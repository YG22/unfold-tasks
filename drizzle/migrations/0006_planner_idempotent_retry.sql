CREATE OR REPLACE FUNCTION public._planner_record(uid uuid, a jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  typ text := a->>'type'; t text := public._planner_table(a->>'table');
  rid uuid := (a->>'id')::uuid; bv bigint := coalesce((a->>'base_version')::bigint, -1);
  cols text[]; cur jsonb; nc jsonb;
BEGIN
  IF t IS NULL OR rid IS NULL THEN RAISE EXCEPTION 'planner: invalid table or id'; END IF;
  cols := public._planner_cols(t, false);
  cur := public._planner_get(t, uid, rid);
  IF typ = 'upsert' THEN
    IF cur IS NULL THEN
      IF bv <> 0 THEN RETURN public._planner_status(rid, 'missing', NULL); END IF;
      nc := public._planner_content(t, public._planner_defaults(t) || coalesce(a->'data', '{}'), cols);
      IF public._planner_insert(t, uid, rid, nc, cols) = 1 THEN
        RETURN public._planner_status(rid, 'created', jsonb_build_object('version', 1));
      END IF;
      cur := public._planner_get(t, uid, rid);
      IF cur IS NULL THEN RAISE EXCEPTION 'planner: id already in use'; END IF;
      IF cur->>'deleted_at' IS NULL AND public._planner_content(t, cur, cols) = nc THEN
        RETURN public._planner_status(rid, 'unchanged', cur); END IF;
      RETURN public._planner_status(rid, 'conflict', cur);
    END IF;
    IF cur->>'deleted_at' IS NOT NULL THEN RETURN public._planner_status(rid, 'deleted', cur); END IF;
    nc := public._planner_content(t, (CASE WHEN bv = 0 THEN public._planner_defaults(t) ELSE cur END) || coalesce(a->'data', '{}'), cols);
    -- Retry of an already-applied change: identical content is "unchanged" whatever the version.
    IF nc = public._planner_content(t, cur, cols) THEN RETURN public._planner_status(rid, 'unchanged', cur); END IF;
    IF (cur->>'version')::bigint <> bv THEN RETURN public._planner_status(rid, 'stale', cur); END IF;
    PERFORM public._planner_update(t, uid, rid, nc, cols, NULL);
  ELSIF typ IN ('delete', 'undelete') THEN
    IF cur IS NULL THEN RETURN public._planner_status(rid, 'missing', NULL); END IF;
    IF typ = 'delete' AND cur->>'deleted_at' IS NOT NULL THEN RETURN public._planner_status(rid, 'unchanged', cur); END IF;
    IF typ = 'undelete' AND cur->>'deleted_at' IS NULL THEN RETURN public._planner_status(rid, 'unchanged', cur); END IF;
    IF (cur->>'version')::bigint <> bv THEN RETURN public._planner_status(rid, 'stale', cur); END IF;
    PERFORM public._planner_update(t, uid, rid, public._planner_content(t, cur, cols), cols, CASE WHEN typ = 'delete' THEN now() END);
  ELSE RAISE EXCEPTION 'planner: unknown action %', typ;
  END IF;
  RETURN public._planner_status(rid, CASE typ WHEN 'upsert' THEN 'updated' WHEN 'delete' THEN 'deleted_ok' ELSE 'undeleted' END,
    public._planner_get(t, uid, rid));
END $$;

CREATE OR REPLACE FUNCTION public._planner_settings(uid uuid, a jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE cur jsonb; nc jsonb; bv bigint := coalesce((a->>'base_version')::bigint, -1);
  cols text[] := ARRAY['default_view','suggestion_days_off','timezone'];
  dflt jsonb := '{"default_view":"week","suggestion_days_off":[]}'::jsonb;
BEGIN
  SELECT to_jsonb(s) INTO cur FROM public.planner_settings s WHERE user_id = uid FOR UPDATE;
  IF cur IS NULL THEN
    IF bv <> 0 THEN RETURN public._planner_status(uid, 'missing', NULL); END IF;
    nc := public._planner_content('planner_settings', dflt || coalesce(a->'data', '{}'), cols);
    INSERT INTO public.planner_settings (user_id, default_view, suggestion_days_off, timezone)
      SELECT uid, r.default_view, r.suggestion_days_off, r.timezone FROM jsonb_populate_record(NULL::public.planner_settings, nc) r
      ON CONFLICT (user_id) DO NOTHING;
    SELECT to_jsonb(s) INTO cur FROM public.planner_settings s WHERE user_id = uid FOR UPDATE;
    IF (cur->>'version')::bigint = 1 AND public._planner_content('planner_settings', cur, cols) = nc THEN
      RETURN public._planner_status(uid, 'created', cur); END IF;
    RETURN public._planner_status(uid, 'conflict', cur);
  END IF;
  nc := public._planner_content('planner_settings', (CASE WHEN bv = 0 THEN dflt ELSE cur END) || coalesce(a->'data', '{}'), cols);
  IF nc = public._planner_content('planner_settings', cur, cols) THEN RETURN public._planner_status(uid, 'unchanged', cur); END IF;
  IF (cur->>'version')::bigint <> bv THEN RETURN public._planner_status(uid, 'stale', cur); END IF;
  UPDATE public.planner_settings s SET default_view = r.default_view, suggestion_days_off = r.suggestion_days_off, timezone = r.timezone
    FROM jsonb_populate_record(NULL::public.planner_settings, nc) r WHERE s.user_id = uid;
  SELECT to_jsonb(s) INTO cur FROM public.planner_settings s WHERE user_id = uid;
  RETURN public._planner_status(uid, 'updated', cur);
END $$;

REVOKE ALL ON FUNCTION public._planner_record(uuid, jsonb), public._planner_settings(uuid, jsonb) FROM PUBLIC, anon, authenticated;