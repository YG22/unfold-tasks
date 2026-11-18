CREATE OR REPLACE FUNCTION public._planner_restore(uid uuid, p jsonb, apply_ boolean)
 RETURNS jsonb LANGUAGE plpgsql SET search_path TO public, pg_temp
AS $function$
DECLARE
  short text; t text; cols text[]; rec jsonb; cur jsonb; rid uuid; curv bigint; expv bigint;
  op uuid := (p->>'op_id')::uuid; prev jsonb; plan jsonb := '{}'; items jsonb; conflicts jsonb := '[]';
  counts jsonb := '{}'; sections jsonb := '{}'; added int; replaced int; same int; removed int; ids uuid[]; sec jsonb;
BEGIN
  IF jsonb_typeof(p->'data') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'planner: restore data must be an object'; END IF;
  FOREACH short IN ARRAY ARRAY['categories','events','exceptions','availability'] LOOP
    IF p->'data' ? short THEN
      IF jsonb_typeof(p->'data'->short) <> 'array' THEN RAISE EXCEPTION 'planner: restore section % must be an array', short; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(p->'data'->short) e WHERE jsonb_typeof(e) <> 'object') THEN
        RAISE EXCEPTION 'planner: restore section % contains invalid records', short; END IF;
    END IF;
  END LOOP;
  IF p->'data' ? 'settings' AND jsonb_typeof(p->'data'->'settings') <> 'object' THEN
    RAISE EXCEPTION 'planner: restore settings must be an object'; END IF;
  IF apply_ THEN
    IF op IS NULL OR coalesce((p->>'confirmed')::boolean, false) IS NOT TRUE THEN RAISE EXCEPTION 'planner: restore needs op_id and confirmation'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(uid::text || ':' || op::text, 0));
    SELECT result INTO prev FROM public.planner_operations WHERE user_id = uid AND op_id = op;
    IF prev IS NOT NULL THEN RETURN prev || '{"repeated":true}'; END IF;
    SET CONSTRAINTS ALL DEFERRED;
  END IF;
  FOREACH short IN ARRAY ARRAY['categories','events','exceptions','availability','settings'] LOOP
    sections := sections || jsonb_build_object(short, CASE WHEN p->'data' ? short THEN 'included' ELSE 'omitted' END);
  END LOOP;
  FOREACH short IN ARRAY ARRAY['categories','events','exceptions','availability'] LOOP
    CONTINUE WHEN NOT (p->'data' ? short);
    sec := p->'data'->short;
    t := public._planner_table(short); cols := public._planner_cols(t, true); items := '[]';
    EXECUTE format('SELECT coalesce(array_agg(DISTINCT x), ''{}'') FROM (SELECT (e->>''id'')::uuid x FROM jsonb_array_elements($1) e UNION SELECT id FROM public.%I WHERE user_id = $2 AND deleted_at IS NULL) q', t)
      INTO ids USING sec, uid;
    IF EXISTS (SELECT 1 FROM unnest(ids) i WHERE i IS NULL) THEN RAISE EXCEPTION 'planner: restore record without id'; END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(sec)) <> (SELECT count(DISTINCT e->>'id') FROM jsonb_array_elements(sec) e) THEN
      RAISE EXCEPTION 'planner: duplicate id in restore'; END IF;
    FOREACH rid IN ARRAY ids LOOP
      cur := public._planner_get(t, uid, rid);
      SELECT e INTO rec FROM jsonb_array_elements(sec) e WHERE (e->>'id')::uuid = rid;
      curv := coalesce((cur->>'version')::bigint, 0);
      items := items || jsonb_build_object('id', rid, 'version', curv, 'action',
        CASE WHEN rec IS NULL THEN 'delete' WHEN cur IS NULL THEN 'add'
             WHEN cur->>'deleted_at' IS NULL AND public._planner_content(t, cur, cols) = public._planner_content(t, public._planner_defaults(t) || rec, cols) THEN 'same'
             ELSE 'replace' END);
      IF apply_ THEN
        expv := (p->'expected'->short->>rid::text)::bigint;
        IF expv IS DISTINCT FROM curv THEN conflicts := conflicts || jsonb_build_object('table', short, 'id', rid, 'expected', expv, 'current', curv); END IF;
      END IF;
    END LOOP;
    plan := plan || jsonb_build_object(short, items);
  END LOOP;
  IF p->'data' ? 'settings' THEN
    SELECT coalesce((SELECT version FROM public.planner_settings WHERE user_id = uid FOR UPDATE), 0) INTO curv;
    plan := plan || jsonb_build_object('settings_version', curv);
    IF apply_ AND (p->'expected'->>'settings')::bigint IS DISTINCT FROM curv THEN
      conflicts := conflicts || jsonb_build_object('table', 'settings', 'expected', p->'expected'->'settings', 'current', curv); END IF;
  END IF;
  IF NOT apply_ THEN RETURN jsonb_build_object('status', 'preview', 'sections', sections, 'plan', plan); END IF;
  IF jsonb_array_length(conflicts) > 0 THEN RETURN jsonb_build_object('status', 'conflict', 'changed', conflicts); END IF;
  FOREACH short IN ARRAY ARRAY['categories','events','exceptions','availability'] LOOP
    CONTINUE WHEN NOT (p->'data' ? short);
    t := public._planner_table(short); cols := public._planner_cols(t, true); added := 0; replaced := 0; same := 0; removed := 0;
    FOR items IN SELECT e FROM jsonb_array_elements(plan->short) e LOOP
      rid := (items->>'id')::uuid;
      SELECT e INTO rec FROM jsonb_array_elements(p->'data'->short) e WHERE (e->>'id')::uuid = rid;
      CASE items->>'action'
        WHEN 'same' THEN same := same + 1;
        WHEN 'add' THEN
          IF public._planner_insert(t, uid, rid, public._planner_content(t, public._planner_defaults(t) || rec, cols), cols) <> 1 THEN
            RAISE EXCEPTION 'planner: restore conflict on %', rid; END IF;
          added := added + 1;
        WHEN 'replace' THEN
          PERFORM public._planner_update(t, uid, rid, public._planner_content(t, public._planner_defaults(t) || rec, cols), cols, NULL); replaced := replaced + 1;
        ELSE
          cur := public._planner_get(t, uid, rid);
          PERFORM public._planner_update(t, uid, rid, public._planner_content(t, cur, cols), cols, now()); removed := removed + 1;
      END CASE;
    END LOOP;
    counts := counts || jsonb_build_object(short, jsonb_build_object('added', added, 'replaced', replaced, 'same', same, 'deleted', removed));
  END LOOP;
  IF p->'data' ? 'settings' THEN
    PERFORM public._planner_settings(uid, jsonb_build_object('base_version', curv, 'data', p->'data'->'settings'));
  END IF;
  prev := jsonb_build_object('status', 'applied', 'op_id', op, 'sections', sections, 'counts', counts);
  INSERT INTO public.planner_operations (user_id, op_id, kind, result) VALUES (uid, op, 'restore', prev);
  RETURN prev;
END $function$;

ALTER FUNCTION public.apply_planner_changes(jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public._planner_cols(text, boolean) SET search_path = public, pg_temp;
ALTER FUNCTION public._planner_content(text, jsonb, text[]) SET search_path = public, pg_temp;
ALTER FUNCTION public._planner_defaults(text) SET search_path = public, pg_temp;
ALTER FUNCTION public._planner_get(text, uuid, uuid) SET search_path = public, pg_temp;
ALTER FUNCTION public._planner_insert(text, uuid, uuid, jsonb, text[]) SET search_path = public, pg_temp;
ALTER FUNCTION public._planner_record(uuid, jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public._planner_settings(uuid, jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public._planner_split(uuid, jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public._planner_status(uuid, text, jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public._planner_table(text) SET search_path = public, pg_temp;
ALTER FUNCTION public._planner_update(text, uuid, uuid, jsonb, text[], timestamptz) SET search_path = public, pg_temp;
ALTER FUNCTION public.planner_stamp() SET search_path = public, pg_temp;
ALTER FUNCTION public.planner_days_ok(smallint[]) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION public._planner_restore(uuid, jsonb, boolean) FROM PUBLIC, anon, authenticated;