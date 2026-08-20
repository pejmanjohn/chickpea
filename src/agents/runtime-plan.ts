import { createHash } from 'node:crypto';

import { resolveAgentModel } from '../config/model-policy.ts';
import {
  type ApiConnectionConfig,
  type McpConnectionConfig,
  type RepositoryGrant,
  type ResolvedAssignment,
  type SkillConfig,
} from '../config/types.ts';
import { opaqueId } from '../work/admission.ts';
import { effectiveSlackIdentityId } from '../slack/identity-admission.ts';
import { slackThreadKey } from '../slack/thread-key.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';
import {
  projectEffectiveApiConnections,
  projectEffectiveMcpConnections,
} from '../connections/runtime.ts';
import type { EffectiveConnectionAccount } from '../connections/types.ts';
import type { PersonalConnectionAuthorizationOption } from '../connections/types.ts';

export const RUNTIME_PLAN_SCHEMA_VERSION = 2 as const;
export const DEFAULT_CONTINUITY_POLICY = 'slack-runtime-v3' as const;

export type RuntimePlanSurface = 'channel_thread' | 'direct_message';
export type RuntimePlanSandboxMode = 'bash' | 'cloudflare';

export interface RuntimePlanConversationV2 {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  surface: RuntimePlanSurface;
  continuityKey: string;
}

export interface RuntimePlanSkillV2 {
  name: string;
  description: string;
  instructions: string;
}

export interface RuntimePlanMcpConnectionV2 {
  id: string;
  url: string;
  transport: 'streamable-http' | 'sse';
  authMode: 'none' | 'bearer' | 'oauth';
  headerNames: string[];
  allowedTools: string[];
  optional: boolean;
}

export interface RuntimePlanApiConnectionV2 {
  id: string;
  allowedHosts: string[];
  pathPrefixes: string[];
  allowedMethods: string[];
  headerName: string;
  headerValuePrefix?: string;
  authMode: 'credential' | 'oauth';
  oauthProvider?: 'google';
  oauthScopes?: string[];
}

export interface RuntimePlanRepositoryV2 {
  id: string;
  fullName: string;
  allRepos?: boolean;
}

export interface RuntimePlanConnectionAuthorizationV2 {
  providerId: string;
  templateAccountId: string;
  accounts: Array<{
    id: string;
    label: string;
    purpose?: string;
    lifecycle: 'pending' | 'ready' | 'needs_attention';
  }>;
}

export interface RuntimePlanConnectionChoiceV2 {
  providerId: string;
  choices: Array<{ label: string; purpose?: string; scope: 'team' | 'personal' }>;
}

export interface RuntimePlanV2 {
  schemaVersion: typeof RUNTIME_PLAN_SCHEMA_VERSION;
  continuityPolicy: string;
  /** Durable profile identity used only by trusted live resource resolvers. */
  agentId: string;
  /** Slack-provisioned product actor; required for personal connection accounts. */
  actorMembershipId?: string;
  /** Credential-free account references frozen for this task. */
  connectionAccountIds?: string[];
  /** Actor-safe personal provider options available for inline authorization. */
  connectionAuthorizations?: RuntimePlanConnectionAuthorizationV2[];
  /** Providers withheld until the user identifies one plausible account. */
  connectionChoices?: RuntimePlanConnectionChoiceV2[];
  /** Non-secret Slack app reference. Missing only on pre-U4 durable plans. */
  slackIdentityId?: string;
  /** Object revisions used to explain which live configuration this turn froze. */
  configurationRevision?: {
    agent: number;
    channel?: number;
  };
  conversation: RuntimePlanConversationV2;
  model: string;
  instructions: string;
  memoryEpoch: number;
  skills: RuntimePlanSkillV2[];
  mcpConnections: RuntimePlanMcpConnectionV2[];
  apiConnections: RuntimePlanApiConnectionV2[];
  repositories: RuntimePlanRepositoryV2[];
  sandbox: { mode: RuntimePlanSandboxMode };
  artifactDestination: {
    kind: 'slack_conversation';
    channelId: string;
  };
  harnessRevision: string;
}

