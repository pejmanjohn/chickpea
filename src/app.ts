import { instrument } from '@flue/runtime';
import { Hono } from 'hono';

import { createAdminRoutes } from './admin/routes.ts';
import { CHICKPEA_SLACK_AGENT_NAME } from './agents/names.ts';
import {
  getIdentityStore,
  getSettingsStore,
  getSlackStateStore,
  type PlatformEnv,
} from './config/state-backend.ts';
import { isCloudflareTarget } from './config/runtime-target.ts';
import {
  isOAuthContinuationActorActive,
  repairPendingOAuthContinuationResumes,
} from './connections/oauth-continuation.ts';
import type { OAuthContinuation } from './connections/types.ts';
import { createBetterAuthRuntimeRoutes } from './auth/better-auth-runtime.ts';
import { createMcpOAuthRuntimeRoutes } from './auth/mcp-oauth-routes.ts';
import { createManagementSetupRoutes } from './management/setup-routes.ts';
import { activityStatusForObservation } from './activity/status.ts';
import {
  observeProviderAuthRoute,
  providerAuthRouteInterceptor,
} from './audit/provider-auth.ts';
import {
  memoryToolPolicyInterceptor,
  observeMemoryToolPolicy,
} from './memory/tool-policy.ts';
import { publishActivityStatus } from './slack/activity-publisher.ts';
import {
  observePresentationToolPolicy,
  presentationToolPolicyInterceptor,
} from './slack/presentation-tool-policy.ts';
import { startNodeTurnRelay, wakeNodeTurnRelay } from './slack/node-turn-relay.ts';
import { createPlatformProductTelemetry } from './telemetry/platform.ts';
import { createRequestTelemetryLifecycle } from './telemetry/runtime.ts';
import { startNodeGatewaySession } from './slack/gateway/node-runtime.ts';
import { workModelInvocationInterceptor } from './work/model-invocation.ts';
import {
  observeResponseMetadata,
  responseMetadataInterceptor,
} from './usage/response-metadata.ts';
import { channel } from './channels/slack.ts';
import {
  bootstrapRuntimeProviders,
  WORKERS_AI_CONTEXT_WINDOW_FLOOR,
} from './runtime-bootstrap.ts';

export { WORKERS_AI_CONTEXT_WINDOW_FLOOR };

// Install the same app-owned Pi providers used by direct agent execution.
// Cloudflare adds its keyless Workers AI binding in the Worker entry.
bootstrapRuntimeProviders();

// Bridge only safe activity summaries. The work interceptor below restores
// app-owned TurnJob correlation from Flue's instance/submission coordinates;
// no synthetic request header or model-visible attribute carries it.
instrument({
  key: Symbol.for('chickpea.activity-status'),
  interceptor: async (_operation, _context, next) => next(),
  observe(event, context) {
    if (context.agentName !== CHICKPEA_SLACK_AGENT_NAME) return;
    const status = activityStatusForObservation(event);
    if (
      status &&
      typeof event.instanceId === 'string' &&
      typeof event.submissionId === 'string'
    ) {
      publishActivityStatus(event.instanceId, status, context.env, event.submissionId);
    }
  },
  dispose() {},
});

// Response metadata is the one durable usage-of-record consumed by both the
// interactive Slack relay and routines. It contains token counts and bounded
// model identifiers only — never prompts, completions, credentials, or tool
// arguments.
instrument({
  key: Symbol.for('chickpea.response-metadata'),
  interceptor: responseMetadataInterceptor,
  observe: observeResponseMetadata,
  dispose() {},
});

instrument({
  key: Symbol.for('chickpea.memory-tool-policy'),
  interceptor: memoryToolPolicyInterceptor,
  observe: observeMemoryToolPolicy,
  dispose() {},
});

instrument({
  key: Symbol.for('chickpea.slack-presentation-tool-policy'),
  interceptor: presentationToolPolicyInterceptor,
  observe: observePresentationToolPolicy,
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

// Canonical invocation state changes at Flue's first model operation, after
// agent initialization and live policy resolution but before provider work.
instrument({
  key: Symbol.for('chickpea.work-model-invocation'),
  interceptor: workModelInvocationInterceptor,
  observe() {},
  dispose() {},
});

const app = new Hono();
app.use('*', async (c, next) => {
  const control = await getIdentityStore(c.env as PlatformEnv | undefined).getAuthControl();
  if (control?.healthGate === 'recovery_only') return c.notFound();
  return next();
});
// Starts the shared startup/periodic wake for durable compatibility TurnJobs
// and ledger-authoritative interactive Runs. Ledger admission stays default-off
// and exact-channel scoped by SLACK_TAG_LEDGER_CANARY_CHANNELS.
startNodeTurnRelay();
startNodeGatewaySession();

async function resumeOAuthContinuation(
  continuation: OAuthContinuation,
  env?: PlatformEnv,
): Promise<void> {
  if (!(await isOAuthContinuationActorActive({
    continuation,
    identity: getIdentityStore(env),
  }))) {
    throw new Error('The Slack member who authorized this connection is no longer active.');
  }
  const resumed = await getSlackStateStore(env).resumeTurnAfterOAuth?.(
    continuation.taskId,
    continuation.id,
  );
  if (!resumed) throw new Error('The interrupted Slack task is no longer available.');
  await wakeNodeTurnRelay(env);
}

async function repairOAuthResumes(env?: PlatformEnv): Promise<void> {
  await repairPendingOAuthContinuationResumes({
    settings: getSettingsStore(env),
    onReady: (continuation) => resumeOAuthContinuation(continuation, env),
  });
}

if (!isCloudflareTarget()) {
  let oauthRepairInFlight: Promise<void> | undefined;
  const runOAuthRepair = () => {
    if (oauthRepairInFlight) return oauthRepairInFlight;
    oauthRepairInFlight = repairOAuthResumes()
      .catch(() => undefined)
      .finally(() => {
        oauthRepairInFlight = undefined;
      });
    return oauthRepairInFlight;
  };
  queueMicrotask(() => void runOAuthRepair());
  const oauthRepairTimer = setInterval(
    () => void runOAuthRepair(),
    60_000,
  );
  oauthRepairTimer.unref();
}
app.route('/', createBetterAuthRuntimeRoutes());
app.route('/', createMcpOAuthRuntimeRoutes());
app.route('/', createManagementSetupRoutes({
  productTelemetry: (c) => createPlatformProductTelemetry({
    ...(c.env ? { env: c.env as PlatformEnv } : {}),
    settings: getSettingsStore(c.env as PlatformEnv | undefined),
    lifecycle: createRequestTelemetryLifecycle(c),
  }),
}));
app.route('/', createAdminRoutes({
  onOAuthContinuationReady: resumeOAuthContinuation,
  productTelemetry: (c) => createPlatformProductTelemetry({
    ...(c.env ? { env: c.env as PlatformEnv } : {}),
    settings: getSettingsStore(c.env as PlatformEnv | undefined),
    lifecycle: createRequestTelemetryLifecycle(c),
  }),
}));
app.route('/channels/slack', channel.route());

export default app;
