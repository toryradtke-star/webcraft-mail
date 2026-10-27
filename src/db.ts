/**
 * The database is plain Postgres: Neon over HTTP in production, PGlite (real
 * Postgres compiled to WASM, in-process) in tests and local dev. Both sit
 * behind one function, so nothing else knows which it is.
 *
 * Every timestamp is passed in as a parameter rather than read from now(), so
 * tests can move the clock.
 */
export type Sql = <T = any>(text: string, params?: unknown[]) => Promise<T[]>;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id text PRIMARY KEY,
  config jsonb NOT NULL,
  hashes jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL
);
-- status: subscribed | unsubscribed | bounced | complained. Only subscribed gets mail.
CREATE TABLE IF NOT EXISTS profiles (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  email text NOT NULL,
  first_name text,
  status text NOT NULL DEFAULT 'subscribed',
  created_at timestamptz NOT NULL,
  status_at timestamptz NOT NULL,
  UNIQUE (site, email)
);
-- The proof of opt-in: what the person saw, where, and when.
CREATE TABLE IF NOT EXISTS consents (
  id bigserial PRIMARY KEY,
  profile_id bigint NOT NULL,
  site text NOT NULL,
  form_id text NOT NULL,
  list text NOT NULL,
  wording text NOT NULL,
  url text,
  ip text,
  user_agent text,
  at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS consents_ip ON consents (ip, at);
CREATE TABLE IF NOT EXISTS memberships (
  profile_id bigint NOT NULL,
  list text NOT NULL,
  at timestamptz NOT NULL,
  PRIMARY KEY (profile_id, list)
);
-- An anonymous browser (the wm_id cookie), tied to a profile once known.
CREATE TABLE IF NOT EXISTS visitors (
  site text NOT NULL,
  anon_id text NOT NULL,
  profile_id bigint,
  first_seen timestamptz NOT NULL,
  PRIMARY KEY (site, anon_id)
);
CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  anon_id text,
  profile_id bigint,
  name text NOT NULL,
  props jsonb NOT NULL DEFAULT '{}',
  url text,
  at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS events_profile ON events (profile_id, name, at);
CREATE INDEX IF NOT EXISTS events_anon ON events (site, anon_id);
CREATE INDEX IF NOT EXISTS events_site ON events (site, at);
-- One run of a flow for one profile. Once per profile per flow, ever.
-- state: active | done | exited
CREATE TABLE IF NOT EXISTS enrollments (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  flow_id text NOT NULL,
  profile_id bigint NOT NULL,
  step int NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active',
  enrolled_at timestamptz NOT NULL,
  claimed_until timestamptz,
  UNIQUE (site, flow_id, profile_id)
);
CREATE INDEX IF NOT EXISTS enrollments_due ON enrollments (state, next_at);
CREATE TABLE IF NOT EXISTS broadcasts (
  id text PRIMARY KEY,
  site text NOT NULL,
  list text NOT NULL,
  template jsonb NOT NULL,
  state text NOT NULL DEFAULT 'sending',
  created_at timestamptz NOT NULL
);
-- Every email, written before Resend is called. ref is "<enrollment>:<step>" or the
-- broadcast id; the unique key is what stops a double send.
-- status: sending | sent | failed | skipped
CREATE TABLE IF NOT EXISTS sends (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  profile_id bigint NOT NULL,
  kind text NOT NULL,
  ref text NOT NULL,
  template text NOT NULL,
  subject text NOT NULL,
  status text NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  resend_id text,
  error text,
  at timestamptz NOT NULL,
  opened_at timestamptz,
  clicked_at timestamptz,
  UNIQUE (kind, ref, profile_id)
);
CREATE INDEX IF NOT EXISTS sends_site ON sends (site, at);
CREATE INDEX IF NOT EXISTS sends_resend ON sends (resend_id);

-- CRM (2026-10-27). A profile is the contact: email is optional once a phone is known.
-- status is email: subscribed (marketing) | none (contact only: workflow and
-- appointment mail, never broadcasts or flows) | unsubscribed | bounced | complained.
-- sms_status: none | consented (ticked the box: automated texts) | stopped (replied STOP).
ALTER TABLE profiles ALTER COLUMN email DROP NOT NULL;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_name text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS sms_status text NOT NULL DEFAULT 'none';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS source text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS attribution jsonb;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS owner text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_activity_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_phone ON profiles (site, phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS profiles_activity ON profiles (site, last_activity_at);
-- status: open | won | lost | abandoned
CREATE TABLE IF NOT EXISTS opportunities (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  contact_id bigint NOT NULL,
  pipeline text NOT NULL,
  stage text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  name text,
  value numeric(12,2) NOT NULL DEFAULT 0,
  source text,
  lost_reason text,
  owner text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  stage_at timestamptz NOT NULL,
  status_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS opportunities_board ON opportunities (site, pipeline, status);
CREATE INDEX IF NOT EXISTS opportunities_contact ON opportunities (contact_id);
CREATE TABLE IF NOT EXISTS notes (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  contact_id bigint NOT NULL,
  body text NOT NULL,
  author text NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_contact ON notes (contact_id, at);
CREATE TABLE IF NOT EXISTS tasks (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  contact_id bigint,
  title text NOT NULL,
  body text,
  due_at timestamptz,
  assigned_to text,
  done_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_open ON tasks (site, done_at, due_at);
-- status: booked | confirmed | cancelled | showed | noshow. seat makes double booking impossible:
-- a slot with maxPerSlot n has seats 0..n-1, and an active seat is unique.
CREATE TABLE IF NOT EXISTS appointments (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  calendar text NOT NULL,
  contact_id bigint NOT NULL,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  seat int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'booked',
  notes text,
  booked_by text NOT NULL,
  reminded text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  status_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS appointments_seat ON appointments (site, calendar, start_at, seat) WHERE status <> 'cancelled';
CREATE INDEX IF NOT EXISTS appointments_when ON appointments (site, start_at);
-- Time the owner blocked off (holidays, a dentist visit). calendar null blocks every calendar.
CREATE TABLE IF NOT EXISTS blocks (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  calendar text,
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  reason text,
  created_by text NOT NULL
);
CREATE INDEX IF NOT EXISTS blocks_when ON blocks (site, start_at);
-- The inbox: one conversation per contact, every channel. direction in | out.
-- status: queued | sent | delivered | failed | received | skipped
CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  contact_id bigint NOT NULL,
  channel text NOT NULL,
  direction text NOT NULL,
  subject text,
  body text NOT NULL,
  status text NOT NULL,
  provider_id text,
  error text,
  author text NOT NULL,
  at timestamptz NOT NULL,
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS messages_contact ON messages (contact_id, at);
CREATE INDEX IF NOT EXISTS messages_inbox ON messages (site, at);
CREATE UNIQUE INDEX IF NOT EXISTS messages_provider ON messages (channel, provider_id) WHERE provider_id IS NOT NULL;
-- One workflow run. state: active | done | exited. ref ties a run to the opportunity
-- or appointment that started it ("appt:12"), so appointment triggers can run per appointment.
CREATE TABLE IF NOT EXISTS runs (
  id bigserial PRIMARY KEY,
  site text NOT NULL,
  workflow text NOT NULL,
  contact_id bigint NOT NULL,
  ref text,
  step int NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'active',
  started_at timestamptz NOT NULL,
  claimed_until timestamptz,
  ended_why text
);
CREATE INDEX IF NOT EXISTS runs_due ON runs (state, next_at);
CREATE INDEX IF NOT EXISTS runs_contact ON runs (site, workflow, contact_id);
-- Owner-app sign-in. The token is never stored, only its hash.
CREATE TABLE IF NOT EXISTS sessions (
  hash text PRIMARY KEY,
  email text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
`;

export async function migrate(sql: Sql): Promise<void> {
  for (const stmt of SCHEMA.replace(/^\s*--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean)) await sql(stmt);
}

/** Neon's HTTP driver: one round trip per query, nothing to pool. */
export async function neonSql(url: string): Promise<Sql> {
  const { neon } = await import('@neondatabase/serverless');
  const q = neon(url);
  return (text, params = []) => q.query(text, params as any[]) as any;
}

/** In-process Postgres for tests and `npm run dev`; dataDir keeps it on disk. */
export async function pgliteSql(dataDir?: string): Promise<Sql> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dataDir);
  return async (text, params = []) => (await db.query(text, params as any[])).rows as any;
}