export interface CompileRuntimePlanV2Input {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  /** Complete, already-layered model instruction text. */
  instructions: string;
  memoryEpoch: number;
  sandboxMode: RuntimePlanSandboxMode;
  continuityPolicy?: string;
  effectiveConnections?: readonly EffectiveConnectionAccount[];
  connectionAuthorizations?: readonly PersonalConnectionAuthorizationOption[];
  connectionChoices?: readonly RuntimePlanConnectionChoiceV2[];
}

/**
 * Compile the only data allowed to cross Flue's durable creation boundary.
 * Credential identities, versions, values, tokens, and live request objects
 * are intentionally absent. Non-secret auth and header policy is frozen here;
 * trusted request-time resolvers own the current credential material.
 */
export function compileRuntimePlanV2(input: CompileRuntimePlanV2Input): RuntimePlanV2 {
  const conversationThreadTs = input.turn.sessionThreadTs ?? input.turn.threadTs;
  const continuityKey = opaqueId('agent', slackThreadKey(input.turn));
  const effectiveConnections = input.effectiveConnections;
  const mcpConnections = effectiveConnections
    ? projectEffectiveMcpConnections(effectiveConnections)
    : input.assignment.agent.mcpServers;
  const apiConnections = effectiveConnections
    ? projectEffectiveApiConnections(effectiveConnections)
    : input.assignment.agent.apiConnections;
  const planWithoutRevision: Omit<RuntimePlanV2, 'harnessRevision'> = {
    schemaVersion: RUNTIME_PLAN_SCHEMA_VERSION,
    continuityPolicy: input.continuityPolicy ?? DEFAULT_CONTINUITY_POLICY,
    agentId: input.assignment.agent.id,
    ...(input.turn.actorMembershipId
      ? { actorMembershipId: input.turn.actorMembershipId }
      : {}),
    connectionAccountIds: effectiveConnections?.map(({ account }) => account.id) ?? [],
    connectionAuthorizations: compileConnectionAuthorizations(input.connectionAuthorizations),
    connectionChoices: (input.connectionChoices ?? []).map((choice) => ({
      providerId: choice.providerId,
      choices: choice.choices.map((candidate) => ({ ...candidate })),
    })),
    slackIdentityId: effectiveSlackIdentityId(input.assignment),
    configurationRevision: {
      agent: input.assignment.agent.revision,
      ...(input.assignment.channelRevision
        ? { channel: input.assignment.channelRevision }
        : {}),
    },
    conversation: {
      workspaceId: input.turn.workspaceId,
      channelId: input.turn.channelId,
      threadTs: conversationThreadTs,
      surface: surfaceForTurn(input.turn),
      continuityKey,
    },
    model: input.assignment.model ?? resolveAgentModel(input.assignment.agent),
    instructions: input.instructions,
    memoryEpoch: input.memoryEpoch,
    skills: compileSkills(input.assignment.agent.skills),
    mcpConnections: compileMcpConnections(mcpConnections),
    apiConnections: compileApiConnections(apiConnections),
    repositories: compileRepositories(input.assignment.agent.repositories),
    sandbox: { mode: input.sandboxMode },
    artifactDestination: {
      kind: 'slack_conversation',
      channelId: input.turn.channelId,
    },
  };
  const plan: RuntimePlanV2 = {
    ...planWithoutRevision,
    harnessRevision: computeHarnessRevision(planWithoutRevision),
  };
  return parseRuntimePlanV2(plan);
}

export function deriveRuntimePlanInstanceId(plan: RuntimePlanV2): string {
  const validated = parseRuntimePlanV2(plan);
  return opaqueId(
    'agent',
    `${validated.conversation.continuityKey}:${validated.harnessRevision}`,
  );
}

/**
 * Canonical adapter coordinate for operational state that belongs to the
 * Slack conversation rather than to one opaque Flue agent incarnation.
 */
export function runtimePlanConversationKey(plan: RuntimePlanV2): string {
  const validated = parseRuntimePlanV2(plan);
  return [
    validated.conversation.workspaceId,
    validated.conversation.channelId,
    validated.conversation.threadTs,
  ].join(':');
}

/**
 * Owner-bound Sandbox coordinate for isolated executions such as routines.
 * The opaque key binds both the canonical Slack coordinate and frozen owner
 * identity while remaining below Cloudflare Sandbox's 63-character id limit.
 * Concurrent occurrences stay isolated and retries with the same owner
 * converge without exposing a provider identity to unbounded Slack fields.
 */
