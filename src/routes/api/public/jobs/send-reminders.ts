import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";

// Scheduler target. NOT scheduled yet — activation needs explicit approval.
export const Route = createFileRoute("/api/public/jobs/send-reminders")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const fail = await authenticateCronRequest(request);
        if (fail) return fail;
        const { dispatchDue } = await import("@/lib/reminders.server");
        const res = await dispatchDue();
        return Response.json({ processed: res.length, sent: res.filter((r) => r.status === "sent").length });
      },
    },
  },
});
