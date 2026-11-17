import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { loadGroups, loadTasks, saveGroups, saveTasks, type Group, type Task } from "@/lib/tasks";
import { diff, fromRows, isEmpty, rebase, type Changes, type Rows, type State } from "@/lib/cloud";

export type SyncStatus = "local" | "loading" | "synced" | "pending" | "syncing" | "offline" | "error";

const modeKey = (uid: string) => `cloud-mode-${uid}`;
const cacheKey = (uid: string) => `cloud-cache-${uid}`;
const EMPTY: State = { tasks: [], groups: [] };

export const isCloudMode = (uid: string) => localStorage.getItem(modeKey(uid)) === "cloud";
export const setCloudMode = (uid: string) => localStorage.setItem(modeKey(uid), "cloud");

type Cache = { base: State; working: State };
function readCache(uid: string): Cache | null {
  try { return JSON.parse(localStorage.getItem(cacheKey(uid)) ?? "null"); } catch { return null; }
}
function writeCache(uid: string, c: Cache) {
  localStorage.setItem(cacheKey(uid), JSON.stringify(c));
}
export const hasPendingFor = (uid: string) => {
  const c = readCache(uid);
  return !!c && !isEmpty(diff(c.base, c.working));
};

export async function fetchCloud(): Promise<Rows> {
  const [g, l, s] = await Promise.all([
    supabase.from("task_groups").select("id,title,position"),
    supabase.from("task_lists").select("id,group_id,title,position"),
    supabase.from("subtasks").select("id,list_id,title,done,position,due_date,start_date,start_time,duration_min"),
  ]);
  const err = g.error || l.error || s.error;
  if (err) throw err;
  return { groups: g.data!, lists: l.data!, subtasks: s.data! };
}

export async function pushChanges(c: Changes) {
  const { error } = await supabase.rpc("apply_task_changes", { p: c as never });
  if (error) throw error;
}

export function useTaskStore() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [modeTick, setModeTick] = useState(0);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<SyncStatus>("loading");
  const [error, setError] = useState("");

  const cloudUid = user && authReady && isCloudMode(user.id) ? user.id : null;
  const cur = useRef<State>(EMPTY);
  cur.current = { tasks, groups };
  const base = useRef<State>(EMPTY);
  const busy = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => { setUser(data.user ?? null); setAuthReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, []);

  const sync = useCallback(async (uid: string) => {
    if (busy.current) { again.current = true; return; }
    if (!navigator.onLine) { setStatus(isEmpty(diff(base.current, cur.current)) ? "offline" : "offline"); return; }
    busy.current = true;
    setStatus("syncing");
    try {
      const snap = cur.current;
      const changes = diff(base.current, snap);
      if (!isEmpty(changes)) await pushChanges(changes);
      base.current = snap;
      writeCache(uid, { base: snap, working: cur.current });
      const remote = fromRows(await fetchCloud());
      const merged = rebase(remote, diff(snap, cur.current));
      base.current = remote;
      setTasks(merged.tasks); setGroups(merged.groups);
      writeCache(uid, { base: remote, working: merged });
      setError("");
      setStatus(isEmpty(diff(remote, merged)) ? "synced" : "pending");
      if (!isEmpty(diff(remote, merged))) again.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(navigator.onLine ? "error" : "offline");
    } finally {
      busy.current = false;
      if (again.current) { again.current = false; setTimeout(() => sync(uid), 300); }
    }
  }, []);

  // Choose data source.
  useEffect(() => {
    if (!authReady) return;
    setReady(false);
    if (!cloudUid) {
      setTasks(loadTasks()); setGroups(loadGroups()); setStatus("local"); setReady(true);
      return;
    }
    const c = readCache(cloudUid);
    base.current = c?.base ?? EMPTY;
    const w = c?.working ?? EMPTY;
    cur.current = w;
    setTasks(w.tasks); setGroups(w.groups); setReady(true);
    sync(cloudUid);
    const onOnline = () => sync(cloudUid);
    const onOffline = () => setStatus("offline");
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    let rt: ReturnType<typeof setTimeout>;
    const ping = () => { clearTimeout(rt); rt = setTimeout(() => sync(cloudUid), 400); };
    const ch = supabase.channel(`tasks-${Math.random().toString(36).slice(2)}`);
    for (const table of ["task_groups", "task_lists", "subtasks"])
      ch.on("postgres_changes", { event: "*", schema: "public", table }, ping);
    ch.subscribe();
    const onVis = () => document.visibilityState === "visible" && sync(cloudUid);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVis);
      supabase.removeChannel(ch);
      clearTimeout(rt);
    };
  }, [authReady, cloudUid, modeTick, sync]);

  // Persist every change durably before any network work.
  useEffect(() => {
    if (!ready) return;
    if (!cloudUid) { saveTasks(tasks); saveGroups(groups); return; }
    writeCache(cloudUid, { base: base.current, working: { tasks, groups } });
    if (isEmpty(diff(base.current, { tasks, groups }))) return;
    setStatus(navigator.onLine ? "pending" : "offline");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => sync(cloudUid), 600);
  }, [tasks, groups, ready, cloudUid, sync]);

  return {
    user, tasks, setTasks, groups, setGroups, ready, status, error,
    cloud: !!cloudUid,
    retry: () => cloudUid && sync(cloudUid),
    refreshMode: () => setModeTick((n) => n + 1),
  };
}
