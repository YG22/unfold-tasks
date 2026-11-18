// @ts-nocheck -- run with `bun test`
import { describe, expect, it } from "bun:test";
import { GuestPlannerStore, GUEST_KEY, GUEST_CORRUPT_KEY, loadGuest } from "./guest";
import { PlannerSync, PlannerNetworkError, PlannerServerError, cloudKey } from "./sync";
import { DB_TABLE, TABLES, SPLIT_ONLY } from "./data";
import { expand } from "./model";

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
    subscribe(cb) { const l = { uid, cb }; srv.listeners.add(l); return () => srv.listeners.delete(l); },
  });
  srv.user = user;
  /** Another device writes directly (bypasses this client). */
  srv.other = (uid, actions) => srv.transport(uid).apply(actions);
  return srv;
}
const addD = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

function fakeEnv() {
  let timers = [], online = true; const onl = new Set();
  return {
    env: { online: () => online, onOnline: (cb) => { onl.add(cb); return () => onl.delete(cb); }, setTimeout: (fn) => { const t = { fn }; timers.push(t); return t; }, clearTimeout: (t) => { timers = timers.filter((x) => x !== t); }, now: () => "2026-11-18T00:00:00Z" },
    setOnline(v) { online = v; if (v) for (const f of onl) f(); },
    async settle() { for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 0)); const t = timers; timers = []; for (const x of t) x.fn(); if (!t.length) { await new Promise((r) => setTimeout(r, 0)); if (!timers.length) return; } } },
    listenerCount: () => onl.size,
  };
}
async function setup(uid = uuid(), srv = fakeServer(), kv = memKV()) {
  const e = fakeEnv(); const s = new PlannerSync(uid, kv, srv.transport(uid), e.env);
  s.start(); await e.settle(); return { s, e, srv, kv, uid };
}

describe("guest storage", () => {
  it("G1 survives reload with stable ids; separate versioned key; task keys untouched", () => {
    const kv = memKV({ "todo-lists-v1": "[TASKS]", "todo-groups-v1": "[GROUPS]" });
    const g = new GuestPlannerStore(kv), c = cat(), e = ev({ categoryId: c.id });
    expect(g.upsert("categories", c).ok).toBe(true);
    expect(g.upsert("events", e).ok).toBe(true);
    const again = new GuestPlannerStore(kv).get();
    expect([again.categories[0].id, again.events[0].id, again.events[0].categoryId]).toEqual([c.id, e.id, c.id]);
    expect(JSON.parse(kv.getItem(GUEST_KEY)).v).toBe(1);
    expect([kv.getItem("todo-lists-v1"), kv.getItem("todo-groups-v1")]).toEqual(["[TASKS]", "[GROUPS]"]);
    expect([...kv.m.keys()].sort()).toEqual([GUEST_KEY, "todo-groups-v1", "todo-lists-v1"]);
  });
  it("G2 invalid writes refused; malformed storage handled without data loss", () => {
    const g = new GuestPlannerStore(memKV());
    expect(g.upsert("categories", cat({ color: "#ff0000" })).ok).toBe(false);
    expect(g.upsert("events", ev({ id: "not-a-uuid" })).ok).toBe(false);
    expect(g.upsert("availability", { id: uuid(), weekday: 0, startMin: 600, endMin: 600, endsNextDay: false }).ok).toBe(false);
    const bad = memKV({ [GUEST_KEY]: "{oops" });
    const l = loadGuest(bad);
    expect([l.unreadable, l.data.events.length, bad.getItem(GUEST_CORRUPT_KEY), bad.getItem(GUEST_KEY)]).toEqual([true, 0, "{oops", "{oops"]);
    const mixed = memKV({ [GUEST_KEY]: JSON.stringify({ v: 1, categories: [cat(), { id: 5 }], events: "x", settings: { defaultView: "month" } }) });
    const m = loadGuest(mixed);
    expect([m.data.categories.length, m.dropped, m.data.settings.defaultView]).toEqual([1, 2, "week"]);
  });
  it("G3 guest split keeps exceptions (superseded) and links the series", () => {
    const g = new GuestPlannerStore(memKV()), e = ev({ weekdays: [0, 2] }), x1 = uuid(), x2 = uuid(), n = uuid();
    g.upsert("events", e);
    g.upsert("exceptions", { id: x1, eventId: e.id, originalDate: "2026-03-03", type: "skip" });
    g.upsert("exceptions", { id: x2, eventId: e.id, originalDate: "2026-03-10", type: "skip" });
    expect(g.split(e.id, "2026-03-08", n, { startMin: 660 }, "2026-03-05T00:00:00Z").ok).toBe(true);
    const d = g.get();
    expect(d.exceptions.map((x) => [x.id, x.supersededByEventId ?? null])).toEqual([[x1, null], [x2, n]]);
    expect(d.events.map((x) => [x.id, x.until ?? null, x.splitFromEventId ?? null])).toEqual([[e.id, "2026-03-07", null], [n, null, e.id]]);
  });
});

