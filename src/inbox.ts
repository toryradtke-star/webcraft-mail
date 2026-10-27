/**
 * The inbox: one conversation per contact, email and text in one thread.
 *
 * Email replies come back through Resend Inbound. Every email a CRM site
 * sends has Reply-To c<contact>.<mac>@<inboundDomain>; Resend posts
 * email.received, the body is fetched by id, and the mac proves the address
 * wasn't made up. Texts come in from Twilio, matched to the site by the number
 * they were sent to.
 *
 * Automated texts (workflows, reminders) go only to people who ticked the SMS
 * box, and only between 9:00 and 20:00 local. A person can always text the
 * business and get a reply typed by a person. STOP is honored on every path.
 */
import { createHmac } from 'node:crypto';
import type { Env, Site } from './runner.ts';
import { activity, fullName, getContact, upsertContact, type Contact } from './crm.ts';
import { esc } from './render.ts';
import { keyword, UNDELIVERABLE } from './sms.ts';
import { fire, runWorkflows } from './workflows.ts';
import { loadSite } from './runner.ts';

const iso = (d: Date) => d.toISOString();
const mac = (env: Env, contactId: number) => createHmac('sha256', env.secret).update(`reply:${contactId}`).digest('hex').slice(0, 12);

export const replyAddress = (env: Env, contactId: number) => `c${contactId}.${mac(env, contactId)}@${env.inboundDomain}`;

/** The contact a reply address belongs to, or null if it's forged or not ours. */
export function contactFromAddress(env: Env, address: string): number | null {
  const m = /^c(\d{1,12})\.([0-9a-f]{12})@(.+)$/i.exec(address.trim().replace(/^.*<([^>]+)>.*$/, '$1'));
  if (!m || !env.inboundDomain || m[3].toLowerCase() !== env.inboundDomain.toLowerCase()) return null;
  const id = Number(m[1]);
  return mac(env, id) === m[2].toLowerCase() ? id : null;
}

/** The new part of a reply: everything above the quoted original. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  const cut = lines.findIndex((l, i) => /^On .{4,200} wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l.trim())
    || (/^From: .+/.test(l) && lines.slice(i + 1, i + 4).some((x) => /^(Sent|Date|To|Subject): /.test(x))) || /^>/.test(l));
  return (cut >= 0 ? lines.slice(0, cut) : lines).join('\n').trim();
}

const htmlToText = (html: string) => html.replace(/<(br|\/p|\/div|\/li)[^>]*>/gi, '\n').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n');

/** Plain text typed by a person, as a simple email that looks personal. */
function personalHtml(body: string): string {
  return `<!doctype html><html><body style="font:15px/1.55 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">${
    body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</body></html>`;
}

export type SendResult = { id: number; status: 'sent' | 'failed' | 'skipped'; why?: string };

/** Whether this contact can get a text, and why not. */
export function smsBlocked(site: Site, env: Env, c: Contact, automated: boolean, hasInbound: boolean): string | null {
  if (!site.config.crm?.sms || !env.sms) return 'this business has no texting set up';
  if (!c.phone) return 'no phone number';
  if (c.sms_status === 'stopped') return 'they replied STOP';
  if (automated && c.sms_status !== 'consented') return 'they never ticked the box for texts';
  if (!automated && c.sms_status !== 'consented' && !hasInbound) return 'they never ticked the box for texts or texted in first';
  return null;
}

/**
 * Sends one message in the contact's conversation. author is the person
 * (their email) or "workflow:<id>"; key, when given, makes a retry a no-op.
 */
