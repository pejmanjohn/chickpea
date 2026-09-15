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
