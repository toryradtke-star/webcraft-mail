/**
 * The owner app's back end: sign-in by emailed link (no passwords), and the
 * JSON API the app at /app/ calls. Who may sign in, and to which business, is
 * crm.users in each site's approved config.
 *
 * The session is an HttpOnly cookie holding a random token; only its hash is
 * stored. Every write needs the X-Requested-With header, which another site's
 * page can't send without CORS, so a cross-site form can't act as the owner.
 * The sign-in link opens a page with a button rather than signing in on GET,
 * because mail scanners open links.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Env, Site } from './runner.ts';
import { loadSite } from './runner.ts';
import { activity, addNote, addTag, addTask, completeTask, EMAIL, fullName, getContact, normPhone, placeInStage, removeTag, setOpportunityStatus, upsertContact } from './crm.ts';
import { sendMessage, smsBlocked } from './inbox.ts';
import { book, calendarOf, freeSlots, setAppointmentStatus, Taken } from './calendar.ts';
import { esc } from './render.ts';
import { sign, verify } from './tokens.ts';
import { local, atLocal, addDays } from './time.ts';
import type { AppointmentStatus } from './crm-config.ts';
import { runWorkflows } from './workflows.ts';

const iso = (d: Date) => d.toISOString();
const DAY = 86_400_000;
const SESSION_DAYS = 30;
const hash = (t: string) => createHash('sha256').update(t).digest('hex');

export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

export async function sitesFor(env: Env, email: string): Promise<Site[]> {
  const rows = await env.sql<any>(`SELECT id FROM sites WHERE config->'crm'->'users' @> $1::jsonb ORDER BY id`, [JSON.stringify([{ email }])]);
  const out: Site[] = [];
  for (const r of rows) { const s = await loadSite(env.sql, r.id); if (s) out.push(s); }
  return out;
}

function cookie(req: Request, name: string): string | null {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function sessionEmail(env: Env, req: Request): Promise<string | null> {
  const t = cookie(req, 'wm_s');
  if (!t) return null;
  const [s] = await env.sql<any>('SELECT email FROM sessions WHERE hash = $1 AND expires_at > $2', [hash(t), iso(env.now())]);
  return s?.email ?? null;
}

const page = (title: string, body: string) => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:420px;margin:12vh auto;padding:0 16px;color:#111827;background:#fff}button{font:inherit;padding:10px 18px;border-radius:6px;border:0;background:#111827;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`,
  { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

/** /app/auth: GET shows a button, POST signs in. */
export async function auth(env: Env, req: Request, url: URL): Promise<Response> {
  const t = url.searchParams.get('t');
  const c = verify(env.secret, t, 'login', env.now().getTime());
  if (!c) return page('Link expired', '<p>This sign-in link has expired. <a href="/app/">Get a new one</a>.</p>');
  if (req.method !== 'POST') return page('Sign in', `<p>Sign in as <strong>${esc(c.e)}</strong>?</p><form method="post"><button type="submit">Sign in</button></form>`);
  const token = randomBytes(32).toString('base64url');
  const now = env.now();
  await env.sql('INSERT INTO sessions (hash, email, created_at, expires_at) VALUES ($1,$2,$3,$4)', [hash(token), c.e, iso(now), iso(new Date(now.getTime() + SESSION_DAYS * DAY))]);
  const secure = env.publicUrl.startsWith('https:') ? '; Secure' : '';
  return new Response(null, { status: 303, headers: { location: '/app/', 'set-cookie': `wm_s=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}` } });
}

async function login(env: Env, email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  if (!EMAIL.test(e)) throw new AppError(400, 'Enter your email address.');
  const sites = await sitesFor(env, e);
  // The same answer either way, so the form doesn't reveal who has an account.
  if (!sites.length) return;
  const link = `${env.publicUrl}/app/auth?t=${sign(env.secret, { k: 'login', e, exp: env.now().getTime() + 15 * 60_000 })}`;
  const text = `Here's your sign-in link for ${sites.map((s) => s.config.name).join(', ')}. It works for 15 minutes.\n\n${link}\n\nIf you didn't ask for this, ignore it.`;
  await env.mailer({ from: sites[0].config.from, to: e, subject: 'Your sign-in link', text, html: `<p>${esc(text).replace(/\n/g, '<br>').replace(esc(link), `<a href="${esc(link)}">Sign in</a>`)}</p>`,
    idempotencyKey: `wm-login-${hash(link).slice(0, 24)}`, tags: { site: sites[0].config.id, kind: 'login' } });
}

