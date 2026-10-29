import type { ConfigStoreLogic } from '../../src/config/store.ts';
import type { SettingsStoreLogic } from '../../src/config/settings-store.ts';
import type { SignInGroupPolicy } from '../../src/config/sign-in-group.ts';
import type {
  AgentCreateInput,
  AgentOwnedConnectionInput,
  AgentScheduleReferenceInput,
  ChannelConfig,
  NonChatModelRole,
  SlackPublicContextEntryInput,
} from '../../src/config/types.ts';
import type { GatewayWorkspaceBinding } from '../../src/slack/gateway/protocol.ts';
import type { StateDb } from '../../src/state/state-db.ts';

export interface ConfigStorageStores { config: ConfigStoreLogic; settings: SettingsStoreLogic }
/** Opens one source tree's config and settings stores over a database. Each call constructs new store instances, so the config store's start-time installs run again (as on a Worker restart). */
export type ConfigStorageKit = (db: StateDb) => ConfigStorageStores;

/** The fixed clock the caller installs (Date.now) while the scenario writes and reads. */
export const SCENARIO_NOW = Date.UTC(2026, 9, 15, 17, 0, 0);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const WORKSPACE = 'T0SCENARIO';
const CHANNEL_RESEARCH = 'C0SCENARIO1';
const CHANNEL_PRIVATE = 'C0SCENARIO2';
const CHANNEL_RETIRED = 'C0SCENARIO3';
const DIRECT_CHANNEL = 'D0SCENARIO1';
const OWNER = 'membership_scenario_owner';
const MEMBER = 'membership_scenario_member';

const RESEARCHER = 'agent_scenario_researcher';
const CONCIERGE = 'agent_scenario_concierge';
const SCOUT = 'agent_scenario_scout';
const ARCHIVIST = 'agent_scenario_archivist';
const TEMPORARY = 'agent_scenario_temporary';

const ROOT_TS = '1792080000.000100';
const TRANSFER_TS = '1792080030.000150';
const APP_TS = '1792080060.000200';
const AGENT_TS = '1792080120.000300';
const EDIT_TS = '1792080300.000400';
const SECOND_ROOT_TS = '1792076400.000100';
const SECOND_REPLY_TS = '1792076460.000200';
const SECOND_TRANSFER_TS = '1792076520.000300';
const THREADS: ReadonlyArray<readonly [channelId: string, threadTs: string]> = [
  [CHANNEL_RESEARCH, ROOT_TS],
  [CHANNEL_PRIVATE, SECOND_ROOT_TS],
];

const DEPLOYMENT_IDENTITY_KEY = 'slack.gateway.deploymentIdentity.v1';
const GATEWAY_CLAIM_KEY = 'slack.gateway.claim.v1';
const GATEWAY_BINDING_KEY = 'slack.gateway.binding.v1';
const DEPLOYMENT_ID = 'deployment_scenario';

const ACCOUNT_WEATHER = 'connection_scenario_weather';
const ACCOUNT_CALENDAR = 'connection_scenario_calendar';
const ACCOUNT_TRACKER = 'connection_scenario_tracker';
const ACCOUNT_DOCS = 'connection_scenario_docs';
const ACCOUNT_MAIL = 'connection_scenario_mail';
const ACCOUNT_NOTES = 'connection_scenario_notes';
const ACCOUNT_NOTES_SHARED = 'connection_scenario_notes_shared';

const MODEL_ROLES: readonly NonChatModelRole[] = ['image', 'coding'];

const incarnation = (sequence: number) => `agent_${sequence.toString(16).padStart(32, '0')}`;
const credentialRef = (sequence: number) => `connection_${sequence.toString(16).padStart(32, '0')}`;

const NO_CONNECTIONS = { skills: [], mcpServers: [], apiConnections: [], repositories: [] };

