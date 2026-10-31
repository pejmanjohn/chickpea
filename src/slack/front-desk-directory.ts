import type { ConfigStore } from '../config/store.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  agentAppIsLive,
  type AgentConnectionBinding,
  type ConnectionAccount,
  type CustomAgentConfig,
  type FrontDeskAgent,
  type FrontDeskDirectory,
  type RecentSlackAgentReply,
} from '../config/types.ts';
import { CHICKPEA_AGENT_ID } from '../config/agent-id.ts';
import { compileWebsiteLogins } from '../agents/runtime-plan.ts';
import { browserCapabilityForTurn } from '../browser/capability.ts';
import { listWebsiteLogins, type WebsiteLogin } from '../browser/logins.ts';
import { projectEffectiveConnectionAccounts } from '../connections/runtime.ts';
import {
  listPrivatelyUsableAgents,
  type PrivateAgentActor,
  type PrivatelyUsableAgents,
} from './agent-access.ts';
import {
  FRONT_DESK_MAX_AGENTS,
  FRONT_DESK_MAX_BLOCK_CHARS,
  FRONT_DESK_MAX_LIST_NAMES,
  FRONT_DESK_MAX_NAME_CHARS,
  FRONT_DESK_MAX_PURPOSE_CHARS,
  FRONT_DESK_RECENT_WINDOW_MS,
  clampText,
  inlineText,
  pickRecentFrontDeskAgent,
  renderFrontDeskBlock,
  slackTsAt,
} from './front-desk.ts';

/** The facts one directory is assembled from, read once at ingress. */
export interface FrontDeskFacts {
  usable: PrivatelyUsableAgents;
  accounts: readonly ConnectionAccount[];
  bindings: ReadonlyMap<string, readonly AgentConnectionBinding[]>;
  actorMembershipId?: string;
  /** Present only while the browser is connected. */
  websiteLogins?: readonly WebsiteLogin[];
  recentReplies: readonly RecentSlackAgentReply[];
  nowMs: number;
}

/**
 * The usable Agents the front desk may list. An Agent with its own live
 * Slack app is left out: it posts as its own bot, which is not in this DM.
 */
export function frontDeskCandidates(usable: PrivatelyUsableAgents): CustomAgentConfig[] {
  return usable.agents.filter((agent) =>
    agent.kind === 'user' && agent.id !== CHICKPEA_AGENT_ID && !agentAppIsLive(agent.slackPresence));
}

/** The candidates in listing order: the recent Agent first, then by name. */
function orderFrontDeskCandidates(
  usable: PrivatelyUsableAgents,
  replies: readonly RecentSlackAgentReply[],
  nowMs: number,
): { ordered: CustomAgentConfig[]; recent: FrontDeskDirectory['recent'] } {
  const candidates = frontDeskCandidates(usable);
  const recent = pickRecentFrontDeskAgent(replies, new Set(candidates.map(({ id }) => id)), nowMs);
  return {
    ordered: recent
      ? [
          ...candidates.filter(({ id }) => id === recent.agentId),
          ...candidates.filter(({ id }) => id !== recent.agentId),
        ]
      : candidates,
    recent,
  };
}

export function assembleFrontDeskDirectory(facts: FrontDeskFacts): FrontDeskDirectory | undefined {
  const { ordered, recent } = orderFrontDeskCandidates(facts.usable, facts.recentReplies, facts.nowMs);
  if (ordered.length === 0) return undefined;
  const listed = ordered.slice(0, FRONT_DESK_MAX_AGENTS).map((agent) => frontDeskAgent(agent, facts));
  return fitFrontDeskDirectory({
    agents: listed,
    omitted: ordered.length - listed.length,
    incomplete: facts.usable.incomplete,
    ...(recent ? { recent } : {}),
  }, facts.nowMs);
}

/**
 * Read the facts for one person's directory and assemble it. Who is listed
 * is `listPrivatelyUsableAgents`, the rule routing applies to a DM; the rest
 * is what that person would get in a run of each listed Agent.
 */
