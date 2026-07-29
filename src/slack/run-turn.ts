import { WebClient } from '@slack/web-api';

import { resolveAgentModel } from '../config/model-policy.ts';
import { getGithubConnection } from '../config/github-app.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { resolveSandboxSettings } from '../config/sandbox-settings.ts';
import { getSettingsStore } from '../config/state-backend.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import { parseMemoryCommand } from '../memory/commands.ts';
import { handleMemoryCommand, prepareMemoryTurn } from '../memory/runtime.ts';
import {
  handleRoutineSlackRequest,
  routineResponseVisibility,
} from '../routines/commands.ts';
import { isRoutineSlackTurn } from '../routines/slack-context.ts';
import {
  AgentPromptFailure,
  promptSlackThreadAgent,
  releaseCloudflareSandboxTurn,
} from './agent-dispatch.ts';
import { resolveSlackCredentials, resolveSlackPublicUrl } from './credentials.ts';
import type { SlackStatusUpdate } from './replies.ts';
import { registerSlackStatusTurn } from './status-registry.ts';
import type { SlackTurnContext } from './thread-context.ts';
import { slackThreadKey } from './thread-key.ts';
import type { NormalizedSlackTurn } from './types.ts';
import { selectSandbox } from '../sandbox/select.ts';
import {
  assembleSlackPrompt,
  hydrateSlackContextViaWebClient,
} from './web-client-context.ts';
import {
  AGENT_FAILURE_TEXT,
  OPENAI_SUBSCRIPTION_POLICY_TEXT,
  OPENAI_SUBSCRIPTION_QUOTA_TEXT,
  OPENAI_SUBSCRIPTION_RECONNECT_TEXT,
  PROVIDER_FAILURE_TEXT,
  SANDBOX_FAILURE_TEXT,
  SANDBOX_SESSION_CAP_FAILURE_TEXT,
  WebClientPresenter,
} from './web-client-presenter.ts';

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
  /** Durable turn key forwarded to the sandbox for cap/idempotency state. */
  turnId?: string;
  /** Recorded result from an earlier attempt; skips the agent entirely. */
  replayText?: string;
  /** Persist sandbox side effects before the final Slack delivery can fail. */
  beforeDelivery?: () => Promise<string | undefined>;
  /** Persist terminal delivery before post-delivery workspace teardown begins. */
  onDelivered?: () => void | Promise<void>;
}

