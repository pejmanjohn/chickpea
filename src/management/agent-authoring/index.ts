import { bytesToHex } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { defineSkill, useInstruction, useSkill } from '@flue/runtime';

export const AGENT_AUTHORING_SKILL_NAME = 'agent-authoring' as const;
export const AGENT_AUTHORING_GUIDE_VERSION = '1.0.0' as const;
export const AGENT_AUTHORING_GUIDE_URI = 'chickpea://guide/agent-authoring/v1' as const;
export const AGENT_AUTHORING_REASONS = [
  'agent_creation',
  'agent_edit',
  'skill_creation',
  'skill_edit',
  'onboarding',
] as const;
export type AgentAuthoringReason = typeof AGENT_AUTHORING_REASONS[number];

export const AGENT_AUTHORING_ROUTER_INSTRUCTION = [
  'Activate the `agent-authoring` skill before helping a requester create an Agent, edit an Agent, explore possible Agent roles or workflows, ask a capability question about Agent configuration, or create or revise a skill.',
  'Exploration and unresolved questions are read-only. Use the management tools only after the activated guide establishes the correct posture and target.',
].join(' ');

export const AGENT_AUTHORING_GUIDE = `# Chickpea Agent authoring

Use this guide when a requester wants to explore, create, onboard, or edit a Chickpea Agent, asks what an Agent could do, or wants to create or revise a reusable Agent skill. The management service is the only mutation authority. This guide helps you reason and compose; tools validate, authorize, preview, confirm, and apply.

## Start with posture

Classify the current turn semantically before selecting fields or tools:

- \`commit\`: the requester is asking to make a sufficiently understood change.
- \`explore\`: the requester is brainstorming roles, workflows, or options.
- \`capability_question\`: the requester is asking whether or how something could work.
- \`clarify\`: the request is too ambiguous to design safely or an answer would materially change the design.

An \`explore\`, \`capability_question\`, or unresolved \`clarify\` turn must not mutate configuration. Inspect live state when useful, answer or offer options, and make the next decision easy. A detailed request is not automatically authorization to commit.

## Inspect before recommending

Use \`inspect_workspace\` before claiming a connector, repository, model, schedule facility, or other capability is available. Use the dedicated inspection tools for memory, routines, and Slack Channels when those details matter. Recommend only what the live result supports. Describe missing or unhealthy access as setup still needed; never imply that access exists because a tool or service is familiar.

Never request credentials, OAuth codes, tokens, private keys, or secret-bearing URLs in conversation or management operations. Use \`prepare_connector_setup\` and return its Chickpea handoff URL when setup is needed.

## Choose the configuration primitive

Place each part of the request according to its lifetime and execution semantics:

- **Identity and description**: the Agent's name, handle, concise purpose, and discoverability.
- **Instructions**: standing role, priorities, boundaries, decision posture, and general behavior that should shape most turns.
- **Skills**: repeatable procedures that should activate for a recognizable class of work. Read \`skill-creation.md\` before drafting or materially revising one.
- **Memory**: durable facts, decisions, preferences, and context. Memory is not a procedure or a substitute for instructions.
- **Connections and repositories**: grants to tools and information sources. They describe access, not desired behavior.
- **Schedules**: recurring or one-time future work with a cadence, timezone, destination, and empty-result behavior. Mentioning a cadence does not by itself authorize a schedule.
- **Model choice**: a supported live model selected for the workload; do not invent model availability.
- **Slack presence and Channel reach**: where the Agent can appear and act. They do not teach the Agent what to do.
- **Editing authority**: who may edit the Agent. It is authority, not personality or knowledge.

When a request spans primitives, use the smallest coherent composition. Explain a placement choice in plain language when it changes behavior, setup, reach, or authority. Do not force an entire workflow into instructions just because it arrived in one message.

## Explore and design conversationally

For a new Agent, keep the design as text in the conversation until final approval. There must be no Agent record, memory write, grant, connection, repository, routine, Slack presence, or reserved authority during exploration.

Infer low-risk defaults when confidence is high and disclose them. For example, a support Agent can start with handle \`support\` and a concise support-oriented description. Ask only questions whose answers materially change the role, procedure, access, schedule, reach, or authority. Prefer one to three focused questions at a time.

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

Use \`propose_workspace_changes\` for new-Agent creation and for generated, inferred, compound, multi-field, skill-bearing, capability-expanding, reach-changing, scheduled, destructive, or otherwise consequential edits. A proposal is read-only: it normalizes the exact typed operations, shows a bounded visible diff and missing setup, records the guide version, and returns a requester- and origin-bound handle.

Ask the requester to approve the exact visible proposal. Only then call \`confirm_workspace_change\` with its proposal handle. Never reconstruct or reinterpret operations during confirmation. If the proposal is stale, expired, denied, or bound to a different requester, conversation, client, or acting Agent, make no configuration write and offer a fresh inspection and proposal.

A direct, explicit, reversible single-field edit may use \`apply_workspace_changes\` immediately when the current edit policy permits it. If the value was inferred or generated, or if there is any material uncertainty, use a proposal. Existing setup, permission, revision, reach, and destructive confirmation gates always win.

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

- **Chief of staff**: “Help me brainstorm what a chief of staff Agent could do and what to connect.” This is \`explore\`. Inspect available capabilities, offer a few grounded workflow shapes and their access needs, and ask which outcomes matter. Do not create anything.
- **Coding workflow**: “When I send a bug link, verify it, fix it, verify the fix, open a pull request, and share progress.” Put the coding role and boundaries in instructions, repository access in repositories, and the repeatable bug-to-pull request procedure in a skill. Inspect repository and workspace availability, read \`skill-creation.md\`, and propose the exact edit before activation.
- **Daily Sentry summary**: “Can this Agent post a daily summary of new P0 or P1 bugs?” Treat the first turn as a \`capability_question\`. Inspect Sentry and scheduling availability, then resolve destination, delivery time, timezone, severity definition, and empty-result behavior. Do not schedule from the question alone.

## Final check

Before any write, verify: posture is \`commit\`; target and acting scope are valid; live capabilities were inspected; the primitives match their intended semantics; credentials stay outside model context; consequential content has a visible proposal; and the user is approving the exact change that will be applied.`;

