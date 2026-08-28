# Chickpea Agent authoring

Use this guide when a requester wants to explore, create, onboard, or edit a Chickpea Agent, asks what an Agent could do, or wants to create or revise a reusable Agent skill. Use it for scheduled work when that work is part of a compound Agent-configuration request or when the requester asks to delete scheduled work. The management service is the only mutation authority. This guide helps you reason and compose; tools validate, authorize, preview, confirm, and apply.

## Start with posture

Classify the current turn semantically before selecting fields or tools:

- `commit`: the requester is asking to make a sufficiently understood change.
- `explore`: the requester is brainstorming roles, workflows, or options.
- `capability_question`: the requester is asking whether or how something could work.
- `clarify`: the request is too ambiguous to design safely or an answer would materially change the design.

An `explore`, `capability_question`, or unresolved `clarify` turn must not mutate configuration. Inspect live state when useful, answer or offer options, and make the next decision easy. A detailed request is not automatically authorization to commit.

Activating this skill, reading its references, inspecting live state, and drafting a proposal are read-only. Do those steps when needed without asking the requester for separate permission. Ask for approval only at the configuration boundary required by this guide and the management service.

## Inspect before recommending

Use `inspect_workspace` before claiming a connector, repository, model, schedule facility, or other capability is available. When the requester asks what an Agent could do or what to connect, inspection is mandatory in that turn before naming specific services or describing availability; do not offer to inspect later after giving generic recommendations. Use the dedicated inspection tools for memory, routines, and Slack Channels when those details matter. Recommend only what the live result supports. Describe missing or unhealthy access as setup still needed; never imply that access exists because a tool or service is familiar.

Use each inspected revision only for the object it belongs to. A Channel's top-level `revision` is for `put_channel`. A nested `channels[].grants[].revision` is the Agent-to-Channel grant revision required by `revoke_agent_channel` and by `grant_agent_channel` when a matching grant already exists. Use `expectedRevision: 0` for `grant_agent_channel` only when inspection shows that no matching grant exists. Never substitute the parent Channel revision for a grant revision.

For a routine that posts to the current Slack Channel, reuse that destination when `inspect_workspace` shows the Channel is active and its grant for the acting Agent is active. Put the inspected `workspaceId` and `channelId` directly in `save_routine`; do not add `put_channel`, `grant_agent_channel`, or Channel discovery to the proposal. A Channel operation is needed only when the destination or grant is actually missing or inactive. Do not turn an already-satisfied destination into a workspace-authority handoff.

In a one-to-one Chickpea DM, call `inspect_routines` with the workspace and let the trusted Slack origin supply the private conversation. Create private scheduled work with `destination: { kind: "current_dm_thread" }` and omit `channelId`; never copy or invent a DM ID, thread timestamp, or member ID. A user Agent may create and manage only schedules it owns. Chickpea may manage every schedule belonging to that member in the same DM, but must name an eligible user Agent as owner and never use itself. Use `reassign_routine_agent` only through Chickpea when the member explicitly changes the owning Agent. Group DMs cannot contain scheduled work.

Never request credentials, OAuth codes, tokens, private keys, or secret-bearing URLs in conversation or management operations. Use `prepare_connector_setup` and return its Chickpea handoff URL when setup is needed.

## Choose the configuration primitive

Place each part of the request according to its lifetime and execution semantics:

- **Identity and description**: the Agent's name, handle, concise purpose, and discoverability.
- **Instructions**: standing role, priorities, boundaries, decision posture, and general behavior that should shape most turns.
- **Skills**: repeatable procedures that should activate for a recognizable class of work. Read `skill-creation.md` before drafting or materially revising one.
- **Memory**: durable facts, decisions, preferences, and context. Memory is not a procedure or a substitute for instructions.
- **Connections and repositories**: grants to tools and information sources. They describe access, not desired behavior.
- **Schedules**: recurring or one-time future work with a cadence, timezone, destination, and empty-result behavior. Mentioning a cadence does not by itself authorize a schedule.
- **Model choice**: a supported live model selected for the workload; do not invent model availability.
- **Slack presence and Channel reach**: where the Agent can appear and act. They do not teach the Agent what to do.
- **Editing authority**: who may edit the Agent. It is authority, not personality or knowledge.

