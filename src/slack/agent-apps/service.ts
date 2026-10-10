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
import type {
  AgentAppIcon,
  AgentAppLifecycle,
  AgentAppPresence,
  AgentSlackPresence,
  CustomAgentConfig,
  UserGroupPresence,
} from '../../config/types.ts';
import { generatedAgentAvatarPng, readAgentAvatarAsset } from '../agent-presence/avatar-assets.ts';
import {
  AGENT_APP_BOT_EVENTS,
  SLACK_APP_DESCRIPTION_MAX_LENGTH,
  SLACK_APP_NAME_MAX_LENGTH,
  SLACK_BOT_DISPLAY_NAME_MAX_LENGTH,
  buildSlackAppManifest,
  slackManifestFingerprint,
  type SlackAppManifest,
} from '../app-manifest.ts';
import { sha256Hex } from '../../security/digest.ts';
import { loadCredentialKeyring } from '../credential-keyring.ts';
import { hostedSlackLifecycleOutcome } from '../hosted-slack-app.ts';
import { SLACK_BOT_AUTHORIZE_URL } from '../install-oauth.ts';
import { AGENT_APP_BOT_SCOPES } from '../scopes.ts';
import type { CredentialKeyring } from '../secret-envelope.ts';
import { SlackTransportError, type SlackTransport } from '../transport/types.ts';
import type { AgentSlackAppsHost } from './host.ts';
import {
  type AgentAppEvent,
  type AgentAppStep,
  CREATE_SETTLE_MS,
  agentAppIsLive,
  agentAppRecord,
  createIsStale,
  initialAgentApp,
  isRefusal,
  nextStep,
  normalizeAgentAppPresence,
  transition,
} from './lifecycle.ts';
import {
  type AgentAppHomeRow,
  type AgentAppLinks,
  type AgentAppMessageKind,
  type AgentAppNames,
  STALLED_AFTER_MS,
  agentAppHomeBlocks,
  agentAppMessage,
  archiveRefusedCopy,
  consentPage,
  tokenPagePath,
} from './pages.ts';
import {
  AgentAppSecretsUnreadable,
  ConfigTokenNeeded,
  LostRevision,
  type SecretDeps,
  deleteAppSecrets,
  deleteConfigurationToken,
  hasConfigurationToken,
  readAppSecrets,
  saveConfigurationToken,
  withConfigurationToken,
  writeAppSecrets,
} from './secrets.ts';
import {
  type AgentAppSlackApi,
  AmbiguousEffect,
  SlackRefused,
  SlackUnavailable,
  createAgentAppSlackApi,
} from './slack-api.ts';

export type AgentAppTransport = Pick<
  SlackTransport,
  'disableUserGroup' | 'enableUserGroup' | 'openDirectConversation' | 'postMessage'
>;

export interface AgentSlackAppsDeps {
  env: PlatformEnv | undefined;
  stores: {
    config: Pick<ConfigStore, 'getAgent' | 'listAgents' | 'updateAgent' | 'listWorkspaceInstallations'>;
    settings: SettingsStore & EncryptedCredentialStore;
  };
  host: AgentSlackAppsHost;
  /** The workspace's main bot, for the Owner's DMs and the handle's user group. */
  transport: AgentAppTransport;
  slack?: AgentAppSlackApi;
  keyring?: CredentialKeyring;
  /** Where Chickpea Admin lives, for the "Paste a new token" button. */
  publicOrigin?: () => Promise<string | undefined>;
  now?: () => number;
}

export type AgentAppStartOutcome =
  | { kind: 'started'; agent: CustomAgentConfig }
  | { kind: 'already_started'; agent: CustomAgentConfig }
  | { kind: 'token_needed' }
  | { kind: 'not_eligible' };

interface Run {
  agent: CustomAgentConfig;
  presence: AgentAppPresence;
  app: AgentAppLifecycle;
  now: number;
  /** Only the run that wrote `creating` may create; any other run waits for it to settle. */
  wroteCreating: boolean;
}

type Outcome = { event: AgentAppEvent; after?: () => Promise<void> } | 'wait';
type Performer = (run: Run) => Promise<Outcome>;

