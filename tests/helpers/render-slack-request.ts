/**
 * Render the exact Anthropic Messages or OpenAI Responses request one Slack
 * turn sends, through the production ChickpeaSlack harness, model access and
 * pi-ai, without egress: the SDK method pi-ai sends every such request
 * through (`beta.messages.create`, `responses.create`) captures its params and
 * answers with the next scripted reply, or throws when none is left, and
 * `fetch` refuses. Import this module before any `src/` module: it scopes the
 * process's state database and provider key first.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SharedPrefixId } from '../../src/agents/shared-prefix.ts';
import type { ThreadImageRecord } from '../../src/slack/thread-images.ts';

process.env.ANTHROPIC_API_KEY = 'render-only-not-a-key';
process.env.OPENAI_API_KEY = 'render-only-not-a-key';
// Chickpea Cloud, whose turns share the prompt prefix, has a search key.
process.env.EXA_API_KEY = 'render-only-not-a-key';
process.env.SLACK_STATE_DB_PATH = join(mkdtempSync(join(tmpdir(), 'render-slack-request-')), 'state.db');

const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
const OpenAI = (await import('openai')).default as any;
const { createFlueContext, resolveModel } = await import('@flue/runtime/internal');
const { observe, useModel, useTool } = await import('@flue/runtime');
const { ChickpeaSlack } = await import('../../src/agents/slack-thread.ts');
const { freezeRuntimePlanForTurn } = await import('../../src/slack/run-turn.ts');
const { compileRuntimePlanV2 } = await import('../../src/agents/runtime-plan.ts');
const { FILE_DELIVERY_SIGNAL_TAG, FILE_DELIVERY_SIGNAL_TYPE } = await import('../../src/slack/file-delivery-completion.ts');
const { getConfigStore, getIdentityStore, getSettingsStore } = await import('../../src/config/state-backend.ts');
const { createChickpeaAgent } = await import('../../src/config/seed.ts');
const { serializeCurrentRequestEnvelope } = await import('../../src/memory/tool-policy.ts');
const { configureModelAccessResolver, withModelAccess } = await import('../../src/config/model-access.ts');
const { configurePlatformFunding } = await import('../../src/config/platform-funding.ts');
const { configureInstallationAdmission } = await import('../../src/config/installation-admission.ts');
const { scopeInstallationEnv } = await import('../../src/config/installation-scope.ts');
const { EVERY_PROVIDER_FUNDED, NO_RUN_FEES } = await import('./platform-funding.ts');
const { serializeThreadImageRecords } = await import('../../src/slack/thread-images.ts');
const { noteAgentAuthoringActivation } = await import('../../src/management/workspace-change-tools.ts');

export type RenderedRequest = Record<string, any>;

export interface SlackRequestVariant {
  workspace: string;
  channel: string;
  thread: string;
  user: string;
  text: string;
  agentKind?: 'system' | 'user';
  /** The Agent's model provider: Anthropic Messages, or OpenAI Responses. */
  provider?: 'anthropic' | 'openai';
  model?: string;
  /** The endpoint model access resolves, as a standalone deployment's base URL override sets it. */
  baseUrl?: string;
  funding?: 'platform' | 'customer';
  progressiveStreamingOffered?: boolean;
  progressiveStreamingMode?: 'early' | 'final_answer';
  conversationKind?: 'channel' | 'im' | 'mpim';
  /** False renders a requester with no workspace membership. */
  member?: boolean;
  /** The delivery the render answers: the Slack message, or the file-delivery check appended after it. */
  delivery?: 'message' | 'file_delivery_check';
  imageModel?: string;
  /** Saved Agent fields over the fixture Agent, for example repositories. */
  agentOverrides?: Record<string, unknown>;
  /** The workspace's connection accounts and this Agent's bindings to them. */
  connections?: { accounts: unknown[]; bindings: unknown[] };
  /** Images already in the thread, as the host hands them to the dispatch. */
  threadImages?: ThreadImageRecord[];
  /**
   * The plan has a coding workspace and the Agent renders as the Worker build
   * does. Only the Cloudflare target compiles or mounts one.
   */
  codingWorkspace?: true;
  /** The system Agent's root DM turn with these Agents on its front desk. */
  frontDesk?: import('../../src/config/types.ts').FrontDeskDirectory;
  /** More host attributes on every turn's Slack signal, such as the change-tools signal. */
  signalAttributes?: Record<string, string>;
  /** Deployment variables in the env model access is bound with. */
  vars?: Record<string, string>;
}

