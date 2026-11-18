// Guest -> account planner migration. Explicit, preview-first, never automatic. Not used by the app yet.
// Writes only through apply_planner_changes (via PlannerTransport) with base versions; never touches the user's
// pending cloud edits (planner-cloud-v1-<uid>) and never deletes guest data.
import { content, settingsToRow, TABLES, toRow, validRecord, validSettings, type PlannerData, type Row, type TableName } from "./data";
import { loadGuest, type KV } from "./guest";
import { cloudKey, PlannerNetworkError, type Action, type ActionResult, type PlannerTransport, type ServerSnapshot } from "./sync";

export const migrationKey = (uid: string) => `planner-migration-v1-${uid}`;
/** Written after a verified migration; records which account received this device's guest data. Guest data itself stays. */
export const GUEST_MIGRATED_KEY = "planner-guest-v1-migrated";

export type ItemStatus = "add" | "add-remapped" | "already-present";
export type PlanItem = { table: TableName; guestId: string; cloudId: string; status: ItemStatus; reason?: "id-in-cloud" | "id-in-pending-edit" | "other-account" };
export type InvalidItem = { table: TableName | "settings"; id: string | null; reason: "invalid" | "missing-reference" | "invalid-split" | "circular-split" };
export type Blocker =
  | { kind: "invalid-records"; count: number }
  | { kind: "deleted-in-cloud"; table: TableName; id: string }
  | { kind: "settings-differ" }
  | { kind: "split-history-unsupported"; count: number }
  | { kind: "guest-unreadable" };
export type Resolutions = {
  /** Skip the listed invalid guest records (they stay in guest storage). */
  skipInvalid?: boolean;
  /** For guest records identical to a record deleted in the cloud: "skip" keeps it deleted, "copy" adds it under a new id. */
  deletedInCloud?: Record<string, "skip" | "copy">;
  /** When both sides have different settings. */
  settings?: "keep-cloud" | "use-guest";
};
export type MigrationPreview = {
  uid: string; token: string; cloudFingerprint: string; guestFingerprint: string;
  guestCounts: Record<TableName, number>; cloudCounts: Record<TableName, number>;
  items: PlanItem[]; invalid: InvalidItem[]; remapped: { table: TableName; from: string; to: string }[];
  /** References changed because the record they point to got a new id. */
  references: { table: TableName; id: string; field: string; from: string; to: string }[];
  settings: "none" | "add" | "same" | "differ";
  blockers: Blocker[]; unresolved: Blocker[]; canMigrate: boolean;
  expected: { add: number; alreadyPresent: number; skipped: number; settings: "add" | "update" | "keep" };
  actions: MigAction[];
};
/** Create-only save that keeps split links (events and exceptions); everything else uses the ordinary create. */
export type MigAction = Action | { type: "migrate_insert"; table: "events" | "exceptions"; id: string; base_version: 0; data: Record<string, unknown> };

// ---------- helpers ----------
const h32 = (s: string, seed: number) => {
  let h = seed ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 0x85ebca6b); h ^= h >>> 13; }
  h = Math.imul(h ^ (h >>> 16), 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0;
};
const hash = (s: string) => [1, 2, 3, 4].map((k) => h32(s, k).toString(16).padStart(8, "0")).join("");
/** Deterministic new id for a guest record in one account, so retries reuse the same id (no duplicates). */
export function derivedId(uid: string, guestId: string): string {
  const x = hash(`${uid}|${guestId}`).split("");
  x[12] = "4"; x[16] = "89ab"[parseInt(x[16]!, 16) & 3]!;
  const s = x.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}
export function fingerprint(s: ServerSnapshot): string {
  const parts = TABLES.flatMap((t) => s[t].map((r) => `${t}:${r.id}:${r.version ?? 0}:${r.deleted_at ? 1 : 0}`)).sort();
  return hash(parts.join("|") + `|settings:${s.settings?.version ?? 0}`);
}
const guestFp = (d: PlannerData) => hash(JSON.stringify(d));
const REFS: Record<TableName, [string, TableName][]> = {
  categories: [], events: [["category_id", "categories"], ["split_from_event_id", "events"]],
  exceptions: [["event_id", "events"], ["superseded_by_event_id", "events"]], availability: [],
};

