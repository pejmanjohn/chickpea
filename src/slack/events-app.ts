import { Hono } from 'hono';

import type { ProviderId } from '../config/types.ts';
import type { WorkersAiRestProviderOptions } from '../providers/workers-ai-rest.ts';
import {
  createDemoEnvironment,
  handleSlackTurn,
  type DemoEnvironment,
} from '../runtime/slack-thread-runner.ts';
import { SlackWebApiContextClient } from './thread-context.ts';
import { SlackWebApiReplySink } from './web-api-replies.ts';
import { verifySlackSignature } from './signature.ts';
import {
  isSlackAppMentionEvent,
  isSlackAssistantEvent,
  isSlackMessageEvent,
  type SlackEventFixture,
} from './types.ts';

interface SlackUrlVerificationPayload {
  type: 'url_verification';
  challenge: string;
}

type SlackEventsPayload = SlackUrlVerificationPayload | SlackEventFixture;

export interface SlackEventsAppOptions {
  signingSecret: string;
  botToken: string;
  providerId?: ProviderId;
  dispatchMode?: 'sync' | 'async';
  fetch?: typeof fetch;
  environment?: DemoEnvironment;
  workersAi?: WorkersAiRestProviderOptions;
  presentationDelayMs?: number;
  botUserId?: string;
}

export function createSlackEventsApp(options: SlackEventsAppOptions): Hono {
  const app = new Hono();
  const providerId = options.providerId ?? 'workers-ai';
  const dispatchMode = options.dispatchMode ?? 'sync';
  const webApiOptions = options.fetch
    ? {
        botToken: options.botToken,
        fetch: options.fetch,
      }
    : {
        botToken: options.botToken,
      };
  const environment =
    options.environment ??
    createDemoEnvironment({
      replies: new SlackWebApiReplySink(webApiOptions),
      slackContext: new SlackWebApiContextClient(webApiOptions),
      ...(options.workersAi ? { workersAi: options.workersAi } : {}),
      presentationDelayMs: options.presentationDelayMs ?? 0,
      ...(options.botUserId ? { botUserId: options.botUserId } : {}),
    });

  app.post('/slack/events', async (c) => {
    const rawBody = await c.req.raw.text();
    const verified = verifySlackSignature({
      signingSecret: options.signingSecret,
      body: rawBody,
      timestamp: c.req.header('x-slack-request-timestamp') ?? null,
      signature: c.req.header('x-slack-signature') ?? null,
    });

    if (!verified) {
      return c.json({ error: 'invalid_slack_signature' }, 401);
    }

    let payload: SlackEventsPayload;
    try {
      payload = JSON.parse(rawBody) as SlackEventsPayload;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }

    if (payload.type === 'url_verification') {
      return c.json({ challenge: payload.challenge });
    }

    if (payload.type !== 'event_callback') {
      return c.json({ ok: true, status: 'ignored' });
    }

    if (isSlackAssistantEvent(payload.event)) {
      return c.json({
        ok: true,
        status: 'assistant_event_acknowledged',
        event_id: payload.event_id,
      });
    }

    if (!isSlackAppMentionEvent(payload.event) && !isSlackMessageEvent(payload.event)) {
      return c.json({ ok: true, status: 'ignored' });
    }

    if (dispatchMode === 'async') {
      dispatchSlackTurn(c, handleSlackTurn(payload, environment, { providerId }));
      return c.json({
        ok: true,
        status: 'accepted',
        event_id: payload.event_id,
      });
    }

    const result = await handleSlackTurn(payload, environment, { providerId });
    return c.json({
      ok: true,
      status: result.status,
      event_id: payload.event_id,
      ...(result.status === 'ignored' ? { reason: result.reason } : {}),
    });
  });

  app.get('/health', (c) => c.json({ ok: true }));

  return app;
}

function dispatchSlackTurn(c: unknown, turn: Promise<unknown>): void {
  const guarded = turn.catch((error) => {
    console.error(`Slack event processing failed: ${sanitizeAsyncError(error)}`);
  });
  const executionCtx = getExecutionContext(c);

  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(guarded);
    return;
  }

  void guarded;
}

function getExecutionContext(
  c: unknown,
): { waitUntil?: (promise: Promise<unknown>) => void } | undefined {
  try {
    return (c as { executionCtx?: { waitUntil?: (promise: Promise<unknown>) => void } })
      .executionCtx;
  } catch {
    return undefined;
  }
}

function sanitizeAsyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160);
}
