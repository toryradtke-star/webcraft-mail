/**
 * Flows and broadcasts. Enrolling is cheap and happens inside the request
 * that caused it (a signup, a tracked event). Sending happens in runDue,
 * which the signup request calls for its own profile (so a welcome email with
 * after "0m" goes out within seconds) and the cron calls for everything else.
 *
 * Double sends are stopped twice over: an enrollment is claimed with a
 * conditional UPDATE before it's worked, and every email is first written to
 * sends under a unique (kind, ref, profile) key, whose id is the Resend
 * idempotency key.
 */
import type { Sql } from './db.ts';
import { durationMs, flowHash, type Flow, type SiteConfig, type Template } from './config.ts';
import type { Mailer } from './mail.ts';
import { merge, renderEmail, toText } from './render.ts';
import { sign, urlHash } from './tokens.ts';
import type { ReceivedEmail, SmsSender } from './sms.ts';
import { replyAddress } from './inbox.ts';

export type Env = {
  sql: Sql;
  mailer: Mailer;
  /** HMAC key for every link token. */
  secret: string;
  /** Where this service is served, e.g. "https://mail.webcraftmn.com". */
  publicUrl: string;
  adminToken: string;
  cronSecret?: string;
  webhookSecret?: string;
  now: () => Date;
  /** Milliseconds between Resend calls (its default limit is a few per second). */
  paceMs?: number;
  /** Texts through Twilio; without it nothing is texted. */
  sms?: SmsSender;
  twilioAuthToken?: string;
  /** Domain whose mail Resend receives (MX), for reply addresses: "in.webcraftmn.com". */
  inboundDomain?: string;
  /** Fetches a received email's content from Resend by id. */
  receivedEmail?: (id: string) => Promise<ReceivedEmail>;
};

export type Site = { config: SiteConfig; hashes: Record<string, string> };

const DEFAULT_CAP = 200;
const MAX_ATTEMPTS = 3;
const CLAIM_MS = 5 * 60_000;

export async function loadSite(sql: Sql, id: string): Promise<Site | null> {
  const [r] = await sql<{ config: SiteConfig; hashes: Record<string, string> }>('SELECT config, hashes FROM sites WHERE id = $1', [id]);
  return r ? { config: r.config, hashes: r.hashes } : null;
}

const iso = (d: Date) => d.toISOString();
const later = (now: Date, ms: number) => new Date(now.getTime() + ms);

/** Puts a profile into every enabled flow this happening starts. Once per flow, ever. */
export async function enroll(env: Env, site: Site, profileId: number, what: { type: 'subscribed'; list: string } | { type: 'event'; name: string; path?: string }): Promise<string[]> {
  const now = env.now();
  const started: string[] = [];
  for (const f of site.config.flows) {
    if (!f.enabled) continue;
    const t = f.trigger;
    const hit = t.type === 'subscribed'
      ? what.type === 'subscribed' && t.list === what.list
      : what.type === 'event' && t.name === what.name && (!t.pathPrefix || (what.path ?? '').startsWith(t.pathPrefix));
    if (!hit) continue;
    const r = await env.sql(`INSERT INTO enrollments (site, flow_id, profile_id, step, next_at, enrolled_at) VALUES ($1,$2,$3,0,$4,$5)
      ON CONFLICT (site, flow_id, profile_id) DO NOTHING RETURNING id`,
      [site.config.id, f.id, profileId, iso(later(now, durationMs(f.steps[0].after))), iso(now)]);
    if (r.length) started.push(f.id);
  }
  return started;
}

/** Sends in the last 24 hours for a site, against its warmup cap. */
async function capLeft(env: Env, c: SiteConfig): Promise<number> {
  const [r] = await env.sql<{ n: string }>(`SELECT count(*) AS n FROM sends WHERE site = $1 AND status = 'sent' AND at > $2`,
    [c.id, iso(later(env.now(), -86_400_000))]);
  return (c.dailyCap ?? DEFAULT_CAP) - Number(r.n);
}

export type Profile = { id: number; email: string; first_name: string | null; status: string };

export type DeliverOpts = {
  /** Merge fields beyond first_name and site_name. */
  vars?: Record<string, string | null | undefined>;
  /** Footer line saying why they got it, for people who never signed up. */
  reason?: string;
  /** Put it in the contact's conversation, written by this author. */
  log?: string;
  attachments?: { filename: string; content: string; contentType?: string }[];
};

/**
 * Writes the send row, then calls Resend. Returns 'sent', 'failed' (will be
 * retried), or 'gave-up' after MAX_ATTEMPTS.
 */
