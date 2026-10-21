/** The one Vercel function. Every route in vercel config rewrites here. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handle } from './app.ts';
import { migrate, neonSql, type Sql } from './db.ts';
import { resendMailer } from './mail.ts';
import type { Env } from './runner.ts';
import { sendResponse, toRequest } from './node.ts';

let ready: Promise<Env> | undefined;

function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
}

async function boot(): Promise<Env> {
  const sql: Sql = await neonSql(need('DATABASE_URL'));
  await migrate(sql);
  return {
    sql,
    mailer: resendMailer(need('RESEND_API_KEY')),
    secret: need('TOKEN_SECRET'),
    publicUrl: need('PUBLIC_URL').replace(/\/$/, ''),
    adminToken: need('ADMIN_TOKEN'),
    cronSecret: process.env.CRON_SECRET,
    webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
    now: () => new Date(),
    paceMs: 250,
  };
}

export default async function (req: IncomingMessage, res: ServerResponse) {
  ready ??= boot().catch((e) => { ready = undefined; throw e; });
  const env = await ready;
  const base = `https://${req.headers.host ?? 'localhost'}`;
  await sendResponse(res, await handle(env, await toRequest(req, base)));
}
