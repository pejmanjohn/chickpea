import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import {
  AGENT_VIEW_STREAM_RETIRE_AFTER_MS,
  recoveryReplySplit,
  SlackAgentViewPresentation,
  type SlackPresentationDeliveryObserver,
  type SlackPresentationStatePort,
} from '../src/slack/agent-view-presentation.ts';
import {
  canonicalSlackMarkdownText,
  SLACK_REPLY_SHORTENED_NOTE,
  slackMarkdownBlockTextLimit,
  slackMarkdownPartBlockLimit,
  slackMarkdownPartFits,
  slackMarkdownRenderedShape,
  splitSlackMarkdownReply,
} from '../src/slack/message-format.ts';
import {
  drainSlackPresentationRepairs,
  hasRetryableTerminalRepair,
} from '../src/slack/presentation-repair.ts';
import {
  SlackRunPresentationStoreLogic,
  type SlackPresentationMutation,
  type SlackRunPresentationV3,
} from '../src/slack/run-presentations.ts';
import { slackClientMessageId } from '../src/slack/transport/message-id.ts';
import { SlackTransportError } from '../src/slack/transport/types.ts';
import { deliverPersistedSlackPayload, WebClientPresenter } from '../src/slack/web-client-presenter.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const LIMIT = slackMarkdownBlockTextLimit;

/** Fourteen headed sections, about 14 KB: the plan that used to be cut at section 7. */
function longPlan(sections = 14, sentences = 23): string {
  return Array.from({ length: sections }, (_, index) =>
    `## Section ${index + 1}\n\n${'Keep the rollout reversible and measured. '.repeat(sentences).trim()}`
  ).join('\n\n');
}

test('a reply that fits one message is returned unchanged', () => {
  const text = 'Short answer.\n\n## Detail\n\nMore.';
  assert.deepEqual(splitSlackMarkdownReply(text), [text]);
  const exact = 'x'.repeat(LIMIT);
  assert.deepEqual(splitSlackMarkdownReply(exact), [exact]);
});

test('long replies split before a heading and lose no text', () => {
  const text = longPlan();
  const parts = splitSlackMarkdownReply(text);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((part) => part.length <= LIMIT));
  assert.match(parts[1]!, /^## Section \d+\n/);
  assert.equal(parts.join('\n\n'), text);
  assert.ok(parts.every((part) => !part.includes('[truncated]')));
});

test('without headings the cut falls on a paragraph boundary', () => {
  const paragraph = 'A measured sentence about the plan. '.repeat(40).trim();
  const text = Array.from({ length: 12 }, () => paragraph).join('\n\n');
  const parts = splitSlackMarkdownReply(text);
  assert.equal(parts.length, 2);
  assert.ok(parts[0]!.endsWith('plan.'));
  assert.ok(parts[1]!.startsWith('A measured'));
  assert.equal(parts.join('\n\n'), text);
});

test('one character over the budget produces two parts within it', () => {
  const text = `${'word '.repeat(LIMIT / 5).trim()} extra`;
  assert.ok(text.length > LIMIT);
  const parts = splitSlackMarkdownReply(text);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((part) => part.length <= LIMIT && part.length > 0));
  assert.equal(parts.join(' '), text);
});

test('a long code block closes and reopens its fence with the same info string', () => {
  const code = Array.from({ length: 900 }, (_, index) => `const value${index} = ${index};`);
  const text = `Here is the file:\n\n\`\`\`ts\n${code.join('\n')}\n\`\`\`\n\nThat is all.`;
  const parts = splitSlackMarkdownReply(text);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((part) => part.length <= LIMIT));
  assert.match(parts[0]!, /\n```$/);
  assert.match(parts[1]!, /^```ts\n/);
  for (const part of parts) {
    assert.equal((part.match(/^```/gm) ?? []).length % 2, 0, 'every part balances its fences');
  }
  const lines = parts.flatMap((part) => part.split('\n'))
    .filter((line) => line.startsWith('const value'));
  assert.deepEqual(lines, code);
});

test('a single long line never splits a link, inline code, or a bare URL', () => {
  const unit = 'See [the release notes](https://example.com/releases/2026/09/notes) and `npm run verify` or https://example.com/a/b ';
  const text = unit.repeat(Math.ceil((LIMIT * 1.5) / unit.length)).trim();
  const parts = splitSlackMarkdownReply(text);
  assert.equal(parts.length, 2);
  for (const part of parts) {
    assert.ok(part.length <= LIMIT);
    const opens = (part.match(/\[/g) ?? []).length;
    const links = (part.match(/\[[^\]]*\]\([^)]*\)/g) ?? []).length;
    assert.equal(links, opens, 'every link label keeps its URL');
    assert.equal((part.match(/`/g) ?? []).length % 2, 0, 'inline code stays whole');
  }
  assert.equal(parts.join(' '), text);
});

test('beyond three continuations the last message ends with the shortened note', () => {
  const text = longPlan(60, 35);
  assert.ok(text.length > 4 * LIMIT);
  const parts = splitSlackMarkdownReply(text);
  assert.equal(parts.length, 4);
  assert.ok(parts.every((part) => part.length <= LIMIT));
  assert.ok(parts[3]!.endsWith(`\n\n${SLACK_REPLY_SHORTENED_NOTE}`));
  assert.ok(parts.slice(0, 3).every((part) => !part.includes(SLACK_REPLY_SHORTENED_NOTE)));
  assert.ok(parts.every((part) => !part.includes('[truncated]')));
  const oneMessage = splitSlackMarkdownReply(text, { maxParts: 1 });
  assert.equal(oneMessage.length, 1);
  assert.ok(oneMessage[0]!.length <= LIMIT);
  assert.ok(oneMessage[0]!.endsWith(SLACK_REPLY_SHORTENED_NOTE));
});

test('a streamed prefix stays inside the first message and a reserved marker fits', () => {
  const text = longPlan();
  const streamed = text.slice(0, 11_800).trimEnd();
  const parts = splitSlackMarkdownReply(text, { minFirstPartLength: streamed.length });
  assert.ok(parts[0]!.startsWith(streamed));
  assert.ok(parts[0]!.length <= LIMIT);
  assert.equal(parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));

  const reserved = splitSlackMarkdownReply(text, { firstPartLimit: LIMIT - 20 });
  assert.ok(reserved[0]!.length <= LIMIT - 20);
});

interface Harness {
  store: SlackRunPresentationStoreLogic;
  state: SlackPresentationStatePort;
  client: WebClient;
  calls: Array<{ method: string; input: Record<string, unknown> }>;
  presentation: SlackAgentViewPresentation;
  runId: string;
  clock: { now: number };
  replies: { messages: Array<Record<string, unknown>>; complete: boolean };
  postErrors: unknown[];
  stopStreamErrors: unknown[];
  updateErrors: unknown[];
  close(): void;
}

const ROOT = {
  workspaceId: 'T_CONTINUE',
  channelId: 'C_CONTINUE',
  threadTs: '1785800100.000100',
  requesterUserId: 'U_CONTINUE',
};

const CLOSING = { footer: { agentName: 'Planning Agent', agentId: 'agent_planning' } };

const PERSONA = {
  name: 'Planning Agent',
  avatarUrl: 'https://chickpea.example/assets/agents/planning/avatar/1',
  avatarRevision: 1,
};

function harness(): Harness {
  // A minute after the fake stream starts: younger than the Agent View
  // stream retirement age, so only tests that expire it see a retired stream.
  const clock = { now: 1_785_800_160_000 };
  const db = openStateDb(':memory:');
  const store = new SlackRunPresentationStoreLogic(db, () => clock.now);
  const runId = 'run_continuations';
  store.create({
    schemaVersion: 3,
    runId,
    turnJobId: `turn_${runId}`,
    bindingId: 'binding_continuations',
    workBindingGeneration: 1,
    runFencingToken: 0,
    root: ROOT,
    owner: { kind: 'selected_agent', persona: PERSONA },
    sessionGeneration: 1,
  });
  const calls: Harness['calls'] = [];
  const replies: Harness['replies'] = { messages: [], complete: true };
  const postErrors: unknown[] = [];
  const stopStreamErrors: unknown[] = [];
  const updateErrors: unknown[] = [];
  let posted = 0;
  const client = {
    async apiCall(method: string, input: Record<string, unknown>) {
      calls.push({ method, input });
      return { ok: true };
    },
    assistant: { threads: { async setStatus() { return { ok: true }; } } },
    chat: {
      async startStream(input: Record<string, unknown>) {
        calls.push({ method: 'chat.startStream', input });
        return { ok: true, ts: '1785800100.000200' };
      },
      async appendStream(input: Record<string, unknown>) {
        calls.push({ method: 'chat.appendStream', input });
        return { ok: true };
      },
      async stopStream(input: Record<string, unknown>) {
        calls.push({ method: 'chat.stopStream', input });
        const error = stopStreamErrors.shift();
        if (error) throw error;
        return { ok: true };
      },
      async postMessage(input: Record<string, unknown>) {
        calls.push({ method: 'chat.postMessage', input });
        const error = postErrors.shift();
        if (error) throw error;
        posted += 1;
        return { ok: true, ts: `1785800100.00030${posted}` };
      },
      async update(input: Record<string, unknown>) {
        calls.push({ method: 'chat.update', input });
        const error = updateErrors.shift();
        if (error) throw error;
        return { ok: true };
      },
      async delete(input: Record<string, unknown>) {
        calls.push({ method: 'chat.delete', input });
        return { ok: true };
      },
    },
    conversations: {
      async replies(input: Record<string, unknown>) {
        calls.push({ method: 'conversations.replies', input });
        return { ok: true, messages: structuredClone(replies.messages), has_more: !replies.complete };
      },
    },
  } as unknown as WebClient;
  const state: SlackPresentationStatePort = {
    getRunPresentation: (id) => store.get(id),
    getLatestThreadSessionGeneration: (root) => store.getLatestThreadSessionGeneration(root),
    transitionRunPresentation: (input) => store.transition(input),
    reserveSlackAppend: (workspaceId) => store.reserveAppend(workspaceId),
    applySlackAppendCooldown: (workspaceId, retryAfterMs) =>
      store.applyAppendCooldown(workspaceId, retryAfterMs),
    matchFlueObservation: (instanceId, submissionId) => ({
      turnJobId: `turn_${runId}`,
      instanceId,
      ...(submissionId ? { submissionId } : {}),
      generation: `turn_${runId}`,
    }),
  };
  const presentation = new SlackAgentViewPresentation({
    client,
    state,
    runId,
    runFencingToken: 0,
    footer: { agentName: PERSONA.name, modelLabel: 'model-a', agentId: 'agent_planning' },
    minAppendIntervalMs: 0,
    now: () => clock.now,
    wait: async (milliseconds) => { clock.now += milliseconds; },
    onFinalized: () => undefined,
  });
  return {
    store, state, client, calls, presentation, runId, clock, replies, postErrors,
    stopStreamErrors, updateErrors,
    close: () => db.close(),
  };
}

