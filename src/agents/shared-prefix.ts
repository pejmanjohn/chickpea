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
 *
 * This module reads the rendered tools. The Worker loads it on that hook's
 * first use, and the hosted prewarm imports it. A turn takes its text and
 * tool order from shared-prefix-layout.ts, and
 * tests/worker-startup-imports.test.ts keeps this module out of the
 * Worker's startup imports.
 */
import type { AgentKind } from '../config/types.ts';
import {
  AGENT_KINDS,
  PART_SEPARATOR,
  SHARED_PREFIX_LAST_TOOL,
  reducedSystemBlocks,
  sharedSystemBlock,
} from './shared-prefix-layout.ts';
import rendered from './shared-prefix-tools.json' with { type: 'json' };

/**
 * The capability tools a turn may mount after breakpoint A, in mount order.
 * `management` is the workspace change tools, which a thread mounts from
 * the turn after its model activates agent-authoring.
 */
const SHAPE_SEGMENTS = ['interactive', 'streaming', 'management', 'coding', 'image', 'front_desk'] as const;
type ShapeSegment = (typeof SHAPE_SEGMENTS)[number];

/** Every non-empty ordered selection of `Segments`, joined with underscores. */
type Joined<Segments extends readonly string[]> = Segments extends readonly [infer Head extends string, ...infer Rest extends string[]]
  ? Head | `${Head}_${Joined<Rest>}` | Joined<Rest>
  : never;
export type SharedPrefixShape = 'bare' | Joined<typeof SHAPE_SEGMENTS>;

function buildShapes(): Readonly<Record<SharedPrefixShape, readonly ShapeSegment[]>> {
  const selections = SHAPE_SEGMENTS.reduce<ShapeSegment[][]>((chosen, segment) =>
    [...chosen, ...chosen.map((selection) => [...selection, segment])], [[]]);
  const shapes = {} as Record<SharedPrefixShape, readonly ShapeSegment[]>;
  for (const segments of selections) shapes[(segments.join('_') || 'bare') as SharedPrefixShape] = segments;
  return shapes;
}

/** Each shape's segments: every ordered selection of SHAPE_SEGMENTS, `bare` for none. */
export const SHARED_PREFIX_SHAPES = buildShapes();

/** One shared prefix on a model: an Agent kind's constant block after one shape's tools. */
export type SharedPrefixId = `${AgentKind}/${SharedPrefixShape}`;

/**
 * Channel and DM turns mount the interactive tools, so these are the shapes
 * worth warming. Management, coding and front-desk shapes are not warmed:
 * their first request writes the prefix and later ones, in any workspace,
 * read it. Only the system kind ever mounts the front desk, and warming any
 * of them would double the warmed set.
 */
export type WarmedSharedPrefixShape = Exclude<
  Extract<SharedPrefixShape, 'interactive' | `interactive_${string}`>,
  `${string}management${string}` | `${string}coding${string}` | `${string}front_desk${string}`
>;

const UNWARMED_SEGMENTS: readonly ShapeSegment[] = ['management', 'coding', 'front_desk'];

export const WARMED_SHARED_PREFIX_SHAPES = (Object.keys(SHARED_PREFIX_SHAPES) as SharedPrefixShape[])
  .filter((shape): shape is WarmedSharedPrefixShape =>
    SHARED_PREFIX_SHAPES[shape].includes('interactive') &&
    !UNWARMED_SEGMENTS.some((segment) => SHARED_PREFIX_SHAPES[shape].includes(segment)));

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
 * a miss. A turn with fewer tools goes out as built and is logged by
 * `requestId`, the key its charge carries, so its cold write is attributable.
 */
