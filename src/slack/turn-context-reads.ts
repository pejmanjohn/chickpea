import type { WebClient } from '@slack/web-api';

import type { SlackStateStore } from './claim-store.ts';
import { isGatewaySlackWebClient } from './gateway/web-client.ts';
import { seedSlackThreadRecord } from './public-context.ts';
import { createSlackReadGate } from './read-budget.ts';
import type { SlackTurnContext } from './thread-context.ts';
import type { NormalizedSlackTurn } from './types.ts';
import { hydrateSlackContextViaWebClient } from './web-client-context.ts';
import type { SlackPublicContextEntry, SlackPublicContextEntryInput } from '../config/types.ts';

type ThreadRecordStore = {
  listSlackPublicContext(
    workspaceId: string,
    channelId: string,
    rootTs: string,
  ): SlackPublicContextEntry[] | Promise<SlackPublicContextEntry[]>;
  seedSlackPublicContext?(inputs: SlackPublicContextEntryInput[]): number | Promise<number>;
};

/**
 * A turn's Slack reads, sized to the app it runs through. The shared
 * (non-Marketplace) app gets one history and one replies read per minute per
 * workspace, 15 messages each, so reads draw on the workspace's shared
 * budget, and a thread the record already holds is not read at all. What a
 * read returns for a thread is kept in the thread record, so the next turn
 * and the Agent's tools need no Slack read for it. The install's own app
 * reads with its ordinary limits.
 */
export async function hydrateTurnSlackContext(input: {
  client: WebClient;
  turn: NormalizedSlackTurn;
  /** 'gateway' is the shared app. Unknown falls back to the client's own marker. */
  transportMode?: 'direct' | 'gateway';
  botUserId?: string;
  state?: Pick<SlackStateStore, 'reserveSlackRead' | 'applySlackReadCooldown'>;
  record?: ThreadRecordStore;
  maxMessages?: number;
  maxPages?: number;
}): Promise<SlackTurnContext> {
  const { client, turn } = input;
  const gated = input.transportMode
    ? input.transportMode === 'gateway'
    : isGatewaySlackWebClient(client);
  const readGate = createSlackReadGate({ state: input.state, workspaceId: turn.workspaceId, gated });
  const recordCoversThread = gated && turn.contextMode === 'thread' && input.record
    ? await threadRecordHoldsRoot(input.record, turn)
    : false;
  const context = await hydrateSlackContextViaWebClient(client, turn, {
    readGate,
    ...(input.botUserId ? { self: { botUserId: input.botUserId } } : {}),
    recordCoversThread,
    ...(input.maxMessages !== undefined ? { maxMessages: input.maxMessages } : {}),
    ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}),
  });
  if (input.record?.seedSlackPublicContext && turn.contextMode === 'thread') {
    try {
      await seedSlackThreadRecord(
        { seedSlackPublicContext: input.record.seedSlackPublicContext.bind(input.record) },
        turn,
        context,
      );
    } catch {
      // The record is an optimization over Slack reads; a write that cannot
      // land leaves the next turn to read Slack again.
      console.warn('[chickpea] thread record seed failed');
    }
  }
  return context;
}

/**
 * The record holds a thread once it has the root: either the root was a
 * request an Agent answered (every later message was recorded as it
 * arrived), or an earlier read from the root was seeded. On the shared app a
 * second read from the root would return the same first 15 rows, so the
 * record is the better source either way.
 */
async function threadRecordHoldsRoot(
  record: ThreadRecordStore,
  turn: Pick<NormalizedSlackTurn, 'workspaceId' | 'channelId' | 'threadTs'>,
): Promise<boolean> {
  try {
    const rows = await record.listSlackPublicContext(turn.workspaceId, turn.channelId, turn.threadTs);
    return rows.some((row) => row.messageTs === turn.threadTs);
  } catch {
    return false;
  }
}