export async function sendMessage(env: Env, site: Site, contactId: number, m: { channel: 'email' | 'sms'; subject?: string; body: string; author: string; automated?: boolean; key?: string }): Promise<SendResult> {
  const s = site.config.id;
  const c = await getContact(env, s, contactId);
  if (!c) throw new Error('no such contact');
  const body = m.body.trim().slice(0, m.channel === 'sms' ? 1200 : 20000);
  if (!body) throw new Error('the message is empty');
  if (m.key) {
    const [done] = await env.sql<any>(`SELECT id, status FROM messages WHERE contact_id = $1 AND author = $2 AND direction = 'out' LIMIT 1`, [contactId, m.key]);
    if (done) return { id: Number(done.id), status: done.status };
  }
  const now = iso(env.now());
  let why: string | null = null;
  if (m.channel === 'email') {
    if (!c.email) why = 'no email address';
    else if (c.status === 'bounced' || c.status === 'complained') why = `their address ${c.status}`;
    else if (m.automated && c.status === 'unsubscribed') why = 'they unsubscribed';
  } else {
    const [inb] = await env.sql(`SELECT 1 FROM messages WHERE contact_id = $1 AND channel = 'sms' AND direction = 'in' LIMIT 1`, [contactId]);
    why = smsBlocked(site, env, c, !!m.automated, !!inb);
  }
  const subject = m.channel === 'email' ? (m.subject?.trim() || `A message from ${site.config.name}`).slice(0, 200) : null;
  let text = body;
  if (m.channel === 'sms' && !why) {
    // The first text a number gets from the business says how to opt out.
    const [prior] = await env.sql(`SELECT 1 FROM messages WHERE contact_id = $1 AND channel = 'sms' AND direction = 'out' AND status IN ('sent','delivered') LIMIT 1`, [contactId]);
    if (!prior) text = `${site.config.name}: ${body}\nReply STOP to opt out.`;
  }
  const [row] = await env.sql<any>(`INSERT INTO messages (site, contact_id, channel, direction, subject, body, status, author, at, error) VALUES ($1,$2,$3,'out',$4,$5,$6,$7,$8,$9) RETURNING id`,
    [s, contactId, m.channel, subject, text, why ? 'skipped' : 'queued', m.key ?? m.author, now, why]);
  const id = Number(row.id);
  if (why) return { id, status: 'skipped', why };
  try {
    let providerId: string;
    if (m.channel === 'email') {
      const r = await env.mailer({ from: site.config.from, to: c.email!, replyTo: env.inboundDomain ? replyAddress(env, contactId) : site.config.replyTo, subject: subject!, html: personalHtml(body), text: body, idempotencyKey: `wm-msg-${id}`, tags: { site: s, kind: 'message' } });
      providerId = r.id;
    } else {
      const r = await env.sms!({ to: c.phone!, from: site.config.crm!.sms!.from, messagingServiceSid: site.config.crm!.sms!.messagingServiceSid, body: text, statusCallback: `${env.publicUrl}/api/webhooks/twilio/status` });
      providerId = r.sid;
    }
    await env.sql(`UPDATE messages SET status = 'sent', provider_id = $2 WHERE id = $1`, [id, providerId]);
    await env.sql('UPDATE profiles SET last_activity_at = $2 WHERE id = $1', [contactId, now]);
    return { id, status: 'sent' };
  } catch (err) {
    const e = (err as Error).message.slice(0, 500);
    await env.sql(`UPDATE messages SET status = 'failed', error = $2 WHERE id = $1`, [id, e]);
    const code = /\((\d{5})\)$/.exec(e)?.[1];
    if (m.channel === 'sms' && code && UNDELIVERABLE.has(code)) await env.sql(`UPDATE profiles SET sms_status = 'stopped' WHERE id = $1`, [contactId]);
    return { id, status: 'failed', why: e };
  }
}

/** Emails the business's own people (crm.notify, else every user). */
export async function notifyTeam(env: Env, site: Site, subject: string, text: string, key: string): Promise<void> {
  const crm = site.config.crm;
  if (!crm) return;
  const to = crm.notify?.length ? crm.notify : crm.users.map((u) => u.email);
  for (const addr of to) {
    try {
      await env.mailer({ from: site.config.from, to: addr, subject, text, html: personalHtml(text), idempotencyKey: `wm-notify-${key}-${addr}`.slice(0, 250), tags: { site: site.config.id, kind: 'notify' } });
    } catch (err) { console.error(`notify ${site.config.id}: ${(err as Error).message}`); }
  }
}

export const contactLink = (env: Env, site: string, id: number) => `${env.publicUrl}/app/?site=${site}#contact/${id}`;

