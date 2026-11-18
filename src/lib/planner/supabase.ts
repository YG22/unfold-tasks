// Planner transport over the backend: reads the user's five planner data tables, writes only through apply_planner_changes.
// Separate channel from task sync; planner_operations is never subscribed. Not used by the app yet.
import type { SupabaseClient } from "@supabase/supabase-js";
import { DB_TABLE, TABLES, type Row, type SettingsRow } from "./data";
import { PlannerNetworkError, PlannerServerError, type Action, type ActionResult, type PlannerTransport, type ServerSnapshot } from "./sync";

// Postgres/PostgREST errors carry a code; fetch failures do not.
const fail = (e: { message: string; code?: string } | null) => {
  if (!e) return;
  throw e.code ? new PlannerServerError(e.message) : new PlannerNetworkError(e.message);
};

export function supabaseTransport(client: SupabaseClient, uid: string): PlannerTransport & { restore(p: Record<string, unknown>): Promise<unknown> } {
  return {
    async fetchAll() {
      try {
        const res = await Promise.all(TABLES.map((t) => client.from(DB_TABLE[t]).select("*").eq("user_id", uid)));
        res.forEach((r) => fail(r.error));
        const s = await client.from("planner_settings").select("*").eq("user_id", uid).maybeSingle();
        fail(s.error);
        const snap = Object.fromEntries(TABLES.map((t, i) => [t, (res[i]!.data ?? []) as Row[]])) as unknown as ServerSnapshot;
        snap.settings = (s.data as SettingsRow | null) ?? null;
        return snap;
      } catch (e) {
        if (e instanceof PlannerServerError || e instanceof PlannerNetworkError) throw e;
        throw new PlannerNetworkError(String(e));
      }
    },
    async apply(actions: Action[]) {
      let r;
      try { r = await client.rpc("apply_planner_changes" as never, { p: { actions } } as never); }
      catch (e) { throw new PlannerNetworkError(String(e)); }
      fail(r.error as never);
      return ((r.data as { results: ActionResult[] } | null)?.results ?? []) as ActionResult[];
    },
    /** restore_preview / restore through apply_planner_changes (one server transaction, op_id idempotent). */
    async restore(p: Record<string, unknown>) {
      let r;
      try { r = await client.rpc("apply_planner_changes" as never, { p } as never); }
      catch (e) { throw new PlannerNetworkError(String(e)); }
      fail(r.error as never);
      return r.data as unknown;
    },
    subscribe(onChange) {
      const ch = client.channel(`planner-${uid}-${Math.random().toString(36).slice(2)}`);
      for (const t of TABLES.map((x) => DB_TABLE[x]).concat(DB_TABLE.settings))
        ch.on("postgres_changes" as never, { event: "*", schema: "public", table: t, filter: `user_id=eq.${uid}` } as never, onChange);
      ch.subscribe();
      return () => { void client.removeChannel(ch); };
    },
  };
}
