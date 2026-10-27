/**
 * What the hub reads from the CRM: pipelines, deals and activity counts. The
 * same shapes as the hub's other CRM adapters (HighLevel), and nothing that
 * names a person: ids, stages, sources, dates and counts only.
 */
import type { Env, Site } from './runner.ts';

const iso = (d: Date) => d.toISOString();
const DAY = 86_400_000;

const deal = (o: any) => ({ id: String(o.id), pipelineId: o.pipeline, stageId: o.stage, status: o.status, source: o.source ?? '', createdAt: new Date(o.created_at).toISOString(), value: Number(o.value) });

export async function crmAdmin(env: Env, site: Site, what: string, q: URLSearchParams): Promise<unknown> {
  const s = site.config.id;
  const crm = site.config.crm;
  if (!crm) return { error: `${s} has no crm block` };
  if (what === 'pipelines') return { pipelines: crm.pipelines.map((p) => ({ id: p.id, name: p.name, stages: p.stages })) };
  if (what === 'deals') {
    // Whole days as the hub asks for them; it trims to the client's own timezone.
    const since = q.get('since') ?? '1970-01-01', until = q.get('until') ?? '2999-12-31';
    const rows = await env.sql('SELECT * FROM opportunities WHERE site = $1 AND created_at >= $2 AND created_at < $3 ORDER BY created_at',
      [s, iso(new Date(new Date(`${since}T00:00:00Z`).getTime() - DAY)), iso(new Date(new Date(`${until}T00:00:00Z`).getTime() + 2 * DAY))]);
    return { deals: rows.map(deal) };
  }
  if (what === 'open') return { deals: (await env.sql(`SELECT * FROM opportunities WHERE site = $1 AND status = 'open'`, [s])).map(deal) };
  if (what === 'stats') {
    const days = Math.max(1, Math.min(Number(q.get('days') ?? 30) || 30, 365));
    const since = iso(new Date(env.now().getTime() - days * DAY));
    const [contacts, sources, messages, unanswered, appts, runs, tasks, speed] = await Promise.all([
      env.sql(`SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > $2)::int AS new FROM profiles WHERE site = $1`, [s, since]),
      env.sql(`SELECT coalesce(source, '(none)') AS source, count(*)::int AS n FROM profiles WHERE site = $1 AND created_at > $2 GROUP BY 1 ORDER BY 2 DESC`, [s, since]),
      env.sql(`SELECT channel, direction, status, count(*)::int AS n FROM messages WHERE site = $1 AND at > $2 GROUP BY 1,2,3 ORDER BY 1,2,3`, [s, since]),
      // Conversations whose last message is from the contact and still unread.
      env.sql(`SELECT count(*)::int AS n FROM (SELECT DISTINCT ON (contact_id) direction, read_at FROM messages WHERE site = $1 AND status <> 'skipped' ORDER BY contact_id, at DESC) x WHERE direction = 'in' AND read_at IS NULL`, [s]),
      env.sql(`SELECT calendar, status, count(*)::int AS n FROM appointments WHERE site = $1 AND start_at > $2 GROUP BY 1,2 ORDER BY 1,2`, [s, since]),
      env.sql(`SELECT workflow, state, count(*)::int AS n FROM runs WHERE site = $1 AND started_at > $2 GROUP BY 1,2 ORDER BY 1,2`, [s, since]),
      env.sql(`SELECT count(*) FILTER (WHERE done_at IS NULL)::int AS open, count(*) FILTER (WHERE done_at IS NULL AND due_at < $2)::int AS overdue FROM tasks WHERE site = $1`, [s, iso(env.now())]),
      // Speed to lead: minutes from a form or booking to the first reply a person typed.
      env.sql(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY mins)::float AS median, count(*)::int AS answered FROM (
          SELECT EXTRACT(EPOCH FROM (min(o.at) - f.at)) / 60 AS mins FROM messages f JOIN messages o ON o.contact_id = f.contact_id AND o.direction = 'out' AND o.at > f.at AND o.author LIKE '%@%'
          WHERE f.site = $1 AND f.channel = 'form' AND f.at > $2 GROUP BY f.id, f.at) x`, [s, since]),
    ]);
    return { site: s, days, contacts: contacts[0], sources, messages, unanswered: unanswered[0].n, appointments: appts, workflows: runs, tasks: tasks[0], speedToLead: speed[0] };
  }
  return { error: `unknown crm view "${what}"` };
}
