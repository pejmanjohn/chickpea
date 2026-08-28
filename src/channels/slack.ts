// flue-blueprint: channel/slack@1
import {
  createSlackChannel,
  type SlackChannel,
  type SlackChannelOptions,
} from '@flue/slack';
import { createChannelRouter } from '@flue/runtime';

import { resolveBetterAuthEnvironment } from '../auth/better-auth-environment.ts';
import {
  applyGatewaySlackUserChange,
  applySlackUserChange,
} from '../auth/slack-membership-events.ts';
import {
  provisionSlackInteractionMember,
  slackInteractionMayUseGrantedChannel,
} from '../auth/slack-admission.ts';
import {
  effectiveSlackConfigFromAssignment,
  resolveEffectiveSlackConfig,
} from '../config/effective-config.ts';
import { resolveModelCredentialAttribution } from '../config/model-credential-refs.ts';
import { resolveModelPolicyForAssignment } from '../config/model-policy.ts';
import { liveChannelConfigurationEnabled } from '../config/live-channel-config.ts';
import {
  ModelResolutionError,
} from '../config/errors.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import type { AssignmentSurface } from '../config/resolver.ts';
import {
  getOrCreateSnapshot,
  getOrReplaceSnapshotForRoute,
} from '../config/snapshot-store.ts';
import {
  getSlackCredentialDependencies,
  resolveStores,
  type AppStores,
  type PlatformEnv,
} from '../config/state-backend.ts';
import {
  tagStateStub,
  type StateRpcResult,
  type TurnJob,
} from '../config/state-rpc.ts';
import {
  WORKSPACE_SLACK_INSTALLATION_ID,
  type ResolvedAssignment,
} from '../config/types.ts';
import {
  resolveSlackBehaviorSettings,
} from '../slack/behavior-settings.ts';
import {
  parseAgentUserGroupMentions,
  resolveAgentRoute,
  type AgentRoutingActor,
  type AgentRoutingResult,
} from '../slack/agent-routing.ts';
import {
  listPrivatelyUsableAgents,
  resolvePrivateAgentAccess,
  type PrivateAgentActor,
} from '../slack/agent-access.ts';
import {
  agentAppHomeStarterMessage,
  agentDirectoryAppHome,
  parseAgentAppHomeSelection,
  type AgentAppHomeSelection,
} from '../slack/app-home.ts';
import {
  classifySlackInteraction,
  resolveImmediateSlackInteractionIntent,
} from '../slack/interaction-intent.ts';
import {
  InteractionUsageRecorder,
  usageRuntimeRecordingEnabled,
} from '../usage/runtime-recorder.ts';
import { parseMemoryCommand } from '../memory/commands.ts';
import { parseRoutineCommand } from '../routines/commands.ts';
import { isRoutineSlackTurn } from '../routines/slack-context.ts';
import {
  resolveSlackCredentials,
  resolveSlackPublicUrl,
  slackAuthTest,
} from '../slack/credentials.ts';
import {
  resolveSlackInstallationCredentials,
  type ResolvedSlackInstallationCredentials,
} from '../slack/installation-credentials.ts';
import { recordPendingSlackChallenge } from '../slack/installation-handshake.ts';
import { SlackInstallOAuthService } from '../slack/install-oauth.ts';
import {
  prepareSlackShadowAdmission,
  resolveSlackAdmissionTruth,
  slackAdmissionTruthReader,
  type SlackAdmissionTruth,
} from '../slack/work-admission.ts';
import {
  renderChannelOnboarding,
} from '../slack/message-format.ts';
import {
  createSlackWebClient,
  sanitizeError,
} from '../slack/run-turn.ts';
import { slackAgentThreadKey, slackThreadKey } from '../slack/thread-key.ts';
import { normalizeSlackTurn } from '../slack/turn-normalization.ts';
import {
  wakeNodeTurnRelay,
} from '../slack/node-turn-relay.ts';
import { slackSemanticActivityStatusEnabled } from '../slack/semantic-status-flag.ts';
import {
  hydrateSlackContextViaWebClient,
  hydrateSlackPublicHandoffFallback,
} from '../slack/web-client-context.ts';
import {
  reconcileSlackPublicContextMutation,
  recordAcceptedSlackHumanMessage,
  recordDeliveredSlackAgentMessage,
} from '../slack/public-context.ts';
import {
  selectSlackPresentationOwner,
  slackSessionGenerationFromTimestamp,
} from '../slack/claim-store.ts';
import { createDirectSlackTransport } from '../slack/transport/direct.ts';
import type { SlackInboundEnvelope, SlackTransport } from '../slack/transport/types.ts';
import { createGatewaySlackTransport } from '../slack/transport/gateway.ts';
import { GatewayDeploymentClient } from '../slack/gateway/client.ts';
import { createGatewayDeploymentClient } from '../slack/gateway/runtime.ts';
import { createGatewaySlackWebClient } from '../slack/gateway/web-client.ts';
import { selectSlackExecutionAuthority } from '../work/authority.ts';
import { opaqueId } from '../work/admission.ts';
import { EGRESS_SETTING_KEY, parseEgressPolicy } from '../config/egress.ts';
import {
  isSlackMemberJoinedChannelEvent,
  type NormalizedSlackTurn,
  type SlackEventFixture,
} from '../slack/types.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import { emitManagementMetric } from '../management/telemetry.ts';
import { agentAvatarUrlForPresentation } from '../slack/agent-presence/avatar-assets.ts';
import { initialActivityStatus } from '../activity/status.ts';

const MAX_SLACK_INGRESS_BYTES = 1_048_576;

/**
 * Run `task` past the events ack. On Cloudflare the response completing would
 * otherwise cancel in-flight work, so register it on the platform's
 * ExecutionContext (`waitUntil` keeps the isolate alive — hard platform cap:
 * ~30s after the response). On node Hono's `executionCtx` getter THROWS
 * (there is no ExecutionContext); a floating promise already outlives the
 * response there, so the catch arm is the whole node implementation.
 * Callers attach their own `.catch` before detaching — `task` must never be a
 * rejection-unhandled promise.
 *
 * Typed structurally (not hono's `Context`): `c` arrives from @flue/slack,
 * which bundles its own hono whose Context type is not assignable to the
 * app's — and `executionCtx` is the only surface this helper touches.
 */
function detach(
  c: { executionCtx: { waitUntil(promise: Promise<unknown>): void } },
  task: Promise<unknown>,
): void {
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // node: no ExecutionContext — the promise simply runs detached.
  }
}

// Bot user id resolution: prefer the value from the one active encrypted
// credential revision; otherwise resolve once via auth.test() and cache it by
// that revision's bot token. Environment values are not credential sources.
// On auth.test failure leave it undefined so message-family events fail closed
// in normalization.
let probedBotIdentity:
  | { botToken: string | undefined; botUserId: string | undefined }
  | undefined;

const MAX_CANDIDATE_CLASSIFIERS_PER_CHANNEL = 2;
const candidateClassifierCounts = new Map<string, number>();

function acquireCandidateClassifier(key: string): (() => void) | undefined {
  const active = candidateClassifierCounts.get(key) ?? 0;
  if (active >= MAX_CANDIDATE_CLASSIFIERS_PER_CHANNEL) return undefined;
  candidateClassifierCounts.set(key, active + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (candidateClassifierCounts.get(key) ?? 1) - 1;
    if (remaining > 0) candidateClassifierCounts.set(key, remaining);
    else candidateClassifierCounts.delete(key);
  };
}

export function invalidateSlackBotUserIdCache(): void {
  probedBotIdentity = undefined;
}

