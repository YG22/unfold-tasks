import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import type { Group, Task } from "@/lib/tasks";
import { backupFilename, buildBackup, parseBackup } from "@/lib/backup";
import { supabase } from "@/integrations/supabase/client";
import { loadGuest } from "@/lib/planner/guest";
import { supabaseTransport } from "@/lib/planner/supabase";
import {
  applyCloudRestore, applyGuestRestore, plannerToBackup, previewCloudRestore, previewGuestRestore, snapshotToData,
  type CloudRestorePreview, type GuestRestorePreview, type PlannerSections, type RestoreResult,
} from "@/lib/planner/backup";

type Pending = { tasks: Task[]; groups: Group[]; subtaskCount: number; planner: PlannerSections | null };
type PlannerPreview = GuestRestorePreview | CloudRestorePreview;

const SECTION_NAMES = { categories: "קטגוריות", events: "אירועים", exceptions: "שינויים בסדרות", availability: "זמני זמינות", settings: "הגדרות" } as const;

function plannerError(r: Exclude<RestoreResult, { ok: true }>) {
  if (r.reason === "changed") return "נתוני היומן השתנו מאז התצוגה המקדימה. בחרו את הקובץ שוב לתצוגה מעודכנת.";
  if (r.reason === "network") return "אין חיבור. נסו שוב — ניסיון חוזר בטוח.";
  if (r.reason === "invalid") return "נתוני היומן בגיבוי אינם תקינים.";
  return "שחזור היומן נכשל.";
}

export function BackupPanel({
  tasks,
  groups,
  onRestore,
  cloud = false,
  userId = null,
}: {
  cloud?: boolean;
  /** Signed-in account: planner backup/restore uses its cloud data; otherwise the guest planner on this device. */
  userId?: string | null;
  tasks: Task[];
  groups: Group[];
  onRestore: (tasks: Task[], groups: Group[]) => void | Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [preview, setPreview] = useState<PlannerPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const exportData = async () => {
    setError("");
    setDone("");
    let planner: PlannerSections | null = null;
    try {
      if (userId) planner = plannerToBackup(snapshotToData(await supabaseTransport(supabase, userId).fetchAll()));
      else {
        const g = loadGuest(localStorage);
        if (!g.unreadable && g.dropped === 0) planner = plannerToBackup(g.data);
      }
    } catch {
      planner = null;
    }
    if (!planner) setDone("נתוני היומן לא נכללו בגיבוי הזה (לא ניתן היה לקרוא אותם). המשימות נשמרו.");
    const blob = new Blob([JSON.stringify(buildBackup(tasks, groups, planner), null, 2)], {
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
    setPreview(null);
    if (!file) return;
    const res = parseBackup(await file.text());
    if (fileRef.current) fileRef.current.value = "";
    if (!res.ok) return setError(res.error);
    if (res.planner) {
      setBusy(true);
      try {
        setPreview(userId
          ? await previewCloudRestore(supabaseTransport(supabase, userId), userId, res.planner)
          : previewGuestRestore(localStorage, res.planner));
      } catch {
        setBusy(false);
        return setError("לא ניתן להכין תצוגה מקדימה לשחזור היומן. דבר לא שונה.");
      }
      setBusy(false);
    }
    setPending(res);
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError("");
    // Planner first (all or nothing); tasks are restored only if it succeeded.
    if (preview) {
      const r = preview.mode === "guest"
        ? applyGuestRestore(localStorage, preview, true)
        : await applyCloudRestore(supabaseTransport(supabase, userId!), userId!, preview, true);
      if (!r.ok) {
        setBusy(false);
        if (r.reason === "changed") { setPending(null); setPreview(null); }
        return setError(plannerError(r) + " המשימות לא שונו.");
      }
    }
    try {
      await onRestore(pending.tasks, pending.groups);
    } catch {
      setBusy(false);
      return setError(preview
        ? "היומן שוחזר, אך שחזור המשימות נכשל. אפשר לשחזר שוב מאותו קובץ — היומן לא ישוכפל."
        : "שחזור המשימות נכשל.");
    }
    setBusy(false);
    setPending(null);
    setPreview(null);
    setDone("הנתונים שוחזרו בהצלחה");
  };

  const currentSubs = tasks.reduce((n, t) => n + t.subtasks.length, 0);
  const btn =
    "flex flex-1 items-center justify-center gap-2 rounded-xl bg-secondary px-3 py-2 text-sm font-medium text-foreground transition hover:bg-accent";
  const blocked = !!preview && preview.errors.length > 0;

  return (
    <section className="mt-10 rounded-2xl bg-card p-4 shadow-[var(--shadow-soft)]">
      <h2 className="mb-1 text-sm font-semibold text-foreground">גיבוי ושחזור</h2>
      <p className="mb-3 text-xs text-muted-foreground">{cloud ? "פועל על נתוני הענן של החשבון. " : ""}שמרו את כל הנתונים לקובץ, או שחזרו מקובץ גיבוי קודם.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" onClick={exportData} className={btn}>
          <Download className="h-4 w-4" /> ייצוא גיבוי
        </button>
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className={btn}>
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
          {preview ? (
            <div className="mt-2 rounded-lg bg-secondary p-2 text-xs text-foreground">
              <p className="font-medium">יומן ({preview.mode === "cloud" ? "בחשבון" : "במכשיר הזה"}):</p>
              <ul className="mt-1 space-y-0.5">
                {(["categories", "events", "exceptions", "availability"] as const).map((k) => (
                  <li key={k}>
                    {SECTION_NAMES[k]}: {preview.sections[k] === "omitted" ? "לא בגיבוי — יישארו ללא שינוי" : (
                      <>{preview.counts[k].add} חדשים, {preview.counts[k].replace} יוחלפו, {preview.counts[k].same} ללא שינוי, {preview.counts[k].delete} יימחקו</>
                    )}
                  </li>
                ))}
                <li>{SECTION_NAMES.settings}: {preview.sections.settings === "omitted" ? "לא בגיבוי — יישארו ללא שינוי" : preview.settingsChanged ? "יוחלפו" : "ללא שינוי"}</li>
              </ul>
              {blocked && <p role="alert" className="mt-1 text-destructive">נמצאו בעיות בנתוני היומן ({preview.errors.length}). לא ניתן לשחזר את הקובץ הזה.</p>}
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">אין בגיבוי נתוני יומן — היומן יישאר ללא שינוי.</p>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy || blocked}
              onClick={confirm}
              className="flex-1 rounded-xl bg-destructive px-3 py-2 font-medium text-destructive-foreground disabled:opacity-50"
            >
              החלפה ושחזור
            </button>
            <button type="button" onClick={() => { setPending(null); setPreview(null); }} className="flex-1 rounded-xl bg-secondary px-3 py-2 font-medium text-foreground">
              ביטול
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
