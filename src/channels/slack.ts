// flue-blueprint: channel/slack@1
import {
  createSlackChannel,
  type SlackChannel,
  type SlackChannelOptions,
} from '@flue/slack';

import { resolveEffectiveSlackConfig } from '../config/effective-config.ts';
import { resolveModelCredentialAttribution } from '../config/model-credential-refs.ts';
import { resolveAgentModel } from '../config/model-policy.ts';
import { ModelResolutionError, NoAssignmentError } from '../config/errors.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { resolveAssignment, type AssignmentSurface } from '../config/resolver.ts';
import { getOrCreateSnapshot } from '../config/snapshot-store.ts';
import { resolveStores, type AppStores, type PlatformEnv } from '../config/state-backend.ts';
import {
  tagStateStub,
  type SlackInteractionProgress,
  type TurnJob,
} from '../config/state-rpc.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import { resolveSlackBehaviorSettings } from '../slack/behavior-settings.ts';
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
  getClient,
  createSlackWebClient,
  runTurn,
  sanitizeError,
} from '../slack/run-turn.ts';
import { slackThreadKey } from '../slack/thread-key.ts';
import { normalizeSlackTurn } from '../slack/turn-normalization.ts';
import { wakeNodeTurnRelay } from '../slack/node-turn-relay.ts';
import { hydrateSlackContextViaWebClient } from '../slack/web-client-context.ts';
import { WebClientPresenter } from '../slack/web-client-presenter.ts';
import { publishSlackWorkAdmissionProgress } from '../slack/work-admission-progress.ts';
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

// Bot user id resolution: prefer the configured value (env, then the
// wizard-stored setting — resolveSlackCredentials preserves the env
// "explicitly empty = no bot user id, do not probe" knob, S14); otherwise
// resolve once via auth.test() and cache. On auth.test failure leave it
// undefined so message-family events fail closed in normalization.
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
let verifiedChannel: { signingSecret: string; channel: SlackChannel } | undefined;
function channelForSecret(signingSecret: string): SlackChannel {
  if (verifiedChannel?.signingSecret !== signingSecret) {
    verifiedChannel = {
      signingSecret,
      channel: createSlackChannel({ signingSecret, events: handleSlackEvents }),
    };
  }
  return verifiedChannel.channel;
}

// conversationKey/parseConversationKey are pure identity helpers, independent
// of the signing secret; serve them from whichever instance exists. The
// placeholder-keyed instance can never verify anything — its routes are not
// the ones exported below, and the events gate always resolves the real
// secret first.
function identityChannel(): SlackChannel {
  return verifiedChannel?.channel ?? channelForSecret('unconfigured-placeholder');
}

type SlackRouteHandler = SlackChannel['routes'][number]['handler'];

/**
 * Read a Slack `url_verification` challenge from an UNVERIFIED body, returning
 * the challenge string only for exactly that payload shape. Used solely on the
 * bootstrap path below (no signing secret yet); anything else returns
 * undefined so the caller fails closed.
 */
async function urlVerificationChallenge(c: {
  req?: { json(): Promise<unknown> };
}): Promise<string | undefined> {
  try {
    const body = await c.req?.json();
    if (
      body &&
      typeof body === 'object' &&
      (body as Record<string, unknown>).type === 'url_verification' &&
      typeof (body as Record<string, unknown>).challenge === 'string'
    ) {
      return (body as { challenge: string }).challenge;
    }
  } catch {
    // Not JSON / no readable body — treat as not-a-challenge, fail closed.
  }
  return undefined;
}

/**
 * Events gate: resolve the signing secret (env > wizard-stored) per request,
 * then delegate to the real channel's verification + dispatch. No secret yet
 * (first-run, wizard not completed) → fail closed (401) so Slack retries later
 * and the rest of the app (notably /admin) keeps serving — with ONE
 * exception: a `url_verification` challenge is echoed unverified so a
 * manifest-created Slack app can verify its request URL BEFORE the wizard has
 * stored any credential. This is bootstrap-only: once a signing secret exists,
 * challenges take the verified path below and must pass signature verification
 * like any other event.
 */
