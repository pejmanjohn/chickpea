import { GATEWAY_HTTP_PATH, handleHttpDeliveryRequest } from './slack/gateway/http-delivery.ts';
import { createAgentSlackAppRoutes } from './slack/agent-apps/index.ts';
import { deploymentTenancy } from './config/installation-scope.ts';
import { tagStateStub } from './config/state-rpc.ts';
import { instrument, type FlueObservation } from '@flue/runtime';
import { Hono, type Context } from 'hono';

import { ADMIN_ROUTE_PATHS } from './admin/route-paths.ts';
import { CHICKPEA_SLACK_AGENT_NAME } from './agents/names.ts';
import {
  getConfigStore,
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
import { BETTER_AUTH_PUBLIC_PATHS, MCP_OAUTH_PATHS } from './auth/public-auth-paths.ts';
import { lazyRoutes } from './http/lazy-routes.ts';
import { recoveryOnlyGate } from './auth/request-auth-control.ts';
import { activityStatusForObservation } from './activity/status.ts';
import { noteAgentAuthoringActivation } from './management/workspace-change-tools.ts';
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
  agentFailureDiagnosticsInterceptor,
  observeAgentResultDiagnostics,
} from './slack/agent-failure-diagnostics.ts';
import { observeSlackAnswerStep, slackToolBoundaryFoldInterceptor } from './slack/follow-up-fold.ts';
import {
  observePresentationToolPolicy,
  presentationToolPolicyInterceptor,
} from './slack/presentation-tool-policy.ts';
import { startNodeTurnRelay, wakeNodeTurnRelay } from './slack/node-turn-relay.ts';
import { createPlatformProductTelemetry } from './telemetry/platform.ts';
import { createRequestTelemetryLifecycle } from './telemetry/runtime.ts';
import { startNodeGatewaySession } from './slack/gateway/node-runtime.ts';
import { currentFlueObservationContext, workModelInvocationInterceptor } from './work/model-invocation.ts';
import { ModelStepMarks } from './observability/runtime-latency.ts';
import { readStagedSlackObservationTarget } from './agents/turn-input.ts';
import { modelAccessInterceptor } from './agents/model-access-lookup.ts';
import { runFeeInterceptor } from './config/run-fee-interceptor.ts';
import { observeModelAccess } from './config/model-access.ts';
import { workspaceRegistryInterceptor } from './sandbox/workspace-registry.ts';
import {
  observeResponseMetadata,
  responseMetadataInterceptor,
} from './usage/response-metadata.ts';
import { admitSetupWake, answerSlackRecoveryEventsProof, channel, serveAgentAppSlackDelivery } from './channels/slack.ts';
import { SLACK_EVENTS_PATH } from './slack/app-manifest.ts';
import {
  bootstrapRuntimeProviders,
  WORKERS_AI_CONTEXT_WINDOW_FLOOR,
} from './runtime-bootstrap.ts';

export { WORKERS_AI_CONTEXT_WINDOW_FLOOR };

// Install the same app-owned Pi providers used by direct agent execution.
// Cloudflare adds its keyless Workers AI binding in the Worker entry.
bootstrapRuntimeProviders();

instrument({
  key: Symbol.for('chickpea.agent-failure-diagnostics'),
  interceptor: agentFailureDiagnosticsInterceptor,
  observe: observeAgentResultDiagnostics,
  dispose() {},
});

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

