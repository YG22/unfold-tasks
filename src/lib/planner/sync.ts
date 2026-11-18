// Signed-in planner sync. Server rows + an ordered queue of pending actions, saved on the device before any network work.
// Every write goes through apply_planner_changes with base versions; the server decides. Not used by the app yet.
import { content, fromRow, settingsFromRow, settingsToRow, SPLIT_ONLY, TABLES, toRow, validRecord, validSettings, type PlannerData, type PlannerSettings, type RecordOf, type Row, type SettingsRow, type TableName } from "./data";
import type { KV } from "./guest";
import { addDays } from "./time";
import type { PlannerEvent } from "./model";

export type PlannerSyncStatus = "loading" | "saved" | "pending" | "syncing" | "offline" | "conflict" | "error";

export type ServerSnapshot = Record<TableName, Row[]> & { settings: SettingsRow | null };
export type Action =
  | { type: "upsert"; table: TableName; id: string; base_version: number; data: Record<string, unknown> }
  | { type: "delete" | "undelete"; table: TableName; id: string; base_version: number }
  | { type: "split"; event_id: string; new_id: string; from_date: string; base_version: number; data: Record<string, unknown> }
  | { type: "settings"; base_version: number; data: SettingsRow };
export type ActionResult = { id: string; status: string; version: number | null; current: (Row & SettingsRow) | null };

export class PlannerNetworkError extends Error {}
/** Server refused the whole batch (validation or database error); nothing in it was applied. */
export class PlannerServerError extends Error {}

