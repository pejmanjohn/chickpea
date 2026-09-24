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

## Browser and Slack practice in Claude

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
- A new Admin-created Agent is unpublished in Slack until it is attached to a
  channel. Plain text such as `@handle` then routes to Chickpea. Attach the
  Agent to the QA channel before mentioning it. Insert mentions with the
  composer's mention control.
- The extension cannot press native `confirm()` dialogs. For a declared
  cleanup action in an owned tab, override `window.confirm` to return `true`
  in that tab before clicking. Then verify the result by readback.
- Computer use grants Slack desktop only through an OS dialog that the human
  must accept at the machine. A chat approval cannot accept it. Request the
  grant during the kickoff preflight, or use the signed-in web client.
- When the auto-mode permission classifier blocks a declared QA action (a
  lane deploy, a `wrangler rollback` to the lane's receipt version, a product
  UI write), name the lane alias and the declared action, and ask once. Never
  route around the block.

## Slack evidence on gateway lanes

Amber, Cobalt and Violet use the shared gateway transport. The operator has no
Slack token there, so an exact-message `conversations.replies` readback is
unavailable. Use a visible readback from the signed-in client together with the
Worker's finalization records from a bounded `wrangler tail --format json`
attached before the action, and report the exact API readback as a gap. Probe
builds that log API readbacks are a last resort. Each probe build costs a
deploy and must be replaced by the clean candidate before any grading.

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
