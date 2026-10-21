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
