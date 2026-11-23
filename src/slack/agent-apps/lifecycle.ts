import {
  AWAITING_OWN_APP,
  type ActiveAgentApp,
  type AgentSlackPresence,
  type AgentAppAttention,
  type AgentAppIcon,
  type AgentAppLifecycle,
  type AgentAppPresence,
  type AgentAppRecord,
  type AgentAppResume,
  type AgentAppSwitchProgress,
  type AgentPresenceDesiredState,
  type AgentPresenceHealth,
  type AttachedAgentApp,
  appRecordOf,
} from '../../config/types.ts';

export { agentAppIsLive } from '../../config/types.ts';

/** How long a `creating` record may wait for Slack's answer before the create is ambiguous. */
export const CREATE_SETTLE_MS = 60_000;

export type AgentAppStep =
  | 'release_handle'
  | 'create'
  | 'set_urls'
  | 'set_icon'
  | 'post_allow_dm'
  | 'uninstall'
  | 'delete';

export type AgentAppEvent =
  | { type: 'handle_released'; at: number; manifestFingerprint: string }
  | { type: 'handle_release_refused'; at: number }
  /** Slack refused the release because the installation lacks the Owner's user-group permission. */
  | { type: 'handle_permission_missing'; at: number }
  | { type: 'created'; at: number; app: AgentAppRecord }
  | { type: 'create_refused'; at: number; reason: 'create_refused' | 'slack_busy' }
  | { type: 'create_ambiguous'; at: number }
  /** The recorded app has no record, so it is left for the Owner; create again. */
  | { type: 'recreate'; at: number; manifestFingerprint: string }
  | { type: 'urls_set'; at: number }
  | { type: 'urls_refused'; at: number }
  | { type: 'config_token_needed'; at: number }
  | { type: 'icon_set'; at: number; icon: AgentAppIcon }
  | { type: 'allow_dm_posted'; at: number; channelId: string; ts: string }
  | { type: 'consent_opened'; at: number; nonceDigest: string; owner: string; expiresAt: number }
  | { type: 'consent_granted'; at: number; botUserId: string; installedBy: string }
  /** That Owner's open Allow link is spent or undone; any other Owner's stays open. */
  | { type: 'consent_undone'; at: number; owner: string }
  | { type: 'app_removed'; at: number }
  | { type: 'archive'; at: number; hasBotToken: boolean }
  | { type: 'uninstalled'; at: number }
  | { type: 'uninstall_refused'; at: number }
  /** Slack never answered the uninstall of a live app, so it is still installed. */
  | { type: 'uninstall_unanswered'; at: number; restore: ActiveAgentApp }
  | { type: 'deleted'; at: number }
  /** The app's record is unreadable or another Agent's, so Chickpea will not update the app or set its icon. */
  | { type: 'record_refused'; at: number }
  | { type: 'try_again'; at: number; startedBy: string; manifestFingerprint: string };

export interface AgentAppRefusal {
  readonly refused: 'wrong_state' | 'create_settling';
}

/** The app is gone and the presence returns to its user group. */
export interface AgentAppDeleted {
  readonly state: 'deleted';
}

/** Nothing changed in Slack, so the start is undone and the presence returns to its user group as it was. */
export interface AgentAppWithdrawn {
  readonly state: 'withdrawn';
}

export type AgentAppTransition = AgentAppLifecycle | AgentAppDeleted | AgentAppWithdrawn | AgentAppRefusal;

const WRONG_STATE: AgentAppRefusal = { refused: 'wrong_state' };
const CREATE_SETTLING: AgentAppRefusal = { refused: 'create_settling' };
const WITHDRAWN: AgentAppWithdrawn = { state: 'withdrawn' };

export function isRefusal(result: AgentAppTransition): result is AgentAppRefusal {
  return 'refused' in result;
}

/** The switch step a live app still owes; undefined once the switch is done, as for a record stored before it was tracked. */
export function pendingSwitchStep(app: AgentAppLifecycle): Exclude<AgentAppSwitchProgress, 'done'> | undefined {
  return app.state === 'active' && app.switchProgress && app.switchProgress !== 'done' ? app.switchProgress : undefined;
}

/**
 * A presence whose app Slack removed while the app held the handle, so the
 * group it released has not yet been turned back on: the driver's restore is
 * due. One whose group Slack refused to turn on, the Owner told, waits for
 * an Owner.
 */
