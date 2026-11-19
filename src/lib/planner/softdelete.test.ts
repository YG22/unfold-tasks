// @ts-nocheck -- run with `bun test`
import { describe, expect, it } from "bun:test";
import { uuid, memKV, cat, ev, fakeServer } from "./testkit";
import { GUEST_KEY, GuestPlannerStore, loadGuest } from "./guest";
import { readGuestPlanner } from "./source";
import { expand } from "./model";
import { previewMigration, confirmMigration, runMigration } from "./migrate";
import { applyGuestRestore, plannerToBackup, previewGuestRestore } from "./backup";
import { buildBackup, parseBackup } from "../backup";

const T = "2026-11-19T08:00:00.000Z";
const doc = (kv) => JSON.parse(kv.getItem(GUEST_KEY));

describe("guest soft delete", () => {
  it("keeps the record with its id, links and a deletion time; hidden from the active planner", () => {
    const kv = memKV(); const g = new GuestPlannerStore(kv); const c = cat(); const e = ev({ categoryId: c.id });
    g.upsert("categories", c); g.upsert("events", e);
    expect(g.remove("events", e.id, T)).toEqual({ ok: true });
    expect(g.get().events).toEqual([]);
    expect(doc(kv).deleted.events).toEqual([{ ...e, deletedAt: T }]);
    expect(readGuestPlanner(kv).data.events).toEqual([]);
  });
  it("stays deleted after reload and cannot be resurrected by a save", () => {
    const kv = memKV(); const g = new GuestPlannerStore(kv); const e = ev({}); g.upsert("events", e); g.remove("events", e.id, T);
    const again = new GuestPlannerStore(kv);
    expect([again.get().events.length, again.getDeleted().events[0].id]).toEqual([0, e.id]);
    expect(again.upsert("events", e).ok).toBe(false);
    expect(loadGuest(kv).data.events).toEqual([]);
  });
  it("repeated deletion is a no-op and keeps the first deletion time", () => {
    const kv = memKV(); const g = new GuestPlannerStore(kv); const e = ev({}); g.upsert("events", e);
    g.remove("events", e.id, T); const before = kv.getItem(GUEST_KEY);
    expect(g.remove("events", e.id, "2027-01-01T00:00:00.000Z")).toEqual({ ok: true, repeated: true });
    expect(kv.getItem(GUEST_KEY)).toBe(before);
    expect(g.remove("events", uuid()).ok).toBe(false);
  });
  it("deleting one recurring occurrence is a skip exception; the series continues", () => {
    const g = new GuestPlannerStore(memKV()); const e = ev({ date: "2026-11-02", weekdays: [1] }); g.upsert("events", e);
    g.upsert("exceptions", { id: uuid(), eventId: e.id, originalDate: "2026-11-09", type: "skip" });
    const d = g.get(); const occ = expand(d.events, d.exceptions, "2026-11-01", "2026-11-23", "Asia/Jerusalem").map((o) => o.date);
    expect(occ).toEqual(["2026-11-02", "2026-11-16"]);
  });
  it("deleting a series also marks its exceptions deleted (none left pointing to it)", () => {
    const kv = memKV(); const g = new GuestPlannerStore(kv); const e = ev({ weekdays: [1] }); const x = uuid();
    g.upsert("events", e); g.upsert("exceptions", { id: x, eventId: e.id, originalDate: "2026-03-02", type: "skip" });
    g.remove("events", e.id, T);
    expect([g.get().exceptions.length, g.getDeleted().exceptions.map((r) => [r.id, r.eventId])]).toEqual([0, [[x, e.id]]]);
  });
  it("split series: a part with a later part is refused; removeSeries deletes the whole chain with links intact", () => {
    const g = new GuestPlannerStore(memKV()); const e = ev({ weekdays: [0, 2] }); const n = uuid(); const x = uuid();
    g.upsert("events", e); g.upsert("exceptions", { id: x, eventId: e.id, originalDate: "2026-03-10", type: "skip" });
    g.split(e.id, "2026-03-08", n, {}, "2026-03-05T00:00:00Z");
    expect(g.remove("events", e.id)).toEqual({ ok: false, reason: "in-use" });
    expect(g.removeSeries(n, T).ok).toBe(true);
    expect(g.get().events).toEqual([]);
    const del = g.getDeleted();
    expect(del.events.map((r) => [r.id, r.splitFromEventId ?? null]).sort()).toEqual([[e.id, null], [n, e.id]].sort());
    expect(del.exceptions[0]).toMatchObject({ id: x, supersededByEventId: n });
  });
  it("a category still used by an event cannot be deleted", () => {
    const g = new GuestPlannerStore(memKV()); const c = cat(); g.upsert("categories", c); g.upsert("events", ev({ categoryId: c.id }));
    expect(g.remove("categories", c.id)).toEqual({ ok: false, reason: "in-use" });
  });
  it("deleted guest records are never migrated to an account", async () => {
    const gkv = memKV(); const g = new GuestPlannerStore(gkv); const keep = ev({}); const gone = ev({});
    g.upsert("events", keep); g.upsert("events", gone); g.remove("events", gone.id, T);
    const uid = uuid(); const srv = fakeServer(); const t = srv.transport(uid); const kv = memKV();
    const p = previewMigration({ uid, guestKv: gkv, cloudKv: kv, cloud: await t.fetchAll() });
    expect((await runMigration({ preview: p, confirmation: confirmMigration(p), transport: t, kv, guestKv: gkv, currentUid: () => uid })).status).toBe("verified");
    expect([...srv.user(uid).events.keys()]).toEqual([keep.id]);
    expect(doc(gkv).deleted.events[0].id).toBe(gone.id);
  });
  it("backup leaves deleted records out; restore keeps markers, marks removed records, revives restored ones", () => {
    const kv = memKV(); const g = new GuestPlannerStore(kv); const a = ev({}); const b = ev({}); const z = ev({});
    g.upsert("events", a); g.upsert("events", b); g.upsert("events", z); g.remove("events", z.id, T);
    const file = parseBackup(JSON.stringify(buildBackup([], [], plannerToBackup(g.get()))));
    expect(file.planner.events.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
    // Restore a section with only `a` and the previously deleted `z`.
    const p = previewGuestRestore(kv, { events: [a, z] });
    expect(applyGuestRestore(kv, p, true).ok).toBe(true);
    const l = loadGuest(kv);
    expect(l.data.events.map((e) => e.id).sort()).toEqual([a.id, z.id].sort());
    expect(l.deleted.events.map((e) => e.id)).toEqual([b.id]);
    expect(new GuestPlannerStore(kv).get().events.length).toBe(2);
  });
  it("older guest documents without deletion markers still load", () => {
    const e = ev({}); const kv = memKV({ [GUEST_KEY]: JSON.stringify({ v: 1, events: [e] }) });
    const l = loadGuest(kv); expect([l.data.events.length, l.deleted.events.length, l.dropped]).toEqual([1, 0, 0]);
  });
});