const num = (v: unknown, what: string) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new AppError(400, `${what} is missing`); return n; };
const str = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);

/** Everything under /app/api/. */
export async function api(env: Env, req: Request, url: URL): Promise<Response> {
  try {
    const path = url.pathname.replace(/^\/app\/api/, '');
    const write = req.method !== 'GET';
    if (write && req.headers.get('x-requested-with') !== 'wm-app') throw new AppError(403, 'missing app header');
    const b: any = write ? await req.json().catch(() => ({})) : {};
    if (path === '/login' && write) { await login(env, str(b.email, 254)); return json({ ok: true }); }
    const email = await sessionEmail(env, req);
    if (!email) throw new AppError(401, 'signed out');
    if (path === '/logout' && write) {
      const t = cookie(req, 'wm_s');
      if (t) await env.sql('DELETE FROM sessions WHERE hash = $1', [hash(t)]);
      return json({ ok: true }, 200, { 'set-cookie': 'wm_s=; Path=/; Max-Age=0' });
    }
    const mine = await sitesFor(env, email);
    if (path === '/me') return json({ email, name: mine[0]?.config.crm?.users.find((u) => u.email === email)?.name ?? email, sites: mine.map((s) => ({ id: s.config.id, name: s.config.name })) });
    const siteId = str(write ? b.site : url.searchParams.get('site'), 41);
    const site = mine.find((s) => s.config.id === siteId);
    if (!site) throw new AppError(403, 'not your business');
    const res = await route(env, site, email, path, req.method, b, url.searchParams);
    // Anything a change started (a stage move that triggers a workflow) runs now.
    if (write && typeof res === 'object' && res && (res as any).contactId) await runWorkflows(env, { contactId: (res as any).contactId });
    return json(res);
  } catch (err) {
    if (err instanceof AppError) return json({ error: err.message }, err.status);
    if (err instanceof Taken) return json({ error: err.message }, 409);
    const msg = (err as Error).message;
    if (/duplicate key|unique/i.test(msg)) return json({ error: 'Another contact already has that email or phone.' }, 409);
    if (/^(no |a |an |that |the |pipeline |status )/.test(msg)) return json({ error: msg }, 400);
    console.error(err);
    return json({ error: 'server error' }, 500);
  }
}

