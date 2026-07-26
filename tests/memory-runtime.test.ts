import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';

import { getMemoryStateStore } from '../src/config/state-backend.ts';
import {
  handleMemoryCommand,
  prepareMemoryTurn,
  runMemoryRetentionHousekeeping,
} from '../src/memory/runtime.ts';
import type { MemoryStateStore } from '../src/memory/types.ts';
import type { WebClientPresenter } from '../src/slack/web-client-presenter.ts';
import {
  MEMORY_CHANGED_RETRY_TEXT,
  resolveMemoryDeliveryText,
} from '../src/slack/run-turn.ts';
import { slackThreadKey } from '../src/slack/thread-key.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';

const baseTurn: NormalizedSlackTurn = {
  workspaceId: 'T_RUNTIME',
  channelId: 'C_RUNTIME',
  eventId: 'E1',
  text: '<@U_BOT> Please remember that answers should use short bullets.',
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
    assert.match(delivered[0] ?? '', /Saved workspace memory `answers-should-use-short-bullets`/);

    await handleMemoryCommand({
      turn: { ...baseTurn, eventId: 'E_HELP', text: '<@U_BOT> !memory help' },
      platformEnv: undefined,
      client,
      presenter,
    });
    assert.match(delivered.at(-1) ?? '', /Please remember that <what matters>/);
    assert.match(
      delivered.at(-1) ?? '',
      /!memory report <source-channel-id>\/<slug> <stale\|incorrect\|unsafe\|unclear>/,
    );

    const queryTurn = {
      ...baseTurn,
      eventId: 'E2',
      text: '<@U_BOT> How should you format the answer?',
    };
    const first = await prepareMemoryTurn({ turn: queryTurn, platformEnv: undefined, client });
    assert.match(first.conversationKey, /:memory-e1$/);
    assert.match(first.promptBlock ?? '', /answers-should-use-short-bullets/);
    assert.equal(await first.validateLease(), true);
    const unconfirmedRetry = await prepareMemoryTurn({
      turn: { ...queryTurn, eventId: 'E2-retry' },
      platformEnv: undefined,
      client,
    });
    assert.match(unconfirmedRetry.promptBlock ?? '', /answers-should-use-short-bullets/);
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
        text: '<@U_BOT> !memory update answers-should-use-short-bullets — Keep answers extremely concise.\nUse at most three bullets.',
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

test('a committed memory receipt retries Slack delivery without replaying the mutation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-memory-receipt-retry-'));
  const previous = snapshotEnvironment();
  const originalFetch = globalThis.fetch;
  let deliveryAttempts = 0;
  const delivered: string[] = [];
  try {
    process.env.SLACK_STATE_DB_PATH = join(directory, 'state.db');
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-a-real-token';
    process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
    process.env.SLACK_BOT_USER_ID = 'U_BOT';
    globalThis.fetch = fakeSlackFetch;
    const presenter = {
      async deliverFinal(text: string) {
        deliveryAttempts += 1;
        if (deliveryAttempts === 1) throw new Error('transient Slack write failure');
        delivered.push(text);
      },
    } as unknown as WebClientPresenter;

    assert.equal(
      await handleMemoryCommand({
        turn: { ...baseTurn, eventId: 'E_RECEIPT_RETRY' },
        platformEnv: undefined,
        client: {} as WebClient,
        presenter,
      }),
      true,
    );
    assert.equal(deliveryAttempts, 2);
    assert.match(delivered[0] ?? '', /Saved workspace memory/);

    const state = getMemoryStateStore();
    const [entry] = await state.listEntries({
      storeId: 'store_public_T_RUNTIME',
      sourceChannelId: 'C_RUNTIME',
    });
    assert.ok(entry);
    assert.equal((await state.listRevisions(entry.entryId)).length, 1);
    assert.equal(
      (await state.listAuditEvents({
        domain: 'memory',
        eventType: 'memory.created',
        idempotencyKey: 'memory:slack:T_RUNTIME:E_RECEIPT_RETRY:0',
      })).length,
      1,
    );
    assert.equal(
      (await state.getMutationCounts('T_RUNTIME', 'C_RUNTIME', 'U_MEMBER')).actor,
      1,
    );
  } finally {
    globalThis.fetch = originalFetch;
    process.env.SLACK_STATE_DB_PATH = ':memory:';
    getMemoryStateStore();
    restoreEnvironment(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a teammate-addressed implicit thread reply cannot mutate memory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-memory-mention-'));
  const previous = snapshotEnvironment();
  const originalFetch = globalThis.fetch;
  try {
    process.env.SLACK_STATE_DB_PATH = join(directory, 'state.db');
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-a-real-token';
    process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
    process.env.SLACK_BOT_USER_ID = 'U_BOT';
    globalThis.fetch = fakeSlackFetch;

    const handled = await handleMemoryCommand({
      turn: {
        ...baseTurn,
        eventId: 'E_TEAMMATE_MENTION',
        source: 'implicit_thread_reply',
        text: '<@U_TEAMMATE> Please remember that the launch date moved.',
      },
      platformEnv: undefined,
      client: {} as WebClient,
      presenter: {
        async deliverFinal() {
          assert.fail('teammate-addressed prose must not produce a memory receipt');
        },
      } as unknown as WebClientPresenter,
    });

    assert.equal(handled, false);
    assert.deepEqual(await getMemoryStateStore().listEntries(), []);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.SLACK_STATE_DB_PATH = ':memory:';
    getMemoryStateStore();
    restoreEnvironment(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('private-channel forget requires public/<slug> for retained public memory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-memory-private-forget-'));
  const previous = snapshotEnvironment();
  const originalFetch = globalThis.fetch;
  const delivered: string[] = [];
  try {
    process.env.SLACK_STATE_DB_PATH = join(directory, 'state.db');
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-a-real-token';
    process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
    process.env.SLACK_BOT_USER_ID = 'U_BOT';
    globalThis.fetch = fakePrivateSlackFetch;
    const state = getMemoryStateStore();
    const store = await state.ensurePublicStore('T_RUNTIME');
    await state.createEntry({
      entryId: 'mem_retained_public',
      storeId: store.storeId,
      workspaceId: 'T_RUNTIME',
      sourceChannelId: 'C_RUNTIME',
      slug: 'retained-public',
      description: 'Retained public memory.',
      type: 'fact',
      body: 'Public history.',
      actorId: 'U_MEMBER',
      actorClass: 'member',
      idempotencyKey: 'seed-retained-public',
    });
    const presenter = {
      async deliverFinal(text: string) {
        delivered.push(text);
      },
    } as unknown as WebClientPresenter;

    await handleMemoryCommand({
      turn: {
        ...baseTurn,
        eventId: 'E_FORGET_UNQUALIFIED',
        text: '<@U_BOT> !forget retained-public',
      },
      platformEnv: undefined,
      client: {} as WebClient,
      presenter,
    });
    assert.match(delivered.at(-1) ?? '', /not found/i);

    await handleMemoryCommand({
      turn: {
        ...baseTurn,
        eventId: 'E_FORGET_QUALIFIED',
        text: '<@U_BOT> !forget public/retained-public',
      },
      platformEnv: undefined,
      client: {} as WebClient,
      presenter,
    });
    assert.match(delivered.at(-1) ?? '', /permanently removes `retained-public`/i);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.SLACK_STATE_DB_PATH = ':memory:';
    getMemoryStateStore();
    restoreEnvironment(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('cross-channel disclosure includes the exact review command grammar', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-memory-cross-channel-help-'));
  const previous = snapshotEnvironment();
  const originalFetch = globalThis.fetch;
  try {
    process.env.SLACK_STATE_DB_PATH = join(directory, 'state.db');
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-a-real-token';
    process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
    process.env.SLACK_BOT_USER_ID = 'U_BOT';
    globalThis.fetch = fakeSlackFetch;
    const state = getMemoryStateStore();
    const store = await state.ensurePublicStore('T_RUNTIME');
    await state.createEntry({
      entryId: 'mem_cross_channel',
      storeId: store.storeId,
      workspaceId: 'T_RUNTIME',
      sourceChannelId: 'C_RELEASES',
      slug: 'release-checklist',
      description: 'How releases use the checklist.',
      type: 'project',
      body: 'Run the release checklist before every deployment.',
      actorId: 'U_MEMBER',
      actorClass: 'member',
      idempotencyKey: 'seed-cross-channel',
    });

    const prepared = await prepareMemoryTurn({
      turn: {
        ...baseTurn,
        eventId: 'E_CROSS_CHANNEL_HELP',
        text: '<@U_BOT> What release checklist should I run before deployment?',
      },
      platformEnv: undefined,
      client: {} as WebClient,
    });

    assert.ok(prepared.selection?.entries.some(
      ({ entry }) => entry.entryId === 'mem_cross_channel',
    ));
    assert.ok(prepared.footerItems.includes(
      'Review cross-channel memory: !memory report <source-channel-id>/<slug> <stale|incorrect|unsafe|unclear>',
    ));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.SLACK_STATE_DB_PATH = ':memory:';
    getMemoryStateStore();
    restoreEnvironment(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('memory retention housekeeping runs at most hourly and swallows cleanup failures', async () => {
  let calls = 0;
  const state = {
    async cleanupRetention() {
      calls += 1;
      if (calls === 2) throw new Error('best-effort cleanup failure');
      return { actorIdsCleared: 0, rateWindowsDeleted: 0, contextsDeleted: 0 };
    },
  } as unknown as MemoryStateStore;
  const start = Date.now() + 2 * 60 * 60 * 1_000;

  await runMemoryRetentionHousekeeping(state, start);
  await runMemoryRetentionHousekeeping(state, start + 59 * 60 * 1_000);
  await runMemoryRetentionHousekeeping(state, start + 60 * 60 * 1_000);

  assert.equal(calls, 2);
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

test('memory quarantine hides all pre-trigger transcript history when live Slack scope is unavailable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-memory-quarantine-'));
  const previous = snapshotEnvironment();
  try {
    process.env.SLACK_STATE_DB_PATH = join(directory, 'state.db');
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_BOT_USER_ID;
    const prepared = await prepareMemoryTurn({
      turn: { ...baseTurn, eventId: 'E_QUARANTINE', text: '<@U_BOT> What do you remember?' },
      platformEnv: undefined,
      client: {} as WebClient,
    });
    assert.match(prepared.conversationKey, /:memory-q-E_QUARANTINE$/);
    assert.equal(prepared.visibilityBarrierAt, Number.MAX_SAFE_INTEGER);
    assert.equal(prepared.promptBlock, undefined);
  } finally {
    process.env.SLACK_STATE_DB_PATH = ':memory:';
    getMemoryStateStore();
    restoreEnvironment(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an empty memory selection returns a no-op delivery lease', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-memory-empty-lease-'));
  const previous = snapshotEnvironment();
  const originalFetch = globalThis.fetch;
  try {
    process.env.SLACK_STATE_DB_PATH = join(directory, 'state.db');
    process.env.SLACK_BOT_TOKEN = 'xoxb-empty-lease';
    process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
    process.env.SLACK_BOT_USER_ID = 'U_BOT';
    globalThis.fetch = fakeSlackFetch;
    const prepared = await prepareMemoryTurn({
      turn: { ...baseTurn, eventId: 'E_EMPTY_LEASE', text: '<@U_BOT> Hello' },
      platformEnv: undefined,
      client: {} as WebClient,
    });
    assert.deepEqual(prepared.selection?.entries, []);

    let leaseFetches = 0;
    globalThis.fetch = async () => {
      leaseFetches += 1;
      throw new Error('no-op lease must not fetch Slack truth');
    };
    assert.equal(await prepared.validateLease(), true);
    assert.equal(leaseFetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.SLACK_STATE_DB_PATH = ':memory:';
    getMemoryStateStore();
    restoreEnvironment(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('delivery validates channel transition versions but ignores an unrelated transcript epoch race', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-memory-lease-'));
  const previous = snapshotEnvironment();
  const originalFetch = globalThis.fetch;
  try {
    process.env.SLACK_STATE_DB_PATH = join(directory, 'state.db');
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-a-real-token';
    process.env.SLACK_SIGNING_SECRET = 'test-signing-secret';
    process.env.SLACK_BOT_USER_ID = 'U_BOT';
    globalThis.fetch = fakeSlackFetch;
    const client = {} as WebClient;
    const state = getMemoryStateStore();
    const store = await state.ensurePublicStore('T_RUNTIME');
    await state.createEntry({
      entryId: 'mem_lease', storeId: store.storeId, workspaceId: 'T_RUNTIME',
      sourceChannelId: 'C_RUNTIME', slug: 'lease-guidance', description: 'Use the checklist.',
      type: 'project', body: 'Validate before delivery.', actorId: 'U_MEMBER', actorClass: 'member',
      idempotencyKey: 'lease-seed',
    });
    const query = { ...baseTurn, eventId: 'E_LEASE', text: '<@U_BOT> What is the checklist?' };
    const prepared = await prepareMemoryTurn({ turn: query, platformEnv: undefined, client });
    assert.equal(await prepared.validateLease(), true);

    await state.resolveConversationContext({
      baseConversationKey: slackThreadKey(query),
      scopeSignature: 'unrelated-new-epoch',
      selectionFingerprint: 'unrelated-selection',
      selected: [],
      visibilityBarrierAt: null,
      expiresAt: NOW_PLUS_DAY,
    });
    assert.equal(await prepared.confirmInjection(), false);
    assert.equal(await prepared.validateLease(), true);
    assert.equal(resolveMemoryDeliveryText('completed answer', undefined, true), 'completed answer');

    await state.observeChannelScope({
      workspaceId: 'T_RUNTIME', channelId: 'C_RUNTIME', privacy: 'private',
      displayName: 'bot-test', observedAt: Date.now() + 1,
    });
    assert.equal(await prepared.validateLease(), false);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.SLACK_STATE_DB_PATH = ':memory:';
    getMemoryStateStore();
    restoreEnvironment(previous);
    rmSync(directory, { recursive: true, force: true });
  }
});

const NOW_PLUS_DAY = Date.now() + 24 * 60 * 60 * 1_000;

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

async function fakePrivateSlackFetch(input: string | URL | Request): Promise<Response> {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.pathname.endsWith('/conversations.info')) {
    return Response.json({
      ok: true,
      channel: {
        id: 'C_RUNTIME',
        name: 'bot-test',
        is_member: true,
        is_private: true,
        team_id: 'T_RUNTIME',
      },
    });
  }
  return fakeSlackFetch(input);
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
