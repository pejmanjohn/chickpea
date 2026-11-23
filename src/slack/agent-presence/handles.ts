import type { CustomAgentConfig } from '../../config/types.ts';
import type { SlackUserGroup } from '../transport/types.ts';

const SLACK_AGENT_HANDLE_MAX_LENGTH = 80;
// Slack's method docs name description_too_long but give no number. A QA
// workspace accepted 140 and refused 141 on create and update, counting code
// points, not bytes or UTF-16 units (2026-11-06).
const SLACK_USER_GROUP_DESCRIPTION_MAX_LENGTH = 140;

/** Slack-compatible user-group handle derived from editable user input. */
export function normalizeAgentHandle(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLACK_AGENT_HANDLE_MAX_LENGTH)
    .replace(/-+$/g, '');
  return normalized || 'agent';
}

type HandleHolder = Pick<CustomAgentConfig, 'id' | 'lifecycle' | 'slackPresence'>;

/** An Agent is in Slack when it has a user group or its own app. */
export function agentIsInSlack(agent: Pick<CustomAgentConfig, 'slackPresence'>): boolean {
  const presence = agent.slackPresence;
  return presence?.kind === 'agent_app' || presence?.userGroupId !== undefined;
}

/**
 * Choosing a handle (creating or renaming an Agent): the handles every other
 * unarchived Agent stores, in Slack or not. Slack keeps user-group handles
 * unique but not bot names, so this is Chickpea's own rule.
 */
export function handlesOtherAgentsStore(agents: readonly HandleHolder[], agentId: string): Set<string> {
  return otherAgentHandles(agents, agentId, () => true);
}

/**
 * Taking a handle in Slack (publish, Retry, turning on, restore): the handles
 * other unarchived Agents hold there. An Agent not in Slack yet holds none, so
 * the first of two that store one handle to publish takes it.
 */
export function handlesOtherAgentsHoldInSlack(agents: readonly HandleHolder[], agentId: string): Set<string> {
  return otherAgentHandles(agents, agentId, agentIsInSlack);
}

function otherAgentHandles(
  agents: readonly HandleHolder[],
  agentId: string,
  counts: (agent: HandleHolder) => boolean,
): Set<string> {
  return new Set(agents.flatMap((agent) =>
    agent.id !== agentId && agent.lifecycle !== 'archived' && agent.slackPresence && counts(agent)
      ? [agent.slackPresence.normalizedHandle]
      : []));
}

export function alternativeAgentHandles(
  requested: string,
  occupied: ReadonlySet<string>,
  count = 3,
): string[] {
  const base = normalizeAgentHandle(requested);
  const withEnding = (ending: string) =>
    `${base.slice(0, SLACK_AGENT_HANDLE_MAX_LENGTH - ending.length)}${ending}`;
  const suggestions: string[] = [];
  if (!base.endsWith('-team')) {
    const team = withEnding('-team');
    if (!occupied.has(team)) suggestions.push(team);
  }
  for (let suffix = 2; suggestions.length < count && suffix < 10_000; suffix += 1) {
    const candidate = withEnding(`-${suffix}`);
    if (!occupied.has(candidate)) suggestions.push(candidate);
  }
  return suggestions;
}

/**
 * Slack refuses a user group whose name another group already has. Agents reply
 * under their own name either way, so the group can carry a variation while the
 * Agent's name is taken.
 */
export function agentUserGroupName(
  agentName: string,
  groups: readonly Pick<SlackUserGroup, 'id' | 'name'>[],
  ownGroupId?: string,
): string {
  const key = (name: string) => name.trim().toLowerCase();
  const taken = new Set(groups.filter((group) => group.id !== ownGroupId).map((group) => key(group.name)));
  if (!taken.has(key(agentName))) return agentName;
  const base = agentName.trim();
  if (!/(?:^|\s)agent$/i.test(base) && !taken.has(key(`${base} Agent`))) return `${base} Agent`;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(key(candidate))) return candidate;
  }
}

/**
 * The description Slack shows for an Agent's user group. The Agent keeps its
 * own description; the group's copy ends at a word with an ellipsis when the
 * full text is longer than Slack allows.
 */
export function agentUserGroupDescription(agent: { name: string; description?: string }): string {
  const description = agent.description ?? `${agent.name} Agent`;
  const characters = [...description];
  if (characters.length <= SLACK_USER_GROUP_DESCRIPTION_MAX_LENGTH) return description;
  const head = characters.slice(0, SLACK_USER_GROUP_DESCRIPTION_MAX_LENGTH).join('');
  const lastSpace = head.search(/\s\S*$/);
  const cut = lastSpace > 0
    ? head.slice(0, lastSpace)
    : characters.slice(0, SLACK_USER_GROUP_DESCRIPTION_MAX_LENGTH - 1).join('');
  return `${cut.replace(/[\s.,;:]+$/, '')}…`;
}
