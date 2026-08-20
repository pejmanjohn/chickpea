import { WebClient } from '@slack/web-api';

import {
  compileRuntimePlanV2,
  deriveRuntimePlanInstanceId,
  type RuntimePlanV2,
} from '../agents/runtime-plan.ts';
import { effectiveSlackInstructions } from '../config/effective-config.ts';
import { resolveAgentModel } from '../config/model-policy.ts';
import { getGithubConnection } from '../config/github-app.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { resolveSandboxSettings } from '../config/sandbox-settings.ts';
import { getConfigStore, getSettingsStore, getUsageStore, getWorkStore } from '../config/state-backend.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type {
  SlackContinuityNoticeProgress,
  SlackInteractionProgress,
  SlackInteractionProgressPatch,
} from '../config/state-rpc.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import {
  resolveProviderAuthRoute,
  safeRuntimeModelRouteEvidence,
} from '../config/runtime-model.ts';
import { parseMemoryCommand } from '../memory/commands.ts';
import { handleMemoryCommand, prepareMemoryTurn } from '../memory/runtime.ts';
import {
  handleRoutineSlackRequest,
  parseRoutineCommand,
  routineResponseVisibility,
} from '../routines/commands.ts';
import { isRoutineSlackTurn } from '../routines/slack-context.ts';
import {
  agentFailureText,
  AgentPromptFailure,
  promptSlackThreadAgent,
  releaseCloudflareSandboxTurn,
  type AgentDispatchResult,
  type SlackFlueDispatchState,
} from './flue-dispatch.ts';
import {
  ContinuityNoticeDeliveryError,
  ensureContinuityNotice,
} from './continuity-notice.ts';
import { resolveSlackCredentials, resolveSlackPublicUrl } from './credentials.ts';
import { agentAvatarUrlForPresentation } from './agent-presence/avatar-assets.ts';
import type { SlackStatusUpdate } from './replies.ts';
import { registerSlackStatusTurn } from './status-registry.ts';
import type { SlackTurnContext } from './thread-context.ts';
import { slackThreadKey } from './thread-key.ts';
import type { NormalizedSlackTurn } from './types.ts';
import { effectiveSlackIdentityId } from './identity-admission.ts';
import {
  effectiveTurnSlackIdentityId,
  resolveSlackIdentityExecutionContext,
  SlackIdentityUnavailableError,
  type SlackIdentityExecutionContext,
} from './identity-execution.ts';
import type { FrozenRuntimePlanDecision } from './turn-job-types.ts';
import type { FlueDispatchReceiptV1 } from './turn-job-types.ts';
import type { SlackProgressiveReadRelay } from './progressive-relay.ts';
import {
  decideProgressiveEligibility,
  type ProgressiveEligibilityDecision,
} from './progressive-eligibility.ts';
import {
  resolveSandboxSelection,
  sandboxBindingInstalled,
  type SandboxSelectionDecision,
} from '../sandbox/select.ts';
import {
  assembleSlackPrompt,
  hydrateSlackContextViaWebClient,
  renderSlackSelfMention,
} from './web-client-context.ts';
import {
  AGENT_FAILURE_TEXT,
  SANDBOX_UNAVAILABLE_FALLBACK_NOTICE,
  WebClientPresenter,
  type SlackReactionReceipt,
} from './web-client-presenter.ts';
import {
  InteractiveUsageRecorder,
  InteractionUsageRecorder,
  usageRuntimeRecordingEnabled,
  type UsagePersistenceEvent,
} from '../usage/runtime-recorder.ts';
import type { UsageStore } from '../usage/types.ts';
import { opaqueId } from '../work/admission.ts';
import { createWorkExecutionLifecycle } from '../work/executor.ts';
import type { ShadowWorkLifecycle } from '../work/lifecycle.ts';
import type { RunExecutionAuthority, WorkStore } from '../work/types.ts';
import {
  classifySlackInteraction,
  type SlackInteractionIntent,
} from './interaction-intent.ts';
import {
  startWorkChecklistHeartbeat,
  type WorkChecklistHeartbeat,
} from './work-checklist-heartbeat.ts';
import {
  SlackAgentViewPresentation,
  type SlackPresentationStatePort,
} from './agent-view-presentation.ts';
import { createSlackWebClient } from './web-client.ts';
import {
  externalActionAuthorityInstructions,
  resolveEffectiveConnectionAccounts,
  resolvePersonalConnectionAuthorizationOptions,
  selectConnectionsForRequest,
} from '../connections/runtime.ts';

export { createSlackWebClient } from './web-client.ts';

/**
 * The turn lifecycle, factored out of the Slack channel so BOTH the node detach
 * path and the Cloudflare turn-relay DO alarm run the exact same code.
 *
 * On node the channel calls `runTurn` inline (floating promise past the ack —
 * node has no waitUntil horizon). On Cloudflare the events handler enqueues the
 * turn into the state Durable Object and the DO's `alarm()` calls `runTurn`
 * there, with the platform's 15-minute wall-time budget instead of the events
 * invocation's ~30s waitUntil cancellation — the whole reason the relay exists.
 * The alarm injects a Slack client it resolved from ITS local settings store
 * (avoiding a Durable Object calling itself over RPC), which is the one reason
 * `runTurn` accepts a client override; everything else is behavior-identical.
 */

/**
 * Lazily-constructed outbound Slack client, keyed by the bot token from the
 * one active encrypted credential revision. Resolving at first use keeps the
 * Cloudflare build from binding a token at import time and — because the cache
 * is token-keyed — makes a promoted revision take effect on the next event
 * instead of pinning the first-seen token for the isolate's lifetime.
 */
let cachedClient: { botToken: string | undefined; client: WebClient } | undefined;
export async function getClient(env: PlatformEnv | undefined): Promise<WebClient> {
  const { botToken } = await resolveSlackCredentials(env);
  if (!cachedClient || cachedClient.botToken !== botToken) {
    cachedClient = { botToken, client: createSlackWebClient(botToken) };
  }
  return cachedClient.client;
}

