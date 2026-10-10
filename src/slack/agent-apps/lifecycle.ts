import type {
  AgentAppAttention,
  AgentAppIcon,
  AgentAppLifecycle,
  AgentAppPresence,
  AgentAppRecord,
  AgentAppResume,
  AgentPresenceDesiredState,
  AgentPresenceHealth,
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
  | { type: 'created'; at: number; app: AgentAppRecord }
  | { type: 'create_refused'; at: number; reason: 'create_refused' | 'slack_busy' }
  | { type: 'create_ambiguous'; at: number }
  /** The recorded app had no secrets and was deleted; create again. */
  | { type: 'recreate'; at: number; manifestFingerprint: string }
  | { type: 'urls_set'; at: number }
  | { type: 'urls_refused'; at: number }
  | { type: 'config_token_needed'; at: number }
  | { type: 'icon_set'; at: number; icon: AgentAppIcon }
  | { type: 'allow_dm_posted'; at: number; channelId: string; ts: string }
  | { type: 'consent_opened'; at: number; nonceDigest: string; owner: string; expiresAt: number }
  | { type: 'consent_granted'; at: number; botUserId: string; installedBy: string }
  | { type: 'consent_undone'; at: number }
  | { type: 'app_removed'; at: number }
  | { type: 'archive'; at: number; hasBotToken: boolean }
  | { type: 'uninstalled'; at: number }
  | { type: 'uninstall_refused'; at: number }
  | { type: 'deleted'; at: number }
  | { type: 'try_again'; at: number; startedBy: string; manifestFingerprint: string };

export interface AgentAppRefusal {
  readonly refused: 'wrong_state' | 'create_settling';
}

/** The app is gone and the presence returns to its user group. */
export interface AgentAppDeleted {
  readonly state: 'deleted';
}

export type AgentAppTransition = AgentAppLifecycle | AgentAppDeleted | AgentAppRefusal;

const WRONG_STATE: AgentAppRefusal = { refused: 'wrong_state' };
const CREATE_SETTLING: AgentAppRefusal = { refused: 'create_settling' };

export function isRefusal(result: AgentAppTransition): result is AgentAppRefusal {
  return 'refused' in result;
}

export function initialAgentApp(startedBy: string, at: number): AgentAppLifecycle {
  return { state: 'releasing_handle', at, startedBy };
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
    case 'consent_opened':
      return app.state === 'awaiting_consent'
        ? { ...app, at, consent: { nonceDigest: event.nonceDigest, owner: event.owner, expiresAt: event.expiresAt } }
        : WRONG_STATE;
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
          }
        : WRONG_STATE;
    case 'consent_undone': {
      if (app.state !== 'awaiting_consent') return WRONG_STATE;
      const { consent: _consent, ...waiting } = app;
      return { ...waiting, at };
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
    case 'deleted':
      return app.state === 'uninstalling' && app.next === 'delete' ? { state: 'deleted' } : WRONG_STATE;
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
  return { ...stored, desiredState: desiredStateOf(stored.app), health: healthOf(stored.app) };
}
