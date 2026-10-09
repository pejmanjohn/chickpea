/**
 * The prompt prefix every platform-funded Slack turn on one model and Agent
 * kind shares across workspaces and channels: the universal tools, ending at
 * `present_details`, the capability tools of one shape after them, then one
 * constant system block. The Agent's own instructions, its identity, and
 * everything conditional follow as the tenant block, so a new thread in any
 * workspace reads the prefix from the provider's prompt cache.
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

type ShapeSegment = 'interactive' | 'streaming' | 'image';

export const SHARED_PREFIX_SHAPES = {
  interactive: ['interactive'],
  interactive_streaming: ['interactive', 'streaming'],
  interactive_image: ['interactive', 'image'],
  interactive_streaming_image: ['interactive', 'streaming', 'image'],
  bare: [],
  streaming: ['streaming'],
  image: ['image'],
  streaming_image: ['streaming', 'image'],
} as const satisfies Record<string, readonly ShapeSegment[]>;
export type SharedPrefixShape = keyof typeof SHARED_PREFIX_SHAPES;

/** One shared prefix on a model: an Agent kind's constant block after one shape's tools. */
export type SharedPrefixId = `${AgentKind}/${SharedPrefixShape}`;

/** Channel and DM turns mount the interactive tools, so these are the shapes worth warming. */
export type WarmedSharedPrefixShape = {
  [Shape in SharedPrefixShape]: 'interactive' extends typeof SHARED_PREFIX_SHAPES[Shape][number] ? Shape : never;
}[SharedPrefixShape];

export const WARMED_SHARED_PREFIX_SHAPES = (Object.keys(SHARED_PREFIX_SHAPES) as SharedPrefixShape[])
  .filter((shape): shape is WarmedSharedPrefixShape =>
    (SHARED_PREFIX_SHAPES[shape] as readonly ShapeSegment[]).includes('interactive'));

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

let unsharedBlocks: readonly string[] | undefined;

