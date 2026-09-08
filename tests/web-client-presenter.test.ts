import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import {
  deliverPersistedSlackPayload,
  slackDeliveryFailureOutcome,
  WebClientPresenter,
} from '../src/slack/web-client-presenter.ts';
import { activityStatus } from '../src/activity/status.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { syntheticPem } from './helpers/credential-fixtures.ts';

function presenterWith(client: unknown): WebClientPresenter {
  return new WebClientPresenter(client as WebClient, {
    channelId: 'C_BOUND',
    threadTs: '1782770400.000100',
    agentName: 'Test agent',
    agentAvatarUrl: 'https://chickpea.example/assets/agents/test/avatar/1',
    agentId: 'agent_test',
  });
}

test('gateway delivery certainty distinguishes rejected 4xx and 429 calls from ambiguous effects', () => {
  assert.equal(
    slackDeliveryFailureOutcome(new SlackTransportError(
      'chat.postMessage', 'gateway_http_400', { effectOutcome: 'failed' },
    )),
    'failed',
  );
  assert.equal(
    slackDeliveryFailureOutcome(new SlackTransportError(
      'chat.postMessage', 'gateway_http_429', { retryable: true, effectOutcome: 'failed' },
    )),
    'failed',
  );
  assert.equal(
    slackDeliveryFailureOutcome(new SlackTransportError(
      'chat.postMessage', 'gateway_http_500', { retryable: true, effectOutcome: 'unknown' },
    )),
    'unknown',
  );
  assert.equal(
    slackDeliveryFailureOutcome(new SlackTransportError(
      'chat.postMessage', 'gateway_network', { retryable: true, effectOutcome: 'unknown' },
    )),
    'unknown',
  );
});

test('compatibility status uses meaningful activity without repeating the Agent name', async () => {
  const calls: unknown[] = [];
  const presenter = new WebClientPresenter({
    assistant: {
      threads: {
        async setStatus(input: unknown) {
          calls.push(input);
          return { ok: true };
        },
      },
    },
  } as unknown as WebClient, {
    channelId: 'C_BOUND',
    threadTs: '1782770400.000100',
    agentName: 'Test agent',
    agentId: 'agent_test',
    userId: 'U_BOUND',
    workspaceId: 'T_BOUND',
  });

  await presenter.setStatus(activityStatus('preparing', 'Preparing', 'your request'));
  await presenter.setStatus(activityStatus('checking', 'Searching', 'the workspace'));

  assert.deepEqual(calls, [
    {
      channel_id: 'C_BOUND',
      thread_ts: '1782770400.000100',
      status: 'Preparing your request…',
      loading_messages: ['Preparing your request…'],
    },
    {
      channel_id: 'C_BOUND',
      thread_ts: '1782770400.000100',
      status: 'Searching the workspace…',
      loading_messages: ['Searching the workspace…'],
    },
  ]);
});

test('new activity stays on native status and clears without a progress message', async () => {
  const events: Array<{ kind: string; input: Record<string, unknown> }> = [];
  const presenter = presenterWith({
    assistant: {
      threads: {
        async setStatus(input: Record<string, unknown>) {
          events.push({ kind: 'native', input });
          return { ok: true };
        },
      },
    },
    chat: {
      async postMessage(input: Record<string, unknown>) {
        events.push({ kind: 'activity', input });
        return { ok: true, ts: '1782770400.000200' };
      },
    },
  });
  const update = activityStatus('writing', 'Drafting', 'the initial skill');

  await presenter.setStatus(update);
  assert.equal(await presenter.clearStatus(), 'acknowledged');

  assert.deepEqual(events.map(({ kind }) => kind), ['native', 'native']);
  assert.deepEqual(events[0]?.input, {
    channel_id: 'C_BOUND',
    thread_ts: '1782770400.000100',
    status: 'Drafting the initial skill…',
    loading_messages: ['Drafting the initial skill…'],
  });
  assert.deepEqual(events[1]?.input, {
    channel_id: 'C_BOUND',
    thread_ts: '1782770400.000100',
    status: '',
  });
});

test('V3 Chickpea chooses native status instead of a transient chat message', async () => {
  const presenter = new WebClientPresenter({} as WebClient, {
    channelId: 'C_BOUND',
    threadTs: '1782770400.000100',
    agentName: 'Chickpea',
    agentId: 'agent_chickpea',
    visibleOwner: { kind: 'chickpea' },
  });

  assert.equal(presenter.preferredActivitySurface(), 'assistant_status');
});

