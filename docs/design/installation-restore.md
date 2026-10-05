# Per-installation point-in-time restore

Core supplies host RPCs for the SQLite Durable Objects of one installation:
`TagStateStore`, `SlackThreadRunner`, all Flue agent classes, and `Sandbox`.
Every RPC refuses standalone deployments and requests naming another
installation. They use the object's env, scoped from its `i1~` name, and the
state store also checks its persisted installation binding. There is no
customer UI or change to standalone routing, storage, or startup.

## Host functions

- `chickpeaHostRestoreBookmarks({ installationId, timestamp })` returns
  `{ timestamp, currentBookmark, targetBookmark }`. T is Unix epoch
  milliseconds within the past 30 days and strictly before now on the
  object's clock. The host's and the object's clocks differ, so choose a T
  well in the past, never the current time.
- `chickpeaHostRestore({ installationId, expectedCurrentBookmark,
  targetBookmark })` refuses a moved current bookmark, awaits
  `storage.onNextSessionRestoreBookmark(targetBookmark)` and returns the
  receipt `{ expectedCurrentBookmark, targetBookmark, undoBookmark }`. It does
  not restart the object. The object remembers the receipt for the rest of
  its session: a repeated call returns it, and a different restore or a new
  preparation in that session is refused with `restore_already_scheduled`.
- `chickpeaHostRestoreRestart({ installationId })` calls
  `ctx.abort('Installation point-in-time restore')` when the session has a
  restore scheduled, which interrupts the call. Otherwise it returns
  `{ restorePending: false, currentBookmark }`. A scheduled restore applies
  on the object's next session, so after a receipt that return proves the
  restore applied.

Each call runs in one input gate. Refusals leave the object running.
Cloudflare validates the opaque bookmark's retained history. A Sandbox must
have its container stopped and that stop recorded before preparation or
scheduling (`restore_object_busy` otherwise; retry once it settles). Both
calls then delete the Containers SDK's alarm, if set, before reading the
fence: a waking Sandbox arms it, and a second later it deletes itself, which
would move the fence just read.

The host wrappers in `src/state/installation-objects.ts` validate ownership
before resolving a stub. `scheduleInstallationObjectRestore` and
`restartInstallationObject` also require `confirmInstallationId`. The restart
wrapper makes up to three calls, each over a fresh stub, and returns the
first answer. In `src/state/installation-restore.ts`,
`buildInstallationRestorePlan(installationId, inventory)` is pure, accepts the
concatenated inventory pages, adds the implicit state store and rejects
foreign names, unknown kinds and duplicate entries. It cannot establish
whether the inventory is complete. `prepareInstallationRestore(env, census,
T)` reads every planned object's bookmarks and reports each object as
prepared, skipped or failed instead of stopping at the first failure.

## Order: schedule everything, then restart callee first

Restored objects write to each other when they wake. A Sandbox restored
inside a coding turn has the container status `running`; its next session's
SDK alarm records the stop, and `Sandbox.onStop` releases its lease in the
state store. A runner resumes its restored jobs and calls the state store.
The state store's alarm hands turns to runners. With one object restored and
restarted at a time, a restored object can move the fence of one still
waiting, whichever order is chosen, and the waiting object is then refused
with `restore_bookmark_moved`.

So apply has two phases. First every object is scheduled against its own
fence while all of them still run pre-restore state. Then they restart in
plan order: the state store, which every other kind writes to, then
Sandboxes, which write only to it, then runners, Flue agents and coding
workers. A Sandbox's lease release and a runner's calls land in the restored
state store. A write to an object not yet restarted, such as the state
store's hand-off to a runner, is discarded by that object's restore. The
cancellation in step 6 settles what that leaves.

## Operator jobs

The host serving many installations must implement these jobs:

1. Suspend the installation in the host registry and gate every ingress,
   dispatch, scheduled job and delivery path. Wait for active work to stop;
   stop Sandbox containers and settle their lifecycle writes. Run the existing
   `cancel_pending` if needed to quiet work before preparing. Keep the host's
   suspension outside the storage being restored.
2. Census before restore: exhaust `listInstallationObjects` pagination and
   include the implicit state store. Save exact object kinds, names and
   `firstSeenAt` outside tenant storage. Report any unknown residue instead
   of claiming a complete restore. A backfill records legacy names with the
   time it ran, so run it once, before any T you will restore to.