export function restorePending(
  presence: AgentSlackPresence | undefined,
): presence is AgentAppPresence & { app: Extract<AgentAppLifecycle, { state: 'needs_attention' }> } {
  return presence?.kind === 'agent_app' && presence.app.state === 'needs_attention' && presence.app.reason === 'app_removed' &&
    presence.released?.enableRefused !== true;
}

/** The job that drives one Agent's move to or from its own Slack app, outside the request that started it. */
export interface AgentAppSwitchJob {
  agentId: string;
  appId: string;
  teamId: string;
  ownerSlackUserId: string;
}

/** The job an Agent's move still owes: a live app's switch with steps left, or a removed app's restore. */
export function agentAppMoveJob(agentId: string, presence: AgentSlackPresence | undefined, teamId: string): AgentAppSwitchJob | undefined {
  if (presence?.kind !== 'agent_app') return undefined;
  const { app } = presence;
  if (app.state === 'active' && pendingSwitchStep(app)) {
    return { agentId, appId: app.app.appId, teamId, ownerSlackUserId: app.installedBy };
  }
  if (restorePending(presence) && presence.app.app) {
    return { agentId, appId: presence.app.app.appId, teamId, ownerSlackUserId: presence.app.startedBy };
  }
  return undefined;
}

/**
 * Where an Agent stands in Slack, as an Owner chooses what to do next:
 * answering through Chickpea's user group, not in Slack yet, or somewhere on
 * the way to, or at, its own app.
 */
export type AgentSlackState =
  | { state: 'user_group' | 'not_in_slack' | 'creating' | 'waiting_for_allow' | 'switching' | 'own_app' }
  | { state: 'needs_attention'; reason: AgentAppAttention };

export function agentSlackState(presence: AgentSlackPresence): AgentSlackState {
  const app = appRecordOf(presence);
  const unattached = (): AgentSlackState => ({ state: presence.errorCode === AWAITING_OWN_APP ? 'not_in_slack' : 'user_group' });
  if (!app) return unattached();
  switch (app.state) {
    case 'awaiting_consent':
      return { state: 'waiting_for_allow' };
    case 'active':
      return { state: pendingSwitchStep(app) ? 'switching' : 'own_app' };
    case 'needs_attention':
      return { state: 'needs_attention', reason: app.reason };
    case 'uninstalling':
      // A cancel leaves the Agent answering as it did before the press; an archive's uninstall is passing.
      return presence.kind === 'agent_app' ? { state: 'switching' } : unattached();
    default:
      return { state: 'creating' };
  }
}

/** A `creating` record Slack never answered within the settle window; nothing creates again until Try again. */
export function createIsStale(app: AgentAppLifecycle, now: number): boolean {
  return app.state === 'creating' && now - app.at >= CREATE_SETTLE_MS;
}

/** The one external effect due next; undefined while the record waits for a person, Slack, or another run. */
export function nextStep(app: AgentAppLifecycle, now: number): AgentAppStep | undefined {
  switch (app.state) {
    case 'releasing_handle':
      return 'release_handle';
    case 'creating':
      return createIsStale(app, now) ? undefined : 'create';
    case 'created':
      return 'set_urls';
    case 'urls_set':
      return 'set_icon';
    case 'icon_set':
      return 'post_allow_dm';
    case 'uninstalling':
      return app.next;
    case 'awaiting_consent':
    case 'active':
    case 'needs_attention':
      return undefined;
  }
}

export function agentAppRecord(app: AgentAppLifecycle): AgentAppRecord | undefined {
  return 'app' in app ? app.app : undefined;
}