export function runtimePlanSandboxConversationKey(
  plan: RuntimePlanV2,
  ownerId: string,
): string {
  const conversationKey = runtimePlanConversationKey(plan);
  if (!ownerId.trim() || ownerId.length > 200) {
    throw new Error('Sandbox owner identity is invalid.');
  }
  return opaqueId('sandbox', `${conversationKey}:${ownerId}`);
}

/** Strict allowlist parser for persisted/runtime-provided Flue initial data. */
export function parseRuntimePlanV2(value: unknown): RuntimePlanV2 {
  const record = exactRecord(value, 'runtime plan', [
    'schemaVersion',
    'continuityPolicy',
    'agentId',
    'actorMembershipId',
    'connectionAccountIds',
    'connectionAuthorizations',
    'connectionChoices',
    'slackIdentityId',
    'configurationRevision',
    'conversation',
    'model',
    'instructions',
    'memoryEpoch',
    'skills',
    'mcpConnections',
    'apiConnections',
    'repositories',
    'sandbox',
    'artifactDestination',
    'harnessRevision',
  ], [
    'slackIdentityId',
    'configurationRevision',
    'actorMembershipId',
    'connectionAccountIds',
    'connectionAuthorizations',
    'connectionChoices',
  ]);
  if (record.schemaVersion !== RUNTIME_PLAN_SCHEMA_VERSION) {
    throw new Error('Runtime plan schemaVersion must be 2.');
  }
  const continuityPolicy = boundedString(record.continuityPolicy, 'continuityPolicy', 1, 80);
  const agentId = boundedString(record.agentId, 'agentId', 1, 128);
  const actorMembershipId = record.actorMembershipId === undefined
    ? undefined
    : boundedString(record.actorMembershipId, 'actorMembershipId', 1, 160);
  const connectionAccountIds = record.connectionAccountIds === undefined
    ? []
    : arrayOf(
      record.connectionAccountIds,
      'connectionAccountIds',
      (value) => boundedString(value, 'connectionAccountId', 1, 160),
      128,
    );
  const connectionAuthorizations = record.connectionAuthorizations === undefined
    ? []
    : arrayOf(
      record.connectionAuthorizations,
      'connectionAuthorizations',
      parseConnectionAuthorization,
      64,
    );
  const connectionChoices = record.connectionChoices === undefined
    ? []
    : arrayOf(record.connectionChoices, 'connectionChoices', parseConnectionChoice, 64);
  const slackIdentityId = record.slackIdentityId === undefined
    ? undefined
    : boundedString(record.slackIdentityId, 'slackIdentityId', 1, 128);
  const configurationRevision = record.configurationRevision === undefined
    ? undefined
    : parseConfigurationRevision(record.configurationRevision);
  const conversationRecord = exactRecord(record.conversation, 'conversation', [
    'workspaceId',
    'channelId',
    'threadTs',
    'surface',
    'continuityKey',
  ]);
  const persistedSurface = oneOf(
    conversationRecord.surface,
    'conversation.surface',
    ['channel_thread', 'direct_message', 'app_home'] as const,
  );
  // Pre-Agent-View plans may survive in pending TurnJobs. Accept that durable
  // read shape, but normalize it so new plans and every downstream consumer
  // only observe the current direct-message surface.
  const surface: RuntimePlanSurface = persistedSurface === 'app_home'
    ? 'direct_message'
    : persistedSurface;
  const conversation: RuntimePlanConversationV2 = {
    workspaceId: slackIdentity(conversationRecord.workspaceId, 'conversation.workspaceId'),
    channelId: slackIdentity(conversationRecord.channelId, 'conversation.channelId'),
    threadTs: conversationThread(conversationRecord.threadTs),
    surface,
    continuityKey: opaqueAgentId(conversationRecord.continuityKey, 'conversation.continuityKey'),
  };
  const model = boundedString(record.model, 'model', 3, 240);
  const instructions = boundedString(record.instructions, 'instructions', 1, 200_000);
  const memoryEpoch = positiveInteger(record.memoryEpoch, 'memoryEpoch');
  const skills = arrayOf(record.skills, 'skills', parseSkill, 128);
  const mcpConnections = arrayOf(
    record.mcpConnections,
    'mcpConnections',
    parseMcpConnection,
    128,
  );
  const apiConnections = arrayOf(
    record.apiConnections,
    'apiConnections',
    parseApiConnection,
    128,
  );
  const repositories = arrayOf(record.repositories, 'repositories', parseRepository, 256);
  const sandboxRecord = exactRecord(record.sandbox, 'sandbox', ['mode']);
  const sandbox = {
    mode: oneOf(sandboxRecord.mode, 'sandbox.mode', ['bash', 'cloudflare'] as const),
  };
  const artifactRecord = exactRecord(record.artifactDestination, 'artifactDestination', [
    'kind',
    'channelId',
  ]);
  if (artifactRecord.kind !== 'slack_conversation') {
    throw new Error('Runtime plan artifactDestination.kind is invalid.');
  }
  const artifactDestination: RuntimePlanV2['artifactDestination'] = {
    kind: 'slack_conversation',
    channelId: slackIdentity(artifactRecord.channelId, 'artifactDestination.channelId'),
  };
  if (artifactDestination.channelId !== conversation.channelId) {
    throw new Error('Runtime plan artifact destination does not match its conversation.');
  }
  const harnessRevision = sha256(record.harnessRevision, 'harnessRevision');
  const parsed: RuntimePlanV2 = {
    schemaVersion: RUNTIME_PLAN_SCHEMA_VERSION,
    continuityPolicy,
    agentId,
    ...(actorMembershipId ? { actorMembershipId } : {}),
    ...(record.connectionAccountIds === undefined ? {} : { connectionAccountIds }),
    ...(record.connectionAuthorizations === undefined ? {} : { connectionAuthorizations }),
    ...(record.connectionChoices === undefined ? {} : { connectionChoices }),
    ...(slackIdentityId ? { slackIdentityId } : {}),
    ...(configurationRevision ? { configurationRevision } : {}),
    conversation,
    model,
    instructions,
    memoryEpoch,
    skills,
    mcpConnections,
    apiConnections,
    repositories,
    sandbox,
    artifactDestination,
    harnessRevision,
  };
  const expected = computeHarnessRevision(parsed);
  const legacyCandidate = { ...parsed };
  delete legacyCandidate.connectionAccountIds;
  delete legacyCandidate.connectionAuthorizations;
  delete legacyCandidate.connectionChoices;
  const legacyExpected = !parsed.actorMembershipId && connectionAccountIds.length === 0 &&
      connectionAuthorizations.length === 0 && connectionChoices.length === 0
    ? computeHarnessRevision(legacyCandidate)
    : undefined;
  if (harnessRevision !== expected && harnessRevision !== legacyExpected) {
    throw new Error('Runtime plan harnessRevision does not match its harness policy.');
  }
  return parsed;
}

