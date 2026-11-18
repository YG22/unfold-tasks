// @ts-nocheck -- run with `bun test`
import { describe, expect, it } from "bun:test";
import { uuid, memKV, cat, ev, fakeServer } from "./testkit";
import { GUEST_KEY } from "./guest";
import { cloudKey, PlannerNetworkError } from "./sync";
import { previewMigration, confirmMigration, runMigration, derivedId, migrationKey, GUEST_MIGRATED_KEY, pendingMigration } from "./migrate";

const A = uuid(), B = uuid();
const guestKV = (d) => memKV({ [GUEST_KEY]: JSON.stringify({ v: 1, categories: [], events: [], exceptions: [], availability: [], ...d }) });
async function setup(guest, uid = A) {
  const srv = fakeServer(); const t = srv.transport(uid); const kv = memKV(); const gkv = guestKV(guest);
  let who = uid;
  const preview = async (res) => previewMigration({ uid, guestKv: gkv, cloudKv: kv, cloud: await t.fetchAll(), resolutions: res });
  const run = (p, extra = {}) => runMigration({ preview: p, confirmation: confirmMigration(p), transport: t, kv, guestKv: gkv, currentUid: () => who, ...extra });
  return { srv, t, kv, gkv, preview, run, setWho: (u) => (who = u) };
}
const c1 = cat(), e1 = ev({ categoryId: c1.id, weekdays: [1, 3], until: "2026-06-30" });
const e0 = ev({ weekdays: [1] });
const x0 = { id: uuid(), eventId: e0.id, originalDate: "2026-03-02", type: "skip" };
const x1 = { id: uuid(), eventId: e1.id, originalDate: "2026-03-02", type: "skip" };
const av = { id: uuid(), weekday: 1, startMin: 1320, endMin: 120, endsNextDay: true };
const full = { categories: [c1], events: [e1], exceptions: [x1], availability: [av], settings: { defaultView: "day", suggestionDaysOff: [6], timezone: "Asia/Jerusalem" } };

