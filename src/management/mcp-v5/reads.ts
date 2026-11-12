import type { z } from 'zod';

import { AGENT_ID_PATTERN, CHICKPEA_AGENT_ID } from '../../config/agent-id.ts';
import { isMcpToolReviewRequired } from '../../config/mcp-access.ts';
import { mcpToolDeclaredRead } from '../../config/mcp-tool-policy.ts';
import { resolveConnectorCatalogPreset } from '../../config/presets.ts';
import type { PlatformEnv } from '../../config/state-backend.ts';
import type { GithubConnection } from '../../config/github-app.ts';
import type { CustomAgentConfig, McpConnectionConfig, RepositoryGrant } from '../../config/types.ts';
import { decodeBase64Url, encodeBase64Url } from '../../security/base64url.ts';
import { agentAvatarInstallation, sameOriginAgentAvatarUrl } from '../../slack/agent-presence/avatar-assets.ts';
import {
  ADMIN_PATH,
  ADMIN_SETTINGS_SECTIONS,
  adminOnlySettingsSections,
  adminOrigin,
  adminSettingsLinks,
  adminTeamUrl,
} from '../admin-links.ts';
import { agentConnections, managementApiConnection, managementConnectionStatus, managementMcpConnection } from '../agent-connections.ts';
import { agentWelcomeQuote } from '../receipts.ts';
import {
  connectionWorkspaceIds,
  managementActorPrincipal,
  projectAgentConnectionAccounts,
  visibleConnectionAccountsOf,
  withoutRevisions,
  type WorkspaceManagementService,
} from '../service.ts';
import {
  ManagementError,
  type ManagementActorContext,
  type ManagementOperationResult,
  type ManagementRoutineSnapshot,
  type ManagementSetupPublicStatus,
  type ManagementWorkspaceSnapshot,
} from '../types.ts';
import { accountProfileId, fail, versionToken } from './conventions.ts';
import type * as schemas from './schemas.ts';
import { withSkillText } from './skill-text.ts';

/** What every 5.0 tool reads with: the service, the caller, and this deployment. */
export interface FiveZeroDeps {
  service: WorkspaceManagementService;
  context(): Promise<ManagementActorContext>;
  /** The deployment's public base URL, for Admin links. */
  baseUrl?: string;
  env?: PlatformEnv;
}

type Out<T extends z.ZodType> = z.infer<T>;
type SnapshotAgent = ManagementWorkspaceSnapshot['agents'][number];
/** One Agent's connections, as the snapshot lists them. */
type AgentConnectionView = Pick<SnapshotAgent, 'mcpServers' | 'apiConnections' | 'connectionStatus' | 'connections'>;
type AgentRow = Out<typeof schemas.listAgentsOutput>['agents'][number];

const ROLE_LABEL = { owner: 'Owner', admin: 'Admin', member: 'Member' } as const;

/** The read every projection starts from, with the caller it was read for. */
export async function readWorkspace(deps: FiveZeroDeps): Promise<{
  context: ManagementActorContext;
  snapshot: ManagementWorkspaceSnapshot;
}> {
  const context = await deps.context();
  return { context, snapshot: await deps.service.inspectWorkspace(context) };
}

export async function getAccount(deps: FiveZeroDeps): Promise<Out<typeof schemas.getAccountOutput>> {
  const { snapshot } = await readWorkspace(deps);
  const name = snapshot.caller.displayName?.trim();
  return {
    id: accountProfileId(snapshot.organizationId, snapshot.caller.membershipId),
    ...(name ? { name } : {}),
    nickname: `${snapshot.slackTeamName ?? 'Chickpea'} (${ROLE_LABEL[snapshot.caller.role]})`,
  };
}

export async function getWorkspace(deps: FiveZeroDeps): Promise<Out<typeof schemas.getWorkspaceOutput>> {
  const { snapshot } = await readWorkspace(deps);
  const origin = adminOrigin(deps.baseUrl);
  const adminUrl = origin ? `${origin}${ADMIN_PATH}` : undefined;
  const name = snapshot.caller.displayName?.trim();
  const settings = snapshot.caller.role === 'member' ? [] : adminOnlySettingsSections(deps.env).map((section) => ({
    what: ADMIN_SETTINGS_SECTIONS[section],
    ...withUrl(adminSettingsLinks(deps.baseUrl, section, deps.env)?.admin),
  }));
  return {
    ...(snapshot.slackTeamName ? { name: snapshot.slackTeamName } : {}),
    you: { ...(name ? { name } : {}), role: snapshot.caller.role },
    agentCount: agentRows(snapshot).length,
    ...withAdminUrl(adminUrl),
    adminOnly: [
      { what: 'Agent pictures', ...withUrl(adminUrl) },
      { what: 'Adding a website login to an Agent (Owners and Admins)', ...withUrl(adminUrl) },
      ...settings,
    ],
  };
}

/** list_agents' result, its text block and `structuredContent` together, in characters at most. */
export const LIST_AGENTS_BUDGET_CHARS = 20_000;
/** A listed Agent's description, on one line, at most. */
const LISTED_DESCRIPTION_CHARS = 100;

/**
 * The Agents the caller can use, archived ones only when asked, each as a
 * list needs it: get_agent has the rest. One page stays inside the budget.
 * The ones the caller can edit come first, then shared ones, each group in
 * agentId order, and `nextCursor` names the last one listed, so an Agent
 * created or archived between pages never moves another one.
 */
