// Server-only reminder delivery. Uses the admin client; callers must be verified first.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendPush, vapidFromSeed } from "@/lib/webpush";
import { reminderPayload, retryDelayMs, MAX_ATTEMPTS } from "@/lib/reminders";

const SUBJECT = "https://unfold-tasks.lovable.app";
type Claimed = { id: string; user_id: string; subtask_id: string; kind: string; fire_at: string; title: string; attempts: number };

export async function deliver(rows: Claimed[]) {
  if (!rows.length) return [];
  const seed = process.env["VAPID_PRIVATE_SEED"];
  if (!seed) throw new Error("VAPID_NOT_CONFIGURED");
  const keys = await vapidFromSeed(seed);
  const out = [];
  for (const r of rows) {
    const { data: subs } = await supabaseAdmin.from("push_subscriptions")
      .select("id,endpoint,p256dh,auth,failure_count").eq("user_id", r.user_id);
    let accepted = 0, failed = 0, temporary = 0;
    for (const s of subs ?? []) {
      let status = 0;
      try { status = (await sendPush(s, reminderPayload(r), keys, SUBJECT)).status; } catch (e) { console.error("push network error", e); }
      if (status >= 200 && status < 300) {
        accepted++;
        await supabaseAdmin.from("push_subscriptions").update({ last_success_at: new Date().toISOString(), failure_count: 0 }).eq("id", s.id);
      } else if (status === 404 || status === 410) {
        failed++;
        await supabaseAdmin.from("push_subscriptions").delete().eq("id", s.id);
      } else {
        failed++; temporary++;
        await supabaseAdmin.from("push_subscriptions").update({ failure_count: s.failure_count + 1 }).eq("id", s.id);
      }
    }
    const total = subs?.length ?? 0;
    // Retry only when no device accepted it, so accepted devices never get a duplicate.
    const status = total === 0 ? "no_devices"
      : accepted === total ? "sent"
      : accepted > 0 ? "partial"
      : temporary > 0 && r.attempts < MAX_ATTEMPTS ? "retry" : "failed";
    await supabaseAdmin.from("reminder_deliveries").update({
      status, accepted_count: accepted, failed_count: failed, updated_at: new Date().toISOString(),
      next_attempt_at: status === "retry" ? new Date(Date.now() + retryDelayMs(r.attempts)).toISOString() : null,
    }).eq("id", r.id);
    out.push({ id: r.id, status, accepted, failed, total });
  }
  return out;
}

export async function dispatchDue(now = new Date()) {
  const { data, error } = await supabaseAdmin.rpc("claim_due_reminders", { p_now: now.toISOString() });
  if (error) throw new Error("CLAIM_FAILED: " + error.message);
  return deliver((data ?? []) as Claimed[]);
}
