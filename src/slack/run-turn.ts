import { verifyMemoryUpdateAcknowledgement } from './memory-update-terminal.ts';
import { WebClient } from '@slack/web-api';

import {
  compileRuntimePlanV2,
  deriveRuntimePlanInstanceId,
  type RuntimePlanV2,
} from '../agents/runtime-plan.ts';
import { effectiveSlackInstructions } from '../config/effective-config.ts';
import { CHICKPEA_AGENT_NAME } from '../config/agent-id.ts';
import { resolveAgentModel } from '../config/model-policy.ts';
import { getGithubConnection } from '../config/github-app.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { resolveSandboxSettings } from '../config/sandbox-settings.ts';
import {
  getConfigStore,
  getIdentityStore,
  getManagementStore,
  getSettingsStore,
  getUsageStore,
  getWorkStore,
  type AppStores,
} from '../config/state-backend.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type {
  SlackInteractionProgress,
  SlackInteractionProgressPatch,
} from '../config/state-rpc.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import {
  freezeRuntimeModelRoute,
  resolveProviderAuthRoute,
  resolveRuntimeModel,
  safeRuntimeModelRouteEvidence,
} from '../config/runtime-model.ts';
import { parseMemoryCommand } from '../memory/commands.ts';
import { handleMemoryCommand, prepareMemoryTurn } from '../memory/runtime.ts';
import {
  handleRoutineSlackRequest,
  parseRoutineCommand,
  routineResponseVisibility,
  shouldHandleRoutineCommandTurn,
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
import { resolveSlackCredentials, resolveSlackPublicUrl } from './credentials.ts';
import { agentAvatarUrlForPresentation } from './agent-presence/avatar-assets.ts';
import type { SlackStatusUpdate } from './replies.ts';
import { activityStatus, initialActivityStatus } from '../activity/status.ts';
import { registerSlackStatusTurn } from './status-registry.ts';
import { currentMessageOnlyContext, type SlackTurnContext } from './thread-context.ts';
import { slackAgentThreadKey, slackConversationKind } from './thread-key.ts';
import { slackTimestampMs } from './timestamp.ts';
import { formatSlackPublicHandoff } from './public-context.ts';
import type { NormalizedSlackTurn } from './types.ts';
import {
  effectiveTurnSlackInstallationId,
  resolveSlackInstallationExecutionContext,
  SlackInstallationUnavailableError,
  type SlackInstallationExecutionContext,
} from './installation-execution.ts';
import type { FrozenRuntimePlanDecision } from './turn-job-types.ts';
import type { FlueDispatchReceiptV1 } from './turn-job-types.ts';
import type { SlackProgressiveReadRelay } from './progressive-relay.ts';
import {
  decideProgressiveEligibility,
  type ProgressiveEligibilityDecision,
} from './progressive-eligibility.ts';
import type { SlackPresentationOwner } from './run-presentations.ts';
import { slackProgressiveStreamingEnabled } from './progressive-ops-flag.ts';
import { slackSemanticActivityStatusEnabled } from './semantic-status-flag.ts';
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
import type { SlackTablePresentation } from './table-presentation.ts';
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
  SlackAgentViewPresentation,
  type SlackPresentationStatePort,
} from './agent-view-presentation.ts';
import { createSlackWebClient } from './web-client.ts';
import {
  externalActionAuthorityInstructions,
  resolveConnectionAccountContext,
  selectConnectionsForRequest,
} from '../connections/runtime.ts';
import { createLiveWorkspaceManagementService } from '../management/live-service.ts';
import {
  executeHostSlackManagementApproval,
  type SlackManagementApprovalDependencies,
} from '../management/slack-approval.ts';
import { resolveSlackManagementActor } from '../management/slack-tools.ts';

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
  installationContext?: SlackInstallationExecutionContext;
  /** Focused-test override for proving replay and delivery lifecycle behavior. */
  agentPrompt?: typeof promptSlackThreadAgent;
  /** Adapter-owned dispatch/read checkpoints restored by the relay. */
  flueDispatch?: SlackFlueDispatchState;
  /** Durable turn key forwarded to the sandbox for cap/idempotency state. */
  turnId?: string;
  /** Recorded result from an earlier attempt; skips the agent entirely. */
  replayText?: string;
  /** Recovery replays can be a durable failure rather than a successful answer. */
  replayTerminalResult?: 'answer' | 'failure';
  /** Persist sandbox side effects before the final Slack delivery can fail. */
  beforeDelivery?: () => Promise<string | undefined>;
  /** Persist terminal delivery before post-delivery workspace teardown begins. */
  onDelivered?: (outcome?: 'succeeded' | 'no_op' | 'failed') => void | Promise<void>;
  /** A durable outbox now owns the terminal; keep the TurnJob open until it settles. */
  onDeferredTerminal?: () => void | Promise<void>;
  /** Record a confirmed Slack-visible final for future owner handoffs. */
  onPublicMessageDelivered?: (
    input: { messageTs: string; text: string },
  ) => void | Promise<void>;
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
  /** Local state ports when the turn already runs inside their owning DO. */
  appStores?: AppStores;
  /** Lazily resolved local management runtime when the turn runs inside its owning DO. */
  managementApproval?: SlackManagementApprovalDependencies |
    (() => SlackManagementApprovalDependencies);
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
  /** Adapter seam; absent means terminal-only delivery. */
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
}

