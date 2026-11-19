// Event details, create/edit forms and delete/cancel confirmations for the planner calendar.
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BUILTIN_CATEGORIES, eventCategory, expand } from "@/lib/planner/model";
import type { PlannerData } from "@/lib/planner/data";
import { cancelOccurrence, deleteEvent, endOf, formFor, saveEvent, saveOccurrence, seriesChain, type EventForm, type FormErrors, type PlannerWriter } from "@/lib/planner/editor";
import { addDays, fromMinutes } from "@/lib/planner/time";
import { hebrewWeekday, shortDate } from "@/lib/planner/view";

export type DialogTarget = { kind: "new"; date: string } | { kind: "occurrence"; eventId: string; originalDate: string };
type Mode = "details" | "edit-series" | "edit-occurrence" | "confirm-delete" | "confirm-cancel";
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const field = "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring";
const btn = "rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50";

export function EventDialog({ target, data, writer, tz, onClose }: { target: DialogTarget; data: PlannerData; writer: PlannerWriter | null; tz: string; onClose: () => void }) {
  const event = target.kind === "occurrence" ? data.events.find((e) => e.id === target.eventId) ?? null : null;
  const [mode, setMode] = useState<Mode>(target.kind === "new" ? "edit-series" : "details");
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const close = () => onClose();
  if (target.kind === "occurrence" && !event) {
    return <Shell title="האירוע לא נמצא" onClose={close}><p className="text-sm text-muted-foreground">ייתכן שהאירוע נמחק במכשיר אחר.</p></Shell>;
  }
  const recurring = !!event?.weekdays?.length;
  const occ = event && target.kind === "occurrence"
    ? expand([event], data.exceptions, addDays(target.originalDate, -2), addDays(target.originalDate, 3), tz).find((o) => o.originalDate === target.originalDate)
      ?? movedOccurrence(event, data, target.originalDate, tz)
    : null;
  const finish = (msg: string) => { setError(""); setDone(msg); setTimeout(close, 700); };
  const newId = () => crypto.randomUUID();

  if (done) return <Shell title={done} onClose={close}><p role="status" className="text-sm text-muted-foreground">הלוח מתעדכן.</p></Shell>;

  if (mode === "details" && event && target.kind === "occurrence") {
    const cat = eventCategory(event, data.categories);
    const date = occ?.date ?? target.originalDate, start = occ?.startMin ?? event.startMin, dur = occ?.durationMin ?? event.durationMin;
    const end = endOf(date, start, dur, tz);
    const chain = seriesChain(data, event.id);
    return (
      <Shell title={event.title} onClose={close} description={`${cat.name}`}>
        <dl className="space-y-1.5 text-sm">
          <Row k="מתי">יום {hebrewWeekday(date)}, {shortDate(date)} · <span dir="ltr" className="tabular-nums">{fromMinutes(start)}–{end.time}</span>{end.date !== date && " (למחרת)"}</Row>
          {recurring && <Row k="חוזר">בימים {event.weekdays!.map((d) => hebrewWeekday(addDays("2026-11-15", d))).join(", ")}{event.until ? ` עד ${shortDate(event.until)}` : ""}{chain.length > 1 ? ` · הסדרה פוצלה ל־${chain.length} חלקים` : ""}</Row>}
          {occ?.status === "moved" && <Row k="שינוי">המופע הזה הוזז ממועדו המקורי ({shortDate(target.originalDate)}).</Row>}
          {occ?.status === "invalid" && <Row k="שים לב">השעה לא קיימת ביום הזה בגלל מעבר לשעון קיץ. מוצג זמן שמור בלבד; אפשר לשנות את המופע הזה.</Row>}
        </dl>
        {!writer ? <p className="mt-3 text-xs text-muted-foreground">העריכה לא זמינה כרגע.</p> : (
          <div className="mt-4 flex flex-wrap gap-2">
            {recurring ? (<>
              <button type="button" className={`${btn} bg-primary text-primary-foreground`} onClick={() => setMode("edit-occurrence")}>עריכת המופע הזה</button>
              <button type="button" className={`${btn} border border-border`} onClick={() => setMode("edit-series")}>עריכת כל הסדרה</button>
              <button type="button" className={`${btn} border border-border text-destructive`} onClick={() => setMode("confirm-cancel")}>ביטול המופע הזה</button>
              <button type="button" className={`${btn} border border-destructive/50 text-destructive`} onClick={() => setMode("confirm-delete")}>מחיקת כל הסדרה</button>
            </>) : (<>
              <button type="button" className={`${btn} bg-primary text-primary-foreground`} onClick={() => setMode("edit-series")}>עריכה</button>
              <button type="button" className={`${btn} border border-destructive/50 text-destructive`} onClick={() => setMode("confirm-delete")}>מחיקה</button>
            </>)}
          </div>
        )}
      </Shell>
    );
  }

  if (!writer) return <Shell title="העריכה לא זמינה" onClose={close}><p className="text-sm text-muted-foreground">לא ניתן לשמור שינויים כרגע.</p></Shell>;

  if (mode === "confirm-delete" && event) {
    const chain = seriesChain(data, event.id);
    return (
      <Shell title={recurring ? "למחוק את כל הסדרה?" : "למחוק את האירוע?"} onClose={close}
        description={recurring ? `כל המופעים של "${event.title}" יימחקו${chain.length > 1 ? `, כולל ${chain.length} חלקי הסדרה` : ""}.` : `"${event.title}" יימחק מהלוח.`}>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="gap-2 sm:justify-start">
          <button type="button" className={`${btn} bg-destructive text-destructive-foreground`} onClick={() => { const r = deleteEvent(writer, event.id); if (r.ok) finish("נמחק"); else setError(r.message); }}>מחיקה</button>
          <button type="button" className={`${btn} border border-border`} onClick={() => setMode("details")}>חזרה</button>
        </DialogFooter>
      </Shell>
    );
  }
  if (mode === "confirm-cancel" && event && target.kind === "occurrence") {
    return (
      <Shell title="לבטל את המופע הזה?" onClose={close} description={`"${event.title}" ביום ${hebrewWeekday(target.originalDate)}, ${shortDate(target.originalDate)} לא יתקיים. שאר הסדרה לא משתנה.`}>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter className="gap-2 sm:justify-start">
          <button type="button" className={`${btn} bg-destructive text-destructive-foreground`} onClick={() => { const r = cancelOccurrence(writer, event, target.originalDate, newId()); if (r.ok) finish("המופע בוטל"); else setError(r.message); }}>ביטול המופע</button>
          <button type="button" className={`${btn} border border-border`} onClick={() => setMode("details")}>חזרה</button>
        </DialogFooter>
      </Shell>
    );
  }
  if (mode === "edit-occurrence" && event && target.kind === "occurrence") {
    return <OccurrenceForm key="occ" data={data} event={event} originalDate={target.originalDate} occ={occ ?? null} tz={tz}
      onBack={() => setMode("details")} onSave={(f) => saveOccurrence(writer, event, target.originalDate, f, tz, newId())} onDone={() => finish("המופע עודכן")} onClose={close} />;
  }
  return <SeriesForm key="series" data={data} event={event} tz={tz} initialDate={target.kind === "new" ? target.date : ""}
    onBack={event ? () => setMode("details") : undefined}
    onSave={(f) => saveEvent(writer, f, tz, event?.id ?? newId(), event ?? undefined)} onDone={() => finish(event ? "האירוע עודכן" : "האירוע נוסף")} onClose={close} />;
}

