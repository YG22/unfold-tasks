ALTER TABLE public.subtasks DROP CONSTRAINT subtasks_list_id_fkey,
  ADD CONSTRAINT subtasks_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.task_lists(id) ON DELETE CASCADE;
ALTER TABLE public.task_lists DROP CONSTRAINT task_lists_group_id_fkey,
  ADD CONSTRAINT task_lists_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.task_groups(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.apply_task_changes(p jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE uid uuid := auth.uid();
BEGIN
  IF uid IS NULL THEN RAISE EXCEPTION 'not authenticated'; END IF;

  INSERT INTO task_groups (id, user_id, title, position)
  SELECT (x->>'id')::uuid, uid, x->>'title', (x->>'position')::int
  FROM jsonb_array_elements(coalesce(p->'groups','[]'::jsonb)) x
  ON CONFLICT (id) DO UPDATE SET title = excluded.title, position = excluded.position, updated_at = now();

  INSERT INTO task_lists (id, user_id, group_id, title, position)
  SELECT (x->>'id')::uuid, uid,
    CASE WHEN EXISTS (SELECT 1 FROM task_groups g WHERE g.id = (x->>'group_id')::uuid AND g.user_id = uid)
      THEN (x->>'group_id')::uuid END,
    x->>'title', (x->>'position')::int
  FROM jsonb_array_elements(coalesce(p->'lists','[]'::jsonb)) x
  ON CONFLICT (id) DO UPDATE SET group_id = excluded.group_id, title = excluded.title, position = excluded.position, updated_at = now();

  INSERT INTO subtasks (id, user_id, list_id, title, done, position, due_date, start_date, start_time, duration_min)
  SELECT (x->>'id')::uuid, uid, (x->>'list_id')::uuid, x->>'title', (x->>'done')::boolean, (x->>'position')::int,
    (x->>'due_date')::date, (x->>'start_date')::date, (x->>'start_time')::time, (x->>'duration_min')::int
  FROM jsonb_array_elements(coalesce(p->'subtasks','[]'::jsonb)) x
  WHERE EXISTS (SELECT 1 FROM task_lists l WHERE l.id = (x->>'list_id')::uuid AND l.user_id = uid)
  ON CONFLICT (id) DO UPDATE SET list_id = excluded.list_id, title = excluded.title, done = excluded.done,
    position = excluded.position, due_date = excluded.due_date, start_date = excluded.start_date,
    start_time = excluded.start_time, duration_min = excluded.duration_min, updated_at = now();

  DELETE FROM subtasks WHERE user_id = uid AND id IN (SELECT jsonb_array_elements_text(coalesce(p->'delete_subtasks','[]'::jsonb))::uuid);
  DELETE FROM task_lists WHERE user_id = uid AND id IN (SELECT jsonb_array_elements_text(coalesce(p->'delete_lists','[]'::jsonb))::uuid);
  DELETE FROM task_groups WHERE user_id = uid AND id IN (SELECT jsonb_array_elements_text(coalesce(p->'delete_groups','[]'::jsonb))::uuid);
END $$;
REVOKE ALL ON FUNCTION public.apply_task_changes(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_task_changes(jsonb) TO authenticated;

ALTER PUBLICATION supabase_realtime ADD TABLE public.task_groups, public.task_lists, public.subtasks;