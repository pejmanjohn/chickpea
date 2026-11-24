/**
 * The one writer of an Agent's app lifecycle and of its secrets. `advance`
 * asks the pure `nextStep` for the one effect due, performs it, commits by
 * compare-and-set and repeats until the record waits for a person, Slack, or
 * another run. A lost compare-and-set re-reads and re-applies the transition
 * when the state still allows it; it never repeats the effect.
 */
import { AgentRevisionConflictError, UnknownAgentError } from '../../config/errors.ts';
import { canEditAgent } from '../../auth/permissions.ts';
import { AgentPresenceError } from '../agent-presence/errors.ts';
import type { MemberInSlack } from '../agent-presence/place-in-slack.ts';
import { installationScopeOf } from '../../config/installation-scope.ts';
import type { EncryptedCredentialStore, SettingsStore } from '../../config/settings-store.ts';
import type { PlatformEnv } from '../../config/state-backend.ts';
import type { ConfigStore } from '../../config/store.ts';
import {
  type AgentAppFollowRefusal,
  type AgentAppFollowTarget,
  type AgentAppFollows,
  type AgentAppIcon,
  type AgentAppLifecycle,
  type AgentChannelGrant,
  type AgentAppPresence,
  type AgentAppSwitchProgress,
  type AgentPresenceBase,
  type AgentSlackPresence,
  type CustomAgentConfig,
  type UserGroupPresence,
  answeringUserGroupId,
  appRecordOf,
} from '../../config/types.ts';
import {
  agentAvatarInstallation,
  agentAvatarUrlForPresentation,
  generatedAgentAvatarPng,
  readAgentAvatarAsset,
} from '../agent-presence/avatar-assets.ts';
import { bringUserGroupToAgent, handlesOtherAgentsHoldInSlack } from '../agent-presence/handles.ts';
import {
  AGENT_APP_BOT_EVENTS,
  type AgentAppManifestIntent,
  SLACK_APP_DESCRIPTION_MAX_LENGTH,
  SLACK_APP_NAME_MAX_LENGTH,
  agentAppCreateManifest,
  buildSlackAppManifest,
  slackManifestFingerprint,
  type SlackAppCreateManifest,
  type SlackAppManifest,
} from '../app-manifest.ts';
import { sha256Hex } from '../../security/digest.ts';
import { loadCredentialKeyring } from '../credential-keyring.ts';
import { hostedSlackLifecycleOutcome } from '../hosted-slack-app.ts';
import { SLACK_BOT_AUTHORIZE_URL } from '../install-oauth.ts';
import { AGENT_APP_BOT_SCOPES } from '../scopes.ts';
import type { CredentialKeyring } from '../secret-envelope.ts';
import { createDirectSlackTransport } from '../transport/direct.ts';
import { SlackTransportError, type SlackChannel, type SlackTransport } from '../transport/types.ts';
import type { AgentAppRetirement, AgentSlackAppsHost } from './host.ts';
import {
  type AgentAppEvent,
  type AgentAppRefusal,
  type AgentAppStep,
  type AgentAppSwitchJob,
  type AgentAppTransition,
  CREATE_SETTLE_MS,
  agentAppFollowStep,
  agentAppIsLive,
  agentAppMoveJob,
  agentAppRecord,
  attachedAgentApp,
  createIsStale,
  isRefusal,
  nextStep,
  normalizeAgentAppPresence,
  pendingSwitchStep,
  waitsForOwnApp,
  restorePending,
  stoppedBeforeAnyApp,
  transition,
} from './lifecycle.ts';
import {
  type AddRefusal,
  type AgentAppPageAgent,
  type AgentAppPageLinks,
  type ConsentOutcome,
  addRefusedPage,
  addedPage,
  consentPage,
  handoffPage,
  notAddablePage,
  unnamedExpiredPage,
} from './journey.ts';
import {
  ADMIN_PATH,
  type AgentAppHomeRow,
  type AgentAppLinks,
  type AgentAppMessageKind,
  type AgentAppNames,
  SLACK_CONNECTION_PATH,
  STALLED_AFTER_MS,
  agentAppHomeBlocks,
  agentAppMessage,
  addPressReply,
  agentAppSwitchedMessage,
  archiveRefusedCopy,
  TOKEN_PAGE_PATH,
} from './pages.ts';
import {
  ConfigTokenNeeded,
  type ConfigurationTokenStatus,
  LostRevision,
  type SecretDeps,
  TOKEN_REFUSALS,
  configurationTokenStatus,
  deleteAppSecrets,
  discardConfigurationToken,
  readAppSecrets,
  readOwnAppSecrets,
  saveConfigurationToken,
  unreadableAsNone,
  withConfigurationToken,
  writeAppSecrets,
} from './secrets.ts';
import {
  type AgentSlackAppsMode,
  type AgentSlackAppsSetting,
  readAgentSlackAppsSetting,
  writeAgentSlackAppsSetting,
} from './setting.ts';
import {
  type AgentAppSlackApi,
  AmbiguousEffect,
  SlackRefused,
  SlackUnavailable,
  createAgentAppSlackApi,
  logSlackRefusal,
} from './slack-api.ts';

export type AgentAppTransport = Pick<
  SlackTransport,
  | 'disableUserGroup' | 'enableUserGroup' | 'listUserGroups' | 'updateUserGroup' | 'openDirectConversation' | 'postMessage'
  | 'lookupChannel' | 'joinPublicChannel' | 'channelHasMember'
>;

/** What an Agent app's own bot does at the switch: see a Channel and join a public one. */
export type AgentAppBotTransport = Pick<SlackTransport, 'lookupChannel' | 'joinPublicChannel'>;

export type { AgentAppSwitchJob } from './lifecycle.ts';

export interface AgentSlackAppsDeps {
  env: PlatformEnv | undefined;
  stores: {
    config: Pick<
      ConfigStore,
      | 'getAgent' | 'listAgents' | 'updateAgent' | 'listWorkspaceInstallations' | 'listAgentChannelGrants' | 'putAgentChannelGrant'
      | 'deleteAgentChannelGrant'
    >;
    settings: SettingsStore & EncryptedCredentialStore;
  };
  host: AgentSlackAppsHost;
  /** The workspace's main bot, for the Owner's DMs and the handle's user group. */
  transport: AgentAppTransport;
  slack?: AgentAppSlackApi;
  /** An Agent app's own bot, from its token. */
  appBot?: (botToken: string) => AgentAppBotTransport;
  /**
   * Arms the move's job: at Allow, at Remove App, and at an Owner's Finish
   * setting up. Idempotent for one app; `continueSwitch` is what the job runs.
   */
  armSwitch: (job: AgentAppSwitchJob) => Promise<void>;
  keyring?: CredentialKeyring;
  /** Where Chickpea Admin lives, for the "Paste a new token" and "Open Chickpea" buttons. */
  publicOrigin?: () => Promise<string | undefined>;
  /**
   * Whether the installation lacks the Owner's user-group permission that
   * freeing an Agent's handle needs: the fact Admin's permissions bar reads.
   * Absent on a host whose permissions update grants no such permission.
   */
  userGroupPermissionMissing?: () => Promise<boolean>;
  /**
   * Gives an Agent in Slack nowhere its user group and its creator's
   * Channels, as creation in `shared` mode would have: for a record that ended
   * after the workspace went back to `shared`.
   */
  placeInSlack?: (agentId: string) => Promise<void>;
  /** An active member in Slack, for the check that whoever added a waiting Channel may still add it. */
  memberInSlack: (membershipId: string) => Promise<MemberInSlack | undefined>;
  now?: () => number;
}

export type AgentAppStartOutcome =
  | { kind: 'started'; agent: CustomAgentConfig }
  | { kind: 'already_started'; agent: CustomAgentConfig }
  | { kind: 'token_needed' }
  | { kind: 'permission_needed' }
  /** Slack's plan allows no more apps in this workspace; the Agent is as it was. */
  | { kind: 'app_limit' }
  /** Another Agent in Slack holds this Agent's handle; nothing was created. */
  | { kind: 'handle_taken'; agent: CustomAgentConfig }
  | { kind: 'not_eligible' };

/**
 * Where an Owner pressed: Chickpea's hand-off page from Slack (and the Allow
 * link), or Admin. It decides only where Slack's Allow lands them.
 */
export type AgentAppPressFrom = 'slack' | 'admin';

/**
 * An Owner's press to give one Agent its own app: the move for an Agent that
 * answers through Chickpea, the add for one not in Slack yet. `authorize` is
 * Slack's Allow page for that Owner; `creating` waits on Slack. A missing or
 * refused configuration token is `token_needed`.
 */
export type AgentAppPressOutcome =
  | { kind: 'authorize'; url: string; agent: CustomAgentConfig }
  | { kind: 'creating'; agent: CustomAgentConfig }
  | { kind: 'needs_attention'; agent: CustomAgentConfig }
  | { kind: 'already_own_app'; agent: CustomAgentConfig }
  /** A Cancel's removal was pending: the press finished what it could and created nothing. */
  | { kind: 'cancelling'; agent: CustomAgentConfig }
  | { kind: 'token_needed' }
  | { kind: 'permission_needed' }
  | { kind: 'app_limit' }
  | { kind: 'handle_taken'; agent: CustomAgentConfig }
  | { kind: 'not_eligible' };

/**
 * Where a run left the Agent; `withdrawn` when its create step withdrew the record: Slack would make no more apps, or
 * another Agent in Slack holds the handle.
 */
interface Advanced {
  agent: CustomAgentConfig;
  withdrawn?: 'app_limit' | 'handle_taken';
}

/**
 * An Owner's Cancel. `cancelled` says whether the app is deleted, was left
 * for the Owner to delete (or may exist, after a create Slack never answered),
 * or never existed; `unfinished` is a removal Slack did not finish, which the
 * next Cancel or Start finishes.
 */
export type AgentAppCancelOutcome =
  | { kind: 'cancelled'; agent: CustomAgentConfig; app: 'deleted' | 'left_for_owner' | 'none' }
  | { kind: 'unfinished'; agent: CustomAgentConfig }
  | { kind: 'not_waiting' }
  | { kind: 'not_eligible' };

interface Run {
  agent: CustomAgentConfig;
  presence: AgentSlackPresence;
  app: AgentAppLifecycle;
  now: number;
  /** Only the run that wrote `creating` may create; any other run waits for it to settle. */
  wroteCreating: boolean;
  /** An archive's own run; any other removal of an app attached to a user group is a Cancel's. */
  archiving: boolean;
  /** The press that runs it sends the Owner's browser to Slack's Allow screen next. */
  handOff: boolean;
}

type Outcome = { event: AgentAppEvent; after?: () => Promise<void> } | 'wait';
type Performer = (run: Run) => Promise<Outcome>;

type LiveAgentApp = AgentAppPresence & { app: Extract<AgentAppLifecycle, { state: 'active' }> };
type RemovedAgentApp = AgentAppPresence & { app: Extract<AgentAppLifecycle, { state: 'needs_attention' }> };

/**
 * A switch step's result: the step due next; the group Slack confirmed it
 * turned off; and that the Owner's message was given up.
 */
interface SwitchStepDone {
  next: AgentAppSwitchProgress;
  groupOff?: string;
  ownerNotTold?: true;
}

const MAX_STEPS_PER_RUN = 12;
/** How long an opened Allow link stays valid. */
export const CONSENT_TTL_MS = 15 * 60_000;
/** Agent, nonce and, since the press said where it came from, that; a state without it lands as one from Slack. */
const STATE_SHAPE = /^([A-Za-z0-9_-]{1,128})\.([a-f0-9-]{36})(?:\.([a-z]{1,16}))?$/;
const MAX_COMMIT_RETRIES = 3;
const ICON_MIN_PX = 512;
const ICON_MAX_PX = 2_000;
const GROUP_ALREADY_RELEASED = new Set(['already_disabled', 'no_such_subteam']);
/**
 * An app made before Chickpea asked for `channels:join` may be granted
 * without it. Its bot then cannot join a Channel the Agent is added to, and
 * is reported as left out there.
 */
export const OLDER_APPS_LACK = 'channels:join';
/**
 * How Slack refuses a create once the workspace has every app its plan
 * allows (ten on the free plan). Not yet seen live: `managed_app_limit_reached`
 * is the code apps.manifest.create documents, `service_limits_exceeded` the
 * one Slack's CLI reports for the free plan's limit.
 */
const APP_LIMIT_REFUSALS = new Set(['managed_app_limit_reached', 'service_limits_exceeded']);
/** How Slack refuses a user-group change for want of a permission. */
const PERMISSION_REFUSALS = new Set(['permission_denied', 'missing_scope', 'not_allowed']);

