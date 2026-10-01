# Codex and Claude hosts

The `.agents` and `.claude` skill entrypoints both load [SKILL.md](SKILL.md).
Keep workflow policy and executable helpers here; a host adapter only explains
tool access. Both hosts use the same Node commands, private records, and lane
claims. Neither host's task list is an acceptance record.

At entry, identify the available shell, browser/native UI tools, authenticated
test sessions, and private evidence directory. In Codex, use the enabled browser
or computer-use tools and their current documentation. In Claude, use its enabled
browser/native tools. Do not assume either host has the other's APIs or tab IDs.

Keep evidence outside Git in an owner-only directory. Confirm that the current
host can read it before a run. If a review tool cannot read a private file, provide
the relevant authorized, sanitized content in its review prompt. Do not move
private evidence into source or bypass a tool denial. Report unavailable context.
Preserve requested model selectors; configured defaults and independent serving
model readbacks are different evidence.

## Task-owned browser tabs

Each task creates or uses its own tabs and keeps their handles in its working
context. Independent tasks may work in separate tabs of the same browser or
profile. Browser work requires no browser-wide or machine-wide UI lock, lease
receipt, or registration command.

Before acting, confirm the intended tab/window, URL, signed-in actor, workspace,
and run marker. Target that tab/window explicitly with the tool's supported APIs.
Do not navigate, type into, reload, close, or repurpose another task's tabs.
Close only tabs owned by this task when cleanup calls for it.

Coordinate with the affected owner only when an operation uses an actual shared
resource, such as the same tab, a profile-wide sign-out or account switch, or a
native dialog/input operation that cannot be targeted independently. Use the
tool's documented targeting and focus behavior and inspect the actual state.
If an action requires exclusive control, coordinate that action for its duration;
uncertainty about one native operation does not block unrelated tab work.

Keep a tab waiting for MFA or another human capability with its owning task.
Continue independent checks in other owned tabs. After the capability is supplied,
inspect the current UI and reconcile the original action using [recovery.md](recovery.md)
before continuing. Capture only the relevant window; never capture secret entry.

Environment claims, shared fixture ownership, and [expensive-check host
reservations](host-checks.md) still apply to their respective resources. Keep
action evidence and measured browser/human wait time in the existing run record.

## Lane browsers

Use a dedicated browser per lane, not a shared extension. Each lane's Chrome
is a daemon: one long-lived, windowed Chrome on that lane's profile, signed in
to the lane's Slack workspace and Admin, listening on a fixed local debugging
port (amber 9331, cobalt 9332, violet 9333). Every session's `chrome-amber`,
`chrome-cobalt` or `chrome-violet` MCP server attaches to that daemon with
`--browserUrl`. The server launches nothing and holds no profile lock, so any
number of sessions drive the same lane in their own tabs, and a finished
session has nothing to quit. Claude calls the tools as `mcp__chrome-<lane>__*`;
Codex exposes the same servers as `mcp__chrome_<lane>__*` (underscores) and
its calls take a `pageId`. Use only the claimed lane's server. Its pages are
real foreground targets, so hidden-tab rendering, cross-browser routing and
focus problems do not apply, and the server's dialog tool handles native
`confirm()` dialogs. Different lanes run in parallel without contention.

At kickoff, `npm run verify:live:kickoff` starts any stopped lane browser and
reports whether each is signed in to Admin and Slack. Daemons do not restart
on their own after a reboot or after Chrome is quit, so starting them is the
verifier's job, never the maintainer's. `npm run lane:browser -- status all`
shows the daemons alone:

- `running`: attach and go. Signed-in state lives in the profile, so a
  restarted daemon is still signed in.
- `stopped`: run `npm run lane:browser -- start <lane>` yourself. It is
  idempotent and reports a daemon that already answers. In Codex, run it outside the command
  sandbox (escalated) if the sandbox blocks the launch or the local port. A tool call before that fails with
  "Could not connect to Chrome. Check if Chrome is running."; that means start
  the daemon, not that the lane is broken.
- `held`: a browser from the earlier launch-per-server mode locks the profile
  and answers on no port. It belongs to the session whose server launched it.
  Ask that session to quit it; never stop another session's browser yourself.
  `stop` refuses a browser it did not start.

Leave the daemon running when a run ends; other sessions share it. Stop it
(`npm run lane:browser -- stop <lane>`) only to sign the profile in again or
when the maintainer asks.

