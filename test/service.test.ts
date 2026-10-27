import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { configProblems, flowHashes } from '../src/config.ts';
import { renderEmail } from '../src/render.ts';
import { runDue } from '../src/runner.ts';
import { sign, verify } from '../src/tokens.ts';
import { DAY, demo, kit, ORIGIN } from './kit.ts';

const tokenIn = (url: string) => new URL(url).searchParams.get('t')!;
const linksIn = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));

test('the demo config is valid, and the validator names real problems', () => {
  assert.deepEqual(configProblems(demo()), []);
  const bad = demo();
  bad.address = '';
  bad.forms[0].list = 'nope';
  bad.flows[0].steps[1].after = 'two days';
  bad.flows[0].steps[0].template = 'missing';
  const p = configProblems(bad).join('\n');
  assert.match(p, /CAN-SPAM/);
  assert.match(p, /list "nope"/);
  assert.match(p, /"two days" is not a wait/);
  assert.match(p, /template "missing"/);
});

test('a signup stores consent, sends the welcome now and the second step two days later', async () => {
  const k = await kit();
  const r = await k.subscribe('Sam@Example.com');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  assert.ok(verify(k.env.secret, r.json.token, 'id', k.env.now().getTime()));

  const [consent] = await k.sql('SELECT * FROM consents');
  assert.equal(consent.form_id, 'popup-tour');
  assert.match(consent.wording, /agree to get emails/);
  assert.equal(consent.ip, '203.0.113.9');

  assert.equal(k.mail.length, 1);
  const m = k.mail[0];
  assert.equal(m.to, 'sam@example.com');
  assert.equal(m.subject, 'Your free week, Sam');
  assert.match(m.html, /100 Main St, Pine City/);
  assert.match(m.text, /Unsubscribe: https:\/\/mail\.test\/u\?t=/);
  assert.match(m.unsubscribeUrl!, /^https:\/\/mail\.test\/u\?t=/);
  assert.ok(linksIn(m.html).some((l) => l.startsWith('https://mail.test/c?')), 'links are click-tracked');

  // Nothing more is due yet.
  assert.equal((await runDue(k.env)).sent, 0);
  k.advance(2 * DAY + 60_000);
  const r2 = await k.call('GET', '/api/cron', undefined, { authorization: 'Bearer cron-token' });
  assert.equal(r2.json.flows.sent, 1);
  assert.equal(k.mail[1].subject, 'How was your first visit?');
  const [e] = await k.sql(`SELECT state FROM enrollments WHERE flow_id = 'welcome'`);
  assert.equal(e.state, 'done');
});

test('signing up again does not restart the welcome series', async () => {
  const k = await kit();
  await k.subscribe('sam@example.com');
  await k.subscribe('sam@example.com');
  assert.equal(k.mail.length, 1);
  const [n] = await k.sql('SELECT count(*)::int AS n FROM profiles');
  assert.equal(n.n, 1);
});

test('unlessEvent ends the flow when the person already did the thing', async () => {
  const k = await kit();
  await k.subscribe('sam@example.com');
  await k.call('POST', '/api/track', { site: 'demo-gym', anon_id: 'anon-aaaaaaaa', event: 'Joined', url: `${ORIGIN}/join/thanks` });
  k.advance(3 * DAY);
  const r = await runDue(k.env);
  assert.equal(r.sent, 0);
  assert.equal(r.exited, 1);
  assert.equal(k.mail.length, 1);
});

