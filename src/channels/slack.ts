// flue-blueprint: channel/slack@1
import {
  createSlackChannel,
  type SlackChannel,
  type SlackChannelOptions,
} from '@flue/slack';
import { createChannelRouter } from '@flue/runtime';
import { Hono } from 'hono';

import { resolveBetterAuthEnvironment } from '../auth/better-auth-environment.ts';
import { applySlackUserChange } from '../auth/slack-membership-events.ts';
import { resolveEffectiveSlackConfig } from '../config/effective-config.ts';
import { resolveModelCredentialAttribution } from '../config/model-credential-refs.ts';
import { resolveAgentModel } from '../config/model-policy.ts';
import {
  ModelResolutionError,
  NoAssignmentError,
  SlackIdentityRevisionConflictError,
} from '../config/errors.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { resolveAssignment, type AssignmentSurface } from '../config/resolver.ts';
import { getOrCreateSnapshot } from '../config/snapshot-store.ts';
import {
  getSlackCredentialDependencies,
  resolveStores,
  type AppStores,
  type PlatformEnv,
} from '../config/state-backend.ts';
import {
  tagStateStub,
  type SlackInteractionProgress,
  type TurnJob,
} from '../config/state-rpc.ts';
import {
  WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  type ResolvedAssignment,
  type SlackIdentity,
} from '../config/types.ts';
import {
  resolveSlackBehaviorSettings,
} from '../slack/behavior-settings.ts';
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
import type { SlackClaimStore } from '../slack/claim-store.ts';
import {
  resolveSlackCredentials,
  resolveSlackPublicUrl,
  slackAuthTest,
} from '../slack/credentials.ts';
import {
  resolveSlackIdentityCredentials,
  type ResolvedSlackIdentityCredentials,
} from '../slack/identity-credentials.ts';
import {
  completeWorkspaceDefaultSlackConnectionIfVerified,
} from '../slack/identity-bootstrap.ts';
import { SlackInstallOAuthService } from '../slack/install-oauth.ts';
import {
  assignmentUsesSlackIdentity,
  resolveSlackIdentityDmAssignment,
} from '../slack/identity-admission.ts';
import {
  recordSlackIdentityFanoutIgnored,
  recordSlackIdentityOperationalEvent,
} from '../slack/identity-observability.ts';
import {
  handlePendingSlackIdentityChallenge,
  MAX_SLACK_INGRESS_BYTES,
  resolveSlackIngressCandidate,
  validateSlackIdentityEnvelopeBinding,
} from '../slack/identity-ingress.ts';
import {
  prepareSlackShadowAdmission,
  resolveSlackAdmissionTruth,
  slackAdmissionTruthReader,
  type SlackAdmissionTruth,
} from '../slack/work-admission.ts';
import {
  renderChannelOnboarding,
  renderUnassignedChannelHint,
} from '../slack/message-format.ts';
import {
  createSlackWebClient,
  sanitizeError,
} from '../slack/run-turn.ts';
import { slackThreadKey } from '../slack/thread-key.ts';
import { normalizeSlackTurn } from '../slack/turn-normalization.ts';
import { wakeNodeTurnRelay } from '../slack/node-turn-relay.ts';
import { hydrateSlackContextViaWebClient } from '../slack/web-client-context.ts';
import { WebClientPresenter } from '../slack/web-client-presenter.ts';
import { publishSlackAdmissionProgress } from '../slack/work-admission-progress.ts';
import { parseSlackParticipationControl } from '../slack/participation-control.ts';
import { selectSlackExecutionAuthority } from '../work/authority.ts';
import { EGRESS_SETTING_KEY, parseEgressPolicy } from '../config/egress.ts';
import {
  isSlackMemberJoinedChannelEvent,
  type NormalizedSlackTurn,
  type SlackEventFixture,
} from '../slack/types.ts';

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
const MAX_VERIFIED_SLACK_IDENTITY_CHANNELS = 64;
interface VerifiedSlackIdentityChannel {
  credentialRevision: string | null;
  signingSecret: string;
  channel: SlackChannel;
}

const verifiedChannels = new Map<string, VerifiedSlackIdentityChannel>();

