import { AgentStore, AssignmentStore, resolveAssignment } from '../config/resolver.ts';
import { seededAgents } from '../config/seed.ts';
import type { ProviderId, ResolvedAssignment } from '../config/types.ts';
import { ProviderRegistry } from '../providers/deterministic.ts';
import type { ProviderResponse } from '../providers/types.ts';
import type { WorkersAiRestProviderOptions } from '../providers/workers-ai-rest.ts';
import { EventDedupeLedger } from '../slack/dedupe.ts';
import {
  LocalSlackReplySink,
  type SlackFinalDelivery,
  type SlackPresentationContext,
  type SlackPresentationEvent,
  type SlackPresentationStage,
  type SlackReplyPost,
  type SlackReplySink,
} from '../slack/replies.ts';
import type { NormalizedSlackMention, SlackEventFixture } from '../slack/types.ts';
import { normalizeAppMention, slackThreadKey } from '../slack/thread-key.ts';
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
  telemetry: TelemetryStore;
  presentationDelayMs: number;
  now: () => number;
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

interface SlackPresentationRunState {
  degradations: string[];
  statusFailed: boolean;
  statusWasSet: boolean;
}

export function createDemoEnvironment(
  options: {
    now?: () => number;
    replies?: SlackReplySink;
    providers?: ProviderRegistry;
    workersAi?: WorkersAiRestProviderOptions;
    presentationDelayMs?: number;
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
    telemetry: new TelemetryStore(),
    presentationDelayMs: options.presentationDelayMs ?? 0,
    now: options.now ?? Date.now,
  };
}

export async function handleSlackAppMention(
  payload: SlackEventFixture,
  env: DemoEnvironment,
  options: SlackRunOptions,
): Promise<SlackRunResult> {
  const receivedAt = env.now();
  const mention = normalizeAppMention(payload);
  const assignment = resolveAssignment(mention.workspaceId, mention.channelId, {
    agents: env.agentStore,
    assignments: env.assignmentStore,
  });
  const provider = env.providers.get(options.providerId);
  const threadKey = slackThreadKey(mention);
  const session = env.sessions.getOrCreate({
    threadKey,
    agent: assignment.agent,
    providerId: options.providerId,
    model: provider.model,
    now: receivedAt,
  });

  if (!env.dedupe.claim(mention.eventId)) {
    const previousFinal = env.dedupe.finalReply(mention.eventId);
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
        {
          kind: 'final',
          channelId: mention.channelId,
          threadTs: mention.threadTs,
          text: 'Duplicate event acknowledged.',
          postedAt: env.now(),
        },
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
    const firstVisible = await startVisibleWork(env, mention, assignment.agent.name, presentation);

    let providerResponse: ProviderResponse;
    try {
      const toolResults = await collectAllowedToolResults(
        assignment,
        mention.channelId,
        mention.text,
        async (stage) => {
          await setStageStatus(env, mention, stage, presentation);
        },
      );
      await setStageStatus(env, mention, 'generating_answer', presentation);

      providerResponse = await provider.generate({
        agent: assignment.agent,
        message: mention.text,
        session,
        toolResults,
      });
    } catch (error) {
      await setStageStatus(env, mention, 'provider_failed', presentation);
      const finalDelivery = await deliverFinalWithCleanup(
        env,
        mention,
        providerFailureText(error),
        presentation,
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
      env.dedupe.complete(mention.eventId, finalDelivery.finalReply);
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
      mention,
      providerResponse.text,
      presentation,
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
    env.dedupe.complete(mention.eventId, finalDelivery.finalReply);
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
      env.dedupe.release(mention.eventId);
    }
    throw error;
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
  mention: NormalizedSlackMention,
  agentName: string,
  presentation: SlackPresentationRunState,
): Promise<Pick<TurnTelemetry, 'firstVisibleResponseKind'> & { postedAt: number }> {
  const status = await trySetStageStatus(env, mention, 'checking_context', presentation);
  if (status?.ok) {
    return {
      firstVisibleResponseKind: 'slack_status',
      postedAt: status.postedAt,
    };
  }

  const progress = await env.replies.post('progress', {
    channelId: mention.channelId,
    threadTs: mention.threadTs,
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
  mention: NormalizedSlackMention,
  stage: SlackPresentationStage,
  presentation: SlackPresentationRunState,
): Promise<void> {
  await trySetStageStatus(env, mention, stage, presentation);
}

async function trySetStageStatus(
  env: DemoEnvironment,
  mention: NormalizedSlackMention,
  stage: SlackPresentationStage,
  presentation: SlackPresentationRunState,
): Promise<SlackPresentationEvent | undefined> {
  if (!env.replies.setStatus || presentation.statusFailed) {
    return undefined;
  }

  const result = await env.replies.setStatus(presentationContext(env, mention), stage);
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
  mention: NormalizedSlackMention,
  text: string,
  presentation: SlackPresentationRunState,
): Promise<SlackFinalDelivery> {
  try {
    return await deliverFinal(env, mention, text, presentation.degradations);
  } finally {
    if (env.replies.clearStatus && presentation.statusWasSet) {
      const cleared = await env.replies.clearStatus(presentationContext(env, mention));
      if (!cleared.ok) {
        presentation.degradations.push(`assistant.threads.setStatus.clear:${cleared.error ?? 'unknown_error'}`);
      }
    }
  }
}

async function deliverFinal(
  env: DemoEnvironment,
  mention: NormalizedSlackMention,
  text: string,
  degradations: string[],
): Promise<SlackFinalDelivery> {
  const context = presentationContext(env, mention);
  if (env.replies.deliverFinal) {
    const delivery = await env.replies.deliverFinal(context, text);
    degradations.push(...delivery.degradations);
    return delivery;
  }

  const finalReply = await env.replies.post('final', {
    channelId: mention.channelId,
    threadTs: mention.threadTs,
    text,
    postedAt: env.now(),
  });
  return {
    finalReply,
    deliveryMode: 'fallback_post',
    degradations: [],
  };
}

function presentationContext(env: DemoEnvironment, mention: NormalizedSlackMention): SlackPresentationContext {
  return {
    channelId: mention.channelId,
    threadTs: mention.threadTs,
    workspaceId: mention.workspaceId,
    userId: mention.userId,
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