function pendingIds(kv: KV, uid: string): Set<string> {
  const out = new Set<string>();
  try {
    const p = JSON.parse(kv.getItem(cloudKey(uid)) ?? "null") as { queue?: Action[]; conflicts?: { mine: Action[] }[] } | null;
    for (const a of [...(p?.queue ?? []), ...(p?.conflicts ?? []).flatMap((c) => c.mine ?? [])]) {
      if (a.type === "split") out.add(a.new_id); else if (a.type !== "settings") out.add(a.id);
    }
  } catch { /* unreadable cache: the sync layer handles recovery; ids there are unknown */ }
  return out;
}
function migratedTo(kv: KV): string | null {
  try { return (JSON.parse(kv.getItem(GUEST_MIGRATED_KEY) ?? "null") as { uid?: string } | null)?.uid ?? null; } catch { return null; }
}

// ---------- preview (read-only) ----------
export function previewMigration(input: {
  uid: string; guestKv: KV; cloudKv: KV; cloud: ServerSnapshot; resolutions?: Resolutions;
  /** False when the backend has no migrate_insert: anything with split history is then blocked, never sent without it. */
  splitHistorySupported?: boolean;
}): MigrationPreview {
  const { uid, cloud } = input; const res = input.resolutions ?? {};
  const g = loadGuest(input.guestKv);
  const raw = parseRaw(input.guestKv);
  const pend = pendingIds(input.cloudKv, uid);
  // Guest data already moved to another account: its ids are taken there, so every record gets an id of its own here.
  const otherAccount = (() => { const m = migratedTo(input.guestKv); return m !== null && m !== uid; })();

  const cloudRows = Object.fromEntries(TABLES.map((t) => [t, new Map(cloud[t].map((r) => [r.id, r]))])) as Record<TableName, Map<string, Row>>;
  const invalid: InvalidItem[] = [];
  // Invalid records loadGuest dropped (kept in storage, never sent).
  for (const t of TABLES) for (const r of raw[t]) if (!validRecord(t, r)) invalid.push({ table: t, id: typeof (r as { id?: unknown })?.id === "string" ? (r as { id: string }).id : null, reason: "invalid" });
  if (raw.settingsInvalid) invalid.push({ table: "settings", id: null, reason: "invalid" });

  // Rows with guest ids; drop records whose references point nowhere (guest, cloud or built-in).
  const rows = Object.fromEntries(TABLES.map((t) => [t, g.data[t].map((r) => toRow(t, r as never))])) as Record<TableName, Row[]>;
  // Repeat until stable: dropping a record can orphan the records that point to it.
  for (let changed = true; changed;) {
    changed = false;
    const live = (t: TableName, id: string) => rows[t].some((r) => r.id === id);
    const exists = (t: TableName, id: string) => live(t, id) || (cloudRows[t].has(id) && !cloudRows[t].get(id)!.deleted_at);
    const bad = new Map<string, InvalidItem["reason"]>();
    const evById = new Map(rows.events.map((r) => [r.id, r]));
    for (const t of TABLES) for (const r of rows[t]) {
      // Category / event links may point to the user's own cloud records; split history only within the guest data.
      if (REFS[t].some(([f, to]) => r[f] != null && !(f === "split_from_event_id" || f === "superseded_by_event_id" ? live(to, r[f] as string) : exists(to, r[f] as string))))
        bad.set(`${t}:${r.id}`, "missing-reference");
    }
    for (const r of rows.events) {
      if (bad.has(`events:${r.id}`) || r["split_from_event_id"] == null) continue;
      // Walk the chain: a loop or a series that does not end before its successor starts is invalid.
      const seen = new Set<string>([r.id]); let cur: Row | undefined = r; let reason: InvalidItem["reason"] | null = null;
      while (cur && cur["split_from_event_id"] != null) {
        const p = evById.get(cur["split_from_event_id"] as string);
        if (!p) break;
        if (seen.has(p.id)) { reason = "circular-split"; break; }
        seen.add(p.id); cur = p;
      }
      const parent = evById.get(r["split_from_event_id"] as string);
      if (!reason && parent && (parent["until"] == null || (r["date"] as string) <= (parent["until"] as string))) reason = "invalid-split";
      if (reason) bad.set(`events:${r.id}`, reason);
    }
    for (const x of rows.exceptions) {
      if (bad.has(`exceptions:${x.id}`) || x["superseded_by_event_id"] == null) continue;
      const n = evById.get(x["superseded_by_event_id"] as string);
      const okTime = typeof x["superseded_at"] === "string" && !Number.isNaN(Date.parse(x["superseded_at"] as string));
      if (!n || n["split_from_event_id"] !== x["event_id"] || (x["original_date"] as string) < (n["date"] as string) || !okTime) bad.set(`exceptions:${x.id}`, "invalid-split");
    }
    for (const t of TABLES) rows[t] = rows[t].filter((r) => {
      const why = bad.get(`${t}:${r.id}`); if (!why) return true;
      invalid.push({ table: t, id: r.id, reason: why }); changed = true; return false;
    });
  }

  const blockers: Blocker[] = []; const items: PlanItem[] = [];
  const idMap = Object.fromEntries(TABLES.map((t) => [t, new Map<string, string>()])) as Record<TableName, Map<string, string>>;
  const skip = new Set<string>();
  for (const t of TABLES) for (const r of rows[t]) {
    const c = cloudRows[t].get(r.id);
    let status: ItemStatus = "add", reason: PlanItem["reason"], to = r.id;
    if (otherAccount) { status = "add-remapped"; reason = "other-account"; to = derivedId(uid, r.id); }
    else if (pend.has(r.id)) { status = "add-remapped"; reason = "id-in-pending-edit"; to = derivedId(uid, r.id); }
    else if (c) {
      // Same id, same content: the record is already in the account (e.g. an earlier, interrupted migration).
      const same = sameRow(c, r);
      if (same && !c.deleted_at) status = "already-present";
      else if (same && c.deleted_at) {
        const choice = res.deletedInCloud?.[r.id];
        blockers.push({ kind: "deleted-in-cloud", table: t, id: r.id });
        if (choice === "skip") skip.add(`${t}:${r.id}`);
        status = "add-remapped"; reason = "id-in-cloud"; to = derivedId(uid, r.id);
      } else { status = "add-remapped"; reason = "id-in-cloud"; to = derivedId(uid, r.id); }
    }
    // A derived id can itself already exist from an earlier interrupted run.
    if (status === "add-remapped") {
      const d = cloudRows[t].get(to);
      if (d && !d.deleted_at) status = "already-present";
    }
    idMap[t].set(r.id, to);
    items.push({ table: t, guestId: r.id, cloudId: to, status, ...(reason ? { reason } : {}) });
  }
  // Remap references; re-check "already present" against the remapped content.
  const references: MigrationPreview["references"] = [];
  const out = Object.fromEntries(TABLES.map((t) => [t, [] as Row[]])) as Record<TableName, Row[]>;
  for (const t of TABLES) for (const r of rows[t]) {
    const n: Row = { ...r, id: idMap[t].get(r.id)! };
    for (const [f, to] of REFS[t]) {
      const v = r[f] as string | null; if (v == null) continue;
      const m = idMap[to].get(v);
      if (m && m !== v) { n[f] = m; references.push({ table: t, id: n.id, field: f, from: v, to: m }); }
    }
    out[t].push(n);
  }
  for (const it of items) if (it.status === "already-present") {
    const n = out[it.table].find((r) => r.id === it.cloudId)!, c = cloudRows[it.table].get(it.cloudId)!;
    if (!sameRow(c, n)) {
      // Something else lives under the derived id: fall back to a second derived id.
      it.cloudId = derivedId(uid, it.cloudId); it.status = "add-remapped"; n.id = it.cloudId;
    }
  }
  const splitLinks = out.events.filter((r) => r["split_from_event_id"]).length + out.exceptions.filter((r) => r["superseded_by_event_id"]).length;
  if (splitLinks && input.splitHistorySupported === false) blockers.push({ kind: "split-history-unsupported", count: splitLinks });
  if (invalid.length) blockers.push({ kind: "invalid-records", count: invalid.length });
  if (g.unreadable) blockers.push({ kind: "guest-unreadable" });

  // Settings: never overwrite silently.
  const gs = settingsToRow(g.data.settings), cs = cloud.settings;
  const guestHasSettings = raw.hasSettings && validSettings(g.data.settings);
  const settings: MigrationPreview["settings"] = !guestHasSettings ? "none" : !cs ? "add" : content(cs) === content(gs) ? "same" : "differ";
  if (settings === "differ") blockers.push({ kind: "settings-differ" });

  const unresolved = blockers.filter((b) =>
    b.kind === "guest-unreadable" ? true
      : b.kind === "invalid-records" ? !res.skipInvalid
      : b.kind === "deleted-in-cloud" ? !res.deletedInCloud?.[b.id]
      : b.kind === "settings-differ" ? !res.settings
      : true);

  // Actions: create-only (base_version 0). The server answers "unchanged" for an identical existing record and
  // "conflict" for a different one, so nothing is ever overwritten and retries never duplicate.
  const actions: MigAction[] = [];
  let skipped = invalid.length;
  const depth = (id: string): number => { let d = 0, cur = out.events.find((e) => e.id === id); while (cur?.["split_from_event_id"] && d < 1000) { d++; cur = out.events.find((e) => e.id === cur!["split_from_event_id"]); } return d; };
  const ordered: [TableName, Row][] = [
    ...out.categories.map((r) => ["categories", r] as [TableName, Row]),
    ...out.events.map((r) => ["events", r] as [TableName, Row]).sort((x, y) => depth(x[1].id) - depth(y[1].id)),
    ...out.exceptions.map((r) => ["exceptions", r] as [TableName, Row]),
    ...out.availability.map((r) => ["availability", r] as [TableName, Row]),
  ];
  for (const [t, n] of ordered) {
    const it = items.find((i) => i.table === t && i.cloudId === n.id)!;
    if (it.status === "already-present") continue;
    if (skip.has(`${t}:${it.guestId}`)) { skipped++; continue; }
    const { id, ...data } = n;
    if (t === "events" || t === "exceptions") actions.push({ type: "migrate_insert", table: t, id, base_version: 0, data });
    else actions.push({ type: "upsert", table: t, id, base_version: 0, data });
  }
  const settingsPlan = settings === "add" ? "add" : settings === "differ" && res.settings === "use-guest" ? "update" : "keep";
  if (settingsPlan !== "keep") actions.push({ type: "settings", base_version: cs?.version ?? 0, data: gs });

  const cloudFingerprint = fingerprint(cloud), guestFingerprint = guestFp(g.data);
  const count = (f: (t: TableName) => number) => Object.fromEntries(TABLES.map((t) => [t, f(t)])) as Record<TableName, number>;
  return {
    uid, cloudFingerprint, guestFingerprint, token: hash(`${uid}|${cloudFingerprint}|${guestFingerprint}|${JSON.stringify(res)}`),
    guestCounts: count((t) => g.data[t].length), cloudCounts: count((t) => cloud[t].filter((r) => !r.deleted_at).length),
    items, invalid, remapped: items.filter((i) => i.cloudId !== i.guestId).map((i) => ({ table: i.table, from: i.guestId, to: i.cloudId })),
    references, settings, blockers, unresolved, canMigrate: unresolved.length === 0 && actions.length > 0,
    expected: { add: actions.filter((a) => a.type === "upsert" || a.type === "migrate_insert").length, alreadyPresent: items.filter((i) => i.status === "already-present").length, skipped, settings: settingsPlan },
    actions,
  };
}
/** Content equality; timestamps compared as instants (the database returns +00:00 where the guest stored Z). */
function norm(r: Row): Row { const x = { ...r }; if (typeof x["superseded_at"] === "string") x["superseded_at"] = new Date(x["superseded_at"] as string).toISOString(); return x; }
const sameRow = (a: Row, b: Row) => content(norm(a)) === content(norm(b));
const sameVal = (k: string, a: unknown, b: unknown) =>
  k === "superseded_at" && typeof a === "string" && typeof b === "string" ? Date.parse(a) === Date.parse(b) : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
