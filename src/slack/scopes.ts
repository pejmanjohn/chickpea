import slackAppManifest from '../../slack-app-manifest.json' with { type: 'json' };

/**
 * The committed Slack manifest is the authority for every bot installation.
 * Keeping scope validation here prevents the onboarding wizard and dedicated
 * identity flow from drifting away from what Slack is asked to grant.
 */
export const REQUESTED_SLACK_BOT_SCOPES = Object.freeze([
  ...slackAppManifest.oauth_config.scopes.bot,
]);
/**
 * Requested scopes an installation may lack while ordinary chat keeps working.
 * A scope added after an installation exists belongs here, never in the
 * required set, and its feature explains its absence: existing grants stay
 * valid for reinstall and recovery until an Owner updates them. Lists are the
 * only one today.
 */
export const SLACK_FEATURE_SCOPES = Object.freeze(['lists:read', 'lists:write']);
/** Feature scopes are additive: a core-only installation must keep serving ordinary chat. */
export const REQUIRED_SLACK_BOT_SCOPES = Object.freeze(REQUESTED_SLACK_BOT_SCOPES.filter(scope => !SLACK_FEATURE_SCOPES.includes(scope)));
/**
 * Scopes the manifest no longer requests but older grants still hold. Slack
 * is expected to keep a bot token's scopes across re-grants (to confirm live
 * in H13b), so a scope removed from the manifest would return on every
 * existing installation's next reinstall or recovery. List it here when
 * removing it so those grants are not refused.
 */
export const RETIRED_SLACK_BOT_SCOPES: readonly string[] = Object.freeze([]);
/**
 * User scopes a hosted install asks the installing Owner for. Slack lets only
 * Owners and Admins deactivate a user group, so archiving an Agent needs a
 * token with an Owner's rights; it is used only for `usergroups.*` calls.
 */
export const SLACK_USER_GROUP_SCOPES = Object.freeze(['usergroups:read', 'usergroups:write']);

/** Parse Slack's comma-delimited `x-oauth-scopes` response header. */
export function parseSlackGrantedScopes(value: string | null): string[] | undefined {
  if (value === null) return undefined;
  return [...new Set(value.split(',').map((scope) => scope.trim()).filter(Boolean))];
}

/**
 * Return the manifest scopes absent from a live token. An undefined result
 * means the Slack-compatible endpoint omitted its scope header, so callers
 * cannot make a scope claim from that response alone.
 */
export function missingRequiredSlackBotScopes(
  grantedScopes: readonly string[] | undefined,
): string[] | undefined {
  if (grantedScopes === undefined) return undefined;
  const granted = new Set(grantedScopes);
  return REQUIRED_SLACK_BOT_SCOPES.filter((scope) => !granted.has(scope));
}

/**
 * Return the requested scopes a grant lacks, feature scopes included: what an
 * Owner's update would add. Order and duplicates in the grant do not matter.
 */
export function missingRequestedSlackBotScopes(
  grantedScopes: readonly string[],
  requested: readonly string[] = REQUESTED_SLACK_BOT_SCOPES,
): string[] {
  const granted = new Set(grantedScopes);
  return [...new Set(requested)].filter((scope) => !granted.has(scope));
}

/** Return scopes Slack granted that are neither requested by the manifest nor retired from it. */
export function unexpectedSlackBotScopes(
  grantedScopes: readonly string[] | undefined,
  retired: readonly string[] = RETIRED_SLACK_BOT_SCOPES,
): string[] | undefined {
  if (grantedScopes === undefined) return undefined;
  const allowed = new Set([...REQUESTED_SLACK_BOT_SCOPES, ...retired]);
  return grantedScopes.filter((scope) => !allowed.has(scope));
}
