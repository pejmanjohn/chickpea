import { createHash, randomUUID } from 'node:crypto';

import type { z } from 'zod';

import { isMcpToolReviewRequired } from '../../config/mcp-access.ts';
import { keptToolPolicies } from '../../config/mcp-tool-policy.ts';
import { CONNECTION_CATALOG_PRESETS, resolveConnectorCatalogPreset } from '../../config/presets.ts';
import { ADMIN_PATH, adminOrigin } from '../admin-links.ts';
import type {
  ManagementActorContext,
  ManagementOperation,
  ManagementWorkspaceSnapshot,
  PrepareConnectorSetupResult,
} from '../types.ts';
import {
  agentSummary,
  applyChange,
  callOperationId,
  changeResult,
  CONFIRMATION_LIFETIME_MS,
  requireVersion,
  type ChangeResult,
} from './changes.ts';
import { fail } from './conventions.ts';
import { agentVersion, catalogConnection, connectionRows, forManagedAgent, requireAgent, type FiveZeroDeps } from './reads.ts';
import type * as schemas from './schemas.ts';
import { editableAgent } from './writes.ts';

/**
 * Connections and repositories. A catalog service gets the connector setup
 * link Admin hands out, from the same service methods; a custom API or MCP
 * connection gets a request_setup link. No tool takes a key.
 */

type In<T extends z.ZodType> = z.output<T>;
type SnapshotAgent = ManagementWorkspaceSnapshot['agents'][number];
type SetupTarget = Extract<ManagementOperation, { kind: 'request_setup' }>['target'];
type Setup = NonNullable<ChangeResult['setup']>;
type ConnectionRow = ReturnType<typeof connectionRows>[number];

/** For the model: hand the link over. Only a link with a setupToken can be followed. */
function setupNextStep(setups: readonly Setup[]): string {
  return [
    setups.length === 1 ? 'Give the person the link; they finish there.' : 'Give the person each link; they finish there.',
    'Never ask for the key or password itself.',
    ...(setups.some(({ setupToken }) => setupToken) ? ['get_setup_status with a setupToken says when it is done.'] : []),
  ].join(' ');
}

async function readAgent(deps: FiveZeroDeps, context: ManagementActorContext, agentId: string, version?: string) {
  const snapshot = await deps.service.inspectWorkspace(context);
  const agent = requireAgent(snapshot, agentId);
  if (version !== undefined) requireVersion(agentVersion(snapshot, agent), version, agent.name, 'get_agent');
  return { snapshot, agent };
}

function needsSetup(
  agent: ChangeResult['agent'],
  setup: Setup,
  summary: string,
): ChangeResult {
  return { status: 'needs_setup', summary, nextStep: setupNextStep([setup]), ...(agent ? { agent } : {}), setup };
}

/**
 * Chickpea's page for a new connection asks whose account it is, so its
 * owner is named only where it is fixed: a reconnect keeps its account's,
 * and Admin's page is for the one asked for.
 */
function linkFrom(result: PrepareConnectorSetupResult): Setup {
  const fixed = result.reconnect !== undefined || result.setupOperationId === undefined;
  return {
    url: result.handoffUrl,
    ...(result.setupOperationId ? { setupToken: result.setupOperationId } : {}),
    what: result.connector.name,
    ...(fixed ? { owner: result.ownerKind } : {}),
  };
}

/**
 * A fresh setup link for one connection or repository. It is never replayed:
 * a stored result keeps no link, so a retry gets a new one.
 */
async function issueSetup(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  target: SetupTarget,
  what: string,
): Promise<Setup> {
  const nonce = randomUUID();
  const result = await deps.service.applyWorkspaceChanges({
    context,
    idempotencyKey: `setup:${nonce}`,
    operations: [{ itemId: 'setup', kind: 'request_setup', target }],
    operationId: callOperationId(context, 'request_setup', { target, nonce }),
    // A setup applies at once today. Were it ever to wait for confirmation, it expires as every 5.0 one does.
    confirmationLifetimeMs: CONFIRMATION_LIFETIME_MS,
  });
  const outcome = 'outcomes' in result ? result.outcomes[0] : undefined;
  if (outcome?.disposition === 'setup_required' && outcome.setupUrl && outcome.setupOperationId) {
    return { url: outcome.setupUrl, setupToken: outcome.setupOperationId, what };
  }
  await changeResult(deps, context, result);
  return fail('temporarily_unavailable', 'Chickpea could not make the setup link.', { nextStep: 'Try the same call again in a moment.' });
}