const AGENTS: ReadonlyArray<readonly [AgentCreateInput, string]> = [
  [{
    id: RESEARCHER,
    name: 'Scenario Researcher',
    description: 'Collects synthetic research notes.',
    instructions: 'Summarize findings in three bullet points.',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: OWNER,
    editPolicy: 'creator_and_admins',
    model: 'anthropic/claude-sonnet-4-5',
    modelEffort: 'high',
    skills: [
      {
        name: 'weekly-digest',
        description: 'Write the weekly digest.',
        instructions: '# Weekly digest\nList three highlights from the week.',
        enabled: true,
        suggestedSkillId: 'suggested_weekly_digest',
      },
      {
        name: 'imported-checklist',
        description: 'Run the imported checklist.',
        instructions: '# Checklist\nConfirm each item before replying.',
        enabled: false,
        importSource: {
          repository: 'example-org/scenario-skills',
          commit: '0123456789abcdef0123456789abcdef01234567',
          path: 'skills/checklist/SKILL.md',
          contentSha256: 'c'.repeat(64),
        },
      },
    ],
    mcpServers: [
      {
        id: 'mcp_scenario_tracker',
        displayName: 'Scenario Tracker',
        url: 'https://Tracker.Example.com',
        transport: 'streamable-http',
        authMode: 'bearer',
        headerNames: ['X-Workspace'],
        enabled: true,
        lifecycleStatus: 'ready',
        statusText: 'Connected',
        discoveredTools: [
          {
            name: 'search_issues',
            title: 'Search issues',
            description: 'Search synthetic tracker issues.',
            readOnlyHint: true,
            inputSchema: {
              propertyNames: ['query', 'account_id'],
              accountFields: [{ name: 'account_id', type: 'string', required: false }],
              ambiguous: false,
              fingerprint: 'f'.repeat(64),
            },
          },
          { name: 'create_issue', description: 'Create a synthetic issue.' },
        ],
        toolAccessMode: 'review',
        toolPolicies: {
          search_issues: { effect: 'read' },
          create_issue: { effect: 'write', argumentConstraints: { project: ['SCN'] } },
        },
        allowedTools: ['search_issues', 'create_issue'],
        lastCheckedAt: SCENARIO_NOW - HOUR,
        identity: { workspaceName: 'Example Workspace', accountName: 'scenario-bot' },
        presetId: 'preset_scenario_tracker',
      },
      {
        id: 'mcp_scenario_docs',
        displayName: 'Scenario Docs',
        url: 'https://docs.example.com/mcp/',
        transport: 'sse',
        authMode: 'oauth',
        headerNames: [],
        enabled: true,
        lifecycleStatus: 'ready',
        statusText: 'Connected',
        discoveredTools: [{ name: 'read_page' }],
        allowedTools: ['read_page'],
        oauthScope: 'docs.read',
        oauthAttemptId: '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b',
        identity: { accountName: 'scenario-reader' },
      },
      {
        id: 'mcp_scenario_feed',
        displayName: 'Scenario Feed',
        url: 'https://feed.example.com/mcp',
        transport: 'streamable-http',
        authMode: 'none',
        headerNames: ['X-Feed-Key'],
        credentialHeaderName: 'X-Feed-Key',
        credentialValuePrefix: 'Key ',
        credentialOptional: true,
        enabled: false,
        lifecycleStatus: 'pending',
        statusText: 'Not tested',
        discoveredTools: [],
        toolAccessMode: 'auto',
        allowedTools: [],
      },
    ],
    apiConnections: [
      {
        id: 'api_scenario_weather',
        displayName: 'Scenario Weather',
        allowedHosts: ['api.weather.example.com'],
        pathPrefixes: ['/v1/'],
        headerName: 'Authorization',
        headerValuePrefix: 'Bearer ',
        allowedMethods: ['GET'],
        enabled: true,
        authMode: 'credential',
        lifecycleStatus: 'pending',
        statusText: 'Waiting for a credential',
        presetId: 'preset_scenario_weather',
      },
      {
        id: 'api_scenario_calendar',
        displayName: 'Scenario Calendar',
        allowedHosts: ['calendar.example.com'],
        pathPrefixes: ['/calendar/v3/'],
        headerName: 'Authorization',
        allowedMethods: ['GET', 'POST'],
        enabled: true,
        authMode: 'oauth',
        oauthProvider: 'google',
        oauthScopes: ['https://calendar.example.com/auth/calendar.readonly'],
        oauthAppType: 'external',
        lifecycleStatus: 'ready',
        statusText: 'Connected',
        identity: { accountName: 'scenario@example.com' },
      },
      {
        id: 'api_scenario_legacy',
        displayName: 'Scenario Legacy',
        allowedHosts: ['legacy.example.com'],
        pathPrefixes: ['/'],
        headerName: 'X-Api-Key',
        allowedMethods: ['GET'],
        enabled: false,
      },
    ],
    repositories: [
      {
        id: 'repo_scenario_app',
        installationId: 4242,
        accountLogin: 'example-org',
        fullName: 'example-org/scenario-app',
        enabled: true,
      },
      {
        id: 'repo_scenario_all',
        installationId: null,
        accountLogin: 'example-user',
        fullName: 'example-user/*',
        allRepos: true,
        enabled: false,
      },
    ],
    websiteLogins: [
      { loginId: 'login_scenario_portal', level: 'act', enabled: true },
      { loginId: 'login_scenario_reports', level: 'check', enabled: false },
    ],
  }, incarnation(1)],
  [{
    id: CONCIERGE,
    name: 'Scenario Concierge',
    instructions: 'Answer synthetic front-desk questions.',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: MEMBER,
    editPolicy: 'all_workspace_members',
    slackPresence: {
      kind: 'agent_app',
      requestedHandle: 'scenario-concierge',
      normalizedHandle: 'scenario-concierge',
      desiredState: 'active',
      health: 'healthy',
      avatar: { kind: 'generated', revision: 1, seed: 'chickpea-avatar-v1:04:agent_scenario_concierge' },
      observedAt: SCENARIO_NOW - HOUR,
      app: {
        state: 'active',
        at: SCENARIO_NOW - HOUR,
        app: { appId: 'A0SCENARIOCON', clientId: '1000000000.3000000000' },
        icon: 'agent_avatar',
        botUserId: 'U0SCENARIOCON',
        installedAt: SCENARIO_NOW - HOUR,
        installedBy: OWNER,
      },
      released: { userGroupId: 'S0SCENARIOCON', desiredState: 'active', health: 'healthy' },
    },
    ...NO_CONNECTIONS,
  }, incarnation(2)],
  [{
    id: SCOUT,
    name: 'Scenario Scout',
    instructions: 'Watch for synthetic listings.',
    enabled: false,
    lifecycle: 'draft',
    creatorMembershipId: MEMBER,
    slackPresence: {
      kind: 'agent_app',
      requestedHandle: 'scenario-scout',
      normalizedHandle: 'scenario-scout',
      desiredState: 'active',
      health: 'needs_attention',
      avatar: { kind: 'uploaded', revision: 1, url: 'https://assets.example.com/avatars/scout-1.png' },
      errorCode: 'slack_busy',
      errorDetail: 'Slack asked for a retry later.',
      app: {
        state: 'needs_attention',
        at: SCENARIO_NOW - 2 * HOUR,
        startedBy: MEMBER,
        reason: 'slack_busy',
        resume: 'created',
        app: { appId: 'A0SCENARIOSCT', clientId: '1000000000.4000000000' },
        icon: 'default_avatar',
      },
    },
    ...NO_CONNECTIONS,
  }, incarnation(3)],
  [{
    id: ARCHIVIST,
    name: 'Scenario Archivist',
    instructions: 'File synthetic notes.',
    enabled: true,
    lifecycle: 'active',
    creatorMembershipId: OWNER,
    model: 'openai/gpt-5.5',
    slackPresence: {
      kind: 'user_group',
      requestedHandle: 'Scenario Archivist',
      normalizedHandle: 'scenario-archivist',
      desiredState: 'active',
      health: 'needs_attention',
      avatar: {
        kind: 'generated',
        revision: 3,
        seed: 'chickpea-avatar-v1:07:agent_scenario_archivist',
        generatedSeedHistory: [{ throughRevision: 2, seed: 'chickpea-avatar-v1:02:agent_scenario_archivist' }],
      },
      userGroupId: 'S0SCENARIOARC',
      pendingCreate: {
        name: 'Scenario Archivist',
        handle: 'scenario-archivist',
        description: 'Synthetic archivist',
        startedAt: SCENARIO_NOW - DAY,
      },
      errorCode: 'handle_taken',
      handleSuggestions: ['scenario-archivist-team', 'scenario-archivist-2'],
      observedAt: SCENARIO_NOW - DAY,
    },
    ...NO_CONNECTIONS,
  }, incarnation(4)],
  [{
    id: TEMPORARY,
    name: 'Scenario Temporary',
    instructions: 'Exist briefly.',
    enabled: true,
    ...NO_CONNECTIONS,
  }, incarnation(5)],
];

