// Planner calculations: recurrence, exceptions, travel, busy/free time, suggestions, tasks, categories.
// Pure and deterministic; not used by the app yet.
import type { SubTask } from "../tasks";
import { addDays, checkLocal, dueBoundaryUtc, merge, MIN, overlaps, subtract, toMinutes, weekday, fromMinutes, toLocal, type Interval } from "./time";

export const DISPLAY_FALLBACK_MIN = 30;
export const SUGGESTION_STEP_MIN = 15;

export type PlannerEvent = {
  id: string; title: string; categoryId?: string | null;
  date: string; // one-time date, or series start date
  startTime: string; durationMin: number;
  weekdays?: number[] | null; // weekly repeat when set (0 = Sunday)
  until?: string | null; // inclusive last date of a series
  travelBeforeMin?: number | null; travelAfterMin?: number | null;
};
export type PlannerException =
  | { eventId: string; originalDate: string; type: "skip" }
  | { eventId: string; originalDate: string; type: "change"; date?: string; startTime?: string; durationMin?: number };

export type Occurrence = {
  key: string; eventId: string; originalDate: string; date: string; startTime: string; durationMin: number;
  status: "normal" | "moved" | "ambiguous" | "invalid";
  interval: Interval | null; // real time; null when invalid
  /** Protective busy time for an invalid recurring occurrence (spring DST gap). Not a rescheduled event. */
  reservation: (Interval & { reason: "invalid-recurring-dst" }) | null;
};

export function validateEvent(e: PlannerEvent, tz: string): string[] {
  const errs: string[] = [];
  if (!(e.durationMin > 0)) errs.push("duration");
  if (!e.weekdays?.length && checkLocal(e.date, e.startTime, tz).status === "nonexistent") errs.push("nonexistent-time");
  if (e.until && e.until < e.date) errs.push("until-before-start");
  return errs;
}

/** Manual scheduling: any minute, but never a nonexistent local time. */
export function validateManualTime(date: string, time: string, tz: string): { ok: boolean; note?: "ambiguous-second" } {
  const c = checkLocal(date, time, tz);
  if (c.status === "nonexistent") return { ok: false };
  return c.status === "ambiguous" ? { ok: true, note: "ambiguous-second" } : { ok: true };
}

function isSeriesDate(e: PlannerEvent, d: string) {
  if (d < e.date || (e.until && d > e.until)) return false;
  return e.weekdays?.length ? e.weekdays.includes(weekday(d)) : d === e.date;
}

function build(e: PlannerEvent, originalDate: string, date: string, startTime: string, durationMin: number, moved: boolean, tz: string): Occurrence {
  const key = `${e.id}:${originalDate}`;
  const c = checkLocal(date, startTime, tz);
  const base = { key, eventId: e.id, originalDate, date, startTime, durationMin };
  if (c.status === "nonexistent")
    return { ...base, status: "invalid", interval: null, reservation: { start: c.firstValidUtc, end: c.firstValidUtc + durationMin * MIN, reason: "invalid-recurring-dst" } };
  const interval = { start: c.utc, end: c.utc + durationMin * MIN }; // real elapsed time
  return { ...base, status: moved ? "moved" : c.status === "ambiguous" ? "ambiguous" : "normal", interval, reservation: null };
}

/** Expand events for local dates in [from, to). Moved occurrences appear on their new date only. */
export function expand(events: PlannerEvent[], exceptions: PlannerException[], from: string, to: string, tz: string): Occurrence[] {
  const ex = new Map(exceptions.map((x) => [`${x.eventId}:${x.originalDate}`, x]));
  const out: Occurrence[] = [];
  for (const e of events) {
    for (let d = from; d < to; d = addDays(d, 1)) {
      if (!isSeriesDate(e, d)) continue;
      const x = ex.get(`${e.id}:${d}`);
      if (x?.type === "skip") continue;
      if (x?.type === "change") {
        const nd = x.date ?? d;
        if (nd >= from && nd < to) out.push(build(e, d, nd, x.startTime ?? e.startTime, x.durationMin ?? e.durationMin, true, tz));
        continue;
      }
      out.push(build(e, d, d, e.startTime, e.durationMin, false, tz));
    }
    // Changes moving an occurrence INTO range from an original date outside it.
    for (const x of exceptions) {
      if (x.eventId !== e.id || x.type !== "change" || !x.date) continue;
      if ((x.originalDate < from || x.originalDate >= to) && x.date >= from && x.date < to && isSeriesDate(e, x.originalDate))
        out.push(build(e, x.originalDate, x.date, x.startTime ?? e.startTime, x.durationMin ?? e.durationMin, true, tz));
    }
  }
  return out.sort((a, b) => (a.interval ?? a.reservation)!.start - (b.interval ?? b.reservation)!.start);
}

