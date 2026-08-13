# Design QA — Agent-first exploration

## Source visual truth

- Prior accepted Profile implementation: `qa-profile-tabs-annotated.png`
- User-directed structural change: Agents replace Channels as the sidebar's primary objects; Profile is renamed Agent; channels are opened from the Agent; Agent instructions are primary; channel instructions become Advanced overrides.

## Implementation evidence

- Agent memory file editor: `qa-agent-memory-files.png`
- Channels assignment index: `qa-channels-index.png`
- Earlier Agent and memory view: `qa-agent-first-memory.png`
- Channel Advanced override view: `qa-agent-first-channel.png`
- Always-on channel instructions and memory: `qa-channel-always-on-capabilities.png`
- Side-by-side comparison: `qa-agent-first-comparison.png`
- Browser viewport: Codex in-app Browser desktop viewport; full-page screenshots captured at device density 1.

## State and interactions tested

- Sidebar lists three realistic Agents and makes Agents the active primary area.
- Selecting Customer Insights changes the active Agent and its data.
- Clicking `#customer-feedback` from the Agent opens that channel's settings.
- Channel back action returns to Customer Insights.
- Agent tabs include directly editable Instructions, Skills, Connectors, Repositories, and Memory.
- Memory matches Chickpea's existing file model: a generated read-only `MEMORY.md` index plus individually selectable memory files with name, type, description, Markdown body, status, version, and revision affordances.
- Editing and saving a memory file increments its version; switching to `MEMORY.md` and back preserves the saved value.
- The lower-left Channels index lists channel-to-Agent assignments, behavior, and readiness. Search filters by channel or Agent.
- Clicking the Customer Insights assignment opens that Agent; clicking its channel opens `#customer-feedback` with the correct Agent relationship.
- Model remains visible outside Advanced.
- Channel Advanced contains always-available editors for additive channel instructions and channel-scoped memory.
- Both editors retain their values after navigating back to the Agent and reopening the channel.
- Build and Sites packaging tests pass.

## Full-view comparison

The redesign preserves the accepted visual system and compact tab treatment while reversing information architecture. The previous channel-first sidebar is visibly replaced by an Agent roster; Agent placement now provides the path into channel settings.

## Focused comparison

The main content hierarchy remains familiar while `Default Profile` becomes a concrete Agent. Agent memory is no longer an abstract on/off summary: it uses the product's existing file-based editor. Channel instructions and memory remain always available capabilities rather than user-facing on/off modes; the Agent decides whether they are relevant during a turn. The separate Channels index restores a complete operational view without making channels the primary authoring orientation.

## Findings

- No actionable P0/P1/P2 visual or interaction issues found in this exploratory prototype.
- P3: internal CSS component names still use some `profile-*` class names; this is implementation-only and intentionally left alone in a throwaway prototype.

## Final result

passed

---

# Previous QA archive

## Scope

- Channel detail redesign at 1440 x 1024.
- Profile redesign in both scannable-row and compact-tab layouts.
- Shared mock state and linked navigation between Channel and Profile.

## Visual comparison

Compared the selected Channel and Profile references beside the implementation in `qa-comparison.png`.

- The implementation preserves Chickpea's warm cream surface, compact left rail, gold actions, rounded controls, and low-contrast dividers.
- Channel content hierarchy matches the selected direction: purpose first, then behavior/capabilities, then a concrete Slack action.
- Profile rows preserve the reference hierarchy while replacing abstract counts with visible skills, connector logos, repository names, and capped `+N more` previews.
- The compact-tab option reduces simultaneous rows without hiding Profile scope: `Where it works` stays visible below every tab.
- Profile typography was reduced after comparison so the title no longer overpowers the working content.

## Interaction checks

- Channel and Profile navigation preserves the same `#all-acme-inc` / `Default Profile` relationship.
- Instructions, Skills, Connectors, and Repositories tabs switch their working panel.
- Scannable rows and Compact tabs switch without losing state.
- Edit instructions, Manage skills, Manage connectors, Manage repositories, Add to channels, and channel behavior open focused dialogs.
- Connector selections and channel placement show realistic selected state.
- Copy prompt, Open Slack, Save changes, and modal actions provide visible feedback.
- Advanced remains collapsed until requested.
- Desktop viewport has no horizontal overflow or unreachable actions.

## Verification

- `npm run build` passed with Vite 8.0.10.
- Browser interaction pass completed in the in-app browser at `http://127.0.0.1:4184/#profile`.
- Historical console errors from the initial duplicate-React setup were resolved; subsequent reloads rendered cleanly.

final result: passed