const CHANNELS: readonly ChannelConfig[] = [
  { workspaceId: WORKSPACE, channelId: CHANNEL_RESEARCH, label: 'scenario-research', lifecycle: 'active' },
  { workspaceId: WORKSPACE, channelId: CHANNEL_PRIVATE, label: 'scenario-private', lifecycle: 'active' },
  { workspaceId: WORKSPACE, channelId: CHANNEL_RETIRED, lifecycle: 'archived' },
];

const CONNECTIONS: readonly AgentOwnedConnectionInput[] = [
  {
    account: {
      id: ACCOUNT_WEATHER,
      workspaceId: WORKSPACE,
      ownerKind: 'team',
      createdByMembershipId: OWNER,
      providerId: 'scenario-weather',
      label: 'Weather (team)',
      purpose: 'Daily forecast lookups',
      identity: { accountName: 'weather-team' },
      policy: {
        kind: 'api',
        allowedHosts: ['api.weather.example.com'],
        pathPrefixes: ['/v1/'],
        headerName: 'Authorization',
        headerValuePrefix: 'Bearer ',
        allowedMethods: ['GET'],
        authMode: 'credential',
        presetId: 'preset_scenario_weather',
        guide: 'Forecasts live under /v1/forecast?city=NAME.\nUse metric units.',
      },
      secretRefId: 'secret_scenario_weather',
      lifecycle: 'ready',
    },
    binding: {
      agentId: RESEARCHER,
      connectionAccountId: ACCOUNT_WEATHER,
      providerId: 'scenario-weather',
      allowedCapabilities: ['GET'],
      enabled: true,
    },
  },
  {
    account: {
      id: ACCOUNT_CALENDAR,
      workspaceId: WORKSPACE,
      ownerKind: 'member',
      ownerMembershipId: MEMBER,
      createdByMembershipId: MEMBER,
      providerId: 'scenario-calendar',
      label: 'Calendar (personal)',
      identity: { workspaceName: 'Example Workspace', accountName: 'member@example.com' },
      policy: {
        kind: 'api',
        allowedHosts: ['calendar.example.com'],
        pathPrefixes: ['/calendar/v3/'],
        headerName: 'Authorization',
        allowedMethods: ['GET', 'POST'],
        authMode: 'oauth',
        oauthProvider: 'google',
        oauthScopes: ['https://calendar.example.com/auth/calendar.events'],
        oauthAppType: 'workspace-internal',
        oauthAttemptId: '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d',
      },
      secretRefId: 'secret_scenario_calendar',
      lifecycle: 'needs_attention',
    },
    binding: {
      agentId: CONCIERGE,
      connectionAccountId: ACCOUNT_CALENDAR,
      providerId: 'scenario-calendar',
      allowedCapabilities: ['GET', 'POST'],
      enabled: true,
    },
  },
  {
    account: {
      id: ACCOUNT_TRACKER,
      workspaceId: WORKSPACE,
      ownerKind: 'team',
      createdByMembershipId: OWNER,
      providerId: 'scenario-tracker',
      label: 'Tracker (team)',
      policy: {
        kind: 'mcp',
        // Non-canonical on purpose, so a change to how the store writes MCP URLs shows as a stored-value change.
        url: 'https://Tracker.Example.com',
        transport: 'streamable-http',
        authMode: 'bearer',
        headerNames: ['Authorization'],
        credentialHeaderName: 'Authorization',
        credentialValuePrefix: 'Bearer ',
        discoveredTools: [
          { name: 'search_issues', readOnlyHint: true },
          { name: 'create_issue', title: 'Create issue' },
        ],
        toolAccessMode: 'review',
        toolPolicies: { create_issue: { effect: 'write', argumentConstraints: { project: ['SCN'] } } },
        allowedTools: ['search_issues', 'create_issue'],
        presetId: 'preset_scenario_tracker',
        guide: 'Search by project key, for example SCN.',
      },
      secretRefId: 'secret_scenario_tracker',
      lifecycle: 'ready',
    },
    binding: {
      agentId: RESEARCHER,
      connectionAccountId: ACCOUNT_TRACKER,
      providerId: 'scenario-tracker',
      allowedCapabilities: ['search_issues'],
      enabled: true,
    },
  },
  {
    account: {
      id: ACCOUNT_DOCS,
      workspaceId: WORKSPACE,
      ownerKind: 'member',
      ownerMembershipId: MEMBER,
      createdByMembershipId: MEMBER,
      providerId: 'scenario-docs',
      label: 'Docs (personal)',
      policy: {
        kind: 'mcp',
        url: 'https://docs.example.com/mcp/',
        transport: 'sse',
        authMode: 'oauth',
        headerNames: [],
        discoveredTools: [{ name: 'read_page' }],
        allowedTools: ['read_page'],
        oauthScope: 'docs.read',
        oauthAttemptId: '1b2c3d4e-5f60-4718-a9b0-c1d2e3f4a5b6',
      },
      secretRefId: 'secret_scenario_docs',
      lifecycle: 'pending',
    },
    binding: {
      agentId: CONCIERGE,
      connectionAccountId: ACCOUNT_DOCS,
      providerId: 'scenario-docs',
      allowedCapabilities: ['read_page'],
      enabled: false,
    },
  },
  {
    account: {
      id: ACCOUNT_MAIL,
      workspaceId: WORKSPACE,
      ownerKind: 'team',
      createdByMembershipId: OWNER,
      providerId: 'scenario-mail',
      label: 'Mail (managed)',
      policy: {
        kind: 'managed',
        adapterId: 'composio',
        toolkit: 'gmail',
        principalRef: 'principal_scenario',
        accountRef: 'account_scenario_mail',
        allowedCapabilities: ['mail.read', 'mail.send'],
        resourceConstraints: {
          labels: [
            { handle: 'label_inbox', providerRef: 'INBOX', label: 'Inbox' },
            { handle: 'label_reports', providerRef: 'Label_42', label: 'Reports' },
          ],
          adAccounts: [{ handle: 'ads_main', providerRef: 'act_1001', label: 'Main ads', currencyCode: 'USD' }],
        },
        grantSummary: { items: [{ type: 'page', label: 'Scenario Handbook' }], truncated: false },
        providerGeneration: 3,
        providerLineage: 'lineage_scenario',
      },
      secretRefId: 'secret_scenario_mail',
      lifecycle: 'ready',
    },
    binding: {
      agentId: RESEARCHER,
      connectionAccountId: ACCOUNT_MAIL,
      providerId: 'scenario-mail',
      allowedCapabilities: ['mail.read'],
      resourceConstraints: { labels: ['label_reports'] },
      enabled: true,
    },
  },
];

