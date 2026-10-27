/**
 * Booking calendars: open slots from local opening hours, booking a slot,
 * appointment status, the confirmation (with an .ics file) and reminders.
 *
 * Double booking is stopped by the database: each slot has maxPerSlot seats,
 * a booking takes the first free seat with an insert that can't collide, and
 * two people racing for the last seat can't both get it.
 */
import { durationMs, type Template } from './config.ts';
import { APPOINTMENT_STATUSES, type AppointmentStatus, type Calendar, type Day, DAYS } from './crm-config.ts';
import { activity, contactVars, getContact, type Contact } from './crm.ts';
import { esc } from './render.ts';
import { deliver, loadSite, type Env, type Site } from './runner.ts';
import { sendMessage, notifyTeam, contactLink } from './inbox.ts';
import { addDays, atLocal, human, local } from './time.ts';
import { sign } from './tokens.ts';
import { fire, runWorkflows } from './workflows.ts';

const iso = (d: Date) => d.toISOString();
const MIN = 60_000;

export class Taken extends Error {}

export function calendarOf(site: Site, id: string): Calendar {
  const c = site.config.crm?.calendars?.find((x) => x.id === id);
  if (!c) throw new Error(`no calendar "${id}"`);
  return c;
}

/**
 * Open start times by local date, from `from` (a local date, default today)
 * for `days` days, never past rangeDays and never sooner than minNoticeHours.
 */
export async function freeSlots(env: Env, site: Site, cal: Calendar, opts: { from?: string; days?: number } = {}): Promise<Record<string, string[]>> {
  const tz = site.config.crm!.timezone;
  const now = env.now();
  const today = local(now, tz).date;
  const last = addDays(today, cal.rangeDays ?? 30);
  const from = opts.from && opts.from > today ? opts.from : today;
  const days = Math.min(Math.max(opts.days ?? 7, 1), 31);
  const earliest = now.getTime() + (cal.minNoticeHours ?? 2) * 3_600_000;
  const dur = cal.durationMin * MIN, step = (cal.intervalMin ?? cal.durationMin) * MIN, buffer = (cal.bufferMin ?? 0) * MIN;
  const seats = cal.maxPerSlot ?? 1;
  const lo = atLocal(addDays(from, -1), '00:00', tz), hi = atLocal(addDays(from, days + 1), '00:00', tz);
  const appts = (await env.sql<any>(`SELECT start_at, end_at FROM appointments WHERE site = $1 AND calendar = $2 AND status <> 'cancelled' AND start_at < $4 AND end_at > $3`,
    [site.config.id, cal.id, iso(lo), iso(hi)])).map((a) => ({ s: new Date(a.start_at).getTime(), e: new Date(a.end_at).getTime() }));
  const blocks = (await env.sql<any>(`SELECT start_at, end_at FROM blocks WHERE site = $1 AND (calendar IS NULL OR calendar = $2) AND start_at < $4 AND end_at > $3`,
    [site.config.id, cal.id, iso(lo), iso(hi)])).map((b) => ({ s: new Date(b.start_at).getTime(), e: new Date(b.end_at).getTime() }));
  const out: Record<string, string[]> = {};
  for (let i = 0; i < days; i++) {
    const date = addDays(from, i);
    if (date > last) break;
    const dow = DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] as Day;
    const dayStart = atLocal(date, '00:00', tz).getTime(), dayEnd = atLocal(addDays(date, 1), '00:00', tz).getTime();
    if (cal.maxPerDay && appts.filter((a) => a.s >= dayStart && a.s < dayEnd).length >= cal.maxPerDay) continue;
    const list: string[] = [];
    for (const [open, close] of cal.hours[dow] ?? []) {
      const end = atLocal(date, close, tz).getTime();
      for (let t = atLocal(date, open, tz).getTime(); t + dur <= end; t += step) {
        if (t < earliest) continue;
        const e = t + dur;
        const same = appts.filter((a) => a.s === t).length;
        // Another start time that overlaps this one, buffers included, takes the slot.
        const clash = appts.some((a) => a.s !== t && a.s < e + buffer && a.e + buffer > t);
        if (same >= seats || clash || blocks.some((b) => b.s < e && b.e > t)) continue;
        list.push(new Date(t).toISOString());
      }
    }
    if (list.length) out[date] = list;
  }
  return out;
}

export type Appointment = { id: number; calendar: string; contact_id: number; start_at: string; end_at: string; status: AppointmentStatus; notes: string | null };

export async function getAppointment(env: Env, site: string, id: number): Promise<Appointment | null> {
  const [a] = await env.sql<any>('SELECT * FROM appointments WHERE id = $1 AND site = $2', [id, site]);
  return a ? { ...a, id: Number(a.id), contact_id: Number(a.contact_id), start_at: new Date(a.start_at).toISOString(), end_at: new Date(a.end_at).toISOString() } : null;
}