describe("guest -> account planner migration", () => {
  it("empty cloud: everything added with the same ids, then verified; guest data kept", async () => {
    const s = await setup(full); const p = await s.preview();
    expect(p.canMigrate).toBe(true); expect(p.expected).toEqual({ add: 4, alreadyPresent: 0, skipped: 0, settings: "add" });
    expect(p.remapped).toEqual([]);
    expect(await s.run(p)).toEqual({ status: "verified", added: 4, alreadyPresent: 0 });
    const u = s.srv.user(A);
    expect(u.events.get(e1.id).category_id).toBe(c1.id); expect(u.events.get(e1.id).weekdays).toEqual([1, 3]);
    expect(u.exceptions.get(x1.id).event_id).toBe(e1.id); expect(u.availability.get(av.id).ends_next_day).toBe(true);
    expect(u.settings.timezone).toBe("Asia/Jerusalem");
    expect(JSON.parse(s.gkv.getItem(GUEST_KEY)).events[0].id).toBe(e1.id);
    expect(JSON.parse(s.gkv.getItem(GUEST_MIGRATED_KEY)).uid).toBe(A);
  });

  it("existing cloud records are preserved; no merge by title or date", async () => {
    const s = await setup({ events: [ev({ title: "שיעור", date: "2026-03-01" })] });
    const mine = uuid();
    await s.srv.other(A, [{ type: "upsert", table: "events", id: mine, base_version: 0, data: { title: "שיעור", date: "2026-03-01", start_min: 540, duration_min: 60 } }]);
    const p = await s.preview(); expect(p.expected.add).toBe(1);
    expect((await s.run(p)).status).toBe("verified");
    expect(s.srv.user(A).events.size).toBe(2); expect(s.srv.user(A).events.get(mine).version).toBe(1);
  });

  it("id collision with different cloud content: guest copy gets a new id, cloud record untouched", async () => {
    const s = await setup({ categories: [c1], events: [e1] });
    await s.srv.other(A, [{ type: "upsert", table: "categories", id: c1.id, base_version: 0, data: { name: "אחר", color: "blue" } }]);
    const p = await s.preview(); const to = derivedId(A, c1.id);
    expect(p.remapped).toEqual([{ table: "categories", from: c1.id, to }]);
    expect(p.references).toEqual([{ table: "events", id: e1.id, field: "category_id", from: c1.id, to }]);
    expect((await s.run(p)).status).toBe("verified");
    const u = s.srv.user(A);
    expect(u.categories.get(c1.id).name).toBe("אחר"); expect(u.categories.get(to).name).toBe(c1.name);
    expect(u.events.get(e1.id).category_id).toBe(to);
  });

  it("event collision remaps its exceptions too", async () => {
    const s = await setup({ events: [e0], exceptions: [x0] });
    await s.srv.other(A, [{ type: "upsert", table: "events", id: e0.id, base_version: 0, data: { title: "x", date: "2026-01-01", start_min: 0, duration_min: 30 } }]);
    const p = await s.preview(); const to = derivedId(A, e0.id);
    expect(p.references.find((r) => r.table === "exceptions")).toEqual({ table: "exceptions", id: x0.id, field: "event_id", from: e0.id, to });
    expect((await s.run(p)).status).toBe("verified");
    expect(s.srv.user(A).exceptions.get(x0.id).event_id).toBe(to);
  });

  it("invalid guest records block until explicitly skipped, and stay in guest storage", async () => {
    const s = await setup({ events: [e0, { id: "nope", title: "" }], exceptions: [{ id: uuid(), eventId: uuid(), originalDate: "2026-03-02", type: "skip" }] });
    const p = await s.preview();
    expect(p.invalid.map((i) => i.reason).sort()).toEqual(["invalid", "missing-reference"]);
    expect(p.canMigrate).toBe(false); expect(confirmMigration(p)).toBe(null);
    expect((await s.run(p)).status).toBe("not-confirmed"); expect(s.srv.calls).toBe(0);
    const p2 = await s.preview({ skipInvalid: true });
    expect(p2.expected).toMatchObject({ add: 1, skipped: 2 });
    expect((await s.run(p2)).status).toBe("verified");
    expect(JSON.parse(s.gkv.getItem(GUEST_KEY)).events.length).toBe(2);
  });

  it("different cloud settings block until the user chooses; keep-cloud leaves them", async () => {
    const s = await setup({ settings: { defaultView: "day", suggestionDaysOff: [], timezone: null }, availability: [av] });
    await s.srv.other(A, [{ type: "settings", base_version: 0, data: { default_view: "week", suggestion_days_off: [5], timezone: null } }]);
    expect((await s.preview()).unresolved).toEqual([{ kind: "settings-differ" }]);
    const p = await s.preview({ settings: "keep-cloud" });
    expect((await s.run(p)).status).toBe("verified"); expect(s.srv.user(A).settings.suggestion_days_off).toEqual([5]);
  });

  it("guest record identical to one deleted in the cloud needs a decision; skip keeps it deleted", async () => {
    const s = await setup({ categories: [c1] });
    await s.srv.other(A, [{ type: "upsert", table: "categories", id: c1.id, base_version: 0, data: { name: c1.name, color: c1.color } }]);
    await s.srv.other(A, [{ type: "delete", table: "categories", id: c1.id, base_version: 1 }]);
    expect((await s.preview()).canMigrate).toBe(false);
    const p = await s.preview({ deletedInCloud: { [c1.id]: "skip" } });
    expect(p.actions).toEqual([]); expect(p.canMigrate).toBe(false); // nothing to do
    const p2 = await s.preview({ deletedInCloud: { [c1.id]: "copy" } });
    expect((await s.run(p2)).status).toBe("verified");
    expect(s.srv.user(A).categories.get(c1.id).deleted_at).toBeTruthy();
  });

  it("cloud change after preview invalidates it; nothing written", async () => {
    const s = await setup(full); const p = await s.preview();
    await s.srv.other(A, [{ type: "upsert", table: "categories", id: uuid(), base_version: 0, data: { name: "חדש", color: "teal" } }]);
    const before = s.srv.applied;
    expect((await s.run(p)).status).toBe("preview-stale"); expect(s.srv.applied).toBe(before);
  });

  it("guest change after preview also invalidates it", async () => {
    const s = await setup(full); const p = await s.preview();
    s.gkv.setItem(GUEST_KEY, JSON.stringify({ v: 1, categories: [], events: [], exceptions: [], availability: [] }));
    expect((await s.run(p)).status).toBe("preview-stale");
  });

  it("interrupted halfway (lost response / offline) resumes without duplicates, also after reload", async () => {
    const many = Array.from({ length: 70 }, (_, i) => ev({ title: `e${i}` }));
    const s = await setup({ events: many }); const p = await s.preview();
    let n = 0; const flaky = { ...s.t, apply: async (a) => { if (++n === 2) { s.srv.offline = true; } return s.t.apply(a); } };
    const r = await s.run(p, { transport: flaky });
    expect(r).toMatchObject({ status: "interrupted", done: 50, remaining: 20 });
    expect(pendingMigration(s.kv, A)).toEqual({ state: "running", done: 50, total: 70 });
    s.srv.offline = false;
    // "Reload": same journal, same preview -> resumes the remaining 20.
    expect((await s.run(p)).status).toBe("verified"); expect(s.srv.user(A).events.size).toBe(70);
    // Or a fresh preview after reload: the 50 are already present.
    const s2 = await setup({ events: many }); const p0 = await s2.preview();
    s2.srv.loseNextResponse = true;
    expect((await s2.run(p0)).status).toBe("interrupted");
    const p1 = await s2.preview(); expect(p1.expected).toMatchObject({ add: 20, alreadyPresent: 50 });
    expect((await s2.run(p1)).status).toBe("verified"); expect(s2.srv.user(A).events.size).toBe(70);
  });

  it("repeated and concurrent requests do not duplicate", async () => {
    const s = await setup(full); const p = await s.preview();
    const [r1, r2] = await Promise.all([s.run(p), s.run(p)]);
    expect([r1.status, r2.status].sort()).toEqual(["busy", "verified"]);
    expect((await s.run(p)).status).toBe("nothing-to-do");
    const again = await s.preview(); expect(again.canMigrate).toBe(false); expect(again.expected.alreadyPresent).toBe(4);
    expect(s.srv.user(A).events.size).toBe(1);
  });

  it("sign-out or account switch stops the run; journal stays with the first user", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ev({ title: `e${i}` }));
    const s = await setup({ events: many }); const p = await s.preview();
    const t2 = { ...s.t, apply: async (a) => { const r = await s.t.apply(a); s.setWho(B); return r; } };
    expect((await s.run(p, { transport: t2 })).status).toBe("account-changed");
    expect(s.srv.user(B).events.size).toBe(0); expect(s.kv.getItem(migrationKey(B))).toBe(null);
    s.setWho(null); expect((await s.run(p)).status).toBe("account-changed");
  });

  it("same device guest data moved to a second account gets that account's own ids", async () => {
    const s = await setup(full); expect((await s.run(await s.preview())).status).toBe("verified");
    const tB = s.srv.transport(B);
    const p = previewMigration({ uid: B, guestKv: s.gkv, cloudKv: memKV(), cloud: await tB.fetchAll() });
    expect(p.remapped.length).toBe(4);
    const r = await runMigration({ preview: p, confirmation: confirmMigration(p), transport: tB, kv: memKV(), guestKv: s.gkv, currentUid: () => B });
    expect(r.status).toBe("verified"); expect(s.srv.user(A).events.get(e1.id).title).toBe(e1.title);
  });

  it("failure keeps guest data and reports refused records", async () => {
    const s = await setup({ categories: [c1] }); const p = await s.preview();
    const bad = { ...s.t, apply: async (a) => a.map((x) => ({ id: x.id, status: "conflict", version: 1, current: null })) };
    expect((await s.run(p, { transport: bad }))).toMatchObject({ status: "failed" });
    expect(JSON.parse(s.gkv.getItem(GUEST_KEY)).categories[0].id).toBe(c1.id); expect(s.gkv.getItem(GUEST_MIGRATED_KEY)).toBe(null);
  });

  it("pending cloud edits are untouched and their ids are not reused", async () => {
    const s = await setup({ categories: [c1] });
    const cache = JSON.stringify({ v: 1, server: null, queue: [{ type: "upsert", table: "categories", id: c1.id, base_version: 0, data: { name: "מקומי", color: "rose" } }], conflicts: [], rejected: [] });
    s.kv.setItem(cloudKey(A), cache);
    const p = await s.preview(); expect(p.items[0]).toMatchObject({ status: "add-remapped", reason: "id-in-pending-edit" });
    expect((await s.run(p)).status).toBe("verified"); expect(s.kv.getItem(cloudKey(A))).toBe(cache);
  });

  it("explicit confirmation is required: no confirmation or a foreign token writes nothing", async () => {
    const s = await setup(full); const p = await s.preview();
    expect((await s.run(p, { confirmation: null })).status).toBe("not-confirmed");
    expect((await s.run(p, { confirmation: { confirmed: true, token: "x" } })).status).toBe("not-confirmed");
    expect(s.srv.calls).toBe(0);
  });

  // ---------- split-series history ----------
  const splitData = () => {
    const a = ev({ title: "א", weekdays: [1], date: "2026-01-05", until: "2026-03-31" });
    const b = ev({ title: "ב", weekdays: [2], date: "2026-04-01", until: "2026-06-30", splitFromEventId: a.id });
    const c = ev({ title: "ג", weekdays: [3], date: "2026-07-01", splitFromEventId: b.id });
    const xa = { id: uuid(), eventId: a.id, originalDate: "2026-01-12", type: "skip" };
    const xs = { id: uuid(), eventId: a.id, originalDate: "2026-04-06", type: "change", newStartMin: 600, supersededByEventId: b.id, supersededAt: "2026-03-20T10:15:00.000Z" };
    const xb = { id: uuid(), eventId: b.id, originalDate: "2026-04-07", type: "skip" };
    const xs2 = { id: uuid(), eventId: b.id, originalDate: "2026-07-08", type: "skip", supersededByEventId: c.id, supersededAt: "2026-06-01T08:00:00.000Z" };
    return { a, b, c, xa, xs, xb, xs2, guest: { events: [c, b, a], exceptions: [xs2, xb, xs, xa] } };
  };
  const row = (s, t, id) => s.srv.user(A)[t].get(id);

  it("split-of-split history is kept: links, end dates, superseded markers and their original times", async () => {
    const d = splitData(); const s = await setup(d.guest); const p = await s.preview();
    expect(p.unresolved).toEqual([]);
    expect(p.actions.filter((x) => x.table === "events").map((x) => x.id)).toEqual([d.a.id, d.b.id, d.c.id]); // parents first
    expect((await s.run(p)).status).toBe("verified");
    expect(row(s, "events", d.b.id).split_from_event_id).toBe(d.a.id); expect(row(s, "events", d.c.id).split_from_event_id).toBe(d.b.id);
    expect(row(s, "events", d.a.id).until).toBe("2026-03-31"); expect(row(s, "events", d.b.id).until).toBe("2026-06-30");
    expect(row(s, "exceptions", d.xs.id)).toMatchObject({ superseded_by_event_id: d.b.id, new_start_min: 600 });
    expect(Date.parse(row(s, "exceptions", d.xs.id).superseded_at)).toBe(Date.parse(d.xs.supersededAt));
    expect(row(s, "exceptions", d.xs2.id).superseded_by_event_id).toBe(d.c.id);
    expect(row(s, "exceptions", d.xa.id).superseded_by_event_id).toBe(null);
  });

  it("original series remapped after a collision: successor and exceptions on it follow", async () => {
    const d = splitData(); const s = await setup(d.guest);
    await s.srv.other(A, [{ type: "upsert", table: "events", id: d.a.id, base_version: 0, data: { title: "אחר", date: "2026-01-01", start_min: 0, duration_min: 30 } }]);
    const p = await s.preview(); const to = derivedId(A, d.a.id);
    expect((await s.run(p)).status).toBe("verified");
    expect(row(s, "events", d.a.id).title).toBe("אחר");
    expect(row(s, "events", d.b.id).split_from_event_id).toBe(to);
    expect(row(s, "exceptions", d.xa.id).event_id).toBe(to); expect(row(s, "exceptions", d.xs.id).event_id).toBe(to);
  });

  it("replacement series remapped: superseded markers and its own exceptions follow", async () => {
    const d = splitData(); const s = await setup(d.guest);
    await s.srv.other(A, [{ type: "upsert", table: "events", id: d.b.id, base_version: 0, data: { title: "אחר", date: "2026-01-01", start_min: 0, duration_min: 30 } }]);
    const p = await s.preview(); const to = derivedId(A, d.b.id);
    expect((await s.run(p)).status).toBe("verified");
    expect(row(s, "exceptions", d.xs.id).superseded_by_event_id).toBe(to); expect(row(s, "exceptions", d.xb.id).event_id).toBe(to);
    expect(row(s, "exceptions", d.xs2.id).event_id).toBe(to); expect(row(s, "events", d.c.id).split_from_event_id).toBe(to);
  });

  it("circular, broken and missing split history is blocked before anything is written", async () => {
    const a = ev({ until: "2026-03-31" }), b = ev({ date: "2026-04-01", until: "2026-05-01" });
    a.splitFromEventId = b.id; b.splitFromEventId = a.id; a.date = "2026-01-01";
    const early = ev({ date: "2026-03-15", splitFromEventId: ev().id });
    const p0 = ev({ date: "2026-01-01", until: "2026-03-31" });
    const tooEarly = ev({ date: "2026-03-20", splitFromEventId: p0.id });
    const badSup = { id: uuid(), eventId: p0.id, originalDate: "2026-04-06", type: "skip", supersededByEventId: p0.id, supersededAt: "2026-03-20T00:00:00Z" };
    const s = await setup({ events: [a, b, early, p0, tooEarly], exceptions: [badSup] }); const pv = await s.preview();
    const why = Object.fromEntries(pv.invalid.map((i) => [i.id, i.reason]));
    expect(why[a.id]).toBe("circular-split"); expect(why[early.id]).toBe("missing-reference");
    expect(why[tooEarly.id]).toBe("invalid-split"); expect(why[badSup.id]).toBe("invalid-split");
    expect(pv.canMigrate).toBe(false); expect((await s.run(pv)).status).toBe("not-confirmed"); expect(s.srv.calls).toBe(0);
  });

  it("dropping an invalid parent also blocks everything that depends on it", async () => {
    const d = splitData(); d.a.title = ""; const s = await setup(d.guest); const p = await s.preview();
    const ids = p.invalid.map((i) => i.id);
    for (const x of [d.b, d.c, d.xa, d.xs, d.xb, d.xs2]) expect(ids).toContain(x.id);
  });

  it("references to another account's records are rejected", async () => {
    const s = await setup({ exceptions: [] });
    const foreign = uuid();
    await s.srv.other(B, [{ type: "upsert", table: "events", id: foreign, base_version: 0, data: { title: "B", date: "2026-01-01", until: "2026-03-31", start_min: 0, duration_min: 30 } }]);
    const child = ev({ date: "2026-04-01", splitFromEventId: foreign }), x = { id: uuid(), eventId: foreign, originalDate: "2026-01-05", type: "skip" };
    s.gkv.setItem(GUEST_KEY, JSON.stringify({ v: 1, categories: [], events: [child], exceptions: [x], availability: [] }));
    const p = await s.preview(); expect(p.invalid.map((i) => i.reason)).toEqual(["missing-reference", "missing-reference"]);
    // Even a hand-made request is refused by the server.
    const r = await s.t.apply([{ type: "migrate_insert", table: "events", id: child.id, base_version: 0, data: { title: "x", date: "2026-04-01", start_min: 0, duration_min: 30, split_from_event_id: foreign } }]);
    expect(r[0].status).toBe("invalid_reference");
  });

  it("without split support on the backend, split history is blocked (no acknowledgement option)", async () => {
    const d = splitData(); const s = await setup(d.guest);
    const p = previewMigration({ uid: A, guestKv: s.gkv, cloudKv: s.kv, cloud: await s.t.fetchAll(), resolutions: { acceptSplitLinkLoss: true, skipInvalid: true }, splitHistorySupported: false });
    expect(p.unresolved).toEqual([{ kind: "split-history-unsupported", count: 4 }]); expect(confirmMigration(p)).toBe(null);
  });

  it("interrupted between groups resumes; parents saved earlier stay intact", async () => {
    const d = splitData(); const s = await setup(d.guest); const p = await s.preview();
    let n = 0; const t = { ...s.t, apply: async (a) => { if (++n === 3) throw new PlannerNetworkError("offline"); return s.t.apply(a); } };
    expect((await s.run(p, { transport: t })).status).toBe("interrupted");
    expect(row(s, "events", d.a.id)).toBeTruthy(); expect(row(s, "events", d.b.id)).toBeTruthy(); expect(row(s, "events", d.c.id)).toBe(undefined);
    expect((await s.run(p)).status).toBe("verified");
    const again = await s.preview(); expect(again.canMigrate).toBe(false); expect(again.expected.alreadyPresent).toBe(7);
    expect((await s.run(p)).status).toBe("nothing-to-do"); expect(s.srv.user(A).events.size).toBe(3);
  });

  it("id taken by another account mid-run: earlier groups kept, the record and its dependents get the new id", async () => {
    const d = splitData(); const s = await setup(d.guest); const p = await s.preview();
    // Another account claims b's id and an exception id after the preview (invisible to this account).
    await s.srv.other(B, [{ type: "upsert", table: "events", id: d.b.id, base_version: 0, data: { title: "B", date: "2026-01-01", start_min: 0, duration_min: 30 } }]);
    await s.srv.other(B, [{ type: "upsert", table: "events", id: uuid(), base_version: 0, data: { title: "B2", date: "2026-01-01", start_min: 0, duration_min: 30 } }]);
    const bx = s.srv.user(B).events.get(d.b.id);
    const r = await s.run(p); expect(r.status).toBe("verified");
    const to = derivedId(A, d.b.id);
    expect(row(s, "events", to).split_from_event_id).toBe(d.a.id); expect(row(s, "events", d.c.id).split_from_event_id).toBe(to);
    expect(row(s, "exceptions", d.xs.id).superseded_by_event_id).toBe(to); expect(row(s, "exceptions", d.xb.id).event_id).toBe(to);
    expect(s.srv.user(B).events.get(d.b.id)).toEqual(bx);
    expect(JSON.parse(s.kv.getItem(migrationKey(A))).remaps).toEqual({ [d.b.id]: to });
  });

  it("an exception id taken by another account is remapped too", async () => {
    const d = splitData(); const s = await setup(d.guest); const p = await s.preview();
    await s.srv.other(B, [{ type: "upsert", table: "events", id: uuid(), base_version: 0, data: { title: "B", date: "2026-01-01", start_min: 0, duration_min: 30 } }]);
    const bev = [...s.srv.user(B).events.keys()][0];
    await s.srv.other(B, [{ type: "upsert", table: "exceptions", id: d.xs.id, base_version: 0, data: { event_id: bev, original_date: "2026-01-01", type: "skip" } }]);
    expect((await s.run(p)).status).toBe("verified");
    expect(row(s, "exceptions", derivedId(A, d.xs.id)).superseded_by_event_id).toBe(d.b.id);
  });

  it("a different existing record is never overwritten by migrate_insert", async () => {
    const d = splitData(); const s = await setup(d.guest); const p = await s.preview();
    await s.srv.other(A, [{ type: "upsert", table: "events", id: d.a.id, base_version: 0, data: { title: "שלי", date: "2026-01-01", start_min: 0, duration_min: 30 } }]);
    expect((await s.run(p)).status).toBe("preview-stale");
    // Even sent directly, the create-only save refuses to replace it.
    const r = await s.t.apply([p.actions.find((x) => x.id === d.a.id)]);
    expect(r[0].status).toBe("conflict");
    expect(row(s, "events", d.a.id).title).toBe("שלי");
  });
});
