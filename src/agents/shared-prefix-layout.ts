/**
 * The order and text that let platform-funded Slack turns share a prompt
 * prefix (shared-prefix.ts): the universal tools end at `present_details`,
 * and the system prompt opens with one constant block per Agent kind, then
 * the tenant block with the Agent's own instructions and identity.
 *
 * The Slack agent and the runner build their turns from this module, so it
 * loads at Worker startup and must not read the rendered tools.
 */
import type { AgentKind } from '../config/types.ts';
import { CHICKPEA_AGENT_ID } from '../config/agent-id.ts';
import {
  SLACK_INTERACTION_DEFAULTS,
  SLACK_RUNTIME_GUARDRAIL,
  agentTeammateInstructions,
  runtimeIdentityInstruction,
} from '../config/effective-config.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import { EXTERNAL_ACTION_AUTHORITY_PREAMBLE, savedAgentInstructionsBlock } from '../connections/runtime.ts';
import { AGENT_AUTHORING_ROUTER_INSTRUCTION } from '../management/agent-authoring/index.ts';
import { firstTeammateInstruction } from '../management/first-teammate.ts';
import {
  SLACK_MANAGEMENT_GUIDANCE,
  USER_AGENT_CREATION_HANDOFF_INSTRUCTION,
  slackManagementInstruction,
} from '../management/slack-tools.ts';
import { FILE_COMPLETION_INSTRUCTION } from '../slack/file-delivery-completion.ts';
import { SLACK_LISTS_INSTRUCTION } from '../slack/lists/tools.ts';
import { SLACK_ACTION_LINK_INSTRUCTION } from '../slack/message-format.ts';
import { SLACK_READING_INSTRUCTION } from '../slack/reading/tools.ts';
import { SLACK_PRESENT_TABLE_INSTRUCTION } from '../slack/table-presentation.ts';
import { SLACK_PRESENT_DETAILS_TOOL_NAME } from '../slack/ui/presentation-tools.ts';

/** The last universal tool: breakpoint A. */
export const SHARED_PREFIX_LAST_TOOL = SLACK_PRESENT_DETAILS_TOOL_NAME;

/** Tools that open every Slack turn's tool list, before any capability or tenant tool. */
export const UNIVERSAL_ARTIFACT_TOOL_NAMES: ReadonlySet<string> = new Set(['post_artifact', 'complete_file_delivery']);

/** Unconditional runtime-plan instructions. A routine registers them; a Slack turn opens its system block with them. */
export const RUNTIME_PLAN_INSTRUCTIONS = {
  honesty: 'Never invent facts or claim access to context and tools you do not have.',
  sandboxMemory: 'Sandbox files are temporary working data, not durable Agent memory. They do not follow this Agent into a fresh conversation. A successful file or shell write cannot establish that a fact was remembered. Never promise future recall from a sandbox file.',
  freshSandbox: 'This virtual sandbox starts with a fresh filesystem for each new request, including a follow-up in the same Slack thread. Files from an earlier request are gone. When the current user asks to return or revise those files, recreate them from the available contents in this request before attaching them; do not assume an earlier path still exists. The internal file-delivery check continues the current request and may only read and export existing files.',
  selfContained: 'The final Slack answer must be self-contained. Earlier assistant steps are working narration. After an interrupted response, write the complete final answer again, not just the remaining words of the partial response.',
} as const;

export const AGENT_KINDS: readonly AgentKind[] = ['system', 'user'];

/** Flue joins an agent's instruction parts with a blank line. */
export const PART_SEPARATOR = '\n\n';

export function slackAgentKind(agentId: string): AgentKind {
  return agentId === CHICKPEA_AGENT_ID ? 'system' : 'user';
}

/**
 * The instruction a Slack turn's agent returns, which opens its system
 * prompt. With the management tools and the requester's Lists and reading
 * tools mounted it is exactly `sharedSystemBlock(kind)`.
 */
