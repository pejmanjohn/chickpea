import { instrument, registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

import { createAdminRoutes } from './admin/routes.ts';
import { activityStatusForObservation } from './activity/status.ts';
import {
  observeProviderAuthRoute,
  providerAuthRouteInterceptor,
} from './audit/provider-auth.ts';
import { recordRegisteredProvider } from './config/providers.ts';
import {
  memoryToolPolicyInterceptor,
  observeMemoryToolPolicy,
} from './memory/tool-policy.ts';
import {
  activityStatusGenerationInterceptor,
  publishActivityStatus,
} from './slack/activity-publisher.ts';
import { registerOpenAiSubscriptionApi } from './openai-subscription/provider.ts';
import { registerModelCompatibilityApis } from './model-compat/provider.ts';

// Provider registrations run at module scope so they are in place before any
// agent resolves its model. On the Cloudflare target the seeded Workers AI
// default (`@cf/zai-org/glm-5.2`) resolves keylessly through Flue's
// binding-backed `cloudflare` provider — no registration needed there.
// Registering `cloudflare-workers-ai` here is the NODE path: the REST provider
// that serves the same non-catalog model id from CLOUDFLARE_API_TOKEN +
// CLOUDFLARE_ACCOUNT_ID (and declares a context-window floor below so that
// path keeps auto-compaction, unlike the binding provider's contextWindow 0).
// `||` (not `??`): an empty-string env var means "unset" here — an empty
// baseUrl would otherwise be accepted and the openai-completions client would
// silently fall back to api.openai.com.
const workersAiBaseUrl =
  process.env.CLOUDFLARE_WORKERS_AI_BASE_URL ||
  `https://api.cloudflare.com/client/v4/accounts/${
    process.env.CLOUDFLARE_ACCOUNT_ID || '{CLOUDFLARE_ACCOUNT_ID}'
  }/ai/v1`;

export const WORKERS_AI_CONTEXT_WINDOW_FLOOR = 32_768;

registerProvider('cloudflare-workers-ai', {
  baseUrl: workersAiBaseUrl,
  ...(process.env.CLOUDFLARE_API_TOKEN ? { apiKey: process.env.CLOUDFLARE_API_TOKEN } : {}),
  // Non-catalog models resolve with contextWindow 0, which Flue treats as
  // "unknown" and therefore NEVER threshold-compacts. Pre-release transcript
  // testing measured linear DM-history growth on that path. Declaring a
  // conservative floor turns auto-compaction on; if the real window is larger,
  // compaction just fires early, never overflows.
  contextWindow: WORKERS_AI_CONTEXT_WINDOW_FLOOR,
  maxTokens: 2048,
});
recordRegisteredProvider('cloudflare-workers-ai');

// These handlers contain no credentials. API-key binding happens only after
// Settings resolves the selected canonical provider immediately before use.
registerModelCompatibilityApis();

// The wire handler is credential-free and safe to install at module boot.
// A subscription profile binds live credentials and the internal provider
// immediately before use; until then no `openai-subscription/*` model exists.
registerOpenAiSubscriptionApi();

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
// Enables `SLACK_TAG_MODEL=local-stub/<model>` against a fake provider.
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

// Flue persists trace carriers across its durable submission boundary even
// though recovered execution receives a synthetic Request. Restore the Slack
// turn generation around the complete agent execution, then bridge only safe,
// bounded activity summaries to the per-turn status line.
instrument({
  key: Symbol.for('chickpea.activity-status-generation'),
  interceptor: activityStatusGenerationInterceptor,
  observe(event, context) {
    if (context.agentName !== 'slack-thread') return;
    const status = activityStatusForObservation(event);
    if (status && typeof event.instanceId === 'string') {
      publishActivityStatus(event.instanceId, status, context.env);
    }
  },
  dispose() {},
});

instrument({
  key: Symbol.for('chickpea.memory-tool-policy'),
  interceptor: memoryToolPolicyInterceptor,
  observe: observeMemoryToolPolicy,
  dispose() {},
});

// Flue emits one turn_request for every main, structured-output, retry, and
// compaction model operation. Its provider id is already credential-free; add
// the exact product route fact to the same trace without prompts, account data,
// tokens, or billing guesses.
instrument({
  key: Symbol.for('chickpea.provider-auth-route'),
  interceptor: providerAuthRouteInterceptor,
  observe: observeProviderAuthRoute,
  dispose() {},
});

const app = new Hono();
app.route('/', createAdminRoutes());
app.route('/', flue());

export default app;
