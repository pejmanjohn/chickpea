import slackAppManifest from '../../slack-app-manifest.json' with { type: 'json' };

/**
 * The committed Slack manifest is the authority for every bot installation.
 * Keeping scope validation here prevents the onboarding wizard and dedicated
 * identity flow from drifting away from what Slack is asked to grant.
 */
export const REQUIRED_SLACK_BOT_SCOPES = Object.freeze([
  ...slackAppManifest.oauth_config.scopes.bot,
]);
const REQUIRED_SLACK_BOT_SCOPE_SET = new Set(REQUIRED_SLACK_BOT_SCOPES);

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

/** Return scopes Slack granted that are not in the committed manifest. */
export function unexpectedSlackBotScopes(
  grantedScopes: readonly string[] | undefined,
): string[] | undefined {
  if (grantedScopes === undefined) return undefined;
  return grantedScopes.filter((scope) => !REQUIRED_SLACK_BOT_SCOPE_SET.has(scope));
}
