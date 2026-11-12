/**
 * Private delivery of a browser hand-off link to the person who asked. The
 * link is a bearer URL to a live browser, so it reaches only that person: an
 * ephemeral message in a channel, or an ordinary message in their own DM.
 */
import type { RuntimePlanSurface } from '../agents/runtime-plan.ts';
import { escapeSlackControlCharacters, renderSlackActionLink } from '../slack/message-format.ts';

export interface SlackRequester {
  slackUserId: string;
  channelId: string;
  /** Trusted Slack surface from the host signal; absent on legacy signals. */
  conversationKind?: 'channel' | 'im' | 'mpim';
}

export interface SlackRequesterClient {
  postMessage(args: Record<string, unknown>): Promise<unknown>;
  postEphemeral(args: Record<string, unknown>): Promise<unknown>;
}

export interface SlackRequesterNotifierInput {
  requester: SlackRequester;
  surface: RuntimePlanSurface;
  /** The trusted reply thread, when the conversation has one. */
  threadTs?: string;
  client: () => Promise<SlackRequesterClient>;
}

export type NotifyRequester = (message: { text: string }) => Promise<void>;

/**
 * Only a one-to-one DM gets an ordinary message; a channel or a group DM gets
 * an ephemeral message only the requester sees.
 */
export function createSlackRequesterNotifier(input: SlackRequesterNotifierInput): NotifyRequester {
  const direct = input.surface === 'direct_message' && input.requester.conversationKind === 'im';
  return async ({ text }) => {
    const client = await input.client();
    const thread = input.threadTs ? { thread_ts: input.threadTs } : {};
    if (direct) {
      await client.postMessage({
        channel: input.requester.channelId,
        text,
        unfurl_links: false,
        unfurl_media: false,
        ...thread,
      });
      return;
    }
    await client.postEphemeral({
      channel: input.requester.channelId,
      user: input.requester.slackUserId,
      text,
      ...thread,
    });
  };
}

export const BROWSER_HANDOFF_LINK_LABEL = 'Open the browser';

/**
 * The hand-off message, the only place the live-view URL appears. The tool's
 * output never carries it. In a one-to-one DM it is an ordinary message, so
 * the next turn's thread context reads it back and that turn's model sees the
 * link; a copy drops it (src/review/website-logins.ts).
 */
export function browserHandoffMessage(host: string, liveViewUrl: string): string {
  return `${escapeSlackControlCharacters(host)} needs you to sign in before I can continue. ` +
    `${renderSlackActionLink(liveViewUrl, BROWSER_HANDOFF_LINK_LABEL)} and sign in; ` +
    'it stays open for 10 minutes and only this link reaches it. ' +
    'When you are done, reply here and I will pick up where I left off.';
}