async function route(env: Env, site: Site, me: string, path: string, method: string, b: any, q: URLSearchParams): Promise<unknown> {
  const s = site.config.id;
  const crm = site.config.crm!;
  const tz = crm.timezone;
  const now = env.now();
  const get = method === 'GET';
  // Every write that names a contact must name one of this business's.
  const mineContact = async (v: unknown) => {
    const id = num(v, 'contact');
    if (!(await getContact(env, s, id))) throw new AppError(404, 'no such contact');
    return id;
  };
  switch (`${method} ${path}`) {
    case 'GET /setup':
      return { id: s, name: site.config.name, timezone: tz, pipelines: crm.pipelines, calendars: (crm.calendars ?? []).map(({ id, name, durationMin }) => ({ id, name, durationMin })),
        customFields: crm.customFields ?? [], lostReasons: crm.lostReasons ?? [], sms: !!crm.sms && !!env.sms, users: crm.users, bookingBase: `${env.publicUrl}/book/${s}/` };

    case 'GET /home': {
      const today = local(now, tz).date;
      const [unread] = await env.sql<any>(`SELECT count(DISTINCT contact_id)::int AS n FROM messages WHERE site = $1 AND direction = 'in' AND read_at IS NULL`, [s]);
      const [due] = await env.sql<any>(`SELECT count(*)::int AS n FROM tasks WHERE site = $1 AND done_at IS NULL AND due_at < $2`, [s, iso(atLocal(addDays(today, 1), '00:00', tz))]);
      const [leads] = await env.sql<any>(`SELECT count(*)::int AS n FROM profiles WHERE site = $1 AND created_at > $2`, [s, iso(new Date(now.getTime() - 7 * DAY))]);
      const appts = await env.sql<any>(`SELECT a.id, a.calendar, a.start_at, a.status, a.contact_id, p.first_name, p.last_name, p.email, p.phone FROM appointments a JOIN profiles p ON p.id = a.contact_id
        WHERE a.site = $1 AND a.status <> 'cancelled' AND a.start_at >= $2 AND a.start_at < $3 ORDER BY a.start_at`, [s, iso(atLocal(today, '00:00', tz)), iso(atLocal(addDays(today, 1), '00:00', tz))]);
      return { unread: unread.n, tasksDue: due.n, newContacts7d: leads.n, today: appts.map((a) => ({ id: Number(a.id), calendar: a.calendar, start: a.start_at, status: a.status, contactId: Number(a.contact_id), name: fullName(a) })) };
    }

    case 'GET /inbox': {
      const rows = await env.sql<any>(`SELECT DISTINCT ON (m.contact_id) m.contact_id, m.channel, m.direction, m.subject, m.body, m.at, p.first_name, p.last_name, p.email, p.phone,
          (SELECT count(*)::int FROM messages u WHERE u.contact_id = m.contact_id AND u.direction = 'in' AND u.read_at IS NULL) AS unread
        FROM messages m JOIN profiles p ON p.id = m.contact_id WHERE m.site = $1 AND m.status <> 'skipped' ORDER BY m.contact_id, m.at DESC`, [s]);
      const list = rows.map((r) => ({ contactId: Number(r.contact_id), name: fullName(r), channel: r.channel, direction: r.direction, snippet: (r.subject && r.channel === 'form' ? `${r.subject}: ` : '') + String(r.body).slice(0, 140), at: r.at, unread: r.unread }));
      list.sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || +new Date(b.at) - +new Date(a.at));
      return { conversations: q.get('unread') === '1' ? list.filter((c) => c.unread) : list.slice(0, 200) };
    }

    case 'GET /contacts': {
      const term = str(q.get('q'), 100).toLowerCase();
      const tag = str(q.get('tag'), 60).toLowerCase();
      const rows = await env.sql<any>(`SELECT id, first_name, last_name, email, phone, tags, source, created_at, last_activity_at FROM profiles
        WHERE site = $1 AND ($2 = '' OR lower(coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(email,'') || ' ' || coalesce(phone,'')) LIKE '%' || $2 || '%')
          AND ($3 = '' OR $3 = ANY(tags)) ORDER BY last_activity_at DESC NULLS LAST, id DESC LIMIT 100 OFFSET $4`, [s, term, tag, Math.max(0, Number(q.get('offset') ?? 0) || 0)]);
      return { contacts: rows.map((r) => ({ id: Number(r.id), name: fullName(r), email: r.email, phone: r.phone, tags: r.tags, source: r.source, created: r.created_at, active: r.last_activity_at })) };
    }

    case 'GET /contact': {
      const id = num(q.get('id'), 'contact');
      const c = await getContact(env, s, id);
      if (!c) throw new AppError(404, 'no such contact');
      const [opps, tasks, notes, appts, msgs, events, inb] = await Promise.all([
        env.sql<any>('SELECT * FROM opportunities WHERE contact_id = $1 ORDER BY created_at DESC', [id]),
        env.sql<any>('SELECT * FROM tasks WHERE contact_id = $1 ORDER BY done_at NULLS FIRST, due_at NULLS LAST', [id]),
        env.sql<any>('SELECT * FROM notes WHERE contact_id = $1 ORDER BY at DESC', [id]),
        env.sql<any>('SELECT * FROM appointments WHERE contact_id = $1 ORDER BY start_at DESC', [id]),
        env.sql<any>('SELECT id, channel, direction, subject, body, status, error, author, at, read_at FROM messages WHERE contact_id = $1 ORDER BY at', [id]),
        env.sql<any>(`SELECT name, props, at FROM events WHERE profile_id = $1 AND name NOT IN ('Viewed Page') ORDER BY at DESC LIMIT 60`, [id]),
        env.sql(`SELECT 1 FROM messages WHERE contact_id = $1 AND channel = 'sms' AND direction = 'in' LIMIT 1`, [id]),
      ]);
      const { status, sms_status, attribution, ...rest } = c as any;
      return {
        contact: { ...rest, name: fullName(c), emailStatus: status, smsStatus: sms_status, attribution },
        canEmail: !c.email ? 'no email address' : ['bounced', 'complained'].includes(c.status) ? `their address ${c.status}` : null,
        canText: smsBlocked(site, env, c, false, inb.length > 0),
        opportunities: opps.map((o) => ({ ...o, id: Number(o.id), value: Number(o.value) })),
        tasks: tasks.map((t) => ({ ...t, id: Number(t.id) })), notes: notes.map((n) => ({ ...n, id: Number(n.id) })),
        appointments: appts.map((a) => ({ ...a, id: Number(a.id) })), messages: msgs.map((m) => ({ ...m, id: Number(m.id) })), events,
      };
    }

    case 'POST /contact': {
      if (b.id) await mineContact(b.id);
      if (!b.id) {
        const { contact } = await upsertContact(env, site, { email: str(b.email, 254) || null, phone: str(b.phone, 40) || null, first_name: str(b.first_name, 60) || null, last_name: str(b.last_name, 60) || null, source: str(b.source, 80) || 'Added by hand' });
        return { id: contact.id, contactId: contact.id };
      }
      const id = num(b.id, 'contact');
      const email = str(b.email, 254).toLowerCase() || null;
      if (email && !EMAIL.test(email)) throw new AppError(400, 'That email address isn\'t valid.');
      const phone = str(b.phone, 40) ? normPhone(b.phone) : null;
      if (str(b.phone, 40) && !phone) throw new AppError(400, 'That phone number isn\'t valid.');
      const custom = b.custom && typeof b.custom === 'object' ? Object.fromEntries(Object.entries(b.custom).filter(([k]) => (crm.customFields ?? []).some((f) => f.key === k)).map(([k, v]) => [k, str(v, 1000)])) : {};
      await env.sql(`UPDATE profiles SET first_name = $3, last_name = $4, email = $5, phone = $6, source = $7, custom = custom || $8::jsonb WHERE id = $1 AND site = $2`,
        [id, s, str(b.first_name, 60) || null, str(b.last_name, 60) || null, email, phone, str(b.source, 80) || null, JSON.stringify(custom)]);
      await activity(env, s, id, 'Contact Edited', { by: me });
      return { ok: true };
    }

    case 'POST /tag': {
      const id = await mineContact(b.contact);
      if (b.remove) await removeTag(env, site, id, str(b.tag, 60), me); else await addTag(env, site, id, str(b.tag, 60), me);
      return { ok: true, contactId: id };
    }

    case 'POST /message': {
      const id = await mineContact(b.contact);
      const r = await sendMessage(env, site, id, { channel: b.channel === 'sms' ? 'sms' : 'email', subject: str(b.subject, 200), body: str(b.body, 20000), author: me });
      if (r.status === 'skipped') throw new AppError(400, `Not sent: ${r.why}.`);
      if (r.status === 'failed') throw new AppError(502, `Sending failed: ${r.why}`);
      await env.sql(`UPDATE messages SET read_at = $2 WHERE contact_id = $1 AND direction = 'in' AND read_at IS NULL`, [id, iso(now)]);
      return { ok: true, id: r.id };
    }

    case 'POST /read':
      await env.sql(`UPDATE messages SET read_at = $3 WHERE contact_id = $1 AND site = $2 AND direction = 'in' AND read_at IS NULL`, [num(b.contact, 'contact'), s, iso(now)]);
      return { ok: true };

    case 'POST /note': return { id: await addNote(env, s, await mineContact(b.contact), str(b.body, 5000), me) };

    case 'POST /task': {
      const due = str(b.due, 40);
      return { id: await addTask(env, s, { contactId: b.contact ? await mineContact(b.contact) : null, title: str(b.title, 200), body: str(b.body, 2000) || null, dueAt: due ? iso(new Date(due)) : null, assignedTo: str(b.assignedTo, 254) || me }, me) };
    }

    case 'POST /task-done': await completeTask(env, s, num(b.id, 'task'), b.done !== false); return { ok: true };

    case 'GET /tasks': {
      const rows = await env.sql<any>(`SELECT t.*, p.first_name, p.last_name, p.email, p.phone FROM tasks t LEFT JOIN profiles p ON p.id = t.contact_id
        WHERE t.site = $1 AND (t.done_at IS NULL OR $2) ORDER BY t.done_at NULLS FIRST, t.due_at NULLS LAST LIMIT 200`, [s, q.get('all') === '1']);
      return { tasks: rows.map((t) => ({ id: Number(t.id), title: t.title, body: t.body, due: t.due_at, done: t.done_at, assignedTo: t.assigned_to, contactId: t.contact_id ? Number(t.contact_id) : null, name: t.contact_id ? fullName(t) : null })) };
    }

    case 'GET /board': {
      const pipe = crm.pipelines.find((p) => p.id === q.get('pipeline')) ?? crm.pipelines[0];
      if (!pipe) return { pipeline: null, opportunities: [] };
      const status = ['won', 'lost', 'abandoned'].includes(q.get('status') ?? '') ? q.get('status') : 'open';
      const rows = await env.sql<any>(`SELECT o.*, p.first_name, p.last_name, p.email, p.phone FROM opportunities o JOIN profiles p ON p.id = o.contact_id
        WHERE o.site = $1 AND o.pipeline = $2 AND o.status = $3 ORDER BY o.stage_at DESC LIMIT 500`, [s, pipe.id, status]);
      return { pipeline: pipe, opportunities: rows.map((o) => ({ id: Number(o.id), contactId: Number(o.contact_id), name: fullName(o), title: o.name, contactName: fullName(o), stage: o.stage, status: o.status, value: Number(o.value), source: o.source, stageAt: o.stage_at, created: o.created_at })) };
    }

    case 'POST /opportunity': {
      const contactId = await mineContact(b.contact);
      const o = await placeInStage(env, site, contactId, { id: b.id ? num(b.id, 'opportunity') : undefined, pipeline: str(b.pipeline, 41), stage: str(b.stage, 41), name: str(b.name, 120) || undefined, value: b.value === undefined || b.value === '' ? undefined : Math.max(0, Number(b.value) || 0) }, me);
      return { id: o.id, contactId };
    }

    case 'POST /opportunity-status': {
      const st = str(b.status, 20);
      if (!['open', 'won', 'lost', 'abandoned'].includes(st)) throw new AppError(400, 'status must be open, won, lost or abandoned');
      const o = await setOpportunityStatus(env, site, num(b.id, 'opportunity'), st as any, str(b.reason, 200) || null, me);
      return { ok: true, contactId: o.contact_id };
    }

    case 'GET /calendar': {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('from') ?? '') ? q.get('from')! : local(now, tz).date;
      const days = Math.min(Math.max(Number(q.get('days') ?? 7) || 7, 1), 31);
      const lo = iso(atLocal(from, '00:00', tz)), hi = iso(atLocal(addDays(from, days), '00:00', tz));
      const [appts, blocks] = await Promise.all([
        env.sql<any>(`SELECT a.*, p.first_name, p.last_name, p.email, p.phone FROM appointments a JOIN profiles p ON p.id = a.contact_id WHERE a.site = $1 AND a.start_at >= $2 AND a.start_at < $3 ORDER BY a.start_at`, [s, lo, hi]),
        env.sql<any>('SELECT * FROM blocks WHERE site = $1 AND start_at < $3 AND end_at > $2 ORDER BY start_at', [s, lo, hi]),
      ]);
      return { from, days, appointments: appts.map((a) => ({ id: Number(a.id), calendar: a.calendar, start: a.start_at, end: a.end_at, status: a.status, notes: a.notes, contactId: Number(a.contact_id), name: fullName(a), phone: a.phone })),
        blocks: blocks.map((x) => ({ id: Number(x.id), calendar: x.calendar, start: x.start_at, end: x.end_at, reason: x.reason })) };
    }

    case 'GET /slots': return { slots: await freeSlots(env, site, calendarOf(site, str(q.get('calendar'), 41)), { from: q.get('from') ?? undefined, days: 14 }) };

    case 'POST /appointment': {
      const contactId = await mineContact(b.contact);
      const a = await book(env, site, calendarOf(site, str(b.calendar, 41)), str(b.start, 40), contactId, me, str(b.notes, 2000) || null, { anyTime: b.anyTime === true });
      return { id: a.id, contactId };
    }

    case 'POST /appointment-status': {
      const a = await setAppointmentStatus(env, site, num(b.id, 'appointment'), str(b.status, 20) as AppointmentStatus, me);
      return { ok: true, contactId: a.contact_id };
    }

    case 'POST /block': {
      const start = new Date(str(b.start, 40)), end = new Date(str(b.end, 40));
      if (Number.isNaN(+start) || Number.isNaN(+end) || end <= start) throw new AppError(400, 'A block needs a start before its end.');
      if (b.calendar) calendarOf(site, str(b.calendar, 41));
      const [r] = await env.sql<any>('INSERT INTO blocks (site, calendar, start_at, end_at, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [s, str(b.calendar, 41) || null, iso(start), iso(end), str(b.reason, 200) || null, me]);
      return { id: Number(r.id) };
    }

    case 'POST /unblock': await env.sql('DELETE FROM blocks WHERE id = $1 AND site = $2', [num(b.id, 'block'), s]); return { ok: true };
  }
  throw new AppError(404, get ? 'not found' : 'unknown action');
}
