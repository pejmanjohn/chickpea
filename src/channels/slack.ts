// flue-blueprint: channel/slack@1
import {
  createSlackChannel,
  type SlackChannel,
  type SlackChannelOptions,
} from '@flue/slack';
import { createChannelRouter } from '@flue/runtime';

import { withBetterAuthAccessRevoker } from '../auth/better-auth-environment.ts';
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
import { deploymentTenancy, requireInstallationScope } from '../config/installation-scope.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import { createPlatformProductTelemetry } from '../telemetry/platform.ts';
import { createRequestTelemetryLifecycle } from '../telemetry/runtime.ts';
import { surfaceForChannelId, type AssignmentSurface } from '../config/resolver.ts';
import {
  getOrCreateSnapshot,
  getOrReplaceSnapshotForRoute,
} from '../config/snapshot-store.ts';
import {
  getSlackCredentialDependencies,
  getSlackStateStore,
  resolveStores,
  type AppStores,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import {
  tagStateStub,
  type StateRpcResult,
  type TurnJob,
} from '../config/state-rpc.ts';
import type {
  CustomAgentConfig,
  ResolvedAssignment,
} from '../config/types.ts';
import {
  resolveSlackBehaviorSettings,
} from '../slack/behavior-settings.ts';
import {
  mayUseThreadAgent,
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
  shouldResolveSlackManagementApproval,
  slackSteeringCommand,
  type SlackSteeringCommand,
} from '../slack/interaction-intent.ts';
import {
  InteractionUsageRecorder,
  usageRuntimeRecordingEnabled,
} from '../usage/runtime-recorder.ts';
import { parseMemoryCommand } from '../memory/commands.ts';
import { parseRoutineCommand } from '../routines/commands.ts';
import { isRoutineSlackTurn } from '../routines/slack-context.ts';
import {
  readBoundedRequestBody,
  requestWithBufferedBody,
} from '../security/request-body-limit.ts';
import {
  resolveSlackCredentials,
  resolveSlackPublicUrl,
  slackAuthTest,
} from '../slack/credentials.ts';
import {
  readActiveSlackCredentialMetadata,
  resolveSlackInstallationCredentials,
  SlackCredentialRecoveryOnlyError,
  type ResolvedSlackInstallationCredentials,
} from '../slack/installation-credentials.ts';
import {
  hostedSlackAppOf,
  hostedSlackEventRoute,
  hostedSlackInteractionRoute,
  hostedSlackLifecycleOutcome,
  slackInstallationCredentialId,
} from '../slack/hosted-slack-app.ts';
import { recordFirstHostedSlackDelivery } from '../slack/hosted-installation.ts';
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
import {
  slackAgentThreadKey,
  slackConversationKind,
  slackGuestThreadKey,
  slackThreadKey,
} from '../slack/thread-key.ts';
import { normalizeSlackTurn } from '../slack/turn-normalization.ts';
import {
  registerNodeAgentAskDispatcher,
  wakeNodeTurnRelay,
} from '../slack/node-turn-relay.ts';
import { slackSemanticActivityStatusEnabled } from '../slack/semantic-status-flag.ts';
import { hydrateSlackPublicHandoffFallback } from '../slack/web-client-context.ts';
import { hydrateTurnSlackContext } from '../slack/turn-context-reads.ts';
import { createSlackReadGate, sharesSlackAppReadBudget } from '../slack/read-budget.ts';
import {
  assembleRetainedSlackContext,
  reconcileSlackPublicContextMutation,
  recordSlackThreadEventMessage,
  recordAcceptedSlackHumanMessage,
  recordDeliveredSlackAgentMessage,
} from '../slack/public-context.ts';
import {
  selectSlackPresentationOwner,
  slackSessionGenerationFromTimestamp,
  type SlackStateStore,
} from '../slack/claim-store.ts';
import {
  postSteeringReply,
  readSteeringRunFacts,
  slackCheckInReply,
  STEERING_REPLY_TEXT,
  steeringReplyTarget,
  type SteeringReplyTarget,
} from '../slack/steering-replies.ts';
import { turnStopThreadKey } from '../slack/turn-jobs.ts';
import type {
  TurnMidRunReceipt,
  TurnSteeringDecision,
  TurnSteeringInterception,
  TurnSteeringRequest,
  TurnStopSource,
} from '../slack/turn-job-types.ts';
import {
  addSlackReceiptReaction,
  removeSlackReaction,
  slackMidRunReceipt,
} from '../slack/web-client-presenter.ts';
import { createDirectSlackTransport } from '../slack/transport/direct.ts';
import {
  isRetryableDependencyFailure,
  type SlackInboundEnvelope,
  type SlackTransport,
} from '../slack/transport/types.ts';
import { createGatewaySlackTransport } from '../slack/transport/gateway.ts';
import {
  AGENT_ASK_MAX_TARGETS,
  AGENT_ASK_PAUSE_TEXT,
  AGENT_ASK_TURN_LIMIT,
  agentAskOrigin,
  agentSlackHandle,
  isHandedBackTurn,
  mentionedHandleWords,
  type SlackAgentAskRequest,
} from '../slack/agent-asks.ts';
import { GatewayDeploymentClient } from '../slack/gateway/client.ts';
import { createGatewayDeploymentClient } from '../slack/gateway/runtime.ts';
import { createGatewaySlackWebClient, setAgentSessionStatus } from '../slack/gateway/web-client.ts';
import type { GatewayPrivateChannelSetupDelivery } from '../slack/gateway/protocol.ts';
import { AgentPresenceReconciler } from '../slack/agent-presence/reconciler.ts';
import { prepareGeneratedGatewayAgentAvatar } from '../slack/agent-presence/gateway-avatar.ts';
import { requireAgentChannelPublication } from '../auth/permissions.ts';
import { PrivateChannelSetupError, PrivateChannelSetupService } from '../slack/private-channel-setup-service.ts';
import {
  parsePrivateChannelSetupAction,
  privateChannelSetupCard,
  privateChannelSetupRecoveryText,
  privateChannelSetupUnavailableText,
  type PrivateChannelSetupAction,
} from '../slack/private-channel-setup.ts';
import { selectSlackExecutionAuthority } from '../work/authority.ts';
import { opaqueId } from '../work/admission.ts';
import { EGRESS_SETTING_KEY, parseEgressPolicy } from '../config/egress.ts';
import {
  isSlackMemberJoinedChannelEvent,
  parseSlackAgentSessionStopped,
  type NormalizedSlackTurn,
  type SlackEventFixture,
  type SlackMessageEvent,
  type SlackStopButtonPress,
} from '../slack/types.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import { emitManagementMetric } from '../management/telemetry.ts';
import { resolveHostSlackManagementApproval } from '../management/slack-approval.ts';
import { admitSlackBrowserActionReply } from '../slack/browser-action-admission.ts';
import {
  authorizeUiResponse,
  uiRefusalText,
  type SlackUiAdmission,
  type UiRefusal,
} from '../slack/ui/authorize.ts';
import {
  microsecondSlackTs,
  parseSlackUiBlockAction,
  parseSlackUiViewSubmission,
  type SlackUiAction,
  type SlackUiViewSubmission,
} from '../slack/ui/interaction-payload.ts';
import {
  isModalControl,
  modalForClick,
  readViewSubmission,
  surfaceMayAnswer,
  viewSubmissionSurfaceId,
} from '../slack/ui/modals.ts';
import {
  encodeFormValues,
  formErrorsText,
  formLayout,
  parseFormValues,
  readFormSubmission,
} from '../slack/ui/render-form.ts';
import { approvalChoice, uiResponseTurnText, type RenderedUiSurface } from '../slack/ui/render.ts';
import {
  interactiveAnswer,
  QUESTION_OTHER_CHOICE,
  type InteractiveAnswer,
} from '../slack/ui/render-interactive.ts';
import {
  redrawUiSurface,
  retireApprovalSurfacesForTypedAnswer,
  uiSurfaceRecord,
} from '../slack/ui/host-surfaces.ts';
import { parseUiControl, type UiSurfaceRecord } from '../slack/ui/surface.ts';
import type {
  GatewayUiActionDelivery,
  GatewayViewSubmissionDelivery,
} from '../slack/gateway/protocol.ts';
import {
  agentAvatarInstallation,
  agentAvatarUrlForPresentation,
  refreshLegacyAgentAvatar,
} from '../slack/agent-presence/avatar-assets.ts';
import { initialActivityStatus } from '../activity/status.ts';

export const MAX_SLACK_INGRESS_BYTES = 1_048_576;

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
  key = credentialRevision ?? 'current',
): SlackChannel {
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
  const ingress = await readSlackIngressBody(c.req.raw);
  if (!ingress.ok) {
    return c.json(
      { error: ingress.status === 413 ? 'request_too_large' : 'invalid_request' },
      ingress.status,
    );
  }
  c.req.raw = requestWithBufferedBody(c.req.raw, ingress.body);
  const rawBody = new TextDecoder().decode(ingress.body);
  const signature = c.req.header('x-slack-signature') ?? '';
  const timestamp = c.req.header('x-slack-request-timestamp') ?? '';
  const verification = await slackDeliveryVerification(platformEnv);
  if (!verification) {
    return c.json({ error: 'slack_not_configured' }, 401);
  }
  const route = channelForInstallation(
    verification.signingSecret,
    verification.credentialRevision,
    verification.cacheKey,
  ).routes.find((candidate) => candidate.path === '/events');
  if (!route) throw new Error('Slack channel lost its /events route');
  const response = await route.handler(c, next);
  // A hosted app's Request URL is verified once, at the app; no installation
  // waits on a per-install Events URL proof.
  if (verification.hosted) return response;
  if (response.ok && isSlackUrlVerification(rawBody)) {
    const recorded = await recordPendingSlackChallenge(
      resolveStores(platformEnv).settings,
      { rawBody, signature, timestamp },
    );
    // Slack allows the challenge three seconds, and a cold state store can
    // take most of that. The recorded envelope is the proof, so answer now
    // and promote the pending install past the response; the setup page's
    // Events check finishes it from the same envelope if this is cut short.
    if (recorded.accepted) {
      const stores = resolveStores(platformEnv);
      detach(c, finalizePendingWorkspaceInstallation(
        stores,
        platformEnv,
        createPlatformProductTelemetry({
          ...(platformEnv ? { env: platformEnv } : {}),
          settings: stores.settings,
          config: stores.config,
          lifecycle: createRequestTelemetryLifecycle(c),
        }),
      ));
    }
  }
  return response;
};

/**
 * The signing secret a delivery must carry, and the bot credential revision
 * its handlers act for. Standalone: both from the customer-owned app's
 * bundle. Installation tenancy: the host's app alone, the same for every
 * installation, so nothing is read before the signature is checked; the
 * handlers read the installation's own state once it is.
 */
async function slackDeliveryVerification(
  platformEnv: PlatformEnv | undefined,
): Promise<{
  signingSecret: string;
  credentialRevision: string | null;
  cacheKey: string;
  hosted: boolean;
} | undefined> {
  if (requireInstallationScope(platformEnv)) {
    const app = hostedSlackAppOf(platformEnv);
    return app
      ? { signingSecret: app.signingSecret, credentialRevision: null, cacheKey: `hosted:${app.appId}`, hosted: true }
      : undefined;
  }
  const credentials = await resolveSlackInstallationCredentials(
    slackInstallationCredentialId(platformEnv),
    platformEnv,
  );
  return credentials.signingSecret
    ? {
        signingSecret: credentials.signingSecret,
        credentialRevision: credentials.connectionRevision,
        cacheKey: credentials.connectionRevision ?? 'current',
        hosted: false,
      }
    : undefined;
}

async function readSlackIngressBody(
  request: Request,
): Promise<
  | { ok: true; body: Uint8Array }
  | { ok: false; status: 400 | 413 }
> {
  const result = await readBoundedRequestBody(request, MAX_SLACK_INGRESS_BYTES);
  if (result.ok) return { ok: true, body: result.body ?? new Uint8Array() };
  return {
    ok: false,
    status: result.reason === 'body_too_large' ? 413 : 400,
  };
}