export interface PlannerTransport {
  fetchAll(): Promise<ServerSnapshot>;
  apply(actions: Action[]): Promise<ActionResult[]>;
  /** Called on any change to the user's five planner data tables. Returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void;
}
export type Env = { online(): boolean; onOnline(cb: () => void): () => void; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; now(): string };

export type ConflictReason = "stale" | "conflict" | "missing" | "deleted";
/** Local actions the server refused because the record changed elsewhere. Both sides are kept until the user decides. */
export type Conflict = { key: string; reason: ConflictReason; mine: Action[]; server: Row | SettingsRow | null };
export type Rejected = { action: Action; message: string };

type Persisted = { v: 1; server: ServerSnapshot | null; queue: Action[]; conflicts: Conflict[]; rejected: Rejected[] };
export const cloudKey = (uid: string) => `planner-cloud-v1-${uid}`;

const OK = new Set(["created", "updated", "unchanged", "deleted_ok", "undeleted", "split"]);
const FAIL = new Set(["stale", "conflict", "missing", "deleted"]);
const BATCH = 50;
export const keyOf = (a: Action) => (a.type === "settings" ? "settings" : a.type === "split" ? `events:${a.event_id}` : `${a.table}:${a.id}`);
const keysOf = (a: Action) => (a.type === "split" ? [`events:${a.event_id}`, `events:${a.new_id}`] : [keyOf(a)]);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export class PlannerSync {
  private server: ServerSnapshot | null = null;
  private queue: Action[] = [];
  private conflicts: Conflict[] = [];
  private rejected: Rejected[] = [];
  private flushing = false;
  private inflight = new Set<Action>();
  private again = false;
  private loaded = false;
  private lastError = "";
  private disposed = false;
  private listeners = new Set<() => void>();
  private cleanups: Array<() => void> = [];
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private rtTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 1000;

  constructor(private uid: string, private kv: KV, private t: PlannerTransport, private env: Env) {
    try {
      const p = JSON.parse(kv.getItem(cloudKey(uid)) ?? "null") as Persisted | null;
      if (p?.v === 1) { this.server = p.server; this.queue = p.queue ?? []; this.conflicts = p.conflicts ?? []; this.rejected = p.rejected ?? []; }
    } catch { /* unreadable cache: start from the server; pending edits cannot be recovered from it */ }
  }

  // ---------- lifecycle ----------
  /** Loads from the server, sends pending edits, and listens for changes from other devices. One subscription per instance. */
  start() {
    if (this.cleanups.length || this.disposed) return;
    this.cleanups.push(this.t.subscribe(() => {
      this.env.clearTimeout(this.rtTimer);
      this.rtTimer = this.env.setTimeout(() => void this.refresh().then(() => this.flush()), 300);
    }));
    this.cleanups.push(this.env.onOnline(() => void this.refresh().then(() => this.flush())));
    void this.refresh().then(() => this.flush());
  }
  /** Stops listening and timers (sign-out, account switch, unmount). Pending edits stay saved for this user only. */
  dispose() {
    this.disposed = true;
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.env.clearTimeout(this.retryTimer); this.env.clearTimeout(this.rtTimer);
    this.listeners.clear();
  }
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  private emit() { if (!this.disposed) for (const f of this.listeners) f(); }
  private persist() {
    if (this.disposed) return;
    this.kv.setItem(cloudKey(this.uid), JSON.stringify({ v: 1, server: this.server, queue: this.queue, conflicts: this.conflicts, rejected: this.rejected } satisfies Persisted));
  }

  // ---------- reading ----------
  status(): PlannerSyncStatus {
    if (!this.loaded && !this.server) return this.env.online() ? "loading" : "offline";
    if (this.conflicts.length) return "conflict";
    if (this.rejected.length || this.lastError) return "error";
    if (this.flushing) return "syncing";
    if (!this.env.online()) return "offline";
    if (this.queue.length) return "pending";
    return this.loaded ? "saved" : "loading";
  }
  getConflicts(): Conflict[] { return this.conflicts; }
  getRejected(): Rejected[] { return this.rejected; }
  pendingCount() { return this.queue.length; }
  error() { return this.lastError; }

  /** Rows as the user should see them: server data with pending and conflicted local edits on top. Includes soft-deleted rows. */
  private rows(): { tables: Record<TableName, Map<string, Row>>; settings: SettingsRow | null } {
    const s = this.server;
    const tables = Object.fromEntries(TABLES.map((t) => [t, new Map((s?.[t] ?? []).map((r) => [r.id, { ...r }]))])) as Record<TableName, Map<string, Row>>;
    let settings = s?.settings ? { ...s.settings } : null;
    const all = [...this.conflicts.flatMap((c) => c.mine), ...this.queue];
    for (const a of all) {
      if (a.type === "settings") { settings = { ...(settings ?? {}), ...a.data } as SettingsRow; continue; }
      if (a.type === "split") {
        const ev = tables.events, old = ev.get(a.event_id);
        if (!old || old.deleted_at) continue;
        ev.set(a.event_id, { ...old, until: addDays(a.from_date, -1) });
        const { version: _v, ...base } = old;
        ev.set(a.new_id, { ...base, ...a.data, id: a.new_id, date: a.from_date, split_from_event_id: a.event_id, deleted_at: null });
        for (const [id, x] of tables.exceptions)
          if (x["event_id"] === a.event_id && (x["original_date"] as string) >= a.from_date && !x.deleted_at && !x["superseded_by_event_id"])
            tables.exceptions.set(id, { ...x, superseded_by_event_id: a.new_id, superseded_at: "pending" });
        continue;
      }
      const m = tables[a.table], cur = m.get(a.id);
      if (a.type === "upsert") m.set(a.id, { ...(cur ?? {}), ...a.data, id: a.id, deleted_at: cur?.deleted_at ?? null });
      else if (cur) m.set(a.id, { ...cur, deleted_at: a.type === "delete" ? "pending" : null });
    }
    return { tables, settings };
  }
  get(): PlannerData {
    const { tables, settings } = this.rows();
    const out = Object.fromEntries(TABLES.map((t) => [t, [...tables[t].values()].filter((r) => !r.deleted_at).map((r) => fromRow(t, r))])) as Omit<PlannerData, "settings">;
    return { ...out, settings: settingsFromRow(settings) };
  }

  // ---------- version bookkeeping ----------
  /** Version a new action for this key must be based on: the server's, advanced by every earlier unconfirmed action. */
  private baseFor(key: string): number {
    const [table, id] = key.split(":") as [TableName | "settings", string | undefined];
    let v = table === "settings" ? (this.server?.settings?.version ?? 0) : (this.server?.[table].find((r) => r.id === id)?.version ?? 0);
    for (const a of this.queue) {
      if (a.type === "split") { if (key === `events:${a.event_id}`) v = a.base_version + 1; else if (key === `events:${a.new_id}`) v = 1; continue; }
      if (keyOf(a) === key) v = a.base_version === 0 && (a.type === "upsert" || a.type === "settings") ? 1 : a.base_version + 1;
    }
    return v;
  }
  private blocked(keys: string[]) { return this.conflicts.some((c) => keys.includes(c.key)); }

  // ---------- writing ----------
  private enqueue(a: Action) {
    this.queue.push(a);
    this.persist(); this.emit();
    this.scheduleFlush(0);
  }
  /** Create or edit by stable id. Refused when invalid or while that record has an unresolved conflict. No-op edits are not sent. */
  upsert<T extends TableName>(table: T, record: RecordOf<T>): { ok: boolean; reason?: "invalid" | "conflict" } {
    if (!validRecord(table, record)) return { ok: false, reason: "invalid" };
    const key = `${table}:${record.id}`;
    if (this.blocked([key])) return { ok: false, reason: "conflict" };
    const data = toRow(table, record); delete (data as Record<string, unknown>)["id"];
    for (const k of SPLIT_ONLY) delete (data as Record<string, unknown>)[k];
    const cur = this.rows().tables[table].get(record.id);
    if (cur?.deleted_at) return { ok: false, reason: "invalid" }; // restore it with undelete first
    if (cur && Object.entries(data).every(([k, v]) => JSON.stringify(cur[k] ?? null) === JSON.stringify(v ?? null))) return { ok: true };
    // Merge into a not-yet-sent edit of the same record, so a retry of an applied batch compares final content (no false conflict).
    const last = [...this.queue].reverse().find((a) => keysOf(a).includes(key));
    if (last && last.type === "upsert" && !this.inflight.has(last)) {
      const merged: Action = { ...last, data: { ...last.data, ...data } };
      this.queue[this.queue.indexOf(last)] = merged;
      this.persist(); this.emit(); this.scheduleFlush(0);
      return { ok: true };
    }
    this.enqueue({ type: "upsert", table, id: record.id, base_version: this.baseFor(key), data });
    return { ok: true };
  }
  /** Soft delete (the server keeps the row). Related exceptions are left as they are. */
  remove(table: TableName, id: string): { ok: boolean } {
    const key = `${table}:${id}`, cur = this.rows().tables[table].get(id);
    if (!cur || cur.deleted_at || this.blocked([key])) return { ok: false };
    this.enqueue({ type: "delete", table, id, base_version: this.baseFor(key) }); return { ok: true };
  }
  undelete(table: TableName, id: string): { ok: boolean } {
    const key = `${table}:${id}`, cur = this.rows().tables[table].get(id);
    if (!cur || !cur.deleted_at || this.blocked([key])) return { ok: false };
    this.enqueue({ type: "undelete", table, id, base_version: this.baseFor(key) }); return { ok: true };
  }
  setSettings(s: PlannerSettings): { ok: boolean } {
    if (!validSettings(s) || this.blocked(["settings"])) return { ok: false };
    const cur = this.rows().settings, data = settingsToRow(s);
    if (cur && content(cur) === content(data)) return { ok: true };
    const last = [...this.queue].reverse().find((a) => a.type === "settings");
    if (last && !this.inflight.has(last)) { this.queue[this.queue.indexOf(last)] = { ...last, data } as Action; this.persist(); this.emit(); this.scheduleFlush(0); return { ok: true }; }
    this.enqueue({ type: "settings", base_version: this.baseFor("settings"), data }); return { ok: true };
  }
  /** "From this date on" for a recurring series. The server ends the old series, creates the new one and marks later exceptions superseded. */
  split(eventId: string, fromDate: string, newId: string, changes: Partial<PlannerEvent>): { ok: boolean } {
    const ev = this.rows().tables.events, old = ev.get(eventId);
    if (!old || old.deleted_at || ev.has(newId) || this.blocked([`events:${eventId}`, `events:${newId}`])) return { ok: false };
    const e = fromRow("events", old);
    if (fromDate <= e.date || (e.until && fromDate > e.until)) return { ok: false };
    const after = { ...e, ...changes, id: newId, date: fromDate, splitFromEventId: eventId };
    if (!validRecord("events", after)) return { ok: false };
    const data = toRow("events", after); for (const k of ["id", "date", ...SPLIT_ONLY]) delete (data as Record<string, unknown>)[k];
    this.enqueue({ type: "split", event_id: eventId, new_id: newId, from_date: fromDate, base_version: this.baseFor(`events:${eventId}`), data });
    return { ok: true };
  }

  // ---------- conflicts ----------
  /** "server": drop my edits. "mine": re-send my final version on top of the server's current version. */
  resolveConflict(key: string, choice: "mine" | "server") {
    const c = this.conflicts.find((x) => x.key === key); if (!c) return;
    this.conflicts = this.conflicts.filter((x) => x !== c);
    if (choice === "mine") {
      const before = this.queue.length;
      if (key === "settings") {
        const last = [...c.mine].reverse().find((a) => a.type === "settings");
        if (last && last.type === "settings") this.queue.push({ ...last, base_version: this.baseFor("settings") });
      } else for (const a of this.rebuild(c)) this.queue.push(a);
      if (this.queue.length === before) { /* nothing left to send */ }
    }
    this.persist(); this.emit(); this.scheduleFlush(0);
  }
  private rebuild(c: Conflict): Action[] {
    const [table, id] = c.key.split(":") as [TableName, string];
    const out: Action[] = [];
    const split = c.mine.find((a) => a.type === "split");
    if (split && split.type === "split") { out.push({ ...split, base_version: this.baseFor(c.key) }); return out; }
    // Desired end state from my actions alone.
    let wantDeleted: boolean | null = null; let data: Record<string, unknown> = {};
    for (const a of c.mine) {
      if (a.type === "upsert") { data = { ...data, ...a.data }; wantDeleted = false; }
      else if (a.type === "delete") wantDeleted = true;
      else if (a.type === "undelete") wantDeleted = false;
    }
    const srv = this.server?.[table].find((r) => r.id === id);
    let v = srv?.version ?? 0;
    if (wantDeleted) { if (srv && !srv.deleted_at) out.push({ type: "delete", table, id, base_version: v }); return out; }
    if (srv?.deleted_at) { out.push({ type: "undelete", table, id, base_version: v }); v++; }
    if (Object.keys(data).length) out.push({ type: "upsert", table, id, base_version: v, data });
    return out;
  }

  // ---------- network ----------
  private scheduleFlush(ms: number) {
    this.env.clearTimeout(this.retryTimer);
    this.retryTimer = this.env.setTimeout(() => void this.flush(), ms);
  }
  /** Re-reads the user's planner rows. Pending edits are never replaced; they stay on top until the server answers them. */
  async refresh() {
    if (this.disposed) return;
    try {
      const snap = await this.t.fetchAll();
      if (this.disposed) return;
      this.server = snap; this.loaded = true;
      if (this.lastError && !this.rejected.length) this.lastError = "";
      this.persist(); this.emit();
    } catch (e) {
      if (!(e instanceof PlannerNetworkError)) this.lastError = String((e as Error).message ?? e);
      this.emit();
    }
  }

  async flush(): Promise<void> {
    if (this.disposed) return;
    if (this.flushing) { this.again = true; return; }
    if (!this.queue.length || !this.env.online()) { this.emit(); return; }
    this.flushing = true; this.emit();
    let progressed = false, networkDown = false;
    try {
      const batch = this.queue.slice(0, BATCH);
      for (const a of batch) this.inflight.add(a);
      let results: Array<ActionResult | Error>;
      try {
        results = await this.t.apply(batch);
      } catch (e) {
        if (e instanceof PlannerNetworkError) throw e;
        // One bad action rolls back the whole batch: send them one by one to find it.
        results = [];
        for (const a of batch) {
          try { results.push((await this.t.apply([a]))[0]!); }
          catch (x) { if (x instanceof PlannerNetworkError) throw x; results.push(x as Error); }
        }
      }
      if (this.disposed) return;
      batch.forEach((a, i) => {
        const r = results[i];
        if (!r) return;
        if (!this.queue.includes(a)) return; // already moved to a conflict with an earlier action of this record
        if (r instanceof Error) {
          this.queue = this.queue.filter((x) => x !== a);
          this.rejected.push({ action: a, message: r.message }); return;
        }
        if (OK.has(r.status)) {
          this.queue = this.queue.filter((x) => x !== a); progressed = true;
          this.store(a, r); return;
        }
        if (FAIL.has(r.status)) {
          // This action and every later one for the same record were based on a version the server no longer has.
          const keys = keysOf(a);
          const mine = this.queue.filter((x) => x === a || (this.queue.indexOf(x) > this.queue.indexOf(a) && keysOf(x).some((k) => keys.includes(k))));
          this.queue = this.queue.filter((x) => !mine.includes(x));
          const existing = this.conflicts.find((c) => c.key === keyOf(a));
          if (existing) existing.mine.push(...mine);
          else this.conflicts.push({ key: keyOf(a), reason: r.status as ConflictReason, mine, server: r.current ? clone(r.current) : null });
          this.store(a, r);
          return;
        }
        this.queue = this.queue.filter((x) => x !== a);
        this.rejected.push({ action: a, message: `unexpected status ${r.status}` });
      });
      this.retryDelay = 1000;
      this.lastError = "";
    } catch (e) {
      if (e instanceof PlannerNetworkError) networkDown = true;
      else this.lastError = String((e as Error).message ?? e);
    } finally {
      this.flushing = false;
      this.inflight.clear();
    }
    if (this.disposed) return;
    this.persist();
    if (progressed) await this.refresh(); // picks up server-side effects (split, superseded exceptions)
    this.emit();
    if (networkDown) { this.scheduleFlush(this.retryDelay); this.retryDelay = Math.min(this.retryDelay * 2, 60_000); return; }
    if (this.again || (progressed && this.queue.length)) { this.again = false; void this.flush(); }
  }

  /** Keeps the server's answer as the new known server state for that record. */
  private store(a: Action, r: ActionResult) {
    if (!this.server || !r.current) return;
    if (a.type === "settings") { this.server.settings = clone(r.current); return; }
    const table: TableName = a.type === "split" ? "events" : a.table;
    const row = clone(r.current) as Row, list = this.server[table];
    const i = list.findIndex((x) => x.id === row.id);
    if (i < 0) list.push(row); else list[i] = row;
  }
}

/** Browser defaults for Env. */
export const browserEnv = (): Env => ({
  online: () => (typeof navigator === "undefined" ? true : navigator.onLine),
  onOnline: (cb) => { window.addEventListener("online", cb); return () => window.removeEventListener("online", cb); },
  setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
  now: () => new Date().toISOString(),
});
