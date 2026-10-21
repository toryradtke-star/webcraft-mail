# webcraft-mail

Lightweight signup forms, onsite identity and email flows for Webcraft client sites: the parts of Klaviyo a local service business actually uses, on Vercel + Neon + Resend. The teardown it came from is `~/teardowns/2026-10-21-klaviyo-onsite/teardown.md`.

- **One script tag** per site: `<script src="https://mail.webcraftmn.com/wm.js" data-site="<id>" async></script>`
- **Forms**: popup or embedded, with delay, scroll depth, exit intent, URL include/exclude, device, cooldown and hide-if-subscribed. Shadow DOM, so site CSS can't break them. A honeypot field and 5 signups per IP per hour slow down bots.
- **Identity**: an anonymous first-party cookie (`wm_id`). Page views include Next.js client-side navigations. Signing up ties the browser to the person and backfills their earlier events. Email links back to the site carry a signed `_wm` token, so a new device is recognized too. Global Privacy Control turns page-view tracking off.
- **Flows**: triggered by a signup to a list, or by an event (optionally on a path), for known people. Steps are `after` waits with an optional `unlessEvent` exit, and each person runs each flow once. The first step sends inside the signup request, so a welcome email arrives in seconds.
- **Broadcasts**: one email to a list, sent within a daily cap and resumed across runs.
- **Compliance**: CAN-SPAM footer (name and postal address) on every email, one-click `List-Unsubscribe` (RFC 8058), an unsubscribe page where GET only asks (so link scanners can't unsubscribe anyone), a stored consent record (form wording, page, IP, time), and permanent suppression on bounces and spam complaints.
- **Safety**: every send row is written before Resend is called, and its id is the Resend idempotency key, so retries never double-send. Flows only run if their content hash matches what was pushed, and pushing happens only after approval in the hub.

## How it's run

The config for each business lives in hub-data (`clients/<slug>/email/site.json`), not here. The hub's `email` module stages a push. Tory approves it (`hub approve <id> --confirm send`, or through `gates_request_approval`), and the approved config is PUT to `/api/admin/sites`. Stats come back through `hub <client> email stats`.

## Develop

```
npm install
npm test        # 16 tests on PGlite (real Postgres in-process)
npm run check   # tsc
npm run dev     # http://localhost:8787/demo, fake mailer prints to the terminal
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
3. **Domain**: add `mail.webcraftmn.com` to the project (webcraftmn.com DNS is already on Vercel).
4. **Resend webhook**: endpoint `https://mail.webcraftmn.com/api/webhooks/resend` for `email.bounced` and `email.complained`. Put its signing secret in `RESEND_WEBHOOK_SECRET`.
5. **Sending domains**: webcraftmn.com is already verified. **workout247fitness.com is not**, so add it in Resend and put its DKIM/SPF/MX records in that domain's DNS before Workout 24/7's flows can send.
6. **Hub**: put `ADMIN_TOKEN`'s value in `~/hub-data/secrets.env` as `WEBCRAFT_MAIL_ADMIN_TOKEN`.
7. `vercel deploy --prod`, then `curl https://mail.webcraftmn.com/api/health`.

Vercel Hobby runs the cron once a day (15:00 UTC), so delayed steps ("after 2d") go out in that daily run. Signups send their first step right away.

## Known gaps

- No double opt-in. Anyone can sign up any address, slowed only by the honeypot and the per-IP limit. Add confirm-by-email if a list ever gets abused.
- Open rates are inflated by Apple Mail Privacy Protection, so read clicks instead.
- One popup per page view and per session. No A/B tests, SMS, geo targeting or cart events (they aren't needed for service businesses).