async function finalizePendingWorkspaceInstallation(
  stores: AppStores,
  platformEnv: PlatformEnv | undefined,
  productTelemetry?: ProductTelemetryCapture,
): Promise<void> {
  try {
    const setup = await stores.identity.getSlackSetupTransaction('setup_default');
    if (setup?.state !== 'bot_install_pending') return;
    await new SlackInstallOAuthService({
      identity: stores.identity,
      credentials: getSlackCredentialDependencies(platformEnv),
      config: stores.config,
      settings: stores.settings,
      ...(productTelemetry ? { productTelemetry } : {}),
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
  const verification = await slackDeliveryVerification(platformEnv);
  if (!verification) {
    return c.json({ error: 'slack_not_configured' }, 401);
  }
  const route = channelForInstallation(
    verification.signingSecret,
    verification.credentialRevision,
    verification.cacheKey,
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
    const hosted = deploymentTenancy(platformEnv) === 'installation';
    // A host's delivery must be for its app, and for the workspace whose
    // installation received it (hostedSlackEventRoute), before any record.
    if (hosted && (payload.api_app_id !== hostedSlackAppOf(platformEnv)?.appId ||
        hostedSlackEventRoute(payload).route !== 'installation')) return;
    const stores = resolveStores(platformEnv);
    const installation = await stores.config.getWorkspaceInstallation(payload.team_id);
    if (
      !installation || installation.transportMode !== 'direct' ||
      installation.health === 'revoked' ||
      (installation.appId && installation.appId !== payload.api_app_id) ||
      (hosted && !installation.appId)
    ) return;

    const verifiedEventType = payload.type === 'event_callback' &&
        payload.event && typeof payload.event === 'object'
      ? (payload.event as { type?: unknown }).type
      : undefined;
    if (verifiedEventType === 'app_uninstalled' || verifiedEventType === 'tokens_revoked') {
      // Hosted, only the installation's own bot token ends it, and an event
      // from before this installation is about an earlier one. The host acts
      // on these first (and ends the installation); this is the record's half.
      if (hosted && hostedSlackLifecycleOutcome(payload, {
        installedAt: installation.createdAt,
        botUserId: installation.botUserId,
      }) !== 'end') return;
      await markSlackInstallationEnded(stores.config, installation.workspaceId, verifiedEventType);
      return;
    }
    if (hosted && payload.type === 'event_callback') {
      await recordFirstHostedSlackDelivery(stores.config, installation);
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

    const credentials = await directSlackCredentials(c, platformEnv);
    if (credentials instanceof Response) return credentials;
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
    // Slack's Stop button; the SDK's event union predates it.
    if (verifiedEventType === 'agent_session_stopped') {
      detach(
        c,
        processSlackStopButton(payload as unknown as SlackEventFixture, platformEnv).catch((error) => {
          console.error('[chickpea] Slack Stop button intake failed:', sanitizeError(error));
        }),
      );
      return;
    }
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
    if (deploymentTenancy(c.env as PlatformEnv | undefined) === 'installation' &&
        !await admitHostedSlackInteraction(payload, c.env as PlatformEnv | undefined)) return;
    const uiAction = parseSlackUiBlockAction(payload);
    // A modal opens now, inside Slack's three-second trigger window; a click
    // that cannot open one goes on to ordinary admission, which says why.
    if (uiAction && isModalControl(parseUiControl(uiAction)) &&
        await openDirectSlackUiModal(uiAction, payload.api_app_id ?? '', c.env as PlatformEnv | undefined)) {
      return;
    }
    if (uiAction) {
      detach(c, processDirectSlackUiAction(
        uiAction, payload.api_app_id ?? '', c.env as PlatformEnv | undefined,
      ).catch((error) => {
        console.error('[chickpea] Slack click failed:', sanitizeError(error));
      }));
      return;
    }
    const submission = parseSlackUiViewSubmission(payload);
    if (submission) {
      return receiveDirectSlackUiViewSubmission(
        c, submission, payload.api_app_id ?? '', c.env as PlatformEnv | undefined,
      );
    }
    const setupAction = parsePrivateChannelSetupAction(payload);
    if (setupAction) {
      detach(c, processDirectPrivateChannelSetup(
        setupAction, payload.api_app_id, c.env as PlatformEnv | undefined,
      ).catch((error) => {
        console.error('[chickpea] private Channel setup action failed:', sanitizeError(error));
      }));
      return;
    }
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
    const credentials = await directSlackCredentials(c, platformEnv);
    if (credentials instanceof Response) return credentials;
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

/**
 * The installation's Slack credentials for a direct delivery. A hosted bundle
 * that latches recovery on this read is answered as the app's recovery gate
 * answers every later request, not found, rather than as a server error; a
 * keyring that will not load stays a server error, transient for Slack to
 * retry. Standalone throws as before.
 */
async function directSlackCredentials(
  c: { notFound(): Response | Promise<Response> },
  platformEnv: PlatformEnv | undefined,
): Promise<ResolvedSlackInstallationCredentials | Response> {
  try {
    return await resolveSlackInstallationCredentials(slackInstallationCredentialId(platformEnv), platformEnv);
  } catch (error) {
    if (error instanceof SlackCredentialRecoveryOnlyError && deploymentTenancy(platformEnv) === 'installation') {
      return await c.notFound();
    }
    throw error;
  }
}

/**
 * A host's interaction is for its app and for a direct installation of the
 * signed team in this store; the first one marks the installation's events
 * as arriving. Every handler below checks its own installation again.
 */
async function admitHostedSlackInteraction(
  payload: { api_app_id?: string },
  platformEnv: PlatformEnv | undefined,
): Promise<boolean> {
  const route = hostedSlackInteractionRoute(payload);
  if (route.route !== 'installation' || payload.api_app_id !== hostedSlackAppOf(platformEnv)?.appId) {
    return false;
  }
  const config = resolveStores(platformEnv).config;
  const installation = await config.getWorkspaceInstallation(route.teamId);
  if (!installation || installation.transportMode !== 'direct' || installation.health === 'revoked' ||
      installation.appId !== payload.api_app_id) return false;
  await recordFirstHostedSlackDelivery(config, installation);
  return true;
}
export interface ResolvedAgentRoutingActor {
  requesterTimezone?: string;
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
    ...(member.timezone ? { requesterTimezone: member.timezone } : {}),
  };
}

export async function claimChickpeaIntroductionForAgentInteraction(input: {
  actor: ResolvedAgentRoutingActor;
  workspaceId: string;
  slackUserId: string;
  management: Pick<AppStores['management'], 'claimIntroduction'>;
}): Promise<void> {
  if (!input.actor.principal) return;
  await input.management.claimIntroduction({
    organizationId: input.actor.principal.organizationId,
    userId: input.actor.principal.userId,
    workspaceId: input.workspaceId,
    slackUserId: input.slackUserId,
    trigger: 'first_interaction',
    at: Date.now(),
  }).catch((error) => {
    console.warn('[chickpea] Slack introduction claim failed:', sanitizeError(error));
  });
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
  // Without an avatar URL the Agent's replies come from the app itself
  // (selectSlackPresentationOwner), so the starter does too.
  if (!avatarUrl) {
    console.warn('[chickpea] App Home starter posted as the app: the Agent avatar URL is unavailable');
  }
  const dm = await input.transport.openDirectConversation(input.userId);
  const root = await input.transport.postMessage({
    channelId: dm.id,
    text: agentAppHomeStarterMessage(agent.name),
    ...(avatarUrl ? { persona: { name: agent.name, avatarUrl } } : {}),
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
  const installationId = agentAvatarInstallation(platformEnv);
  if (agent.slackPresence?.avatar.url && !installationId) return agent.slackPresence.avatar.url;
  // Every admitted turn and App Home seed passes here first, with the
  // request's (or the state store's local) stores: the one backfill point.
  const origin = await resolveSlackPublicUrl(platformEnv, stores.settings, stores.identity);
  return agentAvatarUrlForPresentation(agent, origin, installationId);
}

export async function postAgentRoutingFeedback(input: {
  turn: NormalizedSlackTurn;
  surface: AssignmentSurface;
  result: Extract<AgentRoutingResult, { kind: 'denied' }>;
  client: ReturnType<typeof createSlackWebClient>;
}): Promise<void> {
  const alternatives = input.result.alternatives.length > 0
    ? ` Available here: ${input.result.alternatives.map(({ handle }) => `@${handle}`).join(', ')}.`
    : '';
  const text = input.result.reason === 'temporarily_unavailable'
    ? 'That Agent address could not be verified right now. Try again.'
    : input.result.reason === 'several_agents'
      ? 'Mention one Agent at a time here.'
      : `That Agent is not available here.${alternatives}`;
  if (input.surface === 'channel') {
    // Explicit base-app and Agent-handle mentions receive a private denial.
    // Ambient roots remain silent, and a denied Agent never becomes visible
    // through the alternatives list.
    const explicitAgentMention = input.turn.source === 'agent_mention' ||
      (input.turn.source === 'implicit_thread_reply' &&
        parseAgentUserGroupMentions(input.turn.text).length > 0);
    if (
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
  if (payload.event.type !== 'user_change') return;
  // A host's app verified it, so it is checked against the installation's
  // current bot; standalone, against the bundle whose secret verified it.
  const revision = hostedSlackAppOf(platformEnv)
    ? (await readActiveSlackCredentialMetadata(slackInstallationCredentialId(platformEnv), platformEnv))?.revision
    : credentialRevision;
  if (!revision) return;
  const change = {
    identity: stores.identity,
    credentialIdentityId: slackInstallationCredentialId(platformEnv),
    credentialRevision: revision,
    payloadTeamId: payload.team_id,
    apiAppId: payload.api_app_id,
    eventId: payload.event_id,
    event: payload.event,
  };
  await withBetterAuthAccessRevoker({
    control: await stores.identity.getAuthControl(),
    platformEnv,
  }, (betterAuth) => applySlackUserChange({ ...change, ...(betterAuth ? { betterAuth } : {}) }));
}

/**
 * Marks a workspace's installation record revoked after Slack uninstalled the
 * app or revoked its token, once: a record already revoked is left as it is.
 * Every Slack path drops a revoked record's events and clicks. A host that
 * ends an installation calls this with the installation's config store.
 */
export async function markSlackInstallationEnded(
  config: Pick<ConfigStore, 'getWorkspaceInstallation' | 'updateWorkspaceInstallation'>,
  workspaceId: string,
  reason: 'app_uninstalled' | 'tokens_revoked',
): Promise<void> {
  const current = await config.getWorkspaceInstallation(workspaceId);
  if (!current || current.health === 'revoked') return;
  try {
    await config.updateWorkspaceInstallation(
      workspaceId,
      { health: 'revoked', healthDetail: reason },
      current.revision,
    );
  } catch {
    const latest = await config.getWorkspaceInstallation(workspaceId);
    if (!latest || latest.health === 'revoked') return;
    await config.updateWorkspaceInstallation(
      workspaceId,
      { health: 'revoked', healthDetail: reason },
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
  /** A durable upstream inbox owns retry when local turn persistence fails. */
  durableIngress?: boolean;
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
    enqueueTurn?(job: TurnJob): Promise<StateRpcResult<null>>;
    durableIngress?: boolean;
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
    await markSlackInstallationEnded(stores.config, envelope.workspaceId, envelope.event.type);
    return 'accepted';
  }
  if (envelope.event.type === 'agent_session_stopped') {
    await processSlackStopButton(payload, platformEnv, {
      transport,
      client,
      botUserId: installation.botUserId,
      stores,
    });
    return 'accepted';
  }
  if (envelope.event.type === 'user_change') {
    const change = {
      identity: stores.identity,
      payloadTeamId: envelope.workspaceId,
      apiAppId: installation.appId,
      eventId: envelope.eventId,
      event: envelope.event,
    };
    await withBetterAuthAccessRevoker({
      control: await stores.identity.getAuthControl(),
      platformEnv,
    }, (betterAuth) => applyGatewaySlackUserChange({ ...change, ...(betterAuth ? { betterAuth } : {}) }));
    return 'accepted';
  }
  await processSlackEvent(payload, platformEnv, {
    transport,
    client,
    botUserId: installation.botUserId,
    stores,
    ...(providedExecution?.enqueueTurn ? { enqueueTurn: providedExecution.enqueueTurn } : {}),
    ...(providedExecution?.durableIngress ? { durableIngress: true } : {}),
  });
  return 'accepted';
}

// The Node relay runs turns in this process and admits their asks here.
registerNodeAgentAskDispatcher(processSlackAgentAsks);

/**
 * A turn the host addressed to an Agent: an ask, or one of the later Agents
 * a person's message mentioned. Admitted like a person's message, minus
 * everything only a person's own words may do.
 */
interface SlackAgentAskAdmission {
  /** Built by the host: from the asking Agent's delivered message, or from the person's. */
  turn: NormalizedSlackTurn;
  targetAgentId: string;
  /**
   * The queue of the host that admits the ask, when that host runs inside
   * the state store: it must never enqueue through its own stub.
   */
  enqueueTurn?: SlackEventExecution['enqueueTurn'];
  /**
   * The exchange used every ask it may: pause it, once, in the thread.
   * Only an ask can reach the limit.
   */
  onLimitReached?(client: ReturnType<typeof createSlackWebClient>): Promise<void>;
}

/** Attempts of one host-addressed turn's admission when a dependency fails transiently. */
const AGENT_ASK_ADMISSION_ATTEMPTS = 3;

/**
 * Admit the asks one delivered Agent reply made: each Agent whose handle it
 * mentions (at most AGENT_ASK_MAX_TARGETS, in order, never the asker) gets a
 * turn in the same thread. Each turn is admitted like a person's message in
 * that thread, with that person's access, except that no human-only command
 * (approve, stop, check-in, memory) can come from it and it never takes the
 * thread over. A guest's answer that asks nobody, in a chain the thread's
 * own Agent started, is handed back to that Agent the same way, so it can
 * finish the person's request (or stay silent). Only the thread's own Agent
 * is handed answers, and its own reply hands nothing back, so this never
 * loops. Runs where the asking turn ran; failures are logged.
 */
export async function processSlackAgentAsks(
  request: SlackAgentAskRequest,
  platformEnv?: PlatformEnv,
  provided?: {
    stores?: AppStores;
    gatewayClient?: GatewayDeploymentClient;
    enqueueTurn?: SlackEventExecution['enqueueTurn'];
  },
): Promise<void> {
  const stores = provided?.stores ?? resolveStores(platformEnv);
  const { turn: asking } = request;
  const installation = await stores.config.getWorkspaceInstallation(asking.workspaceId);
  if (
    !installation || installation.health === 'revoked' ||
    installation.runtimeContract !== 'chickpea-v1'
  ) return;
  const agents = await stores.config.listAgents();
  const from = agents.find((agent) => agent.id === request.fromAgentId);
  if (!from) return;
  const byHandle = new Map<string, CustomAgentConfig>();
  for (const agent of agents) {
    const handle = agentSlackHandle(agent)?.handle;
    if (agent.kind === 'user' && handle) byHandle.set(handle, agent);
  }
  const targets: Array<{ agent: CustomAgentConfig; delivery: SlackAgentAskRequest['deliveries'][number] }> = [];
  for (const delivery of request.deliveries) {
    for (const word of mentionedHandleWords(delivery.text)) {
      const agent = byHandle.get(word);
      if (!agent || agent.id === from.id || targets.some((target) => target.agent.id === agent.id)) continue;
      if (targets.length < AGENT_ASK_MAX_TARGETS) targets.push({ agent, delivery });
    }
  }
  // The thread's own Agent, if it started this chain: asks made here carry it,
  // and a guest's answer that asks nobody goes back to it. One that mentions
  // an Agent is a report or a further ask, whose answer comes back later.
  const threadOwnerAgentId = request.fromThreadOwner ? from.id : asking.agentAsk?.threadOwnerAgentId;
  let handedBack = false;
  if (targets.length === 0 && request.answer && threadOwnerAgentId) {
    const owner = agents.find((agent) => agent.id === threadOwnerAgentId);
    if (owner) {
      targets.push({ agent: owner, delivery: request.answer });
      handedBack = true;
    }
  }
  if (targets.length === 0) return;

  let execution: SlackEventExecution | undefined;
  if (installation.transportMode === 'gateway') {
    if (!installation.gatewayBindingId || !installation.appId || !installation.botUserId) return;
    const gateway = provided?.gatewayClient ?? createGatewayDeploymentClient(platformEnv);
    const binding = await gateway.loadBinding();
    if (
      !binding || binding.bindingId !== installation.gatewayBindingId ||
      binding.workspaceId !== asking.workspaceId || binding.appId !== installation.appId ||
      binding.botUserId !== installation.botUserId
    ) return;
    execution = {
      transport: createGatewaySlackTransport(gateway),
      client: createGatewaySlackWebClient(gateway),
      botUserId: installation.botUserId,
      stores,
      ...(provided?.enqueueTurn ? { enqueueTurn: provided.enqueueTurn } : {}),
    };
  }
  const originMessageTs = agentAskOrigin(asking);
  const fromHandle = agentSlackHandle(from)?.handle;
  for (const { agent, delivery } of targets) {
    const turn: NormalizedSlackTurn = {
      workspaceId: asking.workspaceId,
      channelId: asking.channelId,
      eventId: `agent-ask:${asking.channelId}:${delivery.messageTs}:${agent.id}`,
      text: delivery.text,
      userId: asking.userId,
      messageTs: delivery.messageTs,
      threadTs: asking.threadTs,
      source: 'agent_mention',
      contextMode: 'thread',
      ...(asking.channelType ? { channelType: asking.channelType } : {}),
      ...(asking.requesterTimezone ? { requesterTimezone: asking.requesterTimezone } : {}),
      agentAsk: {
        fromAgentId: from.id,
        fromAgentName: from.name,
        ...(fromHandle ? { fromAgentHandle: fromHandle } : {}),
        originMessageTs,
        ...(handedBack
          ? { handedBack: true as const }
          : threadOwnerAgentId ? { threadOwnerAgentId } : {}),
      },
    };
    const payload: SlackEventFixture = {
      token: '',
      team_id: asking.workspaceId,
      api_app_id: installation.appId ?? '',
      event_id: turn.eventId,
      event_time: Math.floor(Number(delivery.messageTs)) || 0,
      type: 'event_callback',
      event: {
        type: 'message',
        channel: asking.channelId,
        ts: delivery.messageTs,
        thread_ts: asking.threadTs,
        user: asking.userId,
        text: delivery.text,
        ...(asking.channelType ? { channel_type: asking.channelType } : {}),
      },
    };
    const admission: SlackAgentAskAdmission = {
      turn,
      targetAgentId: agent.id,
      ...(provided?.enqueueTurn ? { enqueueTurn: provided.enqueueTurn } : {}),
      // A handed-back answer at the limit asked nobody: no pause to announce.
      ...(handedBack ? {} : {
        onLimitReached: (client: ReturnType<typeof createSlackWebClient>) => postAgentAskPause({
          client,
          stores,
          platformEnv,
          turn,
          from,
          originMessageTs,
        }),
      }),
    };
    await admitHostAddressedTurn(payload, platformEnv, execution, admission);
  }
}

/**
 * Admit one turn the host addressed to an Agent (an ask, or one of several
 * Agents a person mentioned), retrying a dependency that fails transiently.
 * Its claims were given back on failure, so a retry may admit it again.
 */
async function admitHostAddressedTurn(
  payload: SlackEventFixture,
  platformEnv: PlatformEnv | undefined,
  execution: SlackEventExecution | undefined,
  admission: SlackAgentAskAdmission,
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await processSlackEvent(payload, platformEnv, execution, undefined, admission);
      return;
    } catch (error) {
      const retryable = error instanceof SlackDurableEnqueueError || isRetryableDependencyFailure(error);
      if (!retryable || attempt >= AGENT_ASK_ADMISSION_ATTEMPTS) {
        console.error('[chickpea] agent turn was not admitted:', sanitizeError(error));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
    }
  }
}

/**
 * The other Agents one person's message mentioned, admitted after the first
 * one took the thread: each gets its own turn on that message in the same
 * thread queue, in mention order, so each answers after the one before it
 * and sees its reply. They are guests, as when asked; the message's
 * human-only commands stay with the first Agent's turn.
 */
async function admitCoAddressedTurns(input: {
  payload: SlackEventFixture;
  turn: NormalizedSlackTurn;
  platformEnv: PlatformEnv | undefined;
  execution: SlackEventExecution | undefined;
}): Promise<void> {
  const { turn } = input;
  const addressed = turn.coAddressed;
  // Only the first Agent's turn admits the others; theirs never fan out again.
  if (addressed?.position !== 0) return;
  for (const [position, agent] of addressed.agents.entries()) {
    if (position === 0) continue;
    // Copied field by field: by now admission has stamped the first turn with
    // what only it may carry (an approval, a click, its interaction intent).
    const coTurn: NormalizedSlackTurn = {
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      eventId: `co-addressed:${turn.channelId}:${turn.messageTs}:${agent.agentId}`,
      text: turn.text,
      userId: turn.userId,
      messageTs: turn.messageTs,
      threadTs: turn.threadTs,
      source: turn.source,
      contextMode: 'thread',
      ...(turn.channelType ? { channelType: turn.channelType } : {}),
      ...(turn.requesterTimezone ? { requesterTimezone: turn.requesterTimezone } : {}),
      ...(turn.attachments?.length ? { attachments: turn.attachments } : {}),
      ...(turn.attachmentIntake ? { attachmentIntake: turn.attachmentIntake } : {}),
      coAddressed: { agents: addressed.agents, position },
    };
    await admitHostAddressedTurn(
      { ...input.payload, event_id: coTurn.eventId },
      input.platformEnv,
      input.execution,
      { turn: coTurn, targetAgentId: agent.agentId },
    );
  }
}

/**
 * The exchange of asks one person's message started reached its limit: the
 * asking Agent says it is pausing, once per exchange, and the thread waits
 * for a person. The note enters the thread record like any Agent reply.
 */
async function postAgentAskPause(input: {
  client: ReturnType<typeof createSlackWebClient>;
  stores: AppStores;
  platformEnv: PlatformEnv | undefined;
  turn: NormalizedSlackTurn;
  from: CustomAgentConfig;
  originMessageTs: string;
}): Promise<void> {
  const { turn, from } = input;
  const key = `agent-ask-pause:${turn.workspaceId}:${turn.channelId}:${turn.threadTs}:${input.originMessageTs}`;
  if (!(await input.stores.slackState.claim(key))) return;
  console.info('[chickpea] agent ask limit reached; exchange paused');
  let posted: Awaited<ReturnType<typeof input.client.chat.postMessage>>;
  try {
    const avatarUrl = await resolvedAgentAvatarUrl(from, input.stores, input.platformEnv);
    posted = await input.client.chat.postMessage({
      channel: turn.channelId,
      thread_ts: turn.threadTs,
      text: AGENT_ASK_PAUSE_TEXT,
      username: from.name,
      ...(avatarUrl ? { icon_url: avatarUrl } : {}),
    });
  } catch (error) {
    // The note was not posted: give the claim back so the exchange's next
    // refused ask says so. A post Slack accepted but did not acknowledge may
    // then be said twice; a paused exchange nobody can see is worse.
    await input.stores.slackState.release(key).catch(() => undefined);
    throw error;
  }
  if (typeof posted.ts === 'string' && posted.ts) {
    await recordDeliveredSlackAgentMessage(
      input.stores.config,
      turn,
      { runtimeContract: 'chickpea-v1', agentId: from.id },
      { messageTs: posted.ts, text: AGENT_ASK_PAUSE_TEXT },
    ).catch(() => undefined);
  }
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
    !installation.appId || !installation.botUserId || !installation.gatewayBindingId
  ) return 'rejected';
  const gateway = providedClient ?? createGatewayDeploymentClient(platformEnv);
  const binding = await gateway.loadBinding();
  if (!binding || binding.bindingId !== installation.gatewayBindingId ||
      binding.workspaceId !== selection.workspaceId ||
      binding.appId !== installation.appId ||
      binding.botUserId !== installation.botUserId) return 'rejected';
  await seedAgentAppHomeThread({
    ...selection,
    stores,
    transport: createGatewaySlackTransport(gateway),
    botUserId: installation.botUserId,
  });
  return 'accepted';
}

/** The normalized action still needs the Worker's current installation binding. */
export async function processGatewayPrivateChannelSetup(
  action: GatewayPrivateChannelSetupDelivery,
  platformEnv?: PlatformEnv,
  providedClient?: GatewayDeploymentClient,
  providedStores?: AppStores,
): Promise<'accepted' | 'rejected'> {
  const stores = providedStores ?? resolveStores(platformEnv);
  const installation = await stores.config.getWorkspaceInstallation(action.workspaceId);
  if (!installation || installation.transportMode !== 'gateway' ||
      installation.health === 'revoked' || !installation.botUserId || !installation.appId ||
      !installation.gatewayBindingId || installation.gatewayBindingId !== action.bindingId) {
    return 'rejected';
  }
  const gateway = providedClient ?? createGatewayDeploymentClient(platformEnv);
  const binding = await gateway.loadBinding();
  if (!binding || binding.bindingId !== action.bindingId ||
      binding.workspaceId !== action.workspaceId || binding.appId !== installation.appId ||
      binding.botUserId !== installation.botUserId) return 'rejected';
  await completePrivateChannelSetupAction(action, {
    stores,
    transport: createGatewaySlackTransport(gateway),
    client: createGatewaySlackWebClient(gateway),
    botUserId: installation.botUserId,
    ...(platformEnv ? { platformEnv } : {}),
    gateway,
  });
  return 'accepted';
}

type SlackUiClient = ReturnType<typeof createSlackWebClient>;

interface SlackUiContext {
  appId: string;
  platformEnv: PlatformEnv | undefined;
  stores: AppStores;
  client: SlackUiClient;
  execution?: SlackEventExecution;
  /** The app's own bot user: never a person someone can pick. */
  botUserId?: string;
}

type UiSurfaceState = Required<Pick<SlackStateStore, 'executeUiSurface'>>;

/** A private notice to the person who clicked or submitted, in the card's thread. */
async function sendUiNotice(
  client: SlackUiClient,
  input: { channelId: string | null; userId: string; text: string; threadTs?: string },
): Promise<void> {
  if (!input.channelId) return;
  await client.chat.postEphemeral({
    channel: input.channelId,
    user: input.userId,
    text: input.text,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
  }).catch(() => {
    console.warn('[chickpea] Slack click notice was not delivered');
  });
}

/**
 * A click on a host-namespace control. It resolves against the durable
 * surface, passes the same admission gate as a typed message from the
 * clicker, claims the surface first-wins together with its TurnJob, and then
 * redraws the card from stored state. Refusals are private to the clicker and
 * never consume the control.
 */
async function handleSlackUiAction(input: SlackUiContext & { action: SlackUiAction }): Promise<void> {
  const { action, stores, client } = input;
  const control = parseUiControl(action);
  // Link buttons also send block_actions, and so does choosing a value in a
  // form's field (in a message or a modal); only Submit answers a form.
  if (!control || control.kind === 'link' || control.kind === 'field') return;
  if (!stores.slackState.executeUiSurface) return;
  const state = stores.slackState as UiSurfaceState;
  const refuse = async (refusal: UiRefusal, surface?: UiSurfaceRecord) => {
    emitUiInteraction('refused', refusal);
    await sendUiNotice(client, {
      channelId: action.channelId,
      userId: action.userId,
      text: uiRefusalText(refusal, surface),
      ...(surface?.threadTs ? { threadTs: surface.threadTs } : {}),
    });
  };
  emitUiInteraction('received');

  let surface = await uiSurfaceRecord(state, { kind: 'get_surface', id: control.surfaceId });
  if (!surface) return refuse('closed');
  if (surface.namespace !== control.namespace || surface.workspaceId !== action.workspaceId) {
    console.warn('[chickpea] Slack click refused: namespace_or_workspace_mismatch');
    return refuse('unavailable');
  }
  if (action.containerType !== 'message' || action.isEphemeral ||
      action.channelId !== surface.channelId || !action.messageTs ||
      (surface.messageTs && surface.messageTs !== action.messageTs)) {
    return refuse('unavailable');
  }
  const messenger = surfaceMessenger(client, surface.channelId);
  const redraw = (next: UiSurfaceRecord | undefined) => redrawUiSurface(messenger, next);
  if (!surface.messageTs) {
    surface = await uiSurfaceRecord(state, {
      kind: 'bind_surface_message', id: surface.id, messageTs: action.messageTs,
    }) ?? surface;
  }
  if (surface.status === 'resolved') {
    await redraw(surface);
    return refuse('answered', surface);
  }
  if (surface.status !== 'open' && surface.status !== 'pending_delivery') {
    await redraw(surface);
    return refuse('closed', surface);
  }
  if (surface.expiresAt <= Date.now()) {
    await redraw(await uiSurfaceRecord(state, { kind: 'close_surface', id: surface.id, status: 'expired' }));
    return refuse('closed', surface);
  }
  // A modal control is answered when Slack's request arrives; one that gets
  // here could not open its modal for this person.
  if (isModalControl(control)) {
    return refuse(surfaceMayAnswer(surface, action.userId) ? 'unavailable' : 'wrong_user', surface);
  }
  let answer: InteractiveAnswer | undefined;
  const spec = surface.spec;
  if (spec.kind === 'approval') {
    if (control.valueIndex === undefined) return refuse('unavailable', surface);
    answer = { choice: control.valueIndex };
  } else if (spec.kind === 'form') {
    if (control.kind !== 'form_submit' || formLayout(spec.form) !== 'inline') return refuse('unavailable', surface);
    const read = readFormSubmission(surface, spec.form, action.state);
    if (!read.ok) {
      emitUiInteraction('refused', 'unavailable');
      return sendUiNotice(client, {
        channelId: action.channelId,
        userId: action.userId,
        text: formErrorsText(surface, spec.form, read.errors),
        threadTs: surface.threadTs,
      });
    }
    answer = { choice: 0, values: encodeFormValues(read.values) };
  } else {
    // Ticking a checkbox or choosing in a picker before Submit also sends
    // block_actions; only a complete answer goes on, and nothing is consumed.
    answer = interactiveAnswer(surface, control, action);
    if (!answer) return;
  }
  // A picked bot user would also read as an @mention of the app.
  if (input.botUserId && answerPicksUser(surface, answer, input.botUserId)) return refuse('unavailable', surface);
  const messageTs = microsecondSlackTs(action.actionTs);
  if (!messageTs) return refuse('unavailable', surface);
  const outcome = await admitUiAnswer(input, { surface, answer, userId: action.userId, messageTs });
  const current = await uiSurfaceRecord(state, { kind: 'get_surface', id: surface.id }) ?? surface;
  if (outcome === 'admitted') {
    emitUiInteraction('resolved');
    // Cancel retires the proposal, so a later typed "approve" cannot apply
    // what the card now shows as cancelled. Only the claimed click gets here.
    if (spec.kind === 'approval' && spec.approval === 'workspace_change' &&
        approvalChoice(answer.choice) === 'decline') {
      await stores.management.markChangeSetProposalStale(spec.proposalId, Date.now()).catch(() => {
        console.warn('[chickpea] cancelled proposal could not be retired');
      });
    }
    await redraw(current);
    return;
  }
  if (outcome === 'not_current') {
    await redraw(await uiSurfaceRecord(state, { kind: 'close_surface', id: surface.id, status: 'expired' }));
  } else if (outcome === 'answered' || outcome === 'closed') {
    await redraw(current);
  }
  return refuse(current.status === 'resolved' ? 'answered' : outcome, current);
}

/**
 * A submitted host modal, already validated when Slack's request arrived (the
 * modal closed only for a valid answer). It is re-read against the stored
 * surface and then admitted exactly like a click on the card.
 */
async function handleSlackUiViewSubmission(
  input: SlackUiContext & { submission: SlackUiViewSubmission },
): Promise<void> {
  const { submission, stores, client } = input;
  const surfaceId = viewSubmissionSurfaceId(submission);
  if (!surfaceId || !stores.slackState.executeUiSurface) return;
  const state = stores.slackState as UiSurfaceState;
  emitUiInteraction('received');
  const surface = await uiSurfaceRecord(state, { kind: 'get_surface', id: surfaceId });
  const reading = readViewSubmission(submission, surface);
  const refuse = async (refusal: UiRefusal, current: UiSurfaceRecord) => {
    emitUiInteraction('refused', refusal);
    await sendUiNotice(client, {
      channelId: current.channelId,
      userId: submission.userId,
      text: uiRefusalText(refusal, current),
      threadTs: current.threadTs,
    });
  };
  if (!reading.ok) {
    // It was valid when Slack asked, so the modal closed; only the card can
    // have changed since. Say so privately, as a late click would.
    if (!surface || surface.namespace !== 'ui' || surface.workspaceId !== submission.workspaceId) return;
    const open = surface.status === 'open' || surface.status === 'pending_delivery';
    if (open && surface.expiresAt > Date.now()) return;
    const current = open
      ? await uiSurfaceRecord(state, { kind: 'close_surface', id: surface.id, status: 'expired' }) ?? surface
      : surface;
    await redrawUiSurface(surfaceMessenger(client, current.channelId), current);
    return refuse(current.status === 'resolved' ? 'answered' : 'closed', current);
  }
  if (input.botUserId && answerPicksUser(reading.surface, reading.answer, input.botUserId)) {
    return refuse('unavailable', reading.surface);
  }
  const outcome = await admitUiAnswer(input, {
    surface: reading.surface,
    answer: reading.answer,
    userId: submission.userId,
    messageTs: receiptSlackTs(),
  });
  const current = await uiSurfaceRecord(state, { kind: 'get_surface', id: surfaceId }) ?? reading.surface;
  await redrawUiSurface(surfaceMessenger(client, current.channelId), current);
  if (outcome === 'admitted') {
    emitUiInteraction('resolved');
    return;
  }
  return refuse(current.status === 'resolved' ? 'answered' : outcome, current);
}

/**
 * The answer becomes a synthetic message from the person, through the same
 * admission as typed text; the surface is claimed first-wins with its TurnJob.
 */
async function admitUiAnswer(
  context: SlackUiContext,
  input: { surface: UiSurfaceRecord; answer: InteractiveAnswer; userId: string; messageTs: string },
): Promise<SlackUiAdmission['outcome']> {
  const { surface, answer } = input;
  const admission: SlackUiAdmission = {
    surface,
    choice: answer.choice,
    ...(answer.values ? { values: answer.values } : {}),
    outcome: 'unavailable',
  };
  await processSlackEvent({
    token: '',
    team_id: surface.workspaceId,
    api_app_id: context.appId,
    event_id: `EvUI${surface.id}`,
    event_time: Math.floor(Number(input.messageTs)),
    type: 'event_callback',
    event: {
      type: 'message',
      channel: surface.channelId,
      channel_type: surface.conversationKind === 'im' ? 'im' : 'channel',
      user: input.userId,
      text: uiResponseTurnText(surface, answer, input.userId),
      ts: input.messageTs,
      event_ts: input.messageTs,
      thread_ts: surface.threadTs,
    },
  }, context.platformEnv, context.execution, admission);
  return admission.outcome;
}

/** A modal has no action_ts: the receipt time, with sub-millisecond noise against same-ms collisions. */
function receiptSlackTs(now = Date.now()): string {
  const micros = (now % 1000) * 1000 + Math.floor(Math.random() * 1000);
  return `${Math.floor(now / 1000)}.${String(micros).padStart(6, '0')}`;
}

/** Whether an answer names this user as a picked person. */
function answerPicksUser(surface: UiSurfaceRecord, answer: InteractiveAnswer, userId: string): boolean {
  const spec = surface.spec;
  if (spec.kind === 'form') {
    const values = parseFormValues(answer.values);
    return spec.form.fields.some((field) => (field.type === 'person' || field.type === 'people') &&
      [values[field.key]].flat().includes(userId));
  }
  if (spec.kind === 'question' && answer.choice === QUESTION_OTHER_CHOICE) return false;
  return answer.values?.includes(userId) ?? false;
}

function emitUiInteraction(outcome: 'received' | 'refused' | 'resolved', reason?: UiRefusal): void {
  console.info('[chickpea] slack_ui.click', { outcome, ...(reason ? { reason } : {}) });
}

/** Edits a host surface message in place; `chat.update` keeps the sender. */
function surfaceMessenger(
  client: ReturnType<typeof createSlackWebClient>,
  channelId: string,
): { update(messageTs: string, rendered: RenderedUiSurface): Promise<void> } {
  return {
    async update(messageTs, rendered) {
      await client.chat.update({
        channel: channelId,
        ts: messageTs,
        text: rendered.text,
        blocks: rendered.blocks,
      } as unknown as Parameters<typeof client.chat.update>[0]);
    },
  };
}

async function processDirectSlackUiAction(
  action: SlackUiAction,
  appId: string,
  platformEnv: PlatformEnv | undefined,
): Promise<void> {
  const context = await directSlackUiContext(action.workspaceId, appId, platformEnv);
  if (context) await handleSlackUiAction({ ...context, action });
}

/** The bound direct installation for a verified interaction, with its bot client. */
async function directSlackUiContext(
  workspaceId: string,
  appId: string,
  platformEnv: PlatformEnv | undefined,
): Promise<SlackUiContext | undefined> {
  const stores = resolveStores(platformEnv);
  const installation = await stores.config.getWorkspaceInstallation(workspaceId);
  if (!installation || installation.transportMode !== 'direct' ||
      installation.health === 'revoked' ||
      (installation.appId && installation.appId !== appId)) return undefined;
  const credentials = await resolveSlackInstallationCredentials(
    slackInstallationCredentialId(platformEnv),
    platformEnv,
  );
  if (!credentials.botToken) return undefined;
  return {
    appId,
    platformEnv,
    stores,
    client: createSlackWebClient(credentials.botToken),
    ...(installation.botUserId ? { botUserId: installation.botUserId } : {}),
  };
}

async function readUiSurface(stores: AppStores, id: string): Promise<UiSurfaceRecord | undefined> {
  if (!stores.slackState.executeUiSurface) return undefined;
  return uiSurfaceRecord(stores.slackState as UiSurfaceState, { kind: 'get_surface', id });
}

/** Opens a Fill in or "Something else…" modal with the click's trigger_id; false when it cannot. */
async function openDirectSlackUiModal(
  action: SlackUiAction,
  appId: string,
  platformEnv: PlatformEnv | undefined,
): Promise<boolean> {
  try {
    const control = parseUiControl(action);
    const context = control ? await directSlackUiContext(action.workspaceId, appId, platformEnv) : undefined;
    if (!control || !context) return false;
    const view = modalForClick(action, await readUiSurface(context.stores, control.surfaceId));
    if (!view) return false;
    await context.client.views.open({
      trigger_id: action.triggerId,
      view,
    } as unknown as Parameters<typeof context.client.views.open>[0]);
    emitUiInteraction('received');
    return true;
  } catch (error) {
    console.warn('[chickpea] Slack modal did not open:', sanitizeError(error));
    return false;
  }
}

/**
 * A submitted host modal answers Slack in this response: field errors keep the
 * modal open; a valid answer closes it and is admitted after the response.
 */
async function receiveDirectSlackUiViewSubmission(
  c: Parameters<NonNullable<SlackChannelOptions['interactions']>>[0]['c'],
  submission: SlackUiViewSubmission,
  appId: string,
  platformEnv: PlatformEnv | undefined,
): Promise<Response | undefined> {
  const context = await directSlackUiContext(submission.workspaceId, appId, platformEnv);
  const surfaceId = viewSubmissionSurfaceId(submission);
  const surface = context && surfaceId ? await readUiSurface(context.stores, surfaceId) : undefined;
  const reading = readViewSubmission(submission, surface);
  if (!reading.ok) return Response.json(reading.responseAction);
  detach(c, handleSlackUiViewSubmission({ ...context!, submission }).catch((error) => {
    console.error('[chickpea] Slack form submission failed:', sanitizeError(error));
  }));
  return undefined;
}

type GatewayUiExecution = {
  stores: AppStores;
  enqueueTurn?(job: TurnJob): Promise<StateRpcResult<null>>;
  durableIngress?: boolean;
};

/** A normalized gateway click or modal still needs the Worker's current binding. */
async function gatewaySlackUiContext(
  delivery: { workspaceId: string; bindingId: string },
  platformEnv: PlatformEnv | undefined,
  providedClient: GatewayDeploymentClient | undefined,
  providedExecution: GatewayUiExecution | undefined,
): Promise<SlackUiContext | undefined> {
  const stores = providedExecution?.stores ?? resolveStores(platformEnv);
  const installation = await stores.config.getWorkspaceInstallation(delivery.workspaceId);
  if (!installation || installation.transportMode !== 'gateway' ||
      installation.health === 'revoked' || !installation.appId || !installation.botUserId ||
      !installation.gatewayBindingId || installation.gatewayBindingId !== delivery.bindingId) {
    return undefined;
  }
  const gateway = providedClient ?? createGatewayDeploymentClient(platformEnv);
  const binding = await gateway.loadBinding();
  if (!binding || binding.bindingId !== delivery.bindingId ||
      binding.workspaceId !== delivery.workspaceId || binding.appId !== installation.appId ||
      binding.botUserId !== installation.botUserId) return undefined;
  const client = createGatewaySlackWebClient(gateway);
  return {
    appId: installation.appId,
    platformEnv,
    stores,
    client,
    botUserId: installation.botUserId,
    execution: {
      transport: createGatewaySlackTransport(gateway),
      client,
      botUserId: installation.botUserId,
      stores,
      ...(providedExecution?.enqueueTurn ? { enqueueTurn: providedExecution.enqueueTurn } : {}),
      ...(providedExecution?.durableIngress ? { durableIngress: true } : {}),
    },
  };
}

export async function processGatewayUiAction(
  delivery: GatewayUiActionDelivery,
  platformEnv?: PlatformEnv,
  providedClient?: GatewayDeploymentClient,
  providedExecution?: GatewayUiExecution,
): Promise<'accepted' | 'rejected'> {
  const context = await gatewaySlackUiContext(delivery, platformEnv, providedClient, providedExecution);
  if (!context) return 'rejected';
  await handleSlackUiAction({ ...context, action: delivery });
  return 'accepted';
}

/** A modal the session validated at receipt; admitted like a click on its card. */
export async function processGatewayViewSubmission(
  delivery: GatewayViewSubmissionDelivery,
  platformEnv?: PlatformEnv,
  providedClient?: GatewayDeploymentClient,
  providedExecution?: GatewayUiExecution,
): Promise<'accepted' | 'rejected'> {
  const context = await gatewaySlackUiContext(delivery, platformEnv, providedClient, providedExecution);
  if (!context) return 'rejected';
  await handleSlackUiViewSubmission({ ...context, submission: delivery });
  return 'accepted';
}

async function processDirectPrivateChannelSetup(
  action: PrivateChannelSetupAction,
  apiAppId: string | undefined,
  platformEnv?: PlatformEnv,
): Promise<void> {
  const stores = resolveStores(platformEnv);
  const installation = await stores.config.getWorkspaceInstallation(action.workspaceId);
  if (!installation || installation.transportMode !== 'direct' ||
      installation.health === 'revoked' || !installation.appId ||
      installation.appId !== apiAppId) return;
  const credentials = await resolveSlackInstallationCredentials(
    slackInstallationCredentialId(platformEnv), platformEnv,
  );
  const botUserId = await resolveInstallationBotUserId(
    installation.botUserId, credentials, platformEnv,
  );
  if (!credentials.botToken || !botUserId) return;
  await completePrivateChannelSetupAction(action, {
    stores,
    transport: createDirectSlackTransport(credentials.botToken),
    client: createSlackWebClient(credentials.botToken),
    botUserId,
    ...(platformEnv ? { platformEnv } : {}),
  });
}

interface PrivateChannelSetupExecution {
  stores: AppStores;
  transport: SlackTransport;
  client: ReturnType<typeof createSlackWebClient>;
  botUserId: string;
  platformEnv?: PlatformEnv;
  gateway?: GatewayDeploymentClient;
}

function privateChannelSetupService(execution: PrivateChannelSetupExecution): PrivateChannelSetupService {
  const { stores, transport, botUserId } = execution;
  return new PrivateChannelSetupService({
    config: stores.config,
    management: stores.management,
    resolveActor: (input) => resolveAgentRoutingActor({
      workspaceId: input.workspaceId,
      userId: input.inviterSlackUserId,
      channelId: input.channelId,
      botUserId, transport, stores,
    }),
    lookupChannel: (_workspaceId, channelId) => transport.lookupChannel(channelId),
    prepareGeneratedAvatar: async ({ workspaceId, agent }) => prepareGeneratedGatewayAgentAvatar({
      workspaceId,
      installation: await stores.config.getWorkspaceInstallation(workspaceId),
      agent,
      publish: (candidate) => (execution.gateway ??
        createGatewayDeploymentClient(execution.platformEnv)).publishAvatar(candidate),
      updateAgent: (agentId, patch, revision) => stores.config.updateAgent(agentId, patch, revision),
    }),
    publishAgentChannel: async ({ actor, workspaceId, channelId, agentId }) => {
      const user = await stores.identity.getUser(actor.userId);
      if (!user || user.slackTeamId !== workspaceId || !user.slackUserId) {
        throw new Error('The acting Slack member is no longer available.');
      }
      // Avatar preparation can involve remote work. Recheck authority before
      // the reconciler imports the Channel or writes the pending grant.
      const current = await resolveAgentRoutingActor({
        workspaceId, userId: user.slackUserId, channelId, botUserId, transport, stores,
      });
      const channel = await transport.lookupChannel(channelId);
      if (!current.principal || !current.routing.fullMember ||
          current.principal.membershipId !== actor.membershipId ||
          channel.id !== channelId || !channel.private || !channel.member || channel.archived) {
        throw new Error('Private Channel setup is no longer available.');
      }
      requireAgentChannelPublication(
        current.principal, await stores.config.getAgent(agentId), current.routing.channelMember,
      );
      return new AgentPresenceReconciler({ config: stores.config, transport }).publish({
        workspaceId, channelId, agentId,
        actorMembershipId: current.principal.membershipId,
        actorSlackUserId: user.slackUserId,
      });
    },
  });
}

async function privateChannelSetupAdminUrl(execution: PrivateChannelSetupExecution): Promise<string | undefined> {
  const origin = await resolveSlackPublicUrl(execution.platformEnv, execution.stores.settings);
  return origin ? new URL('/admin/agents', origin).toString() : undefined;
}

async function completePrivateChannelSetupAction(
  action: PrivateChannelSetupAction,
  execution: PrivateChannelSetupExecution,
): Promise<void> {
  // Never send even private feedback to somebody other than this card's inviter.
  const intent = await execution.stores.management.getPrivateChannelSetupIntent(action.setupId);
  if (!intent || intent.inviterSlackUserId !== action.userId ||
      intent.workspaceId !== action.workspaceId || intent.channelId !== action.channelId) return;
  if (!await execution.stores.slackState.claim(`private-setup:${action.deliveryId}`)) return;
  let text: string;
  try {
    // An already-completed card can report current truth with its bound choice,
    // even if Slack has since cleared the selector. It cannot publish again.
    const agentId = action.agentId ?? (intent.status === 'completed' ? intent.selectedAgentId : undefined);
    if (!agentId) {
      const actor = await resolveAgentRoutingActor({
        workspaceId: action.workspaceId, userId: action.userId, channelId: action.channelId,
        botUserId: execution.botUserId, transport: execution.transport, stores: execution.stores,
      });
      const channel = await execution.transport.lookupChannel(action.channelId);
      if (!actor.principal || !actor.routing.fullMember || !actor.routing.channelMember ||
          actor.principal.userId !== intent.actorUserId ||
          actor.principal.membershipId !== intent.actorMembershipId ||
          actor.principal.organizationId !== intent.organizationId ||
          channel.id !== action.channelId || !channel.private || !channel.member || channel.archived) return;
      text = intent.status === 'open' && intent.expiresAt > Date.now()
        ? 'Choose an Agent in the setup card, then click Add.'
        : privateChannelSetupUnavailableText(
          intent.status === 'open' ? 'expired' : 'used', await privateChannelSetupAdminUrl(execution),
        );
    } else {
      const result = await privateChannelSetupService(execution).add({
        workspaceId: action.workspaceId, channelId: action.channelId,
        inviterSlackUserId: action.userId, setupId: action.setupId, agentId,
      });
      text = result.kind === 'completed'
        ? `@${result.handle} is ready in this private channel. Mention @${result.handle} to start a conversation.`
        : result.kind === 'in_progress'
          ? 'This Agent is being added. Click Add again in a moment to check.'
          : result.kind === 'no_longer_added'
            ? privateChannelSetupUnavailableText('removed', await privateChannelSetupAdminUrl(execution))
            : privateChannelSetupRecoveryText(await privateChannelSetupAdminUrl(execution));
    }
  } catch (error) {
    if (error instanceof PrivateChannelSetupError) {
      if (error.code === 'forbidden') return;
      text = error.code === 'unverifiable'
        ? 'I couldn’t check this Agent right now. Click Add again in a moment.'
        : privateChannelSetupUnavailableText(
        error.code === 'expired' ? 'expired' : error.code === 'stale' ? 'stale' : 'used',
        await privateChannelSetupAdminUrl(execution),
      );
    } else {
      console.warn('[chickpea] private Channel setup could not finish:', sanitizeError(error));
      text = privateChannelSetupRecoveryText(await privateChannelSetupAdminUrl(execution));
    }
  }
  // Ephemeral messages cannot be updated with chat.update. Results are another
  // private message; failed delivery never falls back to a public post.
  await execution.client.chat.postEphemeral({ channel: action.channelId, user: action.userId, text });
}

async function processSlackEvent(
  payload: SlackEventFixture,
  platformEnv: PlatformEnv | undefined,
  execution?: SlackEventExecution,
  ui?: SlackUiAdmission,
  ask?: SlackAgentAskAdmission,
): Promise<void> {
  // A click is admitted like a message; every early return below is a refusal
  // (its outcome starts at `unavailable`).
  const stores = execution?.stores ?? resolveStores(platformEnv);
  const behavior = await resolveSlackBehaviorSettings(platformEnv, stores.settings);
  const installation = await stores.config.getWorkspaceInstallation(payload.team_id);
  if (!installation || installation.health === 'revoked') return;
  if (execution && installation.transportMode !== 'gateway') return;
  if (!execution && installation.transportMode !== 'direct') return;
  if (
    !ask &&
    installation.runtimeContract === 'chickpea-v1' &&
    payload.event.type === 'message' &&
    await reconcileSlackPublicContextMutation(
      stores.config,
      payload.team_id,
      payload.event,
    )
  ) return;
  if (!ask && installation.runtimeContract === 'chickpea-v1' && payload.event.type === 'message') {
    await recordAgentThreadMessage(stores.config, payload.team_id, payload.event, installation.botUserId);
  }
  const credentials = execution
    ? ({ connectionRevision: null } as ResolvedSlackInstallationCredentials)
    : await resolveSlackInstallationCredentials(slackInstallationCredentialId(platformEnv), platformEnv);

  if (payload.event.type === 'member_joined_channel') {
    await handleMemberJoinedChannel(
      payload,
      stores,
      platformEnv,
      installation.botUserId,
      credentials,
      behavior.welcomeOnJoin.value,
      execution,
    );
    return;
  }

  const resolvedBotUserId = execution?.botUserId ??
    await resolveInstallationBotUserId(installation.botUserId, credentials, platformEnv);
  // A host-addressed turn is built by the host: an ask's from a delivered
  // Agent reply, which Slack event normalization would ignore as an
  // app-authored post; a co-addressed one from the person's normalized turn.
  const normalization = ask
    ? { status: 'runnable' as const, turn: ask.turn }
    : normalizeSlackTurn(payload, {
        ...(resolvedBotUserId ? { botUserId: resolvedBotUserId } : {}),
      });
  if (normalization.status !== 'runnable') return;
  const turn = normalization.turn;
  if (ui) {
    turn.uiResponse = {
      surfaceId: ui.surface.id,
      namespace: ui.surface.namespace,
      kind: ui.surface.spec.kind,
      choice: ui.choice,
      ...(ui.values?.length ? { values: ui.values } : {}),
    };
  }
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
  // Several Agents can answer one message (asked by a reply, or mentioned
  // together by a person): each Agent's turn on it is its own.
  const msgKey = ask
    ? `msg:${turn.channelId}:${turn.messageTs}:ask-${ask.targetAgentId}`
    : `msg:${turn.channelId}:${turn.messageTs}`;

  let assignment: ResolvedAssignment;
  let routedBaseAssignment: ResolvedAssignment | undefined;
  // A mention of a different Agent hands the thread over: no mid-run 👀 (R12).
  let routedHandoff = false;
  let agentRoutingActor: ResolvedAgentRoutingActor | undefined;
  let agentSourceVisibility: 'public' | 'private' | undefined;
  let liveChannelName: string | undefined;
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
    !ask &&
    turnRequiresOwnedThread(turn) &&
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
        ...(ask ? { askAgentId: ask.targetAgentId } : {}),
        authorizeUserAgent: async (agent) => resolvePrivateAgentAccess({
          agent,
          workspaceId: turn.workspaceId,
          grants: await store.listAgentChannelGrants(turn.workspaceId),
          actor: privateAgentActor(agentRoutingActor!, turn.userId),
          transport: runtimeTransport,
        }),
      });
      if (routed.kind === 'ignore') return;
      if (routed.kind !== 'routed' && ui) return;
      if (routed.kind !== 'routed' && ask) {
        // The asking Agent's teammates list names whom it can reach; an ask
        // that cannot run here is not answered, and nobody is told in Slack.
        console.info(`[chickpea] host-addressed turn not admitted: ${routed.reason}`);
        return;
      }
      if (routed.kind !== 'routed') {
        // Guests and Slack Connect users are refused before this check and
        // keep today's behaviour.
        if (
          routed.kind === 'denied' && routed.reason === 'not_available' &&
          agentRoutingActor.routing.fullMember &&
          await refuseIneligibleSlackStop({
            turn,
            evtKey,
            msgKey,
            state,
            config: store,
            client: runtimeClient,
            botUserId: resolvedBotUserId,
            runtimeContract: installation.runtimeContract,
          })
        ) return;
        await postAgentRoutingFeedback({
          turn,
          surface,
          result: routed,
          client: runtimeClient,
        });
        return;
      }
      routedHandoff = routed.handoff;
      if (routed.coAddressed) turn.coAddressed = routed.coAddressed;
      if (!ask) {
        await claimChickpeaIntroductionForAgentInteraction({
          actor: agentRoutingActor,
          workspaceId: turn.workspaceId,
          slackUserId: turn.userId,
          management: stores.management,
        });
      }
      let routedAssignment = routed.assignment;
      if (routed.handoffFallbackRequired && routed.previousAgentId && routed.route.handoff) {
        const fallbackContext = await hydrateSlackPublicHandoffFallback(
          runtimeClient,
          turn,
          routed.previousAgentId,
          {
            readGate: createSlackReadGate({
              state,
              workspaceId: turn.workspaceId,
              gated: sharesSlackAppReadBudget({ transportMode: installation.transportMode, env: platformEnv }),
            }),
            ...(installation.botUserId ? { self: { botUserId: installation.botUserId } } : {}),
          },
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
      const policyAssignment = await resolveModelPolicyForAssignment(
        routedAssignment, store, process.env, undefined, platformEnv,
      );
      candidateTurn = turn.source === 'reaction_added';
      if (surface === 'channel') {
        const channel = await runtimeTransport.lookupChannel(turn.channelId);
        agentSourceVisibility = channel.private ? 'private' : 'public';
        liveChannelName = channel.name;
        if (liveChannelName && routedAssignment.channelLabel !== liveChannelName) {
          // The Slack Channel was renamed after this Agent's grant cached its
          // name. Record the current name on the Channel and all its grants; a
          // failed refresh only leaves the previous labels in place.
          await store.refreshChannelLabel(turn.workspaceId, turn.channelId, liveChannelName)
            .catch(() => undefined);
        }
      } else {
        agentSourceVisibility = 'private';
      }
      // A guest answering an ask keeps its own frozen configuration, so the
      // owner's snapshot is never replaced by the guest's.
      const guestAgent = routedAssignment.threadGuest ? routedAssignment.agent : undefined;
      const frozenAssignment = await getOrReplaceSnapshotForRoute(
        stores.snapshots,
        guestAgent ? slackGuestThreadKey(threadKey, guestAgent.id) : threadKey,
        guestAgent
          ? {
              agentId: guestAgent.id,
              agentGeneration: guestAgent.configurationGeneration ?? guestAgent.revision,
              modelAttribution: policyAssignment.modelAttribution,
            }
          : { ...routed.route, modelAttribution: policyAssignment.modelAttribution },
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
        ...(routedAssignment.threadGuest ? { threadGuest: true as const } : {}),
        ...(routedAssignment.channelTeammates?.length
          ? { channelTeammates: routedAssignment.channelTeammates }
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
    } else if (isRetryableDependencyFailure(err)) {
      // A rate-limited or unreachable Slack/gateway lookup (users.info,
      // conversations.info, ...) or a transient store disconnect is not a
      // configuration decision. Nothing was claimed yet, so throwing lets the
      // durable gateway inbox retry this delivery with backoff instead of
      // completing it; a Slack retry would otherwise dedupe as a duplicate
      // and the mention would be lost.
      console.warn('[chickpea] turn admission deferred:', sanitizeError(err));
      throw err;
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
  // A message a person typed: neither a click nor an Agent's ask. Only such
  // a message can run a command, approve, stop, check in, or answer a
  // browser step; an Agent's words never do, whatever they say.
  const typedByPerson = !ui && !ask;
  let deterministicCommand = typedByPerson && (Boolean(parseMemoryCommand(turn.text)) ||
    (isRoutineSlackTurn(turn) && Boolean(parseRoutineCommand(turn.text, commandAddress))));
  let admissionTruth: SlackAdmissionTruth = {
    eligible: false,
    reason: 'slack_truth_unavailable',
  };
  let admittedActorMembershipId = agentRoutingActor?.principal?.membershipId;
  let admittedRequesterTimezone = agentRoutingActor?.requesterTimezone;
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
          admittedRequesterTimezone = user.timezone;
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
  if (admissionTruth.eligible && admittedRequesterTimezone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: admittedRequesterTimezone });
      turn.requesterTimezone = admittedRequesterTimezone;
    } catch { /* Do not infer a timezone from invalid profile data. */ }
  }
  if (admissionTruth.eligible && admittedActorMembershipId) {
    turn.actorMembershipId = admittedActorMembershipId;
  }

  // A click is structured data: it never enters the typed approve/stop
  // matching below. Only a host-namespace click on a live host record can
  // stamp an approval, and only after the clicker passed the gate above.
  if (ui) {
    const refusal = admissionTruth.eligible && !candidateTurn
      ? await authorizeUiResponse({
          admission: ui,
          turn,
          assignment,
          actorMembershipId: admittedActorMembershipId,
          stores,
        })
      : 'unavailable';
    if (refusal) {
      ui.outcome = refusal;
      return;
    }
    turn.interactionIntent = { disposition: 'reply', reason: 'substantive_request' };
    if (turn.managementApprovalProposalId) deterministicCommand = true;
  }

  // An exact "approve" or "stop" answers a browser step this Agent is holding
  // for the same person in the same thread. It is checked before management
  // approvals because it is bound to this thread, and the Agent then runs
  // with the reply (the approved step is bound to this message).
  const browserActionAnswered = typedByPerson && admissionTruth.eligible && !candidateTurn
    ? await admitSlackBrowserActionReply({
        turn,
        assignment,
        settings: stores.settings,
        actorMembershipId: admittedActorMembershipId,
        address: commandAddress,
      })
    : undefined;

  // A stop phrase or check-in typed alone is decided at admission, outside
  // the thread's queue, so it reaches a running (even a stuck) run without a
  // model (KTD1). A plain "stop" that answered a browser step above keeps
  // that meaning (R21). A message addressed to a different Agent (or to
  // @Chickpea in another Agent's thread) hands the thread over and is not
  // steering: routing checked the sender against the new Agent only, and a
  // stop must come from someone who may use the running one (R3). A click or
  // form answer on an interactive surface is never steering.
  const steeringCommand = typedByPerson && !browserActionAnswered && !candidateTurn && !routedHandoff && slackClient
    ? slackSteeringCommand(turn.text, commandAddress)
    : undefined;
  if (steeringCommand && slackClient && slackConversationKind(turn) === 'im' &&
      turn.messageTs === turn.threadTs) {
    await steerTopLevelDirectMessage({
      command: steeringCommand,
      turn,
      evtKey,
      msgKey,
      state,
      client: slackClient,
      platformEnv,
    });
    return;
  }
  // Bound to the routed Agent: another Agent's run (the previous owner's,
  // after a handoff) is steered only once the sender may use that Agent (R3).
  let steering = steeringCommand
    ? slackSteeringRequest(steeringCommand, turnStopThreadKey(turn, assignment), turn, assignment.agentId)
    : undefined;
  const mayUseRunningAgent = (agentId: string) => agentRoutingActor && runtimeTransport
    ? mayUseRunningSlackAgent({
        agentId,
        turn,
        surface,
        actor: agentRoutingActor,
        config: stores.config,
        transport: runtimeTransport,
      })
    : Promise.resolve(false);
  // An eligible message posted while its thread's run is in progress gets
  // Chickpea's 👀 at once, before any model reads it (R12, KTD9). A stop or
  // check-in is answered instead, a reaction or surface click is not a
  // message, and a mention of a different Agent takes the thread over rather
  // than waiting on its run.
  // The receipt is recorded with the message's TurnJob before the reaction is
  // added, so the 👀 always has a turn that removes it.
  const midRun = typedByPerson && !steering && !candidateTurn && !routedHandoff && slackClient
    ? {
        threadKey: turnStopThreadKey(turn, assignment),
        receipt: slackMidRunReceipt({ channelId: turn.channelId, messageTs: turn.messageTs }),
      }
    : undefined;
  let midRunReceipt: TurnMidRunReceipt | undefined;

  if (
    typedByPerson && !browserActionAnswered &&
    admissionTruth.eligible && admittedActorMembershipId &&
    shouldResolveSlackManagementApproval(turn.text)
  ) {
    const proposalId = await resolveHostSlackManagementApproval({
      turn,
      assignment,
      actorMembershipId: admittedActorMembershipId,
      identity: stores.identity,
      management: stores.management,
    });
    if (proposalId) {
      turn.managementApprovalProposalId = proposalId;
      turn.interactionIntent = { disposition: 'reply', reason: 'substantive_request' };
      deterministicCommand = true;
    }
  }

  // A person handed the thread to another Agent while the chain was out: the
  // answer is already in the thread for that Agent, and nobody is owed it.
  if (turn.agentAsk?.handedBack && assignment.threadGuest === true) {
    console.info('[chickpea] handed-back answer dropped: the thread has a new Agent');
    await state.claim(evtKey);
    await state.claim(msgKey);
    return;
  }
  // The thread's own Agent, handed a teammate's answer, replies or stays
  // silent: it never opens a checklist or reacts instead.
  const handedBack = isHandedBackTurn(turn, assignment);
  if (handedBack) turn.interactionIntent = { disposition: 'reply', reason: 'substantive_request' };
  if (!ui && !deterministicCommand && !browserActionAnswered && !candidateTurn && !handedBack) {
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
        {
          config: stores.config,
          installation: {
            transportMode: installation.transportMode,
            ...(installation.botUserId ? { botUserId: installation.botUserId } : {}),
          },
        },
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
            }, process.env, assignment.agentId, platformEnv)
          : await getOrCreateSnapshot(stores.snapshots, threadKey, () =>
              resolveEffectiveSlackConfig(turn.workspaceId, turn.channelId, {
                agents: stores.config,
                grants: stores.config,
              }, process.env, assignment.agentId, platformEnv));
      }
    } finally {
      releaseClassifier();
    }
  }

  // Keep thread behavior frozen while adopting a migrated legacy avatar for
  // this new turn. The admitted Run still freezes that selection for retries.
  if (routedBaseAssignment) {
    assignment = {
      ...assignment,
      agent: refreshLegacyAgentAvatar(assignment.agent, routedBaseAssignment.agent),
    };
  }
  // A thread snapshot freezes the Channel label from its first turn. This
  // turn's usage names the Channel as Slack calls it now.
  if (liveChannelName && assignment.channelLabel !== liveChannelName) {
    assignment = { ...assignment, channelLabel: liveChannelName };
  }
  const assignmentAvatarUrl = await resolvedAgentAvatarUrl(
    assignment.agent,
    stores,
    platformEnv,
  );

  // Canonical Work admission stores a concrete configured model. A missing
  // model is an operator configuration error, but it must still follow the
  // established legacy turn path so Slack receives one sanitized failure
  // instead of an intake exception and silence.
  let modelReadyForCanonicalAdmission = true;
  modelReadyForCanonicalAdmission = Boolean(turn.managementApprovalProposalId) ||
    Boolean(assignment.model && assignment.modelAttribution);

  // A click resolves its surface inside canonical admission, atomically with
  // its TurnJob; it never takes the legacy claim path that could not.
  if (ui && !(admissionTruth.eligible && modelReadyForCanonicalAdmission)) return;
  // An ask is admitted canonically or not at all: its limit is counted there.
  if (ask && !(admissionTruth.eligible && modelReadyForCanonicalAdmission)) {
    console.info('[chickpea] host-addressed turn not admitted: not_eligible');
    return;
  }
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
      legacyOnlyTurn: deterministicCommand,
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
      conversationKind: slackConversationKind(turn),
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
    // A stop or check-in the thread's run took is settled outside the catch:
    // a failure there has given the claims back already, for the gateway's
    // retry. When its run ended meanwhile, the message is admitted again as
    // an ordinary turn, its claims given back first since the admission
    // takes them itself.
    for (;;) {
      let steered: TurnSteeringInterception | undefined;
      try {
        const result = await state.admitCanonical({
          evtKey,
          msgKey,
          threadKey,
          admission,
          turnJob: canonicalTurnJob,
          ...(steering ? { steering } : {}),
          ...(midRun ? { midRun } : {}),
          ...(ask?.turn.agentAsk ? { agentAskLimit: AGENT_ASK_TURN_LIMIT } : {}),
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
          ...(ui
            ? {
                uiSurfaceClaim: {
                  surfaceId: ui.surface.id,
                  namespace: ui.surface.namespace,
                  resolution: {
                    byUserId: turn.userId,
                    at: Date.now(),
                    choice: ui.choice,
                    ...(ui.values?.length ? { values: ui.values } : {}),
                  },
                },
              }
            : {}),
        });
        if (!result.claimed) {
          if (ui) ui.outcome = 'answered';
          return;
        }
        if ('agentAskLimitReached' in result) {
          if (ask?.onLimitReached && slackClient) await ask.onLimitReached(slackClient).catch(() => {
            console.warn('[chickpea] agent ask pause note was not posted');
          });
          return;
        }
        if ('agentAskCoalesced' in result) {
          console.info('[chickpea] agent ask joined the asked Agent\'s queued turn');
          return;
        }
        if ('steered' in result) {
          steered = result.steered;
        } else {
          if (ui) ui.outcome = 'admitted';
          claimsHeldByCanonicalAdmission = true;
          canonicalRunId = result.admission.run.id;
          if (result.midRunReceipt) midRunReceipt = midRun?.receipt;
        }
      } catch (err) {
        if (admission.run.executionAuthority === 'ledger') {
          // A selected canary must never fall back across authority lanes. The
          // transaction rolled its claims back, so Slack may safely redeliver.
          if (execution?.durableIngress) {
            console.error('[chickpea] ledger Work admission failed: durable_ingress_failure');
          } else {
            console.error('[chickpea] ledger Work admission failed:', sanitizeError(err));
          }
          if (promotedDecisionKey) await state.release(promotedDecisionKey);
          // An ask's own retry loop is its redelivery.
          if (execution?.enqueueTurn || execution?.durableIngress || ask) {
            throw new SlackDurableEnqueueError('Canonical Work admission failed.');
          }
          return;
        }
        if (ui) {
          console.error('[chickpea] Slack click admission failed:', sanitizeError(err));
          return;
        }
        if (ask) {
          // Never the uncounted legacy path: the claims rolled back, so the
          // ask's own retry may admit it again.
          console.error('[chickpea] agent ask admission failed:', sanitizeError(err));
          throw new SlackDurableEnqueueError('Agent ask admission failed.');
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
      if (!steered) break;
      const settled = await settleSlackSteering({
        decision: steered,
        request: steering!,
        keys: [evtKey, msgKey],
        mayUse: mayUseRunningAgent,
        turn,
        state,
        client: slackClient!,
        platformEnv,
      });
      if (settled !== 'ended') return;
      await releaseSteeringMessage(state, evtKey, msgKey);
      steering = undefined;
    }
  } else {
    if (!(await state.claim(evtKey))) return;
    if (!(await state.claim(msgKey))) {
      await state.release(evtKey);
      return;
    }
  }

  if (steering && !claimsHeldByCanonicalAdmission) {
    // The legacy lane (no canonical admission) holds the claims already. Its
    // enqueue below is a separate write, so a stop racing the thread's first
    // message may queue behind it there; the canonical lane decides both in
    // one transaction. A run that ended while the sender was checked against
    // it leaves the message to that enqueue, as with nothing running.
    const decision = await state.steerTurn?.(steering).catch((err: unknown) => {
      console.warn('[chickpea] steering decision failed:', sanitizeError(err));
      return undefined;
    });
    if (decision && decision.outcome !== 'enqueue') {
      const settled = await settleSlackSteering({
        decision,
        request: steering,
        keys: [evtKey, msgKey],
        mayUse: mayUseRunningAgent,
        turn,
        state,
        client: slackClient!,
        platformEnv,
      });
      if (settled !== 'ended') return;
    }
  }
  if (midRun && !claimsHeldByCanonicalAdmission) {
    // The legacy lane's enqueue below is a separate write: a run that ends in
    // between leaves this message a 👀 its own turn reuses and removes.
    const decision = await state.steerTurn?.({ kind: 'message', threadKey: midRun.threadKey })
      .catch(() => undefined);
    if (decision?.outcome === 'enqueue' && decision.undelivered) midRunReceipt = midRun.receipt;
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
  if (!ui && runtimeClient && (turn.managementApprovalProposalId || browserActionAnswered)) {
    // A typed approve or stop settles the card offering the same approval.
    await retireApprovalSurfacesForTypedAnswer({
      state,
      messenger: surfaceMessenger(runtimeClient, turn.channelId),
      scope: { workspaceId: turn.workspaceId, channelId: turn.channelId, agentId: assignment.agent.id },
      match: {
        ...(turn.managementApprovalProposalId ? { proposalId: turn.managementApprovalProposalId } : {}),
        ...(browserActionAnswered ? { browserActionId: browserActionAnswered.id } : {}),
      },
      resolution: {
        byUserId: turn.userId,
        at: Date.now(),
        choice: browserActionAnswered?.kind === 'stopped' ? 1 : 0,
      },
    }).catch(() => {
      console.warn('[chickpea] typed approval did not retire its card');
    });
  }
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
      ...(midRunReceipt ? { midRunReceipt } : {}),
    };
    // An ask admitted inside the state store enqueues into its own queue
    // whatever the installation's transport; the stub is for a Worker.
    const enqueueTurn = execution?.enqueueTurn ?? ask?.enqueueTurn;
    const enqueued = enqueueTurn
      ? await enqueueTurn(job)
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
    if (midRunReceipt && slackClient) {
      await addMidRunReaction({ client: slackClient, state, jobId: job.id, receipt: midRunReceipt });
    }
    if (typedByPerson) {
      await recordAcceptedSlackHumanMessage(stores.config, turn, assignment, slackEventFiles(payload.event)).catch(() => {
        console.warn('[chickpea] accepted Slack message was not added to public context');
      });
    }
    await admitCoAddressedTurns({ payload, turn, platformEnv, execution });
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
        ...(midRunReceipt ? { midRunReceipt } : {}),
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
      if (execution?.durableIngress) {
        console.error('[chickpea] Node turn enqueue failed: durable_ingress_failure');
      } else {
        console.error('[chickpea] Node turn enqueue failed:', sanitizeError(err));
      }
      if (execution?.durableIngress) {
        throw new SlackDurableEnqueueError('Node turn persistence failed.');
      }
      return;
    }
  }
  if (midRunReceipt && slackClient) {
    await addMidRunReaction({ client: slackClient, state, jobId: msgKey, receipt: midRunReceipt });
  }
  if (typedByPerson) {
    await recordAcceptedSlackHumanMessage(stores.config, turn, assignment, slackEventFiles(payload.event)).catch(() => {
      console.warn('[chickpea] accepted Slack message was not added to public context');
    });
  }
  await admitCoAddressedTurns({ payload, turn, platformEnv, execution });
  const wake = wakeNodeTurnRelay(platformEnv).catch((err) => {
    if (execution?.durableIngress) {
      console.error('[chickpea] node turn wake failed: durable_ingress_failure');
    } else {
      console.error('[chickpea] node turn wake failed:', sanitizeError(err));
    }
  });
  // A host-addressed turn is admitted from inside another turn's admission
  // or run: waiting for the relay here could hold the next Agent's admission
  // until earlier turns finish.
  if (execution?.durableIngress || ask) {
    void wake;
    return;
  }
  await wake;
}


type SlackSteeringAdmission = Extract<TurnSteeringRequest, { kind: 'stop' | 'check_in' }>;

/**
 * Add the mid-run 👀 whose receipt admission recorded with the message's
 * TurnJob (R12, KTD9). The receipt already says Chickpea's own, so the queued
 * turn reuses it and its finish, or a stop that drops it, removes it. When
 * Slack does not create the reaction here (Chickpea's is already there, or
 * Slack refuses it), the receipt is corrected so nothing ever removes a 👀
 * Chickpea did not add. Best effort: the admitted turn never depends on it.
 */
async function addMidRunReaction(input: MidRunReaction): Promise<void> {
  let added: { name: string; created: boolean } | undefined;
  try {
    added = await addSlackReceiptReaction(input.client, 'seen_mid_run', input.receipt);
  } catch {
    console.warn('[chickpea] mid-run reaction failed');
  }
  if (added?.created) {
    await removeLateMidRunReaction(input, added.name);
    return;
  }
  try {
    await input.state.recordSlackInteractionProgress?.(input.jobId, {
      acknowledgment: {
        ...input.receipt, created: false, cleanup: 'done', reaction: 'seen_mid_run',
      },
    });
  } catch {
    console.warn('[chickpea] mid-run reaction receipt was not corrected');
  }
}

interface MidRunReaction {
  client: Pick<ReturnType<typeof createSlackWebClient>, 'reactions'>;
  state: SlackStateStore;
  jobId: string;
  receipt: TurnMidRunReceipt;
}

/**
 * The receipt is written before Slack adds the 👀, so what removes it (a stop
 * that drops the message, or the turn's own finish) can run first: Slack
 * answers `no_reaction`, that counts as removed, and the late 👀 would stay.
 * Once Slack says the 👀 is Chickpea's, read the row again; when it has left
 * the queue (dropped, delivered or gone) or its receipt is already finished,
 * take that 👀 off the recorded message at once. A row still queued keeps it
 * for its turn. Only where the state store serves its rows here (Node, and
 * the Cloudflare state store's own gateway intake).
 */
async function removeLateMidRunReaction(input: MidRunReaction, name: string): Promise<void> {
  if (!input.state.turnJobView) return;
  try {
    const view = await input.state.turnJobView(input.jobId);
    const settled = view.status === 'done' || view.status === 'error' || view.status === 'missing';
    if (!settled && view.job?.progress.slackInteraction?.acknowledgment?.cleanup !== 'done') return;
    await removeSlackReaction(input.client, name, input.receipt);
    await input.state.recordSlackInteractionProgress?.(input.jobId, {
      acknowledgment: {
        ...input.receipt, name, created: true, cleanup: 'done', reaction: 'seen_mid_run',
      },
    });
  } catch {
    console.warn('[chickpea] a late mid-run reaction was not removed');
  }
}

/**
 * A Stop button press that stopped nothing, as one content-free
 * `steering.stop_button` token, so a button that does nothing shows in the
 * field: `invalid` (an unreadable event), `no_route` (not an Agent thread),
 * `no_running_job` (nothing undelivered to stop) or `not_allowed` (someone
 * who may not use the Agent there, and is not told: a guest, say).
 */
type SlackStopButtonToken = 'invalid' | 'no_route' | 'no_running_job' | 'not_allowed';

function logSlackStopButton(outcome: SlackStopButtonToken): void {
  console.info('[chickpea] steering.stop_button', { outcome });
}

/** A stop or check-in decided at admission, as one content-free token. */
function logSteeringAdmission(
  outcome: 'stopped' | 'check_in' | 'stop_refused' | 'check_in_refused' | 'ended' | 'unsettled',
  source?: TurnStopSource,
  detail?: { created: boolean },
): void {
  console.info('[chickpea] steering.admission', {
    outcome,
    ...(source === 'button' ? { source } : {}),
    ...detail,
  });
}

/**
 * Slack's Stop button (R1, R3, KTD5). Slack sends `agent_session_stopped`
 * when someone presses Stop on the working indicator of a thread's Agent
 * Session; turn normalization would drop it, so both transports hand it here
 * first. The thread must be an Agent thread, and the person who pressed goes
 * through the same actor and Agent-access checks as a reply of theirs in that
 * thread would. The stop is then recorded exactly as a typed one (KTD1), its
 * cutoff the press's own Slack timestamp (KTD2), so a message posted before
 * the press is held and one posted after it is a new turn. Recording is
 * idempotent and the press is claimed, so a Slack retry, a second press and a
 * typed stop record one stop. Slack leaves the session in `processing`; the
 * stopped ending settles it.
 */
async function processSlackStopButton(
  payload: SlackEventFixture,
  platformEnv: PlatformEnv | undefined,
  execution?: Pick<SlackEventExecution, 'transport' | 'client' | 'botUserId' | 'stores'>,
): Promise<void> {
  const press = parseSlackAgentSessionStopped(payload.event);
  if (!press) {
    logSlackStopButton('invalid');
    return;
  }
  const stores = execution?.stores ?? resolveStores(platformEnv);
  const installation = await stores.config.getWorkspaceInstallation(payload.team_id);
  if (!installation || installation.health === 'revoked') return;
  if (execution && installation.transportMode !== 'gateway') return;
  if (!execution && installation.transportMode !== 'direct') return;
  if (!(await stores.config.getAgentThreadRoute(payload.team_id, press.channelId, press.threadTs))) {
    logSlackStopButton('no_route');
    return;
  }
  const credentials = execution
    ? undefined
    : await resolveSlackInstallationCredentials(slackInstallationCredentialId(platformEnv), platformEnv);
  const transport = execution?.transport ?? (
    credentials?.botToken ? createDirectSlackTransport(credentials.botToken) : undefined
  );
  const client = execution?.client ?? (
    credentials?.botToken ? createSlackWebClient(credentials.botToken) : undefined
  );
  const botUserId = execution?.botUserId ?? (credentials
    ? await resolveInstallationBotUserId(installation.botUserId, credentials, platformEnv)
    : undefined);
  if (!transport || !client || !botUserId) return;

  // The press, as a reply of that person's in the Agent Session's thread.
  const surface = surfaceForChannelId(press.channelId);
  const turn: NormalizedSlackTurn = {
    workspaceId: payload.team_id,
    channelId: press.channelId,
    eventId: payload.event_id,
    text: '',
    userId: press.userId,
    messageTs: press.eventTs,
    threadTs: press.threadTs,
    ...(surface === 'direct' ? { sessionThreadTs: 'dm', channelType: 'im' } : {}),
    source: surface === 'direct' ? 'dm_message' : 'implicit_thread_reply',
    contextMode: 'thread',
  };
  let actor: ResolvedAgentRoutingActor;
  let routed: AgentRoutingResult;
  try {
    // No membership proof comes with a press: the channel is asked.
    actor = await resolveAgentRoutingActor({
      workspaceId: turn.workspaceId,
      userId: turn.userId,
      ...(surface === 'channel' ? { channelId: turn.channelId } : {}),
      botUserId,
      transport,
      stores,
    });
    routed = await resolveAgentRoute({
      turn,
      surface,
      actor: actor.routing,
      config: stores.config,
      transport,
      authorizeUserAgent: async (agent) => resolvePrivateAgentAccess({
        agent,
        workspaceId: turn.workspaceId,
        grants: await stores.config.listAgentChannelGrants(turn.workspaceId),
        actor: privateAgentActor(actor, turn.userId),
        transport,
      }),
    });
  } catch (err) {
    // Nothing is claimed yet: a rate-limited or unreachable lookup is retried
    // by the durable gateway inbox, as for a message.
    if (isRetryableDependencyFailure(err)) throw err;
    console.warn('[chickpea] Stop button admission failed:', sanitizeError(err));
    return;
  }
  const state = stores.slackState;
  const threadKey = turnStopThreadKey(
    turn,
    installation.runtimeContract ? { runtimeContract: installation.runtimeContract } : {},
  );
  const keys = [`evt:${payload.event_id}`, `stop:${press.channelId}:${press.eventTs}`] as const;
  if (routed.kind !== 'routed') {
    // As for a typed stop, only a full member is told (AE4); a guest keeps
    // Chickpea's silence.
    const refusal = routed.kind === 'denied' && routed.reason === 'not_available' &&
        actor.routing.fullMember
      ? await refuseSlackStop({
          threadKey,
          keys,
          target: steeringReplyTarget(turn),
          state,
          client,
          source: 'button',
        })
      : 'not_allowed';
    if (refusal === 'idle') logSlackStopButton('no_running_job');
    else if (refusal === 'not_allowed') logSlackStopButton('not_allowed');
    return;
  }
  if (!(await claimSteeringMessage(state, ...keys))) return;
  // Bound to the thread's Agent the press was checked against: after a
  // handoff the run may be the previous owner's, which the presser must be
  // allowed to use as well (R3).
  const request: SlackSteeringAdmission = {
    kind: 'stop',
    threadKey,
    source: 'button',
    stopperUserId: press.userId,
    cutoffTs: press.eventTs,
    agentId: routed.assignment.agentId,
  };
  let decision: TurnSteeringDecision | undefined;
  try {
    decision = await state.steerTurn?.(request);
  } catch (err) {
    // Free the claims so a redelivery decides it again; a recorded stop is
    // idempotent, so deciding twice records one stop.
    await releaseSteeringMessage(state, ...keys);
    throw err;
  }
  if (!decision) return;
  if (decision.outcome !== 'enqueue') {
    const settled = await settleSlackSteering({
      decision,
      request,
      keys,
      mayUse: (agentId) => mayUseRunningSlackAgent({
        agentId,
        turn,
        surface,
        actor,
        config: stores.config,
        transport,
      }),
      turn,
      state,
      client,
      platformEnv,
      source: 'button',
    });
    if (settled !== 'ended') return;
  }
  // Nothing was running, or the run ended while the presser was checked
  // against it: the indicator is idle.
  logSlackStopButton('no_running_job');
  await settleIdleAgentSession({
    client,
    press,
    turn,
    assignment: routed.assignment,
    installationHealth: installation.health,
    stores,
    platformEnv,
  });
}

/**
 * Slack leaves an Agent Session `processing` when its Stop button is pressed;
 * the app moves it out once its work has stopped. With nothing running, the
 * indicator Stop was pressed on is an orphan (a settle that never reached
 * Slack, say), so it goes `active` now, as a run's settle would set it, with
 * the thread's Agent persona, instead of spinning until Slack's one-hour
 * timeout. Best effort; a failure is logged without content.
 */
async function settleIdleAgentSession(input: {
  client: ReturnType<typeof createSlackWebClient>;
  press: SlackStopButtonPress;
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  installationHealth: Parameters<typeof selectSlackPresentationOwner>[0]['installationHealth'];
  stores: AppStores;
  platformEnv: PlatformEnv | undefined;
}): Promise<void> {
  try {
    const { agent } = input.assignment;
    const avatarUrl = await resolvedAgentAvatarUrl(agent, input.stores, input.platformEnv);
    const owner = selectSlackPresentationOwner({
      installationHealth: input.installationHealth,
      agentId: agent.id,
      agentName: agent.name,
      conversationKind: slackConversationKind(input.turn),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(agent.slackPresence ? { slackPresence: agent.slackPresence } : {}),
    });
    await setAgentSessionStatus(input.client, {
      channel_id: input.press.channelId,
      thread_ts: input.press.threadTs,
      status: 'active',
      ...(owner.kind === 'selected_agent'
        ? { username: owner.persona.name, icon_url: owner.persona.avatarUrl }
        : {}),
    });
  } catch {
    console.warn('[chickpea] Stop button could not settle an idle Agent Session');
  }
}

/**
 * A typed stop or check-in for one thread (KTD1). A stop's cutoff is the
 * typed message's own timestamp, and its stopper is the sender. `agentId`,
 * when given, is the Agent the sender was checked against (R3).
 */
function slackSteeringRequest(
  command: SlackSteeringCommand,
  threadKey: string,
  turn: NormalizedSlackTurn,
  agentId?: string,
): SlackSteeringAdmission {
  const bound = agentId ? { agentId } : {};
  return command === 'stop'
    ? {
        kind: 'stop',
        threadKey,
        source: 'typed',
        stopperUserId: turn.userId,
        cutoffTs: turn.messageTs,
        ...bound,
      }
    : { kind: 'check_in', threadKey, ...bound };
}

/** How settleSlackSteering left a stop or check-in; `ended` is as with nothing running. */
type SlackSteeringSettlement = 'settled' | 'refused' | 'ended';

/**
 * Settle a stop or check-in the thread's run took (KTD1). When that run is
 * another Agent's than the one the sender was routed to (the previous
 * owner's, after a handoff), only a sender who may use that Agent here
 * steers it (R3): the request is decided again bound to that Agent, so a
 * handoff mid-run does not hide the running turn from them. Anyone else's
 * stop is refused privately, and their check-in gets no answer, since what
 * it would tell is that Agent's run's (R11). A run that ended meanwhile
 * leaves nothing to steer (`ended`). One still moving on to other Agents
 * after two decisions is refused the same way, fail closed (`unsettled`).
 * The message's claims are held already; a failure gives them back and
 * rethrows, so a redelivery decides it again.
 */
async function settleSlackSteering(input: {
  decision: TurnSteeringInterception;
  request: SlackSteeringAdmission;
  keys: readonly [string, string];
  mayUse(agentId: string): Promise<boolean>;
  turn: NormalizedSlackTurn;
  state: SlackStateStore;
  client: ReturnType<typeof createSlackWebClient>;
  platformEnv: PlatformEnv | undefined;
  source?: TurnStopSource;
}): Promise<SlackSteeringSettlement> {
  let decision: TurnSteeringDecision = input.decision;
  try {
    // Twice at most: the thread's run may move on to yet another Agent's.
    for (let round = 0; decision.outcome === 'other_agent'; round += 1) {
      if (round === 2 || !input.state.steerTurn) {
        logSteeringAdmission('unsettled', input.source);
        break;
      }
      if (!(await input.mayUse(decision.agentId))) break;
      decision = await input.state.steerTurn({ ...input.request, agentId: decision.agentId });
    }
  } catch (err) {
    await releaseSteeringMessage(input.state, ...input.keys);
    throw err;
  }
  if (decision.outcome === 'other_agent') {
    if (input.request.kind === 'stop') {
      await tellIneligibleStopper(input.client, steeringReplyTarget(input.turn), input.source ?? 'typed');
    } else {
      logSteeringAdmission('check_in_refused');
    }
    return 'refused';
  }
  if (decision.outcome === 'enqueue') {
    logSteeringAdmission('ended', input.source);
    return 'ended';
  }
  await answerSlackSteering({
    decision,
    turn: input.turn,
    state: input.state,
    client: input.client,
    platformEnv: input.platformEnv,
    ...(input.source ? { source: input.source } : {}),
  });
  return 'settled';
}

/**
 * R3 across a handoff: whether the sender may use `agentId`, the Agent whose
 * run a stop or check-in reached, by the rule routing applies to a reply of
 * theirs to it in this thread. An Agent that no longer exists is a no; a
 * retryable lookup failure throws.
 */
async function mayUseRunningSlackAgent(input: {
  agentId: string;
  turn: NormalizedSlackTurn;
  surface: AssignmentSurface;
  actor: ResolvedAgentRoutingActor;
  config: AppStores['config'];
  transport: SlackTransport;
}): Promise<boolean> {
  const { turn, config, actor } = input;
  const agent = await config.getAgent(input.agentId).catch((err: unknown) => {
    if (isRetryableDependencyFailure(err)) throw err;
    return undefined;
  });
  return mayUseThreadAgent({
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    agent,
    surface: input.surface,
    actor: actor.routing,
    config,
    authorizeUserAgent: async (candidate) => resolvePrivateAgentAccess({
      agent: candidate,
      workspaceId: turn.workspaceId,
      grants: await config.listAgentChannelGrants(turn.workspaceId),
      actor: privateAgentActor(actor, turn.userId),
      transport: input.transport,
    }),
  });
}

/**
 * Act on a stop or check-in the thread's run took. A stop is recorded and
 * already offered to its runner; the stopped ending posts its note. A
 * check-in reads the run's facts without touching the run and answers only
 * the asker (R9-R11). Nothing here is retried: the claims already make a
 * Slack retry a duplicate.
 */
async function answerSlackSteering(input: {
  decision: Extract<TurnSteeringDecision, { outcome: 'stopped' | 'check_in' }>;
  turn: NormalizedSlackTurn;
  state: SlackStateStore;
  client: ReturnType<typeof createSlackWebClient>;
  platformEnv: PlatformEnv | undefined;
  target?: SteeringReplyTarget;
  /** Slack's Stop button rather than a typed message. */
  source?: TurnStopSource;
}): Promise<void> {
  const { decision } = input;
  logSteeringAdmission(
    decision.outcome,
    input.source,
    decision.outcome === 'stopped' ? { created: decision.stop.created } : undefined,
  );
  if (decision.outcome === 'stopped') {
    // Node has no state store alarm: its relay delivers the new stop in this
    // process, beside the run it stops (KTD16). Never awaited, and never
    // rejects; on Cloudflare the state store delivered it already.
    if (decision.stop.created) void wakeNodeTurnRelay(input.platformEnv);
    return;
  }
  const facts = await readSteeringRunFacts(decision.run, {
    state: input.state,
    env: input.platformEnv as Record<string, unknown> | undefined,
  });
  await replyToSteering(
    input.client,
    input.target ?? steeringReplyTarget(input.turn),
    slackCheckInReply({ facts, dispatched: decision.run.dispatched }),
  );
}

/**
 * Claim a steering message's event and message keys, as ordinary admission
 * does (a Stop press claims its event and the press itself).
 */
async function claimSteeringMessage(
  state: SlackStateStore,
  evtKey: string,
  msgKey: string,
): Promise<boolean> {
  if (!(await state.claim(evtKey))) return false;
  if (await state.claim(msgKey)) return true;
  await state.release(evtKey);
  return false;
}

/** Give a steering message's claims back, so a redelivery decides it again. */
async function releaseSteeringMessage(
  state: SlackStateStore,
  evtKey: string,
  msgKey: string,
): Promise<void> {
  await state.release(evtKey);
  await state.release(msgKey);
}

async function replyToSteering(
  client: ReturnType<typeof createSlackWebClient>,
  target: SteeringReplyTarget,
  text: string,
): Promise<void> {
  try {
    await postSteeringReply(client, target, text);
  } catch (err) {
    console.warn('[chickpea] steering reply failed:', sanitizeError(err));
  }
}

/**
 * A stop or check-in typed at the top of a DM means the sender's single
 * running DM thread (KTD1); with none or several, the sender gets a hint in
 * a reply to their message. It is never queued as a turn.
 */
async function steerTopLevelDirectMessage(input: {
  command: SlackSteeringCommand;
  turn: NormalizedSlackTurn;
  evtKey: string;
  msgKey: string;
  state: SlackStateStore;
  client: ReturnType<typeof createSlackWebClient>;
  platformEnv: PlatformEnv | undefined;
}): Promise<void> {
  const { turn, state } = input;
  if (!(await claimSteeringMessage(state, input.evtKey, input.msgKey))) return;
  const target = steeringReplyTarget(turn);
  let decision: Extract<TurnSteeringDecision, { outcome: 'stopped' | 'check_in' }> | undefined;
  let running: string[];
  try {
    running = await state.runningDirectThreads?.({
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      requesterUserId: turn.userId,
    }) ?? [];
    if (running.length === 1) {
      const steered = await state.steerTurn?.(
        slackSteeringRequest(input.command, running[0]!, turn),
      );
      // Unbound (no Agent): the sender's own run in their DM.
      if (steered?.outcome === 'stopped' || steered?.outcome === 'check_in') decision = steered;
    }
  } catch (err) {
    // Free the claims so a redelivery decides it again; a recorded stop is
    // idempotent, so deciding twice records one stop.
    await releaseSteeringMessage(state, input.evtKey, input.msgKey);
    throw err;
  }
  if (decision) {
    await answerSlackSteering({
      decision,
      turn,
      state,
      client: input.client,
      platformEnv: input.platformEnv,
      target,
    });
    return;
  }
  // Several running threads, or none (the one just finished).
  await replyToSteering(
    input.client,
    target,
    running.length > 1
      ? STEERING_REPLY_TEXT.directSeveralRunning
      : STEERING_REPLY_TEXT.directNoneRunning,
  );
}

/**
 * R3: a stop typed by someone who may not use the thread's Agent leaves its
 * run alone, and only they are told. True when the stop was answered here;
 * false leaves the message to today's routing feedback (no run in progress,
 * not a stop, or the store could not say).
 */
async function refuseIneligibleSlackStop(input: {
  turn: NormalizedSlackTurn;
  evtKey: string;
  msgKey: string;
  state: SlackStateStore;
  config: AppStores['config'];
  client: ReturnType<typeof createSlackWebClient>;
  botUserId: string;
  runtimeContract: ResolvedAssignment['runtimeContract'];
}): Promise<boolean> {
  const { turn, state } = input;
  try {
    const route = await input.config.getAgentThreadRoute(
      turn.workspaceId,
      turn.channelId,
      turn.threadTs,
    );
    const agent = route
      ? await input.config.getAgent(route.agentId).catch(() => undefined)
      : undefined;
    const command = slackSteeringCommand(turn.text, {
      botUserId: input.botUserId,
      agentUserGroupId: agent?.slackPresence?.userGroupId,
    });
    if (command !== 'stop') return false;
  } catch {
    return false;
  }
  const refusal = await refuseSlackStop({
    threadKey: turnStopThreadKey(
      turn,
      input.runtimeContract ? { runtimeContract: input.runtimeContract } : {},
    ),
    keys: [input.evtKey, input.msgKey],
    target: steeringReplyTarget(turn),
    state,
    client: input.client,
    source: 'typed',
  });
  return refusal !== 'idle';
}

/**
 * R3 for a typed stop and the Stop button alike: a stop from someone who may
 * not use the thread's Agent leaves its run alone, and only they are told,
 * once per stop (its claim keys). `idle` when nothing runs in the thread, or
 * the store could not say: there is no run to refuse.
 */
async function refuseSlackStop(input: {
  threadKey: string;
  keys: readonly [string, string];
  target: SteeringReplyTarget;
  state: SlackStateStore;
  client: ReturnType<typeof createSlackWebClient>;
  source: TurnStopSource;
}): Promise<'refused' | 'duplicate' | 'idle'> {
  try {
    const decision = await input.state.steerTurn?.({ kind: 'message', threadKey: input.threadKey });
    if (decision?.outcome !== 'enqueue' || !decision.undelivered) return 'idle';
  } catch {
    return 'idle';
  }
  if (!(await claimSteeringMessage(input.state, ...input.keys))) return 'duplicate';
  await tellIneligibleStopper(input.client, input.target, input.source);
  return 'refused';
}

/** The private R3 note to someone whose stop was refused (its claims held). */
async function tellIneligibleStopper(
  client: ReturnType<typeof createSlackWebClient>,
  target: SteeringReplyTarget,
  source: TurnStopSource,
): Promise<void> {
  logSteeringAdmission('stop_refused', source);
  await replyToSteering(client, target, STEERING_REPLY_TEXT.ineligibleStop);
}

async function handleMemberJoinedChannel(
  payload: SlackEventFixture,
  stores: AppStores,
  platformEnv: PlatformEnv | undefined,
  installedBotUserId: string | undefined,
  credentials: ResolvedSlackInstallationCredentials,
  publicWelcomeEnabled: boolean,
  execution?: SlackEventExecution,
): Promise<void> {
  const event = payload.event;
  if (!isSlackMemberJoinedChannelEvent(event)) {
    return;
  }

  const workspaceId = payload.team_id ?? event.team;
  if (!workspaceId) return;
  const resolvedBotUserId = execution?.botUserId ??
    await resolveInstallationBotUserId(installedBotUserId, credentials, platformEnv);
  const client = execution?.client ?? (
    credentials.botToken ? createSlackWebClient(credentials.botToken) : undefined
  );
  if (!resolvedBotUserId || event.user !== resolvedBotUserId || !client) return;
  const transport = execution?.transport ?? createDirectSlackTransport(credentials.botToken!);
  let channel;
  try {
    channel = await transport.lookupChannel(event.channel);
  } catch {
    // Unknown privacy must never become a public welcome.
    return;
  }
  if (channel.id !== event.channel || channel.archived || !channel.member) return;

  if (channel.private) {
    if (!event.inviter || event.inviter === resolvedBotUserId) return;
    if (!await stores.slackState.claim(`evt:${payload.event_id}`)) return;
    const setupExecution: PrivateChannelSetupExecution = {
      stores, transport, client, botUserId: resolvedBotUserId,
      ...(platformEnv ? { platformEnv } : {}),
    };
    try {
      const setup = await privateChannelSetupService(setupExecution).begin({
        workspaceId, channelId: event.channel, inviterSlackUserId: event.inviter,
      });
      if (setup.agents.length === 0) return;
      const adminUrl = await privateChannelSetupAdminUrl(setupExecution);
      const card = privateChannelSetupCard({
        setupId: setup.setupId,
        agents: setup.agents.map((agent) => ({ ...agent, id: agent.agentId })),
        truncated: setup.choicesTruncated,
        ...(adminUrl ? { adminUrl } : {}),
      });
      await client.chat.postEphemeral({ channel: event.channel, user: event.inviter, ...card });
    } catch (error) {
      console.warn('[chickpea] private Channel setup card unavailable:', sanitizeError(error));
    }
    return;
  }

  // Public courtesy messages retain the existing enabled-grant and setting gates.
  if (!publicWelcomeEnabled) return;
  try {
    const grants = await stores.config.listAgentChannelGrants(workspaceId, event.channel);
    if (!grants.some((grant) => grant.status === 'active')) return;
  } catch {
    return;
  }

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

/**
 * Whether a turn continues only a thread an Agent already owns. A reaction
 * or a plain reply does; a reply that names an Agent's handle does not: it
 * addresses that Agent directly, like a root mention, so "@oncall what is
 * this?" under an alert nobody has answered reaches @oncall. Routing still
 * decides which Agent that is and whether it may work in this channel.
 */
export function turnRequiresOwnedThread(turn: Pick<NormalizedSlackTurn, 'source' | 'text'>): boolean {
  if (turn.source === 'reaction_added') return true;
  return turn.source === 'implicit_thread_reply' && parseAgentUserGroupMentions(turn.text).length === 0;
}

/** A Slack event's files, for the image references the thread record keeps. */
function slackEventFiles(event: SlackEventFixture['event']): unknown {
  return 'files' in event ? event.files : undefined;
}

/**
 * Keep a Slack-visible reply in the thread record when an Agent is part of
 * that thread: people who did not address the Agent, guests, apps and alert
 * bots, other AI agents. Nothing is kept for threads no Agent is in. A
 * record write that fails loses only this context row, never the event.
 */
async function recordAgentThreadMessage(
  config: Pick<ConfigStore, 'getAgentThreadRoute' | 'putSlackPublicContext'>,
  workspaceId: string,
  event: SlackMessageEvent,
  botUserId: string | undefined,
): Promise<void> {
  try {
    await recordSlackThreadEventMessage(
      config,
      workspaceId,
      event,
      botUserId ? { botUserId } : {},
      async (rootTs) => Boolean(await config.getAgentThreadRoute(workspaceId, event.channel, rootTs)),
    );
  } catch {
    console.warn('[chickpea] thread record capture failed');
  }
}

export async function classifyCandidateTurn(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  platformEnv: PlatformEnv | undefined,
  client: ReturnType<typeof createSlackWebClient>,
  dependencies: {
    config?: NonNullable<Parameters<typeof assembleRetainedSlackContext>[2]>['store'];
    classify?: typeof classifySlackInteraction;
    /** The installation's app, so its reads are paced and its own rows labeled as Agent rows. */
    installation?: { transportMode: 'direct' | 'gateway'; botUserId?: string };
  } = {},
): Promise<{
  classification: Awaited<ReturnType<typeof classifySlackInteraction>>;
  requestedModel: string | null;
}> {
  const requestedModel = assignment.model ?? null;
  const hydrated = await hydrateTurnSlackContext({
    client,
    turn,
    ...(dependencies.installation?.botUserId ? { botUserId: dependencies.installation.botUserId } : {}),
    sharedAppReads: sharesSlackAppReadBudget({
      transportMode: dependencies.installation?.transportMode, env: platformEnv, client,
    }),
    state: getSlackStateStore(platformEnv),
    ...(assignment.runtimeContract === 'chickpea-v1' && dependencies.config
      ? { record: dependencies.config }
      : {}),
    // The turn this classifies needs the shared app's one read a minute.
    pacedReads: false,
    maxMessages: 12,
    maxPages: 2,
  });
  const context = await assembleRetainedSlackContext(hydrated, turn, {
    ...(assignment.runtimeContract === 'chickpea-v1' && dependencies.config
      ? { store: dependencies.config, agentId: assignment.agentId }
      : {}),
    maxMessages: 12,
  });
  const classification = await (dependencies.classify ?? classifySlackInteraction)({
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
    recentContext: [
      ...context.messages.map((message) => `${message.userId}: ${message.text}`),
      ...(context.truncated || context.degradations.length > 0
        ? ['Slack context is incomplete; missing history is not evidence that this request is unrelated.']
        : []),
    ],
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