When a request spans primitives, use the smallest coherent composition. Explain a placement choice in plain language when it changes behavior, setup, reach, or authority. Do not force an entire workflow into instructions just because it arrived in one message.

All requests to remember or edit durable Agent memory are Agent authoring. Call `inspect_memory` to read the current body and revision, then preserve the existing body and include an `update_agent_memory` operation with that exact `expectedRevision`. A clear, standalone, reversible memory request may use the direct-apply path when policy permits. If the same turn also asks for standing behavior, a skill, access, identity, model, reach, editing authority, or scheduled work, include the memory operation in the same read-only proposal as the other primitives; never partially apply the turn.

Standalone natural-language requests to create, edit, pause, resume, disable, or run scheduled work now use the first-class `manage_scheduled_work` tool and are outside Agent authoring. Inspect existing routines before an edit, control, or run-now action so the operation uses an exact routine ID and current version where required. Deletion is deliberately outside `manage_scheduled_work` because it is irreversible. For a clear delete request, activate this guide, call `inspect_routines`, and disambiguate if needed. Once the exact routine ID and current version are known, call `propose_workspace_changes` with one `delete_routine` operation, show the returned Slack preview, and wait for explicit confirmation before calling `confirm_workspace_change`. Never delete through `apply_workspace_changes`. Exact `!routines` commands remain a separate deterministic control surface. When one request also contains a durable fact, standing behavior, skill, access change, identity change, or model change, this guide owns the compound request: inspect and place every part together; never save only the cadence and discard the rest.

A clear instruction to continue work at a future time is an explicit schedule request and does not need to say schedule. For example, “Check this again in 5 minutes and tell me anything new” means fresh one-time scheduled work, not an edit to an existing routine. Relative timing stays relative so the service computes the exact future instant from its trusted clock. In a compound request, represent the schedule with the same `save_routine` operation used by the shared command, but keep it inside the proposal required by the other changes. Never use the compound path to add an approval round trip to a standalone clear schedule action.

## Explore and design conversationally

For a new Agent, keep the design as text in the conversation until final approval. There must be no Agent record, memory write, grant, connection, repository, routine, Slack presence, or reserved authority during exploration.

Infer low-risk defaults when confidence is high and disclose them. For example, a support Agent can start with handle `support` and a concise support-oriented description. Ask only questions whose answers materially change the role, procedure, access, schedule, reach, or authority. Prefer one to three focused questions at a time.

Before proposing creation, show a coherent blueprint:

1. Name, handle, purpose, and description.
2. Standing instructions and boundaries.
3. Initial inline skills, if any, including their full content or a faithful summary and diff.
4. Capability and setup needs grounded in live inspection.
5. Intended Slack presence, Channel reach, and schedules, clearly marked as later gated steps.
6. Editing authority and model choice.
7. Assumptions and unresolved decisions.
8. What will exist immediately after approval versus what still needs setup or separate confirmation.

Do not repeatedly re-ask settled details. Fill obvious blanks, show the assumption, and let the requester correct it.

## Propose, review, and commit

Use `propose_workspace_changes` for new-Agent creation and for generated, inferred, compound, multi-field, skill-bearing, capability-expanding, reach-changing, destructive, or otherwise consequential edits. A proposal is read-only: it normalizes the exact typed operations, shows a bounded visible diff and missing setup, records the guide version, and returns a requester- and origin-bound handle. Standalone scheduled work does not belong to this path except for irreversible deletion, which always does.

Treat every returned proposal handle as an opaque control token. Preserve it byte-for-byte for `confirm_workspace_change`; never retype, shorten, normalize, or invent it. The handle is not the human-facing proposal and should not replace the visible preview. If the exact handle is unavailable, inspect or propose again instead of guessing.

