# Per-installation point-in-time restore

Core supplies host RPCs for the SQLite Durable Objects of one installation:
`TagStateStore`, `SlackThreadRunner`, all Flue agent classes, and `Sandbox`.
Every RPC refuses standalone deployments and requests naming another
installation. They use the object's env, scoped from its `i1~` name, and the
state store also checks its persisted installation binding. There is no
customer UI or change to standalone routing, storage, or startup.

## Host functions

- `chickpeaHostRestoreBookmarks({ installationId, timestamp })` returns
  `{ timestamp, currentBookmark, targetBookmark, contentDigest }`. T is Unix
  epoch milliseconds within the past 30 days and strictly before now on the
  object's clock. The host's and the object's clocks differ, so choose a T
  well in the past, never the current time. `contentDigest` is a SHA-256
  over everything the restore replaces: each schema entry, every row of
  every table in key order, every key-value entry and the alarm.
- `chickpeaHostRestore({ installationId, expectedCurrentBookmark,
  expectedContentDigest, targetBookmark })` refuses with
  `restore_content_moved` when the object's storage no longer matches the
  prepared digest, awaits `storage.onNextSessionRestoreBookmark(targetBookmark)`
  and returns the receipt `{ expectedCurrentBookmark, expectedContentDigest,
  targetBookmark, undoBookmark }`. It does not restart the object. The object
  remembers the receipt for the rest of its session: a repeated call returns
  it, and a different restore or a new preparation in that session is
  refused with `restore_already_scheduled`.
- `chickpeaHostRestoreRestart({ installationId, expectedCurrentBookmark })`
  takes the receipt's fence. The session holding that restore calls
  `ctx.abort('Installation point-in-time restore')`, which interrupts the
  call; it refuses another fence with `restore_already_scheduled`. Any other
  session returns `{ applied: true, currentBookmark }` only once its bookmark
  has left the fence, and refuses with `restore_not_scheduled` while the
  object still holds it. A scheduled restore applies on the object's next
  session, so after a receipt that return proves the restore applied, also
  when an eviction applied it before the restart. Without a receipt it
  proves nothing: every new session starts a new bookmark.

Each call runs in one input gate. Refusals leave the object running.
Cloudflare validates the opaque bookmark's retained history. A Sandbox must
have its container stopped and that stop recorded before preparation or
scheduling (`restore_object_busy` otherwise; retry once it settles). Both
calls then delete the Containers SDK's alarm, if set, before reading the
fence and the digest: a waking Sandbox arms it, and a second later it
deletes itself, which would change the storage just read. So a Sandbox
evicted since preparation schedules unless its wake wrote more than that
alarm.

The host wrappers in `src/state/installation-objects.ts` validate ownership
before resolving a stub. `scheduleInstallationObjectRestore` and
`restartInstallationObject` also require `confirmInstallationId`, and the
restart wrapper the receipt's fence. It makes up to three calls, each over a
fresh stub, and returns the first answer. In `src/state/installation-restore.ts`,
`buildInstallationRestorePlan(installationId, inventory)` is pure, accepts the
concatenated inventory pages, adds the implicit state store and rejects
foreign names, unknown kinds and duplicate entries. It cannot establish
whether the inventory is complete. `prepareInstallationRestore(env, census,
T)` reads every planned object's bookmarks and reports each object as
prepared, skipped or failed instead of stopping at the first failure.

## The fence is the storage, not the bookmark

A Durable Object's current bookmark is not a write position alone. Every
session of an object, after an eviction or a restart, starts a new current
bookmark without writing anything: on staging, three idle objects prepared
under suspension each had a new current bookmark three minutes later, with
nothing but bookmark reads reaching them, while each one's bookmark for T
stayed the same. Cloudflare evicts an idle object within minutes, and apply
runs minutes after preparation, so a fence compared by bookmark refuses
almost every object.

What the fence guards against is a write between preparation and
scheduling, which suspension and `cancel_pending` should have made
impossible: work the restore would discard unreviewed, an object created
and recorded in the state store that no census lists, or a restored object
writing to one not yet scheduled. So scheduling compares the storage
itself, within the same input gate as the scheduling: a session that only
read leaves the digest as it was, and any write that changes what is stored
changes it. A write that stores the same values again goes unnoticed; it
changed nothing the restore discards. The digest reads every row, so it
costs one full read of each object at preparation and at scheduling.

