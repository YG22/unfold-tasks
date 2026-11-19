// Read-only planner loading for the planner screens. Guests read guest storage; signed-in users read their own cloud rows.
// Never writes: guest reads go through a read-only view of storage, cloud reads use fetchAll only (no sync, no queue flush).
import { emptyData, fromRow, settingsFromRow, TABLES, type PlannerData, type Row } from "./data";
import { loadGuest, type KV } from "./guest";
import type { PlannerTransport, ServerSnapshot } from "./sync";

/** Storage wrapper that refuses every write, so a read can never change anything. */
export const readOnlyKV = (kv: Pick<KV, "getItem">): KV => ({ getItem: (k) => kv.getItem(k), setItem: () => {}, removeItem: () => {} });

export type PlannerLoad = { data: PlannerData; unreadable: boolean };

export function readGuestPlanner(kv: Pick<KV, "getItem">): PlannerLoad {
  const l = loadGuest(readOnlyKV(kv));
  return { data: l.data, unreadable: l.unreadable };
}

/** Maps a server snapshot to planner data, leaving out deleted rows. */
export function fromSnapshot(s: ServerSnapshot): PlannerData {
  const data = emptyData();
  for (const t of TABLES) (data[t] as unknown[]) = (s[t] ?? []).filter((r: Row) => !r.deleted_at).map((r: Row) => fromRow(t, r));
  data.settings = settingsFromRow(s.settings);
  return data;
}

export async function readCloudPlanner(t: Pick<PlannerTransport, "fetchAll">): Promise<PlannerLoad> {
  return { data: fromSnapshot(await t.fetchAll()), unreadable: false };
}
