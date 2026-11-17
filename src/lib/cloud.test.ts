// @ts-nocheck -- fixture indexing in tests
import { describe, expect, it } from "bun:test";
import { diff, fromRows, isEmpty, normalizeIds, rebase, toRows, verifyContains } from "./cloud";

const st = {
  groups: [{ id: "g1", title: "לימודים" }],
  tasks: [
    { id: "a", title: "מתמטיקה", groupId: "g1", subtasks: [
      { id: "s1", title: "תרגיל", done: true, dueDate: "2026-11-20", startAt: "2026-11-18T09:30", durationMin: 45 },
      { id: "s2", title: "קריאה", done: false, dueDate: null, startAt: "2026-11-19", durationMin: null },
    ] },
    { id: "b", title: "כללי", groupId: null, subtasks: [] },
  ],
};

describe("cloud mapping", () => {
  it("round-trips order, status and scheduling", () => {
    expect(fromRows(toRows(st))).toEqual(st);
  });
  it("maps db time HH:mm:ss back to HH:mm", () => {
    const r = toRows(st);
    r.subtasks[0].start_time = "09:30:00";
    expect(fromRows(r).tasks[0].subtasks[0].startAt).toBe("2026-11-18T09:30");
  });
  it("diff detects delete and reorder only", () => {
    const next = { ...st, tasks: [st.tasks[1], { ...st.tasks[0], subtasks: [st.tasks[0].subtasks[0]] }] };
    const c = diff(st, next);
    expect(c.delete_subtasks).toEqual(["s2"]);
    expect(c.lists.map((l) => l.id).sort()).toEqual(["a", "b"]);
    expect(isEmpty(diff(st, st))).toBe(true);
  });
  it("rebase keeps remote additions and local pending edits", () => {
    const remote = { ...st, tasks: [...st.tasks, { id: "c", title: "חדש", groupId: null, subtasks: [] }] };
    const local = { ...st, tasks: st.tasks.map((t) => (t.id === "b" ? { ...t, title: "שונה" } : t)) };
    const out = rebase(remote, diff(st, local));
    expect(out.tasks.map((t) => t.title)).toEqual(["מתמטיקה", "שונה", "חדש"]);
  });
  it("legacy ids map to the same uuid every time", async () => {
    const a = await normalizeIds(st), b = await normalizeIds(st);
    expect(a).toEqual(b);
    expect(a.tasks[0].groupId).toBe(a.groups[0].id);
    expect(verifyContains(toRows(a), a)).toBeNull();
  });
});
