/**
 * Signed tokens for links in emails: unsubscribe, click tracking, the open
 * pixel and the onsite identity hand-off. The payload is readable (nothing in
 * it is secret); the HMAC is what stops anyone forging or editing one.
 */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export type Claims =
  | { k: 'unsub'; p: number; s: string }
  | { k: 'open'; send: number }
  | { k: 'click'; send: number; h: string }
  | { k: 'id'; p: number; s: string; exp: number }
  /** An appointment's own page: details, calendar file, cancel. */
  | { k: 'appt'; a: number; s: string }
  /** The owner app's emailed sign-in link. */
  | { k: 'login'; e: string; exp: number };

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function sign(secret: string, c: Claims): string {
  const body = b64(JSON.stringify(c));
  return `${body}.${b64(createHmac('sha256', secret).update(body).digest()).slice(0, 22)}`;
}

export function verify<K extends Claims['k']>(secret: string, token: string | null | undefined, kind: K, now = Date.now()): Extract<Claims, { k: K }> | null {
  if (!token) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(b64(createHmac('sha256', secret).update(body).digest()).slice(0, 22));
  const got = Buffer.from(mac);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let c: any;
  try { c = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (c?.k !== kind) return null;
  if ((c.k === 'id' || c.k === 'login') && !(c.exp > now)) return null;
  return c;
}

/** Short hash of a click target, so a click token works only for its own URL. */
export const urlHash = (url: string) => createHash('sha256').update(url).digest('base64url').slice(0, 12);
