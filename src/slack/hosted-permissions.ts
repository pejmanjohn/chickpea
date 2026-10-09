import { slackAuthTest } from './credentials.ts';
import { missingRequestedSlackBotScopes, REQUESTED_SLACK_BOT_SCOPES } from './scopes.ts';

/**
 * Whether a hosted installation's Slack grant covers what the hosted app now
 * requests. A release that adds a feature scope leaves every existing grant
 * without it until an Owner approves Chickpea in Slack again; Admin shows a
 * bar until then.
 *
 * The decision reads only the active credential revision's validated scopes
 * and the requested set compiled into this build, confirmed by a live
 * `auth.test` while a gap exists. Runtime `missing_scope` errors never feed
 * it: they are per method and may name a scope Chickpea never requests, which
 * no update could clear.
 */
export type SlackPermissionsStatus = 'current' | 'update_needed' | 'unknown';

export interface SlackPermissionsView {
  status: SlackPermissionsStatus;
  /** Only an Owner on a host that supplies the update path. */
  canUpdate: boolean;
  /** Same-origin path the update form posts to; null when the host supplies none. */
  updatePath: string | null;
}

export interface HostedSlackPermissionsUpdate {
  /**
   * A same-origin path, such as `/start/reinstall`. Admin's plain form posts
   * there without any Core token, so the host route must enforce Origin and
   * the session itself.
   */
  path: string;
  /**
   * The update also asks the installing Owner for a user-group token, so an
   * active bundle without one needs the update too.
   */
  grantsUserGroupToken?: boolean;
}

let updatePath: string | null = null;
let grantsUserGroupToken = false;

/**
 * Install the host's update path, once at module scope; undefined removes it.
 * Without it, Admin offers no update and shows no bar.
 */
export function configureHostedSlackPermissionsUpdate(
  update: HostedSlackPermissionsUpdate | undefined,
): void {
  if (update === undefined) {
    updatePath = null;
    grantsUserGroupToken = false;
    return;
  }
  const path = update.path;
  if (typeof path !== 'string' || !/^\/(?![/\\])[A-Za-z0-9/_.~-]{0,255}$/.test(path)) {
    throw new Error('The Slack permissions update path must be a same-origin path.');
  }
  updatePath = path;
  grantsUserGroupToken = update.grantsUserGroupToken === true;
}

export function hostedSlackPermissionsUpdatePath(): string | null {
  return updatePath;
}

export function hostedSlackUpdateGrantsUserGroupToken(): boolean {
  return grantsUserGroupToken;
}

/** The scope evidence of one installation's active credential revision. */
export interface SlackPermissionsEvidence {
  /** The installation the revision belongs to; part of the memo key. */
  installationId: string;
  revision: string;
  grantedScopes: readonly string[];
  validatedAt: number | null;
}

export interface SlackPermissionsCheckDependencies {
  /** The installation's bot token, read only when a gap needs confirming. */
  botToken: () => Promise<string | undefined>;
  requiredUserGroupTokenHeld?: () => Promise<boolean>;
  authTest?: typeof slackAuthTest;
  warn?: (entry: Record<string, unknown>) => void;
  now?: () => number;
}

type SettledDecision = 'current' | 'update_needed';

/**
 * How long a gap Slack confirmed stands before Slack is asked again. Slack can
 * hold scopes the host did not record, such as an approval by another Slack
 * account, and only a live check sees them.
 */
const UPDATE_NEEDED_TTL_MS = 10 * 60_000;
const MEMO_LIMIT = 1_000;
const memo = new Map<string, { decision: SettledDecision; until: number }>();

function memoKey(evidence: SlackPermissionsEvidence, requested: readonly string[]): string {
  const requestedSet = [...new Set(requested)].sort().join(',');
  return `${evidence.installationId}\u0000${evidence.revision}\u0000${requestedSet}`;
}

function remember(key: string, decision: SettledDecision, until: number): SettledDecision {
  memo.delete(key);
  if (memo.size >= MEMO_LIMIT) memo.delete(memo.keys().next().value as string);
  memo.set(key, { decision, until });
  return decision;
}

/** Forget every memoized decision (tests). */
export function resetSlackPermissionsMemo(): void {
  memo.clear();
}

/**
 * Decide one installation's status. Its inputs change only with a release
 * (the requested set) or a reinstall (a new revision), and both move it
 * toward `current`. The live check can only remove a false positive: `current`
 * stands for the revision, and a confirmed gap is asked again after ten
 * minutes. So the bar cannot flap.
 */
export async function evaluateSlackPermissions(
  evidence: SlackPermissionsEvidence | undefined,
  dependencies: SlackPermissionsCheckDependencies,
  requested: readonly string[] = REQUESTED_SLACK_BOT_SCOPES,
): Promise<SettledDecision | 'unknown'> {
  const decision = await evaluateBotScopes(evidence, dependencies, requested);
  if (decision !== 'current' || !dependencies.requiredUserGroupTokenHeld) return decision;
  return await dependencies.requiredUserGroupTokenHeld() ? 'current' : 'update_needed';
}

async function evaluateBotScopes(
  evidence: SlackPermissionsEvidence | undefined,
  dependencies: SlackPermissionsCheckDependencies,
  requested: readonly string[],
): Promise<SettledDecision | 'unknown'> {
  // A revision written without validation says nothing about its grant.
  if (!evidence || evidence.validatedAt === null || evidence.grantedScopes.length === 0) return 'unknown';
  const missing = missingRequestedSlackBotScopes(evidence.grantedScopes, requested);
  if (missing.length === 0) return 'current';
  const key = memoKey(evidence, requested);
  const now = (dependencies.now ?? Date.now)();
  const settled = memo.get(key);
  if (settled && now < settled.until) return settled.decision;
  let live: string[] | undefined;
  try {
    const token = await dependencies.botToken();
    if (token) {
      const auth = await (dependencies.authTest ?? slackAuthTest)(token);
      if (auth.ok) live = auth.grantedScopes;
    }
  } catch {
    live = undefined;
  }
  // Slack could not confirm either way: keep the stored decision and ask
  // again on the next load.
  if (live === undefined) return 'update_needed';
  const granted = new Set(live);
  const stillMissing = missing.filter((scope) => !granted.has(scope));
  if (stillMissing.length > 0) return remember(key, 'update_needed', now + UPDATE_NEEDED_TTL_MS);
  // Slack already holds every scope, for example from a grant the host
  // refused to record. The stored evidence is behind; say so to operators.
  (dependencies.warn ?? ((entry) => console.warn(JSON.stringify(entry))))({
    event: 'chickpea.slack_permissions.stored_scopes_behind',
    installationId: evidence.installationId,
    revision: evidence.revision,
    storedMissing: missing,
  });
  return remember(key, 'current', Infinity);
}
