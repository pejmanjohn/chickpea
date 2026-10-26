import { createHash } from 'node:crypto';

import {
  hasCredentialLikeContent,
  hasDisallowedControlCharacter,
} from '../security/content-validation.ts';
import { isAgentId } from '../config/agent-id.ts';
import {
  isValidRepositoryGrantShape,
  REPOSITORY_GRANT_SHAPE_MESSAGE,
} from '../config/github-app.ts';
import {
  apiConnectionsWriteProblem,
  mcpConnectionsWriteProblem,
  skillsWriteProblem,
} from '../config/agent-write-rules.ts';
import type { RepositoryGrant } from '../config/types.ts';
import type { ManagementApiConnection, ManagementMcpConnection } from './agent-connections.ts';
import {
  AgentWriteRuleError,
  ManagementError,
  type ManagementActorContext,
  type ManagementApplyResult,
  type ManagementOperation,
  type ManagementOrigin,
  type ManagementObjectRef,
} from './types.ts';

const MAX_OPERATIONS = 25;
const MAX_OPERATION_BYTES = 128 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_KEYS = new Set([
  'apikey',
  'authorization',
  'bearertoken',
  'clientsecret',
  'credential',
  'credentialvalue',
  'oauthcode',
  'password',
  'privatekey',
  'refreshtoken',
  'secret',
  'token',
]);

export function managementResultFullyApplied(
  result: ManagementApplyResult | undefined,
): result is ManagementApplyResult {
  return result?.status === 'completed' &&
    result.outcomes.every(({ disposition }) => disposition === 'applied');
}

export function validateManagementOperations(
  operations: readonly ManagementOperation[],
): ManagementOperation[] {
  if (operations.length === 0 || operations.length > MAX_OPERATIONS) {
    throw invalid('A management request must contain between 1 and 25 operations.');
  }
  const serialized = JSON.stringify(operations);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_OPERATION_BYTES) {
    throw invalid('The management request is too large.');
  }
  if (hasDisallowedControlCharacter(serialized) || hasCredentialLikeContent(serialized)) {
    throw invalid('Management operations cannot contain credentials or control characters.');
  }
  rejectSecretKeys(operations);

  const seen = new Set<string>();
  const clientRefs = new Set<string>();
  const creationItems = new Map<string, string>();
  for (const operation of operations) {
    if (!SAFE_ID.test(operation.itemId) || seen.has(operation.itemId)) {
      throw invalid('Management item IDs must be unique safe identifiers.');
    }
    for (const dependency of operation.dependsOn ?? []) {
      if (!seen.has(dependency)) {
        throw invalid('Management dependencies must reference an earlier item.');
      }
    }
    if (operation.kind === 'create_agent' && operation.clientRef) {
      if (!SAFE_ID.test(operation.clientRef)) throw invalid('Agent clientRef is invalid.');
      if (clientRefs.has(operation.clientRef)) throw invalid('Agent clientRef values must be unique.');
      clientRefs.add(operation.clientRef);
    }
    if (operation.kind === 'create_agent') creationItems.set(operation.agent.id, operation.itemId);
    if (operation.kind === 'update_agent' && operation.expectedRevision === 0) {
      const creation = creationItems.get(operation.agentId);
      if (!creation || !operation.dependsOn?.includes(creation)) {
        throw invalid('An update_agent with expectedRevision 0 must depend on the create_agent of that Agent earlier in the call.');
      }
    }
    assertValidRepositoryGrants(
      operation.kind === 'create_agent'
        ? operation.agent.repositories
        : operation.kind === 'update_agent'
          ? operation.patch.repositories
          : undefined,
    );
    const agentFields = operation.kind === 'create_agent'
      ? operation.agent
      : operation.kind === 'update_agent' ? operation.patch : undefined;
    const problem = agentFields && agentWriteProblem(agentFields);
    if (problem) throw new AgentWriteRuleError(problem);
    if (operation.kind === 'create_agent' && !isAgentId(operation.agent.id)) {
      throw invalid('Agent IDs must start with a lowercase letter or digit and contain only lowercase letters, digits, underscores, or hyphens.');
    }
    for (const agentId of operationAgentIds(operation)) {
      if (!isAgentId(agentId)) {
        throw invalid('Agent IDs must start with a lowercase letter or digit and contain only lowercase letters, digits, underscores, or hyphens.');
      }
    }
    if (operation.kind === 'save_routine' && operation.schedule.kind === 'preserve' &&
        (!operation.routineId || !Number.isSafeInteger(operation.expectedVersion) || operation.expectedVersion! < 1)) {
      throw invalid('Preserving a schedule requires its ID and expected version.');
    }
    if (operation.kind === 'grant_agent_channel') {
      const hasClientRef = operation.agentClientRef !== undefined;
      const hasAgentId = operation.agentId !== undefined;
      if (hasClientRef === hasAgentId) {
        throw invalid('A Channel grant must provide exactly one of agentId or agentClientRef.');
      }
      if (operation.agentClientRef && !clientRefs.has(operation.agentClientRef)) {
        throw invalid('A Channel grant agentClientRef must reference an earlier Agent creation.');
      }
    }
    if (operation.kind === 'request_setup' &&
        ['api_connection', 'mcp_connection', 'repository_access'].includes(operation.target.kind)) {
      const target = operation.target as Extract<
        typeof operation.target,
        { kind: 'api_connection' | 'mcp_connection' | 'repository_access' }
      >;
      const hasClientRef = target.agentClientRef !== undefined;
      const hasAgentId = target.agentId !== undefined;
      if (hasClientRef === hasAgentId) {
        throw invalid('Setup must provide exactly one of agentId or agentClientRef.');
      }
      if (target.agentClientRef && !clientRefs.has(target.agentClientRef)) {
        throw invalid('A setup agentClientRef must reference an earlier Agent creation.');
      }
    }
    seen.add(operation.itemId);
  }
  return [...operations];
}