export async function deliver(env: Env, c: SiteConfig, p: Profile, kind: 'flow' | 'broadcast' | 'workflow' | 'appointment', ref: string, templateId: string, t: Template, tags: Record<string, string>, o: DeliverOpts = {}): Promise<'sent' | 'failed' | 'gave-up'> {
  const now = env.now();
  const unsubscribeUrl = `${env.publicUrl}/u?t=${sign(env.secret, { k: 'unsub', p: p.id, s: c.id })}`;
  const vars = { first_name: p.first_name, site_name: c.name, ...o.vars };
  const draft = renderEmail(c, t, vars, { unsubscribeUrl, reason: o.reason });
  await env.sql(`INSERT INTO sends (site, profile_id, kind, ref, template, subject, status, at) VALUES ($1,$2,$3,$4,$5,$6,'sending',$7)
    ON CONFLICT (kind, ref, profile_id) DO NOTHING`, [c.id, p.id, kind, ref, templateId, draft.subject, iso(now)]);
  const [row] = await env.sql<{ id: string; status: string; attempts: number }>(
    `UPDATE sends SET attempts = attempts + 1, status = 'sending' WHERE kind = $1 AND ref = $2 AND profile_id = $3 AND status IN ('sending','failed') AND attempts < $4 RETURNING id, status, attempts`,
    [kind, ref, p.id, MAX_ATTEMPTS]);
  if (!row) {
    const [existing] = await env.sql<{ status: string }>('SELECT status FROM sends WHERE kind = $1 AND ref = $2 AND profile_id = $3', [kind, ref, p.id]);
    return existing?.status === 'sent' ? 'sent' : 'gave-up';
  }
  const sendId = Number(row.id);
  const link = (u: string) => `${env.publicUrl}/c?t=${sign(env.secret, { k: 'click', send: sendId, h: urlHash(u) })}&u=${encodeURIComponent(u)}`;
  const mail = renderEmail(c, t, vars,
    { unsubscribeUrl, link, reason: o.reason, openPixelUrl: `${env.publicUrl}/o?t=${sign(env.secret, { k: 'open', send: sendId })}` });
  // On a CRM site, replies come back into the contact's conversation.
  const replyTo = c.crm && env.inboundDomain ? replyAddress(env, p.id) : c.replyTo;
  try {
    const r = await env.mailer({ from: c.from, to: p.email, replyTo, subject: mail.subject, html: mail.html, text: mail.text, unsubscribeUrl, idempotencyKey: `wm-send-${sendId}`, tags: { site: c.id, kind, ...tags }, attachments: o.attachments });
    await env.sql(`UPDATE sends SET status = 'sent', resend_id = $2, at = $3, error = NULL WHERE id = $1`, [sendId, r.id, iso(env.now())]);
    if (o.log) {
      await env.sql(`INSERT INTO messages (site, contact_id, channel, direction, subject, body, status, provider_id, author, at) VALUES ($1,$2,'email','out',$3,$4,'sent',$5,$6,$7)
        ON CONFLICT DO NOTHING`, [c.id, p.id, mail.subject, toText(merge(t.body, vars)), r.id, o.log, iso(env.now())]);
    }
    return 'sent';
  } catch (err) {
    await env.sql(`UPDATE sends SET status = 'failed', error = $2 WHERE id = $1`, [sendId, (err as Error).message.slice(0, 500)]);
    return row.attempts >= MAX_ATTEMPTS ? 'gave-up' : 'failed';
  } finally {
    if (env.paceMs) await new Promise((r) => setTimeout(r, env.paceMs));
  }
}

export type RunReport = { sent: number; failed: number; exited: number; done: number; capped: string[] };

