import { AgentStore, AssignmentStore, resolveAssignment } from '../config/resolver.ts';
import { seededAgents } from '../config/seed.ts';
import type { ProviderId, ResolvedAssignment } from '../config/types.ts';
import { ProviderRegistry } from '../providers/deterministic.ts';
import type { ProviderResponse } from '../providers/types.ts';
import type { WorkersAiRestProviderOptions } from '../providers/workers-ai-rest.ts';
import { EventDedupeLedger } from '../slack/dedupe.ts';
import { renderSlackMessage, type SlackReplyFormat } from '../slack/message-format.ts';
import {
  LocalSlackReplySink,
  type SlackFinalDelivery,
  type SlackPresentationContext,
  type SlackPresentationEvent,
  type SlackPresentationStage,
  type SlackReplyPost,
  type SlackReplySink,
} from '../slack/replies.ts';
import {
  currentMessageOnlyContext,
  NoopSlackContextClient,
  type SlackContextClient,
  type SlackTurnContext,
} from '../slack/thread-context.ts';
import { slackThreadKey } from '../slack/thread-key.ts';
import { normalizeSlackTurn } from '../slack/turn-normalization.ts';
import type { NormalizedSlackTurn, SlackEventFixture, SlackTurnIgnoreReason } from '../slack/types.ts';
import { runAllowedTool, type ToolRunResult } from '../tools/safe-tools.ts';
import { ThreadSessionStore, type SessionView } from './session-store.ts';
import { TelemetryStore, type TurnTelemetry } from './telemetry.ts';

export type { SlackEventFixture } from '../slack/types.ts';

export interface DemoEnvironment {
  agentStore: AgentStore;
  assignmentStore: AssignmentStore;
  dedupe: EventDedupeLedger;
  sessions: ThreadSessionStore;
  replies: SlackReplySink;
  providers: ProviderRegistry;
  slackContext: SlackContextClient;
  telemetry: TelemetryStore;
  presentationDelayMs: number;
  now: () => number;
  botUserId?: string;
}

export interface SlackRunOptions {
  providerId: ProviderId;
}

export interface SlackRunResult {
  status: 'handled' | 'duplicate';
  assignment: ResolvedAssignment;
  session: SessionView;
  provider: {
    providerId: ProviderId;
    model: string;
  };
  finalReply: SlackReplyPost;
  telemetry: TurnTelemetry;
}

export interface SlackIgnoredRunResult {
  status: 'ignored';
  reason: SlackTurnIgnoreReason | 'unknown_thread';
  eventId: string;
}

export type SlackTurnResult = SlackRunResult | SlackIgnoredRunResult;

interface SlackPresentationRunState {
  degradations: string[];
  statusFailed: boolean;
  statusWasSet: boolean;
}

interface SlackRunnableState {
  assignment: ResolvedAssignment;
  session: SessionView;
  provider: ReturnType<ProviderRegistry['get']>;
}

export function createDemoEnvironment(
  options: {
    now?: () => number;
    replies?: SlackReplySink;
    providers?: ProviderRegistry;
    slackContext?: SlackContextClient;
    workersAi?: WorkersAiRestProviderOptions;
    presentationDelayMs?: number;
    botUserId?: string;
  } = {},
): DemoEnvironment {
  const firstAgent = seededAgents[0];
  if (!firstAgent) {
    throw new Error('Seeded demo agent is missing');
  }

  return {
    agentStore: new AgentStore(),
    assignmentStore: new AssignmentStore(),
    dedupe: new EventDedupeLedger(),
    sessions: new ThreadSessionStore(),
    replies: options.replies ?? new LocalSlackReplySink(),
    providers:
      options.providers ??
      new ProviderRegistry(
        firstAgent.defaultModels,
        options.workersAi ? { workersAi: options.workersAi } : {},
      ),
    slackContext: options.slackContext ?? new NoopSlackContextClient(),
    telemetry: new TelemetryStore(),
    presentationDelayMs: options.presentationDelayMs ?? 0,
    now: options.now ?? Date.now,
    ...(options.botUserId ? { botUserId: options.botUserId } : {}),
  };
}

