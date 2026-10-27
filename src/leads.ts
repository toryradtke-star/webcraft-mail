/**
 * What visitors do that reaches the CRM: a lead form (from wm.js on the
 * business's site) and a booking (on the hosted booking page, which a site
 * can link to or put in an iframe).
 *
 * Both create or update the contact, record what the person saw as consent,
 * put the submission in the inbox, tell the team, and start workflows.
 */
import type { Form } from './config.ts';
import type { Calendar } from './crm-config.ts';
import { activity, EMAIL, fullName, getContact, normPhone, upsertContact, type Contact } from './crm.ts';
import { contactLink, notifyTeam } from './inbox.ts';
import { esc } from './render.ts';
import { enroll, runDue, type Env, type Site } from './runner.ts';
import { appointmentUrl, book, calendarOf, freeSlots } from './calendar.ts';
import { human } from './time.ts';
import { fire, runWorkflows } from './workflows.ts';

const iso = (d: Date) => d.toISOString();
const PER_IP_HOUR = 5;

export class BadInput extends Error {}

const clean = (v: unknown, max = 200) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

/** UTM tags and click ids from the page the form was on. */
function attribution(url: string | null, referrer: unknown): Record<string, string> | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const a: Record<string, string> = { url: `${u.origin}${u.pathname}` };
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']) { const v = u.searchParams.get(k); if (v) a[k] = v.slice(0, 200); }
    const ref = clean(referrer, 300);
    if (ref) a.referrer = ref;
    return a;
  } catch { return null; }
}

/** "Google Ads", "Facebook", "Website form": the contact's source, from the attribution. */
export function sourceOf(a: Record<string, string> | null): string {
  if (a?.gclid || /google/i.test(a?.utm_source ?? '') && /cpc|paid|ppc/i.test(a?.utm_medium ?? '')) return 'Google Ads';
  if (a?.fbclid || /facebook|fb|instagram|ig|meta/i.test(a?.utm_source ?? '')) return 'Facebook / Instagram';
  if (a?.utm_source) return a.utm_source;
  if (a?.referrer && /google\./i.test(a.referrer)) return 'Google search';
  return 'Website form';
}

async function tooMany(env: Env, ip: string): Promise<boolean> {
  if (!ip) return false;
  const [r] = await env.sql<{ n: string }>('SELECT count(*) AS n FROM consents WHERE ip = $1 AND at > $2', [ip, iso(new Date(env.now().getTime() - 3_600_000))]);
  return Number(r.n) >= PER_IP_HOUR;
}

