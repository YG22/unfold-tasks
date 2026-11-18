CREATE OR REPLACE FUNCTION public._planner_migrate_insert(uid uuid, a jsonb) RETURNS jsonb
 LANGUAGE plpgsql SET search_path TO public, pg_temp
AS $function$
DECLARE
  t text := public._planner_table(a->>'table'); rid uuid := (a->>'id')::uuid;
  bv bigint := coalesce((a->>'base_version')::bigint, -1);
  cols text[]; nc jsonb; cur jsonb; par jsonb; ev jsonb; sup jsonb; taken boolean;
BEGIN
  IF t IS NULL OR rid IS NULL OR t NOT IN ('planner_events', 'planner_exceptions') THEN
    RAISE EXCEPTION 'planner: migrate_insert supports events and exceptions only'; END IF;
  IF bv <> 0 THEN RAISE EXCEPTION 'planner: migrate_insert needs base_version 0'; END IF;
  cols := public._planner_cols(t, true);
  nc := public._planner_content(t, public._planner_defaults(t) || coalesce(a->'data', '{}'), cols);
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
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I WHERE id = $1)', t) INTO taken USING rid;
  IF taken THEN RETURN public._planner_status(rid, 'id_taken', NULL); END IF;
  RETURN public._planner_status(rid, 'conflict', NULL);
END $function$;

REVOKE ALL ON FUNCTION public._planner_migrate_insert(uuid, jsonb) FROM PUBLIC, anon, authenticated;