/** One run of an Agent app's job: whether it is the row's last try, and the row's number when the drain runs it. */
interface FollowRun {
  finalAttempt: boolean;
  row?: number;
}

/** What Chickpea would make an Agent's live app today: its whole definition, and the target a follow compares. */
export interface AgentAppFollow {
  manifest: SlackAppManifest;
  target: AgentAppFollowTarget;
}

/**
 * The definition Chickpea makes for an Agent's app, Request URLs included,
 * and the Agent's avatar revision. Pure, so the state store's sweep can tell
 * a live app that must be brought to match without reading anything more.
 */
export function agentAppFollow(
  agent: CustomAgentConfig,
  appId: string,
  host: AgentSlackAppsHost,
  installationId: string,
): AgentAppFollow {
  const manifest = buildSlackAppManifest({ kind: 'agent_app', urls: host.requestUrls(installationId, appId), ...manifestIntent(agent, host) });
  return { manifest, target: { manifestFingerprint: slackManifestFingerprint(manifest), avatarRevision: agent.slackPresence?.avatar.revision ?? 0 } };
}

/** The longest start of `text` within `max` UTF-16 units that ends between characters, never inside an emoji. */
function wholeCharacters(text: string, max: number): string {
  let kept = '';
  for (const character of text) {
    if (kept.length + character.length > max) break;
    kept += character;
  }
  return kept;
}

function manifestIntent(agent: CustomAgentConfig, host: AgentSlackAppsHost): AgentAppManifestIntent {
  return {
    appName: wholeCharacters(agent.name, SLACK_APP_NAME_MAX_LENGTH),
    botDisplayName: agent.slackPresence?.normalizedHandle ?? agent.id,
    description: wholeCharacters(agent.description?.trim() || `${agent.name} Agent`, SLACK_APP_DESCRIPTION_MAX_LENGTH),
    redirectUri: host.redirectUri,
    scopes: AGENT_APP_BOT_SCOPES,
    events: AGENT_APP_BOT_EVENTS,
  };
}

export class AgentSlackApps {
  private readonly now: () => number;
  private readonly slack: AgentAppSlackApi;
  private readonly appBot: (botToken: string) => AgentAppBotTransport;
  private readonly secrets: SecretDeps;
  private facts: Promise<{ teamId: string; installationId: string }> | undefined;
  /**
   * Agents whose app the delete step left for the Owner: uninstalled with its definition kept (Slack refused, or no
   * configuration token), or still installed because no record proves the app is theirs.
   */
  private readonly leftForOwner = new Map<string, 'uninstalled_left_definition' | 'left_for_owner'>();

  constructor(private readonly deps: AgentSlackAppsDeps) {
    this.now = deps.now ?? Date.now;
    this.slack = deps.slack ?? createAgentAppSlackApi();
    this.appBot = deps.appBot ?? ((botToken) => createDirectSlackTransport(botToken, undefined));
    this.secrets = {
      credentials: deps.stores.settings,
      keyring: deps.keyring ?? loadCredentialKeyring(deps.env),
      slack: this.slack,
      now: this.now,
    };
  }

  /**
   * Attach a `creating` record to the Agent's presence by compare-and-set and
   * run the sequence; the loser of two starts sees the winner's record. The
   * user group keeps the handle and keeps answering until Allow. The
   * permission the switch will need to turn the group off is checked first,
   * so a move never reaches a switch it cannot finish.
   */
  async start(agentId: string, ownerSlackUserId: string, options: { handOff?: boolean } = {}): Promise<AgentAppStartOutcome> {
    const { config } = this.deps.stores;
    const agent = await config.getAgent(agentId);
    const presence = agent.slackPresence;
    if (agent.kind !== 'user' || agent.lifecycle === 'archived' || agent.lifecycle === 'draft' || !presence) {
      return { kind: 'not_eligible' };
    }
    if (presence.kind === 'agent_app' || presence.app) return { kind: 'already_started', agent };
    if (handleHeldByAnother(await config.listAgents(), agent)) return { kind: 'handle_taken', agent };
    if (presence.userGroupId && await this.userGroupPermissionMissing()) {
      await this.message('permission_needed', agent, ownerSlackUserId, `agent-app-permission:${agent.id}:${this.now()}`);
      return { kind: 'permission_needed' };
    }
    const { teamId } = await this.installation();
    if (!(await configurationTokenStatus(this.secrets, teamId)).stored) return { kind: 'token_needed' };
    const manifestFingerprint = slackManifestFingerprint(this.createManifest(agent));
    const started: UserGroupPresence = {
      ...presence,
      app: { state: 'creating', at: this.now(), startedBy: ownerSlackUserId, manifestFingerprint },
    };
    try {
      await config.updateAgent(agentId, { slackPresence: started }, agent.revision);
    } catch (error) {
      if (!(error instanceof AgentRevisionConflictError)) throw error;
      const latest = await config.getAgent(agentId);
      if (appRecordOf(latest.slackPresence)) return { kind: 'already_started', agent: latest };
      return this.start(agentId, ownerSlackUserId, options);
    }
    const advanced = await this.advance(agentId, { wroteCreating: true, handOff: options.handOff ?? false });
    if (advanced.withdrawn === 'app_limit') return { kind: 'app_limit' };
    if (advanced.withdrawn === 'handle_taken') return { kind: 'handle_taken', agent: advanced.agent };
    return { kind: 'started', agent: advanced.agent };
  }

  /**
   * Add to Slack pressed on a message posted while it was still an action:
   * an Owner is answered with the link that adds the Agent now, anyone else
   * with who can. Nothing starts here.
   */
  async addLinkReply(agentId: string, isOwner: boolean): Promise<string> {
    let agent;
    try {
      agent = await this.deps.stores.config.getAgent(agentId);
    } catch (error) {
      if (!(error instanceof UnknownAgentError)) throw error;
      return addPressReply('gone');
    }
    const names = this.names(agent);
    return isOwner ? addPressReply('link', names, this.deps.host.addUrl(agent.id)) : addPressReply('owner_needed', names);
  }

  /**
   * Perform the next step, commit by compare-and-set, repeat until the record
   * waits. `appLimit` says the run withdrew the record because Slack would not
   * create another app in this workspace.
   */
  async advance(agentId: string, options: { wroteCreating?: boolean; archiving?: boolean; handOff?: boolean } = {}): Promise<Advanced> {
    const { config } = this.deps.stores;
    let agent = await config.getAgent(agentId);
    let wroteCreating = options.wroteCreating ?? false;
    const archiving = options.archiving ?? false;
    const handOff = options.handOff ?? false;
    for (let guard = 0; guard < MAX_STEPS_PER_RUN; guard += 1) {
      const presence = agent.slackPresence;
      const app = appRecordOf(presence);
      if (!presence || !app) return { agent };
      const now = this.now();
      if (createIsStale(app, now)) {
        agent = (await this.commit(agent, { type: 'create_ambiguous', at: now })).agent;
        await this.notifyAttention(agent);
        return { agent };
      }
      const step = nextStep(app, now);
      if (!step) return { agent };
      const outcome = await this.performers[step]({ agent, presence, app, now, wroteCreating, archiving, handOff });
      if (outcome === 'wait') return { agent };
      const committed = await this.commit(agent, outcome.event);
      agent = committed.agent;
      if (committed.outcome === 'refused') continue;
      wroteCreating = outcome.event.type === 'handle_released' || outcome.event.type === 'recreate';
      if (outcome.after) await outcome.after();
      if (committed.outcome === 'deleted' || committed.outcome === 'withdrawn') {
        if (!archiving) await this.placeIfShared(agent);
        const { type } = outcome.event;
        return type === 'app_limit_reached' ? { agent, withdrawn: 'app_limit' } : type === 'handle_taken' ? { agent, withdrawn: type } : { agent };
      }
      if (appRecordOf(agent.slackPresence)?.state === 'needs_attention') {
        await this.notifyAttention(agent, archiving);
        return { agent };
      }
    }
    return { agent };
  }

  /**
   * An Owner chose Try again or Finish setting up: resume where the record
   * says, then advance. A live app whose switch has steps left, or that Slack
   * would not bring to match its Agent, has its job armed again, and so does
   * a removed app's group, which Slack may now let Chickpea turn back on.
   */
  async retry(agentId: string, ownerSlackUserId: string): Promise<CustomAgentConfig> {
    const { config } = this.deps.stores;
    let agent = await config.getAgent(agentId);
    const presence = agent.slackPresence;
    const app = appRecordOf(presence);
    if (!app) return agent;
    if (presence?.kind === 'agent_app' && presence.released?.enableRefused) {
      agent = await config.updateAgent(agentId, { slackPresence: { ...presence, released: unrefused(presence.released) } }, agent.revision);
    }
    if (app.state === 'active' || restorePending(agent.slackPresence)) return this.followAgain(agent);
    if (app.state !== 'needs_attention') return (await this.advance(agentId)).agent;
    return (await this.tryAgain(agent, app, ownerSlackUserId)).agent;
  }

  /** Resume a record that needs attention where it says, then advance: for a removed app, its Allow message again. */
  private async tryAgain(
    agent: CustomAgentConfig,
    app: Extract<AgentAppLifecycle, { state: 'needs_attention' }>,
    ownerSlackUserId: string,
    handOff = false,
  ): Promise<Advanced> {
    const agentId = agent.id;
    const manifestFingerprint = slackManifestFingerprint(this.createManifest(agent));
    const resumed = await this.commit(agent, {
      type: 'try_again', at: this.now(), startedBy: ownerSlackUserId, manifestFingerprint,
    });
    if (resumed.outcome === 'refused') return { agent: resumed.agent };
    return this.advance(agentId, { wroteCreating: app.resume === 'creating', handOff });
  }

  /** "Allow <Agent> in Slack": a fresh consent nonce, then Slack's authorize page. Creates nothing. */
  async allow(agentId: string, ownerSlackUserId: string): Promise<Response> {
    const { config } = this.deps.stores;
    let agent = await config.getAgent(agentId);
    const app = appRecordOf(agent.slackPresence);
    if (!app) return this.consentPage('expired', agent);
    if (app.state === 'active') return this.consentPage('already_active', agent);
    if (app.state === 'needs_attention' && app.reason === 'app_removed') agent = (await this.tryAgain(agent, app, ownerSlackUserId, true)).agent;
    const url = await this.authorizeUrl(agent, ownerSlackUserId, 'slack');
    return url ? Response.redirect(url, 303) : this.consentPage('expired', agent);
  }

  /**
   * The hand-off page an Owner opens from Chickpea's messages in Slack. It
   * only reads: the press is its POST, `addPress`. An Agent already in Slack
   * gets the Added page, and one an Owner cannot add says so.
   */
  async addPage(agentId: string, options: { pressOnOpen?: boolean } = {}): Promise<Response> {
    const pressOnOpen = options.pressOnOpen ?? true;
    const agent = await this.knownAgent(agentId);
    if (!agent || !addable(agent)) return notAddablePage(await this.pageLinks());
    const presence = agent.slackPresence!;
    const app = appRecordOf(presence);
    if (!app) {
      if (presence.userGroupId) return addedPage(await this.pageAgent(agent), await this.pageLinks(), 'already');
      return handoffPage(await this.pageAgent(agent), 'creating', pressOnOpen);
    }
    if (app.state === 'active') return addedPage(await this.pageAgent(agent), await this.pageLinks(agent), 'already');
    // An app Slack already made (waiting for Allow, partway, or removed from the workspace) is not created again.
    return handoffPage(await this.pageAgent(agent), agentAppRecord(app) ? 'opening' : 'creating', pressOnOpen);
  }