const NOTES_DATABASE = '5c3e1a2b-7d4f-4e6a-9b8c-0d1e2f3a4b5c';
const NOTES_HANDBOOK = '6d4f2b3c-8e5a-4f7b-8c9d-1e2f3a4b5c6d';

/**
 * One Notion sign-in that two Agents share: the owner signed in for the
 * researcher, and a member added the concierge, limited to one of its pages.
 */
const NOTES_SIGN_IN: SignInGroupPolicy = {
  adapterId: 'composio',
  toolkit: 'notion',
  principalRef: 'principal_scenario',
  accountRef: 'account_scenario_notes',
  signIn: { person: 'notion:workspace-scenario:user-scenario', accessLane: 'write', signedBy: OWNER },
  grantSummary: {
    items: [
      { id: NOTES_DATABASE, type: 'database', label: 'Scenario Notes' },
      { id: NOTES_HANDBOOK, type: 'page', label: 'Scenario Handbook' },
    ],
    truncated: true,
  },
  providerGeneration: 3,
  providerLineage: 'lineage_scenario',
};

function notesConnection(
  id: string,
  agentId: string,
  createdByMembershipId: string,
  allowedCapabilities: string[],
  oauthAttemptId?: string,
  notionPages?: string[],
): AgentOwnedConnectionInput {
  return {
    account: {
      id,
      workspaceId: WORKSPACE,
      ownerKind: 'team',
      createdByMembershipId,
      providerId: 'notion',
      label: 'Notes (managed)',
      policy: {
        kind: 'managed',
        ...NOTES_SIGN_IN,
        allowedCapabilities,
        ...(oauthAttemptId ? { oauthAttemptId } : {}),
      },
      secretRefId: `secret_${id}`,
      lifecycle: 'ready',
    },
    binding: {
      agentId,
      connectionAccountId: id,
      providerId: 'notion',
      allowedCapabilities,
      ...(notionPages ? { resourceConstraints: { notionPages } } : {}),
      enabled: true,
    },
  };
}