export const AGENT_SKILL_CREATION_GUIDE = `# Creating Chickpea inline skills

Use this procedure only when part of an Agent request is a reusable procedure that should activate for a recognizable class of work. Do not create a skill merely because a request is detailed, recurring, important, or long. Put standing identity and boundaries in instructions, durable facts in memory, access in connections or repositories, and timing in schedules.

The v1 output is one Chickpea inline skill with exactly these fields: \`name\`, \`description\`, \`instructions\`, and \`enabled\`. Scripts, assets, templates, and additional packaged files are not available for generated user skills in this release.

## 1. Collect activation examples

Begin with concrete user messages that should activate the skill and the observable outcomes they expect. Include paraphrases, not just one preferred wording. Add nearby examples that should not activate it so the boundary is explicit.

For a bug-to-pull request skill, positive activation examples could include a bug-report URL with a request to reproduce and fix it, or a failing issue with a request for a verified pull request. Negative examples could include asking for a code explanation, reviewing an existing pull request, or discussing engineering process without asking the Agent to execute the workflow.

If the requester has not supplied enough examples, ask focused questions or draft clearly labeled examples for correction. Do not invent a workflow from a title alone.

## 2. Research the actual environment

Inspect the Agent and live workspace before naming tools or steps. Establish which connectors, repositories, models, sandbox facilities, and management actions are actually available and healthy. Read relevant existing Agent instructions and skills so the new procedure composes instead of contradicting them.

Research enough domain context to make the steps executable. Distinguish facts learned from tools from assumptions that still need confirmation. Never solicit credentials; use Chickpea setup handoffs for missing access.

## 3. Design the skill

- **Name**: use lowercase letters, numbers, and single hyphens. Make it specific enough to avoid collisions and reserve \`agent-authoring\` for the product guide.
- **Description**: write a trigger-oriented catalog line. Say what the skill does and when to use it, using language close to the positive activation examples and enough contrast to avoid false positives.
- **Instructions**: give an executable procedure in the order work should happen. Name required inspections, progress updates, verification, failure handling, stopping conditions, and the final evidence to report. Prefer direct steps over background exposition.
- **Enabled**: normally \`true\` only after the requester approves the exact proposal.

Keep the skill focused. Refer to existing Agent instructions for universal behavior rather than repeating them. Do not claim unavailable tools, invent connector schemas, smuggle credentials into examples, or encode customer-specific facts that belong in memory.

## 4. Draft for observable behavior

Each important instruction should be verifiable from the eventual trace or result. For a coding skill, “verify the bug” should say how to establish a failing baseline; “fix it” should preserve scope and repository rules; “verify the fix” should rerun the failing reproduction plus relevant tests; “open a pull request” should happen only after verification; and “share progress” should identify meaningful milestones without noisy narration.

Include failure behavior. If required access is missing, stop and return the safe setup need. If reproduction fails, report the evidence instead of manufacturing a fix. If a side effect has an ambiguous result, inspect remote state before retrying.

## 5. Evaluate before proposing

Run realistic positive and negative cases in fresh conversations. Check both false negatives, where the skill should activate but does not, and false positives, where ordinary Agent work activates it. Inspect the activation and tool traces, not only the final prose.

Evaluate placement and safety too: the procedure belongs in a skill; capability claims match inspection; exploratory prompts cause no mutation; credentials are never requested; and consequential edits select the proposal path. Revise the description first when activation boundaries are wrong, then refine instructions when execution quality is wrong.

## 6. Show and propose the exact change

Present the skill name, trigger description, and full instructions or a faithful diff. Explain any material placement choice in user language. Adding or materially rewriting a skill is a generated complex edit: call \`propose_workspace_changes\`, show its exact bounded diff and setup needs, and ask for explicit approval.

Only \`confirm_workspace_change\` may activate the frozen proposal. If the proposal becomes stale or permissions change, do not recreate the content silently; inspect again and propose a new revision. Report the terminal receipt without including raw skill instructions in telemetry.`;