function observer(): SlackPresentationDeliveryObserver {
  return { async before() { return 'attempt'; }, async after() {} };
}

function v3(h: Harness): SlackRunPresentationV3 {
  const presentation = h.store.get(h.runId);
  assert.equal(presentation?.schemaVersion, 3);
  return presentation as SlackRunPresentationV3;
}

function mutate(h: Harness, mutation: SlackPresentationMutation): SlackRunPresentationV3 {
  const current = v3(h);
  const result = h.store.transition({
    runId: current.runId,
    workBindingGeneration: current.workBindingGeneration,
    runFencingToken: current.runFencingToken,
    expectedProjectionVersion: current.projectionVersion,
    expectedStreamState: current.stream.state,
    mutation,
  });
  assert.equal(result.outcome, 'applied');
  return v3(h);
}

function posts(h: Harness) {
  return h.calls.filter((call) => call.method === 'chat.postMessage');
}

function blockTypes(input: Record<string, unknown>): string[] {
  return (input.blocks as Array<{ type: string }>).map((block) => block.type);
}

async function finalizeLongAnswer(h: Harness, text: string): Promise<void> {
  const result = await h.presentation.finalize(text, 'markdown', 'complete', observer());
  assert.equal(result.handled, true);
}

/** Stream a long answer progressively; the stream holds at most one message. */
async function streamLongAnswer(h: Harness, text: string): Promise<void> {
  await h.presentation.freezeProgressiveEligibility({ allowed: true, reason: 'safe_early_release' });
  const relay = await h.presentation.prepareReceipt({
    instanceId: 'instance_stream',
    receipt: { submissionId: 'submission_stream', acceptedAt: 'now', uid: 'uid' },
    eligibility: { allowed: true, reason: 'safe_early_release' },
  });
  assert.ok(relay);
  relay.onEvent({
    type: 'message-started', conversationId: 'conversation',
    submissionId: 'submission_stream', messageId: 'message_stream',
    position: { batch: 1, index: 0 },
  });
  relay.onEvent({
    type: 'tool-input', conversationId: 'conversation', messageId: 'message_stream',
    toolCallId: 'stream_call_1', toolName: 'stream_answer', input: {},
    position: { batch: 2, index: 0 },
  });
  relay.onEvent({
    type: 'tool-output', conversationId: 'conversation', toolCallId: 'stream_call_1',
    output: 'Delivery preference noted. Continue with the answer.',
    position: { batch: 3, index: 0 },
  });
  const pieces = text.match(/[\s\S]{1,1500}/g)!;
  pieces.forEach((delta, index) => relay.onEvent({
    type: 'message-delta', conversationId: 'conversation', messageId: 'message_stream',
    kind: 'text', delta, position: { batch: 4 + index, index: 0 },
  }));
  relay.onEvent({
    type: 'message-completed', conversationId: 'conversation', messageId: 'message_stream',
    position: { batch: 4 + pieces.length, index: 0 },
  });
  await relay.closeAndDrain();
}

test('a terminal-only final holds part 1 without a footer; the follow-up closes the reply', async () => {
  const h = harness();
  try {
    const text = longPlan();
    const parts = splitSlackMarkdownReply(text);
    await finalizeLongAnswer(h, text);

    const start = h.calls.find((call) => call.method === 'chat.startStream')!;
    const chunks = start.input.chunks as Array<{ type: string; text?: string }>;
    assert.equal(chunks.find((chunk) => chunk.type === 'markdown_text')?.text, parts[0]);
    const stop = h.calls.find((call) => call.method === 'chat.stopStream')!;
    assert.equal(Object.hasOwn(stop.input, 'blocks'), false, 'no footer on the first message');

    let presentation = v3(h);
    assert.equal(presentation.continuations?.state, 'active');
    assert.equal(presentation.continuations?.parts.length, 1);
    // Each part is stored once, as canonical text; rendering happens at post time.
    assert.deepEqual(Object.keys(presentation.continuations!.parts[0]!), ['text']);
    assert.ok(JSON.stringify(presentation.continuations).length < parts[1]!.length + 1_000);
    assert.equal(presentation.repairRequired, true);

    const delivered: Array<[string, string]> = [];
    await h.presentation.deliverContinuations({
      onDelivered: async (ts, partText) => { delivered.push([ts, partText]); },
    });
    const [post] = posts(h);
    assert.ok(post);
    assert.equal(post.input.thread_ts, ROOT.threadTs);
    assert.equal(post.input.username, PERSONA.name);
    assert.equal(post.input.icon_url, PERSONA.avatarUrl);
    assert.equal(typeof post.input.client_msg_id, 'string');
    assert.deepEqual(blockTypes(post.input), ['markdown', 'context']);
    const blocks = post.input.blocks as Array<{ type: string; text?: string; elements?: Array<{ text: string }> }>;
    assert.equal(blocks[0]!.text, parts[1]);
    assert.match(blocks[1]!.elements![0]!.text, /Planning Agent \| model-a/);
    assert.deepEqual(delivered, [['1785800100.000301', parts[1]]]);

    presentation = v3(h);
    assert.equal(presentation.continuations?.state, 'delivered');
    assert.equal(presentation.continuations?.parts[0]?.messageTs, '1785800100.000301');
    await h.presentation.settleLifecycle();
    assert.equal(v3(h).repairRequired, false);

    await h.presentation.deliverContinuations();
    assert.equal(posts(h).length, 1, 'a delivered set never posts again');
  } finally {
    h.close();
  }
});

test('a stream whose cap falls inside a code line stops at the line boundary before it', async () => {
  const h = harness();
  try {
    const prose = Array.from({ length: 18 }, (_, index) =>
      `Paragraph ${index + 1}: ${'the retry policy stays conservative. '.repeat(13).trim()}`
    ).join('\n\n');
    const code = Array.from({ length: 60 }, (_, index) =>
      `    raise_if_retryable(response_${index}, reason="${'failures that must not be retried '.repeat(3).trim()}")`
    );
    const text = `${prose}\n\n\`\`\`python\n${code.join('\n')}\n\`\`\`\n\nThat is the whole module.`;
    const codeStart = text.indexOf('```python');
    assert.ok(codeStart < LIMIT - 2_500 && text.length > LIMIT + 2_000);

    await streamLongAnswer(h, text);
    const streamed = h.calls
      .filter((call) => call.method === 'chat.startStream' || call.method === 'chat.appendStream')
      .flatMap((call) => (call.input.chunks as Array<{ type: string; text?: string }>)
        .filter((chunk) => chunk.type === 'markdown_text')
        .map((chunk) => chunk.text ?? ''))
      .join('');
    assert.ok(streamed.length > codeStart && streamed.length <= LIMIT);
    assert.ok(text.startsWith(streamed));
    assert.equal(text[streamed.length], '\n', 'the stream stops at the end of a whole line');

    await finalizeLongAnswer(h, text);
    await h.presentation.deliverContinuations();
    const [post] = posts(h);
    const second = (post!.input.blocks as Array<{ text?: string }>)[0]!.text!;
    const lines = new Set(code);
    const secondLines = second.split('\n');
    assert.equal(secondLines[0], '```python');
    assert.ok(lines.has(secondLines[1]!), 'part 2 begins with a complete code line');
    const stop = h.calls.find((call) => call.method === 'chat.stopStream')!;
    const suffix = ((stop.input.chunks ?? []) as Array<{ type: string; text?: string }>)
      .filter((chunk) => chunk.type === 'markdown_text').map((chunk) => chunk.text ?? '').join('');
    const first = streamed + suffix;
    for (const line of [...first.split('\n'), ...secondLines]) {
      if (line.startsWith('    raise_if_retryable')) assert.ok(lines.has(line), 'no code line is split');
    }
  } finally {
    h.close();
  }
});