function parseRaw(kv: KV): Record<TableName, unknown[]> & { hasSettings: boolean; settingsInvalid: boolean } {
  let d: Record<string, unknown> = {};
  try { const p = JSON.parse(kv.getItem("planner-guest-v1") ?? "{}"); if (p && typeof p === "object") d = p; } catch { /* reported as unreadable */ }
  const o = Object.fromEntries(TABLES.map((t) => [t, Array.isArray(d[t]) ? d[t] : []])) as Record<TableName, unknown[]>;
  return { ...o, hasSettings: d["settings"] !== undefined, settingsInvalid: d["settings"] !== undefined && !validSettings(d["settings"]) };
}

// ---------- execution ----------
export type Confirmation = { confirmed: true; token: string };
/** The only way to obtain a confirmation: from a preview with nothing unresolved. A future screen calls this on the user's tap. */
export function confirmMigration(p: MigrationPreview): Confirmation | null {
  return p.canMigrate ? { confirmed: true, token: p.token } : null;
}

type Journal = { v: 1; token: string; uid: string; actions: MigAction[]; remaps?: Record<string, string>; done: string[]; failed: { key: string; status: string }[]; state: "running" | "verified" | "failed" };
const aKey = (a: MigAction) => (a.type === "settings" ? "settings" : `${(a as { table: string }).table}:${(a as { id: string }).id}`);
export type MigrationResult =
  | { status: "verified"; added: number; alreadyPresent: number }
  | { status: "not-confirmed" | "preview-stale" | "account-changed" | "busy" | "nothing-to-do" }
  | { status: "interrupted"; done: number; remaining: number; error: string }
  | { status: "failed"; failed: { key: string; status: string }[]; error?: string };