function compileConnectionAuthorizations(
  options: readonly PersonalConnectionAuthorizationOption[] | undefined,
): RuntimePlanConnectionAuthorizationV2[] {
  return (options ?? []).map((option) => ({
    providerId: option.providerId,
    templateAccountId: option.templateAccountId,
    accounts: option.accounts.flatMap((account) => account.lifecycle === 'revoked'
      ? []
      : [{
          id: account.id,
          label: account.label,
          ...(account.purpose ? { purpose: account.purpose } : {}),
          lifecycle: account.lifecycle,
        }]),
  })).sort(compareBy('providerId'));
}

function compileSkills(skills: readonly SkillConfig[] | undefined): RuntimePlanSkillV2[] {
  const byName = new Map<string, RuntimePlanSkillV2>();
  for (const skill of skills ?? []) {
    if (!skill.enabled) continue;
    byName.set(skill.name, {
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
    });
  }
  return [...byName.values()].sort(compareBy('name'));
}

function compileMcpConnections(
  connections: readonly McpConnectionConfig[] | undefined,
): RuntimePlanMcpConnectionV2[] {
  return (connections ?? [])
    .filter(
      (connection) =>
        connection.enabled &&
        connection.lifecycleStatus === 'ready' &&
        connection.allowedTools.length > 0,
    )
    .map((connection) => ({
      id: connection.id,
      url: connection.url,
      transport: connection.transport,
      authMode: connection.authMode,
      headerNames: sortedUnique(connection.headerNames.map((name) => name.toLowerCase())),
      allowedTools: sortedUnique(connection.allowedTools),
      // Current Chickpea policy degrades unavailable profile MCP servers.
      optional: true,
    }))
    .sort(compareBy('id'));
}

