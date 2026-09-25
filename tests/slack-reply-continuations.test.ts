import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ErrorCode, type WebClient } from '@slack/web-api';

import {
  AGENT_VIEW_STREAM_RETIRE_AFTER_MS,
  SlackAgentViewPresentation,
  type SlackPresentationDeliveryObserver,
  type SlackPresentationStatePort,
} from '../src/slack/agent-view-presentation.ts';
import {
  canonicalSlackMarkdownText,
  SLACK_REPLY_SHORTENED_NOTE,
  slackMarkdownBlockTextLimit,
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
import { WebClientPresenter } from '../src/slack/web-client-presenter.ts';
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

test('a long streamed answer whose stream expired posts part 1 fresh and its continuation follows', async () => {
  const h = harness();
  try {
    const recorded: Array<{ messageTs: string; text: string }> = [];
    const presenter = planningPresenter(h, recorded);
    const text = longPlan();
    await streamLongAnswer(h, text);
    const planned = splitSlackMarkdownReply(text, { minFirstPartLength: streamedText(h).length });
    assert.equal(planned.length, 2);
    // The streamed prefix moved the first cut, so a fresh split would not line up.
    assert.notEqual(planned[0], splitSlackMarkdownReply(text)[0]);

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

    const [fresh, continuation, ...extra] = posts(h);
    assert.equal(extra.length, 0, 'one final and one continuation');
    assert.deepEqual(blockTypes(fresh!.input), ['markdown'], 'the fresh final carries no footer');
    assert.equal((fresh!.input.blocks as Array<{ text?: string }>)[0]!.text, planned[0]);
    assert.equal(typeof fresh!.input.client_msg_id, 'string');
    assert.equal(fresh!.input.username, PERSONA.name);
    assert.deepEqual(blockTypes(continuation!.input), ['markdown', 'context']);
    assert.equal((continuation!.input.blocks as Array<{ text?: string }>)[0]!.text, planned[1]);
    assert.equal(continuation!.input.username, PERSONA.name);
    assert.deepEqual(recorded.map((delivery) => delivery.text), planned);

    const presentation = v3(h);
    assert.equal(presentation.stream.state, 'artifact_delivered');
    assert.equal(presentation.continuations?.state, 'delivered');
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
