ALTER TABLE public.notification_settings ADD COLUMN reminders_from timestamptz NOT NULL DEFAULT now();

CREATE TABLE public.reminder_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  subtask_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('before','start','test')),
  fire_at timestamptz NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed','sent','partial','retry','failed','no_devices','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subtask_id, kind, fire_at)
);
CREATE INDEX reminder_deliveries_retry_idx ON public.reminder_deliveries (status, next_attempt_at);
GRANT SELECT ON public.reminder_deliveries TO authenticated;
GRANT ALL ON public.reminder_deliveries TO service_role;
ALTER TABLE public.reminder_deliveries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own deliveries select" ON public.reminder_deliveries FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Atomically claims reminders that are due now. Fire time = task wall-clock date+time in the user's IANA zone.
-- Only rows newly inserted (or retry rows whose lock was taken) are returned, so concurrent runs never double-send.
CREATE OR REPLACE FUNCTION public.claim_due_reminders(p_now timestamptz DEFAULT now(), p_grace interval DEFAULT interval '15 minutes')
RETURNS TABLE (id uuid, user_id uuid, subtask_id uuid, kind text, fire_at timestamptz, title text, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH cand AS (
    SELECT s.user_id, s.id AS subtask_id, k.kind, s.title,
      ((s.start_date + s.start_time) AT TIME ZONE n.timezone) - k.off AS fire_at, n.reminders_from
    FROM public.subtasks s
    JOIN public.notification_settings n ON n.user_id = s.user_id AND n.enabled
    JOIN pg_timezone_names z ON z.name = n.timezone
    CROSS JOIN LATERAL (VALUES ('before', interval '10 minutes', n.remind_before), ('start', interval '0', n.remind_at_start)) AS k(kind, off, on_)
    WHERE NOT s.done AND s.start_date IS NOT NULL AND s.start_time IS NOT NULL AND k.on_
  ), ins AS (
    INSERT INTO public.reminder_deliveries AS d (user_id, subtask_id, kind, fire_at, title, attempts)
    SELECT c.user_id, c.subtask_id, c.kind, c.fire_at, c.title, 1 FROM cand c
    WHERE c.fire_at <= p_now AND c.fire_at > p_now - p_grace AND c.fire_at >= c.reminders_from
    ON CONFLICT (subtask_id, kind, fire_at) DO NOTHING
    RETURNING d.id, d.user_id, d.subtask_id, d.kind, d.fire_at, d.title, d.attempts
  ), re AS (
    -- Retry only reminders whose task still exists, is open, and still has the same fire time.
    UPDATE public.reminder_deliveries d SET status = 'claimed', attempts = d.attempts + 1, next_attempt_at = NULL, updated_at = p_now
    WHERE d.status = 'retry' AND d.next_attempt_at <= p_now AND d.fire_at > p_now - p_grace
      AND EXISTS (SELECT 1 FROM cand c WHERE c.subtask_id = d.subtask_id AND c.kind = d.kind AND c.fire_at = d.fire_at)
    RETURNING d.id, d.user_id, d.subtask_id, d.kind, d.fire_at, d.title, d.attempts
  )
  SELECT * FROM ins UNION ALL SELECT * FROM re;
  -- Give up on stale retries.
  UPDATE public.reminder_deliveries d SET status = 'failed', next_attempt_at = NULL, updated_at = p_now
  WHERE d.status = 'retry' AND d.fire_at <= p_now - p_grace;
END $$;
REVOKE ALL ON FUNCTION public.claim_due_reminders(timestamptz, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_reminders(timestamptz, interval) TO service_role;