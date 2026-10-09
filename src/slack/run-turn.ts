import { planAllowsConnectionFileUpload } from '../connections/file-upload-tool.ts';
import { conversationThreadImageInventory } from './thread-images.ts';
import { verifyMemoryUpdateAcknowledgement } from './memory-update-terminal.ts';
import { WebClient } from '@slack/web-api';

import {
  compileRuntimePlanV2,
  deriveRuntimePlanInstanceId,
  frozenModelCredential,
  type RuntimePlanCodingModelV1,
  type RuntimePlanV2,
} from '../agents/runtime-plan.ts';
import { agentTeammateHandles } from '../config/effective-config.ts';
import { slackTenantInstructions } from '../agents/shared-prefix.ts';
import { CHICKPEA_AGENT_NAME } from '../config/agent-id.ts';
import {
  codingOnAgentModel,
  imageCapabilityForResolution,
  resolveAgentModel,
  resolveAgentModelRoleFromStore,
  resolveCodingModelForPlan,
  type CodingModelAgentRoute,
  type ModelRoleReader,
} from '../config/model-policy.ts';
import { getGithubConnection } from '../config/github-app.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { resolveSandboxSettings } from '../config/sandbox-settings.ts';
import {
  getConfigStore,
  getIdentityStore,
  getManagementStore,
  getSettingsStore,
  getSlackStateStore,
  getUsageStore,
  getWorkStore,
  type AppStores,
} from '../config/state-backend.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  abandonTurnSurfaces,
  deliverHostApprovalSurfaces,
  deliverInteractiveSurfaces,
  markDisplaySurfacesDelivered,
  prepareDisplaySurfaces,
  renderDisplayComponents,
} from './ui/host-surfaces.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { installationRefusesWork } from '../config/installation-admission.ts';
import {
  deploymentServesManyInstallations,
  InstallationContextError,
  installationOwnershipOf,
} from '../config/installation-scope.ts';
import { resolveModelCredentialAttribution } from '../config/model-credential-refs.ts';
import type { TurnEnvelopeV1 } from '../agents/turn-envelope.ts';
import { buildTurnEnvelope } from './turn-envelope-builder.ts';
import { browserCapabilityForTurn, websiteLoginsForTurn } from '../browser/capability.ts';
import type {
  SlackInteractionProgress,
  SlackInteractionProgressPatch,
} from '../config/state-rpc.ts';
import type { ModelCredentialAttribution, ResolvedAssignment } from '../config/types.ts';
import {
  freezeRuntimeModelRoute,
  resolveProviderAuthRoute,
  resolveRuntimeModel,
  RuntimeModelReadinessError,
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
import { replyFooterModelLabel } from './message-format.ts';
import { isSandboxDisconnect } from '../sandbox/reconnect.ts';
import { isStateStoreDisconnect } from '../config/cf-state-proxies.ts';
import {
  agentFailureText,
  AgentObservationYield,
  AgentRunAborted,
  StateStoreUnavailable,
  AgentPromptFailure,
  promptSlackThreadAgent,
  type AgentDispatchResult,
  type SlackFlueDispatchState,
} from './flue-dispatch.ts';
import { resolveSlackCredentials, resolveSlackPublicUrl } from './credentials.ts';
import { agentAvatarInstallation, agentAvatarUrlForPresentation } from './agent-presence/avatar-assets.ts';
import type { SlackStatusUpdate } from './replies.ts';
import { activityStatus, initialActivityStatus } from '../activity/status.ts';
import { abandonTerminalSlackPresentationBestEffort } from './presentation-repair.ts';
import { defaultSlackStatusRegistry, type SlackStatusRegistry } from './status-registry.ts';
import { createCodingTaskProgress } from './coding-task-progress.ts';
import { creditsExhaustedComponents } from './credits-ask.ts';
import {
  creditBackFailedRun,
  creditBackReason,
  hostedRun,
  planFunding,
  withCreditedBack,
  type SlackFailureKind,
} from '../usage/run-settlement.ts';
import { currentMessageOnlyContext } from './thread-context.ts';
import { collectAdmittedSlackListIds } from './lists/admission.ts';
import { conversationThreadTs, slackAgentContinuityKey, slackAgentThreadKey, slackConversationKind } from './thread-key.ts';
import { slackTimestampMs } from './timestamp.ts';
import {
  assembleRetainedSlackContext, formatSlackPublicHandoff, type SlackPublicDelivery,
} from './public-context.ts';
import type { NormalizedSlackTurn } from './types.ts';
import {
  isAgentAskSilentReply,
  isHandedBackTurn,
  isLaterCoAddressedTurn,
  personRequestText,
} from './agent-asks.ts';
import {
  effectiveTurnSlackInstallationId,
  resolveSlackInstallationExecutionContext,
  SlackInstallationUnavailableError,
  type SlackInstallationExecutionContext,
} from './installation-execution.ts';
import type {
  FlueSettlementCheckpointV1,
  FrozenRuntimePlanDecision,
  SlackThreadContinuation,
  TurnPreviousStop,
} from './turn-job-types.ts';
import { slackContextSinceWatermark, threadContinuityNote } from './thread-continuity.ts';
import { hydrateTurnSlackContext } from './turn-context-reads.ts';
import { createSlackReadGate, sharesSlackAppReadBudget } from './read-budget.ts';
import { resolveSlackContextNames } from './context-names.ts';
import type { FlueDispatchReceiptV1 } from './turn-job-types.ts';
import type { SlackProgressiveReadRelay } from './progressive-relay.ts';
import {
  TurnLatencyTracker,
  type TurnFirstWrite,
  type TurnLatencyContext,
} from '../observability/runtime-latency.ts';
import {
  decideProgressiveEligibility,
  type ProgressiveEligibilityDecision,
} from './progressive-eligibility.ts';
import {
  progressiveStreamingModeForReason,
  type SlackPresentationOwner,
} from './run-presentations.ts';
import { slackProgressiveStreamingEnabled } from './progressive-ops-flag.ts';
import { slackSemanticActivityStatusEnabled } from './semantic-status-flag.ts';
import {
  resolveCodingWorkspaceCapability,
  sandboxBindingInstalled,
  type CodingWorkspaceCapabilityDecision,
} from '../sandbox/select.ts';
import {
  assembleSlackPrompt,
  renderSlackSelfMention,
} from './web-client-context.ts';
import {
  AGENT_FAILURE_TEXT,
  SANDBOX_UNAVAILABLE_FALLBACK_NOTICE,
  WebClientPresenter,
  type SlackDeliveryObserver,
  slackDeliveryFailureOutcome,
  slackStopNoteText,
  type SlackReactionReceipt,
  type SlackStopNoteFacts,
} from './web-client-presenter.ts';
import type { SlackTablePresentation } from './table-presentation.ts';
import type { SlackArtifactReceipt } from './artifact-receipts.ts';
import {
  InteractiveUsageRecorder,
  InteractionUsageRecorder,
  interactionReportedUsage,
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
  AGENT_VIEW_STREAM_AGE_CHECK_MS,
  SlackAgentViewPresentation,
  type SlackPresentationStatePort,
} from './agent-view-presentation.ts';
import { createSlackWebClient } from './web-client.ts';
import {
  resolveConnectionAccountContext,
  selectConnectionsForRequest,
} from '../connections/runtime.ts';
import { createLiveWorkspaceManagementService } from '../management/live-service.ts';
import {
  executeHostSlackManagementApproval,
  type SlackManagementApprovalDependencies,
  type SlackManagementApprovalInvoke,
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
  beforeDelivery?: (input?: {
    /** Whether the Agent opened a coding workspace; undefined when unknown. */
    codingWorkspaceOpened?: boolean;
  }) => Promise<string | undefined>;
  /**
   * Persist terminal delivery before post-delivery workspace teardown begins.
   * `stopped`: the stopped ending delivered its stop note (KTD3).
   */
  onDelivered?: (outcome?: 'succeeded' | 'no_op' | 'failed' | 'stopped') => void | Promise<void>;
  /**
   * The stopped ending of a turn a person stopped (KTD3). An aborted
   * settlement ends with it instead of the failure text or a replayed
   * pull-request answer; with `beforeDispatch`, the turn never dispatched and
   * ends with it at once, with no classification, memory, plan or model call.
   */
  stopEnding?: SlackStopEnding;
  /** The thread's previous run was stopped: the prompt says so, and by whom. */
  previousStop?: Pick<TurnPreviousStop, 'stopperUserId'>;
  /** A durable outbox now owns the terminal; keep the TurnJob open until it settles. */
  onDeferredTerminal?: () => void | Promise<void>;
  /** Record a confirmed Slack-visible final for future owner handoffs. */
  onPublicMessageDelivered?: (input: SlackPublicDelivery) => void | Promise<void>;
  /** Stable ID for one actual model invocation; persistence retries reuse it. */
  usageExecutionId?: string;
  /** Observational canonical Run correlation; legacy remains authoritative. */
  runId?: string;
  /** Durable relay attempt used as the canonical RunExecution fence. */
  runAttempt?: number;
  /**
   * Ends observation of an already-dispatched reply without settling it. The
   * turn then rejects with AgentObservationYield, leaving its receipt, active
   * work, acknowledgment, and workspace turn for the reattaching attempt.
   */
  observationSignal?: AbortSignal;
  /** The durable receipt exists and this attempt is now only observing. */
  onObservationStarted?: () => void;
  /** Explicit lease fence for a ledger-authoritative attempt. */
  runFencingToken?: number;
  /** Immutable authority selected at admission. Missing means legacy. */
  executionAuthority?: RunExecutionAuthority;
  /** Opaque Flue continuity identity, independent of Slack/memory coordinates. */
  continuityKey?: string;
  /** First-write-wins decision restored from a prior durable attempt. */
  runtimePlanDecision?: FrozenRuntimePlanDecision;
  /** Trusted routing context from the bound, previously dispatched TurnJob. */
  getBoundRuntimePlan?: (
    continuityKey: string,
    beforeMessageTs: string,
    actorMembershipId: string,
    agentId: string,
  ) => RuntimePlanV2 | undefined | Promise<RuntimePlanV2 | undefined>;
  /**
   * The thread instance's previous admitted turn, when this turn continues its
   * transcript: its prompt then carries only newer Slack rows.
   */
  getThreadContinuation?: (
    continuityKey: string,
    instanceId: string,
    beforeMessageTs: string,
  ) => SlackThreadContinuation | undefined | Promise<SlackThreadContinuation | undefined>;
  /** Persist the first complete plan before the agent dispatch boundary. */
  onRuntimePlan?: (
    candidate: RuntimePlanV2,
  ) => FrozenRuntimePlanDecision | Promise<FrozenRuntimePlanDecision>;
  /** Local override avoids a Durable Object calling its own Work RPC. */
  workStore?: WorkStore;
  /** Local override avoids a Durable Object calling its own settings RPC. */
  settingsStore?: SettingsStore;
  /**
   * The public URL the executor already resolved (null: none is configured),
   * so the turn does not read it again. Absent, the turn resolves it.
   */
  publicUrl?: string | null;
  /** Local override avoids a Durable Object calling its own Usage RPC. */
  usageStore?: UsageStore;
  /** Local state ports when the turn already runs inside their owning DO. */
  appStores?: AppStores;
  /** Lazily resolved local management runtime when the turn runs inside its owning DO. */
  managementApproval?: SlackManagementApprovalDependencies |
    (() => SlackManagementApprovalDependencies);
  /**
   * Applies an approved proposal in the state owner over one RPC. A thread
   * runner supplies this instead of `managementApproval`: it holds no local
   * management runtime, and the state store stays the only management writer.
   */
  invokeManagementApproval?: SlackManagementApprovalInvoke;
  /** Test/rollout override; otherwise USAGE_RUNTIME_RECORDING controls capture. */
  usageRecordingEnabled?: boolean;
  /** Test override, bounded to the product's 250 ms maximum. */
  usageWriteBudgetMs?: number;
  /** Durable turn-job denominator hook for persistence coverage. */
  onUsagePersistence?: (event: UsagePersistenceEvent) => void;
  /** Persist the first validated explicit-turn decision before Slack effects. */
  onInteractionIntent?: (intent: SlackInteractionIntent) => void | Promise<void>;
  /**
   * The Agent delegated its first coding task this response (`workspace_task`).
   * Such a turn can run far longer than an ordinary one.
   */
  onCodingTaskStarted?: () => void | Promise<void>;
  /**
   * An earlier attempt of this turn already delegated a coding task, so a
   * reattached observation may start from the quiet-worker poll cadence.
   */
  codingTaskStarted?: boolean;
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
  /**
   * Where the turn registers its live Slack status, so observed activity for
   * it can be routed there. Defaults to this isolate's registry.
   */
  statusRegistry?: SlackStatusRegistry;
  /**
   * Relay context for the content-free `turn_latency` log. Present only when a
   * durable relay runs the turn; absent emits nothing.
   */
  turnLatency?: TurnLatencyContext;
  /** Set by `runTurn` itself when `turnLatency` is present. */
  onSlackWrite?: (surface: TurnFirstWrite) => void;
}

/** How a stopped turn ends (see RunTurnOptions.stopEnding). */
export interface SlackStopEnding {
  /** The stopped turn never dispatched: nothing ran, so it ends at once. */
  beforeDispatch?: boolean;
  /**
   * Ends the stop in the state store, dropping and counting the rows it
   * held, before any Slack delivery, and returns what the stop note says.
   * Undefined when the turn carries no stop: an aborted settlement is then
   * an ordinary Agent failure. Repeatable: a replay reads the first ending.
   */
  finish(): Promise<SlackStopNoteFacts | undefined>;
  /**
   * An earlier attempt admitted this turn's usage operation before the stop
   * refused its dispatch; `beforeDispatch` then records it interrupted.
   */
  usageAdmitted?: boolean;
}

export const WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT =
  'The Workspace default model needs attention. An owner or admin can repair it in Settings → Model providers.';

/**
 * The reply for a turn whose model cannot run until someone repairs Model
 * providers: its provider has no key, or the deployment does not offer the
 * model. Only a model inherited from the Workspace default has a reply, and
 * it matches Admin's "Repair required"; a pinned model's turn, and a provider
 * that could not be checked just now, keep the generic failure.
 */
function modelRepairReplyText(error: unknown, assignment: ResolvedAssignment): string | undefined {
  if (!(error instanceof RuntimeModelReadinessError) || error.transient) return undefined;
  return assignment.modelAttribution?.source === 'workspace_default'
    ? WORKSPACE_DEFAULT_MODEL_REPAIR_TEXT
    : undefined;
}

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
 *
 * With `options.turnLatency`, each attempt also emits one `turn_latency` log
 * (admission to first acknowledged Slack write and to final) when it returns
 * or throws. Logging never changes the outcome.
 */
export async function runTurn(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  platformEnv: PlatformEnv | undefined,
  options: RunTurnOptions = {},
): Promise<void> {
  if (!options.turnLatency) return runTurnAttempt(turn, assignment, platformEnv, options);
  const tracker = new TurnLatencyTracker(options.turnLatency, {
    ...(options.turnId ? { turnJobId: options.turnId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.runAttempt === undefined ? {} : { attempt: options.runAttempt }),
  });
  const { onDelivered, onDeferredTerminal } = options;
  let stopped = false;
  try {
    await runTurnAttempt(turn, assignment, platformEnv, {
      ...options,
      onSlackWrite: (surface) => tracker.markSlackWrite(surface),
      onDelivered: async (outcome) => {
        tracker.markFinal('delivered');
        if (outcome === 'stopped') stopped = true;
        await onDelivered?.(outcome);
      },
      ...(onDeferredTerminal
        ? {
            onDeferredTerminal: async () => {
              tracker.markFinal('deferred');
              await onDeferredTerminal();
            },
          }
        : {}),
    });
    tracker.emit(stopped ? 'stopped' : 'returned');
  } catch (error) {
    tracker.emit('threw');
    throw error;
  }
}

async function runTurnAttempt(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  platformEnv: PlatformEnv | undefined,
  options: RunTurnOptions,
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
  const sharedAppReads = installationContext
    ? installationContext.sharedAppReads
    : sharesSlackAppReadBudget({ env: platformEnv, client });
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
  // Independent reads: in a thread runner the presentation is local and the
  // public URL comes from the runner's `begin` round trip.
  const [publicUrl, frozenPresentation] = await Promise.all([
    options.publicUrl !== undefined
      ? options.publicUrl ?? undefined
      : resolveSlackPublicUrl(platformEnv, settingsStore),
    options.presentationState && options.runId
      ? options.presentationState.getRunPresentation(options.runId)
      : undefined,
  ]);
  const agentAvatarUrl = agentAvatarUrlForPresentation(
    assignment.agent, publicUrl, agentAvatarInstallation(platformEnv),
  );
  const visibleOwner: SlackPresentationOwner | undefined =
    frozenPresentation?.schemaVersion === 3 ? frozenPresentation.owner : undefined;
  // The Agent's model until the reply shows a coding worker ran; then the
  // label also names the coding model (see `codingModel` below).
  const footerModelLabel = replyFooterModelLabel({
    agentModel: resolvedModel,
    codingWorkerRan: false,
  });
  const {
    agentName: visibleAgentName,
    agentAvatarUrl: visibleAgentAvatarUrl,
  } = turnReplySender(assignment, visibleOwner, agentAvatarUrl);
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
      modelRepair: true,
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
  // An ask's text is the asking Agent's message: only a person's message can
  // be a memory or schedule command. Admission refuses those for an ask too
  // (typedByPerson in processSlackEvent); this is the runtime's own gate. A
  // message that mentioned several Agents is one command, for the first.
  const typedByPerson = !turn.agentAsk && !isLaterCoAddressedTurn(turn);
  // The thread's own Agent, handed a teammate's answer: it may end the turn
  // silently, so its reply never streams before it is known.
  const handedBack = isHandedBackTurn(turn, assignment);
  if (typedByPerson && shouldHandleRoutineCommandTurn(turn, commandAddress)) {
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
  const memoryCommand = typedByPerson ? parseMemoryCommand(turn.text) : undefined;
  const deterministicCommand = Boolean(memoryCommand) ||
    Boolean(turn.managementApprovalProposalId) ||
    (typedByPerson && isRoutineSlackTurn(turn) && Boolean(parseRoutineCommand(turn.text, commandAddress)));
  // Delivery-only recovery replays the exact persisted answer. It must not
  // re-resolve current Agent memory (which could both block recovery
  // on a changed lease and unnecessarily touch live state).
  // A stopped turn that never dispatched ends without reading anything more,
  // and a replayed abort delivers only its stop note: neither needs memory.
  const stoppedBeforeDispatch = options.stopEnding?.beforeDispatch === true;
  const abortedReplay = options.stopEnding !== undefined &&
    options.flueDispatch?.flueSettlement?.outcome === 'aborted';
  const skipMemory = Boolean(memoryCommand) || Boolean(turn.managementApprovalProposalId) ||
    options.replayText !== undefined || stoppedBeforeDispatch || abortedReplay;
  let onNativeStarted = async (): Promise<void> => {};
  // A reply mentions its teammates live; each mention asks that Agent.
  const liveAgentHandles = agentTeammateHandles(assignment);
  const agentViewPresentation = options.presentationState && options.runId
    ? new SlackAgentViewPresentation({
        client,
        ...(liveAgentHandles ? { liveAgentHandles } : {}),
        state: options.presentationState,
        readGate: createSlackReadGate({
          state: options.appStores?.slackState ?? getSlackStateStore(platformEnv),
          workspaceId: turn.workspaceId,
          gated: sharedAppReads,
        }),
        runId: options.runId,
        runFencingToken: options.runFencingToken ?? 0,
        footer: {
          agentName: visibleAgentName,
          ...(footerModelLabel === undefined ? {} : { modelLabel: footerModelLabel }),
          agentId: assignment.agent.id,
          ...(publicUrl ? { publicUrl } : {}),
          // Set once the turn's memory is prepared, before any delivery.
          memoryItems: undefined,
        },
        onNativeStarted: () => onNativeStarted(),
        ...(options.onSlackWrite
          ? { onStreamStarted: () => options.onSlackWrite?.('stream') }
          : {}),
      })
    : undefined;
  // A delegated coding task's progress shows in the working indicator.
  const codingProgress = createCodingTaskProgress();
  // The Work lifecycle is created after the first status (it reads the state
  // store); the presenter reaches it only when it delivers, which is later.
  let deliveryLifecycle: ShadowWorkLifecycle | undefined;
  /** The stopped ending is delivering its note: the Run settles cancelled. */
  let stoppedEnding = false;
  /** The turn is taking the stopped ending: whatever interrupts it is retried, never a failure. */
  let stopping = false;
  const deliveryObserver: SlackDeliveryObserver = {
    beforeDelivery: async (input) => deliveryLifecycle?.beforeDelivery(input),
    afterDelivery: async (input) => {
      await deliveryLifecycle?.afterDelivery(
        stoppedEnding && input.outcome === 'delivered'
          ? { ...input, terminalDisposition: 'cancelled' }
          : input,
      );
    },
  };
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
  }, deliveryObserver, {
    deliverySafety: ledgerAuthority ? 'ledger' : 'legacy',
    statusDisplay: (update) => codingProgress.display(update),
    ...(liveAgentHandles ? { liveAgentHandles } : {}),
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
  const statusGeneration = options.turnId ?? `msg:${turn.channelId}:${turn.messageTs}`;
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
  // Slack shows a custom assistant status only while the Agent Session is not
  // in native `processing`; the native indicator otherwise takes precedence.
  // A non-empty assistant status itself moves the session to processing, so
  // the custom status carries the session once it shows. Slack's native stop
  // control is absent while custom text shows, so a run that goes quiet (no
  // progress for five minutes) shows native processing again
  // (`showNativeIndicator`), and its next progress hands over again. Settle
  // below stays on agents.sessions.
  const semanticStatusCarriesSession = () => semanticActivityEnabled &&
    presenter.preferredActivitySurface() === 'assistant_status' &&
    !presenter.activityReceipt().unavailable;
  /** Native processing shows and has not yet been handed to the custom status. */
  let nativeHeld = false;
  /** Native processing was handed to the custom status. */
  let nativeReleased = false;
  /**
   * The turn's status registration: while native processing is held, it
   * sends it again before Slack's hour runs out, and it stops at the
   * terminal (KTD6).
   */
  let nativeKeepalive: ReturnType<SlackStatusRegistry['registerTurn']> | undefined;
  // Turn start (in `beginVisibleWork`): Slack's native indicator first, the
  // fast write (about 0.4 s, against about 2 s for the custom status and its
  // bookkeeping); the custom status then replaces it (see
  // `handOverToCustomStatus`). A retry whose custom status is known visible
  // already carries the session and starts nothing: a native start would hide
  // that text. Otherwise the native start is made at most once per attempt:
  // one that fails is not retried, and the custom status (or its settle) is
  // what the turn shows instead.
  const startNativeIndicator = async (): Promise<void> => {
    if (admittedVisibleStatus !== undefined || !agentViewPresentation) return;
    // True also for a retry whose earlier attempt started native processing
    // and stopped before its custom write, so that write hands over too. A
    // start whose outcome is unknown returns false: its custom writes do not
    // hand over, and may stay hidden until the turn settles (cosmetic).
    nativeHeld = await agentViewPresentation.beginAgentSessionProcessing();
    if (nativeHeld) options.onSlackWrite?.('agent_session');
  };
  /**
   * Hand the working indicator from native `processing` to the custom status
   * about to be written. Slack acknowledges a custom status written while the
   * session is in native processing but does not render it (seen live on
   * Violet, #198), so the session leaves native processing first; the custom
   * status then moves it back to processing, carried by the custom text.
   * Runs before each native-surface custom write made while native shows.
   */
  const handOverToCustomStatus = async (): Promise<void> => {
    if (!nativeHeld || !agentViewPresentation) return;
    // A keepalive in flight lands first, so the release is Slack's last word.
    await nativeKeepalive?.releaseNative();
    nativeHeld = false;
    nativeReleased = await agentViewPresentation.releaseNativeProcessing();
  };
  // Nothing custom is (or can be) visible after a hand-over: show Slack's
  // native indicator again. The next custom write hands over again.
  const beginNativeSessionFallback = async (): Promise<void> => {
    if (!nativeReleased || !agentViewPresentation) return;
    nativeReleased = false;
    if (await agentViewPresentation.reassertNativeProcessing()) {
      nativeHeld = true;
      nativeKeepalive?.holdNative(true);
      options.onSlackWrite?.('agent_session');
    }
  };
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
      if (activityWrite?.surface === 'assistant_status' && semanticStatusCarriesSession()) {
        await handOverToCustomStatus();
      }
      const succeeded = await presenter.setStatus(update, activityWrite);
      if (succeeded) options.onSlackWrite?.('activity_status');
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
      // Nothing custom is (or can be) visible: show Slack's native indicator.
      if (!succeeded && (!semanticStatusCarriesSession() ||
          !presenter.assistantStatusVisible())) {
        await beginNativeSessionFallback();
      }
      return succeeded;
    },
    refreshRetryable(): boolean {
      // A failed reservation or refresh preparation leaves the shown status
      // valid; a latched Slack rejection does not.
      return semanticStatusCarriesSession() && presenter.assistantStatusVisible();
    },
    async refreshStatus(update: SlackStatusUpdate): Promise<boolean> {
      if (!semanticActivityEnabled) return false;
      // Without a V3 activity record there is nothing to validate against:
      // reassert the phrase exactly as a fresh write would.
      let succeeded: boolean;
      // A refresh that brings the phrase back after a quiet stretch hands
      // over from native processing first, like any custom write.
      let handedOver = false;
      if (frozenPresentation?.schemaVersion !== 3) {
        handedOver = nativeHeld && semanticStatusCarriesSession();
        if (handedOver) await handOverToCustomStatus();
        succeeded = await presenter.setStatus(update);
      } else {
        if (!agentViewPresentation) return false;
        const durable = await agentViewPresentation.prepareActivityRefresh(update);
        if (!durable) return false;
        handedOver = nativeHeld && semanticStatusCarriesSession();
        if (handedOver) await handOverToCustomStatus();
        succeeded = await presenter.setStatus(update, durable);
      }
      if (succeeded) options.onSlackWrite?.('activity_status');
      // The quiet stretch let the custom status lapse: show native again.
      else if (handedOver) await beginNativeSessionFallback();
      return succeeded;
    },
    /**
     * The run went quiet: the status registry stopped refreshing the custom
     * status, so show Slack's native indicator, which carries the Stop
     * button. The next custom write hands over again (`handOverToCustomStatus`).
     */
    async showNativeIndicator(): Promise<boolean> {
      if (nativeHeld) return true;
      if (!agentViewPresentation || !(await agentViewPresentation.reassertNativeProcessing())) {
        return false;
      }
      nativeHeld = true;
      nativeReleased = false;
      nativeKeepalive?.holdNative(true);
      options.onSlackWrite?.('agent_session');
      return true;
    },
    /**
     * Native processing shows: send it again before Slack drops the session
     * (and its Stop button) at the hour (KTD6). It stays held, so the next
     * custom write releases it first (`handOverToCustomStatus`).
     */
    async keepNativeIndicator(): Promise<boolean> {
      if (!nativeHeld || !agentViewPresentation) return false;
      if (!(await agentViewPresentation.reassertNativeProcessing())) return false;
      nativeHeld = true;
      nativeReleased = false;
      options.onSlackWrite?.('agent_session');
      return true;
    },
  };
  const statusRegistry = options.statusRegistry ?? defaultSlackStatusRegistry;
  let admissionStatusAttempted = false;
  /**
   * The turn's first Slack writes, which need only the client and the frozen
   * presentation: the native indicator, then the admitted pending activity as
   * the custom status, which takes over from it (the hand-over runs inside
   * that custom write).
   */
  const registerStatusTurn = (statusInstanceId: string) => {
    const registration = statusRegistry.registerTurn(statusInstanceId, activityPresenter, {
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
            // A stopped turn ends at once: nothing is refreshed, only cleared.
            ...(admittedVisibleStatus && !stoppedBeforeDispatch ? { refreshInitialStatus: true } : {}),
          }
        : {}),
    });
    nativeKeepalive = registration;
    return registration;
  };
  const beginVisibleWork = async (statusInstanceId: string) => {
    await startNativeIndicator();
    const registered = registerStatusTurn(statusInstanceId);
    // Native processing shows from the start (sent now, or by an earlier
    // attempt): keep it alive until a custom status takes over.
    if (nativeHeld) registered.holdNative(false);
    if (frozenPresentation?.schemaVersion === 3 &&
        frozenPresentation.currentActivity?.operation.certainty === 'pending') {
      admissionStatusAttempted = true;
      const admitted = frozenPresentation.currentActivity;
      await registered.setStatus(activityStatus(
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
    return registered;
  };
  // A frozen V3 presentation shows its admitted activity before the turn
  // reads anything else (classification, memory, plan, Work lifecycle): in a
  // thread runner each of those is a round trip to the state store. What it
  // shows is the admission's own pending activity, whatever the turn decides
  // later. Observed activity is routed by the Agent instance, known once the
  // plan is frozen; nothing is observed before dispatch.
  // A stopped turn that never dispatched shows nothing new: its status turn
  // only lets the stopped ending clear what an earlier attempt showed.
  const earlyStatusInstanceId = options.runtimePlanDecision?.instanceId ??
    options.continuityKey ??
    slackAgentThreadKey(turn, assignment);
  const earlyStatusTurn = frozenPresentation?.schemaVersion !== 3
    ? undefined
    : stoppedBeforeDispatch
      ? registerStatusTurn(earlyStatusInstanceId)
      : await beginVisibleWork(earlyStatusInstanceId);
  let interactionIntent = turn.interactionIntent;
  // Classification and the memory → plan → Work lifecycle chain read
  // independent state; each chain keeps its own writes in order.
  const classifyTurn = async (): Promise<void> => {
    if (deterministicCommand || interactionIntent || stoppedBeforeDispatch) return;
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
  };
  const prepareTurn = async () => {
    const memory = skipMemory
      ? undefined
      : prepareMemoryTurn({
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
    // The plan's reads do not need the memory; only its compilation does.
    // `Promise.all` below reports a memory failure; the epoch derived from it
    // is only awaited once the plan's reads finish, so mark it handled here or
    // an early memory rejection would be unhandled meanwhile. If the freeze
    // fails first, memory preparation finishes in the background unused:
    // harmless, because nothing is persisted without the epoch.
    const memoryEpoch = memory?.then((value) => value.memoryEpoch);
    memoryEpoch?.catch(() => undefined);
    const [preparedMemory, frozen] = await Promise.all([
      memory,
      !options.runtimePlanDecision && memoryEpoch && resolvedModel
        ? freezeRuntimePlanForTurn({
            turn,
            assignment,
            platformEnv,
            memoryEpoch,
            ...(settingsStore ? { settingsStore } : {}),
            ...(options.appStores?.config ? { configStore: options.appStores.config } : {}),
            ...(options.onRuntimePlan ? { persist: options.onRuntimePlan } : {}),
            ...(options.getBoundRuntimePlan
              ? { getBoundRuntimePlan: options.getBoundRuntimePlan }
              : {}),
          }).catch((error: unknown) => {
            // A model that needs repair ends the turn with its reply, below;
            // a retry could not change that.
            const modelRepairText = modelRepairReplyText(error, assignment);
            if (modelRepairText === undefined) throw error;
            return { modelRepairText };
          })
        : undefined,
    ]);
    const conversationKey = preparedMemory?.conversationKey ?? slackAgentThreadKey(turn, assignment);
    const agentConversationKey = options.continuityKey ?? conversationKey;
    if (frozen && 'modelRepairText' in frozen) {
      return {
        preparedMemory,
        conversationKey,
        agentConversationKey,
        runtimePlanDecision: undefined,
        sandboxUnavailableFallback: false,
        workLifecycle: undefined,
        modelRepairText: frozen.modelRepairText,
      };
    }
    const runtimePlanDecision = frozen?.decision ?? options.runtimePlanDecision;
    const sandboxUnavailableFallback = frozen?.unavailableFallback ?? false;
    const workLifecycle = options.runId && options.replayText === undefined && resolvedModel &&
        !stoppedBeforeDispatch
      ? await createSlackShadowLifecycle({
          runId: options.runId,
          attemptNumber: options.runAttempt ?? 1,
          ...(options.runFencingToken === undefined
            ? {}
            : { fencingToken: options.runFencingToken }),
          assignment,
          canonicalModel: resolvedModel,
          // Only a frozen plan names a Flue instance, and only its recording
          // store freezes one. A turn without one (an approval, a memory
          // command) runs in the host and references none: a reference
          // made up from its thread key would name an object that never
          // existed, which a census counts as residue it cannot erase.
          ...(runtimePlanDecision
            ? { flueInstanceRef: opaqueId('flueinstance', runtimePlanDecision.instanceId) }
            : {}),
          platformEnv,
          ...(options.workStore ? { workStore: options.workStore } : {}),
          ...(settingsStore ? { settingsStore } : {}),
          mode: ledgerAuthority ? 'enforce' : 'observe',
          resumeSettled: !ledgerAuthority && options.flueDispatch?.flueSettlement !== undefined,
        })
      : undefined;
    return {
      preparedMemory,
      conversationKey,
      agentConversationKey,
      runtimePlanDecision,
      sandboxUnavailableFallback,
      workLifecycle,
      modelRepairText: undefined,
    };
  };
  let prepared: Awaited<ReturnType<typeof prepareTurn>>;
  try {
    const [classified, preparation] = await Promise.allSettled([classifyTurn(), prepareTurn()]);
    if (classified.status === 'rejected') throw classified.reason;
    if (preparation.status === 'rejected') throw preparation.reason;
    prepared = preparation.value;
  } catch (error) {
    // Only the status turn is open yet. Like any failed V3 attempt, it keeps
    // the admitted activity visible for the next attempt.
    earlyStatusTurn?.close();
    throw error;
  }
  const {
    preparedMemory,
    agentConversationKey,
    runtimePlanDecision,
    sandboxUnavailableFallback,
    workLifecycle,
    modelRepairText,
  } = prepared;
  deliveryLifecycle = workLifecycle;
  if (preparedMemory) presenter.setMemoryFooterItems(preparedMemory.footerItems);
  agentViewPresentation?.setFooterMemoryItems(preparedMemory?.footerItems);
  const statusInstanceId = runtimePlanDecision?.instanceId ?? agentConversationKey;
  earlyStatusTurn?.rebind(statusInstanceId);
  const statusTurn = earlyStatusTurn ?? (stoppedBeforeDispatch
    ? registerStatusTurn(statusInstanceId)
    : await beginVisibleWork(statusInstanceId));
  // Once per turn; a failed hint never holds back the task's progress.
  let codingTaskSignalled = false;
  const signalCodingTaskStarted = async () => {
    if (codingTaskSignalled || !options.onCodingTaskStarted) return;
    codingTaskSignalled = true;
    try {
      await options.onCodingTaskStarted();
    } catch (error) {
      console.warn(
        `[chickpea] coding active-work hint skipped: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
  };
  let terminalStatusFinished = false;
  let yielded = false;
  const finishStatus = async (result: 'answer' | 'failure'): Promise<void> => {
    // Close the sink first. Agent observations are relayed best-effort from a
    // different Cloudflare isolate and may still arrive after settlement
    // resolves; removing this generation makes its late relays no-ops even if
    // another turn has already registered under the same conversation key.
    // The normal clear is awaited so it reaches Slack before the Worker turn
    // settles. If an active status write lands after it, the registry issues a
    // second best-effort clear without blocking the final response.
    // A custom status write landing after the session settles would move the
    // session back to processing (a non-empty assistant status carries it),
    // so let the one write that may be in flight land first.
    await statusTurn.drain();
    await agentViewPresentation?.settleAgentSession(result);
    await statusTurn.finish(async (late) => {
      if (frozenPresentation?.schemaVersion !== 3 || !agentViewPresentation) {
        await presenter.clearStatus(late);
        return;
      }
      const cleanup = await agentViewPresentation.prepareActivityCleanup(
        stoppedEnding ? { stopped: true } : undefined,
      );
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
  let usageRecorder: InteractiveUsageRecorder | undefined;
  const usageRecordingEnabled = options.usageRecordingEnabled ??
    usageRuntimeRecordingEnabled(platformEnv);
  const openUsageRecorder = async (): Promise<void> => {
    usageRecorder = new InteractiveUsageRecorder({
      turn,
      assignment,
      requestedModel: resolvedModel ?? null,
      operationId: statusGeneration,
      executionId: options.usageExecutionId ?? `exec:${statusGeneration}:1`,
      store: options.usageStore ?? options.appStores?.usage ?? getUsageStore(platformEnv),
      ...(options.flueDispatch?.flueSettlement
        ? { replaySettlementAt: options.flueDispatch.flueSettlement.settledAt } : {}),
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
  };
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
  /**
   * Remove the turn's receipt: its work acknowledgment, or the 👀 admission
   * added because the message arrived mid-run (KTD9). Only a receipt recorded
   * as Chickpea's own is removed, and only on the message it names, because
   * `reactions.remove` is not scoped to the code path that added it.
   */
  const removeWorkAcknowledgment = async (): Promise<void> => {
    const persisted = interactionProgress.acknowledgment;
    if (!workAcknowledgment?.created || !persisted || persisted.cleanup === 'done') return;
    try {
      await presenter.removeReaction(persisted.name, {
        channelId: persisted.channelId,
        messageTs: persisted.messageTs,
      });
      workAcknowledgment = undefined;
      await recordInteractionProgress({
        acknowledgment: { ...persisted, created: true, cleanup: 'done' },
      });
    } catch {
      console.warn('[chickpea] Slack work acknowledgment cleanup failed');
    }
  };
  /**
   * A reaction answer that is the receipt's own emoji on the receipt's own
   * message (the classifier's `seen` on a message admission gave 👀) is the
   * turn's output now: the finish keeps it instead of removing the answer.
   */
  const keepAcknowledgmentAsAnswer = async (
    delivered: SlackReactionReceipt,
    coordinate: { channelId: string; messageTs: string },
  ): Promise<void> => {
    const persisted = interactionProgress.acknowledgment;
    if (!workAcknowledgment?.created || !persisted || persisted.cleanup === 'done' ||
        persisted.name !== delivered.name || persisted.channelId !== coordinate.channelId ||
        persisted.messageTs !== coordinate.messageTs) return;
    workAcknowledgment = undefined;
    await recordInteractionProgress({ acknowledgment: { ...persisted, cleanup: 'done' } });
  };
  const finishDelivery = async (
    outcome?: 'succeeded' | 'no_op' | 'failed' | 'stopped',
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

  /**
   * The stopped ending (KTD3): one stop note, posted as the thread's Agent
   * like a final (sealing an open stream after its partial answer), then the
   * Agent Session settles `active`, the status clears and Chickpea's 👀
   * receipt goes, through the ordinary delivery finish. No failure text, and
   * no replayed pull-request answer: what already happened is in the note.
   */
  const endStopped = async (facts: SlackStopNoteFacts): Promise<void> => {
    stoppedEnding = true;
    await agentViewPresentation?.recordExecutionStopped().catch(() => {
      console.warn('[chickpea] stopped Slack plan rows could not be recorded');
    });
    await workLifecycle?.settleExecution({
      outcome: 'failed',
      rawStatus: 'flue_stopped',
      safeFailureCode: 'run_stopped',
    });
    await usageRecorder?.recordStopped();
    await statusTurn.prepareFinal();
    await presenter.deliverFinal(
      slackStopNoteText(facts),
      'markdown',
      'complete',
      undefined,
      undefined,
      { stopped: true },
    );
    await finishStatus('answer');
    await finishDelivery('stopped');
  };

  // 1. Visible work: set best-effort native status. A rejection degrades to
  //    Agent Session lifecycle only and never creates a progress message.
  try {
    if (stoppedBeforeDispatch) {
      // The stop refused this turn's dispatch: nothing ran, so it ends now.
      stopping = true;
      const facts = await options.stopEnding!.finish();
      // The executor saw a stop record; without one nothing may run here.
      if (!facts) throw new Error('A stopped turn lost its stop record.');
      if (options.stopEnding!.usageAdmitted && usageRecordingEnabled) await openUsageRecorder();
      await endStopped(facts);
      return;
    }
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
    // The turn's model cannot run until Model providers is repaired: say so
    // once, as the thread's Agent, with nothing dispatched.
    if (modelRepairText !== undefined) {
      presenter.setFooterModelRepair();
      agentViewPresentation?.setFooterModelRepair();
      await statusTurn.prepareFinal();
      await presenter.deliverFinal(modelRepairText, 'plain_text', 'error');
      await finishStatus('failure');
      await finishDelivery('failed');
      return;
    }
    // Only a person's own words title the thread: a click's or form's text
    // is host-authored, and an ask or a later co-addressed turn joins a
    // thread a person's message already titled.
    if (typedByPerson && !turn.uiResponse) {
      await agentViewPresentation?.setTitle(turn.text).catch(() => {
        console.warn('[chickpea] Slack Agent View title could not be recorded');
      });
    }
    if (turn.managementApprovalProposalId && options.replayText === undefined &&
        options.invokeManagementApproval && !options.managementApproval) {
      const persisted = await workLifecycle?.prepareExecution('Slack management approval');
      void persisted;
      const approval = await options.invokeManagementApproval({
        turn,
        assignment,
        turnJobId: options.turnId ?? `msg:${turn.channelId}:${turn.messageTs}`,
        proposalId: turn.managementApprovalProposalId,
        ...(agentViewPresentation && options.runId ? { presentationRunId: options.runId } : {}),
        ...(publicUrl ? { publicUrl } : {}),
      });
      if (approval.kind === 'agent_welcome_queued' && agentViewPresentation && options.runId) {
        // The state owner queued the welcome; this executor owns the run's
        // presentation, so it records the deferred terminal intent here.
        await agentViewPresentation.prepareDeferredTerminalDelivery('answer').catch(() => {
          console.warn('[chickpea:management] deferred terminal intent will be recovered on delivery');
        });
      }
      await workLifecycle?.settleExecution({
        outcome: 'succeeded',
        rawStatus: 'host_management_approval_succeeded',
        modelInvoked: false,
      });
      if (approval.kind === 'message') {
        await statusTurn.prepareFinal();
        await presenter.deliverFinal(approval.text, 'markdown');
      }
      await finishStatus('answer');
      await finishDelivery();
      return;
    }
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
      await workLifecycle?.settleExecution({
        outcome: 'succeeded',
        rawStatus: 'host_management_approval_succeeded',
        modelInvoked: false,
      });
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
      await workLifecycle?.settleExecution({
        outcome: 'succeeded',
        rawStatus: 'adapter_reaction_only',
        modelInvoked: false,
      });
      // Reading the persisted input is the ledger fence; its content is not
      // user-visible and the semantic reaction remains the approved output.
      void prepared;
      if (frozenPresentation?.schemaVersion === 3 && agentViewPresentation &&
          !(await agentViewPresentation.prepareDeferredTerminalDelivery('answer'))) {
        throw new Error('Slack reaction delivery requires reconciliation.');
      }
      const reactionCoordinate = resolveReactionCoordinate(turn, interactionIntent.target);
      let delivered: SlackReactionReceipt;
      try {
        delivered = await presenter.deliverReaction(interactionIntent.reaction, reactionCoordinate);
      } catch (error) {
        await agentViewPresentation?.recordTerminalDeliveryReceipt(slackDeliveryFailureOutcome(error));
        throw error;
      }
      await keepAcknowledgmentAsAnswer(delivered, reactionCoordinate);
      // The reaction is the terminal output. V3 cleanup requires its receipt,
      // just as it does for a written answer.
      await agentViewPresentation?.recordTerminalDeliveryReceipt('acknowledged');
      await finishStatus('answer');
      await finishDelivery();
      return;
    }
    if (usageRecordingEnabled && options.replayText === undefined) await openUsageRecorder();
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
      if (workAcknowledgment?.created) options.onSlackWrite?.('reaction');
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
    // A turn that continues the thread's transcript sends only what arrived
    // since the previous turn; the transcript already holds the rest,
    // including any ownership handoff context its first turn carried.
    const continuation = await readThreadContinuation(options, runtimePlanDecision, turn);
    const frozenHandoff = continuation
      ? []
      : runtimePlanDecision?.runtimePlan.handoffContext ?? assignment.handoffContext ?? [];
    const threadRecord = assignment.runtimeContract === 'chickpea-v1' && frozenHandoff.length === 0
      ? options.appStores?.config ?? getConfigStore(platformEnv)
      : undefined;
    const hydratedContext = frozenHandoff.length > 0
      ? currentMessageOnlyContext(turn)
      : await hydrateTurnSlackContext({
          client,
          turn,
          ...(installationContext ? { botUserId: installationContext.botUserId } : {}),
          sharedAppReads,
          state: options.appStores?.slackState ?? getSlackStateStore(platformEnv),
          ...(threadRecord ? { record: threadRecord } : {}),
        });
    const context = await resolveSlackContextNames(
      client,
      turn.workspaceId,
      await assembleRetainedSlackContext(hydratedContext, turn, {
        visibilityBarrierAt: preparedMemory?.visibilityBarrierAt ?? null,
        ...(threadRecord ? { store: threadRecord, agentId: assignment.agentId } : {}),
      }),
    );
    const promptContext = continuation
      ? slackContextSinceWatermark(context, continuation.messageTs, assignment.agentId)
      : context;
    const continuityNote = continuation && runtimePlanDecision
      ? threadContinuityNote({
          previous: continuation,
          plan: runtimePlanDecision.runtimePlan,
          turn,
          sharedThread: slackConversationKind(turn) !== 'im',
        })
      : undefined;
    // A frozen plan reaches the render with the turn's staged input, so the
    // memory is rendered as an instruction there, once, instead of piling up
    // in the thread's transcript turn after turn.
    const memoryRendered = runtimePlanDecision !== undefined;
    const admittedListIds = runtimePlanDecision
      ? collectAdmittedSlackListIds({
          workspaceId: turn.workspaceId,
          currentText: turn.text,
          activeRootTs: turn.threadTs,
          contextMessages: context.messages,
          instructions: runtimePlanDecision.runtimePlan.instructions,
          memoryPromptBlock: preparedMemory?.promptBlock,
          agentId: assignment.agentId,
        })
      : [];
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
        replacementCapable: handedBack,
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
    const offeredEligibility =
      currentRequestPolicyVersion === 2 && frozenProgressiveEligibility?.allowed === true
        ? frozenProgressiveEligibility
        : undefined;
    // The host fetch is the only place these records exist; the dispatch
    // envelope is the only channel that reaches the Agent object. Only a plan
    // that can use them gets them: one whose image role resolved, or one that
    // can send a conversation image to a connection.
    const threadImages = context.images?.length && runtimePlanDecision &&
      (runtimePlanDecision.runtimePlan.imageCapability?.filled === true ||
        planAllowsConnectionFileUpload(runtimePlanDecision.runtimePlan))
      ? context.images
      : undefined;
    const threadImageManifest = threadImages && runtimePlanDecision
      ? conversationThreadImageInventory(runtimePlanDecision.runtimePlan.conversation, threadImages).manifest
      : '';
    const prompt = assembleSlackPrompt(turn, promptContext, {
      ...(handoffBlock ? { handoffBlock } : {}),
      ...(preparedMemory?.promptBlock && !memoryRendered
        ? { memoryBlock: preparedMemory.promptBlock }
        : {}),
      ...(continuityNote ? { continuityNote } : {}),
      memorySelected: (preparedMemory?.selection?.entries.length ?? 0) > 0,
      currentRequestPolicyVersion,
      progressiveStreamingOffered: offeredEligibility !== undefined,
      ...(offeredEligibility
        ? { progressiveStreamingMode: progressiveStreamingModeForReason(offeredEligibility.reason) }
        : {}),
      ...(options.previousStop
        ? { previousRunStopped: { stopperUserId: options.previousStop.stopperUserId } }
        : {}),
      // The thread's own Agent reads a teammate's message as its answer; a
      // guest reads it as a question.
      ...(turn.agentAsk ? { askedAsThreadOwner: assignment.threadGuest !== true } : {}),
      ...(threadImageManifest ? { threadImageManifest } : {}),
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
    // Usage names the execution only once it exists. A creation queued behind
    // a slow Work store links when it lands; usage recorded before then names
    // none, never one that may not exist.
    workLifecycle?.whenExecutionRecorded((executionId) => {
      usageRecorder?.linkRunExecution(executionId);
    });
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
    // A settled answer replayed from its checkpoint carries no display
    // components; they are read back from the turn's stored surfaces.
    const settledBeforePrompt = options.flueDispatch?.flueSettlement?.outcome === 'completed';
    let tablePresentation: SlackTablePresentation | undefined =
      options.flueDispatch?.flueSettlement?.outcome === 'completed'
        ? options.flueDispatch.flueSettlement.result.tablePresentations?.[0]
        : undefined;
    let artifacts: SlackArtifactReceipt[] | undefined =
      options.flueDispatch?.flueSettlement?.outcome === 'completed'
        ? options.flueDispatch.flueSettlement.result.artifacts
        : undefined;
    if (options.replayText !== undefined) {
      text = options.replayText;
    } else {
      try {
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
        // A burst of milestone records (a reattached read replays them all)
        // publishes once, after it settles, for the state it left.
        let codingProgressScheduled = false;
        const publishCodingProgress = () => {
          if (codingProgressScheduled) return;
          codingProgressScheduled = true;
          setTimeout(() => {
            codingProgressScheduled = false;
            const status = codingProgress.takeStatus();
            if (status) void statusTurn.setStatus(status).catch(() => false);
          }, 0);
        };
        // A stream that outlives Slack's few-minute window is closed before
        // Slack can seal it; its answer then posts as a fresh message.
        const streamAgeChecks = agentViewPresentation
          ? watchAgentViewStreamAge(agentViewPresentation)
          : undefined;
        try {
          agentResult = await (options.agentPrompt ?? promptSlackThreadAgent)({
            message: executionPrompt,
            state: options.flueDispatch!,
            turnId: statusGeneration,
            conversationKey: agentConversationKey,
            requestedModel: resolvedModel ?? null,
            ...(runtimePlanDecision
              ? { runtimePlan: runtimePlanDecision.runtimePlan }
              : {}),
            ...(memoryRendered && preparedMemory?.promptBlock
              ? { memoryBlock: preparedMemory.promptBlock }
              : {}),
            ...(threadImages ? { threadImages } : {}),
            ...(admittedListIds.length ? { admittedListIds } : {}),
            ...turnEnvelopeBuilder(runtimePlanDecision?.runtimePlan, settingsStore, options.appStores?.config, platformEnv),
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
            ...(options.observationSignal ? { observationSignal: options.observationSignal } : {}),
            ...(options.onObservationStarted
              ? { onObservationStarted: options.onObservationStarted }
              : {}),
            ...(options.codingTaskStarted ? { codingTaskStarted: true } : {}),
            onWorkspaceMilestone: async (record) => {
              await signalCodingTaskStarted();
              codingProgress.apply(record);
              // Progress by its position in the reply: a replay is not.
              statusTurn.progress({ kind: 'milestone', sequence: codingProgress.applied() });
              publishCodingProgress();
            },
          });
        } finally {
          await streamAgeChecks?.stop();
        }
        text = sandboxUnavailableFallback
          ? `${SANDBOX_UNAVAILABLE_FALLBACK_NOTICE}\n\n${agentResult.text}`
          : agentResult.text;
        tablePresentation = agentResult.tablePresentations?.[0];
        artifacts = agentResult.artifacts;
        if (agentResult.codingModel) {
          const codingFooterLabel = replyFooterModelLabel({
            agentModel: resolvedModel,
            codingModel: agentResult.codingModel,
            codingWorkerRan: true,
          });
          presenter.setFooterModelLabel(codingFooterLabel);
          agentViewPresentation?.setFooterModelLabel(codingFooterLabel);
        }
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
        // The executing Durable Object (or one it reached) is being replaced:
        // nothing about the turn is decided. Retry and reattach, never a final.
        // A settled Flue failure is an AgentPromptFailure and is final as is.
        if (!(err instanceof AgentPromptFailure) && isSandboxDisconnect(err)) {
          throw new StateStoreUnavailable();
        }
        // A stop's abort took effect (live or replayed): the stopped ending,
        // never the failure text or a replayed pull-request answer.
        if (err instanceof AgentRunAborted && options.stopEnding) {
          stopping = true;
          const facts = await options.stopEnding.finish();
          if (facts) {
            await endStopped(facts);
            return;
          }
          stopping = false;
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
        // A suspended or ended installation gets no new Slack output: its
        // refused attempt ends without any reply, only its activity cleared.
        if (await installationRefusesWork(platformEnv)) {
          await statusTurn.prepareFinal();
          // A partial answer already streamed stays as shown, ended rather than left streaming.
          await agentViewPresentation?.sealStreamWithoutReply().catch(() => {
            console.warn('[chickpea] Slack stream of a refused turn could not be ended; Slack seals an idle stream itself');
          });
          if (options.runId) {
            await abandonTerminalSlackPresentationBestEffort({
              runId: options.runId,
              state: options.presentationState,
              client,
            });
          }
          await finishStatus('failure');
          await finishDelivery('failed');
          return;
        }
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
        const components = err instanceof AgentPromptFailure && err.kind === 'credits-exhausted'
          ? await creditsExhaustedComponents({
              env: platformEnv,
              identity: options.appStores?.identity ?? getIdentityStore(platformEnv),
              workspaceId: turnWorkspaceId,
              userId: turn.userId,
            })
          : undefined;
        const failureText = withCreditedBack(agentFailureText(err), await creditBackFailedRun(
          hostedRun(platformEnv, options.flueDispatch?.dispatchReceipt?.submissionId),
          creditBackReason(
            slackFailureKind(err, options.flueDispatch?.flueSettlement),
            {
              funding: planFunding(runtimePlanDecision?.runtimePlan),
              toolCallCount: err instanceof AgentPromptFailure ? err.toolCallCount : undefined,
            },
          ),
        ));
        await statusTurn.prepareFinal();
        // A plain_text final drops its text when it carries blocks; this text has no markdown syntax.
        await (components
          ? presenter.deliverFinal(failureText, 'markdown', 'error', { components })
          : presenter.deliverFinal(failureText, 'plain_text', 'error'));
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
      const requesterText = personRequestText(turn);
      const signal = {
        agentId: assignment.agent.id,
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        threadTs: conversationThreadTs(turn, assignment.runtimeContract),
        conversationKind: slackConversationKind(turn),
        slackUserId: turn.userId,
        eventId: turn.eventId,
        messageTs: turn.messageTs,
        turnJobId,
        ...(requesterText === undefined ? {} : { requesterText }),
        ...(turn.requesterTimezone ? { requesterTimezone: turn.requesterTimezone } : {}),
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
        ...(terminal.pendingProposalId
          ? { pendingProposalId: terminal.pendingProposalId }
          : {}),
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
    const recoveredText = await options.beforeDelivery?.(
      agentResult?.codingWorkspaceOpened === undefined
        ? undefined
        : { codingWorkspaceOpened: agentResult.codingWorkspaceOpened },
    );
    let acknowledgeMemoryUpdate = false;
    if (agentResult?.memoryUpdate && preparedMemory?.validateReceiptLease) {
      // A changed memory invalidates the ordinary lease. Only a verified
      // own-turn receipt permits this host acknowledgement, which either keeps
      // the model's answer (a write that only added to the injected snapshot)
      // or replaces it with the bounded summary (anything that could forget).
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
        const requesterText = personRequestText(turn);
        const signal = {
          agentId: assignment.agent.id,
          workspaceId: turn.workspaceId,
          channelId: turn.channelId,
          threadTs: conversationThreadTs(turn, assignment.runtimeContract),
          conversationKind: slackConversationKind(turn),
          slackUserId: turn.userId,
          eventId: turn.eventId,
          messageTs: turn.messageTs,
          turnJobId,
          ...(requesterText === undefined ? {} : { requesterText }),
          ...(turn.requesterTimezone ? { requesterTimezone: turn.requesterTimezone } : {}),
        } as const;
        const actor = await resolveSlackManagementActor(signal, dependencies.identity);
        acknowledgeMemoryUpdate = await verifyMemoryUpdateAcknowledgement({
          hint: agentResult.memoryUpdate,
          agentId: assignment.agent.id,
          turnJobId,
          getOperation: (operationId) => dependencies.service.getOperation(actor, operationId),
          validateReceiptLease: preparedMemory.validateReceiptLease,
        });
      } catch {
        // Unavailable receipts or revoked actors retain the ordinary lease check.
        acknowledgeMemoryUpdate = false;
      }
    }
    // Memory was in the model's context at generation time. A write that kept
    // that snapshot verbatim leaves nothing forgotten for the draft to
    // disclose, so the answer and its presentation deliver as usual. A forget,
    // rewrite, replay, or write over an unseen snapshot replaces the draft.
    if (acknowledgeMemoryUpdate && agentResult?.memoryUpdate?.preservesContext !== true) {
      text = recoveredText ?? agentResult?.memoryUpdate?.summary ?? 'I updated my memory.';
      tablePresentation = undefined;
      artifacts = undefined;
    }
    // Confirmation only prevents reinjecting the same selection into this
    // transcript. A concurrent turn can legitimately advance the epoch before
    // this one finishes; that bookkeeping race must not discard a completed,
    // lease-valid answer.
    await preparedMemory?.confirmInjection();
    const leaseValid = acknowledgeMemoryUpdate || (await preparedMemory?.validateLease() ?? true);
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
    // Teammates' answers already completed the request: nothing is posted, and
    // the turn ends like a reaction-only one. Anything else still delivers.
    const silentEnding = handedBack && options.replayTerminalResult === undefined &&
      isAgentAskSilentReply(text) && recoveredText === undefined && leaseValid &&
      !acknowledgeMemoryUpdate && !artifacts?.length && !tablePresentation &&
      !agentResult?.displayComponents?.length && !workChecklistTs;
    if (silentEnding) {
      if (frozenPresentation?.schemaVersion === 3 && agentViewPresentation &&
          !(await agentViewPresentation.prepareDeferredTerminalDelivery('answer'))) {
        throw new Error('Slack silent reply requires reconciliation.');
      }
      await abandonTurnSurfaces(
        options.appStores?.slackState ?? getSlackStateStore(platformEnv),
        options.turnId ?? `msg:${turn.channelId}:${turn.messageTs}`,
      ).catch(() => undefined);
      await workLifecycle?.settleWithoutDelivery({ terminalDisposition: 'no_op' });
      await agentViewPresentation?.recordTerminalDeliveryReceipt('acknowledged');
      await finishStatus('answer');
      await finishDelivery('no_op');
      return;
    }
    const terminalResult = options.replayTerminalResult ?? 'answer';
    await statusTurn.prepareFinal();
    // Files publish only with the model's own lease-valid answer. A recovered
    // or replaced text never adopts staged files.
    const deliverableArtifacts = recoveredText === undefined && leaseValid && terminalResult === 'answer'
      ? artifacts
      : undefined;
    const surfaceState = options.appStores?.slackState ?? getSlackStateStore(platformEnv);
    const surfaceTurnJobId = options.turnId ?? `msg:${turn.channelId}:${turn.messageTs}`;
    // Components travel only with the model's own lease-valid answer.
    const ownAnswer = terminalResult === 'answer' && recoveredText === undefined && leaseValid &&
      !(acknowledgeMemoryUpdate && agentResult?.memoryUpdate?.preservesContext !== true);
    const displaySurfaces = ownAnswer
      ? await prepareDisplaySurfaces({
          state: surfaceState,
          turn,
          agentId: assignment.agent.id,
          turnJobId: surfaceTurnJobId,
          ...(settledBeforePrompt ? {} : { fresh: agentResult?.displayComponents ?? [] }),
        }).catch(() => {
          console.warn('[chickpea] display components were not stored; the answer posts without them');
          return [];
        })
      : [];
    const displayComponents = renderDisplayComponents(displaySurfaces);
    await presenter.deliverFinal(
      text,
      'markdown',
      terminalResult === 'failure' ? 'error' : 'complete',
      displayComponents
        ? { ...(tablePresentation ? { table: tablePresentation } : {}), components: displayComponents }
        : tablePresentation,
      deliverableArtifacts,
    );
    if (displaySurfaces.length) {
      await markDisplaySurfacesDelivered(surfaceState, displaySurfaces).catch(() => undefined);
    }
    if (terminalResult === 'answer') {
      const surfaceMessenger = {
        post: (rendered: { text: string; blocks: Array<Record<string, unknown>> }) =>
          presenter.postSurfaceMessage(rendered),
        update: (messageTs: string, rendered: { text: string; blocks: Array<Record<string, unknown>> }) =>
          presenter.updateSurfaceMessage(messageTs, rendered),
      };
      await (ownAnswer
        ? deliverInteractiveSurfaces({
            turn,
            agentId: assignment.agent.id,
            turnJobId: surfaceTurnJobId,
            state: surfaceState,
            messenger: surfaceMessenger,
            answerText: text,
          })
        : abandonTurnSurfaces(surfaceState, surfaceTurnJobId)
      ).catch(() => {
        console.warn('[chickpea] Slack reply buttons were not posted');
      });
      // An approval this turn is holding gets host buttons under the reply.
      // A failure here never undoes the delivered answer; typed approval works.
      await deliverHostApprovalSurfaces({
        turn,
        assignment,
        turnJobId: options.turnId ?? `msg:${turn.channelId}:${turn.messageTs}`,
        state: options.appStores?.slackState ?? getSlackStateStore(platformEnv),
        ...(settingsStore ? { settings: settingsStore } : {}),
        identity: options.appStores?.identity ?? getIdentityStore(platformEnv),
        management: options.appStores?.management ?? getManagementStore(platformEnv),
        messenger: {
          post: (rendered) => presenter.postSurfaceMessage(rendered),
          update: (messageTs, rendered) => presenter.updateSurfaceMessage(messageTs, rendered),
        },
      }).catch(() => {
        console.warn('[chickpea] Slack approval buttons were not posted');
      });
    }
    // Clear after the final reaches Slack. A custom Agent persona does not
    // reliably trigger Slack's automatic app-status cleanup, and clearing
    // before delivery can leave the custom status visible after the reply.
    await finishStatus(terminalResult);
    await finishDelivery(
      options.replayText === undefined
        ? terminalResult === 'failure' ? 'failed' : 'succeeded'
        : undefined,
    );
  } catch (caught) {
    // A runner whose state store is being replaced retries the turn the same
    // way it reattaches after a yield: the Agent is still working. That
    // includes a store call anywhere in the turn (a memory lease check after
    // the answer, say) failing because its Durable Object is being replaced.
    const err = !(caught instanceof AgentPromptFailure) && isStateStoreDisconnect(caught)
      ? new StateStoreUnavailable()
      : caught;
    if (err instanceof AgentObservationYield || err instanceof StateStoreUnavailable) yielded = true;
    if (!stopping && !(err instanceof AgentPromptFailure && err.retryable)) {
      await usageRecorder?.recordFailure();
    }
    throw err;
  } finally {
    // A yielded turn is still running: it ends nothing a reattaching attempt
    // needs (its status and acknowledgment), the same as an attempt the
    // platform killed mid-observation.
    if (yielded) {
      if (!terminalStatusFinished) statusTurn.close();
    } else {
      // A V3 retry/recovery attempt keeps its acknowledged activity visible.
      // Legacy presentations retain their prior best-effort finally cleanup.
      if (!terminalStatusFinished) {
        if (frozenPresentation?.schemaVersion === 3) {
          statusTurn.close();
        } else {
          await statusTurn.finish(async () => { await presenter.clearStatus(); });
        }
      }
      await removeWorkAcknowledgment();
    }
    // Work writes queued behind a slow Work store are recorded now, within a
    // bound. The reply and its cleanup are done, so the user waits for none of
    // them. A yielded turn waits too: work left running after the alarm
    // returns may never land, and the attempt that reattaches needs the
    // execution this one opened.
    await deliveryLifecycle?.settled();
  }
}

/**
 * Check the Agent View stream's age while the turn waits on its agent: at
 * once (a reattached turn may hold an old stream) and every
 * AGENT_VIEW_STREAM_AGE_CHECK_MS. Checks never overlap and never throw.
 */
function watchAgentViewStreamAge(
  presentation: Pick<SlackAgentViewPresentation, 'retireAgedStream'>,
): { stop(): Promise<void> } {
  let running: Promise<unknown> = presentation.retireAgedStream();
  const timer = setInterval(() => {
    running = running.then(() => presentation.retireAgedStream());
  }, AGENT_VIEW_STREAM_AGE_CHECK_MS);
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
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
  const usage = interactionReportedUsage(input.classification.result?.reportedUsage);
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
  /** Absent for a turn the host answers without a Flue instance. */
  flueInstanceRef?: string;
  platformEnv: PlatformEnv | undefined;
  workStore?: WorkStore;
  settingsStore?: SettingsStore;
  mode: 'observe' | 'enforce';
  resumeSettled?: boolean;
}): Promise<ShadowWorkLifecycle | undefined> {
  try {
    const store = input.workStore ?? getWorkStore(input.platformEnv);
    const providerAuthRoute = await resolveProviderAuthRoute(
      input.canonicalModel,
      input.settingsStore ?? getSettingsStore(input.platformEnv),
    );
    // Awaited here so a rejection reaches the catch: in observe mode a resume
    // whose execution was never created (its first attempt hit a slow store)
    // continues without the shadow lifecycle instead of failing every attempt.
    return await createWorkExecutionLifecycle(store, {
      runId: input.runId,
      attemptNumber: input.attemptNumber,
      ...(input.fencingToken === undefined ? {} : { fencingToken: input.fencingToken }),
      executorKind: 'agent',
      agentName: input.assignment.agent.id,
      canonicalModel: input.canonicalModel,
      ...(input.flueInstanceRef ? { flueInstanceRef: input.flueInstanceRef } : {}),
      routeEvidence: safeRuntimeModelRouteEvidence(
        input.canonicalModel,
        providerAuthRoute,
        input.assignment.modelCredential,
        input.platformEnv,
      ),
      ...(input.resumeSettled ? { resumeSettled: true } : {}),
    }, {
      mode: input.mode,
    });
  } catch (error) {
    if (input.mode === 'enforce') throw error;
    console.warn('[work] shadow lifecycle initialization failed; legacy execution will continue');
    return undefined;
  }
}

function slackFailureKind(error: unknown, settlement: FlueSettlementCheckpointV1 | undefined): SlackFailureKind {
  if (settlement && settlement.outcome !== 'completed') return settlement.failureKind;
  return error instanceof AgentPromptFailure ? error.kind : 'agent';
}

function agentFailureSafeCode(error: unknown): string {
  if (!(error instanceof AgentPromptFailure)) return 'agent_failed';
  switch (error.kind) {
    case 'provider': return 'provider_failed';
    case 'invalid-output': return 'invalid_model_output';
    case 'openai-subscription-reconnect': return 'subscription_reconnect';
    case 'openai-subscription-quota': return 'subscription_quota';
    case 'openai-subscription-policy': return 'subscription_policy';
    case 'credits-exhausted': return 'credits_exhausted';
    default: return 'agent_failed';
  }
}

function agentFailureBeforeModelInvocation(error: unknown): boolean {
  if (!(error instanceof AgentPromptFailure)) return false;
  return [
    'openai-subscription-reconnect',
    'openai-subscription-policy',
  ].includes(error.kind);
}

/**
 * Whether this turn's Agent may use a coding workspace. It never changes the
 * Agent's own environment; it only decides whether the workspace tools mount.
 */
export async function resolveCodingWorkspaceDecision(
  assignment: ResolvedAssignment,
  env: PlatformEnv | undefined,
  store?: SettingsStore,
): Promise<CodingWorkspaceCapabilityDecision> {
  if (!isCloudflareTarget()) return { capability: 'unavailable', unavailableFallback: false };
  const repositories = assignment.agent.repositories ?? [];
  if (repositories.length === 0) {
    return { capability: 'unavailable', unavailableFallback: false };
  }

  try {
    const settingsStore = store ?? getSettingsStore(env);
    const [settings, connection] = await Promise.all([
      resolveSandboxSettings(settingsStore, env),
      getGithubConnection(settingsStore, env),
    ]);
    return resolveCodingWorkspaceCapability({
      target: 'cloudflare',
      installed: sandboxBindingInstalled(env),
      enabled: settings.enabled,
      appConnected: connection.mode === 'app',
      repositoryGrants: repositories,
    });
  } catch {
    // Without its policy the workspace is simply not offered this turn.
    return { capability: 'unavailable', unavailableFallback: false };
  }
}

/**
 * On Cloudflare the Agent runs in its own Durable Object, where every settings
 * read is an RPC back into this state object. Freeze what its tools read
 * (host-local reads here) so they do not call back per tool.
 */
function turnEnvelopeBuilder(
  plan: RuntimePlanV2 | undefined,
  settings: SettingsStore | undefined,
  config: AppStores['config'] | undefined,
  env: PlatformEnv | undefined,
): { buildTurnEnvelope?: () => Promise<TurnEnvelopeV1 | undefined> } {
  if (!plan || !settings || !config || !isCloudflareTarget()) return {};
  return {
    buildTurnEnvelope: () => buildTurnEnvelope({ plan, settings, config, ...(env ? { env } : {}) }),
  };
}

/**
 * The thread instance's previous turn, if this turn continues its transcript.
 * A failed read degrades to a full bounded context: repeating rows the
 * transcript holds is harmless; omitting ones it lacks is not.
 */
async function readThreadContinuation(
  options: Pick<RunTurnOptions, 'getThreadContinuation' | 'replayText'>,
  decision: FrozenRuntimePlanDecision | undefined,
  turn: NormalizedSlackTurn,
): Promise<SlackThreadContinuation | undefined> {
  if (!decision || !options.getThreadContinuation || options.replayText !== undefined) return undefined;
  try {
    return await options.getThreadContinuation(
      decision.runtimePlan.conversation.continuityKey,
      decision.instanceId,
      turn.messageTs,
    );
  } catch {
    console.warn('[chickpea] thread continuation read failed; sending the full bounded context');
    return undefined;
  }
}

export async function freezeRuntimePlanForTurn(input: {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  platformEnv: PlatformEnv | undefined;
  settingsStore?: SettingsStore;
  configStore?: ReturnType<typeof getConfigStore>;
  /** Only compilation needs it, so every read below runs while it resolves. */
  memoryEpoch: Promise<number>;
  persist?: (candidate: RuntimePlanV2) => FrozenRuntimePlanDecision | Promise<FrozenRuntimePlanDecision>;
  getBoundRuntimePlan?: RunTurnOptions['getBoundRuntimePlan'];
}): Promise<{
  decision: FrozenRuntimePlanDecision;
  unavailableFallback: boolean;
}> {
  const installation = installationOwnershipOf(input.platformEnv);
  // A hosted plan names a Flue instance of its installation, which must be
  // in the installation's object inventory before anything addresses it:
  // only the store that records it (TurnJobStore.freezeRuntimePlan) may
  // freeze one. Standalone keeps no inventory.
  if (installation && !input.persist) {
    throw new InstallationContextError(
      'installation_context_invalid',
      'A hosted turn must record its runtime plan before using it.',
    );
  }
  const configStore = input.configStore ?? getConfigStore(input.platformEnv);
  const actorConnectionContext = input.turn.actorMembershipId
    ? {
        config: configStore,
        workspaceId: input.turn.workspaceId,
        agentId: input.assignment.agentId,
        actorMembershipId: input.turn.actorMembershipId,
      }
    : undefined;
  // Independent reads: the workspace policy, the actor's connections, and
  // the thread's previous plan.
  const [workspaceDecision, connectionContext, previous] = await Promise.all([
    resolveCodingWorkspaceDecision(
      input.assignment,
      input.platformEnv,
      input.settingsStore,
    ),
    actorConnectionContext
      ? resolveConnectionAccountContext(actorConnectionContext)
      : undefined,
    input.turn.actorMembershipId
      ? input.getBoundRuntimePlan?.(
          opaqueId('agent', slackAgentContinuityKey(input.turn, input.assignment)), input.turn.messageTs,
          input.turn.actorMembershipId, input.assignment.agentId,
        )
      : undefined,
  ]);
  // The constant guidance opens the agent's system prompt in code
  // (shared-prefix.ts); the plan carries only what names this Agent.
  const instructions = slackTenantInstructions(input.assignment);
  const allEffectiveConnections = connectionContext?.effective ?? [];
  const connectionAuthorizations = connectionContext?.authorizations;
  const teamReconnects = connectionContext?.teamReconnects;
  const sameActorThread = previous && input.turn.actorMembershipId &&
    previous.actorMembershipId === input.turn.actorMembershipId &&
    previous.agentId === input.assignment.agentId &&
    previous.ownerIncarnation === (input.assignment.ownerIncarnation ?? 1) &&
    previous.conversation.workspaceId === input.turn.workspaceId &&
    previous.conversation.channelId === input.turn.channelId &&
    previous.conversation.threadTs === input.turn.threadTs;
  const connectionResolution = selectConnectionsForRequest({
    connections: allEffectiveConnections,
    requestText: input.turn.text,
    ...(sameActorThread && previous.connectionSelections ? { previousSelections: previous.connectionSelections } : {}),
  });
  const canonicalModel = resolvedAssignmentModel(input.assignment);
  if (!canonicalModel) {
    throw new Error('Runtime plan compilation requires a frozen model.');
  }
  const settingsStore = input.settingsStore ?? getSettingsStore(input.platformEnv);
  // The runtime model, the image role, the browser capability, and the
  // granted website logins resolve independently.
  const [runtimeModel, imageRole, browserCapability, websiteLogins] = await Promise.all([
    resolveRuntimeModel(
      input.assignment.agentId,
      canonicalModel,
      {
        settings: settingsStore,
        ...(input.platformEnv ? { env: input.platformEnv } : {}),
      },
    ),
    resolveAgentModelRoleFromStore({
      role: 'image',
      workspaceId: input.turn.workspaceId,
      agent: { id: input.assignment.agent.id, kind: input.assignment.agent.kind },
      reader: {
        getWorkspaceModelRole: (workspaceId, role) =>
          configStore.getWorkspaceModelRole(workspaceId, role),
        getAgentModelRole: (agentId, role) => configStore.getAgentModelRole(agentId, role),
      },
      ...(input.platformEnv ? { env: input.platformEnv } : {}),
      settings: settingsStore,
    }),
    // A connected hosted browser mounts the browser tools. The key stays in
    // settings and is read again at call time; only the capability is frozen.
    browserCapabilityForTurn(settingsStore, input.platformEnv),
    // Login metadata only; passwords are decrypted at call time.
    websiteLoginsForTurn(settingsStore, input.assignment.agent.websiteLogins),
  ]);
  // The image role is the store's alone. Freezing its bounded capability here
  // is what mounts `generate_image` on the Agent; an unresolved or
  // uncredentialed role freezes an unfilled capability instead.
  const imageCapability = imageCapabilityForResolution(imageRole);
  const runtimeModelRoute = freezeRuntimeModelRoute(
    canonicalModel,
    runtimeModel.providerAuthRoute,
    input.platformEnv,
  );
  const codingWorkspace = workspaceDecision.capability === 'available';
  const codingModel = codingWorkspace
    ? await freezeCodingModelForTurn({
        workspaceId: input.turn.workspaceId,
        agent: input.assignment.agent,
        reader: configStore,
        agentRoute: {
          model: canonicalModel,
          runtimeModel: runtimeModel.model,
          ...(runtimeModelRoute ? { runtimeModelRoute } : {}),
        },
        settings: settingsStore,
        ...(input.platformEnv ? { env: input.platformEnv } : {}),
        agentCredential: input.assignment.modelCredential ?? null,
      })
    : undefined;
  const candidate = compileRuntimePlanV2({
    ...(installation ? { installation } : {}),
    turn: input.turn,
    assignment: input.assignment,
    runtimeModel: runtimeModel.model,
    ...(runtimeModelRoute ? { runtimeModelRoute } : {}),
    imageCapability,
    ...(codingWorkspace ? { codingWorkspace, ...(codingModel ? { codingModel } : {}) } : {}),
    ...(browserCapability ? { browserCapability, websiteLogins } : {}),
    instructions,
    memoryEpoch: await input.memoryEpoch,
    effectiveConnections: connectionResolution.selected,
    ...(connectionAuthorizations ? { connectionAuthorizations } : {}),
    connectionChoices: connectionResolution.ambiguous,
    connectionSelections: connectionResolution.selections,
    ...(teamReconnects ? { teamReconnects } : {}),
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
  return { decision, unavailableFallback: workspaceDecision.unavailableFallback };
}

/**
 * Freeze the coding model for a turn that has a coding workspace. Shared by
 * Slack turns and routines so both coordinators resolve the role the same way.
 */
export async function freezeCodingModelForTurn(input: {
  workspaceId: string;
  agent: { id: string; kind: ResolvedAssignment['agent']['kind'] };
  reader: ModelRoleReader;
  agentRoute: CodingModelAgentRoute;
  settings: SettingsStore;
  env?: PlatformEnv;
  resolveModel?: typeof resolveRuntimeModel;
  /** The credential frozen for the Agent's own model with this turn. */
  agentCredential?: Pick<ModelCredentialAttribution, 'credentialRefId' | 'version' | 'providerId'> | null;
  resolveCredential?: typeof resolveModelCredentialAttribution;
}): Promise<RuntimePlanCodingModelV1> {
  const coding = await resolveCodingModelRoute(input);
  return deploymentServesManyInstallations(input.env) ? withHostedCodingCredential(coding, input) : coding;
}

/**
 * An installation of a deployment serving many runs its coding worker on a
 * frozen credential, as its Agent runs on one: the coding model's own, else
 * the Agent's model and the Agent's credential, as a role whose provider
 * has no key falls back today.
 */
async function withHostedCodingCredential(
  coding: RuntimePlanCodingModelV1,
  input: Parameters<typeof freezeCodingModelForTurn>[0],
): Promise<RuntimePlanCodingModelV1> {
  const agentCredential = input.agentCredential ? frozenModelCredential(input.agentCredential) : undefined;
  if (coding.model === input.agentRoute.model) {
    return agentCredential ? { ...coding, modelCredential: agentCredential } : coding;
  }
  // No key falls back; a store that cannot be read fails the turn, as the
  // Agent's own credential read does.
  const credential = await (input.resolveCredential ?? resolveModelCredentialAttribution)(
    coding.model,
    input.env,
    input.settings,
    undefined,
    { registerUsage: false },
  );
  if (credential) return { ...coding, modelCredential: frozenModelCredential(credential) };
  return {
    ...codingOnAgentModel(input.agentRoute, true),
    ...(agentCredential ? { modelCredential: agentCredential } : {}),
  };
}

async function resolveCodingModelRoute(input: Parameters<typeof freezeCodingModelForTurn>[0]) {
  return resolveCodingModelForPlan({
    workspaceId: input.workspaceId,
    agent: { id: input.agent.id, kind: input.agent.kind },
    reader: {
      getWorkspaceModelRole: (workspaceId, role) =>
        input.reader.getWorkspaceModelRole(workspaceId, role),
      getAgentModelRole: (agentId, role) => input.reader.getAgentModelRole(agentId, role),
    },
    agentRoute: input.agentRoute,
    resolveRoute: async (canonicalModel) => {
      const resolved = await (input.resolveModel ?? resolveRuntimeModel)(
        input.agent.id,
        canonicalModel,
        { settings: input.settings, ...(input.env ? { env: input.env } : {}) },
      );
      const runtimeModelRoute = freezeRuntimeModelRoute(
        canonicalModel,
        resolved.providerAuthRoute,
        input.env,
      );
      return {
        runtimeModel: resolved.model,
        ...(runtimeModelRoute ? { runtimeModelRoute } : {}),
      };
    },
  });
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
 * Who a turn's replies come from (docs/runbooks/slack-message-identity.md):
 * the owner its run froze at admission, or the Agent itself for a turn with
 * no frozen presentation. A `chickpea` owner posts as the installation's
 * bot: no custom name or avatar reaches Slack, and its footer names Chickpea.
 */
function turnReplySender(
  assignment: ResolvedAssignment,
  visibleOwner: SlackPresentationOwner | undefined,
  agentAvatarUrl: string | undefined,
): { agentName: string; agentAvatarUrl?: string } {
  if (visibleOwner?.kind === 'selected_agent') {
    return { agentName: visibleOwner.persona.name, agentAvatarUrl: visibleOwner.persona.avatarUrl };
  }
  if (visibleOwner?.kind === 'chickpea') return { agentName: CHICKPEA_AGENT_NAME };
  return { agentName: assignment.agent.name, ...(agentAvatarUrl ? { agentAvatarUrl } : {}) };
}

/**
 * Deliver ONLY the sanitized generic failure final — the relay alarm's
 * last-ditch on the terminal attempt, when `runTurn` itself kept throwing (a
 * genuine delivery failure, not an agent execution failure, which runTurn
 * already surfaces as a categorized final and returns). Best-effort: the caller swallows
 * its errors (if Slack is the thing that is failing, this post fails too).
 * It posts under the same sender as the turn's replies: `presentation` names
 * the run whose frozen owner decides it, and the settings store whose pinned
 * public URL the replies' footer and avatar use.
 */
export async function deliverAgentFailureFinal(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  client: WebClient,
  platformEnv?: PlatformEnv,
  onPublicMessageDelivered?: RunTurnOptions['onPublicMessageDelivered'],
  presentation?: {
    state?: Pick<SlackPresentationStatePort, 'getRunPresentation'>;
    runId?: string;
    settingsStore?: SettingsStore;
  },
): Promise<void> {
  const resolvedModel = resolvedAssignmentModel(assignment);
  const state = presentation?.state;
  const runId = presentation?.runId;
  const [publicUrl, frozenPresentation] = await Promise.all([
    resolveSlackPublicUrl(platformEnv, presentation?.settingsStore),
    state && runId
      ? (async () => state.getRunPresentation(runId))().catch(() => {
          // The notice still posts, under the sender a turn without one uses.
          console.warn('[chickpea] failure final could not read its run presentation');
          return undefined;
        })
      : undefined,
  ]);
  const visibleOwner = frozenPresentation?.schemaVersion === 3 ? frozenPresentation.owner : undefined;
  const sender = turnReplySender(
    assignment,
    visibleOwner,
    agentAvatarUrlForPresentation(assignment.agent, publicUrl, agentAvatarInstallation(platformEnv)),
  );
  const presenter = new WebClientPresenter(client, {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    ...sender,
    ...(visibleOwner ? { visibleOwner } : {}),
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

export function sanitizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
