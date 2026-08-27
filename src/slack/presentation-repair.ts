import type { WebClient } from '@slack/web-api';

import {
  SlackAgentViewPresentation,
  type SlackPresentationStatePort,
} from './agent-view-presentation.ts';
import type { SlackRunPresentationV3 } from './run-presentations.ts';
import { WebClientPresenter } from './web-client-presenter.ts';

export interface SlackPresentationRepairDrainOptions {
  presentations: readonly SlackRunPresentationV3[];
  state: SlackPresentationStatePort;
  resolveClient(workspaceId: string): Promise<WebClient>;
  now?: () => number;
  onFailure?(presentation: SlackRunPresentationV3, error: unknown): void;
}

export const SLACK_PRESENTATION_REPAIR_MIN_BACKOFF_MS = 30_000;
export const SLACK_PRESENTATION_REPAIR_MAX_BACKOFF_MS = 15 * 60_000;

export interface SlackPresentationRepairDrainResult {
  attempted: number;
  retryableRemaining: number;
  nextRetryAt?: number;
}

/**
 * Retry only idempotent post-terminal effects with confirmed non-delivery.
 * Pending or unknown receipts remain quarantined because Slack may already
 * have applied them.
 */
export async function drainSlackPresentationRepairs(
  options: SlackPresentationRepairDrainOptions,
): Promise<SlackPresentationRepairDrainResult> {
  const now = options.now?.() ?? Date.now();
  let attempted = 0;
  let retryableRemaining = 0;
  let nextRetryAt: number | undefined;
  for (const presentation of options.presentations) {
    if (!hasRetryableTerminalRepair(presentation)) continue;
    if (presentation.repair?.nextRetryAt !== undefined &&
        presentation.repair.nextRetryAt > now) {
      retryableRemaining += 1;
      nextRetryAt = earlier(nextRetryAt, presentation.repair.nextRetryAt);
      continue;
    }
    attempted += 1;
    const scheduledRetryAt = now + presentationRepairBackoffMs(
      (presentation.repair?.attempts ?? 0) + 1,
    );
    try {
      const scheduled = await recordRepairAttempt(
        presentation,
        options.state,
        scheduledRetryAt,
      );
      const client = await options.resolveClient(presentation.root.workspaceId);
      const repaired = await repairTerminalSlackPresentation(
        scheduled,
        options.state,
        client,
      );
      if (hasRetryableTerminalRepair(repaired)) {
        retryableRemaining += 1;
        nextRetryAt = earlier(nextRetryAt, scheduledRetryAt);
      }
    } catch (error) {
      retryableRemaining += 1;
      nextRetryAt = earlier(nextRetryAt, scheduledRetryAt);
      options.onFailure?.(presentation, error);
    }
  }
  return {
    attempted,
    retryableRemaining,
    ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
  };
}

export async function repairTerminalSlackPresentation(
  presentation: SlackRunPresentationV3,
  state: SlackPresentationStatePort,
  client: WebClient,
): Promise<SlackRunPresentationV3> {
  if (!hasRetryableTerminalRepair(presentation)) return presentation;
  if (presentation.terminalDelivery.state !== 'intended') return presentation;
  const terminalResult = presentation.terminalDelivery.result === 'failure'
    ? 'failure'
    : 'answer';
  const agentName = presentation.owner.kind === 'selected_agent'
    ? presentation.owner.persona.name
    : 'Chickpea';
  const agentView = new SlackAgentViewPresentation({
    client,
    state,
    runId: presentation.runId,
    runFencingToken: presentation.runFencingToken,
    footer: { agentName, agentId: 'agent_default' },
  });
  const presenter = new WebClientPresenter(client, {
    channelId: presentation.root.channelId,
    threadTs: presentation.root.threadTs,
    agentName,
    visibleOwner: presentation.owner,
    agentId: 'agent_default',
    userId: presentation.root.requesterUserId,
    workspaceId: presentation.root.workspaceId,
  }, undefined, {
    agentViewPresentation: agentView,
    activityProjection: presentation.activityProjection,
    ...(presentation.currentActivity?.operation.certainty === 'unknown'
      ? { activityMayBeVisible: true }
      : {}),
  });

  const latestGeneration = await state.getLatestThreadSessionGeneration(presentation.root);
  if (latestGeneration === undefined || latestGeneration < presentation.sessionGeneration) {
    throw new Error('Slack presentation repair could not prove the latest thread generation.');
  }
  const ownsSharedEffects = latestGeneration === presentation.sessionGeneration;
  if (ownsSharedEffects) {
    await agentView.settleAgentSession(terminalResult);
  } else {
    await agentView.supersedeSharedRepairEffects();
  }
  const cleanup = await agentView.prepareActivityCleanup();
  if (cleanup.kind === 'prepared' &&
      (ownsSharedEffects || cleanup.projection.surface === 'message')) {
    const certainty = await presenter.clearStatus();
    await agentView.recordActivityCleanupReceipt(cleanup.operationId, certainty);
  }
  await agentView.settleLifecycle();

  const repaired = await state.getRunPresentation(presentation.runId);
  if (repaired?.schemaVersion !== 3) {
    throw new Error('Slack presentation repair lost its V3 state.');
  }
  return repaired;
}

export function hasRetryableTerminalRepair(
  presentation: SlackRunPresentationV3,
): boolean {
  if (!presentation.repairRequired ||
      presentation.terminalDelivery.state !== 'intended' ||
      presentation.terminalDelivery.operation.certainty !== 'acknowledged') return false;
  const session = presentation.agentSession.operation;
  const lifecycleRepairable = presentation.lifecyclePhase !== 'settled';
  const sessionRepairable = !presentation.agentSession.disposition &&
    (!session || session.certainty === 'failed');
  const ambiguousNativeActivity = presentation.activityProjection.surface ===
      'assistant_status' && presentation.activityProjection.state === 'unavailable' &&
    presentation.currentActivity?.operation.certainty === 'unknown';
  const cleanupRepairable = (presentation.activityProjection.state === 'visible' ||
      ambiguousNativeActivity) &&
    (presentation.cleanup.state === 'not_required'
      ? presentation.cleanup.disposition === undefined
      : presentation.cleanup.operation.certainty === 'failed');
  return lifecycleRepairable || sessionRepairable || cleanupRepairable;
}

function presentationRepairBackoffMs(attempt: number): number {
  const exponent = Math.max(0, Math.min(20, attempt - 1));
  return Math.min(
    SLACK_PRESENTATION_REPAIR_MAX_BACKOFF_MS,
    SLACK_PRESENTATION_REPAIR_MIN_BACKOFF_MS * (2 ** exponent),
  );
}

async function recordRepairAttempt(
  presentation: SlackRunPresentationV3,
  state: SlackPresentationStatePort,
  nextRetryAt: number,
): Promise<SlackRunPresentationV3> {
  const result = await state.transitionRunPresentation({
    runId: presentation.runId,
    workBindingGeneration: presentation.workBindingGeneration,
    runFencingToken: presentation.runFencingToken,
    expectedProjectionVersion: presentation.projectionVersion,
    expectedStreamState: presentation.stream.state,
    mutation: { kind: 'record_repair_attempt', nextRetryAt },
  });
  if (result.outcome !== 'applied' || result.presentation.schemaVersion !== 3) {
    throw new Error('Slack presentation repair attempt lost its V3 state.');
  }
  return result.presentation;
}

function earlier(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.min(current, candidate);
}