export interface RunTurnOptions {
  /**
   * Slack client to use instead of the module-cached one. The relay alarm
   * passes a client it resolved from the state DO's local settings store, so
   * the DO never has to RPC into itself to resolve the bot token.
   */
  client?: WebClient;
  /** Current non-secret identity execution context resolved by the relay. */
  identityContext?: SlackIdentityExecutionContext;
  /** Focused-test override for proving replay and delivery lifecycle behavior. */
  agentPrompt?: typeof promptSlackThreadAgent;
  /** Adapter-owned dispatch/read checkpoints restored by the relay. */
  flueDispatch?: SlackFlueDispatchState;
  /** Restored exactly-once DM continuity-notice checkpoint. */
  continuityNoticeProgress?: SlackContinuityNoticeProgress;
  onContinuityNoticeProgress?: (
    notice: SlackContinuityNoticeProgress,
  ) => void | Promise<void>;
  /** Durable turn key forwarded to the sandbox for cap/idempotency state. */
  turnId?: string;
  /** Recorded result from an earlier attempt; skips the agent entirely. */
  replayText?: string;
  /** Persist sandbox side effects before the final Slack delivery can fail. */
  beforeDelivery?: () => Promise<string | undefined>;
  /** Persist terminal delivery before post-delivery workspace teardown begins. */
  onDelivered?: () => void | Promise<void>;
  /** Stable ID for one actual model invocation; persistence retries reuse it. */
  usageExecutionId?: string;
  /** Observational canonical Run correlation; legacy remains authoritative. */
  runId?: string;
  /** Durable relay attempt used as the canonical RunExecution fence. */
  runAttempt?: number;
  /** Explicit lease fence for a ledger-authoritative attempt. */
  runFencingToken?: number;
  /** Immutable authority selected at admission. Missing means legacy. */
  executionAuthority?: RunExecutionAuthority;
  /** Opaque Flue continuity identity, independent of Slack/memory coordinates. */
  continuityKey?: string;
  /** First-write-wins decision restored from a prior durable attempt. */
  runtimePlanDecision?: FrozenRuntimePlanDecision;
  /** Persist the first complete plan before the agent dispatch boundary. */
  onRuntimePlan?: (
    candidate: RuntimePlanV2,
  ) => FrozenRuntimePlanDecision | Promise<FrozenRuntimePlanDecision>;
  /** Local override avoids a Durable Object calling its own Work RPC. */
  workStore?: WorkStore;
  /** Local override avoids a Durable Object calling its own settings RPC. */
  settingsStore?: SettingsStore;
  /** Local override avoids a Durable Object calling its own Usage RPC. */
  usageStore?: UsageStore;
  /** Test/rollout override; otherwise USAGE_RUNTIME_RECORDING controls capture. */
  usageRecordingEnabled?: boolean;
  /** Test override, bounded to the product's 250 ms maximum. */
  usageWriteBudgetMs?: number;
  /** Durable turn-job denominator hook for persistence coverage. */
  onUsagePersistence?: (event: UsagePersistenceEvent) => void;
  /** Persist the first validated explicit-turn decision before Slack effects. */
  onInteractionIntent?: (intent: SlackInteractionIntent) => void | Promise<void>;
  /** Adapter artifacts restored from a prior relay attempt. */
  interactionProgress?: SlackInteractionProgress;
  /** Persist adapter coordinates before any later model or delivery work. */
  onInteractionProgress?: (
    patch: SlackInteractionProgressPatch,
  ) => void | Promise<void>;
  /** U4/U5 adapter seam; absent means terminal-only delivery. */
  prepareProgressiveRelay?: (input: {
    runId: string;
    runFencingToken: number;
    instanceId: string;
    receipt: FlueDispatchReceiptV1;
    eligibility: ProgressiveEligibilityDecision;
  }) => Promise<SlackProgressiveReadRelay | undefined>;
  /** True only when the adapter serializes roots in this Flue conversation. */
  progressiveAttributionProven?: boolean;
  /** Canonical presentation writer; absent keeps the legacy terminal path. */
  presentationState?: SlackPresentationStatePort;
  /** Focused-test override for the otherwise one-minute checklist heartbeat. */
  progressHeartbeatMs?: number;
  /** Focused-test override for the bounded in-flight heartbeat drain. */
  progressHeartbeatDrainMs?: number;
}

const DEFAULT_PROGRESS_HEARTBEAT_MS = 60_000;

/**
 * Full Slack turn lifecycle:
 *   1. set Assistant status (or post a durable progress placeholder on reject),
 *   2. hydrate the bounded Slack context per contextMode,
 *   3. prompt the durable agent through Flue 2 dispatch/read with the
 *      trigger text + hydrated (bot-filtered) context rows,
 *   4. stream the final (fallback to a markdown post), and clear status.
 * An agent/provider/workspace failure is delivered as category-specific static
 * copy (no internal error text ever reaches Slack) and the turn still
 * completes. `runTurn` throws only on a genuine delivery failure or when
 * reconciliation explicitly requires recovery. Callers release claims for a
 * retryable delivery failure and retain them for recovery-required Runs.
 */
