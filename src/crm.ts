/**
 * Contacts, tags, opportunities, notes and tasks: the CRM records every other
 * part (forms, bookings, the inbox, workflows, the owner app) writes through.
 * Each change that a workflow can start on goes through here, so the trigger
 * fires the same way whoever made the change.
 *
 * A contact is matched by email first, then phone (HighLevel's default
 * dedupe). Tags are only ever added or removed one at a time, never replaced
 * wholesale, so an update can't wipe them.
 */
import type { Env, Site } from './runner.ts';
import { fire } from './workflows.ts';
import type { Vars } from './render.ts';

export type Contact = {
  id: number; site: string; email: string | null; first_name: string | null; last_name: string | null; phone: string | null;
  status: string; sms_status: string; tags: string[]; custom: Record<string, string>; source: string | null; owner: string | null;
  created_at: string; last_activity_at: string | null;
};

const iso = (d: Date) => d.toISOString();
export const EMAIL = /^[^\s@<>()",;:]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,24}$/i;

/** US-first phone normalizing to E.164: "(218) 555-0100" → "+12185550100". Null when it isn't a number. */
export function normPhone(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export const fullName = (c: Pick<Contact, 'first_name' | 'last_name' | 'email' | 'phone'>) =>
  [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || c.phone || 'Unknown';

export async function getContact(env: Env, site: string, id: number): Promise<Contact | null> {
  const [c] = await env.sql<any>('SELECT * FROM profiles WHERE id = $1 AND site = $2', [id, site]);
  return c ? { ...c, id: Number(c.id) } : null;
}

/** Writes an activity row on the contact's timeline. */
export async function activity(env: Env, site: string, contactId: number, name: string, props: Record<string, unknown> = {}, url: string | null = null): Promise<void> {
  const now = iso(env.now());
  await env.sql(`INSERT INTO events (site, profile_id, name, props, url, at) VALUES ($1,$2,$3,$4,$5,$6)`, [site, contactId, name, JSON.stringify(props), url, now]);
  await env.sql('UPDATE profiles SET last_activity_at = $2 WHERE id = $1', [contactId, now]);
}

export type ContactInput = {
  email?: string | null; phone?: string | null; first_name?: string | null; last_name?: string | null;
  source?: string | null; custom?: Record<string, string>; attribution?: Record<string, unknown> | null;
};

/**
 * Finds the contact by email, then phone, and fills in what's new; creates it
 * otherwise. New non-empty values win over old ones, empty ones never erase.
 * Fires contact_created for a new contact. Email marketing status starts as
 * "none": only a signup or a ticked box makes someone "subscribed".
 */
export async function upsertContact(env: Env, site: Site, input: ContactInput): Promise<{ contact: Contact; created: boolean }> {
  const s = site.config.id;
  const email = input.email ? String(input.email).trim().toLowerCase() : null;
  const phone = input.phone ? normPhone(input.phone) : null;
  if (!email && !phone) throw new Error('a contact needs an email or a phone number');
  const now = iso(env.now());
  let [row] = email ? await env.sql<any>('SELECT id FROM profiles WHERE site = $1 AND email = $2', [s, email]) : [];
  if (!row && phone) [row] = await env.sql<any>('SELECT id FROM profiles WHERE site = $1 AND phone = $2', [s, phone]);
  const custom = JSON.stringify(input.custom ?? {});
  if (row) {
    // A phone already on another contact stays there; this one keeps its own.
    const phoneFree = phone ? !(await env.sql('SELECT 1 FROM profiles WHERE site = $1 AND phone = $2 AND id <> $3', [s, phone, row.id])).length : false;
    await env.sql(`UPDATE profiles SET
        email = COALESCE(email, $2), phone = CASE WHEN $3::text IS NOT NULL AND $4 THEN $3 ELSE phone END,
        first_name = COALESCE(NULLIF($5, ''), first_name), last_name = COALESCE(NULLIF($6, ''), last_name),
        source = COALESCE(source, $7), custom = custom || $8::jsonb, last_activity_at = $9
      WHERE id = $1`, [row.id, email, phone, phoneFree, input.first_name ?? null, input.last_name ?? null, input.source ?? null, custom, now]);
    return { contact: (await getContact(env, s, Number(row.id)))!, created: false };
  }
  const [p] = await env.sql<any>(`INSERT INTO profiles (site, email, phone, first_name, last_name, status, source, attribution, custom, created_at, status_at, last_activity_at)
    VALUES ($1,$2,$3,$4,$5,'none',$6,$7,$8::jsonb,$9,$9,$9) RETURNING id`,
    [s, email, phone, input.first_name || null, input.last_name || null, input.source ?? null, input.attribution ? JSON.stringify(input.attribution) : null, custom, now]);
  const id = Number(p.id);
  await activity(env, s, id, 'Contact Created', { source: input.source ?? null });
  await fire(env, site, id, { type: 'contact_created' });
  return { contact: (await getContact(env, s, id))!, created: true };
}

export async function addTag(env: Env, site: Site, contactId: number, tag: string, by: string): Promise<boolean> {
  const t = tag.trim().toLowerCase().slice(0, 60);
  if (!t) return false;
  const r = await env.sql(`UPDATE profiles SET tags = array_append(tags, $2) WHERE id = $1 AND site = $3 AND NOT ($2 = ANY(tags)) RETURNING id`, [contactId, t, site.config.id]);
  if (!r.length) return false;
  await activity(env, site.config.id, contactId, 'Tag Added', { tag: t, by });
  await fire(env, site, contactId, { type: 'tag_added', tag: t });
  return true;
}

export async function removeTag(env: Env, site: Site, contactId: number, tag: string, by: string): Promise<boolean> {
  const t = tag.trim().toLowerCase();
  const r = await env.sql(`UPDATE profiles SET tags = array_remove(tags, $2) WHERE id = $1 AND site = $3 AND $2 = ANY(tags) RETURNING id`, [contactId, t, site.config.id]);
  if (r.length) await activity(env, site.config.id, contactId, 'Tag Removed', { tag: t, by });
  return r.length > 0;
}

export type Opportunity = {
  id: number; contact_id: number; pipeline: string; stage: string; status: string; name: string | null; value: number;
  source: string | null; lost_reason: string | null; created_at: string; stage_at: string;
};

const oppRow = (o: any): Opportunity => ({ ...o, id: Number(o.id), contact_id: Number(o.contact_id), value: Number(o.value) });

export async function getOpportunity(env: Env, site: string, id: number): Promise<Opportunity | null> {
  const [o] = await env.sql('SELECT * FROM opportunities WHERE id = $1 AND site = $2', [id, site]);
  return o ? oppRow(o) : null;
}

function stageOk(site: Site, pipeline: string, stage: string) {
  const p = site.config.crm?.pipelines.find((x) => x.id === pipeline);
  if (!p) throw new Error(`no pipeline "${pipeline}"`);
  if (!p.stages.some((s) => s.id === stage)) throw new Error(`pipeline ${pipeline} has no stage "${stage}"`);
}

/**
 * Puts the contact in a stage: moves their open opportunity in that pipeline,
 * or opens one. Fires stage_changed when the stage actually changes.
 */
export async function placeInStage(env: Env, site: Site, contactId: number, o: { pipeline: string; stage: string; name?: string; value?: number; source?: string | null; id?: number }, by: string): Promise<Opportunity> {
  stageOk(site, o.pipeline, o.stage);
  const s = site.config.id;
  const now = iso(env.now());
  const [cur] = o.id
    ? await env.sql('SELECT * FROM opportunities WHERE id = $1 AND site = $2 AND contact_id = $3', [o.id, s, contactId])
    : await env.sql(`SELECT * FROM opportunities WHERE site = $1 AND contact_id = $2 AND pipeline = $3 AND status = 'open' ORDER BY created_at DESC LIMIT 1`, [s, contactId, o.pipeline]);
  let opp: Opportunity;
  let moved = false;
  if (cur) {
    if (cur.pipeline !== o.pipeline) throw new Error('an opportunity stays in its own pipeline');
    moved = cur.stage !== o.stage;
    const [u] = await env.sql(`UPDATE opportunities SET stage = $2, stage_at = CASE WHEN stage <> $2 THEN $3::timestamptz ELSE stage_at END, updated_at = $3,
        name = COALESCE($4, name), value = COALESCE($5, value) WHERE id = $1 RETURNING *`, [cur.id, o.stage, now, o.name ?? null, o.value ?? null]);
    opp = oppRow(u);
  } else {
    const [c] = await env.sql<any>('SELECT source FROM profiles WHERE id = $1', [contactId]);
    const [n] = await env.sql(`INSERT INTO opportunities (site, contact_id, pipeline, stage, name, value, source, created_at, updated_at, stage_at, status_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$8,$8) RETURNING *`, [s, contactId, o.pipeline, o.stage, o.name ?? null, o.value ?? 0, o.source ?? c?.source ?? null, now]);
    opp = oppRow(n);
    moved = true;
  }
  if (moved) {
    await activity(env, s, contactId, 'Stage Changed', { opportunity: opp.id, pipeline: o.pipeline, stage: o.stage, from: cur?.stage ?? null, by });
    await fire(env, site, contactId, { type: 'stage_changed', pipeline: o.pipeline, stage: o.stage, ref: `opp:${opp.id}` });
  }
  return opp;
}

export async function setOpportunityStatus(env: Env, site: Site, id: number, status: 'open' | 'won' | 'lost' | 'abandoned', reason: string | null, by: string): Promise<Opportunity> {
  const s = site.config.id;
  const cur = await getOpportunity(env, s, id);
  if (!cur) throw new Error('no such opportunity');
  if (cur.status === status) return cur;
  const now = iso(env.now());
  const [u] = await env.sql(`UPDATE opportunities SET status = $2, status_at = $3, updated_at = $3, lost_reason = $4 WHERE id = $1 RETURNING *`,
    [id, status, now, status === 'lost' ? reason : null]);
  await activity(env, s, cur.contact_id, 'Opportunity Status', { opportunity: id, pipeline: cur.pipeline, status, reason, by });
  await fire(env, site, cur.contact_id, { type: 'opportunity_status', pipeline: cur.pipeline, status, ref: `opp:${id}` });
  return oppRow(u);
}

export async function addNote(env: Env, site: string, contactId: number, body: string, author: string): Promise<number> {
  const text = body.trim().slice(0, 5000);
  if (!text) throw new Error('a note needs text');
  const [n] = await env.sql<any>('INSERT INTO notes (site, contact_id, body, author, at) VALUES ($1,$2,$3,$4,$5) RETURNING id', [site, contactId, text, author, iso(env.now())]);
  await env.sql('UPDATE profiles SET last_activity_at = $2 WHERE id = $1', [contactId, iso(env.now())]);
  return Number(n.id);
}

export async function addTask(env: Env, site: string, t: { contactId?: number | null; title: string; body?: string | null; dueAt?: string | null; assignedTo?: string | null }, by: string): Promise<number> {
  const title = t.title.trim().slice(0, 200);
  if (!title) throw new Error('a task needs a title');
  const [n] = await env.sql<any>(`INSERT INTO tasks (site, contact_id, title, body, due_at, assigned_to, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [site, t.contactId ?? null, title, t.body ?? null, t.dueAt ?? null, t.assignedTo ?? null, by, iso(env.now())]);
  if (t.contactId) await activity(env, site, t.contactId, 'Task Created', { task: Number(n.id), title, by });
  return Number(n.id);
}

export async function completeTask(env: Env, site: string, id: number, done: boolean): Promise<void> {
  await env.sql('UPDATE tasks SET done_at = $3 WHERE id = $1 AND site = $2', [id, site, done ? iso(env.now()) : null]);
}

/** Merge fields for a contact, for templates, texts and notices. */
export function contactVars(site: Site, c: Contact): Vars & Record<string, string> {
  return {
    first_name: c.first_name ?? '', last_name: c.last_name ?? '', full_name: fullName(c),
    email: c.email ?? '', phone: c.phone ?? '', site_name: site.config.name,
  };
}
