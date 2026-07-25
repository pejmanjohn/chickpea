import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { getMemoryStateStore } from '../src/config/state-backend.ts';
import { handleMemoryCommand, prepareMemoryTurn } from '../src/memory/runtime.ts';
import type { WebClientPresenter } from '../src/slack/web-client-presenter.ts';
import {
  MEMORY_CHANGED_RETRY_TEXT,
  resolveMemoryDeliveryText,
} from '../src/slack/run-turn.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

const baseTurn: NormalizedSlackTurn = {
  workspaceId: 'T_RUNTIME',
  channelId: 'C_RUNTIME',
  eventId: 'E1',
  text: '<@U_BOT> !remember Answer style — Keep answers concise.\nUse short bullets.',
  userId: 'U_MEMBER',
  messageTs: '1782770400.000100',
  threadTs: '1782770400.000100',
  source: 'app_mention',
  contextMode: 'channel_history',
};

test('Slack commands persist memory even when a legacy disable override remains', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-memory-runtime-'));
  const previous = snapshotEnvironment();
  const originalFetch = globalThis.fetch;
  const delivered: string[] = [];
  try {
    process.env.SLACK_STATE_DB_PATH = join(directory, 'state.db');
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-a-real-token';
    process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
    process.env.SLACK_BOT_USER_ID = 'U_BOT';
    process.env.SLACK_TAG_MEMORY_ENABLED = 'false';
    globalThis.fetch = fakeSlackFetch;
    const client = {} as WebClient;
    const presenter = {
      async deliverFinal(text: string) {
        delivered.push(text);
      },
    } as unknown as WebClientPresenter;

    assert.equal(
      await handleMemoryCommand({ turn: baseTurn, platformEnv: undefined, client, presenter }),
      true,
    );
    assert.match(delivered[0] ?? '', /Saved workspace memory `answer-style`/);

    const queryTurn = {
      ...baseTurn,
      eventId: 'E2',
      text: '<@U_BOT> How should you format the answer?',
    };
    const first = await prepareMemoryTurn({ turn: queryTurn, platformEnv: undefined, client });
    assert.match(first.conversationKey, /:memory-e1$/);
    assert.match(first.promptBlock ?? '', /answer-style/);
    assert.equal(await first.validateLease(), true);
    const unconfirmedRetry = await prepareMemoryTurn({
      turn: { ...queryTurn, eventId: 'E2-retry' },
      platformEnv: undefined,
      client,
    });
    assert.match(unconfirmedRetry.promptBlock ?? '', /answer-style/);
    assert.equal(await first.confirmInjection(), true);

    const second = await prepareMemoryTurn({
      turn: { ...queryTurn, eventId: 'E3', messageTs: '1782770401.000100' },
      platformEnv: undefined,
      client,
    });
    assert.equal(second.conversationKey, first.conversationKey);
    assert.equal(second.promptBlock, undefined);

    await handleMemoryCommand({
      turn: {
        ...baseTurn,
        eventId: 'E4',
        messageTs: '1782770402.000100',
        text: '<@U_BOT> !memory update answer-style — Keep answers extremely concise.\nUse at most three bullets.',
      },
      platformEnv: undefined,
      client,
      presenter,
    });
    assert.equal(await first.validateLease(), false);
    const rotated = await prepareMemoryTurn({
      turn: { ...queryTurn, eventId: 'E5', messageTs: '1782770403.000100' },
      platformEnv: undefined,
      client,
    });
    assert.match(rotated.conversationKey, /:memory-e2$/);
    assert.match(rotated.promptBlock ?? '', /at most three bullets/);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.SLACK_STATE_DB_PATH = ':memory:';
    getMemoryStateStore();
    restoreEnvironment(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('stale delivery leases preserve recovered side-effect receipts and never instruct blind retry', () => {
  assert.equal(
    resolveMemoryDeliveryText('draft', 'Created pull request #42.', false),
    'Created pull request #42.',
  );
  assert.equal(resolveMemoryDeliveryText('draft', undefined, false), MEMORY_CHANGED_RETRY_TEXT);
  assert.doesNotMatch(MEMORY_CHANGED_RETRY_TEXT, /please retry/i);
  assert.equal(resolveMemoryDeliveryText('draft', 'receipt', true), 'draft');
});

async function fakeSlackFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  let body: Record<string, unknown>;
  switch (url.pathname.split('/').pop()) {
    case 'conversations.info':
      body = {
        ok: true,
        channel: {
          id: 'C_RUNTIME', name: 'bot-test', is_member: true, team_id: 'T_RUNTIME',
        },
      };
      break;
    case 'users.info':
      body = { ok: true, user: { id: 'U_MEMBER', team_id: 'T_RUNTIME' } };
      break;
    case 'conversations.members':
      body = { ok: true, members: ['U_MEMBER', 'U_BOT'], response_metadata: { next_cursor: '' } };
      break;
    case 'users.list':
      body = {
        ok: true,
        members: [
          { id: 'U_MEMBER', team_id: 'T_RUNTIME' },
          { id: 'U_BOT', team_id: 'T_RUNTIME', is_bot: true, is_app_user: true },
        ],
        response_metadata: { next_cursor: '' },
      };
      break;
    default:
      body = { ok: false, error: 'unexpected_method' };
  }
  return Response.json(body);
}

function snapshotEnvironment(): Record<string, string | undefined> {
  return {
    SLACK_STATE_DB_PATH: process.env.SLACK_STATE_DB_PATH,
    SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
    SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET,
    SLACK_BOT_USER_ID: process.env.SLACK_BOT_USER_ID,
    SLACK_TAG_MEMORY_ENABLED: process.env.SLACK_TAG_MEMORY_ENABLED,
  };
}

function restoreEnvironment(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
