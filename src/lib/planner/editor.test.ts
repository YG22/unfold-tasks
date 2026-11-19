// @ts-nocheck -- run with `bun test`
import { describe, expect, it } from "bun:test";
import { GuestPlannerStore, GUEST_KEY } from "./guest";
import { PlannerSync } from "./sync";
import { expand } from "./model";
import { buildEvent, cancelOccurrence, deleteEvent, formFor, saveEvent, saveOccurrence, seriesChain } from "./editor";
import { uuid, memKV, fakeServer } from "./testkit";

const TZ = "Asia/Jerusalem";
const form = (o = {}) => ({ title: "פגישה", category: "builtin:work", startDate: "2026-11-15", startTime: "09:00", endDate: "2026-11-15", endTime: "10:00", repeat: false, weekdays: [], until: "", ...o });
const weekly = (o = {}) => form({ title: "חוג", repeat: true, weekdays: [0, 2], startDate: "2026-11-01", endDate: "2026-11-01", ...o });
const occs = (d, from = "2026-11-01", to = "2026-12-01") => expand(d.events, d.exceptions, from, to, TZ);
function fakeEnv() {
  let timers = [], online = true; const onl = new Set();
  return {
    env: { online: () => online, onOnline: (cb) => { onl.add(cb); return () => onl.delete(cb); }, setTimeout: (fn) => { const t = { fn }; timers.push(t); return t; }, clearTimeout: (t) => { timers = timers.filter((x) => x !== t); }, now: () => "2026-11-18T00:00:00Z" },
    setOnline(v) { online = v; if (v) for (const f of onl) f(); },
    async settle() { for (let i = 0; i < 40; i++) { await new Promise((r) => setTimeout(r, 0)); const t = timers; timers = []; for (const x of t) x.fn(); if (!t.length) { await new Promise((r) => setTimeout(r, 0)); if (!timers.length) return; } } },
  };
}
async function cloud(uid = uuid(), srv = fakeServer(), kv = memKV()) {
  const e = fakeEnv(); const s = new PlannerSync(uid, kv, srv.transport(uid), e.env); s.start(); await e.settle(); return { s, e, srv, uid, kv };
}

describe("validation", () => {
  const d = { categories: [], events: [], exceptions: [], availability: [], settings: {} };
  const errs = (f) => buildEvent(f, d, TZ, uuid()).errors ?? {};
  it("requires a title, a known category and an end after the start", () => {
    expect(errs(form({ title: "  " })).title).toBeTruthy();
    expect(errs(form({ category: uuid() })).category).toBeTruthy();
    expect(errs(form({ endTime: "09:00" })).endTime).toBeTruthy();
    expect(errs(form({ endTime: "08:00" })).endTime).toBeTruthy();
  });
  it("allows overnight up to 24 hours, refuses longer", () => {
    expect(buildEvent(form({ startTime: "22:00", endDate: "2026-11-16", endTime: "02:00" }), d, TZ, uuid()).event.durationMin).toBe(240);
    expect(buildEvent(form({ endDate: "2026-11-16", endTime: "09:00" }), d, TZ, uuid()).event.durationMin).toBe(1440);
    expect(errs(form({ endDate: "2026-11-16", endTime: "09:15" })).endDate).toBeTruthy();
  });
  it("refuses a start inside the spring DST gap; duration across the gap is real time", () => {
    expect(errs(form({ startDate: "2026-03-27", endDate: "2026-03-27", startTime: "02:30", endTime: "04:00" })).startTime).toBeTruthy();
    expect(buildEvent(form({ startDate: "2026-03-27", endDate: "2026-03-27", startTime: "01:00", endTime: "04:00" }), d, TZ, uuid()).event.durationMin).toBe(120);
  });
  it("recurring needs a weekday and an end date not before the start", () => {
    expect(errs(weekly({ weekdays: [] })).weekdays).toBeTruthy();
    expect(errs(weekly({ until: "2026-10-01" })).until).toBeTruthy();
  });
});