const MAX_STEPS_PER_RUN = 12;
/** How long an opened Allow link stays valid. */
export const CONSENT_TTL_MS = 15 * 60_000;
const STATE_SHAPE = /^([A-Za-z0-9_-]{1,128})\.([a-f0-9-]{36})$/;
const MAX_COMMIT_RETRIES = 3;
const ICON_MIN_PX = 512;
const ICON_MAX_PX = 2_000;
const GROUP_ALREADY_RELEASED = new Set(['already_disabled', 'no_such_subteam']);

export class AgentSlackApps {
  private readonly now: () => number;
  private readonly slack: AgentAppSlackApi;
  private readonly secrets: SecretDeps;
  private facts: Promise<{ teamId: string; installationId: string }> | undefined;
  /** Agents whose app Slack would not delete (refused, or no configuration token): the definition stays for the Owner. */
  private readonly leftDefinition = new Set<string>();

  constructor(private readonly deps: AgentSlackAppsDeps) {
    this.now = deps.now ?? Date.now;
    this.slack = deps.slack ?? createAgentAppSlackApi();
    this.secrets = {
      credentials: deps.stores.settings,
      keyring: deps.keyring ?? loadCredentialKeyring(deps.env),
      slack: this.slack,
      now: this.now,
    };
  }

  /** Compare-and-set the user group away and run the sequence; the loser of two starts sees the winner's record. */
  async start(agentId: string, ownerSlackUserId: string): Promise<AgentAppStartOutcome> {
    const { config } = this.deps.stores;
    const agent = await config.getAgent(agentId);
    const presence = agent.slackPresence;
    if (agent.kind !== 'user' || agent.lifecycle === 'archived' || agent.lifecycle === 'draft' || !presence) {
      return { kind: 'not_eligible' };
    }
    if (presence.kind === 'agent_app') return { kind: 'already_started', agent };
    const { teamId } = await this.installation();
    if (!(await hasConfigurationToken(this.secrets, teamId))) return { kind: 'token_needed' };
    const started: AgentAppPresence = normalizeAgentAppPresence({
      kind: 'agent_app',
      requestedHandle: presence.requestedHandle,
      normalizedHandle: presence.normalizedHandle,
      avatar: presence.avatar,
      desiredState: 'active',
      health: 'pending',
      app: initialAgentApp(ownerSlackUserId, this.now()),
      ...(presence.userGroupId ? { released: { userGroupId: presence.userGroupId } } : {}),
    });
    try {
      await config.updateAgent(agentId, { slackPresence: started }, agent.revision);
    } catch (error) {
      if (!(error instanceof AgentRevisionConflictError)) throw error;
      const latest = await config.getAgent(agentId);
      if (latest.slackPresence?.kind === 'agent_app') return { kind: 'already_started', agent: latest };
      return this.start(agentId, ownerSlackUserId);
    }
    return { kind: 'started', agent: await this.advance(agentId) };
  }

  /** Perform the next step, commit by compare-and-set, repeat until the record waits. */
  async advance(agentId: string, options: { wroteCreating?: boolean } = {}): Promise<CustomAgentConfig> {
    const { config } = this.deps.stores;
    let agent = await config.getAgent(agentId);
    let wroteCreating = options.wroteCreating ?? false;
    for (let guard = 0; guard < MAX_STEPS_PER_RUN; guard += 1) {
      const presence = agent.slackPresence;
      if (presence?.kind !== 'agent_app') return agent;
      const now = this.now();
      if (createIsStale(presence.app, now)) {
        agent = (await this.commit(agent, { type: 'create_ambiguous', at: now })).agent;
        await this.notifyAttention(agent);
        return agent;
      }
      const step = nextStep(presence.app, now);
      if (!step) return agent;
      const outcome = await this.performers[step]({ agent, presence, app: presence.app, now, wroteCreating });
      if (outcome === 'wait') return agent;
      const committed = await this.commit(agent, outcome.event);
      agent = committed.agent;
      if (committed.outcome === 'refused') continue;
      wroteCreating = outcome.event.type === 'handle_released' || outcome.event.type === 'recreate';
      if (outcome.after) await outcome.after();
      if (committed.outcome === 'deleted') return agent;
      if (agent.slackPresence?.kind === 'agent_app' && agent.slackPresence.app.state === 'needs_attention') {
        await this.notifyAttention(agent);
        return agent;
      }
    }
    return agent;
  }

