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

process.env.ANTHROPIC_API_KEY = 'render-only-not-a-key';
process.env.SLACK_STATE_DB_PATH = join(mkdtempSync(join(tmpdir(), 'render-slack-request-')), 'state.db');

const Anthropic = (await import('@anthropic-ai/sdk')).default as any;
const { createFlueContext, resolveModel } = await import('@flue/runtime/internal');
const { ChickpeaSlack } = await import('../../src/agents/slack-thread.ts');
const { compileRuntimePlanV2 } = await import('../../src/agents/runtime-plan.ts');
const { slackTenantInstructions } = await import('../../src/agents/shared-prefix.ts');
const { getConfigStore, getIdentityStore, getSettingsStore } = await import('../../src/config/state-backend.ts');
const { createChickpeaAgent } = await import('../../src/config/seed.ts');
const { serializeCurrentRequestEnvelope } = await import('../../src/memory/tool-policy.ts');
const { resolveRuntimeModel } = await import('../../src/config/runtime-model.ts');
const { configureModelAccessResolver, withModelAccess } = await import('../../src/config/model-access.ts');
const { configurePlatformFunding } = await import('../../src/config/platform-funding.ts');
const { configureInstallationAdmission } = await import('../../src/config/installation-admission.ts');
const { scopeInstallationEnv } = await import('../../src/config/installation-scope.ts');
const { NO_RUN_FEES } = await import('./platform-funding.ts');

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
}

export const USER_AGENT_ID = 'agent_brief_writer';

let captured: unknown;
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
  return { ...agent, model: `anthropic/${variant.model ?? 'claude-opus-5-5'}` };
}
const store: any = getConfigStore();
const identity: any = getIdentityStore();
store.getAgent = async () => currentAgent();
store.listConnectionAccounts = async () => [];
store.listAgentConnectionBindings = async () => [];
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
  charge: async () => {},
} as any);

/** Network requests the renders attempted; empty unless egress leaked. */
export function blockedNetworkCalls(): readonly string[] {
  return blockedUrls;
}

export async function renderSlackRequest(variant: SlackRequestVariant): Promise<RenderedRequest> {
  current = variant;
  captured = undefined;
  const agent = currentAgent();
  const runtime = await resolveRuntimeModel(agent.id, agent.model, { settings: getSettingsStore() } as any);
  const messageTs = (Number(variant.thread) + 0.0001).toFixed(6);
  const assignment = {
    workspaceId: variant.workspace, channelId: variant.channel, agentId: agent.id, agent, model: agent.model,
    modelAttribution: { source: 'workspace_default', providerId: 'anthropic', workspaceDefaultRevision: 1 },
  } as any;
  const turn = {
    workspaceId: variant.workspace, channelId: variant.channel, eventId: `E_${variant.thread}`, text: variant.text,
    userId: variant.user, actorMembershipId: 'member', messageTs, threadTs: variant.thread, source: 'app_mention',
    contextMode: 'thread',
  };
  const plan = compileRuntimePlanV2({
    turn, assignment, runtimeModel: runtime.model, instructions: slackTenantInstructions(assignment),
    memoryEpoch: 1, effectiveConnections: [],
  } as any);
  const context = createFlueContext({
    id: `render-${variant.workspace}-${variant.channel}-${variant.thread}`,
    agentName: 'chickpea-slack-v2', env: {}, agentConfig: { resolveModel } as any,
  });
  const body = serializeCurrentRequestEnvelope(variant.text, false, variant.user, messageTs, {
    schemaVersion: 2, progressiveStreamingOffered: variant.progressiveStreamingOffered ?? true,
  });
  const signal = {
    kind: 'signal', type: 'slack.message', tagName: 'slack_message', body,
    attributes: {
      workspaceId: variant.workspace, channelId: variant.channel, threadTs: variant.thread,
      slackUserId: variant.user, eventId: turn.eventId, messageTs, turnJobId: `job_${variant.thread}`,
    },
  } as any;
  const harness: any = await context.initializeRootHarness(ChickpeaSlack, signal, plan);
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
  return captured as RenderedRequest;
}
