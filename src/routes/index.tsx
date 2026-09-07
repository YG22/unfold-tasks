import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Check, ChevronDown, Pencil, Trash2, X } from "lucide-react";
import { TaskInput } from "@/components/TaskInput";
import { loadTasks, newId, saveTasks, type Task } from "@/lib/tasks";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "רשימת המשימות שלי" },
      { name: "description", content: "אפליקציית משימות פשוטה: כותרת ראשית, תתי משימות, סימון ביצוע ושמירה אוטומטית." },
      { property: "og:title", content: "רשימת המשימות שלי" },
      { property: "og:description", content: "נהלו משימות ותתי משימות בקלות, עם שמירה אוטומטית במכשיר." },
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
  const [openId, setOpenId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setTasks(loadTasks());
    setReady(true);
  }, []);

  useEffect(() => {
    if (ready) saveTasks(tasks);
  }, [tasks, ready]);

  const update = (id: string, fn: (t: Task) => Task) =>
    setTasks((prev) => prev.map((t) => (t.id === id ? fn(t) : t)));

  return (
    <div dir="rtl" className="min-h-screen bg-background px-4 py-10">
      <main className="mx-auto w-full max-w-xl">
        <header className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-foreground">המשימות שלי</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            הוסיפו משימה ראשית, פתחו אותה והוסיפו לתוכה תתי משימות
          </p>
        </header>

        <TaskInput placeholder="שם משימה חדשה" onAdd={(title) => {
          const task: Task = { id: newId(), title, subtasks: [] };
          setTasks((p) => [...p, task]);
          setOpenId(task.id);
        }} />

        <div className="mt-8 space-y-4">
          {ready && tasks.length === 0 && (
            <p className="rounded-2xl bg-card px-5 py-8 text-center text-muted-foreground shadow-[var(--shadow-soft)]">
              אין עדיין משימות. כתבו שם משימה ולחצו על הפלוס.
            </p>
          )}

          {tasks.map((task) => {
            const open = openId === task.id;
            const doneCount = task.subtasks.filter((s) => s.done).length;
            return (
              <section
                key={task.id}
                className="overflow-hidden rounded-2xl bg-card shadow-[var(--shadow-soft)]"
              >
                <div className="flex items-center gap-2 px-4 py-3">
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
                    {task.subtasks.map((s) => (
                      <EditableRow
                        key={s.id}
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
          })}
          </SortableContext>
          </DndContext>
        </div>

      </main>
    </div>
  );
}
