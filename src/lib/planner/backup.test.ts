// @ts-nocheck -- run with `bun test`
import { describe, expect, it } from "bun:test";
import { uuid, memKV, cat, ev, fakeServer } from "./testkit";
import { GUEST_KEY, GuestPlannerStore, loadGuest } from "./guest";
import { buildBackup, parseBackup } from "../backup";
import { applyCloudRestore, applyGuestRestore, plannerToBackup, previewCloudRestore, previewGuestRestore, snapshotToData } from "./backup";

const A = uuid(), B = uuid();
const tasks = [{ id: "t1", title: "לימודים", groupId: null, subtasks: [{ id: "s1", title: "קריאה", done: false, dueDate: null, startAt: "2026-12-01T18:45", durationMin: 30 }] }];
const roundTrip = (planner) => parseBackup(JSON.stringify(buildBackup(tasks, [], planner)));

// A split series with one superseded and one active exception.
function splitGuest() {
  const kv = memKV(); const g = new GuestPlannerStore(kv);
  const c = cat(); g.upsert("categories", c);
  const e = ev({ categoryId: c.id, weekdays: [1, 3], until: "2026-06-30" }); g.upsert("events", e);
  g.upsert("exceptions", { id: uuid(), eventId: e.id, originalDate: "2026-03-02", type: "skip" });
  g.upsert("exceptions", { id: uuid(), eventId: e.id, originalDate: "2026-04-06", type: "change", newStartMin: 600 });
  const n = uuid(); g.split(e.id, "2026-04-01", n, { startMin: 660 }, "2026-03-20T10:00:00.000Z");
  g.upsert("availability", { id: uuid(), weekday: 5, startMin: 1320, endMin: 120, endsNextDay: true });
  g.setSettings({ defaultView: "day", suggestionDaysOff: [6], timezone: "Asia/Jerusalem" });
  return { kv, data: g.get(), e, n };
}
async function cloudWith(uid, data) {
  const srv = fakeServer(); const t = srv.transport(uid);
  const p = await previewCloudRestore(t, uid, plannerToBackup(data));
  expect((await applyCloudRestore(t, uid, p, true)).ok).toBe(true);
  return { srv, t };
}

describe("backup v1 compatibility", () => {
  it("a version 1 file restores tasks and carries no planner data", () => {
    const r = parseBackup(JSON.stringify({ app: "todo-lists", version: 1, exportedAt: "x", tasks, groups: [] }));
    expect(r.ok).toBe(true); expect(r.version).toBe(1); expect(r.planner).toBeNull(); expect(r.tasks).toEqual(tasks);
  });
  it("a version 1 file with a planner key ignores it (planner untouched)", () => {
    const r = parseBackup(JSON.stringify({ app: "todo-lists", version: 1, tasks, groups: [], planner: { events: [] } }));
    expect(r.ok).toBe(true); expect(r.planner).toBeNull();
  });
  it("versions newer than 2 are still refused", () => {
    expect(parseBackup(JSON.stringify({ app: "todo-lists", version: 3, tasks: [], groups: [] })).ok).toBe(false);
  });
  it("task validation is unchanged in version 2", () => {
    const b = buildBackup([{ ...tasks[0], groupId: "nope" }], [], { events: [] });
    expect(parseBackup(JSON.stringify(b)).ok).toBe(false);
  });
});

describe("backup v2 format", () => {
  it("export and import keep every planner field incl. split history", () => {
    const { data, e, n } = splitGuest();
    const r = roundTrip(plannerToBackup(data));
    expect(r.ok).toBe(true); expect(r.version).toBe(2); expect(r.tasks).toEqual(tasks);
    expect(r.planner).toEqual(plannerToBackup(data));
    expect(r.planner.events.find((x) => x.id === n).splitFromEventId).toBe(e.id);
    expect(r.planner.events.find((x) => x.id === e.id).until).toBe("2026-03-31");
    const sup = r.planner.exceptions.find((x) => x.originalDate === "2026-04-06");
    expect(sup.supersededByEventId).toBe(n); expect(sup.supersededAt).toBe("2026-03-20T10:00:00.000Z");
    expect(r.planner.availability[0].endsNextDay).toBe(true);
    expect(r.planner.settings).toEqual({ defaultView: "day", suggestionDaysOff: [6], timezone: "Asia/Jerusalem" });
  });
  it("contains no queues, operation logs or tokens", () => {
    const b = buildBackup(tasks, [], plannerToBackup(splitGuest().data));
    expect(Object.keys(b.planner).sort()).toEqual(["availability", "categories", "events", "exceptions", "settings"]);
    expect(JSON.stringify(b)).not.toMatch(/queue|op_id|token|version"?:\s*\d+,\s*"deleted/);
  });
  it("missing sections stay missing; explicit empty sections stay empty", () => {
    const r = roundTrip({ events: [] });
    expect(r.planner).toEqual({ events: [] });
    expect(roundTrip({}).planner).toBeNull();
  });
  it("invalid planner data rejects the whole file", () => {
    expect(roundTrip({ events: [{ id: "x", title: "a" }] }).ok).toBe(false);
    expect(roundTrip({ events: "no" }).ok).toBe(false);
    expect(roundTrip({ bogus: [] }).ok).toBe(false);
    const e = ev(); expect(roundTrip({ events: [e, e] }).ok).toBe(false);
    expect(roundTrip({ settings: { defaultView: "month", suggestionDaysOff: [], timezone: null } }).ok).toBe(false);
    expect(parseBackup(JSON.stringify({ app: "todo-lists", version: 2, tasks, groups: [], planner: [] })).ok).toBe(false);
  });
});