// A Slack thread mounts the workspace change tools on the render after its
// model activates agent-authoring.
instrument({
  key: Symbol.for('chickpea.agent-authoring-activation'),
  interceptor: async (_operation, _context, next) => next(),
  observe(event, context) {
    if (context.agentName === CHICKPEA_SLACK_AGENT_NAME) noteAgentAuthoringActivation(event);
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

// One coding-workspace registry per managed submission, shared by the
// workspace tools.
instrument({
  key: Symbol.for('chickpea.workspace-registry'),
  interceptor: workspaceRegistryInterceptor,
  observe() {},
  dispose() {},
});

instrument({
  key: Symbol.for('chickpea.slack-presentation-tool-policy'),
  interceptor: presentationToolPolicyInterceptor,
  observe: observePresentationToolPolicy,
  dispose() {},
});

// Registered after the presentation policy, so it runs inside it: a tool
// that policy refuses never counts as a tool boundary.
instrument({
  key: Symbol.for('chickpea.slack-tool-boundary-fold'),
  interceptor: slackToolBoundaryFoldInterceptor,
  observe: observeSlackAnswerStep,
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

// Every attempt of every agent binds its run's model access before its first
// model call; the provider proxy refuses a call without it. Registered inside
// the work interceptor, so a Slack attempt reuses its TurnJob match.
instrument({
  key: Symbol.for('chickpea.model-access'),
  interceptor: modelAccessInterceptor,
  observe: observeModelAccess,
  dispose() {},
});

// One content-free model_step record per model request, timed in the object
// that makes it; a Slack turn's names the turn.
const modelSteps = new ModelStepMarks();
instrument({
  key: Symbol.for('chickpea.model-step-latency'),
  interceptor: (operation, _context, next) => modelSteps.intercept(operation, next),
  observe(event, context) {
    modelSteps.observe(event, () => (context.agentName === CHICKPEA_SLACK_AGENT_NAME ? slackTurnJobIdOf(event) : undefined));
  },
  dispose() {},
});

/** The Slack turn a thread agent's activity belongs to: the attempt's own match, else its staged input. */
function slackTurnJobIdOf({ instanceId, submissionId }: FlueObservation): string | undefined {
  if (!instanceId || !submissionId) return undefined;
  const active = currentFlueObservationContext();
  if (active?.target && active.instanceId === instanceId && active.submissionId === submissionId) {
    return active.target.turnJobId;
  }
  return readStagedSlackObservationTarget(instanceId, submissionId)?.turnJobId;
}

instrument({
  key: Symbol.for('chickpea.run-fees'),
  interceptor: runFeeInterceptor,
  observe() {},
  dispose() {},
});

const app = new Hono();
app.post(GATEWAY_HTTP_PATH, (c) => {
  // No installation of a deployment serving many takes gateway deliveries.
  if (!isCloudflareTarget() || deploymentTenancy(c.env as PlatformEnv | undefined) === 'installation') return c.notFound();
  return handleHttpDeliveryRequest(c.req.raw, input => tagStateStub(c.env as PlatformEnv).receiveGatewayHttp(input));
});
// Recovery-only closes everything but Slack credential recovery and the paths
// with their own bearer capability; the Events URL answers only recovery's
// signed proof. Admin mounts the same gate; it and authentication reuse this read.
app.use('*', recoveryOnlyGate(
  (c) => getIdentityStore(c.env as PlatformEnv | undefined),
  new Map([[SLACK_EVENTS_PATH, answerSlackRecoveryEventsProof]]),
));
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

function productTelemetryForRequest(c: Context) {
  const platformEnv = c.env as PlatformEnv | undefined;
  return createPlatformProductTelemetry({
    ...(platformEnv ? { env: platformEnv } : {}),
    settings: getSettingsStore(platformEnv),
    config: getConfigStore(platformEnv),
    lifecycle: createRequestTelemetryLifecycle(c),
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
// Better Auth and the MCP resource load on their first request; a Slack turn
// never needs them, and their modules are about 1.5 MiB of the static closure.
app.route('/', lazyRoutes('Better Auth routes', BETTER_AUTH_PUBLIC_PATHS, async () =>
  (await import('./auth/better-auth-runtime.ts')).createBetterAuthRuntimeRoutes()));
app.route('/', lazyRoutes('MCP OAuth routes', MCP_OAUTH_PATHS, async () =>
  (await import('./auth/mcp-oauth-routes.ts')).createMcpOAuthRuntimeRoutes({ productTelemetry: productTelemetryForRequest })));
// Admin, the setup links and the connect pages load on their first request
// too. They share one app, in this order, because a setup link's OAuth return
// falls through to Admin's.
app.route('/', lazyRoutes('Admin routes', ADMIN_ROUTE_PATHS, async () => {
  const [{ createManagementSetupRoutes }, { createConnectRoutes }, { createAdminRoutes }] = await Promise.all([
    import('./management/setup-routes.ts'),
    import('./management/connect-routes.ts'),
    import('./admin/routes.ts'),
  ]);
  return new Hono()
    .route('/', createManagementSetupRoutes({
      productTelemetry: productTelemetryForRequest,
      wakeAgent: admitSetupWake,
    }))
    .route('/', createConnectRoutes())
    .route('/', createAdminRoutes({
      onOAuthContinuationReady: resumeOAuthContinuation,
      productTelemetry: productTelemetryForRequest,
    }));
}));
app.route('/', createAgentSlackAppRoutes({ serveDelivery: serveAgentAppSlackDelivery }));
app.route('/channels/slack', channel.route());

export default app;
