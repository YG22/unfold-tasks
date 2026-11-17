// @ts-nocheck -- run with `bun test`
import { describe, expect, test } from "bun:test";
import { buildBackup, parseBackup } from "./backup";

const tasks = [
  { id: "t1", title: "לימודים", groupId: "g1", subtasks: [
    { id: "s1", title: "לקרוא פרק 3", done: true, dueDate: "2026-12-05", startAt: "2026-12-01T18:45", durationMin: 120 },
    { id: "s2", title: "תרגיל", done: false, dueDate: null, startAt: "2026-12-02", durationMin: null },
  ] },
  { id: "t2", title: "כללי", groupId: null, subtasks: [] },
];
const groups = [{ id: "g1", title: "סמסטר א׳" }];

describe("backup", () => {
  test("round-trip keeps everything, incl. Hebrew and scheduling", () => {
    const r = parseBackup(JSON.stringify(buildBackup(tasks, groups)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tasks).toEqual(tasks);
    expect(r.groups).toEqual(groups);
    expect(r.subtaskCount).toBe(2);
  });
  test("rejects non-JSON", () => expect(parseBackup("abc").ok).toBe(false));
  test("rejects file from another app", () => expect(parseBackup('{"tasks":[],"groups":[]}').ok).toBe(false));
  test("rejects bad start time", () => {
    const b = buildBackup([{ ...tasks[1], subtasks: [{ id: "x", title: "a", done: false, startAt: "2026-12-01T25:00" }] }], []);
    expect(parseBackup(JSON.stringify(b)).ok).toBe(false);
  });
  test("rejects unknown group", () => {
    expect(parseBackup(JSON.stringify(buildBackup([{ ...tasks[1], groupId: "nope" }], []))).ok).toBe(false);
  });
});