export async function runTurn(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  platformEnv: PlatformEnv | undefined,
  options: RunTurnOptions = {},
): Promise<void> {
  const turnIdentityId = effectiveTurnSlackIdentityId(turn);
  if (effectiveSlackIdentityId(assignment) !== turnIdentityId) {
    throw new SlackIdentityUnavailableError(turnIdentityId, 'assignment_identity_mismatch');
  }
  const identityContext = options.identityContext ?? (
    options.client
      ? undefined
      : await resolveSlackIdentityExecutionContext(turnIdentityId, platformEnv, {
          ...(options.settingsStore ? { settings: options.settingsStore } : {}),
        })
  );
  if (identityContext && identityContext.identityId !== turnIdentityId) {
    throw new SlackIdentityUnavailableError(turnIdentityId, 'execution_identity_mismatch');
  }
  const client = identityContext?.client ?? options.client ?? (await getClient(platformEnv));
  // A frozen assignment (from a thread snapshot) carries its model; otherwise
  // resolve it from the agent via policy.
  const resolvedModel = assignment.model ?? tryResolveAgentModel(assignment.agent);
  const ledgerAuthority = options.executionAuthority === 'ledger';
  // env (SLACK_TAG_PUBLIC_URL) → stored slack.publicUrl (the origin the admin
  // pinned): on a button deploy nobody sets the env var, so without the stored
  // fallback the footer's "Configure" link would be dead.
  const publicUrl = await resolveSlackPublicUrl(platformEnv);
  const agentAvatarUrl = agentAvatarUrlForPresentation(assignment.agent, publicUrl);
  // Natural-language Routine intent runs through a fresh, tool-less v2 agent.
  // A selected ledger canary deliberately skips that pre-parser;
  // explicit Routine commands are kept off this lane at admission.
  if (!ledgerAuthority && isRoutineSlackTurn(turn)) {
    const routineText = await handleRoutineSlackRequest(turn, platformEnv, {
      ...(identityContext ? { identityContext } : {}),
      assignment,
    });
    if (routineText !== undefined) {
      const routinePresenter = new WebClientPresenter(client, {
        channelId: turn.channelId,
        threadTs: turn.threadTs,
        agentName: assignment.agent.name,
        ...(agentAvatarUrl
          ? { agentAvatarUrl }
          : {}),
        agentId: assignment.agent.id,
        modelLabel: resolvedModel,
        publicUrl,
        userId: turn.userId,
        workspaceId: turn.workspaceId,
      });
      if (routineResponseVisibility(turn.text, turn.channelId) === 'requester') {
        await routinePresenter.deliverRequesterOnly(routineText, 'markdown');
      } else {
        await routinePresenter.deliverFinal(routineText, 'markdown');
      }
      await options.onDelivered?.();
      return;
    }
  }
  const memoryCommand = parseMemoryCommand(turn.text);
  const deterministicCommand = Boolean(memoryCommand) ||
    (isRoutineSlackTurn(turn) && Boolean(parseRoutineCommand(turn.text)));
  let interactionIntent = turn.interactionIntent;
  if (!deterministicCommand && !interactionIntent) {
    const classification = await classifySlackInteraction({
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
      requestedModel: resolvedModel ?? null,
    }, platformEnv);
    interactionIntent = classification.intent;
    turn.interactionIntent = interactionIntent;
    await options.onInteractionIntent?.(interactionIntent);
    await recordExplicitInteractionClassifierUsage({
      turn,
      assignment,
      classification,
      requestedModel: resolvedModel ?? null,
      platformEnv,
      options,
    });
  }
  // Delivery-only recovery replays the exact persisted answer. It must not
  // re-resolve current Agent/Channel memory (which could both block recovery
  // on a changed lease and unnecessarily touch live state).
  const preparedMemory = memoryCommand || options.replayText !== undefined
    ? undefined
    : await prepareMemoryTurn({
        turn,
        assignment,
        platformEnv,
        client,
        ...(identityContext
          ? { botToken: identityContext.botToken, botUserId: identityContext.botUserId }
          : {}),
      });
  const conversationKey = preparedMemory?.conversationKey ?? slackThreadKey(turn);
  let sandboxUnavailableFallback = false;
  let runtimePlanDecision = options.runtimePlanDecision;
  if (!runtimePlanDecision && preparedMemory && resolvedModel) {
    const frozen = await freezeRuntimePlanForTurn({
          turn,
          assignment,
          platformEnv,
          memoryEpoch: preparedMemory.memoryEpoch,
          ...(options.settingsStore ? { settingsStore: options.settingsStore } : {}),
          ...(options.onRuntimePlan ? { persist: options.onRuntimePlan } : {}),
        });
    runtimePlanDecision = frozen.decision;
    sandboxUnavailableFallback = frozen.unavailableFallback;
  }
  // A frozen plan is durable, but binding availability is not. Preserve its
  // envelope/receipt for idempotent reattachment while narrowing any work that
  // has not settled yet; settled replies must replay their saved result.
  const sandboxDispatchUnsettled = !options.flueDispatch?.flueSettlement;
  if (
    runtimePlanDecision?.runtimePlan.sandbox.mode === 'cloudflare' &&
    !sandboxBindingInstalled(platformEnv) &&
    sandboxDispatchUnsettled
  ) {
    sandboxUnavailableFallback = true;
  }
  const agentConversationKey = options.continuityKey ?? conversationKey;
  const workLifecycle = options.runId && options.replayText === undefined && resolvedModel
    ? await createSlackShadowLifecycle({
        runId: options.runId,
        attemptNumber: options.runAttempt ?? 1,
        ...(options.runFencingToken === undefined
          ? {}
          : { fencingToken: options.runFencingToken }),
        assignment,
        canonicalModel: resolvedModel,
        flueInstanceRef: opaqueId(
          'flueinstance',
          runtimePlanDecision?.instanceId ?? agentConversationKey,
        ),
        platformEnv,
        ...(options.workStore ? { workStore: options.workStore } : {}),
        ...(options.settingsStore ? { settingsStore: options.settingsStore } : {}),
        mode: ledgerAuthority ? 'enforce' : 'observe',
      })
    : undefined;
  let onNativeStarted = async (): Promise<void> => {};
  const agentViewPresentation = options.presentationState && options.runId
    ? new SlackAgentViewPresentation({
        client,
        state: options.presentationState,
        runId: options.runId,
        runFencingToken: options.runFencingToken ?? 0,
        footer: {
          agentName: assignment.agent.name,
          modelLabel: resolvedModel,
          agentId: assignment.agent.id,
          publicUrl,
          memoryItems: preparedMemory?.footerItems,
        },
        onNativeStarted: () => onNativeStarted(),
      })
    : undefined;
  const presenter = new WebClientPresenter(client, {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    agentName: assignment.agent.name,
    ...(agentAvatarUrl
      ? { agentAvatarUrl }
      : {}),
    agentId: assignment.agent.id,
    modelLabel: resolvedModel,
    publicUrl,
    userId: turn.userId,
    workspaceId: turn.workspaceId,
    ...(preparedMemory ? { memoryFooterItems: preparedMemory.footerItems } : {}),
  }, workLifecycle, {
    deliverySafety: ledgerAuthority ? 'ledger' : 'legacy',
    ...(agentViewPresentation ? { agentViewPresentation } : {}),
  });
  let continuityNoticeProgress = options.continuityNoticeProgress;
  const ensureRequiredContinuityNotice = (): Promise<void> => ensureContinuityNotice({
    required: runtimePlanDecision?.continuityNoticeRequired ?? false,
    ...(continuityNoticeProgress ? { progress: continuityNoticeProgress } : {}),
    post: (text) => presenter.postContinuityNotice(text),
    record: async (notice) => {
      continuityNoticeProgress = notice;
      await options.onContinuityNoticeProgress?.(notice);
    },
  });
  const statusGeneration = options.turnId ?? `msg:${turn.channelId}:${turn.messageTs}`;
  const statusInstanceId = runtimePlanDecision?.instanceId ?? agentConversationKey;
  const statusTurn = registerSlackStatusTurn(statusInstanceId, presenter, {
    generation: statusGeneration,
  });
  const finishStatus = (): void => {
    // Close the sink first. Agent observations are relayed best-effort from a
    // different Cloudflare isolate and may still arrive after settlement
    // resolves; removing this generation makes its late relays no-ops even if
    // another turn has already registered under the same conversation key.
    // Clearing is deliberately non-blocking: if the active Slack request lands
    // after the first clear, the registry issues a second clear once it settles.
    statusTurn.finish(() => presenter.clearStatus());
  };
  let usedCloudflareSandbox = false;
  let usageRecorder: InteractiveUsageRecorder | undefined;
  let interactionProgress: SlackInteractionProgress = {
    ...options.interactionProgress,
  };
  let workAcknowledgment: SlackReactionReceipt | undefined =
    interactionProgress.acknowledgment
      ? {
          name: interactionProgress.acknowledgment.name,
          created: interactionProgress.acknowledgment.created,
        }
      : undefined;
  let workChecklistTs = interactionProgress.checklist?.messageTs;
  let workChecklistHeartbeat: WorkChecklistHeartbeat | undefined;
  const workChecklist = interactionIntent?.disposition === 'work'
    ? interactionIntent.checklist
    : undefined;
  const triggerCoordinate = {
    channelId: turn.channelId,
    messageTs: turn.reactionTargetTs ?? turn.messageTs,
  };
  const recordInteractionProgress = async (
    patch: SlackInteractionProgressPatch,
  ): Promise<void> => {
    interactionProgress = {
      ...interactionProgress,
      ...(patch.acknowledgment
        ? {
            acknowledgment: {
              ...interactionProgress.acknowledgment,
              ...patch.acknowledgment,
            },
          }
        : {}),
      ...(patch.checklist
        ? {
            checklist: {
              ...interactionProgress.checklist,
              ...patch.checklist,
            },
          }
        : {}),
    };
    await options.onInteractionProgress?.(patch);
  };
  const removeWorkAcknowledgment = async (): Promise<void> => {
    const persisted = interactionProgress.acknowledgment;
    if (!workAcknowledgment?.created || persisted?.cleanup === 'done') return;
    const acknowledgment = workAcknowledgment;
    try {
      const coordinate = persisted
        ? { channelId: persisted.channelId, messageTs: persisted.messageTs }
        : triggerCoordinate;
      await presenter.removeReaction(acknowledgment.name, coordinate);
      workAcknowledgment = undefined;
      await recordInteractionProgress({
        acknowledgment: {
          channelId: coordinate.channelId,
          messageTs: coordinate.messageTs,
          name: acknowledgment.name,
          created: true,
          cleanup: 'done',
        },
      });
    } catch {
      console.warn('[chickpea] Slack work acknowledgment cleanup failed');
    }
  };
  const finishDelivery = async (): Promise<void> => {
    // Delivery gets its durable tombstone before the best-effort repair so a
    // slow reporting backend can never make Slack retry already-delivered work.
    await options.onDelivered?.();
    await presenter.markCanonicalPresentationFinalized();
    await usageRecorder?.repairAfterDelivery();
    if (workChecklistHeartbeat) {
      const drained = await workChecklistHeartbeat.stop();
      workChecklistHeartbeat = undefined;
      if (!drained) {
        // The delivered tombstone is already durable. Leave adapter cleanup
        // pending so the repair lane can finalize without racing a late write.
        return;
      }
    }
    if (workChecklistTs && workChecklist &&
        !interactionProgress.checklist?.supersededByNative) {
      try {
        await presenter.updateWorkChecklist(workChecklistTs, workChecklist, true);
        const checklistProgress = interactionProgress.checklist;
        if (checklistProgress) {
          await recordInteractionProgress({
            checklist: { ...checklistProgress, cleanup: 'done' },
          });
        }
      } catch {
        console.warn('[chickpea] Slack work checklist finalization failed');
      }
    }
    await removeWorkAcknowledgment();
  };
  onNativeStarted = async (): Promise<void> => {
    if (!workChecklistTs || !interactionProgress.checklist ||
        interactionProgress.checklist.cleanup === 'done') return;
    if (workChecklistHeartbeat) {
      await workChecklistHeartbeat.stop();
      workChecklistHeartbeat = undefined;
    }
    const checklist = {
      ...interactionProgress.checklist,
      supersededByNative: true,
    };
    await recordInteractionProgress({ checklist });
    try {
      await presenter.deleteWorkChecklist(workChecklistTs);
      await recordInteractionProgress({ checklist: { ...checklist, cleanup: 'done' } });
      workChecklistTs = undefined;
    } catch {
      console.warn('[chickpea] legacy checklist cleanup will retry after native start');
    }
  };

  // 1. Visible work: set status; if it is rejected, post a durable progress
  //    placeholder so the user still sees work in-flight before the final.
  try {
    // Owner-native memory is authorized live, independently of the frozen
    // config snapshot. Fence every visible Slack effect as well as model/tool
    // execution when the selected owner lease has already gone stale.
    if (preparedMemory?.ownerBound && !(await preparedMemory.validateLease())) return;
    await agentViewPresentation?.setTitle(turn.text).catch(() => {
      console.warn('[chickpea] Slack Agent View title could not be recorded');
    });
    if (memoryCommand) {
      const handled = await handleMemoryCommand({
        turn,
        assignment,
        platformEnv,
        client,
        presenter,
        ...(identityContext
          ? { botToken: identityContext.botToken, botUserId: identityContext.botUserId }
          : {}),
      });
      if (handled) {
        await finishDelivery();
        return;
      }
    }
    if (interactionIntent?.disposition === 'react_only') {
      const prepared = await workLifecycle?.prepareExecution(
        `Slack reaction response: ${interactionIntent.reaction}`,
      );
      if (workLifecycle?.hasExecution) {
        await workLifecycle.settleExecution({
          outcome: 'succeeded',
          rawStatus: 'adapter_reaction_only',
          modelInvoked: false,
        });
      }
      // Reading the persisted input is the ledger fence; its content is not
      // user-visible and the semantic reaction remains the approved output.
      void prepared;
      await presenter.deliverReaction(
        interactionIntent.reaction,
        resolveReactionCoordinate(turn, interactionIntent.target),
      );
      await finishDelivery();
      return;
    }
    const recordingEnabled = options.usageRecordingEnabled ??
      usageRuntimeRecordingEnabled(platformEnv);
    if (recordingEnabled && options.replayText === undefined) {
      usageRecorder = new InteractiveUsageRecorder({
        turn,
        assignment,
        requestedModel: resolvedModel ?? null,
        operationId: statusGeneration,
        executionId: options.usageExecutionId ?? `exec:${statusGeneration}:1`,
        store: options.usageStore ?? getUsageStore(platformEnv),
        ...(options.runId ? { runId: options.runId } : {}),
        ...(platformEnv ? { platformEnv } : {}),
        ...(options.usageWriteBudgetMs === undefined
          ? {}
          : { writeBudgetMs: options.usageWriteBudgetMs }),
        ...(options.onUsagePersistence
          ? { onPersistence: options.onUsagePersistence }
          : {}),
      });
      await usageRecorder.admit();
    }
    // A substantive @-mention is classified late (above), AFTER Work admission
    // froze the presentation without a plan — whereas ambient and obvious-work
    // turns carry their plan from admission. Attach the late-classified work
    // plan now so the presenter opens a native task card and supersedes the
    // interim checklist below through onNativeStarted, exactly as the ambient
    // path does. adoptLatePlan no-ops when native tasks are off, a plan is
    // already frozen (ambient/obvious-work), or any Slack effect has begun;
    // delivery-only replay skips it so recovery never opens a fresh card.
    if (workChecklist && options.replayText === undefined) {
      await agentViewPresentation?.adoptLatePlan(workChecklist).catch(() => {
        console.warn('[chickpea] Slack late native plan attachment failed');
      });
    }
    if (workChecklist) {
      if (!interactionProgress.acknowledgment) {
        try {
          workAcknowledgment = await presenter.addSemanticReaction('work_ack', triggerCoordinate);
        } catch {
          console.warn('[chickpea] Slack work acknowledgment failed');
        }
        if (workAcknowledgment) {
          await recordInteractionProgress({
            acknowledgment: {
              channelId: triggerCoordinate.channelId,
              messageTs: triggerCoordinate.messageTs,
              name: workAcknowledgment.name,
              created: workAcknowledgment.created,
              cleanup: workAcknowledgment.created ? 'pending' : 'done',
            },
          });
        }
      }
      if (!workChecklistTs) {
        try {
          workChecklistTs = await presenter.postWorkChecklist(workChecklist);
        } catch {
          console.warn('[chickpea] Slack work checklist post failed');
        }
        if (workChecklistTs) {
          await recordInteractionProgress({
            checklist: {
              channelId: turn.channelId,
              threadTs: turn.threadTs,
              messageTs: workChecklistTs,
              cleanup: 'pending',
            },
          });
        }
      }
      if (workChecklistTs && interactionProgress.checklist?.cleanup !== 'done') {
        const heartbeatMs = Math.max(
          1_000,
          Math.floor(options.progressHeartbeatMs ?? DEFAULT_PROGRESS_HEARTBEAT_MS),
        );
        workChecklistHeartbeat = startWorkChecklistHeartbeat({
          intervalMs: heartbeatMs,
          ...(options.progressHeartbeatDrainMs === undefined
            ? {}
            : { drainTimeoutMs: options.progressHeartbeatDrainMs }),
          update: () => presenter.updateWorkChecklist(workChecklistTs!, workChecklist, false),
          onError: () => {
            console.warn('[chickpea] Slack work checklist heartbeat failed');
          },
          onDrainTimeout: () => {
            console.warn('[chickpea] Slack work checklist heartbeat drain timed out');
          },
        });
      }
    }
    const statusSet = await statusTurn.setStatus(thinkingStatus());
    if (!statusSet && !workChecklistTs) {
      await presenter.postProgress(`${assignment.agent.name} is reading the thread.`);
    }

    // 2. Hydrate bounded context (degrades to current-message-only on failure).
    const hydratedContext = await hydrateSlackContextViaWebClient(client, turn);
    const context = applyVisibilityBarrier(
      hydratedContext,
      preparedMemory?.visibilityBarrierAt ?? null,
    );
    void statusTurn.setStatus(hydratedContextStatus(context));
    const prompt = assembleSlackPrompt(turn, context, {
      ...(preparedMemory?.promptBlock ? { memoryBlock: preparedMemory.promptBlock } : {}),
      memorySelected: (preparedMemory?.selection?.entries.length ?? 0) > 0,
      ...(identityContext
        ? {
            slackIdentity: {
              botUserId: identityContext.botUserId,
              ...(identityContext.displayName
                ? { displayName: identityContext.displayName }
                : {}),
            },
          }
        : {}),
    });
    const persistedPrompt = await workLifecycle?.prepareExecution(prompt);
    if (workLifecycle?.hasExecution) {
      usageRecorder?.linkRunExecution(workLifecycle.executionId);
    }
    const executionPrompt = persistedPrompt ?? prompt;

    // 3 + 4. Prompt the durable agent, then deliver the final — with clearStatus
    //    in a finally so a status that was actually set is cleared even if
    //    delivery throws (old-lane parity: the clear happened in a finally; keeps
    //    S03/S15/S16 green). clearStatus is a no-op when no status was set. A
    //    failures surface as bounded dispatch/read outcomes; we deliver only
    //    category-specific static copy (no envelope text reaches Slack).
    // The model status is cosmetic: resolving it must never abort the turn.
    // If the model is unresolvable (misconfig), skip the status and let the
    // durable agent's own resolution fail, so the prompt's catch below still
    // delivers a sanitized failure final (not silence + a Slack
    // retry loop from the claims being released on an uncaught throw).
    let text: string;
    let agentResult: AgentDispatchResult | undefined;
    if (options.replayText !== undefined) {
      text = options.replayText;
    } else {
      if (resolvedModel) {
        void statusTurn.setStatus(modelStatus(resolvedModel));
      }
      try {
        usedCloudflareSandbox = runtimePlanDecision
          ? runtimePlanDecision.runtimePlan.sandbox.mode === 'cloudflare' &&
            !sandboxUnavailableFallback
          : await shouldUseCloudflareSandbox(assignment, platformEnv);
        if (!options.agentPrompt && !options.flueDispatch) {
          throw new Error('Durable Flue dispatch state is unavailable.');
        }
        let prepareProgressiveRelay:
          | NonNullable<Parameters<typeof promptSlackThreadAgent>[0]['prepareProgressiveRelay']>
          | undefined;
        const progressiveRelayFactory = options.prepareProgressiveRelay ??
          (agentViewPresentation
            ? (input: Parameters<NonNullable<RunTurnOptions['prepareProgressiveRelay']>>[0]) =>
                agentViewPresentation.prepareReceipt(input)
            : undefined);
        if (
          progressiveRelayFactory &&
          options.runId &&
          runtimePlanDecision
        ) {
          let continuityReady = !runtimePlanDecision.continuityNoticeRequired ||
            continuityNoticeProgress?.status === 'delivered';
          let eligibility = decideProgressiveEligibility({
            runtimePlan: runtimePlanDecision.runtimePlan,
            memorySelected: (preparedMemory?.selection?.entries.length ?? 0) > 0,
            continuityReady,
            recoveryRequired: false,
            concurrentAttributionProven: options.progressiveAttributionProven === true,
            replacementCapable: options.beforeDelivery !== undefined,
          });
          if (eligibility.reason === 'continuity') {
            await ensureRequiredContinuityNotice();
            continuityReady = continuityNoticeProgress?.status === 'delivered';
            eligibility = decideProgressiveEligibility({
              runtimePlan: runtimePlanDecision.runtimePlan,
              memorySelected: (preparedMemory?.selection?.entries.length ?? 0) > 0,
              continuityReady,
              recoveryRequired: false,
              concurrentAttributionProven: options.progressiveAttributionProven === true,
              replacementCapable: options.beforeDelivery !== undefined,
            });
          }
          const frozenEligibility = eligibility;
          prepareProgressiveRelay = ({ instanceId, receipt }) =>
            progressiveRelayFactory({
              runId: options.runId!,
              runFencingToken: options.runFencingToken ?? 0,
              instanceId,
              receipt,
              eligibility: frozenEligibility,
            });
        }
        agentResult = await (options.agentPrompt ?? promptSlackThreadAgent)({
          message: executionPrompt,
          state: options.flueDispatch!,
          turnId: statusGeneration,
          conversationKey: agentConversationKey,
          useCloudflareSandbox: usedCloudflareSandbox,
          requestedModel: resolvedModel ?? null,
          ...(runtimePlanDecision
            ? { runtimePlan: runtimePlanDecision.runtimePlan }
            : {}),
          ...(platformEnv ? { env: platformEnv } : {}),
          ...(workLifecycle && options.runId
            ? {
                workCorrelation: {
                  runId: options.runId,
                  runExecutionId: workLifecycle.executionId,
                  mode: ledgerAuthority ? 'enforce' : 'observe',
                },
              }
            : {}),
          beforeResult: ensureRequiredContinuityNotice,
          ...(prepareProgressiveRelay ? { prepareProgressiveRelay } : {}),
        });
        text = sandboxUnavailableFallback
          ? `${SANDBOX_UNAVAILABLE_FALLBACK_NOTICE}\n\n${agentResult.text}`
          : agentResult.text;
        await workLifecycle?.settleExecution({
          outcome: 'succeeded',
          rawStatus: 'flue_succeeded',
          ...(agentResult.flueSubmissionRef
            ? { flueSubmissionRef: agentResult.flueSubmissionRef }
            : {}),
        });
        await usageRecorder?.recordSuccess(agentResult);
      } catch (err) {
        // A Flue identity or idempotency conflict is not an ordinary model
        // failure. Its TurnJob already entered recovery_required and must not
        // emit a Slack final or reach an onDelivered tombstone.
        if (err instanceof AgentPromptFailure && (err.recoveryRequired || err.retryable)) {
          throw err;
        }
        if (err instanceof ContinuityNoticeDeliveryError) {
          const settlement = options.flueDispatch?.flueSettlement;
          if (settlement?.outcome === 'completed') {
            await workLifecycle?.settleExecution({
              outcome: 'succeeded',
              rawStatus: 'flue_succeeded',
              ...(settlement.result.flueSubmissionRef
                ? { flueSubmissionRef: settlement.result.flueSubmissionRef }
                : {}),
            });
            await usageRecorder?.recordSuccess(settlement.result);
          } else if (settlement) {
            await workLifecycle?.settleExecution({
              outcome: 'failed',
              rawStatus: `flue_${settlement.outcome}`,
              safeFailureCode: settlement.failureKind,
            });
            await usageRecorder?.recordFailure();
          }
          throw err;
        }
        console.error('[chickpea] agent run failed:', sanitizeError(err));
        const modelNotInvoked = agentFailureBeforeModelInvocation(err);
        await workLifecycle?.settleExecution({
          outcome: modelNotInvoked ? 'not_submitted' : 'failed',
          rawStatus: modelNotInvoked ? 'model_not_invoked' : 'flue_failed',
          safeFailureCode: agentFailureSafeCode(err),
        });
        await usageRecorder?.recordFailure();
        const recoveredText = await options.beforeDelivery?.();
        finishStatus();
        if (recoveredText) {
          await preparedMemory?.confirmInjection();
          await presenter.deliverFinal(
            identityContext
              ? renderSlackSelfMention(recoveredText, identityContext.botUserId)
              : recoveredText,
            'markdown',
          );
          await finishDelivery();
          return;
        }
        await presenter.deliverFinal(agentFailureText(err), 'plain_text', 'error');
        await finishDelivery();
        return;
      }
    }
    const recoveredText = await options.beforeDelivery?.();
    // Confirmation only prevents reinjecting the same selection into this
    // transcript. A concurrent turn can legitimately advance the epoch before
    // this one finishes; that bookkeeping race must not discard a completed,
    // lease-valid answer.
    await preparedMemory?.confirmInjection();
    const leaseValid = await preparedMemory?.validateLease() ?? true;
    if (preparedMemory?.ownerBound && !leaseValid && !recoveredText) return;
    text = resolveMemoryDeliveryText(
      text,
      recoveredText,
      leaseValid,
    );
    if (identityContext) {
      text = renderSlackSelfMention(text, identityContext.botUserId);
    }
    finishStatus();
    await presenter.deliverFinal(text, 'markdown');
    await finishDelivery();
  } catch (err) {
    if (!(err instanceof ContinuityNoticeDeliveryError) &&
        !(err instanceof AgentPromptFailure && err.retryable)) {
      await usageRecorder?.recordFailure();
    }
    throw err;
  } finally {
    // Also covers failures before the ordinary delivery boundary (hydration,
    // provider setup, or persistence). Idempotent after the success path.
    try {
      if (workChecklistHeartbeat) {
        workChecklistHeartbeat.cancel();
        workChecklistHeartbeat = undefined;
      }
      finishStatus();
      await removeWorkAcknowledgment();
    } finally {
      // The Sandbox DO lives in a different isolate from the agent factory;
      // release it by its durable thread id at the actual end-of-turn seam.
      await releaseCloudflareSandboxTurn(
        platformEnv,
        conversationKey,
        usedCloudflareSandbox,
      );
    }
  }
}

