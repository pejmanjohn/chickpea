// flue-blueprint: channel/slack@1
import { createSlackChannel } from '@flue/slack';
import { WebClient } from '@slack/web-api';

import { resolveEffectiveSlackConfig } from '../config/effective-config.ts';
import { ModelResolutionError } from '../config/errors.ts';
import { resolveAgentModel } from '../config/model-policy.ts';
import { resolveAssignment, type AssignmentSurface } from '../config/resolver.ts';
import { getAgentSnapshotStore } from '../config/snapshot-store.ts';
import { getConfigStore } from '../config/store.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import {
  SqliteSlackStateStore,
  resolveStateDbPath,
  type SlackClaimStore,
  type SlackThreadRegistry,
} from '../slack/claim-store.ts';
import { INTERNAL_AGENT_TOKEN, INTERNAL_AGENT_TOKEN_HEADER } from '../slack/internal-auth.ts';
import { renderChannelOnboarding } from '../slack/message-format.ts';
import type { SlackStatusUpdate } from '../slack/replies.ts';
import { registerSlackStatusTurn } from '../slack/status-registry.ts';
import { slackThreadKey } from '../slack/thread-key.ts';
import type { SlackTurnContext } from '../slack/thread-context.ts';
import { normalizeSlackTurn } from '../slack/turn-normalization.ts';
import {
  isSlackMemberJoinedChannelEvent,
  type NormalizedSlackTurn,
  type SlackEventFixture,
} from '../slack/types.ts';
import {
  assembleSlackPrompt,
  hydrateSlackContextViaWebClient,
} from '../slack/web-client-context.ts';
import { PROVIDER_FAILURE_TEXT, WebClientPresenter } from '../slack/web-client-presenter.ts';

// Loopback-only hostnames: an origin derived from the inbound request's Host
// header (see `resolveSelfBaseUrl`) is only trusted when it points back at
// this same process, since Slack's request signature does not cover Host.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

/**
 * Lazily-constructed outbound Slack client. Reading env at first use (not module
 * load) lets the offline verification point `slackApiUrl` at a fake Slack, and
 * keeps the cloudflare build from binding a token at import time. The v8 client
 * appends the method to `slackApiUrl`, which must end with `/` (it self-corrects
 * if not). `retryConfig` is pinned to no retries to match the hand-rolled lane's
 * raw-fetch sinks (deterministic, no 30-minute backoff on a transient upstream).
 */
let cachedClient: WebClient | undefined;
function getClient(): WebClient {
  if (!cachedClient) {
    const slackApiUrl = process.env.SLACK_API_URL;
    cachedClient = new WebClient(process.env.SLACK_BOT_TOKEN, {
      retryConfig: { retries: 0 },
      ...(slackApiUrl ? { slackApiUrl } : {}),
    });
  }
  return cachedClient;
}

// Claims + thread registry are SQLite-backed (own file, sibling of the Flue
// transcript DB) so a Slack redelivery right after a restart is still
// suppressed and joined threads stay continuable across restarts. Constructed
// lazily like getClient() so env is read at first event, not at import.
let cachedState: SqliteSlackStateStore | undefined;
function getStateStore(): SlackClaimStore & SlackThreadRegistry {
  if (!cachedState) {
    cachedState = new SqliteSlackStateStore(resolveStateDbPath());
  }
  return cachedState;
}