test('a progressive stream holds part 1 and the continuation follows after stop', async () => {
  const h = harness();
  try {
    const text = longPlan();
    const parts = splitSlackMarkdownReply(text);
    await streamLongAnswer(h, text);

    const streamed = h.calls
      .filter((call) => call.method === 'chat.startStream' || call.method === 'chat.appendStream')
      .flatMap((call) => (call.input.chunks as Array<{ type: string; text?: string }>)
        .filter((chunk) => chunk.type === 'markdown_text')
        .map((chunk) => chunk.text ?? ''))
      .join('');
    assert.ok(streamed.length > 0);
    assert.ok(streamed.length <= LIMIT);

    await finalizeLongAnswer(h, text);
    const stop = h.calls.find((call) => call.method === 'chat.stopStream')!;
    const suffix = (stop.input.chunks as Array<{ type: string; text?: string }> | undefined ?? [])
      .filter((chunk) => chunk.type === 'markdown_text')
      .map((chunk) => chunk.text ?? '')
      .join('');
    const first = streamed + suffix;
    assert.equal(Object.hasOwn(stop.input, 'blocks'), false);
    assert.ok(first.length <= LIMIT);
    assert.equal(first, splitSlackMarkdownReply(text, { minFirstPartLength: streamed.length })[0]);
    assert.notEqual(v3(h).stream.presentationOutcome, 'corrected');

    await h.presentation.deliverContinuations();
    const [post] = posts(h);
    const continuation = (post!.input.blocks as Array<{ text?: string }>)[0]!.text!;
    assert.equal(`${first}\n\n${continuation}`.replace(/\s/g, ''), text.replace(/\s/g, ''));
    assert.ok(parts.length >= 2);
    assert.deepEqual(blockTypes(post!.input), ['markdown', 'context']);
  } finally {
    h.close();
  }
});

function planningPresenter(
  h: Harness,
  recorded: Array<{ messageTs: string; text: string }>,
): WebClientPresenter {
  return new WebClientPresenter(h.client, {
    channelId: ROOT.channelId,
    threadTs: ROOT.threadTs,
    agentName: PERSONA.name,
    visibleOwner: { kind: 'selected_agent', persona: PERSONA },
    agentId: 'agent_planning',
    userId: ROOT.requesterUserId,
    workspaceId: ROOT.workspaceId,
  }, undefined, {
    agentViewPresentation: h.presentation,
    onPublicDelivery: (delivery) => { recorded.push(delivery); },
  });
}

function streamedText(h: Harness): string {
  return h.calls
    .filter((call) => call.method === 'chat.startStream' || call.method === 'chat.appendStream')
    .flatMap((call) => (call.input.chunks as Array<{ type: string; text?: string }>)
      .filter((chunk) => chunk.type === 'markdown_text')
      .map((chunk) => chunk.text ?? ''))
    .join('');
}

const RECOVERY_UPDATE_CHARS = 4_000;

/** One fresh final (part 1, no footer), then its follow-ups; the last closes the reply. */
function assertFreshReply(
  h: Harness,
  planned: readonly string[],
  recorded: ReadonlyArray<{ messageTs: string; text: string }>,
): void {
  const all = posts(h);
  assert.equal(all.length, planned.length, 'exactly one final and its follow-ups');
  all.forEach((post, index) => {
    assert.equal((post.input.blocks as Array<{ text?: string }>)[0]!.text, planned[index]);
    assert.equal(post.input.username, PERSONA.name);
    assert.equal(typeof post.input.client_msg_id, 'string');
    assert.deepEqual(
      blockTypes(post.input),
      index === planned.length - 1 ? ['markdown', 'context'] : ['markdown'],
    );
  });
  assert.deepEqual(recorded.map((delivery) => delivery.text), planned);
}

test('a long streamed answer whose stream expired posts part 1 fresh and its continuation follows', async () => {
  const h = harness();
  try {
    const recorded: Array<{ messageTs: string; text: string }> = [];
    const presenter = planningPresenter(h, recorded);
    const text = longPlan();
    await streamLongAnswer(h, text);
    // Recovery replaces the message through chat.update, so its first
    // message stays within the update bound and the rest continues.
    const planned = splitSlackMarkdownReply(
      text,
      recoveryReplySplit({ minFirstPartLength: streamedText(h).length }, text),
    );
    assert.ok(planned.length >= 2 && planned[0]!.length <= RECOVERY_UPDATE_CHARS);

    // The stream expired before its stop: the stop is refused, the recovery
    // update finds no message, and the final posts fresh.
    const expired = { code: ErrorCode.PlatformError, data: { ok: false, error: 'message_not_in_streaming_state' } };
    const missing = { code: ErrorCode.PlatformError, data: { ok: false, error: 'message_not_found' } };
    h.stopStreamErrors.push(expired, expired);
    h.updateErrors.push(missing);
    await presenter.deliverFinal(text, 'markdown');

    const update = h.calls.find((call) => call.method === 'chat.update')!;
    const updated = update.input.blocks as Array<{ type: string; text?: string }>;
    assert.deepEqual(updated.map((block) => block.type), ['markdown'], 'recovery sends part 1 only');
    assert.equal(updated[0]!.text, planned[0]);

    assertFreshReply(h, planned, recorded);
    const presentation = v3(h);
    assert.equal(presentation.stream.state, 'artifact_delivered');
    assert.equal(presentation.continuations?.state, 'delivered');
  } finally {
    h.close();
  }
});

test('a recovery split keeps a short streamed prefix whole in the first message', () => {
  const text = longPlan(18, 23);
  const prefix = text.slice(0, 3_000).trimEnd();
  const parts = splitSlackMarkdownReply(text, recoveryReplySplit({ minFirstPartLength: prefix.length }, text));
  assert.ok(parts[0]!.startsWith(prefix));
  assert.ok(parts[0]!.length <= RECOVERY_UPDATE_CHARS);
  assert.equal(parts.join('\n\n'), text);
});

test('a recovery split keeps a plain prefix up to the full bound whole', () => {
  const text = longPlan(18, 23);
  const prefix = text.slice(0, 3_995).trimEnd();
  assert.ok(prefix.length > 3_985 && !prefix.includes('```'));
  const parts = splitSlackMarkdownReply(text, recoveryReplySplit({ minFirstPartLength: prefix.length }, text));
  assert.ok(parts[0]!.startsWith(prefix), 'the visible prefix is not rewritten');
  assert.ok(parts[0]!.length <= RECOVERY_UPDATE_CHARS);
});

test('a four-part continuation plan needs a recovery split that allows it', () => {
  const h = harness();
  try {
    mutate(h, { kind: 'record_terminal_delivery_intent', operationId: 'terminal_answer', result: 'answer' });
    const four = ['Part two.', 'Part three.', 'Part four.', 'Part five.'];
    assert.throws(() => mutate(h, {
      kind: 'record_continuation_plan', parts: four, closing: CLOSING,
    }), /up to four on a recovery split/);
    assert.throws(() => mutate(h, {
      kind: 'record_continuation_plan', parts: four, closing: CLOSING,
      split: { firstPartLimit: 4_000 },
    }), /up to four on a recovery split/);
    const planned = mutate(h, {
      kind: 'record_continuation_plan', parts: four, closing: CLOSING,
      split: { firstPartLimit: 4_000, maxParts: 5 },
    });
    assert.equal(planned.continuations?.parts.length, 4);
  } finally {
    h.close();
  }
});

test('a recovery split over a longer streamed prefix cuts at a boundary, never mid-word or in a link', () => {
  const bullets = Array.from({ length: 160 }, (_, index) =>
    `- bullet item ${index} with several words and [a link](https://example.com/items/${index})`
  ).join('\n');
  const text = `${bullets}\n\nClosing paragraph.`;
  const parts = splitSlackMarkdownReply(text, recoveryReplySplit({ minFirstPartLength: 7_000 }, text));
  const first = parts[0]!;
  assert.ok(first.length <= RECOVERY_UPDATE_CHARS);
  assert.equal(text[first.length], '\n', 'the first message ends at a line boundary');
  assert.match(parts[1]!, /^- bullet item \d+ with several words/);
  for (const part of parts) {
    assert.equal((part.match(/\[/g) ?? []).length, (part.match(/\[[^\]]*\]\([^)]*\)/g) ?? []).length);
  }
  assert.equal(parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), 'no text is lost');
});