export const appointmentUrl = (env: Env, site: string, id: number) => `${env.publicUrl}/appt?t=${sign(env.secret, { k: 'appt', a: id, s: site })}`;

export async function appointmentVars(env: Env, site: Site, id: number): Promise<Record<string, string>> {
  const a = await getAppointment(env, site.config.id, id);
  if (!a) return {};
  const cal = site.config.crm?.calendars?.find((c) => c.id === a.calendar);
  return {
    appointment_when: human(a.start_at, site.config.crm!.timezone), appointment_calendar: cal?.name ?? a.calendar,
    appointment_location: cal?.location ?? '', appointment_link: appointmentUrl(env, site.config.id, id),
  };
}

/**
 * Books a start time for a contact. People booking online get only the open
 * slots; the owner (by = their email) may book outside hours but never into a
 * full slot. Sends the confirmation and starts appointment_booked workflows.
 */
export async function book(env: Env, site: Site, cal: Calendar, startIso: string, contactId: number, by: string, notes: string | null = null, opts: { anyTime?: boolean } = {}): Promise<Appointment> {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) throw new Error('that time is not valid');
  const tz = site.config.crm!.timezone;
  if (!opts.anyTime) {
    const date = local(start, tz).date;
    const open = (await freeSlots(env, site, cal, { from: date, days: 1 }))[date] ?? [];
    if (!open.includes(start.toISOString())) throw new Taken('That time was just taken or is no longer open. Please pick another.');
  }
  const end = new Date(start.getTime() + cal.durationMin * MIN);
  const now = iso(env.now());
  let id = 0;
  for (let seat = 0; seat < (cal.maxPerSlot ?? 1) && !id; seat++) {
    const [r] = await env.sql<any>(`INSERT INTO appointments (site, calendar, contact_id, start_at, end_at, seat, notes, booked_by, created_at, status_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) ON CONFLICT DO NOTHING RETURNING id`, [site.config.id, cal.id, contactId, iso(start), iso(end), seat, notes, by, now]);
    if (r) id = Number(r.id);
  }
  if (!id) throw new Taken('That time was just taken. Please pick another.');
  const a = (await getAppointment(env, site.config.id, id))!;
  await activity(env, site.config.id, contactId, 'Appointment Booked', { appointment: id, calendar: cal.id, start: a.start_at, by });
  await confirm(env, site, cal, a);
  await fire(env, site, contactId, { type: 'appointment_booked', calendar: cal.id, ref: `appt:${id}` });
  await runWorkflows(env, { contactId });
  return a;
}

export async function setAppointmentStatus(env: Env, site: Site, id: number, status: AppointmentStatus, by: string): Promise<Appointment> {
  if (!APPOINTMENT_STATUSES.includes(status)) throw new Error(`status must be one of ${APPOINTMENT_STATUSES.join(', ')}`);
  const a = await getAppointment(env, site.config.id, id);
  if (!a) throw new Error('no such appointment');
  if (a.status === status) return a;
  await env.sql('UPDATE appointments SET status = $2, status_at = $3 WHERE id = $1', [id, status, iso(env.now())]);
  await activity(env, site.config.id, a.contact_id, 'Appointment Status', { appointment: id, status, by });
  await fire(env, site, a.contact_id, { type: 'appointment_status', calendar: a.calendar, status, ref: `appt:${id}` });
  await runWorkflows(env, { contactId: a.contact_id });
  return { ...a, status };
}

export function ics(site: Site, cal: Calendar, a: Appointment): string {
  const t = (s: string) => s.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const e = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Webcraft//CRM//EN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:appt-${a.id}-${site.config.id}@webcraftmn.com`, `DTSTAMP:${t(a.start_at)}`, `DTSTART:${t(a.start_at)}`, `DTEND:${t(a.end_at)}`,
    `SUMMARY:${e(`${cal.name} with ${site.config.name}`)}`, ...(cal.location ? [`LOCATION:${e(cal.location)}`] : []),
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
}

const BUILT_IN: Template = {
  subject: "You're booked: {{appointment_calendar}}, {{appointment_when}}",
  body: "Hi {{first_name|there}},\n\nYou're booked for **{{appointment_calendar}}** on {{appointment_when}}.\n\n{{appointment_location}}\n\n[[Add to calendar or cancel]]({{appointment_link}})\n\nSee you then,\n{{site_name}}",
};
const REMINDER: Template = {
  subject: 'Reminder: {{appointment_calendar}}, {{appointment_when}}',
  body: "Hi {{first_name|there}},\n\nA reminder that you're booked for **{{appointment_calendar}}** on {{appointment_when}}.\n\n{{appointment_location}}\n\n[[Can't make it? Cancel here]]({{appointment_link}})\n\n{{site_name}}",
};