function unsharedSystemBlocks(): readonly string[] {
  unsharedBlocks ??= AGENT_KINDS.flatMap((kind) => [
    slackSystemBase({ kind, managementMounted: true, memberToolsMounted: false }),
    slackSystemBase({ kind, managementMounted: false, memberToolsMounted: false }),
  ]);
  return unsharedBlocks;
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

export interface SharedPrefixDecision {
  payload: Payload;
  sharedPrefix: SharedPrefixId | null;
}

/**
 * Set breakpoints A on the last universal tool and B on the constant system
 * block, then C on the tenant block and D on the last user block (5 minutes).
 * B lasts an hour only when the tools between A and B are a shared shape's:
 * a tenant tool there keys B to one workspace, where an hour's write premium
 * buys nothing. A Slack turn that carries the anchor tool or a shared
 * block but not both, or other universal tools, goes out as built and counts
 * a miss.
 */
export function sharePromptPrefix(payload: Payload): SharedPrefixDecision {
  const unshared = { payload, sharedPrefix: null };
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const anchor = tools.findIndex((tool) => isRecord(tool) && tool.name === SHARED_PREFIX_LAST_TOOL);
  const text = singleSystemText(payload);
  const opensWith = (block: string) => text !== undefined && text.startsWith(block + PART_SEPARATOR);
  const kind = AGENT_KINDS.find((candidate) => opensWith(sharedSystemBlock(candidate)));
  const constant = kind === undefined ? undefined : sharedSystemBlock(kind);
  if (constant === undefined && (anchor < 0 || unsharedSystemBlocks().some(opensWith))) return unshared;
  const tail = constant === undefined ? '' : text!.slice(constant.length + PART_SEPARATOR.length);
  const miss = anchor < 0
    ? 'universal_tools_missing'
    : JSON.stringify(tools.slice(0, anchor + 1).map(withoutCacheControl)) !== renderedToolsJson()
      ? 'universal_tools_differ'
      : constant === undefined ? 'system_block_missing' : tail.length === 0 ? 'tenant_block_empty' : undefined;
  if (miss) {
    missed += 1;
    console.warn('[chickpea] platform-funded request went out without the shared prompt prefix', {
      model: payload.model,
      reason: miss,
    });
    return unshared;
  }
  const shape = shapeOf(tools.slice(anchor + 1));
  const sharedPrefix: SharedPrefixId | null = kind && shape ? `${kind}/${shape}` : null;
  const shared = {
    ...payload,
    tools: tools.map((tool, index) => index === anchor
      ? { ...(withoutCacheControl(tool) as Payload), cache_control: ONE_HOUR }
      : withoutCacheControl(tool)),
    system: [
      { type: 'text', text: constant, cache_control: sharedPrefix ? ONE_HOUR : FIVE_MINUTES },
      { type: 'text', text: tail, cache_control: FIVE_MINUTES },
    ],
    ...(Array.isArray(payload.messages) ? { messages: payload.messages.map(withFiveMinuteMarkers) } : {}),
  };
  return { payload: shared, sharedPrefix };
}

/** Whatever retention pi-ai chose: a 1-hour marker may not follow a 5-minute one. */
function withFiveMinuteMarkers(message: unknown): unknown {
  if (!isRecord(message) || !Array.isArray(message.content)) return message;
  return {
    ...message,
    content: message.content.map((block) => isRecord(block) && 'cache_control' in block
      ? { ...block, cache_control: FIVE_MINUTES }
      : block),
  };
}

type RenderedPrefix = {
  tools: Payload[];
  segments: Record<ShapeSegment, Payload[]>;
  models: Record<string, Payload>;
};

let toolsJson: string | undefined;
function renderedToolsJson(): string {
  toolsJson ??= JSON.stringify((rendered as RenderedPrefix).tools);
  return toolsJson;
}

function shapeTools(shape: SharedPrefixShape): Payload[] {
  return SHARED_PREFIX_SHAPES[shape].flatMap((segment) => (rendered as RenderedPrefix).segments[segment]);
}

let shapesByTools: ReadonlyMap<string, SharedPrefixShape> | undefined;
function shapeOf(afterAnchor: unknown[]): SharedPrefixShape | undefined {
  shapesByTools ??= new Map((Object.keys(SHARED_PREFIX_SHAPES) as SharedPrefixShape[])
    .map((shape) => [JSON.stringify(shapeTools(shape)), shape]));
  return shapesByTools.get(JSON.stringify(afterAnchor.map(withoutCacheControl)));
}

const PREWARM_TURN = 'Reply with one word.';

export interface SharedPrefixRequest {
  /** The ID a real request carrying this prefix reports to the platform charge. */
  id: SharedPrefixId;
  kind: AgentKind;
  shape: SharedPrefixShape;
  request: Payload;
}

/**
 * One request per Agent kind and warmed shape that writes or refreshes that
 * shared prefix on `model`. Its bytes are a rendered turn's, kept in
 * shared-prefix-tools.json, which the test pins to a fresh render.
 */
export function sharedPrefixRequests(model: string): SharedPrefixRequest[] {
  const { tools, models } = rendered as RenderedPrefix;
  const settings = models[model];
  if (!settings) throw new Error(`No shared prompt prefix is rendered for model ${model}.`);
  const universal = tools.map((tool, index) => index === tools.length - 1 ? { ...tool, cache_control: ONE_HOUR } : tool);
  return AGENT_KINDS.flatMap((kind) => WARMED_SHARED_PREFIX_SHAPES.map((shape) => ({
    id: `${kind}/${shape}` as const,
    kind,
    shape,
    request: {
      model,
      max_tokens: 0,
      ...settings,
      system: [{ type: 'text', text: sharedSystemBlock(kind), cache_control: ONE_HOUR }],
      tools: [...universal, ...shapeTools(shape)],
      messages: [{ role: 'user', content: [{ type: 'text', text: PREWARM_TURN }] }],
    },
  })));
}
