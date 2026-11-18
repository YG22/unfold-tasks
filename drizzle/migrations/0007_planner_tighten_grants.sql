REVOKE ALL ON public.planner_categories, public.planner_events, public.planner_exceptions,
  public.planner_availability, public.planner_settings, public.planner_operations FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.planner_categories, public.planner_events,
  public.planner_exceptions, public.planner_availability, public.planner_settings, public.planner_operations FROM authenticated;