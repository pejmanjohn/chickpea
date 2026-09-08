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
  const suggestions: string[] = [];
  for (let suffix = 2; suggestions.length < count && suffix < 10_000; suffix += 1) {
    const ending = `-${suffix}`;
    const candidate = `${base.slice(0, SLACK_AGENT_HANDLE_MAX_LENGTH - ending.length)}${ending}`;
    if (!occupied.has(candidate)) suggestions.push(candidate);
  }
  return suggestions;
}
