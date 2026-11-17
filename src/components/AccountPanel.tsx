import { useEffect, useState } from "react";
import { CloudUpload, LogIn, LogOut, RefreshCw, UserPlus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { loadGroups, loadTasks } from "@/lib/tasks";
import { counts, fromRows, normalizeIds, toRows, verifyContains, type State } from "@/lib/cloud";
import { fetchCloud, hasPendingFor, pushChanges, setCloudMode, type useTaskStore } from "@/hooks/useTaskStore";

const btn =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50";
const btn2 =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-secondary px-4 py-2 text-sm font-medium text-foreground transition hover:bg-accent disabled:opacity-50";
const input =
  "w-full rounded-lg bg-background px-3 py-2 text-sm text-foreground outline-none ring-1 ring-border focus:ring-2 focus:ring-ring";

const STATUS: Record<string, string> = {
  synced: "מסונכרן עם הענן",
  syncing: "מסנכרן…",
  pending: "יש שינויים שממתינים לסנכרון",
  offline: "אין חיבור לאינטרנט. השינויים נשמרים במכשיר ויסונכרנו כשהחיבור יחזור.",
  error: "הסנכרון נכשל. השינויים שמורים במכשיר.",
  loading: "טוען…",
};

type Store = ReturnType<typeof useTaskStore>;
type Preview = { local: State; cloud: ReturnType<typeof counts> };

function MigratePanel({ store }: { store: Store }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState<"upload" | "merge" | "useCloud" | null>(null);

  const check = async () => {
    setMsg(null);
    try {
      const remote = fromRows(await fetchCloud());
      const local = { tasks: loadTasks(), groups: loadGroups() };
      const p = { local, cloud: counts(remote) };
      if (p.cloud.lists + p.cloud.groups === 0 && counts(local).lists + counts(local).groups === 0) {
        setCloudMode(store.user!.id); store.refreshMode(); return;
      }
      setPreview(p);
    } catch {
      setMsg({ ok: false, text: "לא ניתן לבדוק את נתוני הענן. בדקו את החיבור ונסו שוב." });
    }
  };
  useEffect(() => { check(); }, [store.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const migrate = async () => {
    if (!preview) return;
    setBusy(true); setMsg(null);
    try {
      const local = await normalizeIds(preview.local);
      const r = toRows(local);
      // One all-or-nothing call; re-running it updates the same records instead of duplicating them.
      await pushChanges({ ...r, delete_groups: [], delete_lists: [], delete_subtasks: [] });
      const bad = verifyContains(await fetchCloud(), local);
      if (bad) throw new Error("verify:" + bad);
      setCloudMode(store.user!.id);
      setMsg({ ok: true, text: "ההעברה הצליחה ונבדקה. המשימות במכשיר נשארו כגיבוי." });
      store.refreshMode();
    } catch (e) {
      const v = e instanceof Error && e.message.startsWith("verify");
      setMsg({ ok: false, text: v ? "הבדיקה אחרי ההעברה מצאה אי-התאמה. הנתונים המקומיים לא שונו; אפשר לנסות שוב בבטחה." : "ההעברה נכשלה ולא בוצעו שינויים. הנתונים המקומיים לא שונו; אפשר לנסות שוב בבטחה." });
    }
    setBusy(false); setConfirm(null);
  };

  if (!preview) return msg ? <Msg m={msg} /> : <p className="text-xs text-muted-foreground">בודק נתוני ענן…</p>;
  const lc = counts(preview.local), cc = preview.cloud;
  const hasLocal = lc.lists + lc.groups > 0, hasCloud = cc.lists + cc.groups > 0;

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-border p-3 text-sm">
      <p className="font-medium text-foreground">העברה לענן</p>
      <p className="text-xs text-muted-foreground">
        במכשיר: {lc.groups} איחודים, {lc.lists} רשימות, {lc.subtasks} תתי־משימות.
        <br />
        בענן: {hasCloud ? `${cc.groups} איחודים, ${cc.lists} רשימות, ${cc.subtasks} תתי־משימות` : "אין נתונים"}.
      </p>
      {hasLocal && !hasCloud && (
        confirm === "upload" ? (
          <Confirm text="להעלות את כל המשימות מהמכשיר לחשבון? המשימות במכשיר יישארו ללא שינוי." busy={busy} onYes={migrate} onNo={() => setConfirm(null)} />
        ) : (
          <button className={btn} onClick={() => setConfirm("upload")}><CloudUpload className="h-4 w-4" /> העברה לענן</button>
        )
      )}
      {hasCloud && (
        <>
          {hasLocal && <p className="text-xs text-destructive">יש נתונים גם במכשיר וגם בענן. לא יתבצע מיזוג בלי אישורך.</p>}
          {confirm === "useCloud" ? (
            <Confirm text="להציג את נתוני הענן? המשימות במכשיר לא יועלו ולא יימחקו, והן יחזרו להופיע אחרי התנתקות." busy={busy} onYes={() => { setCloudMode(store.user!.id); store.refreshMode(); }} onNo={() => setConfirm(null)} />
          ) : confirm === "merge" ? (
            <Confirm text="להוסיף את משימות המכשיר לענן? שום דבר לא יימחק מהענן. מומלץ לייצא גיבוי לפני כן." busy={busy} onYes={migrate} onNo={() => setConfirm(null)} />
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <button className={btn} onClick={() => setConfirm("useCloud")}>שימוש בנתוני הענן</button>
              {hasLocal && <button className={btn2} onClick={() => setConfirm("merge")}><CloudUpload className="h-4 w-4" /> הוספת משימות המכשיר לענן</button>}
            </div>
          )}
        </>
      )}
      {msg && <Msg m={msg} />}
    </div>
  );
}

const Msg = ({ m }: { m: { ok: boolean; text: string } }) => (
  <p role={m.ok ? undefined : "alert"} className={`text-xs ${m.ok ? "text-primary" : "text-destructive"}`}>{m.text}</p>
);

function Confirm({ text, busy, onYes, onNo }: { text: string; busy: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-foreground">{text}</p>
      <div className="flex gap-2">
        <button className={`${btn} flex-1`} disabled={busy} onClick={onYes}>{busy ? "מעביר…" : "אישור"}</button>
        <button className={`${btn2} flex-1`} disabled={busy} onClick={onNo}>ביטול</button>
      </div>
    </div>
  );
}

export function AccountPanel({ store }: { store: Store }) {
  const { user } = store;
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    if (mode === "up") {
      const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
      if (error) setMsg({ ok: false, text: error.message });
      else if (!data.session) setMsg({ ok: true, text: "נשלח אליך מייל לאישור החשבון. אשרו אותו ואז התחברו." });
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMsg({ ok: false, text: "אימייל או סיסמה שגויים, או שהחשבון עדיין לא אושר." });
    }
    setBusy(false);
    setPassword("");
  };

  const signOut = () => {
    if (user && hasPendingFor(user.id) && !confirm("יש שינויים שעדיין לא סונכרנו. הם יישמרו במכשיר ויסונכרנו בהתחברות הבאה. להתנתק?")) return;
    supabase.auth.signOut();
  };

  return (
    <section className="mt-6 rounded-2xl bg-card p-4 shadow-[var(--shadow-soft)]">
      <h2 className="mb-1 text-sm font-semibold text-foreground">חשבון</h2>
      {user ? (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-xs text-muted-foreground">
              <p className="break-all">מחובר/ת כ־<span dir="ltr" className="font-medium text-foreground">{user.email}</span></p>
              {store.cloud ? (
                <p className={store.status === "error" || store.status === "offline" ? "text-destructive" : ""}>
                  {STATUS[store.status] ?? ""}
                  {store.status === "error" && (
                    <button className="ms-2 inline-flex items-center gap-1 underline" onClick={store.retry}><RefreshCw className="h-3 w-3" /> נסו שוב</button>
                  )}
                </p>
              ) : (
                <p>המשימות מוצגות כרגע מהמכשיר הזה.</p>
              )}
            </div>
            <button type="button" className={btn} onClick={signOut}><LogOut className="h-4 w-4" /> התנתקות</button>
          </div>
          {!store.cloud && <MigratePanel store={store} />}
        </>
      ) : (
        <form onSubmit={submit} className="space-y-2">
          <p className="text-xs text-muted-foreground">אופציונלי. המשימות שלך נשארות במכשיר זה גם בלי חשבון.</p>
          <input className={input} type="email" dir="ltr" required autoComplete="email" placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="אימייל" />
          <input className={input} type="password" dir="ltr" required minLength={6} autoComplete={mode === "up" ? "new-password" : "current-password"} placeholder="סיסמה" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="סיסמה" />
          {msg && <Msg m={msg} />}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <button type="submit" disabled={busy} className={btn}>
              {mode === "in" ? <><LogIn className="h-4 w-4" /> התחברות</> : <><UserPlus className="h-4 w-4" /> הרשמה</>}
            </button>
            <button type="button" className="text-xs text-muted-foreground underline" onClick={() => { setMode(mode === "in" ? "up" : "in"); setMsg(null); }}>
              {mode === "in" ? "אין לך חשבון? הרשמה" : "יש לך חשבון? התחברות"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