export const AGENT_AUTHORING_GUIDE_DIGEST = bytesToHex(sha256(new TextEncoder().encode(
  `${AGENT_AUTHORING_GUIDE}\n---skill-creation---\n${AGENT_SKILL_CREATION_GUIDE}`,
)));

const agentAuthoringSkill = defineSkill({
  name: AGENT_AUTHORING_SKILL_NAME,
  description: 'Explore, create, onboard, or edit a Chickpea Agent, answer Agent capability questions, and create or revise reusable Agent skills. Activate before proposing Agent configuration changes.',
  instructions: AGENT_AUTHORING_GUIDE,
  metadata: {
    'chickpea-guide-version': AGENT_AUTHORING_GUIDE_VERSION,
    'chickpea-guide-uri': AGENT_AUTHORING_GUIDE_URI,
    'chickpea-guide-digest': AGENT_AUTHORING_GUIDE_DIGEST,
  },
  files: { 'skill-creation.md': AGENT_SKILL_CREATION_GUIDE },
});

export const AGENT_AUTHORING_PACKAGE = Object.freeze({
  name: AGENT_AUTHORING_SKILL_NAME,
  version: AGENT_AUTHORING_GUIDE_VERSION,
  uri: AGENT_AUTHORING_GUIDE_URI,
  digest: AGENT_AUTHORING_GUIDE_DIGEST,
  router: AGENT_AUTHORING_ROUTER_INSTRUCTION,
  guide: AGENT_AUTHORING_GUIDE,
  skillCreationGuide: AGENT_SKILL_CREATION_GUIDE,
  skill: agentAuthoringSkill,
});

/** Mount product-owned authoring intelligence only in interactive Agents. */
export function useAgentAuthoring(): void {
  useInstruction(AGENT_AUTHORING_ROUTER_INSTRUCTION);
  useSkill(agentAuthoringSkill);
}
