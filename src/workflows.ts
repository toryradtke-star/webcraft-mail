/**
 * Workflows: a trigger, an optional filter, then steps run in order (wait,
 * email, text, tag, opportunity, status, task, notify, stop), each with an
 * optional "when" condition. The same semantics as HighLevel's builder,
 * flattened: an if/else is two steps with opposite conditions.
 *
 * Starting a run only inserts a row; runWorkflows does the work, inside the
 * request that caused it (so a form's "notify the owner" goes out in seconds)
 * and on the cron for anything waiting. A run claims itself before it works,
 * every email has a unique send row and every text a unique message key, so a
 * retry never sends twice. A workflow whose content no longer matches the
 * approved hash ends its runs instead of sending.
 */
import { durationMs } from './config.ts';
import { workflowHash, type Action, type Cond, type Workflow, type WorkflowTrigger } from './crm-config.ts';
import { addTag, addTask, contactVars, getContact, placeInStage, removeTag, setOpportunityStatus, type Contact } from './crm.ts';
import { contactLink, notifyTeam, sendMessage } from './inbox.ts';
import { merge } from './render.ts';
import { deliver, loadSite, type Env, type Site } from './runner.ts';
import { quietUntil } from './time.ts';
import { appointmentVars } from './calendar.ts';

export type Fired =
  | { type: 'contact_created' }
  | { type: 'form_submitted'; form: string }
  | { type: 'tag_added'; tag: string }
  | { type: 'stage_changed'; pipeline: string; stage: string; ref: string }
  | { type: 'opportunity_status'; pipeline: string; status: string; ref: string }
  | { type: 'appointment_booked'; calendar: string; ref: string }
  | { type: 'appointment_status'; calendar: string; status: string; ref: string }
  | { type: 'customer_replied'; channel: 'email' | 'sms' };

const iso = (d: Date) => d.toISOString();
const CLAIM_MS = 5 * 60_000;

export function matches(t: WorkflowTrigger, f: Fired): boolean {
  if (t.type !== f.type) return false;
  switch (t.type) {
    case 'contact_created': return true;
    case 'form_submitted': return !t.form || t.form === (f as any).form;
    case 'tag_added': return t.tag.toLowerCase() === (f as any).tag;
    case 'stage_changed': return t.pipeline === (f as any).pipeline && (!t.stage || t.stage === (f as any).stage);
    case 'opportunity_status': return (!t.pipeline || t.pipeline === (f as any).pipeline) && t.status === (f as any).status;
    case 'appointment_booked': return !t.calendar || t.calendar === (f as any).calendar;
    case 'appointment_status': return (!t.calendar || t.calendar === (f as any).calendar) && t.status === (f as any).status;
    case 'customer_replied': return !t.channel || t.channel === (f as any).channel;
  }
}

/** Whether a condition holds for the contact now. runStart limits "replied" to this run. */
export async function holds(env: Env, c: Contact, cond: Cond | undefined, runStart?: string): Promise<boolean> {
  if (!cond) return true;
  if (cond.tag && !c.tags.includes(cond.tag.toLowerCase())) return false;
  if (cond.notTag && c.tags.includes(cond.notTag.toLowerCase())) return false;
  if (cond.hasEmail !== undefined && !!c.email !== cond.hasEmail) return false;
  if (cond.hasPhone !== undefined && !!c.phone !== cond.hasPhone) return false;
  if (cond.source && (c.source ?? '').toLowerCase() !== cond.source.toLowerCase()) return false;
  if (cond.field && String(c.custom?.[cond.field.key] ?? '') !== cond.field.equals) return false;
  if (cond.stage) {
    const r = await env.sql(`SELECT 1 FROM opportunities WHERE contact_id = $1 AND pipeline = $2 AND stage = $3 AND status = 'open' LIMIT 1`, [c.id, cond.stage.pipeline, cond.stage.stage]);
    if (!r.length) return false;
  }
  if (cond.replied !== undefined) {
    const r = await env.sql(`SELECT 1 FROM messages WHERE contact_id = $1 AND direction = 'in' AND channel <> 'form' AND at >= $2 LIMIT 1`, [c.id, runStart ?? '1970-01-01']);
    if (!!r.length !== cond.replied) return false;
  }
  return true;
}

/** Runs only what was pushed after approval: the stored hash must match the workflow as it is now. */
const approved = (site: Site, w: Workflow) => site.hashes[`wf:${w.id}`] === workflowHash(site.config, w);

/**
 * Starts every enabled, approved workflow this happening triggers. A contact
 * runs a workflow once unless it allows re-entry, and never twice at the same
 * time; appointment triggers run once per appointment.
 */