For Slack, copy the tool's `presentation.slack` value verbatim. A new object shows concise values without a fictional before state. An existing object shows before and after only for meaningful visible changes. The preview omits empty and internal details and clearly labels truncation. Ask the requester to approve the proposed changes. Confirmation applies the full frozen proposal, including details omitted from a truncated preview. Proposals do not expire, but a newer proposal from the same requester and origin supersedes the older pending one, and confirmation still rechecks live authority, policy, and target revisions. Only then call `confirm_workspace_change` with its proposal handle. Never reconstruct or reinterpret operations during confirmation. If the proposal is stale, denied, or bound to a different requester, conversation, client, or acting Agent, make no configuration write and offer a fresh inspection and proposal.

A direct, explicit, reversible single-field edit may use `apply_workspace_changes` immediately when the current edit policy permits it. If the value was inferred or generated, or if there is any material uncertainty, use a proposal. Existing setup, permission, revision, reach, and destructive confirmation gates always win.

Report the receipt accurately: applied, confirmation required, setup required, stale, denied, failed, or partially completed after admission. After any confirmation attempt, always finish the same turn with visible plain-language final text that names the terminal status and what changed or why nothing changed. Do not end on a tool call or leave a progress card or checklist as the only response. Do not claim success from intent alone.

## Acting scope

The host supplies the authenticated requester and trusted acting Agent identity; never take either from model-authored tool input.

- A user Agent may inspect and author its own complete configuration when the requester may edit it. It must not create another Agent, inspect or edit another Agent, or change workspace or provider authority.
- System Chickpea may create Agents and author Agents the requester is permitted to edit. System identity never overrides requester permission.
- In a one-to-one DM, the acting user Agent sees only its own private schedules. Chickpea can administer all of that member's schedules in that DM, including run-now and explicit owner reassignment, while the stored user Agent remains the execution identity.
- An external MCP client acts with the authenticated requester's permissions and the same proposal, setup, revision, confirmation, idempotency, and audit rules.

For a cross-Agent request from a user Agent, do not inspect, infer, or expose the other Agent's configuration. Call `request_chickpea_handoff` with reason `cross_agent`, then tell the requester to mention `@Chickpea` in the same thread so Chickpea can re-check their permission and continue. Use reason `workspace_authority` for Channel, team, or provider administration outside the acting Agent's scope. A handoff is read-only and does not reserve or mutate anything.

## Onboard progressively

Confirmed creation produces only the approved base Agent: active and addressable through the base Chickpea app by an authorized editor, but with no silently attached connections, repositories, Channel grants, Slack presence, or routines. After creation, offer one highest-value next step based on the desired outcome and live capability state. Preserve resumability and let ordinary setup and authority gates handle each addition.

## Product examples

- **Chief of staff**: “Help me brainstorm what a chief of staff Agent could do and what to connect.” This is `explore`. Inspect available capabilities, offer a few grounded workflow shapes and their access needs, and ask which outcomes matter. Do not create anything.
- **Coding workflow**: “When I send a bug link, verify it, fix it, verify the fix, open a pull request, and share progress.” Put the coding role and boundaries in instructions, repository access in repositories, and the repeatable bug-to-pull request procedure in a skill. Inspect repository and workspace availability, read `skill-creation.md`, and propose the exact edit before activation.
- **Daily Sentry summary**: “Can this Agent post a daily summary of new P0 or P1 bugs?” Treat the first turn as a `capability_question`. Inspect Sentry and scheduling availability, then resolve destination, delivery time, timezone, severity definition, and empty-result behavior. Do not schedule from the question alone.

## Final check

Before any write, verify: the complete request was considered before selecting a mutation tool; posture is `commit`; target and acting scope are valid; live capabilities were inspected; the primitives match their intended semantics; credentials stay outside model context; consequential content has a visible proposal; and the user is approving the exact change that will be applied.