export async function listAgents(
  deps: FiveZeroDeps,
  input: Out<typeof schemas.listAgentsInput>,
): Promise<Out<typeof schemas.listAgentsOutput>> {
  const after = input.cursor === undefined ? undefined : cursorPlace(input.cursor);
  const { context, snapshot } = await readWorkspace(deps);
  const mine = new Set(snapshot.agents
    .filter(({ creatorMembershipId }) => creatorMembershipId === snapshot.caller.membershipId)
    .map(({ id }) => id));
  const github = snapshot.agents.some(({ repositories }) => repositories.some(({ enabled }) => enabled))
    ? await deps.service.githubConnection(context)
    : undefined;
  const rows = agentRows(snapshot, github)
    .filter((row) => (after === undefined || listOrder(row, after) > 0) &&
      (input.include !== 'mine' || mine.has(row.agentId)) && (input.includeArchived === true || row.status !== 'archived'))
    .sort(listOrder);
  const page = (count: number): Out<typeof schemas.listAgentsOutput> => ({
    agents: rows.slice(0, count),
    canCreate: true,
    ...(count < rows.length ? { nextCursor: agentsCursor(rows[count - 1]!) } : {}),
  });
  // The text block is the same JSON, so a page counts twice.
  const fits = (count: number) => 2 * JSON.stringify(page(count)).length <= LIST_AGENTS_BUDGET_CHARS;
  let count = Math.min(1, rows.length);
  while (count < rows.length && fits(count + 1)) count += 1;
  return page(count);
}

/** Where an Agent stands in the list: its group, then its ID. */
type ListPlace = Pick<AgentRow, 'agentId' | 'canEdit'>;

function listOrder(left: ListPlace, right: ListPlace): number {
  if (left.canEdit !== right.canEdit) return left.canEdit ? -1 : 1;
  return left.agentId < right.agentId ? -1 : left.agentId > right.agentId ? 1 : 0;
}

const AGENTS_CURSOR_PREFIX = 'after1_';

function agentsCursor({ agentId, canEdit }: ListPlace): string {
  return `${AGENTS_CURSOR_PREFIX}${encodeBase64Url(new TextEncoder().encode(`${canEdit ? 'e' : 's'}:${agentId}`))}`;
}

/** The place a cursor names. Anything else, such as an offset an earlier Chickpea gave, is refused. */
function cursorPlace(cursor: string): ListPlace {
  let place: string | undefined;
  if (cursor.startsWith(AGENTS_CURSOR_PREFIX)) {
    try {
      place = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(cursor.slice(AGENTS_CURSOR_PREFIX.length)));
    } catch {
      place = undefined;
    }
  }
  const group = place?.slice(0, 2);
  const agentId = place?.slice(2);
  if ((group === 'e:' || group === 's:') && agentId !== undefined && AGENT_ID_PATTERN.test(agentId)) {
    return { agentId, canEdit: group === 'e:' };
  }
  return fail('invalid_input', 'Chickpea can\'t continue the list from that cursor.', {
    nextStep: 'Call list_agents without a cursor to start again from the first page.',
  });
}

/** Every Agent the caller can use: the ones they can edit, then shared ones they cannot. */
function agentRows(snapshot: ManagementWorkspaceSnapshot, github?: GithubConnection): AgentRow[] {
  const editable = snapshot.agents.map((agent): AgentRow => {
    const handle = agentHandle(agent);
    const description = agent.description?.replace(/\s+/g, ' ').trim();
    return {
      agentId: agent.id,
      name: agent.name,
      ...(handle ? { handle } : {}),
      ...(description ? { description: shortDescription(description) } : {}),
      status: agentStatus(agent),
      canEdit: true,
      needsAttention: needsAttention(agent, github),
    };
  });
  const listed = new Set(editable.map(({ agentId }) => agentId));
  const shared = (snapshot.usableAgents ?? []).filter(({ id }) => !listed.has(id)).map((agent): AgentRow => ({
    agentId: agent.id,
    name: agent.name,
    ...(agent.handle ? { handle: agent.handle } : {}),
    status: 'on',
    canEdit: agent.canEdit,
    needsAttention: [],
  }));
  return [...editable, ...shared];
}

function shortDescription(description: string): string {
  return description.length > LISTED_DESCRIPTION_CHARS ? `${description.slice(0, LISTED_DESCRIPTION_CHARS - 1)}…` : description;
}

function agentHandle(agent: SnapshotAgent): string | undefined {
  return agent.slackPresence?.normalizedHandle || undefined;
}

export function agentStatus(agent: { lifecycle?: CustomAgentConfig['lifecycle'] | undefined; enabled: boolean }): AgentRow['status'] {
  if (agent.lifecycle === 'archived') return 'archived';
  return agent.enabled ? 'on' : 'off';
}

/** Its picture as Slack shows it, on this deployment's origin, which is all a card's CSP allows. */
export function agentAvatar(
  deps: FiveZeroDeps,
  agent: Pick<CustomAgentConfig, 'id' | 'slackPresence'>,
): { avatarUrl?: string } {
  const origin = adminOrigin(deps.baseUrl);
  const avatarUrl = origin && sameOriginAgentAvatarUrl(agent, origin, agentAvatarInstallation(deps.env));
  return avatarUrl ? { avatarUrl } : {};
}