  /**
   * The hand-off page's POST: the Owner's press, as Admin's, then straight to
   * Slack's permission screen. An Agent that answers through Chickpea's
   * handle is already in Slack, and a link never starts its move. Every other
   * answer is a page.
   */
  async addPress(agentId: string, ownerSlackUserId: string): Promise<{ response: Response; pressed?: AgentAppPressOutcome['kind'] }> {
    const agent = await this.knownAgent(agentId);
    if (!agent || !addable(agent)) return { response: notAddablePage(await this.pageLinks()) };
    if (agent.slackPresence?.userGroupId && !appRecordOf(agent.slackPresence)) {
      return { response: addedPage(await this.pageAgent(agent), await this.pageLinks(), 'already') };
    }
    const pressed = await this.press(agentId, ownerSlackUserId, 'slack');
    const refused = async (refusal: AddRefusal, latest: CustomAgentConfig = agent) =>
      ({ response: addRefusedPage(refusal, await this.pageAgent(latest), await this.pageLinks(latest)), pressed: pressed.kind });
    switch (pressed.kind) {
      case 'authorize':
        return { response: Response.redirect(pressed.url, 303), pressed: pressed.kind };
      case 'already_own_app':
        return { response: addedPage(await this.pageAgent(pressed.agent), await this.pageLinks(pressed.agent), 'already'), pressed: pressed.kind };
      case 'creating':
        return refused('still_creating', pressed.agent);
      case 'needs_attention': {
        const app = appRecordOf(pressed.agent.slackPresence);
        const reason = app?.state === 'needs_attention' ? app.reason : undefined;
        return refused(reason === 'ambiguous_create' || reason === 'create_refused' ? reason : 'not_finished', pressed.agent);
      }
      case 'cancelling':
        return refused('cancelling', pressed.agent);
      case 'handle_taken':
        return refused('handle_taken', pressed.agent);
      case 'token_needed':
      case 'permission_needed':
      case 'app_limit':
        return refused(pressed.kind);
      case 'not_eligible':
        return { response: notAddablePage(await this.pageLinks()) };
    }
  }

  /** The press failed outright (Slack, a store): the hand-off's Try again picks the record up where it stopped. */
  async addPressFailedPage(agentId: string): Promise<Response> {
    const agent = await this.knownAgent(agentId).catch(() => undefined);
    if (!agent) return notAddablePage(await this.pageLinks().catch(() => ({ admin: ADMIN_PATH })));
    return addRefusedPage('not_finished', await this.pageAgent(agent), await this.pageLinks(agent));
  }

  /** Slack's authorize page for an app waiting for Allow, under a fresh nonce bound to this Owner; undefined for any other record. */
  private async authorizeUrl(agent: CustomAgentConfig, ownerSlackUserId: string, from: AgentAppPressFrom): Promise<string | undefined> {
    const app = appRecordOf(agent.slackPresence);
    if (app?.state !== 'awaiting_consent') return undefined;
    const nonce = crypto.randomUUID();
    const now = this.now();
    const opened = await this.commit(agent, {
      type: 'consent_opened', at: now, nonceDigest: await sha256Hex(nonce), owner: ownerSlackUserId, expiresAt: now + CONSENT_TTL_MS,
    });
    if (opened.outcome !== 'applied') return undefined;
    const url = new URL(SLACK_BOT_AUTHORIZE_URL);
    url.searchParams.set('client_id', app.app.clientId);
    url.searchParams.set('scope', AGENT_APP_BOT_SCOPES.join(','));
    url.searchParams.set('redirect_uri', this.deps.host.redirectUri);
    url.searchParams.set('state', `${agent.id}.${nonce}.${from}`);
    return url.toString();
  }

  /**
   * An Owner's press in Admin: start the app, or pick up a record that
   * stopped, then lead straight to Allow. A record on its way to Allow is
   * advanced from where it stopped, and only the run that wrote `creating`
   * creates, so two presses make one app. One waiting for Allow gets a fresh
   * link. A Cancel's unfinished removal is finished, and nothing is created.
   */
  async press(agentId: string, ownerSlackUserId: string, from: AgentAppPressFrom): Promise<AgentAppPressOutcome> {
    const { config } = this.deps.stores;
    let agent = await config.getAgent(agentId);
    if (agent.kind !== 'user' || agent.lifecycle === 'archived' || agent.lifecycle === 'draft' || !agent.slackPresence) {
      return { kind: 'not_eligible' };
    }
    const record = appRecordOf(agent.slackPresence);
    const attached = agent.slackPresence.kind !== 'agent_app';
    // Every press sends the Owner's browser on to Slack's Allow screen, so none posts the message asking them to choose Allow.
    if (!record) {
      const started = await this.start(agentId, ownerSlackUserId, { handOff: true });
      if (started.kind !== 'started' && started.kind !== 'already_started') return started;
      agent = started.agent;
    } else if (record.state === 'needs_attention' && record.reason === 'app_removed') {
      // A removed app, whichever kind holds the handle now: its Allow is offered again, as the Allow link does.
      agent = (await this.tryAgain(agent, record, ownerSlackUserId, true)).agent;
    } else if (attached && cancelPending(record)) {
      const finished = record.state === 'needs_attention'
        ? await this.tryAgain(agent, record, ownerSlackUserId)
        : await this.advance(agentId);
      return { kind: 'cancelling', agent: finished.agent };
    } else if (attached && record.state !== 'awaiting_consent') {
      if (record.state === 'needs_attention' && record.reason === 'config_token_needed' && !(await this.hasConfigurationToken())) {
        return { kind: 'token_needed' };
      }
      const resumed = record.state === 'needs_attention'
        ? await this.tryAgain(agent, record, ownerSlackUserId, true)
        : await this.advance(agentId, { handOff: true });
      if (resumed.withdrawn === 'app_limit') return { kind: 'app_limit' };
      if (resumed.withdrawn === 'handle_taken') return { kind: 'handle_taken', agent: resumed.agent };
      agent = resumed.agent;
    }
    const app = appRecordOf(agent.slackPresence);
    if (app?.state === 'awaiting_consent') {
      const url = await this.authorizeUrl(agent, ownerSlackUserId, from);
      return url ? { kind: 'authorize', url, agent: await config.getAgent(agentId) } : { kind: 'creating', agent };
    }
    if (app?.state === 'needs_attention' && app.reason === 'config_token_needed') return { kind: 'token_needed' };
    if (app?.state === 'needs_attention') return { kind: 'needs_attention', agent };
    // A live app Slack would not bring to match its Agent is tried again.
    if (app?.state === 'active') return { kind: 'already_own_app', agent: app.follows?.refused ? await this.followAgain(agent) : agent };
    return { kind: 'creating', agent };
  }

  /**
   * An Owner's Cancel before Allow: the created app is deleted under its own
   * record, and the Agent goes back to how it answered before the press. The
   * check that the app still waits for Allow is the `cancel` event itself, so
   * an Allow that lands first wins and nothing is deleted. A removal an
   * earlier Cancel left unfinished is finished.
   */
  async cancel(agentId: string, ownerSlackUserId: string): Promise<AgentAppCancelOutcome> {
    const agent = await this.deps.stores.config.getAgent(agentId);
    if (agent.kind !== 'user' || agent.lifecycle === 'archived') return { kind: 'not_eligible' };
    const app = appRecordOf(agent.slackPresence);
    if (!app || agent.slackPresence?.kind === 'agent_app') return { kind: 'not_waiting' };
    let settled: CustomAgentConfig;
    if (app.state === 'awaiting_consent') {
      const stored = await readAppSecrets(this.secrets, app.app.appId).catch(unreadableAsNone);
      const cancelled = await this.commit(agent, { type: 'cancel', at: this.now(), hasBotToken: Boolean(stored?.secrets.botToken) });
      if (cancelled.outcome === 'refused') return { kind: 'not_waiting' };
      settled = (await this.advance(agentId)).agent;
    } else if (app.state === 'needs_attention' && cancelPending(app)) {
      // Slack refused the uninstall last time: pick the removal up where it stopped.
      settled = (await this.tryAgain(agent, app, ownerSlackUserId)).agent;
    } else if (stoppedBeforeAnyApp(app)) {
      // Stopped before Slack made an app: nothing in Slack to remove, and the Agent is as it was before the press.
      const withdrawn = await this.commit(agent, { type: 'cancel', at: this.now(), hasBotToken: false });
      if (withdrawn.outcome !== 'withdrawn') return { kind: 'not_waiting' };
      await this.placeIfShared(withdrawn.agent);
      // After a create Slack never answered, an app may exist that Chickpea has no record of: only the Owner can delete it.
      return {
        kind: 'cancelled', agent: await this.deps.stores.config.getAgent(agentId), app: app.reason === 'ambiguous_create' ? 'left_for_owner' : 'none',
      };
    } else if (app.state === 'uninstalling') {
      settled = (await this.advance(agentId)).agent;
    } else {
      return { kind: 'not_waiting' };
    }
    const left = this.leftForOwner.get(agentId);
    this.leftForOwner.delete(agentId);
    if (appRecordOf(settled.slackPresence)) return { kind: 'unfinished', agent: settled };
    return { kind: 'cancelled', agent: settled, app: left ? 'left_for_owner' : 'deleted' };
  }

  /** Slack's callback, forwarded untouched: exchange the code with the app's own credentials and validate the grant. */
  async completeConsent(query: URLSearchParams, ownerSlackUserId: string): Promise<Response> {
    const state = STATE_SHAPE.exec(query.get('state') ?? '');
    if (!state) return unnamedExpiredPage(await this.pageLinks());
    const agentId = state[1]!;
    const nonce = state[2]!;
    const from: AgentAppPressFrom = state[3] === 'admin' ? 'admin' : 'slack';
    const agent = await this.knownAgent(agentId);
    if (!agent) return unnamedExpiredPage(await this.pageLinks());
    const consentPage = (outcome: ConsentOutcome) => this.consentPage(outcome, agent);
    const record = appRecordOf(agent.slackPresence);
    if (!record) return consentPage('expired');
    if (record.state === 'active') return consentPage('already_active');
    if (record.state !== 'awaiting_consent') return consentPage('expired');
    const { consents, app } = record;
    const now = this.now();
    const nonceDigest = await sha256Hex(nonce);
    const [owner, consent] = Object.entries(consents ?? {}).find(([, open]) => open.nonceDigest === nonceDigest) ?? [];
    if (!owner || !consent || consent.expiresAt <= now) return consentPage('expired');
    if (owner !== ownerSlackUserId) return consentPage('another_person');
    if (query.get('error') || !query.get('code')) {
      await this.commit(agent, { type: 'consent_undone', at: now, owner });
      return consentPage('cancelled');
    }
    const stored = await readOwnAppSecrets(this.secrets, app.appId, agent.id, 'exchange');
    if (stored.kind !== 'own') return consentPage('expired');
    let grant;
    try {
      grant = await this.slack.exchange({
        clientId: app.clientId,
        clientSecret: stored.secrets.clientSecret,
        code: query.get('code')!,
        redirectUri: this.deps.host.redirectUri,
      });
    } catch (error) {
      if (error instanceof SlackRefused) {
        logSlackRefusal('exchange', { agentId: agent.id, appId: app.appId }, error);
        return consentPage('expired');
      }
      if (error instanceof SlackUnavailable) return consentPage('slack_down');
      throw error;
    }
    const { teamId } = await this.installation();
    const undo = async () => {
      await this.slack.uninstall({ clientId: app.clientId, clientSecret: stored.secrets.clientSecret, botToken: grant.botToken }).catch((error: unknown) => {
        if (error instanceof SlackRefused) logSlackRefusal('uninstall', { agentId: agent.id, appId: app.appId }, error);
      });
      await this.commit(agent, { type: 'consent_undone', at: now, owner });
    };
    if (grant.teamId !== teamId) { await undo(); return consentPage('other_workspace'); }
    if (grant.appId !== app.appId || grant.installerUserId !== owner) { await undo(); return consentPage('another_person'); }
    if (AGENT_APP_BOT_SCOPES.some((scope) => scope !== OLDER_APPS_LACK && !grant.scopes.includes(scope))) {
      await undo();
      return consentPage('missing_permissions');
    }
    // Two stores: a crash between them leaves the token stored and the app not live while the group answers, and the
    // Owner's next Allow, which this same path serves, repairs it.
    try {
      await writeAppSecrets(this.secrets, app.appId, agent.id, { ...stored.secrets, botToken: grant.botToken }, stored.revision);
    } catch (error) {
      // Another callback of this Allow stored its token first, and makes the one switch.
      if (error instanceof LostRevision) return consentPage('already_active');
      throw error;
    }
    const granted = await this.commit(agent, {
      type: 'consent_granted', at: now, botUserId: grant.botUserId, installedBy: grant.installerUserId,
    });
    if (granted.outcome !== 'applied') return consentPage('expired');
    await this.armSwitch(granted.agent);
    if (from === 'slack') return Response.redirect(slackAppRedirect(app.appId, teamId), 303);
    // From Admin: back to where its Slack section shows the result; without Admin's address, the Added page.
    const origin = await this.publicOrigin();
    if (origin) return Response.redirect(`${origin}${SLACK_CONNECTION_PATH}`, 303);
    return addedPage(await this.pageAgent(granted.agent), await this.pageLinks(granted.agent), 'added');
  }

