import { instrument } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';

import {
  ChickpeaRoutineIntent,
  route as routineIntentRoute,
} from './agents/routine-intent.ts';
import { ChickpeaSlack, route as slackAgentRoute } from './agents/slack-thread.ts';
import { createAdminRoutes } from './admin/routes.ts';
import { activityStatusForObservation } from './activity/status.ts';
import {
  observeProviderAuthRoute,
  providerAuthRouteInterceptor,
} from './audit/provider-auth.ts';
import {
  memoryToolPolicyInterceptor,
  observeMemoryToolPolicy,
} from './memory/tool-policy.ts';
import {
  activityStatusGenerationInterceptor,
  publishActivityStatus,
} from './slack/activity-publisher.ts';
import { startNodeTurnRelay } from './slack/node-turn-relay.ts';
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
// Starts the shared startup/periodic wake for durable compatibility TurnJobs
// and ledger-authoritative interactive Runs. Ledger admission stays default-off
// and exact-channel scoped by SLACK_TAG_LEDGER_CANARY_CHANNELS.
startNodeTurnRelay();
app.route('/', createAdminRoutes());
// Preserve the internal endpoints until dispatch moves to
// init()/dispatch()/read(). Every agent route stays behind the existing
// process-local/operator token rather than becoming a public model endpoint.
app.use('/agents/slack-thread/*', slackAgentRoute);
app.use('/agents/routine-intent/*', routineIntentRoute);
app.route('/agents/slack-thread', createAgentRouter(ChickpeaSlack));
app.route('/agents/routine-intent', createAgentRouter(ChickpeaRoutineIntent));
app.route('/channels/slack', channel.route());

export default app;
