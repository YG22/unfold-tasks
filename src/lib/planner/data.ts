// Planner records as stored in the database (snake_case rows) and as used by the calculations (model types).
// One mapping and one set of validation rules, shared by guest storage and cloud sync. Not used by the app yet.
import { BUILTIN_IDS, CATEGORY_COLORS, validateAvailability, validateEvent, type AvailabilityRule, type Category, type PlannerEvent, type PlannerException } from "./model";

export type TableName = "categories" | "events" | "exceptions" | "availability";
export const TABLES: TableName[] = ["categories", "events", "exceptions", "availability"];
/** Database table per section (the five planner data tables; planner_operations is never read here). */
export const DB_TABLE: Record<TableName | "settings", string> = {
  categories: "planner_categories", events: "planner_events", exceptions: "planner_exceptions",
  availability: "planner_availability", settings: "planner_settings",
};

export type PlannerExceptionRecord = PlannerException & { id: string };
export type PlannerAvailability = AvailabilityRule & { id: string };
export type PlannerSettings = { defaultView: "day" | "week"; suggestionDaysOff: number[]; timezone: string | null };
export type PlannerData = {
  categories: Category[]; events: PlannerEvent[]; exceptions: PlannerExceptionRecord[];
  availability: PlannerAvailability[]; settings: PlannerSettings;
};
export type RecordOf<T extends TableName> = PlannerData[T][number];

export const DEFAULT_SETTINGS: PlannerSettings = { defaultView: "week", suggestionDaysOff: [], timezone: null };
export const emptyData = (): PlannerData => ({ categories: [], events: [], exceptions: [], availability: [], settings: { ...DEFAULT_SETTINGS, suggestionDaysOff: [] } });

/** A database row: content columns plus server bookkeeping. */
export type Row = { id: string; version?: number; deleted_at?: string | null; [k: string]: unknown };
export type SettingsRow = { default_view: string; suggestion_days_off: number[]; timezone: string | null; version?: number };

/** Columns only a split may set; ordinary saves never send them (the server ignores them there too). */
export const SPLIT_ONLY = ["superseded_by_event_id", "superseded_at", "split_from_event_id"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);
const isDate = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const isInt = (n: unknown, lo: number, hi: number) => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;
const opt = <T>(v: T | undefined) => (v === undefined ? null : v);
const days = (a: unknown) => Array.isArray(a) && a.every((d) => isInt(d, 0, 6)) && new Set(a).size === a.length;

// ---------- Validation (same rules as the database checks) ----------
export function validRecord(table: TableName, r: unknown): boolean {
  if (!r || typeof r !== "object" || !isUuid((r as { id?: unknown }).id)) return false;
  if (table === "categories") {
    const c = r as Category;
    return typeof c.name === "string" && c.name.trim().length >= 1 && c.name.trim().length <= 40 && (CATEGORY_COLORS as readonly string[]).includes(c.color) && !BUILTIN_IDS.includes(c.id);
  }
  if (table === "events") {
    const e = r as PlannerEvent;
    if (typeof e.title !== "string" || e.title.trim().length < 1 || e.title.trim().length > 200 || !isDate(e.date)) return false;
    if (e.until != null && !isDate(e.until)) return false;
    if (e.categoryId != null && !isUuid(e.categoryId)) return false;
    if (e.splitFromEventId != null && (!isUuid(e.splitFromEventId) || e.splitFromEventId === e.id)) return false;
    if (e.notes != null && (typeof e.notes !== "string" || e.notes.length > 2000)) return false;
    if (e.weekdays != null && !days(e.weekdays)) return false;
    // A nonexistent one-time start depends on the timezone; that is checked when scheduling, not when storing.
    return validateEvent(e, "UTC").filter((x) => x !== "nonexistent-time").length === 0;
  }
  if (table === "exceptions") {
    const x = r as PlannerExceptionRecord;
    if (!isUuid(x.eventId) || !isDate(x.originalDate)) return false;
    if (x.newDate != null && !isDate(x.newDate)) return false;
    if (x.newStartMin != null && !isInt(x.newStartMin, 0, 1439)) return false;
    if (x.newDurationMin != null && !isInt(x.newDurationMin, 1, 1440)) return false;
    if (!x.supersededByEventId !== !x.supersededAt) return false;
    if (x.supersededByEventId != null && !isUuid(x.supersededByEventId)) return false;
    const changes = [x.newDate, x.newStartMin, x.newDurationMin].filter((v) => v != null).length;
    return x.type === "skip" ? changes === 0 : x.type === "change" ? changes > 0 : false;
  }
  const a = r as PlannerAvailability;
  return typeof a.endsNextDay === "boolean" && validateAvailability(a);
}