Host configuration (outside the repository): the user-scope MCP entries and
`~/.codex/config.toml` run exactly what
`npm run lane:browser -- attach <lane> --dry-run` prints, which is
`chrome-devtools-mcp` with `--browserUrl http://127.0.0.1:<port>`, one
`--workspace` per private evidence folder (`verification`, `qa-runs` and
`reviews` beside the profile root, plus the temp directories),
`--screenshotFormat jpeg`, `--screenshotMaxWidth 1400`,
`--redactNetworkHeaders` and `--no-usage-statistics`. Without `--workspace`
the server refuses `take_screenshot` and `take_snapshot` paths outside the OS
temp directory. The profile root's parent itself is never a workspace,
because it holds the lane secrets file and exported cookie payloads. The
daemon commands use `--root`, else `CHICKPEA_LANE_CHROME_ROOT`, else
`~/.chickpea/browsers` when it exists, so they work from any shell. Each
daemon writes an owner-only log beside its record
(`<root>/<lane>.daemon.log`). Seeding, `import` and `export` refuse while a
daemon or another browser has the profile open; stop the daemon first. `start` launches Chrome itself with `--remote-debugging-port`,
`--hide-crash-restore-bubble` and `--no-first-run`, and on macOS with the real
keychain, so cookies survive and no "Restore pages?" bubble appears. The
maintainer signs each profile in once, in the daemon's own window. If a
profile is signed out, ask for that one-time sign-in during the kickoff
preflight. Google may refuse sign-in inside an automated browser, so use
Slack's email code; treat a Google OAuth consent that refuses automation as a
human-only step.

Proven Slack recipe for these servers:

1. Open `https://app.slack.com/client/<team-id>/<channel-id>` for the lane's QA
   channel and take a snapshot to confirm the signed-in actor and channel.
2. To mention an Agent or Chickpea, click the composer, then its "Mention
   someone" button (a typed `@` is often swallowed when text is inserted by a
   tool), type the name, wait about 1.5 s for autocomplete, and press Enter to
   insert the mention token. Before sending, confirm the draft holds a
   `ts-mention` element; if it does not, clear the draft instead of sending.
   Then type the message and press Enter. A message posted without the token
   reaches no Agent, so its silence proves nothing.
3. Read the reply thread by navigating to
   `https://app.slack.com/client/<team-id>/<channel-id>/thread/<channel-id>-<message-ts>`
   instead of clicking the reply counter. Poll the thread every 10 s up to the
   attempt's observation deadline.
4. Read Admin in the same profile at the lane origin. Close only the pages the
   run opened. Leave the daemon running for the next session.

The Claude-in-Chrome extension (Claude) or Codex's own browser tool remains the
fallback only when a lane daemon cannot be started.

### Cloud sessions

Cloud sessions are dormant: they cannot claim a lane, because claims live only
in the host's environment registry, and they could not watch Slack live. Their
lane browser and private-file setup is kept in [cloud.md](cloud.md).

## Browser and Slack practice with the extension (fallback)

These habits come from repeated live runs with the Claude-in-Chrome extension
and the Slack web client:

- Keep exactly one browser connected to the extension. With two or more, calls
  route to the wrong browser ("tab not in group", vanished tab groups, failed
  batches). Start each batch with `tabs_context_mcp`. If calls still flap,
  pin with `select_browser` and ask once for the extra browser to be
  disconnected.
- Extension tabs usually report `document.hidden`. Slack threads may stay on
  "Loading thread…", and an app that skips hidden-tab loads may render
  nothing. Override the page's `document.hidden` and `visibilityState` getters
  in the owned tab and reload. Use `form_input` for Admin text fields, because
  typed text and focus often do not reach a background tab.
- Open a Slack thread by URL, `/client/<team>/<channel>/thread/<channel>-<ts>`.
  It often loads on the second navigation. Before typing, click the thread
  composer and confirm by screenshot that the draft sits in the thread and not
  the channel composer. Then press Return.
- The extension cannot press native `confirm()` dialogs. For a declared
  cleanup action in an owned tab, override `window.confirm` to return `true`
  in that tab before clicking. Then verify the result by readback.
- Computer use grants Slack desktop only through an OS dialog that the human
  must accept at the machine. A chat approval cannot accept it. Request the
  grant during the kickoff preflight, or use the signed-in web client.

## Slack and permission notes for any browser

- A new Admin-created Agent is unpublished in Slack until it is attached to a
  channel. Plain text such as `@handle` then routes to Chickpea. Attach the
  Agent to the QA channel before mentioning it. Insert mentions with the
  composer's mention control.
- When the auto-mode permission classifier blocks a declared QA action (a
  lane deploy, a `wrangler rollback` to the lane's receipt version, a product
  UI write), name the lane alias and the declared action, and ask once. Never
  route around the block: do not change permission modes or settings to get
  past it, and never stop processes by pattern across the host (`pkill -f`),
  which can kill another worktree's gate. When the maintainer has instructed a
  shared or production deploy in this session, run it here as one plain
  command rather than handing the command back.
- Run the guarded lane deploy as one plain command,
  `CHICKPEA_DEPLOY_TARGET=<alias> npm run verify:host -- --wait-ms 300000 npm run deploy`
  (`deploy:sandbox` on a sandbox-profile lane). It serializes the build with
  the host's other expensive checks and matches the operator allow rules.
  Before building it refuses stale dependencies and a core deploy over a lane
  that serves the sandbox profile, naming the command to run instead; after
  reconciling it writes the serving version's telemetry receipt. To
  deploy a sibling worktree's candidate, add `-- --worktree <absolute path>`
  instead of `cd <worktree> &&`; the wrapper re-runs that checkout's own
  wrapper from there. Do not chain anything in front of the command or
  redirect its output: `export PATH=...`, `source nvm.sh` or `cd` send it to
  the classifier instead of the allow rule. The host shells already put the
  pinned Node first (SKILL.md, Node baseline); check `node -v` once at kickoff
  and report a mismatch as a host setup gap rather than prefixing commands.

