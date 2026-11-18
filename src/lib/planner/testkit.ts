// @ts-nocheck -- shared test helpers (fake planner server with the same answers as apply_planner_changes)
import { PlannerNetworkError, PlannerServerError } from "./sync";
import { TABLES } from "./data";

const uuid = () => crypto.randomUUID();
const memKV = (init = {}) => { const m = new Map(Object.entries(init)); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const cat = (o = {}) => ({ id: uuid(), name: "ספורט", color: "rose", ...o });
const ev = (o = {}) => ({ id: uuid(), title: "שיעור", date: "2026-03-01", startMin: 540, durationMin: 60, ...o });

// ---- Fake server with the same answers as apply_planner_changes (per-record versions, retries are "unchanged") ----
const CONTENT = { categories: ["name", "color"], events: ["title", "category_builtin", "category_id", "date", "start_min", "duration_min", "weekdays", "until", "travel_before_min", "travel_after_min", "notes"], exceptions: ["event_id", "original_date", "type", "new_date", "new_start_min", "new_duration_min"], availability: ["weekday", "start_min", "end_min", "ends_next_day"] };
const DEF = { events: { travel_before_min: 0, travel_after_min: 0 }, availability: { ends_next_day: false } };
function fakeServer() {
  const db = { users: {} };
  const user = (uid) => (db.users[uid] ??= { categories: new Map(), events: new Map(), exceptions: new Map(), availability: new Map(), settings: null });
  const owner = new Map(); // id -> uid (ids are global like primary keys)
  const srv = { db, calls: 0, applied: 0, offline: false, loseNextResponse: false, listeners: new Set() };
  const pick = (t, o) => Object.fromEntries(CONTENT[t].map((k) => [k, o[k] ?? null]));
  const st = (id, status, cur) => ({ id, status, version: cur?.version ?? null, current: cur ? structuredClone(cur) : null });
  function one(uid, u, a) {
    if (a.type === "settings") {
      const cur = u.settings, base = { default_view: "week", suggestion_days_off: [], timezone: null };
      if (!cur) { if (a.base_version !== 0) return st(uid, "missing", null); u.settings = { ...base, ...a.data, version: 1 }; return st(uid, "created", u.settings); }
      const nc = { ...(a.base_version === 0 ? base : cur), ...a.data }; delete nc.version;
      const cc = { ...cur }; delete cc.version;
      if (JSON.stringify(nc) === JSON.stringify(cc)) return st(uid, "unchanged", cur);
      if (cur.version !== a.base_version) return st(uid, "stale", cur);
      u.settings = { ...nc, version: cur.version + 1 }; return st(uid, "updated", u.settings);
    }
    if (a.type === "split") {
      const old = u.events.get(a.event_id); if (!old) return st(a.event_id, "missing", null);
      const ex = u.events.get(a.new_id);
      if (ex) return ex.split_from_event_id === a.event_id && ex.date === a.from_date ? st(a.new_id, "unchanged", ex) : st(a.new_id, "conflict", ex);
      if (old.deleted_at) return st(a.event_id, "deleted", old);
      if (old.version !== a.base_version) return st(a.event_id, "stale", old);
      u.events.set(a.event_id, { ...old, until: addD(a.from_date, -1), version: old.version + 1 });
      const n = { ...old, ...a.data, id: a.new_id, date: a.from_date, split_from_event_id: a.event_id, version: 1, deleted_at: null };
      u.events.set(a.new_id, n); owner.set(a.new_id, uid);
      for (const [id, x] of u.exceptions) if (x.event_id === a.event_id && x.original_date >= a.from_date && !x.deleted_at && !x.superseded_at)
        u.exceptions.set(id, { ...x, superseded_by_event_id: a.new_id, superseded_at: "2026-11-18T00:00:00Z", version: x.version + 1 });
      return st(a.new_id, "split", n);
    }
    if (a.type === "migrate_insert") {
      // Same answers as _planner_migrate_insert: create-only, full content incl. split history, own references only.
      if (a.base_version !== 0 || !["events", "exceptions"].includes(a.table)) throw new PlannerServerError("planner: migrate_insert invalid");
      const cols = [...CONTENT[a.table], ...(a.table === "events" ? ["split_from_event_id"] : ["superseded_by_event_id", "superseded_at"])];
      const full = (o) => { const x = Object.fromEntries(cols.map((k) => [k, o[k] ?? null])); if (x.superseded_at) x.superseded_at = new Date(x.superseded_at).toISOString(); return x; };
      const nc = full({ ...(DEF[a.table] ?? {}), ...a.data });
      const liveEv = (id) => { const e = u.events.get(id); return e && !e.deleted_at ? e : null; };
      if (a.table === "events") {
        if (nc.category_id && !(u.categories.get(nc.category_id) && !u.categories.get(nc.category_id).deleted_at)) return st(a.id, "invalid_reference", null);
        if (nc.split_from_event_id) { const p = liveEv(nc.split_from_event_id); if (!p || !p.until || nc.date <= p.until || p.id === a.id) return st(a.id, "invalid_reference", null); }
      } else {
        if (!liveEv(nc.event_id)) return st(a.id, "invalid_reference", null);
        if (nc.superseded_by_event_id) { const n = liveEv(nc.superseded_by_event_id); if (!n || n.split_from_event_id !== nc.event_id || nc.original_date < n.date) return st(a.id, "invalid_reference", null); }
      }
      const cur = u[a.table].get(a.id);
      if (cur) return !cur.deleted_at && JSON.stringify(full(cur)) === JSON.stringify(nc) ? st(a.id, "unchanged", cur) : st(a.id, "conflict", cur);
      if (owner.has(a.id)) return st(a.id, "id_taken", null);
      const row = { id: a.id, ...nc, ...(a.table === "exceptions" && nc.superseded_at ? { superseded_at: nc.superseded_at.replace(".000Z", "+00:00") } : {}), version: 1, deleted_at: null };
      u[a.table].set(a.id, row); owner.set(a.id, uid); return st(a.id, "created", row);
    }
    const m = u[a.table], cur = m.get(a.id);
    if (owner.has(a.id) && owner.get(a.id) !== uid) throw new PlannerServerError("planner: id already in use");
    if (a.type === "upsert") {
      if (a.table === "categories" && !["green", "blue", "amber", "rose", "violet", "teal", "orange", "slate"].includes(a.data.color ?? cur?.color)) throw new PlannerServerError("check constraint planner_categories_color_check");
      if (!cur) {
        if (a.base_version !== 0) return st(a.id, "missing", null);
        const row = { id: a.id, ...pick(a.table, { ...DEF[a.table], ...a.data }), ...(a.table === "exceptions" ? { superseded_by_event_id: null, superseded_at: null } : {}), ...(a.table === "events" ? { split_from_event_id: null } : {}), version: 1, deleted_at: null };
        m.set(a.id, row); owner.set(a.id, uid); return st(a.id, "created", row);
      }
      if (cur.deleted_at) return st(a.id, "deleted", cur);
      const nc = pick(a.table, { ...(a.base_version === 0 ? DEF[a.table] ?? {} : cur), ...a.data });
      if (JSON.stringify(nc) === JSON.stringify(pick(a.table, cur))) return st(a.id, "unchanged", cur);
      if (cur.version !== a.base_version) return st(a.id, "stale", cur);
      const row = { ...cur, ...nc, version: cur.version + 1 }; m.set(a.id, row); return st(a.id, "updated", row);
    }
    if (!cur) return st(a.id, "missing", null);
    if (a.type === "delete" && cur.deleted_at) return st(a.id, "unchanged", cur);
    if (a.type === "undelete" && !cur.deleted_at) return st(a.id, "unchanged", cur);
    if (cur.version !== a.base_version) return st(a.id, "stale", cur);
    const row = { ...cur, deleted_at: a.type === "delete" ? "2026-11-18T00:00:00Z" : null, version: cur.version + 1 };
    m.set(a.id, row); return st(a.id, a.type === "delete" ? "deleted_ok" : "undeleted", row);
  }
  // Same answers as _planner_restore: omitted sections untouched, versions checked, op_id idempotent, all or nothing.
  const FULL = { ...CONTENT, events: [...CONTENT.events, "split_from_event_id"], exceptions: [...CONTENT.exceptions, "superseded_by_event_id", "superseded_at"] };
  const norm = (t, o) => JSON.stringify(FULL[t].map((k) => { const v = o[k] ?? null; return k === "superseded_at" && v ? new Date(v).toISOString() : v; }));
  const ops = new Map();
  function restore(uid, u, p) {
    const d = p.data;
    if (!d || typeof d !== "object") throw new PlannerServerError("planner: restore data must be an object");
    if (p.type === "restore") {
      if (!p.op_id || p.confirmed !== true) throw new PlannerServerError("planner: restore needs op_id and confirmation");
      const prev = ops.get(uid + ":" + p.op_id); if (prev) return { ...prev, repeated: true };
    }
    const sections = Object.fromEntries([...TABLES, "settings"].map((k) => [k, k in d ? "included" : "omitted"]));
    const plan = {}, conflicts = [];
    for (const t of TABLES) {
      if (!(t in d)) continue;
      const ids = new Set([...d[t].map((r) => r.id), ...[...u[t].values()].filter((r) => !r.deleted_at).map((r) => r.id)]);
      if (new Set(d[t].map((r) => r.id)).size !== d[t].length) throw new PlannerServerError("planner: duplicate id in restore");
      plan[t] = [...ids].map((id) => {
        const cur = u[t].get(id), rec = d[t].find((r) => r.id === id), v = cur?.version ?? 0;
        if (p.type === "restore" && p.expected?.[t]?.[id] !== v) conflicts.push({ table: t, id, expected: p.expected?.[t]?.[id] ?? null, current: v });
        return { id, version: v, action: !rec ? "delete" : !cur ? "add" : !cur.deleted_at && norm(t, cur) === norm(t, { ...(DEF[t] ?? {}), ...rec }) ? "same" : "replace" };
      });
    }
    if ("settings" in d) { plan.settings_version = u.settings?.version ?? 0; if (p.type === "restore" && p.expected?.settings !== plan.settings_version) conflicts.push({ table: "settings", expected: p.expected?.settings, current: plan.settings_version }); }
    if (p.type === "restore_preview") return { status: "preview", sections, plan };
    if (conflicts.length) return { status: "conflict", changed: conflicts };
    const backup = structuredClone({ categories: [...u.categories], events: [...u.events], exceptions: [...u.exceptions], availability: [...u.availability], settings: u.settings });
    const ownerBackup = new Map(owner);
    try {
      const counts = {};
      for (const t of TABLES) {
        if (!(t in d)) continue;
        const c = { added: 0, replaced: 0, same: 0, deleted: 0 };
        for (const it of plan[t]) {
          const rec = d[t].find((r) => r.id === it.id), cur = u[t].get(it.id);
          const row = (base) => ({ ...base, ...Object.fromEntries(FULL[t].map((k) => [k, ({ ...(DEF[t] ?? {}), ...rec })[k] ?? null])), id: it.id, deleted_at: null });
          if (it.action === "same") c.same++;
          else if (it.action === "add") { if (owner.has(it.id)) throw new PlannerServerError("planner: restore conflict on " + it.id); u[t].set(it.id, { ...row({}), version: 1 }); owner.set(it.id, uid); c.added++; }
          else if (it.action === "replace") { u[t].set(it.id, { ...row(cur), version: cur.version + 1 }); c.replaced++; }
          else { u[t].set(it.id, { ...cur, deleted_at: "2026-11-18T00:00:00Z", version: cur.version + 1 }); c.deleted++; }
        }
        counts[t] = c;
      }
      // Foreign keys are checked at the end of the transaction, like the deferred constraints.
      const live = (t, id) => { const r = u[t].get(id); return r && !r.deleted_at; };
      for (const e of u.events.values()) if (!e.deleted_at && ((e.category_id && !live("categories", e.category_id)) || (e.split_from_event_id && !u.events.get(e.split_from_event_id)))) throw new PlannerServerError("foreign key violation");
      for (const x of u.exceptions.values()) if (!x.deleted_at && !u.events.get(x.event_id)) throw new PlannerServerError("foreign key violation");
      if ("settings" in d) { const v = u.settings?.version ?? 0; u.settings = { default_view: "week", suggestion_days_off: [], timezone: null, ...d.settings, version: v + 1 }; }
      const res = { status: "applied", op_id: p.op_id, sections, counts };
      ops.set(uid + ":" + p.op_id, res); srv.applied++;
      for (const f of srv.listeners) if (f.uid === uid) f.cb();
      return res;
    } catch (e) {
      for (const t of TABLES) u[t] = new Map(backup[t]); u.settings = backup.settings; owner.clear(); for (const [k, v] of ownerBackup) owner.set(k, v);
      throw e;
    }
  }
  srv.transport = (uid) => ({
    async fetchAll() {
      if (srv.offline) throw new PlannerNetworkError("Failed to fetch");
      const u = user(uid);
      const snap = Object.fromEntries(TABLES.map((t) => [t, [...u[t].values()].map((r) => structuredClone(r))]));
      snap.settings = u.settings ? structuredClone(u.settings) : null; return snap;
    },
    async apply(actions) {
      srv.calls++;
      if (srv.offline) throw new PlannerNetworkError("Failed to fetch");
      const u = user(uid), backup = structuredClone({ ...u, categories: [...u.categories], events: [...u.events], exceptions: [...u.exceptions], availability: [...u.availability] });
      const ownerBackup = new Map(owner);
      try {
        const out = actions.map((a) => one(uid, u, a));
        srv.applied += out.filter((r) => ["created", "updated", "deleted_ok", "undeleted", "split"].includes(r.status)).length;
        for (const f of srv.listeners) if (f.uid === uid) f.cb();
        if (srv.loseNextResponse) { srv.loseNextResponse = false; throw new PlannerNetworkError("connection reset after commit"); }
        return out;
      } catch (e) {
        if (!(e instanceof PlannerNetworkError)) { for (const t of TABLES) u[t] = new Map(backup[t]); u.settings = backup.settings; owner.clear(); for (const [k, v] of ownerBackup) owner.set(k, v); }
        throw e;
      }
    },
    async restore(p) {
      srv.calls++;
      if (srv.offline) throw new PlannerNetworkError("Failed to fetch");
      if (srv.failRestore) { srv.failRestore = false; throw new PlannerServerError("planner: restore failed"); }
      const r = restore(uid, user(uid), p);
      if (srv.loseNextResponse) { srv.loseNextResponse = false; throw new PlannerNetworkError("connection reset after commit"); }
      return r;
    },
    subscribe(cb) { const l = { uid, cb }; srv.listeners.add(l); return () => srv.listeners.delete(l); },
  });
  srv.user = user;
  /** Another device writes directly (bypasses this client). */
  srv.other = (uid, actions) => srv.transport(uid).apply(actions);
  return srv;
}
const addD = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export { uuid, memKV, cat, ev, CONTENT, DEF, fakeServer, addD };
