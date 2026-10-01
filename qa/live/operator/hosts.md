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

At kickoff run `npm run lane:browser -- status all`:

- `running`: attach and go. Signed-in state lives in the profile, so a
  restarted daemon is still signed in.
- `stopped`: run `npm run lane:browser -- start <lane>`. It is idempotent and
  reports a daemon that already answers. In Codex, run it outside the command
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

A Claude Code cloud session has none of the host-configured servers above, so
the repository's `.mcp.json` defines the same three servers, `chrome-amber`,
`chrome-cobalt` and `chrome-violet`, each as
`node scripts/lane-browser.mjs serve <lane> --root ${CHICKPEA_LANE_CHROME_ROOT}`.
They are opt-in: the launcher refuses to start until `CHICKPEA_LANE_CHROME_ROOT`
names an absolute, owner-only directory outside the repository, so the file is
inert on a host that never set it. Set the variable in the cloud environment
(for example `/root/.chickpea/browsers`); the launcher creates the root and one
profile directory per lane under it with owner-only permissions. Start the
session at the repository root, where the relative script path resolves. On a
Mac the project entry and the user-scope entry end up in the same place: both
attach to the lane daemon, and `serve` also starts it when it is stopped. An
approved project entry replaces the user-scope one and needs
`CHICKPEA_LANE_CHROME_ROOT` set (the maintainer's user settings set it);
without the variable it fails to start, and Claude Code lists the duplicate
definition as a diagnostic, which is expected. `verify:hygiene` accepts
`.mcp.json` only in exactly this shape.

`serve` seeds the profile when a new cookie payload is present, starts the
lane daemon unless one already answers on its port, and attaches
`chrome-devtools-mcp` to it. The daemon is the environment's Chromium
(`CHICKPEA_LANE_CHROME_EXECUTABLE`, default `/opt/pw-browsers/chromium`; a
Playwright browsers directory or build directory resolves to its binary),
`--headless` whenever Linux has no display (`CHICKPEA_LANE_CHROME_HEADLESS=0`
forces a window), and `--no-sandbox` only when it runs as root. Puppeteer's
basic password store stays on Linux, where it is the only cookie store, so the
macOS keychain exemption above does not apply there. The server comes from
`node_modules/chrome-devtools-mcp` when it is installed, otherwise from
`npx chrome-devtools-mcp@1.10.1` (`CHICKPEA_LANE_CHROME_SERVER` names another
spec or an absolute entry point).
`npm run lane:browser -- serve <lane> --dry-run` prints the attach plan, the
daemon state and launch arguments, and the seed status as JSON without
starting the daemon; a new cookie payload is still seeded, which launches a
short headless Chromium. `serve` seeds, may wait up to 20 s for the daemon,
and may install the server through npx before it answers the MCP handshake,
so install `chrome-devtools-mcp` from the lockfile or raise the host's MCP
startup timeout (`MCP_TIMEOUT` in Claude Code) if the server is reported as
failed to start.

Network: the environment must allow `slack.com` and `*.slack.com` (the web
client, `edgeapi`, `files`), `*.slack-edge.com` (the client's static assets,
without which app.slack.com never boots), `*.workers.dev` together with every
lane Admin origin from the private lane matrix, `api.cloudflare.com` for
Wrangler, and `registry.npmjs.org` unless `chrome-devtools-mcp` is installed
from the lockfile. All traffic passes through the session proxy, which does
not upgrade WebSocket connections. Slack's real-time channel therefore never
connects: the client shows a reconnecting state, new messages appear only
after a fresh navigation, and presence, typing indicators and live thread
updates are unavailable. Read threads by URL and poll them as in the recipe
above; nothing in this workflow depends on the socket. Admin pages load
normally.

Profiles are seeded from cookies, not by signing in. Slack's web sign-in needs
an email code, which the transcript must never relay, and a proxy-injected
`Cookie` header (an environment credential on some plans) cannot be verified
from inside the sandbox and would collide with the cookies Chromium sends
itself. Instead the maintainer exports each signed-in lane profile once, on
the Mac, with that lane's Chrome quit:

```sh
npm run lane:browser -- export amber --root "$HOME/.chickpea/browsers" \
  --to-file "$HOME/.chickpea/lane-cookies/amber.b64" --host <lane-admin-host>
```

The file is owner-only base64 of a `chickpea-lane-cookies/v1` document: the
profile's `slack.com` cookies plus every `--host` given, such as the lane
Admin host so Admin stays signed in (without it, sign in to Admin through
Sign in with Slack inside the seeded profile). The command reports cookie
names, domains, sizes and a digest; it never prints a value, and there is no
stdout mode. Paste the file's content into the cloud environment variable
`CHICKPEA_LANE_COOKIES_AMBER` (`_COBALT`, `_VIOLET` likewise; environment
variables are readable only by that environment's users), then delete the
file. The next `serve` imports the payload into the fresh profile over the
DevTools pipe, checks the readback by name and domain, quits Chromium so the
profile is written, and stores `chickpea-lane-seed.json` in the profile with
the payload digest, cookie names and domains. Cookies without an expiry are
skipped, because Chromium drops them at exit. Neither the browser nor the
server child inherits any `CHICKPEA_LANE_COOKIES_*` variable, and no value
reaches stdout, stderr, the marker, a run record or an error: a payload that
fails validation is reported by cookie position and field.

Rotation: export again and replace the variable. The changed digest makes the
next `serve` reseed on its own; `npm run lane:browser -- import <lane> --replace`
does it immediately inside a running session. Record the export date per lane
in the hand-written part of the private lane matrix. Revocation: on the lane's
Slack account, sign out of all other sessions from the account settings page,
which invalidates the exported session everywhere; remove the variable from
the environment; delete the cloud profile root. A cookie value that appears in
any transcript or record is a leaked secret: stop using it, revoke, re-export.

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

Amber, Cobalt and Violet use the shared gateway transport. The operator has no
Slack token there, so an exact-message `conversations.replies` readback is
unavailable. Use a visible readback from the signed-in client together with the
Worker's finalization records from a bounded `npm run lane:tail -- <alias>`
started before the action, and report the exact API readback as a gap. Probe
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
