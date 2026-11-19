// "התכנון שלי": read-only weekly and daily calendar. Shows planner data only; nothing here creates, edits or deletes.
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Loader2, Moon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { supabaseTransport } from "@/lib/planner/supabase";
import { readCloudPlanner, readGuestPlanner, type PlannerLoad } from "@/lib/planner/source";
import { calendarWeek, hebrewWeekday, layoutDays, shortDate, type CalendarBlock } from "@/lib/planner/view";
import { addDays } from "@/lib/planner/time";

type State = { status: "loading" } | { status: "error"; message: string } | ({ status: "ready" } & PlannerLoad);

/** Loads planner data for the current account. A response for a previous account is ignored. */
export function usePlannerData(userId: string | null) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    if (!userId) {
      try { const l = readGuestPlanner(window.localStorage); setState({ status: "ready", ...l }); }
      catch { setState({ status: "error", message: "לא ניתן לקרוא את התכנון מהמכשיר." }); }
      const onStorage = (e: StorageEvent) => { if (e.key === "planner-guest-v1") setNonce((n) => n + 1); };
      window.addEventListener("storage", onStorage);
      return () => { live = false; window.removeEventListener("storage", onStorage); };
    }
    const t = supabaseTransport(supabase as never, userId);
    const load = () => readCloudPlanner(t).then(
      (l) => { if (live) setState({ status: "ready", ...l }); },
      () => { if (live) setState({ status: "error", message: "לא ניתן לטעון את התכנון כרגע. בדקו את החיבור ונסו שוב." }); },
    );
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = t.subscribe(() => { clearTimeout(timer); timer = setTimeout(() => void load(), 300); });
    return () => { live = false; clearTimeout(timer); unsub(); };
  }, [userId, nonce]);
  return { state, retry: () => setNonce((n) => n + 1) };
}

const HOUR_PX = 44;
const hours = Array.from({ length: 24 }, (_, h) => h);
const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Jerusalem";