async function mailAbout(env: Env, site: Site, cal: Calendar, a: Appointment, c: Contact, ref: string, t: Template, withIcs: boolean): Promise<void> {
  if (!c.email || c.status === 'bounced' || c.status === 'complained') return;
  const vars = { ...contactVars(site, c), ...(await appointmentVars(env, site, a.id)) };
  await deliver(env, site.config, { id: c.id, email: c.email, first_name: c.first_name, status: c.status }, 'appointment', ref, `appt:${ref}`, t, { calendar: cal.id },
    { vars, log: 'system', reason: `You're getting this because you booked with ${site.config.name}.`, attachments: withIcs ? [{ filename: 'appointment.ics', content: ics(site, cal, a), contentType: 'text/calendar' }] : undefined });
}

async function confirm(env: Env, site: Site, cal: Calendar, a: Appointment): Promise<void> {
  const c = await getContact(env, site.config.id, a.contact_id);
  if (!c) return;
  await mailAbout(env, site, cal, a, c, `${a.id}:confirm`, cal.confirmation ? site.config.templates[cal.confirmation] : BUILT_IN, true);
}

/** Sends the reminders now due ("24h" before, "2h" before), once each. Cron work. */
export async function runReminders(env: Env, opts: { limit?: number } = {}): Promise<{ sent: number }> {
  const now = env.now();
  const due = await env.sql<any>(`SELECT id, site FROM appointments WHERE status IN ('booked','confirmed') AND start_at > $1 AND start_at < $2 ORDER BY start_at LIMIT $3`,
    [iso(now), iso(new Date(now.getTime() + 8 * 86_400_000)), opts.limit ?? 200]);
  let sent = 0;
  for (const row of due) {
    const site = await loadSite(env.sql, row.site);
    const a = site ? await getAppointment(env, row.site, Number(row.id)) : null;
    const cal = a ? site!.config.crm?.calendars?.find((c) => c.id === a.calendar) : null;
    if (!site || !a || !cal?.reminders?.length) continue;
    const [{ reminded, created_at }] = await env.sql<any>('SELECT reminded, created_at FROM appointments WHERE id = $1', [a.id]);
    const start = new Date(a.start_at).getTime();
    for (const r of cal.reminders) {
      if (reminded.includes(r) || now.getTime() < start - durationMs(r)) continue;
      // Booked inside the reminder window: the confirmation just went out, skip this one.
      const mark = await env.sql(`UPDATE appointments SET reminded = array_append(reminded, $2) WHERE id = $1 AND NOT ($2 = ANY(reminded)) RETURNING id`, [a.id, r]);
      if (!mark.length || new Date(created_at).getTime() > start - durationMs(r)) continue;
      const c = await getContact(env, site.config.id, a.contact_id);
      if (!c) continue;
      await mailAbout(env, site, cal, a, c, `${a.id}:remind:${r}`, REMINDER, false);
      if (c.sms_status === 'consented') {
        await sendMessage(env, site, c.id, { channel: 'sms', author: 'system', automated: true, key: `reminder:${a.id}:${r}`,
          body: `Reminder: ${cal.name} on ${human(a.start_at, site.config.crm!.timezone)}. Need to cancel? ${appointmentUrl(env, site.config.id, a.id)}` });
      }
      sent++;
    }
  }
  return { sent };
}

/** The appointment's own page for the person who booked: details, add to calendar, cancel. */
export async function appointmentPage(env: Env, site: Site, a: Appointment, token: string, method: string): Promise<{ title: string; html: string }> {
  const cal = site.config.crm?.calendars?.find((c) => c.id === a.calendar);
  const when = human(a.start_at, site.config.crm!.timezone);
  const name = esc(site.config.name);
  if (method === 'POST' && a.status !== 'cancelled' && new Date(a.start_at) > env.now()) {
    await setAppointmentStatus(env, site, a.id, 'cancelled', 'contact');
    const c = await getContact(env, site.config.id, a.contact_id);
    if (c) await notifyTeam(env, site, `Cancelled: ${cal?.name ?? a.calendar}, ${when}`, `${c.first_name ?? 'Someone'} cancelled ${cal?.name ?? 'an appointment'} on ${when}.\n\n${contactLink(env, site.config.id, c.id)}`, `cancel-${a.id}`);
    return { title: 'Cancelled', html: `<h1>Cancelled</h1><p>Your ${esc(cal?.name ?? 'appointment')} on ${esc(when)} is cancelled. ${name} has been told.</p>` };
  }
  if (a.status === 'cancelled') return { title: 'Cancelled', html: `<h1>Cancelled</h1><p>This ${esc(cal?.name ?? 'appointment')} on ${esc(when)} was cancelled.</p>` };
  const past = new Date(a.start_at) <= env.now();
  return {
    title: cal?.name ?? 'Appointment',
    html: `<h1>${esc(cal?.name ?? 'Appointment')}</h1><p><strong>${esc(when)}</strong> with ${name}</p>${cal?.location ? `<p>${esc(cal.location)}</p>` : ''}
<p><a href="/appt.ics?t=${esc(token)}">Add to your calendar</a></p>${past ? '' : `<form method="post"><button type="submit">Cancel this appointment</button></form>`}`,
  };
}
