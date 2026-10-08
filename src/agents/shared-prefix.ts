/**
 * The prompt prefix every platform-funded Slack turn on one model and Agent
 * kind shares across workspaces and channels: the universal tools, ending at
 * `present_details`, then one constant system block. The Agent's own
 * instructions, its identity, and everything conditional follow as the tenant
 * block, so a new thread in any workspace reads the prefix from the provider's
 * prompt cache.
 *
 * The platform payload hook in model access sets the cache breakpoints with
 * `sharePromptPrefix`. Any per-workspace text placed before the boundary, or
 * an unconditional instruction registered outside `slackSystemBase`, breaks
 * sharing; tests/shared-prefix.test.ts pins both.
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
import { SLACK_MANAGEMENT_GUIDANCE, slackManagementInstruction } from '../management/slack-tools.ts';
import { FILE_COMPLETION_INSTRUCTION } from '../slack/file-delivery-completion.ts';
import { SLACK_LISTS_INSTRUCTION } from '../slack/lists/tools.ts';
import { SLACK_ACTION_LINK_INSTRUCTION } from '../slack/message-format.ts';
import { SLACK_READING_INSTRUCTION } from '../slack/reading/tools.ts';
import { SLACK_PRESENT_TABLE_INSTRUCTION } from '../slack/table-presentation.ts';
import { SLACK_PRESENT_DETAILS_TOOL_NAME } from '../slack/ui/presentation-tools.ts';
import rendered from './shared-prefix-tools.json' with { type: 'json' };

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

const AGENT_KINDS: readonly AgentKind[] = ['system', 'user'];

/** Flue joins an agent's instruction parts with a blank line. */
const PART_SEPARATOR = '\n\n';

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
      : [SLACK_MANAGEMENT_GUIDANCE]),
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

/**
 * The first tenant instruction: the Agent's saved instructions, its identity
 * in this workspace and channel, the saved instructions again inside the
 * external-action boundary, and the Channel teammates it may ask.
 */
export function slackTenantInstructions(
  assignment: Pick<ResolvedAssignment, 'workspaceId' | 'channelId' | 'agent' | 'channelTeammates' | 'threadGuest'>,
): string {
  const teammates = agentTeammateInstructions(assignment);
  return [
    assignment.agent.instructions,
    runtimeIdentityInstruction(assignment),
    savedAgentInstructionsBlock(assignment.agent.instructions),
    ...(teammates ? [teammates] : []),
  ].join('\n');
}

type CacheControl = { type: 'ephemeral'; ttl: '1h' | '5m' };
const ONE_HOUR: CacheControl = { type: 'ephemeral', ttl: '1h' };
const FIVE_MINUTES: CacheControl = { type: 'ephemeral', ttl: '5m' };

type Payload = Record<string, unknown>;

let missed = 0;

/** Platform-funded Slack-turn requests in this process that went out without the shared prefix. */
export function sharedPrefixMisses(): number {
  return missed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function singleSystemText(payload: Payload): string | undefined {
  const { system } = payload;
  if (!Array.isArray(system) || system.length !== 1) return undefined;
  const [block] = system;
  return isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
}

function withoutCacheControl(block: unknown): unknown {
  if (!isRecord(block) || !('cache_control' in block)) return block;
  const { cache_control: _marker, ...rest } = block;
  return rest;
}

/**
 * Set breakpoints so the request shares its prefix: A on the last universal
 * tool (1 hour), B on the constant system block (1 hour, or 5 minutes when
 * capability tools sit between A and B and key it to this tool set), C on
 * the tenant block (5 minutes), and pi-ai's D on the last user block. A
 * request that carries the anchor tool or a shared block but not both goes
 * out exactly as built and counts as a miss; any other request (an intent
 * check, a routine) is not a Slack turn and goes out unchanged.
 */
export function sharePromptPrefix(payload: Payload): Payload {
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const anchor = tools.findIndex((tool) => isRecord(tool) && tool.name === SHARED_PREFIX_LAST_TOOL);
  const text = singleSystemText(payload);
  const constant = text === undefined
    ? undefined
    : AGENT_KINDS.map(sharedSystemBlock).find((block) => text.startsWith(block + PART_SEPARATOR));
  if (anchor < 0 && constant === undefined) return payload;
  const tail = constant === undefined ? '' : text!.slice(constant.length + PART_SEPARATOR.length);
  if (anchor < 0 || constant === undefined || tail.length === 0) {
    missed += 1;
    console.warn('[chickpea] platform-funded request went out without the shared prompt prefix', {
      model: payload.model,
      reason: anchor < 0 ? 'universal_tools_missing' : constant === undefined ? 'system_block_missing' : 'tenant_block_empty',
    });
    return payload;
  }
  return {
    ...payload,
    tools: tools.map((tool, index) => index === anchor
      ? { ...(withoutCacheControl(tool) as Payload), cache_control: ONE_HOUR }
      : withoutCacheControl(tool)),
    system: [
      { type: 'text', text: constant, cache_control: anchor === tools.length - 1 ? ONE_HOUR : FIVE_MINUTES },
      { type: 'text', text: tail, cache_control: FIVE_MINUTES },
    ],
  };
}

type RenderedPrefix = {
  tools: Payload[];
  models: Record<string, Payload>;
};

const PREWARM_TURN = 'Reply with one word.';

/**
 * The request that writes or refreshes the shared prefix of `kind` on
 * `model`: the universal tools and the constant system block with markers A
 * and B (1 hour), the request settings real traffic sends, a placeholder turn,
 * and `max_tokens: 0`. The tools and settings are the bytes a rendered
 * platform-funded turn sends, kept in shared-prefix-tools.json; the test pins
 * that file to a fresh render.
 */
export function sharedPrefixRequest(model: string, kind: AgentKind): Payload {
  const { tools, models } = rendered as RenderedPrefix;
  const settings = models[model];
  if (!settings) throw new Error(`No shared prompt prefix is rendered for model ${model}.`);
  return {
    model,
    max_tokens: 0,
    ...settings,
    system: [{ type: 'text', text: sharedSystemBlock(kind), cache_control: ONE_HOUR }],
    tools: tools.map((tool, index) => index === tools.length - 1 ? { ...tool, cache_control: ONE_HOUR } : tool),
    messages: [{ role: 'user', content: [{ type: 'text', text: PREWARM_TURN }] }],
  };
}