The prepared current bookmark stays the object's undo point: restoring to
it brings back exactly the storage the digest describes.

## Order: schedule everything, then restart callee first

Restored objects write to each other when they wake. A Sandbox restored
inside a coding turn has the container status `running`; its next session's
SDK alarm records the stop, and `Sandbox.onStop` releases its lease in the
state store. A runner resumes its restored jobs and calls the state store.
The state store's alarm hands turns to runners. With one object restored and
restarted at a time, a restored object can write to one still waiting,
whichever order is chosen, and the waiting object is then refused with
`restore_content_moved`.

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
   of claiming a complete restore. Run the backfill once first: it records
   the legacy names it recovers with `firstSeenAt` 0, so prepare never skips
   them.
3. `restore_prepare`: call `prepareInstallationRestore` with the saved census
   and T. Persist each prepared object's current and target bookmarks and
   content digest, the skipped and failed objects, T, the target deployment
   and the installation in a private operator record. Offer apply only when
   nothing failed and the skipped list has been reviewed. Each prepared
   current bookmark is also that object's undo point.
4. `restore_apply --confirm inst_…`: require the saved installation
   confirmation and keep it suspended. Check the prepared record and T's
   remaining retention window. Never deploy during apply, from the first
   schedule until every receipt has its restart answer: a deploy restarts
   every Durable Object, which applies every scheduled restore at once, in
   arbitrary order.
   - Schedule: call `scheduleInstallationObjectRestore` serially in plan
     order with each object's exact prepared fence, content digest and
     target. Persist each receipt before the next call. A restore is per
     object, not a transaction across the installation.
   - A scheduled restore cannot be cancelled. Cloudflare has no undo for
     `onNextSessionRestoreBookmark`, and the session holding it refuses
     another schedule with `restore_already_scheduled`. It applies on the
     object's next wake of any kind: a restart, an eviction, a deploy, any
     call. So never stop at a refusal and resume: the receipted objects would
     restore later, out of order, under live traffic. Either finish: settle
     the refusal as below, prepare the refused object again, schedule it and
     continue. Or back out: restart every receipted object as below, then
     apply again with each one's receipt `undoBookmark` as its target:
     prepare each again for its new fence, schedule every one, then restart
     them in plan order. Either way, step 6 follows.
   - An object evicted since preparation has a new current bookmark and
     still schedules. `restore_content_moved` means something wrote to it
     since preparation, which suspension should have prevented: review
     before preparing it again. A Sandbox whose wake wrote more than its SDK
     alarm may be prepared again and scheduled straight away. Never replace a
     refused fence and retry silently. A host that reads every object again
     before scheduling, to stop before anything is scheduled, compares the
     digest, never the current bookmark.
   - Restart: only once every prepared object has a receipt, call
     `restartInstallationObject` for each in plan order with its receipt's
     fence. Its answer, `applied: true`, proves the restore applied. Keep
     progress and partial-failure evidence outside the installation.
   - Never resume while any receipt lacks that answer, including the
     receipts of a back-out.
5. Confirm a schedule whose answer was lost by calling it again: a session
   that still holds it returns the receipt. A later session schedules again
   when its storage still matches the prepared digest, whether or not the
   first call scheduled anything: restoring twice to one target gives the
   same storage. Never infer from a moved bookmark that a restore applied:
   every new session moves it, applied or not. If the call is refused with
   `restore_content_moved`, the restore applied or something wrote, and
   nothing tells them apart; review, then prepare it again and schedule it
   to the same target. Either way the first prepared fence remains the undo
   point. The runtime logs the abort as
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
the saved census for step 6 and for any later export or erasure.

The backfill stamps the legacy names it recovers with `firstSeenAt` 0: their
objects predate the inventory, so prepare restores them whenever the
backfill ran. A name recorded before the backfill keeps its time. So an
object older than its record is still skipped: one created before the
inventory that a turn recorded before the backfill ran, or one a backfill by
an earlier Core stamped with the time it ran. Prepare it explicitly with
`readInstallationObjectRestoreBookmarks` if review shows it existed at T.

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
- That the next session's current bookmark differs from the prepared fence,
  even for a target equal to it: restart's answer relies on it. Observed for
  sessions without a restore: an idle object woken again has a new bookmark.
- That an idle object of each kind evicted and woken again keeps its content
  digest, so nothing it runs on waking writes.
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