/** Works through due flow steps, oldest first. Pass profileId to run only one person's. */
export async function runDue(env: Env, opts: { profileId?: number; limit?: number } = {}): Promise<RunReport> {
  const now = env.now();
  const report: RunReport = { sent: 0, failed: 0, exited: 0, done: 0, capped: [] };
  const claimed = await env.sql<{ id: string; site: string; flow_id: string; profile_id: string; step: number; enrolled_at: string }>(
    `UPDATE enrollments SET claimed_until = $2
     WHERE id IN (SELECT id FROM enrollments WHERE state = 'active' AND next_at <= $1 AND (claimed_until IS NULL OR claimed_until < $1)
                  ${opts.profileId ? 'AND profile_id = $4' : ''} ORDER BY next_at LIMIT $3)
       AND (claimed_until IS NULL OR claimed_until < $1)
     RETURNING id, site, flow_id, profile_id, step, enrolled_at`,
    [iso(now), iso(later(now, CLAIM_MS)), opts.limit ?? 50, ...(opts.profileId ? [opts.profileId] : [])]);
  const sites = new Map<string, Site | null>();
  const left = new Map<string, number>();
  const end = (id: string, state: 'done' | 'exited') => env.sql(`UPDATE enrollments SET state = $2, claimed_until = NULL WHERE id = $1`, [id, state]);
  const release = (id: string, nextAt?: Date) => env.sql(`UPDATE enrollments SET claimed_until = NULL${nextAt ? ', next_at = $2' : ''} WHERE id = $1`, nextAt ? [id, iso(nextAt)] : [id]);

  for (const e of claimed) {
    if (!sites.has(e.site)) sites.set(e.site, await loadSite(env.sql, e.site));
    const site = sites.get(e.site);
    const flow: Flow | undefined = site?.config.flows.find((f) => f.id === e.flow_id);
    // A flow that was turned off, removed, or edited without a new approval ends the runs in it.
    if (!site || !flow || !flow.enabled || site.hashes[flow.id] !== flowHash(site.config, flow)) { await end(e.id, 'exited'); report.exited++; continue; }
    const step = flow.steps[e.step];
    if (!step) { await end(e.id, 'done'); report.done++; continue; }
    const [p] = await env.sql<Profile>('SELECT id, email, first_name, status FROM profiles WHERE id = $1', [e.profile_id]);
    if (!p || p.status !== 'subscribed') { await end(e.id, 'exited'); report.exited++; continue; }
    if (step.unlessEvent) {
      const hit = await env.sql('SELECT 1 FROM events WHERE profile_id = $1 AND name = $2 AND at >= $3 LIMIT 1', [p.id, step.unlessEvent, e.enrolled_at]);
      if (hit.length) { await end(e.id, 'exited'); report.exited++; continue; }
    }
    if (!left.has(e.site)) left.set(e.site, await capLeft(env, site.config));
    if (left.get(e.site)! <= 0) {
      if (!report.capped.includes(e.site)) report.capped.push(e.site);
      await release(e.id);
      continue;
    }
    const r = await deliver(env, site.config, p, 'flow', `${e.id}:${e.step}`, step.template, site.config.templates[step.template], { flow: flow.id });
    if (r === 'sent') {
      report.sent++;
      left.set(e.site, left.get(e.site)! - 1);
      const next = flow.steps[e.step + 1];
      if (next) await env.sql(`UPDATE enrollments SET step = step + 1, next_at = $2, claimed_until = NULL WHERE id = $1`, [e.id, iso(later(env.now(), durationMs(next.after)))]);
      else { await end(e.id, 'done'); report.done++; }
    } else if (r === 'failed') {
      report.failed++;
      await release(e.id, later(env.now(), 3_600_000));
    } else {
      report.failed++;
      await end(e.id, 'exited');
      report.exited++;
    }
  }
  return report;
}

/** Sends queued broadcasts to their lists, within each site's cap. Picks up where it left off. */
export async function runBroadcasts(env: Env, opts: { limit?: number } = {}): Promise<RunReport> {
  const report: RunReport = { sent: 0, failed: 0, exited: 0, done: 0, capped: [] };
  let budget = opts.limit ?? 50;
  const open = await env.sql<{ id: string; site: string; list: string; template: Template }>(`SELECT id, site, list, template FROM broadcasts WHERE state = 'sending' ORDER BY created_at`);
  for (const b of open) {
    const site = await loadSite(env.sql, b.site);
    if (!site) continue;
    let left = await capLeft(env, site.config);
    const people = await env.sql<Profile>(
      `SELECT p.id, p.email, p.first_name, p.status FROM memberships m JOIN profiles p ON p.id = m.profile_id
       WHERE m.list = $1 AND p.site = $2 AND p.status = 'subscribed'
         AND NOT EXISTS (SELECT 1 FROM sends s WHERE s.kind = 'broadcast' AND s.ref = $3 AND s.profile_id = p.id AND (s.status = 'sent' OR s.attempts >= $4))
       ORDER BY p.id LIMIT $5`, [b.list, b.site, b.id, MAX_ATTEMPTS, Math.max(0, Math.min(budget, left))]);
    for (const p of people) {
      const r = await deliver(env, site.config, p, 'broadcast', b.id, `broadcast:${b.id}`, b.template, { broadcast: b.id });
      if (r === 'sent') { report.sent++; left--; } else report.failed++;
      budget--;
    }
    const [remaining] = await env.sql<{ n: string }>(
      `SELECT count(*) AS n FROM memberships m JOIN profiles p ON p.id = m.profile_id
       WHERE m.list = $1 AND p.site = $2 AND p.status = 'subscribed'
         AND NOT EXISTS (SELECT 1 FROM sends s WHERE s.kind = 'broadcast' AND s.ref = $3 AND s.profile_id = p.id AND (s.status = 'sent' OR s.attempts >= $4))`,
      [b.list, b.site, b.id, MAX_ATTEMPTS]);
    if (Number(remaining.n) === 0) { await env.sql(`UPDATE broadcasts SET state = 'done' WHERE id = $1`, [b.id]); report.done++; }
    else if (left <= 0) report.capped.push(b.site);
    if (budget <= 0) break;
  }
  return report;
}
