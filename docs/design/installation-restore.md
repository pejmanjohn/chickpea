# Per-installation point-in-time restore

Core supplies host RPCs for the SQLite Durable Objects of one installation:
`TagStateStore`, `SlackThreadRunner`, all Flue agent classes, and `Sandbox`.
Both RPCs refuse standalone deployments and requests naming another
installation. They use the object's env, scoped from its `i1~` name, and the
state store also checks its persisted installation binding. There is no
customer UI or change to standalone routing, storage, or startup.

`chickpeaHostRestoreBookmarks({ installationId, timestamp })` returns
`{ timestamp, currentBookmark, targetBookmark }`. T is Unix epoch milliseconds
within the past 30 days. `chickpeaHostRestore({ installationId,
expectedCurrentBookmark, targetBookmark })` refuses a moved current bookmark,
awaits `storage.onNextSessionRestoreBookmark(targetBookmark)`, then calls
`ctx.abort()`. The input gate covers the fence and scheduling. Refusals leave
the object running. Cloudflare validates the opaque bookmark's retained
history. A Sandbox must have its container stopped before either call.

The host wrappers in `src/state/installation-objects.ts` validate ownership
before resolving a stub. `restoreInstallationObject` additionally requires
`confirmInstallationId`. `buildInstallationRestorePlan(installationId,
inventory)` is pure, accepts the concatenated inventory pages, adds the
implicit state store, and orders runners, agents, Sandboxes, then the state
store. It rejects foreign names, unknown kinds and duplicate entries. It
cannot establish whether the supplied inventory is complete.

The host serving many installations must implement these operator jobs:

1. Suspend the installation in the host registry and gate every ingress,
   dispatch, scheduled job and delivery path. Wait for active work to stop;
   stop Sandbox containers and settle their lifecycle writes. Run the existing
   `cancel_pending` if needed to quiet work before preparing. Keep the host's
   suspension outside the storage being restored.
2. Census before restore: exhaust `listInstallationObjects` pagination and
   include the implicit state store. Backfill legacy inventory before taking
   bookmarks. Report any unknown residue instead of claiming a complete
   restore. Save exact object kinds and names outside tenant storage, including
   objects first seen after T, which the restored inventory may no longer list.
3. `restore_prepare`: call `readInstallationObjectRestoreBookmarks` for every
   planned object at the same T. Persist each object's current and target
   bookmarks, T, target deployment and installation in a private operator
   record. Preparation must complete without errors before apply is offered.
   The prepared current bookmark is also each object's undo point: a restore
   schedules only when the object is still at that bookmark, so restoring to
   it later returns the object to its pre-restore state.
4. `restore_apply --confirm inst_…`: require the saved installation confirmation
   and keep it suspended. Check the prepared record and T's remaining retention
   window. Call `restoreInstallationObject` serially in the saved plan's order,
   passing each object's exact prepared fence and target. Stop on a moved
   bookmark or other failure. A restore is per object, not a transaction across
   the installation. Keep progress and partial-failure evidence outside it.
   An object evicted between prepare and apply runs its constructor again when
   apply wakes it, and that start-up work may move its bookmark. Apply then
   refuses that object with `restore_bookmark_moved`; prepare it again and
   review the new fence before applying it.
5. `ctx.abort()` can interrupt a successful RPC, so a disconnect alone proves
   neither success nor failure. Obtain a fresh stub and reconcile the restored
   state before marking that step complete. Never replace a moved fence and
   retry silently. A restart can perform Core/SDK initialization writes, so
   equality with the target bookmark alone is not a general success check.
6. Census after restore and run `cancel_pending` while still suspended, over
   the union of saved pre-restore objects and the new inventory, state store
   last. Restored queued jobs and delivery records must not replay on resume.
   Capture the post-cancellation census and verify acceptance before resume.

This restores SQL and key-value state in each Durable Object. It does not
rewind Slack, provider or connector side effects, D1, the host registry, R2
checkpoints, or container files. Restoring Sandbox metadata may reference a
checkpoint whose R2 objects have expired; the host must assess those separately.
Cloudflare's PITR APIs require a deployed SQLite object and are unavailable
in local development. Unit fakes cover the contract, not actual recovery or
the restart/acknowledgment behavior. See the
[Cloudflare PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api).
