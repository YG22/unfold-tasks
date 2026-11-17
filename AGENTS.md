<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->
- Tasks still persist in localStorage; Lovable Cloud tables (task_groups, task_lists, subtasks) exist with owner-only RLS but are unused until the planned migration step — why: user asked for infra first, no auto-merge of local and cloud data.