// Bot user id resolution: prefer the configured env, otherwise resolve once via
// auth.test() and cache. An explicitly-empty SLACK_BOT_USER_ID means "no bot
// user id, do not probe auth.test" — the clean knob for fail-closed scenarios
// (S14). On auth.test failure leave it undefined so message-family events fail
// closed in normalization (matching the hand-rolled lane).
let botUserId: string | undefined;
let botUserIdResolved = false;
async function resolveBotUserId(): Promise<string | undefined> {
  const configured = process.env.SLACK_BOT_USER_ID;
  if (configured !== undefined) {
    return configured === '' ? undefined : configured;
  }
  if (botUserIdResolved) {
    return botUserId;
  }
  try {
    const auth = await getClient().auth.test();
    botUserId = typeof auth.user_id === 'string' ? auth.user_id : undefined;
    // Latch only on a successful call: a definitive answer (including "no
    // user_id") is cached, but a transient auth.test failure must not pin
    // botUserId=undefined for the process lifetime — the next event retries.
    botUserIdResolved = true;
  } catch {
    botUserId = undefined;
  }
  return botUserId;
}

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,

  // Path: /channels/slack/events
  async events({ c, payload }) {
    // a. Admission: only Events API callbacks; ack Assistant lifecycle events.
    if (payload.type !== 'event_callback') return;
    const eventType = payload.event.type;
    if (
      eventType === 'assistant_thread_started' ||
      eventType === 'assistant_thread_context_changed'
    ) {
      return;
    }
    if (eventType === 'member_joined_channel') {
      await handleMemberJoinedChannel(payload as unknown as SlackEventFixture);
      return;
    }

    // b. Normalize with the shared admission policy (imported verbatim).
    const resolvedBotUserId = await resolveBotUserId();
    const normalization = normalizeSlackTurn(
      payload as unknown as SlackEventFixture,
      resolvedBotUserId ? { botUserId: resolvedBotUserId } : {},
    );
    if (normalization.status !== 'runnable') return;
    const turn = normalization.turn;
    const threadKey = slackThreadKey(turn);
    const state = getStateStore();

    // c. Implicit thread replies require a thread this app already started (a
    //    prior mention/DM). An unknown thread key produces nothing on the wire
    //    (S13). With the file-backed state store the registry survives
    //    restarts; `:memory:` keeps the old process-local semantics. Checked
    //    before any claim so a dropped reply stays fully silent.
    if (turn.source === 'implicit_thread_reply' && !state.has(threadKey)) {
      return;
    }

    // c2. Direct messages / App Home are a separate surface, on by default.
    //     When SLACK_FLUE_ALLOW_DMS is turned off, the bot is reachable only in
    //     channels (an org-wide direct-message opt-out). Checked before any
    //     claim so a disabled DM stays fully silent.
    const surface = turnSurface(turn);
    if (surface === 'direct' && !directMessagesEnabled()) {
      return;
    }

    // d. Claim BOTH the event id and the (channel, message-ts) so the
    //    app_mention + message fan-out for a single mention replies once.
    const evtKey = `evt:${payload.event_id}`;
    const msgKey = `msg:${turn.channelId}:${turn.messageTs}`;
    if (!state.claim(evtKey)) return;
    if (!state.claim(msgKey)) {
      state.release(evtKey);
      return;
    }

    // e. Resolve the config for this turn — inside a try so any failure releases
    //    the claims (a Slack retry can then re-drive the turn) rather than
    //    leaking them and dropping the message.
    //    - CHANNELS freeze at the first turn: the gate resolves the effective
    //      config ONCE and writes the write-once snapshot, so the presenter and
    //      the durable agent both serve that same row (no first-turn attribution
    //      drift). A started thread is served from its snapshot even if its
    //      profile was since disabled/removed — a disable must not break an
    //      in-flight thread — and a snapshot exists only for a thread whose first
    //      turn passed this gate, so it cannot bypass fail-closed. Channels fail
    //      closed if unassigned and never fall through to the global '*,*'
    //      wildcard (see turnSurface / the resolver).
    //    - DIRECT conversations (DMs, App Home) are one continuous session, not a
    //      discrete thread, so they are NOT frozen: they resolve current config
    //      every turn, so admin edits to the DM profile reach existing DM users.
    let assignment: ResolvedAssignment;
    try {
      const store = getConfigStore();
      const stores = { agents: store, assignments: store };
      assignment =
        surface === 'channel'
          ? getAgentSnapshotStore().getOrCreate(threadKey, () =>
              resolveEffectiveSlackConfig(turn.workspaceId, turn.channelId, stores),
            )
          : resolveAssignment(turn.workspaceId, turn.channelId, stores, { surface });
    } catch (err) {
      // A model that cannot resolve is NOT fail-closed: admit with a best-effort
      // assignment so the turn still delivers the sanitized provider-failure
      // final (no snapshot is written — a misconfigured-model thread has no
      // usable config to freeze). Everything else (unassigned/disabled channel,
      // disabled DM default) is fail-closed: release the claims and stay silent.
      const store = getConfigStore();
      if (err instanceof ModelResolutionError) {
        assignment = resolveAssignment(
          turn.workspaceId,
          turn.channelId,
          { agents: store, assignments: store },
          { surface },
        );
      } else {
        state.release(evtKey);
        state.release(msgKey);
        console.error('[slack-flue] no assignment for turn:', sanitizeError(err));
        return;
      }
    }

    // f. Capture the self-origin BEFORE detaching, then run the turn as a
    //    detached promise so the events callback returns a fast 200. Slack
    //    signatures don't cover the Host header, so an untrusted derived
    //    origin means we skip the turn rather than let a spoofed Host divert
    //    it (with the message content) to an attacker-controlled origin.
    const selfBaseUrl = resolveSelfBaseUrl(c.req.url);
    if (!selfBaseUrl) {
      state.release(evtKey);
      state.release(msgKey);
      console.error('[slack-flue] rejected self-call: untrusted request origin');
      return;
    }

    // g. Mark this thread as started so its later implicit replies are admitted
    //    (mentions and DMs both open a thread the app owns). Registered
    //    pre-turn (before runTurn) on purpose: it admits implicit replies that
    //    arrive while the root turn is still in flight, matching the old lane's
    //    session-created-before-provider-call semantics. A failed turn leaves
    //    the thread registered (only the claims are released, for retry).
    state.start(threadKey);

    void runTurn(turn, assignment, selfBaseUrl).catch((err) => {
      // Release on a genuine delivery failure so a Slack retry can re-drive the
      // turn. A completed turn (including a delivered provider-failure final)
      // returns normally and keeps its claim, so it never re-runs.
      state.release(evtKey);
      state.release(msgKey);
      console.error('[slack-flue] turn failed:', sanitizeError(err));
    });
  },
});