export async function fire(env: Env, site: Site, contactId: number, f: Fired): Promise<string[]> {
  const s = site.config.id;
  const flows = site.config.crm?.workflows ?? [];
  if (f.type === 'customer_replied') {
    const stoppers = flows.filter((w) => w.stopOnResponse).map((w) => w.id);
    if (stoppers.length) await env.sql(`UPDATE runs SET state = 'exited', ended_why = 'they replied' WHERE site = $1 AND contact_id = $2 AND state = 'active' AND workflow = ANY($3)`, [s, contactId, stoppers]);
  }
  const started: string[] = [];
  let contact: Contact | null = null;
  for (const w of flows) {
    if (!w.enabled || !matches(w.trigger, f) || !approved(site, w)) continue;
    contact ??= await getContact(env, s, contactId);
    if (!contact || !(await holds(env, contact, w.filter))) continue;
    const ref = 'ref' in f ? f.ref : null;
    const perAppt = f.type === 'appointment_booked' || f.type === 'appointment_status';
    const prior = await env.sql<any>(`SELECT state FROM runs WHERE site = $1 AND workflow = $2 AND contact_id = $3 ${perAppt ? 'AND ref = $4' : ''}`,
      perAppt ? [s, w.id, contactId, ref] : [s, w.id, contactId]);
    if (prior.some((r) => r.state === 'active')) continue;
    if (prior.length && !w.allowReentry && !perAppt) continue;
    await env.sql(`INSERT INTO runs (site, workflow, contact_id, ref, next_at, started_at) VALUES ($1,$2,$3,$4,$5,$5)`, [s, w.id, contactId, ref, iso(env.now())]);
    started.push(w.id);
  }
  return started;
}

export type WorkflowReport = { steps: number; done: number; exited: number; waiting: number };

type Run = { id: string; site: string; workflow: string; contact_id: string; ref: string | null; step: number; started_at: string };

/**
 * Works due runs, oldest first, each as far as it goes (to a wait, the end,
 * or a stop). With contactId, only that contact's, repeated while the steps
 * start more runs (a tag that triggers another workflow), up to a limit.
 */
export async function runWorkflows(env: Env, opts: { contactId?: number; limit?: number } = {}): Promise<WorkflowReport> {
  const report: WorkflowReport = { steps: 0, done: 0, exited: 0, waiting: 0 };
  const sites = new Map<string, Site | null>();
  for (let round = 0; round < (opts.contactId ? 5 : 1); round++) {
    const now = env.now();
    const claimed = await env.sql<Run>(
      `UPDATE runs SET claimed_until = $2
       WHERE id IN (SELECT id FROM runs WHERE state = 'active' AND next_at <= $1 AND (claimed_until IS NULL OR claimed_until < $1)
                    ${opts.contactId ? 'AND contact_id = $4' : ''} ORDER BY next_at LIMIT $3)
         AND (claimed_until IS NULL OR claimed_until < $1)
       RETURNING id, site, workflow, contact_id, ref, step, started_at`,
      [iso(now), iso(new Date(now.getTime() + CLAIM_MS)), opts.limit ?? 50, ...(opts.contactId ? [opts.contactId] : [])]);
    if (!claimed.length) break;
    for (const r of claimed) {
      if (!sites.has(r.site)) sites.set(r.site, await loadSite(env.sql, r.site));
      await advance(env, sites.get(r.site) ?? null, r, report);
    }
  }
  return report;
}

async function advance(env: Env, site: Site | null, r: Run, report: WorkflowReport): Promise<void> {
  const end = async (state: 'done' | 'exited', why: string | null = null) => {
    await env.sql(`UPDATE runs SET state = $2, ended_why = $3, claimed_until = NULL WHERE id = $1`, [r.id, state, why]);
    if (state === 'done') report.done++; else report.exited++;
  };
  const w = site?.config.crm?.workflows?.find((x) => x.id === r.workflow);
  // Turned off, removed, or edited without a new approval: the run ends.
  if (!site || !w || !w.enabled || !approved(site, w)) return end('exited', 'workflow changed or turned off');
  const contactId = Number(r.contact_id);
  let step = r.step;
  while (step < w.steps.length) {
    const a = w.steps[step];
    const c = await getContact(env, site.config.id, contactId);
    if (!c) return end('exited', 'contact deleted');
    report.steps++;
    if (!(await holds(env, c, a.when, r.started_at))) { step++; continue; }
    if (a.do === 'stop') { await log(env, site, c, w, step, a, 'stopped'); return end('exited', `stopped at step ${step + 1}`); }
    if (a.do === 'wait') {
      step++;
      await env.sql(`UPDATE runs SET step = $2, next_at = $3, claimed_until = NULL WHERE id = $1`, [r.id, step, iso(new Date(env.now().getTime() + durationMs(a.for)))]);
      report.waiting++;
      return;
    }
    if (a.do === 'sms' && quietUntil(env.now(), site.config.crm!.timezone)) {
      // Texts wait for daytime; the run picks up here then.
      await env.sql(`UPDATE runs SET step = $2, next_at = $3, claimed_until = NULL WHERE id = $1`, [r.id, step, iso(quietUntil(env.now(), site.config.crm!.timezone)!)]);
      report.waiting++;
      return;
    }
    try {
      const result = await act(env, site, c, w, r, step, a);
      await log(env, site, c, w, step, a, result);
      if (result === 'retry') {
        await env.sql(`UPDATE runs SET step = $2, next_at = $3, claimed_until = NULL WHERE id = $1`, [r.id, step, iso(new Date(env.now().getTime() + 3_600_000))]);
        return;
      }
    } catch (err) {
      await log(env, site, c, w, step, a, `error: ${(err as Error).message}`);
      return end('exited', `step ${step + 1} failed: ${(err as Error).message}`.slice(0, 300));
    }
    step++;
    await env.sql('UPDATE runs SET step = $2 WHERE id = $1', [r.id, step]);
  }
  return end('done');
}

