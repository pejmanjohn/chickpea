import { createHash } from 'node:crypto';

import type { WebClient } from '@slack/web-api';

import {
  SlackAgentViewPresentation,
  type SlackPresentationStatePort,
} from './agent-view-presentation.ts';
import {
  presentationHasTerminalOutcome,
  type SlackRunPresentationV3,
} from './run-presentations.ts';
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
 * The deferred Slack post is the Run's canonical terminal artifact. Record its
 * acknowledgement first, then reuse the normal repair path to settle the Agent
 * Session and remove any visible activity.
 */
export async function acknowledgeDeferredTerminalSlackDelivery(input: {
  runId: string;
  state: SlackPresentationStatePort;
  client: WebClient;
}): Promise<SlackRunPresentationV3 | undefined> {
  let presentation = await input.state.getRunPresentation(input.runId);
  if (presentation?.schemaVersion !== 3) return undefined;
  const agentName = presentation.owner.kind === 'selected_agent'
    ? presentation.owner.persona.name
    : 'Chickpea';
  const agentView = new SlackAgentViewPresentation({
    client: input.client,
    state: input.state,
    runId: presentation.runId,
    runFencingToken: presentation.runFencingToken,
    footer: { agentName, agentId: 'agent_default' },
  });
  if (presentation.terminalDelivery.state === 'none') {
    await agentView.prepareDeferredTerminalDelivery('answer');
    presentation = await input.state.getRunPresentation(input.runId);
  }
  if (presentation?.schemaVersion !== 3 ||
      presentation.terminalDelivery.state !== 'intended') return undefined;
  await agentView.recordTerminalDeliveryReceipt('acknowledged');
  const acknowledged = await input.state.getRunPresentation(input.runId);
  if (acknowledged?.schemaVersion !== 3) return undefined;
  return repairTerminalSlackPresentation(acknowledged, input.state, input.client);
}

/** Close lifecycle honestly when the durable deferred post is terminally undeliverable. */
export async function abandonDeferredTerminalSlackDelivery(input: {
  runId: string;
  state: SlackPresentationStatePort;
  resolveClient(workspaceId: string): Promise<WebClient>;
}): Promise<SlackRunPresentationV3 | undefined> {
  const abandoned = await recordDeferredTerminalAbandonment(input.runId, input.state);
  if (!abandoned) return undefined;
  const client = await input.resolveClient(abandoned.root.workspaceId);
  return repairTerminalSlackPresentation(abandoned, input.state, client);
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
  if (presentation.terminalDelivery.state === 'none') return presentation;
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
  if (!presentation.repairRequired || !presentationHasTerminalOutcome(presentation)) return false;
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

async function recordDeferredTerminalAbandonment(
  runId: string,
  state: SlackPresentationStatePort,
): Promise<SlackRunPresentationV3 | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const presentation = await state.getRunPresentation(runId);
    if (presentation?.schemaVersion !== 3) return undefined;
    if (presentation.terminalDelivery.state === 'abandoned' ||
        presentation.terminalDelivery.state === 'intended' &&
          presentation.terminalDelivery.operation.certainty === 'acknowledged') {
      return presentation;
    }
    const mutation = presentation.terminalDelivery.state === 'none'
      ? {
          kind: 'record_terminal_delivery_intent' as const,
          operationId: `terminal_${hash(`${presentation.runId}:answer:1`).slice(0, 24)}`,
          result: 'answer' as const,
        }
      : {
          kind: 'abandon_terminal_delivery' as const,
          operationId: presentation.terminalDelivery.operation.operationId,
        };
    const result = await state.transitionRunPresentation({
      runId: presentation.runId,
      workBindingGeneration: presentation.workBindingGeneration,
      runFencingToken: presentation.runFencingToken,
      expectedProjectionVersion: presentation.projectionVersion,
      expectedStreamState: presentation.stream.state,
      mutation,
    });
    if (result.outcome === 'applied' && result.presentation.schemaVersion === 3 &&
        result.presentation.terminalDelivery.state === 'abandoned') {
      return result.presentation;
    }
  }
  throw new Error('Slack deferred terminal abandonment lost its presentation fence.');
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function earlier(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.min(current, candidate);
}