/**
 * Resolve the base URL for the app's own self-call to the agent endpoint.
 *
 * `new URL(c.req.url).origin` is derived from the inbound request's Host
 * header, which Slack's request signature does NOT cover. A captured signed
 * event replayed within the timestamp window with a forged Host header would
 * otherwise make the app POST the turn (message content) to an
 * attacker-controlled origin. So: prefer an explicit operator-configured URL,
 * and otherwise only trust the derived origin when it is loopback (dev/test
 * always run against 127.0.0.1/localhost) — any other host is rejected.
 */
function resolveSelfBaseUrl(requestUrl: string): string | undefined {
  const configured = process.env.FLUE_SELF_URL;
  if (configured) return configured;

  let origin: URL;
  try {
    origin = new URL(requestUrl);
  } catch {
    return undefined;
  }
  return LOOPBACK_HOSTNAMES.has(origin.hostname) ? origin.origin : undefined;
}

/**
 * Full turn lifecycle for the Flue lane, at parity with the hand-rolled lane:
 *   1. set Assistant status (or post a durable progress placeholder on reject),
 *   2. hydrate the bounded Slack context per contextMode,
 *   3. prompt the durable agent over the app's own authenticated HTTP API with
 *      the trigger text + hydrated (bot-filtered) context rows,
 *   4. stream the final (fallback to a markdown post), and clear status.
 * A provider failure is delivered as the sanitized static final (no provider
 * error text ever reaches Slack) and the turn still completes.
 */