test('foreign origins, unknown sites, bad emails, bots and floods are refused', async () => {
  const k = await kit();
  assert.equal((await k.call('POST', '/api/subscribe', { site: 'demo-gym', form: 'popup-tour', email: 'a@b.co' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await k.call('POST', '/api/subscribe', { site: 'nope', form: 'popup-tour', email: 'a@b.co' })).status, 404);
  const bad = await k.subscribe('not-an-email');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /valid email/);
  assert.equal(bad.headers.get('access-control-allow-origin'), ORIGIN, 'the form can read the error');
  const bot = await k.subscribe('bot@example.com', { company: 'Acme' });
  assert.equal(bot.status, 200);
  assert.equal((await k.sql('SELECT * FROM profiles')).length, 0);
  for (let i = 0; i < 5; i++) assert.equal((await k.subscribe(`p${i}@example.com`)).status, 200);
  assert.equal((await k.subscribe('p6@example.com')).status, 429);
});

test('unsubscribe: GET only asks, POST (button or one-click) unsubscribes and stops flows', async () => {
  const k = await kit();
  await k.subscribe('sam@example.com');
  const t = tokenIn(k.mail[0].unsubscribeUrl!);
  const ask = await k.call('GET', `/u?t=${t}`);
  assert.match(ask.text, /Stop getting emails from Northwoods Fitness/);
  assert.equal((await k.sql('SELECT status FROM profiles'))[0].status, 'subscribed');
  const done = await k.call('POST', `/u?t=${t}`, 'List-Unsubscribe=One-Click', { origin: '' });
  assert.match(done.text, /You're unsubscribed/);
  assert.equal((await k.sql('SELECT status FROM profiles'))[0].status, 'unsubscribed');
  k.advance(3 * DAY);
  assert.equal((await runDue(k.env)).sent, 0);
  assert.equal((await k.call('GET', `/u?t=${t}x`)).status, 400);
});

test('clicks redirect only to the signed URL, and links back to the site carry identity', async () => {
  const k = await kit();
  await k.subscribe('sam@example.com', { anon_id: undefined });
  const link = linksIn(k.mail[0].html).find((l) => l.startsWith('https://mail.test/c?'))!;
  const u = new URL(link);
  const r = await k.call('GET', u.pathname + u.search);
  assert.equal(r.status, 302);
  const dest = new URL(r.headers.get('location')!);
  assert.equal(dest.origin + dest.pathname, `${ORIGIN}/hours`);
  const idToken = dest.searchParams.get('_wm')!;
  assert.ok(idToken);
  const [s] = await k.sql('SELECT opened_at, clicked_at FROM sends');
  assert.ok(s.clicked_at && s.opened_at);

  u.searchParams.set('u', 'https://evil.example/phish');
  assert.equal((await k.call('GET', u.pathname + u.search)).status, 400, 'no open redirect');

  // A new browser that arrives through the email is tied to Sam, with its earlier page views.
  await k.call('POST', '/api/track', { site: 'demo-gym', anon_id: 'anon-bbbbbbbb', event: 'Viewed Page', url: `${ORIGIN}/hours` });
  assert.equal((await k.call('POST', '/api/identify', { site: 'demo-gym', anon_id: 'anon-bbbbbbbb', token: idToken })).json.ok, true);
  const [ev] = await k.sql(`SELECT profile_id FROM events WHERE anon_id = 'anon-bbbbbbbb'`);
  assert.ok(ev.profile_id);
  assert.equal((await k.call('POST', '/api/identify', { site: 'demo-gym', anon_id: 'anon-cccccccc', token: idToken + 'x' })).json.ok, false);
});

test('an event flow starts only for known people on matching pages', async () => {
  const k = await kit();
  await k.call('POST', '/api/track', { site: 'demo-gym', anon_id: 'anon-stranger', event: 'Viewed Page', url: `${ORIGIN}/pricing` });
  await k.subscribe('sam@example.com');
  await k.call('POST', '/api/track', { site: 'demo-gym', anon_id: 'anon-aaaaaaaa', event: 'Viewed Page', url: `${ORIGIN}/about` });
  assert.equal((await k.sql(`SELECT * FROM enrollments WHERE flow_id = 'pricing-nudge'`)).length, 0);
  await k.call('POST', '/api/track', { site: 'demo-gym', anon_id: 'anon-aaaaaaaa', event: 'Viewed Page', url: `${ORIGIN}/pricing?x=1` });
  assert.equal((await k.sql(`SELECT * FROM enrollments WHERE flow_id = 'pricing-nudge'`)).length, 1);
  k.advance(DAY + 60_000);
  await runDue(k.env);
  assert.ok(k.mail.some((m) => m.subject === 'Questions about memberships?'));
});

test('the daily cap holds sends back until the window clears', async () => {
  const c = demo();
  c.dailyCap = 2;
  const k = await kit({ config: c });
  await k.subscribe('a@example.com');
  await k.subscribe('b@example.com');
  await k.subscribe('c@example.com');
  assert.equal(k.mail.length, 2);
  k.advance(DAY + 60_000);
  await runDue(k.env);
  assert.ok(k.mail.some((m) => m.to === 'c@example.com' && m.subject.startsWith('Your free week')));
});

test('a failed send retries with the same idempotency key, never sends twice, and gives up after 3', async () => {
  let fail = true;
  const k = await kit({ failMail: () => fail });
  await k.subscribe('sam@example.com');
  assert.equal(k.mail.length, 0);
  const [s1] = await k.sql('SELECT status, attempts, error FROM sends');
  assert.equal(s1.status, 'failed');
  assert.match(s1.error, /Resend 500/);
  k.advance(3_600_000 + 1);
  fail = false;
  await runDue(k.env);
  await runDue(k.env);
  assert.equal(k.mail.length, 1);
  assert.equal(k.mail[0].idempotencyKey, 'wm-send-1');

  const k2 = await kit({ failMail: () => true });
  await k2.subscribe('sam@example.com');
  for (let i = 0; i < 3; i++) { k2.advance(3_600_000 + 1); await runDue(k2.env); }
  const [e] = await k2.sql('SELECT state FROM enrollments');
  assert.equal(e.state, 'exited');
  assert.equal((await k2.sql('SELECT attempts FROM sends'))[0].attempts, 3);
});

function svix(secret: string, body: string, now: Date) {
  const id = 'msg_1', ts = String(Math.floor(now.getTime() / 1000));
  const sig = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
  return { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` };
}

test('bounces and complaints suppress the person for good; unsigned webhooks are refused', async () => {
  const k = await kit();
  await k.subscribe('sam@example.com');
  const body = JSON.stringify({ type: 'email.bounced', data: { email_id: 're_1', bounce: { type: 'Permanent' } } });
  assert.equal((await k.call('POST', '/api/webhooks/resend', body)).status, 401);
  assert.equal((await k.call('POST', '/api/webhooks/resend', body, svix(k.env.webhookSecret!, body, k.env.now()))).status, 200);
  assert.equal((await k.sql('SELECT status FROM profiles'))[0].status, 'bounced');
  await k.subscribe('sam@example.com');
  assert.equal((await k.sql('SELECT status FROM profiles'))[0].status, 'bounced');
  k.advance(3 * DAY);
  await runDue(k.env);
  assert.equal(k.mail.length, 1);
});

test('admin: push needs the token, rejects bad config, and a flow edited behind its back stops', async () => {
  const k = await kit();
  assert.equal((await k.call('PUT', '/api/admin/sites', demo())).status, 401);
  const bad = { ...demo(), address: '' };
  const r = await k.call('PUT', '/api/admin/sites', bad, { authorization: 'Bearer admin-token' });
  assert.equal(r.status, 400);
  assert.match(r.json.problems.join(' '), /CAN-SPAM/);
  const ok = await k.call('PUT', '/api/admin/sites', demo(), { authorization: 'Bearer admin-token' });
  assert.deepEqual(ok.json.hashes, flowHashes(demo()));

  await k.subscribe('sam@example.com');
  // Someone edits the template in the database without pushing (so without approval).
  const c = demo();
  c.templates['welcome-2'].body = 'Something nobody approved';
  await k.sql('UPDATE sites SET config = $1', [JSON.stringify(c)]);
  k.advance(3 * DAY);
  const run = await runDue(k.env);
  assert.equal(run.sent, 0);
  assert.equal(run.exited, 1);
});

test('broadcasts go once to subscribed members, across runs, then finish', async () => {
  const k = await kit();
  for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) await k.subscribe(e);
  await k.sql(`UPDATE profiles SET status = 'unsubscribed' WHERE email = 'c@example.com'`);
  const auth = { authorization: 'Bearer admin-token' };
  const b = { id: 'oct-news', list: 'newsletter', template: { subject: 'October at the gym', body: 'New hours, {{first_name|friend}}.' } };
  const r = await k.call('POST', '/api/admin/broadcasts?site=demo-gym', b, auth);
  assert.equal(r.json.firstBatch.sent, 2);
  assert.equal((await k.call('POST', '/api/admin/broadcasts?site=demo-gym', b, auth)).status, 409);
  await k.call('GET', '/api/cron', undefined, { authorization: 'Bearer cron-token' });
  const news = k.mail.filter((m) => m.subject === 'October at the gym');
  assert.deepEqual(news.map((m) => m.to).sort(), ['a@example.com', 'b@example.com']);
  assert.equal((await k.sql(`SELECT state FROM broadcasts`))[0].state, 'done');

  const stats = await k.call('GET', '/api/admin/stats?site=demo-gym', undefined, auth);
  assert.equal(stats.status, 200);
  assert.ok(stats.json.profiles.some((p: any) => p.status === 'subscribed' && p.n === 2));
  assert.equal(stats.json.forms[0].signups, 3);
});

test('forms endpoint gives forms only, with defaults filled in', async () => {
  const k = await kit();
  const r = await k.call('GET', '/api/forms?site=demo-gym');
  assert.equal(r.status, 200);
  assert.equal(r.json.forms.length, 3);
  assert.equal(r.json.forms[1].triggers.hideIfSubscribed, true);
  const lead = r.json.forms[2];
  assert.equal(lead.kind, 'lead');
  assert.equal(lead.triggers.hideIfSubscribed, false, 'a contact form stays for people already on the list');
  assert.deepEqual(lead.fields[4], { name: 'custom:goal', label: 'Main goal', type: 'select', options: ['Lose weight', 'Get stronger', 'Feel better'] });
  assert.equal(r.json.crm, undefined);
  assert.equal(r.json.flows, undefined);
  assert.equal(JSON.stringify(r.json).includes('owner@'), false, 'no sender details leak');
});

test('rendering escapes HTML, fills merge tags and always adds the footer', () => {
  const c = demo();
  const r = renderEmail(c, { subject: 'Hi {{first_name|there}}', body: 'Hello <script>x</script> **{{first_name|there}}**' }, { first_name: '<b>Al</b>', site_name: c.name }, { unsubscribeUrl: 'https://mail.test/u?t=1' });
  assert.equal(r.subject, 'Hi <b>Al</b>');
  assert.doesNotMatch(r.html, /<script>/);
  assert.match(r.html, /&lt;b&gt;Al&lt;\/b&gt;/);
  assert.match(r.html, /signed up at northwoods-fitness\.example/);
  const blank = renderEmail(c, { subject: 'Hi {{first_name|there}}', body: 'x' }, { first_name: '  ', site_name: c.name }, { unsubscribeUrl: 'u' });
  assert.equal(blank.subject, 'Hi there');
});

test('tokens: forged, edited, expired or wrong-kind tokens fail', () => {
  const t = sign('s', { k: 'id', p: 1, s: 'x', exp: 2000 });
  assert.ok(verify('s', t, 'id', 1000));
  assert.equal(verify('s', t, 'id', 3000), null);
  assert.equal(verify('other', t, 'id', 1000), null);
  assert.equal(verify('s', t, 'unsub', 1000), null);
  const [body, mac] = t.split('.');
  const edited = Buffer.from(JSON.stringify({ k: 'id', p: 2, s: 'x', exp: 2000 })).toString('base64url');
  assert.equal(verify('s', `${edited}.${mac}`, 'id', 1000), null);
  assert.ok(body);
});