describe("guest event management", () => {
  it("creates one-time, overnight and recurring events that survive reload", () => {
    const kv = memKV(), g = new GuestPlannerStore(kv);
    expect(saveEvent(g, form(), TZ, uuid()).ok).toBe(true);
    expect(saveEvent(g, form({ title: "משמרת", startTime: "22:00", endDate: "2026-11-16", endTime: "06:00" }), TZ, uuid()).ok).toBe(true);
    expect(saveEvent(g, weekly({ until: "2026-11-30" }), TZ, uuid()).ok).toBe(true);
    const again = new GuestPlannerStore(kv).get();
    expect(again.events).toHaveLength(3);
    expect(occs(again).filter((o) => o.eventId === again.events[2].id)).toHaveLength(9); // Sun+Tue, Nov 1–30
    expect(again.events[1].durationMin).toBe(480);
  });
  it("edits a one-time event in place (same id, travel and notes kept)", () => {
    const g = new GuestPlannerStore(memKV()), id = uuid();
    saveEvent(g, form(), TZ, id); g.upsert("events", { ...g.get().events[0], notes: "חדר 3", travelBeforeMin: 15 });
    const e = g.get().events[0];
    expect(saveEvent(g, { ...formFor(e, TZ), title: "פגישה מעודכנת", startTime: "11:00", endTime: "12:30" }, TZ, id, e).ok).toBe(true);
    expect(g.get().events).toHaveLength(1);
    expect(g.get().events[0]).toMatchObject({ id, title: "פגישה מעודכנת", startMin: 660, durationMin: 90, notes: "חדר 3", travelBeforeMin: 15 });
  });
  it("edits one occurrence (date/time/duration only) and reuses its exception on a second edit", () => {
    const g = new GuestPlannerStore(memKV()), id = uuid(); saveEvent(g, weekly(), TZ, id);
    const e = g.get().events[0];
    expect(saveOccurrence(g, e, "2026-11-17", { startDate: "2026-11-18", startTime: "10:00", endDate: "2026-11-18", endTime: "10:30" }, TZ, uuid()).ok).toBe(true);
    expect(saveOccurrence(g, e, "2026-11-17", { startDate: "2026-11-18", startTime: "11:00", endDate: "2026-11-18", endTime: "11:30" }, TZ, uuid()).ok).toBe(true);
    const d = g.get(); expect(d.exceptions).toHaveLength(1);
    expect(d.exceptions[0]).toMatchObject({ type: "change", newDate: "2026-11-18", newStartMin: 660, newDurationMin: 30 });
    expect(Object.keys(d.exceptions[0])).not.toContain("title");
    expect(d.events[0].title).toBe("חוג");
    expect(saveOccurrence(g, e, "2026-11-15", { startDate: "2026-11-15", startTime: "09:00", endDate: "2026-11-15", endTime: "10:00" }, TZ, uuid()).ok).toBe(false); // no change
  });
  it("edits the whole series: every occurrence changes, single-occurrence changes are kept", () => {
    const g = new GuestPlannerStore(memKV()), id = uuid(); saveEvent(g, weekly(), TZ, id);
    saveOccurrence(g, g.get().events[0], "2026-11-17", { startDate: "2026-11-17", startTime: "15:00", endDate: "2026-11-17", endTime: "16:00" }, TZ, uuid());
    const e = g.get().events[0];
    expect(saveEvent(g, { ...formFor(e, TZ), title: "חוג ציור", startTime: "08:00", endTime: "08:45" }, TZ, id, e).ok).toBe(true);
    const list = occs(g.get());
    expect(list.every((o) => o.originalDate === "2026-11-17" ? o.startMin === 900 : o.startMin === 480 && o.durationMin === 45)).toBe(true);
    expect(g.get().events[0].title).toBe("חוג ציור");
  });
  it("cancels one occurrence with a skip; the rest of the series stays", () => {
    const g = new GuestPlannerStore(memKV()), id = uuid(); saveEvent(g, weekly(), TZ, id);
    const before = occs(g.get()).length;
    expect(cancelOccurrence(g, g.get().events[0], "2026-11-15", uuid()).ok).toBe(true);
    expect(occs(g.get()).length).toBe(before - 1);
    expect(g.get().exceptions[0].type).toBe("skip");
  });
  it("deletes a one-time event softly; an ordinary save cannot bring it back", () => {
    const kv = memKV(), g = new GuestPlannerStore(kv), id = uuid(); saveEvent(g, form(), TZ, id);
    const e = g.get().events[0];
    expect(deleteEvent(g, id).ok).toBe(true);
    expect(g.get().events).toHaveLength(0);
    expect(g.getDeleted().events[0]).toMatchObject({ id, title: "פגישה" });
    expect(saveEvent(g, formFor(e, TZ), TZ, id, e).ok).toBe(false);
    expect(new GuestPlannerStore(kv).get().events).toHaveLength(0);
  });
  it("deletes a whole split series (all parts and exceptions), from any part", () => {
    const g = new GuestPlannerStore(memKV()), a = uuid(), b = uuid(); saveEvent(g, weekly(), TZ, a);
    cancelOccurrence(g, g.get().events[0], "2026-11-03", uuid());
    expect(g.split(a, "2026-11-15", b, { startMin: 600 }).ok).toBe(true);
    expect(seriesChain(g.get(), a).map((e) => e.id)).toEqual([a, b]);
    expect(g.remove("events", a).ok).toBe(false); // a single part alone is refused
    expect(deleteEvent(g, a).ok).toBe(true);
    expect(g.get().events).toHaveLength(0); expect(g.get().exceptions).toHaveLength(0);
    expect(g.getDeleted().events.find((e) => e.id === b).splitFromEventId).toBe(a);
  });
  it("locks the linked start/end dates of a split part", () => {
    const g = new GuestPlannerStore(memKV()), a = uuid(), b = uuid(); saveEvent(g, weekly(), TZ, a); g.split(a, "2026-11-15", b, {});
    const later = g.get().events.find((e) => e.id === b), earlier = g.get().events.find((e) => e.id === a);
    expect(saveEvent(g, { ...formFor(later, TZ), startDate: "2026-11-22", endDate: "2026-11-22" }, TZ, b, later).errors.startDate).toBeTruthy();
    expect(saveEvent(g, { ...formFor(earlier, TZ), until: "2026-11-20" }, TZ, a, earlier).errors.until).toBeTruthy();
    expect(saveEvent(g, { ...formFor(later, TZ), title: "חדש" }, TZ, b, later).ok).toBe(true);
  });
});