async function consent(env: Env, site: string, contactId: number, form: string, list: string, wording: string, url: string | null, ip: string, ua: string) {
  await env.sql(`INSERT INTO consents (profile_id, site, form_id, list, wording, url, ip, user_agent, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [contactId, site, form, list, wording, url, ip || null, ua.slice(0, 300), iso(env.now())]);
}

/** The submission as the team reads it, in the inbox and the alert. */
function summary(site: Site, f: { fields: string[] }, b: any): string {
  const labels: Record<string, string> = { first_name: 'First name', last_name: 'Last name', email: 'Email', phone: 'Phone', message: 'Message' };
  return f.fields.map((name) => {
    const key = name.startsWith('custom:') ? name.slice(7) : null;
    const label = key ? site.config.crm?.customFields?.find((x) => x.key === key)?.label ?? key : labels[name] ?? name;
    const v = clean(b[name], name === 'message' ? 3000 : 300);
    return v ? `${label}: ${v}` : '';
  }).filter(Boolean).join('\n');
}

async function intoInbox(env: Env, site: Site, c: Contact, subject: string, body: string) {
  await env.sql(`INSERT INTO messages (site, contact_id, channel, direction, subject, body, status, author, at) VALUES ($1,$2,'form','in',$3,$4,'received','contact',$5)`,
    [site.config.id, c.id, subject, body, iso(env.now())]);
}

/** POST /api/lead from wm.js. */
export async function submitLead(env: Env, site: Site, b: any, ip: string, ua: string): Promise<{ ok: true }> {
  const f: Form | undefined = site.config.forms.find((x) => x.id === b.form && x.kind === 'lead');
  if (!f || !site.config.crm) throw new BadInput('unknown form');
  if (b.company) return { ok: true }; // the honeypot
  const email = f.fields.includes('email') ? clean(b.email, 254).toLowerCase() : '';
  const phoneRaw = f.fields.includes('phone') ? clean(b.phone, 40) : '';
  if (email && !EMAIL.test(email)) throw new BadInput('Please enter a valid email address.');
  const phone = phoneRaw ? normPhone(phoneRaw) : null;
  if (phoneRaw && !phone) throw new BadInput('Please enter a valid phone number.');
  if (!email && !phone) throw new BadInput(f.fields.includes('email') ? 'Please enter your email address.' : 'Please enter your phone number.');
  for (const r of f.required ?? []) if (!clean(b[r])) throw new BadInput('Please fill in every required field.');
  if (await tooMany(env, ip)) throw new BadInput('Too many submissions from here. Try again later.');
  const url = clean(b.url, 500) || null;
  const attr = attribution(url, b.referrer);
  const custom: Record<string, string> = {};
  for (const name of f.fields) if (name.startsWith('custom:') && clean(b[name])) custom[name.slice(7)] = clean(b[name], 1000);
  const { contact } = await upsertContact(env, site, {
    email: email || null, phone, first_name: clean(b.first_name, 60) || null, last_name: clean(b.last_name, 60) || null,
    source: sourceOf(attr), custom, attribution: attr,
  });
  const s = site.config.id;
  await consent(env, s, contact.id, f.id, f.list ?? '', f.consent, url, ip, ua);
  if (f.smsConsent && b.sms_consent === true && contact.sms_status !== 'stopped') {
    await env.sql(`UPDATE profiles SET sms_status = 'consented' WHERE id = $1`, [contact.id]);
    await consent(env, s, contact.id, f.id, 'sms', f.smsConsent, url, ip, ua);
  }
  if (f.marketingOptIn && f.list && b.marketing === true && email && !['bounced', 'complained'].includes(contact.status)) {
    await env.sql(`UPDATE profiles SET status = 'subscribed', status_at = $2 WHERE id = $1`, [contact.id, iso(env.now())]);
    await consent(env, s, contact.id, f.id, f.list, f.marketingOptIn, url, ip, ua);
    const joined = await env.sql(`INSERT INTO memberships (profile_id, list, at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING list`, [contact.id, f.list, iso(env.now())]);
    if (joined.length) await enroll(env, site, contact.id, { type: 'subscribed', list: f.list });
  }
  const text = summary(site, f, b);
  await intoInbox(env, site, contact, f.title, text);
  await activity(env, s, contact.id, 'Submitted Form', { form: f.id, source: sourceOf(attr) }, url);
  if (site.config.crm.notifyOnLead !== false) {
    const c = (await getContact(env, s, contact.id))!;
    await notifyTeam(env, site, `New lead: ${fullName(c)} (${f.title})`, `${text}\n\nSource: ${sourceOf(attr)}\n\nOpen: ${contactLink(env, s, c.id)}`, `lead-${contact.id}-${env.now().getTime()}`);
  }
  await fire(env, site, contact.id, { type: 'form_submitted', form: f.id });
  await runWorkflows(env, { contactId: contact.id });
  await runDue(env, { profileId: contact.id, limit: 5 });
  return { ok: true };
}

/** POST /api/book from the booking page. */
export async function submitBooking(env: Env, site: Site, b: any, ip: string, ua: string): Promise<{ ok: true; when: string; link: string }> {
  const cal = calendarOf(site, clean(b.calendar, 60));
  if (b.company) throw new BadInput('Please try again.');
  const email = clean(b.email, 254).toLowerCase();
  if (!EMAIL.test(email)) throw new BadInput('Please enter a valid email address.');
  const first = clean(b.first_name, 60);
  if (!first) throw new BadInput('Please enter your name.');
  const phone = cal.askPhone && clean(b.phone, 40) ? normPhone(b.phone) : null;
  if (cal.askPhone && clean(b.phone, 40) && !phone) throw new BadInput('Please enter a valid phone number.');
  if (await tooMany(env, ip)) throw new BadInput('Too many bookings from here. Try again later.');
  const attr = attribution(clean(b.url, 500) || null, b.referrer);
  const { contact } = await upsertContact(env, site, { email, phone, first_name: first, last_name: clean(b.last_name, 60) || null, source: attr ? sourceOf(attr) : 'Online booking', attribution: attr });
  const wording = `Booked ${cal.name} with ${site.config.name} online.`;
  await consent(env, site.config.id, contact.id, `book:${cal.id}`, '', wording, clean(b.url, 500) || null, ip, ua);
  if (site.config.crm?.sms && b.sms_consent === true && phone && contact.sms_status !== 'stopped') {
    await env.sql(`UPDATE profiles SET sms_status = 'consented' WHERE id = $1`, [contact.id]);
    await consent(env, site.config.id, contact.id, `book:${cal.id}`, 'sms', smsWording(site), clean(b.url, 500) || null, ip, ua);
  }
  const note = clean(b.message, 2000) || null;
  const a = await book(env, site, cal, clean(b.start, 40), contact.id, 'web', note);
  const when = human(a.start_at, site.config.crm!.timezone);
  await intoInbox(env, site, contact, `Booked: ${cal.name}`, `${when}${note ? `\n\n${note}` : ''}`);
  await notifyTeam(env, site, `New booking: ${fullName(contact)}, ${cal.name} ${when}`, `${fullName(contact)} booked ${cal.name} for ${when}.${note ? `\n\nThey wrote: ${note}` : ''}\n\nOpen: ${contactLink(env, site.config.id, contact.id)}`, `book-${a.id}`);
  return { ok: true, when, link: appointmentUrl(env, site.config.id, a.id) };
}

export const smsWording = (site: Site) => `Text me about my appointments and questions at this number. Msg & data rates may apply. Reply STOP to opt out. From ${site.config.name}.`;

/** GET /api/slots */
export async function slots(env: Env, site: Site, calId: string, from: string | null): Promise<Record<string, string[]>> {
  return freeSlots(env, site, calendarOf(site, calId), { from: from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : undefined, days: 14 });
}

/** The hosted booking page: pick a day, a time, then name and email. */
export function bookingPage(site: Site, cal: Calendar): string {
  const color = site.config.brandColor ?? '#111827';
  const tz = site.config.crm!.timezone;
  const cfg = JSON.stringify({ site: site.config.id, calendar: cal.id, tz, askPhone: !!cal.askPhone, sms: !!site.config.crm?.sms, smsWording: smsWording(site) }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(cal.name)} · ${esc(site.config.name)}</title>
<style>
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;background:#fff}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}.sub{color:#4b5563;margin:0 0 20px}
.days{display:flex;gap:8px;overflow-x:auto;padding-bottom:8px}.day,.time{border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer;white-space:nowrap}
.day[aria-pressed=true],.time[aria-pressed=true]{background:${color};border-color:${color};color:#fff}
.times{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;margin:16px 0}
label{display:block;font-size:14px;font-weight:600;margin:12px 0 4px}input,textarea{width:100%;font:inherit;padding:10px;border:1px solid #d1d5db;border-radius:8px}
.check{display:flex;gap:8px;align-items:flex-start;font-weight:400;font-size:13px;color:#4b5563}.check input{width:auto;margin-top:3px}
button.go{margin-top:16px;width:100%;padding:12px;border:0;border-radius:8px;background:${color};color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:#b91c1c}.hp{position:absolute;left:-9999px}.muted{color:#6b7280;font-size:14px}
</style></head><body><main>
<h1>${esc(cal.name)}</h1><p class="sub">${esc(site.config.name)} · ${cal.durationMin} minutes${cal.location ? ` · ${esc(cal.location)}` : ''}</p>
${cal.description ? `<p>${esc(cal.description)}</p>` : ''}
<div id="pick"><div class="days" id="days" role="group" aria-label="Day"></div><div class="times" id="times" role="group" aria-label="Time"></div><p class="muted" id="none" hidden>No open times in the next two weeks. Please call us.</p></div>
<form id="form" hidden novalidate>
<p id="chosen"></p>
<label for="first_name">First name</label><input id="first_name" name="first_name" autocomplete="given-name" required>
<label for="last_name">Last name</label><input id="last_name" name="last_name" autocomplete="family-name">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required>
${cal.askPhone ? `<label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel">` : ''}
${cal.askPhone && site.config.crm?.sms ? `<label class="check"><input type="checkbox" name="sms_consent"> <span id="smsw"></span></label>` : ''}
<label for="message">Anything we should know? (optional)</label><textarea id="message" name="message" rows="3"></textarea>
<div class="hp" aria-hidden="true"><input name="company" tabindex="-1" autocomplete="off"></div>
<p class="err" id="err" role="alert" hidden></p><button class="go" type="submit">Book it</button>
</form>
<div id="done" hidden role="status"></div>
</main><script>
(function(){var C=${cfg};var $=function(i){return document.getElementById(i)};var slots={},day=null,start=null;
if($('smsw'))$('smsw').textContent=C.smsWording;
var fmtDay=new Intl.DateTimeFormat('en-US',{timeZone:C.tz,weekday:'short',month:'short',day:'numeric'});
var fmtTime=new Intl.DateTimeFormat('en-US',{timeZone:C.tz,hour:'numeric',minute:'2-digit'});
function btn(cls,text,on){var b=document.createElement('button');b.type='button';b.className=cls;b.textContent=text;b.setAttribute('aria-pressed','false');b.onclick=on;return b}
function press(box,b){[].forEach.call(box.children,function(x){x.setAttribute('aria-pressed',String(x===b))})}
function showDay(d,b){day=d;press($('days'),b);var t=$('times');t.innerHTML='';slots[d].forEach(function(s){t.appendChild(btn('time',fmtTime.format(new Date(s)),function(){start=s;press(t,this);$('chosen').innerHTML='';var p=document.createElement('strong');p.textContent=fmtDay.format(new Date(s))+' at '+fmtTime.format(new Date(s));$('chosen').appendChild(p);$('form').hidden=false;$('first_name').focus()}))})}
fetch('/api/slots?site='+C.site+'&calendar='+C.calendar).then(function(r){return r.json()}).then(function(j){slots=j.slots||{};var ds=Object.keys(slots);if(!ds.length){$('none').hidden=false;return}
ds.forEach(function(d,i){var b=btn('day',fmtDay.format(new Date(slots[d][0])),function(){showDay(d,b)});$('days').appendChild(b);if(i===0)showDay(d,b)})});
$('form').onsubmit=function(e){e.preventDefault();var f=e.target,err=$('err');err.hidden=true;var go=f.querySelector('.go');go.disabled=true;
var body={site:C.site,calendar:C.calendar,start:start,first_name:f.first_name.value,last_name:f.last_name.value,email:f.email.value,phone:f.phone?f.phone.value:'',sms_consent:!!(f.sms_consent&&f.sms_consent.checked),message:f.message.value,company:f.company.value,url:location.href,referrer:document.referrer};
fetch('/api/book',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||'Something went wrong.');return j})})
.then(function(j){$('pick').hidden=true;f.hidden=true;var d=$('done');d.hidden=false;d.innerHTML='<h2>You\\u2019re booked</h2>';var p=document.createElement('p');p.textContent=j.when+'. A confirmation is on its way to your email.';d.appendChild(p);if(window.parent!==window)parent.postMessage({type:'wm-booked'},'*')})
.catch(function(x){err.textContent=x.message;err.hidden=false;go.disabled=false})}})();
</script></body></html>`;
}
