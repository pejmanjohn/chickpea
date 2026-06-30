import { AgentStore, AssignmentStore, resolveAssignment } from '../config/resolver.ts';
import { seededAgents } from '../config/seed.ts';
import type { ProviderId, ResolvedAssignment } from '../config/types.ts';
import { ProviderRegistry } from '../providers/deterministic.ts';
import type { WorkersAiRestProviderOptions } from '../providers/workers-ai-rest.ts';
import { EventDedupeLedger } from '../slack/dedupe.ts';
import { LocalSlackReplySink, type SlackReplyPost, type SlackReplySink } from '../slack/replies.ts';
import type { SlackEventFixture } from '../slack/types.ts';
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

export function createDemoEnvironment(
  options: {
    now?: () => number;
    replies?: SlackReplySink;
    providers?: ProviderRegistry;
    workersAi?: WorkersAiRestProviderOptions;
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
    const previousFinal = env.replies.posts.at(-1);
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
        (await env.replies.post('final', {
          channelId: mention.channelId,
          threadTs: mention.threadTs,
          text: 'Duplicate event acknowledged.',
          postedAt: env.now(),
          format: 'plain_text',
        })),
      telemetry: {
        firstVisibleResponseKind: 'slack_progress',
        timeToFirstVisibleResponseMs: 0,
        providerId: provider.providerId,
        model: provider.model,
        totalLatencyMs: 0,
      },
    };
  }

  const progress = await env.replies.post('progress', {
    channelId: mention.channelId,
    threadTs: mention.threadTs,
    text: `${assignment.agent.name} is checking the Slack thread context.`,
    postedAt: env.now(),
    format: 'plain_text',
  });
  const toolResults = await collectAllowedToolResults(assignment, mention.channelId, mention.text);
  let providerResponse;
  try {
    providerResponse = await provider.generate({
      agent: assignment.agent,
      message: mention.text,
      session,
      toolResults,
    });
  } catch (error) {
    const finalReply = await env.replies.post('final', {
      channelId: mention.channelId,
      threadTs: mention.threadTs,
      text: providerFailureText(error),
      postedAt: env.now(),
      format: 'plain_text',
    });

    const telemetry: TurnTelemetry = {
      firstVisibleResponseKind: 'slack_progress',
      timeToFirstVisibleResponseMs: progress.postedAt - receivedAt,
      providerId: provider.providerId,
      model: provider.model,
      totalLatencyMs: finalReply.postedAt - receivedAt,
    };
    env.telemetry.recordTurn(telemetry);

    return {
      status: 'handled',
      assignment,
      session,
      provider: {
        providerId: provider.providerId,
        model: provider.model,
      },
      finalReply,
      telemetry,
    };
  }

  const updatedSession = env.sessions.incrementTurn(threadKey);
  const finalReply = await env.replies.post('final', {
    channelId: mention.channelId,
    threadTs: mention.threadTs,
    text: providerResponse.text,
    postedAt: env.now(),
    format: 'markdown',
  });

  env.telemetry.recordModelCall({
    providerId: providerResponse.providerId,
    model: providerResponse.model,
    latencyMs: providerResponse.latencyMs,
    inputTokens: providerResponse.usage.inputTokens,
    outputTokens: providerResponse.usage.outputTokens,
  });

  const telemetry: TurnTelemetry = {
    firstVisibleResponseKind: 'slack_progress',
    timeToFirstVisibleResponseMs: progress.postedAt - receivedAt,
    providerId: providerResponse.providerId,
    model: providerResponse.model,
    totalLatencyMs: finalReply.postedAt - receivedAt,
  };
  env.telemetry.recordTurn(telemetry);

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
    finalReply,
    telemetry,
  };
}

async function collectAllowedToolResults(
  assignment: ResolvedAssignment,
  channelId: string,
  text: string,
): Promise<ToolRunResult[]> {
  if (!text.toLowerCase().includes('channel context')) {
    return [];
  }

  return [await runAllowedTool(assignment.agent, 'lookup_channel_brief', { channelId })];
}

function providerFailureText(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown provider error';
  return `I reached the Slack thread, but the model provider call failed: ${message}`;
}
