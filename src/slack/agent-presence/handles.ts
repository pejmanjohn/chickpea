import type { SlackUserGroup } from '../transport/types.ts';

const SLACK_AGENT_HANDLE_MAX_LENGTH = 80;

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
