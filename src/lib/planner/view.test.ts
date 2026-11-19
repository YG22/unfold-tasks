// @ts-nocheck -- run with `bun test`
import { describe, expect, it } from "bun:test";
import { emptyData, toRow } from "./data";
import { layoutDays, calendarWeek, assignLanes, hebrewWeekday } from "./view";
import { readGuestPlanner, readCloudPlanner, fromSnapshot } from "./source";
import { GUEST_KEY } from "./guest";
import { addDays } from "./time";

const TZ = "Asia/Jerusalem";
const ev = (o) => ({ id: "e1", title: "פגישה", categoryBuiltin: "builtin:work", date: "2026-11-15", startMin: 540, durationMin: 60, weekdays: null, until: null, travelBeforeMin: 0, travelAfterMin: 0, notes: null, splitFromEventId: null, ...o });
const data = (o) => ({ ...emptyData(), ...o });
const writesKV = (store = {}) => { const kv = { writes: 0, getItem: (k) => store[k] ?? null, setItem: () => { kv.writes++; }, removeItem: () => { kv.writes++; } }; return kv; };

describe("week navigation and order", () => {
  it("weeks start on Sunday and list seven days in order", () => {
    const w = calendarWeek("2026-11-19"); // Thursday
    expect(w).toEqual(["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"]);
    expect(hebrewWeekday(w[0])).toBe("ראשון");
    expect(hebrewWeekday(w[6])).toBe("שבת");
  });
  it("previous/next week and day move by 7 and 1 days, across month ends", () => {
    expect(calendarWeek(addDays("2026-11-19", 7))[0]).toBe("2026-11-22");
    expect(calendarWeek(addDays("2026-11-19", -7))[0]).toBe("2026-11-08");
    expect(calendarWeek("2026-12-01")[0]).toBe("2026-11-29");
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
  });
});

describe("layout", () => {
  it("positions an event by start and end time with its category colour", () => {
    const l = layoutDays(data({ events: [ev({})] }), ["2026-11-15"], TZ)["2026-11-15"];
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ top: 540, bottom: 600, startLabel: "09:00", endLabel: "10:00", color: "blue", lanes: 1 });
  });
  it("weekly recurrence shows on its weekdays; skip and change exceptions apply, superseded ones do not", () => {
    const e = ev({ weekdays: [0, 2], date: "2026-11-01" });
    const ex = [
      { id: "x1", eventId: "e1", originalDate: "2026-11-15", type: "skip" },
      { id: "x2", eventId: "e1", originalDate: "2026-11-17", type: "change", newDate: "2026-11-18", newStartMin: 600, newDurationMin: 30 },
      { id: "x3", eventId: "e1", originalDate: "2026-11-22", type: "skip", supersededByEventId: "e2" },
    ];
    const week = layoutDays(data({ events: [e], exceptions: ex }), calendarWeek("2026-11-15"), TZ);
    expect(week["2026-11-15"]).toHaveLength(0);
    expect(week["2026-11-17"]).toHaveLength(0);
    expect(week["2026-11-18"][0]).toMatchObject({ top: 600, bottom: 630 });
    const next = layoutDays(data({ events: [e], exceptions: ex }), ["2026-11-22"], TZ);
    expect(next["2026-11-22"]).toHaveLength(1);
  });
  it("overnight events are drawn on both days and marked as continuing", () => {
    const w = layoutDays(data({ events: [ev({ startMin: 1380, durationMin: 120 })] }), ["2026-11-15", "2026-11-16"], TZ);
    expect(w["2026-11-15"][0]).toMatchObject({ top: 1380, bottom: 1440, continuesToNext: true, startLabel: "23:00", endLabel: "01:00" });
    expect(w["2026-11-16"][0]).toMatchObject({ top: 0, bottom: 60, continuesFromPrev: true });
  });
  it("day view shows the part of an event that began the previous evening", () => {
    const d = layoutDays(data({ events: [ev({ startMin: 1380, durationMin: 120 })] }), ["2026-11-16"], TZ);
    expect(d["2026-11-16"][0]).toMatchObject({ top: 0, bottom: 60, continuesFromPrev: true });
  });
  it("overlapping events sit side by side; non-overlapping ones keep full width", () => {
    const l = layoutDays(data({ events: [ev({ id: "a" }), ev({ id: "b", startMin: 570 }), ev({ id: "c", startMin: 720 })] }), ["2026-11-15"], TZ)["2026-11-15"];
    const by = Object.fromEntries(l.map((b) => [b.eventId, b]));
    expect([by.a.lanes, by.b.lanes, by.c.lanes]).toEqual([2, 2, 1]);
    expect(by.a.lane).not.toBe(by.b.lane);
  });
  it("back-to-back events do not count as overlapping", () => {
    const l = assignLanes([{ key: "1", top: 0, bottom: 60 }, { key: "2", top: 60, bottom: 120 }]);
    expect(l.map((b) => b.lanes)).toEqual([1, 1]);
  });
  it("empty data gives empty days", () => {
    const w = layoutDays(emptyData(), calendarWeek("2026-11-15"), TZ);
    expect(Object.values(w).every((d) => d.length === 0)).toBe(true);
  });
});

