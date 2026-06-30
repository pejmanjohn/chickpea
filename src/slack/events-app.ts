import { Hono } from 'hono';

import type { ProviderId } from '../config/types.ts';
import type { WorkersAiRestProviderOptions } from '../providers/workers-ai-rest.ts';
import {
  createDemoEnvironment,
  handleSlackAppMention,
  type DemoEnvironment,
} from '../runtime/slack-thread-runner.ts';
import { SlackWebApiReplySink } from './web-api-replies.ts';
import { verifySlackSignature } from './signature.ts';
import { isSlackAppMentionEvent, isSlackAssistantEvent, type SlackEventFixture } from './types.ts';

interface SlackUrlVerificationPayload {
  type: 'url_verification';
  challenge: string;
}

type SlackEventsPayload = SlackUrlVerificationPayload | SlackEventFixture;

export interface SlackEventsAppOptions {
  signingSecret: string;
  botToken: string;
  providerId?: ProviderId;
  fetch?: typeof fetch;
  environment?: DemoEnvironment;
  workersAi?: WorkersAiRestProviderOptions;
  presentationDelayMs?: number;
}

export function createSlackEventsApp(options: SlackEventsAppOptions): Hono {
  const app = new Hono();
  const providerId = options.providerId ?? 'workers-ai';
  const environment =
    options.environment ??
    createDemoEnvironment({
      replies: new SlackWebApiReplySink(
        options.fetch
          ? {
              botToken: options.botToken,
              fetch: options.fetch,
            }
          : {
              botToken: options.botToken,
            },
      ),
      ...(options.workersAi ? { workersAi: options.workersAi } : {}),
      presentationDelayMs: options.presentationDelayMs ?? 0,
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

    if (!isSlackAppMentionEvent(payload.event)) {
      return c.json({ ok: true, status: 'ignored' });
    }

    const result = await handleSlackAppMention(payload, environment, { providerId });
    return c.json({
      ok: true,
      status: result.status,
      event_id: payload.event_id,
    });
  });

  app.get('/health', (c) => c.json({ ok: true }));

  return app;
}