/**
 * Refuses repository grants the runtime would silently drop (for example
 * `allRepos: true` with a repository fullName), so the proposer re-proposes the
 * correct shape instead of saving a grant that removes all repository access.
 */
export function assertValidRepositoryGrants(
  repositories: readonly Pick<RepositoryGrant, 'installationId' | 'accountLogin' | 'fullName' | 'allRepos'>[] | undefined,
): void {
  if (repositories?.some((grant) =>
    !isValidRepositoryGrantShape(grant, { requireInstallation: true }))) {
    throw invalid(REPOSITORY_GRANT_SHAPE_MESSAGE);
  }
}

/**
 * Where a requester-chosen idempotency key is unique: one MCP client, one
 * Admin session, or one Slack conversation, under the acting Agent. A retry
 * there replays; the same key from another client or door is a new request.
 * An approval resumes the request in the conversation that proposed it.
 */
export function managementIdempotencyScope(
  actor: Pick<ManagementActorContext, 'origin' | 'actingAgentId'>,
): string {
  return `${createHash('sha256').update(managementApprovalScopeKey(actor)).digest('hex').slice(0, 32)}.`;
}

export function managementStorageIdempotencyKey(
  actor: Pick<ManagementActorContext, 'origin' | 'actingAgentId'>,
  publicKey: string,
): string {
  return `${managementIdempotencyScope(actor)}${publicKey}`;
}

function operationAgentIds(operation: ManagementOperation): string[] {
  switch (operation.kind) {
    case 'update_agent':
    case 'delete_agent':
    case 'restore_agent':
    case 'revoke_agent_channel':
    case 'update_agent_memory':
    case 'save_routine':
      return [operation.agentId];
    case 'archive_agent':
      return [operation.agentId, ...(operation.replacementDefaultAgentId
        ? [operation.replacementDefaultAgentId]
        : [])];
    case 'grant_agent_channel':
      return operation.agentId ? [operation.agentId] : [];
    case 'request_setup':
      return 'agentId' in operation.target && operation.target.agentId
        ? [operation.target.agentId]
        : [];
    default:
      return [];
  }
}