async function runTurn(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  selfBaseUrl: string,
): Promise<void> {
  const client = getClient();
  // A frozen assignment (from a thread snapshot) carries its model; otherwise
  // resolve it from the agent via policy.
  const resolvedModel = assignment.model ?? tryResolveAgentModel(assignment.agent);
  const presenter = new WebClientPresenter(client, {
    channelId: turn.channelId,
    threadTs: turn.threadTs,
    agentName: assignment.agent.name,
    agentId: assignment.agent.id,
    modelLabel: resolvedModel,
    publicUrl: process.env.SLACK_FLUE_PUBLIC_URL,
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
    // durable agent's own resolution fail, so promptAgent's catch below still
    // delivers the sanitized provider-failure final (not silence + a Slack
    // retry loop from the claims being released on an uncaught throw).
    if (resolvedModel) {
      await statusTurn.setStatus(modelStatus(resolvedModel));
    }
    let text: string;
    try {
      text = await promptAgent(turn, prompt, selfBaseUrl);
    } catch (err) {
      console.error('[slack-flue] provider call failed:', sanitizeError(err));
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

async function handleMemberJoinedChannel(payload: SlackEventFixture): Promise<void> {
  const event = payload.event;
  if (!isSlackMemberJoinedChannelEvent(event)) {
    return;
  }

  const resolvedBotUserId = await resolveBotUserId();
  if (!resolvedBotUserId || event.user !== resolvedBotUserId) {
    return;
  }

  // Fail-closed, exactly like every turn: only greet in a channel that has an
  // enabled assignment. The direct-message wildcard must never cause an
  // unsolicited onboarding message in a channel the bot was never configured for.
  const workspaceId = payload.team_id ?? event.team;
  if (!workspaceId) {
    return;
  }
  try {
    const store = getConfigStore();
    resolveAssignment(
      workspaceId,
      event.channel,
      { agents: store, assignments: store },
      { surface: 'channel' },
    );
  } catch {
    return;
  }

  const state = getStateStore();
  const evtKey = `evt:${payload.event_id}`;
  if (!state.claim(evtKey)) {
    return;
  }

  try {
    await getClient().chat.postMessage({
      channel: event.channel,
      text: renderChannelOnboarding({
        botUserId: resolvedBotUserId,
        channelId: event.channel,
        publicUrl: process.env.SLACK_FLUE_PUBLIC_URL,
      }),
    });
  } catch (err) {
    // Best-effort courtesy: log and KEEP the claim so a Slack retry cannot
    // double-post the disclosure. Never rethrow — the events route turns a
    // throw into a 500, which is exactly what makes Slack redeliver the event.
    console.error('[slack-flue] channel onboarding post failed:', sanitizeError(err));
  }
}

function tryResolveAgentModel(agent: Parameters<typeof resolveAgentModel>[0]): string | undefined {
  try {
    return resolveAgentModel(agent);
  } catch {
    return undefined;
  }
}

// The turn's surface, from the normalizer's authoritative source/channel_type
// (not a channel-id prefix): a DM or App Home message ('dm_message'), and any
// im/app_home/mpim thread, is 'direct'; everything else is a channel. A group-DM
// app_mention carries no channel_type and falls through to 'channel' — the
// fail-closed default (see surfaceForChannelId for the id ambiguity).
function turnSurface(turn: NormalizedSlackTurn): AssignmentSurface {
  if (turn.source === 'dm_message') {
    return 'direct';
  }
  const channelType = turn.channelType;
  if (channelType === 'im' || channelType === 'app_home' || channelType === 'mpim') {
    return 'direct';
  }
  return 'channel';
}

// Direct messages / App Home are on by default; SLACK_FLUE_ALLOW_DMS=false (or
// 0/off/no) turns them off so the bot is reachable only in channels.
function directMessagesEnabled(): boolean {
  const raw = process.env.SLACK_FLUE_ALLOW_DMS?.trim().toLowerCase();
  return !(raw === 'false' || raw === '0' || raw === 'off' || raw === 'no');
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

/**
 * Prompt the durable agent over the app's own HTTP API and block for the
 * terminal result. Throws on a non-2xx (the ?wait=result typed error envelope a
 * provider failure produces) or an empty result — the caller sanitizes both
 * into the provider-failure final without exposing any envelope text to Slack.
 */
async function promptAgent(
  turn: NormalizedSlackTurn,
  message: string,
  selfBaseUrl: string,
): Promise<string> {
  const conversationKey = slackThreadKey(turn);
  const url =
    `${selfBaseUrl.replace(/\/$/, '')}` +
    `/agents/slack-thread/${encodeURIComponent(conversationKey)}?wait=result`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [INTERNAL_AGENT_TOKEN_HEADER]: INTERNAL_AGENT_TOKEN,
    },
    body: JSON.stringify({ message }),
  });
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

function sanitizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
