/** The one Vercel function. Every route in vercel config rewrites here. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handle } from './app.ts';
import { migrate, neonSql, type Sql } from './db.ts';
import { resendMailer } from './mail.ts';
import type { Env } from './runner.ts';
import { sendResponse, toRequest } from './node.ts';
import { twilioSender, type ReceivedEmail } from './sms.ts';

let ready: Promise<Env> | undefined;

function need(k: string): string {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
}

/** A received email's content from Resend (the key needs full access, not sending only). */
function resendReceiver(apiKey: string) {
  return async (id: string): Promise<ReceivedEmail> => {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${apiKey}` } });
    const b: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend ${res.status}: ${b.message ?? 'could not read the received email'}`);
    return { from: b.from, to: b.to ?? [], subject: b.subject ?? '', text: b.text ?? null, html: b.html ?? null };
  };
}

async function boot(): Promise<Env> {
  const sql: Sql = await neonSql(need('DATABASE_URL'));
  await migrate(sql);
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: twilio, INBOUND_DOMAIN: inbound } = process.env;
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
    // Texting and inbound replies are optional: without them the inbox is email-out only.
    sms: sid && twilio ? twilioSender(sid, twilio) : undefined,
    twilioAuthToken: twilio,
    inboundDomain: inbound,
    receivedEmail: inbound ? resendReceiver(need('RESEND_API_KEY')) : undefined,
  };
}

export default async function (req: IncomingMessage, res: ServerResponse) {
  ready ??= boot().catch((e) => { ready = undefined; throw e; });
  const env = await ready;
  const base = `https://${req.headers.host ?? 'localhost'}`;
  await sendResponse(res, await handle(env, await toRequest(req, base)));
}
