/**
 * A workspace whose Agent holds one connection of each kind, each able to
 * write: an API connection allowing GET and POST, an MCP server with a tool
 * declared a read, one declared a write and one undeclared, and a connector
 * with a read and a write capability. Its run plan parts turn on every other
 * capability too, so a test run's plan shows what it narrowed away.
 */
import type { AgentRunPlanParts } from '../../src/agents/run-plan-resolution.ts';
import type { RuntimePlanV2 } from '../../src/agents/runtime-plan.ts';
import type { InstallationOwnership } from '../../src/config/installation-scope.ts';
import {
  closeNodeStateStores,
  getConfigStore,
  getIdentityStore,
} from '../../src/config/state-backend.ts';
import type { CustomAgentConfig, ResolvedAssignment } from '../../src/config/types.ts';
import { resolveEffectiveConnectionAccounts } from '../../src/connections/runtime.ts';
import type { NormalizedSlackTurn } from '../../src/slack/types.ts';
import { createSlackOwner } from './slack-owner.ts';

export const WORKSPACE = 'T0TESTRUN';
export const SLACK_USER = 'U0TESTRUN';
export const MODEL = 'faux/test-run';
export const API_ACCOUNT = 'connection_test_api';
export const MCP_ACCOUNT = 'connection_test_mcp';
export const MANAGED_ACCOUNT = 'connection_test_gmail';
/** A public address, so the MCP guard needs no DNS answer. */
export const MCP_URL = 'https://203.0.114.10/mcp';
export const MCP_TOOLS = { read: 'lookup_order', write: 'refund_order', undeclared: 'list_notes' } as const;
export const MANAGED_READ = 'gmail.messages.search';
export const MANAGED_WRITE = 'gmail.messages.send';
export const INSTALLATION: InstallationOwnership = { version: 1, installationId: 'inst_test_run' };

export const AGENT: CustomAgentConfig = {
  id: 'agent_test_run', kind: 'user', revision: 1, name: 'Orders', instructions: 'Answer questions about orders.',
  enabled: true, model: MODEL, lifecycle: 'active',
  skills: [{ name: 'refund-policy', description: 'The refund policy.', instructions: 'Refunds within 30 days.', enabled: true }],
  mcpServers: [], apiConnections: [],
  repositories: [{ id: 'repo_orders', installationId: 1, accountLogin: 'acme', fullName: 'acme/orders', enabled: true }],
};

export interface TestRunLane {
  actorMembershipId: string;
  /** Every capability a plan can freeze, with the Agent's three connections as its member's DM resolves them. */
  parts(): Promise<AgentRunPlanParts>;
  /** A DM from the member, for the Slack plan the same parts compile to. */
  turn: NormalizedSlackTurn;
}

const STORE_ENV = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
const SCRUBBED_ENV = ['CHICKPEA_TENANCY', 'EXA_API_KEY', 'BROWSERBASE_API_KEY'] as const;