export function sharePromptPrefix(payload: Payload, requestId: string): SharedPrefixDecision {
  const unshared = { payload, sharedPrefix: null };
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const anchor = tools.findIndex((tool) => isRecord(tool) && tool.name === SHARED_PREFIX_LAST_TOOL);
  const text = singleSystemText(payload);
  const opensWith = (block: string) => text !== undefined && text.startsWith(block + PART_SEPARATOR);
  const kind = AGENT_KINDS.find((candidate) => opensWith(sharedSystemBlock(candidate)));
  const constant = kind === undefined ? undefined : sharedSystemBlock(kind);
  const reduced = constant === undefined ? reducedSystemBlocks().find(([block]) => opensWith(block))?.[1] : undefined;
  if (reduced) {
    console.info('[chickpea] platform-funded Slack turn sent a reduced tool list without the shared prompt prefix', {
      model: payload.model, reason: reduced, requestId,
    });
    return unshared;
  }
  if (constant === undefined && anchor < 0) return unshared;
  const tail = constant === undefined ? '' : text!.slice(constant.length + PART_SEPARATOR.length);
  const universal = tools.slice(0, anchor + 1).map(withoutCacheControl);
  const miss = anchor < 0
    ? 'universal_tools_missing'
    : JSON.stringify(universal) !== renderedToolsJson()
      ? 'universal_tools_differ'
      : constant === undefined ? 'system_block_missing' : tail.length === 0 ? 'tenant_block_empty' : undefined;
  if (miss) {
    missed += 1;
    console.warn('[chickpea] platform-funded request went out without the shared prompt prefix', {
      model: payload.model,
      reason: miss,
      ...(miss === 'universal_tools_differ' ? { tool: firstDifferingTool(universal) } : {}),
      requestId,
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
  /** Tools pi-ai appends after every mounted tool on some models, such as its deferred-loading placeholder. */
  trailer: Payload[];
  /** Each model's request settings as pi-ai passes them to the SDK, `betas` included. */
  models: Record<string, Payload & { betas?: string[] }>;
};

let toolsJson: string | undefined;
function renderedToolsJson(): string {
  toolsJson ??= JSON.stringify((rendered as RenderedPrefix).tools);
  return toolsJson;
}

/** The name of the first universal tool whose definition is not the rendered one's. */
function firstDifferingTool(universal: unknown[]): string {
  const expected = (rendered as RenderedPrefix).tools;
  const index = universal.findIndex((tool, at) => JSON.stringify(tool) !== JSON.stringify(expected[at]));
  // Every sent tool matched: the render has one the request lacks.
  const tool = index < 0 ? expected[universal.length] : universal[index];
  return isRecord(tool) && typeof tool.name === 'string' ? tool.name : 'unknown';
}

function shapeTools(shape: SharedPrefixShape): Payload[] {
  return SHARED_PREFIX_SHAPES[shape].flatMap((segment) => (rendered as RenderedPrefix).segments[segment]);
}

let shapesByTools: ReadonlyMap<string, SharedPrefixShape> | undefined;
/** The shape of the tools after the anchor, whether or not pi-ai appended its trailer to them. */
function shapeOf(afterAnchor: unknown[]): SharedPrefixShape | undefined {
  shapesByTools ??= new Map((Object.keys(SHARED_PREFIX_SHAPES) as SharedPrefixShape[])
    .map((shape) => [JSON.stringify(shapeTools(shape)), shape]));
  const { trailer } = rendered as RenderedPrefix;
  const tools = afterAnchor.map(withoutCacheControl);
  const mounted = trailer.length > 0 && JSON.stringify(tools.slice(-trailer.length)) === JSON.stringify(trailer)
    ? tools.slice(0, -trailer.length)
    : tools;
  return shapesByTools.get(JSON.stringify(mounted));
}

const PREWARM_TURN = 'Reply with one word.';

/**
 * A prewarm as the Anthropic SDK sends it: POST `body` as JSON to
 * `/v1/messages?beta=true`, with `betas` joined by commas as the
 * `anthropic-beta` header when it is not empty.
 */
export interface SharedPrefixRequest {
  /** The ID a real request carrying this prefix reports to the platform charge. */
  id: SharedPrefixId;
  kind: AgentKind;
  shape: SharedPrefixShape;
  betas: readonly string[];
  /** The JSON body, without `betas`, which the API refuses in the body. */
  body: Payload;
}

/**
 * One request per Agent kind and warmed shape that writes or refreshes that
 * shared prefix on `model`. Its bytes are a rendered turn's, kept in
 * shared-prefix-tools.json, which the test pins to a fresh render.
 */
export function sharedPrefixRequests(model: string): SharedPrefixRequest[] {
  const { tools, trailer, models } = rendered as RenderedPrefix;
  const settings = models[model];
  if (!settings) throw new Error(`No shared prompt prefix is rendered for model ${model}.`);
  const { betas = [], ...bodySettings } = settings;
  const universal = tools.map((tool, index) => index === tools.length - 1 ? { ...tool, cache_control: ONE_HOUR } : tool);
  return AGENT_KINDS.flatMap((kind) => WARMED_SHARED_PREFIX_SHAPES.map((shape) => ({
    id: `${kind}/${shape}` as const,
    kind,
    shape,
    betas,
    body: {
      model,
      max_tokens: 0,
      ...bodySettings,
      system: [{ type: 'text', text: sharedSystemBlock(kind), cache_control: ONE_HOUR }],
      tools: [...universal, ...shapeTools(shape), ...trailer],
      messages: [{ role: 'user', content: [{ type: 'text', text: PREWARM_TURN }] }],
    },
  })));
}