/** An occurrence moved far from its original date: expand only around its new date. */
function movedOccurrence(event: PlannerData["events"][number], data: PlannerData, originalDate: string, tz: string) {
  const x = data.exceptions.find((y) => y.eventId === event.id && y.originalDate === originalDate && y.type === "change" && y.newDate && !y.supersededByEventId);
  if (!x?.newDate) return null;
  return expand([event], data.exceptions, addDays(x.newDate, -1), addDays(x.newDate, 2), tz).find((o) => o.originalDate === originalDate) ?? null;
}

function Shell({ title, description, children, onClose }: { title: string; description?: string | undefined; children: React.ReactNode; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent dir="rtl" className="max-h-[90vh] overflow-y-auto text-start sm:max-w-lg">
        <DialogHeader className="text-start sm:text-start">
          <DialogTitle className="ps-8">{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
const Row = ({ k, children }: { k: string; children: React.ReactNode }) => (
  <div className="flex gap-2"><dt className="w-14 shrink-0 text-muted-foreground">{k}</dt><dd className="text-foreground">{children}</dd></div>
);
const Err = ({ m, id }: { m?: string | undefined; id: string }) => (m ? <p id={id} className="mt-1 text-xs text-destructive">{m}</p> : null);

type SaveRes = { ok: true } | { ok: false; message: string; errors?: FormErrors };

function DateTimeFields({ f, set, errors }: { f: Pick<EventForm, "startDate" | "startTime" | "endDate" | "endTime">; set: (p: Partial<EventForm>) => void; errors: FormErrors }) {
  const pair = (dk: "startDate" | "endDate", tk: "startTime" | "endTime", label: string) => (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-sm font-medium text-foreground">{label}</legend>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <input type="date" aria-label={`תאריך ${label}`} aria-invalid={!!errors[dk]} className={field} value={f[dk]} onChange={(e) => set({ [dk]: e.target.value })} />
        <input type="time" aria-label={`שעת ${label}`} aria-invalid={!!errors[tk]} className={field} value={f[tk]} onChange={(e) => set({ [tk]: e.target.value })} />
      </div>
      <Err id={`${dk}-err`} m={errors[dk] ?? errors[tk]} />
    </fieldset>
  );
  return <div className="grid gap-3 sm:grid-cols-2">{pair("startDate", "startTime", "התחלה")}{pair("endDate", "endTime", "סיום")}</div>;
}

function useSubmit(onSave: () => SaveRes, onDone: () => void) {
  const [errors, setErrors] = useState<FormErrors>({});
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true);
    const r = onSave(); setSaving(false);
    if (r.ok) { setErrors({}); setMessage(""); onDone(); } else { setErrors(r.errors ?? {}); setMessage(r.message); }
  };
  return { errors, message, saving, submit };
}

function SeriesForm({ data, event, tz, initialDate, onSave, onDone, onBack, onClose }: {
  data: PlannerData; event: PlannerData["events"][number] | null; tz: string; initialDate: string;
  onSave: (f: EventForm) => SaveRes; onDone: () => void; onBack?: (() => void) | undefined; onClose: () => void;
}) {
  const [f, setF] = useState<EventForm>(() => formFor(event, tz, initialDate));
  const set = (p: Partial<EventForm>) => setF((x) => {
    const n = { ...x, ...p };
    if (p.startDate && x.endDate === x.startDate) n.endDate = p.startDate; // keep same-day events on the same day
    if (p.startDate && n.repeat && x.weekdays.length <= 1) n.weekdays = [new Date(p.startDate + "T00:00:00Z").getUTCDay()];
    return n;
  });
  const { errors, message, saving, submit } = useSubmit(() => onSave(f), onDone);
  const chain = event ? seriesChain(data, event.id) : [];
  const split = chain.length > 1;
  return (
    <Shell title={event ? (event.weekdays?.length ? "עריכת כל הסדרה" : "עריכת אירוע") : "אירוע חדש"} onClose={onClose}
      description={split ? "הסדרה פוצלה בעבר: השינוי חל על החלק הזה של הסדרה בלבד." : event?.weekdays?.length ? "השינוי חל על כל המופעים. מופעים ששונו בנפרד שומרים על השינוי שלהם." : undefined}>
      <form onSubmit={submit} noValidate className="space-y-3">
        <div>
          <label htmlFor="pe-title" className="mb-1 block text-sm font-medium text-foreground">כותרת</label>
          <input id="pe-title" autoFocus maxLength={200} aria-invalid={!!errors.title} aria-describedby="title-err" className={field} value={f.title} onChange={(e) => set({ title: e.target.value })} />
          <Err id="title-err" m={errors.title} />
        </div>
        <div>
          <label htmlFor="pe-cat" className="mb-1 block text-sm font-medium text-foreground">קטגוריה</label>
          <select id="pe-cat" className={field} value={f.category} onChange={(e) => set({ category: e.target.value })}>
            <option value="">ללא קטגוריה</option>
            {[...BUILTIN_CATEGORIES, ...data.categories].map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Err id="cat-err" m={errors.category} />
        </div>
        <DateTimeFields f={f} set={set} errors={errors} />
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={f.repeat} onChange={(e) => set({ repeat: e.target.checked, weekdays: f.weekdays.length ? f.weekdays : f.startDate ? [new Date(f.startDate + "T00:00:00Z").getUTCDay()] : [] })} className="h-4 w-4 accent-[var(--primary)]" />
          חוזר כל שבוע
        </label>
        <Err id="repeat-err" m={errors.repeat} />
        {f.repeat && (
          <div className="space-y-3 rounded-lg bg-secondary/60 p-3">
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-foreground">בימים</legend>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((d) => {
                  const on = f.weekdays.includes(d);
                  return <button key={d} type="button" aria-pressed={on} onClick={() => set({ weekdays: on ? f.weekdays.filter((x) => x !== d) : [...f.weekdays, d] })}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium ${on ? "bg-primary text-primary-foreground" : "border border-border bg-background text-foreground"}`}>{hebrewWeekday(addDays("2026-11-15", d))}</button>;
                })}
              </div>
              <Err id="wd-err" m={errors.weekdays} />
            </fieldset>
            <div>
              <label htmlFor="pe-until" className="mb-1 block text-sm font-medium text-foreground">עד תאריך (לא חובה)</label>
              <input id="pe-until" type="date" className={field} value={f.until} min={f.startDate} onChange={(e) => set({ until: e.target.value })} />
              <Err id="until-err" m={errors.until} />
            </div>
          </div>
        )}
        {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
        <DialogFooter className="gap-2 sm:justify-start">
          <button type="submit" disabled={saving} className={`${btn} bg-primary text-primary-foreground`}>{saving ? "שומר…" : "שמירה"}</button>
          <button type="button" className={`${btn} border border-border`} onClick={onBack ?? onClose}>{onBack ? "חזרה" : "ביטול"}</button>
        </DialogFooter>
      </form>
    </Shell>
  );
}

function OccurrenceForm({ event, originalDate, occ, tz, onSave, onDone, onBack, onClose }: {
  data: PlannerData; event: PlannerData["events"][number]; originalDate: string; occ: { date: string; startMin: number; durationMin: number } | null; tz: string;
  onSave: (f: Pick<EventForm, "startDate" | "startTime" | "endDate" | "endTime">) => SaveRes; onDone: () => void; onBack: () => void; onClose: () => void;
}) {
  const [f, setF] = useState(() => {
    const d = occ?.date ?? originalDate, s = occ?.startMin ?? event.startMin, e = endOf(d, s, occ?.durationMin ?? event.durationMin, tz);
    return { startDate: d, startTime: fromMinutes(s), endDate: e.date, endTime: e.time };
  });
  const set = (p: Partial<EventForm>) => setF((x) => ({ ...x, ...p, ...(p.startDate && x.endDate === x.startDate ? { endDate: p.startDate } : {}) }));
  const { errors, message, saving, submit } = useSubmit(() => onSave(f), onDone);
  return (
    <Shell title="עריכת המופע הזה" onClose={onClose} description={`"${event.title}" של ${shortDate(originalDate)}. אפשר לשנות תאריך, שעה ומשך. הכותרת והקטגוריה נקבעות לכל הסדרה.`}>
      <form onSubmit={submit} noValidate className="space-y-3">
        <DateTimeFields f={f} set={set} errors={errors} />
        {message && <p role="alert" className="text-sm text-destructive">{message}</p>}
        <DialogFooter className="gap-2 sm:justify-start">
          <button type="submit" disabled={saving} className={`${btn} bg-primary text-primary-foreground`}>{saving ? "שומר…" : "שמירת המופע"}</button>
          <button type="button" className={`${btn} border border-border`} onClick={onBack}>חזרה</button>
        </DialogFooter>
      </form>
    </Shell>
  );
}
