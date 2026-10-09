/**
 * Which credential answered a Slack `usergroups.*` call. Slack lets only
 * Owners and Admins deactivate a user group, so a host may hold the
 * installing Owner's user-group token beside the bot token; `owner` names
 * that token.
 */
export type UserGroupCredential = 'owner' | 'bot';

/**
 * Slack codes that refuse the caller rather than the request: a revoked,
 * deactivated or demoted Owner, or a token without the scope. The bot may
 * still be allowed. Everything else, rate limits and unreachable included,
 * would answer the bot the same way or is not the caller's fault.
 */
const CALLER_REFUSALS: ReadonlySet<string> = new Set([
  'token_revoked',
  'invalid_auth',
  'not_authed',
  'token_expired',
  'account_inactive',
  'missing_scope',
  'permission_denied',
  'not_allowed',
  'restricted_action',
  'two_factor_setup_required',
  'two_factor_required',
]);

/**
 * Make one `usergroups.*` call with the Owner's token when one is held, else
 * the bot's. When Slack refuses the Owner as caller, the call runs once more
 * with the bot, whose outcome stands. `refusal` reads Slack's error code from
 * an outcome, undefined for success. With an Owner token held, one line per
 * call records the operation, which credential answered and Slack's codes,
 * never a token or a user group.
 */
export async function withUserGroupAuthority<C, T>(input: {
  operation: string;
  owner: C | undefined;
  bot: C;
  call: (credential: C) => Promise<T>;
  refusal: (outcome: T) => string | undefined;
  log?: (entry: Record<string, unknown>) => void;
}): Promise<{ outcome: T; answeredBy: UserGroupCredential }> {
  if (input.owner === undefined) return { outcome: await input.call(input.bot), answeredBy: 'bot' };
  const log = input.log ?? ((entry) => console.warn(JSON.stringify(entry)));
  const entry = { event: 'chickpea.slack_user_groups.call', operation: input.operation };
  const owned = await input.call(input.owner);
  const ownerCode = input.refusal(owned);
  if (ownerCode === undefined || !CALLER_REFUSALS.has(ownerCode)) {
    log({ ...entry, answeredBy: 'owner', code: ownerCode ?? 'ok' });
    return { outcome: owned, answeredBy: 'owner' };
  }
  const outcome = await input.call(input.bot);
  log({ ...entry, answeredBy: 'bot', code: input.refusal(outcome) ?? 'ok', ownerCode });
  return { outcome, answeredBy: 'bot' };
}
