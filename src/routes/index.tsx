import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { BackupPanel } from "@/components/BackupPanel";
import { AccountPanel } from "@/components/AccountPanel";
import { useTaskStore } from "@/hooks/useTaskStore";
import { normalizeIds } from "@/lib/cloud";
import {
  CalendarClock,
  Check,
  ChevronDown,
  Clock,
  FolderPlus,
  GripVertical,
  ListTodo,
  Pencil,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { TaskInput } from "@/components/TaskInput";
import {
  newId,
  type Group,
  type SubTask,
  type Task,
} from "@/lib/tasks";

function fmtDate(d: string) {
  const [y, m, day] = d.split("-");
  return `${day}/${m}/${y}`;
}

function scheduleLabel(s: SubTask) {
  const parts: string[] = [];
  if (s.dueDate) parts.push(`יעד: ${fmtDate(s.dueDate)}`);
  if (s.startAt) {
    const [d, t] = s.startAt.split("T");
    parts.push(`התחלה: ${fmtDate(d ?? "")} ${t ?? ""}`.trim());
  }
  if (s.durationMin) parts.push(`${s.durationMin} דק׳`);
  return parts.join(" · ");
}

function splitStart(v?: string | null): [string, string] {
  if (!v) return ["", ""];
  const [d, t] = v.split("T");
  return [d ?? "", t ?? ""];
}

// Today's date in the user's local timezone (not UTC).
function localTodayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

type DayEntry = { task: Task; sub: SubTask };

function MyDayView({
  today,
  overdue,
  onToggle,
}: {
  today: DayEntry[];
  overdue: DayEntry[];
  onToggle: (taskId: string, subId: string) => void;
}) {
  const [showOverdue, setShowOverdue] = useState(true);
  const todayStr = localTodayStr();
  const row = ({ task, sub }: DayEntry) => {
    const [d, t] = splitStart(sub.startAt);
    return (
      <div
        key={sub.id}
        className="flex items-center gap-3 rounded-2xl bg-card px-4 py-3 shadow-[var(--shadow-soft)]"
      >
        <button
          type="button"
          onClick={() => onToggle(task.id, sub.id)}
          aria-label="סימון כבוצע"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 border-border bg-card transition hover:border-primary"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-foreground">{sub.title}</p>
          <p className="truncate text-xs text-muted-foreground">{task.title}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="flex items-center gap-1 rounded-full bg-secondary px-2 py-1" dir="ltr">
            <Clock className="h-3 w-3" />
            {d !== todayStr ? `${fmtDate(d)} ` : ""}
            {t}
          </span>
          {sub.durationMin ? (
            <span className="rounded-full bg-secondary px-2 py-1">{sub.durationMin} דק׳</span>
          ) : null}
        </div>
      </div>
    );
  };
  return (
    <div className="mt-6 space-y-3">
      {today.length === 0 ? (
        <p className="rounded-2xl bg-card px-5 py-8 text-center text-muted-foreground shadow-[var(--shadow-soft)]">
          אין משימות מתוכננות להיום. יום פנוי! ☀️
        </p>
      ) : (
        today.map(row)
      )}
      {overdue.length > 0 && (
        <div className="rounded-2xl border border-border bg-card/60 p-3">
          <button
            type="button"
            onClick={() => setShowOverdue((v) => !v)}
            aria-expanded={showOverdue}
            className="flex w-full items-center gap-2 px-1 py-1 text-sm text-muted-foreground transition hover:text-foreground"
          >
            <ChevronDown
              className={`h-4 w-4 transition-transform ${showOverdue ? "" : "-rotate-90"}`}
            />
            משימות שעבר מועדן ({overdue.length})
          </button>
          {showOverdue && <div className="mt-2 space-y-2">{overdue.map(row)}</div>}
        </div>
      )}
    </div>
  );
}

// HH:mm (24h) entry: accepts 930, 9:30, 0930 or 09:30; commits on blur.
function parseTime(text: string): string | null {
  const d = text.replace(/\D/g, "");
  if (!/^\d{3,4}$/.test(d)) return null;
  const hh = d.length === 3 ? parseInt(d.slice(0, 1), 10) : parseInt(d.slice(0, 2), 10);
  const mm = parseInt(d.slice(-2), 10);
  if (hh > 23 || mm > 59) return null;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function ScheduleEditor({
  sub,
  onChange,
}: {
  sub: SubTask;
  onChange: (patch: Partial<SubTask>) => void;
}) {
  const field =
    "min-w-0 w-full flex-1 rounded-lg bg-card px-2 py-1.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring";
  const clear =
    "rounded-lg p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive";
  const [startDate, startTime] = splitStart(sub.startAt);
  const [timeDraft, setTimeDraft] = useState<string | null>(null);
  const timeText = timeDraft ?? startTime;
  const timeInvalid = timeText !== "" && parseTime(timeText) === null;
  const row = (label: string, input: React.ReactNode, has: boolean, onClear: () => void) => (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:items-center sm:gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1">
        {input}
        {has && (
          <button type="button" aria-label={`ניקוי ${label}`} onClick={onClear} className={clear}>
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
  return (
    <div className="mt-2 space-y-2 rounded-xl border border-border bg-secondary/60 p-3">
      {row(
        "תאריך יעד",
        <input
          type="date"
          value={sub.dueDate ?? ""}
          onChange={(e) => onChange({ dueDate: e.target.value || null })}
          className={field}
        />,
        !!sub.dueDate,
        () => onChange({ dueDate: null }),
      )}
      {row(
        "התחלה מתוכננת",
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-1 sm:grid-cols-2">
          <input
            type="date"
            aria-label="תאריך התחלה"
            value={startDate}
            onChange={(e) => {
              const d = e.target.value;
              setTimeDraft(null);
              onChange({ startAt: d ? (startTime ? `${d}T${startTime}` : d) : null });
            }}
            className={field}
          />
          <input
            type="text"
            dir="ltr"
            inputMode="numeric"
            autoComplete="off"
            maxLength={5}
            placeholder="HH:MM"
            aria-label="שעת התחלה (24 שעות)"
            disabled={!startDate}
            value={timeText}
            onChange={(e) => setTimeDraft(e.target.value.replace(/[^\d:]/g, "").slice(0, 5))}
            onBlur={() => {
              const t = parseTime(timeText);
              if (timeText === "") {
                onChange({ startAt: startDate || null });
                setTimeDraft(null);
              } else if (t && startDate) {
                onChange({ startAt: `${startDate}T${t}` });
                setTimeDraft(null);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
            className={`${field} text-center tabular-nums disabled:cursor-not-allowed disabled:opacity-50 ${
              timeInvalid ? "ring-2 ring-destructive/60" : ""
            }`}
          />
        </div>,
        !!sub.startAt,
        () => onChange({ startAt: null }),
      )}
      {row(
        "משך (דקות)",
        <input
          type="number"
          min={1}
          inputMode="numeric"
          value={sub.durationMin ?? ""}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            onChange({ durationMin: Number.isFinite(n) && n > 0 ? n : null });
          }}
          className={field}
        />,
        !!sub.durationMin,
        () => onChange({ durationMin: null }),
      )}
    </div>
  );
}

function SortableTask({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <section
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative overflow-hidden rounded-2xl bg-card shadow-[var(--shadow-soft)] ${
        isDragging ? "z-10 opacity-80 ring-2 ring-ring" : ""
      }`}
    >
      <button
        type="button"
        aria-label="גרירה לשינוי סדר"
        className="absolute start-2 top-3 cursor-grab touch-none rounded-lg p-2 text-muted-foreground transition hover:bg-secondary active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-4 w-4" />
      </button>
      {children}
    </section>
  );
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "רשימת המשימות שלי" },
      {
        name: "description",
        content: "אפליקציית משימות פשוטה: כותרת ראשית, תתי משימות, קיבוץ משימות ושמירה אוטומטית.",
      },
      { property: "og:title", content: "רשימת המשימות שלי" },
      {
        property: "og:description",
        content: "נהלו משימות ותתי משימות בקלות, אחדו משימות תחת כותרת משותפת, עם שמירה אוטומטית.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function EditableRow({
  title,
  done,
  onSave,
  onDelete,
  onToggle,
  strong,
}: {
  title: string;
  done?: boolean;
  onSave: (t: string) => void;
  onDelete: () => void;
  onToggle?: () => void;
  strong?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  useEffect(() => setDraft(title), [title]);

  return (
    <div className="flex items-center gap-2">
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          aria-label="סימון כבוצע"
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 transition ${
            done ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card"
          }`}
        >
          {done && <Check className="h-4 w-4" />}
        </button>
      )}

      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              onSave(draft.trim());
              setEditing(false);
            }
            if (e.key === "Escape") setEditing(false);
          }}
          className="flex-1 rounded-xl bg-secondary px-3 py-2 text-foreground outline-none focus:ring-2 focus:ring-ring"
        />
      ) : (
        <span
          className={`flex-1 truncate ${strong ? "text-lg font-semibold" : ""} ${
            done ? "text-muted-foreground line-through" : "text-foreground"
          }`}
        >
          {title}
        </span>
      )}

      <button
        type="button"
        aria-label={editing ? "שמירה" : "עריכה"}
        onClick={() => {
          if (editing) {
            if (draft.trim()) onSave(draft.trim());
            setEditing(false);
          } else setEditing(true);
        }}
        className="rounded-lg p-2 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
      >
        {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
      </button>
      <button
        type="button"
        aria-label="מחיקה"
        onClick={onDelete}
        className="rounded-lg p-2 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
      >
        {editing ? <X className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
      </button>
    </div>
  );
}