export async function handleSlackAppMention(
  payload: SlackEventFixture,
  env: DemoEnvironment,
  options: SlackRunOptions,
): Promise<SlackRunResult> {
  const result = await handleSlackTurn(payload, env, options);
  if (result.status === 'ignored') {
    throw new Error(`Expected runnable Slack app_mention event, got ignored ${result.reason}`);
  }
  return result;
}

export async function handleSlackTurn(
  payload: SlackEventFixture,
  env: DemoEnvironment,
  options: SlackRunOptions,
): Promise<SlackTurnResult> {
  const receivedAt = env.now();
  const normalization = normalizeSlackTurn(payload, env.botUserId ? { botUserId: env.botUserId } : {});
  if (normalization.status === 'ignored') {
    return {
      status: 'ignored',
      reason: normalization.reason,
      eventId: payload.event_id,
    };
  }

  const turn = normalization.turn;
  const runtime = resolveRunnableState(turn, env, options, receivedAt);
  if ('status' in runtime) {
    return runtime;
  }

  const { assignment, provider, session } = runtime;
  const threadKey = slackThreadKey(turn);

  if (!env.dedupe.claim(turn.eventId)) {
    const previousFinal = env.dedupe.finalReply(turn.eventId);
    return {
      status: 'duplicate',
      assignment,
      session,
      provider: {
        providerId: provider.providerId,
        model: provider.model,
      },
      finalReply:
        previousFinal ??
        createSyntheticReply(
          turn,
          'Duplicate event acknowledged.',
          env.now(),
          'plain_text',
        ),
      telemetry: {
        firstVisibleResponseKind: 'slack_progress',
        timeToFirstVisibleResponseMs: 0,
        providerId: provider.providerId,
        model: provider.model,
        totalLatencyMs: 0,
      },
    };
  }

  let completed = false;

  try {
    const presentation: SlackPresentationRunState = {
      degradations: [],
      statusFailed: false,
      statusWasSet: false,
    };
    const firstVisible = await startVisibleWork(env, turn, assignment.agent.name, presentation);
    const slackContext = await hydrateSlackContext(env, turn, presentation);

    let providerResponse: ProviderResponse;
    try {
      const toolResults = await collectAllowedToolResults(
        assignment,
        turn.channelId,
        turn.text,
        async (stage) => {
          await setStageStatus(env, turn, stage, presentation);
        },
      );
      await setStageStatus(env, turn, 'generating_answer', presentation);

      providerResponse = await provider.generate({
        agent: assignment.agent,
        message: turn.text,
        session,
        toolResults,
        slackContext,
      });
    } catch (error) {
      await setStageStatus(env, turn, 'provider_failed', presentation);
      const finalDelivery = await deliverFinalWithCleanup(
        env,
        turn,
        providerFailureText(error),
        presentation,
        'plain_text',
      );

      const telemetry = buildTurnTelemetry({
        firstVisible,
        receivedAt,
        finalDelivery,
        providerId: provider.providerId,
        model: provider.model,
        degradations: presentation.degradations,
      });
      env.telemetry.recordTurn(telemetry);
      env.dedupe.complete(turn.eventId, finalDelivery.finalReply);
      completed = true;

      return {
        status: 'handled',
        assignment,
        session,
        provider: {
          providerId: provider.providerId,
          model: provider.model,
        },
        finalReply: finalDelivery.finalReply,
        telemetry,
      };
    }

    const finalDelivery = await deliverFinalWithCleanup(
      env,
      turn,
      providerResponse.text,
      presentation,
      'markdown',
    );
    const updatedSession = env.sessions.incrementTurn(threadKey);

    env.telemetry.recordModelCall({
      providerId: providerResponse.providerId,
      model: providerResponse.model,
      latencyMs: providerResponse.latencyMs,
      inputTokens: providerResponse.usage.inputTokens,
      outputTokens: providerResponse.usage.outputTokens,
    });

    const telemetry = buildTurnTelemetry({
      firstVisible,
      receivedAt,
      finalDelivery,
      providerId: providerResponse.providerId,
      model: providerResponse.model,
      degradations: presentation.degradations,
    });
    env.telemetry.recordTurn(telemetry);
    env.dedupe.complete(turn.eventId, finalDelivery.finalReply);
    completed = true;

    return {
      status: 'handled',
      assignment,
      session: {
        ...updatedSession,
        isNew: session.isNew,
      },
      provider: {
        providerId: providerResponse.providerId,
        model: providerResponse.model,
      },
      finalReply: finalDelivery.finalReply,
      telemetry,
    };
  } catch (error) {
    if (!completed) {
      env.dedupe.release(turn.eventId);
    }
    throw error;
  }
}