const SCHEDULES: readonly AgentScheduleReferenceInput[] = [
  {
    scheduleId: 'schedule_scenario_daily',
    agentId: RESEARCHER,
    workspaceId: WORKSPACE,
    channelId: CHANNEL_RESEARCH,
    destinationKind: 'channel',
    destinationBindingDigest: null,
    createdByMembershipId: OWNER,
    runsAsMembershipId: OWNER,
    authorityReceiptId: 'receipt_scenario_daily',
    requiredConnectionAccountIds: [ACCOUNT_WEATHER, ACCOUNT_MAIL],
    boundRoutineVersion: 2,
    state: 'active',
  },
  {
    scheduleId: 'schedule_scenario_direct',
    agentId: RESEARCHER,
    workspaceId: WORKSPACE,
    channelId: DIRECT_CHANNEL,
    destinationKind: 'direct_thread',
    destinationBindingDigest: '5c'.repeat(32),
    createdByMembershipId: MEMBER,
    runsAsMembershipId: MEMBER,
    authorityReceiptId: 'receipt_scenario_direct',
    requiredConnectionAccountIds: [ACCOUNT_TRACKER],
    connectionPauseAccountIds: [ACCOUNT_TRACKER],
    connectionPausePreservesState: true,
    state: 'needs_attention',
  },
  {
    scheduleId: 'schedule_scenario_legacy',
    agentId: CONCIERGE,
    workspaceId: WORKSPACE,
    channelId: CHANNEL_PRIVATE,
    createdByMembershipId: MEMBER,
    runsAsMembershipId: MEMBER,
    authorityReceiptId: 'receipt_scenario_legacy',
    requiredConnectionAccountIds: [],
    state: 'active',
  },
  {
    scheduleId: 'schedule_scenario_archive_active',
    agentId: ARCHIVIST,
    workspaceId: WORKSPACE,
    channelId: CHANNEL_RESEARCH,
    createdByMembershipId: OWNER,
    runsAsMembershipId: OWNER,
    authorityReceiptId: 'receipt_scenario_archive_active',
    requiredConnectionAccountIds: [],
    state: 'active',
  },
  {
    scheduleId: 'schedule_scenario_archive_outage',
    agentId: ARCHIVIST,
    workspaceId: WORKSPACE,
    channelId: CHANNEL_RESEARCH,
    createdByMembershipId: OWNER,
    runsAsMembershipId: OWNER,
    authorityReceiptId: 'receipt_scenario_archive_outage',
    requiredConnectionAccountIds: [ACCOUNT_WEATHER],
    connectionPauseAccountIds: [ACCOUNT_WEATHER],
    state: 'needs_attention',
  },
];

const PUBLIC_CONTEXT: readonly SlackPublicContextEntryInput[] = [
  {
    workspaceId: WORKSPACE,
    channelId: CHANNEL_RESEARCH,
    rootTs: ROOT_TS,
    messageTs: ROOT_TS,
    role: 'human',
    text: 'Can someone pull the synthetic quarterly report?',
    authorId: 'U0SCENARIOMEM',
    files: [{ name: 'report-q3.csv', type: 'csv', sizeBytes: 2048 }],
  },
  {
    workspaceId: WORKSPACE,
    channelId: CHANNEL_RESEARCH,
    rootTs: ROOT_TS,
    messageTs: APP_TS,
    role: 'app',
    text: 'Report job queued.',
    authorId: 'B0SCENARIOJOB',
    authorName: 'Scenario Jobs',
  },
  {
    workspaceId: WORKSPACE,
    channelId: CHANNEL_RESEARCH,
    rootTs: ROOT_TS,
    messageTs: AGENT_TS,
    role: 'agent',
    agentId: RESEARCHER,
    text: 'Here is the first summary.',
    authorName: 'Scenario Researcher',
    images: [{ id: 'F0SCENARIOIMG', name: 'chart.png', mimeType: 'image/png', sizeBytes: 4096 }],
    contentVersionTs: AGENT_TS,
  },
  {
    workspaceId: WORKSPACE,
    channelId: CHANNEL_RESEARCH,
    rootTs: ROOT_TS,
    messageTs: AGENT_TS,
    role: 'agent',
    agentId: RESEARCHER,
    text: 'Here is the revised summary.',
    contentVersionTs: EDIT_TS,
  },
];

