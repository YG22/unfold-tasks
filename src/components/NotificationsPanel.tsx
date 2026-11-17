import { useEffect, useState } from "react";
import { Bell, BellOff, Send } from "lucide-react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getVapidPublicKey, removeSubscription, saveSubscription, sendTestPush } from "@/lib/push.functions";
import { unb64u } from "@/lib/webpush";

const btn =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50";
const btn2 =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-secondary px-4 py-2 text-sm font-medium text-foreground transition hover:bg-accent disabled:opacity-50";

type Settings = { enabled: boolean; remind_before: boolean; remind_at_start: boolean; timezone: string | null };
type Env = "ok" | "unsupported" | "iframe";
const SW = "/push-sw.js";
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || null;

const PERM: Record<string, string> = {
  granted: "ניתנה הרשאה",
  denied: "ההרשאה נחסמה. אפשר לאשר אותה בהגדרות האתר בדפדפן (סמל המנעול ליד הכתובת ← הרשאות ← התראות).",
  default: "עדיין לא התבקשה הרשאה",
};

async function currentSub() {
  if (!(await navigator.serviceWorker.getRegistration("/"))) return null;
  const reg = await navigator.serviceWorker.ready;
  if (!reg.active?.scriptURL.endsWith(SW)) return null;
  return reg.pushManager.getSubscription();
}

