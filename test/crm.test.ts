import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { configProblems, flowHashes } from '../src/config.ts';
import { runReminders, freeSlots, book, calendarOf } from '../src/calendar.ts';
import { replyAddress, stripQuoted } from '../src/inbox.ts';
import { loadSite } from '../src/runner.ts';
import { quietUntil } from '../src/time.ts';
import { runWorkflows } from '../src/workflows.ts';
import { DAY, demo, kit, ORIGIN } from './kit.ts';

const HOUR = 3_600_000;
const BOOK_ORIGIN = { origin: 'https://mail.test', 'content-type': 'application/json' };

const lead = (k: Awaited<ReturnType<typeof kit>>, extra: Record<string, unknown> = {}) => k.call('POST', '/api/lead', {
  site: 'demo-gym', form: 'contact', first_name: 'Riley', last_name: 'Stone', email: 'riley@example.com', phone: '(612) 555-0142',
  'custom:goal': 'Get stronger', message: 'Do you have a squat rack?', sms_consent: true, marketing: false, url: `${ORIGIN}/contact?utm_source=facebook&utm_medium=paid`, ...extra,
});

function twilioSig(url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', 'twilio-token').update(data).digest('base64');
}
async function text(k: Awaited<ReturnType<typeof kit>>, from: string, body: string, sid: string, sig?: string) {
  const params = { From: from, To: '+16125550100', Body: body, MessageSid: sid };
  return k.call('POST', '/api/webhooks/twilio', new URLSearchParams(params).toString(), {
    'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig ?? twilioSig('https://mail.test/api/webhooks/twilio', params),
  });
}
async function contact(k: Awaited<ReturnType<typeof kit>>, email = 'riley@example.com') {
  const [c] = await k.sql<any>('SELECT * FROM profiles WHERE email = $1', [email]);
  return c;
}

