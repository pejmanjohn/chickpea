import { addSettingStringSetValues, readSettingStringSet } from '../config/setting-string-set.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ResolvedSlackInstallationCredentials } from './installation-credentials.ts';

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

// The Owner's token can no longer manage user groups until an Owner updates in
// Slack: it was revoked or expired, its person left, or its person lost the
// rights. Slack answers a demoted Owner's group change with permission_denied.
const OWNER_TOKEN_DEAD: ReadonlySet<string> = new Set([
  'token_revoked',
  'token_expired',
  'invalid_auth',
  'account_inactive',
  'not_allowed',
  'permission_denied',
]);

export async function withUserGroupAuthority<C, T>(input: {
  operation: string;
  owner: C | undefined;
  bot: C;
  call: (credential: C) => Promise<T>;
  errorCode: (outcome: T) => string | undefined;
  /** Told when Slack says the Owner's token no longer works. */
  ownerTokenDead?: () => Promise<void>;
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
  if (OWNER_TOKEN_DEAD.has(ownerCode)) await input.ownerTokenDead?.();
  const outcome = await input.call(input.bot);
  log({ ...entry, answeredBy: 'bot', code: input.errorCode(outcome) ?? 'ok', ownerCode }, 'warn');
  return { outcome, answeredBy: 'bot' };
}

/** The credential revisions whose Owner token Slack refused as dead. */
const DEAD_OWNER_TOKEN_REVISIONS = 'slack_user_group_token_dead_revisions';

type OwnerTokenSource = Pick<ResolvedSlackInstallationCredentials, 'userGroupToken' | 'connectionRevision'>;

export interface OwnerUserGroupToken {
  token: string;
  dead: () => Promise<void>;
}

/**
 * The installation's Owner token, if it holds one, and how to record that it
 * died. The record names the credential revision, so the next Owner update
 * clears the bar, and a late refusal from another revision cannot raise or
 * clear it.
 */
export function ownerUserGroupToken(
  credentials: OwnerTokenSource,
  settings: SettingsStore,
): OwnerUserGroupToken | undefined {
  const { userGroupToken: token, connectionRevision: revision } = credentials;
  if (!token) return undefined;
  return {
    token,
    dead: async () => {
      if (!revision) return;
      try {
        await addSettingStringSetValues(settings, DEAD_OWNER_TOKEN_REVISIONS, [revision]);
      } catch (error) {
        console.warn(JSON.stringify({
          event: 'chickpea.slack_user_groups.dead_token_unrecorded',
          error: error instanceof Error ? error.name : 'unknown',
        }));
      }
    },
  };
}

/** Whether the installation holds an Owner token Slack has not refused as dead. */
export async function ownerUserGroupTokenWorks(credentials: OwnerTokenSource, settings: SettingsStore): Promise<boolean> {
  const { userGroupToken: token, connectionRevision: revision } = credentials;
  if (!token || !revision) return false;
  return !(await readSettingStringSet(settings, DEAD_OWNER_TOKEN_REVISIONS)).includes(revision);
}
