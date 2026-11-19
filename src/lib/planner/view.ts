// Read-only calendar layout for the planner screens: turns planner data into positioned blocks per local day.
// Pure; uses expand() for recurrence/exceptions and splitByDay() for overnight items. Never writes anything.
import type { PlannerData } from "./data";
import { eventCategory, expand, type Occurrence } from "./model";
import { addDays, dayStartUtc, MIN, splitByDay, toLocal, weekDates } from "./time";

export type CalendarBlock = {
  key: string; eventId: string; originalDate: string; recurring: boolean; title: string; color: string; categoryName: string;
  date: string; // local day this piece is drawn on
  top: number; bottom: number; // minutes from that day's local midnight (bottom may be 1440)
  startLabel: string; endLabel: string; // real local wall-clock start/end of the whole occurrence
  continuesFromPrev: boolean; continuesToNext: boolean;
  status: Occurrence["status"] | "reserved"; lane: number; lanes: number;
};

/** Sunday-first dates of the week containing `date`. */
export const calendarWeek = (date: string) => weekDates(date);

/** Minutes since local midnight for an instant on its local day; handles DST days by measuring real elapsed minutes. */
const minutesInto = (t: number, date: string, tz: string) => Math.round((t - dayStartUtc(date, tz)) / MIN);

export function layoutDays(data: PlannerData, dates: string[], tz: string): Record<string, CalendarBlock[]> {
  const out: Record<string, CalendarBlock[]> = Object.fromEntries(dates.map((d) => [d, []]));
  if (!dates.length) return out;
  const sorted = [...dates].sort();
  // One extra day before so occurrences that start the previous evening still show after midnight.
  const occs = expand(data.events, data.exceptions, addDays(sorted[0]!, -1), addDays(sorted[sorted.length - 1]!, 1), tz);
  const byId = new Map(data.events.map((e) => [e.id, e]));
  for (const o of occs) {
    const e = byId.get(o.eventId); if (!e) continue;
    const span = o.interval ?? o.reservation; if (!span || span.end <= span.start) continue;
    const cat = eventCategory(e, data.categories);
    const startLabel = toLocal(span.start, tz).time, endLabel = toLocal(span.end, tz).time;
    for (const piece of splitByDay(span, tz)) {
      const list = out[piece.date]; if (!list) continue;
      const len = Math.round((dayStartUtc(addDays(piece.date, 1), tz) - dayStartUtc(piece.date, tz)) / MIN);
      const top = minutesInto(piece.start, piece.date, tz), rawBottom = minutesInto(piece.end, piece.date, tz);
      // Scale DST days (23h/25h) onto the 24h grid so the bottom of the day stays at midnight.
      const scale = 1440 / len;
      list.push({
        key: `${o.key}@${piece.date}`, eventId: e.id, originalDate: o.originalDate, recurring: !!e.weekdays?.length, title: e.title, color: cat.color, categoryName: cat.name, date: piece.date,
        top: Math.round(top * scale), bottom: Math.round(rawBottom * scale), startLabel, endLabel,
        continuesFromPrev: piece.start > span.start, continuesToNext: piece.end < span.end,
        status: o.interval ? o.status : "reserved", lane: 0, lanes: 1,
      });
    }
  }
  for (const d of dates) assignLanes(out[d]!);
  return out;
}

/** Side-by-side columns for overlapping blocks; each cluster of overlapping blocks shares one lane count. */
export function assignLanes(blocks: CalendarBlock[]) {
  blocks.sort((a, b) => a.top - b.top || b.bottom - a.bottom || a.key.localeCompare(b.key));
  let cluster: CalendarBlock[] = []; let laneEnds: number[] = []; let clusterEnd = -1;
  const close = () => { for (const b of cluster) b.lanes = laneEnds.length; cluster = []; laneEnds = []; };
  for (const b of blocks) {
    if (b.top >= clusterEnd) { close(); clusterEnd = -1; }
    let lane = laneEnds.findIndex((end) => end <= b.top);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(b.bottom); } else laneEnds[lane] = b.bottom;
    b.lane = lane; cluster.push(b); clusterEnd = Math.max(clusterEnd, b.bottom);
  }
  close();
  return blocks;
}

const HE_DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
export const hebrewWeekday = (date: string) => HE_DAYS[new Date(date + "T00:00:00Z").getUTCDay()]!;
export const shortDate = (date: string) => { const [, m, d] = date.split("-"); return `${Number(d)}.${Number(m)}`; };