  /**
   * A verified app_uninstalled or tokens_revoked of one Agent app: the bot
   * token goes and the record moves to removed. Turning the released group
   * back on and telling the Owner are the move job's restore.
   */
  async end(appId: string, payload: Record<string, unknown>): Promise<'ended' | 'ignored'> {
    const { config } = this.deps.stores;
    const agent = (await config.listAgents()).find((candidate) => {
      const app = appRecordOf(candidate.slackPresence);
      return app !== undefined && agentAppRecord(app)?.appId === appId;
    });
    const presence = agent?.slackPresence;
    // Only a live app has a bot Slack can remove; any other record waits for its own step.
    if (!agent || !agentAppIsLive(presence)) return 'ignored';
    const outcome = hostedSlackLifecycleOutcome(payload, {
      installedAt: presence.app.installedAt,
      botUserId: presence.app.botUserId,
    });
    if (outcome !== 'end') return 'ignored';
    return await this.removedAtSlack(agent, appId) ? 'ended' : 'ignored';
  }

  /** Slack removed this live app: its bot token goes and the record moves to removed, for the job to restore. */
  private async removedAtSlack(agent: CustomAgentConfig, appId: string): Promise<CustomAgentConfig | undefined> {
    const stored = await readOwnAppSecrets(this.secrets, appId, agent.id, 'end');
    if (stored.kind === 'own' && stored.secrets.botToken) {
      const { clientSecret, signingSecret } = stored.secrets;
      await writeAppSecrets(this.secrets, appId, agent.id, { clientSecret, signingSecret }, stored.revision);
    }
    const removed = await this.commit(agent, { type: 'app_removed', at: this.now() });
    if (removed.outcome !== 'applied') return undefined;
    await this.armSwitch(removed.agent);
    return removed.agent;
  }

  /**
   * Archive: uninstall and delete the app, hand the handle back to its user
   * group. Throws AgentPresenceError when Slack refuses or does not answer the
   * uninstall, so the Agent is not archived; a create still settling refuses
   * the same way. A live app Slack did not answer about is still installed, so
   * it goes back to answering until the archive is tried again.
   */
  async retire(agent: CustomAgentConfig): Promise<{ agent: CustomAgentConfig; outcome: AgentAppRetirement['outcome'] }> {
    const presence = agent.slackPresence;
    const app = appRecordOf(presence);
    if (!app) return { agent, outcome: 'removed' };
    const record = agentAppRecord(app);
    const stored = record ? await readAppSecrets(this.secrets, record.appId).catch(unreadableAsNone) : undefined;
    const archived = await this.commit(agent, { type: 'archive', at: this.now(), hasBotToken: Boolean(stored?.secrets.botToken) });
    if (archived.outcome === 'refused') throw new AgentPresenceError('slack_operation_failed', archiveRefusedCopy({ name: agent.name }));
    if (archived.outcome === 'deleted') {
      if (app.state === 'needs_attention' && app.reason === 'ambiguous_create') {
        await this.message('ambiguous_create', agent, app.startedBy, `agent-app-archived-ambiguous:${agent.id}:${this.now()}`);
      }
      return { agent: archived.agent, outcome: 'removed' };
    }
    const { agent: settled } = await this.advance(agent.id, { archiving: true });
    const after = appRecordOf(settled.slackPresence);
    if (!after) {
      const left = this.leftForOwner.get(agent.id);
      this.leftForOwner.delete(agent.id);
      return { agent: settled, outcome: left ?? 'removed' };
    }
    if (agentAppIsLive(presence) && after.state === 'uninstalling' && after.next === 'uninstall') {
      await this.commit(settled, { type: 'uninstall_unanswered', at: this.now(), restore: presence.app });
    }
    throw new AgentPresenceError('slack_operation_failed', archiveRefusedCopy({ name: agent.name }));
  }

  /**
   * The Owner's App Home line for each Agent whose app is being set up, is
   * live or needs attention, keyed by Agent ID; empty for anyone but an
   * Owner. Giving an Agent its own app starts in Admin, never here.
   */
  async homeRows(
    agents: readonly CustomAgentConfig[],
    viewer: { role?: string | undefined },
  ): Promise<ReadonlyMap<string, readonly object[]>> {
    const rows = new Map<string, readonly object[]>();
    if (viewer.role !== 'owner') return rows;
    const withApps = agents.flatMap((agent) => {
      const app = agent.kind === 'user' ? appRecordOf(agent.slackPresence) : undefined;
      return app ? [{ agent, app }] : [];
    });
    const untold = withApps.some(({ app }) => app.state === 'active' && app.ownerNotTold);
    const privateGrants = untold
      ? (await this.deps.stores.config.listAgentChannelGrants()).filter((grant) => grant.status === 'active' && grant.channelIsPrivate)
      : [];
    const now = this.now();
    for (const { agent, app } of withApps) {
      rows.set(agent.id, agentAppHomeBlocks(homeRowFor(agent, app, now, privateGrants), this.names(agent), agent.id, this.deps.host.addUrl(agent.id)));
    }
    return rows;
  }

  /**
   * Paste once per workspace; the Owner who pasted it is kept with it. Every
   * live app that waited for a token, or whose update did not go through, is
   * brought to match its Agent again.
   */
  async pasteConfigurationToken(
    refreshToken: string,
    pastedBy: string,
  ): Promise<'saved' | 'not_refresh_token' | 'rejected' | 'other_workspace'> {
    const saved = await saveConfigurationToken(this.secrets, (await this.installation()).teamId, refreshToken, pastedBy);
    if (saved === 'saved') await this.unrefuseFollows(['config_token_needed', 'update_failed']);
    return saved;
  }

  /** A stored pair that cannot be opened is no token: the Owner pastes a new one. */
  async hasConfigurationToken(): Promise<boolean> {
    return (await this.configurationToken()).stored;
  }

  async configurationToken(): Promise<ConfigurationTokenStatus> {
    return configurationTokenStatus(this.secrets, (await this.installation()).teamId);
  }

  /** Spends the stored token with one rotation it never keeps, then deletes Chickpea's copy whatever Slack answered. */
  async removeConfigurationToken(): Promise<'discarded' | 'unconfirmed' | 'none'> {
    return discardConfigurationToken(this.secrets, (await this.installation()).teamId);
  }

  /** The Agents an Owner can give their own app: user Agents in use, each with a Slack presence. */
  async userAgents(): Promise<CustomAgentConfig[]> {
    return (await this.deps.stores.config.listAgents()).filter((agent) =>
      agent.kind === 'user' && agent.lifecycle !== 'archived' && agent.lifecycle !== 'draft' && agent.slackPresence);
  }

  async agentChannelGrants(): Promise<AgentChannelGrant[]> {
    return this.deps.stores.config.listAgentChannelGrants();
  }

  async setting(): Promise<AgentSlackAppsSetting> {
    return readAgentSlackAppsSetting(this.deps.stores.settings);
  }

  /** The mode already stored changes nothing, not even who chose it and when. */
  async setMode(mode: AgentSlackAppsMode, changedBy: string): Promise<{ setting: AgentSlackAppsSetting; changed: boolean }> {
    const current = await this.setting();
    if (current.mode === mode) return { setting: current, changed: false };
    return { setting: await writeAgentSlackAppsSetting(this.deps.stores.settings, { mode, changedBy, changedAt: this.now() }), changed: true };
  }

  /**
   * The move job, the one driver of an Agent's move to and from its own app:
   * the switch steps a live app still owes, or a removed app's restore; then,
   * for a live app, what brings it to match its Agent. Each
   * step is recorded by compare-and-set before the next begins, so a rerun
   * from any point finishes it and repeats nothing that was recorded. Throws
   * when Slack may answer later, so the job retries; Slack's refusal of a
   * step is not retried. On the job's last try the Owner's message is given
   * up, and the switch still finishes.
   */
  async continueSwitch(agentId: string, options: { finalAttempt?: boolean; row?: number } = {}): Promise<'done' | 'not_live'> {
    const run: FollowRun = { finalAttempt: options.finalAttempt ?? false, ...(options.row !== undefined ? { row: options.row } : {}) };
    let agent = await this.deps.stores.config.getAgent(agentId);
    for (let guard = 0; guard < MAX_STEPS_PER_RUN; guard += 1) {
      const presence = agent.slackPresence;
      if (restorePending(presence)) {
        agent = await this.restoreGroup(agent, presence, options.finalAttempt ?? false);
        continue;
      }
      if (!agentAppIsLive(presence)) return 'not_live';
      const step = pendingSwitchStep(presence.app);
      if (step) {
        const done = await this.switchSteps[step](agent, presence, options.finalAttempt ?? false);
        agent = await this.recordSwitch(agent, step, done);
        continue;
      }
      const follow = await this.followOf(agent, presence.app.app.appId);
      const followStep = agentAppFollowStep(presence.app, follow.target, this.now());
      if (!followStep) return 'done';
      agent = await this.followSteps[followStep](agent, presence, follow, run);
    }
    throw Object.assign(new Error('The Agent app move did not settle.'), { name: 'agent_app_move_unsettled' });
  }

  private readonly switchSteps: Record<
    Exclude<AgentAppSwitchProgress, 'done'>,
    (agent: CustomAgentConfig, presence: LiveAgentApp, finalAttempt: boolean) => Promise<SwitchStepDone>
  > = {
    live: (agent, presence, finalAttempt) => this.switchSteps.group_pending(agent, presence, finalAttempt),

    group_pending: async (agent, presence) => {
      const userGroupId = answeringUserGroupId(presence);
      if (!userGroupId) return { next: 'bring_in_pending' };
      try {
        await this.deps.transport.disableUserGroup(userGroupId);
      } catch (error) {
        if (!(error instanceof SlackTransportError)) throw error;
        if (!GROUP_ALREADY_RELEASED.has(error.code)) {
          if (error.retryable) throw error;
          // Refused: the group keeps answering beside the app, and the Owner's message says so.
          logSlackRefusal('release_handle', { agentId: agent.id, appId: presence.app.app.appId }, error);
          return { next: 'bring_in_pending' };
        }
      }
      return { next: 'bring_in_pending', groupOff: userGroupId };
    },

    bring_in_pending: async (agent, presence) => {
      if (!presence.released) await this.grantWaitingChannels(agent);
      const bot = await this.switchBot(agent, presence);
      if (bot) {
        for (const channelId of await this.grantedChannels(agent.id)) {
          const channel = await seenBy(bot, channelId);
          // Private Channels are never joined; Slack shows the bot none it is not in.
          if (!channel || channel.private || channel.member || channel.archived) continue;
          try {
            await bot.joinPublicChannel(channelId);
          } catch (error) {
            if (!(error instanceof SlackTransportError)) throw error;
            if (error.retryable) throw error;
            logSlackRefusal('join', { agentId: agent.id, appId: presence.app.app.appId, channelId }, error);
          }
        }
      }
      return { next: 'owner_told' };
    },

    owner_told: async (agent, presence, finalAttempt) => {
      const { app, installedAt, installedBy } = presence.app;
      try {
        const bot = await this.switchBot(agent, presence);
        const joined: string[] = [];
        const throughChickpea: string[] = [];
        for (const channelId of await this.grantedChannels(agent.id)) {
          const channel = bot ? await seenBy(bot, channelId) : undefined;
          if (channel?.archived) continue;
          (channel?.member ? joined : throughChickpea).push(channelId);
        }
        const message = agentAppSwitchedMessage(this.names(agent), {
          joined, throughChickpea, groupStillOn: answeringUserGroupId(presence) !== undefined, added: !presence.released,
        });
        const dm = await this.deps.transport.openDirectConversation(installedBy);
        await this.deps.transport.postMessage({
          channelId: dm.id, text: message.text, blocks: message.blocks,
          idempotencyKey: `agent-app-switched:${agent.id}:${app.appId}:${installedAt}`,
        });
      } catch (error) {
        // The message is the switch's last step: a refusal, or a failure on the job's last try, gives up the message
        // and not the switch. The Owner's Home row says what it would have.
        const refused = error instanceof SlackTransportError && !error.retryable;
        if (!refused && !finalAttempt) throw error;
        console.warn({
          event: 'chickpea.agent_app.switch_owner_not_told', agentId: agent.id, appId: app.appId,
          error: error instanceof SlackTransportError ? error.code : error instanceof Error ? error.name : 'unknown',
        });
        return { next: 'done', ownerNotTold: true };
      }
      return { next: 'done' };
    },
  };

