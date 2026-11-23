export interface SlackCommandAddress {
  botUserId?: string | undefined;
  agentUserGroupId?: string | undefined;
  /** The Agent's own Slack app's bot, which names the Agent wherever Chickpea's bot answers for it. */
  agentBotUserId?: string | undefined;
}

const UNRESOLVED_ADDRESS =
  /^(\s*)(?:(?:<@[^>\s]+>|<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>)\s*:?[ \t]*)+/i;

/**
 * Remove a leading Slack address only when it belongs to the routed base app
 * or Agent. This helper is an exact-command transport boundary; it never
 * classifies natural-language intent.
 */
export function stripResolvedSlackCommandAddress(
  rawText: string,
  address: SlackCommandAddress = {},
): string {
  const identities: string[] = [];
  for (const bot of [address.botUserId, address.agentBotUserId]) {
    if (bot) identities.push(`<@${escapeRegExp(bot)}>`);
  }
  if (address.agentUserGroupId) {
    identities.push(
      `<!subteam\\^${escapeRegExp(address.agentUserGroupId)}(?:\\|[^>]*)?>`,
    );
  }
  if (identities.length === 0) return rawText;
  return rawText.replace(
    new RegExp(`^\\s*(?:(?:${identities.join('|')})\\s*:?[ \\t]*)+`, 'i'),
    '',
  );
}

/** Candidate-only pre-pass. Its result must be reparsed with resolved IDs. */
export function stripUnresolvedSlackCommandAddress(rawText: string): string {
  return rawText.replace(UNRESOLVED_ADDRESS, '$1');
}

export function hasLeadingSlackCommandAddress(rawText: string): boolean {
  return UNRESOLVED_ADDRESS.test(rawText);
}

export function hasLeadingSlackUserAddress(rawText: string): boolean {
  return /^\s*<@[^>\s]+>/i.test(rawText);
}

/** Drop leading user mentions ahead of text normalization. User mentions only;
 * it deliberately leaves user-group addresses in place. */
export function stripLeadingUserMentions(text: string): string {
  return text.replace(/^\s*(?:<@[^>\s]+>\s*)+/i, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