/**
 * Full Slack turn lifecycle:
 *   1. set Assistant status (or post a durable progress placeholder on reject),
 *   2. hydrate the bounded Slack context per contextMode,
 *   3. prompt the durable agent in-process (slack/agent-dispatch.ts) with the
 *      trigger text + hydrated (bot-filtered) context rows,
 *   4. stream the final (fallback to a markdown post), and clear status.
 * An agent/provider/workspace failure is delivered as category-specific static
 * copy (no internal error text ever reaches Slack) and the turn still
 * completes. `runTurn` throws ONLY on a genuine delivery failure, so the
 * caller (node .catch / relay alarm) can release the claims for a retry.
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
  // env (SLACK_TAG_PUBLIC_URL) → stored slack.publicUrl (the origin the admin
  // pinned): on a button deploy nobody sets the env var, so without the stored
  // fallback the footer's "Configure" link would be dead.
  const publicUrl = await resolveSlackPublicUrl(platformEnv);
  if (isRoutineSlackTurn(turn)) {
    const routineText = await handleRoutineSlackRequest(turn, platformEnv);
    if (routineText !== undefined) {
      const routinePresenter = new WebClientPresenter(client, {
        channelId: turn.channelId,
        threadTs: turn.threadTs,
        agentName: assignment.agent.name,
        agentId: assignment.agent.id,
        modelLabel: resolvedModel,
        publicUrl,
        userId: turn.userId,
        workspaceId: turn.workspaceId,
      });
      if (routineResponseVisibility(turn.text, turn.channelId) === 'requester') {
        await routinePresenter.deliverRequesterOnly(routineText, 'markdown');
      } else {
        await routinePresenter.deliverFinal(routineText, 'markdown');
      }
      await options.onDelivered?.();
      return;
    }
  }
  const memoryCommand = parseMemoryCommand(turn.text);
  const preparedMemory = memoryCommand
    ? undefined
    : await prepareMemoryTurn({ turn, platformEnv, client });
  const presenter = new WebClientPresenter(client, {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    agentName: assignment.agent.name,
    agentId: assignment.agent.id,
    modelLabel: resolvedModel,
    publicUrl,
    userId: turn.userId,
    workspaceId: turn.workspaceId,
    ...(preparedMemory ? { memoryFooterItems: preparedMemory.footerItems } : {}),
  });
  const conversationKey = preparedMemory?.conversationKey ?? slackThreadKey(turn);
  const statusGeneration = options.turnId ?? `msg:${turn.channelId}:${turn.messageTs}`;
  const statusTurn = registerSlackStatusTurn(conversationKey, presenter, {
    generation: statusGeneration,
  });
  const closeAndDrainStatus = async (): Promise<void> => {
    // Close the sink first. Agent observations are relayed best-effort from a
    // different Cloudflare isolate and may still arrive after ?wait=result
    // resolves; removing this generation makes its late relays no-ops even if
    // another turn has already registered under the same conversation key.
    // drain() then waits only for the one Slack write already in flight and
    // discards throttled/stale pending detail, so the final is not delayed.
    statusTurn.close();
    await statusTurn.drain();
  };
  let usedCloudflareSandbox = false;

  // 1. Visible work: set status; if it is rejected, post a durable progress
  //    placeholder so the user still sees work in-flight before the final.
  try {
    if (memoryCommand) {
      const handled = await handleMemoryCommand({ turn, platformEnv, client, presenter });
      if (handled) {
        await options.onDelivered?.();
        return;
      }
    }
    const statusSet = await statusTurn.setStatus(readingThreadStatus());
    if (!statusSet) {
      await presenter.postProgress(`${assignment.agent.name} is reading the thread.`);
    }

    // 2. Hydrate bounded context (degrades to current-message-only on failure).
    const hydratedContext = await hydrateSlackContextViaWebClient(client, turn);
    const context = applyVisibilityBarrier(
      hydratedContext,
      preparedMemory?.visibilityBarrierAt ?? null,
    );
    await statusTurn.setStatus(hydratedContextStatus(context));
    const prompt = assembleSlackPrompt(turn, context, {
      ...(preparedMemory?.promptBlock ? { memoryBlock: preparedMemory.promptBlock } : {}),
      memorySelected: (preparedMemory?.selection?.entries.length ?? 0) > 0,
    });

    // 3 + 4. Prompt the durable agent, then deliver the final — with clearStatus
    //    in a finally so a status that was actually set is cleared even if
    //    delivery throws (old-lane parity: the clear happened in a finally; keeps
    //    S03/S15/S16 green). clearStatus is a no-op when no status was set. A
    //    failures surface as non-2xx ?wait=result envelopes; we deliver only
    //    category-specific static copy (no envelope text reaches Slack).
    // The model status is cosmetic: resolving it must never abort the turn.
    // If the model is unresolvable (misconfig), skip the status and let the
    // durable agent's own resolution fail, so the prompt's catch below still
    // delivers a sanitized failure final (not silence + a Slack
    // retry loop from the claims being released on an uncaught throw).
    if (resolvedModel) {
      await statusTurn.setStatus(modelStatus(resolvedModel));
    }
    let text: string;
    if (options.replayText !== undefined) {
      text = options.replayText;
    } else {
      try {
        usedCloudflareSandbox = await shouldUseCloudflareSandbox(assignment, platformEnv);
        text = await promptSlackThreadAgent(
          conversationKey,
          prompt,
          platformEnv,
          statusGeneration,
          usedCloudflareSandbox,
        );
      } catch (err) {
        console.error('[chickpea] agent run failed:', sanitizeError(err));
        const recoveredText = await options.beforeDelivery?.();
        await closeAndDrainStatus();
        if (recoveredText) {
          await preparedMemory?.confirmInjection();
          await presenter.deliverFinal(recoveredText, 'markdown');
          await options.onDelivered?.();
          return;
        }
        await presenter.deliverFinal(agentFailureText(err), 'plain_text');
        await options.onDelivered?.();
        return;
      }
    }
    const recoveredText = await options.beforeDelivery?.();
    // Confirmation only prevents reinjecting the same selection into this
    // transcript. A concurrent turn can legitimately advance the epoch before
    // this one finishes; that bookkeeping race must not discard a completed,
    // lease-valid answer.
    await preparedMemory?.confirmInjection();
    const leaseValid = await preparedMemory?.validateLease() ?? true;
    text = resolveMemoryDeliveryText(
      text,
      recoveredText,
      leaseValid,
    );
    await closeAndDrainStatus();
    await presenter.deliverFinal(text, 'markdown');
    await options.onDelivered?.();
  } finally {
    // Also covers failures before the ordinary delivery boundary (hydration,
    // provider setup, or persistence). Idempotent after the success path.
    try {
      await closeAndDrainStatus();
      await presenter.clearStatus();
    } finally {
      // The Sandbox DO lives in a different isolate from the agent factory;
      // release it by its durable thread id at the actual end-of-turn seam.
      await releaseCloudflareSandboxTurn(
        platformEnv,
        conversationKey,
        usedCloudflareSandbox,
      );
    }
  }
}

export async function shouldUseCloudflareSandbox(
  assignment: ResolvedAssignment,
  env: PlatformEnv | undefined,
): Promise<boolean> {
  if (!isCloudflareTarget()) return false;
  const repositories = assignment.agent.repositories ?? [];
  if (repositories.length === 0) return false;

  try {
    const settingsStore = getSettingsStore(env);
    const [settings, connection] = await Promise.all([
      resolveSandboxSettings(settingsStore),
      getGithubConnection(settingsStore),
    ]);
    return selectSandbox({
      target: 'cloudflare',
      enabled: settings.enabled,
      appConnected: connection.mode === 'app',
      repositoryGrants: repositories,
    }) === 'cloudflare';
  } catch {
    // The agent factory resolves the same live settings and will fail closed.
    // Avoid touching a container when its policy cannot be established here.
    return false;
  }
}

export const MEMORY_CHANGED_RETRY_TEXT =
  'Channel memory or Slack access changed while I was answering, so I withheld the draft. Before trying again, check whether any requested external action already completed.';

export function resolveMemoryDeliveryText(
  draft: string,
  recoveredText: string | undefined,
  leaseValid: boolean,
): string {
  if (leaseValid) return draft;
  return recoveredText || MEMORY_CHANGED_RETRY_TEXT;
}

export function agentFailureText(err: unknown): string {
  if (!(err instanceof AgentPromptFailure)) return AGENT_FAILURE_TEXT;
  if (err.kind === 'provider') return PROVIDER_FAILURE_TEXT;
  if (err.kind === 'openai-subscription-reconnect') return OPENAI_SUBSCRIPTION_RECONNECT_TEXT;
  if (err.kind === 'openai-subscription-quota') return OPENAI_SUBSCRIPTION_QUOTA_TEXT;
  if (err.kind === 'openai-subscription-policy') return OPENAI_SUBSCRIPTION_POLICY_TEXT;
  if (err.kind === 'sandbox') return SANDBOX_FAILURE_TEXT;
  if (err.kind === 'sandbox-session-cap') return SANDBOX_SESSION_CAP_FAILURE_TEXT;
  return AGENT_FAILURE_TEXT;
}

/**
 * Deliver ONLY the sanitized generic failure final — the relay alarm's
 * last-ditch on the terminal attempt, when `runTurn` itself kept throwing (a
 * genuine delivery failure, not an agent execution failure, which runTurn
 * already surfaces as a categorized final and returns). Best-effort: the caller swallows
 * its errors (if Slack is the thing that is failing, this post fails too).
 */
