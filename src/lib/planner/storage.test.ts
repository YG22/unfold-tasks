// @ts-nocheck -- run with `bun test`
import { describe, expect, it } from "bun:test";
import { GuestPlannerStore, GUEST_KEY, GUEST_CORRUPT_KEY, loadGuest } from "./guest";
import { PlannerSync, PlannerNetworkError, PlannerServerError, cloudKey } from "./sync";
import { DB_TABLE, TABLES, SPLIT_ONLY } from "./data";
import { expand } from "./model";

import { uuid, memKV, cat, ev, CONTENT, DEF, fakeServer, addD } from "./testkit";

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

describe("reliability hardening", () => {
  const { cloudRecoveryKey } = require("./sync");
  const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };
  it("R1 unreadable pending edits: raw copy kept, nothing sent or loaded, error + recovery state", async () => {
    const srv = fakeServer(), uid = uuid(), kv = memKV({ [cloudKey(uuid())]: "OTHER-USER" });
    kv.setItem(cloudKey(uid), "{broken");
    const e = fakeEnv(); const s = new PlannerSync(uid, kv, srv.transport(uid), e.env);
    let fetched = 0; const t = srv.transport(uid); const orig = t.fetchAll; t.fetchAll = () => { fetched++; return orig(); };
    s.start(); await e.settle();
    expect([s.recoveryRequired(), s.status(), s.recoveryData(), kv.getItem(cloudKey(uid)), srv.calls]).toEqual([true, "error", "{broken", "{broken", 0]);
    expect(s.upsert("categories", cat()).ok).toBe(false);
    expect(s.get().categories.length).toBe(0);
    expect([...kv.m.values()]).toContain("OTHER-USER");
  });
  it("R2 an existing recovery copy is never overwritten; valid JSON with a bad queue also counts as unreadable", () => {
    const uid = uuid(), kv = memKV({ [cloudRecoveryKey(uid)]: "FIRST" });
    kv.setItem(cloudKey(uid), JSON.stringify({ v: 1, server: null, queue: [{ type: "upsert" }], conflicts: [], rejected: [] }));
    const s = new PlannerSync(uid, kv, fakeServer().transport(uid), fakeEnv().env);
    expect([s.recoveryRequired(), kv.getItem(cloudRecoveryKey(uid))]).toEqual([true, "FIRST"]);
  });
  it("R3 reload stays in recovery until the user resumes; resuming keeps the recovery copy", async () => {
    const srv = fakeServer(), uid = uuid(), kv = memKV({ [cloudKey(uid)]: "garbage" });
    new PlannerSync(uid, kv, srv.transport(uid), fakeEnv().env);
    const e = fakeEnv(); const s = new PlannerSync(uid, kv, srv.transport(uid), e.env);
    s.start(); await e.settle();
    expect(s.status()).toBe("error");
    s.discardUnreadableAndResume(); await e.settle();
    expect([s.recoveryRequired(), s.status(), kv.getItem(cloudRecoveryKey(uid))]).toEqual([false, "saved", "garbage"]);
    expect(JSON.parse(kv.getItem(cloudKey(uid))).v).toBe(1);
  });
  it("R4+R5 a save that never answers times out, edits stay queued, retry succeeds once", async () => {
    const srv = fakeServer(), uid = uuid(), t = srv.transport(uid), real = t.apply; let n = 0;
    t.apply = (a) => (++n === 1 ? new Promise(() => {}) : real(a));
    const e = fakeEnv(); const s = new PlannerSync(uid, memKV(), t, e.env, { timeoutMs: 5000 });
    s.start(); await e.settle(); const c = cat();
    s.upsert("categories", c);
    await new Promise((r) => setTimeout(r, 0)); await e.settle();
    expect([n >= 2, srv.applied, s.pendingCount(), s.status(), srv.user(uid).categories.get(c.id).version]).toEqual([true, 1, 0, "saved", 1]);
  });
  it("R4b timeout is reported and edits kept while the connection stays bad", async () => {
    const srv = fakeServer(), uid = uuid(), t = srv.transport(uid);
    t.apply = () => new Promise(() => {});
    const e = fakeEnv(); const s = new PlannerSync(uid, memKV(), t, e.env);
    s.start(); await e.settle(); s.upsert("categories", cat());
    for (let i = 0; i < 3; i++) await e.settle();
    expect([s.lastAttemptTimedOut(), s.pendingCount(), s.status() === "saved"]).toEqual([true, 1, false]);
  });
  it("R6 a late answer after a timeout cannot clear newer edits or change state", async () => {
    const srv = fakeServer(), uid = uuid(), t = srv.transport(uid), real = t.apply; let late; let n = 0;
    t.apply = (a) => { if (++n === 1) { late = deferred(); const r = real(a); return late.p.then(() => r); } return real(a); };
    const e = fakeEnv(); const s = new PlannerSync(uid, memKV(), t, e.env);
    s.start(); await e.settle(); const c = cat();
    s.upsert("categories", c); await e.settle(); // first try applied on server but timed out; retry answered "unchanged"
    e.setOnline(false); s.upsert("categories", { ...c, name: "חדש" });
    const before = JSON.stringify([s.get(), s.pendingCount(), s.getConflicts()]);
    late.resolve(); await new Promise((r) => setTimeout(r, 0));
    expect(JSON.stringify([s.get(), s.pendingCount(), s.getConflicts()])).toBe(before);
    e.setOnline(true); await e.settle();
    expect([srv.user(uid).categories.get(c.id).name, srv.user(uid).categories.get(c.id).version, s.status(), srv.applied]).toEqual(["חדש", 2, "saved", 2]);
  });
  it("R7 repeated timeouts then success: exactly one write", async () => {
    const srv = fakeServer(), uid = uuid(), t = srv.transport(uid), real = t.apply; let n = 0;
    t.apply = (a) => (++n <= 3 ? new Promise(() => {}) : real(a));
    const e = fakeEnv(); const s = new PlannerSync(uid, memKV(), t, e.env);
    s.start(); await e.settle(); s.upsert("categories", cat());
    for (let i = 0; i < 6; i++) await e.settle();
    expect([n, srv.applied, s.status(), s.pendingCount()]).toEqual([4, 1, "saved", 0]);
  });
  it("R8 account switch while a save is pending: late answer is ignored, other account untouched", async () => {
    const srv = fakeServer(), kv = memKV(), A = uuid(), B = uuid(), tA = srv.transport(A), real = tA.apply; let hold;
    tA.apply = (a) => { hold = deferred(); const r = real(a); return hold.p.then(() => r); };
    const eA = fakeEnv(); const a = new PlannerSync(A, kv, tA, eA.env, { timeoutMs: 1e9 });
    a.start(); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    a.upsert("categories", cat()); const p = a.flush();
    const savedA = kv.getItem(cloudKey(A));
    a.dispose();
    const b = await setup(B, srv, kv);
    hold.resolve(); await p;
    expect([kv.getItem(cloudKey(A)), JSON.parse(savedA).queue.length, b.s.get().categories.length, b.s.status()]).toEqual([savedA, 1, 0, "saved"]);
  });
});
