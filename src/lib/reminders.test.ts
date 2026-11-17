// @ts-nocheck -- run with `bun test`
import { describe, expect, it } from "bun:test";
import { wallToUtc, reminderPayload, retryDelayMs } from "./reminders";

describe("reminders", () => {
  it("Jerusalem winter (UTC+2): 09:00 -> 07:00Z", () => {
    expect(wallToUtc("2026-01-15", "09:00", "Asia/Jerusalem").toISOString()).toBe("2026-01-15T07:00:00.000Z");
  });
  it("Jerusalem summer DST (UTC+3): 09:00 -> 06:00Z", () => {
    expect(wallToUtc("2026-07-15", "09:00", "Asia/Jerusalem").toISOString()).toBe("2026-07-15T06:00:00.000Z");
  });
  it("payload uses Hebrew titles per kind and a stable tag", () => {
    expect(reminderPayload({ kind: "before", title: "x", subtask_id: "a" }).title).toBe("בעוד 10 דקות");
    expect(reminderPayload({ kind: "start", title: "x", subtask_id: "a" }).tag).toBe("rem-a-start");
  });
  it("retry backoff grows", () => { expect(retryDelayMs(2)).toBe(120000); });
});