export async function connectService(
  deps: FiveZeroDeps,
  input: In<typeof schemas.connectServiceInput>,
): Promise<ChangeResult> {
  if (input.custom) return connectCustom(deps, input, input.custom);
  const context = await deps.context();
  const { snapshot, agent } = await readAgent(deps, context, input.agentId);
  const connector = resolveConnectorCatalogPreset(input.service!);
  if (!connector) {
    fail('invalid_input', `Chickpea does not list a service called ${input.service}.`, {
      nextStep: 'Call list_services and send a service from it, or connect it with custom.',
    });
  }
  const ownerKind = input.owner === 'team' ? 'team' : 'member';
  if (ownerKind === 'team' && snapshot.caller.role === 'member') teamConnectionRefused(`connect ${connector.name}`);
  const existing = catalogConnection(agent, connector, ownerKind);
  if (existing) alreadyConnected(agent, existing);
  const setup = await forManagedAgent(deps.service.prepareConnectorSetup(context, {
    agentId: agent.id,
    connector: connector.id,
    ownerKind,
  }));
  // The service signs an existing connection in again; that is reconnect_service's to do.
  if (setup.reconnect) {
    if (setup.setupOperationId) await deps.service.revokeSetupLink(context, setup.setupOperationId);
    alreadyConnected(agent, { connectionId: setup.reconnect.connectionId, name: setup.reconnect.label });
  }
  const { agent: summary } = await agentSummary(deps, context, agent.id);
  return needsSetup(summary, linkFrom(setup), `Open the link to connect ${connector.name} to ${agent.name}.`);
}

function alreadyConnected(agent: SnapshotAgent, connection: { connectionId: string; name: string }): never {
  return fail('invalid_input', `${agent.name} already has ${connection.name}, so no link was made.`, {
    nextStep: 'To sign it in again or replace its key, call reconnect_service with its connectionId.',
    fix: {
      label: `Reconnect ${connection.name}`,
      tool: 'reconnect_service',
      arguments: { agentId: agent.id, connectionId: connection.connectionId },
    },
  });
}

type Custom = In<typeof schemas.zCustomConnection>;
type CustomChanges = In<typeof schemas.updateConnectionInput>['changes'];

/**
 * A new custom connection's ID: its name's slug, with the next free suffix
 * when another connection holds it, as two names with no Latin letters would.
 * An account's ID starts with connection_, so a new connection's never does.
 */
