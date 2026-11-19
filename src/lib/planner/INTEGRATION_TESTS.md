# Planner – real-backend integration scenarios (Stage 9B.2f)

Not run yet. Each needs separate approval: it creates test accounts and planner rows in the live backend.
Clean-up plan required before running (planner rows are soft-deleted, not removed, and have no link to the account).

1. **Authentication and ownership** – user A cannot read B's rows; anonymous visitors read nothing and cannot call the save function; an action naming B's record id fails for A without revealing content.
2. **Create, update, soft delete** – versions go 1 → 2 → 3; deleted rows stay on the server with `deleted_at`; undelete restores; edits to a deleted row are refused ("deleted").
3. **Offline retry** – queue edits offline, reload the page, reconnect: each edit is applied once (versions confirm), queue empties, status "saved".
4. **Lost/late answers and timeouts** – abort the connection after the request is sent: the retry returns "unchanged", no duplicate version bump.
5. **Version conflicts** – two devices edit the same record: the second gets "stale"; both versions are kept; "keep mine" and "keep server" each end with the expected server row.
6. **Realtime updates** – an edit on device 1 appears on device 2 within seconds; device 2's pending edit is not replaced; only the five planner data tables are subscribed (never planner_operations); no events from another user arrive.
7. **Account switching** – sign out / sign in as another user while a save is pending: the old channel is removed, A's cache stays separate, B never sees A's data.
8. **Recurring-series splits** – split from a date: old series ends the day before, new series links back, later exceptions become superseded (kept), earlier exceptions unchanged; repeating the split returns "unchanged".
9. **Restore interaction** – a restore preview/apply while a device has pending edits: those edits then get "stale" conflicts instead of overwriting restored data; omitted sections stay untouched.
10. **Unreadable device cache** – corrupt the pending-edit cache: sync pauses with a recovery state, nothing is sent, the raw copy is preserved.

## Known limitations (as of Stage 9C.1)

- Task and planner restores are not one atomic operation (planner restores first; tasks only if it succeeded).
- Live updates were not re-tested after the Scenario 10 fix.
- Real notification delivery has not been tested.
- Signed-in restore was tested only against the isolated Draft backend.

## Event management (Stage 9C.2) – known limitations
- A single occurrence of a recurring event can change only its date, start time and duration; title/category overrides are not supported.
- "Edit the whole series" on a series that was split earlier changes only the chosen part; its start date (linked to the earlier part) and end date (linked to a later part) are locked.
- Guest deletion is stricter than cloud deletion (a category in use or one split part on its own cannot be deleted).
- Guest undelete is not available except through an explicit backup restore; deleted guest records stay stored on the device.
- Signed-in whole-series delete sends one soft delete per part (newest first); if a part is refused mid-way the user is told and the remaining parts stay.
- Signed-in event management was tested against the simulated server only, not the live backend.