test('selected Agent native status carries its frozen persona', async () => {
  const statuses: Array<Record<string, unknown>> = [];
  const presenter = new WebClientPresenter({
    assistant: { threads: { setStatus: async (input: Record<string, unknown>) => {
      statuses.push(input);
      return { ok: true };
    } } },
  } as unknown as WebClient, {
    channelId: 'C_BOUND',
    threadTs: '1782770400.000100',
    agentName: 'Sprout',
    agentId: 'agent_sprout',
    visibleOwner: {
      kind: 'selected_agent',
      persona: {
        name: 'Sprout',
        avatarUrl: 'https://chickpea.example/assets/agents/sprout/avatar/3',
        avatarRevision: 3,
      },
    },
  });

  assert.equal(await presenter.setStatus(
    activityStatus('writing', 'Drafting', 'the response'),
  ), true);
  assert.equal(await presenter.clearStatus(), 'acknowledged');
  assert.deepEqual(statuses, [
    {
      channel_id: 'C_BOUND',
      thread_ts: '1782770400.000100',
      status: 'Drafting the response…',
      loading_messages: ['Drafting the response…'],
      username: 'Sprout',
      icon_url: 'https://chickpea.example/assets/agents/sprout/avatar/3',
    },
    {
      channel_id: 'C_BOUND',
      thread_ts: '1782770400.000100',
      status: '',
    },
  ]);
});

test('meaningful activity is native-only with frozen selected-Agent authorship', async () => {
  const posts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  let compatibilityStatuses = 0;
  const presenter = new WebClientPresenter({
    assistant: { threads: { setStatus: async () => {
      compatibilityStatuses += 1;
      return { ok: true };
    } } },
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, ts: '1782770400.000150' };
      },
      update: async (input: Record<string, unknown>) => {
        updates.push(input);
        return { ok: true };
      },
    },
  } as unknown as WebClient, {
    channelId: 'C_BOUND',
    threadTs: '1782770400.000100',
    agentName: 'Skill Builder',
    agentAvatarUrl: 'https://chickpea.example/assets/agents/skill-builder/avatar/2',
    agentId: 'agent_skill_builder',
    visibleOwner: {
      kind: 'selected_agent',
      persona: {
        name: 'Skill Builder',
        avatarUrl: 'https://chickpea.example/assets/agents/skill-builder/avatar/2',
        avatarRevision: 2,
      },
    },
  });

  assert.equal(await presenter.setStatus({
    kind: 'writing', action: 'Drafting', object: 'the initial skill',
    text: 'Drafting the initial skill…',
  }), true);
  assert.equal(await presenter.setStatus({
    kind: 'checking', action: 'Checking', object: 'Google Ads access',
    text: 'Checking Google Ads access…',
  }), true);

  assert.equal(compatibilityStatuses, 2);
  assert.deepEqual(posts, []);
  assert.deepEqual(updates, []);
});

test('legacy message activity can update a stored coordinate but never creates a new one', async () => {
  const posts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const client = {
    chat: {
      postMessage: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, ts: '1782770400.000160' };
      },
      update: async (input: Record<string, unknown>) => {
        updates.push(input);
        return { ok: true };
      },
    },
  } as unknown as WebClient;
  const target = {
    channelId: 'C_BOUND', threadTs: '1782770400.000100',
    agentName: 'Test agent', agentId: 'agent_test',
  };
  const operationId = 'activity_run_durable_1';
  const first = new WebClientPresenter(client, target);
  assert.equal(await first.setStatus(
    activityStatus('writing', 'Drafting', 'the initial skill'),
    { operationId, surface: 'message' },
  ), false);
  assert.deepEqual(posts, []);

  const retried = new WebClientPresenter(client, target, undefined, {
    activityProjection: {
      surface: 'message', state: 'visible', messageTs: '1782770400.000160',
    },
  });
  assert.equal(await retried.setStatus(
    activityStatus('checking', 'Checking', 'Google Ads access'),
    { operationId: 'activity_run_durable_2', surface: 'message',
      messageTs: '1782770400.000160' },
  ), true);
  assert.equal(posts.length, 0);
  assert.equal(updates[0]?.ts, '1782770400.000160');
});

test('an ambiguous native rejection is recorded without creating a message fallback', async () => {
  let progressPosts = 0;
  const nativeStatuses: string[] = [];
  const presenter = presenterWith({
    chat: {
      async postMessage() {
        progressPosts += 1;
        return { ok: true, ts: 'should-not-exist' };
      },
    },
    assistant: {
      threads: {
        async setStatus(input: { status: string }) {
          nativeStatuses.push(input.status);
          if (input.status) throw { code: ErrorCode.RequestError };
          return { ok: true };
        },
      },
    },
  });

  assert.equal(await presenter.setStatus({ text: 'Drafting the initial skill…' }), false);
  assert.equal(presenter.activityReceiptCertainty(), 'unknown');
  assert.equal(await presenter.clearStatus(), 'acknowledged');
  assert.deepEqual(nativeStatuses, ['Drafting the initial skill…', '']);
  assert.equal(progressPosts, 0);
});