function freeConnectionId(name: string, taken: ReadonlySet<string>): string {
  const slug = (name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'connection')
    .replace(/^connection_/, 'connection-');
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`;
    const id = `${slug.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function apiEntry(id: string, custom: Custom): SnapshotAgent['apiConnections'][number] {
  return {
    id,
    displayName: custom.name,
    allowedHosts: custom.hosts!,
    pathPrefixes: custom.pathPrefixes ?? [],
    headerName: custom.headerName ?? 'Authorization',
    ...(custom.headerValuePrefix !== undefined || custom.headerName === undefined
      ? { headerValuePrefix: custom.headerValuePrefix ?? 'Bearer ' }
      : {}),
    allowedMethods: custom.methods ?? ['GET', 'HEAD'],
    enabled: true,
    authMode: 'credential',
    ...(custom.guide ? { guide: custom.guide } : {}),
  };
}

/** The header a custom MCP server's key goes in, when it is not Authorization. */
function mcpKeyHeader(custom: Custom): string | undefined {
  return (custom.auth ?? 'key') === 'key' && custom.headerName && custom.headerName.toLowerCase() !== 'authorization'
    ? custom.headerName
    : undefined;
}

/**
 * A custom MCP server's key goes as "Bearer <key>" in Authorization, or bare
 * in another header. Its connection stores no other prefix, so one is refused
 * rather than dropped.
 */
function refuseMcpPrefix(custom: Custom): void {
  const prefix = custom.headerValuePrefix?.trim();
  if (custom.kind !== 'mcp' || !prefix) return;
  const auth = custom.auth ?? 'key';
  const sent = auth !== 'key' ? undefined : mcpKeyHeader(custom) ? '' : 'bearer';
  if (prefix.toLowerCase() === sent) return;
  fail('invalid_input', `A custom MCP connection sends its key as "Bearer <key>" in Authorization, or with no prefix in another header, so ${custom.name} cannot send "${prefix}" before it.`, {
    nextStep: auth === 'key'
      ? 'Leave out headerValuePrefix to connect it one of those ways, or tell the person Chickpea cannot send that prefix to a custom MCP server.'
      : 'Leave out headerValuePrefix: this server takes no key.',
  });
}

function mcpEntry(id: string, custom: Custom): SnapshotAgent['mcpServers'][number] {
  const auth = custom.auth ?? 'key';
  const header = mcpKeyHeader(custom);
  return {
    id,
    displayName: custom.name,
    url: custom.url!,
    transport: 'streamable-http',
    // A key in Authorization is a bearer token; in another header, that header carries it.
    authMode: auth === 'sign_in' ? 'oauth' : auth === 'key' && !header ? 'bearer' : 'none',
    headerNames: header ? [header] : [],
    enabled: true,
    allowedTools: custom.allowedTools ?? [],
    ...(custom.guide ? { guide: custom.guide } : {}),
  };
}

/** The setup target a custom connection's key or sign-in takes. */
function connectionTarget(agentId: string, kind: 'api' | 'mcp', connectionId: string, checkPath?: string): SetupTarget {
  return kind === 'api'
    ? { kind: 'api_connection', agentId, connectionId, ...(checkPath ? { path: checkPath } : {}) }
    : { kind: 'mcp_connection', agentId, connectionId };
}

/**
 * Adds the connection to the Agent, then makes its setup link: the add is
 * stored under the call's key, the link is new on every call.
 */
async function connectCustom(
  deps: FiveZeroDeps,
  input: In<typeof schemas.connectServiceInput>,
  custom: Custom,
): Promise<ChangeResult> {
  refuseMcpPrefix(custom);
  const context = await deps.context();
  let addedId: string | undefined;
  const added = await applyChange(deps, context, {
    tool: 'connect_service',
    args: input,
    operations: async () => {
      const { agent } = await readAgent(deps, context, input.agentId, input.version);
      const rows = connectionRows(agent);
      const existing = rows.find(({ name }) => sameName(name, custom.name));
      if (existing) alreadyConnected(agent, existing);
      const id = freeConnectionId(custom.name, new Set([
        ...rows.map(({ connectionId }) => connectionId),
        ...(agent.connections ?? []).map(({ providerId }) => providerId),
      ]));
      addedId = id;
      const patch = custom.kind === 'api'
        ? { apiConnections: [...agent.apiConnections, apiEntry(id, custom)] }
        : { mcpServers: [...agent.mcpServers, mcpEntry(id, custom)] };
      return [{ itemId: 'connect_service', kind: 'update_agent', agentId: agent.id, expectedRevision: agent.revision, patch }];
    },
  });
  const saved = await changeResult(deps, context, added, { agentId: input.agentId, summary: `Added ${custom.name}.` });
  // A replay runs no operations; the connection it added is the one with this name.
  return withSetup(deps, context, saved, input.agentId,
    (row) => addedId ? row.connectionId === addedId : sameName(row.name, custom.name), input.checkPath);
}

/** The change's result, or the setup link its connection now waits for. */
async function withSetup(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  saved: ChangeResult,
  agentId: string,
  isConnection: (row: ConnectionRow) => boolean,
  checkPath: string | undefined,
): Promise<ChangeResult> {
  if (saved.status !== 'done') return saved;
  const { agent } = await readAgent(deps, context, agentId);
  const row = connectionRows(agent).find(isConnection);
  if (row?.status !== 'waiting_for_setup') return saved;
  const mcp = agent.mcpServers.find(({ id }) => id === row.connectionId);
  const setup = {
    ...await issueSetup(deps, context, connectionTarget(agentId, mcp ? 'mcp' : 'api', row.connectionId, checkPath), row.name),
    ...(row.owner ? { owner: row.owner } : {}),
  };
  const finish = mcp?.authMode === 'oauth' ? 'sign it in' : 'add its key';
  return { ...saved, status: 'needs_setup', summary: `${saved.summary} Open the link to ${finish}.`, nextStep: setupNextStep([setup]), setup };
}

export async function reconnectService(
  deps: FiveZeroDeps,
  input: In<typeof schemas.reconnectServiceInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const { snapshot, agent } = await readAgent(deps, context, input.agentId);
  const row = connectionRows(agent).find(({ connectionId }) => connectionId === input.connectionId);
  if (!row) {
    fail('not_found', `${agent.name} no longer has that connection.`, { nextStep: 'Call get_agent for its connectionIds.' });
  }
  const { agent: summary } = await agentSummary(deps, context, agent.id);
  const laneEntry = [...agent.apiConnections, ...agent.mcpServers].find(({ id }) => id === row.connectionId);
  const lane = agent.apiConnections.some(({ id }) => id === row.connectionId) ? 'api'
    : agent.mcpServers.some(({ id }) => id === row.connectionId) ? 'mcp' : undefined;
  const laneLink = async () => needsSetup(
    summary,
    {
      ...await issueSetup(deps, context, connectionTarget(agent.id, lane!, row.connectionId, input.checkPath), row.name),
      ...(row.owner ? { owner: row.owner } : {}),
    },
    `Open the link to reconnect ${row.name}.`,
  );
  const lanePreset = laneEntry?.presetId ? resolveConnectorCatalogPreset(laneEntry.presetId) : undefined;
  // A catalog connection whose sign-in was left unfinished or needs attention gets the page connect_service gives.
  const catalogPreset = lanePreset && !('managedToolkit' in lanePreset) && row.status !== 'ready' ? lanePreset : undefined;
  if (lane && !catalogPreset) return laneLink();
  // A catalog sign-in: the same link the service's connector setup makes for it.
  const account = agent.connections?.find(({ id, providerId }) => id === row.connectionId || providerId === row.connectionId);
  const connector = catalogPreset?.id ?? (account?.reconnect?.tool === 'prepare_connector_setup'
    ? account.reconnect.connector
    : CONNECTION_CATALOG_PRESETS.find((preset) => 'managedToolkit' in preset &&
        (preset.managedToolkit === account?.providerId || preset.id === account?.providerId))?.id);
  if (!account || !connector) cannotReconnect(deps, agent.id, row.name);
  if (account.ownerKind === 'team' && snapshot.caller.role === 'member') teamConnectionRefused(`reconnect ${row.name}`);
  const setup = await forManagedAgent(deps.service.prepareConnectorSetup(context, {
    agentId: agent.id,
    connector,
    ownerKind: account.ownerKind,
  }));
  // A catalog connection the setup page cannot serve, such as Sentry, keeps its own sign-in link.
  if (setup.reconnect?.connectionId !== account.id || lane && !setup.setupOperationId) {
    if (setup.setupOperationId) await deps.service.revokeSetupLink(context, setup.setupOperationId);
    if (lane) return laneLink();
    cannotReconnect(deps, agent.id, row.name);
  }
  return needsSetup(summary, linkFrom(setup), `Open the link to reconnect ${row.name}.`);
}

function teamConnectionRefused(what: string): never {
  return fail('not_allowed', `Only an Owner or Admin can ${what} for the whole team.`, {
    nextStep: 'Connect the person\'s own account with owner me, or tell them an Owner or Admin can do it.',
  });
}

function cannotReconnect(deps: FiveZeroDeps, agentId: string, name: string): never {
  const origin = adminOrigin(deps.baseUrl);
  return fail('not_allowed', `Chickpea cannot make a link to reconnect ${name} for you.`, {
    nextStep: 'Only the person who connected it, or an Owner or Admin for a team connection, can reconnect it.',
    ...(origin ? { fix: { label: 'Open the Agent in Admin', url: `${origin}${ADMIN_PATH}/agents/${encodeURIComponent(agentId)}` } } : {}),
  });
}

const API_CHANGES = { name: 'displayName', hosts: 'allowedHosts', pathPrefixes: 'pathPrefixes', methods: 'allowedMethods', headerName: 'headerName', headerValuePrefix: 'headerValuePrefix', guide: 'guide' } as const;
const MCP_CHANGES = { name: 'displayName', url: 'url', allowedTools: 'allowedTools', guide: 'guide' } as const;
/** An MCP connection's marks, which markedTools applies after the fields above. */
const MCP_MARKS: readonly string[] = ['readTools', 'writeTools'] satisfies Array<keyof CustomChanges>;

/** The changed entry, or a refusal naming a field the connection's kind does not have. */
function changedEntry<T extends object>(
  entry: T,
  changes: CustomChanges,
  fields: Readonly<Record<string, string>>,
  kind: string,
  others: readonly string[] = [],
): T {
  const wrong = Object.keys(changes).filter((field) => !(field in fields) && !others.includes(field));
  if (wrong.length) fail('invalid_input', `A custom ${kind} connection has no ${wrong.join(' or ')} to change.`);
  return {
    ...entry,
    ...Object.fromEntries(Object.entries(changes).flatMap(([field, value]) => field in fields ? [[fields[field]!, value]] : [])),
  };
}

/**
 * The MCP connection with the named tools marked as reads or writes, the
 * tool policy Admin's API and the Slack door declare; a tool not named keeps its mark
 * while it stays allowed. A tool this change dis-allows or allows again loses
 * its mark, and every tool keeps its argument limits (keptToolPolicies). Only
 * an allowed tool can be marked, and never as a read when its server says it
 * writes. A practice run calls only the tools marked as reads.
 */
function markedTools(
  stored: SnapshotAgent['mcpServers'][number],
  entry: SnapshotAgent['mcpServers'][number],
  changes: CustomChanges,
  discovered: ReadonlyArray<{ name: string; readOnlyHint?: boolean }> = [],
) {
  const { readTools = [], writeTools = [] } = changes;
  // The server's own word that a tool writes stands: a practice run must never call it.
  const writes = readTools.filter((tool) => discovered.some(({ name, readOnlyHint }) => name === tool && readOnlyHint === false));
  if (writes.length) {
    fail('invalid_input', `${writes.join(', ')} ${writes.length === 1 ? 'says it changes' : 'say they change'} things, so ${writes.length === 1 ? 'it' : 'they'} can't be marked as a read.`, {
      nextStep: `Leave ${writes.length === 1 ? 'it' : 'them'} out of readTools. A practice run never calls a tool that is not marked as a read.`,
    });
  }
  if ((changes.readTools || changes.writeTools) && readTools.length + writeTools.length === 0) {
    fail('invalid_input', 'An empty readTools or writeTools marks nothing, so nothing changed.', {
      nextStep: 'Name at least one of its allowedTools from get_agent in readTools or writeTools, or leave both out.',
    });
  }
  const both = readTools.filter((tool) => writeTools.includes(tool));
  if (both.length) fail('invalid_input', `Mark ${both.join(', ')} as a read or as a write, not both.`);
  const unknown = [...readTools, ...writeTools].filter((tool) => !entry.allowedTools.includes(tool));
  if (unknown.length) {
    fail('invalid_input', `${entry.displayName} does not allow ${unknown.join(', ')}, so it cannot be marked.`, {
      nextStep: entry.allowedTools.length > 0
        ? `Mark only its allowedTools from get_agent: ${entry.allowedTools.join(', ')}.`
        : 'It allows no tools yet; once its setup finishes, get_agent lists them.',
    });
  }
  const toolPolicies = keptToolPolicies(stored, entry.allowedTools);
  for (const [tools, effect] of [[readTools, 'read'], [writeTools, 'write']] as const) {
    for (const tool of tools) toolPolicies[tool] = { ...toolPolicies[tool], effect };
  }
  const { toolPolicies: _stored, ...unmarked } = entry;
  return Object.keys(toolPolicies).length > 0 ? { ...unmarked, toolPolicies } : unmarked;
}

/**
 * A catalog MCP service with its tools marked, the one change update_connection
 * makes to it: its server, key and tool list are Chickpea's. It takes the
 * custom connection's marks, check and write. A reviewed connector (Bugsnag,
 * Meta Ads) is not one: Chickpea's review marks its tools.
 */
function catalogMarks(agent: SnapshotAgent, entry: SnapshotAgent['mcpServers'][number], changes: CustomChanges) {
  const others = Object.keys(changes).filter((field) => !MCP_MARKS.includes(field));
  if (others.length) {
    fail('invalid_input', `${entry.displayName} is a catalog service, so update_connection changes only its readTools and writeTools.`, {
      nextStep: `Leave out ${others.join(' and ')}. reconnect_service signs it in again.`,
    });
  }
  return markedTools(entry, entry, changes, agent.connectionStatus.find(({ kind, id }) => kind === 'mcp' && id === entry.id)?.discoveredTools);
}

/**
 * Changes a custom connection's settings, or a catalog MCP service's marks.
 * A change to where or how the key is sent (hosts, paths, methods, header,
 * prefix, or an MCP server's URL) makes the service delete the saved key, so
 * the result carries a link to enter it again.
 */
export async function updateConnection(
  deps: FiveZeroDeps,
  input: In<typeof schemas.updateConnectionInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const saved = await applyChange(deps, context, {
    tool: 'update_connection',
    args: input,
    operations: async () => {
      const { agent } = await readAgent(deps, context, input.agentId, input.version);
      const api = agent.apiConnections.find(({ id }) => id === input.connectionId);
      const mcp = agent.mcpServers.find(({ id }) => id === input.connectionId);
      if (mcp?.presetId && !isMcpToolReviewRequired(mcp)) {
        const patch = { mcpServers: agent.mcpServers.map((entry) => entry === mcp ? catalogMarks(agent, entry, input.changes) : entry) };
        return [{ itemId: 'update_connection', kind: 'update_agent', agentId: agent.id, expectedRevision: agent.revision, patch }];
      }
      if (mcp?.presetId) {
        const origin = adminOrigin(deps.baseUrl);
        fail('invalid_input', `${mcp.displayName}'s tools are chosen on the Agent's page in Admin, so update_connection doesn't mark them.`, {
          nextStep: 'Its tools are chosen on the Agent\'s page in Admin, where Chickpea marks the ones that only read.',
          ...(origin ? { fix: { label: 'Open the Agent in Admin', url: `${origin}${ADMIN_PATH}/agents/${encodeURIComponent(agent.id)}` } } : {}),
        });
      }
      if ((!api && !mcp) || api?.presetId) {
        fail('invalid_input', `${agent.name} has no custom connection or catalog MCP service with that connectionId.`, {
          nextStep: 'Send a custom_api or custom_mcp connectionId from get_agent, or a service\'s that lists tools. Another catalog service\'s settings are Chickpea\'s; reconnect_service signs it in again.',
        });
      }
      const patch = api
        ? { apiConnections: agent.apiConnections.map((entry) => entry === api ? changedEntry(entry, input.changes, API_CHANGES, 'API') : entry) }
        : {
            mcpServers: agent.mcpServers.map((entry) => entry === mcp
              ? markedTools(entry, changedEntry(entry, input.changes, MCP_CHANGES, 'MCP', MCP_MARKS), input.changes,
                agent.connectionStatus.find(({ kind, id }) => kind === 'mcp' && id === entry.id)?.discoveredTools)
              : entry),
          };
      return [{ itemId: 'update_connection', kind: 'update_agent', agentId: agent.id, expectedRevision: agent.revision, patch }];
    },
  });
  const result = await changeResult(deps, context, saved, { agentId: input.agentId, summary: 'Saved the connection.' });
  // A catalog service's sign-in is reconnect_service's, never a custom key link.
  return withSetup(deps, context, result, input.agentId,
    ({ connectionId, kind }) => connectionId === input.connectionId && kind !== 'service', input.checkPath);
}

export async function removeConnection(
  deps: FiveZeroDeps,
  input: In<typeof schemas.removeConnectionInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const result = await applyChange(deps, context, {
    tool: 'remove_connection',
    args: input,
    operations: async () => {
      const agent = await editableAgent(deps, context, input.agentId);
      return [{ itemId: 'remove_connection', kind: 'disconnect_connection', agentId: agent.id, connectionId: input.connectionId }];
    },
  });
  return changeResult(deps, context, result, { agentId: input.agentId, summary: 'Removed the connection.' });
}

type Grant = SnapshotAgent['repositories'][number];

/**
 * A new grant's ID: its repository's slug, readable in Admin, and a digest of
 * the exact name, because acme/x-y and acme-x/y share a slug.
 */
function grantId(fullName: string): string {
  const name = fullName.toLowerCase();
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 12);
  return `repo_${name.replace(/[^a-z0-9]+/g, '_').slice(0, 100)}_${digest}`;
}

/**
 * The Agent's repositories afterwards. A repository it has keeps its grant;
 * a new one waits for GitHub access through a setup link. Every repository of
 * an account names a GitHub installation, which only Admin chooses.
 */
function repositoryGrants(deps: FiveZeroDeps, agent: SnapshotAgent, asked: ReadonlyArray<{ repository: string }>): Grant[] {
  const unique = new Map(asked.map(({ repository }) => [repository.toLowerCase(), repository]));
  return [...unique.values()].map((repository) => {
    const [owner] = repository.split('/') as [string];
    if (repository.endsWith('/*')) {
      const held = agent.repositories.find((grant) => grant.allRepos === true && grant.accountLogin.toLowerCase() === owner.toLowerCase());
      if (held) return { ...held, enabled: true };
      const origin = adminOrigin(deps.baseUrl);
      return fail('invalid_input', `Every repository of ${owner} is granted in Admin, which picks the GitHub installation. Nothing changed.`, {
        nextStep: 'Name the repositories one by one as owner/repo, or send the person to the Agent in Admin.',
        ...(origin ? { fix: { label: 'Open the Agent in Admin', url: `${origin}${ADMIN_PATH}/agents/${encodeURIComponent(agent.id)}` } } : {}),
      });
    }
    const held = agent.repositories.find((grant) => grant.allRepos !== true && grant.fullName.toLowerCase() === repository.toLowerCase());
    return held
      ? { ...held, enabled: true }
      : { id: grantId(repository), installationId: null, accountLogin: owner, fullName: repository, enabled: true };
  });
}

export async function setAgentRepositories(
  deps: FiveZeroDeps,
  input: In<typeof schemas.setAgentRepositoriesInput>,
): Promise<z.infer<typeof schemas.setAgentRepositoriesOutput>> {
  const context = await deps.context();
  const saved = await applyChange(deps, context, {
    tool: 'set_agent_repositories',
    args: input,
    operations: async () => {
      const { agent } = await readAgent(deps, context, input.agentId, input.version);
      return [{
        itemId: 'set_agent_repositories',
        kind: 'update_agent',
        agentId: agent.id,
        expectedRevision: agent.revision,
        patch: { repositories: repositoryGrants(deps, agent, input.repositories) },
      }];
    },
  });
  const result = await changeResult(deps, context, saved, { agentId: input.agentId, summary: 'Saved the Agent\'s repositories.' });
  if (result.status !== 'done') return result;
  const { agent } = await readAgent(deps, context, input.agentId);
  const waiting = agent.repositories.filter(({ enabled, installationId }) => enabled && installationId === null);
  if (waiting.length === 0) return result;
  // One at a time: each link is its own request in the management store.
  const links: Setup[] = [];
  for (const grant of waiting) {
    links.push(await issueSetup(deps, context, { kind: 'repository_access', agentId: agent.id, repositoryId: grant.id }, grant.fullName));
  }
  const [first, ...rest] = links;
  return {
    ...result,
    status: 'needs_setup',
    summary: `${result.summary} ${waiting.length === 1 ? 'It needs' : `${waiting.length} need`} GitHub access before the Agent can use ${waiting.length === 1 ? 'it' : 'them'}.`,
    nextStep: setupNextStep(links),
    setup: first!,
    ...(rest.length ? { moreSetups: rest } : {}),
  };
}
