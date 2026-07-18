import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hydrateSlackContextViaWebClient } from '../src/slack/web-client-context.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

// Minimal WebClient stand-in: only conversations.replies is exercised for a
// thread turn. Pages are returned oldest-first with forward cursors, mirroring
// Slack's real conversations.replies pagination.
function fakeClientWithReplyPages(pages: Array<{ messages: unknown[]; next_cursor?: string }>) {
  const cursorToIndex = new Map<string, number>();
  pages.forEach((page, index) => {
    if (page.next_cursor) cursorToIndex.set(page.next_cursor, index + 1);
  });
  let calls = 0;
  return {
    calls: () => calls,
    conversations: {
      async replies(args: { cursor?: string }) {
        calls += 1;
        const index = args.cursor ? (cursorToIndex.get(args.cursor) ?? 0) : 0;
        const page = pages[index] ?? { messages: [] };
        return {
          ok: true,
          messages: page.messages,
          ...(page.next_cursor ? { response_metadata: { next_cursor: page.next_cursor } } : {}),
        };
      },
    },
  };
}

function threadTurn(overrides: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1',
    channelId: 'C1',
    eventId: 'Ev1',
    text: 'what did we just decide?',
    userId: 'U_HUMAN',
    messageTs: '2000.0000',
    threadTs: '1000.0000',
    source: 'implicit_thread_reply',
    contextMode: 'thread',
    ...overrides,
  };
}

function humanMsg(n: number, ts: string) {
  return { user: 'U_HUMAN', type: 'message', text: `msg ${n}`, ts };
}

test('long thread keeps the NEWEST messages, not the oldest, within the window', async () => {
  // 60 messages across two pages (50 + 10), oldest-first. maxMessages 50.
  const page1 = Array.from({ length: 50 }, (_, i) => humanMsg(i + 1, `${1001 + i}.0000`));
  const page2 = Array.from({ length: 10 }, (_, i) => humanMsg(i + 51, `${1051 + i}.0000`));
  const client = fakeClientWithReplyPages([
    { messages: page1, next_cursor: 'c2' },
    { messages: page2 },
  ]);

  const context = await hydrateSlackContextViaWebClient(
    client as never,
    threadTurn(),
    { maxMessages: 50, maxPages: 3 },
  );

  const texts = context.messages.map((m) => m.text);
  // The recent tail must be present...
  assert.ok(texts.includes('msg 60'), 'newest thread message should be in context');
  assert.ok(texts.includes('msg 51'), 'recent tail should be in context');
  // ...and the oldest messages must have been dropped to make room (not the tail).
  assert.ok(!texts.includes('msg 1'), 'oldest message should be dropped, not the newest');
  // Both pages were walked (the bug stopped after page 1).
  assert.equal(client.calls(), 2);
});

test('short thread (single page) is returned intact', async () => {
  const client = fakeClientWithReplyPages([
    { messages: [humanMsg(1, '1001.0000'), humanMsg(2, '1002.0000')] },
  ]);
  const context = await hydrateSlackContextViaWebClient(
    client as never,
    threadTurn(),
    { maxMessages: 50, maxPages: 3 },
  );
  const texts = context.messages.map((m) => m.text);
  assert.ok(texts.includes('msg 1'));
  assert.ok(texts.includes('msg 2'));
  assert.equal(client.calls(), 1);
});