const SEEDED_CONTEXT: readonly SlackPublicContextEntryInput[] = [
  {
    workspaceId: WORKSPACE,
    channelId: CHANNEL_PRIVATE,
    rootTs: SECOND_ROOT_TS,
    messageTs: SECOND_ROOT_TS,
    role: 'app',
    text: 'Synthetic alert: queue depth above threshold.',
    authorId: 'B0SCENARIOALR',
    authorName: 'Scenario Alerts',
    gapBeforeTs: SECOND_REPLY_TS,
  },
  {
    workspaceId: WORKSPACE,
    channelId: CHANNEL_PRIVATE,
    rootTs: SECOND_ROOT_TS,
    messageTs: SECOND_REPLY_TS,
    role: 'human',
    text: 'Looking into it.',
    authorId: 'U0SCENARIOOWN',
    files: [],
  },
];

const LEGACY_SECRET_KEYS = [
  `mcp.${RESEARCHER}.mcp_scenario_tracker.bearer`,
  `mcp.${RESEARCHER}.mcp_scenario_tracker.header.X-Workspace`,
  `mcp.${RESEARCHER}.mcp_scenario_docs.oauth.tokens`,
  `connector.${RESEARCHER}.api_scenario_weather.credential`,
  `connector.${RESEARCHER}.api_scenario_calendar.oauth.tokens`,
];
const CURRENT_SECRET_KEYS = [
  `mcp.${RESEARCHER}.credential.${credentialRef(1)}.bearer`,
  `mcp.${RESEARCHER}.credential.${credentialRef(2)}.oauth.tokens`,
  `connector.${RESEARCHER}.credential.${credentialRef(3)}.credential`,
  `mcp.${ACCOUNT_DOCS}.account.oauth.tokens`,
  `connector.${ACCOUNT_CALENDAR}.account.oauth.tokens`,
];

function must(done: boolean, step: string): void {
  if (!done) throw new Error(`Config storage scenario step did not apply: ${step}`);
}

function writeGateway({ config, settings }: ConfigStorageStores): void {
  settings.setSetting(DEPLOYMENT_IDENTITY_KEY, JSON.stringify({
    version: 1,
    deploymentId: DEPLOYMENT_ID,
    publicKey: { kty: 'EC', crv: 'P-256', x: 'c2NlbmFyaW8tcHVibGljLXg', y: 'c2NlbmFyaW8tcHVibGljLXk' },
    privateKeyEnvelope: {
      version: 1,
      algorithm: 'AES-GCM-256',
      keyId: 'scenario-key',
      nonce: 'c2NlbmFyaW8tbm9uY2U',
      ciphertext: 'c2NlbmFyaW8tY2lwaGVydGV4dA',
    },
    createdAt: SCENARIO_NOW - DAY,
  }));
  const claim = JSON.stringify({
    claimId: 'claim_scenario_first',
    expiresAt: SCENARIO_NOW + HOUR,
    authorizationUrl: 'https://gateway.example.com/claims/claim_scenario_first',
  });
  settings.setSetting(GATEWAY_CLAIM_KEY, claim);
  const binding: GatewayWorkspaceBinding = {
    bindingId: 'binding_scenario',
    deploymentId: DEPLOYMENT_ID,
    workspaceId: WORKSPACE,
    appId: 'A0SCENARIO',
    clientId: '1000000000.2000000000',
    botUserId: 'U0SCENARIOBOT',
    installerSlackUserId: 'U0SCENARIOOWN',
    sessionUrl: 'wss://gateway.example.com/sessions/binding_scenario',
    installedAt: SCENARIO_NOW - HOUR,
  };
  must(config.retainGatewayInstallation({ expectedClaim: claim, binding, now: SCENARIO_NOW }), 'retain gateway');
  settings.setSetting(GATEWAY_CLAIM_KEY, JSON.stringify({
    claimId: 'claim_scenario_second',
    expiresAt: SCENARIO_NOW + 2 * HOUR,
    authorizationUrl: 'https://gateway.example.com/claims/claim_scenario_second',
    setupId: 'setup_scenario',
    setupRevision: 2,
  }));
}

function writeModelPolicy(config: ConfigStoreLogic): void {
  // The gateway install writes an already-activated cutover row; a round trip also writes the prepare and activate paths.
  const installed = config.getWorkspaceInstallation(WORKSPACE)!;
  config.rollbackChickpeaCutover({ workspaceId: WORKSPACE, expectedInstallationRevision: installed.revision });
  const prepared = config.prepareChickpeaCutover({ workspaceId: WORKSPACE, legacyEnvironmentModel: 'openai/gpt-5.5' });
  config.activateChickpeaCutover({
    workspaceId: WORKSPACE,
    expectedInstallationRevision: prepared.installationRevision,
    expectedDefaultRevision: prepared.defaultRevision,
    defaultReady: true,
  });
  config.putWorkspaceModelDefault({
    workspaceId: WORKSPACE,
    modelId: 'anthropic/claude-sonnet-4-5',
    effort: 'medium',
    provenance: 'admin_selected',
    lastChangedByMembershipId: OWNER,
  });
  config.putWorkspaceModelRole({
    workspaceId: WORKSPACE,
    role: 'image',
    modelId: 'openai/gpt-image-1',
    lastChangedByMembershipId: OWNER,
  });
  config.putWorkspaceModelRole({
    workspaceId: WORKSPACE,
    role: 'coding',
    modelId: 'anthropic/claude-opus-4-1',
    effort: 'xhigh',
  });
}