function channelForIdentity(
  identityId: string,
  signingSecret: string,
  credentialRevision: string | null,
): SlackChannel {
  const cached = verifiedChannels.get(identityId);
  if (
    cached?.credentialRevision === credentialRevision &&
    cached.signingSecret === signingSecret
  ) {
    verifiedChannels.delete(identityId);
    verifiedChannels.set(identityId, cached);
    return cached.channel;
  }
  const entry: VerifiedSlackIdentityChannel = {
    credentialRevision,
    signingSecret,
    channel: createSlackChannel({
      signingSecret,
      bodyLimit: MAX_SLACK_INGRESS_BYTES,
      events: handleSlackEventsForIdentity(identityId, credentialRevision),
    }),
  };
  verifiedChannels.delete(identityId);
  verifiedChannels.set(identityId, entry);
  while (verifiedChannels.size > MAX_VERIFIED_SLACK_IDENTITY_CHANNELS) {
    const oldest = verifiedChannels.keys().next().value as string | undefined;
    if (!oldest) break;
    verifiedChannels.delete(oldest);
  }
  return entry.channel;
}

// instanceId/parseInstanceId are pure identity helpers, independent
// of the signing secret; serve them from whichever instance exists. The
// placeholder-keyed instance can never verify anything — its routes are not
// the ones exported below, and the events gate always resolves the real
// secret first.
function identityChannel(): SlackChannel {
  return verifiedChannels.values().next().value?.channel ??
    channelForIdentity(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
      'unconfigured-placeholder',
      null,
    );
}

type SlackRouteHandler = SlackChannel['routes'][number]['handler'];

async function recordSlackIngressRejection(
  response: unknown,
  identity: SlackIdentity,
): Promise<void> {
  if (!(response instanceof Response) || response.status !== 401) return;
  const body = await response.clone().json().catch(() => undefined) as
    | { error?: unknown }
    | undefined;
  if (typeof body?.error === 'string' && body.error.startsWith('slack_identity_')) {
    return;
  }
  recordSlackIdentityOperationalEvent({
    operation: 'ingress_rejected',
    identityId: identity.id,
    ...(identity.appId ? { appId: identity.appId } : {}),
    lifecycle: identity.lifecycle,
    outcome: 'rejected',
    failureClass: 'signature_or_timestamp',
  });
}

/**
 * Events gate: resolve the signing secret (env > wizard-stored) per request,
 * then delegate to the real channel's verification + dispatch. No secret yet
 * (first-run, wizard not completed) → fail closed (401). Fresh setup uses the
 * opaque per-install ingress below; this fixed route remains only as the signed
 * compatibility route for already-installed apps.
 */
const verifiedEventsHandler: SlackRouteHandler = async (c, next) => {
  const platformEnv = c.env as PlatformEnv | undefined;
  const stores = resolveStores(platformEnv);
  const identity = await stores.config.getSlackIdentity(
    WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
  );
  if (
    identity.lifecycle === 'setup_incomplete' ||
    identity.lifecycle === 'credentials_pending'
  ) {
    const response = await handlePendingSlackIdentityChallenge(
      c.req.raw,
      identity,
      stores.settings,
    );
    if (response.ok) {
      await finalizePendingWorkspaceDefaultSlackConnection(
        stores,
        platformEnv,
        identity,
      );
    }
    return response;
  }
  const credentials = await resolveSlackIdentityCredentials(
    identity.id,
    platformEnv,
  );
  const { signingSecret } = credentials;
  if (!signingSecret) {
    return c.json({ error: 'slack_not_configured' }, 401);
  }
  const route = channelForIdentity(
    identity.id,
    signingSecret,
    credentials.connectionRevision,
  ).routes.find((candidate) => candidate.path === '/events');
  if (!route) {
    // Unreachable: createSlackChannel with an events handler always mounts
    // /events. Guarded (not asserted away) so a library change fails loudly.
    throw new Error('slack channel lost its /events route');
  }
  const response = await route.handler(c, next);
  await recordSlackIngressRejection(response, identity);
  return response;
};

const scopedIdentityEventsHandler: SlackRouteHandler = async (c, next) => {
  const ingressKey = c.req.param('ingressKey');
  if (!ingressKey) return c.json({ error: 'slack_identity_unknown' }, 401);
  const platformEnv = c.env as PlatformEnv | undefined;
  const stores = resolveStores(platformEnv);
  const candidate = await resolveSlackIngressCandidate(stores.config, ingressKey);
  if (!candidate.found) return c.json({ error: 'slack_identity_unknown' }, 401);

  // Pending dedicated identities may already have a stored signing secret.
  // Keep their ingress on the bounded challenge recorder until setup is
  // complete so Slack's Retry action replaces an expired handshake instead of
  // being acknowledged without leaving an envelope for the admin verifier.
  // The recorder accepts only url_verification payloads; event callbacks still
  // fail closed while the identity is unavailable.
  if (
    candidate.identity.lifecycle === 'setup_incomplete' ||
    candidate.identity.lifecycle === 'credentials_pending'
  ) {
    const response = await handlePendingSlackIdentityChallenge(
      c.req.raw,
      candidate.identity,
      stores.settings,
    );
    if (
      response.ok &&
      candidate.identity.kind === 'workspace_default' &&
      candidate.identity.lifecycle === 'credentials_pending'
    ) {
      await finalizePendingWorkspaceDefaultSlackConnection(
        stores,
        platformEnv,
        candidate.identity,
      );
    }
    return response;
  }

  const credentials = await resolveSlackIdentityCredentials(
    candidate.identity.id,
    platformEnv,
  );
  if (!credentials.signingSecret) {
    return c.json({ error: 'slack_not_configured' }, 401);
  }

  const route = channelForIdentity(
    candidate.identity.id,
    credentials.signingSecret,
    credentials.connectionRevision,
  ).routes.find((routeCandidate) => routeCandidate.path === '/events');
  if (!route) throw new Error('slack channel lost its /events route');
  const response = await route.handler(c, next);
  await recordSlackIngressRejection(response, candidate.identity);
  return response;
};

