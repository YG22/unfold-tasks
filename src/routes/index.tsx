import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Check, ChevronDown, FolderPlus, GripVertical, Pencil, Trash2, X } from "lucide-react";
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
  loadGroups,
  loadTasks,
  newId,
  saveGroups,
  saveTasks,
  type Group,
  type Task,
} from "@/lib/tasks";

function SortableTask({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
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
      { name: "description", content: "אפליקציית משימות פשוטה: כותרת ראשית, תתי משימות, קיבוץ משימות ושמירה אוטומטית." },
      { property: "og:title", content: "רשימת המשימות שלי" },
      { property: "og:description", content: "נהלו משימות ותתי משימות בקלות, אחדו משימות תחת כותרת משותפת, עם שמירה אוטומטית." },
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [closedGroups, setClosedGroups] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [creating, setCreating] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [groupError, setGroupError] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    setTasks(loadTasks());
    setGroups(loadGroups());
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) saveTasks(tasks);
  }, [tasks, ready]);

  useEffect(() => {
    if (ready) saveGroups(groups);
  }, [groups, ready]);

  const update = (id: string, fn: (t: Task) => Task) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));

  const groupOf = (t: Task) => t.groupId ?? null;
  const tasksIn = (gid: string | null) => tasks.filter((t) => groupOf(t) === gid);

  const reorderWithin = (gid: string | null, activeId: string, overId: string) =>
    setTasks((prev) => {
      const idx = prev.map((t, i) => ({ t, i })).filter(({ t }) => (t.groupId ?? null) === gid);
      const subset = idx.map(({ t }) => t);
      const from = subset.findIndex((t) => t.id === activeId);
      const to = subset.findIndex((t) => t.id === overId);
      if (from < 0 || to < 0) return prev;
      const moved = arrayMove(subset, from, to);
      const next = [...prev];
      idx.forEach(({ i }, k) => (next[i] = moved[k]));
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
            {task.subtasks.map((s) => (
              <EditableRow
                key={s.id}
                title={s.title}
                done={s.done}
                onToggle={() =>
                  update(task.id, (x) => ({
                    ...x,
                    subtasks: x.subtasks.map((y) => (y.id === s.id ? { ...y, done: !y.done } : y)),
                  }))
                }
                onSave={(t) =>
                  update(task.id, (x) => ({
                    ...x,
                    subtasks: x.subtasks.map((y) => (y.id === s.id ? { ...y, title: t } : y)),
                  }))
                }
                onDelete={() =>
                  update(task.id, (x) => ({
                    ...x,
                    subtasks: x.subtasks.filter((y) => y.id !== s.id),
                  }))
                }
              />
            ))}
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
                      <ChevronDown className={`h-5 w-5 transition-transform ${closed ? "-rotate-90" : ""}`} />
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
      </main>
    </div>
  );
}
