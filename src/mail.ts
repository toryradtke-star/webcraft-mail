/**
 * Sending goes through Resend's HTTP API. The idempotency key is the send
 * row's id, so a retry after a timeout can't deliver the same email twice.
 * Marketing mail carries one-click List-Unsubscribe (RFC 8058), which Gmail
 * and Yahoo require of bulk senders.
 */
export type Outgoing = {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  unsubscribeUrl: string;
  idempotencyKey: string;
  tags?: Record<string, string>;
};

export type Mailer = (m: Outgoing) => Promise<{ id: string }>;

export function resendMailer(apiKey: string, fetchImpl: typeof fetch = fetch): Mailer {
  return async (m) => {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': m.idempotencyKey },
      body: JSON.stringify({
        from: m.from, to: [m.to], reply_to: m.replyTo, subject: m.subject, html: m.html, text: m.text,
        headers: { 'List-Unsubscribe': `<${m.unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
        tags: Object.entries(m.tags ?? {}).map(([name, value]) => ({ name, value: value.replace(/[^A-Za-z0-9_-]/g, '_') })),
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.id) throw new Error(`Resend ${res.status}: ${body.message ?? body.name ?? 'no id returned'}`);
    return { id: body.id };
  };
}