test('native rejection latches semantic status off without blocking final delivery', async () => {
  let nativeAttempts = 0;
  let progressPosts = 0;
  let finalStarts = 0;
  const presenter = new WebClientPresenter({
    assistant: { threads: { setStatus: async () => {
      nativeAttempts += 1;
      throw { code: ErrorCode.RequestError };
    } } },
    chat: {
      postMessage: async () => {
        progressPosts += 1;
        return { ok: true, ts: 'should-not-exist' };
      },
      startStream: async () => {
        finalStarts += 1;
        return { ok: true, ts: 'final-ts' };
      },
      stopStream: async () => ({ ok: true }),
    },
  } as unknown as WebClient, {
    channelId: 'C_BOUND',
    threadTs: '1782770400.000100',
    agentName: 'Test agent',
    agentId: 'agent_test',
    userId: 'U_BOUND',
    workspaceId: 'T_BOUND',
  });

  assert.equal(await presenter.setStatus({ text: 'Thinking…' }), false);
  assert.equal(await presenter.setStatus({ text: 'Checking Gmail…' }), false);
  await presenter.deliverFinal('The final answer.', 'markdown');

  assert.equal(nativeAttempts, 1);
  assert.equal(progressPosts, 0);
  assert.equal(finalStarts, 1);
});

test('native rate rejection shares retry timing and stops later custom attempts', async () => {
  let nativeAttempts = 0;
  let reservations = 0;
  const cooldowns: number[] = [];
  const presenter = new WebClientPresenter({
    assistant: { threads: { setStatus: async () => {
      nativeAttempts += 1;
      throw { code: ErrorCode.RateLimitedError, retryAfter: 3 };
    } } },
  } as unknown as WebClient, {
    channelId: 'C_BOUND',
    threadTs: '1782770400.000100',
    agentName: 'Test agent',
    agentId: 'agent_test',
  }, undefined, {
    activityStatusCoordinator: {
      reserve: async () => {
        reservations += 1;
        return { outcome: 'reserved' };
      },
      applyCooldown: async (retryAfterMs) => {
        cooldowns.push(retryAfterMs);
      },
    },
  });

  assert.equal(await presenter.setStatus({ text: 'Thinking…' }), false);
  assert.equal(await presenter.setStatus({ text: 'Checking Gmail…' }), false);
  assert.equal(nativeAttempts, 1);
  assert.equal(reservations, 1);
  assert.deepEqual(cooldowns, [3_000]);
});

test('gateway native rate timing reaches the shared cooldown coordinator', async () => {
  const cooldowns: number[] = [];
  const presenter = new WebClientPresenter({
    assistant: { threads: { setStatus: async () => {
      throw new SlackTransportError(
        'assistant.threads.setStatus',
        'gateway_http_429',
        { retryable: true, effectOutcome: 'failed', retryAfterMs: 7_000 },
      );
    } } },
  } as unknown as WebClient, {
    channelId: 'C_BOUND', threadTs: '1782770400.000100',
    agentName: 'Test agent', agentId: 'agent_test',
  }, undefined, {
    activityStatusCoordinator: {
      reserve: async () => ({ outcome: 'reserved' }),
      applyCooldown: async (retryAfterMs) => { cooldowns.push(retryAfterMs); },
    },
  });

  assert.equal(await presenter.setStatus({ text: 'Thinking…' }), false);
  assert.deepEqual(cooldowns, [7_000]);
});

test('a shared-budget drop cannot reuse an older acknowledged receipt', async () => {
  let reservations = 0;
  let nativeAttempts = 0;
  const presenter = new WebClientPresenter({
    assistant: { threads: { setStatus: async () => {
      nativeAttempts += 1;
      return { ok: true };
    } } },
  } as unknown as WebClient, {
    channelId: 'C_BOUND', threadTs: '1782770400.000100',
    agentName: 'Test agent', agentId: 'agent_test',
  }, undefined, {
    activityStatusCoordinator: {
      reserve: async () => ({ outcome: reservations++ === 0 ? 'reserved' : 'exhausted' }),
      applyCooldown: async () => {},
    },
  });

  assert.equal(await presenter.setStatus({ text: 'Thinking…' }), true);
  assert.equal(presenter.activityReceiptCertainty(), 'acknowledged');
  assert.equal(await presenter.setStatus({ text: 'Checking Gmail…' }), false);
  assert.equal(presenter.activityReceiptCertainty(), 'failed');
  assert.equal(nativeAttempts, 1);
});

test('clearStatus clears the thread without re-sending Agent display fields', async () => {
  const calls: unknown[] = [];
  const presenter = presenterWith({
    assistant: {
      threads: {
        async setStatus(input: unknown) {
          calls.push(input);
          return { ok: true };
        },
      },
    },
  });

  await presenter.setStatus(activityStatus('preparing', 'Preparing', 'your request'));
  await presenter.clearStatus();

  assert.deepEqual(calls.at(-1), {
    channel_id: 'C_BOUND',
    thread_ts: '1782770400.000100',
    status: '',
  });
});

