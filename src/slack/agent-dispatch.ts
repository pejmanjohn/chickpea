import { flue } from '@flue/runtime/routing';
import type { Hono } from 'hono';

import { getInternalAgentToken, INTERNAL_AGENT_TOKEN_HEADER } from './internal-auth.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { cloudflareSandboxOptionVariants } from '../sandbox/lifecycle.ts';
import { sandboxThreadKey } from '../sandbox/thread-key.ts';
import { prepareSandboxTurn, type SandboxTurnContext } from '../sandbox/turn-context.ts';
import { activityStatusTraceHeaders } from './activity-publisher.ts';
import { opaqueId } from '../work/admission.ts';
import type { WorkTraceCorrelation } from '../work/trace-correlation.ts';

export type AgentPromptFailureKind =
  | 'agent'
  | 'provider'
  | 'openai-subscription-disabled'
  | 'openai-subscription-reconnect'
  | 'openai-subscription-quota'
  | 'openai-subscription-policy'
  | 'sandbox'
  | 'sandbox-session-cap';

export type AgentUsageCompleteness = 'complete' | 'partial' | 'not_reported';

export interface AgentReportedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface AgentReturnedModel {
  provider: string;
  id: string;
}

/**
 * Content-bounded result crossing from Flue execution into the Slack relay.
 * Provider-specific usage fields, registry cost, stream coordinates, and raw
 * envelopes deliberately stop at the parser below.
 */
export interface AgentDispatchResult {
  text: string;
  requestedModel: string | null;
  returnedModel: AgentReturnedModel | null;
  reportedUsage: AgentReportedUsage | null;
  usageCompleteness: AgentUsageCompleteness;
  flueSubmissionRef?: string | null;
}

/** Carries only a public-safe category across the Slack presentation seam. */
export class AgentPromptFailure extends Error {
  constructor(
    readonly kind: AgentPromptFailureKind,
    readonly status: number,
  ) {
    super(`agent prompt failed (${kind}, HTTP ${status})`);
    this.name = 'AgentPromptFailure';
  }
}

/**
 * In-process dispatch to the durable slack-thread agent.
 *
 * The channel used to prompt the agent over an HTTP self-call, which required
 * trusting a self base URL derived from the inbound Host header — a header
 * Slack's signature does not cover — and simply cannot loop back on Workers.
 * Instead, run the SAME Flue agent route in-process: `flue()` returns the
 * mountable Hono sub-app (the exact app src/app.ts mounts), and Hono's
 * `request(path, init, env)` executes the matched handler directly. On node
 * that is the same handler the self-call reached; on Cloudflare the route
 * forwards to the agent Durable Object via the runtime's routeAgentRequest —
 * which is why the caller's platform `env` (bindings) MUST be threaded
 * through. The response contract is unchanged: 200 JSON `{result, ...}`.
 *
 * The internal token still travels on the synthetic request even though the
 * dispatch never leaves the process: the route gate in
 * src/agents/slack-thread.ts guards ALL callers (external HTTP included), and
 * caller + gate share this module instance in every isolate, so the lazy
 * random fallback agrees on both sides.
 */

// Lazy: `flue()` reads the runtime the generated entry configures at startup;
// building the router at first prompt (inside a request) keeps this module
// import-order-independent and free of module-scope work on workerd.
let cachedRouter: Hono | undefined;
function getRouter(): Hono {
  cachedRouter ??= flue();
  return cachedRouter;
}

/**
 * Prompt the durable agent and block for the terminal result. A non-2xx Flue
 * envelope is inspected only to derive a public-safe failure category; its raw
 * text never reaches Slack or this function's thrown error.
 */