export function validSettings(s: unknown): s is PlannerSettings {
  if (!s || typeof s !== "object") return false;
  const x = s as PlannerSettings;
  return (x.defaultView === "day" || x.defaultView === "week") && days(x.suggestionDaysOff)
    && (x.timezone === null || (typeof x.timezone === "string" && x.timezone.length >= 1 && x.timezone.length <= 64));
}

// ---------- Mapping model <-> row ----------
export function toRow<T extends TableName>(table: T, r: RecordOf<T>): Row {
  if (table === "categories") { const c = r as Category; return { id: c.id, name: c.name, color: c.color }; }
  if (table === "events") {
    const e = r as PlannerEvent;
    return {
      id: e.id, title: e.title, category_builtin: opt(e.categoryBuiltin), category_id: opt(e.categoryId), date: e.date,
      start_min: e.startMin, duration_min: e.durationMin, weekdays: e.weekdays?.length ? e.weekdays : null, until: opt(e.until),
      travel_before_min: e.travelBeforeMin ?? 0, travel_after_min: e.travelAfterMin ?? 0, notes: opt(e.notes), split_from_event_id: opt(e.splitFromEventId),
    };
  }
  if (table === "exceptions") {
    const x = r as PlannerExceptionRecord;
    return {
      id: x.id, event_id: x.eventId, original_date: x.originalDate, type: x.type, new_date: opt(x.newDate),
      new_start_min: opt(x.newStartMin), new_duration_min: opt(x.newDurationMin),
      superseded_by_event_id: opt(x.supersededByEventId), superseded_at: opt(x.supersededAt),
    };
  }
  const a = r as PlannerAvailability;
  return { id: a.id, weekday: a.weekday, start_min: a.startMin, end_min: a.endMin, ends_next_day: a.endsNextDay };
}

export function fromRow<T extends TableName>(table: T, w: Row): RecordOf<T> {
  const g = (k: string) => w[k] as never;
  if (table === "categories") return { id: w.id, name: g("name"), color: g("color") } as RecordOf<T>;
  if (table === "events")
    return {
      id: w.id, title: g("title"), categoryBuiltin: g("category_builtin") ?? null, categoryId: g("category_id") ?? null, date: g("date"),
      startMin: g("start_min"), durationMin: g("duration_min"), weekdays: g("weekdays") ?? null, until: g("until") ?? null,
      travelBeforeMin: g("travel_before_min") ?? 0, travelAfterMin: g("travel_after_min") ?? 0, notes: g("notes") ?? null,
      splitFromEventId: g("split_from_event_id") ?? null,
    } as RecordOf<T>;
  if (table === "exceptions")
    return {
      id: w.id, eventId: g("event_id"), originalDate: g("original_date"), type: g("type"), newDate: g("new_date") ?? null,
      newStartMin: g("new_start_min") ?? null, newDurationMin: g("new_duration_min") ?? null,
      supersededByEventId: g("superseded_by_event_id") ?? null, supersededAt: g("superseded_at") ?? null,
    } as RecordOf<T>;
  return { id: w.id, weekday: g("weekday"), startMin: g("start_min"), endMin: g("end_min"), endsNextDay: g("ends_next_day") } as RecordOf<T>;
}

export const settingsToRow = (s: PlannerSettings): SettingsRow => ({ default_view: s.defaultView, suggestion_days_off: [...s.suggestionDaysOff], timezone: s.timezone });
export const settingsFromRow = (r: SettingsRow | null | undefined): PlannerSettings =>
  r ? { defaultView: r.default_view === "day" ? "day" : "week", suggestionDaysOff: [...(r.suggestion_days_off ?? [])], timezone: r.timezone ?? null } : { ...DEFAULT_SETTINGS, suggestionDaysOff: [] };

/** Content columns only (no bookkeeping), for comparing two rows. */
export function content(w: Row | SettingsRow): string {
  const { version: _v, deleted_at: _d, created_at: _c, updated_at: _u, user_id: _o, ...rest } = w as Record<string, unknown>;
  return JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]]));
}
