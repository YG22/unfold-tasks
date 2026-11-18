// Planner part of backup file version 2: export, validation, and restore (guest localStorage or cloud restore actions).
// Omitted sections mean "leave unchanged"; an included empty array means "restore that section as empty".
// Never contains pending sync queues, operation logs or tokens.
import { emptyData, fromRow, settingsFromRow, settingsToRow, TABLES, toRow, validRecord, validSettings, type PlannerData, type PlannerSettings, type RecordOf, type TableName } from "./data";
import { GUEST_KEY, loadGuest, type KV } from "./guest";
import { PlannerNetworkError, type ServerSnapshot } from "./sync";

export type Section = TableName | "settings";
export const SECTIONS: Section[] = [...TABLES, "settings"];
export type PlannerSections = Partial<{ [K in TableName]: RecordOf<K>[] } & { settings: PlannerSettings }>;
export type SectionState = Record<Section, "included" | "omitted">;
export type Counts = Record<TableName, { add: number; replace: number; same: number; delete: number }>;

/** Everything in the planner, as stored in a backup file. */
export function plannerToBackup(d: PlannerData): PlannerSections {
  const out = structuredClone({ categories: d.categories, events: d.events, exceptions: d.exceptions, availability: d.availability, settings: d.settings }) as PlannerSections;
  for (const t of TABLES) (out[t] as unknown[]) = (out[t] as RecordOf<typeof t>[]).map((r) => fromRow(t, toRow(t, r)));
  return out;
}

/** Live cloud records only (soft-deleted ones are not part of the planner). */
export function snapshotToData(s: ServerSnapshot): PlannerData {
  const d = emptyData();
  for (const t of TABLES) (d[t] as unknown[]) = s[t].filter((r) => !r.deleted_at).map((r) => fromRow(t, r));
  d.settings = settingsFromRow(s.settings);
  return d;
}

export type ParsePlanner = { ok: true; sections: PlannerSections } | { ok: false; error: string };

/** Validates the "planner" object of a version 2 backup. Any invalid record rejects the whole section set. */
export function parsePlannerSections(raw: unknown): ParsePlanner {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "נתוני היומן בגיבוי פגומים" };
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!(SECTIONS as string[]).includes(k)) return { ok: false, error: "נתוני היומן בגיבוי פגומים" };
  const out: PlannerSections = {};
  for (const t of TABLES) {
    if (!(t in r)) continue;
    const list = r[t];
    if (!Array.isArray(list)) return { ok: false, error: "נתוני היומן בגיבוי פגומים" };
    const seen = new Set<string>();
    for (const x of list) {
      if (!validRecord(t, x) || seen.has((x as { id: string }).id)) return { ok: false, error: "אחת מרשומות היומן בגיבוי פגומה" };
      seen.add((x as { id: string }).id);
    }
    (out[t] as unknown[]) = list.map((x) => fromRow(t, toRow(t, x as never)));
  }
  if ("settings" in r) {
    if (!validSettings(r["settings"])) return { ok: false, error: "הגדרות היומן בגיבוי פגומות" };
    out.settings = settingsFromRow(settingsToRow(r["settings"]));
  }
  return { ok: true, sections: out };
}

export const sectionState = (s: PlannerSections): SectionState =>
  Object.fromEntries(SECTIONS.map((k) => [k, k in s ? "included" : "omitted"])) as SectionState;
export const hasSections = (s: PlannerSections | null | undefined) => !!s && SECTIONS.some((k) => k in s);

/** Result of a restore: included sections replace, omitted sections stay as they are. */
export function merged(cur: PlannerData, s: PlannerSections): PlannerData {
  const d = structuredClone(cur);
  for (const t of TABLES) if (s[t]) (d[t] as unknown[]) = structuredClone(s[t]!);
  if (s.settings) d.settings = structuredClone(s.settings);
  return d;
}

