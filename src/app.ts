/**
 * Every route, as one fetch-style handler: Request in, Response out. The
 * Vercel function and the local dev server both wrap this.
 *
 * Public (called from client sites, CORS-checked against the site's origins):
 *   GET  /api/forms?site=        the site's forms for wm.js
 *   POST /api/subscribe          a form signup
 *   POST /api/track              an onsite event
 *   POST /api/identify           ties a browser to the person who clicked an email
 * From email:
 *   GET  /c  click redirect · GET /o  open pixel · GET|POST /u  unsubscribe
 *   POST /api/lead               a lead form (CRM contact, inbox, workflows)
 * Booking (served from this domain, can be iframed):
 *   GET  /book/<site>/<calendar>  the booking page · GET /api/slots · POST /api/book
 *   GET|POST /appt  an appointment's page (cancel) · GET /appt.ics
 * Owner app:
 *   /app/ (static) · GET|POST /app/auth (emailed sign-in) · /app/api/* (session cookie)
 * Machine:
 *   GET  /api/cron               due flow steps, workflows, reminders, broadcasts (CRON_SECRET)
 *   POST /api/webhooks/resend    bounces, complaints and inbound replies (Svix-signed)
 *   POST /api/webhooks/twilio    inbound texts · /api/webhooks/twilio/status delivery reports
 *   /api/admin/*                 the hub's push, broadcast, stats and CRM counts (ADMIN_TOKEN)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { configProblems, flowHashes, publicForms, type SiteConfig, type Template } from './config.ts';
import { esc } from './render.ts';
import { enroll, loadSite, runBroadcasts, runDue, type Env, type Site } from './runner.ts';
import { sign, urlHash, verify } from './tokens.ts';
import { appointmentPage, getAppointment, ics, runReminders, Taken } from './calendar.ts';
import { inboundEmail, inboundSms, smsStatus } from './inbox.ts';
import { BadInput, bookingPage, slots, submitBooking, submitLead } from './leads.ts';
import { api as ownerApi, auth as ownerAuth } from './owner.ts';
import { twilioValid } from './sms.ts';
import { runWorkflows } from './workflows.ts';
import { crmAdmin } from './crm-admin.ts';

const EMAIL = /^[^\s@<>()",;:]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;
const ANON = /^[A-Za-z0-9_-]{8,64}$/;
const EVENT = /^[A-Za-z0-9 _:.\-/]{1,64}$/;
const SIGNUPS_PER_IP_HOUR = 5;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const page = (title: string, body: string, status = 200) => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;margin:12vh auto;padding:0 16px;color:#111827;background:#fff}button{font:inherit;padding:10px 18px;border-radius:6px;border:0;background:#111827;color:#fff;cursor:pointer}</style></head><body>${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

function corsFor(site: Site | null, req: Request): Record<string, string> | null {
  const origin = req.headers.get('origin');
  if (!origin || !site?.config.origins.includes(origin)) return null;
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', vary: 'origin' };
}

function clientIp(req: Request): string {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || req.headers.get('x-real-ip') || '';
}

async function body(req: Request): Promise<any> {
  const text = await req.text();
  if (text.length > 8_000) throw new HttpError(413, 'too large');
  try { return JSON.parse(text || '{}'); } catch { throw new HttpError(400, 'body must be JSON'); }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const bearer = (req: Request) => (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
function same(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Svix signature check for Resend webhooks: v1 HMAC-SHA256 of "id.timestamp.body". */
export function svixValid(secret: string, headers: Headers, payload: string, now: Date): boolean {
  const id = headers.get('svix-id'), ts = headers.get('svix-timestamp'), sigs = headers.get('svix-signature');
  if (!id || !ts || !sigs) return false;
  if (Math.abs(now.getTime() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const want = createHmac('sha256', key).update(`${id}.${ts}.${payload}`).digest('base64');
  return sigs.split(' ').some((s) => s.startsWith('v1,') && same(s.slice(3), want));
}

async function linkVisitor(env: Env, site: string, anonId: string | undefined, profileId: number): Promise<void> {
  if (!anonId || !ANON.test(anonId)) return;
  await env.sql(`INSERT INTO visitors (site, anon_id, profile_id, first_seen) VALUES ($1,$2,$3,$4)
    ON CONFLICT (site, anon_id) DO UPDATE SET profile_id = EXCLUDED.profile_id`, [site, anonId, profileId, env.now().toISOString()]);
  // Earlier anonymous events of this browser now belong to the person.
  await env.sql('UPDATE events SET profile_id = $3 WHERE site = $1 AND anon_id = $2 AND profile_id IS NULL', [site, anonId, profileId]);
}

async function subscribe(env: Env, site: Site, req: Request, b: any) {
  const form = site.config.forms.find((f) => f.id === b.form);
  // Lead forms post to /api/lead; a signup form always has a list (the validator checks).
  if (!form || form.kind === 'lead' || !form.list) throw new HttpError(400, 'unknown form');
  const list = form.list;
  // The hidden field only bots fill in. Say yes, store nothing.
  if (b.company) return { ok: true };
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!EMAIL.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  const firstName = form.fields.includes('first_name') ? String(b.first_name ?? '').trim().slice(0, 60) || null : null;
  const now = env.now().toISOString();
  const ip = clientIp(req);
  if (ip) {
    const [r] = await env.sql<{ n: string }>('SELECT count(*) AS n FROM consents WHERE ip = $1 AND at > $2', [ip, new Date(env.now().getTime() - 3_600_000).toISOString()]);
    if (Number(r.n) >= SIGNUPS_PER_IP_HOUR) throw new HttpError(429, 'Too many signups from here. Try again later.');
  }
  const [existing] = await env.sql<{ id: string; status: string }>('SELECT id, status FROM profiles WHERE site = $1 AND email = $2', [site.config.id, email]);
  // A bounce or spam complaint is permanent; signing up again doesn't undo it.
  if (existing && (existing.status === 'bounced' || existing.status === 'complained')) return { ok: true, token: null };
  let profileId: number;
  if (existing) {
    profileId = Number(existing.id);
    await env.sql(`UPDATE profiles SET status = 'subscribed', status_at = CASE WHEN status = 'subscribed' THEN status_at ELSE $2 END, first_name = COALESCE($3, first_name) WHERE id = $1`, [profileId, now, firstName]);
  } else {
    const [p] = await env.sql<{ id: string }>(`INSERT INTO profiles (site, email, first_name, created_at, status_at) VALUES ($1,$2,$3,$4,$4) RETURNING id`, [site.config.id, email, firstName, now]);
    profileId = Number(p.id);
  }
  const url = String(b.url ?? '').slice(0, 500) || null;
  await env.sql(`INSERT INTO consents (profile_id, site, form_id, list, wording, url, ip, user_agent, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [profileId, site.config.id, form.id, list, form.consent, url, ip || null, (req.headers.get('user-agent') ?? '').slice(0, 300), now]);
  const joined = await env.sql(`INSERT INTO memberships (profile_id, list, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING list`, [profileId, list, now]);
  await linkVisitor(env, site.config.id, b.anon_id, profileId);
  await env.sql(`INSERT INTO events (site, anon_id, profile_id, name, props, url, at) VALUES ($1,$2,$3,'Subscribed',$4,$5,$6)`,
    [site.config.id, ANON.test(b.anon_id ?? '') ? b.anon_id : null, profileId, JSON.stringify({ form: form.id, list }), url, now]);
  if (joined.length) await enroll(env, site, profileId, { type: 'subscribed', list });
  // A welcome step with after "0m" goes out now rather than at the next cron.
  await runDue(env, { profileId, limit: 5 });
  return { ok: true, token: sign(env.secret, { k: 'id', p: profileId, s: site.config.id, exp: env.now().getTime() + 365 * 86_400_000 }) };
}

async function track(env: Env, site: Site, b: any) {
  const name = String(b.event ?? '');
  if (!EVENT.test(name) || !ANON.test(b.anon_id ?? '')) throw new HttpError(400, 'bad event');
  const props = b.props && typeof b.props === 'object' && !Array.isArray(b.props) ? b.props : {};
  const url = String(b.url ?? '').slice(0, 500) || null;
  const now = env.now().toISOString();
  const [v] = await env.sql<{ profile_id: string | null }>(`INSERT INTO visitors (site, anon_id, first_seen) VALUES ($1,$2,$3)
    ON CONFLICT (site, anon_id) DO UPDATE SET site = EXCLUDED.site RETURNING profile_id`, [site.config.id, b.anon_id, now]);
  const profileId = v?.profile_id ? Number(v.profile_id) : null;
  await env.sql(`INSERT INTO events (site, anon_id, profile_id, name, props, url, at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [site.config.id, b.anon_id, profileId, name, JSON.stringify(props).slice(0, 2000), url, now]);
  if (profileId) {
    let path = '';
    try { path = url ? new URL(url).pathname : ''; } catch { /* not a URL */ }
    await enroll(env, site, profileId, { type: 'event', name, path });
  }
  return { ok: true };
}

async function unsubscribe(env: Env, req: Request, url: URL): Promise<Response> {
  const c = verify(env.secret, url.searchParams.get('t'), 'unsub');
  if (!c) return page('Link expired', '<p>This unsubscribe link isn\'t valid. Reply to any email and we\'ll take you off the list.</p>', 400);
  const site = await loadSite(env.sql, c.s);
  const name = esc(site?.config.name ?? 'this list');
  // GET only shows a button: mail scanners follow links, and a scan must not unsubscribe anyone.
  // POST is the button and the RFC 8058 one-click request from the inbox.
  if (req.method !== 'POST') {
    return page('Unsubscribe', `<p>Stop getting emails from ${name}?</p><form method="post"><button type="submit">Unsubscribe</button></form>`);
  }
  await env.sql(`UPDATE profiles SET status = 'unsubscribed', status_at = $2 WHERE id = $1 AND status = 'subscribed'`, [c.p, env.now().toISOString()]);
  await env.sql(`UPDATE enrollments SET state = 'exited' WHERE profile_id = $1 AND state = 'active'`, [c.p]);
  await env.sql(`INSERT INTO events (site, profile_id, name, props, at) VALUES ($1,$2,'Unsubscribed','{}',$3)`, [c.s, c.p, env.now().toISOString()]);
  return page('Unsubscribed', `<p>You're unsubscribed from ${name}. You won't get any more emails from this list.</p>`);
}

async function click(env: Env, url: URL): Promise<Response> {
  const target = url.searchParams.get('u') ?? '';
  const c = verify(env.secret, url.searchParams.get('t'), 'click');
  // Only a signed URL is followed, so this can't be used as an open redirect.
  if (!c || c.h !== urlHash(target) || !/^https?:\/\//.test(target)) return page('Link not found', '<p>This link isn\'t valid.</p>', 400);
  const now = env.now().toISOString();
  const [s] = await env.sql<{ site: string; profile_id: string }>(
    `UPDATE sends SET clicked_at = COALESCE(clicked_at, $2), opened_at = COALESCE(opened_at, $2) WHERE id = $1 RETURNING site, profile_id`, [c.send, now]);
  let dest = target;
  if (s) {
    await env.sql(`INSERT INTO events (site, profile_id, name, props, url, at) VALUES ($1,$2,'Clicked Email',$3,$4,$5)`,
      [s.site, s.profile_id, JSON.stringify({ send: c.send }), target.slice(0, 500), now]);
    // Links back to the client's own site carry an identity token, so wm.js can tie that browser to the person.
    const site = await loadSite(env.sql, s.site);
    const u = new URL(target);
    if (site?.config.origins.includes(u.origin)) {
      u.searchParams.set('_wm', sign(env.secret, { k: 'id', p: Number(s.profile_id), s: s.site, exp: env.now().getTime() + 30 * 86_400_000 }));
      dest = u.toString();
    }
  }
  return new Response(null, { status: 302, headers: { location: dest, 'cache-control': 'no-store' } });
}

const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

async function open(env: Env, url: URL): Promise<Response> {
  const c = verify(env.secret, url.searchParams.get('t'), 'open');
  if (c) await env.sql('UPDATE sends SET opened_at = COALESCE(opened_at, $2) WHERE id = $1', [c.send, env.now().toISOString()]);
  return new Response(PIXEL, { headers: { 'content-type': 'image/gif', 'cache-control': 'no-store' } });
}

async function resendWebhook(env: Env, req: Request): Promise<Response> {
  const payload = await req.text();
  if (!env.webhookSecret || !svixValid(env.webhookSecret, req.headers, payload, env.now())) return json({ error: 'bad signature' }, 401);
  const e = JSON.parse(payload);
  if (e.type === 'email.received') return json({ ok: true, result: await inboundEmail(env, e.data ?? {}) });
  const status = e.type === 'email.complained' ? 'complained'
    : e.type === 'email.bounced' && (e.data?.bounce?.type ?? 'Permanent') !== 'Transient' ? 'bounced' : null;
  if (status && e.data?.email_id) {
    const [s] = await env.sql<{ profile_id: string }>('SELECT profile_id FROM sends WHERE resend_id = $1', [e.data.email_id]);
    if (s) {
      await env.sql('UPDATE profiles SET status = $2, status_at = $3 WHERE id = $1', [s.profile_id, status, env.now().toISOString()]);
      await env.sql(`UPDATE enrollments SET state = 'exited' WHERE profile_id = $1 AND state = 'active'`, [s.profile_id]);
    }
  }
  return json({ ok: true });
}

/** Twilio posts form-encoded; the signature covers the exact public URL. */
async function twilioWebhook(env: Env, req: Request, url: URL): Promise<Response> {
  const params = new URLSearchParams(await req.text());
  if (!env.twilioAuthToken || !twilioValid(env.twilioAuthToken, `${env.publicUrl}${url.pathname}${url.search}`, params, req.headers.get('x-twilio-signature'))) return json({ error: 'bad signature' }, 401);
  if (url.pathname.endsWith('/status')) await smsStatus(env, params); else await inboundSms(env, params);
  // An empty TwiML reply: nothing is texted back automatically (Twilio itself answers STOP and HELP).
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { headers: { 'content-type': 'text/xml' } });
}

async function appt(env: Env, req: Request, url: URL): Promise<Response> {
  const t = url.searchParams.get('t') ?? '';
  const c = verify(env.secret, t, 'appt');
  const site = c ? await loadSite(env.sql, c.s) : null;
  const a = site ? await getAppointment(env, c!.s, c!.a) : null;
  if (!site || !a) return page('Not found', '<p>This link isn\'t valid.</p>', 400);
  if (url.pathname === '/appt.ics') {
    const cal = site.config.crm?.calendars?.find((x) => x.id === a.calendar);
    if (!cal) return page('Not found', '<p>This calendar no longer exists.</p>', 404);
    return new Response(ics(site, cal, a), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'attachment; filename="appointment.ics"' } });
  }
  const r = await appointmentPage(env, site, a, t, req.method);
  return page(r.title, r.html);
}

async function admin(env: Env, req: Request, url: URL): Promise<Response> {
  if (!env.adminToken || !same(bearer(req), env.adminToken)) return json({ error: 'unauthorized' }, 401);
  const path = url.pathname.replace(/^\/api\/admin/, '');
  const now = env.now().toISOString();
  if (path === '/sites' && req.method === 'PUT') {
    const c = (await req.json()) as SiteConfig;
    const problems = configProblems(c);
    if (problems.length) return json({ error: 'invalid config', problems }, 400);
    const hashes = flowHashes(c);
    await env.sql(`INSERT INTO sites (id, config, hashes, updated_at) VALUES ($1,$2,$3,$4)
      ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, hashes = EXCLUDED.hashes, updated_at = EXCLUDED.updated_at`,
      [c.id, JSON.stringify(c), JSON.stringify(hashes), now]);
    return json({ ok: true, site: c.id, hashes });
  }
  const siteId = url.searchParams.get('site') ?? '';
  const site = await loadSite(env.sql, siteId);
  if (!site) return json({ error: `no site "${siteId}"` }, 404);
  if (path === '/config' && req.method === 'GET') return json(site);
  if (path === '/broadcasts' && req.method === 'POST') {
    const b = (await req.json()) as { id: string; list: string; template: Template };
    if (!/^[a-z0-9-]{3,60}$/.test(b.id ?? '')) return json({ error: 'broadcast id must be 3-60 lowercase letters, digits, dashes' }, 400);
    if (!site.config.lists.some((l) => l.id === b.list)) return json({ error: `no list "${b.list}"` }, 400);
    if (!b.template?.subject || !b.template?.body) return json({ error: 'template needs subject and body' }, 400);
    const r = await env.sql(`INSERT INTO broadcasts (id, site, list, template, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING RETURNING id`,
      [b.id, siteId, b.list, JSON.stringify(b.template), now]);
    if (!r.length) return json({ error: `broadcast "${b.id}" already exists` }, 409);
    const sent = await runBroadcasts(env, { limit: 25 });
    return json({ ok: true, queued: b.id, firstBatch: sent });
  }
  if (path === '/stats' && req.method === 'GET') return json(await stats(env, siteId, Number(url.searchParams.get('days') ?? 30)));
  if (path.startsWith('/crm/') && req.method === 'GET') return json(await crmAdmin(env, site, path.slice(5), url.searchParams));
  return json({ error: 'not found' }, 404);
}

export async function stats(env: Env, site: string, days: number) {
  const since = new Date(env.now().getTime() - Math.max(1, Math.min(days, 365)) * 86_400_000).toISOString();
  const q = env.sql;
  const [profiles, lists, forms, sends, flows, events, broadcasts] = await Promise.all([
    q(`SELECT status, count(*)::int AS n FROM profiles WHERE site = $1 GROUP BY status ORDER BY status`, [site]),
    q(`SELECT m.list, count(*)::int AS n FROM memberships m JOIN profiles p ON p.id = m.profile_id WHERE p.site = $1 AND p.status = 'subscribed' GROUP BY m.list`, [site]),
    q(`SELECT form_id, count(*)::int AS signups FROM consents WHERE site = $1 AND at > $2 GROUP BY form_id ORDER BY signups DESC`, [site, since]),
    q(`SELECT kind, status, count(*)::int AS n, count(opened_at)::int AS opened, count(clicked_at)::int AS clicked FROM sends WHERE site = $1 AND at > $2 GROUP BY kind, status`, [site, since]),
    q(`SELECT flow_id, state, count(*)::int AS n FROM enrollments WHERE site = $1 GROUP BY flow_id, state ORDER BY flow_id, state`, [site]),
    q(`SELECT name, count(*)::int AS n, count(DISTINCT anon_id)::int AS visitors FROM events WHERE site = $1 AND at > $2 GROUP BY name ORDER BY n DESC LIMIT 15`, [site, since]),
    q(`SELECT b.id, b.state, count(s.id) FILTER (WHERE s.status = 'sent')::int AS sent, count(s.opened_at)::int AS opened, count(s.clicked_at)::int AS clicked
       FROM broadcasts b LEFT JOIN sends s ON s.kind = 'broadcast' AND s.ref = b.id WHERE b.site = $1 GROUP BY b.id, b.state, b.created_at ORDER BY b.created_at DESC LIMIT 10`, [site]),
  ]);
  return { site, days, since, profiles, lists, forms, sends, flows, events, broadcasts };
}

export async function handle(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url);
  let cors: Record<string, string> | null = null;
  try {
    const p = url.pathname;
    if (p === '/c') return await click(env, url);
    if (p === '/o') return await open(env, url);
    if (p === '/u') return await unsubscribe(env, req, url);
    if (p === '/api/webhooks/resend' && req.method === 'POST') return await resendWebhook(env, req);
    if (p.startsWith('/api/webhooks/twilio') && req.method === 'POST') return await twilioWebhook(env, req, url);
    if (p.startsWith('/app/api/')) return await ownerApi(env, req, url);
    if (p === '/app/auth') return await ownerAuth(env, req, url);
    if (p === '/appt' || p === '/appt.ics') return await appt(env, req, url);
    if (p.startsWith('/book/') && req.method === 'GET') {
      const [, , siteId, calId] = p.split('/');
      const site = /^[a-z0-9-]{1,41}$/.test(siteId ?? '') ? await loadSite(env.sql, siteId) : null;
      const cal = site?.config.crm?.calendars?.find((c) => c.id === calId);
      if (!site || !cal) return page('Not found', '<p>This booking page doesn\'t exist.</p>', 404);
      return new Response(bookingPage(site, cal), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (p === '/api/slots' && req.method === 'GET') {
      const site = await loadSite(env.sql, url.searchParams.get('site') ?? '');
      if (!site?.config.crm) return json({ error: 'unknown site' }, 404);
      return json({ slots: await slots(env, site, url.searchParams.get('calendar') ?? '', url.searchParams.get('from')) }, 200, { 'cache-control': 'no-store' });
    }
    if (p === '/api/book' && req.method === 'POST') {
      // The booking page is on this domain; a site may also post from its own origin.
      const b = await body(req);
      const site = /^[a-z0-9-]{1,41}$/.test(String(b.site ?? '')) ? await loadSite(env.sql, b.site) : null;
      if (!site?.config.crm) return json({ error: 'unknown site' }, 404);
      const origin = req.headers.get('origin');
      if (origin !== new URL(env.publicUrl).origin && !site.config.origins.includes(origin ?? '')) return json({ error: 'origin not allowed' }, 403);
      try {
        return json(await submitBooking(env, site, b, clientIp(req), req.headers.get('user-agent') ?? ''));
      } catch (e) {
        if (e instanceof BadInput || e instanceof Taken || /^(no calendar|that time)/.test((e as Error).message)) return json({ error: (e as Error).message }, e instanceof Taken ? 409 : 400);
        throw e;
      }
    }
    if (p.startsWith('/api/admin/')) return await admin(env, req, url);
    if (p === '/api/cron') {
      if (!env.cronSecret || !same(bearer(req), env.cronSecret)) return json({ error: 'unauthorized' }, 401);
      return json({ flows: await runDue(env, { limit: 50 }), workflows: await runWorkflows(env, { limit: 100 }), reminders: await runReminders(env), broadcasts: await runBroadcasts(env, { limit: 50 }) });
    }
    if (p === '/api/health') return json({ ok: true });

    // Public routes from client sites.
    const isPost = req.method === 'POST';
    const b = isPost ? await body(req) : {};
    const siteId = String((isPost ? b.site : url.searchParams.get('site')) ?? '');
    const site = /^[a-z0-9-]{1,41}$/.test(siteId) ? await loadSite(env.sql, siteId) : null;
    cors = corsFor(site, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
    if (!site) return json({ error: 'unknown site' }, 404);
    // The forms are public (any visitor's browser fetches them), so a GET with no Origin
    // (same-origin, or a crawler) is fine; a foreign Origin still gets no CORS header.
    if (p === '/api/forms' && req.method === 'GET' && (cors || !req.headers.get('origin'))) {
      return json(publicForms(site.config), 200, { ...cors, 'cache-control': 'public, max-age=60' });
    }
    // Browsers send Origin on every POST; a missing or foreign one is refused.
    if (!cors) return json({ error: 'origin not allowed' }, 403);
    if (p === '/api/subscribe' && isPost) return json(await subscribe(env, site, req, b), 200, cors);
    if (p === '/api/lead' && isPost) {
      try { return json(await submitLead(env, site, b, clientIp(req), req.headers.get('user-agent') ?? ''), 200, cors); } catch (e) { if (e instanceof BadInput) throw new HttpError(400, e.message); throw e; }
    }
    if (p === '/api/track' && isPost) return json(await track(env, site, b), 200, cors);
    if (p === '/api/identify' && isPost) {
      const c = verify(env.secret, b.token, 'id', env.now().getTime());
      if (!c || c.s !== site.config.id) return json({ ok: false }, 200, cors);
      await linkVisitor(env, site.config.id, b.anon_id, c.p);
      return json({ ok: true }, 200, cors);
    }
    return json({ error: 'not found' }, 404, cors);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status, cors ?? {});
    console.error(err);
    return json({ error: 'server error' }, 500);
  }
}
