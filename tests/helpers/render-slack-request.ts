/**
 * Render the exact Anthropic Messages request one Slack turn sends, through
 * the production ChickpeaSlack harness, model access and pi-ai, without
 * egress: the SDK's `messages.create` captures its params and throws, and
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
process.env.SLACK_STATE_DB_PATH = join(mkdtempSync(join(tmpdir(), 'render-slack-request-')), 'state.db');

const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
const { createFlueContext, resolveModel } = await import('@flue/runtime/internal');
const { useModel, useTool } = await import('@flue/runtime');
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
const { NO_RUN_FEES } = await import('./platform-funding.ts');
const { serializeThreadImageRecords } = await import('../../src/slack/thread-images.ts');

export type RenderedRequest = Record<string, any>;

export interface SlackRequestVariant {
  workspace: string;
  channel: string;
  thread: string;
  user: string;
  text: string;
  agentKind?: 'system' | 'user';
  model?: string;
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
}

export const USER_AGENT_ID = 'agent_brief_writer';

let captured: unknown;
let charged: { sharedPrefix: SharedPrefixId | null; requestId: string } | undefined;
const chargedRecords = new WeakMap<RenderedRequest, { sharedPrefix: SharedPrefixId | null; requestId: string }>();
const blockedUrls: string[] = [];
Anthropic.Messages.prototype.create = function (params: unknown) {
  captured = structuredClone(params);
  throw new Error('render only');
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
function currentAgent(): any {
  const variant = current!;
  const agent = variant.agentKind === 'user' ? userAgent : createChickpeaAgent();
  return { ...agent, model: `anthropic/${variant.model ?? 'claude-opus-5-5'}`, ...variant.agentOverrides };
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
configureModelAccessResolver({ resolve: async () => ({ apiKey: 'render-only-not-a-key' }) });
configurePlatformFunding({
  ...NO_RUN_FEES,
  funding: async () => current!.funding ?? 'platform',
  admit: async () => 'admitted',
  charge: async (record: { requestId: string }, sharedPrefix: SharedPrefixId | null) => {
    charged = { sharedPrefix, requestId: record.requestId };
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
  current = variant;
  captured = undefined;
  charged = undefined;
  const agent = currentAgent();
  const conversationKind = variant.conversationKind ?? 'channel';
  const messageTs = (Number(variant.thread) + 0.0001).toFixed(6);
  const assignment = {
    workspaceId: variant.workspace, channelId: variant.channel, agentId: agent.id, agent, model: agent.model,
    modelAttribution: { source: 'workspace_default', providerId: 'anthropic', workspaceDefaultRevision: 1 },
  } as any;
  const turn = {
    workspaceId: variant.workspace, channelId: variant.channel, eventId: `E_${variant.thread}`, text: variant.text,
    userId: variant.user, ...(variant.member === false ? {} : { actorMembershipId: 'member' }), messageTs,
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
        codingWorkspace: true,
      } as any)
    : decision.runtimePlan;
  const context = createFlueContext({
    id: `render-${variant.workspace}-${variant.channel}-${variant.thread}`,
    agentName: 'chickpea-slack-v2', env: {}, agentConfig: { resolveModel } as any,
  });
  const body = serializeCurrentRequestEnvelope(variant.text, false, variant.user, messageTs, {
    schemaVersion: 2, progressiveStreamingOffered: variant.progressiveStreamingOffered ?? true,
    ...(variant.progressiveStreamingMode ? { progressiveStreamingMode: variant.progressiveStreamingMode } : {}),
  });
  const attributes = {
    workspaceId: variant.workspace, channelId: variant.channel, threadTs: variant.thread, conversationKind,
    slackUserId: variant.user, eventId: turn.eventId, messageTs, turnJobId: `job_${variant.thread}`,
    ...(variant.threadImages ? { threadImages: serializeThreadImageRecords(variant.threadImages)! } : {}),
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
    installationId: `inst_${variant.workspace}`, providerId: 'anthropic', runId: `run_${variant.thread}`,
    fundingSource: variant.funding ?? 'platform', credentialRefId: 'platform:anthropic', credentialVersion: 1,
  } as any;
  const env = scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' }, { installationId: grant.installationId }) as any;
  try {
    await withModelAccess(grant, env, 'reply', () => harness.prompt(body));
  } catch (error) {
    if (!captured) throw error;
  }
  if (!captured) throw new Error('No Anthropic request was captured.');
  if (charged !== undefined) chargedRecords.set(captured as RenderedRequest, charged);
  return captured as RenderedRequest;
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
  model = 'chickpea-anthropic-api-bundled-v1/claude-opus-5-5',
): Promise<RenderedRequest['tools']> {
  toolsOnly = { model, tools };
  captured = undefined;
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
  if (!captured) throw new Error('No Anthropic request was captured.');
  return (captured as RenderedRequest).tools;
}
