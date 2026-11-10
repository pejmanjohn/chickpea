import { randomUUID } from 'node:crypto';

import type { z } from 'zod';

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
  requireVersion,
  type ChangeResult,
} from './changes.ts';
import { fail } from './conventions.ts';
import { agentVersion, connectionRows, forManagedAgent, requireAgent, type FiveZeroDeps } from './reads.ts';
import type * as schemas from './schemas.ts';
import { editableAgent } from './writes.ts';

/**
 * Connections and repositories. A catalog service gets the link
 * prepare_connector_setup hands out, from the same service methods; a custom
 * API or MCP connection gets a request_setup link. No tool takes a key.
 */

type In<T extends z.ZodType> = z.output<T>;
type SnapshotAgent = ManagementWorkspaceSnapshot['agents'][number];
type SetupTarget = Extract<ManagementOperation, { kind: 'request_setup' }>['target'];
type Setup = NonNullable<ChangeResult['setup']>;

const SETUP_NEXT_STEP = 'Give the person the link; they finish there. Never ask for the key or password itself. get_setup_status with the setupToken says when it is done.';

async function readAgent(deps: FiveZeroDeps, context: ManagementActorContext, agentId: string, version?: string) {
  const snapshot = await deps.service.inspectWorkspace(context);
  const agent = requireAgent(snapshot, agentId);
  if (version !== undefined) requireVersion(agentVersion(snapshot, agent), version, agent.name, 'get_agent');
  return { snapshot, agent };
}

type Connector = NonNullable<ReturnType<typeof resolveConnectorCatalogPreset>>;

/** The Agent's connection of this catalog service in this owner's lane, which a new link would replace. */
function catalogConnection(agent: SnapshotAgent, connector: Connector, ownerKind: 'team' | 'member') {
  const toolkit = 'managedToolkit' in connector ? connector.managedToolkit : undefined;
  const lanePreset = new Map([...agent.apiConnections, ...agent.mcpServers].map(({ id, presetId }) => [id, presetId]));
  return connectionRows(agent).find((row) => row.kind === 'service' && row.owner === ownerKind &&
    (lanePreset.get(row.connectionId) === connector.id ||
      agent.connections?.some(({ id, providerId }) => id === row.connectionId && toolkit !== undefined &&
        (providerId === toolkit || providerId === connector.id))));
}

function needsSetup(
  agent: ChangeResult['agent'],
  setup: Setup,
  summary: string,
): ChangeResult {
  return { status: 'needs_setup', summary, nextStep: SETUP_NEXT_STEP, ...(agent ? { agent } : {}), setup };
}

