CREATE TABLE public.task_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  title text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_groups TO authenticated;
GRANT ALL ON public.task_groups TO service_role;
ALTER TABLE public.task_groups ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.task_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  group_id uuid REFERENCES public.task_groups(id) ON DELETE SET NULL,
  title text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.task_lists TO authenticated;
GRANT ALL ON public.task_lists TO service_role;
ALTER TABLE public.task_lists ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.subtasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL DEFAULT auth.uid(),
  list_id uuid NOT NULL REFERENCES public.task_lists(id) ON DELETE CASCADE,
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  due_date date,
  start_date date,
  start_time time,
  duration_min integer CHECK (duration_min IS NULL OR duration_min > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_time IS NULL OR start_date IS NOT NULL)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subtasks TO authenticated;
GRANT ALL ON public.subtasks TO service_role;
ALTER TABLE public.subtasks ENABLE ROW LEVEL SECURITY;

CREATE INDEX ON public.task_groups(user_id);
CREATE INDEX ON public.task_lists(user_id);
CREATE INDEX ON public.task_lists(group_id);
CREATE INDEX ON public.subtasks(user_id);
CREATE INDEX ON public.subtasks(list_id);

-- Owner-only policies
CREATE POLICY "own groups select" ON public.task_groups FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own groups insert" ON public.task_groups FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own groups update" ON public.task_groups FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own groups delete" ON public.task_groups FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "own lists select" ON public.task_lists FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own lists insert" ON public.task_lists FOR INSERT TO authenticated WITH CHECK (
  auth.uid() = user_id AND (group_id IS NULL OR EXISTS (SELECT 1 FROM public.task_groups g WHERE g.id = group_id AND g.user_id = auth.uid())));
CREATE POLICY "own lists update" ON public.task_lists FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (
  auth.uid() = user_id AND (group_id IS NULL OR EXISTS (SELECT 1 FROM public.task_groups g WHERE g.id = group_id AND g.user_id = auth.uid())));
CREATE POLICY "own lists delete" ON public.task_lists FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "own subtasks select" ON public.subtasks FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own subtasks insert" ON public.subtasks FOR INSERT TO authenticated WITH CHECK (
  auth.uid() = user_id AND EXISTS (SELECT 1 FROM public.task_lists l WHERE l.id = list_id AND l.user_id = auth.uid()));
CREATE POLICY "own subtasks update" ON public.subtasks FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (
  auth.uid() = user_id AND EXISTS (SELECT 1 FROM public.task_lists l WHERE l.id = list_id AND l.user_id = auth.uid()));
CREATE POLICY "own subtasks delete" ON public.subtasks FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE TRIGGER t_groups_touch BEFORE UPDATE ON public.task_groups FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER t_lists_touch BEFORE UPDATE ON public.task_lists FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER t_subtasks_touch BEFORE UPDATE ON public.subtasks FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();