export async function readFrontDeskDirectory(input: {
  workspaceId: string;
  channelId: string;
  actor: PrivateAgentActor;
  transport: Parameters<typeof listPrivatelyUsableAgents>[0]['transport'];
  config: Pick<
    ConfigStore,
    | 'listAgents'
    | 'listAgentChannelGrants'
    | 'listConnectionAccounts'
    | 'listAgentConnectionBindings'
    | 'listRecentSlackAgentReplies'
  >;
  settings: SettingsStore;
  platformEnv?: Record<string, unknown>;
  nowMs?: number;
}): Promise<FrontDeskDirectory | undefined> {
  const nowMs = input.nowMs ?? Date.now();
  const [agents, grants] = await Promise.all([
    input.config.listAgents(),
    input.config.listAgentChannelGrants(input.workspaceId),
  ]);
  const usable = await listPrivatelyUsableAgents({
    agents,
    workspaceId: input.workspaceId,
    grants,
    actor: input.actor,
    transport: input.transport,
  });
  if (frontDeskCandidates(usable).length === 0) return undefined;
  const recentReplies = await input.config.listRecentSlackAgentReplies({
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    sinceMessageTs: slackTsAt(nowMs - FRONT_DESK_RECENT_WINDOW_MS),
  });
  const listed = orderFrontDeskCandidates(usable, recentReplies, nowMs).ordered.slice(0, FRONT_DESK_MAX_AGENTS);
  const [accounts, bindings, browser] = await Promise.all([
    input.config.listConnectionAccounts(input.workspaceId),
    Promise.all(listed.map(async (agent) =>
      [agent.id, await input.config.listAgentConnectionBindings(agent.id)] as const)),
    listed.some((agent) => agent.websiteLogins?.some(({ enabled }) => enabled))
      ? browserCapabilityForTurn(input.settings, input.platformEnv)
      : undefined,
  ]);
  const websiteLogins = browser ? await listWebsiteLogins(input.settings).catch(() => []) : undefined;
  return assembleFrontDeskDirectory({
    usable,
    accounts,
    bindings: new Map(bindings),
    ...(input.actor.membershipId ? { actorMembershipId: input.actor.membershipId } : {}),
    ...(websiteLogins ? { websiteLogins } : {}),
    recentReplies,
    nowMs,
  });
}

function frontDeskAgent(agent: CustomAgentConfig, facts: FrontDeskFacts): FrontDeskAgent {
  const connections = capNames(projectEffectiveConnectionAccounts(
    [...facts.accounts],
    [...facts.bindings.get(agent.id) ?? []],
    facts.actorMembershipId ?? '',
  ).map(({ account }) => account.label));
  const websiteHosts = capNames(facts.websiteLogins
    ? compileWebsiteLogins(agent.websiteLogins, facts.websiteLogins).map(({ host }) => host)
    : []);
  const skills = capNames(agent.skills.filter(({ enabled }) => enabled).map(({ name }) => name));
  const purpose = firstSentence(agent.description);
  const handle = agent.slackPresence?.normalizedHandle;
  return {
    id: agent.id,
    name: inlineText(agent.name),
    ...(handle ? { handle } : {}),
    ...(purpose ? { purpose } : {}),
    connections: connections.names,
    websiteHosts: websiteHosts.names,
    skills: skills.names,
    more: { connections: connections.more, websiteHosts: websiteHosts.more, skills: skills.more },
  };
}

/** Moves Agents past the block's budget into `omitted`, last first. */
function fitFrontDeskDirectory(directory: FrontDeskDirectory, nowMs: number): FrontDeskDirectory | undefined {
  let fitted = directory;
  while (fitted.agents.length > 0 && renderFrontDeskBlock(fitted, nowMs).length > FRONT_DESK_MAX_BLOCK_CHARS) {
    const agents = fitted.agents.slice(0, -1);
    const { recent: _recent, ...rest } = fitted;
    const recent = fitted.recent && agents.some(({ id }) => id === fitted.recent!.agentId) ? fitted.recent : undefined;
    fitted = { ...rest, agents, omitted: fitted.omitted + 1, ...(recent ? { recent } : {}) };
  }
  return fitted.agents.length > 0 ? fitted : undefined;
}

function capNames(names: readonly string[]): { names: string[]; more: number } {
  const unique = [...new Set(names.map(inlineText).filter(Boolean))];
  return {
    names: unique.slice(0, FRONT_DESK_MAX_LIST_NAMES).map((name) => clampText(name, FRONT_DESK_MAX_NAME_CHARS)),
    more: Math.max(0, unique.length - FRONT_DESK_MAX_LIST_NAMES),
  };
}

function firstSentence(text: string | undefined): string | undefined {
  const flat = inlineText(text ?? '');
  if (!flat) return undefined;
  const end = flat.search(/[.!?](\s|$)/);
  return clampText(end >= 0 ? flat.slice(0, end + 1) : flat, FRONT_DESK_MAX_PURPOSE_CHARS);
}