3. `restore_prepare`: call `prepareInstallationRestore` with the saved census
   and T. Persist each prepared object's current and target bookmarks, the
   skipped and failed objects, T, the target deployment and the installation
   in a private operator record. Offer apply only when nothing failed and the
   skipped list has been reviewed. Each prepared current bookmark is also
   that object's undo point.
4. `restore_apply --confirm inst_…`: require the saved installation
   confirmation and keep it suspended. Check the prepared record and T's
   remaining retention window.
   - Schedule: call `scheduleInstallationObjectRestore` serially in plan
     order with each object's exact prepared fence and target. Persist each
     receipt before the next call. Stop on a refusal. A restore is per
     object, not a transaction across the installation.
   - A Sandbox evicted since preparation wakes with a new SDK alarm, which
     moves its fence, so scheduling refuses it. Prepare that Sandbox again
     and schedule it straight away. Any other moved fence needs review before
     it is prepared again. Never replace a moved fence and retry silently.
   - Restart: only once every prepared object has a receipt, call
     `restartInstallationObject` for each in plan order. Its return confirms
     the restore. Keep progress and partial-failure evidence outside the
     installation.
5. Confirm a schedule whose answer was lost by calling it again: a session
   that still holds it returns the receipt. If that is refused with
   `restore_bookmark_moved`, apply the rule: under suspension, a current
   bookmark that differs from the prepared fence after an apply attempt means
   the apply happened; the session that held the restore has ended, so it
   has applied. A Sandbox's wake writes its own alarm, so for a
   Sandbox prepare again and schedule to the same target instead. Restoring
   twice to one target gives the same storage, and the first prepared fence
   remains the undo point. The runtime logs the abort as
   `Installation point-in-time restore`; a caller may see only a reset error.
6. Census after restore and run `cancel_pending` while still suspended, after
   every restart has returned, over the union of saved pre-restore objects
   and the new inventory, state store last. Restored objects resume their
   own work as soon as they restart; the suspension refuses each agent
   operation at the admission check, and the cancellation settles the jobs
   and records left behind. Restored queued jobs and delivery records must
   not replay on resume. Capture the post-cancellation census and verify acceptance before
   resume.

## Objects younger than T, and objects erased after T

Core records an object's name before anything addresses it, so an object
whose `firstSeenAt` is after T had no storage at T. Prepare skips it with
`younger_than_target`: it is neither restored nor erased and keeps its
current storage. The restored inventory no longer lists it, so keep it in
the saved census for step 6 and for any later export or erasure. A legacy
name backfilled after T is reported the same way although the object is
older; prepare it explicitly with `readInstallationObjectRestoreBookmarks`
if review shows it existed at T.

An object erased after T is absent from the current census, so the plan
never restores it, while the restored state store at T still lists it. Its
storage stays erased, and contacting it re-creates it empty. A host that
needs it back must add it to the plan from a census saved before the
erasure, and must not if the erasure honoured a deletion request.

## What this does not restore

This restores SQL and key-value state in each Durable Object. It does not
rewind Slack, provider or connector side effects, D1, the host registry, R2
checkpoints, or container files. Restoring Sandbox metadata may reference a
checkpoint whose R2 objects have expired; the host must assess those
separately. A Sandbox restored inside a turn releases, on its next session,
the lease the restored state store holds for it, charged from that lease's
start until the release, including the time since T.

## Staging proof

Cloudflare's PITR APIs require a deployed SQLite object and are unavailable
in local development. Unit fakes cover the contract, not actual recovery.
Prove on staging, on disposable objects:

- Schedule, restart and the next session's answer restore SQL and key-value
  storage to T, and restoring to the undo bookmark or the prepared fence
  returns the object to its pre-restore state.
- Whether `onNextSessionRestoreBookmark` itself moves the current bookmark,
  and what the caller of an aborted call receives.
- What `getBookmarkForTime(T)` does for T before an object's first write: an
  error, the empty database or the first write. Check that prepare's
  `younger_than_target` skips agree with it.
- Whether a restore brings back the alarm stored at T, which decides whether
  restored runners and the state store wake on their own.
- That a cold Sandbox's preparation deletes the SDK alarm and that
  scheduling in the same session matches its fence.
- That a T a few seconds before now, chosen on the host's clock, resolves to
  the intended history.

See the
[Cloudflare PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api).