export function agentLinks(baseUrl: string | undefined, agentId: string, slack: string | undefined) {
  const origin = adminOrigin(baseUrl);
  if (!origin) return undefined;
  return { admin: `${origin}${ADMIN_PATH}/agents/${encodeURIComponent(agentId)}`, ...(slack ? { slack } : {}) };
}

/**
 * Plain reasons, the way Admin's Agent page would say them: each problem
 * check_agent finds from stored state alone. `github` is the stored GitHub
 * connection, read only when some Agent has a repository.
 */
function needsAttention(agent: SnapshotAgent, github: GithubConnection | undefined): string[] {
  const reasons: string[] = [];
  const presence = agent.slackPresence;
  if (presence?.health === 'needs_attention') reasons.push(presenceProblem(presence.errorCode));
  // An Agent that is off or archived leaves Slack on purpose.
  if (agentStatus(agent) === 'on' && notInSlack(presence)) reasons.push(NOT_IN_SLACK);
  for (const connection of connectionRows(agent)) {
    if (connection.status === 'needs_attention') reasons.push(`${connection.name} needs to be reconnected.`);
    if (connection.status === 'waiting_for_setup') reasons.push(`${connection.name} is waiting for its setup to finish.`);
  }
  if (github) reasons.push(...repositoryProblems(agent.repositories, github).map(({ detail }) => detail));
  return reasons;
}

export const NOT_IN_SLACK = 'It is not in Slack yet, so no one can mention it.';

type Presence = NonNullable<SnapshotAgent['slackPresence']>;

export function notInSlack(presence: Presence | undefined): presence is undefined | (Presence & { health: 'unpublished' }) {
  return !presence || presence.health === 'unpublished';
}

export type RepositoryProblem =
  | { kind: 'github_not_connected'; detail: string }
  | { kind: 'app_not_installed' | 'access_suspended'; grant: RepositoryGrant; detail: string };

/**
 * What keeps an Agent from its enabled repositories, by the stored GitHub
 * connection: no GitHub at all, or each repository whose account the App
 * isn't installed on or whose access is suspended. Empty when nothing does.
 */
export function repositoryProblems(repositories: readonly RepositoryGrant[], github: GithubConnection): RepositoryProblem[] {
  const granted = repositories.filter(({ enabled }) => enabled);
  if (granted.length === 0) return [];
  if (github.mode === 'none') {
    return [{ kind: 'github_not_connected', detail: 'GitHub is not connected to Chickpea, so it cannot reach its repositories.' }];
  }
  const active = github.platform
    ? new Set(github.platform.bindings.map(({ githubInstallationId }) => githubInstallationId))
    : undefined;
  return granted.flatMap((grant): RepositoryProblem[] => {
    if (grant.installationId === null) {
      return [{ kind: 'app_not_installed', grant, detail: `Chickpea's GitHub App is not installed for ${grant.accountLogin}.` }];
    }
    if (active && !active.has(grant.installationId)) {
      return [{ kind: 'access_suspended', grant, detail: `GitHub access for ${grant.accountLogin} is suspended or was removed.` }];
    }
    return [];
  });
}

const PRESENCE_PROBLEMS: Readonly<Record<string, string>> = {
  paid_plan_required: 'Slack needs a paid plan before an Agent can have its own handle.',
  user_group_policy_denied: 'This Slack workspace does not let Chickpea create the Agent\'s handle.',
  two_factor_required: 'Slack asks for two-factor authentication before Chickpea can add the handle.',
  handle_collision: 'Another Slack group already uses this handle.',
  name_collision: 'Another Slack group already uses this name.',
  invalid_handle: 'Slack does not accept this handle.',
  slack_reconnect_required: 'Chickpea\'s Slack connection needs to be reconnected in Admin.',
  rate_limited: 'Slack is busy. Chickpea tries again shortly.',
};

export function presenceProblem(errorCode: string | undefined): string {
  return (errorCode ? PRESENCE_PROBLEMS[errorCode] : undefined) ??
    'Chickpea could not finish adding the Agent to Slack. Its page in Admin says what to do.';
}

type ConnectionRow = Out<typeof schemas.getAgentOutput>['connections'][number];

/**
 * One row per connection. A custom API or MCP connection comes from the
 * Agent's lanes, under the ID its tools take; a catalog sign-in comes from the
 * Agent's accounts. An account a lane already shows is not listed twice.
 */
