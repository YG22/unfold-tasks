// Planner data + writer for the current account: guest storage when signed out, PlannerSync when signed in.
import { useEffect, useState, useSyncExternalStore } from "react";
import { supabase } from "@/integrations/supabase/client";
import { supabaseTransport } from "@/lib/planner/supabase";
import { GuestPlannerStore, GUEST_KEY } from "@/lib/planner/guest";
import { browserEnv, PlannerSync, type Conflict } from "@/lib/planner/sync";
import type { PlannerData } from "@/lib/planner/data";
import type { PlannerWriter } from "@/lib/planner/editor";

export type PlannerState = {
  status: "loading" | "ready" | "error"; data: PlannerData | null; writer: PlannerWriter | null;
  /** Saving state shown to the user. */
  save: "saved" | "pending" | "syncing" | "offline" | "conflict" | "error" | "local";
  readOnlyReason: string | null; conflicts: Conflict[]; rejected: number; errorMessage: string;
  resolve(key: string, choice: "mine" | "server"): void; retry(): void;
};

type Src = { kind: "guest"; s: GuestPlannerStore } | { kind: "cloud"; s: PlannerSync } | { kind: "error" };

export function usePlanner(userId: string | null): PlannerState {
  const [nonce, setNonce] = useState(0);
  const [src, setSrc] = useState<Src | null>(null);
  useEffect(() => {
    if (!userId) {
      try { setSrc({ kind: "guest", s: new GuestPlannerStore(window.localStorage) }); } catch { setSrc({ kind: "error" }); }
      const onStorage = (e: StorageEvent) => { if (e.key === GUEST_KEY) setNonce((n) => n + 1); };
      window.addEventListener("storage", onStorage);
      return () => window.removeEventListener("storage", onStorage);
    }
    const s = new PlannerSync(userId, window.localStorage, supabaseTransport(supabase as never, userId), browserEnv());
    setSrc({ kind: "cloud", s }); s.start();
    return () => s.dispose();
  }, [userId, nonce]);

  const store = src && src.kind !== "error" ? src.s : null;
  const tick = useSyncExternalStore(
    (cb) => (store ? store.subscribe(cb) : () => {}),
    () => (store ? versionOf(store) : 0), () => 0,
  );
  void tick;
  const base = { resolve: () => {}, retry: () => setNonce((n) => n + 1), conflicts: [], rejected: 0, errorMessage: "" };
  if (!src) return { ...base, status: "loading", data: null, writer: null, save: "local", readOnlyReason: null };
  if (src.kind === "error") return { ...base, status: "error", data: null, writer: null, save: "error", readOnlyReason: null, errorMessage: "לא ניתן לקרוא את התכנון מהמכשיר." };
  if (src.kind === "guest") {
    const unreadable = src.s.loadInfo.unreadable;
    return { ...base, status: "ready", data: src.s.get(), writer: unreadable ? null : src.s, save: "local",
      readOnlyReason: unreadable ? "חלק מנתוני התכנון במכשיר לא ניתנים לקריאה. הם נשמרו ולא נמחקו, ולכן העריכה מושבתת כרגע." : null };
  }
  const s = src.s, st = s.status();
  if (st === "loading") return { ...base, status: "loading", data: null, writer: null, save: "syncing", readOnlyReason: null };
  return {
    ...base, status: "ready", data: s.get(), writer: s.recoveryRequired() ? null : s, save: st,
    readOnlyReason: s.recoveryRequired() ? "שינויים שמורים במכשיר לא ניתנים לקריאה. הם נשמרו בצד, והעריכה מושבתת עד שתוחלט מה לעשות בהם." : null,
    conflicts: s.getConflicts(), rejected: s.getRejected().length, errorMessage: s.error(),
    resolve: (k, c) => s.resolveConflict(k, c),
  };
}

// Cheap change counter per store: bumped on every notification.
const versions = new WeakMap<object, number>();
const hooked = new WeakSet<object>();
function versionOf(store: GuestPlannerStore | PlannerSync) {
  if (!hooked.has(store)) { hooked.add(store); store.subscribe(() => versions.set(store, (versions.get(store) ?? 0) + 1)); }
  return versions.get(store) ?? 0;
}