describe("guest restore", () => {
  it("restores a full backup into an empty guest planner", () => {
    const { data } = splitGuest(); const kv = memKV();
    const p = previewGuestRestore(kv, plannerToBackup(data));
    expect(p.errors).toEqual([]); expect(p.counts.events).toEqual({ add: 2, replace: 0, same: 0, delete: 0 });
    expect(applyGuestRestore(kv, p, true)).toEqual({ ok: true, repeated: false });
    expect(plannerToBackup(loadGuest(kv).data)).toEqual(plannerToBackup(data));
  });
  it("needs confirmation", () => {
    const kv = memKV(); const p = previewGuestRestore(kv, { events: [] });
    expect(applyGuestRestore(kv, p, false).ok).toBe(false);
  });
  it("omitted sections are untouched, empty sections are emptied", () => {
    const { kv, data } = splitGuest();
    const p = previewGuestRestore(kv, { availability: [] });
    expect(p.sections).toEqual({ categories: "omitted", events: "omitted", exceptions: "omitted", availability: "included", settings: "omitted" });
    expect(p.counts.availability.delete).toBe(1);
    applyGuestRestore(kv, p, true);
    const now = loadGuest(kv).data;
    expect(now.availability).toEqual([]); expect(now.events).toEqual(data.events); expect(now.settings).toEqual(data.settings);
  });
  it("refuses if guest data changed after the preview, and repeating a done restore is a no-op", () => {
    const { kv } = splitGuest();
    const p = previewGuestRestore(kv, { availability: [] });
    new GuestPlannerStore(kv).upsert("categories", cat());
    expect(applyGuestRestore(kv, p, true).reason).toBe("changed");
    const p2 = previewGuestRestore(kv, { availability: [] });
    expect(applyGuestRestore(kv, p2, true).ok).toBe(true);
    expect(applyGuestRestore(kv, p2, true)).toEqual({ ok: true, repeated: true });
  });
  it("blocks restores that would break links (e.g. events whose category is not restored)", () => {
    const { kv } = splitGuest();
    const p = previewGuestRestore(kv, { categories: [] });
    expect(p.errors.length).toBeGreaterThan(0);
    const before = kv.getItem(GUEST_KEY);
    expect(applyGuestRestore(kv, p, true).ok).toBe(false);
    expect(kv.getItem(GUEST_KEY)).toBe(before);
  });
  it("keeps guest data when the device storage refuses the write", () => {
    const { kv } = splitGuest(); const before = kv.getItem(GUEST_KEY);
    const p = previewGuestRestore(kv, { availability: [] });
    const set = kv.setItem; kv.setItem = () => { throw new Error("QuotaExceededError"); };
    expect(applyGuestRestore(kv, p, true).reason).toBe("storage");
    kv.setItem = set; expect(kv.getItem(GUEST_KEY)).toBe(before);
  });
  it("refuses to restore over unreadable guest data", () => {
    const kv = memKV({ [GUEST_KEY]: "{broken" });
    const p = previewGuestRestore(kv, { events: [] });
    expect(p.errors).toContain("guest-unreadable");
    expect(applyGuestRestore(kv, p, true).ok).toBe(false);
    expect(kv.getItem(GUEST_KEY)).toBe("{broken");
  });
});