  /** An Owner chose Try again: resume where the record says, then advance. */
  async retry(agentId: string, ownerSlackUserId: string): Promise<CustomAgentConfig> {
    const { config } = this.deps.stores;
    const agent = await config.getAgent(agentId);
    const presence = agent.slackPresence;
    if (presence?.kind !== 'agent_app') return agent;
    if (presence.app.state !== 'needs_attention') return this.advance(agentId);
    const manifestFingerprint = slackManifestFingerprint(this.manifest(agent, undefined));
    const resumed = await this.commit(agent, {
      type: 'try_again', at: this.now(), startedBy: ownerSlackUserId, manifestFingerprint,
    });
    if (resumed.outcome === 'refused') return resumed.agent;
    return this.advance(agentId, { wroteCreating: presence.app.resume === 'creating' });
  }

  /** "Allow <Agent> in Slack": a fresh consent nonce, then Slack's authorize page. */
  async allow(agentId: string, ownerSlackUserId: string): Promise<Response> {
    const { config } = this.deps.stores;
    let agent = await config.getAgent(agentId);
    const names = this.names(agent);
    let presence = agent.slackPresence;
    if (presence?.kind !== 'agent_app') return consentPage('expired', names);
    if (presence.app.state === 'active') return consentPage('already_active', names);
    if (presence.app.state === 'needs_attention' && presence.app.reason === 'app_removed') {
      agent = await this.retry(agentId, ownerSlackUserId);
      presence = agent.slackPresence;
    }
    if (presence?.kind !== 'agent_app' || presence.app.state !== 'awaiting_consent') return consentPage('expired', names);
    const nonce = crypto.randomUUID();
    const now = this.now();
    const opened = await this.commit(agent, {
      type: 'consent_opened', at: now, nonceDigest: await sha256Hex(nonce), owner: ownerSlackUserId, expiresAt: now + CONSENT_TTL_MS,
    });
    if (opened.outcome !== 'applied') return consentPage('expired', names);
    const url = new URL(SLACK_BOT_AUTHORIZE_URL);
    url.searchParams.set('client_id', presence.app.app.clientId);
    url.searchParams.set('scope', AGENT_APP_BOT_SCOPES.join(','));
    url.searchParams.set('redirect_uri', this.deps.host.redirectUri);
    url.searchParams.set('state', `${agent.id}.${nonce}`);
    return Response.redirect(url.toString(), 303);
  }