export function connectionRows(agent: AgentConnectionView): ConnectionRow[] {
  const status = new Map(agent.connectionStatus.map((entry) => [`${entry.kind}:${entry.id}`, entry.lifecycleStatus]));
  const discovered = (id: string) => agent.connectionStatus.find((entry) => entry.kind === 'mcp' && entry.id === id)?.discoveredTools ?? [];
  const laneStatus = (kind: 'mcp' | 'api', id: string, enabled: boolean): ConnectionRow['status'] => {
    if (!enabled) return 'off';
    const lifecycle = status.get(`${kind}:${id}`);
    return lifecycle === 'failed' ? 'needs_attention' : lifecycle === 'pending' ? 'waiting_for_setup' : 'ready';
  };
  const accounts = agent.connections ?? [];
  const accountFor = (id: string) => accounts.find((account) => account.id === id || account.providerId === id);
  const owner = (id: string) => {
    const ownerKind = accountFor(id)?.ownerKind;
    return ownerKind ? { owner: ownerKind } : {};
  };
  const lanes: ConnectionRow[] = [
    ...agent.apiConnections.map((api): ConnectionRow => ({
      connectionId: api.id,
      name: api.displayName,
      kind: api.presetId ? 'service' : 'custom_api',
      ...owner(api.id),
      status: laneStatus('api', api.id, api.enabled),
      ...(api.presetId ? {} : {
        custom: {
          hosts: [...api.allowedHosts],
          pathPrefixes: [...api.pathPrefixes],
          methods: [...api.allowedMethods],
          headerName: api.headerName,
          ...(api.guide ? { guide: api.guide } : {}),
        },
      }),
    })),
    ...agent.mcpServers.map((mcp): ConnectionRow => ({
      connectionId: mcp.id,
      name: mcp.displayName,
      kind: mcp.presetId ? 'service' : 'custom_mcp',
      ...owner(mcp.id),
      status: laneStatus('mcp', mcp.id, mcp.enabled),
      ...(mcp.presetId ? {} : {
        custom: {
          url: mcp.url,
          allowedTools: [...mcp.allowedTools],
          ...toolMarks(mcp, discovered(mcp.id)),
          ...(mcp.guide ? { guide: mcp.guide } : {}),
        },
      }),
      // A reviewed connector's tools are chosen in Admin, and update_connection marks none of them.
      ...(mcp.presetId && !isMcpToolReviewRequired(mcp)
        ? { tools: { allowedTools: [...mcp.allowedTools], ...toolMarks(mcp, discovered(mcp.id)) } }
        : {}),
    })),
  ];
  const shown = new Set(lanes.map(({ connectionId }) => connectionId));
  const signIns = accounts
    .filter((account) => !shown.has(account.id) && !shown.has(account.providerId))
    .map((account): ConnectionRow => ({
      connectionId: account.id,
      name: account.label,
      kind: 'service',
      owner: account.ownerKind,
      status: !account.enabled ? 'off'
        : account.lifecycle === 'needs_attention' ? 'needs_attention'
          : account.lifecycle === 'pending' ? 'waiting_for_setup' : 'ready',
    }));
  return [...lanes, ...signIns];
}

/**
 * The allowed tools marked as reads or writes; a tool with no mark is in
 * neither. A read is one a practice run calls (mcpToolDeclaredRead), so a read
 * mark its server now says writes is in neither too.
 */
function toolMarks(
  mcp: AgentConnectionView['mcpServers'][number],
  discoveredTools: McpConnectionConfig['discoveredTools'],
): { readTools?: string[]; writeTools?: string[] } {
  const connection = { ...mcp, discoveredTools };
  const readTools = mcp.allowedTools.filter((tool) => mcpToolDeclaredRead(connection, tool));
  const writeTools = mcp.allowedTools.filter((tool) => mcp.toolPolicies?.[tool]?.effect === 'write');
  return { ...(readTools.length ? { readTools } : {}), ...(writeTools.length ? { writeTools } : {}) };
}

type Connector = NonNullable<ReturnType<typeof resolveConnectorCatalogPreset>>;

/** The Agent's connection of this catalog service in this owner's lane, which a new link would replace. */
export function catalogConnection(agent: AgentConnectionView, connector: Connector, ownerKind: 'team' | 'member') {
  const toolkit = 'managedToolkit' in connector ? connector.managedToolkit : undefined;
  const lanePreset = new Map([...agent.apiConnections, ...agent.mcpServers].map(({ id, presetId }) => [id, presetId]));
  return connectionRows(agent).find((row) => row.kind === 'service' && row.owner === ownerKind &&
    (lanePreset.get(row.connectionId) === connector.id ||
      agent.connections?.some(({ id, providerId }) => id === row.connectionId && toolkit !== undefined &&
        (providerId === toolkit || providerId === connector.id))));
}