/** Links that would be broken after the restore (missing category/series, broken or circular split chains). */
export function relationErrors(d: PlannerData): string[] {
  const errs: string[] = [];
  const cats = new Set(d.categories.map((c) => c.id));
  const evs = new Map(d.events.map((e) => [e.id, e]));
  for (const e of d.events) {
    if (e.categoryId && !cats.has(e.categoryId)) errs.push(`event ${e.id}: missing category`);
    if (e.splitFromEventId) {
      const p = evs.get(e.splitFromEventId);
      if (!p) errs.push(`event ${e.id}: missing split parent`);
      else if (!p.until || e.date <= p.until) errs.push(`event ${e.id}: invalid split`);
    }
    const seen = new Set<string>(); let c: typeof e | undefined = e;
    while (c?.splitFromEventId) { if (seen.has(c.id)) { errs.push(`event ${e.id}: circular split`); break; } seen.add(c.id); c = evs.get(c.splitFromEventId); }
  }
  const active = new Set<string>();
  for (const x of d.exceptions) {
    if (!evs.has(x.eventId)) errs.push(`exception ${x.id}: missing event`);
    if (x.supersededByEventId) {
      const n = evs.get(x.supersededByEventId);
      if (!n || n.splitFromEventId !== x.eventId || x.originalDate < n.date) errs.push(`exception ${x.id}: invalid superseded marker`);
    } else {
      const k = `${x.eventId}|${x.originalDate}`;
      if (active.has(k)) errs.push(`exception ${x.id}: duplicate active exception`);
      active.add(k);
    }
  }
  return errs;
}

const same = (t: TableName, a: RecordOf<TableName>, b: RecordOf<TableName>) => {
  const n = (r: RecordOf<TableName>) => { const w = toRow(t, r as never); if (typeof w["superseded_at"] === "string") w["superseded_at"] = new Date(w["superseded_at"]).toISOString(); return JSON.stringify(Object.keys(w).sort().map((k) => [k, w[k] ?? null])); };
  return n(a) === n(b);
};
function countChanges(cur: PlannerData, s: PlannerSections): Counts {
  const out = {} as Counts;
  for (const t of TABLES) {
    const c = { add: 0, replace: 0, same: 0, delete: 0 };
    const next = s[t];
    if (next) {
      const old = new Map((cur[t] as RecordOf<TableName>[]).map((r) => [r.id, r]));
      for (const r of next) { const o = old.get(r.id); if (!o) c.add++; else if (same(t, o, r)) c.same++; else c.replace++; old.delete(r.id); }
      c.delete = old.size;
    }
    out[t] = c;
  }
  return out;
}

// ---------- Guest restore (one localStorage write: all or nothing) ----------
export type GuestRestorePreview = {
  mode: "guest"; sections: SectionState; counts: Counts; settingsChanged: boolean; errors: string[];
  data: PlannerSections; basis: string | null;
};
export type RestoreResult =
  | { ok: true; repeated: boolean }
  | { ok: false; reason: "changed" | "invalid" | "storage" | "network" | "server" | "wrong-account"; message?: string; changed?: unknown[] };

export function previewGuestRestore(kv: KV, s: PlannerSections): GuestRestorePreview {
  const l = loadGuest(kv);
  const errors: string[] = [];
  if (l.unreadable) errors.push("guest-unreadable");
  if (l.dropped > 0) errors.push("guest-has-invalid-records");
  errors.push(...relationErrors(merged(l.data, s)));
  return {
    mode: "guest", sections: sectionState(s), counts: countChanges(l.data, s),
    settingsChanged: !!s.settings && JSON.stringify(s.settings) !== JSON.stringify(l.data.settings),
    errors, data: structuredClone(s), basis: kv.getItem(GUEST_KEY),
  };
}