export function NotificationsPanel({ userId }: { userId: string }) {
  const [env, setEnv] = useState<Env>("ok");
  const [perm, setPerm] = useState<NotificationPermission>("default");
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [checked, setChecked] = useState(false);
  const [s, setS] = useState<Settings>({ enabled: false, remind_before: true, remind_at_start: true, timezone: null });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const getKey = useServerFn(getVapidPublicKey);
  const save = useServerFn(saveSubscription);
  const remove = useServerFn(removeSubscription);
  const test = useServerFn(sendTestPush);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { setEnv("unsupported"); }
    else if (window.top !== window.self) setEnv("iframe");
    if ("Notification" in window) setPerm(Notification.permission);
    if ("serviceWorker" in navigator) currentSub().then(setSub).catch(() => {}).finally(() => setChecked(true));
    (async () => {
      const { data } = await supabase.from("notification_settings").select("enabled,remind_before,remind_at_start,timezone").maybeSingle();
      const zone = tz();
      if (data) {
        setS(data);
        if (zone && data.timezone !== zone) await supabase.from("notification_settings").update({ timezone: zone, updated_at: new Date().toISOString() }).eq("user_id", userId);
      }
    })();
  }, [userId]);

  const persist = async (next: Settings) => {
    setS(next);
    const { error } = await supabase.from("notification_settings").upsert({ user_id: userId, ...next, timezone: tz(), updated_at: new Date().toISOString() });
    if (error) setMsg({ ok: false, text: "שמירת ההגדרות נכשלה. בדקו את החיבור ונסו שוב." });
  };

  const register = async () => {
    const reg = await navigator.serviceWorker.register(SW, { scope: "/" });
    await navigator.serviceWorker.ready;
    const { key } = await getKey();
    let p = await reg.pushManager.getSubscription();
    if (p && p.options.applicationServerKey) {
      const cur = new Uint8Array(p.options.applicationServerKey);
      const want = unb64u(key);
      if (cur.length !== want.length || cur.some((b, i) => b !== want[i])) { await p.unsubscribe(); p = null; }
    }
    p ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(key) as BufferSource });
    const j = p.toJSON();
    await save({ data: { endpoint: p.endpoint, p256dh: j.keys!['p256dh']!, auth: j.keys!['auth']!, userAgent: navigator.userAgent.slice(0, 300) } });
    setSub(p);
    return p;
  };

  const enable = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
      setPerm(r);
      if (r !== "granted") { setMsg({ ok: false, text: r === "denied" ? (PERM['denied'] ?? '') : "לא ניתנה הרשאה. אפשר לנסות שוב." }); return; }
      await register();
      await persist({ ...s, enabled: true });
      setMsg({ ok: true, text: "ההתראות הופעלו במכשיר הזה." });
    } catch (e) {
      console.error(e);
      setMsg({ ok: false, text: "לא ניתן היה להפעיל התראות במכשיר הזה. נסו שוב, או בדקו שהדפדפן מעודכן." });
    } finally { setBusy(false); }
  };

  const disable = async () => {
    setBusy(true); setMsg(null);
    try {
      const p = await currentSub();
      if (p) { await remove({ data: { endpoint: p.endpoint } }); await p.unsubscribe(); }
      setSub(null);
      await persist({ ...s, enabled: false });
      setMsg({ ok: true, text: "ההתראות כובו במכשיר הזה." });
    } catch { setMsg({ ok: false, text: "הכיבוי נכשל. נסו שוב." }); }
    finally { setBusy(false); }
  };

  const sendTest = async () => {
    setBusy(true); setMsg(null);
    try {
      let p = sub ?? (await currentSub());
      if (!p) { setMsg({ ok: false, text: "המכשיר לא רשום להתראות. הפעילו התראות קודם." }); return; }
      let r = await test({ data: { endpoint: p.endpoint } });
      if (r.result === "not_found" || r.result === "expired") { p = await register(); r = await test({ data: { endpoint: p.endpoint } }); }
      setMsg(
        r.result === "sent" ? { ok: true, text: "התראת הבדיקה נשלחה. היא אמורה להופיע בתוך כמה שניות." }
        : r.result === "expired" || r.result === "not_found" ? { ok: false, text: "הרישום של המכשיר פג. הפעילו את ההתראות מחדש." }
        : { ok: false, text: `השליחה נכשלה (קוד ${r.status}). נסו שוב בעוד רגע.` },
      );
    } catch (e) {
      console.error(e);
      setMsg({ ok: false, text: "השליחה נכשלה. בדקו את החיבור לאינטרנט ונסו שוב." });
    } finally { setBusy(false); }
  };

  const on = s.enabled && !!sub && perm === "granted";

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-border p-3 text-sm">
      <p className="font-medium text-foreground">התראות</p>
      {env === "unsupported" ? (
        <p className="text-xs text-destructive">הדפדפן הזה לא תומך בהתראות. באנדרואיד השתמשו ב-Chrome מעודכן; באייפון יש להתקין את האפליקציה למסך הבית (iOS 16.4 ומעלה).</p>
      ) : env === "iframe" ? (
        <p className="text-xs text-muted-foreground">כדי להפעיל התראות, פתחו את האפליקציה בלשונית נפרדת או באפליקציה שפורסמה.</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            הרשאה: {PERM[perm]}
            <br />
            מכשיר זה: {!checked ? "בודק…" : on ? "רשום לקבלת התראות" : sub ? "רשום, אבל ההתראות כבויות" : "לא רשום"}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            {on ? (
              <button className={btn2} disabled={busy} onClick={disable}><BellOff className="h-4 w-4" /> כיבוי התראות</button>
            ) : (
              <button className={btn} disabled={busy} onClick={enable}><Bell className="h-4 w-4" /> הפעלת התראות</button>
            )}
            <button className={btn2} disabled={busy || !on} onClick={sendTest}><Send className="h-4 w-4" /> שליחת התראת בדיקה</button>
          </div>
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" checked={s.remind_before} onChange={(e) => persist({ ...s, remind_before: e.target.checked })} />
            תזכורת 10 דקות לפני ההתחלה
          </label>
          <label className="flex items-center gap-2 text-xs text-foreground">
            <input type="checkbox" className="h-4 w-4 accent-[var(--primary)]" checked={s.remind_at_start} onChange={(e) => persist({ ...s, remind_at_start: e.target.checked })} />
            תזכורת בזמן ההתחלה
          </label>
          <p className="text-xs text-muted-foreground">התזכורות האוטומטיות יופעלו בשלב הבא. כרגע אפשר לשלוח התראת בדיקה בלבד.</p>
        </>
      )}
      {msg && <p role={msg.ok ? undefined : "alert"} className={`text-xs ${msg.ok ? "text-primary" : "text-destructive"}`}>{msg.text}</p>}
    </div>
  );
}
