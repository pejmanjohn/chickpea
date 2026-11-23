/**
 * The one writer of an Agent's app lifecycle and of its secrets. `advance`
 * asks the pure `nextStep` for the one effect due, performs it, commits by
 * compare-and-set and repeats until the record waits for a person, Slack, or
 * another run. A lost compare-and-set re-reads and re-applies the transition
 * when the state still allows it; it never repeats the effect.
 */
import { AgentRevisionConflictError, UnknownAgentError } from '../../config/errors.ts';
import { AgentPresenceError } from '../agent-presence/errors.ts';
import { installationScopeOf } from '../../config/installation-scope.ts';
import type { EncryptedCredentialStore, SettingsStore } from '../../config/settings-store.ts';
import type { PlatformEnv } from '../../config/state-backend.ts';
import type { ConfigStore } from '../../config/store.ts';
import {
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
import { generatedAgentAvatarPng, readAgentAvatarAsset } from '../agent-presence/avatar-assets.ts';
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
  type SlackAppRequestUrls,
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
  agentAppIsLive,
  agentAppMoveJob,
  agentAppRecord,
  attachedAgentApp,
  createIsStale,
  isRefusal,
  nextStep,
  normalizeAgentAppPresence,
  pendingSwitchStep,
  restorePending,
  transition,
} from './lifecycle.ts';
import {
  ADMIN_PATH,
  type AgentAppHomeRow,
  type AgentAppLinks,
  type AgentAppMessageKind,
  type AgentAppNames,
  STALLED_AFTER_MS,
  agentAppHomeBlocks,
  agentAppMessage,
  agentAppSwitchedMessage,
  archiveRefusedCopy,
  consentPage,
  tokenPagePath,
  unnamedExpiredPage,
} from './pages.ts';
import {
  ConfigTokenNeeded,
  type ConfigurationTokenStatus,
  LostRevision,
  type SecretDeps,
  configurationTokenStatus,
  deleteAppSecrets,
  discardConfigurationToken,
  hasConfigurationToken,
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
  'disableUserGroup' | 'enableUserGroup' | 'openDirectConversation' | 'postMessage'
>;

/** What an Agent app's own bot does at the switch: see a Channel and join a public one. */
export type AgentAppBotTransport = Pick<SlackTransport, 'lookupChannel' | 'joinPublicChannel'>;

export type { AgentAppSwitchJob } from './lifecycle.ts';

export interface AgentSlackAppsDeps {
  env: PlatformEnv | undefined;
  stores: {
    config: Pick<ConfigStore, 'getAgent' | 'listAgents' | 'updateAgent' | 'listWorkspaceInstallations' | 'listAgentChannelGrants'>;
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
  now?: () => number;
}

export type AgentAppStartOutcome =
  | { kind: 'started'; agent: CustomAgentConfig }
  | { kind: 'already_started'; agent: CustomAgentConfig }
  | { kind: 'token_needed' }
  | { kind: 'permission_needed' }
  | { kind: 'not_eligible' };

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
  | { kind: 'token_needed' }
  | { kind: 'permission_needed' }
  | { kind: 'not_eligible' };

export type AgentAppCancelOutcome =
  | { kind: 'cancelled'; agent: CustomAgentConfig }
  | { kind: 'not_waiting' }
  | { kind: 'not_eligible' };

interface Run {
  agent: CustomAgentConfig;
  presence: AgentSlackPresence;
  app: AgentAppLifecycle;
  now: number;
  /** Only the run that wrote `creating` may create; any other run waits for it to settle. */
  wroteCreating: boolean;
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
const STATE_SHAPE = /^([A-Za-z0-9_-]{1,128})\.([a-f0-9-]{36})$/;
const MAX_COMMIT_RETRIES = 3;
const ICON_MIN_PX = 512;
const ICON_MAX_PX = 2_000;
const GROUP_ALREADY_RELEASED = new Set(['already_disabled', 'no_such_subteam']);
/**
 * An app made before Chickpea asked for `channels:join` may be granted
 * without it. Its bot then cannot join a Channel the Agent is added to, and
 * is reported as left out there.
 */
const OLDER_APPS_LACK = 'channels:join';
/** How Slack refuses a user-group change for want of a permission. */
const PERMISSION_REFUSALS = new Set(['permission_denied', 'missing_scope', 'not_allowed']);

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
  /** Agents whose app an Owner's Cancel is deleting: an app left behind is the cancel's, not an archive's. */
  private readonly cancelling = new Set<string>();

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
  async start(agentId: string, ownerSlackUserId: string): Promise<AgentAppStartOutcome> {
    const { config } = this.deps.stores;
    const agent = await config.getAgent(agentId);
    const presence = agent.slackPresence;
    if (agent.kind !== 'user' || agent.lifecycle === 'archived' || agent.lifecycle === 'draft' || !presence) {
      return { kind: 'not_eligible' };
    }
    if (presence.kind === 'agent_app' || presence.app) return { kind: 'already_started', agent };
    if (presence.userGroupId && await this.userGroupPermissionMissing()) {
      await this.message('permission_needed', agent, ownerSlackUserId, `agent-app-permission:${agent.id}:${this.now()}`);
      return { kind: 'permission_needed' };
    }
    const { teamId } = await this.installation();
    if (!(await hasConfigurationToken(this.secrets, teamId))) return { kind: 'token_needed' };
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
      return this.start(agentId, ownerSlackUserId);
    }
    return { kind: 'started', agent: await this.advance(agentId, { wroteCreating: true }) };
  }

  /** Perform the next step, commit by compare-and-set, repeat until the record waits. */
  async advance(agentId: string, options: { wroteCreating?: boolean } = {}): Promise<CustomAgentConfig> {
    const { config } = this.deps.stores;
    let agent = await config.getAgent(agentId);
    let wroteCreating = options.wroteCreating ?? false;
    for (let guard = 0; guard < MAX_STEPS_PER_RUN; guard += 1) {
      const presence = agent.slackPresence;
      const app = appRecordOf(presence);
      if (!presence || !app) return agent;
      const now = this.now();
      if (createIsStale(app, now)) {
        agent = (await this.commit(agent, { type: 'create_ambiguous', at: now })).agent;
        await this.notifyAttention(agent);
        return agent;
      }
      const step = nextStep(app, now);
      if (!step) return agent;
      const outcome = await this.performers[step]({ agent, presence, app, now, wroteCreating });
      if (outcome === 'wait') return agent;
      const committed = await this.commit(agent, outcome.event);
      agent = committed.agent;
      if (committed.outcome === 'refused') continue;
      wroteCreating = outcome.event.type === 'handle_released' || outcome.event.type === 'recreate';
      if (outcome.after) await outcome.after();
      if (committed.outcome === 'deleted' || committed.outcome === 'withdrawn') return agent;
      if (appRecordOf(agent.slackPresence)?.state === 'needs_attention') {
        await this.notifyAttention(agent);
        return agent;
      }
    }
    return agent;
  }

  /**
   * An Owner chose Try again or Finish setting up: resume where the record
   * says, then advance. A live app whose switch has steps left has its job
   * armed again, and so does a removed app's group, which Slack may now let
   * Chickpea turn back on.
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
    if (app.state === 'active' || restorePending(agent.slackPresence)) {
      await this.armSwitch(agent);
      return agent;
    }
    if (app.state !== 'needs_attention') return this.advance(agentId);
    return this.tryAgain(agent, app, ownerSlackUserId);
  }

  /** Resume a record that needs attention where it says, then advance: for a removed app, its Allow message again. */
  private async tryAgain(
    agent: CustomAgentConfig,
    app: Extract<AgentAppLifecycle, { state: 'needs_attention' }>,
    ownerSlackUserId: string,
  ): Promise<CustomAgentConfig> {
    const agentId = agent.id;
    const manifestFingerprint = slackManifestFingerprint(this.createManifest(agent));
    const resumed = await this.commit(agent, {
      type: 'try_again', at: this.now(), startedBy: ownerSlackUserId, manifestFingerprint,
    });
    if (resumed.outcome === 'refused') return resumed.agent;
    return this.advance(agentId, { wroteCreating: app.resume === 'creating' });
  }

  /** "Allow <Agent> in Slack": a fresh consent nonce, then Slack's authorize page. */
  async allow(agentId: string, ownerSlackUserId: string): Promise<Response> {
    const { config } = this.deps.stores;
    let agent = await config.getAgent(agentId);
    const names = this.names(agent);
    const app = appRecordOf(agent.slackPresence);
    if (!app) return consentPage('expired', names);
    if (app.state === 'active') return consentPage('already_active', names);
    if (app.state === 'needs_attention' && app.reason === 'app_removed') agent = await this.tryAgain(agent, app, ownerSlackUserId);
    const url = await this.authorizeUrl(agent, ownerSlackUserId);
    return url ? Response.redirect(url, 303) : consentPage('expired', names);
  }

  /** Slack's authorize page for an app waiting for Allow, under a fresh nonce bound to this Owner; undefined for any other record. */
  private async authorizeUrl(agent: CustomAgentConfig, ownerSlackUserId: string): Promise<string | undefined> {
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
    url.searchParams.set('state', `${agent.id}.${nonce}`);
    return url.toString();
  }

  /**
   * An Owner's press in Admin: start the app, or pick up a record that
   * stopped, then lead straight to Allow. A second press while the first is
   * creating waits for it; one waiting for Allow gets a fresh link.
   */
  async press(agentId: string, ownerSlackUserId: string): Promise<AgentAppPressOutcome> {
    const { config } = this.deps.stores;
    let agent = await config.getAgent(agentId);
    if (agent.kind !== 'user' || agent.lifecycle === 'archived' || agent.lifecycle === 'draft' || !agent.slackPresence) {
      return { kind: 'not_eligible' };
    }
    const record = appRecordOf(agent.slackPresence);
    if (!record) {
      const started = await this.start(agentId, ownerSlackUserId);
      if (started.kind === 'token_needed' || started.kind === 'permission_needed' || started.kind === 'not_eligible') return started;
      agent = started.agent;
    } else if (record.state === 'needs_attention' && agent.slackPresence.kind !== 'agent_app') {
      if (record.reason === 'config_token_needed' && !(await this.hasConfigurationToken())) return { kind: 'token_needed' };
      agent = await this.retry(agentId, ownerSlackUserId);
    }
    const app = appRecordOf(agent.slackPresence);
    if (app?.state === 'awaiting_consent') {
      const url = await this.authorizeUrl(agent, ownerSlackUserId);
      return url ? { kind: 'authorize', url, agent: await config.getAgent(agentId) } : { kind: 'creating', agent };
    }
    if (app?.state === 'needs_attention' && app.reason === 'config_token_needed') return { kind: 'token_needed' };
    if (app?.state === 'needs_attention') return { kind: 'needs_attention', agent };
    if (app?.state === 'active') return { kind: 'already_own_app', agent };
    return { kind: 'creating', agent };
  }

  /**
   * An Owner's Cancel before Allow: the created app is deleted under its own
   * record, and the Agent goes back to how it answered before the press.
   */
  async cancel(agentId: string): Promise<AgentAppCancelOutcome> {
    const agent = await this.deps.stores.config.getAgent(agentId);
    if (agent.kind !== 'user' || agent.lifecycle === 'archived') return { kind: 'not_eligible' };
    if (appRecordOf(agent.slackPresence)?.state !== 'awaiting_consent' || agent.slackPresence?.kind === 'agent_app') {
      return { kind: 'not_waiting' };
    }
    this.cancelling.add(agentId);
    try {
      return { kind: 'cancelled', agent: (await this.retire(agent)).agent };
    } finally {
      this.cancelling.delete(agentId);
    }
  }

  /** Slack's callback, forwarded untouched: exchange the code with the app's own credentials and validate the grant. */
  async completeConsent(query: URLSearchParams, ownerSlackUserId: string): Promise<Response> {
    const { config } = this.deps.stores;
    const state = STATE_SHAPE.exec(query.get('state') ?? '');
    if (!state) return unnamedExpiredPage();
    const agentId = state[1]!;
    const nonce = state[2]!;
    let agent;
    try {
      agent = await config.getAgent(agentId);
    } catch (error) {
      if (!(error instanceof UnknownAgentError)) throw error;
      return unnamedExpiredPage();
    }
    const names = this.names(agent);
    const record = appRecordOf(agent.slackPresence);
    if (!record) return consentPage('expired', names);
    if (record.state === 'active') return consentPage('already_active', names);
    if (record.state !== 'awaiting_consent') return consentPage('expired', names);
    const { consents, app } = record;
    const now = this.now();
    const nonceDigest = await sha256Hex(nonce);
    const [owner, consent] = Object.entries(consents ?? {}).find(([, open]) => open.nonceDigest === nonceDigest) ?? [];
    if (!owner || !consent || consent.expiresAt <= now) return consentPage('expired', names);
    if (owner !== ownerSlackUserId) return consentPage('another_person', names);
    if (query.get('error') || !query.get('code')) {
      await this.commit(agent, { type: 'consent_undone', at: now, owner });
      return consentPage('cancelled', names);
    }
    const stored = await readOwnAppSecrets(this.secrets, app.appId, agent.id, 'exchange');
    if (stored.kind !== 'own') return consentPage('expired', names);
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
        return consentPage('expired', names);
      }
      if (error instanceof SlackUnavailable) return consentPage('slack_down', names);
      throw error;
    }
    const { teamId } = await this.installation();
    const undo = async () => {
      await this.slack.uninstall({ clientId: app.clientId, clientSecret: stored.secrets.clientSecret, botToken: grant.botToken }).catch((error: unknown) => {
        if (error instanceof SlackRefused) logSlackRefusal('uninstall', { agentId: agent.id, appId: app.appId }, error);
      });
      await this.commit(agent, { type: 'consent_undone', at: now, owner });
    };
    if (grant.teamId !== teamId) { await undo(); return consentPage('other_workspace', names); }
    if (grant.appId !== app.appId || grant.installerUserId !== owner) { await undo(); return consentPage('another_person', names); }
    if (AGENT_APP_BOT_SCOPES.some((scope) => scope !== OLDER_APPS_LACK && !grant.scopes.includes(scope))) {
      await undo();
      return consentPage('missing_permissions', names);
    }
    // Two stores: a crash between them leaves the token stored and the app not live while the group answers, and the
    // Owner's next Allow, which this same path serves, repairs it.
    try {
      await writeAppSecrets(this.secrets, app.appId, agent.id, { ...stored.secrets, botToken: grant.botToken }, stored.revision);
    } catch (error) {
      // Another callback of this Allow stored its token first, and makes the one switch.
      if (error instanceof LostRevision) return consentPage('already_active', names);
      throw error;
    }
    const granted = await this.commit(agent, {
      type: 'consent_granted', at: now, botUserId: grant.botUserId, installedBy: grant.installerUserId,
    });
    if (granted.outcome !== 'applied') return consentPage('expired', names);
    await this.armSwitch(granted.agent);
    return Response.redirect(`https://slack.com/app_redirect?app=${encodeURIComponent(app.appId)}&team=${encodeURIComponent(teamId)}`, 303);
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
    const stored = await readOwnAppSecrets(this.secrets, appId, agent.id, 'end');
    if (stored.kind === 'own' && stored.secrets.botToken) {
      const { clientSecret, signingSecret } = stored.secrets;
      await writeAppSecrets(this.secrets, appId, agent.id, { clientSecret, signingSecret }, stored.revision);
    }
    const removed = await this.commit(agent, { type: 'app_removed', at: this.now() });
    if (removed.outcome !== 'applied') return 'ignored';
    await this.armSwitch(removed.agent);
    return 'ended';
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
    const settled = await this.advance(agent.id);
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
      rows.set(agent.id, agentAppHomeBlocks(homeRowFor(agent, app, now, privateGrants), this.names(agent), agent.id));
    }
    return rows;
  }

  /** Paste once per workspace; the Owner who pasted it is kept with it. */
  async pasteConfigurationToken(
    refreshToken: string,
    pastedBy: string,
  ): Promise<'saved' | 'not_refresh_token' | 'rejected' | 'other_workspace'> {
    return saveConfigurationToken(this.secrets, (await this.installation()).teamId, refreshToken, pastedBy);
  }

  async hasConfigurationToken(): Promise<boolean> {
    return hasConfigurationToken(this.secrets, (await this.installation()).teamId);
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

  async setMode(mode: AgentSlackAppsMode, changedBy: string): Promise<AgentSlackAppsSetting> {
    return writeAgentSlackAppsSetting(this.deps.stores.settings, { mode, changedBy, changedAt: this.now() });
  }

  /**
   * The move job, the one driver of an Agent's move to and from its own app:
   * the switch steps a live app still owes, or a removed app's restore. Each
   * step is recorded by compare-and-set before the next begins, so a rerun
   * from any point finishes it and repeats nothing that was recorded. Throws
   * when Slack may answer later, so the job retries; Slack's refusal of a
   * step is not retried. On the job's last try the Owner's message is given
   * up, and the switch still finishes.
   */
  async continueSwitch(agentId: string, options: { finalAttempt?: boolean } = {}): Promise<'done' | 'not_live'> {
    let agent = await this.deps.stores.config.getAgent(agentId);
    for (let guard = 0; guard < MAX_STEPS_PER_RUN; guard += 1) {
      const presence = agent.slackPresence;
      if (restorePending(presence)) {
        agent = await this.restoreGroup(agent, presence, options.finalAttempt ?? false);
        continue;
      }
      if (!agentAppIsLive(presence)) return 'not_live';
      const step = pendingSwitchStep(presence.app);
      if (!step) return 'done';
      const done = await this.switchSteps[step](agent, presence, options.finalAttempt ?? false);
      agent = await this.recordSwitch(agent, step, done);
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
          joined, throughChickpea, groupStillOn: answeringUserGroupId(presence) !== undefined,
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

  /** The live app's own bot, or none when its record is not this Agent's or holds no token. */
  private async switchBot(agent: CustomAgentConfig, presence: LiveAgentApp): Promise<AgentAppBotTransport | undefined> {
    const stored = await readOwnAppSecrets(this.secrets, presence.app.app.appId, agent.id, 'join');
    return stored.kind === 'own' && stored.secrets.botToken ? this.appBot(stored.secrets.botToken) : undefined;
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
   * A removed app's restore: turn the group it released back on, tell the
   * Owner, then hand the handle back to the group, with the removed record
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
    if (released) {
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
    const kind: AgentAppMessageKind = mentionable ? 'app_removed' : outcome === 'permission' ? 'app_removed_permission' : 'app_removed_unreachable';
    try {
      await this.message(kind, agent, presence.app.startedBy, `agent-app-removed:${agent.id}:${appId ?? ''}:${presence.app.at}:${kind}`);
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
   * Arm the job for an Agent whose move has steps left. A failure is logged,
   * not thrown: the state store's sweep arms it again, and so does the
   * Owner's Finish setting up.
   */
  private async armSwitch(agent: CustomAgentConfig): Promise<void> {
    const app = appRecordOf(agent.slackPresence);
    const appId = app && agentAppRecord(app)?.appId;
    try {
      const { teamId } = await this.installation();
      const job = agentAppMoveJob(agent.id, agent.slackPresence, teamId);
      if (job) await this.deps.armSwitch(job);
    } catch (error) {
      console.warn({
        event: 'chickpea.agent_app.switch_not_armed', agentId: agent.id, ...(appId ? { appId } : {}),
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  private async userGroupPermissionMissing(): Promise<boolean> {
    return await this.deps.userGroupPermissionMissing?.() ?? false;
  }

  private names(agent: CustomAgentConfig): AgentAppNames {
    return { name: agent.name, handle: agent.slackPresence?.normalizedHandle ?? agent.id };
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
      if (!run.wroteCreating) return 'wait';
      const { teamId } = await this.installation();
      const manifest = this.createManifest(run.agent);
      let created;
      try {
        created = await withConfigurationToken(this.secrets, teamId, (token) => this.slack.create(token, manifest));
      } catch (error) {
        if (error instanceof ConfigTokenNeeded) return { event: { type: 'config_token_needed', at: run.now } };
        if (error instanceof AmbiguousEffect) return { event: { type: 'create_ambiguous', at: run.now } };
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
      const { teamId, installationId } = await this.installation();
      const manifest = this.manifest(run.agent, this.deps.host.requestUrls(installationId, app.appId));
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
      return { event: { type: 'urls_set', at: run.now } };
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
      return { event: { type: 'icon_set', at: run.now, icon } };
    },

    post_allow_dm: async (run) => {
      if (run.app.state !== 'icon_set') return 'wait';
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
        }
        await deleteAppSecrets(this.secrets, app.appId, record.revision);
      }
      if (left) this.leftForOwner.set(run.agent.id, stillInstalled ? 'left_for_owner' : 'uninstalled_left_definition');
      const message = this.cancelling.has(run.agent.id) ? 'cancel_left' : stillInstalled ? 'archived_installed' : 'archived_left';
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

  /** Apply `event` to the Agent's record; a lost compare-and-set re-reads and re-applies when the state still allows it. */
  private async commit(
    agent: CustomAgentConfig,
    event: AgentAppEvent,
    attempt = 0,
  ): Promise<{ agent: CustomAgentConfig; outcome: 'applied' | 'deleted' | 'withdrawn' | 'refused' }> {
    const presence = agent.slackPresence;
    const app = appRecordOf(presence);
    if (!presence || !app) return { agent, outcome: 'refused' };
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
    return agentAppCreateManifest(this.manifestIntent(agent));
  }

  private manifest(agent: CustomAgentConfig, urls: SlackAppRequestUrls): SlackAppManifest {
    return buildSlackAppManifest({ kind: 'agent_app', urls, ...this.manifestIntent(agent) });
  }

  private manifestIntent(agent: CustomAgentConfig): AgentAppManifestIntent {
    return {
      appName: agent.name.slice(0, SLACK_APP_NAME_MAX_LENGTH),
      botDisplayName: this.names(agent).handle,
      description: (agent.description?.trim() || `${agent.name} Agent`).slice(0, SLACK_APP_DESCRIPTION_MAX_LENGTH),
      redirectUri: this.deps.host.redirectUri,
      scopes: AGENT_APP_BOT_SCOPES,
      events: AGENT_APP_BOT_EVENTS,
    };
  }

  /** The Agent's avatar when it is a square PNG Slack accepts; its 512 px default otherwise. */
  private async icon(agent: CustomAgentConfig, presence: AgentPresenceBase): Promise<{ png: Uint8Array<ArrayBuffer>; icon: AgentAppIcon }> {
    const asset = await readAgentAvatarAsset({
      settings: this.deps.stores.settings,
      agentId: agent.id,
      revision: presence.avatar.revision,
      avatar: presence.avatar,
    }).catch(() => undefined);
    if (asset?.contentType === 'image/png' && pngIsSlackIcon(asset.bytes)) {
      return { png: new Uint8Array(asset.bytes), icon: 'agent_avatar' };
    }
    return { png: new Uint8Array(await generatedAgentAvatarPng(presence.avatar.seed ?? agent.id)), icon: 'default_avatar' };
  }

  private async notifyAttention(agent: CustomAgentConfig): Promise<void> {
    const app = appRecordOf(agent.slackPresence);
    if (app?.state !== 'needs_attention') return;
    const { reason, startedBy, at } = app;
    await this.message(reason, agent, startedBy, `agent-app-attention:${agent.id}:${reason}:${at}`);
  }

  /** DM the Owner from the main bot. */
  private async message(
    kind: AgentAppMessageKind,
    agent: CustomAgentConfig,
    slackUserId: string,
    idempotencyKey: string,
  ): Promise<{ channelId: string; ts: string }> {
    const names = this.names(agent);
    const origin = kind === 'config_token_needed' || kind === 'permission_needed' || kind === 'app_removed_permission'
      ? await this.deps.publicOrigin?.()
      : undefined;
    const links: AgentAppLinks = {
      agentId: agent.id,
      allowUrl: this.deps.host.allowUrl(agent.id),
      ...(origin ? { tokenPageUrl: tokenPageUrl(origin, agent.id), adminUrl: adminUrl(origin) } : {}),
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

function tokenPageUrl(origin: string, agentId: string): string {
  return `${origin.replace(/\/+$/, '')}${tokenPagePath(agentId)}`;
}

function adminUrl(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${ADMIN_PATH}`;
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
            },
          }
        : { kind: 'active' };
    case 'awaiting_consent':
      return { kind: 'waiting' };
    case 'needs_attention':
      return { kind: 'attention' };
    default:
      return settling();
  }
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