export async function resolveBotUserId(
  env: PlatformEnv | undefined,
): Promise<string | undefined> {
  const { botToken, botUserId } = await resolveSlackCredentials(env);
  if (botUserId !== undefined) {
    return botUserId === '' ? undefined : botUserId;
  }
  if (probedBotIdentity && probedBotIdentity.botToken === botToken) {
    return probedBotIdentity.botUserId;
  }
  if (!botToken) {
    return undefined;
  }
  try {
    const auth = await slackAuthTest(botToken);
    if (!auth.ok) {
      return undefined;
    }
    const probedBotUserId = auth.botUserId;
    // Latch only on a successful call: a definitive answer (including "no
    // user_id") is cached, but a transient auth.test failure must not pin
    // the probe result to undefined for the process lifetime — the next
    // event retries.
    probedBotIdentity = { botToken, botUserId: probedBotUserId };
    return probedBotUserId;
  } catch {
    return undefined;
  }
}

/**
 * The real @flue/slack channel is (re)built per RESOLVED signing secret:
 * `createSlackChannel` captures the secret at construction, but on a first-run
 * install the secret does not exist until the /admin wizard stores it — so
 * construction moves from module load (where a missing secret used to crash
 * the whole app) into the events gate below, keyed so a rotated/stored secret
 * replaces the instance instead of being ignored.
 */
const MAX_VERIFIED_SLACK_CHANNELS = 4;
interface VerifiedSlackChannel {
  credentialRevision: string | null;
  signingSecret: string;
  channel: SlackChannel;
}

const verifiedChannels = new Map<string, VerifiedSlackChannel>();

function channelForInstallation(
  signingSecret: string,
  credentialRevision: string | null,
): SlackChannel {
  const key = credentialRevision ?? 'current';
  const cached = verifiedChannels.get(key);
  if (cached?.signingSecret === signingSecret) return cached.channel;
  const entry: VerifiedSlackChannel = {
    credentialRevision,
    signingSecret,
    channel: createSlackChannel({
      signingSecret,
      bodyLimit: MAX_SLACK_INGRESS_BYTES,
      events: handleDirectSlackEvents(credentialRevision),
      interactions: handleDirectSlackInteractions(),
    }),
  };
  verifiedChannels.set(key, entry);
  while (verifiedChannels.size > MAX_VERIFIED_SLACK_CHANNELS) {
    const oldest = verifiedChannels.keys().next().value as string | undefined;
    if (!oldest) break;
    verifiedChannels.delete(oldest);
  }
  return entry.channel;
}

function installedChannel(): SlackChannel {
  return verifiedChannels.values().next().value?.channel ??
    channelForInstallation('unconfigured-placeholder', null);
}

type SlackRouteHandler = SlackChannel['routes'][number]['handler'];

const verifiedEventsHandler: SlackRouteHandler = async (c, next) => {
  const platformEnv = c.env as PlatformEnv | undefined;
  const rawBody = await c.req.raw.clone().text();
  const signature = c.req.header('x-slack-signature') ?? '';
  const timestamp = c.req.header('x-slack-request-timestamp') ?? '';
  const credentials = await resolveSlackInstallationCredentials(
    WORKSPACE_SLACK_INSTALLATION_ID,
    platformEnv,
  );
  if (!credentials.signingSecret) {
    return c.json({ error: 'slack_not_configured' }, 401);
  }
  const route = channelForInstallation(
    credentials.signingSecret,
    credentials.connectionRevision,
  ).routes.find((candidate) => candidate.path === '/events');
  if (!route) throw new Error('Slack channel lost its /events route');
  const response = await route.handler(c, next);
  if (response.ok && isSlackUrlVerification(rawBody)) {
    const recorded = await recordPendingSlackChallenge(
      resolveStores(platformEnv).settings,
      { rawBody, signature, timestamp },
    );
    if (recorded.accepted) {
      await finalizePendingWorkspaceInstallation(resolveStores(platformEnv), platformEnv);
    }
  }
  return response;
};

async function finalizePendingWorkspaceInstallation(
  stores: AppStores,
  platformEnv: PlatformEnv | undefined,
): Promise<void> {
  try {
    const setup = await stores.identity.getSlackSetupTransaction('setup_default');
    if (setup?.state !== 'bot_install_pending') return;
    await new SlackInstallOAuthService({
      identity: stores.identity,
      credentials: getSlackCredentialDependencies(platformEnv),
      config: stores.config,
      settings: stores.settings,
    }).finalizeWaitingInstallation(setup.id);
  } catch (error) {
    console.error('[chickpea] Slack Events URL completion failed:', sanitizeError(error));
  }
}

function isSlackUrlVerification(rawBody: string): boolean {
  try {
    const body = JSON.parse(rawBody) as { type?: unknown };
    return body.type === 'url_verification';
  } catch {
    return false;
  }
}

const verifiedInteractionsHandler: SlackRouteHandler = async (c, next) => {
  const platformEnv = c.env as PlatformEnv | undefined;
  const credentials = await resolveSlackInstallationCredentials(
    WORKSPACE_SLACK_INSTALLATION_ID,
    platformEnv,
  );
  if (!credentials.signingSecret) {
    return c.json({ error: 'slack_not_configured' }, 401);
  }
  const route = channelForInstallation(
    credentials.signingSecret,
    credentials.connectionRevision,
  ).routes.find((candidate) => candidate.path === '/interactions');
  if (!route) throw new Error('Slack channel lost its /interactions route');
  return route.handler(c, next);
};

const routes: SlackChannel['routes'] = [
  { method: 'POST', path: '/events', handler: verifiedEventsHandler },
  { method: 'POST', path: '/interactions', handler: verifiedInteractionsHandler },
];

export const channel: SlackChannel = {
  routes,
  route: () => createChannelRouter(routes),
  instanceId: (ref) => installedChannel().instanceId(ref),
  parseInstanceId: (id) => installedChannel().parseInstanceId(id),
};

function handleDirectSlackEvents(
  credentialRevision: string | null,
): NonNullable<SlackChannelOptions['events']> {
  return async ({ c, payload }) => {
    const platformEnv = c.env as PlatformEnv | undefined;
    const stores = resolveStores(platformEnv);
    const installation = await stores.config.getWorkspaceInstallation(payload.team_id);
    if (
      !installation || installation.transportMode !== 'direct' ||
      installation.health === 'revoked' ||
      (installation.appId && installation.appId !== payload.api_app_id)
    ) return;

    const verifiedEventType = payload.type === 'event_callback' &&
        payload.event && typeof payload.event === 'object'
      ? (payload.event as { type?: unknown }).type
      : undefined;
    if (verifiedEventType === 'app_uninstalled' || verifiedEventType === 'tokens_revoked') {
      await recordSlackInstallationLifecycleEvent(
        installation.workspaceId,
        verifiedEventType,
        stores,
      );
      return;
    }
    if (verifiedEventType === 'user_change') {
      detach(
        c,
        processSlackUserChange(
          payload as unknown as SlackEventFixture,
          stores,
          platformEnv,
          credentialRevision,
        ).catch((error) => {
          console.error('[chickpea] Slack membership event failed:', sanitizeError(error));
        }),
      );
      return;
    }
    if (payload.type !== 'event_callback') return;

    const credentials = await resolveSlackInstallationCredentials(
      WORKSPACE_SLACK_INSTALLATION_ID,
      platformEnv,
    );
    const eventType = payload.event.type;
    if (eventType === 'app_home_opened') {
      const event = payload.event as { user?: unknown };
      if (typeof event.user === 'string') {
        const botUserId = await resolveInstallationBotUserId(
          installation.botUserId,
          credentials,
          platformEnv,
        );
        detach(
          c,
          publishAgentAppHome({
            workspaceId: payload.team_id,
            userId: event.user,
            stores,
            transport: createDirectSlackTransport(credentials.botToken ?? ''),
            ...(botUserId ? { botUserId } : {}),
          }).catch((error) => {
            console.error('[chickpea] App Home publish failed:', sanitizeError(error));
          }),
        );
      }
      return;
    }
    if (eventType === 'app_context_changed') return;
    detach(
      c,
      processSlackEvent(payload as unknown as SlackEventFixture, platformEnv).catch((error) => {
        console.error('[chickpea] Slack event intake failed:', sanitizeError(error));
      }),
    );
  };
}