async function finalizePendingWorkspaceDefaultSlackConnection(
  stores: AppStores,
  platformEnv: PlatformEnv | undefined,
  identity: SlackIdentity,
): Promise<void> {
  try {
    const setup = await stores.identity.getSlackSetupTransaction('setup_default');
    if (setup?.state === 'bot_install_pending') {
      await new SlackInstallOAuthService({
        identity: stores.identity,
        credentials: getSlackCredentialDependencies(platformEnv),
        config: stores.config,
        settings: stores.settings,
      }).finalizeWaitingInstallation(setup.id);
    } else {
      await completeWorkspaceDefaultSlackConnectionIfVerified({
        config: stores.config,
        settings: stores.settings,
        identityId: identity.id,
        credentialDependencies: {
          state: stores.identity,
          env: platformEnv,
        },
      });
    }
  } catch (error) {
    console.error(
      '[chickpea] Slack Events URL completion failed:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

const routes: SlackChannel['routes'] = [
  { method: 'POST', path: '/events', handler: verifiedEventsHandler },
];

function createSlackIdentityRouter(): ReturnType<typeof createChannelRouter> {
  const router = new Hono();
  router.post('/events/:ingressKey', (c, next) =>
    scopedIdentityEventsHandler(c as never, next as never));
  router.route('/', createChannelRouter(routes));
  return router;
}

export const channel: SlackChannel = {
  // Path: /channels/slack/events
  routes,
  route: createSlackIdentityRouter,
  instanceId: (ref) => identityChannel().instanceId(ref),
  parseInstanceId: (id) => identityChannel().parseInstanceId(id),
};

function handleSlackEventsForIdentity(
  identityId: string,
  credentialRevision: string | null,
): NonNullable<SlackChannelOptions['events']> {
  return async ({ c, payload }) => {
    const platformEnv = c.env as PlatformEnv | undefined;
    const stores = resolveStores(platformEnv);
    let identity = await stores.config.getSlackIdentity(identityId);
    const binding = validateSlackIdentityEnvelopeBinding(identity, payload);
    if (!binding.valid) {
      recordSlackIdentityOperationalEvent({
        operation: 'binding_rejected',
        identityId: identity.id,
        ...(identity.appId ? { appId: identity.appId } : {}),
        lifecycle: identity.lifecycle,
        outcome: 'rejected',
        failureClass: binding.reason,
      });
      return c.json({ error: `slack_identity_${binding.reason}` }, 401);
    }

    if (
      identity.kind === 'workspace_default' &&
      (!identity.appId ||
        !identity.teamId ||
        identity.lifecycle === 'setup_incomplete' ||
        identity.lifecycle === 'credentials_pending')
    ) {
      const completesSetup =
        identity.lifecycle === 'setup_incomplete' ||
        identity.lifecycle === 'credentials_pending';
      try {
        identity = await stores.config.updateSlackIdentity(
          identity.id,
          identity.connectionRevision,
          {
            appId: payload.api_app_id,
            teamId: payload.team_id,
            ...(completesSetup
              ? {
                  lifecycle: 'connected' as const,
                  health: 'healthy' as const,
                  healthDetail: null,
                }
              : {}),
          },
        );
      } catch {
        const current = await stores.config.getSlackIdentity(identity.id);
        if (!validateSlackIdentityEnvelopeBinding(current, payload).valid) {
          return c.json({ error: 'slack_identity_changed' }, 409);
        }
        identity = current;
      }
    }

    const verifiedEventType = payload.type === 'event_callback' &&
        payload.event && typeof payload.event === 'object'
      ? (payload.event as { type?: unknown }).type
      : undefined;
    if (verifiedEventType === 'app_uninstalled' || verifiedEventType === 'tokens_revoked') {
      await recordSlackIdentityLifecycleEvent(identity, verifiedEventType, stores);
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

    if (identity.kind === 'dedicated' && identity.lifecycle !== 'connected') {
      return;
    }

    // a. Admission: only Events API callbacks; acknowledge and discard Agent
    // View lifecycle events before they can enter normalization or persistence.
    if (payload.type !== 'event_callback') return;
    const eventType = payload.event.type;
    if (
      eventType === 'app_home_opened' ||
      eventType === 'app_context_changed'
    ) {
      return;
    }
    // Capture the platform env up front — and BEFORE anything detaches: the
    // stores, the credential resolver, and the dispatch on Cloudflare all need
    // the bindings object `c` carries, and `c` itself must not be touched after
    // the events ack returns (its request scope ends with the response). On
    // node the env is ignored everywhere it is threaded.
    detach(
      c,
      processSlackEvent(
        payload as unknown as SlackEventFixture,
        platformEnv,
        identity.id,
      ).catch((err) => {
        console.error('[chickpea] Slack event intake failed:', sanitizeError(err));
      }),
    );
  };
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

async function recordSlackIdentityLifecycleEvent(
  identity: SlackIdentity,
  eventType: 'app_uninstalled' | 'tokens_revoked',
  stores: AppStores,
): Promise<void> {
  const patchFor = (current: SlackIdentity) => ({
    lifecycle: 'degraded' as const,
    health: eventType === 'app_uninstalled' || current.health === 'uninstalled'
      ? 'uninstalled' as const
      : 'unauthorized' as const,
    healthDetail: eventType,
  });
  try {
    await stores.config.updateSlackIdentity(
      identity.id,
      identity.connectionRevision,
      patchFor(identity),
    );
  } catch (error) {
    if (!(error instanceof SlackIdentityRevisionConflictError)) throw error;

    // A concurrent admin/lifecycle write may win the first CAS. Re-read once
    // and preserve the strongest Slack-owned terminal fact (uninstalled beats
    // token revocation). Do not revive a retired or newly reconnecting app;
    // those lifecycle transitions intentionally supersede this stale callback.
    const current = await stores.config.getSlackIdentity(identity.id);
    if (
      current.lifecycle === 'retired' ||
      current.lifecycle === 'setup_incomplete' ||
      current.lifecycle === 'credentials_pending'
    ) {
      return;
    }
    const patch = patchFor(current);
    if (
      current.lifecycle === patch.lifecycle &&
      current.health === patch.health &&
      current.healthDetail === patch.healthDetail
    ) {
      return;
    }
    await stores.config.updateSlackIdentity(
      current.id,
      current.connectionRevision,
      patch,
    );
  }
}

async function resolveIdentityBotUserId(
  identity: SlackIdentity,
  credentials: ResolvedSlackIdentityCredentials,
  platformEnv: PlatformEnv | undefined,
): Promise<string | undefined> {
  const configured = credentials.botUserId ?? identity.botUserId;
  if (configured) return configured;
  return identity.id === WORKSPACE_DEFAULT_SLACK_IDENTITY_ID
    ? resolveBotUserId(platformEnv)
    : undefined;
}

async function resolveIdentityGateAssignment(
  turn: NormalizedSlackTurn,
  surface: AssignmentSurface,
  identity: SlackIdentity,
  stores: AppStores,
): Promise<ResolvedAssignment | undefined> {
  if (surface === 'direct') {
    return resolveSlackIdentityDmAssignment(
      identity,
      turn.workspaceId,
      turn.channelId,
      stores.config,
    );
  }
  const frozen = await stores.snapshots.get(slackThreadKey(turn));
  if (frozen) return frozen;
  return resolveAssignment(
    turn.workspaceId,
    turn.channelId,
    { agents: stores.config, assignments: stores.config },
    { surface: 'channel' },
  );
}

async function requireSlackIdentityDmAssignment(
  identity: SlackIdentity,
  turn: NormalizedSlackTurn,
  stores: AppStores,
): Promise<ResolvedAssignment> {
  const assignment = await resolveSlackIdentityDmAssignment(
    identity,
    turn.workspaceId,
    turn.channelId,
    stores.config,
  );
  if (!assignment) throw new NoAssignmentError('Slack identity DMs are disabled');
  return assignment;
}

async function processSlackEvent(
  payload: SlackEventFixture,
  platformEnv: PlatformEnv | undefined,
  slackIdentityId: string,
): Promise<void> {
  // Store resolution is per-request and target-aware: on Node the factories
  // return the process-cached SQLite stores (claims + thread registry are
  // SQLite-backed in their own file, sibling of the Flue transcript DB, so a
  // Slack redelivery right after a restart is still suppressed and joined
  // threads stay continuable); on Cloudflare they proxy the state Durable
  // Object, which is why the handler threads `c.env` through.
  const stores = resolveStores(platformEnv);
  // Behavior switches (not credentials) follow the admin's env > stored >
  // default contract. Resolve against THIS request's settings store so Node
  // and Cloudflare (Durable Object-backed) observe the same saved switches.
  const behavior = await resolveSlackBehaviorSettings(platformEnv, stores.settings);
  const identity = await stores.config.getSlackIdentity(slackIdentityId);
  const credentials = await resolveSlackIdentityCredentials(
    slackIdentityId,
    platformEnv,
  );

  if (payload.event.type === 'member_joined_channel') {
    if (!behavior.welcomeOnJoin.value) {
      return;
    }
    await handleMemberJoinedChannel(payload, stores, platformEnv, identity, credentials);
    return;
  }

  // Build a no-network preliminary turn so Profile/identity eligibility is
  // known before auth.test, reactions.get, context reads, classification, or
  // any other Slack API call. The sentinel is replaced after the gate.
  const configuredBotUserId = credentials.botUserId ?? identity.botUserId;
  const preliminary = normalizeSlackTurn(payload, {
    slackIdentityId,
    botUserId: configuredBotUserId ?? '__chickpea_identity_gate__',
  });
  if (preliminary.status !== 'runnable') return;
  const preliminaryTurn = preliminary.turn;
  const state = stores.slackState;
  const preliminarySurface = turnSurface(preliminaryTurn);
  if (preliminarySurface === 'direct' && !behavior.allowDms.value) return;

  try {
    const gateAssignment = await resolveIdentityGateAssignment(
      preliminaryTurn,
      preliminarySurface,
      identity,
      stores,
    );
    if (!gateAssignment || !assignmentUsesSlackIdentity(gateAssignment, slackIdentityId)) {
      recordSlackIdentityFanoutIgnored(identity);
      return;
    }
  } catch (error) {
    if (error instanceof NoAssignmentError) {
      const hintBotUserId = await resolveIdentityBotUserId(identity, credentials, platformEnv);
      await postUnassignedChannelHint(
        preliminaryTurn,
        preliminarySurface,
        behavior.unassignedHint.value,
        state,
        hintBotUserId,
        credentials.botToken
          ? createSlackWebClient(credentials.botToken)
          : undefined,
        platformEnv,
      );
    }
    return;
  }

  const resolvedBotUserId = await resolveIdentityBotUserId(identity, credentials, platformEnv);
  const normalization = normalizeSlackTurn(payload, {
    slackIdentityId,
    ...(resolvedBotUserId ? { botUserId: resolvedBotUserId } : {}),
  });
  if (normalization.status !== 'runnable') return;
  const turn = normalization.turn;
  const candidateTurn =
    turn.source === 'ambient_channel_message' || turn.source === 'reaction_added';
  let threadKey = slackThreadKey(turn);

  // c. Implicit thread replies require a thread this app already started (a
  //    prior mention/DM). An unknown thread key produces nothing on the wire
  //    (S13). With the file-backed state store the registry survives
  //    restarts; `:memory:` keeps the old process-local semantics. Checked
  //    before any claim so a dropped reply stays fully silent.
  if (turn.source === 'implicit_thread_reply' && !(await state.has(threadKey))) {
    return;
  }
  if (
    turn.source === 'implicit_thread_reply' &&
    (await state.getParticipation(threadKey)) === 'mention_only'
  ) {
    return;
  }

  const surface = turnSurface(turn);
  if (surface !== preliminarySurface) return;

  // d. Claim BOTH the event id and the (channel, message-ts) so the
  //    app_mention + message fan-out for a single mention replies once.
  const evtKey = `evt:${payload.event_id}`;
  const msgKey = `msg:${turn.channelId}:${turn.messageTs}`;

  // e. Resolve the config for this turn before canonical admission acquires
  //    the claims. A failure here must not release keys owned by a concurrent
  //    sibling event or Slack retry.
  //    - CHANNELS freeze at the first turn: the gate resolves the effective
  //      config ONCE and writes the write-once snapshot, so the presenter and
  //      the durable agent both serve that same row (no first-turn attribution
  //      drift). A started thread is served from its snapshot even if its
  //      profile was since disabled/removed — a disable must not break an
  //      in-flight thread — and a snapshot exists only for a thread whose first
  //      turn passed this gate, so it cannot bypass fail-closed. Channels fail
  //      closed if unassigned and never fall through to the global '*,*'
  //      wildcard (see turnSurface / the resolver).
  //    - DIRECT conversations are one continuous session, not a
  //      discrete thread, so they are NOT frozen: they resolve current config
  //      every turn, so admin edits to the DM profile reach existing DM users.
  let assignment: ResolvedAssignment;
  try {
    const store = stores.config;
    const configStores = { agents: store, assignments: store };
    assignment = surface === 'direct'
      ? await requireSlackIdentityDmAssignment(identity, turn, stores)
      : !candidateTurn
        ? await getOrCreateSnapshot(stores.snapshots, threadKey, () =>
            resolveEffectiveSlackConfig(turn.workspaceId, turn.channelId, configStores).then(
              async (config) => {
                const modelCredential = await resolveModelCredentialAttribution(
                  config.model,
                  platformEnv,
                  stores.settings,
                  stores.usage,
                );
                return {
                  ...config,
                  ...(modelCredential ? { modelCredential } : {}),
                };
              },
            ),
          )
        : await resolveEffectiveSlackConfig(turn.workspaceId, turn.channelId, configStores);
  } catch (err) {
    // A model that cannot resolve is NOT fail-closed: admit with a best-effort
    // assignment so the turn still delivers the sanitized provider-failure
    // final (no snapshot is written — a misconfigured-model thread has no
    // usable config to freeze). Everything else (unassigned/disabled channel,
    // disabled DM default) is fail-closed and stays silent.
    const store = stores.config;
    if (err instanceof ModelResolutionError) {
      assignment = await resolveAssignment(
        turn.workspaceId,
        turn.channelId,
        { agents: store, assignments: store },
        { surface },
      );
    } else {
      console.error('[chickpea] no assignment for turn:', sanitizeError(err));
      // Fail-closed with feedback: the channel stays silent, but the person
      // who explicitly mentioned the bot gets an ephemeral pointer at /admin.
      // Detached so the events ack is not delayed by the Slack Web API call.
      if (err instanceof NoAssignmentError) {
        await postUnassignedChannelHint(
          turn,
          surface,
          behavior.unassignedHint.value,
          state,
          resolvedBotUserId,
          credentials.botToken
            ? createSlackWebClient(credentials.botToken)
            : undefined,
          platformEnv,
        );
      }
      return;
    }
  }

  if (!assignmentUsesSlackIdentity(assignment, slackIdentityId)) {
    recordSlackIdentityFanoutIgnored(identity);
    return;
  }

  // Direct-message assignments are intentionally live rather than snapshotted,
  // so attach the same non-secret credential attribution at admission time.
  // A model-resolution error still follows the existing sanitized-failure path.
  if (!assignment.modelCredential) {
    try {
      const model = assignment.model ?? resolveAgentModel(assignment.agent);
      const modelCredential = await resolveModelCredentialAttribution(
        model,
        platformEnv,
        stores.settings,
        stores.usage,
      );
      if (modelCredential) assignment = { ...assignment, modelCredential };
    } catch {
      // Reporting enrichment cannot change whether the turn is admitted.
    }
  }

  let claimsHeldByCanonicalAdmission = false;
  let canonicalRunId: string | undefined;
  let canonicalTurnJob: TurnJob | undefined;

  // Resolve actor/source truth only after assignment succeeds. This keeps an
  // unassigned channel's established zero-Slack-API behavior intact while
  // still authorizing before any canonical content or Run is written.
  const { botToken } = credentials;
  const slackClient = botToken ? createSlackWebClient(botToken) : undefined;
  if (
    turn.source === 'reaction_added' &&
    (!slackClient || !(await resolveReactionTargetContext(turn, slackClient)))
  ) {
    await state.claim(evtKey);
    await state.claim(msgKey);
    return;
  }
  threadKey = slackThreadKey(turn);
  turn.activeWorkAtAdmission = await state.isActiveWork(threadKey);
  const deterministicCommand = Boolean(parseMemoryCommand(turn.text)) ||
    (isRoutineSlackTurn(turn) && Boolean(parseRoutineCommand(turn.text)));
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
      ...(assignment.channelPromptAddendum
        ? { channelInstructions: assignment.channelPromptAddendum }
        : {}),
    });
    if (immediateIntent) turn.interactionIntent = immediateIntent;
  }
  let admissionTruth: SlackAdmissionTruth = {
    eligible: false,
    reason: 'slack_truth_unavailable',
  };
  if (botToken && resolvedBotUserId) {
    try {
      admissionTruth = await resolveSlackAdmissionTruth(
        turn,
        resolvedBotUserId,
        slackAdmissionTruthReader(botToken),
      );
    } catch {
      // Shadow truth is observational in U3. A transient resolver failure must
      // not change the established Slack execution path before authority cutover.
    }
  }
  if (identity.kind === 'dedicated' && !admissionTruth.eligible) {
    return;
  }

  // Ambient messages and inbound reactions are candidates, not durable work.
  // Deterministic eligibility and the live rollback/assignment ceiling run
  // before the model classifier, so mention-only channels create no cost.
  if (
    candidateTurn &&
    (!behavior.ambientParticipation.value || assignment.participationMode === 'mention_only')
  ) {
    await state.claim(evtKey);
    await state.claim(msgKey);
    return;
  }
  if (candidateTurn && !admissionTruth.eligible) {
    console.info(
      `[chickpea] Slack candidate denied: ${admissionTruth.reason} (${turn.source})`,
    );
    await state.claim(evtKey);
    await state.claim(msgKey);
    return;
  }

  const participationControl = !candidateTurn && admissionTruth.eligible
    ? parseSlackParticipationControl(turn.text)
    : null;
  if (participationControl?.scope === 'thread') {
    await state.setParticipation(threadKey, participationControl.mode);
  } else if (participationControl?.scope === 'channel' && surface === 'channel') {
    const current = await stores.config.getAssignment(turn.workspaceId, turn.channelId);
    const currentChannel = await stores.config.getChannel(turn.workspaceId, turn.channelId);
    await stores.config.putChannel({
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      ...(currentChannel?.label || assignment.channelLabel
        ? { label: currentChannel?.label ?? assignment.channelLabel }
        : {}),
      ...(currentChannel?.additionalInstructions || assignment.channelPromptAddendum
        ? {
            additionalInstructions:
              currentChannel?.additionalInstructions ?? assignment.channelPromptAddendum,
          }
        : {}),
      participationMode: participationControl.mode,
      lifecycle: currentChannel?.lifecycle ?? 'active',
    });
    if (!current) {
      await stores.config.putAssignment({
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        agentId: assignment.agentId,
      });
    }
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

      // Candidate classification deliberately did not create a frozen thread
      // snapshot. Promotion now freezes the same effective assignment that the
      // full agent will execute under.
      if (surface === 'channel') {
        assignment = await getOrCreateSnapshot(stores.snapshots, threadKey, () =>
          resolveEffectiveSlackConfig(turn.workspaceId, turn.channelId, {
            agents: stores.config,
            assignments: stores.config,
          }).then(async (config) => {
            const modelCredential = await resolveModelCredentialAttribution(
              config.model,
              platformEnv,
              stores.settings,
              stores.usage,
            );
            return {
              ...config,
              ...(modelCredential ? { modelCredential } : {}),
            };
          }));
      }
    } finally {
      releaseClassifier();
    }
  }

  if (!assignmentUsesSlackIdentity(assignment, slackIdentityId)) {
    recordSlackIdentityFanoutIgnored(identity);
    if (promotedDecisionKey) await state.release(promotedDecisionKey);
    return;
  }

  // Canonical Work admission stores a concrete configured model. A missing
  // model is an operator configuration error, but it must still follow the
  // established legacy turn path so Slack receives one sanitized failure
  // instead of an intake exception and silence.
  let modelReadyForCanonicalAdmission = true;
  try {
    void (assignment.model ?? resolveAgentModel(assignment.agent));
  } catch (error) {
    if (!(error instanceof ModelResolutionError)) throw error;
    modelReadyForCanonicalAdmission = false;
  }

  if (admissionTruth.eligible && modelReadyForCanonicalAdmission) {
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
        (isRoutineSlackTurn(turn) && Boolean(parseRoutineCommand(turn.text))),
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
    try {
      const result = await state.admitCanonical({
        evtKey,
        msgKey,
        threadKey,
        admission,
        turnJob: canonicalTurnJob,
        presentation: {
          root: {
            workspaceId: turn.workspaceId,
            channelId: turn.channelId,
            threadTs: turn.threadTs,
            requesterUserId: turn.userId,
          },
          ...(turn.interactionIntent?.disposition === 'work'
            ? { taskLabels: turn.interactionIntent.checklist }
            : {}),
          features: {
            progressiveStreaming: behavior.progressiveStreaming.value,
            nativeTasks: behavior.nativeTasks.value,
          },
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

  let admissionInteractionProgress: SlackInteractionProgress | undefined;
  const shouldAcknowledgeAtAdmission = slackClient && !candidateTurn && !deterministicCommand &&
    turn.interactionIntent?.disposition !== 'react_only';
  if (shouldAcknowledgeAtAdmission) {
    const presenter = new WebClientPresenter(slackClient, {
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      agentName: assignment.agent.name,
      agentId: assignment.agent.id,
      userId: turn.userId,
      workspaceId: turn.workspaceId,
    });
    admissionInteractionProgress = await publishSlackAdmissionProgress({
      turn,
      ...(turn.interactionIntent?.disposition === 'work'
        ? { checklist: turn.interactionIntent.checklist }
        : {}),
      presenter,
      record: async (patch) => {
        if (durableCanonicalTurnJob && state.recordSlackInteractionProgress) {
          await state.recordSlackInteractionProgress(durableCanonicalTurnJob.id, patch);
        }
      },
    });
  }

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
    const enqueued = await tagStateStub(platformEnv).enqueueTurn(job);
    if (!enqueued.ok) {
      // Enqueue failed before anything ran: free the claims so a Slack
      // redelivery can re-drive, and stay silent.
      await state.release(evtKey);
      await state.release(msgKey);
      if (promotedDecisionKey) await state.release(promotedDecisionKey);
      if (marksActiveWork) await state.setActiveWork(threadKey, msgKey, false);
      console.error('[chickpea] enqueue turn failed:', enqueued.error.message);
    }
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
    if (admissionInteractionProgress && state.recordSlackInteractionProgress) {
      await state.recordSlackInteractionProgress(msgKey, admissionInteractionProgress);
    }
  }
  await wakeNodeTurnRelay(platformEnv).catch((err) => {
    console.error('[chickpea] node turn wake failed:', sanitizeError(err));
  });
}

async function handleMemberJoinedChannel(
  payload: SlackEventFixture,
  stores: AppStores,
  platformEnv: PlatformEnv | undefined,
  identity: SlackIdentity,
  credentials: ResolvedSlackIdentityCredentials,
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
    const store = stores.config;
    const assignment = await resolveAssignment(
      workspaceId,
      event.channel,
      { agents: store, assignments: store },
      { surface: 'channel' },
    );
    if (!assignmentUsesSlackIdentity(assignment, identity.id)) return;
  } catch {
    return;
  }

  const resolvedBotUserId = await resolveIdentityBotUserId(identity, credentials, platformEnv);
  if (!resolvedBotUserId || event.user !== resolvedBotUserId || !credentials.botToken) return;

  const state = stores.slackState;
  const evtKey = `evt:${payload.event_id}`;
  if (!(await state.claim(evtKey))) {
    return;
  }

  try {
    await createSlackWebClient(credentials.botToken).chat.postMessage({
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
  const requestedModel = assignment.model ?? (() => {
    try {
      return resolveAgentModel(assignment.agent);
    } catch {
      return null;
    }
  })();
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
    ...(assignment.channelPromptAddendum
      ? { channelInstructions: assignment.channelPromptAddendum }
      : {}),
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

// Fail-closed feedback: an EXPLICIT mention in a channel with no enabled
// assignment posts an ephemeral hint to the mentioner only — the channel gets
// nothing and ambient messages get nothing. A claim on the channel rate-limits
// the hint to one per claim-TTL window; a FAILED post releases the claim (it
// delivered nothing, so a later mention re-hinting cannot double-post). The
// whole body is fenced: this runs detached and must never throw into the
// events route, even if the claim store itself errors.
async function postUnassignedChannelHint(
  turn: NormalizedSlackTurn,
  surface: AssignmentSurface,
  enabled: boolean,
  state: SlackClaimStore,
  botUserId: string | undefined,
  client: ReturnType<typeof createSlackWebClient> | undefined,
  platformEnv: PlatformEnv | undefined,
): Promise<void> {
  try {
    if (surface !== 'channel' || turn.source !== 'app_mention') {
      return;
    }
    // A 'G…' id is ambiguous (legacy private channel vs group DM) and is only
    // classified as a channel to stay fail-closed for turns. The hint must not
    // treat it as a configurable channel — /admin?channel=G… would point at a
    // group DM — so hint only for unambiguous 'C…' channel ids.
    if (!turn.channelId.startsWith('C')) {
      return;
    }
    if (!enabled) {
      return;
    }
    if (!botUserId || !client) {
      return;
    }
    const hintKey = `hint:${turn.workspaceId}:${turn.channelId}`;
    if (!(await state.claim(hintKey))) {
      return;
    }
    try {
      await client.chat.postEphemeral({
        channel: turn.channelId,
        user: turn.userId,
        text: renderUnassignedChannelHint({
          botUserId,
          channelId: turn.channelId,
          publicUrl: await resolveSlackPublicUrl(platformEnv),
        }),
      });
    } catch (err) {
      await state.release(hintKey);
      throw err;
    }
  } catch (err) {
    console.error('[chickpea] unassigned-channel hint failed:', sanitizeError(err));
  }
}