function Index() {
  const store = useTaskStore();
  const { tasks, setTasks, groups, setGroups, ready } = store;
  const [openId, setOpenId] = useState<string | null>(null);
  const [closedGroups, setClosedGroups] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [groupError, setGroupError] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState<string | null>(null);
  const [view, setView] = useState<"day" | "lists">("day");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );


  const update = (id: string, fn: (t: Task) => Task) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));

  const groupOf = (t: Task) => t.groupId ?? null;
  const tasksIn = (gid: string | null) => tasks.filter((t) => groupOf(t) === gid);

  const todayStr = localTodayStr();
  const scheduled: DayEntry[] = tasks.flatMap((task) =>
    task.subtasks.filter((s) => !s.done && s.startAt).map((sub) => ({ task, sub })),
  );
  const dateOf = (e: DayEntry) => splitStart(e.sub.startAt)[0];
  const timeOf = (e: DayEntry) => splitStart(e.sub.startAt)[1] || "99:99";
  const todayEntries = scheduled
    .filter((e) => dateOf(e) === todayStr)
    .sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
  const overdueEntries = scheduled.filter((e) => dateOf(e) < todayStr);

  const reorderWithin = (gid: string | null, activeId: string, overId: string) =>
    setTasks((prev) => {
      const idx = prev.map((t, i) => ({ t, i })).filter(({ t }) => (t.groupId ?? null) === gid);
      const subset = idx.map(({ t }) => t);
      const from = subset.findIndex((t) => t.id === activeId);
      const to = subset.findIndex((t) => t.id === overId);
      if (from < 0 || to < 0) return prev;
      const moved = arrayMove(subset, from, to);
      const next = [...prev];
      idx.forEach(({ i }, k) => {
        const m = moved[k];
        if (m) next[i] = m;
      });
      return next;
    });

  const createGroup = () => {
    const name = groupName.trim();
    if (!name) {
      setGroupError("לא ניתן ליצור איחוד ללא שם");
      return;
    }
    if (picked.length === 0) {
      setGroupError("בחרו לפחות משימה אחת");
      return;
    }
    const g: Group = { id: newId(), title: name };
    setGroups((p) => [...p, g]);
    setTasks((p) => p.map((t) => (picked.includes(t.id) ? { ...t, groupId: g.id } : t)));
    setGroupName("");
    setPicked([]);
    setGroupError("");
    setCreating(false);
  };

  const renderTask = (task: Task) => {
    const open = openId === task.id;
    const doneCount = task.subtasks.filter((s) => s.done).length;
    return (
      <SortableTask key={task.id} id={task.id}>
        <div className="flex items-center gap-2 py-3 pe-4 ps-12">
          <button
            type="button"
            aria-label="פתיחה"
            onClick={() => setOpenId(open ? null : task.id)}
            className="rounded-lg p-1 text-muted-foreground transition hover:text-foreground"
          >
            <ChevronDown className={`h-5 w-5 transition-transform ${open ? "rotate-180" : ""}`} />
          </button>
          <div className="flex-1" onClick={() => setOpenId(open ? null : task.id)}>
            <EditableRow
              strong
              title={task.title}
              onSave={(t) => update(task.id, (x) => ({ ...x, title: t }))}
              onDelete={() => setTasks((p) => p.filter((x) => x.id !== task.id))}
            />
          </div>
          {task.subtasks.length > 0 && (
            <span className="shrink-0 rounded-full bg-secondary px-2.5 py-1 text-xs text-muted-foreground">
              {doneCount}/{task.subtasks.length}
            </span>
          )}
        </div>

        {open && (
          <div className="space-y-3 border-t border-border bg-secondary/40 px-4 py-4">
            {groups.length > 0 && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                שיוך לאיחוד:
                <select
                  value={task.groupId ?? ""}
                  onChange={(e) =>
                    update(task.id, (x) => ({ ...x, groupId: e.target.value || null }))
                  }
                  className="rounded-lg bg-card px-2 py-1 text-foreground outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">ללא איחוד</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {task.subtasks.map((s) => {
              const label = scheduleLabel(s);
              const editingSchedule = scheduleOpen === s.id;
              return (
                <div key={s.id}>
                  <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                      <EditableRow
                        title={s.title}
                        done={s.done}
                        onToggle={() =>
                          update(task.id, (x) => ({
                            ...x,
                            subtasks: x.subtasks.map((y) =>
                              y.id === s.id ? { ...y, done: !y.done } : y,
                            ),
                          }))
                        }
                        onSave={(t) =>
                          update(task.id, (x) => ({
                            ...x,
                            subtasks: x.subtasks.map((y) =>
                              y.id === s.id ? { ...y, title: t } : y,
                            ),
                          }))
                        }
                        onDelete={() =>
                          update(task.id, (x) => ({
                            ...x,
                            subtasks: x.subtasks.filter((y) => y.id !== s.id),
                          }))
                        }
                      />
                    </div>
                    <button
                      type="button"
                      aria-label="תזמון"
                      aria-expanded={editingSchedule}
                      onClick={() => setScheduleOpen(editingSchedule ? null : s.id)}
                      className={`shrink-0 rounded-lg p-2 transition hover:bg-secondary hover:text-foreground ${
                        editingSchedule || label ? "text-primary" : "text-muted-foreground"
                      }`}
                    >
                      <CalendarClock className="h-4 w-4" />
                    </button>
                  </div>
                  {label && !editingSchedule && (
                    <p className="ms-9 mt-0.5 text-xs text-muted-foreground">{label}</p>
                  )}
                  {editingSchedule && (
                    <ScheduleEditor
                      sub={s}
                      onChange={(patch) =>
                        update(task.id, (x) => ({
                          ...x,
                          subtasks: x.subtasks.map((y) => (y.id === s.id ? { ...y, ...patch } : y)),
                        }))
                      }
                    />
                  )}
                </div>
              );
            })}
            <TaskInput
              placeholder="שם תת משימה"
              onAdd={(title) =>
                update(task.id, (x) => ({
                  ...x,
                  subtasks: [...x.subtasks, { id: newId(), title, done: false }],
                }))
              }
            />
          </div>
        )}
      </SortableTask>
    );
  };

  return (
    <div dir="rtl" className="min-h-screen bg-background px-4 py-10">
      <main className="mx-auto w-full max-w-xl">
        <header className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-foreground">המשימות שלי</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            הוסיפו משימה ראשית, פתחו אותה והוסיפו לתוכה תתי משימות
          </p>
        </header>

        <div className="mb-6 grid grid-cols-2 gap-2 rounded-2xl bg-card p-1.5 shadow-[var(--shadow-soft)]">
          {(
            [
              { id: "day", label: "היום שלי", icon: Sun },
              { id: "lists", label: "כל הרשימות", icon: ListTodo },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              aria-pressed={view === id}
              className={`flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-medium transition ${
                view === id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary"
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </div>

        {view === "day" && (
          <MyDayView
            today={todayEntries}
            overdue={overdueEntries}
            onToggle={(taskId, subId) =>
              update(taskId, (x) => ({
                ...x,
                subtasks: x.subtasks.map((y) => (y.id === subId ? { ...y, done: !y.done } : y)),
              }))
            }
          />
        )}

        {view === "lists" && (
        <>
        <TaskInput
          placeholder="שם משימה חדשה"
          onAdd={(title) => {
            const task: Task = { id: newId(), title, subtasks: [], groupId: null };
            setTasks((p) => [...p, task]);
            setOpenId(task.id);
          }}
        />

        {tasks.length > 0 && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => {
                setCreating((c) => !c);
                setGroupError("");
              }}
              className="flex items-center gap-2 rounded-xl bg-card px-4 py-2 text-sm text-foreground shadow-[var(--shadow-soft)] transition hover:bg-secondary"
            >
              <FolderPlus className="h-4 w-4 text-primary" />
              {creating ? "ביטול איחוד" : "איחוד משימות תחת כותרת"}
            </button>

            {creating && (
              <div className="mt-3 space-y-3 rounded-2xl bg-card p-4 shadow-[var(--shadow-soft)]">
                <input
                  value={groupName}
                  onChange={(e) => {
                    setGroupName(e.target.value);
                    setGroupError("");
                  }}
                  placeholder="שם הכותרת המאחדת (למשל: לימודים)"
                  className="w-full rounded-xl bg-secondary px-3 py-2 text-foreground outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="space-y-2">
                  {tasks.map((t) => (
                    <label key={t.id} className="flex items-center gap-2 text-sm text-foreground">
                      <input
                        type="checkbox"
                        checked={picked.includes(t.id)}
                        onChange={(e) =>
                          setPicked((p) =>
                            e.target.checked ? [...p, t.id] : p.filter((x) => x !== t.id),
                          )
                        }
                        className="h-4 w-4 accent-[hsl(var(--primary))]"
                      />
                      {t.title}
                    </label>
                  ))}
                </div>
                {groupError && <p className="text-sm text-destructive">{groupError}</p>}
                <button
                  type="button"
                  onClick={createGroup}
                  className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                >
                  צור איחוד
                </button>
              </div>
            )}
          </div>
        )}

        <div className="mt-8 space-y-6">
          {ready && tasks.length === 0 && (
            <p className="rounded-2xl bg-card px-5 py-8 text-center text-muted-foreground shadow-[var(--shadow-soft)]">
              אין עדיין משימות. כתבו שם משימה ולחצו על הפלוס.
            </p>
          )}

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={({ active, over }: DragEndEvent) => {
              if (!over || active.id === over.id) return;
              const a = tasks.find((t) => t.id === active.id);
              const b = tasks.find((t) => t.id === over.id);
              if (!a || !b) return;
              if ((a.groupId ?? null) !== (b.groupId ?? null)) return;
              reorderWithin(a.groupId ?? null, String(active.id), String(over.id));
            }}
          >
            {groups.map((g) => {
              const list = tasksIn(g.id);
              const closed = closedGroups.includes(g.id);
              return (
                <div key={g.id} className="rounded-2xl border-2 border-primary/25 bg-primary/5 p-3">
                  <div className="flex items-center gap-2 px-1 pb-2">
                    <button
                      type="button"
                      aria-label="פתיחת איחוד"
                      onClick={() =>
                        setClosedGroups((p) =>
                          closed ? p.filter((x) => x !== g.id) : [...p, g.id],
                        )
                      }
                      className="rounded-lg p-1 text-primary transition hover:bg-primary/10"
                    >
                      <ChevronDown
                        className={`h-5 w-5 transition-transform ${closed ? "-rotate-90" : ""}`}
                      />
                    </button>
                    <div className="flex-1">
                      <EditableRow
                        strong
                        title={g.title}
                        onSave={(t) =>
                          setGroups((p) => p.map((x) => (x.id === g.id ? { ...x, title: t } : x)))
                        }
                        onDelete={() => {
                          setGroups((p) => p.filter((x) => x.id !== g.id));
                          setTasks((p) =>
                            p.map((t) => (t.groupId === g.id ? { ...t, groupId: null } : t)),
                          );
                        }}
                      />
                    </div>
                    <span className="shrink-0 rounded-full bg-primary/15 px-2.5 py-1 text-xs text-primary">
                      {list.length}
                    </span>
                  </div>

                  {!closed && (
                    <SortableContext
                      items={list.map((t) => t.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-3">
                        {list.length === 0 ? (
                          <p className="px-2 py-3 text-sm text-muted-foreground">
                            אין משימות באיחוד הזה.
                          </p>
                        ) : (
                          list.map(renderTask)
                        )}
                      </div>
                    </SortableContext>
                  )}
                </div>
              );
            })}

            <SortableContext
              items={tasksIn(null).map((t) => t.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-4">{tasksIn(null).map(renderTask)}</div>
            </SortableContext>
          </DndContext>
        </div>
        </>
        )}
        <BackupPanel
          cloud={store.cloud}
          userId={store.user?.id ?? null}
          tasks={tasks}
          groups={groups}
          onRestore={async (t0, g0) => {
            const { tasks: t, groups: g } = store.cloud ? await normalizeIds({ tasks: t0, groups: g0 }) : { tasks: t0, groups: g0 };
            setTasks(t);
            setGroups(g);
            setOpenId(null);
            setScheduleOpen(null);
          }}
        />
        <AccountPanel store={store} />
      </main>
    </div>
  );
}