function handleDirectSlackInteractions(): NonNullable<SlackChannelOptions['interactions']> {
  return async ({ c, payload }) => {
    const selection = parseAgentAppHomeSelection(payload);
    if (!selection) return;
    const platformEnv = c.env as PlatformEnv | undefined;
    const stores = resolveStores(platformEnv);
    const installation = await stores.config.getWorkspaceInstallation(selection.workspaceId);
    if (
      !installation || installation.transportMode !== 'direct' ||
      installation.health === 'revoked' ||
      (installation.appId && payload.api_app_id !== installation.appId)
    ) return;
    const credentials = await resolveSlackInstallationCredentials(
      WORKSPACE_SLACK_INSTALLATION_ID,
      platformEnv,
    );
    const botUserId = await resolveInstallationBotUserId(
      installation.botUserId,
      credentials,
      platformEnv,
    );
    detach(
      c,
      seedAgentAppHomeThread({
        ...selection,
        stores,
        transport: createDirectSlackTransport(credentials.botToken ?? ''),
        ...(platformEnv ? { platformEnv } : {}),
        ...(botUserId ? { botUserId } : {}),
      }).catch((error) => {
        console.error('[chickpea] App Home Agent seed failed:', sanitizeError(error));
      }),
    );
  };
}
interface ResolvedAgentRoutingActor {
  routing: AgentRoutingActor;
  principal?: AuthPrincipal;
}

function privateAgentActor(
  actor: ResolvedAgentRoutingActor,
  slackUserId: string,
): PrivateAgentActor {
  return {
    fullMember: actor.routing.fullMember,
    slackUserId,
    ...(actor.principal ? { membershipId: actor.principal.membershipId } : {}),
  };
}

export async function resolveAgentRoutingActor(input: {
  workspaceId: string;
  userId: string;
  channelId?: string;
  /** A Slack message/reaction event is current proof that its author belongs
   * to the exact source Channel at event time. */
  sourceChannelMembership?: boolean;
  botUserId: string;
  transport: SlackTransport;
  stores: AppStores;
}): Promise<ResolvedAgentRoutingActor> {
  const member = await input.transport.lookupMember(input.userId);
  let principal: AuthPrincipal | undefined;
  let fullMember = false;
  const provisioned = await provisionSlackInteractionMember({
    identity: input.stores.identity,
    slackTeamId: input.workspaceId,
    botUserId: input.botUserId,
    user: {
      id: member.id,
      teamId: member.teamId,
      displayName: member.displayName ?? member.name,
      email: member.email,
      deleted: member.deleted,
      bot: member.bot,
      appUser: member.appUser,
      restricted: member.restricted,
      ultraRestricted: member.ultraRestricted,
      stranger: member.stranger,
    },
  });
  if (
    'resolution' in provisioned && provisioned.resolution &&
    (provisioned.outcome === 'active' || provisioned.outcome === 'provisioned') &&
    provisioned.resolution.membership.status === 'active'
  ) {
    fullMember = true;
    principal = {
      userId: provisioned.resolution.user.id,
      membershipId: provisioned.resolution.membership.id,
      organizationId: provisioned.resolution.membership.organizationId,
      role: provisioned.resolution.membership.role,
      authenticatorKind: 'slack_event',
      credentialId: `slack:${input.workspaceId}:${input.userId}`,
      correlationId: `slack-event:${input.workspaceId}:${input.userId}`,
      machine: false,
    };
  }
  const channelMember = input.channelId && slackInteractionMayUseGrantedChannel(provisioned)
    ? input.sourceChannelMembership === true ||
      await input.transport.channelHasMember(input.channelId, input.userId)
    : false;
  return {
    routing: {
      channelMember,
      fullMember,
    },
    ...(principal ? { principal } : {}),
  };
}

async function publishAgentAppHome(input: {
  workspaceId: string;
  userId: string;
  stores: AppStores;
  transport: SlackTransport;
  botUserId?: string;
  unavailableNotice?: boolean;
}): Promise<void> {
  if (!input.botUserId) return;
  const installation = await input.stores.config.getWorkspaceInstallation(input.workspaceId);
  if (!installation) return;
  const actor = await resolveAgentRoutingActor({
    workspaceId: input.workspaceId,
    userId: input.userId,
    botUserId: input.botUserId,
    transport: input.transport,
    stores: input.stores,
  });
  const [agents, grants] = actor.routing.fullMember
    ? await Promise.all([
        input.stores.config.listAgents(),
        input.stores.config.listAgentChannelGrants(input.workspaceId),
      ])
    : [[], []];
  const visible = actor.routing.fullMember
    ? await listPrivatelyUsableAgents({
        agents,
        workspaceId: input.workspaceId,
        grants,
        actor: privateAgentActor(actor, input.userId),
        transport: input.transport,
      })
    : [];
  await input.transport.publishAppHome({
    userId: input.userId,
    view: agentDirectoryAppHome(visible, {
      unavailableNotice: input.unavailableNotice === true,
    }),
  });
}

async function seedAgentAppHomeThread(input: {
  workspaceId: string;
  userId: string;
  agentId: string;
  stores: AppStores;
  transport: SlackTransport;
  platformEnv?: PlatformEnv;
  botUserId?: string;
  deliveryId?: string;
}): Promise<void> {
  if (!input.botUserId) return;
  const installation = await input.stores.config.getWorkspaceInstallation(input.workspaceId);
  if (!installation) return;
  const actor = await resolveAgentRoutingActor({
    workspaceId: input.workspaceId,
    userId: input.userId,
    botUserId: input.botUserId,
    transport: input.transport,
    stores: input.stores,
  });
  if (!actor.routing.fullMember) {
    await publishAgentAppHome({ ...input, unavailableNotice: true });
    return;
  }
  const agent = (await input.stores.config.listAgents()).find(({ id }) => id === input.agentId);
  if (
    !agent || agent.kind !== 'user' || !agent.enabled ||
    agent.lifecycle === 'draft' || agent.lifecycle === 'archived'
  ) {
    await publishAgentAppHome({ ...input, unavailableNotice: true });
    return;
  }
  const grants = await input.stores.config.listAgentChannelGrants(input.workspaceId);
  const access = await resolvePrivateAgentAccess({
    agent,
    workspaceId: input.workspaceId,
    grants,
    actor: privateAgentActor(actor, input.userId),
    transport: input.transport,
  });
  if (access.status !== 'allowed') {
    await publishAgentAppHome({ ...input, unavailableNotice: true });
    return;
  }
  const avatarUrl = await resolvedAgentAvatarUrl(agent, input.stores, input.platformEnv);
  if (!avatarUrl) return;
  const dm = await input.transport.openDirectConversation(input.userId);
  const root = await input.transport.postMessage({
    channelId: dm.id,
    text: agentAppHomeStarterMessage(agent.name),
    persona: { name: agent.name, avatarUrl },
    ...(input.deliveryId
      ? { idempotencyKey: input.deliveryId }
      : {}),
  });
  const synthetic: NormalizedSlackTurn = {
    workspaceId: input.workspaceId,
    channelId: root.channelId,
    eventId: `app-home:${root.ts}`,
    text: '',
    userId: input.userId,
    messageTs: root.ts,
    threadTs: root.ts,
    source: 'dm_message',
    channelType: 'im',
    contextMode: 'thread',
  };
  const routed = await resolveAgentRoute({
    turn: synthetic,
    surface: 'direct',
    actor: actor.routing,
    config: input.stores.config,
    appHomeAgentId: agent.id,
    authorizeUserAgent: async () => access,
  });
  if (routed.kind === 'routed') {
    await recordDeliveredSlackAgentMessage(
      input.stores.config,
      synthetic,
      routed.assignment,
      { messageTs: root.ts, text: agentAppHomeStarterMessage(agent.name) },
    ).catch(() => {
      console.warn('[chickpea] App Home starter was not added to public context');
    });
  }
}

async function resolvedAgentAvatarUrl(
  agent: ResolvedAssignment['agent'],
  stores: AppStores,
  platformEnv: PlatformEnv | undefined,
): Promise<string | undefined> {
  if (agent.slackPresence?.avatar.url) return agent.slackPresence.avatar.url;
  const origin = await resolveSlackPublicUrl(platformEnv, stores.settings);
  return agentAvatarUrlForPresentation(agent, origin);
}