describe("timezone and DST display", () => {
  it("other time zones use their own local times", () => {
    const l = layoutDays(data({ events: [ev({})] }), ["2026-11-15"], "America/New_York")["2026-11-15"];
    expect(l[0]).toMatchObject({ startLabel: "09:00", endLabel: "10:00", top: 540 });
  });
  it("a recurring occurrence in the spring gap shows as reserved time from 03:00, not as a moved event", () => {
    const l = layoutDays(data({ events: [ev({ date: "2026-03-01", weekdays: [5], startMin: 150, durationMin: 60 })] }), ["2026-03-27"], TZ)["2026-03-27"];
    expect(l).toHaveLength(1);
    expect(l[0].status).toBe("reserved");
    expect(l[0].startLabel).toBe("03:00");
  });
  it("on the autumn 25-hour day an evening event keeps its wall-clock labels and stays inside the day", () => {
    const l = layoutDays(data({ events: [ev({ date: "2026-10-25", startMin: 1320, durationMin: 60 })] }), ["2026-10-25"], TZ)["2026-10-25"];
    expect(l[0]).toMatchObject({ startLabel: "22:00", endLabel: "23:00" });
    expect(l[0].bottom).toBeLessThanOrEqual(1440);
  });
});

describe("read-only loading", () => {
  it("guest reads the guest key and never writes, even when data is unreadable", () => {
    const kv = writesKV({ [GUEST_KEY]: JSON.stringify({ v: 1, events: [ev({ id: "11111111-1111-4111-8111-111111111111" })] }) });
    const r = readGuestPlanner(kv);
    expect(r.data.events).toHaveLength(1);
    const bad = writesKV({ [GUEST_KEY]: "{broken" });
    expect(readGuestPlanner(bad).unreadable).toBe(true);
    expect(kv.writes + bad.writes).toBe(0);
  });
  it("guest with no planner data sees an empty planner", () => {
    expect(readGuestPlanner(writesKV()).data.events).toEqual([]);
  });
  const snap = (events) => ({ categories: [], exceptions: [], availability: [], settings: null, events });
  it("signed-in reads use fetchAll only, leave out deleted rows, and never call apply", async () => {
    let applied = 0;
    const t = { fetchAll: async () => snap([{ ...toRow("events", ev({ id: "a" })), version: 1 }, { ...toRow("events", ev({ id: "b" })), version: 2, deleted_at: "2026-11-01T00:00:00Z" }]), apply: async () => { applied++; return []; } };
    const r = await readCloudPlanner(t);
    expect(r.data.events.map((e) => e.id)).toEqual(["a"]);
    expect(applied).toBe(0);
  });
  it("each account reads only its own records (switching accounts reads the new account)", async () => {
    const rows = { u1: [toRow("events", ev({ id: "one" }))], u2: [toRow("events", ev({ id: "two" }))] };
    const tFor = (uid) => ({ fetchAll: async () => snap(rows[uid]) });
    expect((await readCloudPlanner(tFor("u1"))).data.events[0].id).toBe("one");
    expect((await readCloudPlanner(tFor("u2"))).data.events[0].id).toBe("two");
  });
  it("a failed cloud read is reported as an error", async () => {
    await expect(readCloudPlanner({ fetchAll: async () => { throw new Error("offline"); } })).rejects.toThrow("offline");
  });
  it("settings timezone is read from the cloud row", () => {
    expect(fromSnapshot({ ...snap([]), settings: { default_view: "day", suggestion_days_off: [], timezone: "Asia/Tokyo" } }).settings.timezone).toBe("Asia/Tokyo");
  });
});
