# Codex and Claude hosts

The `.agents` and `.claude` skill entrypoints both load [SKILL.md](SKILL.md).
Keep workflow policy and executable helpers here; a host adapter only explains
tool access. Both hosts use the same Node commands, private records, lane claims,
and machine-wide UI ownership. Neither host's task list is an acceptance record.

At entry, identify the available shell, browser/native UI tools, authenticated
test sessions, and private evidence directory. In Codex, use the enabled browser
or computer-use tools and their current documentation. In Claude, use its enabled
browser/native tools. Do not assume either host has the other's APIs or tab IDs.
Use one stable browser alias for the actual shared browser profile across hosts.
A new alias does not authorize using an already reserved browser.

Keep evidence outside Git in an owner-only directory. Confirm that the current
host can read it before a run. If a review tool cannot read a private file, provide
the relevant authorized, sanitized content in its review prompt. Do not move
private evidence into source or bypass a tool denial. Report unavailable context.
Preserve requested model selectors; configured defaults and independent serving
model readbacks are different evidence.

## Browser action receipts

Use the same `~/.chickpea/live-ui` root on this machine. It interoperates with the
existing mutex; older code fails closed on receipt ownership. Never use another
root to bypass contention. The CLI acquires ownership only; it does not click,
approve, send a message, or prove an action happened.

```sh
npm run verify:live:ui -- acquire --run RUN_ID --browser BROWSER_ALIAS \
  --case CASE_ID --step STEP_ID --action "Approve the frozen QA proposal" \
  --receipt /private/path/ui-step.json --wait-ms 30000
# On exit 0, use the host's browser tool for this one bounded action/readback.
npm run verify:live:ui -- release --receipt /private/path/ui-step.json
```

Use aliases and a short action description, never credentials. A new receipt
filename is required per acquisition; its private token authorizes exact release
from a later CLI process. Do not print or share it. Keep action evidence separately
in the run notebook. Bounded contention ends in exit 3 without an action; retry
only normal `UI_BUSY` or `BROWSER_RESERVED` contention. Exit 130 is cancellation.
Other errors require inspection. Never repeat the browser action because a later
receipt command failed.

When an authorized action needs MFA or another human capability, keep its browser
reserved while freeing global interaction for independent work:

```sh
npm run verify:live:ui -- pause --receipt /private/path/ui-step.json
# After the missing capability is supplied:
npm run verify:live:ui -- resume --receipt /private/path/ui-step.json --wait-ms 30000
# Observe the current UI; reconcile whether the original action already applied.
npm run verify:live:ui -- finish --receipt /private/path/ui-step.json
```

`finish` removes both the exact browser reservation and global interaction lock.
Use it after any pause/resume cycle; ordinary `release` only releases interaction.
`release` refuses while a browser reservation remains and retains its receipt.
An interrupted owner retains its receipt and reservations. Inspect the actual
action state using [recovery.md](recovery.md), then resume/finish with that receipt.
Resume is idempotent for an already-held exact receipt, including interruption
before a pause. `UI_RESUME_NOT_OWNED` is an immediate ownership error, not ordinary
contention. Resume only restores ownership: inspect and reconcile the visible
state before deciding whether any browser action is still needed.
Receipt ownership is not a live PID: a stopped CLI or changed hostname cannot
clear it. Missing or mismatched receipts require deliberate owner reconciliation;
never delete another task's lock or fabricate a replacement receipt.

The CLI reports acquisition wait and elapsed time since acquisition. The latter
includes pauses and is not browser-active time. Use the notebook's phase receipts
for actual held windows and human waits; do not label their sum a critical path.
