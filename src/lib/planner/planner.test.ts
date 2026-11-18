// @ts-nocheck -- run with `bun test`
import { describe, expect, it } from "bun:test";
import { checkLocal, dueBoundaryUtc, merge, overlaps, splitByDay, subtract, weekStart, weekDates, toLocal } from "./time";
import { expand, splitSeries, travelConflicts, travelBlocks, placeSubtask, busyItems, suggest, validateEvent, validateManualTime, availabilityWindows, freeTime, resolveCategory, conflictsFor } from "./model";
import { wallToUtc } from "../reminders";

const TZ = "Asia/Jerusalem";
const iso = (t) => new Date(t).toISOString();
const loc = (t) => { const l = toLocal(t, TZ); return `${l.date} ${l.time}`; };
const at = (d, t) => checkLocal(d, t, TZ).utc;
const ev = (o) => ({ id: "e1", title: "x", date: "2026-03-01", startTime: "09:00", durationMin: 60, ...o });

describe("time & DST", () => {
  it("B1 normal winter/summer times", () => {
    expect(iso(at("2026-01-15", "09:00"))).toBe("2026-01-15T07:00:00.000Z");
    expect(iso(at("2026-07-15", "09:00"))).toBe("2026-07-15T06:00:00.000Z");
  });
  it("B2 spring gap 27 Mar 2026 02:30 is nonexistent; first valid is 03:00", () => {
    const c = checkLocal("2026-03-27", "02:30", TZ);
    expect(c.status).toBe("nonexistent");
    expect(loc(c.firstValidUtc)).toBe("2026-03-27 03:00");
  });
  it("B3 autumn 25 Oct 2026 01:30 is ambiguous; resolves to second (matches reminders)", () => {
    const c = checkLocal("2026-10-25", "01:30", TZ);
    expect(c.status).toBe("ambiguous");
    expect(c.second - c.first).toBe(3600_000);
    expect(c.utc).toBe(wallToUtc("2026-10-25", "01:30", TZ).getTime());
  });
  it("B4 half-open intervals: touching does not overlap", () => {
    expect(overlaps({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
    expect(overlaps({ start: 0, end: 11 }, { start: 10, end: 20 })).toBe(true);
  });
  it("B5 merge and subtract", () => {
    expect(merge([{ start: 5, end: 8 }, { start: 0, end: 5 }, { start: 10, end: 12 }])).toEqual([{ start: 0, end: 8 }, { start: 10, end: 12 }]);
    expect(subtract({ start: 0, end: 20 }, [{ start: 5, end: 8 }])).toEqual([{ start: 0, end: 5 }, { start: 8, end: 20 }]);
  });
  it("B6 crossing midnight splits into two pieces", () => {
    const s = at("2026-05-10", "23:30");
    const p = splitByDay({ start: s, end: s + 60 * 60000 }, TZ);
    expect(p.map((x) => x.date)).toEqual(["2026-05-10", "2026-05-11"]);
    expect(loc(p[0].end)).toBe("2026-05-11 00:00");
  });
  it("B7 week starts Sunday", () => {
    expect(weekStart("2026-11-18")).toBe("2026-11-15");
    expect(weekDates("2026-11-15")[6]).toBe("2026-11-21");
  });
  it("B8 due boundary is next local midnight", () => {
    expect(loc(dueBoundaryUtc("2026-03-10", TZ))).toBe("2026-03-11 00:00");
  });
});

describe("events & recurrence", () => {
  const weekly = ev({ weekdays: [0, 2] }); // Sun, Tue
  it("B9 weekly expansion with stable keys", () => {
    const o = expand([weekly], [], "2026-03-01", "2026-03-08", TZ);
    expect(o.map((x) => x.key)).toEqual(["e1:2026-03-01", "e1:2026-03-03"]);
  });
  it("B10 skip exception removes one occurrence", () => {
    const o = expand([weekly], [{ eventId: "e1", originalDate: "2026-03-03", type: "skip" }], "2026-03-01", "2026-03-08", TZ);
    expect(o.length).toBe(1);
  });
  it("B11 moved occurrence shows only on new date, keeps original key", () => {
    const x = [{ eventId: "e1", originalDate: "2026-03-03", type: "change", date: "2026-03-04", startTime: "10:00" }];
    const o = expand([weekly], x, "2026-03-01", "2026-03-08", TZ);
    expect(o.map((k) => [k.key, k.date, k.status])).toEqual([["e1:2026-03-01", "2026-03-01", "normal"], ["e1:2026-03-03", "2026-03-04", "moved"]]);
  });
  it("B12 moved into range from outside, no duplicates", () => {
    const x = [{ eventId: "e1", originalDate: "2026-03-08", type: "change", date: "2026-03-07" }];
    const o = expand([weekly], x, "2026-03-01", "2026-03-08", TZ);
    expect(o.map((k) => k.key)).toEqual(["e1:2026-03-01", "e1:2026-03-03", "e1:2026-03-08"]);
    expect(expand([weekly], x, "2026-03-08", "2026-03-15", TZ).some((k) => k.key === "e1:2026-03-08")).toBe(false);
  });
  it("B13 split from date X partitions series and exceptions", () => {
    const x = [{ eventId: "e1", originalDate: "2026-03-03", type: "skip" }, { eventId: "e1", originalDate: "2026-03-10", type: "skip" }];
    const r = splitSeries(weekly, x, "2026-03-08", "e2", { startTime: "11:00" });
    expect(r.before.until).toBe("2026-03-07");
    expect(r.after.date).toBe("2026-03-08");
    expect(r.keptExceptions.length).toBe(1);
    expect(r.droppedExceptions.length).toBe(1);
    const o = expand([r.before, r.after], r.keptExceptions, "2026-03-01", "2026-03-15", TZ);
    expect(o.map((k) => k.key)).toEqual(["e1:2026-03-01", "e2:2026-03-08", "e2:2026-03-10"]);
  });
  it("B14 one-time event at nonexistent time or zero duration is rejected", () => {
    expect(validateEvent(ev({ date: "2026-03-27", startTime: "02:30" }), TZ)).toContain("nonexistent-time");
    expect(validateEvent(ev({ durationMin: 0 }), TZ)).toContain("duration");
    expect(validateManualTime("2026-03-27", "02:30", TZ).ok).toBe(false);
    expect(validateManualTime("2026-10-25", "01:30", TZ)).toEqual({ ok: true, note: "ambiguous-second" });
  });
  it("B15 invalid recurring spring occurrence gets protective reservation 03:00–04:00, not a move", () => {
    const fri = ev({ date: "2026-03-20", startTime: "02:30", weekdays: [5] });
    const o = expand([fri], [], "2026-03-27", "2026-03-28", TZ)[0];
    expect(o.status).toBe("invalid");
    expect(o.interval).toBe(null);
    expect(o.startTime).toBe("02:30");
    expect(o.reservation.reason).toBe("invalid-recurring-dst");
    expect([loc(o.reservation.start), loc(o.reservation.end)]).toEqual(["2026-03-27 03:00", "2026-03-27 04:00"]);
  });
  it("B16 user resolves invalid occurrence with a single-occurrence change", () => {
    const fri = ev({ date: "2026-03-20", startTime: "02:30", weekdays: [5] });
    const o = expand([fri], [{ eventId: "e1", originalDate: "2026-03-27", type: "change", startTime: "04:00" }], "2026-03-27", "2026-03-28", TZ)[0];
    expect(o.status).toBe("moved");
    expect(o.reservation).toBe(null);
  });
  it("B17 autumn ambiguous occurrence uses real elapsed time", () => {
    const o = expand([ev({ date: "2026-10-25", startTime: "01:30", durationMin: 60 })], [], "2026-10-25", "2026-10-26", TZ)[0];
    expect(o.status).toBe("ambiguous");
    expect(o.interval.end - o.interval.start).toBe(3600_000);
  });
});

describe("travel", () => {
  const a = ev({ id: "a", startTime: "09:00", durationMin: 60, travelAfterMin: 20 });
  const b = ev({ id: "b", startTime: "10:30", durationMin: 60, travelBeforeMin: 15 });
  it("B18 travel blocks keep their source", () => {
    const o = expand([a], [], "2026-03-01", "2026-03-02", TZ)[0];
    expect(travelBlocks(o, a)).toEqual([{ start: o.interval.end, end: o.interval.end + 20 * 60000, sourceKey: "a:2026-03-01", side: "after" }]);
  });
  it("B19 after+before > gap → possible conflict (sum, not max)", () => {
    const o = expand([a, b], [], "2026-03-01", "2026-03-02", TZ);
    const c = travelConflicts(o, [a, b]);
    expect(c).toEqual([{ kind: "possible-travel-conflict", fromKey: "a:2026-03-01", toKey: "b:2026-03-01", gapMin: 30, requiredMin: 35, travelAfterMin: 20, travelBeforeMin: 15 }]);
  });
  it("B20 sum exactly equal to gap is not a conflict", () => {
    const b2 = { ...b, travelBeforeMin: 10 };
    expect(travelConflicts(expand([a, b2], [], "2026-03-01", "2026-03-02", TZ), [a, b2])).toEqual([]);
  });
  it("B21 skipped occurrence has no travel and no conflict", () => {
    const o = expand([a, b], [{ eventId: "b", originalDate: "2026-03-01", type: "skip" }], "2026-03-01", "2026-03-02", TZ);
    expect(travelConflicts(o, [a, b])).toEqual([]);
  });
});

describe("tasks, busy time, suggestions", () => {
  const sub = (o) => ({ id: "s1", title: "t", done: false, ...o });
  it("B22 date+time on calendar; date-only or nothing in drawer", () => {
    expect(placeSubtask(sub({ startAt: "2026-05-10T09:00" }), TZ).place).toBe("calendar");
    expect(placeSubtask(sub({ dueDate: "2026-05-10" }), TZ).place).toBe("drawer");
    expect(placeSubtask(sub({}), TZ).place).toBe("drawer");
  });
  it("B23 missing duration uses 30-min display fallback without mutating", () => {
    const s = sub({ startAt: "2026-05-10T09:00" });
    const p = placeSubtask(s, TZ);
    expect([p.durationMin, p.durationIsFallback]).toEqual([30, true]);
    expect(s.durationMin).toBe(undefined);
  });
  it("B24 completed subtask stays on calendar and occupies time", () => {
    const p = placeSubtask(sub({ done: true, startAt: "2026-05-10T09:00", durationMin: 45 }), TZ);
    const items = busyItems([], [], [p]);
    expect(items.length).toBe(1);
    expect(conflictsFor({ start: at("2026-05-10", "09:30"), end: at("2026-05-10", "10:00") }, items).length).toBe(1);
  });
  it("B25 busy includes protective reservation and travel", () => {
    const fri = ev({ date: "2026-03-20", startTime: "02:30", weekdays: [5], travelBeforeMin: 10 });
    const o = expand([fri], [], "2026-03-27", "2026-03-28", TZ);
    expect(busyItems(o, [fri], []).map((b) => b.source)).toEqual(["e1:2026-03-27", "e1:2026-03-27:travel-before"]);
  });
  const avail = [0, 1, 2, 3, 4, 5, 6].map((w) => ({ weekday: w, startTime: "08:00", endTime: "12:00" }));
  const base = { now: at("2026-05-10", "00:00"), from: "2026-05-10", days: 3, tz: TZ, availability: avail, busy: [], max: 3 };
  it("B26 no saved duration → no suggestions", () => {
    expect(suggest({ ...base, durationMin: null })).toEqual([]);
  });
  it("B27 suggestions on 15-minute grid, earliest first, skip busy", () => {
    const busy = [{ start: at("2026-05-10", "08:00"), end: at("2026-05-10", "09:10") }];
    expect(suggest({ ...base, durationMin: 30, busy }).map((s) => s.time)).toEqual(["09:15", "09:30", "09:45"]);
  });
  it("B28 not in the past; next grid step after now", () => {
    expect(suggest({ ...base, durationMin: 30, now: at("2026-05-10", "08:07") })[0].time).toBe("08:15");
  });
  it("B29 must fit window: 60 min last start 11:00", () => {
    const r = suggest({ ...base, durationMin: 60, days: 1, max: 50 });
    expect(r[r.length - 1].time).toBe("11:00");
  });
  it("B30 off days skipped", () => {
    const r = suggest({ ...base, availability: [{ weekday: 1, startTime: "08:00", endTime: "12:00" }], durationMin: 30, max: 1 });
    expect(r[0].date).toBe("2026-05-11");
  });
  it("B31 due date uses real end incl. midnight: end at 00:00 allowed, 00:15 not", () => {
    const late = [{ weekday: 0, startTime: "22:00", endTime: "24:00" }, { weekday: 1, startTime: "00:00", endTime: "02:00" }];
    const now = at("2026-05-10", "22:00");
    const r = suggest({ ...base, now, availability: late, durationMin: 60, dueDate: "2026-05-10", max: 50 });
    expect(r.map((s) => s.time)).toEqual(["22:00", "22:15", "22:30", "22:45", "23:00"]);
    const r2 = suggest({ ...base, now, availability: late, durationMin: 60, dueDate: "2026-05-11", max: 50, days: 1 });
    expect(r2.map((s) => s.time)).toContain("23:30"); // crosses midnight inside merged window
  });
  it("B32 suggestions skip spring gap and autumn repeated hour", () => {
    const night = [{ weekday: 5, startTime: "00:00", endTime: "06:00" }, { weekday: 0, startTime: "00:00", endTime: "06:00" }];
    const spring = suggest({ ...base, now: 0, from: "2026-03-27", days: 1, availability: night, durationMin: 15, max: 50 }).map((s) => s.time);
    expect(spring.some((t) => t.startsWith("02:"))).toBe(false);
    expect(spring).toContain("03:00");
    const autumn = suggest({ ...base, now: 0, from: "2026-10-25", days: 1, availability: night, durationMin: 15, max: 50 }).map((s) => s.time);
    expect(autumn.some((t) => t.startsWith("01:"))).toBe(false);
    expect(autumn).toContain("02:00");
  });
  it("B33 free time = availability minus busy", () => {
    const w = availabilityWindows(avail, "2026-05-10", "2026-05-11", TZ);
    const f = freeTime(w, [{ start: at("2026-05-10", "09:00"), end: at("2026-05-10", "10:00") }]);
    expect(f.map((i) => [loc(i.start), loc(i.end)])).toEqual([["2026-05-10 08:00", "2026-05-10 09:00"], ["2026-05-10 10:00", "2026-05-10 12:00"]]);
  });
  it("B35 existing subtask at spring-gap time matches reminder instant, data unchanged", () => {
    const s = sub({ startAt: "2026-03-27T02:30", durationMin: 60 });
    const p = placeSubtask(s, TZ);
    expect(p.interval.start).toBe(wallToUtc("2026-03-27", "02:30", TZ).getTime());
    expect([loc(p.interval.start), loc(p.interval.end)]).toEqual(["2026-03-27 03:30", "2026-03-27 04:30"]);
    expect(p.invalidTime).toBe(true);
    expect([s.startAt, s.durationMin, p.durationMin]).toEqual(["2026-03-27T02:30", 60, 60]);
    expect(validateManualTime("2026-03-27", "02:30", TZ).ok).toBe(false);
    const r = expand([ev({ date: "2026-03-20", startTime: "02:30", weekdays: [5] })], [], "2026-03-27", "2026-03-28", TZ)[0].reservation;
    expect([loc(r.start), loc(r.end)]).toEqual(["2026-03-27 03:00", "2026-03-27 04:00"]);
  });
  it("B34 categories: built-in, custom, deleted → ללא קטגוריה", () => {
    expect(resolveCategory("work", []).name).toBe("עבודה");
    expect(resolveCategory("c1", [{ id: "c1", name: "ספורט", color: "rose" }]).name).toBe("ספורט");
    expect(resolveCategory("gone", []).name).toBe("ללא קטגוריה");
  });
});

describe("edge cases (9B.1 final)", () => {
  const NY = "America/New_York", TK = "Asia/Tokyo";
  const sub = (o) => ({ id: "s1", title: "t", done: false, ...o });
  const locz = (t, tz) => { const l = toLocal(t, tz); return `${l.date} ${l.time}`; };
  it("E1 other zones: New York DST and Tokyo without DST", () => {
    expect(iso(checkLocal("2026-01-15", "09:00", NY).utc)).toBe("2026-01-15T14:00:00.000Z");
    expect(iso(checkLocal("2026-07-15", "09:00", NY).utc)).toBe("2026-07-15T13:00:00.000Z");
    const g = checkLocal("2026-03-08", "02:30", NY);
    expect(g.status).toBe("nonexistent");
    expect(locz(g.firstValidUtc, NY)).toBe("2026-03-08 03:00");
    const a = checkLocal("2026-11-01", "01:30", NY);
    expect([a.status, a.second - a.first, iso(a.utc)]).toEqual(["ambiguous", 3600_000, "2026-11-01T06:30:00.000Z"]);
    expect(iso(checkLocal("2026-03-29", "02:30", TK).utc)).toBe("2026-03-28T17:30:00.000Z");
    expect(["2026-03-08", "2026-03-27", "2026-10-25", "2026-11-01"].every((d) => checkLocal(d, "02:30", TK).status === "normal")).toBe(true);
  });
  it("E2 weekly series across spring and autumn keeps 09:00 local with correct UTC", () => {
    const fri = ev({ date: "2026-03-20", startTime: "09:00", weekdays: [5], until: "2026-10-30" });
    const o = [...expand([fri], [], "2026-03-20", "2026-03-28", TZ), ...expand([fri], [], "2026-10-23", "2026-11-07", TZ)];
    expect(o.map((x) => iso(x.interval.start))).toEqual(["2026-03-20T07:00:00.000Z", "2026-03-27T06:00:00.000Z", "2026-10-23T06:00:00.000Z", "2026-10-30T07:00:00.000Z"]);
    expect(o.every((x) => x.status === "normal" && x.interval.end - x.interval.start === 3600_000)).toBe(true);
  });
  it("E3 task starting in repeated autumn hour and ending after it", () => {
    const p = placeSubtask(sub({ startAt: "2026-10-25T01:30", durationMin: 60 }), TZ);
    expect(p.interval.start).toBe(wallToUtc("2026-10-25", "01:30", TZ).getTime());
    expect([iso(p.interval.start), loc(p.interval.end), p.invalidTime]).toEqual(["2026-10-24T23:30:00.000Z", "2026-10-25 02:30", false]);
    const q = placeSubtask(sub({ startAt: "2026-10-25T01:45", durationMin: 30 }), TZ);
    expect(loc(q.interval.end)).toBe("2026-10-25 02:15");
  });
  it("E4 availability ending inside the spring gap ends at the transition", () => {
    const rules = [{ weekday: 5, startTime: "00:00", endTime: "02:30" }];
    const w = availabilityWindows(rules, "2026-03-27", "2026-03-28", TZ);
    expect(w.length).toBe(1);
    expect((w[0].end - w[0].start) / 60000).toBe(120);
    expect(loc(w[0].end)).toBe("2026-03-27 03:00");
    const r = suggest({ now: 0, from: "2026-03-27", days: 1, tz: TZ, availability: rules, busy: [], durationMin: 60, max: 50 }).map((s) => s.time);
    expect(r).toEqual(["00:00", "00:15", "00:30", "00:45", "01:00"]);
  });
  it("E5 split on a date that already has a single-occurrence exception", () => {
    const weekly = ev({ weekdays: [0, 2] });
    const x = [{ eventId: "e1", originalDate: "2026-03-10", type: "change", startTime: "15:00" }, { eventId: "e1", originalDate: "2026-03-03", type: "skip" }];
    const r = splitSeries(weekly, x, "2026-03-10", "e2", { startTime: "11:00" });
    expect(r.droppedExceptions.map((d) => d.originalDate)).toEqual(["2026-03-10"]);
    expect(r.keptExceptions.map((d) => d.originalDate)).toEqual(["2026-03-03"]);
    const o = expand([r.before, r.after], r.keptExceptions, "2026-03-01", "2026-03-15", TZ);
    expect(o.map((k) => [k.key, k.startTime, k.status])).toEqual([["e1:2026-03-01", "09:00", "normal"], ["e1:2026-03-08", "09:00", "normal"], ["e2:2026-03-10", "11:00", "normal"]]);
  });
  it("E6 calendar placement equals reminder conversion for every 15 min on DST days (IL, Tokyo)", () => {
    // New York is excluded here: the app's wallToUtc helper differs from the database reminder job there (reported defect); see E7.
    const days = { [TZ]: ["2026-03-27", "2026-10-25"], [TK]: ["2026-03-27"] };
    const bad = [];
    for (const [tz, ds] of Object.entries(days)) for (const d of ds) for (let m = 0; m < 1440; m += 15) {
      const t = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const p = placeSubtask(sub({ startAt: `${d}T${t}`, durationMin: 45 }), tz);
      if (p.interval.start !== wallToUtc(d, t, tz).getTime() || p.durationMin !== 45) bad.push(`${tz} ${d} ${t}`);
    }
    expect(bad).toEqual([]);
  });
  it("E7 New York placement matches the database reminder job (Postgres AT TIME ZONE, checked 2026-11-18)", () => {
    const at = (d, t) => iso(placeSubtask(sub({ startAt: `${d}T${t}`, durationMin: 45 }), NY).interval.start);
    expect(at("2026-03-08", "02:30")).toBe("2026-03-08T07:30:00.000Z");
    expect(at("2026-11-01", "01:30")).toBe("2026-11-01T06:30:00.000Z");
  });
});