describe("cloud sync", () => {
  it("C1 loads only the signed-in user's rows; create, update, delete with server versions", async () => {
    const srv = fakeServer(), other = uuid();
    await srv.other(other, [{ type: "upsert", table: "categories", id: uuid(), base_version: 0, data: { name: "זר", color: "blue" } }]);
    const { s } = await setup(uuid(), srv);
    expect([s.status(), s.get().categories.length]).toEqual(["saved", 0]);
    const c = cat();
    s.upsert("categories", c); expect(s.status()).toBe("pending");
    expect(s.get().categories[0].name).toBe("ספורט"); // shown immediately
    await new Promise((r) => setTimeout(r, 0));
  });
  it("C2 create → update → delete reach the server with correct versions; soft delete kept on server", async () => {
    const { s, e, srv, uid } = await setup();
    const c = cat();
    s.upsert("categories", c); s.upsert("categories", { ...c, name: "ריצה" }); // both queued before sending
    await e.settle();
    let row = srv.user(uid).categories.get(c.id);
    expect([row.name, row.version, s.status(), s.pendingCount()]).toEqual(["ריצה", 1, "saved", 0]); // two quick edits merge into one save
    s.remove("categories", c.id); await e.settle();
    row = srv.user(uid).categories.get(c.id);
    expect([!!row.deleted_at, row.version, s.get().categories.length]).toEqual([true, 2, 0]);
    expect(s.undelete("categories", c.id).ok).toBe(true); await e.settle();
    expect([srv.user(uid).categories.get(c.id).deleted_at, s.get().categories.length]).toEqual([null, 1]);
  });
  it("C3 stale edit → conflict; both versions kept; nothing overwritten; user decides", async () => {
    const { s, e, srv, uid } = await setup(); const c = cat();
    s.upsert("categories", c); await e.settle();
    await srv.other(uid, [{ type: "upsert", table: "categories", id: c.id, base_version: 1, data: { name: "מהטלפון" } }]);
    e.setOnline(false);
    s.upsert("categories", { ...c, name: "מהמחשב" });
    e.setOnline(true); await e.settle();
    expect(s.status()).toBe("conflict");
    const k = s.getConflicts()[0];
    expect([k.key, k.reason, k.server.name, k.mine[0].data.name]).toEqual([`categories:${c.id}`, "stale", "מהטלפון", "מהמחשב"]);
    expect(srv.user(uid).categories.get(c.id).name).toBe("מהטלפון"); // server not overwritten
    expect(s.get().categories[0].name).toBe("מהמחשב"); // local edit not lost
    expect(s.upsert("categories", { ...c, name: "עוד" }).reason).toBe("conflict"); // no stacking on an open conflict
    s.resolveConflict(k.key, "mine"); await e.settle();
    expect([srv.user(uid).categories.get(c.id).name, srv.user(uid).categories.get(c.id).version, s.status()]).toEqual(["מהמחשב", 3, "saved"]);
  });
  it("C4 choosing the server version drops only my edit", async () => {
    const { s, e, srv, uid } = await setup(); const c = cat();
    s.upsert("categories", c); await e.settle();
    await srv.other(uid, [{ type: "upsert", table: "categories", id: c.id, base_version: 1, data: { name: "מהטלפון" } }]);
    e.setOnline(false); s.upsert("categories", { ...c, name: "שלי" }); e.setOnline(true); await e.settle();
    s.resolveConflict(s.getConflicts()[0].key, "server"); await e.settle();
    expect([s.get().categories[0].name, s.status(), srv.user(uid).categories.get(c.id).version]).toEqual(["מהטלפון", "saved", 2]);
  });
  it("C5 edit of a record deleted on another device → conflict 'deleted'; keep mine restores it", async () => {
    const { s, e, srv, uid } = await setup(); const c = cat();
    s.upsert("categories", c); await e.settle();
    await srv.other(uid, [{ type: "delete", table: "categories", id: c.id, base_version: 1 }]);
    e.setOnline(false); s.upsert("categories", { ...c, name: "שלי" }); e.setOnline(true); await e.settle();
    expect(s.getConflicts()[0].reason).toBe("deleted");
    s.resolveConflict(s.getConflicts()[0].key, "mine"); await e.settle();
    const row = srv.user(uid).categories.get(c.id);
    expect([row.deleted_at, row.name, row.version]).toEqual([null, "שלי", 4]);
  });
  it("C6 offline edits survive a reload and are sent once when back online", async () => {
    const srv = fakeServer(), uid = uuid(), kv = memKV();
    const a = await setup(uid, srv, kv); const c = cat();
    srv.offline = true; a.e.setOnline(false);
    a.s.upsert("categories", c); await a.e.settle();
    expect([a.s.status(), a.s.pendingCount()]).toEqual(["offline", 1]);
    a.s.dispose();
    srv.offline = false;
    const b = await setup(uid, srv, kv); // reopened app
    expect([srv.user(uid).categories.get(c.id).name, b.s.pendingCount(), b.s.status(), srv.applied]).toEqual(["ספורט", 0, "saved", 1]);
  });
  it("C7 server applied but the answer was lost → retry gives 'unchanged', no duplicate write, no false conflict", async () => {
    const { s, e, srv, uid } = await setup(); const c = cat();
    srv.loseNextResponse = true;
    s.upsert("categories", c); s.upsert("categories", { ...c, name: "ב" }); await e.settle();
    const row = srv.user(uid).categories.get(c.id);
    expect([row.name, row.version, srv.applied, s.status(), s.getConflicts().length]).toEqual(["ב", 1, 1, "saved", 0]);
    expect(srv.calls).toBeGreaterThan(1);
  });
  it("C8 a refused action is isolated; the rest are saved; status error", async () => {
    const { s, e, srv, uid } = await setup(); const good = cat(); const bad = cat();
    // Bypass client validation to simulate a server-side refusal.
    s.upsert("categories", good);
    s["queue"].push({ type: "upsert", table: "categories", id: bad.id, base_version: 0, data: { name: "x", color: "pink" } });
    await e.settle();
    expect([srv.user(uid).categories.has(good.id), srv.user(uid).categories.has(bad.id), s.status(), s.getRejected().length]).toEqual([true, false, "error", 1]);
  });
  it("C9 realtime: change from another device refreshes; pending local edit stays on top until the server answers", async () => {
    const { s, e, srv, uid } = await setup(); const c = cat(), d = cat({ name: "אחר" });
    s.upsert("categories", c); await e.settle();
    e.setOnline(false);
    s.upsert("categories", { ...c, name: "מקומי" });
    await srv.other(uid, [{ type: "upsert", table: "categories", id: d.id, base_version: 0, data: { name: "אחר", color: "teal" } }]); // fires realtime
    await e.settle();
    expect(s.get().categories.map((x) => x.name).sort()).toEqual(["אחר", "מקומי"]);
    expect(s.pendingCount()).toBe(1);
    e.setOnline(true); await e.settle();
    expect([srv.user(uid).categories.get(c.id).name, s.status()]).toEqual(["מקומי", "saved"]);
  });
  it("C10 one subscription per user; sign-out/account switch removes it and stops writes; data stays per user", async () => {
    const srv = fakeServer(), kv = memKV(), A = uuid(), B = uuid();
    const a = await setup(A, srv, kv);
    a.s.start(); // second start is ignored
    expect([...srv.listeners].filter((l) => l.uid === A).length).toBe(1);
    a.s.upsert("categories", cat({ name: "של A" })); await a.e.settle();
    a.s.dispose();
    expect([srv.listeners.size, a.e.listenerCount()]).toEqual([0, 0]);
    const before = kv.getItem(cloudKey(A));
    a.s.upsert("categories", cat()); // ignored after dispose for storage
    expect(kv.getItem(cloudKey(A))).toBe(before);
    const b = await setup(B, srv, kv);
    expect(b.s.get().categories.length).toBe(0);
    expect([...srv.listeners].map((l) => l.uid)).toEqual([B]);
  });
  it("C11 guest and cloud data are separate: no guest data is ever sent", async () => {
    const kv = memKV(); const g = new GuestPlannerStore(kv); g.upsert("categories", cat({ name: "אורח" }));
    const { s, srv, uid } = await setup(uuid(), fakeServer(), kv);
    expect([s.get().categories.length, srv.user(uid).categories.size, srv.calls]).toEqual([0, 0, 0]);
    expect(new GuestPlannerStore(kv).get().categories[0].name).toBe("אורח");
  });
  it("C12 split offline: series linked, later exceptions superseded (kept), history unchanged, retry-safe", async () => {
    const { s, e, srv, uid } = await setup();
    const w = ev({ weekdays: [0, 2] }), x1 = uuid(), x2 = uuid(), n = uuid();
    s.upsert("events", w);
    s.upsert("exceptions", { id: x1, eventId: w.id, originalDate: "2026-03-03", type: "skip" });
    s.upsert("exceptions", { id: x2, eventId: w.id, originalDate: "2026-03-10", type: "skip" });
    await e.settle();
    const historyBefore = expand(s.get().events, s.get().exceptions, "2026-03-01", "2026-03-08", "Asia/Jerusalem");
    e.setOnline(false);
    expect(s.split(w.id, "2026-03-08", n, { startMin: 660 }).ok).toBe(true);
    expect(s.get().exceptions.find((x) => x.id === x2).supersededByEventId).toBe(n); // shown before sending
    srv.loseNextResponse = true; e.setOnline(true); await e.settle();
    const u = srv.user(uid);
    expect([u.events.get(w.id).until, u.events.get(n).split_from_event_id, u.events.get(n).start_min]).toEqual(["2026-03-07", w.id, 660]);
    expect([u.exceptions.get(x1).superseded_by_event_id, u.exceptions.get(x2).superseded_by_event_id, u.exceptions.size]).toEqual([null, n, 2]);
    expect([s.status(), s.getConflicts().length, [...u.events.keys()].length]).toEqual(["saved", 0, 2]);
    const d = s.get();
    expect(d.exceptions.find((x) => x.id === x2).supersededAt).toBe("2026-11-18T00:00:00Z");
    expect(expand(d.events, d.exceptions, "2026-03-01", "2026-03-08", "Asia/Jerusalem")).toEqual(historyBefore);
  });
  it("C13 settings: create, update, stale conflict kept", async () => {
    const { s, e, srv, uid } = await setup();
    s.setSettings({ defaultView: "day", suggestionDaysOff: [6], timezone: "Asia/Jerusalem" }); await e.settle();
    expect([srv.user(uid).settings.default_view, srv.user(uid).settings.version]).toEqual(["day", 1]);
    await srv.other(uid, [{ type: "settings", base_version: 1, data: { default_view: "week" } }]);
    e.setOnline(false); s.setSettings({ defaultView: "day", suggestionDaysOff: [5, 6], timezone: "Asia/Jerusalem" }); e.setOnline(true); await e.settle();
    expect([s.status(), s.getConflicts()[0].key, srv.user(uid).settings.suggestion_days_off]).toEqual(["conflict", "settings", [6]]);
  });
  it("C14 status: loading → saved; offline with no connection; split-only fields never sent in ordinary saves", async () => {
    const srv = fakeServer(), uid = uuid(), e = fakeEnv();
    const s = new PlannerSync(uid, memKV(), srv.transport(uid), e.env);
    expect(s.status()).toBe("loading");
    s.start(); await e.settle(); expect(s.status()).toBe("saved");
    e.setOnline(false); expect(s.status()).toBe("offline");
    s.upsert("exceptions", { id: uuid(), eventId: uuid(), originalDate: "2026-03-03", type: "skip", supersededByEventId: uuid(), supersededAt: "x" });
    const a = s["queue"][0];
    expect(SPLIT_ONLY.some((k) => k in a.data)).toBe(false);
  });
  it("C15 the realtime transport covers the five data tables only", () => {
    expect(Object.values(DB_TABLE).sort()).toEqual(["planner_availability", "planner_categories", "planner_events", "planner_exceptions", "planner_settings"]);
  });
});

describe("retry while a batch is in flight", () => {
  it("C16 edit made during a lost request is sent after it without a false conflict", async () => {
    const { s, e, srv, uid } = await setup(); const c = cat();
    srv.loseNextResponse = true;
    s.upsert("categories", c);
    const p = s.flush(); // request in flight
    s.upsert("categories", { ...c, name: "ג" });
    await p; await e.settle();
    const row = srv.user(uid).categories.get(c.id);
    expect([row.name, row.version, s.status(), s.getConflicts().length]).toEqual(["ג", 2, "saved", 0]);
  });
});