test('postArtifact sends bytes to files.uploadV2 in the requested thread', async () => {
  const calls: unknown[] = [];
  const presenter = presenterWith({
    files: {
      async uploadV2(input: unknown) {
        calls.push(input);
        return { ok: true };
      },
    },
  });

  const result = await presenter.postArtifact({
    channel: 'C_ARTIFACT',
    threadTs: '1782770400.000200',
    bytes: new Uint8Array([137, 80, 78, 71]),
    filename: 'proof.png',
    title: 'Browser proof',
  });

  assert.deepEqual(result, { uploaded: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    channel_id: 'C_ARTIFACT',
    thread_ts: '1782770400.000200',
    file: Buffer.from([137, 80, 78, 71]),
    filename: 'proof.png',
    title: 'Browser proof',
    username: 'Test agent',
    icon_url: 'https://chickpea.example/assets/agents/test/avatar/1',
  });
});

test('postArtifact degrades missing Slack file-upload scope errors', async () => {
  for (const error of ['missing_scope', 'not_allowed_token_type']) {
    const presenter = presenterWith({
      files: {
        async uploadV2() {
          throw { data: { error } };
        },
      },
    });

    assert.deepEqual(
      await presenter.postArtifact({
        channel: 'C_ARTIFACT',
        threadTs: '1782770400.000200',
        bytes: new Uint8Array([1]),
        filename: 'proof.txt',
      }),
      { uploaded: false, reason: 'missing-scope' },
    );
  }
});

test('postArtifact rethrows unrelated Slack upload failures', async () => {
  const failure = { data: { error: 'invalid_channel' } };
  const presenter = presenterWith({
    files: {
      async uploadV2() {
        throw failure;
      },
    },
  });

  await assert.rejects(
    presenter.postArtifact({
      channel: 'C_ARTIFACT',
      threadTs: '1782770400.000200',
      bytes: new Uint8Array([1]),
      filename: 'proof.txt',
    }),
    (err) => err === failure,
  );
});