/** Every allowed transition; any other pair is a refusal the caller maps to copy. */
export function transition(app: AgentAppLifecycle, event: AgentAppEvent): AgentAppTransition {
  const at = event.at;
  switch (event.type) {
    case 'handle_released':
      return app.state === 'releasing_handle'
        ? { state: 'creating', at, startedBy: app.startedBy, manifestFingerprint: event.manifestFingerprint }
        : WRONG_STATE;
    case 'handle_release_refused':
      return app.state === 'releasing_handle'
        ? attention(app.startedBy, at, 'handle_release_failed', 'releasing_handle')
        : WRONG_STATE;
    case 'handle_permission_missing':
      return app.state === 'releasing_handle' ? WITHDRAWN : WRONG_STATE;
    case 'created':
      return app.state === 'creating'
        ? { state: 'created', at, startedBy: app.startedBy, app: event.app }
        : WRONG_STATE;
    case 'create_refused':
      return app.state === 'creating' ? attention(app.startedBy, at, event.reason, 'creating') : WRONG_STATE;
    case 'create_ambiguous':
      return app.state === 'creating' ? attention(app.startedBy, at, 'ambiguous_create', 'creating') : WRONG_STATE;
    case 'recreate':
      return app.state === 'created'
        ? { state: 'creating', at, startedBy: app.startedBy, manifestFingerprint: event.manifestFingerprint }
        : WRONG_STATE;
    case 'urls_set':
      return app.state === 'created' ? { state: 'urls_set', at, startedBy: app.startedBy, app: app.app } : WRONG_STATE;
    case 'urls_refused':
      return app.state === 'created'
        ? attention(app.startedBy, at, 'urls_refused', 'created', { app: app.app })
        : WRONG_STATE;
    case 'config_token_needed':
      if (app.state === 'creating') return attention(app.startedBy, at, 'config_token_needed', 'creating');
      if (app.state === 'created') return attention(app.startedBy, at, 'config_token_needed', 'created', { app: app.app });
      return WRONG_STATE;
    case 'icon_set':
      return app.state === 'urls_set'
        ? { state: 'icon_set', at, startedBy: app.startedBy, app: app.app, icon: event.icon }
        : WRONG_STATE;
    case 'allow_dm_posted':
      return app.state === 'icon_set'
        ? {
            state: 'awaiting_consent',
            at,
            startedBy: app.startedBy,
            app: app.app,
            icon: app.icon,
            allowDm: { channelId: event.channelId, ts: event.ts },
          }
        : WRONG_STATE;
    case 'consent_opened': {
      if (app.state !== 'awaiting_consent') return WRONG_STATE;
      const open = Object.entries(app.consents ?? {}).filter(([owner, consent]) => owner !== event.owner && consent.expiresAt > at);
      return {
        ...app,
        at,
        consents: Object.fromEntries([...open, [event.owner, { nonceDigest: event.nonceDigest, expiresAt: event.expiresAt }]]),
      };
    }
    case 'consent_granted':
      return app.state === 'awaiting_consent'
        ? {
            state: 'active',
            at,
            app: app.app,
            icon: app.icon,
            botUserId: event.botUserId,
            installedAt: at,
            installedBy: event.installedBy,
            // The switch's first step turns off a group that still answers, and passes when none does.
            switchProgress: 'group_pending',
          }
        : WRONG_STATE;
    case 'consent_undone': {
      if (app.state !== 'awaiting_consent') return WRONG_STATE;
      const { consents, ...waiting } = app;
      const open = Object.entries(consents ?? {}).filter(([owner]) => owner !== event.owner);
      return { ...waiting, at, ...(open.length ? { consents: Object.fromEntries(open) } : {}) };
    }
    case 'app_removed':
      return app.state === 'active'
        ? attention(app.installedBy, at, 'app_removed', 'icon_set', { app: app.app, icon: app.icon })
        : WRONG_STATE;
    case 'archive': {
      if (app.state === 'creating') return createIsStale(app, at) ? { state: 'deleted' } : CREATE_SETTLING;
      if (app.state === 'uninstalling') return app;
      const record = agentAppRecord(app);
      if (!record) return { state: 'deleted' };
      const botUserId = 'botUserId' in app ? app.botUserId : undefined;
      return {
        state: 'uninstalling',
        at,
        startedBy: app.state === 'active' ? app.installedBy : app.startedBy,
        app: record,
        ...(botUserId ? { botUserId } : {}),
        next: event.hasBotToken ? 'uninstall' : 'delete',
      };
    }
    case 'uninstalled':
      return app.state === 'uninstalling' && app.next === 'uninstall' ? { ...app, at, next: 'delete' } : WRONG_STATE;
    case 'uninstall_refused':
      return app.state === 'uninstalling' && app.next === 'uninstall'
        ? attention(app.startedBy, at, 'uninstall_failed', 'uninstalling', {
            app: app.app,
            ...(app.botUserId ? { botUserId: app.botUserId } : {}),
          })
        : WRONG_STATE;
    case 'uninstall_unanswered':
      return app.state === 'uninstalling' && app.next === 'uninstall' && event.restore.app.appId === app.app.appId
        ? event.restore
        : WRONG_STATE;
    case 'deleted':
      return app.state === 'uninstalling' && app.next === 'delete' ? { state: 'deleted' } : WRONG_STATE;
    case 'record_refused':
      if (app.state === 'created' || app.state === 'urls_set') {
        return attention(app.startedBy, at, 'urls_refused', 'created', { app: app.app });
      }
      return WRONG_STATE;
    case 'try_again': {
      if (app.state !== 'needs_attention') return WRONG_STATE;
      const startedBy = event.startedBy;
      switch (app.resume) {
        case 'releasing_handle':
          return { state: 'releasing_handle', at, startedBy };
        case 'creating':
          return { state: 'creating', at, startedBy, manifestFingerprint: event.manifestFingerprint };
        case 'created':
          return app.app ? { state: 'created', at, startedBy, app: app.app } : WRONG_STATE;
        case 'icon_set':
          return app.app ? { state: 'icon_set', at, startedBy, app: app.app, icon: app.icon ?? 'not_set' } : WRONG_STATE;
        case 'uninstalling':
          return app.app
            ? {
                state: 'uninstalling',
                at,
                startedBy,
                app: app.app,
                ...(app.botUserId ? { botUserId: app.botUserId } : {}),
                next: 'uninstall',
              }
            : WRONG_STATE;
      }
    }
  }
}

