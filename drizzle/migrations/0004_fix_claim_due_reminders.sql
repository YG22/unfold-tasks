CREATE OR REPLACE FUNCTION public.claim_due_reminders(p_now timestamptz DEFAULT now(), p_grace interval DEFAULT interval '15 minutes')
RETURNS TABLE (id uuid, user_id uuid, subtask_id uuid, kind text, fire_at timestamptz, title text, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH cand AS (
    SELECT s.user_id AS uid, s.id AS sid, k.kind AS kd, s.title AS ttl,
      ((s.start_date + s.start_time) AT TIME ZONE n.timezone) - k.off AS fat, n.reminders_from AS rfrom
    FROM public.subtasks s
    JOIN public.notification_settings n ON n.user_id = s.user_id AND n.enabled
    JOIN pg_timezone_names z ON z.name = n.timezone
    CROSS JOIN LATERAL (VALUES ('before', interval '10 minutes', n.remind_before), ('start', interval '0', n.remind_at_start)) AS k(kind, off, on_)
    WHERE NOT s.done AND s.start_date IS NOT NULL AND s.start_time IS NOT NULL AND k.on_
  ), ins AS (
    INSERT INTO public.reminder_deliveries AS d (user_id, subtask_id, kind, fire_at, title, attempts)
    SELECT c.uid, c.sid, c.kd, c.fat, c.ttl, 1 FROM cand c
    WHERE c.fat <= p_now AND c.fat > p_now - p_grace AND c.fat >= c.rfrom
    ON CONFLICT ON CONSTRAINT reminder_deliveries_subtask_id_kind_fire_at_key DO NOTHING
    RETURNING d.id, d.user_id, d.subtask_id, d.kind, d.fire_at, d.title, d.attempts
  ), re AS (
    UPDATE public.reminder_deliveries d SET status = 'claimed', attempts = d.attempts + 1, next_attempt_at = NULL, updated_at = p_now
    WHERE d.status = 'retry' AND d.next_attempt_at <= p_now AND d.fire_at > p_now - p_grace
      AND EXISTS (SELECT 1 FROM cand c WHERE c.sid = d.subtask_id AND c.kd = d.kind AND c.fat = d.fire_at)
    RETURNING d.id, d.user_id, d.subtask_id, d.kind, d.fire_at, d.title, d.attempts
  )
  SELECT * FROM ins UNION ALL SELECT * FROM re;
  UPDATE public.reminder_deliveries d SET status = 'failed', next_attempt_at = NULL, updated_at = p_now
  WHERE d.status = 'retry' AND d.fire_at <= p_now - p_grace;
END $$;
REVOKE ALL ON FUNCTION public.claim_due_reminders(timestamptz, interval) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_due_reminders(timestamptz, interval) TO service_role;