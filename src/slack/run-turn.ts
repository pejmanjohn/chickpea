import { WebClient } from '@slack/web-api';

import { resolveAgentModel } from '../config/model-policy.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import { promptSlackThreadAgent } from './agent-dispatch.ts';
import { resolveSlackCredentials } from './credentials.ts';
import type { SlackStatusUpdate } from './replies.ts';
import { registerSlackStatusTurn } from './status-registry.ts';
import type { SlackTurnContext } from './thread-context.ts';
import { slackThreadKey } from './thread-key.ts';
import type { NormalizedSlackTurn } from './types.ts';
import {
  assembleSlackPrompt,
  hydrateSlackContextViaWebClient,
} from './web-client-context.ts';
import { PROVIDER_FAILURE_TEXT, WebClientPresenter } from './web-client-presenter.ts';

/**
 * The turn lifecycle, factored out of the Slack channel so BOTH the node detach
 * path and the Cloudflare turn-relay DO alarm run the exact same code.
 *
 * On node the channel calls `runTurn` inline (floating promise past the ack —
 * node has no waitUntil horizon). On Cloudflare the events handler enqueues the
 * turn into the state Durable Object and the DO's `alarm()` calls `runTurn`
 * there, with the platform's 15-minute wall-time budget instead of the events
 * invocation's ~30s waitUntil cancellation — the whole reason the relay exists.
 * The alarm injects a Slack client it resolved from ITS local settings store
 * (avoiding a Durable Object calling itself over RPC), which is the one reason
 * `runTurn` accepts a client override; everything else is behavior-identical.
 */

/**
 * Build a `@slack/web-api` WebClient with the two workerd fetch fixes the app
 * needs (both no-ops on node). Extracted so the cached channel client and the
 * relay alarm's freshly-resolved client are constructed identically:
 *   1. The WebClient calls its stored fetch as a method (`this.fetchFn(...)`);
 *      workerd rejects fetch invoked with any receiver but globalThis, so we
 *      wrap it to call `globalThis.fetch`.
 *   2. It hardcodes `redirect: 'error'`, which workerd refuses (only
 *      'follow'/'manual' exist at the edge). Slack never redirects, so
 *      'manual' is equivalent without the unsupported value.
 * `retryConfig` is pinned to no retries (deterministic; no 30-minute backoff on
 * a transient upstream). `slackApiUrl` (must end with `/`) lets the offline
 * verification point at a fake Slack.
 */
export function createSlackWebClient(botToken: string | undefined): WebClient {
  const slackApiUrl = process.env.SLACK_API_URL;
  return new WebClient(botToken, {
    retryConfig: { retries: 0 },
    fetch: (input, init) => {
      const patchedInit =
        isCloudflareTarget() && init?.redirect === 'error'
          ? { ...init, redirect: 'manual' as RequestRedirect }
          : init;
      return globalThis.fetch(input, patchedInit);
    },
    ...(slackApiUrl ? { slackApiUrl } : {}),
  });
}

/**
 * Lazily-constructed outbound Slack client, keyed by the RESOLVED bot token
 * (env > wizard-stored; see credentials.ts). Resolving at first use keeps the
 * cloudflare build from binding a token at import time and — because the cache
 * is token-keyed — makes a wizard save take effect on the next event instead of
 * pinning the first-seen token for the isolate's lifetime.
 */
let cachedClient: { botToken: string | undefined; client: WebClient } | undefined;
export async function getClient(env: PlatformEnv | undefined): Promise<WebClient> {
  const { botToken } = await resolveSlackCredentials(env);
  if (!cachedClient || cachedClient.botToken !== botToken) {
    cachedClient = { botToken, client: createSlackWebClient(botToken) };
  }
  return cachedClient.client;
}

export interface RunTurnOptions {
  /**
   * Slack client to use instead of the module-cached one. The relay alarm
   * passes a client it resolved from the state DO's local settings store, so
   * the DO never has to RPC into itself to resolve the bot token.
   */
  client?: WebClient;
}

/**
 * Full turn lifecycle for the Flue lane, at parity with the hand-rolled lane:
 *   1. set Assistant status (or post a durable progress placeholder on reject),
 *   2. hydrate the bounded Slack context per contextMode,
 *   3. prompt the durable agent in-process (slack/agent-dispatch.ts) with the
 *      trigger text + hydrated (bot-filtered) context rows,
 *   4. stream the final (fallback to a markdown post), and clear status.
 * A provider failure is delivered as the sanitized static final (no provider
 * error text ever reaches Slack) and the turn still completes. `runTurn` throws
 * ONLY on a genuine delivery failure, so the caller (node .catch / relay alarm)
 * can release the claims for a retry.
 */