function attention(
  startedBy: string,
  at: number,
  reason: AgentAppAttention,
  resume: AgentAppResume,
  extra: { app?: AgentAppRecord; icon?: AgentAppIcon; botUserId?: string } = {},
): AgentAppLifecycle {
  return { state: 'needs_attention', at, startedBy, reason, resume, ...extra };
}

function desiredStateOf(app: AgentAppLifecycle): AgentPresenceDesiredState {
  switch (app.state) {
    case 'uninstalling':
      return 'disabled';
    case 'needs_attention':
      return app.resume === 'uninstalling' ? 'disabled' : 'active';
    default:
      return 'active';
  }
}

function healthOf(app: AgentAppLifecycle): AgentPresenceHealth {
  switch (app.state) {
    case 'active':
      return 'healthy';
    case 'needs_attention':
      return 'needs_attention';
    default:
      return 'pending';
  }
}

/** Read boundary: the stored flags never outrank the lifecycle they summarize. */
export function normalizeAgentAppPresence(stored: AgentAppPresence): AgentAppPresence {
  return { ...stored, app: normalizeAgentApp(stored.app), desiredState: desiredStateOf(stored.app), health: healthOf(stored.app) };
}

/**
 * Read boundary for a record attached to a user group: undefined for anything
 * that is not a lifecycle record, and for a live one, which only an
 * `agent_app` presence holds.
 */
export function attachedAgentApp(stored: unknown): AttachedAgentApp | undefined {
  if (!stored || typeof stored !== 'object' || typeof (stored as { state?: unknown }).state !== 'string') return undefined;
  const app = normalizeAgentApp(stored as AgentAppLifecycle);
  return app.state === 'active' ? undefined : app;
}

/** The one consent field earlier code stored: a single open Allow link and its Owner. */
interface SingleConsent {
  nonceDigest: string;
  owner: string;
  expiresAt: number;
}

/**
 * A record stored with the single consent field reads as that one Owner's open link. Beside a per-Owner entry
 * for the same Owner, the link that expires later is the one opened last, so it wins.
 */
function normalizeAgentApp(app: AgentAppLifecycle): AgentAppLifecycle {
  if (app.state !== 'awaiting_consent' || !('consent' in app)) return app;
  const { consent, ...waiting } = app as typeof app & { consent?: SingleConsent };
  if (!consent?.owner) return waiting;
  const stored = waiting.consents?.[consent.owner];
  if (stored && stored.expiresAt >= consent.expiresAt) return waiting;
  return {
    ...waiting,
    consents: { ...waiting.consents, [consent.owner]: { nonceDigest: consent.nonceDigest, expiresAt: consent.expiresAt } },
  };
}