async function received(env: Env, site: Site, c: Contact, m: { channel: 'email' | 'sms'; subject?: string | null; body: string; providerId: string }): Promise<boolean> {
  const s = site.config.id;
  const r = await env.sql(`INSERT INTO messages (site, contact_id, channel, direction, subject, body, status, provider_id, author, at) VALUES ($1,$2,$3,'in',$4,$5,'received',$6,'contact',$7)
    ON CONFLICT DO NOTHING RETURNING id`, [s, c.id, m.channel, m.subject ?? null, m.body.slice(0, 20000), m.providerId, iso(env.now())]);
  if (!r.length) return false; // a webhook delivered twice
  await activity(env, s, c.id, m.channel === 'sms' ? 'Replied by Text' : 'Replied by Email');
  await fire(env, site, c.id, { type: 'customer_replied', channel: m.channel });
  await runWorkflows(env, { contactId: c.id });
  const snippet = m.body.length > 300 ? `${m.body.slice(0, 300)}…` : m.body;
  await notifyTeam(env, site, `New ${m.channel === 'sms' ? 'text' : 'email'} from ${fullName(c)}`, `${fullName(c)} wrote:\n\n${snippet}\n\nReply: ${contactLink(env, s, c.id)}`, `in-${r[0].id}`);
  return true;
}

/** Resend's email.received: find the contact from the reply address, fetch the body, thread it. */
export async function inboundEmail(env: Env, data: { email_id?: string; to?: string[] | string; subject?: string }): Promise<'ok' | 'ignored'> {
  if (!data?.email_id || !env.receivedEmail) return 'ignored';
  const to = Array.isArray(data.to) ? data.to : [data.to ?? ''];
  const contactId = to.map((a) => contactFromAddress(env, a)).find((x) => x !== null);
  if (!contactId) return 'ignored';
  const [p] = await env.sql<any>('SELECT site FROM profiles WHERE id = $1', [contactId]);
  const site = p ? await loadSite(env.sql, p.site) : null;
  if (!site) return 'ignored';
  const c = (await getContact(env, site.config.id, contactId))!;
  const mail = await env.receivedEmail(data.email_id);
  const body = stripQuoted(mail.text ?? htmlToText(mail.html ?? '')) || '(empty reply)';
  await received(env, site, c, { channel: 'email', subject: mail.subject ?? data.subject, body, providerId: data.email_id });
  return 'ok';
}

/** Twilio's inbound text: opt-out words first, then into the conversation. */
export async function inboundSms(env: Env, p: URLSearchParams): Promise<'ok' | 'ignored'> {
  const to = p.get('To') ?? '', from = p.get('From') ?? '', body = p.get('Body') ?? '', sid = p.get('MessageSid') ?? '';
  const [row] = await env.sql<any>(`SELECT id FROM sites WHERE config->'crm'->'sms'->>'from' = $1`, [to]);
  const site = row ? await loadSite(env.sql, row.id) : null;
  if (!site || !from || !sid) return 'ignored';
  const { contact } = await upsertContact(env, site, { phone: from, source: 'Text message' });
  const kw = keyword(body);
  if (kw === 'stop') {
    await env.sql(`UPDATE profiles SET sms_status = 'stopped' WHERE id = $1`, [contact.id]);
    await activity(env, site.config.id, contact.id, 'Texts Stopped', { word: body.trim() });
  } else if (kw === 'start') {
    await env.sql(`UPDATE profiles SET sms_status = 'consented' WHERE id = $1`, [contact.id]);
    await activity(env, site.config.id, contact.id, 'Texts Restarted', { word: body.trim() });
  }
  await received(env, site, (await getContact(env, site.config.id, contact.id))!, { channel: 'sms', body: body || '(empty text)', providerId: sid });
  return 'ok';
}

/** Twilio's delivery report for a text we sent. */
export async function smsStatus(env: Env, p: URLSearchParams): Promise<void> {
  const sid = p.get('MessageSid'), status = p.get('MessageStatus'), code = p.get('ErrorCode');
  if (!sid || !status) return;
  const mapped = status === 'delivered' ? 'delivered' : status === 'failed' || status === 'undelivered' ? 'failed' : null;
  if (!mapped) return;
  const [m] = await env.sql<any>(`UPDATE messages SET status = $2, error = COALESCE($3, error) WHERE channel = 'sms' AND provider_id = $1 RETURNING contact_id`, [sid, mapped, code ? `Twilio error ${code}` : null]);
  if (m && code && UNDELIVERABLE.has(code)) await env.sql(`UPDATE profiles SET sms_status = 'stopped' WHERE id = $1`, [m.contact_id]);
}
