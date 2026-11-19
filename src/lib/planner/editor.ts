// Planner event management: form validation and create/edit/delete operations on top of the existing stores.
// Works with GuestPlannerStore (guest) and PlannerSync (signed in) through the same small interface; never writes storage itself.
import type { PlannerData, RecordOf, TableName } from "./data";
import { BUILTIN_IDS, isActiveException, type BuiltinCategoryId, type PlannerEvent } from "./model";
import { checkLocal, fromMinutes, MIN, toMinutes, weekday } from "./time";

/** What the editor needs from a store. Both GuestPlannerStore and PlannerSync satisfy it. */
export type PlannerWriter = {
  get(): PlannerData;
  upsert<T extends TableName>(table: T, record: RecordOf<T>): { ok: boolean; reason?: string };
  remove(table: TableName, id: string): { ok: boolean; reason?: string };
  /** Guest store only: deletes a whole split chain in one write. */
  removeSeries?(eventId: string): { ok: boolean; reason?: string };
};
export type Result = { ok: true; id?: string } | { ok: false; message: string };

export type EventForm = {
  title: string; category: string; // "" = no category, "builtin:*" or a custom category id
  startDate: string; startTime: string; endDate: string; endTime: string;
  repeat: boolean; weekdays: number[]; until: string; // until "" = no end
};
export type FormErrors = Partial<Record<keyof EventForm | "form", string>>;

const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Real elapsed minutes between two local wall-clock times, or an error. Nonexistent (DST gap) times are refused. */
export function spanMinutes(sd: string, st: string, ed: string, et: string, tz: string): { min: number } | { error: keyof FormErrors; message: string } {
  if (!DATE.test(sd)) return { error: "startDate", message: "יש לבחור תאריך התחלה." };
  if (!TIME.test(st)) return { error: "startTime", message: "יש לבחור שעת התחלה." };
  if (!DATE.test(ed)) return { error: "endDate", message: "יש לבחור תאריך סיום." };
  if (!TIME.test(et)) return { error: "endTime", message: "יש לבחור שעת סיום." };
  const a = checkLocal(sd, st, tz), b = checkLocal(ed, et, tz);
  if (a.status === "nonexistent") return { error: "startTime", message: "שעת ההתחלה לא קיימת ביום הזה (מעבר לשעון קיץ)." };
  if (b.status === "nonexistent") return { error: "endTime", message: "שעת הסיום לא קיימת ביום הזה (מעבר לשעון קיץ)." };
  const min = Math.round((b.utc - a.utc) / MIN);
  if (min < 1) return { error: "endTime", message: "הסיום חייב להיות אחרי ההתחלה." };
  if (min > 1440) return { error: "endDate", message: "אירוע יכול להימשך עד 24 שעות." };
  return { min };
}

/** Local end (date, time) of a start plus real elapsed minutes. */
export function endOf(date: string, startMin: number, durationMin: number, tz: string): { date: string; time: string } {
  const c = checkLocal(date, fromMinutes(startMin), tz);
  const start = c.status === "nonexistent" ? c.firstValidUtc : c.utc;
  const t = start + durationMin * MIN;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(t).map((x) => [x.type, x.value]));
  return { date: `${p["year"]}-${p["month"]}-${p["day"]}`, time: `${p["hour"]}:${p["minute"]}` };
}

/** Form for an existing event (or a blank one for a new event on `date`). */
export function formFor(e: PlannerEvent | null, tz: string, date = "", time = "09:00"): EventForm {
  if (!e) {
    const end = date ? endOf(date, toMinutes(time), 60, tz) : { date: "", time: "" };
    return { title: "", category: "", startDate: date, startTime: time, endDate: end.date, endTime: end.time, repeat: false, weekdays: date ? [weekday(date)] : [], until: "" };
  }
  const end = endOf(e.date, e.startMin, e.durationMin, tz);
  return {
    title: e.title, category: e.categoryBuiltin ?? e.categoryId ?? "", startDate: e.date, startTime: fromMinutes(e.startMin),
    endDate: end.date, endTime: end.time, repeat: !!e.weekdays?.length, weekdays: [...(e.weekdays ?? [])], until: e.until ?? "",
  };
}