export async function withTestRunLane<T>(scenario: (lane: TestRunLane) => Promise<T>): Promise<T> {
  const saved = new Map([...STORE_ENV, ...SCRUBBED_ENV].map((key) => [key, process.env[key]]));
  for (const key of SCRUBBED_ENV) delete process.env[key];
  for (const key of STORE_ENV) process.env[key] = ':memory:';
  closeNodeStateStores();
  try {
    const owner = await createSlackOwner(getIdentityStore(), { teamId: WORKSPACE, userId: SLACK_USER, suffix: 'test_run' });
    const actorMembershipId = owner.membership.id;
    await seed(actorMembershipId);
    return await scenario({
      actorMembershipId,
      parts: async () => maxParts(actorMembershipId),
      turn: {
        workspaceId: WORKSPACE, channelId: 'D0TESTRUN', eventId: 'Ev_test_run', text: 'Where is order 42?',
        userId: SLACK_USER, actorMembershipId, messageTs: '1793440000.000100', threadTs: '1793440000.000100',
        contextMode: 'thread', source: 'dm_message', channelType: 'im',
      },
    });
  } finally {
    closeNodeStateStores();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function seed(actorMembershipId: string): Promise<void> {
  const config = getConfigStore();
  await config.createAgent(AGENT);
  const accounts = [
    {
      id: API_ACCOUNT, providerId: 'orders-api', label: 'Orders API',
      policy: {
        kind: 'api' as const, allowedHosts: ['api.orders.example'], pathPrefixes: ['/v1/'], headerName: 'Authorization',
        allowedMethods: ['GET', 'POST'], authMode: 'credential' as const,
      },
    },
    {
      id: MCP_ACCOUNT, providerId: 'orders-mcp', label: 'Orders MCP',
      policy: {
        kind: 'mcp' as const, url: MCP_URL, transport: 'streamable-http' as const, authMode: 'none' as const,
        headerNames: [], discoveredTools: Object.values(MCP_TOOLS).map((name) => ({ name })),
        toolPolicies: { [MCP_TOOLS.read]: { effect: 'read' as const }, [MCP_TOOLS.write]: { effect: 'write' as const } },
        allowedTools: Object.values(MCP_TOOLS),
      },
    },
    {
      id: MANAGED_ACCOUNT, providerId: 'gmail', label: 'Gmail',
      policy: {
        kind: 'managed' as const, adapterId: 'composio', toolkit: 'gmail', principalRef: 'principal_test_run',
        accountRef: 'ca_test_run', allowedCapabilities: [MANAGED_READ, MANAGED_WRITE],
      },
    },
  ];
  for (const account of accounts) {
    await config.putConnectionAccount({
      ...account, workspaceId: WORKSPACE, ownerKind: 'team', createdByMembershipId: actorMembershipId,
      secretRefId: `secret_${account.id}`, lifecycle: 'ready',
    } as never, 0);
    await config.putAgentConnectionBinding({
      agentId: AGENT.id, connectionAccountId: account.id, providerId: account.providerId,
      // A managed binding names its own ceiling.
      allowedCapabilities: account.policy.kind === 'managed' ? account.policy.allowedCapabilities : [], enabled: true,
    });
  }
}

async function maxParts(actorMembershipId: string): Promise<AgentRunPlanParts> {
  const assignment: ResolvedAssignment = {
    workspaceId: WORKSPACE, channelId: 'D0TESTRUN', agentId: AGENT.id, agent: AGENT, model: MODEL, effort: 'high',
    modelAttribution: { source: 'workspace_default', providerId: 'faux', workspaceDefaultRevision: 1 },
    modelCredential: {
      credentialRefId: 'cred_faux', version: 3, providerId: 'faux', sourceKind: 'stored', label: 'Faux key',
      scopeLabel: null, unknownRotation: false,
    },
    ownerIncarnation: 2, channelRevision: 4, threadGuest: true,
    handoffContext: [{ messageTs: '1793430000.000100', role: 'human', text: 'Earlier ask.' }],
  };
  return {
    assignment,
    runtimeModel: MODEL,
    imageCapability: { role: 'image', filled: true, acceptsImageInput: true },
    codingWorkspace: {
      codingModel: {
        model: MODEL, runtimeModel: MODEL,
        attribution: { role: 'coding', source: 'agent_model', providerId: 'faux', fallback: false },
      },
    },
    sandboxUnavailableFallback: false,
    browserCapability: { provider: 'browserbase' },
    websiteLogins: [{ id: `wl_${'a'.repeat(32)}`, host: 'portal.orders.example', label: 'Portal', level: 'act', method: 'handoff' }],
    webSearch: true,
    connections: await resolveEffectiveConnectionAccounts({
      config: getConfigStore(), workspaceId: WORKSPACE, agentId: AGENT.id, actorMembershipId,
    }),
    connectionAuthorizations: [{
      providerId: 'sentry', templateAccountId: 'connection_sentry_template',
      policy: {
        kind: 'api', allowedHosts: ['sentry.io'], pathPrefixes: ['/api/'], headerName: 'Authorization',
        allowedMethods: ['GET'], authMode: 'credential',
      },
      allowedCapabilities: [],
      accounts: [{ id: 'connection_sentry_mine', label: 'My Sentry', lifecycle: 'pending' }],
    }],
    teamReconnects: [{ providerId: 'linear', label: 'Linear' }],
  };
}

/** Every top-level key a run plan can carry; the type fails to compile when the plan gains one. */
export const EVERY_PLAN_KEY: Record<keyof RuntimePlanV2, true> = {
  schemaVersion: true, continuityPolicy: true, agentId: true, installation: true, actorMembershipId: true,
  connectionAccountIds: true, usesPersonalAccess: true, connectionSelections: true, connectionAuthorizations: true,
  connectionChoices: true, teamReconnects: true, frontDesk: true, configurationRevision: true, ownerIncarnation: true,
  handoffContext: true, conversation: true, runtimeModel: true, runtimeModelRoute: true, model: true, effort: true,
  imageCapability: true, browserCapability: true, webSearch: true, codingWorkspace: true, websiteLogins: true,
  modelAttribution: true, modelCredential: true, instructions: true, memoryEpoch: true, skills: true,
  mcpConnections: true, apiConnections: true, managedConnections: true, repositories: true, sandbox: true,
  artifactDestination: true, harnessRevision: true,
};