async function log(env: Env, site: Site, c: Contact, w: Workflow, step: number, a: Action, result: string) {
  await env.sql(`INSERT INTO events (site, profile_id, name, props, at) VALUES ($1,$2,'Workflow Step',$3,$4)`,
    [site.config.id, c.id, JSON.stringify({ workflow: w.id, step: step + 1, action: a.do, result }), iso(env.now())]);
}

/** Does one step. Returns what happened, for the contact's timeline. */
async function act(env: Env, site: Site, c: Contact, w: Workflow, r: Run, step: number, a: Action): Promise<string> {
  const by = `workflow:${w.id}`;
  const vars = { ...contactVars(site, c), ...(r.ref?.startsWith('appt:') ? await appointmentVars(env, site, Number(r.ref.slice(5))) : {}) };
  switch (a.do) {
    case 'email': {
      if (!c.email) return 'skipped: no email';
      if (c.status === 'unsubscribed' || c.status === 'bounced' || c.status === 'complained') return `skipped: ${c.status}`;
      const t = site.config.templates[a.template];
      const res = await deliver(env, site.config, { id: c.id, email: c.email, first_name: c.first_name, status: c.status }, 'workflow', `${r.id}:${step}`, a.template, t, { workflow: w.id },
        { vars, log: by, reason: c.status === 'subscribed' ? undefined : `You're getting this because you contacted ${site.config.name}.` });
      return res === 'sent' ? 'sent' : res === 'failed' ? 'retry' : 'gave up';
    }
    case 'sms': {
      const res = await sendMessage(env, site, c.id, { channel: 'sms', body: merge(a.text, vars), author: by, automated: true, key: `${by}:${r.id}:${step}` });
      return res.status === 'skipped' ? `skipped: ${res.why}` : res.status;
    }
    case 'add_tag': await addTag(env, site, c.id, a.tag, by); return 'ok';
    case 'remove_tag': await removeTag(env, site, c.id, a.tag, by); return 'ok';
    case 'opportunity': {
      const o = await placeInStage(env, site, c.id, { pipeline: a.pipeline, stage: a.stage, name: a.name ? merge(a.name, vars) : undefined, value: a.value }, by);
      return `opportunity ${o.id} in ${a.stage}`;
    }
    case 'status': {
      const [o] = await env.sql<any>(`SELECT id FROM opportunities WHERE contact_id = $1 AND pipeline = $2 ORDER BY (status = 'open') DESC, created_at DESC LIMIT 1`, [c.id, a.pipeline]);
      if (!o) return 'skipped: no opportunity in that pipeline';
      await setOpportunityStatus(env, site, Number(o.id), a.status, a.reason ?? null, by);
      return a.status;
    }
    case 'task': {
      const due = a.due ? iso(new Date(env.now().getTime() + durationMs(a.due))) : null;
      // One task per run step, even if the step is retried.
      const [done] = await env.sql(`SELECT 1 FROM tasks WHERE contact_id = $1 AND created_by = $2 LIMIT 1`, [c.id, `${by}:${r.id}:${step}`]);
      if (!done) await addTask(env, site.config.id, { contactId: c.id, title: merge(a.title, vars), body: a.body ? merge(a.body, vars) : null, dueAt: due }, `${by}:${r.id}:${step}`);
      return 'ok';
    }
    case 'notify':
      await notifyTeam(env, site, merge(a.subject, vars), `${merge(a.text, vars)}\n\nOpen ${vars.full_name}: ${contactLink(env, site.config.id, c.id)}`, `${r.id}-${step}`);
      return 'sent';
  }
  return 'skipped';
}