  /** Slack's callback, forwarded untouched: exchange the code with the app's own credentials and validate the grant. */
  async completeConsent(query: URLSearchParams, ownerSlackUserId: string): Promise<Response> {
    const { config } = this.deps.stores;
    const state = STATE_SHAPE.exec(query.get('state') ?? '');
    if (!state) return consentPage('expired', { name: 'The Agent', handle: 'agent' });
    const agentId = state[1]!;
    const nonce = state[2]!;
    let agent;
    try {
      agent = await config.getAgent(agentId);
    } catch (error) {
      if (!(error instanceof UnknownAgentError)) throw error;
      return consentPage('expired', { name: 'The Agent', handle: 'agent' });
    }
    const names = this.names(agent);
    const presence = agent.slackPresence;
    if (presence?.kind !== 'agent_app') return consentPage('expired', names);
    if (presence.app.state === 'active') return consentPage('already_active', names);
    if (presence.app.state !== 'awaiting_consent' || !presence.app.consent) return consentPage('expired', names);
    const { consent, app } = presence.app;
    const now = this.now();
    if (consent.expiresAt <= now || consent.nonceDigest !== await sha256Hex(nonce)) return consentPage('expired', names);
    if (consent.owner !== ownerSlackUserId) return consentPage('another_person', names);
    if (query.get('error') || !query.get('code')) {
      await this.commit(agent, { type: 'consent_undone', at: now });
      return consentPage('cancelled', names);
    }
    const stored = await readAppSecrets(this.secrets, app.appId);
    if (!stored) return consentPage('expired', names);
    let grant;
    try {
      grant = await this.slack.exchange({
        clientId: app.clientId,
        clientSecret: stored.secrets.clientSecret,
        code: query.get('code')!,
        redirectUri: this.deps.host.redirectUri,
      });
    } catch (error) {
      if (error instanceof SlackRefused) return consentPage('expired', names);
      if (error instanceof SlackUnavailable) return consentPage('slack_down', names);
      throw error;
    }
    const { teamId } = await this.installation();
    const undo = async () => {
      await this.slack.uninstall({ clientId: app.clientId, clientSecret: stored.secrets.clientSecret, botToken: grant.botToken }).catch(() => undefined);
      await this.commit(agent, { type: 'consent_undone', at: now });
    };
    if (grant.teamId !== teamId) { await undo(); return consentPage('other_workspace', names); }
    if (grant.appId !== app.appId || grant.installerUserId !== consent.owner) { await undo(); return consentPage('another_person', names); }
    if (AGENT_APP_BOT_SCOPES.some((scope) => !grant.scopes.includes(scope))) { await undo(); return consentPage('missing_permissions', names); }
    await writeAppSecrets(this.secrets, app.appId, agent.id, { ...stored.secrets, botToken: grant.botToken }, stored.revision);
    const granted = await this.commit(agent, {
      type: 'consent_granted', at: now, botUserId: grant.botUserId, installedBy: grant.installerUserId,
    });
    if (granted.outcome !== 'applied') return consentPage('expired', names);
    await this.message('ready', granted.agent, consent.owner, `agent-app-ready:${agent.id}:${now}`);
    return Response.redirect(`https://slack.com/app_redirect?app=${encodeURIComponent(app.appId)}&team=${encodeURIComponent(teamId)}`, 303);
  }

  /** A verified app_uninstalled or tokens_revoked of one Agent app: the bot token goes, the Owner is told. */
  async end(appId: string, payload: Record<string, unknown>): Promise<'ended' | 'ignored'> {
    const { config } = this.deps.stores;
    const agent = (await config.listAgents()).find((candidate) =>
      agentAppIsLive(candidate.slackPresence) && candidate.slackPresence.app.app.appId === appId
    );
    const presence = agent?.slackPresence;
    if (!agent || !agentAppIsLive(presence)) return 'ignored';
    const outcome = hostedSlackLifecycleOutcome(payload, {
      installedAt: presence.app.installedAt,
      botUserId: presence.app.botUserId,
    });
    if (outcome !== 'end') return 'ignored';
    const stored = await readAppSecrets(this.secrets, appId).catch(unreadableAsNone);
    if (stored?.secrets.botToken) {
      const { clientSecret, signingSecret } = stored.secrets;
      await writeAppSecrets(this.secrets, appId, agent.id, { clientSecret, signingSecret }, stored.revision);
    }
    const removed = await this.commit(agent, { type: 'app_removed', at: this.now() });
    if (removed.outcome !== 'applied') return 'ignored';
    await this.notifyAttention(removed.agent);
    return 'ended';
  }

  /**
   * Archive: uninstall and delete the app, hand the handle back to its user
   * group. Throws AgentPresenceError when Slack refuses the uninstall, so the
   * Agent is not archived; a create still settling refuses the same way.
   */
  async retire(agent: CustomAgentConfig): Promise<{ agent: CustomAgentConfig; outcome: 'removed' | 'uninstalled_left_definition' }> {
    const presence = agent.slackPresence;
    if (presence?.kind !== 'agent_app') return { agent, outcome: 'removed' };
    const record = agentAppRecord(presence.app);
    const stored = record ? await readAppSecrets(this.secrets, record.appId).catch(unreadableAsNone) : undefined;
    const archived = await this.commit(agent, { type: 'archive', at: this.now(), hasBotToken: Boolean(stored?.secrets.botToken) });
    if (archived.outcome === 'refused') throw new AgentPresenceError('slack_operation_failed', archiveRefusedCopy({ name: agent.name }));
    if (archived.outcome === 'deleted') {
      if (presence.app.state === 'needs_attention' && presence.app.reason === 'ambiguous_create') {
        await this.message('ambiguous_create', agent, presence.app.startedBy, `agent-app-archived-ambiguous:${agent.id}:${this.now()}`);
      }
      return { agent: archived.agent, outcome: 'removed' };
    }
    const settled = await this.advance(agent.id);
    const after = settled.slackPresence;
    if (after?.kind !== 'agent_app') {
      return { agent: settled, outcome: this.leftDefinition.delete(agent.id) ? 'uninstalled_left_definition' : 'removed' };
    }
    throw new AgentPresenceError('slack_operation_failed', archiveRefusedCopy({ name: agent.name }));
  }