export async function deliverAgentFailureFinal(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  client: WebClient,
  platformEnv?: PlatformEnv,
): Promise<void> {
  const resolvedModel = assignment.model ?? tryResolveAgentModel(assignment.agent);
  const publicUrl = await resolveSlackPublicUrl(platformEnv);
  const presenter = new WebClientPresenter(client, {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    agentName: assignment.agent.name,
    agentId: assignment.agent.id,
    modelLabel: resolvedModel,
    publicUrl,
    userId: turn.userId,
    workspaceId: turn.workspaceId,
  });
  await presenter.deliverFinal(AGENT_FAILURE_TEXT, 'plain_text');
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

export function applyVisibilityBarrier(
  context: SlackTurnContext,
  barrierAt: number | null,
): SlackTurnContext {
  if (barrierAt === null) return context;
  return {
    ...context,
    messages: context.messages.filter((message) => {
      if (message.isTrigger) return true;
      return slackTimestampAtOrAfter(message.ts, barrierAt);
    }),
  };
}

function slackTimestampAtOrAfter(timestamp: string, barrierAt: number): boolean {
  if (!Number.isSafeInteger(barrierAt) || barrierAt < 0) return false;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(timestamp);
  if (!match) return false;
  const fraction = match[2] ?? '';
  const scaleDigits = Math.max(3, fraction.length);
  const scale = 10n ** BigInt(scaleDigits);
  const timestampUnits =
    BigInt(match[1]!) * scale + BigInt(fraction.padEnd(scaleDigits, '0') || '0');
  const barrierUnits = BigInt(barrierAt) * (scale / 1_000n);
  return timestampUnits >= barrierUnits;
}

export function sanitizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
