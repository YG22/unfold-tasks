-- Stage 9B.2a: isolated planner data layer (new objects only)
CREATE OR REPLACE FUNCTION public.planner_days_ok(a smallint[]) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT a IS NULL OR (a <@ '{0,1,2,3,4,5,6}'::smallint[] AND cardinality(a) = (SELECT count(DISTINCT x) FROM unnest(a) x))
$$;

CREATE TABLE public.planner_categories (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  color text NOT NULL CHECK (color IN ('green','blue','amber','rose','violet','teal','orange','slate')),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, user_id)
);
CREATE TABLE public.planner_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  category_builtin text CHECK (category_builtin IN ('builtin:work','builtin:study','builtin:commuting','builtin:personal','builtin:rest')),
  category_id uuid,
  date date NOT NULL,
  start_min smallint NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  duration_min integer NOT NULL CHECK (duration_min BETWEEN 1 AND 1440),
  weekdays smallint[] CHECK (public.planner_days_ok(weekdays)),
  until date,
  travel_before_min integer NOT NULL DEFAULT 0 CHECK (travel_before_min BETWEEN 0 AND 600),
  travel_after_min integer NOT NULL DEFAULT 0 CHECK (travel_after_min BETWEEN 0 AND 600),
  notes text CHECK (notes IS NULL OR length(notes) <= 2000),
  split_from_event_id uuid,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, user_id),
  CHECK (until IS NULL OR until >= date),
  CHECK (category_builtin IS NULL OR category_id IS NULL),
  CHECK (split_from_event_id IS NULL OR split_from_event_id <> id),
  FOREIGN KEY (category_id, user_id) REFERENCES public.planner_categories (id, user_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (split_from_event_id, user_id) REFERENCES public.planner_events (id, user_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE public.planner_exceptions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  event_id uuid NOT NULL,
  original_date date NOT NULL,
  type text NOT NULL CHECK (type IN ('skip','change')),
  new_date date,
  new_start_min smallint CHECK (new_start_min BETWEEN 0 AND 1439),
  new_duration_min integer CHECK (new_duration_min BETWEEN 1 AND 1440),
  superseded_by_event_id uuid,
  superseded_at timestamptz,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((type = 'skip' AND new_date IS NULL AND new_start_min IS NULL AND new_duration_min IS NULL)
      OR (type = 'change' AND (new_date IS NOT NULL OR new_start_min IS NOT NULL OR new_duration_min IS NOT NULL))),
  CHECK ((superseded_by_event_id IS NULL) = (superseded_at IS NULL)),
  FOREIGN KEY (event_id, user_id) REFERENCES public.planner_events (id, user_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (superseded_by_event_id, user_id) REFERENCES public.planner_events (id, user_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE public.planner_availability (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL DEFAULT auth.uid(),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min smallint NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min smallint NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  ends_next_day boolean NOT NULL DEFAULT false,
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK ((NOT ends_next_day AND end_min > start_min) OR (ends_next_day AND end_min < start_min))
);
CREATE TABLE public.planner_settings (
  user_id uuid PRIMARY KEY DEFAULT auth.uid(),
  default_view text NOT NULL DEFAULT 'week' CHECK (default_view IN ('day','week')),
  suggestion_days_off smallint[] NOT NULL DEFAULT '{}' CHECK (public.planner_days_ok(suggestion_days_off)),
  timezone text CHECK (timezone IS NULL OR length(timezone) BETWEEN 1 AND 64),
  version bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.planner_operations (
  user_id uuid NOT NULL,
  op_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('restore')),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, op_id)
);

-- Clients may only read; every write goes through apply_planner_changes.
GRANT SELECT ON public.planner_categories, public.planner_events, public.planner_exceptions,
  public.planner_availability, public.planner_settings, public.planner_operations TO authenticated;
GRANT ALL ON public.planner_categories, public.planner_events, public.planner_exceptions,
  public.planner_availability, public.planner_settings, public.planner_operations TO service_role;

ALTER TABLE public.planner_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.planner_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.planner_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.planner_availability ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.planner_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.planner_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own planner categories select" ON public.planner_categories FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own planner events select" ON public.planner_events FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own planner exceptions select" ON public.planner_exceptions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own planner availability select" ON public.planner_availability FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own planner settings select" ON public.planner_settings FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own planner operations select" ON public.planner_operations FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE UNIQUE INDEX planner_categories_live_name ON public.planner_categories (user_id, lower(btrim(name))) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX planner_exceptions_live_one ON public.planner_exceptions (event_id, original_date) WHERE deleted_at IS NULL AND superseded_at IS NULL;
CREATE UNIQUE INDEX planner_events_live_split ON public.planner_events (split_from_event_id, date) WHERE deleted_at IS NULL AND split_from_event_id IS NOT NULL;
CREATE INDEX planner_categories_user ON public.planner_categories (user_id, deleted_at);
CREATE INDEX planner_events_user ON public.planner_events (user_id, deleted_at);
CREATE INDEX planner_events_user_date ON public.planner_events (user_id, date);
CREATE INDEX planner_events_category ON public.planner_events (category_id, user_id);
CREATE INDEX planner_events_split ON public.planner_events (split_from_event_id, user_id);
CREATE INDEX planner_exceptions_user ON public.planner_exceptions (user_id, deleted_at);
CREATE INDEX planner_exceptions_event ON public.planner_exceptions (event_id, user_id);
CREATE INDEX planner_exceptions_superseded ON public.planner_exceptions (superseded_by_event_id, user_id);
CREATE INDEX planner_availability_user ON public.planner_availability (user_id, deleted_at);

-- Server-managed owner, version and timestamp.
CREATE OR REPLACE FUNCTION public.planner_stamp() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF auth.uid() IS NOT NULL THEN NEW.user_id := auth.uid(); END IF;
    NEW.version := 1; NEW.created_at := now(); NEW.updated_at := now();
  ELSE
    IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN RAISE EXCEPTION 'planner: owner cannot change'; END IF;
    IF TG_TABLE_NAME <> 'planner_settings' AND (to_jsonb(NEW)->>'id') IS DISTINCT FROM (to_jsonb(OLD)->>'id') THEN
      RAISE EXCEPTION 'planner: id cannot change'; END IF;
    NEW.version := OLD.version + 1; NEW.created_at := OLD.created_at; NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER planner_stamp BEFORE INSERT OR UPDATE ON public.planner_categories FOR EACH ROW EXECUTE FUNCTION public.planner_stamp();
CREATE TRIGGER planner_stamp BEFORE INSERT OR UPDATE ON public.planner_events FOR EACH ROW EXECUTE FUNCTION public.planner_stamp();
CREATE TRIGGER planner_stamp BEFORE INSERT OR UPDATE ON public.planner_exceptions FOR EACH ROW EXECUTE FUNCTION public.planner_stamp();
CREATE TRIGGER planner_stamp BEFORE INSERT OR UPDATE ON public.planner_availability FOR EACH ROW EXECUTE FUNCTION public.planner_stamp();
CREATE TRIGGER planner_stamp BEFORE INSERT OR UPDATE ON public.planner_settings FOR EACH ROW EXECUTE FUNCTION public.planner_stamp();

-- Internal helpers (not callable by clients).
CREATE OR REPLACE FUNCTION public._planner_table(t text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE t WHEN 'categories' THEN 'planner_categories' WHEN 'events' THEN 'planner_events'
    WHEN 'exceptions' THEN 'planner_exceptions' WHEN 'availability' THEN 'planner_availability' END
$$;
CREATE OR REPLACE FUNCTION public._planner_cols(t text, full_ boolean) RETURNS text[] LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT array_agg(column_name::text ORDER BY ordinal_position) FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = t
    AND column_name NOT IN ('id','user_id','version','created_at','updated_at','deleted_at')
    AND (full_ OR column_name NOT IN ('superseded_by_event_id','superseded_at','split_from_event_id'))
$$;
CREATE OR REPLACE FUNCTION public._planner_defaults(t text) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE t WHEN 'planner_events' THEN '{"travel_before_min":0,"travel_after_min":0}'::jsonb
    WHEN 'planner_availability' THEN '{"ends_next_day":false}'::jsonb ELSE '{}'::jsonb END
$$;
CREATE OR REPLACE FUNCTION public._planner_content(t text, j jsonb, cols text[]) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public AS $$
DECLARE n jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(jsonb_populate_record(NULL::public.%I, $1))', t) INTO n USING j;
  RETURN (SELECT coalesce(jsonb_object_agg(c, n->c), '{}'::jsonb) FROM unnest(cols) c);
END $$;
CREATE OR REPLACE FUNCTION public._planner_get(t text, uid uuid, rid uuid) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r jsonb;
BEGIN
  EXECUTE format('SELECT to_jsonb(x) FROM public.%I x WHERE id = $1 AND user_id = $2 FOR UPDATE', t) INTO r USING rid, uid;
  RETURN r;
END $$;
CREATE OR REPLACE FUNCTION public._planner_insert(t text, uid uuid, rid uuid, content jsonb, cols text[]) RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n integer; cl text; sl text;
BEGIN
  SELECT string_agg(quote_ident(c), ','), string_agg('r.' || quote_ident(c), ',') INTO cl, sl FROM unnest(cols) c;
  EXECUTE format('INSERT INTO public.%I (id, user_id, %s) SELECT $1, $2, %s FROM jsonb_populate_record(NULL::public.%I, $3) r ON CONFLICT DO NOTHING', t, cl, sl, t)
    USING rid, uid, content;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;
CREATE OR REPLACE FUNCTION public._planner_update(t text, uid uuid, rid uuid, content jsonb, cols text[], del timestamptz) RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE cl text; sl text;
BEGIN
  SELECT string_agg(quote_ident(c), ','), string_agg('r.' || quote_ident(c), ',') INTO cl, sl FROM unnest(cols) c;
  EXECUTE format('UPDATE public.%I t SET (%s) = (SELECT %s FROM jsonb_populate_record(NULL::public.%I, $1) r), deleted_at = $4 WHERE id = $2 AND user_id = $3', t, cl, sl, t)
    USING content, rid, uid, del;
END $$;
CREATE OR REPLACE FUNCTION public._planner_status(rid uuid, s text, cur jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT jsonb_build_object('id', rid, 'status', s, 'version', (cur->>'version')::bigint, 'current', cur)
$$;

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
    IF (cur->>'version')::bigint <> bv THEN RETURN public._planner_status(rid, 'stale', cur); END IF;
    nc := public._planner_content(t, cur || coalesce(a->'data', '{}'), cols);
    IF nc = public._planner_content(t, cur, cols) THEN RETURN public._planner_status(rid, 'unchanged', cur); END IF;
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

CREATE OR REPLACE FUNCTION public._planner_split(uid uuid, a jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  oid_ uuid := (a->>'event_id')::uuid; nid uuid := (a->>'new_id')::uuid; fd date := (a->>'from_date')::date;
  bv bigint := coalesce((a->>'base_version')::bigint, -1);
  old jsonb; ex jsonb; nc jsonb; n integer; fcols text[] := public._planner_cols('planner_events', true);
BEGIN
  IF oid_ IS NULL OR nid IS NULL OR fd IS NULL OR oid_ = nid THEN RAISE EXCEPTION 'planner: invalid split'; END IF;
  old := public._planner_get('planner_events', uid, oid_);
  IF old IS NULL THEN RETURN public._planner_status(oid_, 'missing', NULL); END IF;
  ex := public._planner_get('planner_events', uid, nid);
  IF ex IS NOT NULL THEN
    IF ex->>'split_from_event_id' = oid_::text AND (ex->>'date')::date = fd THEN
      RETURN public._planner_status(nid, 'unchanged', ex)
        || jsonb_build_object('superseded', (SELECT count(*) FROM public.planner_exceptions WHERE user_id = uid AND superseded_by_event_id = nid));
    END IF;
    RETURN public._planner_status(nid, 'conflict', ex);
  END IF;
  IF old->>'deleted_at' IS NOT NULL THEN RETURN public._planner_status(oid_, 'deleted', old); END IF;
  IF (old->>'version')::bigint <> bv THEN RETURN public._planner_status(oid_, 'stale', old); END IF;
  IF fd <= (old->>'date')::date OR (old->>'until' IS NOT NULL AND fd > (old->>'until')::date) THEN
    RAISE EXCEPTION 'planner: split date outside series'; END IF;
  nc := public._planner_content('planner_events',
    old || (coalesce(a->'data', '{}') - 'split_from_event_id' - 'date') || jsonb_build_object('date', fd, 'split_from_event_id', oid_), fcols);
  PERFORM public._planner_update('planner_events', uid, oid_,
    public._planner_content('planner_events', old || jsonb_build_object('until', fd - 1), fcols), fcols, NULL);
  IF public._planner_insert('planner_events', uid, nid, nc, fcols) <> 1 THEN RAISE EXCEPTION 'planner: id already in use'; END IF;
  UPDATE public.planner_exceptions SET superseded_by_event_id = nid, superseded_at = now()
    WHERE user_id = uid AND event_id = oid_ AND original_date >= fd AND deleted_at IS NULL AND superseded_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN public._planner_status(nid, 'split', public._planner_get('planner_events', uid, nid)) || jsonb_build_object('superseded', n);
END $$;

CREATE OR REPLACE FUNCTION public._planner_settings(uid uuid, a jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE cur jsonb; nc jsonb; bv bigint := coalesce((a->>'base_version')::bigint, -1);
  cols text[] := ARRAY['default_view','suggestion_days_off','timezone'];
BEGIN
  SELECT to_jsonb(s) INTO cur FROM public.planner_settings s WHERE user_id = uid FOR UPDATE;
  IF cur IS NULL THEN
    IF bv <> 0 THEN RETURN public._planner_status(uid, 'missing', NULL); END IF;
    nc := public._planner_content('planner_settings', '{"default_view":"week","suggestion_days_off":[]}'::jsonb || coalesce(a->'data', '{}'), cols);
    INSERT INTO public.planner_settings (user_id, default_view, suggestion_days_off, timezone)
      SELECT uid, r.default_view, r.suggestion_days_off, r.timezone FROM jsonb_populate_record(NULL::public.planner_settings, nc) r
      ON CONFLICT (user_id) DO NOTHING;
    SELECT to_jsonb(s) INTO cur FROM public.planner_settings s WHERE user_id = uid FOR UPDATE;
    IF (cur->>'version')::bigint = 1 AND public._planner_content('planner_settings', cur, cols) = nc THEN
      RETURN public._planner_status(uid, 'created', cur); END IF;
    RETURN public._planner_status(uid, 'conflict', cur);
  END IF;
  IF (cur->>'version')::bigint <> bv THEN RETURN public._planner_status(uid, 'stale', cur); END IF;
  nc := public._planner_content('planner_settings', cur || coalesce(a->'data', '{}'), cols);
  IF nc = public._planner_content('planner_settings', cur, cols) THEN RETURN public._planner_status(uid, 'unchanged', cur); END IF;
  UPDATE public.planner_settings s SET default_view = r.default_view, suggestion_days_off = r.suggestion_days_off, timezone = r.timezone
    FROM jsonb_populate_record(NULL::public.planner_settings, nc) r WHERE s.user_id = uid;
  SELECT to_jsonb(s) INTO cur FROM public.planner_settings s WHERE user_id = uid;
  RETURN public._planner_status(uid, 'updated', cur);
END $$;

-- Restore: preview reports versions; restore applies only if nothing changed since preview. Idempotent by op_id.
CREATE OR REPLACE FUNCTION public._planner_restore(uid uuid, p jsonb, apply_ boolean) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  short text; t text; cols text[]; rec jsonb; cur jsonb; nc jsonb; rid uuid; curv bigint; expv bigint;
  op uuid := (p->>'op_id')::uuid; prev jsonb; plan jsonb := '{}'; items jsonb; conflicts jsonb := '[]';
  counts jsonb := '{}'; added int; replaced int; same int; removed int; ids uuid[];
BEGIN
  IF apply_ THEN
    IF op IS NULL OR coalesce((p->>'confirmed')::boolean, false) IS NOT TRUE THEN RAISE EXCEPTION 'planner: restore needs op_id and confirmation'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(uid::text || ':' || op::text, 0));
    SELECT result INTO prev FROM public.planner_operations WHERE user_id = uid AND op_id = op;
    IF prev IS NOT NULL THEN RETURN prev || '{"repeated":true}'; END IF;
    SET CONSTRAINTS ALL DEFERRED;
  END IF;
  FOREACH short IN ARRAY ARRAY['categories','events','exceptions','availability'] LOOP
    t := public._planner_table(short); cols := public._planner_cols(t, true); items := '[]';
    EXECUTE format('SELECT coalesce(array_agg(DISTINCT x), ''{}'') FROM (SELECT (e->>''id'')::uuid x FROM jsonb_array_elements($1) e UNION SELECT id FROM public.%I WHERE user_id = $2 AND deleted_at IS NULL) q', t)
      INTO ids USING coalesce(p->'data'->short, '[]'), uid;
    IF EXISTS (SELECT 1 FROM unnest(ids) i WHERE i IS NULL) THEN RAISE EXCEPTION 'planner: restore record without id'; END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(coalesce(p->'data'->short, '[]'))) <>
       (SELECT count(DISTINCT e->>'id') FROM jsonb_array_elements(coalesce(p->'data'->short, '[]')) e) THEN
      RAISE EXCEPTION 'planner: duplicate id in restore'; END IF;
    FOREACH rid IN ARRAY ids LOOP
      cur := public._planner_get(t, uid, rid);
      SELECT e INTO rec FROM jsonb_array_elements(coalesce(p->'data'->short, '[]')) e WHERE (e->>'id')::uuid = rid;
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
  IF NOT apply_ THEN RETURN jsonb_build_object('status', 'preview', 'plan', plan); END IF;
  IF jsonb_array_length(conflicts) > 0 THEN RETURN jsonb_build_object('status', 'conflict', 'changed', conflicts); END IF;
  FOREACH short IN ARRAY ARRAY['categories','events','exceptions','availability'] LOOP
    t := public._planner_table(short); cols := public._planner_cols(t, true); added := 0; replaced := 0; same := 0; removed := 0;
    FOR items IN SELECT e FROM jsonb_array_elements(plan->short) e LOOP
      rid := (items->>'id')::uuid;
      SELECT e INTO rec FROM jsonb_array_elements(coalesce(p->'data'->short, '[]')) e WHERE (e->>'id')::uuid = rid;
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
  prev := jsonb_build_object('status', 'applied', 'op_id', op, 'counts', counts);
  INSERT INTO public.planner_operations (user_id, op_id, kind, result) VALUES (uid, op, 'restore', prev);
  RETURN prev;
END $$;

-- The only client entry point. SECURITY DEFINER because clients have no direct write access;
-- every statement is scoped to auth.uid() and composite keys block cross-user links.
CREATE OR REPLACE FUNCTION public.apply_planner_changes(p jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE uid uuid := auth.uid(); a jsonb; out jsonb := '[]';
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;
  IF p->>'type' = 'restore_preview' THEN RETURN public._planner_restore(uid, p, false); END IF;
  IF p->>'type' = 'restore' THEN RETURN public._planner_restore(uid, p, true); END IF;
  FOR a IN SELECT * FROM jsonb_array_elements(coalesce(p->'actions', '[]')) LOOP
    out := out || CASE a->>'type'
      WHEN 'split' THEN public._planner_split(uid, a)
      WHEN 'settings' THEN public._planner_settings(uid, a)
      ELSE public._planner_record(uid, a) END;
  END LOOP;
  RETURN jsonb_build_object('results', out);
END $$;

REVOKE ALL ON FUNCTION public.apply_planner_changes(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_planner_changes(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public._planner_table(text), public._planner_cols(text, boolean), public._planner_defaults(text),
  public._planner_content(text, jsonb, text[]), public._planner_get(text, uuid, uuid), public._planner_insert(text, uuid, uuid, jsonb, text[]),
  public._planner_update(text, uuid, uuid, jsonb, text[], timestamptz), public._planner_status(uuid, text, jsonb),
  public._planner_record(uuid, jsonb), public._planner_split(uuid, jsonb), public._planner_settings(uuid, jsonb),
  public._planner_restore(uuid, jsonb, boolean), public.planner_stamp() FROM PUBLIC, anon, authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE public.planner_categories, public.planner_events,
  public.planner_exceptions, public.planner_availability, public.planner_settings;