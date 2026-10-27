/**
 * Texting through Twilio's REST API, and the checks on what Twilio posts back.
 * Each business needs its own number registered for A2P 10DLC (a brand and a
 * campaign) before carriers deliver its texts; see the README.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SmsOut = { to: string; from: string; body: string; messagingServiceSid?: string; statusCallback?: string };
export type SmsSender = (m: SmsOut) => Promise<{ sid: string }>;

export type ReceivedEmail = { from: string; to: string[]; subject: string; text: string | null; html: string | null };

export function twilioSender(accountSid: string, authToken: string, fetchImpl: typeof fetch = fetch): SmsSender {
  return async (m) => {
    const form = new URLSearchParams({ To: m.to, Body: m.body });
    if (m.messagingServiceSid) form.set('MessagingServiceSid', m.messagingServiceSid); else form.set('From', m.from);
    if (m.statusCallback) form.set('StatusCallback', m.statusCallback);
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.sid) throw new Error(`Twilio ${res.status}: ${body.message ?? 'no sid returned'}${body.code ? ` (${body.code})` : ''}`);
    return { sid: body.sid };
  };
}

/**
 * X-Twilio-Signature: base64 HMAC-SHA1 of the full URL followed by every POST
 * parameter, sorted by name, as name+value.
 */
export function twilioValid(authToken: string, url: string, params: URLSearchParams, signature: string | null): boolean {
  if (!signature) return false;
  const keys = [...new Set(params.keys())].sort();
  const data = url + keys.map((k) => params.getAll(k).map((v) => k + v).join('')).join('');
  const want = Buffer.from(createHmac('sha1', authToken).update(data).digest('base64'));
  const got = Buffer.from(signature);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Twilio's standard opt-out and opt-in words, matched against the whole message. */
const STOP = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'revoke']);
const START = new Set(['start', 'unstop', 'yes']);

export function keyword(body: string): 'stop' | 'start' | 'help' | null {
  const w = body.trim().toLowerCase().replace(/[.!\s]+$/, '');
  if (STOP.has(w)) return 'stop';
  if (START.has(w)) return 'start';
  if (w === 'help' || w === 'info') return 'help';
  return null;
}

/** Twilio errors meaning the number can't get texts (landline, unreachable, blocked, opted out). */
export const UNDELIVERABLE = new Set(['21610', '21614', '30003', '30004', '30005', '30006', '30007']);