test('deliverFinal sanitizes emphasized URLs before streaming them to Slack', async () => {
  const calls: unknown[] = [];
  const presenter = new WebClientPresenter(
    {
      chat: {
        async startStream(input: unknown) {
          calls.push(input);
          return { ok: true, ts: '1782770400.000300' };
        },
        async stopStream() {
          return { ok: true };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND',
      threadTs: '1782770400.000100',
      userId: 'U_REQUESTER',
      workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent',
      agentId: 'agent_test',
    },
  );

  await presenter.deliverFinal(
    'Done: **https://github.com/octo-org/example-site/pull/4**',
    'markdown',
  );

  assert.equal(
    (calls[0] as { markdown_text?: string }).markdown_text,
    'Done: https://github.com/octo-org/example-site/pull/4',
  );
});

test('deliverFinal redacts credential-shaped content before streaming it to Slack', async () => {
  const starts: Array<Record<string, unknown>> = [];
  const approvedOutputs: string[] = [];
  const presenter = new WebClientPresenter(
    {
      chat: {
        async startStream(input: Record<string, unknown>) {
          starts.push(input);
          return { ok: true, ts: '1782770400.000301' };
        },
        async stopStream() {
          return { ok: true };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND',
      threadTs: '1782770400.000100',
      userId: 'U_REQUESTER',
      workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent',
      agentId: 'agent_test',
    },
    {
      async beforeDelivery(input) {
        approvedOutputs.push(input.approvedOutput);
        return 'attempt-redacted-output';
      },
      async afterDelivery() {},
    },
  );
  const canaries = [
    'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
    ['x', 'app'].join('') + '-1-A0123456789-abcdefghijklmnopqrstuvwx',
    ['gh', 'o_'].join('') + 'abcdefghijklmnopqrstuvwxyz012',
  ];

  await presenter.deliverFinal(`Credentials: ${canaries.join(' ')}`, 'markdown');

  assert.equal(starts.length, 1);
  assert.equal(approvedOutputs.length, 1);
  for (const output of [String(starts[0]?.markdown_text), approvedOutputs[0]!]) {
    for (const canary of canaries) assert.doesNotMatch(output, new RegExp(canary));
    assert.match(output, /\[credential redacted\]/);
  }
});

test('deliverFinal removes an algorithm-labeled PEM key before streaming or durable observation', async () => {
  const starts: Array<Record<string, unknown>> = [];
  const approvedOutputs: string[] = [];
  const presenter = new WebClientPresenter(
    {
      chat: {
        async startStream(input: Record<string, unknown>) {
          starts.push(input);
          return { ok: true, ts: '1782770400.000302' };
        },
        async stopStream() { return { ok: true }; },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND', threadTs: '1782770400.000100',
      userId: 'U_REQUESTER', workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent', agentId: 'agent_test',
    },
    {
      async beforeDelivery(input) {
        approvedOutputs.push(input.approvedOutput);
        return 'attempt-pem-redaction';
      },
      async afterDelivery() {},
    },
  );
  const pem = syntheticPem('DSA PRIVATE KEY', [
    'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEA',
    'c2VjcmV0LWJ5dGVzLXRoYXQtbXVzdC1ub3Qtc3Vydml2ZQ==',
  ]);

  await presenter.deliverFinal(`Credential:\n${pem}\nDone.`, 'markdown');

  for (const output of [String(starts[0]?.markdown_text), approvedOutputs[0]!]) {
    assert.match(output, /\[credential redacted\]/);
    assert.doesNotMatch(output, /MIIE|c2VjcmV0|END DSA PRIVATE KEY/);
  }
});

test('deliverFinal attaches a native static table before the footer', async () => {
  const starts: Array<Record<string, unknown>> = [];
  const stops: Array<Record<string, unknown>> = [];
  const presenter = new WebClientPresenter(
    {
      chat: {
        async startStream(input: Record<string, unknown>) {
          starts.push(input);
          return { ok: true, ts: '1782770400.000320' };
        },
        async stopStream(input: Record<string, unknown>) {
          stops.push(input);
          return { ok: true };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND', threadTs: '1782770400.000100',
      userId: 'U_REQUESTER', workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent', agentId: 'agent_test',
    },
  );

  await presenter.deliverFinal(
    'The relocation bonus is ready for review.',
    'markdown',
    'complete',
    {
      caption: 'Synthetic relocation bonus allocation',
      presentation: 'static',
      columns: [{ header: 'Component' }, { header: 'CAD', type: 'number' }],
      rows: [
        ['Taxable', 9_350],
        ['Non-taxable', 650],
        ['Employer tax', 420],
        ['Benefits', 80],
        ['Gross addition', 10_500],
        ['Net addition', 9_920],
        ['Total', 10_000],
      ],
    },
  );

  assert.equal(starts[0]?.markdown_text, 'The relocation bonus is ready for review.');
  const blocks = stops[0]?.blocks as Array<{ type: string; rows?: unknown[] }>;
  assert.deepEqual(blocks.map(({ type }) => type), ['table', 'context']);
  assert.equal(blocks[0]?.rows?.length, 8);
});

test('requester-only data tables retain caption, row header, and readable fallback text', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const presenter = new WebClientPresenter(
    {
      chat: {
        async postEphemeral(input: Record<string, unknown>) {
          calls.push(input);
          return { ok: true, message_ts: '1782770400.000410' };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_INVOKING', threadTs: '1782770400.000100',
      userId: 'U_REQUESTER', workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent', agentId: 'agent_test',
    },
  );

  await presenter.deliverRequesterOnly(
    'The queue is ordered by impact.',
    'markdown',
    {
      caption: 'Synthetic support queue',
      presentation: 'explore',
      columns: [{ header: 'Ticket' }, { header: 'Affected users', type: 'number' }],
      rows: Array.from({ length: 7 }, (_, index) => [`SUP-${index + 1}`, 75 - index * 9]),
      rowHeaderIndex: 0,
      pageSize: 2,
    },
  );

  const blocks = calls[0]?.blocks as Array<Record<string, unknown>>;
  assert.deepEqual(blocks.map(({ type }) => type), ['markdown', 'data_table', 'context']);
  assert.equal(blocks[1]?.caption, 'Synthetic support queue');
  assert.equal(blocks[1]?.row_header_column_index, 0);
  assert.match(String(calls[0]?.text), /Ticket: SUP-1 \| Affected users: 75/);
});

test('only a confirmed public final enters the handoff delivery callback', async () => {
  const delivered: Array<{ messageTs: string; text: string }> = [];
  const presenter = new WebClientPresenter(
    {
      chat: {
        async startStream() {
          return { ok: true, ts: '1782770400.000350' };
        },
        async stopStream() {
          return { ok: true };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND', threadTs: '1782770400.000100',
      userId: 'U_REQUESTER', workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent', agentId: 'agent_test',
    },
    undefined,
    { onPublicDelivery: (delivery) => { delivered.push(delivery); } },
  );

  await presenter.deliverFinal('Visible answer.', 'markdown');
  assert.deepEqual(delivered, [{
    messageTs: '1782770400.000350',
    text: 'Visible answer.',
  }]);
});

test('the public handoff callback receives the credential-safe Slack rendering', async () => {
  const delivered: Array<{ messageTs: string; text: string }> = [];
  const presenter = new WebClientPresenter(
    {
      chat: {
        async startStream() {
          return { ok: true, ts: '1782770400.000351' };
        },
        async stopStream() {
          return { ok: true };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND', threadTs: '1782770400.000100',
      userId: 'U_REQUESTER', workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent', agentId: 'agent_test',
    },
    undefined,
    { onPublicDelivery: (delivery) => { delivered.push(delivery); } },
  );
  const canary = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';

  await presenter.deliverFinal(`Credential: ${canary}`, 'markdown');

  assert.equal(delivered.length, 1);
  assert.doesNotMatch(delivered[0]!.text, new RegExp(canary));
  assert.match(delivered[0]!.text, /\[credential redacted\]/);
});

test('deliverRequesterOnly posts an ephemeral response to the requesting member', async () => {
  const calls: unknown[] = [];
  const presenter = new WebClientPresenter(
    {
      chat: {
        async postEphemeral(input: unknown) {
          calls.push(input);
          return { ok: true, message_ts: '1782770400.000400' };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_INVOKING',
      threadTs: '1782770400.000100',
      userId: 'U_REQUESTER',
      workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent',
      agentId: 'agent_test',
    },
  );

  await presenter.deliverRequesterOnly(
    'Routines for **https://example.com/private-project**',
    'markdown',
  );

  assert.equal(calls.length, 1);
  const call = calls[0] as {
    channel?: string;
    user?: string;
    thread_ts?: string;
    text?: string;
    username?: string;
    icon_url?: string;
  };
  assert.equal(call.channel, 'C_INVOKING');
  assert.equal(call.user, 'U_REQUESTER');
  assert.equal(call.thread_ts, undefined);
  assert.equal(call.username, 'Test agent');
  assert.equal(call.icon_url, undefined);
  assert.doesNotMatch(call.text ?? '', /\*\*https:\/\//);
});

test('stream rejection records confirmed non-delivery before the exact fallback render', async () => {
  const events: Array<Record<string, unknown>> = [];
  const presenter = new WebClientPresenter(
    {
      chat: {
        async startStream() {
          throw new Error('confirmed start rejection');
        },
        async postMessage() {
          return { ok: true, ts: '1782770400.000500' };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND',
      threadTs: '1782770400.000100',
      userId: 'U_REQUESTER',
      workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent',
      agentId: 'agent_test',
    },
    {
      async beforeDelivery(input) {
        events.push({ phase: 'before', ...input });
        return `attempt-${events.length}`;
      },
      async afterDelivery(input) {
        events.push({ phase: 'after', ...input });
      },
    },
  );

  await presenter.deliverFinal('approved answer', 'markdown');
  assert.deepEqual(events.map((event) => [event.phase, event.method, event.outcome]), [
    ['before', 'slack_chat_stream', undefined],
    ['after', undefined, 'failed'],
    ['before', 'slack_chat_post_message', undefined],
    ['after', undefined, 'delivered'],
  ]);
  assert.match(String(events[0]?.renderedPayload), /slack_chat_stream/);
  assert.match(String(events[2]?.renderedPayload), /slack_chat_post_message/);
});

test('stream finalization ambiguity records unknown and never falls back', async () => {
  const outcomes: string[] = [];
  let fallbackPosts = 0;
  const presenter = new WebClientPresenter(
    {
      chat: {
        async startStream() {
          return { ok: true, ts: '1782770400.000600' };
        },
        async stopStream() {
          throw new Error('finalization receipt unavailable');
        },
        async postMessage() {
          fallbackPosts += 1;
          return { ok: true };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND',
      threadTs: '1782770400.000100',
      userId: 'U_REQUESTER',
      workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent',
      agentId: 'agent_test',
    },
    {
      async beforeDelivery() {
        return 'attempt-stream';
      },
      async afterDelivery(input) {
        outcomes.push(input.outcome);
      },
    },
  );

  await presenter.deliverFinal('approved answer', 'markdown');
  assert.deepEqual(outcomes, ['unknown']);
  assert.equal(fallbackPosts, 0);
});

test('ledger delivery treats a transport-level stream start failure as unknown', async () => {
  const outcomes: string[] = [];
  let fallbackPosts = 0;
  const presenter = new WebClientPresenter(
    {
      chat: {
        async startStream() {
          throw new Error('socket closed after send');
        },
        async postMessage() {
          fallbackPosts += 1;
          return { ok: true };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND', threadTs: '1782770400.000100',
      userId: 'U_REQUESTER', workspaceId: 'T_WORKSPACE',
      agentName: 'Test agent', agentId: 'agent_test',
    },
    {
      async beforeDelivery() { return 'attempt-stream'; },
      async afterDelivery(input) { outcomes.push(input.outcome); },
    },
    { deliverySafety: 'ledger' },
  );

  await assert.rejects(() => presenter.deliverFinal('approved answer', 'markdown'));
  assert.deepEqual(outcomes, ['unknown']);
  assert.equal(fallbackPosts, 0);
});

test('ledger delivery never calls Slack before its durable start receipt', async () => {
  let externalCalls = 0;
  const presenter = new WebClientPresenter(
    {
      chat: {
        async postMessage() {
          externalCalls += 1;
          return { ok: true, ts: '1782770400.000700' };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND', threadTs: '1782770400.000100',
      agentName: 'Test agent', agentId: 'agent_test',
    },
    {
      async beforeDelivery() { throw new Error('ledger unavailable'); },
      async afterDelivery() {},
    },
    { deliverySafety: 'ledger' },
  );

  await assert.rejects(() => presenter.deliverFinal('approved answer', 'markdown'));
  assert.equal(externalCalls, 0);
});

test('semantic reactions fall back by name and preserve pre-existing reactions', async () => {
  const calls: string[] = [];
  const presenter = presenterWith({
    reactions: {
      async add(input: { name: string }) {
        calls.push(input.name);
        if (input.name === 'merged') {
          throw { code: ErrorCode.PlatformError, data: { error: 'invalid_name' } };
        }
        throw { code: ErrorCode.PlatformError, data: { error: 'already_reacted' } };
      },
    },
  });
  assert.deepEqual(
    await presenter.addSemanticReaction('merged', {
      channelId: 'C_BOUND', messageTs: '1782770400.000100',
    }),
    { name: 'ship', created: false },
  );
  assert.deepEqual(calls, ['merged', 'ship']);
});

test('gateway no_reaction is an idempotent cleanup success', async () => {
  let removals = 0;
  const presenter = presenterWith({
    reactions: {
      async remove() {
        removals += 1;
        throw new SlackTransportError('reactions.remove', 'no_reaction', {
          effectOutcome: 'failed',
        });
      },
    },
  });

  await presenter.removeReaction('eyes', {
    channelId: 'C_BOUND', messageTs: '1782770400.000100',
  });
  assert.equal(removals, 1);
});

test('reaction-only delivery persists the semantic chain and text-falls back on confirmed scope failure', async () => {
  const events: Array<Record<string, unknown>> = [];
  const posts: unknown[] = [];
  const presenter = new WebClientPresenter(
    {
      reactions: {
        async add() {
          throw { code: ErrorCode.PlatformError, data: { error: 'missing_scope' } };
        },
      },
      chat: {
        async postMessage(input: unknown) {
          posts.push(input);
          return { ok: true, ts: '1782770400.000900' };
        },
      },
    } as unknown as WebClient,
    {
      channelId: 'C_BOUND', threadTs: '1782770400.000100',
      agentName: 'Test agent', agentId: 'agent_test',
    },
    {
      async beforeDelivery(input) { events.push(input); return 'attempt-reaction'; },
      async afterDelivery(input) { events.push(input); },
    },
    { deliverySafety: 'ledger' },
  );
  const receipt = await presenter.deliverReaction('agreement', {
    channelId: 'C_BOUND', messageTs: '1782770400.000100',
  });
  assert.deepEqual(receipt, { name: 'text_fallback', created: false });
  assert.equal(posts.length, 1);
  assert.equal((posts[0] as { text: string }).text, 'Sounds good.');
  assert.match(String(events[0]?.renderedPayload), /slack_reaction_add/);
  assert.equal(events[1]?.outcome, 'delivered');
});

test('persisted reaction delivery replays without reclassification', async () => {
  const calls: unknown[] = [];
  const result = await deliverPersistedSlackPayload(
    {
      reactions: {
        async add(input: unknown) { calls.push(input); return { ok: true }; },
      },
    } as unknown as WebClient,
    JSON.stringify({
      method: 'slack_reaction_add', semantic: 'done', names: ['white_check_mark'],
      channel: 'C_BOUND', timestamp: '1782770400.000100',
      threadTs: '1782770400.000100', fallbackText: 'Done.',
    }),
  );
  assert.equal(result.method, 'slack_reaction_add');
  assert.equal(calls.length, 1);
});

test('persisted reaction text fallback stays in the original thread', async () => {
  const posts: Array<{ thread_ts?: string }> = [];
  const result = await deliverPersistedSlackPayload(
    {
      reactions: {
        async add() {
          throw { code: ErrorCode.PlatformError, data: { error: 'missing_scope' } };
        },
      },
      chat: {
        async postMessage(input: { thread_ts?: string }) {
          posts.push(input);
          return { ok: true, ts: '1782770400.000901' };
        },
      },
    } as unknown as WebClient,
    JSON.stringify({
      method: 'slack_reaction_add', semantic: 'seen', names: ['eyes'],
      channel: 'C_BOUND', timestamp: '1782770400.000700',
      threadTs: '1782770400.000100', fallbackText: 'Seen.',
    }),
  );
  assert.equal(result.method, 'slack_chat_post_message');
  assert.equal(posts[0]?.thread_ts, '1782770400.000100');
});

test('persisted progressive finalization resumes the exact known stream without a new post', async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const result = await deliverPersistedSlackPayload(
    {
      chat: {
        async stopStream(input: unknown) {
          calls.push({ method: 'stop', input });
          return { ok: true };
        },
        async postMessage(input: unknown) {
          calls.push({ method: 'post', input });
          return { ok: true, ts: 'should-not-post' };
        },
      },
    } as unknown as WebClient,
    JSON.stringify({
      method: 'slack_chat_stream_resume',
      channel: 'C_BOUND',
      ts: '1782770400.000950',
      stop: { chunks: [{ type: 'markdown_text', text: ' suffix' }] },
    }),
  );
  assert.deepEqual(calls.map((call) => call.method), ['stop']);
  assert.deepEqual(result, {
    method: 'slack_chat_stream_resume',
    deliveryRef: 'slack:C_BOUND:1782770400.000950',
  });
});

test('persisted correction stops then updates only the exact streamed artifact', async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  await deliverPersistedSlackPayload(
    {
      chat: {
        async stopStream(input: unknown) {
          calls.push({ method: 'stop', input });
          return { ok: true };
        },
        async update(input: unknown) {
          calls.push({ method: 'update', input });
          return { ok: true };
        },
      },
    } as unknown as WebClient,
    JSON.stringify({
      method: 'slack_chat_stream_correct',
      channel: 'C_BOUND',
      ts: '1782770400.000951',
      stop: {},
      update: {
        channel: 'C_BOUND', ts: '1782770400.000951',
        text: 'Corrected', blocks: [{ type: 'markdown', text: 'Corrected' }],
      },
    }),
  );
  assert.deepEqual(calls.map((call) => call.method), ['stop', 'update']);
  assert.equal((calls[1]?.input as { ts?: string }).ts, '1782770400.000951');
});

test('work checklist posts once and updates the same message coordinate', async () => {
  const calls: Array<{ method: string; input: unknown }> = [];
  const presenter = presenterWith({
    chat: {
      async postMessage(input: unknown) {
        calls.push({ method: 'post', input });
        return { ok: true, ts: '1782770400.001000' };
      },
      async update(input: unknown) {
        calls.push({ method: 'update', input });
        return { ok: true };
      },
    },
  });
  const ts = await presenter.postWorkChecklist(['PR link', 'Verification result']);
  assert.equal(ts, '1782770400.001000');
  await presenter.updateWorkChecklist(ts!, ['PR link', 'Verification result'], true);
  assert.deepEqual(calls.map((call) => call.method), ['post', 'update']);
  assert.equal((calls[0]?.input as { username?: string }).username, 'Test agent');
  assert.equal(
    (calls[0]?.input as { icon_url?: string }).icon_url,
    'https://chickpea.example/assets/agents/test/avatar/1',
  );
  assert.equal((calls[1]?.input as { ts: string }).ts, ts);
  assert.equal((calls[1]?.input as { username?: string }).username, undefined);
  assert.equal((calls[1]?.input as { icon_url?: string }).icon_url, undefined);
});

test('fallback milestone projection distinguishes every semantic outcome without a timestamp', async () => {
  const posts: Array<Record<string, unknown>> = [];
  const presenter = presenterWith({
    chat: {
      async postMessage(input: Record<string, unknown>) {
        posts.push(input);
        return { ok: true, ts: 'milestones-ts' };
      },
    },
  });
  const messageTs = await presenter.postMilestonePlan({
    displayMode: 'plan',
    tasks: [
      { id: 'task_completed', title: 'Inspect', status: 'complete', outcome: 'completed',
        detail: 'Completed: record inspected.' },
      { id: 'task_changed', title: 'Revise', status: 'complete', outcome: 'changed',
        detail: 'Changed: recommendation revised.' },
      { id: 'task_skipped', title: 'Optional', status: 'complete', outcome: 'skipped',
        detail: 'Skipped: unnecessary.' },
      { id: 'task_failed', title: 'Publish', status: 'error', outcome: 'failed',
        detail: 'Failed: permission denied.' },
    ],
  });

  assert.equal(messageTs, 'milestones-ts');
  await presenter.postMilestonePlan({
    displayMode: 'plan',
    tasks: [
      { id: 'task_failed_again', title: 'Publish', status: 'error', outcome: 'failed',
        detail: 'Failed: permission denied.' },
      { id: 'task_not_run', title: 'Notify', status: 'error', outcome: 'not_run',
        detail: 'Not run: publishing failed.' },
    ],
  });
  const rendered = posts.map((post) => String(post.text)).join('\n');
  assert.match(rendered, /Completed: record inspected\./);
  assert.match(rendered, /Changed: recommendation revised\./);
  assert.match(rendered, /Skipped: unnecessary\./);
  assert.match(rendered, /Failed: permission denied\./);
  assert.match(rendered, /Not run: publishing failed\./);
  assert.doesNotMatch(rendered, /UTC/);
});
