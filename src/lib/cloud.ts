import type { Group, SubTask, Task } from "./tasks";

// Flat row shapes mirroring the cloud tables (user_id is filled server-side).
export type GRow = { id: string; title: string; position: number };
export type LRow = { id: string; group_id: string | null; title: string; position: number };
export type SRow = {
  id: string; list_id: string; title: string; done: boolean; position: number;
  due_date: string | null; start_date: string | null; start_time: string | null; duration_min: number | null;
};
export type Rows = { groups: GRow[]; lists: LRow[]; subtasks: SRow[] };
export type Changes = Rows & { delete_groups: string[]; delete_lists: string[]; delete_subtasks: string[] };
export type State = { tasks: Task[]; groups: Group[] };

export function toRows({ tasks, groups }: State): Rows {
  const subtasks: SRow[] = [];
  const lists = tasks.map((t, i) => {
    t.subtasks.forEach((s, j) => {
      const [d, tm] = (s.startAt ?? "").split("T");
      subtasks.push({
        id: s.id, list_id: t.id, title: s.title, done: s.done, position: j,
        due_date: s.dueDate || null, start_date: d || null, start_time: tm || null, duration_min: s.durationMin ?? null,
      });
    });
    return { id: t.id, group_id: t.groupId ?? null, title: t.title, position: i };
  });
  return { groups: groups.map((g, i) => ({ id: g.id, title: g.title, position: i })), lists, subtasks };
}

const byPos = <T extends { position: number; id: string }>(a: T, b: T) => a.position - b.position || a.id.localeCompare(b.id);

export function fromRows(r: Rows): State {
  const groups = [...r.groups].sort(byPos).map((g) => ({ id: g.id, title: g.title }));
  const gIds = new Set(groups.map((g) => g.id));
  const subs = new Map<string, SRow[]>();
  for (const s of r.subtasks) subs.set(s.list_id, [...(subs.get(s.list_id) ?? []), s]);
  const tasks: Task[] = [...r.lists].sort(byPos).map((l) => ({
    id: l.id, title: l.title, groupId: l.group_id && gIds.has(l.group_id) ? l.group_id : null,
    subtasks: (subs.get(l.id) ?? []).sort(byPos).map((s): SubTask => ({
      id: s.id, title: s.title, done: s.done, dueDate: s.due_date,
      startAt: s.start_date ? (s.start_time ? `${s.start_date}T${s.start_time.slice(0, 5)}` : s.start_date) : null,
      durationMin: s.duration_min,
    })),
  }));
  return { tasks, groups };
}

export function normalizeRemote(r: Rows): Rows {
  return toRows(fromRows(r));
}

function diffTable<T extends { id: string }>(a: T[], b: T[]) {
  const am = new Map(a.map((x) => [x.id, JSON.stringify(x)]));
  const bIds = new Set(b.map((x) => x.id));
  return { up: b.filter((x) => am.get(x.id) !== JSON.stringify(x)), del: a.filter((x) => !bIds.has(x.id)).map((x) => x.id) };
}

export function diff(base: State, next: State): Changes {
  const a = toRows(base), b = toRows(next);
  const g = diffTable(a.groups, b.groups), l = diffTable(a.lists, b.lists), s = diffTable(a.subtasks, b.subtasks);
  return { groups: g.up, lists: l.up, subtasks: s.up, delete_groups: g.del, delete_lists: l.del, delete_subtasks: s.del };
}

export const isEmpty = (c: Changes) =>
  !c.groups.length && !c.lists.length && !c.subtasks.length && !c.delete_groups.length && !c.delete_lists.length && !c.delete_subtasks.length;

function applyTable<T extends { id: string }>(rows: T[], up: T[], del: string[]) {
  const m = new Map(rows.map((x) => [x.id, x]));
  for (const x of up) m.set(x.id, x);
  for (const id of del) m.delete(id);
  return [...m.values()];
}

// Re-applies not-yet-synced local edits on top of fresh remote data.
export function rebase(remote: State, pending: Changes): State {
  const r = toRows(remote);
  return fromRows({
    groups: applyTable(r.groups, pending.groups, pending.delete_groups),
    lists: applyTable(r.lists, pending.lists, pending.delete_lists),
    subtasks: applyTable(r.subtasks, pending.subtasks, pending.delete_subtasks),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Deterministic: the same legacy id always maps to the same uuid, so retries never duplicate.
export async function stableUuid(id: string): Promise<string> {
  if (UUID.test(id)) return id.toLowerCase();
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("todo-lists:" + id)));
  h[6] = (h[6]! & 0x0f) | 0x50; h[8] = (h[8]! & 0x3f) | 0x80;
  const x = [...h.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export async function normalizeIds({ tasks, groups }: State): Promise<State> {
  const g = await Promise.all(groups.map(async (x) => ({ ...x, id: await stableUuid(x.id) })));
  const t = await Promise.all(tasks.map(async (x) => ({
    ...x, id: await stableUuid(x.id), groupId: x.groupId ? await stableUuid(x.groupId) : null,
    subtasks: await Promise.all(x.subtasks.map(async (s) => ({ ...s, id: await stableUuid(s.id) }))),
  })));
  return { tasks: t, groups: g };
}

// Every local row must exist in the cloud with identical fields.
export function verifyContains(remote: Rows, local: State): string | null {
  const l = toRows(local), r = normalizeRemote(remote);
  for (const k of ["groups", "lists", "subtasks"] as const) {
    const m = new Map((r[k] as { id: string }[]).map((x) => [x.id, JSON.stringify(x)]));
    for (const x of l[k] as { id: string }[]) if (m.get(x.id) !== JSON.stringify(x)) return k;
  }
  return null;
}

export const counts = (s: State) => ({
  groups: s.groups.length, lists: s.tasks.length, subtasks: s.tasks.reduce((n, t) => n + t.subtasks.length, 0),
});