  /**
   * What brings a live app to match its Agent, each step recorded before the
   * next: its definition, sent with the bot scopes its definition in Slack
   * already holds, so no permission changes without an Owner's Allow; then its
   * picture. Only an app whose own record names this Agent is touched. A
   * refusal is recorded for this target; Slack not answering throws, so the
   * job retries, until its last try holds it as a refusal too.
   */
  private readonly followSteps: Record<
    'definition' | 'picture',
    (agent: CustomAgentConfig, presence: LiveAgentApp, follow: AgentAppFollow, run: FollowRun) => Promise<CustomAgentConfig>
  > = {
    definition: async (agent, presence, follow, run) => {
      const { appId } = presence.app.app;
      if ((await readOwnAppSecrets(this.secrets, appId, agent.id, 'update')).kind !== 'own') {
        return this.refuseFollow(agent, appId, follow.target, 'record_refused', run);
      }
      const { teamId } = await this.installation();
      try {
        await withConfigurationToken(this.secrets, teamId, async (token) => {
          const granted = await this.slack.definedBotScopes(token, appId);
          await this.slack.update(token, appId, withBotScopes(follow.manifest, granted));
        });
      } catch (error) {
        const refusal = followRefusal(error, run.finalAttempt);
        if (!refusal) throw error;
        if (error instanceof SlackRefused) {
          logSlackRefusal(error.method === 'apps.manifest.export' ? 'export' : 'update', { agentId: agent.id, appId }, error);
        }
        return this.refuseFollow(agent, appId, follow.target, refusal, run);
      }
      const { manifestFingerprint } = follow.target;
      return this.recordFollow(agent, appId, (follows) => ({ ...unrefusedFollows(follows), manifestFingerprint }), run);
    },

    picture: async (agent, presence, follow, run) => {
      const { appId } = presence.app.app;
      if ((await readOwnAppSecrets(this.secrets, appId, agent.id, 'icon')).kind !== 'own') {
        return this.refuseFollow(agent, appId, follow.target, 'record_refused', run);
      }
      const { teamId } = await this.installation();
      let icon: AgentAppIcon;
      try {
        // An avatar that cannot be read now is retried, never replaced by the default picture.
        const picture = await this.icon(agent, presence, { readFailure: 'throw' });
        icon = picture.icon;
        await withConfigurationToken(this.secrets, teamId, (token) => this.slack.setIcon(token, appId, picture.png));
      } catch (error) {
        const refusal = followRefusal(error, run.finalAttempt);
        if (!refusal) throw error;
        if (error instanceof SlackRefused) logSlackRefusal('icon', { agentId: agent.id, appId }, error);
        return this.refuseFollow(agent, appId, follow.target, refusal, run);
      }
      const { avatarRevision } = follow.target;
      return this.recordFollow(agent, appId, (follows) => ({ ...unrefusedFollows(follows), avatarRevision }), run, icon);
    },
  };

  /**
   * A follow that cannot go on for this target. The Agent is read again, so a
   * removal, an archive or a new app that landed while Slack answered records
   * nothing and tells no one. An Owner is told only of a refusal the record
   * does not already hold, so later edits while it stands tell no one; and a
   * missing token, which is the workspace's, is told once for every app,
   * naming none, to the first Owner who allowed a live app that Slack lets
   * Chickpea message. The Owner is told first, under a key a rerun repeats,
   * then the refusal is recorded. An app the configuration token cannot find,
   * which passed its own record's check, is removed at Slack, as its removal
   * event would have said, only once Slack refuses the app's own bot token:
   * the token is one person's, and may not see an app another Owner's token
   * made. A bot Slack accepts holds the update as one that did not go
   * through. The app's own record refusing is the operator's, logged where it
   * was read.
   */
  private async refuseFollow(
    agent: CustomAgentConfig,
    appId: string,
    target: AgentAppFollowTarget,
    reason: AgentAppFollowRefusal,
    run: FollowRun,
  ): Promise<CustomAgentConfig> {
    const latest = await this.deps.stores.config.getAgent(agent.id);
    const presence = latest.slackPresence;
    if (!agentAppIsLive(presence) || presence.app.app.appId !== appId) return latest;
    if (reason === 'app_not_found') {
      if (!await this.botInstalled(latest, appId, run.finalAttempt)) {
        return await this.removedAtSlack(latest, appId) ?? this.deps.stores.config.getAgent(agent.id);
      }
      return this.refuseFollow(latest, appId, target, 'update_failed', run);
    }
    const kind = await this.followMessage(presence, reason);
    if (kind) {
      const owners = kind === 'follow_token_needed' ? await this.liveAppOwners(presence.app.installedBy) : [presence.app.installedBy];
      for (const owner of owners) {
        try {
          await this.message(kind, latest, owner, `agent-app-follow:${latest.id}:${appId}:${reason}:${latest.revision}:${owner}`);
          break;
        } catch (error) {
          const refused = error instanceof SlackTransportError && !error.retryable;
          if (!refused && !run.finalAttempt) throw error;
          console.warn({
            event: 'chickpea.agent_app.follow_owner_not_told', agentId: latest.id, appId,
            error: error instanceof SlackTransportError ? error.code : error instanceof Error ? error.name : 'unknown',
          });
          // Slack will never take it for this Owner, and once the hold is recorded no other app tells anyone.
          if (!refused) break;
        }
      }
    }
    return this.recordFollow(latest, appId, (follows) => ({ ...follows, refused: { ...target, reason, at: this.now() } }), run);
  }

  /**
   * Whether Slack still accepts this app's own bot token. Slack not answering,
   * or no bot token to ask, throws for the job to retry; on its last try the
   * app counts as installed, so nothing is removed.
   */
  private async botInstalled(agent: CustomAgentConfig, appId: string, finalAttempt: boolean): Promise<boolean> {
    try {
      const stored = await readOwnAppSecrets(this.secrets, appId, agent.id, 'end');
      if (stored.kind !== 'own' || !stored.secrets.botToken) {
        throw Object.assign(new Error('No bot token to ask Slack about.'), { name: 'agent_app_bot_token_unread' });
      }
      return await this.slack.botInstalled(stored.secrets.botToken);
    } catch (error) {
      if (finalAttempt) return true;
      throw error;
    }
  }

  /** `first`, then each other Owner who allowed a live app, once each. */
  private async liveAppOwners(first: string): Promise<string[]> {
    const owners = new Set([first]);
    for (const agent of await this.deps.stores.config.listAgents()) {
      if (agentAppIsLive(agent.slackPresence)) owners.add(agent.slackPresence.app.installedBy);
    }
    return [...owners];
  }

  /** What the Owner is told of a follow's refusal, if anything. */
  private async followMessage(presence: LiveAgentApp, reason: AgentAppFollowRefusal): Promise<AgentAppMessageKind | undefined> {
    if (reason === 'config_token_needed') {
      const held = (await this.deps.stores.config.listAgents()).some((agent) =>
        agentAppIsLive(agent.slackPresence) && agent.slackPresence.app.follows?.refused?.reason === 'config_token_needed');
      return held ? undefined : 'follow_token_needed';
    }
    if (reason !== 'update_refused' && reason !== 'update_failed') return undefined;
    return presence.app.follows?.refused?.reason === reason ? undefined : reason;
  }

  /**
   * Record what a follow step did by compare-and-set, onto the app it was
   * done to, with the job row that did it; another app, or none live,
   * records nothing.
   */
  private async recordFollow(
    agent: CustomAgentConfig,
    appId: string,
    next: (follows: AgentAppFollows | undefined) => AgentAppFollows,
    run?: FollowRun,
    icon?: AgentAppIcon,
    attempt = 0,
  ): Promise<CustomAgentConfig> {
    const presence = agent.slackPresence;
    if (!agentAppIsLive(presence) || presence.app.app.appId !== appId) return agent;
    const follows = { ...next(presence.app.follows), ...(run?.row !== undefined ? { row: run.row } : {}) };
    const app = { ...presence.app, follows, ...(icon ? { icon } : {}) };
    try {
      return await this.deps.stores.config.updateAgent(agent.id, { slackPresence: normalizeAgentAppPresence({ ...presence, app }) }, agent.revision);
    } catch (error) {
      if (!(error instanceof AgentRevisionConflictError) || attempt >= MAX_COMMIT_RETRIES) throw error;
      return this.recordFollow(await this.deps.stores.config.getAgent(agent.id), appId, next, run, icon, attempt + 1);
    }
  }

  /**
   * An Owner asked again (Try again, or Start on a live app): drop the
   * refusal its follow holds and arm its job. A missing token is the
   * workspace's, so asking again on one app asks again on every app that
   * waits for it, and the next failure is told again, once.
   */
  private async followAgain(agent: CustomAgentConfig): Promise<CustomAgentConfig> {
    const presence = agent.slackPresence;
    if (agentAppIsLive(presence) && presence.app.follows?.refused?.reason === 'config_token_needed') {
      const cleared = await this.unrefuseFollows(['config_token_needed']);
      return cleared.find((candidate) => candidate.id === agent.id) ?? agent;
    }
    const cleared = await this.unrefusedFollow(agent);
    await this.armSwitch(cleared);
    return cleared;
  }

  /**
   * Every live app whose follow holds one of `reasons` is tried again. Every
   * hold is cleared before any job is armed, so no job finds another app's
   * hold and stays quiet for it.
   */
  private async unrefuseFollows(reasons: readonly AgentAppFollowRefusal[]): Promise<CustomAgentConfig[]> {
    const cleared: CustomAgentConfig[] = [];
    for (const agent of await this.deps.stores.config.listAgents()) {
      const presence = agent.slackPresence;
      const reason = agentAppIsLive(presence) ? presence.app.follows?.refused?.reason : undefined;
      if (reason && reasons.includes(reason)) cleared.push(await this.unrefusedFollow(agent));
    }
    for (const agent of cleared) await this.armSwitch(agent);
    return cleared;
  }

  private async unrefusedFollow(agent: CustomAgentConfig): Promise<CustomAgentConfig> {
    const presence = agent.slackPresence;
    if (!agentAppIsLive(presence) || !presence.app.follows?.refused) return agent;
    return this.recordFollow(agent, presence.app.app.appId, unrefusedFollows);
  }

  /**
   * An Agent's name, handle, description or avatar was saved: arm the job
   * that brings its live app to match, when it does not. Nothing is asked of
   * Slack here; a failed read of the Agent throws, for the caller to log.
   */
  async followAgent(agentId: string): Promise<void> {
    await this.armSwitch(await this.deps.stores.config.getAgent(agentId));
  }

  /** The live app's own bot, or none when its record is not this Agent's or holds no token. */
  private async switchBot(agent: CustomAgentConfig, presence: LiveAgentApp): Promise<AgentAppBotTransport | undefined> {
    const stored = await readOwnAppSecrets(this.secrets, presence.app.app.appId, agent.id, 'join');
    return stored.kind === 'own' && stored.secrets.botToken ? this.appBot(stored.secrets.botToken) : undefined;
  }

  /**
   * An Agent that was not in Slack yet, so released no group: each Channel it
   * was added to meanwhile waited as a pending grant, and ends as an add to it
   * would, checked again now: whoever added it is still an active member who
   * may edit the Agent and is still in the Channel, or it stays waiting. Chickpea's bot joins a public
   * one it is not in, so replies in the Agent's threads there need no
   * mention; a private one is granted where Chickpea's bot already is; an
   * archived one's grant is dropped.
   */
  private async grantWaitingChannels(agent: CustomAgentConfig): Promise<void> {
    const { config } = this.deps.stores;
    for (const grant of await config.listAgentChannelGrants()) {
      if (grant.agentId !== agent.id || grant.status !== 'pending') continue;
      const channel = await seenBy(this.deps.transport, grant.channelId);
      // Slack no longer shows Chickpea's bot the Channel (a private one it has left, or one deleted): the wait stays.
      if (!channel) continue;
      if (channel.archived) {
        await config.deleteAgentChannelGrant(grant.workspaceId, grant.channelId, agent.id);
        continue;
      }
      const writer = await this.deps.memberInSlack(grant.createdByMembershipId);
      if (!writer || !canEditAgent(writer, agent) || !await inChannel(this.deps.transport, grant.channelId, writer.slackUserId)) continue;
      if (!channel.private && !channel.member) {
        try {
          await this.deps.transport.joinPublicChannel(grant.channelId);
        } catch (error) {
          if (!(error instanceof SlackTransportError) || error.retryable) throw error;
          // The Agent's own bot still answers mentions there; follow-ups without one wait for Chickpea's bot.
          console.warn({ event: 'chickpea.agent_app.chickpea_not_joined', agentId: agent.id, channelId: grant.channelId, error: error.code });
        }
      }
      try {
        await config.putAgentChannelGrant({ ...grant, status: 'active' }, grant.revision);
      } catch (error) {
        // A rerun of this step got there first; anything else is the job's to retry.
        const now = (await config.listAgentChannelGrants(grant.workspaceId, grant.channelId)).find((g) => g.agentId === agent.id);
        if (now?.status !== 'active') throw error;
      }
    }
  }

