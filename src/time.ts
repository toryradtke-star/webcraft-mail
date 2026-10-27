/**
 * Wall-clock time in a business's own timezone, with nothing but Intl:
 * opening hours, SMS quiet hours and the dates people see are all local.
 */
export type Local = { date: string; y: number; m: number; d: number; hh: number; mm: number; dow: number };

const fmts = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmts.get(tz);
  if (!f) fmts.set(tz, f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }));
  return f;
}
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function local(at: Date, tz: string): Local {
  const p = Object.fromEntries(fmt(tz).formatToParts(at).map((x) => [x.type, x.value]));
  const y = Number(p.year), m = Number(p.month), d = Number(p.day);
  return { y, m, d, hh: Number(p.hour), mm: Number(p.minute), dow: DOW[p.weekday], date: `${p.year}-${p.month}-${p.day}` };
}

/** The instant when the clock in tz reads date at hh:mm. Around a DST jump the nearest real time wins. */
export function atLocal(date: string, hhmm: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const l = local(new Date(t), tz);
    const seen = Date.UTC(l.y, l.m - 1, l.d, l.hh, l.mm);
    if (seen === want) break;
    t += want - seen;
  }
  return new Date(t);
}

/** "2026-10-28" plus n days. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** "Wed, Oct 28 at 2:30 PM" in the business's zone. */
export function human(at: Date | string, tz: string): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const day = d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  return `${day} at ${time}`;
}

/**
 * Automated texts go out between 9:00 and 20:00 local (TCPA allows 8 to 9,
 * this leaves margin). Returns null when now is fine, else when to try again.
 */
export function quietUntil(now: Date, tz: string): Date | null {
  const l = local(now, tz);
  if (l.hh >= 9 && l.hh < 20) return null;
  return atLocal(l.hh < 9 ? l.date : addDays(l.date, 1), '09:00', tz);
}
