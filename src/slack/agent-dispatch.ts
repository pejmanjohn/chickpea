import { flue } from '@flue/runtime/routing';
import type { Hono } from 'hono';

import { getInternalAgentToken, INTERNAL_AGENT_TOKEN_HEADER } from './internal-auth.ts';
import type { PlatformEnv } from '../config/state-backend.ts';

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
 * Prompt the durable agent and block for the terminal result. Throws on a
 * non-2xx (the ?wait=result typed error envelope a provider failure produces)
 * or an empty result — the caller sanitizes both into the provider-failure
 * final without exposing any envelope text to Slack.
 */
export async function promptSlackThreadAgent(
  conversationKey: string,
  message: string,
  env: PlatformEnv | undefined,
): Promise<string> {
  const path = `/agents/slack-thread/${encodeURIComponent(conversationKey)}?wait=result`;
  const response = await getRouter().request(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [INTERNAL_AGENT_TOKEN_HEADER]: getInternalAgentToken(),
      },
      body: JSON.stringify({ message }),
    },
    env,
  );
  if (!response.ok) {
    throw new Error(`agent prompt failed: HTTP ${response.status}`);
  }

  const body = (await response.json()) as { result?: unknown };
  const text = extractResultText(body.result);
  if (!text) {
    throw new Error('agent prompt returned no result text');
  }
  return text;
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
