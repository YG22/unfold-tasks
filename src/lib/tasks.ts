export type SubTask = {
  id: string;
  title: string;
  done: boolean;
  dueDate?: string | null; // YYYY-MM-DD
  startAt?: string | null; // YYYY-MM-DDTHH:mm (local)
  durationMin?: number | null;
};
export type Task = { id: string; title: string; subtasks: SubTask[]; groupId?: string | null };
export type Group = { id: string; title: string };

const KEY = "todo-lists-v1";
const GROUPS_KEY = "todo-groups-v1";

export const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 3) | 8).toString(16);
      });

export function loadTasks(): Task[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Task[]) : [];
  } catch {
    return [];
  }
}

export function saveTasks(tasks: Task[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(tasks));
  } catch {
    /* ignore */
  }
}

export function loadGroups(): Group[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(GROUPS_KEY);
    return raw ? (JSON.parse(raw) as Group[]) : [];
  } catch {
    return [];
  }
}

export function saveGroups(groups: Group[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(GROUPS_KEY, JSON.stringify(groups));
  } catch {
    /* ignore */
  }
}