export function slackSystemBase(input: {
  kind: AgentKind;
  managementMounted: boolean;
  memberToolsMounted: boolean;
}): string {
  return [
    [SLACK_INTERACTION_DEFAULTS, SLACK_RUNTIME_GUARDRAIL, EXTERNAL_ACTION_AUTHORITY_PREAMBLE].join('\n'),
    RUNTIME_PLAN_INSTRUCTIONS.honesty,
    RUNTIME_PLAN_INSTRUCTIONS.sandboxMemory,
    RUNTIME_PLAN_INSTRUCTIONS.freshSandbox,
    SLACK_ACTION_LINK_INSTRUCTION,
    RUNTIME_PLAN_INSTRUCTIONS.selfContained,
    FILE_COMPLETION_INSTRUCTION,
    AGENT_AUTHORING_ROUTER_INSTRUCTION,
    // A user Agent's routing sentence names its own ID, so it goes in the tenant block.
    ...(!input.managementMounted ? [] : input.kind === 'system'
      ? [slackManagementInstruction(CHICKPEA_AGENT_ID), firstTeammateInstruction()]
      : [SLACK_MANAGEMENT_GUIDANCE, USER_AGENT_CREATION_HANDOFF_INSTRUCTION]),
    ...(input.memberToolsMounted ? [SLACK_LISTS_INSTRUCTION, SLACK_READING_INSTRUCTION] : []),
    SLACK_PRESENT_TABLE_INSTRUCTION,
  ].join(PART_SEPARATOR);
}

const sharedBlocks = new Map<AgentKind, string>();

/** The constant system block every platform-funded Slack turn of `kind` opens with: breakpoint B. */
export function sharedSystemBlock(kind: AgentKind): string {
  let block = sharedBlocks.get(kind);
  if (block === undefined) {
    block = slackSystemBase({ kind, managementMounted: true, memberToolsMounted: true });
    sharedBlocks.set(kind, block);
  }
  return block;
}

/** Why a Slack turn mounts fewer tools than a shared shape, so its system block is not shared. */
export type ReducedTurn = 'requester_not_member' | 'management_unmounted';

let reducedBlocks: ReadonlyArray<readonly [string, ReducedTurn]> | undefined;

export function reducedSystemBlocks(): ReadonlyArray<readonly [string, ReducedTurn]> {
  reducedBlocks ??= AGENT_KINDS.flatMap((kind) => [
    [slackSystemBase({ kind, managementMounted: true, memberToolsMounted: false }), 'requester_not_member'] as const,
    [slackSystemBase({ kind, managementMounted: false, memberToolsMounted: false }), 'management_unmounted'] as const,
  ]);
  return reducedBlocks;
}

/**
 * How a system prompt opens: with an Agent kind's constant block and its
 * separator, then the tenant tail; with a reduced turn's block; or with
 * neither. The Anthropic hook (shared-prefix.ts) and the OpenAI planner
 * (openai-prompt-cache.ts) cut their cache prefix at the same place.
 */
export type SlackSystemText =
  | { readonly kind: 'shared'; readonly agentKind: AgentKind; readonly constant: string; readonly tail: string }
  | { readonly kind: 'reduced'; readonly reason: ReducedTurn }
  | { readonly kind: 'other' };

export function classifySlackSystemText(text: string | undefined): SlackSystemText {
  if (text === undefined) return { kind: 'other' };
  const opensWith = (block: string) => text.startsWith(block + PART_SEPARATOR);
  const agentKind = AGENT_KINDS.find((candidate) => opensWith(sharedSystemBlock(candidate)));
  if (agentKind !== undefined) {
    const constant = sharedSystemBlock(agentKind);
    return { kind: 'shared', agentKind, constant, tail: text.slice(constant.length + PART_SEPARATOR.length) };
  }
  const reason = reducedSystemBlocks().find(([block]) => opensWith(block))?.[1];
  return reason ? { kind: 'reduced', reason } : { kind: 'other' };
}

/**
 * The first tenant instruction: the Agent's saved instructions, its identity
 * in this workspace and channel, the saved instructions again inside the
 * external-action boundary, and the teammates it may ask.
 */
export function slackTenantInstructions(
  assignment: Pick<ResolvedAssignment, 'workspaceId' | 'channelId' | 'agent' | 'teammates' | 'threadGuest'>,
): string {
  const teammates = agentTeammateInstructions(assignment);
  return [
    assignment.agent.instructions,
    runtimeIdentityInstruction(assignment),
    savedAgentInstructionsBlock(assignment.agent.instructions),
    ...(teammates ? [teammates] : []),
  ].join('\n');
}