const verifiedEventsHandler: SlackRouteHandler = async (c, next) => {
  const { signingSecret } = await resolveSlackCredentials(c.env as PlatformEnv | undefined);
  if (!signingSecret) {
    const challenge = await urlVerificationChallenge(c);
    if (challenge !== undefined) {
      return c.json({ challenge });
    }
    return c.json({ error: 'slack_not_configured' }, 401);
  }
  const route = channelForSecret(signingSecret).routes.find((r) => r.path === '/events');
  if (!route) {
    // Unreachable: createSlackChannel with an events handler always mounts
    // /events. Guarded (not asserted away) so a library change fails loudly.
    throw new Error('slack channel lost its /events route');
  }
  return route.handler(c, next);
};

export const channel: SlackChannel = {
  // Path: /channels/slack/events
  routes: [{ method: 'POST', path: '/events', handler: verifiedEventsHandler }],
  conversationKey: (ref) => identityChannel().conversationKey(ref),
  parseConversationKey: (id) => identityChannel().parseConversationKey(id),
};

const handleSlackEvents: NonNullable<SlackChannelOptions['events']> = ({ c, payload }) => {
  // a. Admission: only Events API callbacks; ack Assistant lifecycle events.
  if (payload.type !== 'event_callback') return;
  const eventType = payload.event.type;
  if (
    eventType === 'assistant_thread_started' ||
    eventType === 'assistant_thread_context_changed'
  ) {
    return;
  }
  // Capture the platform env up front — and BEFORE anything detaches: the
  // stores, the credential resolver, and the dispatch on Cloudflare all need
  // the bindings object `c` carries, and `c` itself must not be touched after
  // the events ack returns (its request scope ends with the response). On
  // node the env is ignored everywhere it is threaded.
  const platformEnv = c.env as PlatformEnv | undefined;
  detach(
    c,
    processSlackEvent(payload as unknown as SlackEventFixture, platformEnv).catch((err) => {
      console.error('[chickpea] Slack event intake failed:', sanitizeError(err));
    }),
  );
};