export function PlannerView({ userId, today }: { userId: string | null; today: string }) {
  const { state, retry } = usePlannerData(userId);
  const [mode, setMode] = useState<"week" | "day">("week");
  const [anchor, setAnchor] = useState(today);
  const tz = (state.status === "ready" && state.data.settings.timezone) || browserTz();
  const dates = mode === "week" ? calendarWeek(anchor) : [anchor];
  const layout = useMemo(() => (state.status === "ready" ? layoutDays(state.data, dates, tz) : {}), [state, dates.join(), tz]);
  const empty = state.status === "ready" && Object.values(layout).every((l) => !l.length);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX; }, [mode, state.status]);

  const step = mode === "week" ? 7 : 1;
  const title = mode === "week" ? `${shortDate(dates[0]!)} – ${shortDate(dates[6]!)}` : `יום ${hebrewWeekday(anchor)}, ${shortDate(anchor)}`;

  return (
    <section aria-label="התכנון שלי" className="mb-6 rounded-2xl bg-card p-3 shadow-[var(--shadow-soft)] sm:p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="תצוגה" className="flex rounded-xl bg-secondary p-1">
          {(["week", "day"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {m === "week" ? "שבוע" : "יום"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" aria-label={mode === "week" ? "השבוע הקודם" : "היום הקודם"} onClick={() => setAnchor(addDays(anchor, -step))}
            className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"><ChevronRight className="h-4 w-4" /></button>
          <button type="button" onClick={() => setAnchor(today)} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary">היום</button>
          <button type="button" aria-label={mode === "week" ? "השבוע הבא" : "היום הבא"} onClick={() => setAnchor(addDays(anchor, step))}
            className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"><ChevronLeft className="h-4 w-4" /></button>
        </div>
      </div>
      <h2 className="mb-2 text-sm font-semibold text-foreground" aria-live="polite">{title}</h2>

      {state.status === "loading" && (
        <p className="flex items-center gap-2 py-10 justify-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />טוען את התכנון…</p>
      )}
      {state.status === "error" && (
        <div role="alert" className="py-8 text-center text-sm">
          <p className="text-destructive">{state.message}</p>
          <button type="button" onClick={retry} className="mt-3 rounded-lg border border-border px-3 py-1.5 font-medium text-foreground hover:bg-secondary">נסו שוב</button>
        </div>
      )}
      {state.status === "ready" && (
        <>
          {state.unreadable && <p role="alert" className="mb-2 rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">חלק מנתוני התכנון במכשיר לא ניתנים לקריאה. הם נשמרו ולא נמחקו.</p>}
          {empty && (
            <p className="mb-2 flex items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground">
              <CalendarDays className="h-4 w-4 shrink-0" />{mode === "week" ? "אין אירועים בשבוע הזה." : "אין אירועים ביום הזה."}
            </p>
          )}
          <div className="overflow-x-auto">
            <div className={mode === "week" ? "min-w-[640px]" : ""}>
              <div className="flex border-b border-border" style={{ paddingInlineStart: 40 }}>
                {dates.map((d) => (
                  <div key={d} data-date={d} className={`flex-1 border-s border-border px-1 py-1.5 text-center text-xs ${d === today ? "font-bold text-primary" : "text-muted-foreground"}`}>
                    <div>{hebrewWeekday(d)}</div>
                    <div className={`mx-auto mt-0.5 inline-block rounded-full px-1.5 ${d === today ? "bg-primary text-primary-foreground" : "text-foreground"}`} aria-current={d === today ? "date" : undefined}>{shortDate(d)}</div>
                  </div>
                ))}
              </div>
              <div ref={scroller} className="relative max-h-[60vh] overflow-y-auto">
                <div className="relative flex" style={{ height: 24 * HOUR_PX }}>
                  <div className="w-10 shrink-0">
                    {hours.map((h) => (
                      <div key={h} className="relative text-[10px] tabular-nums text-muted-foreground" style={{ height: HOUR_PX }}>
                        <span className="absolute -top-1.5 start-1">{h ? `${String(h).padStart(2, "0")}:00` : ""}</span>
                      </div>
                    ))}
                  </div>
                  {dates.map((d) => (
                    <div key={d} className={`relative flex-1 border-s border-border ${d === today ? "bg-primary/5" : ""}`}>
                      {hours.map((h) => <div key={h} className="border-t border-border/60" style={{ height: HOUR_PX }} />)}
                      {(layout[d] ?? []).map((b) => <Block key={b.key} b={b} compact={mode === "week"} />)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function Block({ b, compact }: { b: CalendarBlock; compact: boolean }) {
  const h = Math.max(((b.bottom - b.top) / 60) * HOUR_PX, 14);
  const w = 100 / b.lanes;
  const reserved = b.status === "reserved";
  return (
    <div
      title={`${b.title} · ${b.startLabel}–${b.endLabel} · ${b.categoryName}${reserved ? " · זמן שמור בגלל מעבר לשעון קיץ" : ""}`}
      className={`absolute overflow-hidden rounded-md border-s-4 px-1 py-0.5 text-foreground ${reserved ? "border-dashed opacity-70" : ""} ${compact ? "text-[10px]" : "text-xs"}`}
      style={{
        top: (b.top / 60) * HOUR_PX, height: h, insetInlineStart: `calc(${b.lane * w}% + 1px)`, width: `calc(${w}% - 2px)`,
        background: `color-mix(in srgb, var(--cat-${b.color}) 22%, var(--card))`, borderInlineStartColor: `var(--cat-${b.color})`,
      }}
    >
      <div className="truncate font-semibold">{b.continuesFromPrev && <Moon aria-label="ממשיך מהיום הקודם" className="me-0.5 inline h-3 w-3" />}{b.title}</div>
      {h > 26 && <div className="truncate tabular-nums text-muted-foreground" dir="ltr">{b.startLabel}–{b.endLabel}</div>}
      {reserved && h > 38 && <div className="truncate text-muted-foreground">זמן שמור – שעה לא קיימת</div>}
    </div>
  );
}
