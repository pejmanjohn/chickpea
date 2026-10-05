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
  over the object's ID and everything the restore replaces: each schema
  entry, every row of every table in key order, every key-value entry and
  the alarm. The ID makes it this object's: two objects holding the same
  storage, such as two that hold only their schema, have different digests.
  Every session has the ID (`ctx.id.toString()`), including one woken by ID,
  as a Sandbox's egress handler and lease sweep wake it, which has no name;
  a named object's ID is derived from its name. The name is not hashed: a
  named and an unnamed session of one object would then disagree. The digest
  compares values as JavaScript reads them, so it does not tell apart an
  INTEGER from an equal REAL or integers beyond 2^53 that read alike. It
  leaves out SQLite's own tables, `sqlite_sequence` (AUTOINCREMENT counters)
  among them, and the rowid of a table without an INTEGER PRIMARY KEY, which
  `SELECT *` does not return: its rows are read in rowid order, so rows
  renumbered in the same order digest alike.
- `chickpeaHostRestore({ installationId, expectedCurrentBookmark,
  expectedContentDigest, targetBookmark })` refuses with
  `restore_content_moved` when the object's storage no longer matches the
  prepared digest, or the digest is another object's, awaits
  `storage.onNextSessionRestoreBookmark(targetBookmark)` and returns the
  receipt `{ expectedCurrentBookmark, expectedContentDigest, targetBookmark,
  undoBookmark }`. A missing bookmark is refused with
  `restore_bookmark_invalid`, a missing digest with `restore_digest_invalid`.
  It does not restart the object. Once the restore is scheduled, it writes
  the restore mark, a key-value entry holding the fence
  (`chickpea.restore.scheduled.v1`), in the same input gate. The object
  remembers the receipt for the rest of its session: a repeated call returns
  it only when it presents the same fence, digest and target, and anything
  else, a new preparation included, is refused in that session with
  `restore_already_scheduled`.
