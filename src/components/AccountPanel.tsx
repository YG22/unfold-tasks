import { useEffect, useState } from "react";
import { LogIn, LogOut, UserPlus } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

const btn =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50";
const input =
  "w-full rounded-lg bg-background px-3 py-2 text-sm text-foreground outline-none ring-1 ring-border focus:ring-2 focus:ring-ring";

// Account only — tasks keep living in this device's storage for now.
export function AccountPanel() {
  const [user, setUser] = useState<User | null>(null);
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user ?? null));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null));
    return () => data.subscription.unsubscribe();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    if (mode === "up") {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) setMsg({ ok: false, text: error.message });
      else if (!data.session) setMsg({ ok: true, text: "נשלח אליך מייל לאישור החשבון. אשרו אותו ואז התחברו." });
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMsg({ ok: false, text: "אימייל או סיסמה שגויים, או שהחשבון עדיין לא אושר." });
    }
    setBusy(false);
    setPassword("");
  };

  return (
    <section className="mt-6 rounded-2xl bg-card p-4 shadow-[var(--shadow-soft)]">
      <h2 className="mb-1 text-sm font-semibold text-foreground">חשבון</h2>
      {user ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            מחובר/ת כ־<span dir="ltr" className="font-medium text-foreground">{user.email}</span>. המשימות עדיין נשמרות במכשיר זה בלבד.
          </p>
          <button type="button" className={btn} onClick={() => supabase.auth.signOut()}>
            <LogOut className="h-4 w-4" /> התנתקות
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-2">
          <p className="text-xs text-muted-foreground">אופציונלי. המשימות שלך נשארות במכשיר זה גם בלי חשבון.</p>
          <input className={input} type="email" dir="ltr" required autoComplete="email" placeholder="email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="אימייל" />
          <input className={input} type="password" dir="ltr" required minLength={6} autoComplete={mode === "up" ? "new-password" : "current-password"} placeholder="סיסמה" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="סיסמה" />
          {msg && <p className={`text-xs ${msg.ok ? "text-primary" : "text-destructive"}`}>{msg.text}</p>}
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