export async function postAgentRoutingFeedback(input: {
  turn: NormalizedSlackTurn;
  surface: AssignmentSurface;
  result: Extract<AgentRoutingResult, { kind: 'denied' | 'ambiguous' }>;
  client: ReturnType<typeof createSlackWebClient>;
  channelHintEnabled: boolean;
}): Promise<void> {
  const alternatives = input.result.alternatives.length > 0
    ? ` Available here: ${input.result.alternatives.map(({ handle }) => `@${handle}`).join(', ')}.`
    : '';
  const text = input.result.kind === 'ambiguous'
    ? `Mention one Agent at a time.${alternatives}`
    : input.result.reason === 'temporarily_unavailable'
        ? 'That Agent address could not be verified right now. Try again.'
      : `That Agent is not available here.${alternatives}`;
  if (input.surface === 'channel') {
    // Explicit base-app and Agent-handle mentions receive a private denial.
    // Ambient roots remain silent, and a denied Agent never becomes visible
    // through the alternatives list.
    const explicitAgentMention = input.turn.source === 'agent_mention' ||
      (input.turn.source === 'implicit_thread_reply' &&
        parseAgentUserGroupMentions(input.turn.text).length > 0);
    if (
      (input.result.kind === 'ambiguous' && !input.channelHintEnabled) ||
      (input.turn.source !== 'app_mention' && !explicitAgentMention) ||
      (!input.turn.channelId.startsWith('C') && input.turn.channelType !== 'group')
    ) return;
    await input.client.chat.postEphemeral({
      channel: input.turn.channelId,
      user: input.turn.userId,
      text,
    });
    return;
  }
  await input.client.chat.postMessage({
    channel: input.turn.channelId,
    thread_ts: input.turn.threadTs,
    text,
  });
}

async function processSlackUserChange(
  payload: SlackEventFixture,
  stores: AppStores,
  platformEnv: PlatformEnv | undefined,
  credentialRevision: string | null,
): Promise<void> {
  if (payload.event.type !== 'user_change' || !credentialRevision) return;
  const control = await stores.identity.getAuthControl();
  const environment = control
    ? await resolveBetterAuthEnvironment({ control, platformEnv })
    : undefined;
  await applySlackUserChange({
    identity: stores.identity,
    ...(environment ? { betterAuth: environment.backend } : {}),
    credentialRevision,
    payloadTeamId: payload.team_id,
    apiAppId: payload.api_app_id,
    eventId: payload.event_id,
    event: payload.event,
  });
}

async function recordSlackInstallationLifecycleEvent(
  workspaceId: string,
  eventType: 'app_uninstalled' | 'tokens_revoked',
  stores: AppStores,
): Promise<void> {
  const current = await stores.config.getWorkspaceInstallation(workspaceId);
  if (!current || current.health === 'revoked') return;
  try {
    await stores.config.updateWorkspaceInstallation(
      workspaceId,
      { health: 'revoked', healthDetail: eventType },
      current.revision,
    );
  } catch {
    const latest = await stores.config.getWorkspaceInstallation(workspaceId);
    if (!latest || latest.health === 'revoked') return;
    await stores.config.updateWorkspaceInstallation(
      workspaceId,
      { health: 'revoked', healthDetail: eventType },
      latest.revision,
    );
  }
}

async function resolveInstallationBotUserId(
  installedBotUserId: string | undefined,
  credentials: ResolvedSlackInstallationCredentials,
  platformEnv: PlatformEnv | undefined,
): Promise<string | undefined> {
  return credentials.botUserId ?? installedBotUserId ?? resolveBotUserId(platformEnv);
}
interface SlackEventExecution {
  transport: SlackTransport;
  client: ReturnType<typeof createSlackWebClient>;
  botUserId: string;
  stores?: AppStores;
  enqueueTurn?: (job: TurnJob) => Promise<StateRpcResult<null>>;
}

class SlackDurableEnqueueError extends Error {
  override readonly name = 'SlackDurableEnqueueError';
}

/**
 * Credential-free ingress for the unlisted shared Slack app. The private
 * gateway authenticates Slack, binds the delivery to one deployment, and
 * sends only this normalized event envelope. The OSS runtime revalidates its
 * durable workspace binding before the event can reach ordinary admission.
 */
export async function processGatewaySlackEnvelope(
  envelope: SlackInboundEnvelope,
  platformEnv?: PlatformEnv,
  providedClient?: GatewayDeploymentClient,
  providedExecution?: {
    stores: AppStores;
    enqueueTurn(job: TurnJob): Promise<StateRpcResult<null>>;
  },
): Promise<'accepted' | 'rejected'> {
  const stores = providedExecution?.stores ?? resolveStores(platformEnv);
  const installation = await stores.config.getWorkspaceInstallation(envelope.workspaceId);
  if (
    !installation || installation.transportMode !== 'gateway' ||
    installation.health === 'revoked' ||
    !installation.gatewayBindingId || !installation.appId || !installation.botUserId
  ) return 'rejected';
  const gateway = providedClient ?? createGatewayDeploymentClient(platformEnv);
  const binding = await gateway.loadBinding();
  if (
    !binding || binding.bindingId !== installation.gatewayBindingId ||
    binding.workspaceId !== envelope.workspaceId || binding.appId !== installation.appId ||
    binding.botUserId !== installation.botUserId
  ) return 'rejected';
  const transport = createGatewaySlackTransport(gateway);
  const client = createGatewaySlackWebClient(gateway);
  const payload: SlackEventFixture = {
    token: '',
    team_id: envelope.workspaceId,
    api_app_id: installation.appId,
    event_id: envelope.eventId,
    event_time: envelope.eventTime,
    type: 'event_callback',
    event: envelope.event,
  };
  if (envelope.event.type === 'app_home_opened') {
    await publishAgentAppHome({
      workspaceId: envelope.workspaceId,
      userId: envelope.event.user,
      stores,
      transport,
      botUserId: installation.botUserId,
    });
    return 'accepted';
  }
  if (envelope.event.type === 'app_context_changed') return 'accepted';
  if (envelope.event.type === 'app_uninstalled' || envelope.event.type === 'tokens_revoked') {
    await recordSlackInstallationLifecycleEvent(
      envelope.workspaceId,
      envelope.event.type,
      stores,
    );
    return 'accepted';
  }
  if (envelope.event.type === 'user_change') {
    const control = await stores.identity.getAuthControl();
    const environment = control
      ? await resolveBetterAuthEnvironment({ control, platformEnv })
      : undefined;
    await applyGatewaySlackUserChange({
      identity: stores.identity,
      ...(environment ? { betterAuth: environment.backend } : {}),
      payloadTeamId: envelope.workspaceId,
      apiAppId: installation.appId,
      eventId: envelope.eventId,
      event: envelope.event,
    });
    return 'accepted';
  }
  await processSlackEvent(payload, platformEnv, {
    transport,
    client,
    botUserId: installation.botUserId,
    stores,
    ...(providedExecution ? { enqueueTurn: providedExecution.enqueueTurn } : {}),
  });
  return 'accepted';
}

export async function processGatewayAgentSelection(
  selection: AgentAppHomeSelection,
  platformEnv?: PlatformEnv,
  providedClient?: GatewayDeploymentClient,
  providedStores?: AppStores,
): Promise<'accepted' | 'rejected'> {
  const stores = providedStores ?? resolveStores(platformEnv);
  const installation = await stores.config.getWorkspaceInstallation(selection.workspaceId);
  if (
    !installation || installation.transportMode !== 'gateway' ||
    installation.health === 'revoked' ||
    !installation.botUserId || !installation.gatewayBindingId
  ) return 'rejected';
  const gateway = providedClient ?? createGatewayDeploymentClient(platformEnv);
  const binding = await gateway.loadBinding();
  if (!binding || binding.bindingId !== installation.gatewayBindingId ||
      binding.workspaceId !== selection.workspaceId) return 'rejected';
  await seedAgentAppHomeThread({
    ...selection,
    stores,
    transport: createGatewaySlackTransport(gateway),
    botUserId: installation.botUserId,
  });
  return 'accepted';
}

