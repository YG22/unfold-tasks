import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { b64u, sendPush, vapidFromSeed } from "@/lib/webpush";

const SUBJECT = "https://unfold-tasks.lovable.app";

async function keys() {
  const seed = process.env["VAPID_PRIVATE_SEED"];
  if (!seed) throw new Error("VAPID_NOT_CONFIGURED");
  return vapidFromSeed(seed);
}

export const getVapidPublicKey = createServerFn({ method: "GET" }).handler(async () => {
  return { key: b64u((await keys()).pub) };
});

const SubInput = z.object({
  endpoint: z.string().url().startsWith("https://").max(2000),
  p256dh: z.string().min(20).max(200),
  auth: z.string().min(8).max(100),
  userAgent: z.string().max(300).optional(),
});

export const saveSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => SubInput.parse(i))
  .handler(async ({ data, context }) => {
    // Endpoint is unique per browser: if another account used this browser before,
    // move it to the signed-in user so the previous account no longer gets its pushes.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("push_subscriptions").upsert(
      { user_id: context.userId, endpoint: data.endpoint, p256dh: data.p256dh, auth: data.auth, user_agent: data.userAgent ?? null, failure_count: 0 },
      { onConflict: "endpoint" },
    );
    if (error) throw new Error("SAVE_FAILED");
    return { ok: true };
  });

export const removeSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ endpoint: z.string().max(2000) }).parse(i))
  .handler(async ({ data, context }) => {
    await context.supabase.from("push_subscriptions").delete().eq("endpoint", data.endpoint);
    return { ok: true };
  });

export const sendTestPush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => z.object({ endpoint: z.string().max(2000) }).parse(i))
  .handler(async ({ data, context }) => {
    // RLS: only rows owned by the caller are visible.
    const { data: sub } = await context.supabase
      .from("push_subscriptions").select("id,endpoint,p256dh,auth,failure_count")
      .eq("endpoint", data.endpoint).eq("user_id", context.userId).maybeSingle();
    if (!sub) return { result: "not_found" as const };
    const k = await keys();
    let r: { status: number; text: string };
    try {
      r = await sendPush(sub, { title: "התראת בדיקה", body: "ההתראות פועלות במכשיר הזה 🎉", tag: "test", url: "/" }, k, SUBJECT);
    } catch (e) {
      console.error("push network error", e);
      return { result: "failed" as const, status: 0 };
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (r.status === 404 || r.status === 410) {
      await supabaseAdmin.from("push_subscriptions").delete().eq("id", sub.id);
      return { result: "expired" as const, status: r.status };
    }
    if (r.status >= 200 && r.status < 300) {
      await supabaseAdmin.from("push_subscriptions").update({ last_success_at: new Date().toISOString(), failure_count: 0 }).eq("id", sub.id);
      return { result: "sent" as const, status: r.status };
    }
    console.error("push failed", r.status, r.text);
    await supabaseAdmin.from("push_subscriptions").update({ failure_count: sub.failure_count + 1 }).eq("id", sub.id);
    return { result: "failed" as const, status: r.status };
  });