export function managementOperationDigest(operations: readonly ManagementOperation[]): string {
  return createHash('sha256').update(canonicalJson(operations)).digest('hex');
}

export function managementOriginKey(origin: ManagementOrigin): string {
  if (origin.kind === 'slack') {
    const base = `slack:${origin.workspaceId}:${origin.channelId}:${origin.threadTs}`;
    return origin.conversationKind === 'im' || origin.conversationKind === 'mpim'
      ? `${base}:${origin.conversationKind}`
      : base;
  }
  if (origin.kind === 'mcp') return `mcp:${origin.clientId}`;
  return `admin:${origin.sessionId}`;
}

export function managementActorOriginKey(
  context: Pick<ManagementActorContext, 'origin' | 'actingAgentId'>,
): string {
  const origin = managementOriginKey(context.origin);
  return context.actingAgentId ? `${origin}:agent:${context.actingAgentId}` : origin;
}

/**
 * Stable approval scope for one human conversation. A top-level DM follow-up
 * receives a new Slack thread timestamp, but remains in the same DM and under
 * the same acting Agent. Named-channel approvals stay bound to one thread.
 */
export function managementApprovalScopeKey(
  context: Pick<ManagementActorContext, 'origin' | 'actingAgentId'>,
): string {
  const { origin } = context;
  let scope: string;
  if (origin.kind !== 'slack') {
    scope = managementOriginKey(origin);
  } else if (origin.conversationKind === 'im') {
    scope = `slack:${origin.workspaceId}:${origin.channelId}:dm`;
  } else if (origin.conversationKind === 'mpim') {
    scope = `slack:${origin.workspaceId}:${origin.channelId}:mpim`;
  } else {
    scope = `slack:${origin.workspaceId}:${origin.channelId}:${origin.threadTs}`;
  }
  return context.actingAgentId ? `${scope}:agent:${context.actingAgentId}` : scope;
}

export function effectiveConfigurationRevision(refs: readonly ManagementObjectRef[]): string {
  const normalized = refs.map((ref) => ({
    kind: ref.kind,
    id: ref.id,
    revision: ref.revision ?? 0,
  })).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
  return createHash('sha256').update(canonicalJson(normalized)).digest('hex').slice(0, 32);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, member]) => [key, sortJson(member)]));
}

function rejectSecretKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const member of value) rejectSecretKeys(member);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replaceAll(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (FORBIDDEN_KEYS.has(normalized)) {
      throw invalid(`Management operations cannot contain ${key}.`);
    }
    rejectSecretKeys(member);
  }
}

/**
 * The Agent write rules Admin enforces, plus the shape a connection account
 * can hold. The runtime keeps the last skill of a name, so duplicates would
 * also make a preview mislead.
 */
function agentWriteProblem(fields: {
  skills?: Parameters<typeof skillsWriteProblem>[0] | undefined;
  mcpServers?: ManagementMcpConnection[] | undefined;
  apiConnections?: ManagementApiConnection[] | undefined;
}): string | undefined {
  return (fields.skills && skillsWriteProblem(fields.skills)) ??
    (fields.mcpServers && (mcpConnectionsWriteProblem(fields.mcpServers) ??
      fields.mcpServers.map(connectionAccountShapeProblem).find(Boolean))) ??
    (fields.apiConnections && (apiConnectionsWriteProblem(fields.apiConnections) ??
      fields.apiConnections.map(connectionAccountShapeProblem).find(Boolean)));
}

function connectionAccountShapeProblem(
  connection: ManagementMcpConnection | ManagementApiConnection,
): string | undefined {
  if (!connection.enabled) {
    return `Connection ${connection.id} cannot be turned off. Remove it to stop the Agent using it.`;
  }
  if ('url' in connection && (connection.authMode === 'none'
    ? connection.headerNames.length > 1
    : connection.headerNames.length > 0)) {
    return `Connection ${connection.id} holds one credential: a bearer token, an OAuth sign-in, or with authMode none the value of one header.`;
  }
  return undefined;
}

function invalid(message: string): ManagementError {
  return new ManagementError('invalid_request', message);
}
