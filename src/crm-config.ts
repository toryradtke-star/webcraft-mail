/**
 * The CRM half of a site's setup (from the HighLevel teardown,
 * ~/teardowns/2026-10-27-highlevel-crm): pipelines, calendars, workflows,
 * the people who sign in to the owner app, and the SMS number. It is part of
 * the same site JSON as forms and flows, pushed only after approval, and each
 * workflow is hashed like a flow so an unapproved edit can't run.
 */
import { createHash } from 'node:crypto';
import { canonical, durationMs, type SiteConfig } from './config.ts';

export type Stage = { id: string; name: string };
export type Pipeline = { id: string; name: string; stages: Stage[] };

export type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export const DAYS: Day[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export type Calendar = {
  id: string;
  name: string;
  description?: string;
  /** Where it happens, shown in the confirmation ("100 Main St", "Phone call"). */
  location?: string;
  durationMin: number;
  /** Minutes between possible start times (default: the duration). */
  intervalMin?: number;
  /** Local opening hours per weekday, e.g. { mon: [["08:00","12:00"],["13:00","17:00"]] }. */
  hours: Partial<Record<Day, [string, string][]>>;
  /** No bookings sooner than this many hours from now (default 2). */
  minNoticeHours?: number;
  /** How many days ahead people can book (default 30). */
  rangeDays?: number;
  /** Kept free after each appointment, in minutes. */
  bufferMin?: number;
  maxPerDay?: number;
  /** Bookings allowed in one slot (classes, tours with several staff). Default 1. */
  maxPerSlot?: number;
  /** Ask for a phone number (and offer the SMS opt-in when the site texts). */
  askPhone?: boolean;
  /** Template id for the confirmation email; a plain built-in one is used without it. */
  confirmation?: string;
  /** Reminder emails (and texts, to people who opted in) this long before the start: "24h", "2h". */
  reminders?: string[];
};

/** A filter on the contact (and the run's opportunity or appointment). Every key given must hold. */
export type Cond = {
  tag?: string;
  notTag?: string;
  hasEmail?: boolean;
  hasPhone?: boolean;
  /** The contact has replied (any channel) since this run started. */
  replied?: boolean;
  /** The contact's open opportunity in this pipeline sits in this stage. */
  stage?: { pipeline: string; stage: string };
  source?: string;
  /** A custom field's value equals this. */
  field?: { key: string; equals: string };
};

export type WorkflowTrigger =
  | { type: 'contact_created' }
  | { type: 'form_submitted'; form?: string }
  | { type: 'tag_added'; tag: string }
  | { type: 'stage_changed'; pipeline: string; stage?: string }
  | { type: 'opportunity_status'; pipeline?: string; status: 'won' | 'lost' | 'abandoned' | 'open' }
  | { type: 'appointment_booked'; calendar?: string }
  | { type: 'appointment_status'; calendar?: string; status: AppointmentStatus }
  | { type: 'customer_replied'; channel?: 'email' | 'sms' };

export type AppointmentStatus = 'booked' | 'confirmed' | 'cancelled' | 'showed' | 'noshow';
export const APPOINTMENT_STATUSES: AppointmentStatus[] = ['booked', 'confirmed', 'cancelled', 'showed', 'noshow'];

export type Action = (
  | { do: 'wait'; for: string }
  | { do: 'email'; template: string }
  | { do: 'sms'; text: string }
  | { do: 'add_tag'; tag: string }
  | { do: 'remove_tag'; tag: string }
  /** Creates the contact's open opportunity in the pipeline, or moves the existing one. */
  | { do: 'opportunity'; pipeline: string; stage: string; name?: string; value?: number }
  | { do: 'status'; pipeline: string; status: 'won' | 'lost' | 'abandoned' | 'open'; reason?: string }
  | { do: 'task'; title: string; body?: string; due?: string }
  /** An email to the business's own people (crm.notify, or every user). */
  | { do: 'notify'; subject: string; text: string }
  | { do: 'stop' }
) & {
  /** The step runs only if this holds; otherwise it is skipped. With do "stop", it is "stop if". */
  when?: Cond;
};

export type Workflow = {
  id: string;
  name?: string;
  enabled: boolean;
  trigger: WorkflowTrigger;
  /** Extra condition checked when the trigger fires. */
  filter?: Cond;
  /** Let a contact start again after an earlier run ended (never while one is running). Appointment triggers always may. */
  allowReentry?: boolean;
  /** End the run when the contact replies. */
  stopOnResponse?: boolean;
  steps: Action[];
};

export type User = { email: string; name: string; role?: 'owner' | 'staff' };

export type CustomField = { key: string; label: string; type: 'text' | 'textarea' | 'number' | 'date' | 'select'; options?: string[] };

export type Crm = {
  /** IANA zone, e.g. "America/Chicago": opening hours, quiet hours and dates in the app. */
  timezone: string;
  pipelines: Pipeline[];
  calendars?: Calendar[];
  workflows?: Workflow[];
  /** Who can sign in to the owner app (by emailed link). */
  users: User[];
  /** Who gets "notify" emails and new-message alerts (default: every user). */
  notify?: string[];
  customFields?: CustomField[];
  lostReasons?: string[];
  /** Email the team about every lead-form submission (default true), whatever the workflows do. */
  notifyOnLead?: boolean;
  /** Texting through Twilio. Absent: no SMS anywhere. */
  sms?: { from: string; messagingServiceSid?: string };
};

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const E164 = /^\+[1-9]\d{7,14}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;

export function validZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function condProblems(c: Cond | undefined, where: string, crm: Crm): string[] {
  if (!c) return [];
  const out: string[] = [];
  if (c.stage) {
    const p = crm.pipelines.find((x) => x.id === c.stage!.pipeline);
    if (!p || !p.stages.some((s) => s.id === c.stage!.stage)) out.push(`${where}: stage ${c.stage.pipeline}/${c.stage.stage} doesn't exist`);
  }
  if (c.field && !(crm.customFields ?? []).some((f) => f.key === c.field!.key)) out.push(`${where}: custom field "${c.field.key}" isn't in customFields`);
  return out;
}

/** Every problem with the crm block, as sentences. */
export function crmProblems(site: SiteConfig): string[] {
  const crm = site.crm;
  if (!crm) return [];
  const out: string[] = [];
  const need = (ok: unknown, msg: string) => { if (!ok) out.push(msg); };
  need(validZone(crm.timezone ?? ''), `crm.timezone "${crm.timezone}" isn't an IANA zone like America/Chicago`);
  need(Array.isArray(crm.pipelines), 'crm.pipelines must be a list (it can be empty)');
  const pipes = new Map<string, Pipeline>();
  for (const p of crm.pipelines ?? []) {
    need(ID.test(p.id) && !pipes.has(p.id), `pipeline id "${p.id}" is invalid or repeated`);
    need(p.name, `pipeline ${p.id}: name is missing`);
    need(p.stages?.length, `pipeline ${p.id}: needs at least one stage`);
    const ids = new Set<string>();
    for (const s of p.stages ?? []) { need(ID.test(s.id) && !ids.has(s.id) && s.name, `pipeline ${p.id}: stage "${s.id}" is invalid, repeated or unnamed`); ids.add(s.id); }
    pipes.set(p.id, p);
  }
  need(crm.users?.length, 'crm.users needs at least one person who can sign in');
  for (const u of crm.users ?? []) need(EMAIL.test(u.email) && u.name, `user "${u.email}" needs a valid email and a name`);
  for (const n of crm.notify ?? []) need(EMAIL.test(n), `notify "${n}" isn't an email address`);
  if (crm.sms) need(E164.test(crm.sms.from ?? ''), `crm.sms.from must be a phone number like +12185550100`);
  const keys = new Set<string>();
  for (const f of crm.customFields ?? []) {
    need(/^[a-z][a-z0-9_]{0,40}$/.test(f.key) && !keys.has(f.key), `custom field key "${f.key}" must be lowercase letters, digits and _`);
    need(f.type !== 'select' || f.options?.length, `custom field ${f.key}: a select needs options`);
    keys.add(f.key);
  }
  const cals = new Set<string>();
  for (const c of crm.calendars ?? []) {
    need(ID.test(c.id) && !cals.has(c.id), `calendar id "${c.id}" is invalid or repeated`);
    cals.add(c.id);
    need(c.name, `calendar ${c.id}: name is missing`);
    need(Number.isInteger(c.durationMin) && c.durationMin >= 5 && c.durationMin <= 480, `calendar ${c.id}: durationMin must be 5-480`);
    if (c.intervalMin !== undefined) need(Number.isInteger(c.intervalMin) && c.intervalMin >= 5, `calendar ${c.id}: intervalMin must be at least 5`);
    const days = Object.keys(c.hours ?? {});
    need(days.length, `calendar ${c.id}: hours are empty, so nothing can be booked`);
    for (const d of days) {
      need(DAYS.includes(d as Day), `calendar ${c.id}: "${d}" isn't a day (mon … sun)`);
      for (const w of c.hours[d as Day] ?? []) need(HHMM.test(w[0]) && HHMM.test(w[1]) && w[0] < w[1], `calendar ${c.id} ${d}: ${JSON.stringify(w)} isn't ["HH:MM","HH:MM"] with start before end`);
    }
    if (c.confirmation) need(site.templates?.[c.confirmation], `calendar ${c.id}: confirmation template "${c.confirmation}" doesn't exist`);
    for (const r of c.reminders ?? []) { try { durationMs(r); } catch (e) { out.push(`calendar ${c.id} reminder: ${(e as Error).message}`); } }
  }
  const wfs = new Set<string>();
  for (const w of crm.workflows ?? []) {
    const at = `workflow ${w.id}`;
    need(ID.test(w.id) && !wfs.has(w.id), `workflow id "${w.id}" is invalid or repeated`);
    wfs.add(w.id);
    const t = w.trigger as any;
    switch (t?.type) {
      case 'contact_created': case 'customer_replied': break;
      case 'form_submitted': need(!t.form || site.forms.some((f) => f.id === t.form), `${at}: form "${t.form}" doesn't exist`); break;
      case 'tag_added': need(t.tag, `${at}: tag_added needs a tag`); break;
      case 'stage_changed': need(pipes.has(t.pipeline) && (!t.stage || pipes.get(t.pipeline)!.stages.some((s) => s.id === t.stage)), `${at}: pipeline/stage "${t.pipeline}/${t.stage ?? ''}" doesn't exist`); break;
      case 'opportunity_status': need(['won', 'lost', 'abandoned', 'open'].includes(t.status) && (!t.pipeline || pipes.has(t.pipeline)), `${at}: status must be won, lost, abandoned or open, in a real pipeline`); break;
      case 'appointment_booked': need(!t.calendar || cals.has(t.calendar), `${at}: calendar "${t.calendar}" doesn't exist`); break;
      case 'appointment_status': need(APPOINTMENT_STATUSES.includes(t.status) && (!t.calendar || cals.has(t.calendar)), `${at}: appointment status must be one of ${APPOINTMENT_STATUSES.join(', ')}`); break;
      default: out.push(`${at}: unknown trigger "${t?.type}"`);
    }
    out.push(...condProblems(w.filter, `${at} filter`, crm));
    need(w.steps?.length, `${at}: needs at least one step`);
    for (const [i, s] of (w.steps ?? []).entries()) {
      const where = `${at} step ${i + 1}`;
      out.push(...condProblems(s.when, where, crm));
      switch (s.do) {
        case 'wait': try { durationMs(s.for); } catch (e) { out.push(`${where}: ${(e as Error).message}`); } break;
        case 'email': need(site.templates?.[s.template], `${where}: template "${s.template}" doesn't exist`); break;
        case 'sms': need(crm.sms, `${where}: texts need crm.sms`); need((s.text ?? '').length >= 2 && s.text.length <= 600, `${where}: sms text must be 2-600 characters`); break;
        case 'add_tag': case 'remove_tag': need(s.tag, `${where}: needs a tag`); break;
        case 'opportunity': need(pipes.get(s.pipeline)?.stages.some((x) => x.id === s.stage), `${where}: stage ${s.pipeline}/${s.stage} doesn't exist`); break;
        case 'status': need(pipes.has(s.pipeline) && ['won', 'lost', 'abandoned', 'open'].includes(s.status), `${where}: needs a real pipeline and status won, lost, abandoned or open`); break;
        case 'task': need(s.title, `${where}: a task needs a title`); if (s.due) { try { durationMs(s.due); } catch (e) { out.push(`${where}: ${(e as Error).message}`); } } break;
        case 'notify': need(s.subject && s.text, `${where}: notify needs subject and text`); break;
        case 'stop': break;
        default: out.push(`${where}: unknown action "${(s as any).do}"`);
      }
    }
  }
  return out;
}

/** A workflow's hash covers the workflow, the templates it sends, and the sender. */
export function workflowHash(c: SiteConfig, w: Workflow): string {
  const templates = Object.fromEntries(w.steps.flatMap((s) => s.do === 'email' ? [[s.template, c.templates[s.template]]] : []));
  return createHash('sha256').update(canonical({ workflow: w, templates, from: c.from, address: c.address, sms: c.crm?.sms ?? null })).digest('hex').slice(0, 16);
}

export const workflowHashes = (c: SiteConfig): Record<string, string> =>
  Object.fromEntries((c.crm?.workflows ?? []).map((w) => [`wf:${w.id}`, workflowHash(c, w)]));