const applied = new WeakMap<GuestRestorePreview, string>();
/** Applies a confirmed guest preview. Refuses if guest data changed after the preview; repeating a done restore is a no-op. */
export function applyGuestRestore(kv: KV, p: GuestRestorePreview, confirmed: boolean): RestoreResult {
  if (!confirmed) return { ok: false, reason: "invalid", message: "not confirmed" };
  if (p.errors.length) return { ok: false, reason: "invalid", message: p.errors.join("; ") };
  const now = kv.getItem(GUEST_KEY);
  if (applied.has(p) && applied.get(p) === now) return { ok: true, repeated: true };
  if (now !== p.basis) return { ok: false, reason: "changed" };
  const next = merged(loadGuest(kv).data, p.data);
  const text = JSON.stringify({ v: 1, ...next });
  try { kv.setItem(GUEST_KEY, text); } catch (e) {
    // setItem is all-or-nothing; make sure the previous content is still there.
    if (kv.getItem(GUEST_KEY) !== now && now != null) try { kv.setItem(GUEST_KEY, now); } catch { /* keep going */ }
    return { ok: false, reason: "storage", message: String(e) };
  }
  applied.set(p, text);
  return { ok: true, repeated: false };
}

// ---------- Cloud restore (apply_planner_changes restore_preview / restore, one transaction on the server) ----------
export type RestoreTransport = { fetchAll(): Promise<ServerSnapshot>; restore(p: Record<string, unknown>): Promise<unknown> };
export type CloudRestorePreview = {
  mode: "cloud"; uid: string; opId: string; sections: SectionState; counts: Counts; settingsChanged: boolean; errors: string[];
  payload: Record<string, unknown>; expected: Record<string, unknown>;
};

export function toPayload(s: PlannerSections): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const t of TABLES) if (s[t]) p[t] = (s[t] as RecordOf<TableName>[]).map((r) => toRow(t, r as never));
  if (s.settings) p["settings"] = settingsToRow(s.settings);
  return p;
}

type ServerPreview = { status: string; plan: Record<string, unknown> };
export async function previewCloudRestore(t: RestoreTransport, uid: string, s: PlannerSections, newId = () => crypto.randomUUID()): Promise<CloudRestorePreview> {
  const payload = toPayload(s);
  const [snap, res] = await Promise.all([t.fetchAll(), t.restore({ type: "restore_preview", data: payload }) as Promise<ServerPreview>]);
  const cur = snapshotToData(snap);
  const counts = {} as Counts; const expected: Record<string, unknown> = {};
  for (const tb of TABLES) {
    const c = { add: 0, replace: 0, same: 0, delete: 0 };
    const items = (res.plan?.[tb] as { id: string; version: number; action: keyof typeof c }[] | undefined) ?? [];
    if (s[tb]) expected[tb] = Object.fromEntries(items.map((i) => [i.id, i.version]));
    for (const i of items) c[i.action]++;
    counts[tb] = c;
  }
  if (s.settings) expected["settings"] = (res.plan?.["settings_version"] as number | undefined) ?? 0;
  return {
    mode: "cloud", uid, opId: newId(), sections: sectionState(s), counts,
    settingsChanged: !!s.settings && JSON.stringify(s.settings) !== JSON.stringify(cur.settings),
    errors: relationErrors(merged(cur, s)), payload, expected,
  };
}

/** Sends the confirmed restore with the preview's versions and operation id. Safe to repeat: the server answers the stored result. */
export async function applyCloudRestore(t: RestoreTransport, uid: string, p: CloudRestorePreview, confirmed: boolean): Promise<RestoreResult> {
  if (!confirmed) return { ok: false, reason: "invalid", message: "not confirmed" };
  if (p.uid !== uid) return { ok: false, reason: "wrong-account" };
  if (p.errors.length) return { ok: false, reason: "invalid", message: p.errors.join("; ") };
  let r: { status?: string; repeated?: boolean; changed?: unknown[] };
  try { r = (await t.restore({ type: "restore", data: p.payload, expected: p.expected, op_id: p.opId, confirmed: true })) as typeof r; }
  catch (e) { return { ok: false, reason: e instanceof PlannerNetworkError ? "network" : "server", message: String((e as Error)?.message ?? e) }; }
  if (r?.status === "conflict") return { ok: false, reason: "changed", changed: r.changed ?? [] };
  if (r?.status === "applied") return { ok: true, repeated: !!r.repeated };
  return { ok: false, reason: "server", message: "unexpected answer" };
}