test('the crm block is validated, with problems named', () => {
  assert.deepEqual(configProblems(demo()), []);
  const bad = demo();
  bad.crm!.timezone = 'Central';
  bad.crm!.workflows![0].steps[0] = { do: 'opportunity', pipeline: 'members', stage: 'nope' };
  bad.crm!.workflows![0].steps.push({ do: 'email', template: 'missing' });
  bad.crm!.calendars![0].hours.mon = [['17:00', '09:00']];
  delete bad.crm!.sms;
  const p = configProblems(bad).join('\n');
  assert.match(p, /IANA zone/);
  assert.match(p, /members\/nope doesn't exist/);
  assert.match(p, /template "missing"/);
  assert.match(p, /start before end/);
  assert.match(p, /texts need crm.sms/);
  assert.match(p, /smsConsent needs a phone field and crm.sms/);
});

test('a lead form makes a contact, files the submission, tells the team and runs the workflow', async () => {
  const k = await kit();
  const r = await lead(k);
  assert.equal(r.status, 200, r.text);
  const c = await contact(k);
  assert.equal(c.phone, '+16125550142');
  assert.equal(c.source, 'Facebook / Instagram');
  assert.equal(c.sms_status, 'consented');
  assert.equal(c.status, 'none', 'no newsletter without the tick');
  assert.equal(c.custom.goal, 'Get stronger');
  assert.equal(c.attribution.utm_source, 'facebook');

  const [form] = await k.sql<any>(`SELECT * FROM messages WHERE channel = 'form'`);
  assert.match(form.body, /Message: Do you have a squat rack\?/);
  assert.match(form.body, /Main goal: Get stronger/);
  assert.ok(k.mail.some((m) => m.to === 'owner@northwoods-fitness.example' && /New lead: Riley Stone/.test(m.subject)), 'the owner is told');

  const [opp] = await k.sql<any>('SELECT * FROM opportunities');
  assert.equal(opp.stage, 'new');
  assert.equal(opp.name, 'Riley Stone');
  assert.equal(opp.source, 'Facebook / Instagram');
  const [task] = await k.sql<any>('SELECT * FROM tasks');
  assert.equal(task.title, 'Call Riley Stone back');
  assert.equal(new Date(task.due_at).getTime(), k.now().getTime() + 2 * HOUR);
  assert.equal(k.texts.length, 1);
  assert.match(k.texts[0].body, /^Northwoods Fitness: Hi Riley, thanks/);
  assert.match(k.texts[0].body, /Reply STOP to opt out\.$/, 'the first text says how to opt out');
  const [run] = await k.sql<any>('SELECT * FROM runs');
  assert.equal(run.state, 'active');
  assert.equal(run.step, 4, 'waiting at the step after the 1-day wait');

  // Unanswered and still a new lead a day later: the follow-up email goes, from a reply address.
  k.advance(DAY + 60_000);
  await k.call('GET', '/api/cron', undefined, { authorization: 'Bearer cron-token' });
  const follow = k.mail.find((m) => /Want to see the gym/.test(m.subject))!;
  assert.ok(follow);
  assert.equal(follow.replyTo, replyAddress(k.env, Number(c.id)));
  assert.match(follow.text, /because you contacted Northwoods Fitness/);
  assert.equal((await k.sql<any>('SELECT state FROM runs'))[0].state, 'done');
});

test('the marketing tick subscribes and starts the welcome flow; a second submission updates, not duplicates', async () => {
  const k = await kit();
  await lead(k, { marketing: true });
  assert.equal((await contact(k)).status, 'subscribed');
  assert.ok(k.mail.some((m) => m.subject === 'Your free week, Riley'));
  await lead(k, { email: 'RILEY@example.com', phone: '', first_name: 'Ry', message: 'Also, parking?' });
  const all = await k.sql<any>('SELECT * FROM profiles');
  assert.equal(all.length, 1);
  assert.equal(all[0].first_name, 'Ry');
  assert.equal(all[0].phone, '+16125550142', 'an empty field never erases');
  assert.equal((await k.sql('SELECT * FROM runs')).length, 1, 'the workflow runs once per contact');
  assert.equal((await k.sql('SELECT * FROM opportunities')).length, 1);
});

test('a reply by text stops the workflow (stop on response) and lands in the inbox', async () => {
  const k = await kit();
  await lead(k);
  const r = await text(k, '+16125550142', 'Yes! Thursday?', 'SMin1');
  assert.equal(r.status, 200);
  assert.match(r.text, /<Response><\/Response>/);
  const [run] = await k.sql<any>('SELECT * FROM runs');
  assert.equal(run.state, 'exited');
  assert.equal(run.ended_why, 'they replied');
  const inb = await k.sql<any>(`SELECT * FROM messages WHERE direction = 'in' AND channel = 'sms'`);
  assert.equal(inb.length, 1);
  assert.ok(k.mail.some((m) => /New text from Riley Stone/.test(m.subject)));
  // Twilio retries the same message: stored once.
  await text(k, '+16125550142', 'Yes! Thursday?', 'SMin1');
  assert.equal((await k.sql(`SELECT * FROM messages WHERE direction = 'in' AND channel = 'sms'`)).length, 1);
  k.advance(DAY + 60_000);
  await runWorkflows(k.env);
  assert.ok(!k.mail.some((m) => /Want to see the gym/.test(m.subject)));
});

test('STOP stops automated and typed texts; START turns them back on; bad signatures are refused', async () => {
  const k = await kit();
  assert.equal((await text(k, '+16125550142', 'hi', 'SMx', 'forged')).status, 401);
  await lead(k);
  await text(k, '+16125550142', 'Stop', 'SMin2');
  assert.equal((await contact(k)).sms_status, 'stopped');
  const site = (await loadSite(k.sql, 'demo-gym'))!;
  const { sendMessage } = await import('../src/inbox.ts');
  const c = await contact(k);
  const r = await sendMessage(k.env, site, Number(c.id), { channel: 'sms', body: 'Hello?', author: 'owner@northwoods-fitness.example' });
  assert.equal(r.status, 'skipped');
  assert.match(r.why!, /STOP/);
  await text(k, '+16125550142', 'START', 'SMin3');
  assert.equal((await contact(k)).sms_status, 'consented');
});

test('a stranger who texts in becomes a contact, and only a person may text back', async () => {
  const k = await kit();
  await text(k, '+12185550199', 'Are you open Sunday?', 'SMs1');
  const [c] = await k.sql<any>(`SELECT * FROM profiles WHERE phone = '+12185550199'`);
  assert.equal(c.source, 'Text message');
  const site = (await loadSite(k.sql, 'demo-gym'))!;
  const { sendMessage } = await import('../src/inbox.ts');
  assert.equal((await sendMessage(k.env, site, Number(c.id), { channel: 'sms', body: 'Promo!', author: 'workflow:x', automated: true })).status, 'skipped');
  assert.equal((await sendMessage(k.env, site, Number(c.id), { channel: 'sms', body: 'Yes, 8 to 4.', author: 'owner@northwoods-fitness.example' })).status, 'sent');
});

test('automated texts wait for daytime', async () => {
  assert.equal(quietUntil(new Date('2026-10-21T15:00:00Z'), 'America/Chicago'), null); // 10:00
  assert.equal(quietUntil(new Date('2026-10-22T03:00:00Z'), 'America/Chicago')!.toISOString(), '2026-10-22T14:00:00.000Z'); // 22:00 → 9:00
  const k = await kit();
  k.advance(12 * HOUR); // 03:00 UTC = 22:00 in Chicago
  await lead(k);
  assert.equal(k.texts.length, 0);
  const [run] = await k.sql<any>('SELECT * FROM runs');
  assert.equal(new Date(run.next_at).toISOString(), '2026-10-22T14:00:00.000Z');
  k.advance(11 * HOUR + 60_000);
  await runWorkflows(k.env);
  assert.equal(k.texts.length, 1);
});

test('reply emails thread to the right contact; forged addresses are ignored', async () => {
  const k = await kit();
  await lead(k);
  const c = await contact(k);
  const hook = async (to: string, id: string) => {
    const payload = JSON.stringify({ type: 'email.received', data: { email_id: id, to: [to], subject: 'Re: hi' } });
    const ts = String(Math.floor(k.now().getTime() / 1000));
    const sig = createHmac('sha256', Buffer.from('hook-key')).update(`msg_${id}.${ts}.${payload}`).digest('base64');
    return k.call('POST', '/api/webhooks/resend', payload, { 'svix-id': `msg_${id}`, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` });
  };
  k.inbound.set('rcv1', { from: 'riley@example.com', to: [replyAddress(k.env, Number(c.id))], subject: 'Re: hi', text: 'Thursday works.\n\nOn Tue, Oct 21, 2026 at 10:00 AM Northwoods wrote:\n> old text', html: null });
  assert.equal((await hook(replyAddress(k.env, Number(c.id)), 'rcv1')).json.result, 'ok');
  const [m] = await k.sql<any>(`SELECT * FROM messages WHERE channel = 'email' AND direction = 'in'`);
  assert.equal(m.body, 'Thursday works.');
  assert.equal(Number(m.contact_id), Number(c.id));
  const forged = replyAddress(k.env, Number(c.id)).replace(/\.[0-9a-f]{12}@/, '.000000000000@');
  k.inbound.set('rcv2', { from: 'x@example.com', to: [forged], subject: 'x', text: 'x', html: null });
  assert.equal((await hook(forged, 'rcv2')).json.result, 'ignored');
  assert.equal(stripQuoted('Sounds good\n\n-----Original Message-----\nFrom: a'), 'Sounds good');
});

test('booking: open slots, confirmation with calendar file, workflow, no double booking', async () => {
  const k = await kit();
  const slots = (await k.call('GET', '/api/slots?site=demo-gym&calendar=tour')).json.slots;
  // Wednesday 10:00 local, 2 hours' notice: the morning is gone, the afternoon is open.
  assert.deepEqual(slots['2026-10-21'], ['16:00', '16:30', '17:00', '17:30', '18:00', '18:30'].map((t) => new Date(`2026-10-21T${t}:00-05:00`).toISOString()));
  assert.ok(!slots['2026-10-24'] || slots['2026-10-24'].length === 6, 'Saturday 10 to 1');
  assert.ok(!slots['2026-10-25'], 'closed Sunday');
  const start = slots['2026-10-21'][0];
  const body = { site: 'demo-gym', calendar: 'tour', start, first_name: 'Riley', email: 'riley@example.com', phone: '6125550142', sms_consent: true };
  const r = await k.call('POST', '/api/book', body, BOOK_ORIGIN);
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.when, /Wed, Oct 21 at 4:00 PM/);
  const conf = k.mail.find((m) => /You're booked/.test(m.subject))!;
  assert.ok(conf.attachments?.[0].content.includes('DTSTART:20261021T210000Z'));
  assert.ok(k.mail.some((m) => /New booking: Riley/.test(m.subject)));
  const c = await contact(k);
  assert.deepEqual(c.tags, ['toured']);
  assert.equal((await k.sql<any>('SELECT stage FROM opportunities'))[0].stage, 'tour');
  const again = await k.call('POST', '/api/book', { ...body, email: 'other@example.com' }, BOOK_ORIGIN);
  assert.equal(again.status, 409);
  assert.equal((await k.call('POST', '/api/book', body, { ...BOOK_ORIGIN, origin: 'https://evil.example' })).status, 403);
  // Two at once for the last seat: one wins.
  const site = (await loadSite(k.sql, 'demo-gym'))!;
  const cal = calendarOf(site, 'tour');
  const s2 = (await freeSlots(k.env, site, cal, { from: '2026-10-21', days: 1 }))['2026-10-21'][0];
  const res = await Promise.allSettled([book(k.env, site, cal, s2, Number(c.id), 'web'), book(k.env, site, cal, s2, Number(c.id), 'web')]);
  assert.equal(res.filter((x) => x.status === 'fulfilled').length, 1);
});

test('reminders go once each at their time, by email and by text to people who opted in; cancel only on POST', async () => {
  const k = await kit();
  const slots = (await k.call('GET', '/api/slots?site=demo-gym&calendar=tour&from=2026-10-26')).json.slots;
  const start = slots['2026-10-26'][0]; // Monday 9:00
  const r = await k.call('POST', '/api/book', { site: 'demo-gym', calendar: 'tour', start, first_name: 'Riley', email: 'riley@example.com', phone: '6125550142', sms_consent: true }, BOOK_ORIGIN);
  assert.equal(r.status, 200, r.text);
  assert.equal((await runReminders(k.env)).sent, 0);
  k.advance(new Date(start).getTime() - 24 * HOUR - k.now().getTime() + 60_000);
  assert.equal((await runReminders(k.env)).sent, 1);
  assert.equal((await runReminders(k.env)).sent, 0, 'never twice');
  assert.ok(k.mail.some((m) => /^Reminder: Gym tour/.test(m.subject)));
  assert.match(k.texts.at(-1)!.body, /Reminder: Gym tour on Mon, Oct 26 at 9:00 AM/);
  k.advance(22 * HOUR);
  assert.equal((await runReminders(k.env)).sent, 1, 'the 2h one');

  const t = new URL(r.json.link).searchParams.get('t')!;
  const look = await k.call('GET', `/appt?t=${t}`);
  assert.match(look.text, /Cancel this appointment/);
  assert.equal((await k.sql<any>('SELECT status FROM appointments'))[0].status, 'booked', 'looking never cancels');
  const ics = await k.call('GET', `/appt.ics?t=${t}`);
  assert.match(ics.text, /BEGIN:VEVENT/);
  await k.call('POST', `/appt?t=${t}`);
  assert.equal((await k.sql<any>('SELECT status FROM appointments'))[0].status, 'cancelled');
  assert.ok(k.mail.some((m) => /^Cancelled: Gym tour/.test(m.subject)));
});

test('a workflow edited after approval stops instead of sending', async () => {
  const k = await kit();
  await lead(k);
  const c = demo();
  c.crm!.workflows![0].steps[5] = { do: 'email', template: 'welcome-2' };
  // Stored without new hashes, as if someone changed the database by hand.
  await k.sql('UPDATE sites SET config = $1', [JSON.stringify(c)]);
  k.advance(DAY + 60_000);
  await runWorkflows(k.env);
  const [run] = await k.sql<any>('SELECT * FROM runs');
  assert.equal(run.state, 'exited');
  assert.match(run.ended_why, /changed or turned off/);
  assert.equal(k.mail.filter((m) => m.to === 'riley@example.com').length, 0);
  // A proper push (new hashes) is what approves it again.
  await k.sql('UPDATE sites SET hashes = $1', [JSON.stringify(flowHashes(c))]);
});

test('owner app: emailed sign-in, a session cookie, only your own business, header needed for writes', async () => {
  const k = await kit();
  await lead(k);
  const app = (path: string, body?: unknown, cookie = '', extra: Record<string, string> = {}) => k.call(body === undefined ? 'GET' : 'POST', `/app/api${path}`, body,
    { cookie, 'content-type': 'application/json', 'x-requested-with': 'wm-app', ...extra });
  assert.equal((await app('/me')).status, 401);
  const before = k.mail.length;
  await app('/login', { email: 'stranger@example.com' });
  assert.equal(k.mail.length, before, 'no link for unknown people, and the same answer');
  await app('/login', { email: 'Owner@northwoods-fitness.example' });
  const link = /https:\/\/mail\.test\/app\/auth\?t=\S+/.exec(k.mail.at(-1)!.text)![0];
  const path = link.replace('https://mail.test', '');
  const ask = await k.call('GET', path);
  assert.equal(ask.headers.get('set-cookie'), null, 'opening the link does not sign in');
  const done = await k.call('POST', path);
  assert.equal(done.status, 303);
  const cookie = done.headers.get('set-cookie')!.split(';')[0];
  assert.match(done.headers.get('set-cookie')!, /HttpOnly; SameSite=Lax/);
  const me = await app('/me', undefined, cookie);
  assert.deepEqual(me.json.sites, [{ id: 'demo-gym', name: 'Northwoods Fitness' }]);

  const c = await contact(k);
  const page = await app(`/contact?site=demo-gym&id=${c.id}`, undefined, cookie);
  assert.equal(page.json.contact.name, 'Riley Stone');
  assert.equal(page.json.canText, null);
  assert.ok(page.json.messages.some((m: any) => m.channel === 'form'));
  assert.equal((await app('/home?site=demo-gym', undefined, cookie)).json.unread, 1);
  assert.equal((await app(`/contact?site=other&id=${c.id}`, undefined, cookie)).status, 403);
  assert.equal((await app('/note', { site: 'demo-gym', contact: c.id, body: 'x' }, cookie, { 'x-requested-with': '' })).status, 403);
  // Another business's contact can't be written to through this one.
  const [other] = await k.sql<any>(`INSERT INTO profiles (site, email, created_at, status_at) VALUES ('other-site', 'x@other.example', now(), now()) RETURNING id`);
  for (const [path, body] of [['/note', { body: 'x' }], ['/task', { title: 'x' }], ['/tag', { tag: 'x' }], ['/opportunity', { pipeline: 'members', stage: 'new' }]] as const) {
    assert.equal((await app(path, { site: 'demo-gym', contact: Number(other.id), ...body }, cookie)).status, 404, path);
  }
  assert.equal((await k.sql(`SELECT * FROM notes WHERE contact_id = $1`, [other.id])).length, 0);

  // Moving the card runs workflows on the change; won/lost record the reason.
  const [opp] = await k.sql<any>('SELECT id FROM opportunities');
  assert.equal((await app('/opportunity', { site: 'demo-gym', id: Number(opp.id), contact: c.id, pipeline: 'members', stage: 'trial', value: 49 }, cookie)).status, 200);
  assert.equal((await app('/opportunity-status', { site: 'demo-gym', id: Number(opp.id), status: 'lost', reason: 'Too expensive' }, cookie)).status, 200);
  const [o] = await k.sql<any>('SELECT * FROM opportunities');
  assert.equal(o.stage, 'trial');
  assert.equal(o.status, 'lost');
  assert.equal(o.lost_reason, 'Too expensive');
  assert.equal(Number(o.value), 49);

  const sent = await app('/message', { site: 'demo-gym', contact: c.id, channel: 'email', subject: 'Squat racks', body: 'We have three.' }, cookie);
  assert.equal(sent.status, 200, sent.text);
  const m = k.mail.at(-1)!;
  assert.equal(m.replyTo, replyAddress(k.env, Number(c.id)));
  assert.equal(m.unsubscribeUrl, undefined, 'a typed reply is personal mail');
  assert.equal((await app('/home?site=demo-gym', undefined, cookie)).json.unread, 0, 'answering marks it read');
  const board = await app('/board?site=demo-gym&pipeline=members&status=lost', undefined, cookie);
  assert.equal(board.json.opportunities[0].contactName, 'Riley Stone');
});

test('the hub gets counts and deals, never names or addresses', async () => {
  const k = await kit();
  await lead(k);
  const auth = { authorization: 'Bearer admin-token' };
  const deals = await k.call('GET', '/api/admin/crm/deals?site=demo-gym&since=2026-10-20&until=2026-10-21', undefined, auth);
  assert.equal(deals.json.deals.length, 1);
  assert.deepEqual(Object.keys(deals.json.deals[0]).sort(), ['createdAt', 'id', 'pipelineId', 'source', 'stageId', 'status', 'value']);
  const stats = await k.call('GET', '/api/admin/crm/stats?site=demo-gym&days=7', undefined, auth);
  assert.equal(stats.json.contacts.new, 1);
  assert.doesNotMatch(stats.text, /riley|Riley|5550142/);
  assert.equal((await k.call('GET', '/api/admin/crm/stats?site=demo-gym', undefined, {})).status, 401);
});
