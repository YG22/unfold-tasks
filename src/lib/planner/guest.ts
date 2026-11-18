// Guest (signed-out) planner storage: one versioned localStorage key, never sent to the cloud.
// Separate from task data; loading never writes. Not used by the app yet.
import { emptyData, TABLES, validRecord, validSettings, type PlannerData, type PlannerSettings, type RecordOf, type TableName } from "./data";
import { splitSeries, type PlannerEvent } from "./model";

export const GUEST_KEY = "planner-guest-v1";
export const GUEST_CORRUPT_KEY = "planner-guest-v1-unreadable";
export type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

export type GuestLoad = { data: PlannerData; dropped: number; unreadable: boolean };

/** Reads guest data. Invalid records are skipped (counted); unreadable data is copied aside once and never overwritten silently. */
export function loadGuest(kv: KV): GuestLoad {
  const raw = kv.getItem(GUEST_KEY);
  if (raw == null) return { data: emptyData(), dropped: 0, unreadable: false };
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { doc = null; }
  if (!doc || typeof doc !== "object" || (doc as { v?: unknown }).v !== 1) {
    if (kv.getItem(GUEST_CORRUPT_KEY) == null) kv.setItem(GUEST_CORRUPT_KEY, raw);
    return { data: emptyData(), dropped: 0, unreadable: true };
  }
  const d = doc as Record<string, unknown>;
  const data = emptyData(); let dropped = 0;
  for (const t of TABLES) {
    const list = Array.isArray(d[t]) ? (d[t] as unknown[]) : [];
    const seen = new Set<string>();
    for (const r of list) {
      if (validRecord(t, r) && !seen.has((r as { id: string }).id)) { seen.add((r as { id: string }).id); (data[t] as unknown[]).push(r); }
      else dropped++;
    }
  }
  if (d["settings"] !== undefined) { if (validSettings(d["settings"])) data.settings = d["settings"]; else dropped++; }
  return { data, dropped, unreadable: false };
}

export class GuestPlannerStore {
  private data: PlannerData;
  readonly loadInfo: { dropped: number; unreadable: boolean };
  private listeners = new Set<() => void>();
  constructor(private kv: KV) {
    const l = loadGuest(kv);
    this.data = l.data; this.loadInfo = { dropped: l.dropped, unreadable: l.unreadable };
  }
  get(): PlannerData { return this.data; }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  private commit(next: PlannerData) {
    this.kv.setItem(GUEST_KEY, JSON.stringify({ v: 1, ...next }));
    this.data = next;
    for (const f of this.listeners) f();
  }

  /** Create or replace a record by its stable id. Invalid records are refused. */
  upsert<T extends TableName>(table: T, record: RecordOf<T>): { ok: boolean } {
    if (!validRecord(table, record)) return { ok: false };
    const list = (this.data[table] as RecordOf<T>[]).filter((r) => r.id !== record.id);
    const i = (this.data[table] as RecordOf<T>[]).findIndex((r) => r.id === record.id);
    list.splice(i < 0 ? list.length : i, 0, record);
    this.commit({ ...this.data, [table]: list });
    return { ok: true };
  }
  remove(table: TableName, id: string) {
    this.commit({ ...this.data, [table]: (this.data[table] as { id: string }[]).filter((r) => r.id !== id) });
  }
  setSettings(s: PlannerSettings): { ok: boolean } {
    if (!validSettings(s)) return { ok: false };
    this.commit({ ...this.data, settings: s }); return { ok: true };
  }
  /** "From this date on": ends the series, starts a linked new one; later exceptions are kept and marked superseded. */
  split(eventId: string, fromDate: string, newId: string, changes: Partial<PlannerEvent>, now = new Date().toISOString()): { ok: boolean } {
    const e = this.data.events.find((x) => x.id === eventId);
    if (!e || fromDate <= e.date || (e.until && fromDate > e.until) || this.data.events.some((x) => x.id === newId)) return { ok: false };
    const r = splitSeries(e, this.data.exceptions, fromDate, newId, changes, now);
    if (!validRecord("events", r.after)) return { ok: false };
    this.commit({ ...this.data, events: [...this.data.events.map((x) => (x.id === eventId ? r.before : x)), r.after], exceptions: r.exceptions as PlannerData["exceptions"] });
    return { ok: true };
  }
}