/** Same chain (the part it was split from and parts split from it), oldest first. */
export function seriesChain(data: PlannerData, eventId: string): PlannerEvent[] {
  const ids = new Set([eventId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const e of data.events) {
      const add = ids.has(e.id) ? e.splitFromEventId : e.splitFromEventId && ids.has(e.splitFromEventId) ? e.id : null;
      if (add && !ids.has(add) && data.events.some((x) => x.id === add)) { ids.add(add); grew = true; }
    }
  }
  return data.events.filter((e) => ids.has(e.id)).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Validates the form and builds the event. Editing keeps the id, travel, notes and split link.
 * For a part of a split series the start date (linked to the earlier part) and the end date (linked to a later part) are locked.
 */
export function buildEvent(f: EventForm, data: PlannerData, tz: string, id: string, base?: PlannerEvent): { event: PlannerEvent } | { errors: FormErrors } {
  const errors: FormErrors = {};
  const title = f.title.trim();
  if (!title) errors.title = "יש להזין כותרת.";
  else if (title.length > 200) errors.title = "הכותרת ארוכה מדי (עד 200 תווים).";
  const custom = f.category && !f.category.startsWith("builtin:");
  if (f.category && (custom ? !data.categories.some((c) => c.id === f.category) : !BUILTIN_IDS.includes(f.category))) errors.category = "הקטגוריה לא קיימת.";
  const span = spanMinutes(f.startDate, f.startTime, f.endDate, f.endTime, tz);
  if ("error" in span) errors[span.error] = span.message;
  if (f.repeat) {
    if (!f.weekdays.length) errors.weekdays = "יש לבחור לפחות יום אחד בשבוע.";
    if (f.until && !DATE.test(f.until)) errors.until = "תאריך הסיום של החזרה לא תקין.";
    else if (f.until && f.until < f.startDate) errors.until = "החזרה חייבת להסתיים אחרי תאריך ההתחלה.";
  }
  if (base) {
    const hasLater = data.events.some((e) => e.splitFromEventId === base.id);
    if (base.splitFromEventId && f.startDate !== base.date) errors.startDate = "לא ניתן לשנות את תאריך ההתחלה של חלק בסדרה שפוצלה.";
    if (hasLater && (f.until || null) !== (base.until ?? null)) errors.until = "לא ניתן לשנות את סיום החלק הזה, כי יש אחריו חלק נוסף בסדרה.";
    if ((base.splitFromEventId || hasLater) && f.repeat !== !!base.weekdays?.length) errors.repeat = "לא ניתן לבטל חזרה של סדרה שפוצלה.";
  }
  if (Object.keys(errors).length || "error" in span) return { errors };
  const event: PlannerEvent = {
    travelBeforeMin: 0, travelAfterMin: 0, notes: null, splitFromEventId: null, ...(base ?? {}),
    id, title, date: f.startDate, startMin: toMinutes(f.startTime), durationMin: span.min,
    categoryBuiltin: custom || !f.category ? null : (f.category as BuiltinCategoryId), categoryId: custom ? f.category : null,
    weekdays: f.repeat ? [...f.weekdays].sort() : null, until: f.repeat && f.until ? f.until : null,
  };
  return { event };
}

const failed = (r: { ok: boolean; reason?: string }, what: string): Result =>
  r.ok ? { ok: true } : { ok: false, message: r.reason === "conflict" ? `${what} לא נשמר: האירוע השתנה במכשיר אחר. יש לבחור איזו גרסה לשמור.` : `${what} לא נשמר.` };

export function saveEvent(w: PlannerWriter, f: EventForm, tz: string, id: string, existing?: PlannerEvent): Result | { ok: false; errors: FormErrors; message: string } {
  const b = buildEvent(f, w.get(), tz, id, existing);
  if ("errors" in b) return { ok: false, errors: b.errors, message: "יש לתקן את השדות המסומנים." };
  const r = failed(w.upsert("events", b.event), "האירוע");
  return r.ok ? { ok: true, id } : r;
}

/** Edit one occurrence of a recurring event: date, start time and duration only (an existing "change"/"skip" exception is reused). */
export function saveOccurrence(w: PlannerWriter, e: PlannerEvent, originalDate: string, f: Pick<EventForm, "startDate" | "startTime" | "endDate" | "endTime">, tz: string, newId: string): Result | { ok: false; errors: FormErrors; message: string } {
  const span = spanMinutes(f.startDate, f.startTime, f.endDate, f.endTime, tz);
  if ("error" in span) return { ok: false, errors: { [span.error]: span.message }, message: span.message };
  const startMin = toMinutes(f.startTime);
  const ch = { newDate: f.startDate !== originalDate ? f.startDate : null, newStartMin: startMin !== e.startMin ? startMin : null, newDurationMin: span.min !== e.durationMin ? span.min : null };
  if (ch.newDate == null && ch.newStartMin == null && ch.newDurationMin == null) return { ok: false, errors: {}, message: "לא שונה דבר במופע הזה." };
  const cur = w.get().exceptions.find((x) => x.eventId === e.id && x.originalDate === originalDate && isActiveException(x));
  const id = cur?.id ?? newId;
  return failed(w.upsert("exceptions", { id, eventId: e.id, originalDate, type: "change", ...ch, supersededByEventId: null, supersededAt: null }), "השינוי");
}

/** Cancel one occurrence with a "skip" exception (reusing an existing exception for that date). */
export function cancelOccurrence(w: PlannerWriter, e: PlannerEvent, originalDate: string, newId: string): Result {
  const cur = w.get().exceptions.find((x) => x.eventId === e.id && x.originalDate === originalDate && isActiveException(x));
  if (cur?.type === "skip") return { ok: true };
  return failed(w.upsert("exceptions", { id: cur?.id ?? newId, eventId: e.id, originalDate, type: "skip", newDate: null, newStartMin: null, newDurationMin: null, supersededByEventId: null, supersededAt: null }), "הביטול");
}

/** Delete a one-time event, or a whole recurring series including every split part. Never a single part on its own. */
export function deleteEvent(w: PlannerWriter, eventId: string): Result {
  const chain = seriesChain(w.get(), eventId);
  if (!chain.length) return { ok: false, message: "האירוע כבר לא קיים." };
  if (w.removeSeries) { const r = w.removeSeries(eventId); return r.ok ? { ok: true } : { ok: false, message: "המחיקה לא בוצעה." }; }
  // Signed in: the existing per-record soft delete, newest part first.
  for (const e of [...chain].reverse()) if (!w.remove("events", e.id).ok) return { ok: false, message: "המחיקה לא הושלמה: האירוע השתנה במכשיר אחר או נמחק כבר. רעננו ונסו שוב." };
  return { ok: true };
}