function writeChannels(config: ConfigStoreLogic): void {
  for (const channel of CHANNELS) config.putChannel(channel, 0);
  config.putChannel({ ...CHANNELS[0]!, label: 'scenario-research-desk' }, 1);
  config.putAgentChannelGrant({
    workspaceId: WORKSPACE,
    channelId: CHANNEL_RESEARCH,
    agentId: RESEARCHER,
    status: 'active',
    createdByMembershipId: OWNER,
    channelLabel: 'scenario-research-desk',
    channelIsPrivate: false,
  });
  config.putAgentChannelGrant({
    workspaceId: WORKSPACE,
    channelId: CHANNEL_PRIVATE,
    agentId: CONCIERGE,
    status: 'pending',
    createdByMembershipId: MEMBER,
    channelIsPrivate: true,
  });
  config.putAgentChannelGrant({
    workspaceId: WORKSPACE,
    channelId: CHANNEL_RESEARCH,
    agentId: ARCHIVIST,
    status: 'active',
    createdByMembershipId: OWNER,
    channelLabel: 'scenario-research-desk',
    channelIsPrivate: false,
  });
  must(config.refreshChannelLabel(WORKSPACE, CHANNEL_RESEARCH, 'scenario-research-hub'), 'refresh channel label');
}

function writeThreads(config: ConfigStoreLogic): void {
  config.putAgentThreadRoute({
    workspaceId: WORKSPACE,
    channelId: CHANNEL_RESEARCH,
    threadTs: ROOT_TS,
    agentId: RESEARCHER,
    agentGeneration: config.getAgent(RESEARCHER).configurationGeneration!,
    ownerIncarnation: 2,
    handoff: {
      transferMessageTs: TRANSFER_TS,
      previousAgentId: CONCIERGE,
      context: [
        { messageTs: ROOT_TS, role: 'human', text: 'Can someone pull the synthetic quarterly report?' },
        { messageTs: TRANSFER_TS, role: 'agent', text: 'Handing this to the researcher.', agentId: CONCIERGE },
        { messageTs: APP_TS, role: 'app', text: 'Report job queued.' },
      ],
    },
  }, 0);
  const concierge = config.getAgent(CONCIERGE).configurationGeneration!;
  config.putAgentThreadRoute({
    workspaceId: WORKSPACE,
    channelId: CHANNEL_PRIVATE,
    threadTs: SECOND_ROOT_TS,
    agentId: CONCIERGE,
    agentGeneration: concierge,
  }, 0);
  config.putAgentThreadRoute({
    workspaceId: WORKSPACE,
    channelId: CHANNEL_PRIVATE,
    threadTs: SECOND_ROOT_TS,
    agentId: CONCIERGE,
    agentGeneration: concierge,
    ownerIncarnation: 3,
    handoff: { transferMessageTs: SECOND_TRANSFER_TS, previousAgentId: RESEARCHER },
  }, 1);
  for (const entry of PUBLIC_CONTEXT) config.putSlackPublicContext(entry);
  must(config.seedSlackPublicContext([...SEEDED_CONTEXT]) === SEEDED_CONTEXT.length, 'seed public context');
}

function writeConnections(config: ConfigStoreLogic): void {
  for (const connection of CONNECTIONS) config.createAgentOwnedConnection(connection);
  const notes = config.createAgentOwnedConnection(
    notesConnection(ACCOUNT_NOTES, RESEARCHER, OWNER, ['notion.content.search', 'notion.pages.create']),
  ).account;
  // v0.1.37 has no sign-in groups: its fixture records the database without the concierge's account.
  if ('applySignInGroup' in config) {
    config.applySignInGroup({
      adapterId: NOTES_SIGN_IN.adapterId,
      accountRef: NOTES_SIGN_IN.accountRef,
      members: [{ connectionAccountId: notes.id, expectedRevision: notes.revision }],
      shared: NOTES_SIGN_IN,
      join: notesConnection(
        ACCOUNT_NOTES_SHARED, CONCIERGE, MEMBER, ['notion.content.search'], '2c3d4e5f-6071-4829-b0c1-d2e3f4a5b6c7',
        [NOTES_HANDBOOK],
      ),
    });
  }
  const weather = CONNECTIONS[0]!;
  config.putConnectionAccount({
    ...weather.account,
    label: 'Weather (team, renamed)',
    identity: { workspaceName: 'Example Workspace', accountName: 'weather-team' },
  }, 1);
  config.putAgentConnectionBinding({ ...weather.binding, allowedCapabilities: ['GET', 'HEAD'] });

  const researcher = config.getAgent(RESEARCHER);
  const weatherApi = researcher.apiConnections.find(({ id }) => id === 'api_scenario_weather')!;
  must(config.markApiCredentialReady({
    agentId: RESEARCHER,
    connectionId: weatherApi.id,
    credentialRef: weatherApi.credentialRef!,
  }), 'mark API credential ready');
  const docs = config.getAgent(RESEARCHER).mcpServers.find(({ id }) => id === 'mcp_scenario_docs')!;
  must(config.markOAuthReauthorizationRequired({
    lane: 'mcp',
    agentId: RESEARCHER,
    connectionId: docs.id,
    credentialRef: docs.credentialRef!,
    serverUrl: docs.url,
  }), 'mark MCP OAuth reauthorization');
}

