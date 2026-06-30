import { serve } from '@hono/node-server';
import { existsSync, readFileSync } from 'node:fs';

import type { ProviderId } from './config/types.ts';
import type { WorkersAiRestProviderOptions } from './providers/workers-ai-rest.ts';
import { createSlackEventsApp } from './slack/events-app.ts';

loadLocalEnvFile('.env.slack.local');

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

const botUserId = await resolveBotUserId(botToken);

const app = createSlackEventsApp({
  signingSecret,
  botToken,
  providerId,
  dispatchMode: 'async',
  presentationDelayMs,
  botUserId,
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
    if (!process.env.SLACK_BOT_USER_ID?.trim()) {
      console.log('Derived Slack bot user id with auth.test');
    }
    if (presentationDelayMs > 0) {
      console.log(`Presentation delay enabled: ${presentationDelayMs}ms`);
    }
    if (workersAi && requestedPresentationDelayMs > 0) {
      console.log('Presentation delay disabled in live Workers AI mode');
    }
  },
);

function loadLocalEnvFile(path: string): void {
  if (!existsSync(path)) {
    return;
  }

  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match?.[1] || process.env[match[1]] !== undefined) {
      continue;
    }

    process.env[match[1]] = unquoteEnvValue(match[2] ?? '');
  }
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function resolveBotUserId(token: string): Promise<string> {
  const configured = process.env.SLACK_BOT_USER_ID?.trim();
  if (configured) {
    return configured;
  }

  let response: Response;
  try {
    response = await fetch('https://slack.com/api/auth.test', {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
  } catch (error) {
    console.error(`Unable to derive SLACK_BOT_USER_ID from Slack auth.test: ${sanitizeError(error)}`);
    process.exit(1);
  }

  let body: SlackAuthTestResponse;
  try {
    body = (await response.json()) as SlackAuthTestResponse;
  } catch {
    console.error(`Unable to derive SLACK_BOT_USER_ID from Slack auth.test: http_${response.status}`);
    process.exit(1);
  }

  if (!response.ok || !body.ok || !body.user_id) {
    console.error(
      `Unable to derive SLACK_BOT_USER_ID from Slack auth.test: ${sanitizeError(body.error ?? `http_${response.status}`)}`,
    );
    process.exit(1);
  }

  return body.user_id;
}

interface SlackAuthTestResponse {
  ok?: boolean;
  user_id?: string;
  error?: string;
}

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

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160);
}