/** "From date X": end the old series the day before, start a new series at X. Exceptions are partitioned by date. */
export function splitSeries(e: PlannerEvent, exceptions: PlannerException[], fromDate: string, newId: string, changes: Partial<PlannerEvent>) {
  const before: PlannerEvent = { ...e, until: addDays(fromDate, -1) };
  const after: PlannerEvent = { ...e, ...changes, id: newId, date: fromDate };
  const mine = exceptions.filter((x) => x.eventId === e.id);
  return { before, after, keptExceptions: mine.filter((x) => x.originalDate < fromDate), droppedExceptions: mine.filter((x) => x.originalDate >= fromDate) };
}

// ---------- Travel ----------
export type TravelBlock = Interval & { sourceKey: string; side: "before" | "after" };
const occTime = (o: Occurrence) => o.interval ?? o.reservation;

export function travelBlocks(o: Occurrence, e: PlannerEvent): TravelBlock[] {
  const t = occTime(o); if (!t) return [];
  const out: TravelBlock[] = [];
  if (e.travelBeforeMin) out.push({ start: t.start - e.travelBeforeMin * MIN, end: t.start, sourceKey: o.key, side: "before" });
  if (e.travelAfterMin) out.push({ start: t.end, end: t.end + e.travelAfterMin * MIN, sourceKey: o.key, side: "after" });
  return out;
}

export type TravelConflict = { kind: "possible-travel-conflict"; fromKey: string; toKey: string; gapMin: number; requiredMin: number; travelAfterMin: number; travelBeforeMin: number };

/** Consecutive non-overlapping items whose after+before travel exceeds the gap. Possible, not impossible. */
export function travelConflicts(occs: Occurrence[], events: PlannerEvent[]): TravelConflict[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const list = occs.filter((o) => occTime(o)).sort((a, b) => occTime(a)!.start - occTime(b)!.start);
  const out: TravelConflict[] = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1]!, b = list[i]!;
    const gap = (occTime(b)!.start - occTime(a)!.end) / MIN;
    if (gap < 0) continue; // real overlap, reported elsewhere
    const after = byId.get(a.eventId)?.travelAfterMin ?? 0, before = byId.get(b.eventId)?.travelBeforeMin ?? 0;
    if (after + before > gap) out.push({ kind: "possible-travel-conflict", fromKey: a.key, toKey: b.key, gapMin: gap, requiredMin: after + before, travelAfterMin: after, travelBeforeMin: before });
  }
  return out;
}

// ---------- Tasks ----------
export type TaskPlacement = { subtaskId: string; place: "calendar" | "drawer"; interval: Interval | null; durationMin: number; durationIsFallback: boolean; done: boolean; invalidTime: boolean };

/** Subtasks with date+time go on the calendar (done ones too); others go to the drawer. Never mutates the subtask. */
export function placeSubtask(s: SubTask, tz: string): TaskPlacement {
  const durationIsFallback = !(s.durationMin && s.durationMin > 0);
  const durationMin = durationIsFallback ? DISPLAY_FALLBACK_MIN : s.durationMin!;
  const base = { subtaskId: s.id, durationMin, durationIsFallback, done: s.done };
  if (!s.startAt || s.startAt.length < 16) return { ...base, place: "drawer", interval: null, invalidTime: false };
  const c = checkLocal(s.startAt.slice(0, 10), s.startAt.slice(11, 16), tz);
  // Nonexistent times match the existing reminder behaviour (shift forward); flagged for the UI.
  // Gap time: shift forward by the gap length using the pre-transition offset (02:30 -> 03:30), same instant as wallToUtc.
  let start: number;
  if (c.status === "nonexistent") {
    const naive = (d: string, t: string) => Date.parse(d + "T00:00:00Z") + toMinutes(t) * MIN;
    const prev = toLocal(c.firstValidUtc - MIN, tz);
    start = c.firstValidUtc - MIN + (naive(s.startAt.slice(0, 10), s.startAt.slice(11, 16)) - naive(prev.date, prev.time));
  } else start = c.utc;
  return { ...base, place: "calendar", interval: { start, end: start + durationMin * MIN }, invalidTime: c.status === "nonexistent" };
}

export type BusyItem = Interval & { source: string };

