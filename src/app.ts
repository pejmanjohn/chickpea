import { observe, registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

import { createAdminRoutes } from './admin/routes.ts';
import { recordRegisteredProvider } from './config/providers.ts';
import { toolStatus } from './slack/replies.ts';
import { setObservedSlackStatus } from './slack/status-registry.ts';

// Provider registrations run at module scope so they are in place before any
// agent resolves its model. Registering `cloudflare-workers-ai` is REQUIRED:
// the seeded model id `@cf/zai-org/glm-5.2` is not in Flue's catalog and only
// resolves once the provider id is registered.
// `||` (not `??`): an empty-string env var means "unset" here — an empty
// baseUrl would otherwise be accepted and the openai-completions client would
// silently fall back to api.openai.com.
const workersAiBaseUrl =
  process.env.CLOUDFLARE_WORKERS_AI_BASE_URL ||
  `https://api.cloudflare.com/client/v4/accounts/${
    process.env.CLOUDFLARE_ACCOUNT_ID || '{CLOUDFLARE_ACCOUNT_ID}'
  }/ai/v1`;

registerProvider('cloudflare-workers-ai', {
  baseUrl: workersAiBaseUrl,
  ...(process.env.CLOUDFLARE_API_TOKEN ? { apiKey: process.env.CLOUDFLARE_API_TOKEN } : {}),
  // Non-catalog models resolve with contextWindow 0, which Flue treats as
  // "unknown" and therefore NEVER threshold-compacts — measured: DM transcripts
  // grew linearly without bound (probe-dm-transcript.mjs). Declaring a
  // conservative floor turns auto-compaction on; if the real window is larger,
  // compaction just fires early, never overflows.
  contextWindow: 32_768,
  maxTokens: 2048,
});
recordRegisteredProvider('cloudflare-workers-ai');

// The catalog `anthropic` provider works from ANTHROPIC_API_KEY alone; only
// override it when an explicit base URL is configured.
if (process.env.ANTHROPIC_BASE_URL) {
  registerProvider('anthropic', {
    baseUrl: process.env.ANTHROPIC_BASE_URL,
    ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
  });
  recordRegisteredProvider('anthropic');
}

// Offline / local stub provider speaking the OpenAI-completions wire protocol.
// Enables `SLACK_FLUE_MODEL=local-stub/<model>` against a fake provider.
if (process.env.LOCAL_STUB_URL) {
  registerProvider('local-stub', {
    api: 'openai-completions',
    baseUrl: process.env.LOCAL_STUB_URL,
    // The OpenAI-completions client requires a non-empty key even offline; the
    // fake provider ignores it.
    apiKey: process.env.LOCAL_STUB_API_KEY ?? 'offline-stub-key',
  });
  recordRegisteredProvider('local-stub');
}

// Bridge Flue's tool-start events to the per-turn Slack status line. The status
// registry keys turns by the durable agent id, so its Map lookup is the sole,
// authoritative "is this one of my Slack turns?" filter — no need to re-parse
// the id as a thread key here (that re-encoded the same coupling and paid a
// throw on every non-Slack agent's tool call). All status wording lives in the
// builder layer (toolStatus), keeping this composition root free of copy.
observe((event) => {
  if (event.type !== 'tool_start' || typeof event.instanceId !== 'string') {
    return;
  }
  setObservedSlackStatus(event.instanceId, toolStatus(event.toolName));
});

const app = new Hono();
app.route('/', createAdminRoutes());
app.route('/', flue());

export default app;