function compileApiConnections(
  connections: readonly ApiConnectionConfig[] | undefined,
): RuntimePlanApiConnectionV2[] {
  return (connections ?? [])
    .filter(
      (connection) =>
        connection.enabled &&
        (connection.lifecycleStatus === undefined || connection.lifecycleStatus === 'ready'),
    )
    .map((connection) => ({
      id: connection.id,
      allowedHosts: sortedUnique(connection.allowedHosts.map((host) => host.toLowerCase())),
      pathPrefixes: sortedUnique(connection.pathPrefixes),
      allowedMethods: sortedUnique(connection.allowedMethods.map((method) => method.toUpperCase())),
      headerName: connection.headerName.toLowerCase(),
      ...(connection.headerValuePrefix ? { headerValuePrefix: connection.headerValuePrefix } : {}),
      authMode: connection.authMode ?? 'credential',
      ...(connection.oauthProvider ? { oauthProvider: connection.oauthProvider } : {}),
      ...(connection.oauthScopes
        ? { oauthScopes: sortedUnique(connection.oauthScopes) }
        : {}),
    }))
    .sort(compareBy('id'));
}

function compileRepositories(
  repositories: readonly RepositoryGrant[] | undefined,
): RuntimePlanRepositoryV2[] {
  return (repositories ?? [])
    .filter((repository) => repository.enabled)
    .map((repository) => ({
      id: repository.id,
      fullName: repository.fullName,
      ...(repository.allRepos ? { allRepos: true } : {}),
    }))
    .sort(compareBy('id'));
}

function surfaceForTurn(turn: NormalizedSlackTurn): RuntimePlanSurface {
  if (
    turn.source === 'dm_message' ||
    turn.channelType === 'im' ||
    turn.channelType === 'mpim'
  ) {
    return 'direct_message';
  }
  return 'channel_thread';
}

function computeHarnessRevision(
  plan: Omit<RuntimePlanV2, 'harnessRevision'> | RuntimePlanV2,
): string {
  return createHash('sha256')
    .update(canonicalJson({
      schemaVersion: plan.schemaVersion,
      continuityPolicy: plan.continuityPolicy,
      agentId: plan.agentId,
      ...(plan.actorMembershipId ? { actorMembershipId: plan.actorMembershipId } : {}),
      ...(plan.connectionAccountIds !== undefined
        ? { connectionAccountIds: plan.connectionAccountIds }
        : {}),
      ...(plan.connectionAuthorizations !== undefined
        ? { connectionAuthorizations: plan.connectionAuthorizations }
        : {}),
      ...(plan.connectionChoices !== undefined
        ? { connectionChoices: plan.connectionChoices }
        : {}),
      ...(plan.slackIdentityId ? { slackIdentityId: plan.slackIdentityId } : {}),
      ...(plan.configurationRevision
        ? { configurationRevision: plan.configurationRevision }
        : {}),
      model: plan.model,
      instructions: plan.instructions,
      memoryEpoch: plan.memoryEpoch,
      skills: plan.skills,
      mcpConnections: plan.mcpConnections,
      apiConnections: plan.apiConnections,
      repositories: plan.repositories,
      sandbox: plan.sandbox,
      artifactDestinationKind: plan.artifactDestination.kind,
    }))
    .digest('hex');
}

function parseConnectionAuthorization(value: unknown): RuntimePlanConnectionAuthorizationV2 {
  const record = exactRecord(value, 'connection authorization', [
    'providerId',
    'templateAccountId',
    'accounts',
  ]);
  return {
    providerId: boundedString(record.providerId, 'connection authorization providerId', 1, 128),
    templateAccountId: boundedString(
      record.templateAccountId,
      'connection authorization templateAccountId',
      1,
      160,
    ),
    accounts: arrayOf(record.accounts, 'connection authorization accounts', (candidate) => {
      const account = exactRecord(candidate, 'connection authorization account', [
        'id',
        'label',
        'purpose',
        'lifecycle',
      ], ['purpose']);
      return {
        id: boundedString(account.id, 'connection authorization account id', 1, 160),
        label: boundedString(account.label, 'connection authorization account label', 1, 120),
        ...(account.purpose === undefined
          ? {}
          : { purpose: boundedString(account.purpose, 'connection authorization account purpose', 1, 500) }),
        lifecycle: oneOf(account.lifecycle, 'connection authorization account lifecycle', [
          'pending',
          'ready',
          'needs_attention',
        ] as const),
      };
    }, 32),
  };
}