  /**
   * A record that ended (a Cancel, a limit refusal) on an Agent in Slack
   * nowhere, after the workspace went back to `shared`: it gets its group
   * now, so it is never left out of Slack in that mode. Best effort: the
   * next `shared` press repairs it.
   */
  private async placeIfShared(agent: CustomAgentConfig): Promise<void> {
    if (!this.deps.placeInSlack || !waitsForOwnApp(agent)) return;
    if ((await this.setting()).mode !== 'shared') return;
    try {
      await this.deps.placeInSlack(agent.id);
    } catch (error) {
      console.warn({ event: 'chickpea.agent_app.not_placed', agentId: agent.id, error: error instanceof Error ? error.name : 'unknown' });
    }
  }

  private async grantedChannels(agentId: string): Promise<string[]> {
    const grants = await this.deps.stores.config.listAgentChannelGrants();
    return grants.filter((grant) => grant.agentId === agentId && grant.status === 'active').map((grant) => grant.channelId);
  }

  /**
   * Record one switch step done by compare-and-set; another run that recorded
   * it first wins, and nothing repeats. A group Slack confirmed it turned off
   * is recorded whatever happened to the app meanwhile, so the record never
   * says a group answers that Slack has turned off.
   */
  private async recordSwitch(
    agent: CustomAgentConfig,
    step: AgentAppSwitchProgress,
    done: SwitchStepDone,
    attempt = 0,
  ): Promise<CustomAgentConfig> {
    const presence = agent.slackPresence;
    let slackPresence: AgentSlackPresence | undefined;
    if (agentAppIsLive(presence) && pendingSwitchStep(presence.app) === step) {
      const released = presence.released && done.groupOff === presence.released.userGroupId
        ? { ...presence.released, answers: false }
        : presence.released;
      slackPresence = normalizeAgentAppPresence({
        ...presence,
        ...(released ? { released } : {}),
        app: {
          ...presence.app, at: this.now(), switchProgress: done.next, ...(done.ownerNotTold ? { ownerNotTold: true as const } : {}),
        },
      });
    } else if (done.groupOff) {
      slackPresence = groupTurnedOff(presence, done.groupOff);
    }
    if (!slackPresence) return agent;
    try {
      return await this.deps.stores.config.updateAgent(agent.id, { slackPresence }, agent.revision);
    } catch (error) {
      if (!(error instanceof AgentRevisionConflictError) || attempt >= MAX_COMMIT_RETRIES) throw error;
      return this.recordSwitch(await this.deps.stores.config.getAgent(agent.id), step, done, attempt + 1);
    }
  }

  /**
   * A removed app's restore: bring the group it released to the Agent's
   * current name and handle, turn it back on, tell the Owner, then hand the
   * handle back to the group, with the removed record
   * attached, only once Slack confirmed the group is on. Slack is never
   * trusted to have left the group as the record says: the enable is always
   * sent, and `already_enabled` is success. A refused enable leaves the Agent
   * answering through Chickpea, the Owner told, and nothing retries it until
   * an Owner asks; a group Slack never confirmed it turned off still answers
   * then, and the record and the message go on saying so. The message goes
   * before the record, under a key a rerun of the same removal and outcome
   * repeats, so the Owner is told once.
   */
  private async restoreGroup(agent: CustomAgentConfig, presence: RemovedAgentApp, finalAttempt: boolean): Promise<CustomAgentConfig> {
    const { released } = presence;
    const appId = presence.app.app?.appId;
    let outcome: 'on' | 'none' | 'refused' | 'permission' = released ? 'on' : 'none';
    let keptHandle: string | undefined;
    if (released) {
      keptHandle = await this.renameReleasedGroup(agent, presence, released.userGroupId);
      try {
        await this.deps.transport.enableUserGroup(released.userGroupId);
      } catch (error) {
        if (!(error instanceof SlackTransportError)) throw error;
        if (error.code !== 'already_enabled') {
          if (error.retryable) throw error;
          logSlackRefusal('restore_handle', { agentId: agent.id, ...(appId ? { appId } : {}) }, error);
          outcome = PERMISSION_REFUSALS.has(error.code) && await this.userGroupPermissionMissing() ? 'permission' : 'refused';
        }
      }
    }
    const enableRefused = outcome === 'refused' || outcome === 'permission';
    // A refusal changes nothing in Slack, so a group Slack never confirmed it turned off still answers.
    const mentionable = outcome === 'on' || (enableRefused && released?.answers === true);
    const kind: AgentAppMessageKind = mentionable
      ? keptHandle ? 'app_removed_handle_kept' : 'app_removed'
      : outcome === 'permission' ? 'app_removed_permission' : 'app_removed_unreachable';
    // People mention the group by the handle Slack has; one it refused never answers, so it is never named as one that does.
    const names = { ...this.names(agent), ...(keptHandle ? { handle: keptHandle, refusedHandle: presence.normalizedHandle } : {}) };
    try {
      await this.message(kind, agent, presence.app.startedBy, `agent-app-removed:${agent.id}:${appId ?? ''}:${presence.app.at}:${kind}`, names);
    } catch (error) {
      const refused = error instanceof SlackTransportError && !error.retryable;
      if (!refused && !finalAttempt) throw error;
      console.warn({
        event: 'chickpea.agent_app.restore_owner_not_told', agentId: agent.id, ...(appId ? { appId } : {}),
        error: error instanceof SlackTransportError ? error.code : error instanceof Error ? error.name : 'unknown',
      });
    }
    const slackPresence = enableRefused && released
      ? normalizeAgentAppPresence({ ...presence, released: { ...released, enableRefused: true } })
      : restoredPresence(presence);
    try {
      return await this.deps.stores.config.updateAgent(agent.id, { slackPresence }, agent.revision);
    } catch (error) {
      // Another writer moved the record after the enable was sent: the driver reads it again and repeats the step.
      if (!(error instanceof AgentRevisionConflictError)) throw error;
      return this.deps.stores.config.getAgent(agent.id);
    }
  }

  /**
   * Renames made while the app held the handle never reached the group it
   * released, so before the group answers again it takes the Agent's current
   * name and handle, by the rename a user-group Agent's group gets. A
   * refusal leaves the group as it was and returns the handle it keeps when
   * that is not the Agent's; Slack not answering throws, so the job retries.
   */
  private async renameReleasedGroup(agent: CustomAgentConfig, presence: RemovedAgentApp, userGroupId: string): Promise<string | undefined> {
    const refused = (error: unknown) => {
      if (!(error instanceof SlackTransportError) || error.retryable) throw error;
      logSlackRefusal('restore_handle', { agentId: agent.id, ...(presence.app.app ? { appId: presence.app.app.appId } : {}) }, error);
    };
    const groups = await this.deps.transport.listUserGroups({ includeDisabled: true }).catch((error: unknown) => refused(error));
    const group = groups?.find((candidate) => candidate.id === userGroupId);
    if (!groups || !group) return undefined;
    try {
      await bringUserGroupToAgent(this.deps.transport, group, agent, presence.normalizedHandle, groups);
      return undefined;
    } catch (error) {
      refused(error);
      return group.handle === presence.normalizedHandle ? undefined : group.handle;
    }
  }

