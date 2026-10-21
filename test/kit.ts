/** A fresh in-memory database, the demo site, a fake mailer and a movable clock. */
import { readFileSync } from 'node:fs';
import { handle } from '../src/app.ts';
import { flowHashes, type SiteConfig } from '../src/config.ts';
import { migrate, pgliteSql } from '../src/db.ts';
import type { Outgoing } from '../src/mail.ts';
import type { Env } from '../src/runner.ts';

export const ORIGIN = 'https://northwoods-fitness.example';
export const demo = (): SiteConfig => JSON.parse(readFileSync(new URL('../examples/demo-gym.json', import.meta.url), 'utf8'));

export async function kit(opts: { config?: SiteConfig; failMail?: () => boolean } = {}) {
  const sql = await pgliteSql();
  await migrate(sql);
  let clock = new Date('2026-10-21T15:00:00Z');
  const mail: Outgoing[] = [];
  const env: Env = {
    sql, secret: 'test-secret', publicUrl: 'https://mail.test', adminToken: 'admin-token', cronSecret: 'cron-token', webhookSecret: 'whsec_' + Buffer.from('hook-key').toString('base64'),
    now: () => clock,
    mailer: async (m) => { if (opts.failMail?.()) throw new Error('Resend 500: down'); mail.push(m); return { id: `re_${mail.length}` }; },
  };
  const c = opts.config ?? demo();
  await sql(`INSERT INTO sites (id, config, hashes, updated_at) VALUES ($1,$2,$3,$4)`, [c.id, JSON.stringify(c), JSON.stringify(flowHashes(c)), clock.toISOString()]);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await handle(env, new Request(`https://mail.test${path}`, {
      method, headers: { origin: ORIGIN, 'content-type': 'text/plain', 'x-forwarded-for': '203.0.113.9', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }));
    const text = await r.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: r.status, headers: r.headers, text, json };
  };
  return {
    env, sql, mail, call, site: c,
    advance: (ms: number) => { clock = new Date(clock.getTime() + ms); },
    subscribe: (email: string, extra: Record<string, unknown> = {}) => call('POST', '/api/subscribe', { site: c.id, form: 'popup-tour', email, first_name: 'Sam', anon_id: 'anon-aaaaaaaa', url: `${ORIGIN}/`, ...extra }),
  };
}

export const DAY = 86_400_000;