test('a recovery split over a long fenced prefix stays within the update bound', () => {
  const code = Array.from({ length: 400 }, (_, index) => `const value${index} = compute(${index});`);
  const text = `Here is the module:\n\n\`\`\`ts\n${code.join('\n')}\n\`\`\`\n\nDone.`;
  const parts = splitSlackMarkdownReply(text, recoveryReplySplit({ minFirstPartLength: 7_000 }, text));
  assert.ok(parts[0]!.length <= RECOVERY_UPDATE_CHARS);
  assert.match(parts[0]!, /\n```$/);
  assert.match(parts[1]!, /^```ts\n/);
  for (const part of parts) assert.equal((part.match(/^```/gm) ?? []).length % 2, 0);
  const lines = parts.flatMap((part) => part.split('\n')).filter((line) => line.startsWith('const value'));
  assert.deepEqual(lines, code);
});

test('recovery carries as much as a normal reply: a 47,000-character answer is not shortened', () => {
  const text = longPlan(40, 27);
  assert.ok(text.length > 44_000 && text.length < 48_000);
  const normal = splitSlackMarkdownReply(text);
  assert.ok(!normal.at(-1)!.includes(SLACK_REPLY_SHORTENED_NOTE));
  const recovered = splitSlackMarkdownReply(text, recoveryReplySplit({ minFirstPartLength: 11_000 }, text));
  assert.ok(recovered.length <= 5);
  assert.ok(!recovered.at(-1)!.includes(SLACK_REPLY_SHORTENED_NOTE));
  assert.equal(recovered.join('\n\n'), text);
});

/** Stream past the first message, then lose the stop's outcome, as a crash would. */
async function interruptLongStream(h: Harness, presenter: WebClientPresenter, text: string) {
  await streamLongAnswer(h, text);
  h.stopStreamErrors.push(new Error('socket hang up'));
  await assert.rejects(presenter.deliverFinal(text, 'markdown'));
  assert.equal(v3(h).stream.state, 'unknown');
  return recoveryReplySplit({ minFirstPartLength: streamedText(h).length }, text);
}

test('a reattached long streamed answer recovers with one update that fits, then its follow-ups', async () => {
  const h = harness();
  try {
    const recorded: Array<{ messageTs: string; text: string }> = [];
    const presenter = planningPresenter(h, recorded);
    const text = longPlan(18, 23);
    assert.ok(text.length > LIMIT + 5_000);
    const split = await interruptLongStream(h, presenter, text);
    // The interrupted attempt froze a first message sized for the stream.
    assert.equal(v3(h).continuations?.split?.minFirstPartLength, streamedText(h).length);

    await presenter.deliverFinal(text, 'markdown');
    const planned = splitSlackMarkdownReply(text, split);
    const updates = h.calls.filter((call) => call.method === 'chat.update');
    assert.equal(updates.length, 1, 'one recovery update');
    const update = updates[0]!.input;
    const blocks = update.blocks as Array<{ type: string; text?: string }>;
    assert.deepEqual(blocks.map((block) => block.type), ['markdown'], 'no footer before the reply ends');
    assert.equal(blocks[0]!.text, planned[0]);
    assert.ok(blocks[0]!.text!.length <= RECOVERY_UPDATE_CHARS);
    assert.ok(String(update.text).length <= RECOVERY_UPDATE_CHARS);

    // The final is the recovered stream message; only follow-ups post.
    const all = posts(h);
    assert.equal(all.length, planned.length - 1);
    all.forEach((post, index) => {
      assert.equal((post.input.blocks as Array<{ text?: string }>)[0]!.text, planned[index + 1]);
      assert.equal(post.input.username, PERSONA.name);
    });
    assert.deepEqual(blockTypes(all.at(-1)!.input), ['markdown', 'context']);
    assert.deepEqual(recorded.map((delivery) => delivery.text), planned);
    const presentation = v3(h);
    assert.deepEqual(presentation.continuations?.split, split);
    assert.equal(presentation.continuations?.state, 'delivered');
    assert.equal(presentation.terminalDelivery.state, 'intended');
    if (presentation.terminalDelivery.state === 'intended') {
      assert.equal(presentation.terminalDelivery.operation.certainty, 'acknowledged');
    }
  } finally {
    h.close();
  }
});

test('msg_too_long on the recovery update is definite: the final posts fresh exactly once', async () => {
  const h = harness();
  try {
    const recorded: Array<{ messageTs: string; text: string }> = [];
    const presenter = planningPresenter(h, recorded);
    const text = longPlan(18, 23);
    const split = await interruptLongStream(h, presenter, text);
    // Through the gateway a Slack error arrives with an unknown effect.
    h.updateErrors.push(new SlackTransportError('chat.update', 'msg_too_long'));
    await presenter.deliverFinal(text, 'markdown');

    const planned = splitSlackMarkdownReply(text, split);
    assert.equal(h.calls.filter((call) => call.method === 'chat.update').length, 1, 'never retried');
    const deleted = h.calls.find((call) => call.method === 'chat.delete');
    assert.equal(deleted?.input.ts, '1785800100.000200', 'the partial stream is removed');
    assertFreshReply(h, planned, recorded);
    const presentation = v3(h);
    assert.equal(presentation.stream.state, 'artifact_delivered');
    assert.equal(presentation.continuations?.state, 'delivered');

    // A replay of the same final finds it delivered and posts nothing.
    const before = posts(h).length;
    await presenter.deliverFinal(text, 'markdown');
    assert.equal(posts(h).length, before);
  } finally {
    h.close();
  }
});

const CORRECTED = '_Corrected_';

/**
 * A reattached attempt whose final no longer starts with the streamed prefix.
 * Its correction replaces the message through chat.update, so the first
 * message keeps the recovery bound with room for the marker.
 */
async function streamDivergentAnswer(h: Harness): Promise<{ text: string; planned: string[] }> {
  const streamed = longPlan(18, 23);
  await streamLongAnswer(h, streamed);
  assert.ok(streamedText(h).length > RECOVERY_UPDATE_CHARS);
  const text = `## Revised plan\n\n${streamed}`;
  const planned = splitSlackMarkdownReply(
    text,
    recoveryReplySplit({ firstPartLimit: LIMIT - CORRECTED.length - 2 }, text, CORRECTED.length + 2),
  );
  assert.ok(planned.length >= 3);
  return { text, planned };
}

test('a divergent long final corrects the stream within the update bound, then its follow-ups', async () => {
  const h = harness();
  try {
    const recorded: Array<{ messageTs: string; text: string }> = [];
    const presenter = planningPresenter(h, recorded);
    const { text, planned } = await streamDivergentAnswer(h);
    await presenter.deliverFinal(text, 'markdown');

    const stops = h.calls.filter((call) => call.method === 'chat.stopStream');
    assert.equal(stops.length, 1);
    assert.equal(Object.hasOwn(stops[0]!.input, 'chunks'), false, 'the stop appends nothing');
    const updates = h.calls.filter((call) => call.method === 'chat.update');
    assert.equal(updates.length, 1, 'one correction update');
    const update = updates[0]!.input;
    const blocks = update.blocks as Array<{ type: string; text?: string }>;
    assert.deepEqual(blocks.map((block) => block.type), ['markdown'], 'no footer before the reply ends');
    assert.equal(blocks[0]!.text, `${planned[0]}\n\n${CORRECTED}`);
    assert.ok(blocks[0]!.text!.length <= RECOVERY_UPDATE_CHARS);
    assert.ok(String(update.text).length <= RECOVERY_UPDATE_CHARS);

    // The corrected stream message is the one final; only follow-ups post.
    const all = posts(h);
    assert.equal(all.length, planned.length - 1);
    all.forEach((post, index) => {
      assert.equal((post.input.blocks as Array<{ text?: string }>)[0]!.text, planned[index + 1]);
    });
    assert.deepEqual(blockTypes(all.at(-1)!.input), ['markdown', 'context']);
    const presentation = v3(h);
    assert.equal(presentation.stream.presentationOutcome, 'corrected');
    assert.equal(presentation.stream.state, 'artifact_delivered');
    assert.equal(presentation.continuations?.state, 'delivered');
    assert.equal(presentation.continuations?.split?.firstPartLimit, RECOVERY_UPDATE_CHARS - CORRECTED.length - 2);
  } finally {
    h.close();
  }
});

for (const code of ['msg_too_long', 'msg_blocks_too_long', 'invalid_blocks_format']) {
test(`${code} on a correction update is definite: the final posts fresh once, no attempt lost`, async () => {
  const h = harness();
  try {
    const recorded: Array<{ messageTs: string; text: string }> = [];
    const presenter = planningPresenter(h, recorded);
    const { text, planned } = await streamDivergentAnswer(h);
    // Through the gateway a Slack error arrives with an unknown effect.
    h.updateErrors.push(new SlackTransportError('chat.update', code));
    await presenter.deliverFinal(text, 'markdown');

    assert.equal(h.calls.filter((call) => call.method === 'chat.update').length, 1, 'never retried');
    const deleted = h.calls.find((call) => call.method === 'chat.delete');
    assert.equal(deleted?.input.ts, '1785800100.000200', 'the divergent stream is removed');
    assertFreshReply(h, planned, recorded);
    const presentation = v3(h);
    assert.equal(presentation.stream.state, 'artifact_delivered');
    assert.equal(presentation.continuations?.state, 'delivered');

    const before = posts(h).length;
    await presenter.deliverFinal(text, 'markdown');
    assert.equal(posts(h).length, before, 'a replay of the same final posts nothing');
  } finally {
    h.close();
  }
});
}

test('a persisted correction replays the same bounded update it recorded', async () => {
  const h = harness();
  try {
    const { text } = await streamDivergentAnswer(h);
    const rendered: string[] = [];
    const recording: SlackPresentationDeliveryObserver = {
      async before(input) { rendered.push(input.renderedPayload); return 'attempt'; },
      async after() {},
    };
    const result = await h.presentation.finalize(text, 'markdown', 'complete', recording);
    assert.equal(result.handled, true);
    const live = h.calls.find((call) => call.method === 'chat.update')!.input;
    assert.equal(rendered.length, 1);
    assert.equal(JSON.parse(rendered[0]!).method, 'slack_chat_stream_correct');

    const replayed: Array<{ method: string; input: Record<string, unknown> }> = [];
    await deliverPersistedSlackPayload({
      chat: {
        async stopStream(input: Record<string, unknown>) { replayed.push({ method: 'stop', input }); return { ok: true }; },
        async update(input: Record<string, unknown>) { replayed.push({ method: 'update', input }); return { ok: true }; },
      },
    } as unknown as WebClient, rendered[0]!);
    assert.deepEqual(replayed.map((call) => call.method), ['stop', 'update']);
    assert.deepEqual(replayed[1]!.input, live, 'replay sends exactly the live update');
    const blocks = replayed[1]!.input.blocks as Array<{ text?: string }>;
    assert.ok(blocks[0]!.text!.length <= RECOVERY_UPDATE_CHARS, 'the replay stays within the update bound');
  } finally {
    h.close();
  }
});

test('a long streamed answer whose stream aged out is retired and posts fresh in two messages', async () => {
  const h = harness();
  try {
    const recorded: Array<{ messageTs: string; text: string }> = [];
    const presenter = planningPresenter(h, recorded);
    const text = longPlan();
    await streamLongAnswer(h, text);
    assert.ok(streamedText(h).length > 0);

    // Past the retirement age the stream is closed before the final, which
    // then takes the fresh-post route with its own plan.
    h.clock.now += AGENT_VIEW_STREAM_RETIRE_AFTER_MS;
    await presenter.deliverFinal(text, 'markdown');

    const stops = h.calls.filter((call) => call.method === 'chat.stopStream');
    assert.equal(stops.length, 1, 'only the retirement stops the stream');
    const planned = splitSlackMarkdownReply(text);
    const [fresh, continuation, ...extra] = posts(h);
    assert.equal(extra.length, 0, 'one final and one continuation');
    assert.deepEqual(blockTypes(fresh!.input), ['markdown'], 'the fresh final carries no footer');
    assert.equal((fresh!.input.blocks as Array<{ text?: string }>)[0]!.text, planned[0]);
    assert.deepEqual(blockTypes(continuation!.input), ['markdown', 'context']);
    assert.equal((continuation!.input.blocks as Array<{ text?: string }>)[0]!.text, planned[1]);
    assert.deepEqual(recorded.map((delivery) => delivery.text), planned);
    assert.equal(v3(h).continuations?.state, 'delivered');
  } finally {
    h.close();
  }
});

/** A later attempt's own presenter over the same durable presentation. */
function attemptPresenter(h: Harness, runFencingToken = 0): SlackAgentViewPresentation {
  return new SlackAgentViewPresentation({
    client: h.client,
    state: h.state,
    runId: h.runId,
    runFencingToken,
    footer: { agentName: PERSONA.name, modelLabel: 'model-a', agentId: 'agent_planning' },
    minAppendIntervalMs: 0,
    now: () => h.clock.now,
    wait: async (milliseconds) => { h.clock.now += milliseconds; },
    onFinalized: () => undefined,
  });
}

const RESTART_RECEIPT = { submissionId: 'submission_restart', acceptedAt: 'now', uid: 'uid' } as const;
const RESTART_INPUT = {
  instanceId: 'instance_restart',
  receipt: RESTART_RECEIPT,
  eligibility: { allowed: true, reason: 'safe_early_release' } as const,
};

/** One streamed assistant message: its start, the stream declaration, and its text. */
function streamMessage(
  relay: NonNullable<Awaited<ReturnType<SlackAgentViewPresentation['prepareReceipt']>>>,
  messageId: string,
  text: string,
  batch: number,
  completed: boolean,
): number {
  relay.onEvent({
    type: 'message-started', conversationId: 'conversation',
    submissionId: RESTART_RECEIPT.submissionId, messageId, position: { batch, index: 0 },
  });
  relay.onEvent({
    type: 'tool-input', conversationId: 'conversation', messageId,
    toolCallId: `stream_${messageId}`, toolName: 'stream_answer', input: {},
    position: { batch: batch + 1, index: 0 },
  });
  relay.onEvent({
    type: 'tool-output', conversationId: 'conversation', toolCallId: `stream_${messageId}`,
    output: 'Delivery preference noted. Continue with the answer.',
    position: { batch: batch + 2, index: 0 },
  });
  let next = batch + 3;
  for (const delta of text.match(/[\s\S]{1,1500}/g) ?? []) {
    relay.onEvent({
      type: 'message-delta', conversationId: 'conversation', messageId,
      kind: 'text', delta, position: { batch: next, index: 0 },
    });
    next += 1;
  }
  if (completed) {
    relay.onEvent({
      type: 'message-completed', conversationId: 'conversation', messageId,
      position: { batch: next, index: 0 },
    });
    next += 1;
  }
  return next;
}

function presenterFor(h: Harness, agentView: SlackAgentViewPresentation): WebClientPresenter {
  return new WebClientPresenter(h.client, {
    channelId: ROOT.channelId,
    threadTs: ROOT.threadTs,
    agentName: PERSONA.name,
    visibleOwner: { kind: 'selected_agent', persona: PERSONA },
    agentId: 'agent_planning',
    userId: ROOT.requesterUserId,
    workspaceId: ROOT.workspaceId,
  }, undefined, { agentViewPresentation: agentView });
}

/** Attempt 1 streams a draft, then Flue's fiber is interrupted and the attempt ends. */
async function interruptedDraft(h: Harness, owner: SlackAgentViewPresentation, draft: string) {
  await owner.freezeProgressiveEligibility(RESTART_INPUT.eligibility);
  const relay = await owner.prepareReceipt(RESTART_INPUT);
  assert.ok(relay);
  streamMessage(relay, 'message_interrupted', draft, 1, false);
  await relay.suspendAndDrain();
  assert.equal(v3(h).stream.state, 'streaming');
  assert.ok(v3(h).stream.acknowledgedByteLength > 0);
}

function methods(h: Harness, method: string) {
  return h.calls.filter((call) => call.method === method);
}

/** The visible reply: the stream's first message and every follow-up, in order. */
function assertDeliveredOnce(h: Harness, text: string): void {
  const streamed = methods(h, 'chat.startStream').concat(methods(h, 'chat.appendStream'))
    .flatMap((call) => ((call.input.chunks ?? []) as Array<{ type: string; text?: string }>)
      .filter((chunk) => chunk.type === 'markdown_text').map((chunk) => chunk.text ?? ''))
    .join('');
  const [stop] = methods(h, 'chat.stopStream');
  const suffix = ((stop!.input.chunks ?? []) as Array<{ type: string; text?: string }>)
    .filter((chunk) => chunk.type === 'markdown_text').map((chunk) => chunk.text ?? '').join('');
  const first = streamed + suffix;
  assert.ok(first.length <= LIMIT, 'the stream holds only the first part');
  assert.equal(first, splitSlackMarkdownReply(text, { minFirstPartLength: streamed.length })[0],
    'X1: the first message ends where its follow-ups begin');
  const followUps = posts(h).map((post) => (post.input.blocks as Array<{ text?: string }>)[0]!.text!);
  assert.ok(followUps.length >= 1);
  assert.equal([first, ...followUps].join('\n\n').replace(/\s/g, ''), text.replace(/\s/g, ''),
    'every part once, nothing repeated');
}

test('a run Flue restarted mid-answer streams on and stops its stream once with the split intact', async () => {
  const h = harness();
  try {
    const text = longPlan();
    const draft = text.slice(0, 1_200);
    await interruptedDraft(h, h.presentation, draft);

    // Attempt 2 reads the same receipt from its start: the interrupted draft
    // again, then the recovered run's answer under a new message id.
    const second = attemptPresenter(h);
    const relay = await second.prepareReceipt(RESTART_INPUT);
    assert.ok(relay, 'the reattaching attempt gets a relay for the existing stream');
    const next = streamMessage(relay, 'message_interrupted', draft, 1, false);
    streamMessage(relay, 'message_recovered', text, next, true);
    // The recovered message is not the one the stream carries: the relay
    // stops streaming (it never throws) and the final resumes the stream.
    const summary = await relay.closeAndDrain();
    assert.equal(summary.invalidated, true);
    assert.equal(summary.invalidationReason, 'message_identity_conflict');

    await presenterFor(h, second).deliverFinal(text, 'markdown');
    assert.equal(methods(h, 'chat.startStream').length, 1, 'one stream for the Run');
    assert.equal(methods(h, 'chat.stopStream').length, 1, 'stopped exactly once');
    assert.equal(methods(h, 'chat.update').length, 0, 'resumed, not corrected');
    assert.equal(v3(h).stream.presentationOutcome, 'progressive');
    assertDeliveredOnce(h, text);
  } finally {
    h.close();
  }
});

test('an attempt whose relay setup fails answers on the existing stream and records why it did not stream', async () => {
  const h = harness();
  try {
    const text = longPlan();
    await interruptedDraft(h, h.presentation, text.slice(0, 1_200));
    const second = new SlackAgentViewPresentation({
      client: h.client,
      state: {
        ...h.state,
        matchFlueObservation: () => { throw new Error('synthetic observation lookup failure'); },
      },
      runId: h.runId,
      runFencingToken: 0,
      footer: { agentName: PERSONA.name, modelLabel: 'model-a', agentId: 'agent_planning' },
      minAppendIntervalMs: 0,
      now: () => h.clock.now,
      wait: async (milliseconds) => { h.clock.now += milliseconds; },
      onFinalized: () => undefined,
    });
    await assert.rejects(second.prepareReceipt(RESTART_INPUT), /synthetic observation lookup failure/);
    // flue-dispatch goes on without a relay; the final still closes the stream once.
    await presenterFor(h, second).deliverFinal(text, 'markdown');
    assert.equal(methods(h, 'chat.startStream').length, 1);
    assert.equal(methods(h, 'chat.stopStream').length, 1);
    assert.equal(v3(h).stream.degradationReason, 'relay_setup_failed');
    assertDeliveredOnce(h, text);
  } finally {
    h.close();
  }
});

test('a stale-fenced attempt gets no relay, and its final and the owner\'s together answer once', async () => {
  const h = harness();
  try {
    const text = longPlan();
    // The owner took the Run at fence 1 before streaming (an open stream
    // blocks any later fence advancement), so only an older attempt is stale.
    const owner = attemptPresenter(h, 1);
    await interruptedDraft(h, owner, text.slice(0, 1_200));

    const stale = attemptPresenter(h, 0);
    await assert.rejects(stale.prepareReceipt(RESTART_INPUT), /fence is stale/);
    // Terminal transitions are fenced by the Run's own token, so the stale
    // attempt's final closes the existing stream once, like any attempt's.
    await presenterFor(h, stale).deliverFinal(text, 'markdown');
    assertDeliveredOnce(h, text);
    const callsAfterFinal = h.calls.length;

    // The owner reattaching later finds the answer delivered and writes nothing.
    const resumed = attemptPresenter(h, 1);
    await (await resumed.prepareReceipt(RESTART_INPUT))?.closeAndDrain();
    await presenterFor(h, resumed).deliverFinal(text, 'markdown');
    assert.equal(h.calls.length, callsAfterFinal, 'no second stop, post, or follow-up');
    assert.equal(methods(h, 'chat.stopStream').length, 1);
  } finally {
    h.close();
  }
});

test('an attempt whose presentation is gone still delivers the answer once', async () => {
  const h = harness();
  try {
    const text = longPlan();
    const parts = splitSlackMarkdownReply(canonicalSlackMarkdownText(text));
    const missing = new SlackAgentViewPresentation({
      client: h.client,
      state: { ...h.state, getRunPresentation: () => undefined },
      runId: h.runId,
      runFencingToken: 0,
      footer: { agentName: PERSONA.name, modelLabel: 'model-a', agentId: 'agent_planning' },
    });
    await assert.rejects(missing.prepareReceipt(RESTART_INPUT), /presentation is missing/);
    const presenter = presenterFor(h, missing);
    // Before: finalize threw "presentation is missing" on every attempt.
    await presenter.deliverFinal(text, 'markdown');
    await presenter.markCanonicalPresentationFinalized();
    const [start] = methods(h, 'chat.startStream');
    assert.equal(methods(h, 'chat.startStream').length, 1);
    assert.equal(methods(h, 'chat.stopStream').length, 1);
    assert.equal(start!.input.markdown_text, parts[0]);
    const followUps = posts(h).map((post) => (post.input.blocks as Array<{ text?: string }>)[0]!.text!);
    assert.deepEqual(followUps.map((part) => part.replace(/\s/g, '')),
      parts.slice(1).map((part) => part.replace(/\s/g, '')));
  } finally {
    h.close();
  }
});

test('a final posted fresh after its plan froze for a stream reuses the frozen split', async () => {
  const h = harness();
  try {
    const recorded: Array<{ messageTs: string; text: string }> = [];
    const presenter = new WebClientPresenter(h.client, {
      channelId: ROOT.channelId,
      threadTs: ROOT.threadTs,
      agentName: PERSONA.name,
      visibleOwner: { kind: 'selected_agent', persona: PERSONA },
      agentId: 'agent_planning',
      userId: ROOT.requesterUserId,
      workspaceId: ROOT.workspaceId,
    }, undefined, {
      agentViewPresentation: h.presentation,
      onPublicDelivery: (delivery) => { recorded.push(delivery); },
    });
    const text = longPlan();
    await streamLongAnswer(h, text);
    const streamedChars = v3(h).stream.acknowledgedByteLength;
    assert.ok(streamedChars > 0);
    const split = { minFirstPartLength: streamedChars };
    const frozen = splitSlackMarkdownReply(text, split);
    assert.notEqual(frozen[0], splitSlackMarkdownReply(text)[0], 'the default split differs');

    // The plan froze for the stream; then the final must post fresh on the
    // fallback route, where the stream's prefix no longer shapes the split.
    mutate(h, { kind: 'retire_stream_for_file_share' });
    mutate(h, { kind: 'file_share_stream_retired', messageTs: '1785800100.000200' });
    mutate(h, { kind: 'record_terminal_delivery_intent', operationId: 'terminal_first', result: 'answer' });
    assert.equal(await h.presentation.planContinuations(frozen, undefined, [], split), true);
    mutate(h, {
      kind: 'record_terminal_delivery_receipt', operationId: 'terminal_first', certainty: 'failed',
    });

    await presenter.deliverFinal(text, 'markdown');
    const [final, continuation] = posts(h);
    assert.ok(final && continuation);
    assert.equal((final.input.blocks as Array<{ text?: string }>)[0]!.text, frozen[0]);
    assert.deepEqual(blockTypes(final.input), ['markdown']);
    assert.equal((continuation.input.blocks as Array<{ text?: string }>)[0]!.text, frozen[1]);
    assert.deepEqual(blockTypes(continuation.input), ['markdown', 'context']);
    assert.deepEqual(recorded.map((entry) => entry.text), frozen);
    assert.equal(v3(h).continuations?.state, 'delivered');
  } finally {
    h.close();
  }
});

test('repair posts the owed continuation exactly once after a crash between parts', async () => {
  const h = harness();
  try {
    await finalizeLongAnswer(h, longPlan());
    assert.equal(posts(h).length, 0, 'the crash happens before the follow-up');
    assert.equal(hasRetryableTerminalRepair(v3(h)), true);

    const drain = () => drainSlackPresentationRepairs({
      presentations: h.store.listAutoRepairableV3(10),
      state: h.state,
      resolveClient: async () => h.client,
      now: () => h.clock.now,
    });
    const first = await drain();
    assert.equal(first.attempted, 1);
    assert.equal(posts(h).length, 1);
    assert.equal(v3(h).continuations?.state, 'delivered');

    h.clock.now += 60 * 60_000;
    await drain();
    await h.presentation.deliverContinuations();
    assert.equal(posts(h).length, 1, 'no duplicate after repair');
  } finally {
    h.close();
  }
});

test('an unknown continuation effect is reconciled by readback and never reposted', async () => {
  const h = harness();
  try {
    await finalizeLongAnswer(h, longPlan());
    h.postErrors.push(new Error('socket hang up'));
    await h.presentation.deliverContinuations();
    let part = v3(h).continuations!.parts[0]!;
    assert.equal(part.operation?.certainty, 'unknown');
    assert.equal(posts(h).length, 1);

    // An incomplete read cannot prove absence: no second post.
    h.replies.complete = false;
    await h.presentation.deliverContinuations();
    assert.equal(posts(h).length, 1);
    assert.equal(v3(h).continuations!.parts[0]!.operation?.certainty, 'unknown');

    // The thread shows the earlier post: acknowledge it without posting.
    h.replies.messages = [{
      ts: '1785800100.000399',
      client_msg_id: slackClientMessageId(part.operation!.operationId),
    }];
    const delivered: string[] = [];
    await h.presentation.deliverContinuations({
      onDelivered: async (ts) => { delivered.push(ts); },
    });
    assert.equal(posts(h).length, 1);
    part = v3(h).continuations!.parts[0]!;
    assert.equal(part.operation?.certainty, 'acknowledged');
    assert.equal(part.messageTs, '1785800100.000399');
    assert.deepEqual(delivered, ['1785800100.000399']);
    const replies = h.calls.filter((call) => call.method === 'conversations.replies');
    assert.equal(replies.at(-1)?.input.oldest, '1785800100.000200');
  } finally {
    h.close();
  }
});

test('a young pending intent is left to its writer; an old one with a complete miss reposts once', async () => {
  const h = harness();
  try {
    await finalizeLongAnswer(h, longPlan());
    const operationId = 'continuation_crashed_writer';
    mutate(h, { kind: 'record_continuation_intent', index: 0, operationId });

    await h.presentation.deliverContinuations();
    assert.equal(posts(h).length, 0);
    assert.equal(h.calls.filter((call) => call.method === 'conversations.replies').length, 0);

    h.clock.now += 61_000;
    await h.presentation.deliverContinuations();
    const [post] = posts(h);
    assert.ok(post);
    assert.equal(post.input.client_msg_id, slackClientMessageId(operationId));
    assert.equal(v3(h).continuations?.state, 'delivered');
  } finally {
    h.close();
  }
});

test('repair abandons follow-ups that keep failing and stops owing them', async () => {
  const h = harness();
  try {
    await finalizeLongAnswer(h, longPlan());
    const rejected = Object.assign(new Error('rejected'), {
      code: ErrorCode.PlatformError,
      data: { ok: false, error: 'channel_not_found' },
    });
    for (let attempt = 0; attempt < 8; attempt += 1) h.postErrors.push(rejected);
    for (let attempt = 0; attempt < 7; attempt += 1) {
      await drainSlackPresentationRepairs({
        presentations: h.store.listAutoRepairableV3(10),
        state: h.state,
        resolveClient: async () => h.client,
        now: () => h.clock.now,
      });
      h.clock.now += 16 * 60_000;
    }
    const presentation = v3(h);
    assert.equal(presentation.continuations?.state, 'abandoned');
    assert.equal(presentation.continuations?.parts[0]?.operation?.certainty, 'failed');
    assert.equal(hasRetryableTerminalRepair(presentation), false);
    assert.equal(h.store.listAutoRepairableV3(10).length, 0);
    const attempts = posts(h).length;
    await h.presentation.deliverContinuations();
    assert.equal(posts(h).length, attempts);
  } finally {
    h.close();
  }
});

test('a failure notice that supersedes the answer abandons its follow-ups', () => {
  const h = harness();
  try {
    mutate(h, { kind: 'record_terminal_delivery_intent', operationId: 'terminal_answer', result: 'answer' });
    mutate(h, { kind: 'record_continuation_plan', parts: ['Part two.'], closing: CLOSING });
    mutate(h, {
      kind: 'record_terminal_delivery_receipt', operationId: 'terminal_answer', certainty: 'failed',
    });
    const superseded = mutate(h, {
      kind: 'supersede_failed_answer_delivery', operationId: 'terminal_failure',
    });
    assert.equal(superseded.continuations?.state, 'abandoned');
    assert.throws(() => mutate(h, {
      kind: 'record_continuation_intent', index: 0, operationId: 'continuation_x',
    }));
  } finally {
    h.close();
  }
});

test('an answer that supersedes a failed failure notice plans its own follow-ups again', () => {
  const h = harness();
  try {
    mutate(h, { kind: 'record_terminal_delivery_intent', operationId: 'terminal_answer', result: 'answer' });
    mutate(h, { kind: 'record_continuation_plan', parts: ['Part two.'], closing: CLOSING });
    mutate(h, {
      kind: 'record_terminal_delivery_receipt', operationId: 'terminal_answer', certainty: 'failed',
    });
    mutate(h, { kind: 'supersede_failed_answer_delivery', operationId: 'terminal_failure' });
    // The failure notice itself must have conclusively failed first.
    assert.throws(() => mutate(h, {
      kind: 'supersede_failed_failure_delivery', operationId: 'terminal_answer_again',
    }), /Only a confirmed failed failure delivery/);
    mutate(h, {
      kind: 'record_terminal_delivery_receipt', operationId: 'terminal_failure', certainty: 'failed',
    });
    assert.throws(() => mutate(h, {
      kind: 'supersede_failed_failure_delivery', operationId: 'terminal_failure',
    }), /new operation id/);
    const answered = mutate(h, {
      kind: 'supersede_failed_failure_delivery', operationId: 'terminal_answer_again',
    });
    assert.equal(answered.continuations, undefined);
    assert.deepEqual(answered.terminalDelivery, {
      state: 'intended',
      result: 'answer',
      operation: { operationId: 'terminal_answer_again', certainty: 'pending' },
    });
    const planned = mutate(h, {
      kind: 'record_continuation_plan', parts: ['Part two.'], closing: CLOSING,
    });
    assert.equal(planned.continuations?.state, 'active');
  } finally {
    h.close();
  }
});

test('continuation transitions keep order and reject a plan after the final is acknowledged', () => {
  const h = harness();
  try {
    mutate(h, { kind: 'record_terminal_delivery_intent', operationId: 'terminal_answer', result: 'answer' });
    // The stored closing is validated like other durable V3 facts.
    assert.throws(() => mutate(h, {
      kind: 'record_continuation_plan',
      parts: ['Part two.'],
      closing: { footer: { agentName: 'Planning Agent', agentId: '' } },
    }), /Footer Agent id/);
    assert.throws(() => mutate(h, {
      kind: 'record_continuation_plan',
      parts: ['Part two.'],
      closing: { ...CLOSING, files: [{ fileId: 'not-a-file' }] as never },
    }), /completed receipts/);
    assert.throws(() => mutate(h, {
      kind: 'record_continuation_plan', parts: ['x'.repeat(LIMIT + 1)], closing: CLOSING,
    }), /fit one Slack message/);
    mutate(h, {
      kind: 'record_continuation_plan', parts: ['Part two.', 'Part three.'], closing: CLOSING,
    });
    // Nothing posts before the canonical final is acknowledged.
    assert.throws(() => mutate(h, {
      kind: 'record_continuation_intent', index: 0, operationId: 'continuation_early',
    }));
    mutate(h, {
      kind: 'record_terminal_delivery_receipt', operationId: 'terminal_answer', certainty: 'acknowledged',
    });
    assert.throws(() => mutate(h, {
      kind: 'record_continuation_intent', index: 1, operationId: 'continuation_out_of_order',
    }));
    mutate(h, { kind: 'record_continuation_intent', index: 0, operationId: 'continuation_two' });
    assert.throws(() => mutate(h, {
      kind: 'record_continuation_receipt', index: 0, operationId: 'continuation_two',
      certainty: 'acknowledged',
    }), /coordinate/);
    mutate(h, {
      kind: 'record_continuation_receipt', index: 0, operationId: 'continuation_two',
      certainty: 'acknowledged', messageTs: '1785800100.000301',
    });
    assert.equal(v3(h).continuations?.state, 'active');
    mutate(h, { kind: 'record_continuation_intent', index: 1, operationId: 'continuation_three' });
    const delivered = mutate(h, {
      kind: 'record_continuation_receipt', index: 1, operationId: 'continuation_three',
      certainty: 'acknowledged', messageTs: '1785800100.000302',
    });
    assert.equal(delivered.continuations?.state, 'delivered');
  } finally {
    h.close();
  }
});

test('the presenter records every part of a long answer in thread context', async () => {
  const h = harness();
  try {
    const recorded: Array<{ messageTs: string; text: string }> = [];
    const presenter = new WebClientPresenter(h.client, {
      channelId: ROOT.channelId,
      threadTs: ROOT.threadTs,
      agentName: PERSONA.name,
      visibleOwner: { kind: 'selected_agent', persona: PERSONA },
      agentId: 'agent_planning',
      userId: ROOT.requesterUserId,
      workspaceId: ROOT.workspaceId,
    }, undefined, {
      agentViewPresentation: h.presentation,
      onPublicDelivery: (delivery) => { recorded.push(delivery); },
    });
    const text = longPlan();
    await presenter.deliverFinal(text, 'markdown');
    const parts = splitSlackMarkdownReply(canonicalSlackMarkdownText(text));
    assert.deepEqual(recorded, [
      { messageTs: '1785800100.000200', text: parts[0] },
      { messageTs: '1785800100.000301', text: parts[1] },
    ]);
  } finally {
    h.close();
  }
});

test('a presenter without a durable presentation posts follow-ups directly with one footer', async () => {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let posted = 0;
  const client = {
    chat: {
      async postMessage(input: Record<string, unknown>) {
        calls.push({ method: 'chat.postMessage', input });
        posted += 1;
        return { ok: true, ts: `1785800200.00010${posted}` };
      },
    },
  } as unknown as WebClient;
  const recorded: string[] = [];
  const presenter = new WebClientPresenter(client, {
    channelId: 'C_DIRECT',
    threadTs: '1785800200.000001',
    agentName: 'Direct Agent',
    agentId: 'agent_direct',
  }, undefined, {
    onPublicDelivery: ({ text }) => { recorded.push(text); },
  });
  const text = longPlan(40, 35);
  await presenter.deliverFinal(text, 'markdown');
  const parts = splitSlackMarkdownReply(canonicalSlackMarkdownText(text));
  assert.equal(calls.length, parts.length);
  assert.equal(parts.length, 4);
  calls.forEach((call, index) => {
    assert.equal(call.input.username, 'Direct Agent');
    assert.deepEqual(
      blockTypes(call.input),
      index === parts.length - 1 ? ['markdown', 'context'] : ['markdown'],
    );
  });
  assert.deepEqual(recorded, parts);
  assert.ok(recorded.at(-1)!.endsWith(SLACK_REPLY_SHORTENED_NOTE));
});

/** A guide shaped like the Amber LT-4 answer: many short headed checklist sections. */
function denseChecklistGuide(sections: number): string {
  return Array.from({ length: sections }, (_, index) => [
    `### ${index + 1}. Checklist step ${index + 1}`,
    '- [ ] Confirm the owner.',
    '- [ ] Record the rollback criteria.',
  ].join('\n')).join('\n\n');
}

function rendered(part: string) {
  return slackMarkdownRenderedShape(part);
}

test('a part under 12,000 characters that renders past the block limit is split until it fits', () => {
  // 80 headed sections: about 8,000 characters but about 160 rendered blocks.
  const text = denseChecklistGuide(80);
  assert.ok(text.length < LIMIT);
  assert.ok(rendered(text).blocks > 50, 'one message would exceed Slack\'s 50 blocks');
  const parts = splitSlackMarkdownReply(text);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(rendered(part).blocks <= slackMarkdownPartBlockLimit, 'each part fits the block budget');
    assert.ok(slackMarkdownPartFits(part));
  }
  assert.match(parts[1]!, /^### \d+\. Checklist step/, 'cuts still land before a heading');
  assert.equal(parts.join('\n\n'), text, 'no text is lost');
});

test('many code fences and tables are sized by their rendered blocks', () => {
  const fences = Array.from({ length: 60 }, (_, index) =>
    `Step ${index + 1}:\n\n\`\`\`sql\nSELECT ${index};\n\`\`\``).join('\n\n');
  const tables = Array.from({ length: 40 }, (_, index) =>
    `| Check | Owner |\n| --- | --- |\n| ${index} | ops |\n\nNote ${index}.`).join('\n\n');
  for (const text of [fences, tables]) {
    assert.ok(text.length < LIMIT);
    const parts = splitSlackMarkdownReply(text);
    assert.ok(parts.length > 1);
    assert.ok(parts.every((part) => rendered(part).blocks <= slackMarkdownPartBlockLimit));
    for (const part of parts) {
      assert.equal((part.match(/^```/gm) ?? []).length % 2, 0, 'fences stay balanced');
    }
    assert.equal(parts.join('\n\n'), text);
  }
});

test('characters Slack escapes count at their escaped length', () => {
  // 10,000 characters that Slack counts as far more than 12,000.
  const line = 'Compare p99 < 200ms && errors > 0 -> roll back & page the owner.';
  const text = Array.from({ length: Math.ceil(10_000 / (line.length + 1)) }, () => line).join('\n');
  assert.ok(text.length < LIMIT);
  assert.ok(rendered(text).countedLength > LIMIT);
  const parts = splitSlackMarkdownReply(text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => rendered(part).countedLength <= LIMIT));
  assert.equal(parts.join('\n'), text);
});

test('the rendered-shape bound never moves a streamed prefix out of the first message', () => {
  const text = denseChecklistGuide(80);
  const prefix = text.slice(0, text.indexOf('### 60.'));
  const parts = splitSlackMarkdownReply(text, { minFirstPartLength: prefix.length });
  assert.ok(parts[0]!.startsWith(prefix.trimEnd()));
  assert.equal(parts.join('\n\n'), text);
});

test('msg_blocks_too_long on a continuation re-splits it smaller: one final set, one footer', async () => {
  const h = harness();
  try {
    const text = longPlan(30, 23);
    await finalizeLongAnswer(h, text);
    const planned = v3(h).continuations!.parts.map((part) => part.text);
    // Through the gateway Slack's refusal arrives with an unknown effect.
    h.postErrors.push(new SlackTransportError('chat.postMessage', 'msg_blocks_too_long'));
    const delivered: string[] = [];
    await h.presentation.deliverContinuations({
      onDelivered: async (_ts, partText) => { delivered.push(partText); },
    });

    const presentation = v3(h);
    assert.equal(presentation.continuations?.state, 'delivered');
    assert.equal(presentation.continuations?.resplits, 1);
    const sent = posts(h);
    assert.equal(sent.length, 1 + delivered.length, 'the refused post is never repeated as is');
    assert.ok(delivered.length > planned.length, 'the refused text is carried in smaller parts');
    assert.ok(delivered.every((part) => part.length <= LIMIT / 2));
    assert.notEqual(sent[1]!.input.client_msg_id, sent[0]!.input.client_msg_id);
    const footers = sent.slice(1).filter((post) => blockTypes(post.input).includes('context'));
    assert.equal(footers.length, 1);
    assert.equal(footers[0], sent.at(-1), 'the last message carries the footer');
    const carried = delivered.join('\n\n');
    const expected = planned.join('\n\n');
    assert.ok(
      carried === expected ||
        (carried.endsWith(SLACK_REPLY_SHORTENED_NOTE) &&
          expected.startsWith(carried.slice(0, -SLACK_REPLY_SHORTENED_NOTE.length - 2))),
      'the parts carry the owed text in order, or end with the shortened note',
    );

    await h.presentation.deliverContinuations();
    assert.equal(posts(h).length, sent.length, 'a delivered set never posts again');
  } finally {
    h.close();
  }
});

test('a continuation Slack keeps refusing ends with the shortened note, then stops', async () => {
  const h = harness();
  try {
    await finalizeLongAnswer(h, longPlan(30, 23));
    const refuse = (count: number) => {
      for (let attempt = 0; attempt < count; attempt += 1) {
        h.postErrors.push(new SlackTransportError('chat.postMessage', 'msg_blocks_too_long'));
      }
    };
    // Two smaller splits are refused; the note alone posts with the footer.
    refuse(3);
    await h.presentation.deliverContinuations();
    let presentation = v3(h);
    assert.equal(presentation.continuations?.state, 'delivered');
    assert.equal(presentation.continuations?.resplits, 3);
    const sent = posts(h);
    assert.equal(sent.length, 4);
    const last = sent.at(-1)!.input;
    assert.deepEqual(blockTypes(last), ['markdown', 'context']);
    assert.equal((last.blocks as Array<{ text?: string }>)[0]!.text, SLACK_REPLY_SHORTENED_NOTE);

    // A reply whose note is refused too stops owing follow-ups at once.
    const g = harness();
    try {
      await finalizeLongAnswer(g, longPlan(30, 23));
      for (let attempt = 0; attempt < 10; attempt += 1) {
        g.postErrors.push(new SlackTransportError('chat.postMessage', 'msg_blocks_too_long'));
      }
      await g.presentation.deliverContinuations();
      presentation = v3(g);
      assert.equal(presentation.continuations?.state, 'abandoned');
      assert.equal(posts(g).length, 4, 'bounded: the refused part, two re-splits, the note');
      await g.presentation.deliverContinuations();
      await drainSlackPresentationRepairs({
        presentations: g.store.listAutoRepairableV3(10),
        state: g.state,
        resolveClient: async () => g.client,
        now: () => g.clock.now,
      });
      assert.equal(posts(g).length, 4, 'no retry after the bound');
      assert.equal(hasRetryableTerminalRepair(v3(g)), false);
    } finally {
      g.close();
    }
  } finally {
    h.close();
  }
});

test('only a refused, unsent continuation may be re-split', async () => {
  const h = harness();
  try {
    await finalizeLongAnswer(h, longPlan(30, 23));
    const current = v3(h);
    const attempt = (mutation: SlackPresentationMutation) => h.store.transition({
      runId: current.runId,
      workBindingGeneration: current.workBindingGeneration,
      runFencingToken: current.runFencingToken,
      expectedProjectionVersion: v3(h).projectionVersion,
      expectedStreamState: v3(h).stream.state,
      mutation,
    });
    assert.throws(() => attempt({ kind: 'resplit_continuations', index: 0, parts: ['smaller'] }));
    mutate(h, { kind: 'record_continuation_intent', index: 0, operationId: 'continuation_unknown' });
    mutate(h, {
      kind: 'record_continuation_receipt', index: 0, operationId: 'continuation_unknown', certainty: 'unknown',
    });
    assert.throws(
      () => attempt({ kind: 'resplit_continuations', index: 0, parts: ['smaller'] }),
      'an unknown effect may be visible and is never replaced',
    );
  } finally {
    h.close();
  }
});

test('the stream cap counts &, < and > at their escaped length', async () => {
  const h = harness();
  try {
    // About 11,800 raw characters: under the cap as typed, far over it as Slack counts.
    const paragraph = 'Roll back if p99 > 200ms && errors < 1% -> page the owner & record it. '.repeat(6).trim();
    const text = Array.from({ length: 28 }, () => paragraph).join('\n\n');
    assert.ok(text.length > LIMIT - 400 && text.length < LIMIT - 16);
    assert.ok(slackMarkdownRenderedShape(text).countedLength > LIMIT);

    await streamLongAnswer(h, text);
    const streamed = h.calls
      .filter((call) => call.method === 'chat.startStream' || call.method === 'chat.appendStream')
      .flatMap((call) => (call.input.chunks as Array<{ type: string; text?: string }>)
        .filter((chunk) => chunk.type === 'markdown_text')
        .map((chunk) => chunk.text ?? ''))
      .join('');
    assert.ok(text.startsWith(streamed));
    assert.ok(streamed.length > 0 && streamed.length < text.length);
    assert.ok(slackMarkdownRenderedShape(streamed).countedLength <= LIMIT - 16,
      'the stream stays under the cap as Slack counts it');

    await finalizeLongAnswer(h, text);
    const stop = h.calls.find((call) => call.method === 'chat.stopStream')!;
    const suffix = ((stop.input.chunks ?? []) as Array<{ type: string; text?: string }>)
      .filter((chunk) => chunk.type === 'markdown_text').map((chunk) => chunk.text ?? '').join('');
    assert.ok(slackMarkdownRenderedShape(streamed + suffix).countedLength <= LIMIT,
      'the first message fits as Slack counts it');
    await h.presentation.deliverContinuations();
    assert.equal(v3(h).continuations?.state, 'delivered');
  } finally {
    h.close();
  }
});