  /** The Owner's App Home line for each Agent, keyed by Agent ID; empty for anyone but an Owner. */
  async homeRows(
    agents: readonly CustomAgentConfig[],
    viewer: { role?: string | undefined },
  ): Promise<ReadonlyMap<string, readonly object[]>> {
    const rows = new Map<string, readonly object[]>();
    if (viewer.role !== 'owner') return rows;
    const origin = await this.hasConfigurationToken() ? undefined : await this.deps.publicOrigin?.();
    const now = this.now();
    for (const agent of agents) {
      if (agent.kind === 'user') rows.set(agent.id, agentAppHomeBlocks(homeRowFor(agent, now, origin), this.names(agent), agent.id));
    }
    return rows;
  }

  /** The token page: paste once per workspace. */
  async pasteConfigurationToken(refreshToken: string): Promise<'saved' | 'not_refresh_token' | 'rejected' | 'other_workspace'> {
    return saveConfigurationToken(this.secrets, (await this.installation()).teamId, refreshToken);
  }

  async hasConfigurationToken(): Promise<boolean> {
    return hasConfigurationToken(this.secrets, (await this.installation()).teamId);
  }

  /** Deletes Chickpea's stored pair and nothing in Slack. */
  async removeConfigurationToken(): Promise<'deleted' | 'none'> {
    return deleteConfigurationToken(this.secrets, (await this.installation()).teamId);
  }

  private names(agent: CustomAgentConfig): AgentAppNames {
    return { name: agent.name, handle: agent.slackPresence?.normalizedHandle ?? agent.id };
  }

