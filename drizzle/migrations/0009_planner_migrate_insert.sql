CREATE OR REPLACE FUNCTION public._planner_migrate_insert(uid uuid, a jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path TO public, pg_temp
AS $function$
DECLARE
  t text := public._planner_table(a->>'table'); rid uuid := (a->>'id')::uuid;
  bv bigint := coalesce((a->>'base_version')::bigint, -1);
  cols text[]; nc jsonb; cur jsonb; par jsonb; ev jsonb; sup jsonb;
BEGIN
  IF t IS NULL OR rid IS NULL OR t NOT IN ('planner_events', 'planner_exceptions') THEN
    RAISE EXCEPTION 'planner: migrate_insert supports events and exceptions only'; END IF;
  IF bv <> 0 THEN RAISE EXCEPTION 'planner: migrate_insert needs base_version 0'; END IF;
  cols := public._planner_cols(t, true);
  nc := public._planner_content(t, public._planner_defaults(t) || coalesce(a->'data', '{}'), cols);
  -- References must be the caller's own live records and form a valid split history.
  IF t = 'planner_events' THEN
    IF nc->>'category_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.planner_categories
        WHERE id = (nc->>'category_id')::uuid AND user_id = uid AND deleted_at IS NULL) THEN
      RETURN public._planner_status(rid, 'invalid_reference', NULL); END IF;
    IF nc->>'split_from_event_id' IS NOT NULL THEN
      par := public._planner_get('planner_events', uid, (nc->>'split_from_event_id')::uuid);
      IF par IS NULL OR par->>'deleted_at' IS NOT NULL OR par->>'until' IS NULL
         OR (nc->>'date')::date <= (par->>'until')::date OR (par->>'id')::uuid = rid THEN
        RETURN public._planner_status(rid, 'invalid_reference', NULL); END IF;
    END IF;
  ELSE
    ev := public._planner_get('planner_events', uid, (nc->>'event_id')::uuid);
    IF ev IS NULL OR ev->>'deleted_at' IS NOT NULL THEN RETURN public._planner_status(rid, 'invalid_reference', NULL); END IF;
    IF nc->>'superseded_by_event_id' IS NOT NULL THEN
      sup := public._planner_get('planner_events', uid, (nc->>'superseded_by_event_id')::uuid);
      IF sup IS NULL OR sup->>'deleted_at' IS NOT NULL OR sup->>'split_from_event_id' IS DISTINCT FROM nc->>'event_id'
         OR (nc->>'original_date')::date < (sup->>'date')::date THEN
        RETURN public._planner_status(rid, 'invalid_reference', NULL); END IF;
    END IF;
  END IF;
  cur := public._planner_get(t, uid, rid);
  IF cur IS NOT NULL THEN
    IF cur->>'deleted_at' IS NULL AND public._planner_content(t, cur, cols) = nc THEN
      RETURN public._planner_status(rid, 'unchanged', cur); END IF;
    RETURN public._planner_status(rid, 'conflict', cur);
  END IF;
  IF public._planner_insert(t, uid, rid, nc, cols) = 1 THEN
    RETURN public._planner_status(rid, 'created', public._planner_get(t, uid, rid)); END IF;
  -- Not inserted and not ours: the id belongs to another account. Say only that.
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1)', t) INTO par USING rid;
  IF par::text = 'true' THEN RETURN public._planner_status(rid, 'id_taken', NULL); END IF;
  -- Otherwise another live exception already covers that event and date.
  RETURN public._planner_status(rid, 'conflict', NULL);
END $function$;

REVOKE ALL ON FUNCTION public._planner_migrate_insert(uuid, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.apply_planner_changes(p jsonb)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp
AS $function$
DECLARE uid uuid := auth.uid(); a jsonb; out jsonb := '[]';
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p->>'type' = 'restore_preview' THEN RETURN public._planner_restore(uid, p, false); END IF;
  IF p->>'type' = 'restore' THEN RETURN public._planner_restore(uid, p, true); END IF;
  FOR a IN SELECT * FROM jsonb_array_elements(coalesce(p->'actions', '[]')) LOOP
    out := out || CASE a->>'type'
      WHEN 'split' THEN public._planner_split(uid, a)
      WHEN 'settings' THEN public._planner_settings(uid, a)
      WHEN 'migrate_insert' THEN public._planner_migrate_insert(uid, a)
      ELSE public._planner_record(uid, a) END;
  END LOOP;
  RETURN jsonb_build_object('results', out);
END $function$;

REVOKE ALL ON FUNCTION public.apply_planner_changes(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_planner_changes(jsonb) TO authenticated;