export async function runTurn(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  platformEnv: PlatformEnv | undefined,
  options: RunTurnOptions = {},
): Promise<void> {
  const client = options.client ?? (await getClient(platformEnv));
  // A frozen assignment (from a thread snapshot) carries its model; otherwise
  // resolve it from the agent via policy.
  const resolvedModel = assignment.model ?? tryResolveAgentModel(assignment.agent);
  const presenter = new WebClientPresenter(client, {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    agentName: assignment.agent.name,
    agentId: assignment.agent.id,
    modelLabel: resolvedModel,
    publicUrl: process.env.SLACK_TAG_PUBLIC_URL,
    userId: turn.userId,
    workspaceId: turn.workspaceId,
  });
  const conversationKey = slackThreadKey(turn);
  const statusTurn = registerSlackStatusTurn(conversationKey, presenter);

  // 1. Visible work: set status; if it is rejected, post a durable progress
  //    placeholder so the user still sees work in-flight before the final.
  try {
    const statusSet = await statusTurn.setStatus(readingThreadStatus());
    if (!statusSet) {
      await presenter.postProgress(`${assignment.agent.name} is reading the thread.`);
    }

    // 2. Hydrate bounded context (degrades to current-message-only on failure).
    const context = await hydrateSlackContextViaWebClient(client, turn);
    await statusTurn.setStatus(hydratedContextStatus(context));
    const prompt = assembleSlackPrompt(turn, context);

    // 3 + 4. Prompt the durable agent, then deliver the final — with clearStatus
    //    in a finally so a status that was actually set is cleared even if
    //    delivery throws (old-lane parity: the clear happened in a finally; keeps
    //    S03/S15/S16 green). clearStatus is a no-op when no status was set. A
    //    provider failure surfaces as a non-2xx ?wait=result envelope; we deliver
    //    the sanitized static final (no provider error text ever reaches Slack).
    // The model status is cosmetic: resolving it must never abort the turn.
    // If the model is unresolvable (misconfig), skip the status and let the
    // durable agent's own resolution fail, so the prompt's catch below still
    // delivers the sanitized provider-failure final (not silence + a Slack
    // retry loop from the claims being released on an uncaught throw).
    if (resolvedModel) {
      await statusTurn.setStatus(modelStatus(resolvedModel));
    }
    let text: string;
    try {
      text = await promptSlackThreadAgent(conversationKey, prompt, platformEnv);
    } catch (err) {
      console.error('[tag-team] provider call failed:', sanitizeError(err));
      await statusTurn.drain();
      await presenter.deliverFinal(PROVIDER_FAILURE_TEXT, 'plain_text');
      return;
    }
    await statusTurn.drain();
    await presenter.deliverFinal(text, 'markdown');
  } finally {
    // Close the status registration BEFORE clearing: a late tool_start observed
    // during the clear window is then a no-op instead of writing a fresh status
    // the turn never clears.
    statusTurn.close();
    await presenter.clearStatus();
  }
}

/**
 * Deliver ONLY the sanitized provider-failure final — the relay alarm's
 * last-ditch on the terminal attempt, when `runTurn` itself kept throwing (a
 * genuine delivery failure, not a provider failure, which runTurn already
 * surfaces as this same final and returns). Best-effort: the caller swallows
 * its errors (if Slack is the thing that is failing, this post fails too).
 */
export async function deliverProviderFailureFinal(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  client: WebClient,
): Promise<void> {
  const resolvedModel = assignment.model ?? tryResolveAgentModel(assignment.agent);
  const presenter = new WebClientPresenter(client, {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    agentName: assignment.agent.name,
    agentId: assignment.agent.id,
    modelLabel: resolvedModel,
    publicUrl: process.env.SLACK_TAG_PUBLIC_URL,
    userId: turn.userId,
    workspaceId: turn.workspaceId,
  });
  await presenter.deliverFinal(PROVIDER_FAILURE_TEXT, 'plain_text');
}

function tryResolveAgentModel(agent: Parameters<typeof resolveAgentModel>[0]): string | undefined {
  try {
    return resolveAgentModel(agent);
  } catch {
    return undefined;
  }
}

function readingThreadStatus(): SlackStatusUpdate {
  return { text: 'is reading the thread' };
}

function hydratedContextStatus(context: SlackTurnContext): SlackStatusUpdate {
  const count = context.messages.length;
  const noun = count === 1 ? 'message' : 'messages';
  return {
    text: `is using ${count} ${noun} of ${context.mode} context`,
  };
}

function modelStatus(modelId: string): SlackStatusUpdate {
  return {
    text: `is using ${modelId}`,
  };
}

export function sanitizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
