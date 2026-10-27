# webcraft-mail

Lightweight signup forms, onsite identity and email flows for Webcraft client sites: the parts of Klaviyo a local service business actually uses, on Vercel + Neon + Resend. The teardown it came from is `~/teardowns/2026-10-21-klaviyo-onsite/teardown.md`.

It is also a small CRM: the parts of HighLevel a local service business uses (teardown: `~/teardowns/2026-10-27-highlevel-crm/teardown.md`). See [CRM](#crm) below.

- **One script tag** per site: `<script src="https://mail.webcraftmn.com/wm.js" data-site="<id>" async></script>`
- **Forms**: popup or embedded, with delay, scroll depth, exit intent, URL include/exclude, device, cooldown and hide-if-subscribed. Shadow DOM, so site CSS can't break them. A honeypot field and 5 signups per IP per hour slow down bots.
- **Identity**: an anonymous first-party cookie (`wm_id`). Page views include Next.js client-side navigations. Signing up ties the browser to the person and backfills their earlier events. Email links back to the site carry a signed `_wm` token, so a new device is recognized too. Global Privacy Control turns page-view tracking off.
- **Flows**: triggered by a signup to a list, or by an event (optionally on a path), for known people. Steps are `after` waits with an optional `unlessEvent` exit, and each person runs each flow once. The first step sends inside the signup request, so a welcome email arrives in seconds.
- **Broadcasts**: one email to a list, sent within a daily cap and resumed across runs.
- **Compliance**: CAN-SPAM footer (name and postal address) on every email, one-click `List-Unsubscribe` (RFC 8058), an unsubscribe page where GET only asks (so link scanners can't unsubscribe anyone), a stored consent record (form wording, page, IP, time), and permanent suppression on bounces and spam complaints.
- **Safety**: every send row is written before Resend is called, and its id is the Resend idempotency key, so retries never double-send. Flows only run if their content hash matches what was pushed, and pushing happens only after approval in the hub.

## CRM

Turned on per site by a `crm` block in the site's JSON (see `examples/demo-gym.json`). Everything below works off one contact record, so a form signup, a booking, a text and a pipeline card are the same person.

- **Contacts**: matched by email, then phone (US numbers normalized to +1…). Tags, custom fields, source and UTM/click-id attribution from the page, notes, tasks, a timeline of everything that happened.
- **Lead forms**: `kind: "lead"` forms in wm.js (phone, message, custom fields, an unticked SMS box, an unticked newsletter box). A submission lands in the inbox, emails the team, and starts `form_submitted` workflows. 5 per IP per hour and a honeypot.
- **Pipelines**: stages per pipeline, one open opportunity per contact per pipeline, won/lost/abandoned with a lost reason.
- **Workflows**: trigger (contact created, form submitted, tag added, stage changed, opportunity status, appointment booked, appointment status, customer replied) → optional filter → steps (`wait`, `email`, `sms`, `add_tag`, `remove_tag`, `opportunity`, `status`, `task`, `notify`, `stop`), each with an optional `when` condition (tag, stage, replied, has phone, custom field…). Stop on response, re-entry, and appointment triggers once per appointment, as in HighLevel. Each workflow runs only while its content matches the hash that was pushed, like flows.
- **Calendars**: opening hours per weekday in the business's timezone, interval, buffers, minimum notice, booking window, max per day and per slot. A hosted booking page at `/book/<site>/<calendar>` (link to it or put it in an iframe; it posts `wm-booked` to the parent when done). Confirmation email with an .ics file, reminders ("24h", "2h") by email and by text to people who opted in, and a cancel page. The database makes double booking impossible (one row per seat, unique while active).
- **Inbox**: one conversation per contact with email, texts and form submissions. Email replies come back through Resend Inbound (Reply-To `c<id>.<mac>@<INBOUND_DOMAIN>`); texts through Twilio. New messages email the team. STOP/START are honored, automated texts need the ticked box and wait for 9:00–20:00 local, the first text says "Reply STOP to opt out", and numbers Twilio reports as unreachable stop getting texts.
- **Owner app** at `/app/`: sign in by emailed link (the people in `crm.users`), then Home, Inbox, Contacts, Pipeline (drag cards), Calendar and Tasks. Phone-first.
- **Hub**: `/api/admin/crm/{pipelines,deals,open,stats}` give the hub ids, stages, sources, dates and counts, never names, addresses or numbers. The hub's `crm` module reads them with `adapter: "webcraft"`; the setup goes out with the same gated push as the email config.

Not built: Google Calendar sync (blocks are entered in the app), round-robin across staff, payments and invoices, review requests, a visual workflow builder (workflows are JSON, edited by Claude, approved in the hub), WhatsApp/Facebook/Instagram messages, calls and voicemail.

**Not for healthcare clients.** Patient data stays out of this service; clinics keep a CRM built for it.

## How it's run

The config for each business lives in hub-data (`clients/<slug>/email/site.json`), not here. The hub's `email` module stages a push. Tory approves it (`hub approve <id> --confirm send`, or through `gates_request_approval`), and the approved config is PUT to `/api/admin/sites`. Stats come back through `hub <client> email stats`.

## Develop

```
npm install
npm test        # 29 tests on PGlite (real Postgres in-process)
npm run check   # tsc
npm run dev     # http://localhost:8787/demo and /app/, fake mailer and texts print to the terminal
npm run build   # .vercel/output (Build Output API: one function, wm.js static, daily cron)
```

## Deploy (Tory)

1. **Neon**: create a free project named `webcraft-mail` and copy the pooled connection string.
2. **Vercel**: `vercel link` in this folder (new project `webcraft-mail`, framework "Other", build command `npm run build`). Add these env vars for Production:
   - `DATABASE_URL`: from Neon
   - `RESEND_API_KEY`: a Resend key with sending access (a new key, separate from outreach's)
   - `TOKEN_SECRET`, `ADMIN_TOKEN`, `CRON_SECRET`: three random strings (`openssl rand -base64 32`)
   - `PUBLIC_URL`: `https://mail.webcraftmn.com`
   - `RESEND_WEBHOOK_SECRET`: from step 4
   - CRM, optional: `INBOUND_DOMAIN` (step 8; then `RESEND_API_KEY` must be a **full access** key, because reading received mail needs it), `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` (step 9)
3. **Domain**: add `mail.webcraftmn.com` to the project (webcraftmn.com DNS is already on Vercel).
4. **Resend webhook**: endpoint `https://mail.webcraftmn.com/api/webhooks/resend` for `email.bounced` and `email.complained`. Put its signing secret in `RESEND_WEBHOOK_SECRET`.
5. **Sending domains**: webcraftmn.com is already verified. **workout247fitness.com is not**, so add it in Resend and put its DKIM/SPF/MX records in that domain's DNS before Workout 24/7's flows can send.
6. **Hub**: put `ADMIN_TOKEN`'s value in `~/hub-data/secrets.env` as `WEBCRAFT_MAIL_ADMIN_TOKEN`.
7. `vercel deploy --prod`, then `curl https://mail.webcraftmn.com/api/health`.

8. **Inbound replies (CRM inbox)**: in Resend, add a receiving domain `in.webcraftmn.com` and put its MX record in webcraftmn.com's DNS. Add `email.received` to the webhook from step 4. Set `INBOUND_DOMAIN=in.webcraftmn.com`.
9. **Texting (CRM, per business)**: a Twilio account, one number per business (put it in that site's `crm.sms.from`), and A2P 10DLC registration: a brand (the business's EIN, or sole proprietor) and a campaign (one-time registration fees plus a monthly campaign fee; check Twilio's current 10DLC pricing) with the opt-in wording from the forms and a live privacy page. Carriers take days to weeks. On the number, set "A message comes in" to `https://mail.webcraftmn.com/api/webhooks/twilio` (POST). Without Twilio, the CRM works with email only.
10. **The 5-minute tick**: in this GitHub repo, add the secret `CRON_SECRET` (same value as Vercel's). `.github/workflows/tick.yml` then calls `/api/cron` every 5 minutes, which is what sends workflow waits, reminders and texts held for daytime on time. Vercel Hobby's own cron runs once a day as a backstop.
11. **Owner app**: open `https://mail.webcraftmn.com/app/`, enter an email from the site's `crm.users`, and use the emailed link.

Without the tick, Vercel Hobby runs the cron once a day (15:00 UTC), so delayed steps ("after 2d") go out in that daily run. Signups, form submissions and bookings send their first steps right away.

## Known gaps

- No double opt-in. Anyone can sign up any address, slowed only by the honeypot and the per-IP limit. Add confirm-by-email if a list ever gets abused.
- Open rates are inflated by Apple Mail Privacy Protection, so read clicks instead.
- One popup per page view and per session. No A/B tests, SMS, geo targeting or cart events (they aren't needed for service businesses).