describe("signed-in event management", () => {
  it("creates, edits and cancels through the server and reloads on a new device", async () => {
    const { s, e, srv, uid } = await cloud(); const id = uuid();
    saveEvent(s, weekly(), TZ, id); await e.settle();
    saveOccurrence(s, s.get().events[0], "2026-11-17", { startDate: "2026-11-17", startTime: "12:00", endDate: "2026-11-17", endTime: "13:00" }, TZ, uuid());
    cancelOccurrence(s, s.get().events[0], "2026-11-15", uuid()); await e.settle();
    expect(s.status()).toBe("saved");
    const other = await cloud(uid, srv);
    expect(other.s.get().events[0]).toMatchObject({ id, title: "חוג" });
    expect(other.s.get().exceptions.map((x) => x.type).sort()).toEqual(["change", "skip"]);
  });
  it("deletes a split series softly on the server; ordinary saves cannot restore it", async () => {
    const { s, e, srv, uid } = await cloud(); const a = uuid(), b = uuid();
    saveEvent(s, weekly(), TZ, a); await e.settle();
    s.split(a, "2026-11-15", b, {}); await e.settle();
    expect(deleteEvent(s, b).ok).toBe(true); await e.settle();
    const rows = srv.user(uid).events;
    expect(rows.get(a).deleted_at).toBeTruthy(); expect(rows.get(b).deleted_at).toBeTruthy();
    const old = formFor({ id: a, title: "חוג", date: "2026-11-01", startMin: 540, durationMin: 60, weekdays: [0, 2] }, TZ);
    expect(saveEvent(s, old, TZ, a).ok).toBe(false);
    expect(s.get().events).toHaveLength(0);
  });
  it("keeps accounts apart", async () => {
    const srv = fakeServer(), A = await cloud(uuid(), srv), B = await cloud(uuid(), srv);
    saveEvent(A.s, form(), TZ, uuid()); await A.e.settle(); await B.s.refresh();
    expect(B.s.get().events).toHaveLength(0);
    const id = A.s.get().events[0].id;
    expect(deleteEvent(B.s, id).ok).toBe(false);
  });
  it("an edit made elsewhere becomes a conflict, never a silent overwrite", async () => {
    const srv = fakeServer(), uid = uuid(), A = await cloud(uid, srv), id = uuid();
    saveEvent(A.s, form(), TZ, id); await A.e.settle();
    const B = await cloud(uid, srv);
    A.e.setOnline(false); srv.offline = true;
    saveEvent(A.s, { ...form(), title: "מכשיר א" }, TZ, id, A.s.get().events[0]);
    srv.offline = false;
    saveEvent(B.s, { ...form(), title: "מכשיר ב" }, TZ, id, B.s.get().events[0]); await B.e.settle();
    A.e.setOnline(true); await A.e.settle();
    expect(A.s.getConflicts()).toHaveLength(1);
    expect(srv.user(uid).events.get(id).title).toBe("מכשיר ב");
    expect(saveEvent(A.s, { ...form(), title: "שוב" }, TZ, id, A.s.get().events[0]).ok).toBe(false);
  });
  it("a failed save stays queued and a retry after a lost response creates one record", async () => {
    const { s, e, srv, uid } = await cloud(); const id = uuid();
    srv.offline = true; e.setOnline(false);
    saveEvent(s, form(), TZ, id); await e.settle();
    expect(s.pendingCount()).toBe(1); expect(s.get().events).toHaveLength(1);
    srv.offline = false; srv.loseNextResponse = true; e.setOnline(true); await e.settle();
    await s.refresh(); await s.flush(); await e.settle();
    expect(srv.user(uid).events.size).toBe(1); expect(s.pendingCount()).toBe(0);
    expect(cancelOccurrence(s, s.get().events[0], "2026-11-15", uuid()).ok).toBe(true);
  });
});

it("guest storage key is the only one written", () => {
  const kv = memKV({ "todo-lists-v1": "[T]" }), g = new GuestPlannerStore(kv);
  saveEvent(g, form(), TZ, uuid()); deleteEvent(g, g.get().events[0].id);
  expect([...kv.m.keys()].sort()).toEqual([GUEST_KEY, "todo-lists-v1"].sort());
  expect(kv.m.get("todo-lists-v1")).toBe("[T]");
});
