# Batch smoke

`npm run verify:smoke` is the scripted live check that runs once per merge batch
on `main`, after the batch merges and before any Chickpea Cloud pin or Core
release. It needs no agent judgment, so a background shell task or launchd can
start it. Chickpea Cloud pins only a Core commit that has a passed line in the
smoke ledger.

```sh
npm run verify:smoke -- --lane amber --candidate /abs/clean/worktree
```

The candidate is a clean worktree on a branch at the commit under test, for
example `main`. The smoke never deploys the checkout it runs from. It waits for
the lane with `env wait-claim` and never takes a held lane. When the candidate
already holds the claim, it restamps the claim instead. It deploys with the
lane's guarded deploy command, runs the cases as the lane's Owner, and cleans up
what the cases created. It appends one ledger line and releases a claim it
took. Exit 0 means every case passed, 1 means a case failed or was blocked, and
2 means a usage error. `--cases id,id` selects cases. `--skip-deploy` grades
what the lane already serves. `--no-ledger` writes no line.

## What it needs

- The lane's browser daemon, signed in to Admin and Slack as the Owner. The
  kickoff doctor (`npm run verify:live:kickoff`) checks this.
- The lane's readback token and seed token (see [hosts.md](hosts.md)).
- A `#qa-<lane>` channel that the Owner belongs to, and one published user
  Agent that works in it. The routine case uses that Agent. Without one, the
  case is blocked.

## Cases

Slack posts are Web API calls made from inside the lane browser's Slack tab, as
the [runner matrix](runner-matrix.md) does. Admin calls are same-origin fetches
from a tab on the lane's Admin origin. Readback uses the lane's readback app.
Each grade is mechanical.

| id | action | pass |
|---|---|---|
| `dm-reply` | DM the app bot | a settled bot reply with the marker word |
| `channel-mention` | mention the bot in `#qa-<lane>` | a settled reply in the thread with the marker |
| `thread-follow-up` | reply in that thread with no mention | another reply with a new marker |
| `agent-create-welcome` | ask Chickpea in a DM for a disposable Agent, then `approve` | Admin lists the Agent, and exactly one welcome posts under its name |
| `instruction-proposal` | ask to change that Agent's instructions, then `approve` | Admin's instructions carry the marker |
| `admin-owner-save` | read `/admin/api/account`, then save a description on that Agent | role `owner`, and the description reads back |
| `routine-due-now` | ask the channel's Agent for a one-time routine tomorrow, then call the due-now hook | one delivery with the marker, and Admin shows the routine completed |
| `mcp-signin-resume` | start a signed-out MCP authorization with no cookies | the sign-in page keeps `/auth/mcp/resume/<id>` as its destination, and the Slack sign-in start answers with Slack's authorize link |

A failed case carries a category. `product` means Chickpea misbehaved,
`model` means the model ignored an explicit request, and `tool` means the smoke
or its environment failed. A case whose need did not pass is `blocked`.

The due-now hook, `POST /internal/environment/routine-due`, exists only on QA
targets and answers only the lane seed token. It sets one active routine's next
run to now, so the minute cron fires it through the real scheduled path.

Cleanup deletes the routine through its control route, then archives and
deletes the disposable Agent. Each deletion is read back. The signed-out MCP
registration leaves one client that was never consented, and the product prunes
it.

## Ledger and evidence

Each run appends one line to `~/.chickpea/verification/smoke-ledger.jsonl`.
`scripts/lib/smoke-ledger.mjs` defines the line (`chickpea-smoke-ledger/v1`) and
exports `readSmokeLedger` and `smokePassed(entries, sha)` for Cloud's pin
check. A line passes only when every case passed and cleanup read back clean.
Readbacks, the timestamped deploy log, and `result.json` go to an owner-only
run directory under `~/.chickpea/verification/smoke/`.

## Not covered

- A fresh Owner sign-in, because it needs the test account's Slack password and
  2FA in a cookie-less browser. The cases use the standing Owner session.
- A connection read, because no lane has a published Agent with a stable token
  connection. The `qa-fixtures` Agent holds the fixtures but is unpublished.
- A coding turn, because no lane has a coding model set.