export const USER_AGENT_ID = 'agent_brief_writer';

/**
 * What the model answers one request with: a tool call, which the turn runs,
 * or a final text. Anthropic only: `thinkingSignature` opens the reply with a
 * thinking block of no text and that signature, as display `omitted` sends it.
 */
export type ScriptedReply = (
  | { toolCall: { name: string; input: Record<string, unknown> } }
  | { text: string }
) & { thinkingSignature?: string };

let captured: RenderedRequest | undefined;
let charged: { sharedPrefix: SharedPrefixId | null; requestId: string } | undefined;
const chargedRecords = new WeakMap<RenderedRequest, { sharedPrefix: SharedPrefixId | null; requestId: string }>();
const blockedUrls: string[] = [];
let replies: ScriptedReply[] = [];
let sent: RenderedRequest[] = [];

/** Capture a request's params; answer with the next scripted reply, or refuse it when none is left. */
function answer(params: unknown): ScriptedReply {
  captured = structuredClone(params) as RenderedRequest;
  sent.push(captured);
  const reply = replies.shift();
  if (!reply) throw new Error('render only');
  return reply;
}

Anthropic.Beta.Messages.prototype.create = function (params: { model: string }) {
  const reply = answer(params);
  const id = `toolu_render_${sent.length}`;
  const index = reply.thinkingSignature ? 1 : 0;
  const thinking = reply.thinkingSignature
    ? [
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: reply.thinkingSignature } },
        { type: 'content_block_stop', index: 0 },
      ]
    : [];
  const content = 'text' in reply
    ? [
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: reply.text } },
      ]
    : [
        { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: reply.toolCall.name, input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.toolCall.input) } },
      ];
  const events = [
    { type: 'message_start', message: { id: `msg_render_${sent.length}`, model: params.model, usage: { input_tokens: 1, output_tokens: 0 } } },
    ...thinking,
    ...content,
    { type: 'content_block_stop', index },
    { type: 'message_delta', delta: { stop_reason: 'text' in reply ? 'end_turn' : 'tool_use' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return { asResponse: async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }) };
};