export async function getAgent(
  deps: FiveZeroDeps,
  input: Out<typeof schemas.getAgentInput>,
): Promise<Out<typeof schemas.getAgentOutput>> {
  const { context, snapshot } = await readWorkspace(deps);
  const agent = requireAgent(snapshot, input.agentId);
  const handle = agentHandle(agent);
  const presence = agent.slackPresence;
  const links = agentLinks(deps.baseUrl, agent.id, await deps.service.slackAppLink(context));
  const output: Out<typeof schemas.getAgentOutput> = {
    agentId: agent.id,
    name: agent.name,
    ...(handle ? { handle } : {}),
    ...agentAvatar(deps, agent),
    ...(agent.description ? { description: agent.description } : {}),
    status: agentStatus(agent),
    version: agentVersion(snapshot, agent),
    instructions: agent.instructions,
    whoCanEdit: agent.editPolicy ?? 'creator_and_admins',
    model: {
      model: agent.effectiveModels.model,
      source: agent.effectiveModels.modelSource,
      effort: agent.effectiveModels.effort,
      imageModel: agent.effectiveModels.imageModel,
      imageSource: agent.effectiveModels.imageModelSource,
    },
    slack: {
      presence: notInSlack(presence) ? 'not_in_slack'
        : presence.health === 'healthy' ? 'ready'
          : presence.health === 'pending' ? 'joining' : 'needs_attention',
      ...(presence?.health === 'needs_attention' ? { problem: presenceProblem(presence.errorCode) } : {}),
      ownApp: agent.ownSlackApp !== undefined,
      groupDms: agent.groupDms === 'eligible' ? 'yes' : agent.groupDms === 'not_eligible' ? 'no' : 'unknown',
    },
    skills: agent.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      enabled: skill.enabled,
      from: skill.importSource ? 'github' as const : skill.suggestedSkillId ? 'suggested' as const : 'custom' as const,
    })),
    connections: connectionRows(agent),
    websiteLogins: (agent.websiteLogins ?? []).map(({ loginId, host }) => ({ loginId, site: host })),
    repositories: agent.repositories.map((grant) => ({
      repository: grant.allRepos ? `${grant.accountLogin}/*` : grant.fullName,
    })),
    channels: snapshot.channels
      .filter(({ grants }) => grants.some((grant) => grant.agentId === agent.id && grant.status === 'active'))
      .map(({ channelId, label }) => ({ channelId, ...(label ? { name: label } : {}) })),
    ...(links ? { links } : {}),
  };
  return input.includeSkillText || input.skill !== undefined || input.offset !== undefined
    ? withSkillText(output, agent.skills, input)
    : output;
}

/** A member sees only the Agents they may edit, so any other ID reads as missing. */
export function requireAgent(snapshot: ManagementWorkspaceSnapshot, agentId: string): SnapshotAgent {
  const agent = snapshot.agents.find(({ id }) => id === agentId);
  if (!agent) agentNotFound();
  return agent;
}

export function agentNotFound(): never {
  fail('not_found', 'That Agent is gone, or you can\'t manage it.', { nextStep: 'Call list_agents for the current agentIds.' });
}

/**
 * The service refuses an Agent the caller cannot edit without saying whether
 * it exists; the 5.0 tools call that not_found, as `get_agent` does.
 */
export async function forManagedAgent<T>(read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof ManagementError && error.code === 'forbidden') agentNotFound();
    throw error;
  }
}

export function agentVersion(snapshot: ManagementWorkspaceSnapshot, agent: SnapshotAgent): string {
  return versionToken('agent', agent.id, agent.revision, snapshot.organizationId);
}