export async function promptSlackThreadAgent(
  conversationKey: string,
  message: string,
  env: PlatformEnv | undefined,
  turnId: string,
  useCloudflareSandbox: boolean,
  requestedModel: string | null,
  workCorrelation?: WorkTraceCorrelation,
): Promise<AgentDispatchResult> {
  if (useCloudflareSandbox) {
    try {
      await prepareCloudflareSandboxTurn(env, conversationKey, turnId);
    } catch {
      // This boundary is exclusively the thread-scoped Sandbox binding/RPC
      // setup. Keep its raw control-plane error private while preserving the
      // correct user-visible failure surface.
      throw new AgentPromptFailure('sandbox', 500);
    }
  }
  const path = `/agents/slack-thread/${encodeURIComponent(conversationKey)}?wait=result`;
  const response = await getRouter().request(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_AGENT_TOKEN_HEADER]: getInternalAgentToken(),
        ...activityStatusTraceHeaders(turnId, workCorrelation),
      },
      body: JSON.stringify({ message }),
    },
    env,
  );
  if (!response.ok) {
    const envelope = await response.text().catch(() => '');
    throw new AgentPromptFailure(
      classifyAgentPromptFailure(response.status, envelope),
      response.status,
    );
  }

  return parseAgentDispatchEnvelope(await response.json(), requestedModel);
}

/**
 * Reduce Flue's synchronous result envelope to Chickpea's minimum reporting
 * contract. A successful response containing only zero usage is treated as
 * unreported: some provider adapters initialize an empty accumulator to zero,
 * so accepting it as measured usage would incorrectly present work as free.
 */
export function parseAgentDispatchEnvelope(
  envelope: unknown,
  requestedModel: string | null,
): AgentDispatchResult {
  const body = asRecord(envelope);
  const result = body?.result;
  const text = extractResultText(result);
  if (!text) {
    throw new Error('agent prompt returned no result text');
  }

  const record = asRecord(result);
  const usage = parseReportedUsage(record?.usage);
  return {
    text,
    requestedModel: nonEmptyString(requestedModel),
    returnedModel: parseReturnedModel(record?.model),
    reportedUsage: usage.reportedUsage,
    usageCompleteness: usage.completeness,
    flueSubmissionRef: typeof body?.submissionId === 'string' && body.submissionId
      ? opaqueId('fluesubmission', body.submissionId)
      : null,
  };
}

/**
 * Classify Flue's internal error envelope without returning or logging its
 * message. Exact sandbox markers come first; unknown errors remain generic
 * instead of being falsely blamed on the model provider.
 */
export function classifyAgentPromptFailure(
  _status: number,
  rawEnvelope: string,
): AgentPromptFailureKind {
  const error = parseFlueErrorEnvelope(rawEnvelope);
  const type = error.type.toLowerCase();
  const message = error.message.toLowerCase();
  const searchable = `${type} ${message}`;

  if (message.includes('openai subscription operation failed (preview_disabled)')) {
    return 'openai-subscription-disabled';
  }
  if (
    message.includes('openai subscription operation failed (auth_reconnect_required)') ||
    message.includes('openai subscription operation failed (authorization_missing)') ||
    message.includes('openai subscription operation failed (storage_invalid)')
  ) {
    return 'openai-subscription-reconnect';
  }
  if (message.includes('openai subscription operation failed (subscription_quota_exhausted)')) {
    return 'openai-subscription-quota';
  }
  if (
    message.includes('openai subscription operation failed (entitlement_denied)') ||
    message.includes('openai subscription operation failed (client_rejected)') ||
    message.includes('openai subscription operation failed (originator_rejected)')
  ) {
    return 'openai-subscription-policy';
  }

  if (
    type === 'sandbox_session_cap_reached' ||
    message.includes('coding workspace monthly session limit')
  ) {
    return 'sandbox-session-cap';
  }
  if (
    type === 'sandbox_unavailable' ||
    message.includes('coding workspace is temporarily unavailable') ||
    message.includes('maximum number of running container instances') ||
    message.includes('container was unavailable') ||
    message.includes('container unavailable')
  ) {
    return 'sandbox';
  }
  if (
    type === 'cloudflare_ai_binding_error' ||
    type === 'invalid_provider_registration' ||
    /\b(model|provider|llm|workers ai)\b/.test(searchable)
  ) {
    return 'provider';
  }
  return 'agent';
}

function parseFlueErrorEnvelope(rawEnvelope: string): { type: string; message: string } {
  try {
    const parsed = JSON.parse(rawEnvelope) as {
      error?: { type?: unknown; message?: unknown };
    };
    return {
      type: typeof parsed.error?.type === 'string' ? parsed.error.type : '',
      message: typeof parsed.error?.message === 'string' ? parsed.error.message : '',
    };
  } catch {
    return { type: '', message: '' };
  }
}

function extractResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.data === 'string') return record.data;
  }
  return '';
}