async function processSlackEvent(
  payload: SlackEventFixture,
  platformEnv: PlatformEnv | undefined,
  execution?: SlackEventExecution,
): Promise<void> {
  const stores = execution?.stores ?? resolveStores(platformEnv);
  const behavior = await resolveSlackBehaviorSettings(platformEnv, stores.settings);
  const installation = await stores.config.getWorkspaceInstallation(payload.team_id);
  if (!installation || installation.health === 'revoked') return;
  if (execution && installation.transportMode !== 'gateway') return;
  if (!execution && installation.transportMode !== 'direct') return;
  if (
    installation.runtimeContract === 'chickpea-v1' &&
    payload.event.type === 'message' &&
    await reconcileSlackPublicContextMutation(
      stores.config,
      payload.team_id,
      payload.event,
    )
  ) return;
  const credentials = execution
    ? ({ connectionRevision: null } as ResolvedSlackInstallationCredentials)
    : await resolveSlackInstallationCredentials(WORKSPACE_SLACK_INSTALLATION_ID, platformEnv);

  if (payload.event.type === 'member_joined_channel') {
    if (!behavior.welcomeOnJoin.value) return;
    await handleMemberJoinedChannel(
      payload,
      stores,
      platformEnv,
      installation.botUserId,
      credentials,
      execution,
    );
    return;
  }

  const resolvedBotUserId = execution?.botUserId ??
    await resolveInstallationBotUserId(installation.botUserId, credentials, platformEnv);
  const normalization = normalizeSlackTurn(payload, {
    ...(resolvedBotUserId ? { botUserId: resolvedBotUserId } : {}),
  });
  if (normalization.status !== 'runnable') return;
  const turn = normalization.turn;
  const state = stores.slackState;
  const preliminarySurface = turnSurface(turn);
  const liveChannelConfig = liveChannelConfigurationEnabled(platformEnv);
  let candidateTurn = turn.source === 'reaction_added';
  let threadKey = slackThreadKey(turn);

  // c. Implicit thread replies require a thread this app already started (a
  //    prior mention/DM). An unknown thread key produces nothing on the wire
  //    (S13). With the file-backed state store the registry survives
  //    restarts; `:memory:` keeps the old process-local semantics. Checked
  //    before any claim so a dropped reply stays fully silent.
  const surface = turnSurface(turn);
  if (surface !== preliminarySurface) return;

  // d. Claim BOTH the event id and the (channel, message-ts) so the
  //    app_mention + message fan-out for a single mention replies once.
  const evtKey = `evt:${payload.event_id}`;
  const msgKey = `msg:${turn.channelId}:${turn.messageTs}`;

  let assignment: ResolvedAssignment;
  let routedBaseAssignment: ResolvedAssignment | undefined;
  let agentRoutingActor: ResolvedAgentRoutingActor | undefined;
  let agentSourceVisibility: 'public' | 'private' | undefined;
  const runtimeTransport = execution?.transport ?? (
    credentials.botToken ? createDirectSlackTransport(credentials.botToken) : undefined
  );
  const runtimeClient = execution?.client ?? (
    credentials.botToken ? createSlackWebClient(credentials.botToken) : undefined
  );
  if (turn.source === 'reaction_added') {
    if (!runtimeClient || !(await resolveReactionTargetContext(turn, runtimeClient))) {
      await state.claim(evtKey);
      await state.claim(msgKey);
      return;
    }
    threadKey = slackThreadKey(turn);
  }

  // e. Resolve the config for this turn before canonical admission acquires
  //    the claims. A failure here must not release keys owned by a concurrent
  //    sibling event or Slack retry. Reaction events that cannot resolve a
  //    Slack target are consumed above as transport noise, before config work.
  //    Every newly admitted event resolves current configuration. The durable
  //    TurnJob below freezes that result for retries and an in-flight response;
  //    a later event in the same Slack thread resolves again. Channels remain
  //    fail-closed and never fall through to the global direct-message default.
  if (
    (turn.source === 'implicit_thread_reply' || turn.source === 'reaction_added') &&
    !(await stores.config.getAgentThreadRoute(turn.workspaceId, turn.channelId, turn.threadTs))
  ) {
    return;
  }
  try {
    const store = stores.config;
    if (!runtimeTransport || !runtimeClient || !resolvedBotUserId) return;
      agentRoutingActor = await resolveAgentRoutingActor({
        workspaceId: turn.workspaceId,
        userId: turn.userId,
        ...(surface === 'channel' ? { channelId: turn.channelId } : {}),
        ...(surface === 'channel' ? { sourceChannelMembership: true } : {}),
        botUserId: resolvedBotUserId,
        transport: runtimeTransport,
        stores,
      });
      const routed = await resolveAgentRoute({
        turn,
        surface,
        actor: agentRoutingActor.routing,
        config: store,
        transport: runtimeTransport,
        authorizeUserAgent: async (agent) => resolvePrivateAgentAccess({
          agent,
          workspaceId: turn.workspaceId,
          grants: await store.listAgentChannelGrants(turn.workspaceId),
          actor: privateAgentActor(agentRoutingActor!, turn.userId),
          transport: runtimeTransport,
        }),
      });
      if (routed.kind === 'ignore') return;
      if (routed.kind !== 'routed') {
        await postAgentRoutingFeedback({
          turn,
          surface,
          result: routed,
          client: runtimeClient,
          channelHintEnabled: behavior.unassignedHint.value,
        });
        return;
      }
      let routedAssignment = routed.assignment;
      if (routed.handoffFallbackRequired && routed.previousAgentId && routed.route.handoff) {
        const fallbackContext = await hydrateSlackPublicHandoffFallback(
          runtimeClient,
          turn,
          routed.previousAgentId,
        );
        await store.putAgentThreadRoute({
          workspaceId: routed.route.workspaceId,
          channelId: routed.route.channelId,
          threadTs: routed.route.threadTs,
          agentId: routed.route.agentId,
          agentGeneration: routed.route.agentGeneration,
          ownerIncarnation: routed.route.ownerIncarnation,
          handoff: { ...routed.route.handoff, context: fallbackContext },
        }, routed.route.revision);
        routedAssignment = {
          ...routed.assignment,
          ...(fallbackContext.length ? { handoffContext: fallbackContext } : {}),
        };
      }
      routedBaseAssignment = routedAssignment;
      const policyAssignment = await resolveModelPolicyForAssignment(routedAssignment, store);
      candidateTurn = turn.source === 'reaction_added';
      if (surface === 'channel') {
        const channel = await runtimeTransport.lookupChannel(turn.channelId);
        agentSourceVisibility = channel.private ? 'private' : 'public';
      } else {
        agentSourceVisibility = 'private';
      }
      const frozenAssignment = await getOrReplaceSnapshotForRoute(
        stores.snapshots,
        threadKey,
        { ...routed.route, modelAttribution: policyAssignment.modelAttribution },
        async () => {
          const config = effectiveSlackConfigFromAssignment(policyAssignment);
          const modelCredential = await resolveModelCredentialAttribution(
            config.model,
            platformEnv,
            stores.settings,
            stores.usage,
          );
          return { ...config, ...(modelCredential ? { modelCredential } : {}) };
        },
      );
      assignment = {
        ...frozenAssignment,
        ...(routedAssignment.runtimeContract
          ? { runtimeContract: routedAssignment.runtimeContract }
          : {}),
        ...(routedAssignment.ownerIncarnation
          ? { ownerIncarnation: routedAssignment.ownerIncarnation }
          : {}),
        ...(routedAssignment.handoffContext?.length
          ? { handoffContext: routedAssignment.handoffContext }
          : {}),
        ...(routedAssignment.interactionMode
          ? { interactionMode: routedAssignment.interactionMode }
          : {}),
      };
  } catch (err) {
    // A model that cannot resolve is NOT fail-closed: admit with a best-effort
    // assignment so the turn still delivers the sanitized provider-failure
    // final (no snapshot is written — a misconfigured-model thread has no
    // usable config to freeze). Everything else (unassigned/disabled channel,
    // disabled DM default) is fail-closed and stays silent.
    if (err instanceof ModelResolutionError) {
      if (!routedBaseAssignment) return;
      assignment = routedBaseAssignment;
    } else {
      console.error('[chickpea] no assignment for turn:', sanitizeError(err));
      // Fail-closed with feedback: the channel stays silent, but the person
      // who explicitly mentioned the bot gets an ephemeral pointer at /admin.
      // Detached so the events ack is not delayed by the Slack Web API call.
      return;
    }
  }

  // Direct-message assignments are intentionally live rather than snapshotted,
  // so attach the same non-secret credential attribution at admission time.
  // A model-resolution error still follows the existing sanitized-failure path.
  if (!assignment.modelCredential) {
    try {
      if (assignment.model) {
        const modelCredential = await resolveModelCredentialAttribution(
          assignment.model,
          platformEnv,
          stores.settings,
          stores.usage,
        );
        if (modelCredential) assignment = { ...assignment, modelCredential };
      }
    } catch {
      // Reporting enrichment cannot change whether the turn is admitted.
    }
  }
  if (
    assignment.runtimeContract === 'chickpea-v1' &&
    surface === 'direct' &&
    turn.messageTs === turn.threadTs
  ) {
    // A user-Agent root is a new owned conversation, not an invitation to
    // hydrate unrelated Agent roots from the shared base-app DM history.
    turn.contextMode = 'thread';
  }
  const assignmentAvatarUrl = await resolvedAgentAvatarUrl(
    assignment.agent,
    stores,
    platformEnv,
  );

  let claimsHeldByCanonicalAdmission = false;
  let canonicalRunId: string | undefined;
  let canonicalTurnJob: TurnJob | undefined;

  // Resolve actor/source truth only after assignment succeeds. This keeps an
  // unassigned channel's established zero-Slack-API behavior intact while
  // still authorizing before any canonical content or Run is written.
  const { botToken } = credentials;
  const slackClient = runtimeClient;
  if (
    turn.source === 'reaction_added' &&
    (!slackClient || !(await resolveReactionTargetContext(turn, slackClient)))
  ) {
    await state.claim(evtKey);
    await state.claim(msgKey);
    return;
  }
  threadKey = slackAgentThreadKey(turn, assignment);
  turn.activeWorkAtAdmission = await state.isActiveWork(threadKey);
  const commandAddress = {
    botUserId: resolvedBotUserId,
    agentUserGroupId: assignment.agent.slackPresence?.userGroupId,
  };
  const deterministicCommand = Boolean(parseMemoryCommand(turn.text)) ||
    (isRoutineSlackTurn(turn) && Boolean(parseRoutineCommand(turn.text, commandAddress)));
  let admissionTruth: SlackAdmissionTruth = {
    eligible: false,
    reason: 'slack_truth_unavailable',
  };
  let admittedActorMembershipId = agentRoutingActor?.principal?.membershipId;
  if (agentRoutingActor && agentSourceVisibility) {
    admissionTruth = {
      eligible: true,
      reason: 'eligible',
      sourceVisibility: agentSourceVisibility,
      actorTrustTier: 'member',
    };
  } else if (botToken && resolvedBotUserId) {
    try {
      admissionTruth = await resolveSlackAdmissionTruth(
        turn,
        resolvedBotUserId,
        slackAdmissionTruthReader(botToken),
        async (user) => {
          const authControl = await stores.identity.getAuthControl();
          // Slack can be connected before the workspace Owner finishes the
          // separate product-auth handoff. Preserve that setup/runtime lane;
          // automatic member authority begins only once Slack auth is active.
          if (authControl?.authMode !== 'slack_active') return true;
          const member = await provisionSlackInteractionMember({
            identity: stores.identity,
            slackTeamId: turn.workspaceId,
            botUserId: resolvedBotUserId,
            user,
          });
          if (
            'resolution' in member && member.resolution &&
            (member.outcome === 'provisioned' || member.outcome === 'active') &&
            member.resolution.membership.status === 'active'
          ) {
            admittedActorMembershipId = member.resolution.membership.id;
          }
          return member.outcome === 'provisioned' || member.outcome === 'active';
        },
      );
    } catch {
      // Shadow truth is observational in U3. A transient resolver failure must
      // not change the established Slack execution path before authority cutover.
    }
  }
  if (admissionTruth.eligible && admittedActorMembershipId) {
    turn.actorMembershipId = admittedActorMembershipId;
  }

  if (!deterministicCommand && !candidateTurn) {
    const immediateIntent = resolveImmediateSlackInteractionIntent({
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      eventId: turn.eventId,
      text: turn.text,
      source: turn.source,
      guaranteed: true,
      ...(turn.activeWorkAtAdmission === undefined
        ? {}
        : { activeWork: turn.activeWorkAtAdmission }),
      profileInstructions:
        'instructions' in assignment && typeof assignment.instructions === 'string'
          ? assignment.instructions
          : assignment.agent.instructions,
    });
    if (immediateIntent) turn.interactionIntent = immediateIntent;
  }

  // Inbound reactions are candidates, not durable work.
  if (candidateTurn && !admissionTruth.eligible) {
    console.info(
      `[chickpea] Slack candidate denied: ${admissionTruth.reason} (${turn.source})`,
    );
    await state.claim(evtKey);
    await state.claim(msgKey);
    return;
  }

  let promotedDecisionKey: string | undefined;
  let promotedClassifierUsage:
    | {
        classification: Awaited<ReturnType<typeof classifySlackInteraction>>;
        requestedModel: string | null;
      }
    | undefined;
  if (!deterministicCommand && candidateTurn) {
    const decisionKey = `decision:${msgKey}`;
    if (!(await state.claim(decisionKey))) return;
    const releaseClassifier = acquireCandidateClassifier(
      `${turn.workspaceId}:${turn.channelId}`,
    );
    if (!releaseClassifier) {
      await state.claim(evtKey);
      await state.claim(msgKey);
      return;
    }
    try {
      const { classification, requestedModel } = await classifyCandidateTurn(
        turn,
        assignment,
        platformEnv,
        slackClient as ReturnType<typeof createSlackWebClient>,
      );
      if (classification.intent.disposition === 'ignore') {
        await recordInteractionClassifierUsage({
          turn,
          assignment,
          classification,
          requestedModel,
          surface,
          stores,
          platformEnv,
        });
        await state.claim(evtKey);
        await state.claim(msgKey);
        return;
      }
      turn.interactionIntent = classification.intent;
      promotedDecisionKey = decisionKey;
      promotedClassifierUsage = { classification, requestedModel };

      // Candidate classification may take long enough for configuration to
      // change. Re-resolve at promotion; the ensuing TurnJob is the freeze.
      if (surface === 'channel') {
        assignment = liveChannelConfig
          ? await resolveEffectiveSlackConfig(turn.workspaceId, turn.channelId, {
              agents: stores.config,
              grants: stores.config,
            }, process.env, assignment.agentId)
          : await getOrCreateSnapshot(stores.snapshots, threadKey, () =>
              resolveEffectiveSlackConfig(turn.workspaceId, turn.channelId, {
                agents: stores.config,
                grants: stores.config,
              }, process.env, assignment.agentId));
      }
    } finally {
      releaseClassifier();
    }
  }

  // Canonical Work admission stores a concrete configured model. A missing
  // model is an operator configuration error, but it must still follow the
  // established legacy turn path so Slack receives one sanitized failure
  // instead of an intake exception and silence.
  let modelReadyForCanonicalAdmission = true;
  modelReadyForCanonicalAdmission = Boolean(assignment.model && assignment.modelAttribution);

  if (admissionTruth.eligible && modelReadyForCanonicalAdmission) {
    emitManagementMetric('live_revision.admission', {
      surface,
      action: surface === 'channel' && !liveChannelConfig ? 'snapshot' : 'live',
      outcome: 'admitted',
    });
    let egressPolicy;
    try {
      egressPolicy = parseEgressPolicy(
        await stores.settings.getSetting(EGRESS_SETTING_KEY),
      );
    } catch {
      // Canary eligibility is fail-closed. A settings read failure still uses
      // the established legacy lane and must not change Slack availability.
    }
    const selectedExecution = selectSlackExecutionAuthority({
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      assignment,
      ...(egressPolicy ? { egressPolicy } : {}),
      legacyOnlyTurn:
        Boolean(parseMemoryCommand(turn.text)) ||
        (isRoutineSlackTurn(turn) && Boolean(parseRoutineCommand(turn.text, commandAddress))),
      ...(platformEnv ? { env: platformEnv } : {}),
    });
    const admission = prepareSlackShadowAdmission({
      turn,
      assignment,
      sourceVisibility: admissionTruth.sourceVisibility,
      admittedAt: Date.now(),
      executionAuthority: selectedExecution.authority,
    });
    canonicalTurnJob = {
      id: msgKey,
      evtKey,
      msgKey,
      turn,
      assignment,
      runId: admission.run.id,
      executionAuthority: admission.run.executionAuthority,
    };
    const sessionGeneration = slackSessionGenerationFromTimestamp(turn.messageTs);
    const owner = selectSlackPresentationOwner({
      installationHealth: installation.health,
      agentId: assignment.agent.id,
      agentName: assignment.agent.name,
      ...(assignmentAvatarUrl ? { avatarUrl: assignmentAvatarUrl } : {}),
      ...(assignment.agent.slackPresence
        ? { slackPresence: assignment.agent.slackPresence }
        : {}),
    });
    const admittedActivity = initialActivityStatus(
      turn.interactionIntent?.disposition === 'work'
        ? turn.interactionIntent.checklist
        : undefined,
      turn.text,
    );
    const semanticActivityEnabled = slackSemanticActivityStatusEnabled(platformEnv);
    try {
      const result = await state.admitCanonical({
        evtKey,
        msgKey,
        threadKey,
        admission,
        turnJob: canonicalTurnJob,
        presentation: {
          schemaVersion: 3,
          root: {
            workspaceId: turn.workspaceId,
            channelId: turn.channelId,
            threadTs: turn.threadTs,
            requesterUserId: turn.userId,
          },
          owner,
          sessionGeneration,
          ...(semanticActivityEnabled
            ? {
                currentActivity: {
                  kind: admittedActivity.kind,
                  action: admittedActivity.action,
                  object: admittedActivity.object,
                  family: admittedActivity.family,
                  phase: admittedActivity.phase,
                  generation: sessionGeneration,
                  sequence: 1,
                  operation: {
                    operationId: opaqueId(
                      'activity',
                      `${admission.run.id}:${canonicalTurnJob.id}:1`,
                    ),
                    certainty: 'pending' as const,
                  },
                },
              }
            : {}),
          ...(turn.interactionIntent?.disposition === 'work'
            ? { taskLabels: turn.interactionIntent.checklist }
            : {}),
        },
      });
      if (!result.claimed) return;
      claimsHeldByCanonicalAdmission = true;
      canonicalRunId = result.admission.run.id;
    } catch (err) {
      if (admission.run.executionAuthority === 'ledger') {
        // A selected canary must never fall back across authority lanes. The
        // transaction rolled its claims back, so Slack may safely redeliver.
        console.error('[chickpea] ledger Work admission failed:', sanitizeError(err));
        if (promotedDecisionKey) await state.release(promotedDecisionKey);
        if (execution?.enqueueTurn) {
          throw new SlackDurableEnqueueError('Canonical Work admission failed.');
        }
        return;
      }
      // U3 is deliberately observational. Preserve the existing product path
      // while surfacing a body-free operator gap for follow-up.
      console.error('[chickpea] shadow Work admission failed:', sanitizeError(err));
      if (!(await state.claim(evtKey))) return;
      if (!(await state.claim(msgKey))) {
        await state.release(evtKey);
        return;
      }
    }
  } else {
    if (!(await state.claim(evtKey))) return;
    if (!(await state.claim(msgKey))) {
      await state.release(evtKey);
      return;
    }
  }

  const durableCanonicalTurnJob = canonicalRunId ? canonicalTurnJob : undefined;

  if (promotedClassifierUsage) {
    await recordInteractionClassifierUsage({
      turn,
      assignment,
      ...promotedClassifierUsage,
      surface,
      stores,
      platformEnv,
      ...(canonicalRunId ? { runId: canonicalRunId } : {}),
    });
  }

  // f. The old HTTP self-call — and the Host-derived origin trust it forced,
  //    since Slack signatures don't cover Host — is gone: the agent prompt
  //    now dispatches through the durable Flue 2 adapter with the
  //    platform env captured at the top of this handler, so there is no
  //    origin to spoof or configure.

  // g. Mark this thread as started so its later implicit replies are admitted
  //    (mentions and DMs both open a thread the app owns). Registered
  //    pre-turn (before runTurn) on purpose: it admits implicit replies that
  //    arrive while the root turn is still in flight, matching the old lane's
  //    session-created-before-provider-call semantics. A failed turn leaves
  //    the thread registered (only the claims are released, for retry).
  if (!claimsHeldByCanonicalAdmission) await state.start(threadKey);
  const marksActiveWork = turn.interactionIntent?.disposition === 'work';
  if (marksActiveWork) await state.setActiveWork(threadKey, msgKey, true);

  // h. Persist the turn before starting the target-owned durable driver.
  //    - NODE wakes its SQLite-backed relay after either canonical admission
  //      or a legacy fallback enqueue.
  //    - CLOUDFLARE cannot drive a turn inside the events
  //      invocation's `waitUntil` is cancelled ~30s after the response
  //      (tail-log-confirmed), killing any longer model turn. So the handler
  //      ENQUEUES the job into the state Durable Object — awaited, so the job +
  //      armed alarm are durable BEFORE the ack (milliseconds) — and the DO's
  //      alarm() runs the SAME runTurn with the platform's 15-minute wall-time
  //      budget. The claims are already held; each driver owns terminal claim
  //      release and preserves any admitted Flue envelope for reattachment.
  if (isCloudflareTarget()) {
    // id = msgKey: the message claim key already dedupes the app_mention +
    // message fan-out, so keying the job by it makes the enqueue idempotent.
    const job: TurnJob = durableCanonicalTurnJob ?? {
      id: msgKey,
      evtKey,
      msgKey,
      turn,
      assignment,
    };
    const enqueued = execution?.enqueueTurn
      ? await execution.enqueueTurn(job)
      : await tagStateStub(platformEnv).enqueueTurn(job);
    if (!enqueued.ok) {
      // Enqueue failed before anything ran: free the claims so a Slack
      // redelivery can re-drive, and stay silent.
      await state.release(evtKey);
      await state.release(msgKey);
      if (promotedDecisionKey) await state.release(promotedDecisionKey);
      if (marksActiveWork) await state.setActiveWork(threadKey, msgKey, false);
      console.error('[chickpea] enqueue turn failed:', enqueued.error.message);
      throw new SlackDurableEnqueueError(enqueued.error.message);
    }
    await recordAcceptedSlackHumanMessage(stores.config, turn, assignment).catch(() => {
      console.warn('[chickpea] accepted Slack message was not added to public context');
    });
    return;
  }
  if (!durableCanonicalTurnJob) {
    try {
      const enqueued = await state.enqueueTurn?.({
        id: msgKey,
        evtKey,
        msgKey,
        turn,
        assignment,
      });
      if (enqueued === undefined) {
        throw new Error('Node turn store is unavailable.');
      }
    } catch (err) {
      // Persistence failed before a durable driver owned the turn. Release the
      // claims and active-work marker so Slack can safely redeliver it.
      await state.release(evtKey);
      await state.release(msgKey);
      if (promotedDecisionKey) await state.release(promotedDecisionKey);
      if (marksActiveWork) await state.setActiveWork(threadKey, msgKey, false);
      console.error('[chickpea] Node turn enqueue failed:', sanitizeError(err));
      return;
    }
  }
  await recordAcceptedSlackHumanMessage(stores.config, turn, assignment).catch(() => {
    console.warn('[chickpea] accepted Slack message was not added to public context');
  });
  await wakeNodeTurnRelay(platformEnv).catch((err) => {
    console.error('[chickpea] node turn wake failed:', sanitizeError(err));
  });
}