  private readonly performers: Record<AgentAppStep, Performer> = {
    release_handle: async (run) => {
      const manifestFingerprint = slackManifestFingerprint(this.manifest(run.agent, undefined));
      const userGroupId = run.presence.released?.userGroupId;
      if (userGroupId) {
        try {
          await this.deps.transport.disableUserGroup(userGroupId);
        } catch (error) {
          if (!(error instanceof SlackTransportError)) throw error;
          if (!GROUP_ALREADY_RELEASED.has(error.code)) return { event: { type: 'handle_release_refused', at: run.now } };
        }
      }
      return { event: { type: 'handle_released', at: run.now, manifestFingerprint } };
    },

    create: async (run) => {
      if (!run.wroteCreating) return 'wait';
      const { teamId } = await this.installation();
      const manifest = this.manifest(run.agent, undefined);
      let created;
      try {
        created = await withConfigurationToken(this.secrets, teamId, (token) => this.slack.create(token, manifest));
      } catch (error) {
        if (error instanceof ConfigTokenNeeded) return { event: { type: 'config_token_needed', at: run.now } };
        if (error instanceof AmbiguousEffect) return { event: { type: 'create_ambiguous', at: run.now } };
        if (error instanceof SlackRefused) {
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
      const app = agentAppRecord(run.app)!;
      const { teamId, installationId } = await this.installation();
      const stored = await readAppSecrets(this.secrets, app.appId);
      if (!stored) {
        // A crash between the `created` commit and the realm write left an app without secrets.
        if (run.now - run.app.at < CREATE_SETTLE_MS) return 'wait';
        try {
          await withConfigurationToken(this.secrets, teamId, (token) => this.slack.delete(token, app.appId));
        } catch (error) {
          if (error instanceof ConfigTokenNeeded) return { event: { type: 'config_token_needed', at: run.now } };
          if (error instanceof SlackRefused || error instanceof SlackUnavailable) return 'wait';
          throw error;
        }
        const manifestFingerprint = slackManifestFingerprint(this.manifest(run.agent, undefined));
        return { event: { type: 'recreate', at: run.now, manifestFingerprint } };
      }
      const manifest = this.manifest(run.agent, this.deps.host.requestUrls(installationId, app.appId));
      try {
        await withConfigurationToken(this.secrets, teamId, (token) => this.slack.update(token, app.appId, manifest));
      } catch (error) {
        if (error instanceof ConfigTokenNeeded) return { event: { type: 'config_token_needed', at: run.now } };
        if (error instanceof SlackRefused) return { event: { type: 'urls_refused', at: run.now } };
        if (error instanceof SlackUnavailable) return 'wait';
        throw error;
      }
      return { event: { type: 'urls_set', at: run.now } };
    },

    set_icon: async (run) => {
      const app = agentAppRecord(run.app)!;
      const { teamId } = await this.installation();
      const { png, icon } = await this.icon(run.agent, run.presence);
      let outcome: 'set' | 'refused' | 'failed';
      try {
        outcome = await withConfigurationToken(this.secrets, teamId, (token) => this.slack.setIcon(token, app.appId, png));
      } catch (error) {
        if (!(error instanceof ConfigTokenNeeded || error instanceof SlackUnavailable)) throw error;
        outcome = 'failed';
      }
      return { event: { type: 'icon_set', at: run.now, icon: outcome === 'set' ? icon : 'not_set' } };
    },

    post_allow_dm: async (run) => {
      if (run.app.state !== 'icon_set') return 'wait';
      const posted = await this.message('allow', run.agent, run.app.startedBy, `agent-app-allow:${run.agent.id}:${run.app.at}`);
      if (!posted) return 'wait';
      return { event: { type: 'allow_dm_posted', at: run.now, channelId: posted.channelId, ts: posted.ts } };
    },

    uninstall: async (run) => {
      const app = agentAppRecord(run.app)!;
      const stored = await readAppSecrets(this.secrets, app.appId);
      if (!stored?.secrets.botToken) return { event: { type: 'uninstalled', at: run.now } };
      try {
        await this.slack.uninstall({
          clientId: app.clientId,
          clientSecret: stored.secrets.clientSecret,
          botToken: stored.secrets.botToken,
        });
      } catch (error) {
        if (error instanceof SlackRefused || error instanceof SlackUnavailable) {
          return { event: { type: 'uninstall_refused', at: run.now } };
        }
        throw error;
      }
      return { event: { type: 'uninstalled', at: run.now } };
    },

    delete: async (run) => {
      if (run.app.state !== 'uninstalling') return 'wait';
      const { app, startedBy } = run.app;
      const { teamId } = await this.installation();
      let left = false;
      try {
        await withConfigurationToken(this.secrets, teamId, (token) => this.slack.delete(token, app.appId));
      } catch (error) {
        if (error instanceof SlackUnavailable) return 'wait';
        if (error instanceof SlackRefused && error.code === 'ratelimited') return 'wait';
        if (!(error instanceof ConfigTokenNeeded || error instanceof SlackRefused)) throw error;
        left = true;
      }
      const stored = await readAppSecrets(this.secrets, app.appId).catch(unreadableAsNone);
      if (stored) await deleteAppSecrets(this.secrets, app.appId, stored.revision);
      if (left) this.leftDefinition.add(run.agent.id);
      return {
        event: { type: 'deleted', at: run.now },
        ...(left
          ? { after: async () => { await this.message('archived_left', run.agent, startedBy, `agent-app-left:${run.agent.id}:${app.appId}`); } }
          : {}),
      };
    },
  };

  /** Apply `event` to the Agent's record; a lost compare-and-set re-reads and re-applies when the state still allows it. */
  private async commit(
    agent: CustomAgentConfig,
    event: AgentAppEvent,
    attempt = 0,
  ): Promise<{ agent: CustomAgentConfig; outcome: 'applied' | 'deleted' | 'refused' }> {
    const presence = agent.slackPresence;
    if (presence?.kind !== 'agent_app') return { agent, outcome: 'refused' };
    const next = transition(presence.app, event);
    if (isRefusal(next)) return { agent, outcome: 'refused' };
    const slackPresence: AgentSlackPresence = next.state === 'deleted'
      ? releasedPresence(presence)
      : normalizeAgentAppPresence({ ...presence, app: next });
    try {
      const updated = await this.deps.stores.config.updateAgent(agent.id, { slackPresence }, agent.revision);
      return { agent: updated, outcome: next.state === 'deleted' ? 'deleted' : 'applied' };
    } catch (error) {
      if (!(error instanceof AgentRevisionConflictError) || attempt >= MAX_COMMIT_RETRIES) throw error;
      return this.commit(await this.deps.stores.config.getAgent(agent.id), event, attempt + 1);
    }
  }

  private manifest(agent: CustomAgentConfig, urls: { events: string; interactions: string } | undefined): SlackAppManifest {
    return buildSlackAppManifest({
      kind: 'agent_app',
      appName: agent.name.slice(0, SLACK_APP_NAME_MAX_LENGTH),
      botDisplayName: agent.name.slice(0, SLACK_BOT_DISPLAY_NAME_MAX_LENGTH),
      description: (agent.description?.trim() || `${agent.name} Agent`).slice(0, SLACK_APP_DESCRIPTION_MAX_LENGTH),
      redirectUri: this.deps.host.redirectUri,
      ...(urls ? { urls } : {}),
      scopes: AGENT_APP_BOT_SCOPES,
      events: AGENT_APP_BOT_EVENTS,
    });
  }

  /** The Agent's avatar when it is a square PNG Slack accepts; its 512 px default otherwise. */
  private async icon(agent: CustomAgentConfig, presence: AgentAppPresence): Promise<{ png: Uint8Array<ArrayBuffer>; icon: AgentAppIcon }> {
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
    const presence = agent.slackPresence;
    if (presence?.kind !== 'agent_app' || presence.app.state !== 'needs_attention') return;
    const { reason, startedBy, at } = presence.app;
    await this.message(reason, agent, startedBy, `agent-app-attention:${agent.id}:${reason}:${at}`);
  }

  /** DM the Owner from the main bot; a message kind without copy posts nothing. */
  private async message(
    kind: AgentAppMessageKind,
    agent: CustomAgentConfig,
    slackUserId: string,
    idempotencyKey: string,
  ): Promise<{ channelId: string; ts: string } | undefined> {
    const names = this.names(agent);
    const origin = kind === 'config_token_needed' ? await this.deps.publicOrigin?.() : undefined;
    const links: AgentAppLinks = {
      agentId: agent.id,
      allowUrl: this.deps.host.allowUrl(agent.id),
      ...(origin ? { tokenPageUrl: tokenPageUrl(origin, agent.id) } : {}),
    };
    const message = agentAppMessage(kind, names, links);
    if (!message) return undefined;
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

/** What the Owner's App Home says about an Agent's app; the offer links to the token page when `origin` is given. */
function homeRowFor(agent: CustomAgentConfig, now: number, origin: string | undefined): AgentAppHomeRow {
  const presence = agent.slackPresence;
  if (presence?.kind !== 'agent_app') {
    return { kind: 'offer', tokenPageUrl: origin ? tokenPageUrl(origin, agent.id) : undefined };
  }
  switch (presence.app.state) {
    case 'active':
      return { kind: 'active' };
    case 'awaiting_consent':
      return { kind: 'waiting' };
    case 'needs_attention':
      return { kind: 'attention' };
    default:
      return now - presence.app.at >= STALLED_AFTER_MS ? { kind: 'stalled' } : { kind: 'setting_up' };
  }
}

/** An envelope that cannot be opened reads as no secrets; a store that cannot be reached still throws. */
function unreadableAsNone(error: unknown): undefined {
  if (error instanceof AgentAppSecretsUnreadable) return undefined;
  throw error;
}

/** After the app is gone the handle returns to its user group, disabled; an Agent that never had one is unpublished. */
function releasedPresence(presence: AgentAppPresence): UserGroupPresence {
  const userGroupId = presence.released?.userGroupId;
  return {
    requestedHandle: presence.requestedHandle,
    normalizedHandle: presence.normalizedHandle,
    avatar: presence.avatar,
    desiredState: 'disabled',
    health: userGroupId ? 'healthy' : 'unpublished',
    ...(userGroupId ? { userGroupId } : {}),
  };
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