describe("cloud restore", () => {
  it("cloud export and restore round-trip incl. split history", async () => {
    const { data } = splitGuest();
    const { t } = await cloudWith(A, data);
    expect(plannerToBackup(snapshotToData(await t.fetchAll()))).toEqual(plannerToBackup(data));
  });
  it("preview reports add/replace/same/delete and omitted sections", async () => {
    const { data } = splitGuest(); const { t } = await cloudWith(A, data);
    const ev2 = { ...data.events[0], title: "שונה" };
    const p = await previewCloudRestore(t, A, { events: [ev2, ev()] , exceptions: [] });
    expect(p.counts.events).toEqual({ add: 1, replace: 1, same: 0, delete: 1 });
    expect(p.counts.exceptions.delete).toBe(2);
    expect(p.sections.categories).toBe("omitted");
  });
  it("omitted sections are untouched in the cloud", async () => {
    const { data } = splitGuest(); const { t } = await cloudWith(A, data);
    const p = await previewCloudRestore(t, A, { availability: [] });
    expect((await applyCloudRestore(t, A, p, true)).ok).toBe(true);
    const now = snapshotToData(await t.fetchAll());
    expect(now.availability).toEqual([]); expect(now.events.length).toBe(2); expect(now.settings).toEqual(data.settings);
  });
  it("a change after the preview in an omitted section is kept and does not block the restore", async () => {
    const { data } = splitGuest(); const { srv, t } = await cloudWith(A, data);
    const p = await previewCloudRestore(t, A, { availability: [] });
    const c = data.categories[0];
    await srv.other(A, [{ type: "upsert", table: "categories", id: c.id, base_version: 1, data: { name: "חדש", color: c.color } }]);
    expect((await applyCloudRestore(t, A, p, true)).ok).toBe(true);
    const now = snapshotToData(await t.fetchAll());
    expect(now.availability.length).toBe(0); expect(now.categories[0].name).toBe("חדש");
  });
  it("conflict on the restored section itself", async () => {
    const { data } = splitGuest(); const { srv, t } = await cloudWith(A, data);
    const p = await previewCloudRestore(t, A, { categories: data.categories, events: [], exceptions: [] });
    const c = data.categories[0];
    await srv.other(A, [{ type: "upsert", table: "categories", id: c.id, base_version: 1, data: { name: "חדש", color: c.color } }]);
    const r = await applyCloudRestore(t, A, p, true);
    expect(r.reason).toBe("changed"); expect(r.changed[0]).toMatchObject({ table: "categories", id: c.id, expected: 1, current: 2 });
    expect(snapshotToData(await t.fetchAll()).categories[0].name).toBe("חדש");
  });
  it("repeating a restore (lost answer) uses the same operation and is not applied twice", async () => {
    const { data } = splitGuest(); const { srv, t } = await cloudWith(A, data);
    const p = await previewCloudRestore(t, A, { availability: [] });
    srv.loseNextResponse = true;
    expect((await applyCloudRestore(t, A, p, true)).reason).toBe("network");
    const n = srv.applied;
    expect(await applyCloudRestore(t, A, p, true)).toEqual({ ok: true, repeated: true });
    expect(srv.applied).toBe(n);
  });
  it("a server failure leaves cloud data exactly as it was (no partial restore)", async () => {
    const { data } = splitGuest(); const { srv, t } = await cloudWith(A, data);
    const before = await t.fetchAll();
    const p = await previewCloudRestore(t, A, { availability: [], settings: { defaultView: "week", suggestionDaysOff: [], timezone: null } });
    srv.failRestore = true;
    expect((await applyCloudRestore(t, A, p, true)).reason).toBe("server");
    expect(await t.fetchAll()).toEqual(before);
  });
  it("broken links are blocked before sending", async () => {
    const { data } = splitGuest(); const { srv, t } = await cloudWith(A, data);
    const p = await previewCloudRestore(t, A, { events: [] });
    expect(p.errors.length).toBeGreaterThan(0);
    const calls = srv.calls;
    expect((await applyCloudRestore(t, A, p, true)).reason).toBe("invalid"); expect(srv.calls).toBe(calls);
  });
  it("a preview for one account cannot be applied to another", async () => {
    const srv = fakeServer(); const p = await previewCloudRestore(srv.transport(A), A, { events: [] });
    expect((await applyCloudRestore(srv.transport(B), B, p, true)).reason).toBe("wrong-account");
  });
  it("needs confirmation", async () => {
    const srv = fakeServer(); const t = srv.transport(A); const p = await previewCloudRestore(t, A, { events: [] });
    expect((await applyCloudRestore(t, A, p, false)).ok).toBe(false);
  });
  it("restoring the same file again reports everything unchanged", async () => {
    const { data } = splitGuest(); const { t } = await cloudWith(A, data);
    const p = await previewCloudRestore(t, A, plannerToBackup(data));
    for (const k of ["categories", "events", "exceptions", "availability"]) expect(p.counts[k].add + p.counts[k].replace + p.counts[k].delete).toBe(0);
    expect(p.settingsChanged).toBe(false);
  });
});