export async function listServices(
  deps: FiveZeroDeps,
  input: Out<typeof schemas.listServicesInput>,
): Promise<Out<typeof schemas.listServicesOutput>> {
  const { snapshot } = await readWorkspace(deps);
  const words = (input.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const services = snapshot.connectors
    .filter(({ id, name, description }) => {
      const text = `${id} ${name} ${description}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .map(({ id, name, description }) => ({ service: id, name, description }));
  return {
    services,
    count: services.length,
    nextStep: 'get_service with a service says how it signs in and what it can read and write before it is connected; connect_service connects it to an Agent.',
  };
}

export async function listModels(deps: FiveZeroDeps): Promise<Out<typeof schemas.listModelsOutput>> {
  const { snapshot } = await readWorkspace(deps);
  const roleVersion = (role: string, revision: number) =>
    versionToken('workspace_model', role, revision, snapshot.organizationId);
  const defaults = snapshot.workspaceModels;
  return {
    models: [
      ...snapshot.modelCatalog.chat.map(({ id, efforts }) => ({ model: id, kind: 'chat' as const, efforts: [...efforts] })),
      ...snapshot.modelCatalog.image.map(({ id, name }) => ({ model: id, kind: 'image' as const, name })),
    ],
    ...(defaults
      ? {
          workspaceDefaults: {
            chat: { model: defaults.chat.model, effort: defaults.chat.effort, version: roleVersion('chat', defaults.chat.revision) },
            image: { model: defaults.image.model, version: roleVersion('image', defaults.image.revision) },
            coding: { model: defaults.coding.model, effort: defaults.coding.effort, version: roleVersion('coding', defaults.coding.revision) },
          },
        }
      : {}),
    ...(snapshot.caller.role === 'member' ? {} : {
      providers: snapshot.providers.map((provider) => ({
        provider: provider.id,
        ready: provider.available,
        key: provider.source === 'stored' ? 'yours' as const : provider.source === 'env' ? 'chickpea' as const : 'none' as const,
        replaceable: provider.mutable,
      })),
    }),
  };
}

export async function listMembers(deps: FiveZeroDeps): Promise<Out<typeof schemas.listMembersOutput>> {
  const { snapshot } = await readWorkspace(deps);
  if (!snapshot.team) {
    fail('not_allowed', 'Only an Owner or Admin can list the team.', {
      nextStep: 'Tell the person an Owner or Admin can see the team in Admin.',
    });
  }
  return {
    members: snapshot.team.members.map((member) => {
      const name = member.displayName?.trim();
      return {
        ...(member.slackUserId ? { slackUserId: member.slackUserId } : { adminUrl: adminTeamUrl(deps.baseUrl) }),
        ...(name ? { name } : {}),
        role: member.role,
        status: member.status,
      };
    }),
  };
}

interface SlackDirectory {
  truncated: boolean;
  channels: Array<{ id: string; name: string; isPrivate: boolean; isMember: boolean }>;
}

/** The Slack Channels the caller is in, or undefined when Slack cannot say right now. */
export async function slackDirectory(deps: FiveZeroDeps, context: ManagementActorContext): Promise<SlackDirectory | undefined> {
  try {
    const found = await deps.service.discoverSlackChannels(context) as Partial<SlackDirectory>;
    return Array.isArray(found?.channels) ? { truncated: found.truncated === true, channels: found.channels } : undefined;
  } catch {
    return undefined;
  }
}

export async function listSlackChannels(
  deps: FiveZeroDeps,
  input: Out<typeof schemas.listSlackChannelsInput>,
): Promise<Out<typeof schemas.listSlackChannelsOutput>> {
  const { context, snapshot } = await readWorkspace(deps);
  const directory = await slackDirectory(deps, context);
  const agentNames = new Map(snapshot.agents.map(({ id, name }) => [id, name]));
  const known = new Map(snapshot.channels.map((channel) => [channel.channelId, channel]));
  const rows = new Map<string, Out<typeof schemas.listSlackChannelsOutput>['channels'][number]>();
  const chickpea = (channelId: string) => {
    const channel = known.get(channelId);
    if (!channel) return { agents: [] };
    return {
      settings: { ...(channel.label ? { label: channel.label } : {}), on: channel.lifecycle === 'active' },
      agents: channel.grants.flatMap(({ agentId, status }) => {
        const name = agentNames.get(agentId);
        return name ? [{
          agentId,
          name,
          status: status === 'active' ? 'on' as const : status === 'pending' ? 'joining' as const : 'needs_attention' as const,
        }] : [];
      }),
    };
  };
  for (const channel of directory?.channels ?? []) {
    rows.set(channel.id, {
      channelId: channel.id,
      name: channel.name,
      private: channel.isPrivate,
      chickpeaInChannel: channel.isMember,
      ...chickpea(channel.id),
    });
  }
  for (const channel of snapshot.channels) {
    if (rows.has(channel.channelId)) continue;
    rows.set(channel.channelId, {
      channelId: channel.channelId,
      ...(channel.label ? { name: channel.label } : {}),
      ...chickpea(channel.channelId),
    });
  }
  const search = input.search?.replace(/^#/, '').trim().toLowerCase();
  const channels = [...rows.values()].filter(({ name, channelId }) =>
    !search || (name ?? '').toLowerCase().includes(search) || channelId.toLowerCase() === search);
  return { channels, complete: directory !== undefined && !directory.truncated };
}

export async function getAgentMemory(
  deps: FiveZeroDeps,
  input: Out<typeof schemas.getAgentMemoryInput>,
): Promise<Out<typeof schemas.getAgentMemoryOutput>> {
  const context = await deps.context();
  const memory = await forManagedAgent(deps.service.inspectMemory(context, input.agentId));
  // update_agent_memory checks the memory's own revision, not the Agent's.
  return { body: memory.body, version: versionToken('memory', input.agentId, memory.revision, context.organizationId) };
}

type Schedule = ManagementRoutineSnapshot['routines'][number];
type ScheduleRow = Out<typeof schemas.listSchedulesOutput>['schedules'][number];

export async function listSchedules(
  deps: FiveZeroDeps,
  input: Out<typeof schemas.listSchedulesInput>,
): Promise<Out<typeof schemas.listSchedulesOutput>> {
  const { context, snapshot } = await readWorkspace(deps);
  if (!snapshot.slackTeamId) return { schedules: [] };
  const { routines } = await deps.service.inspectRoutines(context, {
    workspaceId: snapshot.slackTeamId,
    ...(input.channelId ? { channelId: input.channelId } : {}),
    ...(input.scheduleId ? { routineId: input.scheduleId } : {}),
  });
  const agentNames = new Map([
    ...(snapshot.usableAgents ?? []).map(({ id, name }) => [id, name] as const),
    ...snapshot.agents.map(({ id, name }) => [id, name] as const),
  ]);
  const people = new Map((snapshot.team?.members ?? []).map(({ userId, displayName }) => [userId, displayName]));
  const callerName = snapshot.caller.displayName ?? undefined;
  const labels = new Map(snapshot.channels.map(({ channelId, label }) => [channelId, label]));
  return {
    schedules: routines
      .filter(({ owningAgentId }) => !input.agentId || owningAgentId === input.agentId)
      .map((routine) => scheduleRow(routine, {
        organizationId: snapshot.organizationId,
        agentName: agentNames.get(routine.owningAgentId),
        runsAs: routine.creatorUserId === context.userId
          ? { you: true, name: callerName }
          : { you: false, name: people.get(routine.creatorUserId) ?? undefined },
        channelLabel: routine.channelId ? labels.get(routine.channelId) : undefined,
      })),
  };
}

function scheduleRow(routine: Schedule, facts: {
  organizationId: string;
  agentName: string | undefined;
  runsAs: { you: boolean; name: string | undefined };
  channelLabel: string | undefined;
}): ScheduleRow {
  const why = routine.state === 'paused' ? routine.pausedReason
    : routine.state === 'disabled' ? routine.disabledReason : null;
  return {
    scheduleId: routine.id,
    ...(routine.name ? { name: routine.name } : {}),
    agent: { agentId: routine.owningAgentId, ...(facts.agentName ? { name: facts.agentName } : {}) },
    where: routine.destination.kind === 'channel'
      ? { kind: 'channel', channelId: routine.destination.channelId, label: facts.channelLabel ?? routine.destination.channelId }
      : { kind: 'dm', label: routine.destination.label },
    cadence: routine.scheduleInput,
    timezone: routine.timezone,
    nextRun: routine.nextRunTime ? { display: routine.nextRunTime.display, isoUtc: routine.nextRunTime.isoUtc } : null,
    ...(routine.lastRun ? {
      lastRun: {
        outcome: runOutcome(routine.lastRun.status),
        ...(routine.lastRun.publicError ? { problem: routine.lastRun.publicError } : {}),
      },
    } : {}),
    state: SCHEDULE_STATE[routine.state],
    ...(why ? { why } : {}),
    runsAs: { you: facts.runsAs.you, ...(facts.runsAs.name ? { name: facts.runsAs.name } : {}) },
    post: routine.outputPolicy === 'post_on_change' ? 'when_changed' : 'always',
    ...(routine.taskText ? { task: routine.taskText } : {}),
    version: versionToken('schedule', routine.id, routine.version, facts.organizationId),
  };
}

const SCHEDULE_STATE: Record<Schedule['state'], ScheduleRow['state']> = {
  active: 'on',
  paused: 'paused',
  disabled: 'off',
  completed: 'done',
  pending_authority: 'waiting_for_access',
  deleted: 'deleted',
};

function runOutcome(status: NonNullable<Schedule['lastRun']>['status']): NonNullable<ScheduleRow['lastRun']>['outcome'] {
  switch (status) {
    case 'succeeded':
    case 'no_op':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'queued':
    case 'admitting':
    case 'running':
      return 'running';
    case 'skipped':
    case 'cancelled':
    case 'superseded':
      return 'skipped';
  }
}

const SETUP_STATUS: Record<ManagementSetupPublicStatus['status'], Out<typeof schemas.getSetupStatusOutput>['status']> = {
  pending: 'waiting',
  claimed: 'opened',
  authorizing: 'signing_in',
  completed: 'done',
  failed: 'failed',
  revoked: 'cancelled',
  expired: 'expired',
};

function isSetupStatus(result: ManagementOperationResult | undefined): result is ManagementSetupPublicStatus {
  return result !== undefined && 'setupOperationId' in result && 'target' in result;
}

export async function getSetupStatus(
  deps: FiveZeroDeps,
  input: Out<typeof schemas.getSetupStatusInput>,
): Promise<Out<typeof schemas.getSetupStatusOutput>> {
  const context = await deps.context();
  const result = await deps.service.getOperation(context, input.setupToken);
  if (!isSetupStatus(result)) {
    fail('not_found', 'No setup link of yours has that setupToken.', {
      nextStep: 'Use the setupToken a setup link came with.',
    });
  }
  const { target } = result;
  const { connection, avatarUrl, hasFirstAsk } = await setupConnection(deps, context, target);
  return {
    status: SETUP_STATUS[result.status],
    what: target.targetLabel,
    expires: when(result.expiresAt),
    ...(target.agentId
      ? {
          agent: {
            agentId: target.agentId,
            ...(target.agentName ? { name: target.agentName } : {}),
            ...(avatarUrl ? { avatarUrl } : {}),
            ...(hasFirstAsk ? { hasFirstAsk } : {}),
          },
        }
      : {}),
    ...(connection ? { connection } : {}),
  };
}

const CONNECTION_TARGETS: ReadonlySet<ManagementSetupPublicStatus['target']['kind']> = new Set([
  'api_connection', 'mcp_connection', 'catalog_connection', 'managed_connection',
]);

/**
 * The Agent's connection a setup link sets up, as it is now: the one it
 * names, or for a new catalog connection the one connect_service would refuse
 * to make twice. A link can stay waiting after the connection was made
 * another way; this says whether the connection is ready all the same. A
 * card asks every 2 s, so this reads only the Agent's connections.
 */
async function setupConnection(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  target: ManagementSetupPublicStatus['target'],
): Promise<{ connection?: Out<typeof schemas.getSetupStatusOutput>['connection']; avatarUrl?: string; hasFirstAsk?: true }> {
  if (!target.agentId || !CONNECTION_TARGETS.has(target.kind)) return {};
  const agent = await agentConnectionsOf(deps, context, target.agentId);
  if (!agent) return {};
  const rows = connectionRows(agent);
  let row: ConnectionRow | undefined;
  if (target.connectionId) {
    // A catalog sign-in shows under its service's name when the Agent has only one of that service.
    const account = agent.connections?.find(({ id }) => id === target.connectionId);
    row = rows.find(({ connectionId }) => connectionId === target.connectionId || connectionId === account?.providerId);
  } else {
    const connector = target.presetId ? resolveConnectorCatalogPreset(target.presetId) : undefined;
    row = connector && target.ownerKind ? catalogConnection(agent, connector, target.ownerKind) : undefined;
  }
  return {
    ...row ? { connection: { connectionId: row.connectionId, name: row.name, kind: row.kind, status: row.status } } : {},
    ...agentAvatar(deps, agent.config),
    ...agent.hasFirstAsk ? { hasFirstAsk: true as const } : {},
  };
}

/**
 * One Agent's connections as inspect_workspace lists them, read alone: a card
 * polls get_setup_status every 2 s, so never the workspace snapshot or Slack.
 * Also whether it has a first ask, which decides the connect card's next step.
 * undefined when the snapshot would not list the Agent for this caller.
 */
export async function agentConnectionsOf(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  agentId: string,
): Promise<(AgentConnectionView & { config: CustomAgentConfig; hasFirstAsk: boolean }) | undefined> {
  const reader = await deps.service.agentReader(context, agentId).catch((error: unknown) => {
    if (error instanceof ManagementError) return undefined;
    throw error;
  });
  // An Agent acting for itself sees only itself, as in the snapshot.
  const acting = reader?.actor.actingAgentId;
  if (!reader || (acting && acting !== CHICKPEA_AGENT_ID && acting !== agentId)) return undefined;
  const { actor, stores } = reader;
  const workspaceIds = connectionWorkspaceIds(actor, await stores.identity.getOrganization());
  const [accounts, bindings, firstAsk] = await Promise.all([
    Promise.all(workspaceIds.map((id) => stores.config.listConnectionAccounts(id))).then((groups) => groups.flat()),
    stores.config.listAgentConnectionBindings(agentId),
    stores.config.getAgentFirstAsk?.(agentId),
  ]);
  const lanes = agentConnections(accounts, bindings, actor.membershipId);
  const projected = projectAgentConnectionAccounts(
    managementActorPrincipal(actor), agentId, accounts, visibleConnectionAccountsOf(accounts, actor.membershipId), bindings,
  );
  return {
    mcpServers: lanes.mcpServers.map(managementMcpConnection),
    apiConnections: lanes.apiConnections.map(managementApiConnection),
    connectionStatus: managementConnectionStatus(lanes),
    ...(projected.length > 0 ? { connections: projected.map(withoutRevisions) } : {}),
    config: reader.agent,
    hasFirstAsk: Boolean(firstAsk),
  };
}

export async function exportAgents(
  deps: FiveZeroDeps,
  input: Out<typeof schemas.exportAgentsInput>,
): Promise<Out<typeof schemas.exportAgentsOutput>> {
  const context = await deps.context();
  return deps.service.exportRecipe(context, input.agentIds ? { agentIds: input.agentIds } : {});
}

export async function listConnectedApps(deps: FiveZeroDeps): Promise<Out<typeof schemas.listConnectedAppsOutput>> {
  const { clients } = await deps.service.listMcpClients(await deps.context());
  return {
    apps: clients.map((client) => ({
      appId: client.clientId,
      ...(client.name ? { name: client.name } : {}),
      connected: { display: displayDate(client.connectedAt) },
      ...(client.lastUsedAt ? { lastActive: { display: displayDate(client.lastUsedAt) } } : {}),
      thisApp: client.current,
    })),
    ...connectedAppsLink(deps),
  };
}

/** Where the person sees and disconnects their apps without asking a model. */
export function connectedAppsLink(deps: FiveZeroDeps): { adminUrl?: string } {
  return withAdminUrl(adminSettingsLinks(deps.baseUrl, 'connected-apps', deps.env)?.admin);
}

export async function getCreationStatus(
  deps: FiveZeroDeps,
  input: Out<typeof schemas.getCreationStatusInput>,
): Promise<Out<typeof schemas.getCreationStatusOutput>> {
  const context = await deps.context();
  const [progress, slackUrl] = await Promise.all([
    forManagedAgent(deps.service.agentCreationProgress(context, input.agentId)),
    deps.service.slackAppLink(context),
  ]);
  const health = progress.presence?.health;
  const welcome = progress.welcome?.status;
  const problem = health === 'needs_attention' ? presenceProblem(progress.presence?.errorCode)
    : welcome === 'failed' ? 'Chickpea could not send the Agent\'s hello in Slack.' : undefined;
  const stage = problem ? 'needs_attention'
    : welcome === 'delivered' ? 'said_hello'
      : welcome !== undefined || health === 'pending' ? 'joining' : 'ready';
  const grants = progress.channelGrants;
  const hello = welcome === 'delivered' ? agentWelcomeQuote(progress.welcome!.receipt) : undefined;
  return {
    stage,
    agent: {
      ...progress.agent,
      status: agentStatus(progress.config),
      ...agentAvatar(deps, progress.config),
      ...(progress.hasFirstAsk ? { hasFirstAsk: true } : {}),
    },
    channels: grants.length === 0 ? 'none'
      : grants.includes('needs_attention') ? 'needs_attention'
        : grants.includes('pending') ? 'joining' : 'joined',
    ...(slackUrl ? { slackUrl } : {}),
    ...(problem ? { problem } : {}),
    ...(hello ? { hello } : {}),
  };
}

function withUrl(url: string | undefined): { url?: string } {
  return url ? { url } : {};
}

function withAdminUrl(url: string | undefined): { adminUrl?: string } {
  return url ? { adminUrl: url } : {};
}

/** A date for people; the time zone is the deployment's UTC, so only the day is shown. */
function displayDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function when(at: number): { display: string; isoUtc: string } {
  const date = new Date(at);
  return {
    display: `${date.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC',
    })} UTC`,
    isoUtc: date.toISOString(),
  };
}
