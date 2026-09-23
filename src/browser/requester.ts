/**
 * Private delivery of a browser hand-off link to the person who asked. The
 * link is a bearer URL to a live browser, so it reaches only that person: an
 * ephemeral message in a channel, or an ordinary message in their own DM.
 */

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
  surface: 'channel_thread' | 'direct_message';
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

function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The hand-off message. The live-view URL appears only here, never in model context. */
export function browserHandoffMessage(host: string, liveViewUrl: string): string {
  // Slack reads `&`, `<`, and `>` as entities inside a link too; `|` ends the URL.
  const url = escapeSlackText(liveViewUrl).replace(/\|/g, '%7C');
  return `${escapeSlackText(host)} needs you to sign in before I can continue. <${url}|Open the browser> and sign in; ` +
    'it stays open for 10 minutes and only this link reaches it. ' +
    'When you are done, reply here and I will pick up where I left off.';
}