function parseConnectionChoice(value: unknown): RuntimePlanConnectionChoiceV2 {
  const record = exactRecord(value, 'connection choice', ['providerId', 'choices']);
  return {
    providerId: boundedString(record.providerId, 'connection choice providerId', 1, 128),
    choices: arrayOf(record.choices, 'connection choices', (candidate) => {
      const choice = exactRecord(candidate, 'connection choice account', [
        'label',
        'purpose',
        'scope',
      ], ['purpose']);
      return {
        label: boundedString(choice.label, 'connection choice label', 1, 120),
        ...(choice.purpose === undefined
          ? {}
          : { purpose: boundedString(choice.purpose, 'connection choice purpose', 1, 500) }),
        scope: oneOf(choice.scope, 'connection choice scope', ['team', 'personal'] as const),
      };
    }, 32),
  };
}

function parseConfigurationRevision(
  value: unknown,
): NonNullable<RuntimePlanV2['configurationRevision']> {
  const record = exactRecord(value, 'configurationRevision', ['agent', 'channel'], ['channel']);
  return {
    agent: positiveInteger(record.agent, 'configurationRevision.agent'),
    ...(record.channel === undefined
      ? {}
      : { channel: positiveInteger(record.channel, 'configurationRevision.channel') }),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseSkill(value: unknown, index: number): RuntimePlanSkillV2 {
  const record = exactRecord(value, `skills[${index}]`, ['name', 'description', 'instructions']);
  return {
    name: boundedString(record.name, `skills[${index}].name`, 1, 64),
    description: boundedString(record.description, `skills[${index}].description`, 1, 1_000),
    instructions: boundedString(record.instructions, `skills[${index}].instructions`, 1, 100_000),
  };
}

function parseMcpConnection(value: unknown, index: number): RuntimePlanMcpConnectionV2 {
  const label = `mcpConnections[${index}]`;
  const record = exactRecord(value, label, [
    'id',
    'url',
    'transport',
    'authMode',
    'headerNames',
    'allowedTools',
    'optional',
  ]);
  if (record.optional !== true && record.optional !== false) {
    throw new Error(`Runtime plan ${label}.optional must be boolean.`);
  }
  return {
    id: boundedString(record.id, `${label}.id`, 1, 120),
    url: httpsUrl(record.url, `${label}.url`),
    transport: oneOf(
      record.transport,
      `${label}.transport`,
      ['streamable-http', 'sse'] as const,
    ),
    authMode: oneOf(
      record.authMode,
      `${label}.authMode`,
      ['none', 'bearer', 'oauth'] as const,
    ),
    headerNames: sortedUniqueStringArray(record.headerNames, `${label}.headerNames`, 64),
    allowedTools: sortedUniqueStringArray(record.allowedTools, `${label}.allowedTools`, 256),
    optional: record.optional,
  };
}

function parseApiConnection(value: unknown, index: number): RuntimePlanApiConnectionV2 {
  const label = `apiConnections[${index}]`;
  const record = exactRecord(value, label, [
    'id',
    'allowedHosts',
    'pathPrefixes',
    'allowedMethods',
    'headerName',
    'headerValuePrefix',
    'authMode',
    'oauthProvider',
    'oauthScopes',
  ], ['headerValuePrefix', 'oauthProvider', 'oauthScopes']);
  const authMode = oneOf(
    record.authMode,
    `${label}.authMode`,
    ['credential', 'oauth'] as const,
  );
  const oauthProvider = record.oauthProvider === undefined
    ? undefined
    : oneOf(record.oauthProvider, `${label}.oauthProvider`, ['google'] as const);
  const oauthScopes = record.oauthScopes === undefined
    ? undefined
    : sortedUniqueStringArray(record.oauthScopes, `${label}.oauthScopes`, 128);
  if (authMode === 'oauth' && (!oauthProvider || !oauthScopes)) {
    throw new Error(`Runtime plan ${label} OAuth policy is incomplete.`);
  }
  if (authMode === 'credential' && (oauthProvider || oauthScopes)) {
    throw new Error(`Runtime plan ${label} credential policy has OAuth fields.`);
  }
  return {
    id: boundedString(record.id, `${label}.id`, 1, 120),
    allowedHosts: sortedUniqueStringArray(record.allowedHosts, `${label}.allowedHosts`, 128),
    pathPrefixes: sortedUniqueStringArray(record.pathPrefixes, `${label}.pathPrefixes`, 128),
    allowedMethods: sortedUniqueStringArray(record.allowedMethods, `${label}.allowedMethods`, 16),
    headerName: boundedString(record.headerName, `${label}.headerName`, 1, 128).toLowerCase(),
    ...(record.headerValuePrefix === undefined
      ? {}
      : { headerValuePrefix: boundedString(record.headerValuePrefix, `${label}.headerValuePrefix`, 0, 200) }),
    authMode,
    ...(oauthProvider ? { oauthProvider } : {}),
    ...(oauthScopes ? { oauthScopes } : {}),
  };
}

function parseRepository(value: unknown, index: number): RuntimePlanRepositoryV2 {
  const label = `repositories[${index}]`;
  const record = exactRecord(value, label, ['id', 'fullName', 'allRepos'], ['allRepos']);
  if (record.allRepos !== undefined && record.allRepos !== true) {
    throw new Error(`Runtime plan ${label}.allRepos must be true when present.`);
  }
  return {
    id: boundedString(record.id, `${label}.id`, 1, 120),
    fullName: boundedString(record.fullName, `${label}.fullName`, 1, 260),
    ...(record.allRepos === true ? { allRepos: true } : {}),
  };
}

function exactRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Runtime plan ${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`Runtime plan ${label} has unknown field ${key}.`);
    }
  }
  for (const key of allowed) {
    if (!optional.includes(key) && !(key in record)) {
      throw new Error(`Runtime plan ${label} is missing field ${key}.`);
    }
  }
  return record;
}