const running = new Set<string>();
const BATCH = 50;

/**
 * Runs a confirmed migration. Re-reads the cloud first; if anything changed since the preview, nothing is written.
 * Progress is journaled per user so an interrupted run resumes with the same actions (retries are "unchanged").
 * `currentUid` is asked before every request: sign-out or an account switch stops the run.
 */
export async function runMigration(o: {
  preview: MigrationPreview; confirmation: Confirmation | null; transport: PlannerTransport; kv: KV; guestKv: KV; currentUid: () => string | null; now?: () => string;
}): Promise<MigrationResult> {
  const { preview: p, kv, transport: t } = o;
  if (!o.confirmation || o.confirmation.confirmed !== true || o.confirmation.token !== p.token || !p.canMigrate) return { status: "not-confirmed" };
  if (o.currentUid() !== p.uid) return { status: "account-changed" };
  if (running.has(p.uid)) return { status: "busy" };
  running.add(p.uid);
  try {
    let j = readJournal(kv, p.uid);
    if (j?.state === "verified" && j.token === p.token) return { status: "nothing-to-do" };
    if (!j || j.token !== p.token || j.state !== "running") {
      // Fresh start: the cloud and the guest data must still match the preview exactly.
      let snap: ServerSnapshot;
      try { snap = await t.fetchAll(); } catch (e) { return { status: "interrupted", done: 0, remaining: p.actions.length, error: String(e) }; }
      if (fingerprint(snap) !== p.cloudFingerprint || guestFp(loadGuest(o.guestKv).data) !== p.guestFingerprint) return { status: "preview-stale" };
      j = { v: 1, token: p.token, uid: p.uid, actions: p.actions, done: [], failed: [], state: "running" };
      writeJournal(kv, j);
    }
    // Strictly in order, in groups of at most BATCH that never mix a record with the records that point to it.
    for (let guard = 0; guard < 10_000; guard++) {
      if (o.currentUid() !== p.uid) return { status: "account-changed" };
      const todo = j.actions.filter((a) => !j!.done.includes(aKey(a)));
      if (!todo.length) break;
      const batch = groupOf(todo);
      let res: ActionResult[];
      try { res = await t.apply(batch as Action[]); }
      catch (e) {
        if (e instanceof PlannerNetworkError) return { status: "interrupted", done: j.done.length, remaining: j.actions.length - j.done.length, error: String(e) };
        j.state = "failed"; j.failed.push({ key: "batch", status: String((e as Error).message ?? e) }); writeJournal(kv, j);
        return { status: "failed", failed: j.failed, error: String((e as Error).message ?? e) };
      }
      batch.forEach((a, k) => {
        const s = res[k]?.status ?? "missing";
        if (["created", "unchanged", "updated"].includes(s)) j!.done.push(aKey(a));
        else if (s === "id_taken" && a.type === "migrate_insert" && Object.keys(j!.remaps ?? {}).length < 1000) {
          // The id belongs to another account: give this record an id of its own and update every later reference.
          // Nothing saved earlier can point to it (dependents always come later), so finished groups stay valid.
          remapId(j!, a.id, derivedId(p.uid, a.id));
        } else j!.failed.push({ key: aKey(a), status: s });
      });
      writeJournal(kv, j);
      if (j.failed.length) { j.state = "failed"; writeJournal(kv, j); return { status: "failed", failed: j.failed }; }
    }
    // Verify against a fresh read before calling it done.
    if (o.currentUid() !== p.uid) return { status: "account-changed" };
    let snap: ServerSnapshot;
    try { snap = await t.fetchAll(); } catch (e) { return { status: "interrupted", done: j.done.length, remaining: 0, error: String(e) }; }
    const missing = j.actions.filter((a) => {
      if (a.type === "settings") return !snap.settings || content({ ...snap.settings }) !== content(a.data);
      if (a.type !== "upsert" && a.type !== "migrate_insert") return true;
      const r = snap[a.table].find((x) => x.id === a.id);
      if (!r || r.deleted_at) return true;
      // Every sent field, split links and superseded markers included, must read back unchanged.
      return Object.entries(a.data).some(([k, v]) => !sameVal(k, r[k], v));
    });
    if (missing.length) { j.state = "failed"; j.failed = missing.map((a) => ({ key: aKey(a), status: "not-verified" })); writeJournal(kv, j); return { status: "failed", failed: j.failed }; }
    j.state = "verified"; writeJournal(kv, j);
    o.guestKv.setItem(GUEST_MIGRATED_KEY, JSON.stringify({ uid: p.uid, at: (o.now ?? (() => new Date().toISOString()))() }));
    return { status: "verified", added: j.actions.filter((a) => a.type === "upsert" || a.type === "migrate_insert").length, alreadyPresent: p.expected.alreadyPresent };
  } finally { running.delete(p.uid); }
}

