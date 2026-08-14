# Production fidelity QA — Agent-first Admin

## Final result

passed

No unresolved P0, P1, or P2 visual, interaction, responsive, or accessibility difference remains against the approved Agent-first prototype.

## Candidate and method

- Date: 2026-08-13
- Browser: Codex in-app Browser, device density 1
- Data: disposable loopback-only Admin fixture using the real authenticated routes, projections, SQLite stores, and UI actions
- Desktop viewport: 1440 × 1024; Channel Advanced pairs a tall hierarchy capture with a 1440 × 1024 resolved-diagnostics capture
- Responsive viewports: 1000 × 800, 740 × 900, 430 × 844, and 390 × 844
- 200% reflow equivalent: 720 × 1024 CSS pixels, equivalent to a 1440-wide page at 200% browser zoom
- Source references: `design-qa.md` and the approved `qa-*.png` captures in this directory

## Canonical surface comparison

| Surface | Approved reference | Production evidence | Result | Notes |
|---|---|---|---|---|
| Agent Instructions | `qa-profile-tabs-annotated.png`, `qa-profile-tabs.png` | `qa-production-agent-instructions.png` | Pass | Agent-first roster, title, status, compact tabs, primary instructions, placement, Model, and Advanced hierarchy match. |
| Agent Memory | `qa-agent-memory-files.png` | `qa-production-agent-memory.png` | Pass | Generated `MEMORY.md`, file rail, active file styling, dark generated source, add-file action, and owner-scoped editing remain intact. |
| Channels index | `qa-channels-index.png` | `qa-production-channels-index.png` | Pass | One operational summary/search card and one aligned Channel/Agent/Behavior/Status table replace the rejected card rail. |
| Channel detail | `qa-agent-first-channel.png`, `qa-channel-always-on-capabilities.png` | `qa-production-channel-detail.png` | Pass | Readiness, assigned Agent hero, inherited capabilities, participation, Slack proof, and collapsed Advanced follow the approved priority. |
| Channel Advanced | `qa-agent-first-channel.png` | `qa-production-channel-advanced.png`, `qa-production-channel-advanced-diagnostics.png` | Pass | Additive instructions, exact-Channel file memory, and subordinate resolved diagnostics are contained in one disclosure. |

## Responsive and zoom evidence

| Viewport/state | Evidence | Result | Checks |
|---|---|---|---|
| 1000px Agent | `qa-production-responsive-1000-agent.png` | Pass | Agent cards reflow to one column; Model remains readable; no horizontal overflow. |
| 1000px Channels | `qa-production-responsive-1000-channels.png` | Pass | The four-column table becomes labeled stacked rows before status text can clip. |
| 740px Agent | `qa-production-responsive-740-agent.png` | Pass | Desktop roster hands off to the existing mobile top bar; tab strip stays reachable. |
| 430px Agent | `qa-production-responsive-phone-agent.png` | Pass | Title, lifecycle actions, tabs, instructions, and placement reflow without hidden controls. |
| 430px Channel | `qa-production-responsive-phone-channel.png` | Pass | Header, enabled control, Agent hero, capability groups, participation, and Slack actions stack cleanly. |
| 200% equivalent | `qa-production-responsive-200-percent-channel.png` | Pass | No document or main-panel overflow; actions remain reachable. |
| 390px measured layout | Browser metrics | Pass | Document overflow 0px, main overflow 0px, and both Copy prompt and Open Slack rendered. |

## Interaction and accessibility checks

- Agent tab list exposes five semantic tabs and one local tab panel. ArrowRight moved Instructions → Skills; End moved to Memory; Home returned to Instructions, with selection and focus moving together.
- The Agent lifecycle overflow is the sole enable/disable/delete control. Escape closed the menu and restored focus to `Actions for Research Partner`.
- The mobile top-bar Agents action opened the shared Agent roster; Close removed it and restored focus to the Menu trigger.
- Agent and Channel Advanced retain native `details`/`summary` semantics. Browser clicks opened the disclosures, focus remained visible, and Channel memory re-renders preserve the open state. Keyboard behavior is additionally covered by the semantic markup and focused Admin tests; the integrated driver does not synthesize native disclosure activation on its keypress helper.
- Copy prompt wrote the exact suggested Slack prompt and announced `Prompt copied.` through a live status region.
- Clipboard feedback is scoped to the selected Channel; a delayed completion after navigation is ignored.
- Open Slack resolved to `https://app.slack.com/client/T_VISUAL/C_RELEASES` with `noopener noreferrer`.
- A discovered but unconfigured Channel renders `Not configured` and opens the Add Channel flow rather than a configured detail destination.
- The local fake Slack boundary rejects missing or incorrect bearer credentials and returns only the requested seeded user or Channel record.
- Channel Advanced exposed exact-Channel memory and the resolved configuration without returning the removed Access summary to the primary hierarchy.
- No unhandled script warning or error was recorded while navigating, switching tabs, opening the mobile roster, copying the prompt, or opening Advanced. The post-review Channels recapture recorded only expected handled 404 responses for optional onboarding and unseeded noncanonical memory projections.

## Rendered contrast

The scoped production palette was measured against its actual paper and well surfaces after the final polish:

| Pair | Ratio | Result |
|---|---:|---|
| Secondary text / paper | 6.38:1 | Pass |
| Muted text / paper | 4.74:1 | Pass |
| Muted text / well | 4.51:1 | Pass |
| Ready green / paper | 4.94:1 | Pass |
| Primary button ink / gold | 6.07:1 | Pass |

## Production-only differences

These differences are intentional and do not weaken prototype fidelity:

- The environment chip says `local · node` in the fixture rather than `cloudflare · workers`.
- Production uses real projected Agent, Channel, readiness, identity, capability, model, provider, revision, and memory data rather than prototype copy.
- Memory is the product's file-based owner model, including generated index, history, conflict, review, save, discard, and forget states; it is not reduced to a prototype on/off control.
- Advanced includes resolved model/provider/snapshot diagnostics because operators need truthful failure and recovery context.
- Disabled Agents, unassigned Channels, disconnected Slack, loading projections, effective-config errors, clipboard failures, and stale conflicts remain explicit production states.
- Save bars appear only for the dirty owner scope and preserve the existing Agent, Channel, and memory navigation guards.

## Verification gates

- Focused Admin interaction tests: passed
- Visual-fixture tests: passed
- TypeScript typecheck: passed
- Authenticated Admin verifier: passed
- Full repository test suite: passed
- Cloudflare production build validation: passed
- Diff hygiene: passed