function writeSchedules(config: ConfigStoreLogic): void {
  for (const schedule of SCHEDULES) config.putAgentScheduleReference(schedule, 0);
  config.putAgentScheduleReference({ ...SCHEDULES[0]!, boundRoutineVersion: 3 }, 1);
  must(config.retireAgentScheduleReference('schedule_scenario_legacy'), 'retire schedule');
}

function writeAgentChanges(config: ConfigStoreLogic): void {
  const concierge = config.getAgent(CONCIERGE);
  config.updateAgent(CONCIERGE, {
    description: 'Front desk for synthetic visitors.',
    slackPresence: {
      ...concierge.slackPresence!,
      avatar: { kind: 'uploaded', revision: 2, url: 'https://assets.example.com/avatars/concierge-2.png' },
    },
  }, concierge.revision);
  config.putAgentModelRole({ agentId: RESEARCHER, role: 'coding', modelId: 'openai/gpt-5.5-codex' });
  config.putAgentModelRole({ agentId: CONCIERGE, role: 'image' });
  config.setWorkspaceDefaultAgent(WORKSPACE, RESEARCHER);

  const archivist = config.getAgent(ARCHIVIST);
  config.archiveAgent(ARCHIVIST, {
    expectedRevision: archivist.revision,
    expectedCredentialIncarnation: archivist.credentialIncarnation!,
  });
  const temporary = config.getAgent(TEMPORARY);
  must(config.deleteAgentWithMemory(
    TEMPORARY,
    'delete_scenario_temporary',
    temporary.revision,
    temporary.credentialIncarnation!,
  ), 'delete Agent with memory');
}

export function writeConfigStorageScenario(kit: ConfigStorageKit, db: StateDb): void {
  const stores = kit(db);
  const { config, settings } = stores;
  writeGateway(stores);
  writeModelPolicy(config);
  for (const [agent, credentialIncarnation] of AGENTS) config.createAgent(agent, { credentialIncarnation });
  writeChannels(config);
  writeThreads(config);
  writeConnections(config);
  writeSchedules(config);
  writeAgentChanges(config);
  for (const key of [...LEGACY_SECRET_KEYS, ...CURRENT_SECRET_KEYS]) {
    settings.setSetting(key, JSON.stringify({ synthetic: key }));
  }
  // A restart runs the start-time cleanup, which deletes the legacy-format keys.
  kit(db);
}

/** Reads back everything the scenario wrote, through the public store API only, as plain JSON-serializable data. Must not write. */
export function readConfigStorageScenario(kit: ConfigStorageKit, db: StateDb): unknown {
  const { config, settings } = kit(db);
  const agents = config.listAgents();
  const agentIds = agents.map(({ id }) => id);
  return {
    agents,
    agentReferences: agentIds.map((id) => config.getAgentReferences(id)),
    channels: config.listChannels(),
    channelGrants: config.listAgentChannelGrants(),
    threadRoutes: THREADS.map(([channelId, threadTs]) =>
      config.getAgentThreadRoute(WORKSPACE, channelId, threadTs) ?? null),
    publicContext: THREADS.map(([channelId, rootTs]) =>
      config.listSlackPublicContext(WORKSPACE, channelId, rootTs)),
    recentAgentContext: config.listRecentSlackPublicContext({
      workspaceId: WORKSPACE,
      channelId: CHANNEL_RESEARCH,
      agentId: RESEARCHER,
      beforeMessageTs: String(SCENARIO_NOW / 1000),
      limit: 20,
    }),
    connectionAccounts: config.listConnectionAccounts(WORKSPACE),
    connectionBindings: agentIds.flatMap((id) => config.listAgentConnectionBindings(id)),
    scheduleReferences: agentIds.flatMap((id) => config.listAgentScheduleReferences(id)),
    workspaceInstallations: config.listWorkspaceInstallations(),
    workspaceModelDefault: config.getWorkspaceModelDefault(WORKSPACE) ?? null,
    workspaceModelRoles: MODEL_ROLES.map((role) => config.getWorkspaceModelRole(WORKSPACE, role) ?? null),
    agentModelRoles: agentIds.flatMap((id) =>
      MODEL_ROLES.flatMap((role) => config.getAgentModelRole(id, role) ?? [])),
    cutover: config.preflightChickpeaCutover(WORKSPACE),
    gateway: {
      deploymentIdentity: settings.getSetting(DEPLOYMENT_IDENTITY_KEY) ?? null,
      claim: settings.getSetting(GATEWAY_CLAIM_KEY) ?? null,
      binding: settings.getSetting(GATEWAY_BINDING_KEY) ?? null,
    },
    agentSecrets: Object.fromEntries([...LEGACY_SECRET_KEYS, ...CURRENT_SECRET_KEYS].map((key) =>
      [key, settings.getSetting(key) ?? null])),
  };
}
