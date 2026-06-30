import { serve } from '@hono/node-server';

import type { ProviderId } from './config/types.ts';
import type { WorkersAiRestProviderOptions } from './providers/workers-ai-rest.ts';
import { createSlackEventsApp } from './slack/events-app.ts';

const signingSecret = process.env.SLACK_SIGNING_SECRET;
const botToken = process.env.SLACK_BOT_TOKEN;
const providerId = (process.env.SLACK_FLUE_PROVIDER ?? 'workers-ai') as ProviderId;
const port = Number(process.env.PORT ?? '8789');
const workersAi = buildWorkersAiOptions(providerId);
const requestedPresentationDelayMs = numberEnv('SLACK_FLUE_PRESENTATION_DELAY_MS') ?? 0;
const presentationDelayMs = workersAi ? 0 : requestedPresentationDelayMs;

if (!signingSecret || !botToken) {
  console.error('Missing SLACK_SIGNING_SECRET or SLACK_BOT_TOKEN. See docs/play-slack.md.');
  process.exit(1);
}

const app = createSlackEventsApp({
  signingSecret,
  botToken,
  providerId,
  presentationDelayMs,
  ...(workersAi ? { workersAi } : {}),
});

serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`Slack Flue listening on http://localhost:${info.port}`);
    console.log('Configure Slack Events Request URL as <tunnel-url>/slack/events');
    if (workersAi) {
      console.log(`Workers AI live mode enabled for ${workersAi.model}`);
    }
    if (presentationDelayMs > 0) {
      console.log(`Presentation delay enabled: ${presentationDelayMs}ms`);
    }
    if (workersAi && requestedPresentationDelayMs > 0) {
      console.log('Presentation delay disabled in live Workers AI mode');
    }
  },
);

function buildWorkersAiOptions(provider: ProviderId): WorkersAiRestProviderOptions | undefined {
  const mode = (process.env.SLACK_FLUE_WORKERS_AI_MODE ?? 'deterministic').toLowerCase();
  if (provider !== 'workers-ai' || mode !== 'live') {
    return undefined;
  }

  const options: WorkersAiRestProviderOptions = {
    accountId: requiredEnv('CLOUDFLARE_ACCOUNT_ID'),
    apiToken: requiredEnv('CLOUDFLARE_API_TOKEN'),
    model: process.env.CLOUDFLARE_WORKERS_AI_MODEL ?? '@cf/zai-org/glm-5.2',
    maxTokens: numberEnv('CLOUDFLARE_WORKERS_AI_MAX_TOKENS') ?? 512,
  };
  if (process.env.CLOUDFLARE_API_ENDPOINT) {
    options.endpoint = process.env.CLOUDFLARE_API_ENDPOINT;
  }
  return options;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required when SLACK_FLUE_WORKERS_AI_MODE=live.`);
    process.exit(1);
  }
  return value;
}

function numberEnv(name: string): number | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