## Slack evidence on gateway lanes

Amber, Cobalt and Violet use the shared gateway transport, whose Slack token
never reaches the verifier. Each lane workspace therefore has its own
read-only app, installed by the lane's test account, for exact readback of what
Chickpea posted. Read with it, and keep sending the message a case tests
through the composer:

```sh
npm run lane:slack -- <alias> whoami
npm run lane:slack -- <alias> message <message link> --out <private file>
npm run lane:slack -- <alias> thread <message link> --out <private file>
npm run lane:slack -- <alias> history <channel id> --since <ISO time>
```

It returns each message's sender name, bot and app, custom name, text, blocks,
files with their owners, edits and reactions, which is the exact `slack` proof
for a case. It reads only conversations the test account belongs to, never
posts, and never prints its token. It cannot see ephemeral messages or how a
message renders, so mention rendering, private notices and phone views still
need the client.

Setting up a lane, once, is the maintainer's job, because it handles a token:

1. Signed in to the lane workspace as its test account, create an app from
   the manifest in [slack-readback-app.json](slack-readback-app.json) at
   api.slack.com/apps, choosing that workspace. Creating it inside the
   workspace keeps Slack's normal history limits; one app shared by several
   workspaces would be throttled.
   If Slack's wizard ignores a pasted manifest, the app arrives as "Demo
   App"; replace its manifest on the app's App Manifest page instead.
2. Install it to the workspace from the app's OAuth & Permissions page.
3. Run `npm run lane:slack -- <alias|all> store-token`. It reads the app's
   user token from that page in the lane browser daemon, checks it against
   the lane's workspace, and writes `<LANE>__SLACK_READBACK_TOKEN` to the lane
   secrets file, printing only a fingerprint. That name is never uploaded to a
   Worker. Copying the token into the file by hand works too; never paste it
   into a chat.
4. Run `npm run lane:slack -- <alias> whoami`; the kickoff doctor then shows
   the lane's readback as working.

On a lane without a token, use the signed-in client view together with the
Worker's finalization records from a bounded `npm run lane:tail -- <alias>`
started before the action, and report the exact readback as a gap. Probe
builds that log API readbacks are a last resort. Each probe build costs a
deploy and must be replaced by the clean candidate before any grading.

## Host adapter table

The skill is written once for both hosts. Where a tool name differs, use this
table; a row's "Codex" entry is the equivalent, not a weaker substitute.

| The skill says | Claude Code | Codex |
| --- | --- | --- |
| Lane browser tools | `mcp__chrome-<lane>__*` | `mcp__chrome_<lane>__*`; every call takes a `pageId` |
| Browser fallback when no daemon can start | Claude-in-Chrome extension, then computer use | Codex's own browser tool (`cua`), then its computer use |
| Arrange a wake before you yield | the monitor tool, or a background shell `until` loop with a deadline | nothing re-invokes a finished turn: keep the turn open and poll in-turn (background exec sessions) up to the deadline, or end with an explicit blocked status |
| Ask the maintainer once, keep working | `AskUserQuestion` | `request_user_input_async` |
| Delegate a repair or a review | `Agent` (worktree isolation) and `SendMessage` between sessions | `spawn_agent`; cross-thread messages. A delegated reviewer must not delegate again, and must await any test it starts |
| A declared QA action is blocked | the auto-mode classifier; allow rules; ask once | Codex's approval policy; ask once |
| Node | the session inherits the maintainer's shell, pinned Node first | the login shell, pinned Node first; nested `zsh -c` shells inherit it |
| Skill loading | `/chickpea-live-verification` | `$chickpea-live-verification`; read the canonical [SKILL.md](SKILL.md) in full before the supporting docs |
| Tools configured but not callable | `/mcp` (human) reconnects a failed server | `codex mcp login`; a configured server may not be callable until then, so the kickoff check tests a call, not the config |

## Older workflow compatibility

`verify:live:ui`, `scripts/verification-ui-lease.mjs`, and `HostUiMutex` have been
removed. Update private callers to use their own tabs directly and omit the
coordinator's former `uiMutexRoot` option. `UiWindow.pause()` and `resume()` still
guard capture during a human wait and recheck target identity on resume; they
do not reserve a browser.

Existing `~/.chickpea/live-ui` files and private UI lease receipts are not read,
migrated, or deleted by this workflow. Older running checkouts may still use them.
Leave their locks, receipts, tabs, and pending actions with their owners for
reconciliation through the original checkout. Keep historical evidence and
reconcile interrupted actions before continuing an old run with updated code.
