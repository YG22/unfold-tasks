// Pure planner time helpers. Wall-clock dates are "YYYY-MM-DD", times "HH:mm".
// All intervals are half-open [start, end) in UTC epoch milliseconds.
export type Interval = { start: number; end: number };
export const MIN = 60_000;
export const DAY = 86_400_000;

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** 0 = Sunday … 6 = Saturday. */
export const weekday = (date: string) => new Date(date + "T00:00:00Z").getUTCDay();
/** Week starts on Sunday. */
export const weekStart = (date: string) => addDays(date, -weekday(date));
export const weekDates = (date: string) => Array.from({ length: 7 }, (_, i) => addDays(weekStart(date), i));
export const toMinutes = (time: string) => { const [h, m] = time.split(":").map(Number) as [number, number]; return h * 60 + m; };
export const fromMinutes = (n: number) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

function offset(t: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(t).map((x) => [x.type, x.value]));
  return Date.UTC(+p["year"]!, +p["month"]! - 1, +p["day"]!, +p["hour"]!, +p["minute"]!) - Math.floor(t / MIN) * MIN;
}

/** Local wall-clock (date, time) of an instant. */
export function toLocal(t: number, tz: string): { date: string; time: string } {
  const iso = new Date(t + offset(t, tz)).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

export type LocalCheck =
  | { status: "normal"; utc: number }
  | { status: "nonexistent"; firstValidUtc: number }
  | { status: "ambiguous"; utc: number; first: number; second: number };

/**
 * Classify a wall-clock time. Ambiguous (autumn) times resolve to the SECOND
 * occurrence, matching the verified reminder/DB policy. Nonexistent (spring gap)
 * times report the first valid instant after the gap.
 */
export function checkLocal(date: string, time: string, tz: string): LocalCheck {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, mo - 1, d) + toMinutes(time) * MIN;
  const offs = [...new Set([offset(wall - DAY, tz), offset(wall + DAY, tz), offset(wall, tz)])];
  const valid = [...new Set(offs.map((o) => wall - o).filter((t) => offset(t, tz) === wall - t))].sort((a, b) => a - b);
  if (valid.length === 1) return { status: "normal", utc: valid[0]! };
  if (valid.length >= 2) return { status: "ambiguous", utc: valid[valid.length - 1]!, first: valid[0]!, second: valid[valid.length - 1]! };
  // Gap: the transition instant is where the offset changes; its wall time is the first valid minute.
  let lo = wall - Math.max(...offs), hi = wall - Math.min(...offs);
  while (hi - lo > MIN) { const mid = Math.floor((lo + hi) / 2 / MIN) * MIN; if (offset(mid, tz) === offset(lo, tz)) lo = mid; else hi = mid; }
  return { status: "nonexistent", firstValidUtc: hi };
}

/** Start of a local calendar day (first valid instant of that date). */
export function dayStartUtc(date: string, tz: string): number {
  const c = checkLocal(date, "00:00", tz);
  return c.status === "nonexistent" ? c.firstValidUtc : c.status === "ambiguous" ? c.first : c.utc;
}
/** Exclusive end of a due date = start of the following local day. */
export const dueBoundaryUtc = (dueDate: string, tz: string) => dayStartUtc(addDays(dueDate, 1), tz);

export const overlaps = (a: Interval, b: Interval) => a.start < b.end && b.start < a.end;

/** Merge overlapping or touching intervals. */
export function merge(list: Interval[]): Interval[] {
  const s = list.filter((i) => i.end > i.start).map((i) => ({ ...i })).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const i of s) { const last = out[out.length - 1]; if (last && i.start <= last.end) last.end = Math.max(last.end, i.end); else out.push({ start: i.start, end: i.end }); }
  return out;
}
/** Window minus busy time. */
export function subtract(window: Interval, busy: Interval[]): Interval[] {
  const out: Interval[] = []; let cur = window.start;
  for (const b of merge(busy)) {
    if (b.end <= cur || b.start >= window.end) continue;
    if (b.start > cur) out.push({ start: cur, end: b.start });
    cur = Math.max(cur, b.end);
  }
  if (cur < window.end) out.push({ start: cur, end: window.end });
  return out;
}
/** Split an interval at local midnights (for drawing items that cross midnight). */
export function splitByDay(i: Interval, tz: string): Array<Interval & { date: string }> {
  const out: Array<Interval & { date: string }> = []; let s = i.start;
  while (s < i.end) { const date = toLocal(s, tz).date; const e = Math.min(i.end, dayStartUtc(addDays(date, 1), tz)); out.push({ date, start: s, end: e }); s = e; }
  return out;
}
