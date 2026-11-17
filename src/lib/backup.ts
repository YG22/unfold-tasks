import type { Group, SubTask, Task } from "./tasks";

export const BACKUP_APP = "todo-lists";
export const BACKUP_VERSION = 1;

export type Backup = {
  app: typeof BACKUP_APP;
  version: number;
  exportedAt: string;
  tasks: Task[];
  groups: Group[];
};

export function buildBackup(tasks: Task[], groups: Group[]): Backup {
  return { app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), tasks, groups };
}

export function backupFilename(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `todo-backup-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const START = /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/;
type Raw = { id?: unknown; title?: unknown; done?: unknown; subtasks?: unknown; groupId?: unknown; dueDate?: unknown; startAt?: unknown; durationMin?: unknown; app?: unknown; version?: unknown; tasks?: unknown; groups?: unknown };
const isObj = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => typeof v === "string" && v.length > 0;

export type ParseResult =
  | { ok: true; tasks: Task[]; groups: Group[]; subtaskCount: number }
  | { ok: false; error: string };

export function parseBackup(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "הקובץ אינו קובץ JSON תקין" };
  }
  if (!isObj(data) || data.app !== BACKUP_APP) return { ok: false, error: "הקובץ אינו גיבוי של אפליקציית המשימות" };
  if (typeof data.version !== "number" || data.version > BACKUP_VERSION)
    return { ok: false, error: "גרסת הגיבוי אינה נתמכת" };
  if (!Array.isArray(data.tasks) || !Array.isArray(data.groups)) return { ok: false, error: "מבנה הגיבוי פגום" };

  const groups: Group[] = [];
  const gIds = new Set<string>();
  for (const g of data.groups) {
    if (!isObj(g) || !str(g.id) || typeof g.title !== "string" || gIds.has(g.id as string))
      return { ok: false, error: "אחד האיחודים בגיבוי פגום" };
    gIds.add(g.id as string);
    groups.push({ id: g.id as string, title: g.title });
  }

  const tasks: Task[] = [];
  const ids = new Set<string>();
  let subtaskCount = 0;
  for (const t of data.tasks) {
    if (!isObj(t) || !str(t.id) || typeof t.title !== "string" || !Array.isArray(t.subtasks) || ids.has(t.id as string))
      return { ok: false, error: "אחת הרשימות בגיבוי פגומה" };
    ids.add(t.id as string);
    const gid = t.groupId;
    if (gid != null && (typeof gid !== "string" || !gIds.has(gid)))
      return { ok: false, error: "רשימה משויכת לאיחוד שאינו קיים" };
    const subtasks: SubTask[] = [];
    for (const s of t.subtasks) {
      if (!isObj(s) || !str(s.id) || typeof s.title !== "string" || typeof s.done !== "boolean")
        return { ok: false, error: "אחת מתתי־המשימות בגיבוי פגומה" };
      if (s.dueDate != null && (typeof s.dueDate !== "string" || !DATE.test(s.dueDate)))
        return { ok: false, error: "תאריך יעד לא תקין בגיבוי" };
      if (s.startAt != null && (typeof s.startAt !== "string" || !START.test(s.startAt)))
        return { ok: false, error: "מועד התחלה לא תקין בגיבוי" };
      if (s.durationMin != null && (typeof s.durationMin !== "number" || !Number.isInteger(s.durationMin) || s.durationMin <= 0))
        return { ok: false, error: "משך לא תקין בגיבוי" };
      subtasks.push({
        id: s.id as string,
        title: s.title,
        done: s.done,
        dueDate: (s.dueDate as string | null | undefined) ?? null,
        startAt: (s.startAt as string | null | undefined) ?? null,
        durationMin: (s.durationMin as number | null | undefined) ?? null,
      });
    }
    subtaskCount += subtasks.length;
    tasks.push({ id: t.id as string, title: t.title, subtasks, groupId: (gid as string | null | undefined) ?? null });
  }
  return { ok: true, tasks, groups, subtaskCount };
}
