import slackAppManifest from '../../slack-app-manifest.json' with { type: 'json' };

/**
 * The committed Slack manifest is the authority for every bot installation.
 * Keeping scope validation here prevents the onboarding wizard and dedicated
 * identity flow from drifting away from what Slack is asked to grant.
 */
export const REQUESTED_SLACK_BOT_SCOPES = Object.freeze([
  ...slackAppManifest.oauth_config.scopes.bot,
]);
const UPCOMING_FEATURE_SCOPES: readonly string[] = Object.freeze([
  'channels:manage', 'groups:write', 'im:read', 'mpim:write', 'team:read', 'canvases:read', 'canvases:write',
]);
/**
 * Requested scopes an installation may lack while ordinary chat keeps working,
 * grouped by the release that added them. A scope added after an installation
 * exists belongs here, never in the required set, and its feature explains
 * its absence: existing grants stay valid for reinstall and recovery until an
 * Owner updates them. Without `mpim:history`, an Agent answering in a group DM
 * reads none of its earlier messages.
 *
 * An app made from an older manifest lacks whole groups, so recovery and the
 * lane preflight enumerate groups, not scopes.
 */
export const SLACK_FEATURE_SCOPE_GROUPS: readonly (readonly string[])[] = Object.freeze([
  ['lists:read', 'lists:write'], ['mpim:history'], UPCOMING_FEATURE_SCOPES,
]);
export const SLACK_FEATURE_SCOPES: readonly string[] = Object.freeze(SLACK_FEATURE_SCOPE_GROUPS.flat());
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
/** User scopes a hosted install asks the installing Owner for; that token is used only for `usergroups.*` calls. */
export const SLACK_USER_GROUP_SCOPES = Object.freeze(['usergroups:read', 'usergroups:write']);
/**
 * What an Agent's own Slack app asks for: the workspace app's bot scopes
 * without user groups, sender customization or email reads, none of which an
 * Agent that is its own bot needs, and without group DM history: group DMs
 * are served through the workspace app, and an Agent app's scopes and events
 * are not changed for them, so a mention of its bot in a group DM reads none
 * of the group's earlier messages. It also leaves out the scopes requested
 * for upcoming features: an Agent app made before them was never granted
 * them, and its consent must keep passing. It keeps `channels:join` so that
 * adding the Agent to a public Channel brings its bot in where Chickpea's bot
 * cannot invite it: an installation granted before `channels:manage` lacks it.
 */
const AGENT_APP_LEAVES_OUT = new Set([
  'chat:write.customize', 'users:read.email', 'mpim:history', ...UPCOMING_FEATURE_SCOPES,
]);
export const AGENT_APP_BOT_SCOPES: readonly string[] = Object.freeze(REQUESTED_SLACK_BOT_SCOPES.filter((scope) =>
  !scope.startsWith('usergroups:') && !AGENT_APP_LEAVES_OUT.has(scope)
));

/**
 * The feature scope sets an installation's stored manifest can hold: what its
 * token was granted, then every whole-group combination, each in manifest
 * order and deduplicated. Bounded by 1 + 2^groups entries.
 */
export function recoverableSlackFeatureScopeSets(grantedScopes: readonly string[]): string[][] {
  const granted = SLACK_FEATURE_SCOPES.filter((scope) => grantedScopes.includes(scope));
  const seen = new Set<string>();
  return [granted, ...subsets(SLACK_FEATURE_SCOPE_GROUPS).map((groups) => groups.flat())]
    .filter((scopes) => {
      const key = scopes.join(',');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Every subset of `values`, the empty one included, each in the order of `values`. */
export function subsets<T>(values: readonly T[]): T[][] {
  return values.reduce<T[][]>((all, value) => [...all, ...all.map((subset) => [...subset, value])], [[]]);
}

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
