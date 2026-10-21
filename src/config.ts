/**
 * A site's whole setup (forms, flows, templates, sender) is one JSON document.
 * It is written in hub-data and pushed here by the hub only after Tory
 * approves it, so whatever is stored here is what was approved. Each flow's
 * hash (the flow plus the templates it uses) is recorded on push, and the
 * runner sends only flows whose hash still matches.
 */
import { createHash } from 'node:crypto';

export type Trigger = {
  /** Seconds after page load. */
  delaySec?: number;
  /** Percent of the page scrolled. */
  scrollPct?: number;
  /** Pointer leaves through the top of the window (desktop only). */
  exitIntent?: boolean;
  /** Path prefixes or globs ("*" matches anything) the form may show on; empty means everywhere. */
  urlInclude?: string[];
  urlExclude?: string[];
  device?: 'both' | 'desktop' | 'mobile';
  /** Days to wait after someone closes the form before showing it again. */
  cooldownDays?: number;
  /** Hide from anyone who already subscribed in this browser (default true). */
  hideIfSubscribed?: boolean;
};

export type Form = {
  id: string;
  type: 'popup' | 'embed';
  /** For embed forms: the CSS selector to render into. */
  target?: string;
  list: string;
  title: string;
  body?: string;
  fields: ('email' | 'first_name')[];
  button: string;
  success: string;
  /** Shown under the button and stored with each signup as the proof of consent. */
  consent: string;
  triggers?: Trigger;
};

export type Template = { subject: string; preheader?: string; body: string };

export type Step = {
  /** Wait before this step, counted from the previous one: "0m", "30m", "2h", "3d". */
  after: string;
  template: string;
  /** Leave the flow, sending nothing more, if the person did this since enrolling. */
  unlessEvent?: string;
};

export type Flow = {
  id: string;
  name?: string;
  enabled: boolean;
  trigger: { type: 'subscribed'; list: string } | { type: 'event'; name: string; pathPrefix?: string };
  steps: Step[];
};

export type SiteConfig = {
  id: string;
  name: string;
  /** Origins allowed to load forms and post events, e.g. "https://workout247fitness.com". */
  origins: string[];
  /** "Workout 24/7 <hello@workout247fitness.com>" on a Resend-verified domain. */
  from: string;
  replyTo?: string;
  /** Postal address for the CAN-SPAM footer. */
  address: string;
  brandColor?: string;
  privacyUrl?: string;
  /** Most emails per day across flows and broadcasts (domain warmup). */
  dailyCap?: number;
  lists: { id: string; name: string }[];
  forms: Form[];
  flows: Flow[];
  templates: Record<string, Template>;
};

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const DUR = /^(\d+)\s*(m|h|d)$/;

export function durationMs(s: string): number {
  const m = DUR.exec(s.trim());
  if (!m) throw new Error(`"${s}" is not a wait like 0m, 30m, 2h or 3d`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
}

/** Every problem with a config, as sentences; empty means it can be pushed. */
export function configProblems(c: SiteConfig): string[] {
  const out: string[] = [];
  const need = (ok: unknown, msg: string) => { if (!ok) out.push(msg); };
  need(ID.test(c.id ?? ''), `site id "${c.id}" must be lowercase letters, digits and dashes`);
  need(c.name, 'name is missing');
  need(Array.isArray(c.origins) && c.origins.length && c.origins.every((o) => /^https?:\/\/[^/]+$/.test(o)), 'origins must be like "https://example.com" (no path, no trailing slash)');
  need(/^.+<[^@\s]+@[^@\s]+\.[a-z]{2,}>$/i.test(c.from ?? ''), 'from must look like "Name <you@domain.com>"');
  need((c.address ?? '').length >= 10, 'address (a real postal address) is required by CAN-SPAM');
  const lists = new Set((c.lists ?? []).map((l) => l.id));
  need(lists.size, 'at least one list is needed');
  for (const l of c.lists ?? []) need(ID.test(l.id), `list id "${l.id}" must be lowercase letters, digits and dashes`);
  const ids = new Set<string>();
  for (const f of c.forms ?? []) {
    need(ID.test(f.id) && !ids.has(f.id), `form id "${f.id}" is invalid or repeated`);
    ids.add(f.id);
    need(f.type === 'popup' || f.type === 'embed', `form ${f.id}: type must be popup or embed`);
    need(f.type !== 'embed' || f.target, `form ${f.id}: an embed form needs a target selector`);
    need(lists.has(f.list), `form ${f.id}: list "${f.list}" isn't in lists`);
    need(f.fields?.includes('email'), `form ${f.id}: fields must include email`);
    need(f.title && f.button && f.success, `form ${f.id}: title, button and success are required`);
    need((f.consent ?? '').length >= 20, `form ${f.id}: consent wording is required (it is the proof of opt-in)`);
  }
  const fids = new Set<string>();
  for (const fl of c.flows ?? []) {
    need(ID.test(fl.id) && !fids.has(fl.id), `flow id "${fl.id}" is invalid or repeated`);
    fids.add(fl.id);
    if (fl.trigger?.type === 'subscribed') need(lists.has(fl.trigger.list), `flow ${fl.id}: list "${fl.trigger.list}" isn't in lists`);
    else need(fl.trigger?.type === 'event' && fl.trigger.name, `flow ${fl.id}: trigger must be {type:"subscribed",list} or {type:"event",name}`);
    need(fl.steps?.length, `flow ${fl.id}: needs at least one step`);
    for (const [i, s] of (fl.steps ?? []).entries()) {
      try { durationMs(s.after); } catch (e) { out.push(`flow ${fl.id} step ${i + 1}: ${(e as Error).message}`); }
      need(c.templates?.[s.template], `flow ${fl.id} step ${i + 1}: template "${s.template}" doesn't exist`);
    }
  }
  for (const [k, t] of Object.entries(c.templates ?? {})) need(t.subject && t.body, `template ${k}: subject and body are required`);
  if (c.dailyCap !== undefined) need(Number.isInteger(c.dailyCap) && c.dailyCap > 0, 'dailyCap must be a positive whole number');
  return out;
}

/** JSON with sorted keys, so the same content always hashes the same. */
export function canonical(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** A flow's hash covers the flow and the exact templates it sends. */
export function flowHash(c: SiteConfig, f: Flow): string {
  const templates = Object.fromEntries(f.steps.map((s) => [s.template, c.templates[s.template]]));
  return createHash('sha256').update(canonical({ flow: f, templates, from: c.from, address: c.address })).digest('hex').slice(0, 16);
}

export const flowHashes = (c: SiteConfig): Record<string, string> => Object.fromEntries(c.flows.map((f) => [f.id, flowHash(c, f)]));

/** What the onsite script gets: forms only, nothing about flows or the sender. */
export function publicForms(c: SiteConfig) {
  return {
    site: c.id,
    color: c.brandColor ?? '#111827',
    privacyUrl: c.privacyUrl,
    forms: c.forms.map(({ id, type, target, title, body, fields, button, success, consent, triggers }) =>
      ({ id, type, target, title, body, fields, button, success, consent, triggers: { hideIfSubscribed: true, cooldownDays: 7, device: 'both', ...triggers } })),
  };
}