  /**
   * Arm the job for an Agent whose move has steps left, or whose live app
   * does not match it. A failure is logged, not thrown: the state store's
   * sweep arms it again, and so does the Owner's Finish setting up.
   */
  private async armSwitch(agent: CustomAgentConfig): Promise<void> {
    const app = appRecordOf(agent.slackPresence);
    const appId = app && agentAppRecord(app)?.appId;
    try {
      const { teamId } = await this.installation();
      const job = agentAppMoveJob(agent.id, agent.slackPresence, teamId, await this.followDue(agent));
      if (job) await this.deps.armSwitch(job);
    } catch (error) {
      console.warn({
        event: 'chickpea.agent_app.switch_not_armed', agentId: agent.id, ...(appId ? { appId } : {}),
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  /** Whether a live app does not match its Agent; one that cannot be worked out is left to the sweep, and its move is armed all the same. */
  private async followDue(agent: CustomAgentConfig): Promise<boolean> {
    const presence = agent.slackPresence;
    if (!agentAppIsLive(presence)) return false;
    try {
      return agentAppFollowStep(presence.app, (await this.followOf(agent, presence.app.app.appId)).target, this.now()) !== undefined;
    } catch (error) {
      console.warn({ event: 'chickpea.agent_app.follow_not_compared', agentId: agent.id, error: error instanceof Error ? error.name : 'unknown' });
      return false;
    }
  }

  private async userGroupPermissionMissing(): Promise<boolean> {
    return await this.deps.userGroupPermissionMissing?.() ?? false;
  }

  private names(agent: CustomAgentConfig): AgentAppNames {
    return { name: agent.name, handle: agent.slackPresence?.normalizedHandle ?? agent.id };
  }

  private async knownAgent(agentId: string): Promise<CustomAgentConfig | undefined> {
    try {
      return await this.deps.stores.config.getAgent(agentId);
    } catch (error) {
      if (error instanceof UnknownAgentError) return undefined;
      throw error;
    }
  }

  private async publicOrigin(): Promise<string | undefined> {
    return (await this.deps.publicOrigin?.())?.replace(/\/+$/, '');
  }

  /** The Agent on a page: its name, handle and the avatar Admin shows. */
  private async pageAgent(agent: CustomAgentConfig): Promise<AgentAppPageAgent> {
    const avatarUrl = agentAvatarUrlForPresentation(agent, await this.publicOrigin(), agentAvatarInstallation(this.deps.env));
    return { ...this.names(agent), ...(avatarUrl ? { avatarUrl } : {}) };
  }

  /** A page's ways forward. Admin's paths stand alone where Admin's address is unknown, as Admin shares the host's. */
  private async pageLinks(agent?: CustomAgentConfig): Promise<AgentAppPageLinks> {
    const origin = (await this.publicOrigin()) ?? '';
    const app = agent && appRecordOf(agent.slackPresence);
    const live = app?.state === 'active' ? app.app.appId : undefined;
    return {
      admin: `${origin}${ADMIN_PATH}`,
      tokenPage: `${origin}${TOKEN_PAGE_PATH}`,
      ...(agent ? { add: this.deps.host.addUrl(agent.id), agentPage: `${origin}${ADMIN_PATH}/agents/${encodeURIComponent(agent.id)}` } : {}),
      ...(live ? { openInSlack: slackAppRedirect(live, (await this.installation()).teamId) } : {}),
    };
  }

  private async consentPage(outcome: ConsentOutcome, agent: CustomAgentConfig): Promise<Response> {
    return consentPage(outcome, await this.pageAgent(agent), await this.pageLinks(agent));
  }

  private readonly performers: Record<AgentAppStep, Performer> = {
    release_handle: async (run) => {
      if (run.app.state !== 'releasing_handle') return 'wait';
      const { startedBy } = run.app;
      const manifestFingerprint = slackManifestFingerprint(this.createManifest(run.agent));
      const userGroupId = run.presence.kind === 'agent_app' ? run.presence.released?.userGroupId : undefined;
      if (userGroupId) {
        try {
          await this.deps.transport.disableUserGroup(userGroupId);
        } catch (error) {
          if (!(error instanceof SlackTransportError)) throw error;
          if (!GROUP_ALREADY_RELEASED.has(error.code)) {
            logSlackRefusal('release_handle', { agentId: run.agent.id }, error);
            if (PERMISSION_REFUSALS.has(error.code) && await this.userGroupPermissionMissing()) {
              return {
                event: { type: 'handle_permission_missing', at: run.now },
                after: async () => {
                  await this.message('permission_needed', run.agent, startedBy, `agent-app-permission:${run.agent.id}:${run.now}`);
                },
              };
            }
            return { event: { type: 'handle_release_refused', at: run.now } };
          }
        }
      }
      return { event: { type: 'handle_released', at: run.now, manifestFingerprint } };
    },

    create: async (run) => {
      if (!run.wroteCreating || run.app.state !== 'creating') return 'wait';
      const { startedBy } = run.app;
      // Again just before Slack is asked: two Starts on two Agents can both pass the check at Start. Each run checks after
      // its own `creating` write, so at least one of two sees the other; at the same instant both stop, never both go on.
      if (handleHeldByAnother(await this.deps.stores.config.listAgents(), run.agent)) {
        return {
          event: { type: 'handle_taken', at: run.now },
          after: async () => {
            await this.message('handle_taken', run.agent, startedBy, `agent-app-handle-taken:${run.agent.id}:${run.now}`);
          },
        };
      }
      const { teamId } = await this.installation();
      const manifest = this.createManifest(run.agent);
      let created;
      try {
        created = await withConfigurationToken(this.secrets, teamId, (token) => this.slack.create(token, manifest));
      } catch (error) {
        if (error instanceof ConfigTokenNeeded) return { event: { type: 'config_token_needed', at: run.now } };
        if (error instanceof AmbiguousEffect) return { event: { type: 'create_ambiguous', at: run.now } };
        if (error instanceof SlackRefused && APP_LIMIT_REFUSALS.has(error.code)) {
          logSlackRefusal('create', { agentId: run.agent.id }, error);
          return {
            event: { type: 'app_limit_reached', at: run.now },
            after: async () => {
              await this.message('app_limit', run.agent, startedBy, `agent-app-limit:${run.agent.id}:${run.now}`);
            },
          };
        }
        if (error instanceof SlackRefused) {
          logSlackRefusal('create', { agentId: run.agent.id }, error);
          return { event: { type: 'create_refused', at: run.now, reason: error.code === 'ratelimited' ? 'slack_busy' : 'create_refused' } };
        }
        if (error instanceof SlackUnavailable) return 'wait';
        throw error;
      }
      const { clientSecret, signingSecret } = created;
      return {
        event: { type: 'created', at: run.now, app: { appId: created.appId, clientId: created.clientId } },
        after: async () => {
          try {
            await writeAppSecrets(this.secrets, created.appId, run.agent.id, { clientSecret, signingSecret }, null);
          } catch (error) {
            if (!(error instanceof LostRevision)) throw error;
          }
        },
      };
    },

    set_urls: async (run) => {
      if (run.app.state !== 'created') return 'wait';
      const { app, startedBy } = run.app;
      const record = await readOwnAppSecrets(this.secrets, app.appId, run.agent.id, 'update');
      if (record.kind === 'missing') {
        // A crash between the `created` commit and the realm write left an app with no record, so it is not
        // provably this Agent's and is never deleted: create again and leave the Owner to delete the unused one.
        if (run.now - run.app.at < CREATE_SETTLE_MS) return 'wait';
        const manifestFingerprint = slackManifestFingerprint(this.createManifest(run.agent));
        return {
          event: { type: 'recreate', at: run.now, manifestFingerprint },
          after: async () => {
            await this.message('recreated', run.agent, startedBy, `agent-app-unrecorded:${run.agent.id}:${app.appId}`);
          },
        };
      }
      if (record.kind !== 'own') return { event: { type: 'record_refused', at: run.now } };
      const { teamId } = await this.installation();
      const { manifest, target } = await this.followOf(run.agent, app.appId);
      try {
        await withConfigurationToken(this.secrets, teamId, (token) => this.slack.update(token, app.appId, manifest));
      } catch (error) {
        if (error instanceof ConfigTokenNeeded) return { event: { type: 'config_token_needed', at: run.now } };
        if (error instanceof SlackRefused) {
          logSlackRefusal('update', { agentId: run.agent.id, appId: app.appId }, error);
          return { event: { type: 'urls_refused', at: run.now } };
        }
        if (error instanceof SlackUnavailable) return 'wait';
        throw error;
      }
      return { event: { type: 'urls_set', at: run.now, manifestFingerprint: target.manifestFingerprint } };
    },

    set_icon: async (run) => {
      const app = agentAppRecord(run.app)!;
      if ((await readOwnAppSecrets(this.secrets, app.appId, run.agent.id, 'icon')).kind !== 'own') {
        return { event: { type: 'record_refused', at: run.now } };
      }
      const { teamId } = await this.installation();
      const { png, icon } = await this.icon(run.agent, run.presence);
      try {
        await withConfigurationToken(this.secrets, teamId, (token) => this.slack.setIcon(token, app.appId, png));
      } catch (error) {
        if (error instanceof SlackRefused) logSlackRefusal('icon', { agentId: run.agent.id, appId: app.appId }, error);
        else if (!(error instanceof ConfigTokenNeeded || error instanceof SlackUnavailable)) throw error;
        return { event: { type: 'icon_set', at: run.now, icon: 'not_set' } };
      }
      return { event: { type: 'icon_set', at: run.now, icon, avatarRevision: run.presence.avatar.revision } };
    },

    post_allow_dm: async (run) => {
      if (run.app.state !== 'icon_set') return 'wait';
      // The Owner is on their way to Slack's Allow screen; the Add link they pressed, and Admin's row, bring them back.
      if (run.handOff) return { event: { type: 'handed_to_slack', at: run.now } };
      const posted = await this.message('allow', run.agent, run.app.startedBy, `agent-app-allow:${run.agent.id}:${run.app.at}`);
      return { event: { type: 'allow_dm_posted', at: run.now, channelId: posted.channelId, ts: posted.ts } };
    },

    uninstall: async (run) => {
      const app = agentAppRecord(run.app)!;
      const record = await readOwnAppSecrets(this.secrets, app.appId, run.agent.id, 'uninstall');
      // Without its own record the app is not provably this Agent's: nothing is sent, and the delete step leaves it for the Owner.
      if (record.kind !== 'own' || !record.secrets.botToken) return { event: { type: 'uninstalled', at: run.now } };
      try {
        await this.slack.uninstall({
          clientId: app.clientId,
          clientSecret: record.secrets.clientSecret,
          botToken: record.secrets.botToken,
        });
      } catch (error) {
        if (error instanceof SlackUnavailable) return 'wait';
        if (!(error instanceof SlackRefused)) throw error;
        logSlackRefusal('uninstall', { agentId: run.agent.id, appId: app.appId }, error);
        if (error.code === 'ratelimited') return 'wait';
        return { event: { type: 'uninstall_refused', at: run.now } };
      }
      return { event: { type: 'uninstalled', at: run.now } };
    },

    delete: async (run) => {
      if (run.app.state !== 'uninstalling') return 'wait';
      const { app, startedBy, botUserId } = run.app;
      const record = await readOwnAppSecrets(this.secrets, app.appId, run.agent.id, 'delete');
      // With no record of its own, even one this step deleted before a crash, the app is not provably this Agent's: it is
      // left for the Owner, and the record, if any, is left as it is. An app that was live was not uninstalled either.
      const stillInstalled = record.kind !== 'own' && Boolean(botUserId);
      let left = record.kind !== 'own';
      let notFound = false;
      if (record.kind === 'own') {
        const { teamId } = await this.installation();
        try {
          await withConfigurationToken(this.secrets, teamId, (token) => this.slack.delete(token, app.appId));
        } catch (error) {
          if (error instanceof SlackUnavailable) return 'wait';
          if (error instanceof SlackRefused) logSlackRefusal('delete', { agentId: run.agent.id, appId: app.appId }, error);
          if (error instanceof SlackRefused && error.code === 'ratelimited') return 'wait';
          if (!(error instanceof ConfigTokenNeeded || error instanceof SlackRefused)) throw error;
          left = true;
          if (error instanceof SlackRefused) notFound = await this.appNotFound(teamId, app.appId);
        }
        await deleteAppSecrets(this.secrets, app.appId, record.revision);
      }
      if (left) this.leftForOwner.set(run.agent.id, stillInstalled ? 'left_for_owner' : 'uninstalled_left_definition');
      const message = cancelRemoval(run)
        ? notFound ? 'cancel_not_found' : 'cancel_left'
        : stillInstalled ? 'archived_installed' : notFound ? 'archived_not_found' : 'archived_left';
      // What happened to the app is already committed: a message Chickpea's bot cannot send (at tenant end it is often
      // gone) changes nothing about it.
      const tell = async () => {
        try {
          await this.message(message, run.agent, startedBy, `agent-app-left:${run.agent.id}:${app.appId}`);
        } catch (error) {
          console.warn({
            event: 'chickpea.agent_app.archive_owner_not_told', agentId: run.agent.id, appId: app.appId,
            error: error instanceof SlackTransportError ? error.code : error instanceof Error ? error.name : 'unknown',
          });
        }
      };
      return { event: { type: 'deleted', at: run.now }, ...(left ? { after: tell } : {}) };
    },
  };

  /**
   * Whether Slack says the app does not exist. Slack refuses a delete of an
   * app that no longer exists as it may refuse one of an app it will not let
   * this token delete, so the export, which names a missing app, tells them
   * apart. Any other answer is not proof the app is gone.
   */
  private async appNotFound(teamId: string, appId: string): Promise<boolean> {
    try {
      await withConfigurationToken(this.secrets, teamId, (token) => this.slack.definedBotScopes(token, appId));
      return false;
    } catch (error) {
      if (!(error instanceof SlackRefused || error instanceof SlackUnavailable || error instanceof ConfigTokenNeeded)) throw error;
      return error instanceof SlackRefused && error.code === 'app_not_found';
    }
  }

  /** Apply `event` to the Agent's record; a lost compare-and-set re-reads and re-applies when the state still allows it. */
  private async commit(
    agent: CustomAgentConfig,
    event: AgentAppEvent,
    attempt = 0,
  ): Promise<{ agent: CustomAgentConfig; outcome: 'applied' | 'deleted' | 'withdrawn' | 'refused' }> {
    const presence = agent.slackPresence;
    const app = appRecordOf(presence);
    if (!presence || !app) return { agent, outcome: 'refused' };
    // Only a Cancel of an app attached to a user group goes back to the group; a removed app's Allow is not cancelled.
    if (event.type === 'cancel' && presence.kind === 'agent_app') return { agent, outcome: 'refused' };
    const next = transition(app, event);
    if (isRefusal(next)) return { agent, outcome: 'refused' };
    const slackPresence = presence.kind === 'agent_app'
      ? appPresenceAfter(presence, next)
      : next.state === 'active' && event.type === 'consent_granted'
        ? switchedPresence(presence, next)
        : attachedPresenceAfter(presence, next);
    if (!slackPresence) return { agent, outcome: 'refused' };
    try {
      const updated = await this.deps.stores.config.updateAgent(agent.id, { slackPresence }, agent.revision);
      return { agent: updated, outcome: next.state === 'deleted' || next.state === 'withdrawn' ? next.state : 'applied' };
    } catch (error) {
      if (!(error instanceof AgentRevisionConflictError) || attempt >= MAX_COMMIT_RETRIES) throw error;
      return this.commit(await this.deps.stores.config.getAgent(agent.id), event, attempt + 1);
    }
  }

  private createManifest(agent: CustomAgentConfig): SlackAppCreateManifest {
    return agentAppCreateManifest(manifestIntent(agent, this.deps.host));
  }

  private async followOf(agent: CustomAgentConfig, appId: string): Promise<AgentAppFollow> {
    return agentAppFollow(agent, appId, this.deps.host, (await this.installation()).installationId);
  }

  /**
   * The Agent's avatar when it is a square PNG Slack accepts; its 512 px
   * default otherwise. An avatar that cannot be read is the default too,
   * unless `readFailure` is `throw`.
   */
  private async icon(
    agent: CustomAgentConfig,
    presence: AgentPresenceBase,
    options: { readFailure: 'default' | 'throw' } = { readFailure: 'default' },
  ): Promise<{ png: Uint8Array<ArrayBuffer>; icon: AgentAppIcon }> {
    const read = readAgentAvatarAsset({
      settings: this.deps.stores.settings,
      agentId: agent.id,
      revision: presence.avatar.revision,
      avatar: presence.avatar,
    });
    const asset = options.readFailure === 'throw' ? await read : await read.catch(() => undefined);
    if (asset?.contentType === 'image/png' && pngIsSlackIcon(asset.bytes)) {
      return { png: new Uint8Array(asset.bytes), icon: 'agent_avatar' };
    }
    return { png: new Uint8Array(await generatedAgentAvatarPng(presence.avatar.seed ?? agent.id)), icon: 'default_avatar' };
  }

  private async notifyAttention(agent: CustomAgentConfig, archiving = false): Promise<void> {
    const presence = agent.slackPresence;
    const app = appRecordOf(presence);
    if (!presence || app?.state !== 'needs_attention') return;
    const { reason, startedBy, at } = app;
    const kind = reason === 'uninstall_failed' && cancelRemoval({ agent, presence, archiving }) ? 'cancel_unfinished' : reason;
    await this.message(kind, agent, startedBy, `agent-app-attention:${agent.id}:${reason}:${at}`);
  }

  /** DM the Owner from the main bot. */
  private async message(
    kind: AgentAppMessageKind,
    agent: CustomAgentConfig,
    slackUserId: string,
    idempotencyKey: string,
    names: AgentAppNames = this.names(agent),
  ): Promise<{ channelId: string; ts: string }> {
    const linked: readonly AgentAppMessageKind[] = [
      'config_token_needed', 'permission_needed', 'app_removed_permission', 'handle_taken', 'update_refused', 'follow_token_needed',
    ];
    const origin = linked.includes(kind)
      ? await this.deps.publicOrigin?.()
      : undefined;
    const links: AgentAppLinks = {
      agentId: agent.id,
      allowUrl: this.deps.host.allowUrl(agent.id),
      addUrl: this.deps.host.addUrl(agent.id),
      ...(origin ? { tokenPageUrl: tokenPageUrl(origin), adminUrl: adminUrl(origin) } : {}),
    };
    const message = agentAppMessage(kind, names, links);
    const dm = await this.deps.transport.openDirectConversation(slackUserId);
    return this.deps.transport.postMessage({ channelId: dm.id, text: message.text, blocks: message.blocks, idempotencyKey });
  }

  private installation(): Promise<{ teamId: string; installationId: string }> {
    this.facts ??= (async () => {
      const installations = await this.deps.stores.config.listWorkspaceInstallations();
      const workspace = installations[0];
      if (!workspace) throw new Error('No Slack workspace is installed.');
      return {
        teamId: workspace.teamId ?? workspace.workspaceId,
        installationId: installationScopeOf(this.deps.env)?.installationId ?? workspace.workspaceId,
      };
    })();
    return this.facts;
  }
}

function tokenPageUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${TOKEN_PAGE_PATH}`;
}

function adminUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${ADMIN_PATH}`;
}

/**
 * A removal that is a Cancel's, told by the Agent itself: not an archive's own
 * run, the Agent not archived, and the app attached to its user group. A
 * Cancel a later run finishes is never reported as an archive.
 */
function cancelRemoval(run: Pick<Run, 'agent' | 'presence' | 'archiving'>): boolean {
  return !run.archiving && run.agent.lifecycle !== 'archived' && run.presence.kind !== 'agent_app';
}

/** A removal under way on a record attached to a user group, including one whose uninstall Slack refused: a Cancel's. */
function cancelPending(app: AgentAppLifecycle): boolean {
  return app.state === 'uninstalling' || (app.state === 'needs_attention' && app.resume === 'uninstalling');
}

/** What the Owner's App Home says about an Agent's app. */
function homeRowFor(
  agent: CustomAgentConfig,
  app: AgentAppLifecycle,
  now: number,
  privateGrants: readonly { agentId: string; channelId: string }[],
): AgentAppHomeRow {
  const presence = agent.slackPresence;
  const settling = (): AgentAppHomeRow => now - app.at >= STALLED_AFTER_MS ? { kind: 'stalled' } : { kind: 'setting_up' };
  switch (app.state) {
    case 'active':
      if (pendingSwitchStep(app)) return settling();
      // Without the result message the row says what it would have: the private Channels where the Agent answers
      // through Chickpea until someone adds it, and a group Slack would not turn off.
      return app.ownerNotTold
        ? {
            kind: 'active_untold',
            report: {
              joined: [],
              throughChickpea: privateGrants.filter((grant) => grant.agentId === agent.id).map((grant) => grant.channelId),
              groupStillOn: answeringUserGroupId(presence) !== undefined,
              added: presence?.kind === 'agent_app' && !presence.released,
            },
          }
        : { kind: 'active' };
    case 'awaiting_consent':
      return { kind: 'waiting' };
    case 'needs_attention':
      return { kind: 'attention' };
    case 'uninstalling':
      if (presence?.kind !== 'agent_app') return now - app.at >= STALLED_AFTER_MS ? { kind: 'removing_stalled' } : { kind: 'removing' };
      return settling();
    default: {
      // On its way to Allow: the hand-off picks it up where it stopped.
      const row = settling();
      return row.kind === 'stalled' ? { kind: 'stalled', add: true } : row;
    }
  }
}

/** A user Agent in use with a place in Slack, which an Owner can give its own app. */
function addable(agent: CustomAgentConfig): boolean {
  return agent.kind === 'user' && agent.lifecycle !== 'archived' && agent.lifecycle !== 'draft' && agent.slackPresence !== undefined;
}

/**
 * Taking the handle, at Start and again in the create step: another unarchived Agent in Slack holds it, an app record
 * on its way counting as holding it.
 */
function handleHeldByAnother(agents: readonly CustomAgentConfig[], agent: CustomAgentConfig): boolean {
  const handle = agent.slackPresence?.normalizedHandle;
  return handle !== undefined && handlesOtherAgentsHoldInSlack(agents, agent.id).has(handle);
}

function slackAppRedirect(appId: string, teamId: string): string {
  return `https://slack.com/app_redirect?app=${encodeURIComponent(appId)}&team=${encodeURIComponent(teamId)}`;
}

/** An `agent_app` presence after its record moved: the user group back once the app is gone or the start undone. */
function appPresenceAfter(presence: AgentAppPresence, next: Exclude<AgentAppTransition, AgentAppRefusal>): AgentSlackPresence {
  if (next.state === 'deleted') return releasedPresence(presence);
  if (next.state === 'withdrawn') return withdrawnPresence(presence);
  // A refused restore belongs to the removal it followed: once the record moves, a later removal is restored afresh.
  const released = presence.released && unrefused(presence.released);
  return normalizeAgentAppPresence({ ...presence, app: next, ...(released ? { released } : {}) });
}

/** A released group without the mark of a restore Slack refused. */
function unrefused(released: NonNullable<AgentAppPresence['released']>): NonNullable<AgentAppPresence['released']> {
  const { enableRefused: _refused, ...rest } = released;
  return rest;
}

/**
 * A user group's presence after its attached record moved: the group as it
 * was, with the record gone once the app is, or the record's next state.
 * Undefined for a record that would go live, which only the switch to an
 * `agent_app` presence may do.
 */
function attachedPresenceAfter(
  presence: UserGroupPresence,
  next: Exclude<AgentAppTransition, AgentAppRefusal>,
): UserGroupPresence | undefined {
  const { app: _app, ...group } = presence;
  if (next.state === 'deleted' || next.state === 'withdrawn') return group;
  const attached = attachedAgentApp(next);
  return attached ? { ...group, app: attached } : undefined;
}

/**
 * A user group's presence once an Owner's Allow made its attached app live:
 * the app holds the handle, and the group it held, with how it stood, is
 * kept as released and still answering until the switch turns it off.
 */
function switchedPresence(presence: UserGroupPresence, live: AgentAppLifecycle): AgentAppPresence {
  const { userGroupId, desiredState, health } = presence;
  return normalizeAgentAppPresence({
    kind: 'agent_app',
    requestedHandle: presence.requestedHandle,
    normalizedHandle: presence.normalizedHandle,
    avatar: presence.avatar,
    desiredState: 'active',
    health: 'healthy',
    app: live,
    ...(userGroupId ? { released: { userGroupId, desiredState, health, answers: true } } : {}),
  });
}

/**
 * The start is undone before Slack changed anything, so the handle's user
 * group is the Agent's again, as it stood before the start. A start recorded
 * without that state comes back active but pending: how the group stood is
 * unknown, so it is not shown as healthy.
 */
function withdrawnPresence(presence: AgentAppPresence): UserGroupPresence {
  const released = releasedPresence(presence);
  const before = presence.released;
  return before ? { ...released, desiredState: before.desiredState ?? 'active', health: before.health ?? 'pending' } : released;
}

/**
 * After the app is gone the handle returns to its user group: disabled, or as
 * it stood before the start when the switch had not yet turned it off. An
 * Agent that never had one is unpublished.
 */
function releasedPresence(presence: AgentAppPresence): UserGroupPresence {
  const released = presence.released;
  const userGroupId = released?.userGroupId;
  const stillOn = released?.answers === true;
  return {
    requestedHandle: presence.requestedHandle,
    normalizedHandle: presence.normalizedHandle,
    avatar: presence.avatar,
    desiredState: stillOn ? released.desiredState ?? 'active' : 'disabled',
    health: stillOn ? released.health ?? 'pending' : userGroupId ? 'healthy' : 'unpublished',
    ...(userGroupId ? { userGroupId } : {}),
  };
}

/**
 * The presence once Slack confirmed it turned `userGroupId` off, when the
 * switch step that did so finds the app no longer live: the released group no
 * longer answers; or, when a restore already handed the handle back to that
 * group, the removed app again holds it with the group off, so the driver's
 * restore turns it on once more. Undefined when the record already agrees.
 */
function groupTurnedOff(presence: AgentSlackPresence | undefined, userGroupId: string): AgentSlackPresence | undefined {
  if (presence?.kind === 'agent_app') {
    const { released } = presence;
    if (released?.userGroupId !== userGroupId || released.answers !== true) return undefined;
    return normalizeAgentAppPresence({ ...presence, released: { ...released, answers: false } });
  }
  const app = presence?.app;
  if (presence?.userGroupId !== userGroupId || app?.state !== 'needs_attention' || app.reason !== 'app_removed') return undefined;
  return normalizeAgentAppPresence({
    kind: 'agent_app',
    requestedHandle: presence.requestedHandle,
    normalizedHandle: presence.normalizedHandle,
    avatar: presence.avatar,
    desiredState: 'active',
    health: 'needs_attention',
    app,
    released: { userGroupId, desiredState: presence.desiredState, health: presence.health, answers: false },
  });
}

/**
 * A removed app's presence once its group is back on: the group holds the
 * handle again, with the removed app's record attached for the Owner's next
 * Allow. An Agent that never had a group goes back to having none.
 */
function restoredPresence(presence: RemovedAgentApp): UserGroupPresence {
  const userGroupId = presence.released?.userGroupId;
  const app = attachedAgentApp(presence.app);
  return {
    requestedHandle: presence.requestedHandle,
    normalizedHandle: presence.normalizedHandle,
    avatar: presence.avatar,
    desiredState: userGroupId ? 'active' : 'unpublished',
    health: userGroupId ? 'healthy' : 'unpublished',
    ...(userGroupId ? { userGroupId } : {}),
    ...(app ? { app } : {}),
  };
}

/** What the app's own bot sees of a Channel; undefined for one it cannot see, as Slack hides a private Channel it is not in. */
async function seenBy(bot: AgentAppBotTransport, channelId: string): Promise<SlackChannel | undefined> {
  try {
    return await bot.lookupChannel(channelId);
  } catch (error) {
    if (!(error instanceof SlackTransportError) || error.retryable) throw error;
    return undefined;
  }
}

/** Whether Slack says the person is in the Channel. A refusal to say is a no: the Channel keeps waiting and the switch goes on. */
async function inChannel(bot: Pick<AgentAppTransport, 'channelHasMember'>, channelId: string, userId: string): Promise<boolean> {
  try {
    return await bot.channelHasMember(channelId, userId);
  } catch (error) {
    if (!(error instanceof SlackTransportError) || error.retryable) throw error;
    return false;
  }
}

/** Slack takes a square PNG of 512 to 2000 px; the IHDR chunk carries both dimensions. */
function pngIsSlackIcon(bytes: Uint8Array): boolean {
  if (bytes.length < 24) return false;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((byte, index) => bytes[index] === byte)) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width === height && width >= ICON_MIN_PX && width <= ICON_MAX_PX;
}

/**
 * A follow's refusal, or undefined when Slack may answer later and the job
 * retries. Only Slack refusing the definition itself is the Agent's to
 * change; on the job's last try, Slack not answering is held as well.
 */
function followRefusal(error: unknown, finalAttempt: boolean): Exclude<AgentAppFollowRefusal, 'record_refused'> | undefined {
  if (error instanceof ConfigTokenNeeded) return 'config_token_needed';
  if (error instanceof SlackRefused && error.code !== 'ratelimited') {
    if (TOKEN_REFUSALS.has(error.code)) return 'config_token_needed';
    if (error.code === 'app_not_found') return 'app_not_found';
    return error.method === 'apps.manifest.update' && error.code === 'invalid_manifest' ? 'update_refused' : 'update_failed';
  }
  return finalAttempt ? 'update_failed' : undefined;
}

function unrefusedFollows(follows: AgentAppFollows | undefined): AgentAppFollows {
  const { refused: _refused, ...rest } = follows ?? {};
  return rest;
}

/** `manifest` asking for exactly the bot scopes Slack granted, whatever Chickpea's definition asks for today. */
function withBotScopes(manifest: SlackAppManifest, granted: readonly string[]): SlackAppManifest {
  const result = structuredClone(manifest);
  result.oauth_config.scopes.bot = [...granted];
  return result;
}