/** Repair only adapter-owned, already-delivered Slack artifacts. The answer
 * tombstone remains authoritative, so this path can never re-enter the model
 * or post another final. */
export async function repairSlackInteractionProgress(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  progress: SlackInteractionProgress,
  client: WebClient,
  onProgress: (patch: SlackInteractionProgressPatch) => void | Promise<void>,
): Promise<void> {
  const presenter = new WebClientPresenter(client, {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    agentName: assignment.agent.name,
    ...(assignment.agent.slackPresence?.avatar.url
      ? { agentAvatarUrl: assignment.agent.slackPresence.avatar.url }
      : {}),
    agentId: assignment.agent.id,
    modelLabel: assignment.model ?? tryResolveAgentModel(assignment.agent),
    userId: turn.userId,
    workspaceId: turn.workspaceId,
  });
  const checklistProgress = progress.checklist;
  if (checklistProgress?.cleanup === 'pending') {
    if (checklistProgress.supersededByNative) {
      await presenter.deleteWorkChecklist(checklistProgress.messageTs);
    } else {
      const intent = turn.interactionIntent;
      if (intent?.disposition === 'work') {
        await presenter.updateWorkChecklist(
          checklistProgress.messageTs,
          intent.checklist,
          checklistProgress.terminal === 'error' ? 'failed' : true,
        );
      }
    }
    await onProgress({
      checklist: { ...checklistProgress, cleanup: 'done' },
    });
  }
  const acknowledgment = progress.acknowledgment;
  if (acknowledgment?.created && acknowledgment.cleanup === 'pending') {
    await presenter.removeReaction(acknowledgment.name, {
      channelId: acknowledgment.channelId,
      messageTs: acknowledgment.messageTs,
    });
    await onProgress({
      acknowledgment: { ...acknowledgment, cleanup: 'done' },
    });
  }
}

