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
- Signed-out users and signed-in users who have not chosen cloud keep localStorage data; cloud mode (per user, per device flag) uses useTaskStore: durable local cache + snapshot diff pushed via the transactional apply_task_changes RPC, realtime refetch with rebase, last-write-wins per record — why: no silent merge, offline-safe, retry-safe stable UUIDs. Local data is never deleted by migration.