/** Everything that occupies time: occurrences, protective reservations, travel, and calendar subtasks (including completed). */
export function busyItems(occs: Occurrence[], events: PlannerEvent[], tasks: TaskPlacement[]): BusyItem[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const out: BusyItem[] = [];
  for (const o of occs) {
    const t = occTime(o); if (t) out.push({ start: t.start, end: t.end, source: o.key });
    const e = byId.get(o.eventId); if (e) for (const b of travelBlocks(o, e)) out.push({ start: b.start, end: b.end, source: `${o.key}:travel-${b.side}` });
  }
  for (const t of tasks) if (t.interval) out.push({ ...t.interval, source: `task:${t.subtaskId}` });
  return out;
}

export const conflictsFor = (i: Interval, items: BusyItem[], selfSource?: string) => items.filter((b) => b.source !== selfSource && overlaps(i, b));

// ---------- Availability & suggestions ----------
export type AvailabilityRule = { weekday: number; startTime: string; endTime: string }; // endTime "24:00" allowed

export function availabilityWindows(rules: AvailabilityRule[], from: string, to: string, tz: string): Interval[] {
  const out: Interval[] = [];
  for (let d = from; d < to; d = addDays(d, 1))
    for (const r of rules) {
      if (r.weekday !== weekday(d) || toMinutes(r.endTime) <= toMinutes(r.startTime)) continue;
      const s = checkLocal(d, r.startTime, tz), e = r.endTime === "24:00" ? null : checkLocal(d, r.endTime, tz);
      const start = s.status === "nonexistent" ? s.firstValidUtc : s.utc;
      const end = e === null ? dueBoundaryUtc(d, tz) : e.status === "nonexistent" ? e.firstValidUtc : e.utc;
      out.push({ start, end });
    }
  return merge(out); // touching windows merge, so tasks may cross midnight
}

export function freeTime(windows: Interval[], busy: Interval[]): Interval[] {
  return windows.flatMap((w) => subtract(w, busy));
}

export type SuggestInput = { durationMin: number | null | undefined; dueDate?: string | null; now: number; from: string; days: number; tz: string; availability: AvailabilityRule[]; busy: Interval[]; max?: number };
export type Suggestion = Interval & { date: string; time: string };

/** Earliest free 15-minute-grid starts that fully fit. Requires a real saved duration. */
export function suggest(i: SuggestInput): Suggestion[] {
  if (!(i.durationMin && i.durationMin > 0)) return [];
  const to = addDays(i.from, i.days);
  const windows = availabilityWindows(i.availability, i.from, addDays(to, 1), i.tz);
  const limit = i.dueDate ? dueBoundaryUtc(i.dueDate, i.tz) : Infinity;
  const out: Suggestion[] = [];
  for (let d = i.from; d < to; d = addDays(d, 1))
    for (let m = 0; m < 1440; m += SUGGESTION_STEP_MIN) {
      const time = fromMinutes(m), c = checkLocal(d, time, i.tz);
      if (c.status !== "normal") continue; // skip DST gap and repeated hour
      const s = { start: c.utc, end: c.utc + i.durationMin * MIN };
      if (s.start < i.now || s.end > limit) continue;
      if (!windows.some((w) => w.start <= s.start && s.end <= w.end)) continue;
      if (i.busy.some((b) => overlaps(s, b))) continue;
      out.push({ ...s, date: d, time });
      if (out.length >= (i.max ?? 5)) return out;
    }
  return out;
}

// ---------- Categories ----------
export type Category = { id: string; name: string; color: string; builtIn?: boolean };
export const CATEGORY_COLORS = ["green", "blue", "amber", "rose", "violet", "teal", "orange", "slate"] as const;
export const BUILTIN_CATEGORIES: Category[] = [
  { id: "work", name: "עבודה", color: "blue", builtIn: true },
  { id: "studies", name: "לימודים", color: "violet", builtIn: true },
  { id: "commuting", name: "נסיעות", color: "amber", builtIn: true },
  { id: "personal", name: "אישי", color: "green", builtIn: true },
  { id: "rest", name: "מנוחה", color: "teal", builtIn: true },
];
export const NO_CATEGORY: Category = { id: "", name: "ללא קטגוריה", color: "slate" };
export function resolveCategory(id: string | null | undefined, custom: Category[]): Category {
  if (!id) return NO_CATEGORY;
  return BUILTIN_CATEGORIES.find((c) => c.id === id) ?? custom.find((c) => c.id === id) ?? NO_CATEGORY;
}