function parseReturnedModel(value: unknown): AgentReturnedModel | null {
  const record = asRecord(value);
  const provider = nonEmptyString(record?.provider);
  const id = nonEmptyString(record?.id);
  return provider && id ? { provider, id } : null;
}

function parseReportedUsage(value: unknown): {
  reportedUsage: AgentReportedUsage | null;
  completeness: AgentUsageCompleteness;
} {
  const record = asRecord(value);
  if (!record) {
    return { reportedUsage: null, completeness: 'not_reported' };
  }

  const rawValues = [record.input, record.output, record.totalTokens];
  const presentValues = rawValues.filter((raw) => raw !== undefined && raw !== null);
  if (presentValues.length === 0 || presentValues.some((raw) => !isTokenCount(raw))) {
    return { reportedUsage: null, completeness: 'not_reported' };
  }

  const reportedUsage: AgentReportedUsage = {
    inputTokens: isTokenCount(record.input) ? record.input : null,
    outputTokens: isTokenCount(record.output) ? record.output : null,
    totalTokens: isTokenCount(record.totalTokens) ? record.totalTokens : null,
  };
  const values = [
    reportedUsage.inputTokens,
    reportedUsage.outputTokens,
    reportedUsage.totalTokens,
  ];
  if (values.every((tokenCount) => tokenCount === 0)) {
    return { reportedUsage: null, completeness: 'not_reported' };
  }
  return {
    reportedUsage,
    completeness: values.every((tokenCount) => tokenCount !== null) ? 'complete' : 'partial',
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isTokenCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export async function prepareCloudflareSandboxTurn(
  env: PlatformEnv | undefined,
  conversationKey: string,
  turnId: string,
): Promise<void> {
  if (!isCloudflareTarget()) return;
  const binding = env?.SANDBOX ?? env?.Sandbox;
  if (!binding) {
    throw new Error('SANDBOX Durable Object binding is unavailable');
  }
  const { getSandbox } = await import('@cloudflare/sandbox');
  const sandboxKey = sandboxThreadKey(conversationKey);
  const preparations = await Promise.allSettled(
    cloudflareSandboxOptionVariants(sandboxKey).map(async (options) => {
      const sandbox = getSandbox(
        binding as Parameters<typeof getSandbox>[0],
        sandboxKey,
        options,
      ) as ReturnType<typeof getSandbox> & SandboxTurnContext;
      await prepareSandboxTurn(sandbox, turnId);
    }),
  );
  if (preparations.some((result) => result.status === 'rejected')) {
    throw new Error('sandbox turn preparation failed');
  }
}

/**
 * End the thread-scoped container lifetime after every turn. This runs in the
 * relay isolate, so it intentionally resolves the Sandbox DO by id instead of
 * relying on the agent isolate's module-local lifecycle registry.
 */
export async function releaseCloudflareSandboxTurn(
  env: PlatformEnv | undefined,
  conversationKey: string,
  usedCloudflareSandbox: boolean,
): Promise<void> {
  if (!usedCloudflareSandbox || !isCloudflareTarget()) return;
  const binding = env?.SANDBOX ?? env?.Sandbox;
  if (!binding) return;

  try {
    const { getSandbox } = await import('@cloudflare/sandbox');
    const sandboxKey = sandboxThreadKey(conversationKey);
    const teardowns = await Promise.allSettled(
      cloudflareSandboxOptionVariants(sandboxKey).map(async (options) => {
        const sandbox = getSandbox(
          binding as Parameters<typeof getSandbox>[0],
          sandboxKey,
          options,
        ) as ReturnType<typeof getSandbox> & { destroy(): Promise<void> };
        // Await the provider operation itself. A local Promise.race timeout
        // cannot cancel destroy(), and letting the same-thread queue advance
        // while teardown remains live could terminate its successor.
        await sandbox.destroy();
      }),
    );
    if (teardowns.some((result) => result.status === 'rejected')) {
      console.warn('[chickpea] coding workspace teardown did not complete');
    }
  } catch {
    // Best-effort cleanup: sleepAfter remains the crash-safe fallback. Do not
    // log the raw SDK error because control-plane details do not belong in the
    // ordinary application log stream.
    console.warn('[chickpea] coding workspace teardown did not complete');
  }
}
