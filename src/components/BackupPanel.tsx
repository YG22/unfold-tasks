import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import type { Group, Task } from "@/lib/tasks";
import { backupFilename, buildBackup, parseBackup } from "@/lib/backup";

type Pending = { tasks: Task[]; groups: Group[]; subtaskCount: number };

export function BackupPanel({
  tasks,
  groups,
  onRestore,
  cloud = false,
}: {
  cloud?: boolean;
  tasks: Task[];
  groups: Group[];
  onRestore: (tasks: Task[], groups: Group[]) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const exportData = () => {
    const blob = new Blob([JSON.stringify(buildBackup(tasks, groups), null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = backupFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const pickFile = async (file: File | undefined) => {
    setError("");
    setDone("");
    setPending(null);
    if (!file) return;
    const res = parseBackup(await file.text());
    if (res.ok) setPending(res);
    else setError(res.error);
    if (fileRef.current) fileRef.current.value = "";
  };

  const currentSubs = tasks.reduce((n, t) => n + t.subtasks.length, 0);
  const btn =
    "flex flex-1 items-center justify-center gap-2 rounded-xl bg-secondary px-3 py-2 text-sm font-medium text-foreground transition hover:bg-accent";

  return (
    <section className="mt-10 rounded-2xl bg-card p-4 shadow-[var(--shadow-soft)]">
      <h2 className="mb-1 text-sm font-semibold text-foreground">גיבוי ושחזור</h2>
      <p className="mb-3 text-xs text-muted-foreground">{cloud ? "פועל על נתוני הענן של החשבון. " : ""}שמרו את כל הנתונים לקובץ, או שחזרו מקובץ גיבוי קודם.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" onClick={exportData} className={btn}>
          <Download className="h-4 w-4" /> ייצוא גיבוי
        </button>
        <button type="button" onClick={() => fileRef.current?.click()} className={btn}>
          <Upload className="h-4 w-4" /> שחזור מגיבוי
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          aria-label="קובץ גיבוי"
          className="hidden"
          onChange={(e) => pickFile(e.target.files?.[0])}
        />
      </div>

      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      {done && <p className="mt-3 text-sm text-primary">{done}</p>}

      {pending && (
        <div className="mt-3 rounded-xl border border-border p-3 text-sm">
          <p className="text-foreground">
            נמצאו בגיבוי: <b>{pending.tasks.length}</b> רשימות, <b>{pending.subtaskCount}</b> תתי־משימות
            {pending.groups.length > 0 && <> ו־<b>{pending.groups.length}</b> איחודים</>}.
          </p>
          <p className="mt-1 text-xs text-destructive">
            {cloud ? "השחזור יחליף את כל הנתונים בענן ובכל המכשירים המחוברים" : "השחזור יחליף את כל הנתונים הנוכחיים"} ({tasks.length} רשימות, {currentSubs} תתי־משימות). לא ניתן לבטל.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                onRestore(pending.tasks, pending.groups);
                setPending(null);
                setDone("הנתונים שוחזרו בהצלחה");
              }}
              className="flex-1 rounded-xl bg-destructive px-3 py-2 font-medium text-destructive-foreground"
            >
              החלפה ושחזור
            </button>
            <button type="button" onClick={() => setPending(null)} className="flex-1 rounded-xl bg-secondary px-3 py-2 font-medium text-foreground">
              ביטול
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