async function handleMemberJoinedChannel(
  payload: SlackEventFixture,
  stores: AppStores,
  platformEnv: PlatformEnv | undefined,
  installedBotUserId: string | undefined,
  credentials: ResolvedSlackInstallationCredentials,
  execution?: SlackEventExecution,
): Promise<void> {
  const event = payload.event;
  if (!isSlackMemberJoinedChannelEvent(event)) {
    return;
  }

  // Fail-closed, exactly like every turn: only greet in a channel that has an
  // enabled assignment. The direct-message wildcard must never cause an
  // unsolicited onboarding message in a channel the bot was never configured for.
  const workspaceId = payload.team_id ?? event.team;
  if (!workspaceId) {
    return;
  }
  try {
    const grants = await stores.config.listAgentChannelGrants(workspaceId, event.channel);
    if (!grants.some((grant) => grant.status === 'active')) return;
  } catch {
    return;
  }

  const resolvedBotUserId = execution?.botUserId ??
    await resolveInstallationBotUserId(installedBotUserId, credentials, platformEnv);
  const client = execution?.client ?? (
    credentials.botToken ? createSlackWebClient(credentials.botToken) : undefined
  );
  if (!resolvedBotUserId || event.user !== resolvedBotUserId || !client) return;

  const state = stores.slackState;
  const evtKey = `evt:${payload.event_id}`;
  if (!(await state.claim(evtKey))) {
    return;
  }

  try {
    await client.chat.postMessage({
      channel: event.channel,
      text: renderChannelOnboarding({
        botUserId: resolvedBotUserId,
        channelId: event.channel,
        publicUrl: await resolveSlackPublicUrl(platformEnv),
      }),
    });
  } catch (err) {
    // Best-effort courtesy: log and KEEP the claim so a Slack retry cannot
    // double-post the disclosure. Never rethrow — the events route turns a
    // throw into a 500, which is exactly what makes Slack redeliver the event.
    console.error('[chickpea] channel onboarding post failed:', sanitizeError(err));
  }
}