function resolveRunnableState(
  turn: NormalizedSlackTurn,
  env: DemoEnvironment,
  options: SlackRunOptions,
  receivedAt: number,
): SlackRunnableState | SlackIgnoredRunResult {
  const threadKey = slackThreadKey(turn);
  if (turn.source === 'implicit_thread_reply') {
    const existing = env.sessions.getExisting(threadKey);
    if (!existing) {
      return {
        status: 'ignored',
        reason: 'unknown_thread',
        eventId: turn.eventId,
      };
    }
    const provider = env.providers.get(existing.snapshot.providerId);
    return {
      assignment: assignmentFromSession(turn, existing),
      session: existing,
      provider,
    };
  }

  const initialAssignment = resolveAssignment(turn.workspaceId, turn.channelId, {
    agents: env.agentStore,
    assignments: env.assignmentStore,
  });
  const initialProvider = env.providers.get(options.providerId);
  const session = env.sessions.getOrCreate({
    threadKey,
    agent: initialAssignment.agent,
    providerId: options.providerId,
    model: initialProvider.model,
    now: receivedAt,
  });
  const provider = session.isNew
    ? initialProvider
    : env.providers.get(session.snapshot.providerId);

  return {
    assignment: session.isNew ? initialAssignment : assignmentFromSession(turn, session),
    session,
    provider,
  };
}

function assignmentFromSession(
  turn: NormalizedSlackTurn,
  session: SessionView,
): ResolvedAssignment {
  return {
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    agentId: session.snapshot.agent.id,
    agent: session.snapshot.agent,
  };
}

async function hydrateSlackContext(
  env: DemoEnvironment,
  turn: NormalizedSlackTurn,
  presentation: SlackPresentationRunState,
): Promise<SlackTurnContext> {
  try {
    const context = await env.slackContext.hydrate(turn);
    presentation.degradations.push(...context.degradations);
    return context;
  } catch (error) {
    const context = currentMessageOnlyContext(turn, [
      `slack_context.${turn.contextMode}:${sanitizeContextError(error)}`,
    ]);
    presentation.degradations.push(...context.degradations);
    return context;
  }
}

async function collectAllowedToolResults(
  assignment: ResolvedAssignment,
  channelId: string,
  text: string,
  onStage?: (stage: SlackPresentationStage) => Promise<void>,
): Promise<ToolRunResult[]> {
  if (!text.toLowerCase().includes('channel context')) {
    return [];
  }

  await onStage?.('gathering_channel_context');
  const result = await runAllowedTool(assignment.agent, 'lookup_channel_brief', { channelId });
  await onStage?.('channel_context_ready');
  return [result];
}

function providerFailureText(error: unknown): string {
  void error;
  return 'I reached the Slack thread, but the model provider call failed before completion. I did not expose provider error details in Slack.';
}

async function startVisibleWork(
  env: DemoEnvironment,
  turn: NormalizedSlackTurn,
  agentName: string,
  presentation: SlackPresentationRunState,
): Promise<Pick<TurnTelemetry, 'firstVisibleResponseKind'> & { postedAt: number }> {
  const status = await trySetStageStatus(env, turn, 'checking_context', presentation);
  if (status?.ok) {
    return {
      firstVisibleResponseKind: 'slack_status',
      postedAt: status.postedAt,
    };
  }

  const progress = await env.replies.post('progress', {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    text: `${agentName} is checking the Slack thread context.`,
    postedAt: env.now(),
  });
  return {
    firstVisibleResponseKind: 'slack_progress',
    postedAt: progress.postedAt,
  };
}