OpenAI.Responses.prototype.create = function (params: unknown) {
  const reply = answer(params);
  const item = 'text' in reply
    ? { type: 'message', id: `msg_render_${sent.length}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: reply.text, annotations: [] }] }
    : {
        type: 'function_call', id: `fc_render_${sent.length}`, call_id: `call_render_${sent.length}`, status: 'completed',
        name: reply.toolCall.name, arguments: JSON.stringify(reply.toolCall.input),
      };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, ...('arguments' in item ? { arguments: '' } : { content: [] }) } },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: { id: `resp_render_${sent.length}`, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    },
  ];
  async function* stream() { yield* events; }
  return { withResponse: async () => ({ data: stream(), response: new Response(null, { status: 200 }) }) };
};
globalThis.fetch = (async (url: unknown) => {
  blockedUrls.push(String(url));
  throw new Error('network blocked in render');
}) as typeof fetch;

let current: SlackRequestVariant | undefined;
const userAgent = {
  id: USER_AGENT_ID, kind: 'user', revision: 1, name: 'Brief Writer',
  instructions: 'You write one-page briefs for the sales team.', enabled: true, lifecycle: 'active',
  editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [], repositories: [],
};
const DEFAULT_MODELS = { anthropic: 'claude-opus-5-5', openai: 'gpt-5.6-terra' } as const;
function providerOf(variant: SlackRequestVariant): 'anthropic' | 'openai' {
  return variant.provider ?? 'anthropic';
}
function currentAgent(): any {
  const variant = current!;
  const agent = variant.agentKind === 'user' ? userAgent : createChickpeaAgent();
  const provider = providerOf(variant);
  return { ...agent, model: `${provider}/${variant.model ?? DEFAULT_MODELS[provider]}`, ...variant.agentOverrides };
}
const store: any = getConfigStore();
const identity: any = getIdentityStore();
store.getAgent = async () => currentAgent();
store.listConnectionAccounts = async () => current!.connections?.accounts ?? [];
store.listAgentConnectionBindings = async () => current!.connections?.bindings ?? [];
store.getWorkspaceModelRole = async (workspaceId: string, role: string) => role === 'image' && current!.imageModel
  ? { workspaceId, role, modelId: current!.imageModel, revision: 1, createdAt: 0, updatedAt: 0 }
  : undefined;
identity.getOrganization = async () => ({ id: 'org', slackTeamId: current!.workspace });
identity.getMembership = async () => ({ id: 'member', organizationId: 'org', status: 'active', userId: 'user' });
identity.getMembershipAccessOverlay = async () => undefined;
identity.getUser = async () => ({ id: 'user', slackTeamId: current!.workspace, slackUserId: current!.user });
identity.resolveSlackIdentity = async () => ({ user: { id: 'user' }, membership: { id: 'member' }, binding: { membershipId: 'member' } });
configureInstallationAdmission(async () => 'admitted');
// As app.ts observes a Slack turn's tool calls.
observe((event, context) => {
  if (context.agentName === 'chickpea-slack-v2') noteAgentAuthoringActivation(event);
});
// pi-ai sends a key without `sk-` on OpenAI's endpoint as a ChatGPT sign-in, which drops request fields.
configureModelAccessResolver({
  resolve: async () => ({
    apiKey: current?.provider === 'openai' ? 'sk-render-only-not-a-key' : 'render-only-not-a-key',
    ...(current?.baseUrl ? { baseUrl: current.baseUrl } : {}),
  }),
});
configurePlatformFunding({
  ...EVERY_PROVIDER_FUNDED,
  ...NO_RUN_FEES,
  funding: async () => current!.funding ?? 'platform',
  admit: async () => 'admitted',
  charge: async (record: { requestId: string }, sharedPrefix: SharedPrefixId | null) => {
    charged = { sharedPrefix, requestId: record.requestId };
    // Each request settles its charge before the next one goes out.
    if (captured) chargedRecords.set(captured, charged);
  },
} as any);

/**
 * `agent` with the Cloudflare target on while its function runs, so it mounts
 * what the Worker build mounts. Work outside the function (sandbox, model
 * access) stays on Node, and so does the staged turn input, which only the
 * agent's Durable Object can read: the render runs its creation plan.
 */
function renderedOnWorker<T extends (...args: any[]) => unknown>(agent: T): T {
  const onWorker = ((...args: any[]) => {
    const node = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const nodeNavigator = node?.get ? node.get.call(globalThis) : node?.value;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      get: () => new Error().stack?.includes('readStagedSlackTurnInput') ? nodeNavigator : { userAgent: 'Cloudflare-Workers' },
    });
    try {
      return agent(...args);
    } finally {
      if (node) Object.defineProperty(globalThis, 'navigator', node);
      else Reflect.deleteProperty(globalThis, 'navigator');
    }
  }) as T;
  return Object.assign(onWorker, agent);
}

/** Network requests the renders attempted; empty unless egress leaked. */
export function blockedNetworkCalls(): readonly string[] {
  return blockedUrls;
}

export function chargedSharedPrefix(request: RenderedRequest): SharedPrefixId | null {
  return chargedRecord(request).sharedPrefix;
}

/** The request ID the render's charge carried: the key its ledger row is written under. */
export function chargedRequestId(request: RenderedRequest): string {
  return chargedRecord(request).requestId;
}

function chargedRecord(request: RenderedRequest) {
  const record = chargedRecords.get(request);
  if (record === undefined) throw new Error('The render was not charged to the platform.');
  return record;
}

export async function renderSlackRequest(variant: SlackRequestVariant): Promise<RenderedRequest> {
  const [requests] = await renderSlackThread(variant, [{ text: variant.text, replies: [] }]);
  return requests![0]!;
}

/** One message in a thread and what the model answers each of the turn's requests with, in order. */
export interface SlackThreadTurn {
  text: string;
  replies: readonly ScriptedReply[];
  /** This turn's Slack signal attributes, in place of the variant's. */
  signalAttributes?: Record<string, string>;
}

/**
 * Every request each turn of one Slack thread sends: the same agent instance,
 * transcript and persistent state from turn to turn. A turn ends at its final
 * text reply, or at the request after its last reply, which is refused. The
 * render prompts the harness directly, which runs no `useAgentFinish` hook: a
 * delivered submission does.
 */
export async function renderSlackThread(
  variant: SlackRequestVariant,
  turns: readonly SlackThreadTurn[],
): Promise<RenderedRequest[][]> {
  current = variant;
  const context = createFlueContext({
    id: `render-${variant.workspace}-${variant.channel}-${variant.thread}`,
    agentName: 'chickpea-slack-v2', env: {}, agentConfig: { resolveModel } as any,
  });
  const rendered: RenderedRequest[][] = [];
  for (const [index, turn] of turns.entries()) {
    rendered.push(await renderSlackTurn(context, {
      ...variant, text: turn.text, ...(turn.signalAttributes ? { signalAttributes: turn.signalAttributes } : {}),
    }, index, turn.replies));
  }
  return rendered;
}

async function renderSlackTurn(
  context: any,
  variant: SlackRequestVariant,
  index: number,
  scripted: readonly ScriptedReply[],
): Promise<RenderedRequest[]> {
  current = variant;
  captured = undefined;
  charged = undefined;
  replies = [...scripted];
  sent = [];
  const agent = currentAgent();
  const provider = providerOf(variant);
  const conversationKind = variant.conversationKind ?? 'channel';
  // A front-desk turn is the root of its DM thread.
  const messageTs = variant.frontDesk && index === 0
    ? variant.thread
    : (Number(variant.thread) + 0.0001 * (index + 1)).toFixed(6);
  const assignment = {
    workspaceId: variant.workspace, channelId: variant.channel, agentId: agent.id, agent, model: agent.model,
    modelAttribution: { source: 'workspace_default', providerId: provider, workspaceDefaultRevision: 1 },
    ...(variant.frontDesk ? { runtimeContract: 'chickpea-v1', frontDesk: variant.frontDesk } : {}),
  } as any;
  const turn = {
    workspaceId: variant.workspace, channelId: variant.channel, eventId: `E_${variant.thread}${index ? `_${index}` : ''}`,
    text: variant.text, userId: variant.user, ...(variant.member === false ? {} : { actorMembershipId: 'member' }), messageTs,
    threadTs: variant.thread, contextMode: 'thread',
    ...(conversationKind === 'channel' ? { source: 'app_mention' } : { source: 'dm_message', channelType: conversationKind }),
  };
  const { decision } = await freezeRuntimePlanForTurn({
    turn, assignment, platformEnv: undefined, settingsStore: getSettingsStore(), memoryEpoch: Promise.resolve(1),
  } as any);
  const plan = variant.codingWorkspace
    ? compileRuntimePlanV2({
        turn, assignment, instructions: decision.runtimePlan.instructions, memoryEpoch: decision.runtimePlan.memoryEpoch,
        runtimeModel: decision.runtimePlan.runtimeModel,
        ...(decision.runtimePlan.runtimeModelRoute ? { runtimeModelRoute: decision.runtimePlan.runtimeModelRoute } : {}),
        ...(decision.runtimePlan.imageCapability ? { imageCapability: decision.runtimePlan.imageCapability } : {}),
        ...(decision.runtimePlan.webSearch ? { webSearch: true } : {}),
        codingWorkspace: true,
      } as any)
    : decision.runtimePlan;
  const body = serializeCurrentRequestEnvelope(variant.text, false, variant.user, messageTs, {
    schemaVersion: 2, progressiveStreamingOffered: variant.progressiveStreamingOffered ?? true,
    ...(variant.progressiveStreamingMode ? { progressiveStreamingMode: variant.progressiveStreamingMode } : {}),
  });
  const attributes = {
    workspaceId: variant.workspace, channelId: variant.channel, threadTs: variant.thread, conversationKind,
    slackUserId: variant.user, eventId: turn.eventId, messageTs, turnJobId: `job_${variant.thread}${index ? `_${index}` : ''}`,
    ...(variant.threadImages ? { threadImages: serializeThreadImageRecords(variant.threadImages)! } : {}),
    ...variant.signalAttributes,
  };
  const signal = variant.delivery === 'file_delivery_check'
    ? {
        kind: 'signal', type: FILE_DELIVERY_SIGNAL_TYPE, tagName: FILE_DELIVERY_SIGNAL_TAG, body,
        attributes: { ...attributes, boundThreadTs: variant.thread, originalType: 'slack.message' },
      }
    : { kind: 'signal', type: 'slack.message', tagName: 'slack_message', body, attributes };
  const harness: any = await context.initializeRootHarness(
    variant.codingWorkspace ? renderedOnWorker(ChickpeaSlack) : ChickpeaSlack, signal as any, plan);
  const grant = {
    installationId: `inst_${variant.workspace}`, providerId: provider, runId: `run_${variant.thread}_${index}`,
    fundingSource: variant.funding ?? 'platform', credentialRefId: `platform:${provider}`, credentialVersion: 1,
  } as any;
  const env = scopeInstallationEnv(
    { CHICKPEA_TENANCY: 'installation', ...variant.vars }, { installationId: grant.installationId },
  ) as any;
  try {
    await withModelAccess(grant, env, 'reply', () => harness.prompt(body));
  } catch (error) {
    if (!captured) throw error;
  }
  if (!captured) throw new Error('No provider request was captured.');
  if (replies.length > 0) throw new Error(`The turn ended with ${replies.length} scripted replies unsent.`);
  return sent;
}

let toolsOnly: { model: string; tools: readonly unknown[] } | undefined;
function ToolsOnly() {
  useModel(toolsOnly!.model);
  for (const tool of toolsOnly!.tools) useTool(tool as never);
  return 'Render tools.';
}

/**
 * The request tools that `tools` render to, through the same Flue and pi-ai
 * path a Slack turn takes. For tools a Node render never mounts, such as the
 * coding-workspace tools, which need the Cloudflare target.
 */
export async function renderToolPayloads(
  tools: readonly unknown[],
  model = 'anthropic/claude-opus-5-5',
): Promise<RenderedRequest['tools']> {
  toolsOnly = { model, tools };
  captured = undefined;
  replies = [];
  sent = [];
  const context = createFlueContext({
    id: `render-tools-${blockedUrls.length}-${Date.now()}`, agentName: 'render-tools', env: {}, agentConfig: { resolveModel } as any,
  });
  const harness: any = await context.initializeRootHarness(ToolsOnly as any, { kind: 'user', body: 'Render tools.' }, {});
  const grant = {
    installationId: 'inst_render_tools', providerId: 'anthropic', runId: 'run_render_tools',
    fundingSource: 'customer', credentialRefId: 'platform:anthropic', credentialVersion: 1,
  } as any;
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: grant.installationId }) as any;
  try {
    await withModelAccess(grant, env, 'reply', () => harness.prompt('Render tools.'));
  } catch (error) {
    if (!captured) throw error;
  }
  const request = captured as RenderedRequest | undefined;
  if (!request) throw new Error('No Anthropic request was captured.');
  return request.tools;
}