async function recordInteractionClassifierUsage(input: {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  classification: Awaited<ReturnType<typeof classifySlackInteraction>>;
  requestedModel: string | null;
  surface: AssignmentSurface;
  stores: AppStores;
  platformEnv: PlatformEnv | undefined;
  runId?: string;
}): Promise<void> {
  if (!usageRuntimeRecordingEnabled(input.platformEnv)) return;
  // Deterministic edge rules invoke no provider and therefore create no usage.
  if (!input.classification.result && !input.classification.failed) return;
  const recorder = new InteractionUsageRecorder({
    operationId:
      `classification:${input.turn.workspaceId}:${input.turn.channelId}:${input.turn.eventId}`,
    executionId: `classification-exec:${input.turn.eventId}`,
    startedAt: slackEventTimestampMs(input.turn.messageTs) ?? Date.now(),
    workspaceId: input.turn.workspaceId,
    channelId: input.turn.channelId,
    channelLabel: input.surface === 'direct'
      ? 'Direct message'
      : input.assignment.channelLabel ?? input.turn.channelId,
    conversationKind: input.surface === 'direct' ? 'direct_message' : 'named_channel',
    agentId: input.assignment.agentId,
    agentLabel: input.assignment.agent.name,
    requestedModel: input.requestedModel,
    requesterMembershipId: input.turn.actorMembershipId ?? null,
    executionPrincipalId: input.assignment.agentId,
    ...(input.assignment.modelAttribution
      ? { modelAttribution: input.assignment.modelAttribution }
      : {}),
    credentialRefId: input.assignment.modelCredential?.credentialRefId ?? null,
    credentialVersion: input.assignment.modelCredential?.version ?? null,
    store: input.stores.usage,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.platformEnv ? { platformEnv: input.platformEnv } : {}),
  });
  await recorder.admit();
  const reported = input.classification.result?.reportedUsage;
  const usage = reported &&
    reported.inputTokens !== null &&
    reported.outputTokens !== null &&
    reported.totalTokens !== null
      ? {
        inputTokens: reported.inputTokens,
        outputTokens: reported.outputTokens,
        cacheReadTokens: reported.cacheReadTokens ?? 0,
        cacheWriteTokens: reported.cacheWriteTokens ?? 0,
        totalTokens: reported.totalTokens,
      }
    : null;
  await recorder.recordTerminal({
    status: input.classification.failed ? 'failed' : 'completed',
    usage,
    returnedModel: input.classification.result?.returnedModel ?? null,
    unknownReason: input.classification.failed
      ? 'provider_request_unknown'
      : 'usage_not_reported',
  });
  await recorder.repairAfterTerminal();
}