async function setStageStatus(
  env: DemoEnvironment,
  turn: NormalizedSlackTurn,
  stage: SlackPresentationStage,
  presentation: SlackPresentationRunState,
): Promise<void> {
  await trySetStageStatus(env, turn, stage, presentation);
}

async function trySetStageStatus(
  env: DemoEnvironment,
  turn: NormalizedSlackTurn,
  stage: SlackPresentationStage,
  presentation: SlackPresentationRunState,
): Promise<SlackPresentationEvent | undefined> {
  if (!env.replies.setStatus || presentation.statusFailed) {
    return undefined;
  }

  const result = await env.replies.setStatus(presentationContext(env, turn), stage);
  if (result.ok) {
    presentation.statusWasSet = true;
    await waitForPresentationDelay(env);
    return result;
  }

  presentation.statusFailed = true;
  presentation.degradations.push(`assistant.threads.setStatus:${result.error ?? 'unknown_error'}`);
  return result;
}

async function deliverFinalWithCleanup(
  env: DemoEnvironment,
  turn: NormalizedSlackTurn,
  text: string,
  presentation: SlackPresentationRunState,
  format: SlackReplyFormat,
): Promise<SlackFinalDelivery> {
  try {
    return await deliverFinal(env, turn, text, presentation.degradations, format);
  } finally {
    if (env.replies.clearStatus && presentation.statusWasSet) {
      const cleared = await env.replies.clearStatus(presentationContext(env, turn));
      if (!cleared.ok) {
        presentation.degradations.push(`assistant.threads.setStatus.clear:${cleared.error ?? 'unknown_error'}`);
      }
    }
  }
}

async function deliverFinal(
  env: DemoEnvironment,
  turn: NormalizedSlackTurn,
  text: string,
  degradations: string[],
  format: SlackReplyFormat,
): Promise<SlackFinalDelivery> {
  const context = presentationContext(env, turn);
  if (env.replies.deliverFinal) {
    const delivery = await env.replies.deliverFinal(context, text, format);
    degradations.push(...delivery.degradations);
    return delivery;
  }

  const finalReply = await env.replies.post('final', {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    text,
    postedAt: env.now(),
    format,
  });
  return {
    finalReply,
    deliveryMode: 'fallback_post',
    degradations: [],
  };
}

function presentationContext(env: DemoEnvironment, turn: NormalizedSlackTurn): SlackPresentationContext {
  return {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    workspaceId: turn.workspaceId,
    userId: turn.userId,
    postedAt: env.now(),
  };
}

async function waitForPresentationDelay(env: DemoEnvironment): Promise<void> {
  if (env.presentationDelayMs <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, env.presentationDelayMs));
}

function buildTurnTelemetry(input: {
  firstVisible: Pick<TurnTelemetry, 'firstVisibleResponseKind'> & { postedAt: number };
  receivedAt: number;
  finalDelivery: SlackFinalDelivery;
  providerId: ProviderId;
  model: string;
  degradations: string[];
}): TurnTelemetry {
  return {
    firstVisibleResponseKind: input.firstVisible.firstVisibleResponseKind,
    timeToFirstVisibleResponseMs: input.firstVisible.postedAt - input.receivedAt,
    providerId: input.providerId,
    model: input.model,
    totalLatencyMs: input.finalDelivery.finalReply.postedAt - input.receivedAt,
    deliveryMode: input.finalDelivery.deliveryMode,
    degradations: [...input.degradations],
  };
}

function createSyntheticReply(
  turn: NormalizedSlackTurn,
  text: string,
  postedAt: number,
  format: SlackReplyFormat,
): SlackReplyPost {
  return {
    kind: 'final',
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    text,
    postedAt,
    format,
    rendered: renderSlackMessage(text, format),
  };
}

function sanitizeContextError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120);
}
