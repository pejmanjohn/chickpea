export type UserGroupCredential = 'owner' | 'bot';

// No rate-limit code: Slack counts rate limits per app, so the bot would be limited too.
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

export async function withUserGroupAuthority<C, T>(input: {
  operation: string;
  owner: C | undefined;
  bot: C;
  call: (credential: C) => Promise<T>;
  errorCode: (outcome: T) => string | undefined;
  log?: (entry: Record<string, unknown>, level: 'info' | 'warn') => void;
}): Promise<{ outcome: T; answeredBy: UserGroupCredential }> {
  if (input.owner === undefined) return { outcome: await input.call(input.bot), answeredBy: 'bot' };
  const log = input.log ?? ((entry, level) => console[level](JSON.stringify(entry)));
  const entry = { event: 'chickpea.slack_user_groups.call', operation: input.operation };
  const owned = await input.call(input.owner);
  const ownerCode = input.errorCode(owned);
  if (ownerCode === undefined || !CALLER_REFUSALS.has(ownerCode)) {
    log({ ...entry, answeredBy: 'owner', code: ownerCode ?? 'ok' }, ownerCode === undefined ? 'info' : 'warn');
    return { outcome: owned, answeredBy: 'owner' };
  }
  const outcome = await input.call(input.bot);
  log({ ...entry, answeredBy: 'bot', code: input.errorCode(outcome) ?? 'ok', ownerCode }, 'warn');
  return { outcome, answeredBy: 'bot' };
}