export const WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT =
  'The Workspace default model needs attention. An owner or admin can repair it in Settings → Model providers.';

function resolveManagementApprovalDependencies(
  configured: SlackManagementApprovalDependencies |
    (() => SlackManagementApprovalDependencies) |
    undefined,
  fallback: () => SlackManagementApprovalDependencies,
): SlackManagementApprovalDependencies {
  if (typeof configured === 'function') return configured();
  return configured ?? fallback();
}

/**
 * Full Slack turn lifecycle:
 *   1. set best-effort native Assistant status when the capability is enabled,
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
  const turnWorkspaceId = effectiveTurnSlackInstallationId(turn);
  const installationContext = options.installationContext ?? (
    options.client
      ? undefined
      : await resolveSlackInstallationExecutionContext(turnWorkspaceId, platformEnv, {
          ...(options.settingsStore ? { settings: options.settingsStore } : {}),
        })
  );
  if (installationContext && installationContext.workspaceId !== turnWorkspaceId) {
    throw new SlackInstallationUnavailableError(turnWorkspaceId, 'execution_workspace_mismatch');
  }
  const client = installationContext?.client ?? options.client ?? (await getClient(platformEnv));
  // A frozen assignment (from a thread snapshot) carries its model; otherwise
  // resolve it from the agent via policy.
  const resolvedModel = resolvedAssignmentModel(assignment);
  const ledgerAuthority = options.executionAuthority === 'ledger';
  const commandAddress = {
    botUserId: installationContext?.botUserId,
    agentUserGroupId: assignment.agent.slackPresence?.userGroupId,
  };
  const settingsStore = options.settingsStore ?? options.appStores?.settings;
  // env (SLACK_TAG_PUBLIC_URL) → stored slack.publicUrl (the origin the admin
  // pinned): on a button deploy nobody sets the env var, so without the stored
  // fallback the footer's "Configure" link would be dead.
  const publicUrl = await resolveSlackPublicUrl(platformEnv, settingsStore);
  const agentAvatarUrl = agentAvatarUrlForPresentation(assignment.agent, publicUrl);
  let frozenPresentation = options.presentationState && options.runId
    ? await options.presentationState.getRunPresentation(options.runId)
    : undefined;
  const visibleOwner: SlackPresentationOwner | undefined =
    frozenPresentation?.schemaVersion === 3 ? frozenPresentation.owner : undefined;
  const footerModelLabel = resolvedModel;
  const visibleAgentName = visibleOwner?.kind === 'selected_agent'
    ? visibleOwner.persona.name
    : visibleOwner?.kind === 'chickpea'
      ? CHICKPEA_AGENT_NAME
      : assignment.agent.name;
  const visibleAgentAvatarUrl = visibleOwner?.kind === 'selected_agent'
    ? visibleOwner.persona.avatarUrl
    : visibleOwner?.kind === 'chickpea'
      ? undefined
      : agentAvatarUrl;
  // Once the Chickpea contract is active, the frozen Workspace default is the
  // only fallback for an unpinned Agent. Never reintroduce SLACK_TAG_MODEL (or
  // another implicit provider default) after admission failed to freeze one.
  if (
    assignment.runtimeContract === 'chickpea-v1' && !resolvedModel &&
    !turn.managementApprovalProposalId
  ) {
    const repairPresenter = new WebClientPresenter(client, {
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      agentName: visibleAgentName,
      ...(visibleAgentAvatarUrl ? { agentAvatarUrl: visibleAgentAvatarUrl } : {}),
      ...(visibleOwner ? { visibleOwner } : {}),
      agentId: assignment.agent.id,
      publicUrl,
      userId: turn.userId,
      workspaceId: turn.workspaceId,
    }, undefined, {
      deliverySafety: options.executionAuthority === 'ledger' ? 'ledger' : 'legacy',
      ...(options.onPublicMessageDelivered
        ? { onPublicDelivery: options.onPublicMessageDelivered }
        : {}),
    });
    await repairPresenter.deliverFinal(WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT, 'plain_text', 'error');
    await options.onDelivered?.();
    await repairPresenter.markCanonicalPresentationFinalized();
    return;
  }
  // Exact `!routines` controls stay deterministic. All natural-language
  // schedule creation and editing reaches the interactive Flue Agent, where
  // agent-authoring decides placement and uses management proposals.
  if (shouldHandleRoutineCommandTurn(turn, commandAddress)) {
    const routineText = await handleRoutineSlackRequest(turn, platformEnv, {
      ...(installationContext ? { installationContext } : {}),
      assignment,
      ...(options.appStores
        ? {
            store: options.appStores.routines,
            config: options.appStores.config,
            identity: options.appStores.identity,
          }
        : {}),
    });
    if (routineText !== undefined) {
      const routinePresenter = new WebClientPresenter(client, {
        channelId: turn.channelId,
        threadTs: turn.threadTs,
        agentName: visibleAgentName,
        ...(visibleAgentAvatarUrl
          ? { agentAvatarUrl: visibleAgentAvatarUrl }
          : {}),
        ...(visibleOwner ? { visibleOwner } : {}),
        agentId: assignment.agent.id,
        ...(footerModelLabel === undefined ? {} : { modelLabel: footerModelLabel }),
        publicUrl,
        userId: turn.userId,
        workspaceId: turn.workspaceId,
      }, undefined, {
        ...(options.onPublicMessageDelivered
          ? { onPublicDelivery: options.onPublicMessageDelivered }
          : {}),
      });
      if (routineResponseVisibility(turn.text, turn.channelId, commandAddress) === 'requester') {
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
    Boolean(turn.managementApprovalProposalId) ||
    (isRoutineSlackTurn(turn) && Boolean(parseRoutineCommand(turn.text, commandAddress)));
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
      requestedModel: resolvedModel ?? null,
    }, platformEnv, undefined, undefined, {
      ...(settingsStore ? { settings: settingsStore } : {}),
    });
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
  // re-resolve current Agent memory (which could both block recovery
  // on a changed lease and unnecessarily touch live state).
  const preparedMemory = memoryCommand || turn.managementApprovalProposalId ||
      options.replayText !== undefined
    ? undefined
    : await prepareMemoryTurn({
        turn,
        assignment,
        platformEnv,
        client,
        ...(installationContext
          ? { botToken: installationContext.botToken, botUserId: installationContext.botUserId }
          : {}),
        ...(options.appStores
          ? {
              dependencies: {
                config: options.appStores.config,
                identity: options.appStores.identity,
                state: options.appStores.memory,
              },
            }
          : {}),
      });
  const conversationKey = preparedMemory?.conversationKey ?? slackAgentThreadKey(turn, assignment);
  let sandboxUnavailableFallback = false;
  let runtimePlanDecision = options.runtimePlanDecision;
  if (!runtimePlanDecision && preparedMemory && resolvedModel) {
    const frozen = await freezeRuntimePlanForTurn({
          turn,
          assignment,
          platformEnv,
          memoryEpoch: preparedMemory.memoryEpoch,
          ...(settingsStore ? { settingsStore } : {}),
          ...(options.appStores?.config ? { configStore: options.appStores.config } : {}),
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
        ...(settingsStore ? { settingsStore } : {}),
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
          agentName: visibleAgentName,
          ...(footerModelLabel === undefined ? {} : { modelLabel: footerModelLabel }),
          agentId: assignment.agent.id,
          ...(publicUrl ? { publicUrl } : {}),
          memoryItems: preparedMemory?.footerItems,
        },
        onNativeStarted: () => onNativeStarted(),
      })
    : undefined;
  const presenter = new WebClientPresenter(client, {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    agentName: visibleAgentName,
    ...(visibleAgentAvatarUrl
      ? { agentAvatarUrl: visibleAgentAvatarUrl }
      : {}),
    ...(visibleOwner ? { visibleOwner } : {}),
    agentId: assignment.agent.id,
    ...(footerModelLabel === undefined ? {} : { modelLabel: footerModelLabel }),
    publicUrl,
    userId: turn.userId,
    workspaceId: turn.workspaceId,
    ...(preparedMemory ? { memoryFooterItems: preparedMemory.footerItems } : {}),
  }, workLifecycle, {
    deliverySafety: ledgerAuthority ? 'ledger' : 'legacy',
    ...(agentViewPresentation ? { agentViewPresentation } : {}),
    ...(frozenPresentation?.schemaVersion === 3
      ? { activityProjection: frozenPresentation.activityProjection }
      : {}),
    ...(frozenPresentation?.schemaVersion === 3 &&
        frozenPresentation.currentActivity?.operation.certainty === 'unknown'
      ? { activityMayBeVisible: true }
      : {}),
    ...(frozenPresentation?.schemaVersion === 3 &&
        options.presentationState?.reserveSlackActivityStatus &&
        options.presentationState.applySlackActivityStatusCooldown
      ? {
          activityStatusCoordinator: {
            reserve: async () => options.presentationState!.reserveSlackActivityStatus!(
              frozenPresentation.root.workspaceId,
            ),
            applyCooldown: async (retryAfterMs: number) =>
              options.presentationState!.applySlackActivityStatusCooldown!(
                frozenPresentation.root.workspaceId,
                retryAfterMs,
              ),
          },
        }
      : {}),
    ...(options.onPublicMessageDelivered
      ? { onPublicDelivery: options.onPublicMessageDelivered }
      : {}),
  });
  await agentViewPresentation?.beginAgentSessionProcessing();
  const statusGeneration = options.turnId ?? `msg:${turn.channelId}:${turn.messageTs}`;
  const statusInstanceId = runtimePlanDecision?.instanceId ?? agentConversationKey;
  const semanticActivityEnabled = frozenPresentation?.schemaVersion === 3
    ? frozenPresentation.currentActivity !== undefined
    : slackSemanticActivityStatusEnabled(platformEnv);
  const admittedVisibleStatus = frozenPresentation?.schemaVersion === 3 &&
      frozenPresentation.activityProjection.surface === 'assistant_status' &&
      frozenPresentation.activityProjection.state === 'visible' &&
      frozenPresentation.currentActivity?.operation.certainty === 'acknowledged'
    ? activityStatus(
        frozenPresentation.currentActivity.kind,
        frozenPresentation.currentActivity.action,
        frozenPresentation.currentActivity.object,
        frozenPresentation.currentActivity.family,
        frozenPresentation.currentActivity.phase,
      )
    : undefined;
  const activityPresenter = {
    async setStatus(update: SlackStatusUpdate): Promise<boolean> {
      if (!semanticActivityEnabled) return false;
      let activityWrite: Awaited<ReturnType<SlackAgentViewPresentation['beginActivity']>>;
      try {
        activityWrite = await agentViewPresentation?.beginActivity(
          update,
          presenter.preferredActivitySurface(),
        );
      } catch {
        // No Slack effect may precede its durable intent.
        return false;
      }
      if (frozenPresentation?.schemaVersion === 3 && !activityWrite) return false;
      const succeeded = await presenter.setStatus(update, activityWrite);
      try {
        const receipt = presenter.activityReceipt();
        await agentViewPresentation?.recordActivityReceipt(
          activityWrite?.operationId,
          receipt.certainty,
          receipt.messageTs,
          receipt.unavailable,
        );
      } catch {
        // Slack may already have accepted the activity. Keep the presenter's
        // one-message coordinate and let durable repair reconcile the receipt.
        return false;
      }
      return succeeded;
    },
    async refreshStatus(update: SlackStatusUpdate): Promise<boolean> {
      if (!semanticActivityEnabled || !agentViewPresentation) return false;
      const durable = await agentViewPresentation.prepareActivityRefresh(update);
      if (!durable) return false;
      return presenter.setStatus(update, durable);
    },
  };
  const statusTurn = registerSlackStatusTurn(statusInstanceId, activityPresenter, {
    generation: statusGeneration,
    ...(frozenPresentation?.schemaVersion === 3
      ? {
          sessionGeneration: frozenPresentation.sessionGeneration,
          ownershipKey: [
            frozenPresentation.root.workspaceId,
            frozenPresentation.root.channelId,
            frozenPresentation.root.threadTs,
          ].join(':'),
          ...(admittedVisibleStatus ? { initialAppliedStatus: admittedVisibleStatus } : {}),
          ...(admittedVisibleStatus ? { refreshInitialStatus: true } : {}),
        }
      : {}),
  });
  let admissionStatusAttempted = false;
  if (frozenPresentation?.schemaVersion === 3 &&
      frozenPresentation.currentActivity?.operation.certainty === 'pending') {
    admissionStatusAttempted = true;
    const admitted = frozenPresentation.currentActivity;
    await statusTurn.setStatus(activityStatus(
      admitted.kind,
      admitted.action,
      admitted.object,
      admitted.family,
      admitted.phase,
    )).catch(() => {
      // The durable pending receipt remains repairable; status is cosmetic.
      console.warn('[chickpea] admitted Slack activity projection failed');
      return false;
    });
  }
  let terminalStatusFinished = false;
  const finishStatus = async (result: 'answer' | 'failure'): Promise<void> => {
    // Close the sink first. Agent observations are relayed best-effort from a
    // different Cloudflare isolate and may still arrive after settlement
    // resolves; removing this generation makes its late relays no-ops even if
    // another turn has already registered under the same conversation key.
    // The normal clear is awaited so it reaches Slack before the Worker turn
    // settles. If an active status write lands after it, the registry issues a
    // second best-effort clear without blocking the final response.
    await agentViewPresentation?.settleAgentSession(result);
    await statusTurn.finish(async (late) => {
      if (frozenPresentation?.schemaVersion !== 3 || !agentViewPresentation) {
        await presenter.clearStatus(late);
        return;
      }
      const cleanup = await agentViewPresentation.prepareActivityCleanup();
      if (cleanup.kind === 'already_cleared') {
        // An in-flight native write may have landed after the acknowledged
        // durable cleanup. Re-clear the transport without rewriting receipts.
        if (late && cleanup.surface === 'assistant_status') {
          await presenter.clearStatus(true);
        }
        return;
      }
      if (cleanup.kind !== 'prepared') return;
      const certainty = await presenter.clearStatus(late);
      await agentViewPresentation.recordActivityCleanupReceipt(
        cleanup.operationId,
        certainty,
      );
    });
    await agentViewPresentation?.settleLifecycle();
    terminalStatusFinished = true;
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
  const finishDelivery = async (
    outcome?: 'succeeded' | 'no_op' | 'failed',
  ): Promise<void> => {
    // Delivery gets its durable tombstone before the best-effort repair so a
    // slow reporting backend can never make Slack retry already-delivered work.
    await options.onDelivered?.(outcome);
    await presenter.markCanonicalPresentationFinalized();
    await usageRecorder?.repairAfterDelivery();
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

  // 1. Visible work: set best-effort native status. A rejection degrades to
  //    Agent Session lifecycle only and never creates a progress message.
  try {
    // Owner-native memory is authorized live, independently of the frozen
    // config snapshot. Fence every visible Slack effect as well as model/tool
    // execution when the selected owner lease has already gone stale.
    if (preparedMemory?.ownerBound && !(await preparedMemory.validateLease())) {
      // Fail closed, never silently: the durable relay only retires a turn job
      // once delivery is tombstoned, so an early `return` here left the job
      // pending and the alarm re-armed forever behind a live "Thinking…"
      // status. Mirror the post-run lease fence: one sanitized final, the
      // status cleared, and a terminal delivery outcome.
      await statusTurn.prepareFinal();
      await presenter.deliverFinal(AGENT_FAILURE_TEXT, 'plain_text', 'error');
      await finishStatus('failure');
      await finishDelivery('failed');
      return;
    }
    await agentViewPresentation?.setTitle(turn.text).catch(() => {
      console.warn('[chickpea] Slack Agent View title could not be recorded');
    });
    if (turn.managementApprovalProposalId && options.replayText === undefined) {
      const dependencies = resolveManagementApprovalDependencies(options.managementApproval, () => {
        if (isCloudflareTarget()) {
          throw new Error('Cloudflare Slack approvals require the local management runtime');
        }
        const identity = options.appStores?.identity ?? getIdentityStore(platformEnv);
        const config = options.appStores?.config ?? getConfigStore(platformEnv);
        const management = options.appStores?.management ?? getManagementStore(platformEnv);
        return {
          identity,
          config,
          management,
          service: createLiveWorkspaceManagementService(platformEnv, {
            identity,
            ...(settingsStore ? { settings: settingsStore } : {}),
            ...(options.usageStore ? { usage: options.usageStore } : {}),
            overrides: {
              identity,
              config,
              management,
              ...(publicUrl ? { setupBaseUrl: publicUrl } : {}),
              ...(options.appStores
                ? {
                    memory: options.appStores.memory,
                    routines: options.appStores.routines,
                    work: options.appStores.work,
                  }
                : {}),
            },
          }),
          ...(publicUrl ? { publicUrl } : {}),
        };
      });
      const approvalDependencies = dependencies.publicUrl || !publicUrl
        ? dependencies
        : { ...dependencies, publicUrl };
      const persisted = await workLifecycle?.prepareExecution('Slack management approval');
      void persisted;
      const approval = await executeHostSlackManagementApproval({
        turn,
        assignment,
        turnJobId: options.turnId ?? `msg:${turn.channelId}:${turn.messageTs}`,
        proposalId: turn.managementApprovalProposalId,
        dependencies: approvalDependencies,
        ...(agentViewPresentation && options.runId
          ? {
              presentationRunId: options.runId,
              prepareAgentWelcomeTerminal: async () => {
                await agentViewPresentation.prepareDeferredTerminalDelivery('answer');
              },
            }
          : {}),
      });
      if (workLifecycle?.hasExecution) {
        await workLifecycle.settleExecution({
          outcome: 'succeeded',
          rawStatus: 'host_management_approval_succeeded',
          modelInvoked: false,
        });
      }
      if (approval.kind === 'message') {
        await statusTurn.prepareFinal();
        await presenter.deliverFinal(approval.text, 'markdown');
      }
      await finishStatus('answer');
      await finishDelivery();
      return;
    }
    if (memoryCommand) {
      const handled = await handleMemoryCommand({
        turn,
        assignment,
        platformEnv,
        client,
        presenter,
        ...(installationContext
          ? { botToken: installationContext.botToken, botUserId: installationContext.botUserId }
          : {}),
        ...(options.appStores
          ? {
              dependencies: {
                config: options.appStores.config,
                identity: options.appStores.identity,
                state: options.appStores.memory,
              },
            }
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
        store: options.usageStore ?? options.appStores?.usage ?? getUsageStore(platformEnv),
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
    // The eyes reaction is a lightweight receipt on the user's root message,
    // distinct from the native activity status. Persist whether this run
    // created it so terminal cleanup never removes a pre-existing reaction.
    if (workChecklist && !interactionProgress.acknowledgment) {
      try {
        workAcknowledgment = await presenter.addSemanticReaction(
          'work_ack',
          triggerCoordinate,
        );
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
    const initialStatus = frozenPresentation?.schemaVersion === 3 &&
        frozenPresentation.currentActivity
      ? activityStatus(
          frozenPresentation.currentActivity.kind,
          frozenPresentation.currentActivity.action,
          frozenPresentation.currentActivity.object,
          frozenPresentation.currentActivity.family,
          frozenPresentation.currentActivity.phase,
        )
      : initialActivityStatus(workChecklist, turn.text);
    if (semanticActivityEnabled && !admittedVisibleStatus && !admissionStatusAttempted) {
      await statusTurn.setStatus(initialStatus);
    }

    // 2. Hydrate bounded context (degrades to current-message-only on failure).
    const frozenHandoff = runtimePlanDecision?.runtimePlan.handoffContext ??
      assignment.handoffContext ?? [];
    const hydratedContext = frozenHandoff.length > 0
      ? currentMessageOnlyContext(turn)
      : await hydrateSlackContextViaWebClient(client, turn);
    const context = applyVisibilityBarrier(
      hydratedContext,
      preparedMemory?.visibilityBarrierAt ?? null,
    );
    const handoffBlock = formatSlackPublicHandoff(frozenHandoff);
    const progressiveRelayFactory = options.prepareProgressiveRelay ??
      (agentViewPresentation
        ? (input: Parameters<NonNullable<RunTurnOptions['prepareProgressiveRelay']>>[0]) =>
            agentViewPresentation.prepareReceipt(input)
        : undefined);
    let frozenProgressiveEligibility: ProgressiveEligibilityDecision | undefined;
    let currentRequestPolicyVersion: 1 | 2 = 2;
    if (
      options.replayText === undefined &&
      progressiveRelayFactory &&
      options.runId &&
      runtimePlanDecision
    ) {
      const candidate = decideProgressiveEligibility({
        runtimePlan: runtimePlanDecision.runtimePlan,
        operationsEnabled: slackProgressiveStreamingEnabled(platformEnv),
        memorySelected: (preparedMemory?.selection?.entries.length ?? 0) > 0,
        recoveryRequired: false,
        concurrentAttributionProven: options.progressiveAttributionProven === true,
        replacementCapable: options.beforeDelivery !== undefined &&
          runtimePlanDecision.runtimePlan.sandbox.mode === 'cloudflare',
      });
      if (agentViewPresentation) {
        const frozen = await agentViewPresentation.freezeProgressiveEligibility(candidate);
        frozenProgressiveEligibility = {
          allowed: frozen.allowed,
          reason: frozen.reason,
        };
        currentRequestPolicyVersion = frozen.presentationSchemaVersion === 1 ? 1 : 2;
      } else {
        frozenProgressiveEligibility = candidate;
      }
    }
    const prompt = assembleSlackPrompt(turn, context, {
      ...(handoffBlock ? { handoffBlock } : {}),
      ...(preparedMemory?.promptBlock ? { memoryBlock: preparedMemory.promptBlock } : {}),
      memorySelected: (preparedMemory?.selection?.entries.length ?? 0) > 0,
      currentRequestPolicyVersion,
      progressiveStreamingOffered:
        currentRequestPolicyVersion === 2 && frozenProgressiveEligibility?.allowed === true,
      ...(installationContext
        ? {
            slackApp: {
              botUserId: installationContext.botUserId,
              ...(installationContext.displayName
                ? { displayName: installationContext.displayName }
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
    let tablePresentation: SlackTablePresentation | undefined =
      options.flueDispatch?.flueSettlement?.outcome === 'completed'
        ? options.flueDispatch.flueSettlement.result.tablePresentations?.[0]
        : undefined;
    if (options.replayText !== undefined) {
      text = options.replayText;
    } else {
      try {
        usedCloudflareSandbox = runtimePlanDecision
          ? runtimePlanDecision.runtimePlan.sandbox.mode === 'cloudflare' &&
            !turn.attachmentIntake && !turn.attachments?.length &&
            !sandboxUnavailableFallback
          : await shouldUseCloudflareSandbox(assignment, platformEnv);
        if (!options.agentPrompt && !options.flueDispatch) {
          throw new Error('Durable Flue dispatch state is unavailable.');
        }
        let prepareProgressiveRelay:
          | NonNullable<Parameters<typeof promptSlackThreadAgent>[0]['prepareProgressiveRelay']>
          | undefined;
        if (
          progressiveRelayFactory &&
          options.runId &&
          frozenProgressiveEligibility
        ) {
          prepareProgressiveRelay = ({ instanceId, receipt }) =>
            progressiveRelayFactory({
              runId: options.runId!,
              runFencingToken: options.runFencingToken ?? 0,
              instanceId,
              receipt,
              eligibility: frozenProgressiveEligibility,
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
          ...(prepareProgressiveRelay ? { prepareProgressiveRelay } : {}),
        });
        text = sandboxUnavailableFallback
          ? `${SANDBOX_UNAVAILABLE_FALLBACK_NOTICE}\n\n${agentResult.text}`
          : agentResult.text;
        tablePresentation = agentResult.tablePresentations?.[0];
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
        await agentViewPresentation?.recordExecutionFailure(
          'agent execution stopped before the active milestone finished.',
        );
        console.error('[chickpea] agent run failed:', sanitizeError(err));
        const modelNotInvoked = agentFailureBeforeModelInvocation(err);
        await workLifecycle?.settleExecution({
          outcome: modelNotInvoked ? 'not_submitted' : 'failed',
          rawStatus: modelNotInvoked ? 'model_not_invoked' : 'flue_failed',
          safeFailureCode: agentFailureSafeCode(err),
        });
        await usageRecorder?.recordFailure();
        const recoveredText = await options.beforeDelivery?.();
        if (recoveredText) {
          await preparedMemory?.confirmInjection();
          await statusTurn.prepareFinal();
          await presenter.deliverFinal(
            installationContext
              ? renderSlackSelfMention(recoveredText, installationContext.botUserId)
              : recoveredText,
            'markdown',
          );
          await finishStatus('answer');
          await finishDelivery();
          return;
        }
        await statusTurn.prepareFinal();
        await presenter.deliverFinal(agentFailureText(err), 'plain_text', 'error');
        await finishStatus('failure');
        await finishDelivery('failed');
        return;
      }
    }
    if (agentResult?.agentCreationTerminal) {
      const terminal = agentResult.agentCreationTerminal;
      const dependencies = resolveManagementApprovalDependencies(options.managementApproval, () => {
        const identity = options.appStores?.identity ?? getIdentityStore(platformEnv);
        const config = options.appStores?.config ?? getConfigStore(platformEnv);
        const management = options.appStores?.management ?? getManagementStore(platformEnv);
        return {
          identity,
          config,
          management,
          service: createLiveWorkspaceManagementService(platformEnv, {
            identity,
            ...(settingsStore ? { settings: settingsStore } : {}),
            ...(options.usageStore ? { usage: options.usageStore } : {}),
            overrides: {
              identity,
              config,
              management,
              ...(publicUrl ? { setupBaseUrl: publicUrl } : {}),
              ...(options.appStores
                ? {
                    memory: options.appStores.memory,
                    routines: options.appStores.routines,
                    work: options.appStores.work,
                  }
                : {}),
            },
          }),
        };
      });
      const turnJobId = options.turnId ?? `msg:${turn.channelId}:${turn.messageTs}`;
      const signal = {
        agentId: assignment.agent.id,
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        threadTs: assignment.runtimeContract === 'chickpea-v1'
          ? turn.threadTs
          : turn.sessionThreadTs ?? turn.threadTs,
        conversationKind: slackConversationKind(turn),
        slackUserId: turn.userId,
        eventId: turn.eventId,
        messageTs: turn.messageTs,
        turnJobId,
        requesterText: turn.text,
      } as const;
      const actor = await resolveSlackManagementActor(signal, dependencies.identity);
      await preparedMemory?.confirmInjection();
      if (agentViewPresentation && options.runId) {
        await agentViewPresentation.prepareDeferredTerminalDelivery('answer');
      }
      const finalized = await dependencies.service.finalizeSlackAgentCreationWelcome({
        context: actor,
        operationId: terminal.operationId,
        creationItemId: terminal.creationItemId,
        agentId: terminal.agentId,
        connectorMentions: terminal.connectorMentions,
        followOnNotices: terminal.followOnNotices,
        turnJobId,
        ...(agentViewPresentation && options.runId
          ? { presentationRunId: options.runId }
          : {}),
      });
      if (!finalized.created &&
          (finalized.outbox.status === 'delivered' || finalized.outbox.status === 'failed')) {
        await finishStatus(finalized.outbox.status === 'delivered' ? 'answer' : 'failure');
        await finishDelivery();
        return;
      }
      await options.onDeferredTerminal?.();
      return;
    }
    if (agentResult?.memoryUpdate && preparedMemory?.validateReceiptLease) {
      // A changed memory invalidates the model draft, including forgotten facts.
      // Only a verified own-turn receipt permits this host acknowledgement.
      let acknowledge = false;
      try {
        const dependencies = resolveManagementApprovalDependencies(options.managementApproval, () => {
          const identity = options.appStores?.identity ?? getIdentityStore(platformEnv);
          const config = options.appStores?.config ?? getConfigStore(platformEnv);
          const management = options.appStores?.management ?? getManagementStore(platformEnv);
          return {
            identity,
            config,
            management,
            service: createLiveWorkspaceManagementService(platformEnv, {
              identity,
              ...(settingsStore ? { settings: settingsStore } : {}),
              ...(options.usageStore ? { usage: options.usageStore } : {}),
              overrides: {
                identity,
                config,
                management,
                ...(publicUrl ? { setupBaseUrl: publicUrl } : {}),
                ...(options.appStores
                  ? {
                      memory: options.appStores.memory,
                      routines: options.appStores.routines,
                      work: options.appStores.work,
                    }
                  : {}),
              },
            }),
          };
        });
        const turnJobId = options.turnId ?? `msg:${turn.channelId}:${turn.messageTs}`;
        const signal = {
          agentId: assignment.agent.id,
          workspaceId: turn.workspaceId,
          channelId: turn.channelId,
          threadTs: assignment.runtimeContract === 'chickpea-v1'
            ? turn.threadTs
            : turn.sessionThreadTs ?? turn.threadTs,
          conversationKind: slackConversationKind(turn),
          slackUserId: turn.userId,
          eventId: turn.eventId,
          messageTs: turn.messageTs,
          turnJobId,
          requesterText: turn.text,
        } as const;
        const actor = await resolveSlackManagementActor(signal, dependencies.identity);
        acknowledge = await verifyMemoryUpdateAcknowledgement({
          hint: agentResult.memoryUpdate,
          agentId: assignment.agent.id,
          turnJobId,
          getOperation: (operationId) => dependencies.service.getOperation(actor, operationId),
          validateReceiptLease: preparedMemory.validateReceiptLease,
        });
      } catch {
        // Unavailable receipts or revoked actors retain the ordinary lease check.
      }
      if (acknowledge) {
        await preparedMemory.confirmInjection();
        await statusTurn.prepareFinal();
        await presenter.deliverFinal('Updated this Agent’s saved memory.', 'plain_text', 'complete');
        await finishStatus('answer');
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
    if (preparedMemory?.ownerBound && !leaseValid && !recoveredText) {
      await statusTurn.prepareFinal();
      await presenter.deliverFinal(AGENT_FAILURE_TEXT, 'plain_text', 'error');
      await finishStatus('failure');
      await finishDelivery('failed');
      return;
    }
    text = resolveMemoryDeliveryText(
      text,
      recoveredText,
      leaseValid,
    );
    if (installationContext) {
      text = renderSlackSelfMention(text, installationContext.botUserId);
    }
    const terminalResult = options.replayTerminalResult ?? 'answer';
    await statusTurn.prepareFinal();
    await presenter.deliverFinal(
      text,
      'markdown',
      terminalResult === 'failure' ? 'error' : 'complete',
      tablePresentation,
    );
    // Clear after the final reaches Slack. A custom Agent persona does not
    // reliably trigger Slack's automatic app-status cleanup, and clearing
    // before delivery can leave the custom status visible after the reply.
    await finishStatus(terminalResult);
    await finishDelivery(
      options.replayText === undefined
        ? terminalResult === 'failure' ? 'failed' : 'succeeded'
        : undefined,
    );
  } catch (err) {
    if (!(err instanceof AgentPromptFailure && err.retryable)) {
      await usageRecorder?.recordFailure();
    }
    throw err;
  } finally {
    // A V3 retry/recovery attempt keeps its acknowledged activity visible.
    // Legacy presentations retain their prior best-effort finally cleanup.
    try {
      if (!terminalStatusFinished) {
        if (frozenPresentation?.schemaVersion === 3) {
          statusTurn.close();
        } else {
          await statusTurn.finish(async () => { await presenter.clearStatus(); });
        }
      }
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
    modelLabel: resolvedAssignmentModel(assignment),
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
    requesterMembershipId: input.turn.actorMembershipId ?? null,
    executionPrincipalId: input.assignment.agentId,
    ...(input.assignment.modelAttribution
      ? { modelAttribution: input.assignment.modelAttribution }
      : {}),
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
  configStore?: ReturnType<typeof getConfigStore>;
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
        config: input.configStore ?? getConfigStore(input.platformEnv),
        workspaceId: input.turn.workspaceId,
        agentId: input.assignment.agentId,
        actorMembershipId: input.turn.actorMembershipId,
      }
    : undefined;
  const connectionContext = actorConnectionContext
    ? await resolveConnectionAccountContext(actorConnectionContext)
    : undefined;
  const allEffectiveConnections = connectionContext?.effective ?? [];
  const connectionAuthorizations = connectionContext?.authorizations;
  const connectionResolution = selectConnectionsForRequest({
    connections: allEffectiveConnections,
    requestText: input.turn.text,
  });
  const canonicalModel = resolvedAssignmentModel(input.assignment);
  if (!canonicalModel) {
    throw new Error('Runtime plan compilation requires a frozen model.');
  }
  const runtimeModel = await resolveRuntimeModel(
    input.assignment.agentId,
    canonicalModel,
    {
      settings: input.settingsStore ?? getSettingsStore(input.platformEnv),
      ...(input.platformEnv ? { env: input.platformEnv } : {}),
    },
  );
  const runtimeModelRoute = freezeRuntimeModelRoute(
    canonicalModel,
    runtimeModel.providerAuthRoute,
  );
  const candidate = compileRuntimePlanV2({
    turn: input.turn,
    assignment: input.assignment,
    runtimeModel: runtimeModel.model,
    ...(runtimeModelRoute ? { runtimeModelRoute } : {}),
    instructions,
    memoryEpoch: input.memoryEpoch,
    sandboxMode: sandboxDecision.selection,
    effectiveConnections: connectionResolution.selected,
    ...(connectionAuthorizations ? { connectionAuthorizations } : {}),
    connectionChoices: connectionResolution.ambiguous,
  });
  const decision = input.persist
    ? await input.persist(candidate)
      : {
        runtimePlan: candidate,
        instanceId: deriveRuntimePlanInstanceId(candidate),
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

const MEMORY_CHANGED_RETRY_TEXT =
  'Agent memory or Slack access changed while I was answering, so I withheld the draft. Before trying again, check whether any requested external action already completed.';

function resolveMemoryDeliveryText(
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
  onPublicMessageDelivered?: RunTurnOptions['onPublicMessageDelivered'],
): Promise<void> {
  const resolvedModel = resolvedAssignmentModel(assignment);
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
  }, undefined, {
    ...(onPublicMessageDelivered
      ? { onPublicDelivery: onPublicMessageDelivered }
      : {}),
  });
  await presenter.deliverFinal(AGENT_FAILURE_TEXT, 'plain_text');
}

function resolvedAssignmentModel(assignment: ResolvedAssignment): string | undefined {
  if (assignment.model) return assignment.model;
  if (assignment.runtimeContract === 'chickpea-v1') return undefined;
  return tryResolveAgentModel(assignment.agent);
}

function tryResolveAgentModel(agent: Parameters<typeof resolveAgentModel>[0]): string | undefined {
  try {
    return resolveAgentModel(agent);
  } catch {
    return undefined;
  }
}

function applyVisibilityBarrier(
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