const tierOf = (a: MigAction, all: MigAction[]): string => {
  if (a.type === "settings") return "z";
  if (a.type === "migrate_insert" && a.table === "events") {
    let d = 0; let cur: MigAction | undefined = a;
    while (cur && cur.type === "migrate_insert" && cur.data["split_from_event_id"] && d < 1000) { const pid: unknown = cur.data["split_from_event_id"]; cur = all.find((x) => x.type === "migrate_insert" && x.id === pid); d++; }
    return `b${String(d).padStart(4, "0")}`;
  }
  return a.type === "migrate_insert" ? "c" : (a as { table: string }).table === "categories" ? "a" : "y";
};
/** The next group: consecutive actions of the same dependency tier, at most BATCH. */
function groupOf(todo: MigAction[]): MigAction[] {
  const tier = tierOf(todo[0]!, todo); const out: MigAction[] = [];
  for (const a of todo) { if (out.length >= BATCH || tierOf(a, todo) !== tier) break; out.push(a); }
  return out;
}
const REF_FIELDS = ["category_id", "split_from_event_id", "event_id", "superseded_by_event_id"];
function remapId(j: Journal, from: string, to: string) {
  j.remaps = { ...(j.remaps ?? {}), [from]: to };
  j.actions = j.actions.map((a) => {
    if (a.type === "settings" || a.type === "split") return a;
    const b = { ...a } as MigAction & { id: string; data?: Record<string, unknown> };
    if (b.id === from) b.id = to;
    if (b.data) { b.data = { ...b.data }; for (const f of REF_FIELDS) if (b.data[f] === from) b.data[f] = to; }
    return b as MigAction;
  });
}

function readJournal(kv: KV, uid: string): Journal | null {
  try { const j = JSON.parse(kv.getItem(migrationKey(uid)) ?? "null") as Journal | null; return j && j.v === 1 && j.uid === uid && Array.isArray(j.actions) ? j : null; } catch { return null; }
}
function writeJournal(kv: KV, j: Journal) { kv.setItem(migrationKey(j.uid), JSON.stringify(j)); }
/** For a future screen: an unfinished migration for this user (resume by previewing again and confirming). */
export function pendingMigration(kv: KV, uid: string): { state: Journal["state"]; done: number; total: number } | null {
  const j = readJournal(kv, uid); return j ? { state: j.state, done: j.done.length, total: j.actions.length } : null;
}
