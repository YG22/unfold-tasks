// Pure reminder helpers (shared by server and tests).
export const MAX_ATTEMPTS = 3;
export const retryDelayMs = (attempt: number) => 60_000 * attempt;

/** Convert wall-clock date+time in an IANA zone to a UTC instant (mirrors the SQL AT TIME ZONE rule). */
export function wallToUtc(date: string, time: string, tz: string): Date {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(t).map((x) => [x.type, x.value]));
    return Date.UTC(+p['year']!, +p['month']! - 1, +p['day']!, +p['hour']!, +p['minute']!) - t;
  };
  let t = guess - off(guess);
  t = guess - off(t);
  return new Date(t);
}

export function reminderPayload(r: { kind: string; title: string; subtask_id: string }) {
  const title = r.kind === "before" ? "בעוד 10 דקות" : r.kind === "start" ? "הגיע הזמן" : "תזכורת בדיקה";
  return { title, body: r.title, tag: `rem-${r.subtask_id}-${r.kind}`, url: "/" };
}
