// Guest (signed-out) planner storage: one versioned localStorage key, never sent to the cloud.
// Separate from task data; loading never writes. Not used by the app yet.
import { emptyData, TABLES, validRecord, validSettings, type PlannerData, type PlannerSettings, type RecordOf, type TableName } from "./data";
import { splitSeries, type PlannerEvent } from "./model";

export const GUEST_KEY = "planner-guest-v1";
export const GUEST_CORRUPT_KEY = "planner-guest-v1-unreadable";
export type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

/** Soft-deleted guest records: kept with their id, links and a deletion time, never shown, migrated or backed up. */
export type GuestDeleted = Record<TableName, (RecordOf<TableName> & { deletedAt: string })[]>;
export const emptyDeleted = (): GuestDeleted => ({ categories: [], events: [], exceptions: [], availability: [] });
export type GuestLoad = { data: PlannerData; deleted: GuestDeleted; dropped: number; unreadable: boolean };

/** Serialises a guest document; the "deleted" section is optional so older documents stay valid. */
export const guestDoc = (data: PlannerData, deleted: GuestDeleted) => JSON.stringify({ v: 1, ...data, deleted });

/** Reads guest data. Invalid records are skipped (counted); unreadable data is copied aside once and never overwritten silently. */
export function loadGuest(kv: KV): GuestLoad {
  const raw = kv.getItem(GUEST_KEY);
  if (raw == null) return { data: emptyData(), deleted: emptyDeleted(), dropped: 0, unreadable: false };
  let doc: unknown;
  try { doc = JSON.parse(raw); } catch { doc = null; }
  if (!doc || typeof doc !== "object" || (doc as { v?: unknown }).v !== 1) {
    if (kv.getItem(GUEST_CORRUPT_KEY) == null) kv.setItem(GUEST_CORRUPT_KEY, raw);
    return { data: emptyData(), deleted: emptyDeleted(), dropped: 0, unreadable: true };
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
  // Deletion markers. A record that is active again (e.g. restored from a backup) wins over its old marker.
  const deleted = emptyDeleted();
  const del = d["deleted"] && typeof d["deleted"] === "object" ? (d["deleted"] as Record<string, unknown>) : {};
  for (const t of TABLES) {
    const active = new Set((data[t] as { id: string }[]).map((r) => r.id)); const seen = new Set<string>();
    for (const r of Array.isArray(del[t]) ? (del[t] as unknown[]) : []) {
      const x = r as { id?: string; deletedAt?: unknown };
      if (validRecord(t, r) && typeof x.deletedAt === "string" && !active.has(x.id!) && !seen.has(x.id!)) { seen.add(x.id!); deleted[t].push(r as never); }
    }
  }
  return { data, deleted, dropped, unreadable: false };
}

export class GuestPlannerStore {
  private data: PlannerData;
  private deleted: GuestDeleted;
  readonly loadInfo: { dropped: number; unreadable: boolean };
  private listeners = new Set<() => void>();
  constructor(private kv: KV) {
    const l = loadGuest(kv);
    this.data = l.data; this.deleted = l.deleted; this.loadInfo = { dropped: l.dropped, unreadable: l.unreadable };
  }
  get(): PlannerData { return this.data; }
  /** Soft-deleted records (for history and recovery; never part of the active planner). */
  getDeleted(): GuestDeleted { return this.deleted; }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  private commit(next: PlannerData, deleted = this.deleted) {
    this.kv.setItem(GUEST_KEY, guestDoc(next, deleted));
    this.data = next; this.deleted = deleted;
    for (const f of this.listeners) f();
  }

  /** Create or replace a record by its stable id. Invalid records are refused. */
  upsert<T extends TableName>(table: T, record: RecordOf<T>): { ok: boolean } {
    if (!validRecord(table, record)) return { ok: false };
    // Like the cloud: a deleted record is not silently brought back by a save.
    if (this.deleted[table].some((r) => r.id === record.id)) return { ok: false };
    const list = (this.data[table] as RecordOf<T>[]).filter((r) => r.id !== record.id);
    const i = (this.data[table] as RecordOf<T>[]).findIndex((r) => r.id === record.id);
    list.splice(i < 0 ? list.length : i, 0, record);
    this.commit({ ...this.data, [table]: list });
    return { ok: true };
  }
  /**
   * Soft delete: the record moves to the deletion markers with its id and links intact. Repeating it is a no-op.
   * Refused while active records still point to it (a category in use, a series with a later split part), so the
   * active planner never has broken links. Deleting an event also marks its exceptions deleted.
   */
  remove(table: TableName, id: string, now = new Date().toISOString()): { ok: boolean; reason?: "in-use" | "missing"; repeated?: boolean } {
    if (this.deleted[table].some((r) => r.id === id)) return { ok: true, repeated: true };
    const rec = (this.data[table] as { id: string }[]).find((r) => r.id === id);
    if (!rec) return { ok: false, reason: "missing" };
    if (table === "categories" && this.data.events.some((e) => e.categoryId === id)) return { ok: false, reason: "in-use" };
    if (table === "events" && this.data.events.some((e) => e.splitFromEventId === id)) return { ok: false, reason: "in-use" };
    return this.softDelete({ [table]: [id] } as Partial<Record<TableName, string[]>>, now);
  }
  /** Deletes a whole series, including every part it was split into, and their exceptions, in one write. */
  removeSeries(eventId: string, now = new Date().toISOString()): { ok: boolean; reason?: "missing"; repeated?: boolean } {
    if (this.deleted.events.some((r) => r.id === eventId)) return { ok: true, repeated: true };
    if (!this.data.events.some((e) => e.id === eventId)) return { ok: false, reason: "missing" };
    const ids = new Set([eventId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const e of this.data.events) {
        // Walk both ways: to the part it was split from, and to parts split from it.
        const add = ids.has(e.id) ? e.splitFromEventId : e.splitFromEventId && ids.has(e.splitFromEventId) ? e.id : null;
        if (add && !ids.has(add) && this.data.events.some((x) => x.id === add)) { ids.add(add); grew = true; }
      }
    }
    return this.softDelete({ events: [...ids] }, now);
  }
  private softDelete(ids: Partial<Record<TableName, string[]>>, deletedAt: string): { ok: boolean } {
    const evIds = new Set(ids.events ?? []);
    const pick: Record<TableName, Set<string>> = {
      categories: new Set(ids.categories ?? []), events: evIds, availability: new Set(ids.availability ?? []),
      exceptions: new Set([...(ids.exceptions ?? []), ...this.data.exceptions.filter((x) => evIds.has(x.eventId)).map((x) => x.id)]),
    };
    const next = { ...this.data }; const deleted = { ...this.deleted };
    for (const t of TABLES) {
      if (!pick[t].size) continue;
      const list = this.data[t] as RecordOf<TableName>[];
      (next[t] as unknown[]) = list.filter((r) => !pick[t].has(r.id));
      deleted[t] = [...this.deleted[t], ...list.filter((r) => pick[t].has(r.id)).map((r) => ({ ...r, deletedAt }))];
    }
    this.commit(next, deleted);
    return { ok: true };
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