function linkFrom(result: PrepareConnectorSetupResult): Setup {
  return {
    url: result.handoffUrl,
    ...(result.setupOperationId ? { setupToken: result.setupOperationId } : {}),
    what: result.connector.name,
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

/** A custom connection's ID: its name's slug, so a retry derives the same one. */
function connectionIdFrom(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  return slug || 'connection';
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

function mcpEntry(id: string, custom: Custom): SnapshotAgent['mcpServers'][number] {
  const auth = custom.auth ?? 'key';
  const header = auth === 'key' && custom.headerName && custom.headerName.toLowerCase() !== 'authorization'
    ? custom.headerName
    : undefined;
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
  const context = await deps.context();
  const id = connectionIdFrom(custom.name);
  const added = await applyChange(deps, context, {
    tool: 'connect_service',
    args: input,
    operations: async () => {
      const { agent } = await readAgent(deps, context, input.agentId, input.version);
      const existing = connectionRows(agent).find(({ connectionId }) => connectionId === id);
      if (existing) alreadyConnected(agent, existing);
      const patch = custom.kind === 'api'
        ? { apiConnections: [...agent.apiConnections, apiEntry(id, custom)] }
        : { mcpServers: [...agent.mcpServers, mcpEntry(id, custom)] };
      return [{ itemId: 'connect_service', kind: 'update_agent', agentId: agent.id, expectedRevision: agent.revision, patch }];
    },
  });
  const saved = await changeResult(deps, context, added, { agentId: input.agentId, summary: `Added ${custom.name}.` });
  return withSetup(deps, context, saved, input.agentId, id, input.checkPath);
}

/** The change's result, or the setup link its connection now waits for. */
async function withSetup(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  saved: ChangeResult,
  agentId: string,
  connectionId: string,
  checkPath: string | undefined,
): Promise<ChangeResult> {
  if (saved.status !== 'done') return saved;
  const { agent } = await readAgent(deps, context, agentId);
  const row = connectionRows(agent).find((candidate) => candidate.connectionId === connectionId);
  if (row?.status !== 'waiting_for_setup') return saved;
  const kind = agent.mcpServers.some(({ id }) => id === connectionId) ? 'mcp' : 'api';
  const setup = await issueSetup(deps, context, connectionTarget(agentId, kind, connectionId, checkPath), row.name);
  return { ...saved, status: 'needs_setup', summary: `${saved.summary} Open the link to add its key.`, nextStep: SETUP_NEXT_STEP, setup };
}

export async function reconnectService(
  deps: FiveZeroDeps,
  input: In<typeof schemas.reconnectServiceInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const { snapshot, agent } = await readAgent(deps, context, input.agentId);
  const row = connectionRows(agent).find(({ connectionId }) => connectionId === input.connectionId);
  if (!row) {
    fail('not_found', `${agent.name} has no connection with that connectionId.`, { nextStep: 'Call get_agent for its connectionIds.' });
  }
  const { agent: summary } = await agentSummary(deps, context, agent.id);
  const lane = agent.apiConnections.some(({ id }) => id === row.connectionId) ? 'api'
    : agent.mcpServers.some(({ id }) => id === row.connectionId) ? 'mcp' : undefined;
  if (lane) {
    const setup = await issueSetup(deps, context, connectionTarget(agent.id, lane, row.connectionId, input.checkPath), row.name);
    return needsSetup(summary, setup, `Open the link to reconnect ${row.name}.`);
  }
  // A catalog sign-in: the same link prepare_connector_setup makes for it.
  const account = agent.connections?.find(({ id }) => id === row.connectionId);
  const connector = account?.reconnect?.tool === 'prepare_connector_setup'
    ? account.reconnect.connector
    : CONNECTION_CATALOG_PRESETS.find((preset) => 'managedToolkit' in preset &&
        (preset.managedToolkit === account?.providerId || preset.id === account?.providerId))?.id;
  if (!account || !connector) cannotReconnect(deps, agent.id, row.name);
  if (account.ownerKind === 'team' && snapshot.caller.role === 'member') teamConnectionRefused(`reconnect ${row.name}`);
  const setup = await forManagedAgent(deps.service.prepareConnectorSetup(context, {
    agentId: agent.id,
    connector,
    ownerKind: account.ownerKind,
  }));
  if (setup.reconnect?.connectionId !== account.id) {
    if (setup.setupOperationId) await deps.service.revokeSetupLink(context, setup.setupOperationId);
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

/** The changed entry, or a refusal naming a field the connection's kind does not have. */
function changedEntry<T extends object>(entry: T, changes: CustomChanges, fields: Readonly<Record<string, string>>, kind: string): T {
  const wrong = Object.keys(changes).filter((field) => !(field in fields));
  if (wrong.length) fail('invalid_input', `A custom ${kind} connection has no ${wrong.join(' or ')} to change.`);
  return {
    ...entry,
    ...Object.fromEntries(Object.entries(changes).map(([field, value]) => [fields[field]!, value])),
  };
}

/**
 * Changes a custom connection's settings. The service keeps its key while
 * the hosts and header it goes to stay the same; otherwise the connection
 * waits for its key again and the result carries the link.
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
      if ((!api && !mcp) || (api ?? mcp)!.presetId) {
        fail('invalid_input', `${agent.name} has no custom connection with that connectionId.`, {
          nextStep: 'Send a custom_api or custom_mcp connectionId from get_agent. A catalog service\'s settings are Chickpea\'s; reconnect_service signs it in again.',
        });
      }
      const patch = api
        ? { apiConnections: agent.apiConnections.map((entry) => entry === api ? changedEntry(entry, input.changes, API_CHANGES, 'API') : entry) }
        : { mcpServers: agent.mcpServers.map((entry) => entry === mcp ? changedEntry(entry, input.changes, MCP_CHANGES, 'MCP') : entry) };
      return [{ itemId: 'update_connection', kind: 'update_agent', agentId: agent.id, expectedRevision: agent.revision, patch }];
    },
  });
  const result = await changeResult(deps, context, saved, { agentId: input.agentId, summary: 'Saved the connection.' });
  return withSetup(deps, context, result, input.agentId, input.connectionId, input.checkPath);
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

/** A grant's ID: its repository's slug, so the same repository keeps one grant. */
function grantId(fullName: string): string {
  return `repo_${fullName.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 100)}`;
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
): Promise<ChangeResult> {
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
    nextStep: SETUP_NEXT_STEP,
    setup: first!,
    ...(rest.length ? { warnings: [...result.warnings ?? [], ...rest.map((setup) => `Also give the person this link for ${setup.what}: ${setup.url}`)] } : {}),
  };
}
