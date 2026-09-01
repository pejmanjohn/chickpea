export interface SlackCommandAddress {
  botUserId?: string | undefined;
  agentUserGroupId?: string | undefined;
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
  if (address.botUserId) {
    identities.push(`<@${escapeRegExp(address.botUserId)}>`);
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
