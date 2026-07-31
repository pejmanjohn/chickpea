import { WebClient } from '@slack/web-api';

import { resolveAgentModel } from '../config/model-policy.ts';
import { getGithubConnection } from '../config/github-app.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { resolveSandboxSettings } from '../config/sandbox-settings.ts';
import { getSettingsStore, getUsageStore, getWorkStore } from '../config/state-backend.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type {
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
  AgentPromptFailure,
  promptSlackThreadAgent,
  releaseCloudflareSandboxTurn,
  type AgentDispatchResult,
} from './agent-dispatch.ts';
import { resolveSlackCredentials, resolveSlackPublicUrl } from './credentials.ts';
import type { SlackStatusUpdate } from './replies.ts';
import { registerSlackStatusTurn } from './status-registry.ts';
import type { SlackTurnContext } from './thread-context.ts';
import { slackThreadKey } from './thread-key.ts';
import type { NormalizedSlackTurn } from './types.ts';
import { selectSandbox } from '../sandbox/select.ts';
import {
  assembleSlackPrompt,
  hydrateSlackContextViaWebClient,
} from './web-client-context.ts';
import {
  AGENT_FAILURE_TEXT,
  OPENAI_SUBSCRIPTION_POLICY_TEXT,
  OPENAI_SUBSCRIPTION_QUOTA_TEXT,
  OPENAI_SUBSCRIPTION_RECONNECT_TEXT,
  PROVIDER_FAILURE_TEXT,
  SANDBOX_FAILURE_TEXT,
  SANDBOX_SESSION_CAP_FAILURE_TEXT,
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
 * Build a `@slack/web-api` WebClient with the two workerd fetch fixes the app
 * needs (both no-ops on node). Extracted so the cached channel client and the
 * relay alarm's freshly-resolved client are constructed identically:
 *   1. The WebClient calls its stored fetch as a method (`this.fetchFn(...)`);
 *      workerd rejects fetch invoked with any receiver but globalThis, so we
 *      wrap it to call `globalThis.fetch`.
 *   2. It hardcodes `redirect: 'error'`, which workerd refuses (only
 *      'follow'/'manual' exist at the edge). Slack never redirects, so
 *      'manual' is equivalent without the unsupported value.
 * `retryConfig` is pinned to no retries (deterministic; no 30-minute backoff on
 * a transient upstream). `slackApiUrl` (must end with `/`) lets the offline
 * verification point at a fake Slack.
 */
export function createSlackWebClient(botToken: string | undefined): WebClient {
  const slackApiUrl = process.env.SLACK_API_URL;
  return new WebClient(botToken, {
    retryConfig: { retries: 0 },
    // The SDK default is no timeout. Bound every Slack request so an upstream
    // connection cannot hold a durable turn claim or adapter cleanup forever.
    timeout: 10_000,
    fetch: (input, init) => {
      const patchedInit =
        isCloudflareTarget() && init?.redirect === 'error'
          ? { ...init, redirect: 'manual' as RequestRedirect }
          : init;
      return globalThis.fetch(input, patchedInit);
    },
    ...(slackApiUrl ? { slackApiUrl } : {}),
  });
}

/**
 * Lazily-constructed outbound Slack client, keyed by the RESOLVED bot token
 * (env > wizard-stored; see credentials.ts). Resolving at first use keeps the
 * cloudflare build from binding a token at import time and — because the cache
 * is token-keyed — makes a wizard save take effect on the next event instead of
 * pinning the first-seen token for the isolate's lifetime.
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
  /** Focused-test override for proving replay and delivery lifecycle behavior. */
  agentPrompt?: typeof promptSlackThreadAgent;
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
 *   3. prompt the durable agent in-process (slack/agent-dispatch.ts) with the
 *      trigger text + hydrated (bot-filtered) context rows,
 *   4. stream the final (fallback to a markdown post), and clear status.
 * An agent/provider/workspace failure is delivered as category-specific static
 * copy (no internal error text ever reaches Slack) and the turn still
 * completes. `runTurn` throws ONLY on a genuine delivery failure, so the
 * caller (node .catch / relay alarm) can release the claims for a retry.
 */
export async function runTurn(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  platformEnv: PlatformEnv | undefined,
  options: RunTurnOptions = {},
): Promise<void> {
  const client = options.client ?? (await getClient(platformEnv));
  // A frozen assignment (from a thread snapshot) carries its model; otherwise
  // resolve it from the agent via policy.
  const resolvedModel = assignment.model ?? tryResolveAgentModel(assignment.agent);
  const ledgerAuthority = options.executionAuthority === 'ledger';
  // env (SLACK_TAG_PUBLIC_URL) → stored slack.publicUrl (the origin the admin
  // pinned): on a button deploy nobody sets the env var, so without the stored
  // fallback the footer's "Configure" link would be dead.
  const publicUrl = await resolveSlackPublicUrl(platformEnv);
  // Natural-language Routine intent still runs through the legacy Workflow
  // coordinator. A selected ledger canary deliberately skips that pre-parser;
  // explicit Routine commands are kept off this lane at admission.
  if (!ledgerAuthority && isRoutineSlackTurn(turn)) {
    const routineText = await handleRoutineSlackRequest(turn, platformEnv);
    if (routineText !== undefined) {
      const routinePresenter = new WebClientPresenter(client, {
        channelId: turn.channelId,
        threadTs: turn.threadTs,
        agentName: assignment.agent.name,
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
  const preparedMemory = memoryCommand
    ? undefined
    : await prepareMemoryTurn({ turn, platformEnv, client });
  const conversationKey = preparedMemory?.conversationKey ?? slackThreadKey(turn);
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
        flueInstanceRef: opaqueId('flueinstance', agentConversationKey),
        platformEnv,
        ...(options.workStore ? { workStore: options.workStore } : {}),
        ...(options.settingsStore ? { settingsStore: options.settingsStore } : {}),
        mode: ledgerAuthority ? 'enforce' : 'observe',
      })
    : undefined;
  const presenter = new WebClientPresenter(client, {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    agentName: assignment.agent.name,
    agentId: assignment.agent.id,
    modelLabel: resolvedModel,
    publicUrl,
    userId: turn.userId,
    workspaceId: turn.workspaceId,
    ...(preparedMemory ? { memoryFooterItems: preparedMemory.footerItems } : {}),
  }, workLifecycle, { deliverySafety: ledgerAuthority ? 'ledger' : 'legacy' });
  const statusGeneration = options.turnId ?? `msg:${turn.channelId}:${turn.messageTs}`;
  const statusTurn = registerSlackStatusTurn(agentConversationKey, presenter, {
    generation: statusGeneration,
  });
  const finishStatus = (): void => {
    // Close the sink first. Agent observations are relayed best-effort from a
    // different Cloudflare isolate and may still arrive after ?wait=result
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
    if (workChecklistTs && workChecklist) {
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

  // 1. Visible work: set status; if it is rejected, post a durable progress
  //    placeholder so the user still sees work in-flight before the final.
  try {
    if (memoryCommand) {
      const handled = await handleMemoryCommand({ turn, platformEnv, client, presenter });
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
    //    failures surface as non-2xx ?wait=result envelopes; we deliver only
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
        usedCloudflareSandbox = await shouldUseCloudflareSandbox(assignment, platformEnv);
        agentResult = await (options.agentPrompt ?? promptSlackThreadAgent)(
          agentConversationKey,
          executionPrompt,
          platformEnv,
          statusGeneration,
          usedCloudflareSandbox,
          resolvedModel ?? null,
          workLifecycle && options.runId
            ? {
                runId: options.runId,
                runExecutionId: workLifecycle.executionId,
                mode: ledgerAuthority ? 'enforce' : 'observe',
              }
            : undefined,
        );
        text = agentResult.text;
        await workLifecycle?.settleExecution({
          outcome: 'succeeded',
          rawStatus: 'flue_succeeded',
          ...(agentResult.flueSubmissionRef
            ? { flueSubmissionRef: agentResult.flueSubmissionRef }
            : {}),
        });
        await usageRecorder?.recordSuccess(agentResult);
      } catch (err) {
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
          await presenter.deliverFinal(recoveredText, 'markdown');
          await finishDelivery();
          return;
        }
        await presenter.deliverFinal(agentFailureText(err), 'plain_text');
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
    text = resolveMemoryDeliveryText(
      text,
      recoveredText,
      leaseValid,
    );
    finishStatus();
    await presenter.deliverFinal(text, 'markdown');
    await finishDelivery();
  } catch (err) {
    await usageRecorder?.recordFailure();
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
    agentId: assignment.agent.id,
    modelLabel: assignment.model ?? tryResolveAgentModel(assignment.agent),
    userId: turn.userId,
    workspaceId: turn.workspaceId,
  });
  const checklistProgress = progress.checklist;
  if (checklistProgress?.cleanup === 'pending') {
    const intent = turn.interactionIntent;
    if (intent?.disposition === 'work') {
      await presenter.updateWorkChecklist(
        checklistProgress.messageTs,
        intent.checklist,
        checklistProgress.terminal === 'error' ? 'failed' : true,
      );
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
    input.turn.channelType === 'app_home' ||
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
    profileId: input.assignment.agentId,
    profileLabel: input.assignment.agent.name,
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
  if (!isCloudflareTarget()) return false;
  const repositories = assignment.agent.repositories ?? [];
  if (repositories.length === 0) return false;

  try {
    const settingsStore = getSettingsStore(env);
    const [settings, connection] = await Promise.all([
      resolveSandboxSettings(settingsStore),
      getGithubConnection(settingsStore),
    ]);
    return selectSandbox({
      target: 'cloudflare',
      enabled: settings.enabled,
      appConnected: connection.mode === 'app',
      repositoryGrants: repositories,
    }) === 'cloudflare';
  } catch {
    // The agent factory resolves the same live settings and will fail closed.
    // Avoid touching a container when its policy cannot be established here.
    return false;
  }
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

export function agentFailureText(err: unknown): string {
  if (!(err instanceof AgentPromptFailure)) return AGENT_FAILURE_TEXT;
  if (err.kind === 'provider') return PROVIDER_FAILURE_TEXT;
  if (err.kind === 'openai-subscription-reconnect') return OPENAI_SUBSCRIPTION_RECONNECT_TEXT;
  if (err.kind === 'openai-subscription-quota') return OPENAI_SUBSCRIPTION_QUOTA_TEXT;
  if (err.kind === 'openai-subscription-policy') return OPENAI_SUBSCRIPTION_POLICY_TEXT;
  if (err.kind === 'sandbox') return SANDBOX_FAILURE_TEXT;
  if (err.kind === 'sandbox-session-cap') return SANDBOX_SESSION_CAP_FAILURE_TEXT;
  return AGENT_FAILURE_TEXT;
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
  const presenter = new WebClientPresenter(client, {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    agentName: assignment.agent.name,
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