async function recordExplicitInteractionClassifierUsage(input: {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  classification: Awaited<ReturnType<typeof classifySlackInteraction>>;
  requestedModel: string | null;
  platformEnv: PlatformEnv | undefined;
  options: RunTurnOptions;
}): Promise<void> {
  const enabled = input.options.usageRecordingEnabled ??
    usageRuntimeRecordingEnabled(input.platformEnv);
  if (!enabled) return;
  // Deterministic edge rules invoke no provider and therefore create no usage.
  if (!input.classification.result && !input.classification.failed) return;
  const direct = input.turn.source === 'dm_message' ||
    input.turn.channelType === 'im' ||
    input.turn.channelType === 'mpim';
  const operationId =
    `classification:${input.turn.workspaceId}:${input.turn.channelId}:${input.turn.eventId}`;
  const recorder = new InteractionUsageRecorder({
    operationId,
    executionId: `classification-exec:${input.turn.eventId}`,
    startedAt: slackTimestampMs(input.turn.messageTs) ?? Date.now(),
    workspaceId: input.turn.workspaceId,
    channelId: input.turn.channelId,
    channelLabel: direct
      ? 'Direct message'
      : input.assignment.channelLabel ?? input.turn.channelId,
    conversationKind: direct ? 'direct_message' : 'named_channel',
    agentId: input.assignment.agentId,
    agentLabel: input.assignment.agent.name,
    requestedModel: input.requestedModel,
    credentialRefId: input.assignment.modelCredential?.credentialRefId ?? null,
    credentialVersion: input.assignment.modelCredential?.version ?? null,
    store: input.options.usageStore ?? getUsageStore(input.platformEnv),
    ...(input.options.runId ? { runId: input.options.runId } : {}),
    ...(input.platformEnv ? { platformEnv: input.platformEnv } : {}),
    ...(input.options.usageWriteBudgetMs === undefined
      ? {}
      : { writeBudgetMs: input.options.usageWriteBudgetMs }),
    ...(input.options.onUsagePersistence
      ? { onPersistence: input.options.onUsagePersistence }
      : {}),
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

function slackTimestampMs(value: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const milliseconds = Math.floor(Number(value) * 1_000);
  return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : null;
}

function resolveReactionCoordinate(
  turn: NormalizedSlackTurn,
  target: 'trigger' | 'thread_root' | 'latest_user',
): { channelId: string; messageTs: string } {
  if (target === 'thread_root') {
    return { channelId: turn.channelId, messageTs: turn.threadTs };
  }
  return {
    channelId: turn.channelId,
    messageTs: turn.reactionTargetTs ?? turn.messageTs,
  };
}

async function createSlackShadowLifecycle(input: {
  runId: string;
  attemptNumber: number;
  fencingToken?: number;
  assignment: ResolvedAssignment;
  canonicalModel: string;
  flueInstanceRef: string;
  platformEnv: PlatformEnv | undefined;
  workStore?: WorkStore;
  settingsStore?: SettingsStore;
  mode: 'observe' | 'enforce';
}): Promise<ShadowWorkLifecycle | undefined> {
  try {
    const store = input.workStore ?? getWorkStore(input.platformEnv);
    const providerAuthRoute = await resolveProviderAuthRoute(
      input.canonicalModel,
      input.settingsStore ?? getSettingsStore(input.platformEnv),
    );
    return createWorkExecutionLifecycle(store, {
      runId: input.runId,
      attemptNumber: input.attemptNumber,
      ...(input.fencingToken === undefined ? {} : { fencingToken: input.fencingToken }),
      executorKind: 'agent',
      agentName: input.assignment.agent.id,
      canonicalModel: input.canonicalModel,
      flueInstanceRef: input.flueInstanceRef,
      routeEvidence: safeRuntimeModelRouteEvidence(
        input.canonicalModel,
        providerAuthRoute,
        input.assignment.modelCredential,
      ),
    }, {
      mode: input.mode,
    });
  } catch (error) {
    if (input.mode === 'enforce') throw error;
    console.warn('[work] shadow lifecycle initialization failed; legacy execution will continue');
    return undefined;
  }
}

function agentFailureSafeCode(error: unknown): string {
  if (!(error instanceof AgentPromptFailure)) return 'agent_failed';
  switch (error.kind) {
    case 'provider': return 'provider_failed';
    case 'openai-subscription-reconnect': return 'subscription_reconnect';
    case 'openai-subscription-quota': return 'subscription_quota';
    case 'openai-subscription-policy': return 'subscription_policy';
    case 'sandbox': return 'sandbox_failed';
    case 'sandbox-session-cap': return 'sandbox_session_cap';
    default: return 'agent_failed';
  }
}

function agentFailureBeforeModelInvocation(error: unknown): boolean {
  if (!(error instanceof AgentPromptFailure)) return false;
  return [
    'openai-subscription-reconnect',
    'openai-subscription-policy',
    'sandbox',
    'sandbox-session-cap',
  ].includes(error.kind);
}

export async function shouldUseCloudflareSandbox(
  assignment: ResolvedAssignment,
  env: PlatformEnv | undefined,
): Promise<boolean> {
  return (await resolveCloudflareSandboxDecision(assignment, env)).selection === 'cloudflare';
}

export async function resolveCloudflareSandboxDecision(
  assignment: ResolvedAssignment,
  env: PlatformEnv | undefined,
  store?: SettingsStore,
): Promise<SandboxSelectionDecision> {
  if (!isCloudflareTarget()) return { selection: 'bash', unavailableFallback: false };
  const repositories = assignment.agent.repositories ?? [];
  if (repositories.length === 0) {
    return { selection: 'bash', unavailableFallback: false };
  }

  try {
    const settingsStore = store ?? getSettingsStore(env);
    const [settings, connection] = await Promise.all([
      resolveSandboxSettings(settingsStore),
      getGithubConnection(settingsStore),
    ]);
    return resolveSandboxSelection({
      target: 'cloudflare',
      installed: sandboxBindingInstalled(env),
      enabled: settings.enabled,
      appConnected: connection.mode === 'app',
      repositoryGrants: repositories,
    });
  } catch {
    // The agent factory resolves the same live settings and will fail closed.
    // Avoid touching a container when its policy cannot be established here.
    return { selection: 'bash', unavailableFallback: false };
  }
}

async function freezeRuntimePlanForTurn(input: {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  platformEnv: PlatformEnv | undefined;
  settingsStore?: SettingsStore;
  memoryEpoch: number;
  persist?: (candidate: RuntimePlanV2) => FrozenRuntimePlanDecision | Promise<FrozenRuntimePlanDecision>;
}): Promise<{
  decision: FrozenRuntimePlanDecision;
  unavailableFallback: boolean;
}> {
  const sandboxDecision = await resolveRuntimePlanSandboxSelection(
    input.assignment,
    input.platformEnv,
    input.settingsStore,
  );
  const baseInstructions =
    'instructions' in input.assignment && typeof input.assignment.instructions === 'string'
      ? input.assignment.instructions
      : effectiveSlackInstructions(input.assignment);
  const instructions = [
    baseInstructions,
    externalActionAuthorityInstructions(input.assignment.agent.instructions),
  ].join('\n');
  const actorConnectionContext = input.turn.actorMembershipId
    ? {
        config: getConfigStore(input.platformEnv),
        workspaceId: input.turn.workspaceId,
        agentId: input.assignment.agentId,
        actorMembershipId: input.turn.actorMembershipId,
      }
    : undefined;
  const [allEffectiveConnections, connectionAuthorizations] = actorConnectionContext
    ? await Promise.all([
        resolveEffectiveConnectionAccounts(actorConnectionContext),
        resolvePersonalConnectionAuthorizationOptions(actorConnectionContext),
      ])
    : [undefined, undefined];
  const connectionResolution = allEffectiveConnections
    ? selectConnectionsForRequest({
        connections: allEffectiveConnections,
        requestText: input.turn.text,
      })
    : undefined;
  const candidate = compileRuntimePlanV2({
    turn: input.turn,
    assignment: input.assignment,
    instructions,
    memoryEpoch: input.memoryEpoch,
    sandboxMode: sandboxDecision.selection,
    ...(connectionResolution ? { effectiveConnections: connectionResolution.selected } : {}),
    ...(connectionAuthorizations ? { connectionAuthorizations } : {}),
    ...(connectionResolution ? { connectionChoices: connectionResolution.ambiguous } : {}),
  });
  const decision = input.persist
    ? await input.persist(candidate)
    : {
        runtimePlan: candidate,
        instanceId: deriveRuntimePlanInstanceId(candidate),
        continuityNoticeRequired: false,
      };
  if (
    decision.runtimePlan.conversation.continuityKey !==
    candidate.conversation.continuityKey
  ) {
    throw new Error('Frozen RuntimePlanV2 belongs to another Slack conversation.');
  }
  return { decision, unavailableFallback: sandboxDecision.unavailableFallback };
}

async function resolveRuntimePlanSandboxSelection(
  assignment: ResolvedAssignment,
  env: PlatformEnv | undefined,
  store?: SettingsStore,
): Promise<SandboxSelectionDecision> {
  if (!isCloudflareTarget()) {
    return { selection: 'bash', unavailableFallback: false };
  }
  return resolveCloudflareSandboxDecision(assignment, env, store);
}

export const MEMORY_CHANGED_RETRY_TEXT =
  'Channel memory or Slack access changed while I was answering, so I withheld the draft. Before trying again, check whether any requested external action already completed.';

export function resolveMemoryDeliveryText(
  draft: string,
  recoveredText: string | undefined,
  leaseValid: boolean,
): string {
  if (leaseValid) return draft;
  return recoveredText || MEMORY_CHANGED_RETRY_TEXT;
}

/**
 * Deliver ONLY the sanitized generic failure final — the relay alarm's
 * last-ditch on the terminal attempt, when `runTurn` itself kept throwing (a
 * genuine delivery failure, not an agent execution failure, which runTurn
 * already surfaces as a categorized final and returns). Best-effort: the caller swallows
 * its errors (if Slack is the thing that is failing, this post fails too).
 */
export async function deliverAgentFailureFinal(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  client: WebClient,
  platformEnv?: PlatformEnv,
): Promise<void> {
  const resolvedModel = assignment.model ?? tryResolveAgentModel(assignment.agent);
  const publicUrl = await resolveSlackPublicUrl(platformEnv);
  const agentAvatarUrl = agentAvatarUrlForPresentation(assignment.agent, publicUrl);
  const presenter = new WebClientPresenter(client, {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    agentName: assignment.agent.name,
    ...(agentAvatarUrl
      ? { agentAvatarUrl }
      : {}),
    agentId: assignment.agent.id,
    modelLabel: resolvedModel,
    publicUrl,
    userId: turn.userId,
    workspaceId: turn.workspaceId,
  });
  await presenter.deliverFinal(AGENT_FAILURE_TEXT, 'plain_text');
}

function tryResolveAgentModel(agent: Parameters<typeof resolveAgentModel>[0]): string | undefined {
  try {
    return resolveAgentModel(agent);
  } catch {
    return undefined;
  }
}

function thinkingStatus(): SlackStatusUpdate {
  return { text: 'is thinking...' };
}

function hydratedContextStatus(context: SlackTurnContext): SlackStatusUpdate {
  const count = context.messages.length;
  const noun = count === 1 ? 'message' : 'messages';
  return {
    text: `is using ${count} ${noun} of ${context.mode} context`,
  };
}

function modelStatus(modelId: string): SlackStatusUpdate {
  return {
    text: `is using ${modelId}`,
  };
}

export function applyVisibilityBarrier(
  context: SlackTurnContext,
  barrierAt: number | null,
): SlackTurnContext {
  if (barrierAt === null) return context;
  return {
    ...context,
    messages: context.messages.filter((message) => {
      if (message.isTrigger) return true;
      return slackTimestampAtOrAfter(message.ts, barrierAt);
    }),
  };
}

function slackTimestampAtOrAfter(timestamp: string, barrierAt: number): boolean {
  if (!Number.isSafeInteger(barrierAt) || barrierAt < 0) return false;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(timestamp);
  if (!match) return false;
  const fraction = match[2] ?? '';
  const scaleDigits = Math.max(3, fraction.length);
  const scale = 10n ** BigInt(scaleDigits);
  const timestampUnits =
    BigInt(match[1]!) * scale + BigInt(fraction.padEnd(scaleDigits, '0') || '0');
  const barrierUnits = BigInt(barrierAt) * (scale / 1_000n);
  return timestampUnits >= barrierUnits;
}

export function sanitizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
