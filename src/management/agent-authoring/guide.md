# Chickpea Agent authoring

Use this guide when a requester wants to explore, create, onboard, or edit a Chickpea Agent, asks what an Agent could do, or wants to create or revise a reusable Agent skill. The management service is the only mutation authority. This guide helps you reason and compose; tools validate, authorize, preview, confirm, and apply.

## Start with posture

Classify the current turn semantically before selecting fields or tools:

- `commit`: the requester is asking to make a sufficiently understood change.
- `explore`: the requester is brainstorming roles, workflows, or options.
- `capability_question`: the requester is asking whether or how something could work.
- `clarify`: the request is too ambiguous to design safely or an answer would materially change the design.

An `explore`, `capability_question`, or unresolved `clarify` turn must not mutate configuration. Inspect live state when useful, answer or offer options, and make the next decision easy. A detailed request is not automatically authorization to commit.

Activating this skill, reading its references, inspecting live state, and drafting a proposal are read-only. Do those steps when needed without asking the requester for separate permission. Ask for approval only at the configuration boundary required by this guide and the management service.

## Inspect before recommending

Use `inspect_workspace` before claiming a connector, repository, model, schedule facility, or other capability is available. Use the dedicated inspection tools for memory, routines, and Slack Channels when those details matter. Recommend only what the live result supports. Describe missing or unhealthy access as setup still needed; never imply that access exists because a tool or service is familiar.

Use each inspected revision only for the object it belongs to. A Channel's top-level `revision` is for `put_channel`. A nested `channels[].grants[].revision` is the Agent-to-Channel grant revision required by `revoke_agent_channel` and by `grant_agent_channel` when a matching grant already exists. Use `expectedRevision: 0` for `grant_agent_channel` only when inspection shows that no matching grant exists. Never substitute the parent Channel revision for a grant revision.

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

Use `propose_workspace_changes` for new-Agent creation and for generated, inferred, compound, multi-field, skill-bearing, capability-expanding, reach-changing, scheduled, destructive, or otherwise consequential edits. A proposal is read-only: it normalizes the exact typed operations, shows a bounded visible diff and missing setup, records the guide version, and returns a requester- and origin-bound handle.

Ask the requester to approve the exact visible proposal. Only then call `confirm_workspace_change` with its proposal handle. Never reconstruct or reinterpret operations during confirmation. If the proposal is stale, expired, denied, or bound to a different requester, conversation, client, or acting Agent, make no configuration write and offer a fresh inspection and proposal.

A direct, explicit, reversible single-field edit may use `apply_workspace_changes` immediately when the current edit policy permits it. If the value was inferred or generated, or if there is any material uncertainty, use a proposal. Existing setup, permission, revision, reach, and destructive confirmation gates always win.

Report the receipt accurately: applied, confirmation required, setup required, stale, denied, failed, or partially completed after admission. Do not claim success from intent alone.

## Acting scope

The host supplies the authenticated requester and trusted acting Agent identity; never take either from model-authored tool input.

- A user Agent may inspect and author its own complete configuration when the requester may edit it. It must not create another Agent, inspect or edit another Agent, or change workspace or provider authority.
- System Chickpea may create Agents and author Agents the requester is permitted to edit. System identity never overrides requester permission.
- An external MCP client acts with the authenticated requester's permissions and the same proposal, setup, revision, confirmation, idempotency, and audit rules.

For a cross-Agent request from a user Agent, use a bounded Chickpea handoff when the service offers one. Otherwise refuse without revealing the other Agent's private configuration.

## Onboard progressively

Confirmed creation produces only the approved base Agent: active and addressable through the base Chickpea app by an authorized editor, but with no silently attached connections, repositories, Channel grants, Slack presence, or routines. After creation, offer one highest-value next step based on the desired outcome and live capability state. Preserve resumability and let ordinary setup and authority gates handle each addition.

## Product examples

- **Chief of staff**: “Help me brainstorm what a chief of staff Agent could do and what to connect.” This is `explore`. Inspect available capabilities, offer a few grounded workflow shapes and their access needs, and ask which outcomes matter. Do not create anything.
- **Coding workflow**: “When I send a bug link, verify it, fix it, verify the fix, open a pull request, and share progress.” Put the coding role and boundaries in instructions, repository access in repositories, and the repeatable bug-to-pull request procedure in a skill. Inspect repository and workspace availability, read `skill-creation.md`, and propose the exact edit before activation.
- **Daily Sentry summary**: “Can this Agent post a daily summary of new P0 or P1 bugs?” Treat the first turn as a `capability_question`. Inspect Sentry and scheduling availability, then resolve destination, delivery time, timezone, severity definition, and empty-result behavior. Do not schedule from the question alone.

## Final check

Before any write, verify: posture is `commit`; target and acting scope are valid; live capabilities were inspected; the primitives match their intended semantics; credentials stay outside model context; consequential content has a visible proposal; and the user is approving the exact change that will be applied.
