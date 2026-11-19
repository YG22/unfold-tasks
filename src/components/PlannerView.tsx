// "התכנון שלי": weekly and daily calendar with event management (create, edit, cancel one occurrence, delete).
// Writes go only through the existing planner stores (guest storage or signed-in sync) via src/lib/planner/editor.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, Check, ChevronLeft, ChevronRight, CloudOff, Loader2, Moon, Plus } from "lucide-react";
import { calendarWeek, hebrewWeekday, layoutDays, shortDate, type CalendarBlock } from "@/lib/planner/view";
import { addDays } from "@/lib/planner/time";
import { usePlanner } from "./usePlanner";
import { EventDialog, type DialogTarget } from "./PlannerEventDialog";

const HOUR_PX = 44;
const hours = Array.from({ length: 24 }, (_, h) => h);
const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Jerusalem";

const SAVE_LABEL: Record<string, string> = { saved: "נשמר", pending: "ממתין לשמירה…", syncing: "שומר…", offline: "אין חיבור – השינויים יישמרו כשיחזור", conflict: "יש שינוי שלא נשמר", error: "שגיאה בשמירה", local: "נשמר במכשיר" };

export function PlannerView({ userId, today }: { userId: string | null; today: string }) {
  const p = usePlanner(userId);
  const state = p.status === "ready" && p.data ? { status: "ready" as const, data: p.data } : p.status === "error" ? { status: "error" as const, message: p.errorMessage } : { status: "loading" as const };
  const retry = p.retry;
  const [target, setTarget] = useState<DialogTarget | null>(null);
  const [mode, setMode] = useState<"week" | "day">("week");
  const [anchor, setAnchor] = useState(today);
  const tz = (state.status === "ready" && state.data.settings.timezone) || browserTz();
  const dates = mode === "week" ? calendarWeek(anchor) : [anchor];
  const layout = useMemo(() => (state.status === "ready" ? layoutDays(state.data, dates, tz) : {}), [state, dates.join(), tz]);
  const empty = state.status === "ready" && Object.values(layout).every((l) => !l.length);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 7 * HOUR_PX; }, [mode, state.status]);

  const step = mode === "week" ? 7 : 1;
  const title = mode === "week" ? `${shortDate(dates[0] ?? anchor)} – ${shortDate(dates[6] ?? anchor)}` : `יום ${hebrewWeekday(anchor)}, ${shortDate(anchor)}`;

  return (
    <section aria-label="התכנון שלי" className="mb-6 rounded-2xl bg-card p-3 shadow-[var(--shadow-soft)] sm:p-4 lg:mx-[calc((100%-100vw+2rem)/2)] lg:w-[calc(100vw-2rem)]">
      <div className="mb-3 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:justify-between">
        <div role="group" aria-label="תצוגה" className="flex rounded-xl bg-secondary p-1">
          {(["week", "day"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}>
              {m === "week" ? "שבוע" : "יום"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          {p.writer && (
            <button type="button" onClick={() => setTarget({ kind: "new", date: anchor })}
              className="me-1 inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">
              <Plus className="h-4 w-4" />אירוע חדש
            </button>
          )}
          <button type="button" aria-label={mode === "week" ? "השבוע הקודם" : "היום הקודם"} onClick={() => setAnchor(addDays(anchor, -step))}
            className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"><ChevronRight className="h-4 w-4" /></button>
          <button type="button" onClick={() => setAnchor(today)} className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-secondary">היום</button>
          <button type="button" aria-label={mode === "week" ? "השבוע הבא" : "היום הבא"} onClick={() => setAnchor(addDays(anchor, step))}
            className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"><ChevronLeft className="h-4 w-4" /></button>
        </div>
      </div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground" aria-live="polite">{title}</h2>
        {state.status === "ready" && (
          <span role="status" className={`inline-flex items-center gap-1 text-xs ${p.save === "conflict" || p.save === "error" ? "text-destructive" : "text-muted-foreground"}`}>
            {p.save === "syncing" || p.save === "pending" ? <Loader2 className="h-3 w-3 animate-spin" /> : p.save === "offline" ? <CloudOff className="h-3 w-3" /> : p.save === "conflict" || p.save === "error" ? <AlertTriangle className="h-3 w-3" /> : <Check className="h-3 w-3" />}
            {SAVE_LABEL[p.save]}
          </span>
        )}
      </div>
      {p.conflicts.map((c) => (
        <div key={c.key} role="alert" className="mb-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground">
          <p>שינוי שעשית לא נשמר, כי אותו פריט השתנה במכשיר אחר{c.reason === "deleted" ? " ונמחק שם" : ""}. מה לשמור?</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => p.resolve(c.key, "mine")} className="rounded-lg bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">את השינוי שלי</button>
            <button type="button" onClick={() => p.resolve(c.key, "server")} className="rounded-lg border border-border px-3 py-1 text-xs font-medium">את הגרסה מהמכשיר האחר</button>
          </div>
        </div>
      ))}
      {p.rejected > 0 && <p role="alert" className="mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{p.rejected === 1 ? "שינוי אחד נדחה ולא נשמר." : `${p.rejected} שינויים נדחו ולא נשמרו.`}</p>}

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
          {p.readOnlyReason && <p role="alert" className="mb-2 rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">{p.readOnlyReason}</p>}
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
                      {(layout[d] ?? []).map((b) => <Block key={b.key} b={b} compact={mode === "week"} onOpen={() => setTarget({ kind: "occurrence", eventId: b.eventId, originalDate: b.originalDate })} />)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
      {target && state.status === "ready" && (
        <EventDialog target={target} data={state.data} writer={p.writer} tz={tz} onClose={() => setTarget(null)} />
      )}
    </section>
  );
}

function Block({ b, compact, onOpen }: { b: CalendarBlock; compact: boolean; onOpen: () => void }) {
  const h = Math.max(((b.bottom - b.top) / 60) * HOUR_PX, 14);
  const w = 100 / b.lanes;
  const reserved = b.status === "reserved";
  return (
    <button type="button" onClick={onOpen} aria-label={`${b.title}, ${b.startLabel}–${b.endLabel}, ${b.categoryName}. פתיחת פרטים`}
      title={`${b.title} · ${b.startLabel}–${b.endLabel} · ${b.categoryName}${reserved ? " · זמן שמור בגלל מעבר לשעון קיץ" : ""}`}
      className={`absolute overflow-hidden rounded-md text-start hover:ring-2 hover:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring border-s-4 px-1 py-0.5 text-foreground ${reserved ? "border-dashed opacity-70" : ""} ${compact ? "text-[10px] lg:text-xs" : "text-xs"}`}
      style={{
        top: (b.top / 60) * HOUR_PX, height: h, insetInlineStart: `calc(${b.lane * w}% + 1px)`, width: `calc(${w}% - 2px)`,
        background: `color-mix(in srgb, var(--cat-${b.color}) 22%, var(--card))`, borderInlineStartColor: `var(--cat-${b.color})`,
      }}
    >
      <span className="block truncate font-semibold">{b.continuesFromPrev && <Moon aria-label="ממשיך מהיום הקודם" className="me-0.5 inline h-3 w-3" />}{b.title}</span>
      {h > 26 && <span className="block truncate tabular-nums" dir="ltr">{b.startLabel}–{b.endLabel}</span>}
      {reserved && h > 38 && <span className="block truncate">זמן שמור – שעה לא קיימת</span>}
    </button>
  );
}