async function processSlackEvent(
  payload: SlackEventFixture,
  platformEnv: PlatformEnv | undefined,
): Promise<void> {
  const eventType = payload.event.type;

  // Store resolution is per-request and target-aware: on Node the factories
  // return the process-cached SQLite stores (claims + thread registry are
  // SQLite-backed in their own file, sibling of the Flue transcript DB, so a
  // Slack redelivery right after a restart is still suppressed and joined
  // threads stay continuable); on Cloudflare they proxy the state Durable
  // Object, which is why the handler threads `c.env` through.
  const stores = resolveStores(platformEnv);
  // Runtime behavior follows the same env > stored > default contract the
  // admin exposes. Resolve against THIS request's settings store so Node and
  // Cloudflare (Durable Object-backed) observe the same saved switches.
  const behavior = await resolveSlackBehaviorSettings(platformEnv, stores.settings);

  if (eventType === 'member_joined_channel') {
    if (!behavior.welcomeOnJoin.value) {
      return;
    }
    await handleMemberJoinedChannel(payload, stores, platformEnv);
    return;
  }

  // b. Normalize with the shared admission policy (imported verbatim).
  const resolvedBotUserId = await resolveBotUserId(platformEnv);
  const normalization = normalizeSlackTurn(
    payload,
    resolvedBotUserId ? { botUserId: resolvedBotUserId } : {},
  );
  if (normalization.status !== 'runnable') return;
  const turn = normalization.turn;
  const candidateTurn =
    turn.source === 'ambient_channel_message' || turn.source === 'reaction_added';
  let threadKey = slackThreadKey(turn);
  const state = stores.slackState;

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

  // c2. Direct messages / App Home are a separate surface, on by default.
  //     When the resolved allow-DMs setting is off (env or admin-stored), the
  //     bot is reachable only in channels. Checked before any claim so a
  //     disabled DM stays fully silent.
  const surface = turnSurface(turn);
  if (surface === 'direct' && !behavior.allowDms.value) {
    return;
  }

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
  //    - DIRECT conversations (DMs, App Home) are one continuous session, not a
  //      discrete thread, so they are NOT frozen: they resolve current config
  //      every turn, so admin edits to the DM profile reach existing DM users.
  let assignment: ResolvedAssignment;
  try {
    const store = stores.config;
    const configStores = { agents: store, assignments: store };
    assignment =
      surface === 'channel' && !candidateTurn
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
        : surface === 'channel'
          ? await resolveEffectiveSlackConfig(turn.workspaceId, turn.channelId, configStores)
          : await resolveAssignment(turn.workspaceId, turn.channelId, configStores, { surface });
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
          platformEnv,
        );
      }
      return;
    }
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
  const { botToken } = await resolveSlackCredentials(platformEnv, stores.settings);
  if (
    turn.source === 'reaction_added' &&
    (!botToken || !(await resolveReactionTargetContext(turn, createSlackWebClient(botToken))))
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
    await stores.config.putAssignment({
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      agentId: current?.agentId ?? assignment.agentId,
      enabled: current?.enabled ?? true,
      ...(current?.channelLabel || assignment.channelLabel
        ? { channelLabel: current?.channelLabel ?? assignment.channelLabel }
        : {}),
      ...(current?.channelPromptAddendum || assignment.channelPromptAddendum
        ? {
            channelPromptAddendum:
              current?.channelPromptAddendum ?? assignment.channelPromptAddendum,
          }
        : {}),
      participationMode: participationControl.mode,
    });
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

  if (admissionTruth.eligible) {
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

  let admissionInteractionProgress: SlackInteractionProgress | undefined;
  if (turn.interactionIntent?.disposition === 'work' && botToken) {
    const presenter = new WebClientPresenter(createSlackWebClient(botToken), {
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      agentName: assignment.agent.name,
      agentId: assignment.agent.id,
      userId: turn.userId,
      workspaceId: turn.workspaceId,
    });
    admissionInteractionProgress = await publishSlackWorkAdmissionProgress({
      turn,
      checklist: turn.interactionIntent.checklist,
      presenter,
      record: async (patch) => {
        if (canonicalTurnJob && state.recordSlackInteractionProgress) {
          await state.recordSlackInteractionProgress(canonicalTurnJob.id, patch);
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
  //    now dispatches in-process (see slack/agent-dispatch.ts) with the
  //    platform env captured at the top of this handler, so there is no
  //    origin to spoof or configure.

  // g. Mark this thread as started so its later implicit replies are admitted
  //    (mentions and DMs both open a thread the app owns). Registered
  //    pre-turn (before runTurn) on purpose: it admits implicit replies that
  //    arrive while the root turn is still in flight, matching the old lane's
  //    session-created-before-provider-call semantics. A failed turn leaves
  //    the thread registered (only the claims are released, for retry).
  if (!claimsHeldByCanonicalAdmission) await state.start(threadKey);
  let marksActiveWork = turn.interactionIntent?.disposition === 'work';
  if (marksActiveWork) await state.setActiveWork(threadKey, msgKey, true);

  // h. Run the turn past the fast events ack.
  //    - NODE runs it inline as a floating promise: node has no waitUntil
  //      horizon, so a long turn just outlives the response.
  //    - CLOUDFLARE cannot do that. A turn driven inside the events
  //      invocation's `waitUntil` is cancelled ~30s after the response
  //      (tail-log-confirmed), killing any longer model turn. So the handler
  //      ENQUEUES the job into the state Durable Object — awaited, so the job +
  //      armed alarm are durable BEFORE the ack (milliseconds) — and the DO's
  //      alarm() runs the SAME runTurn with the platform's 15-minute wall-time
  //      budget. The claims are already held; on the CF path the alarm owns
  //      releasing them on terminal failure, exactly as the node .catch does.
  if (isCloudflareTarget()) {
    // id = msgKey: the message claim key already dedupes the app_mention +
    // message fan-out, so keying the job by it makes the enqueue idempotent.
    const job: TurnJob =
      canonicalTurnJob ?? { id: msgKey, evtKey, msgKey, turn, assignment, ...(canonicalRunId ? { runId: canonicalRunId } : {}) };
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
  if (canonicalRunId && canonicalTurnJob) {
    await wakeNodeTurnRelay(platformEnv).catch((err) => {
      console.error('[chickpea] node turn wake failed:', sanitizeError(err));
    });
    return;
  }
  await runTurn(turn, assignment, platformEnv, {
      turnId: msgKey,
      usageExecutionId: `exec:${msgKey}:1`,
      ...(admissionInteractionProgress
        ? { interactionProgress: admissionInteractionProgress }
        : {}),
      onInteractionIntent: async (intent) => {
        if (intent.disposition !== 'work') return;
        marksActiveWork = true;
        await state.setActiveWork(threadKey, msgKey, true);
      },
      onDelivered: async () => {
        if (marksActiveWork) await state.setActiveWork(threadKey, msgKey, false);
      },
    }).catch(async (err) => {
      // Release on a genuine delivery failure so a Slack retry can re-drive
      // the turn. A completed turn (including a delivered provider-failure
      // final) returns normally and keeps its claim, so it never re-runs.
      await state.release(evtKey);
      await state.release(msgKey);
      if (promotedDecisionKey) await state.release(promotedDecisionKey);
      if (marksActiveWork) await state.setActiveWork(threadKey, msgKey, false);
      console.error('[chickpea] turn failed:', sanitizeError(err));
    });
}

async function handleMemberJoinedChannel(
  payload: SlackEventFixture,
  stores: AppStores,
  platformEnv: PlatformEnv | undefined,
): Promise<void> {
  const event = payload.event;
  if (!isSlackMemberJoinedChannelEvent(event)) {
    return;
  }

  const resolvedBotUserId = await resolveBotUserId(platformEnv);
  if (!resolvedBotUserId || event.user !== resolvedBotUserId) {
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
    await resolveAssignment(
      workspaceId,
      event.channel,
      { agents: store, assignments: store },
      { surface: 'channel' },
    );
  } catch {
    return;
  }

  const state = stores.slackState;
  const evtKey = `evt:${payload.event_id}`;
  if (!(await state.claim(evtKey))) {
    return;
  }

  try {
    await (await getClient(platformEnv)).chat.postMessage({
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
    profileId: input.assignment.agentId,
    profileLabel: input.assignment.agent.name,
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
    await getClient(platformEnv),
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
// (not a channel-id prefix): a DM or App Home message ('dm_message'), and any
// im/app_home/mpim thread, is 'direct'; everything else is a channel. A group-DM
// app_mention carries no channel_type and falls through to 'channel' — the
// fail-closed default (see surfaceForChannelId for the id ambiguity).
function turnSurface(turn: NormalizedSlackTurn): AssignmentSurface {
  if (turn.source === 'dm_message') {
    return 'direct';
  }
  const channelType = turn.channelType;
  if (channelType === 'im' || channelType === 'app_home' || channelType === 'mpim') {
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
    const botUserId = await resolveBotUserId(platformEnv);
    if (!botUserId) {
      return;
    }
    const hintKey = `hint:${turn.workspaceId}:${turn.channelId}`;
    if (!(await state.claim(hintKey))) {
      return;
    }
    try {
      await (await getClient(platformEnv)).chat.postEphemeral({
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