async function classifyCandidateTurn(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  platformEnv: PlatformEnv | undefined,
  client: ReturnType<typeof createSlackWebClient>,
): Promise<{
  classification: Awaited<ReturnType<typeof classifySlackInteraction>>;
  requestedModel: string | null;
}> {
  const requestedModel = assignment.model ?? null;
  const context = await hydrateSlackContextViaWebClient(
    client,
    turn,
    { maxMessages: 12, maxPages: 2 },
  );
  const classification = await classifySlackInteraction({
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    eventId: turn.eventId,
    text: turn.text,
    source: turn.source,
    guaranteed: false,
    ...(turn.activeWorkAtAdmission === undefined
      ? {}
      : { activeWork: turn.activeWorkAtAdmission }),
    profileInstructions:
      'instructions' in assignment && typeof assignment.instructions === 'string'
        ? assignment.instructions
        : assignment.agent.instructions,
    requestedModel,
    recentContext: context.messages.map((message) => `${message.userId}: ${message.text}`),
    ...(turn.reactionTargetText
      ? { reactionTargetText: turn.reactionTargetText }
      : {}),
  }, platformEnv);
  return { classification, requestedModel };
}

async function resolveReactionTargetContext(
  turn: NormalizedSlackTurn,
  client: ReturnType<typeof createSlackWebClient>,
): Promise<boolean> {
  const targetTs = turn.reactionTargetTs;
  if (!targetTs) return false;
  try {
    const result = await client.reactions.get({
      channel: turn.channelId,
      timestamp: targetTs,
      full: true,
    });
    const message = result.message as
      | { ts?: unknown; thread_ts?: unknown; text?: unknown }
      | undefined;
    const messageTs = typeof message?.ts === 'string' && message.ts
      ? message.ts
      : targetTs;
    const threadTs = typeof message?.thread_ts === 'string' && message.thread_ts
      ? message.thread_ts
      : messageTs;
    if (typeof message?.text !== 'string' || !message.text.trim()) return false;
    turn.threadTs = threadTs;
    turn.reactionTargetText = message.text.trim();
    return true;
  } catch {
    return false;
  }
}

function slackEventTimestampMs(value: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const milliseconds = Math.floor(Number(value) * 1_000);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

// The turn's surface, from the normalizer's authoritative source/channel_type
// (not a channel-id prefix): a DM message ('dm_message'), and any im/mpim
// thread, is 'direct'; everything else is a channel. A group-DM
// app_mention carries no channel_type and falls through to 'channel' — the
// fail-closed default (see surfaceForChannelId for the id ambiguity).
function turnSurface(turn: NormalizedSlackTurn): AssignmentSurface {
  if (turn.source === 'dm_message') {
    return 'direct';
  }
  const channelType = turn.channelType;
  if (channelType === 'im' || channelType === 'mpim') {
    return 'direct';
  }
  return 'channel';
}