- `chickpeaHostRestoreRestart({ installationId, expectedCurrentBookmark })`
  takes the receipt's fence. The session holding that restore calls
  `ctx.abort('Installation point-in-time restore')`, which interrupts the
  call; it refuses another fence with `restore_already_scheduled`. Any other
  session refuses with `restore_not_scheduled` while the object still holds
  the fence, and with `restore_not_applied` while it still holds this
  restore's mark; otherwise it returns `{ applied: true, currentBookmark,
  contentDigest }`. Given the receipt, that answer means the restore
  applied, also when an eviction applied it before the restart: the restore
  discards every write since T, the mark included, and Core removes the mark
  nowhere else. Without a receipt it proves nothing: every new session
  starts a new bookmark, and no mark was written. `contentDigest` is the
  digest of the storage that session holds, read in the same input gate, or
  null when it is over the digest's bound (below): a record for the
  operator, which decides nothing (see below). On staging the abort did not
  apply the restore: the next call reached a new session still holding the
  mark, and the restore stayed pending until the object's next wake after an
  eviction. So `restore_not_applied` means not yet, and a later restart with
  the same receipt, past an eviction, answers `applied: true` (Staging
  proof).

Each call runs in one input gate. Refusals are thrown outside it and leave
the object running. Cloudflare validates the opaque bookmark's retained
history. A Sandbox must have its container stopped and that stop recorded
before preparation or scheduling (`restore_object_busy` otherwise; retry
once it settles). Both calls then delete the Containers SDK's alarm, if
set, before reading the fence and the digest: a waking Sandbox arms it, and
a second later it deletes itself, which would change the storage just read.
So a Sandbox evicted since preparation schedules unless its wake wrote more
than that alarm.

The state store and thread runners refuse preparation and scheduling with
`restore_object_busy` while their alarm still owes work, which it is
running now or a new instance arms it for at once: for the state store an
alarm turn whose Flue dispatch was in flight, a gateway delivery in flight,
or a hand-off to a runner not yet confirmed (armed for after a deploy, and
re-admitted by the alarm's next run); for a runner a job marked running or
a stop that still owes its abort or coding cascade. A delivery is in
flight whichever instance leased it: the current alarm writes when it
completes its own, and the next drain reclaims an earlier instance's. A
wake would write that alarm, and its run would write more, so a
preparation would only be refused at scheduling. `cancel_pending` parks the
state store's turns but leaves a delivery in flight, a running job and an
owed stop: run it, then retry once each object's alarm has settled what
remains. A delivery leaves flight once its alarm completes it or reclaims
its lease; with the alarm cleared, the object's next instance arms it. The
state store cannot be left out (below), and only an eviction gives it a
next instance: while a delivery stays in flight, stop calling the state
store for two to three minutes, so that Cloudflare evicts it, then retry
preparation. The call wakes a new instance, which arms the alarm that
reclaims the delivery; preparation passes once that alarm has settled it.
A running job settles as its run ends, its submission aborted and its model
calls refused while the installation is suspended. Work that never settles,
such as a job whose run never ends, follows the path of an object over the
digest's bound (below).

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

An error thrown over RPC loses its class and `code`; only its message
arrives, so the host maps each refusal by its message. The messages, with
`…` for a part that varies:

| Code | Message |
| --- | --- |
| `restore_time_invalid` | Restore time must be within the past 30 days and before now. |
| `restore_bookmark_invalid` | Restore requires current and target bookmarks. |
| `restore_bookmark_invalid` | Restart requires the fence the restore was scheduled against. |
| `restore_digest_invalid` | Restore requires the content digest read with its fence. |
| `restore_content_moved` | The storage no longer matches the prepared digest, or the digest is another object's; prepare it again. |
| `restore_object_too_large` | This object holds more than a restore can check: over … |
| `restore_object_busy` | Stop the Sandbox container before restoring it. |
| `restore_object_busy` | The Sandbox container stop or schedules have not settled; retry once its alarm has completed them. |
| `restore_object_busy` | The thread runner has a job running or a stop owed; retry once its alarm has settled them. |
| `restore_object_busy` | The state store has work its alarm resumes (…); run cancel_pending, then retry once its alarm has settled what remains. |
| `restore_already_scheduled` | A restore is already scheduled; restart the object first. |
| `restore_already_scheduled` | A restore against another fence is scheduled. |
| `restore_not_scheduled` | No restore is scheduled or applied: the object still holds the fence. |
| `restore_not_applied` | The object restarted still holding what was written after its restore was scheduled: the restore did not apply. |
| `restore_restarting` | The object is restarting to apply its restore; call again. |
| `restore_unavailable` | This object has no SQLite restore context. |
| `restore_unavailable` | This object has no ID to bind its content digest to. |

The `restore_not_applied` message is Core's exact string, which the host
matches, but it overstates: the restore has not applied yet and stays
pending (Staging proof). The receipt is still owed (step 4).

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
costs one full read of each object at preparation, at scheduling and at
restart.

The prepared current bookmark stays the object's undo point: restoring to
it brings back exactly the storage the digest describes.

## Telling an applied restore from one not yet applied

Restart's answer, not the digest, decides whether a restore applied. The
digest cannot: the host cannot read an object's storage at T, since
Cloudflare offers no read at a bookmark short of restoring to it, so it
cannot know whether the storage changed between T and preparation. An
object idle since T digests the same whether or not the restore applied,
and a state store need not move either: an idle installation, whose
maintenance found nothing to purge, writes nothing to it.

So scheduling writes the restore mark, holding the fence, right after it
schedules the restore. The fence did not exist at T, so storage at T never
holds this mark, and a restore discards every write since T, the mark
among them. A later session that still holds the mark restarted without
restoring, and restart refuses there with `restore_not_applied`: the
restore has not applied yet, and the receipt stays owed (step 4). Restart
answers `applied: true` only once the mark is gone, so the rule the host
checks is that answer, given the receipt. The post-restart
`contentDigest` is evidence for the operator record only: equal to the
prepared digest is expected of an object that held at T what it held at
preparation, and a Sandbox's wake changes it either way.

Whether the undo bookmark the receipt returns, "immediately before the
restore", keeps the mark is undocumented; staging checks it (see Staging
proof). Either outcome is safe. If it keeps the mark, a back-out to it
brings the first restore's mark back, which the back-out's own fence does
not match. If not, a back-out brings back no mark, and its restart answers
`applied: true` all the same. The prepared fence, read before the mark,
does not hold it.

## The digest's bound

The digest is read inside `blockConcurrencyWhile`, at preparation and again
at scheduling, and Cloudflare resets an object whose callback runs past 30
seconds. An object too large to digest in time would be reset by every
preparation, and could never be restored. So the digest reads each table
one row at a time and stops at 500,000 records (rows, key-value entries and
schema entries), 16,000,000 column values (500,000 rows of 32 columns) or
512 MiB serialized, whichever comes first, refusing with
`restore_object_too_large`. Preparation and scheduling refuse an object
whose SQLite database (`databaseSize`) is over 2 GiB first, before the
input gate: nothing is read, and a Sandbox keeps its SDK alarm. That size
counts indexes, key-value storage and free pages, so its bound is four times the
serialized one and refuses only an object far over the others.

On local workerd SQLite, a digest at that bound took at most 1.1 s: 490,000
rows of 31 columns took 1.06-1.08 s. Column counts here include the key.
Rows of the widest Chickpea table (52 columns, 307,000 of them at the values
bound) took 1.0 s, rows of 100 columns (159,000) 0.9 s, 490,000 key-value
entries 0.9 s and 512 MiB of transcript chunks 0.3 s; a refusal came within
1 s. Repeats in that run varied by under 5%, but an earlier bench, of a
digest since replaced, read 1,000,000 audit rows in 2.9 s in one run and
1.7 s in another, so the allowance for run-to-run variance is 1.7x. With
that and a production CPU assumed twice as slow, the worst case is 1.1 s x
1.7 x 2, about 3.7 s: a margin of about 8x under the gate's 30 s and the
30 s of CPU a request gets. Without the values bound, 490,000 rows of 100
columns took 2.79-2.82 s in the same run, about 9.6 s with the same
allowances: a margin of only 3x, which is why wide rows have their own
bound. The twofold assumption did not hold. On the platform the digest is
CPU-bound at 7-28 µs of CPU per record, depending on the shape, against
2 µs locally: 3.5 to 14 times slower
(`~/.chickpea/plans/hosted/evidence/digest-scale-bench/README.md`). At the
bound, key-value entries and 30-column rows then take about 10-15 s warm,
over the 10 s Staging proof allows. Reading pages a deployed object has
not cached is not measured locally, so a staging measurement of the
largest real object gates apply (see Staging proof).

Reading a row at a time keeps memory to one row (at most 2 MB) and 16
key-value entries, far under an isolate's 128 MB. The count is
deterministic: storage that passes at preparation passes at scheduling
unless it grew, and an object that grows over the bound since preparation
refuses scheduling as it would for any write.

Durable Object SQLite offers no hash function to checksum a table in SQL,
and its 2 MB value limit refuses `quote()` of a large BLOB, so the digest is
computed in JavaScript. Splitting it across several input gates would let
writes land between them unseen, unless each gate also checked the
bookmark, whose meaning within a session is undocumented, and the
request's 30 s of CPU would still bound the whole.

An object over the bound cannot be restored by these functions. Preparation
reports it failed, so apply is not offered, and nothing was scheduled. If
it is not the state store, the operator may restore the installation
without it: prepare a census that leaves it out, record why in the operator
record, and treat it as an object younger than T: it keeps its current
storage, and the saved census still covers it in step 6. The state store
cannot be left out; nor can an object whose current storage the restored
installation must not see. Then the installation is not restored: resume it
or keep it suspended, and record the object and its size for a Core change
to the bound.

An object that stays busy takes the same path: a runner whose running job
never settles, because its run never ends, refuses preparation with
`restore_object_busy` for as long as it runs. Leave it out as above,
recording the job, or do not restore the installation. There is no force:
a forced preparation would fence storage its own alarm is about to change.

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
   schedule until every receipt has answered `applied: true`: a deploy
   restarts every Durable Object, which applies every scheduled restore at
   once, in arbitrary order. A receipt that answered `restore_not_applied`
   is still owed.
   - Schedule: call `scheduleInstallationObjectRestore` serially in plan
     order with each object's exact prepared fence, content digest and
     target. Persist each receipt before the next call. A restore is per
     object, not a transaction across the installation.
   - A scheduled restore cannot be cancelled. Cloudflare has no undo for
     `onNextSessionRestoreBookmark`, and the session holding it refuses
     another schedule with `restore_already_scheduled`. It applies on the
     object's next wake after an eviction or a deploy, whatever wakes it;
     on staging, not in the new session Core's restart started (Staging
     proof). So never stop at a refusal and resume: the receipted objects
     would restore later, out of order, under live traffic. Either finish:
     settle the refusal as below, prepare the refused object again, schedule
     it and continue. Or back out: restart every receipted object as below
     until each answers `applied: true`, then apply again with each one's
     receipt `undoBookmark` as its target: prepare each again for its new
     fence, schedule every one, then restart them in plan order. Either
     way, step 6 follows.
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
     fence. Only its answer `applied: true`, given the receipt, settles the
     receipt: the restore applied. `restore_not_applied` means the object
     restarted still holding the restore mark: the restore has not applied
     yet and is still pending. On staging it applied on the object's next
     wake after an eviction (Staging proof, below). Treat the receipt as
     owed: keep the installation suspended, deploy nothing, and leave the
     object uncalled for two to three minutes, so that Cloudflare evicts it.
     Then, before restarting the next object, call restart again with the
     same receipt: the call wakes the object, the restore applies, and
     restart answers `applied: true`. Do not prepare or schedule the object
     again: on staging that only scheduled another restore, which the next
     restart again left pending. Only a mark still present after a restart
     past an eviction is a case for review. When an object was prepared
     again, restart it only with its latest receipt: with an earlier one,
     restart answers for what the storage now holds, not for the restore
     that receipt scheduled. Its first prepared fence stays the undo point.
     Keep the answer's `contentDigest` with the receipt as a record; it
     decides nothing. Keep progress and partial-failure evidence outside the
     installation.
   - A back-out's preparation reads restored objects, which may hold the
     work they held at T: a running job, an interrupted dispatch. They
     refuse with `restore_object_busy` until it settles, so run
     `cancel_pending` over them first, as in step 6.
   - Never resume while any receipt lacks `applied: true`, including the
     receipts of a back-out. A receipt that answered `restore_not_applied`
     still lacks it.
5. Confirm a schedule whose answer was lost by calling it again with
   exactly the original fence, digest and target: a session that still
   holds it returns the receipt. Any other call to that session, a new
   preparation included, is refused with `restore_already_scheduled`, so
   never prepare again before asking. A later session schedules again when
   its storage still matches the prepared digest, whether or not the first
   call scheduled anything: restoring twice to one target gives the same
   storage. Never infer from a moved bookmark that a restore applied: every
   new session moves it, applied or not. If the call is refused with
   `restore_content_moved`, restart with the original fence before anything
   else. When the first call scheduled a restore that has not applied yet,
   its mark remains, and restart answers `restore_not_applied`: that
   restore is owed, so settle it as in step 4 and do not prepare it again.
   Otherwise the restore applied or something wrote, and nothing tells them
   apart; review, then prepare it again and schedule it to the same target.
   Either way the first prepared fence remains the undo point. The runtime
   logs the abort as `Installation point-in-time restore`; a caller may see
   only a reset error.
6. Census after restore and run `cancel_pending` while still suspended, after
   every restart has answered `applied: true`, over the union of saved
   pre-restore objects and the new inventory, state store last. Restored
   objects resume their own work as soon as they restart; the suspension
   refuses each agent operation at the admission check, and the
   cancellation settles the jobs and records left behind. Restored queued
   jobs and delivery records must not replay on resume. Capture the
   post-cancellation census and verify acceptance before resume.

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

**Results so far (2026-10-05).** The second staging rehearsal found that
restart does not apply a restore. Each restart through `ctx.abort()`, a call
into the session that had scheduled the restore, came back with the mark
still there (`restore_not_applied`). On one object, the state store, that
restore was seen to apply later, on its next wake after eviction: twenty
minutes later, because nothing called it sooner. Objects whose scheduling
session was evicted before restart answered `applied`. In a separate test
on a disposable benchmark Worker, not on staging, an abort in the same
request as `onNextSessionRestoreBookmark` did apply, and the caller
received a rejected call carrying the abort reason. Hosts do not offer
apply until restart makes the restore apply and staging shows it.

The rehearsal also established the following:
- An idle object keeps its content digest across eviction (a state store, a
  thread runner and a Flue agent).
- The next session's current bookmark differs from the fence.
- The restore discards the mark.
- `getBookmarkForTime` throws a generic error for a time before an object's
  first write.
- The undo bookmark most likely keeps the mark.
- A T chosen on the host's clock, 13 minutes before preparation, resolved
  to the intended history.

On staging, preparation's digest passed the gate below on one tenant's
largest objects, as the host timed it: its state store, 4,905 records, took
2,495 ms cold (the first call after an eviction) and 728 ms warm, and its
largest transcript agent, 213 records, 441 ms and 358 ms. A state store of
243 records, read after its restore, took 1,892 ms and 248 ms. At scale
the digest is slower than locally: a warm benchmark on the disposable
Worker put 500,000 key-value entries at about 15 s and 500,000 rows of 30
columns at about 10 s, both over the 10 s the gate allows, so
`OBJECT_DIGEST_BUDGET` must come down before apply is enabled.

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
- That a write after `onNextSessionRestoreBookmark` in the same session,
  such as the restore mark, is discarded by the restore, and whether the
  undo bookmark it returned keeps it (either is safe; see above).
- A gate before apply is enabled: time preparation's digest on the largest
  real objects on staging (the largest state store and transcript agent by
  `databaseSize`), cold, as the first call after an eviction, and warm.
  Each must stay under 10 s, a third of the gate's 30 s; otherwise lower the
  bound before enabling apply.
- What `getBookmarkForTime(T)` does for T before an object's first write: an
  error, the empty database or the first write. Check that prepare's
  `younger_than_target` skips agree with it.
- Whether a restore brings back the alarm stored at T, which decides whether
  restored runners and the state store wake on their own.
- That a cold Sandbox's preparation deletes the SDK alarm and that
  scheduling in the same session matches its fence.
- That a T a few seconds before now, chosen on the host's clock, resolves to
  the intended history.

A host binds the gate's measurement to `OBJECT_DIGEST_CONTRACT` and
`OBJECT_DIGEST_BUDGET`, not to a Core commit. The digest's time depends on its
algorithm and coverage, the budget, the quiesce hooks, the objects' size and
the platform. The contract versions the first three: Core bumps it with any
change to the digest's algorithm, encoding, record order or coverage, to the
budget, or to a quiesce hook, and its tests pin each, so such a change fails
until it is recorded. While the Core a host runs declares the contract and
budget its measurement recorded, apply stays enabled; a Core that declares
either differently is measured again before apply reopens. The objects'
size and the platform are not in the contract: the host measures again as the
objects grow.

See the
[Cloudflare PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api).