function arrayOf<T>(
  value: unknown,
  label: string,
  parse: (entry: unknown, index: number) => T,
  maximum: number,
): T[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`Runtime plan ${label} must be an array of at most ${maximum} entries.`);
  }
  return value.map(parse);
}

function boundedString(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new Error(`Runtime plan ${label} must be a string between ${minimum} and ${maximum} characters.`);
  }
  return value;
}

function slackIdentity(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 2, 80);
  if (!/^[A-Za-z0-9_-]+$/.test(parsed)) {
    throw new Error(`Runtime plan ${label} is invalid.`);
  }
  return parsed;
}

function conversationThread(value: unknown): string {
  const parsed = boundedString(value, 'conversation.threadTs', 2, 80);
  if (parsed !== 'dm' && !/^\d{1,20}\.\d{1,10}$/.test(parsed)) {
    throw new Error('Runtime plan conversation.threadTs is invalid.');
  }
  return parsed;
}

function opaqueAgentId(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 46, 46);
  if (!/^agent_[a-f0-9]{40}$/.test(parsed)) {
    throw new Error(`Runtime plan ${label} is invalid.`);
  }
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Runtime plan ${label} must be a positive integer.`);
  }
  return Number(value);
}

function sha256(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64, 64);
  if (!/^[a-f0-9]{64}$/.test(parsed)) {
    throw new Error(`Runtime plan ${label} must be a SHA-256 digest.`);
  }
  return parsed;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  label: string,
  allowed: T,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`Runtime plan ${label} is invalid.`);
  }
  return value as T[number];
}

function httpsUrl(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 8, 2_048);
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new Error(`Runtime plan ${label} is invalid.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`Runtime plan ${label} must be a credential-free HTTPS URL.`);
  }
  return parsed;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortedUniqueStringArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`Runtime plan ${label} must be an array of at most ${maximum} strings.`);
  }
  const values = value.map((entry, index) => boundedString(entry, `${label}[${index}]`, 1, 2_048));
  return sortedUnique(values);
}

function compareBy<K extends string>(key: K) {
  return <T extends Record<K, string>>(left: T, right: T): number =>
    left[key].localeCompare(right[key]);
}
