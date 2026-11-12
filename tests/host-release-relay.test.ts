import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConversationStreamChunk } from '@flue/runtime';

import { SLACK_AGENT_CREATION_TERMINAL_DATA_NAME } from '../src/slack/agent-creation-terminal.ts';
import { SLACK_ARTIFACT_RECEIPTS_DATA_NAME } from '../src/slack/artifact-receipts.ts';
import {
  CODING_WORKER_RUN_DATA_NAME, CODING_WORKER_USAGE_DATA_NAME, WORKSPACE_MILESTONE_DATA_NAME,
} from '../src/slack/coding-worker-run.ts';
import { answerReleasePoint } from '../src/slack/answer-release.ts';
import { FILE_DELIVERY_DATA_NAME } from '../src/slack/file-delivery-completion.ts';
import { FRONT_DESK_TOOL_NAME, SLACK_FRONT_DESK_HANDOFF_DATA_NAME } from '../src/slack/front-desk.ts';
import { HostReleaseRelay, type HostReleaseReport } from '../src/slack/host-release-relay.ts';
import { SLACK_MEMORY_UPDATE_DATA_NAME } from '../src/slack/memory-update-terminal.ts';
import { streamableSlackMarkdownPrefix } from '../src/slack/message-format.ts';
import { SLACK_STREAM_ANSWER_TOOL_NAME } from '../src/slack/presentation-intent.ts';
import type { ProgressiveTextChunk } from '../src/slack/progressive-relay.ts';
import { HOST_RELEASE_INTENT_ID, type SlackProgressiveIntent } from '../src/slack/run-presentations.ts';
import { SLACK_TABLE_PRESENTATION_DATA_NAME } from '../src/slack/table-presentation.ts';
import { SLACK_DISPLAY_COMPONENTS_DATA_NAME } from '../src/slack/ui/display-tools.ts';
import { SLACK_INTERACTIVE_QUESTION_DATA_NAME } from '../src/slack/ui/interactive-tools.ts';
import { SLACK_ASK_USER_TOOL_NAME } from '../src/slack/ui/presentation-tools.ts';
import { KEY_SETUP_TOOL_DATA_NAME } from '../src/slack/ui/surface.ts';
import { CODING_WORKSPACE_USE_DATA_NAME } from '../src/sandbox/workspace-use.ts';

const SUBMISSION = 'submission_host_release';
const MESSAGE = 'message_host_release';
const SENTENCE = 'The synthetic forecast lists three dry days and one windy afternoon. ';
const HOLD = 400;

/** Plain prose of about `chars` characters, as model tokens: each word with its leading space. */
function prose(chars: number): string[] {
  return SENTENCE.repeat(Math.ceil(chars / SENTENCE.length)).slice(0, chars).split(/(?= )/)
    .filter((word) => word.length > 0);
}

/** One Flue response read by a host release relay whose sink records every effect in order. */
function response(input: { initial?: SlackProgressiveIntent; holdChars?: number } = {}) {
  const effects: string[] = [];
  const appended: ProgressiveTextChunk[] = [];
  const reports: HostReleaseReport[] = [];
  const initial = input.initial ?? { status: 'unresolved' };
  const relay = new HostReleaseRelay({
    submissionId: SUBMISSION,
    holdChars: input.holdChars ?? HOLD,
    initial,
    modelIntent: {
      initial,
      async transition(intent) {
        effects.push(`intent:${intent.kind}${'toolCallId' in intent ? `:${intent.toolCallId}`
          : intent.kind === 'denied' ? `:${intent.reason}` : ''}`);
      },
    },
    async append(chunk) {
      effects.push('append');
      appended.push(structuredClone(chunk));
    },
    async invalidate(reason) { effects.push(`invalidate:${reason}`); },
    async retire(late) { effects.push(`retire:${late}`); },
    report: (report) => { reports.push(report); },
  });
  let batch = 0;
  let calls = 0;
  const emit = (body: Record<string, unknown> & { type: ConversationStreamChunk['type'] }) => {
    batch += 1;
    relay.onEvent({ conversationId: 'conversation', ...body, position: { batch, index: 0 } } as ConversationStreamChunk);
  };
  const steps = {
    relay,
    effects,
    reports,
    /** Every appended chunk joined: what reached the sink. */
    sent: () => appended.map((chunk) => chunk.delta).join(''),
    first: () => appended[0]?.delta ?? '',
    step() {
      emit({ type: 'message-started', messageId: MESSAGE, submissionId: SUBMISSION });
      return steps;
    },
    text(tokens: readonly string[]) {
      for (const delta of tokens) emit({ type: 'message-delta', messageId: MESSAGE, kind: 'text', delta });
      return steps;
    },
    tool(toolName: string) {
      calls += 1;
      emit({ type: 'tool-input', messageId: MESSAGE, toolCallId: `call_${calls}`, toolName, input: {} });
      emit({ type: 'tool-output', toolCallId: `call_${calls}`, output: 'done' });
      return steps;
    },
    data(name: string, data: unknown = {}) {
      emit({ type: 'data-part', messageId: MESSAGE, name, data });
      return steps;
    },
    complete() {
      emit({ type: 'message-completed', messageId: MESSAGE });
      return steps;
    },
    /** Flue's stream recovery: the hidden advisory that asks the model to continue its partial. */
    recover() {
      emit({
        type: 'message-appended',
        message: { id: `advisory_${batch}`, role: 'system', purpose: 'advisory', display: 'hidden', parts: [] },
      });
      return steps;
    },
    reset() {
      emit({
        type: 'conversation-reset',
        snapshot: { v: 1, conversationId: 'conversation', offset: '0', messages: [], settlements: [] },
      });
      return steps;
    },
    async close() {
      await relay.closeAndDrain();
      return steps;
    },
    async drain() {
      // A late event closes the relay; its queued effects still run.
      await relay.closeAndDrain();
      return steps;
    },
  };
  return steps;
}

const RELEASED = [`intent:candidate:${HOST_RELEASE_INTENT_ID}`, `intent:requested:${HOST_RELEASE_INTENT_ID}`];

// Defect caught: a hold of 0, or one counted on raw text, releases a short answer early.
test('a step that ends short of the hold shows nothing early and records not_requested', async () => {
  const run = await response().step().text(prose(HOLD - 40)).complete().close();
  assert.deepEqual(run.effects, ['intent:not_requested']);
  assert.deepEqual(run.reports, [{ outcome: 'below_hold' }]);
});

// Defects caught: an append before the durable intent, held text lost at the
// release, or later text not appended.
test('past the hold the host intent is durable before the first append, which carries the held text', async () => {
  const opening = prose(HOLD + 20);
  const run = response().step().text(opening);
  const rest = prose(300);
  run.text(rest).complete();
  await run.close();
  assert.deepEqual(run.effects.slice(0, 3), [...RELEASED, 'append']);
  assert.equal(run.effects.filter((effect) => effect.startsWith('intent:')).length, 2, 'no not_requested at close');
  assert.equal(run.sent(), [...opening, ...rest].join(''), 'the held text and every later token, once');
  assert.deepEqual(run.reports, [{ outcome: 'released' }]);
  assert.ok(streamableSlackMarkdownPrefix(run.sent()).length >= HOLD);
});

test('tool steps, then a long answer step: the answer streams and no narration does', async () => {
  const narration = ['Let me', ' check the', ' forecast first.'];
  const answer = prose(900);
  const run = response()
    .step().text(narration).tool('web_search').complete()
    .step().tool('read_memory').complete()
    .step().text(answer).complete();
  await run.close();
  assert.equal(run.sent(), answer.join(''));
  assert.deepEqual(run.effects.slice(0, 2), RELEASED);
  assert.ok(!run.effects.some((effect) => effect.startsWith('retire')));
});

// Defect caught: tools before a release denied, as the declared relay's early mode does.
test('a short preamble, then a tool: nothing is released and the next answer step still can be', async () => {
  const run = response().step().text(prose(HOLD - 100)).tool('web_search').complete();
  assert.deepEqual(run.effects, []);
  run.step().text(prose(HOLD + 50)).complete();
  await run.close();
  assert.deepEqual(run.effects.slice(0, 3), [...RELEASED, 'append']);
});

// Defect caught: no retirement, so a preamble stays in Slack as if it were the answer.
test('a long preamble, then a tool: the release is retired and nothing more is appended', async () => {
  const run = response().step().text(prose(HOLD + 50));
  await new Promise((resolve) => setImmediate(resolve));
  run.tool('web_search').complete().step().text(prose(900)).complete();
  await run.drain();
  assert.deepEqual(run.effects, [...RELEASED, 'append', 'retire:tool']);
  assert.ok(!run.effects.some((effect) => effect.startsWith('intent:denied')), 'the host intent stays requested');
});

test('a release and its tool call read in one page never reach Slack', async () => {
  const run = response().step().text(prose(HOLD + 50)).tool(SLACK_STREAM_ANSWER_TOOL_NAME);
  await run.drain();
  assert.deepEqual(run.effects, [...RELEASED, 'retire:tool']);
  assert.equal(run.sent(), '');
});

test('what follows a release decides how it is retired', async () => {
  for (const [follow, late] of [
    [(run: ReturnType<typeof response>) => run.tool('present_table'), 'presentation_tool'],
    [(run: ReturnType<typeof response>) => run.tool('post_artifact'), 'file_delivery'],
    [(run: ReturnType<typeof response>) => run.complete().step(), 'step'],
    [(run: ReturnType<typeof response>) => run.reset(), 'conversation_reset'],
    [(run: ReturnType<typeof response>) => run.data(SLACK_DISPLAY_COMPONENTS_DATA_NAME), 'display_component'],
    [(run: ReturnType<typeof response>) => run.data(FILE_DELIVERY_DATA_NAME, { unresolved: false, files: ['F1'] }), 'file_delivery'],
  ] as const) {
    const run = response().step().text(prose(HOLD + 50));
    await new Promise((resolve) => setImmediate(resolve));
    follow(run);
    await run.drain();
    assert.deepEqual(run.effects, [...RELEASED, 'append', `retire:${late}`], late);
  }
});

// Defect caught: Flue's recovery of an interrupted step taken for a new step, retiring a good answer.
test('a step Flue recovers after an interruption keeps streaming', async () => {
  const partial = prose(HOLD + 50);
  const continuation = prose(300);
  const run = response().step().text(partial).complete().recover().step().text(continuation).complete();
  await run.close();
  assert.ok(!run.effects.some((effect) => effect.startsWith('retire')));
  assert.equal(run.sent(), [...partial, ...continuation].join(''));
});

// Defects caught: a blocking condition ignored before release, or a pass-list data part blocking.
test('each blocking condition before a release keeps the response terminal', async () => {
  for (const [block, follow, denial] of [
    ['draft_replacing_tool', (run: ReturnType<typeof response>) => run.tool('apply_workspace_changes'), 'non_presentation_tool'],
    ['draft_replacing_tool', (run: ReturnType<typeof response>) => run.tool(FRONT_DESK_TOOL_NAME), 'non_presentation_tool'],
    ['file_delivery', (run: ReturnType<typeof response>) => run.tool('post_artifact'), 'structured_output'],
    ['interactive_component', (run: ReturnType<typeof response>) => run.tool(SLACK_ASK_USER_TOOL_NAME), 'non_presentation_tool'],
    ['agent_creation', (run: ReturnType<typeof response>) => run.data(SLACK_AGENT_CREATION_TERMINAL_DATA_NAME), 'structured_output'],
    ['file_delivery', (run: ReturnType<typeof response>) => run.data(FILE_DELIVERY_DATA_NAME, { unresolved: true, files: [] }), 'structured_output'],
    ['file_delivery', (run: ReturnType<typeof response>) => run.data(SLACK_ARTIFACT_RECEIPTS_DATA_NAME), 'structured_output'],
    ['interactive_component', (run: ReturnType<typeof response>) => run.data(SLACK_INTERACTIVE_QUESTION_DATA_NAME), 'non_presentation_tool'],
    ['draft_replacing_tool', (run: ReturnType<typeof response>) => run.data(SLACK_FRONT_DESK_HANDOFF_DATA_NAME), 'non_presentation_tool'],
    ['display_component', (run: ReturnType<typeof response>) => run.data(SLACK_DISPLAY_COMPONENTS_DATA_NAME), 'structured_output'],
    ['key_setup', (run: ReturnType<typeof response>) => run.data(KEY_SETUP_TOOL_DATA_NAME), 'structured_output'],
    ['structured_output', (run: ReturnType<typeof response>) => run.data('someFuturePart'), 'structured_output'],
    ['conversation_reset', (run: ReturnType<typeof response>) => run.reset(), 'reset'],
  ] as const) {
    const run = response().step().text(['Working.']);
    follow(run);
    run.complete().step().text(prose(900)).complete();
    await run.close();
    assert.deepEqual(run.effects, [`intent:denied:${denial}`], `${block}: denied, nothing appended`);
    assert.deepEqual(run.reports, [{ outcome: 'blocked', block }], block);
  }
});

test('data parts after which the answer is delivered as written pass, before and after a release', async () => {
  const passing: Array<[string, unknown]> = [
    [SLACK_MEMORY_UPDATE_DATA_NAME, {}],
    [SLACK_TABLE_PRESENTATION_DATA_NAME, {}],
    [CODING_WORKSPACE_USE_DATA_NAME, { opened: true }],
    [CODING_WORKER_RUN_DATA_NAME, {}],
    [CODING_WORKER_USAGE_DATA_NAME, {}],
    [WORKSPACE_MILESTONE_DATA_NAME, {}],
    [FILE_DELIVERY_DATA_NAME, { unresolved: false, files: [] }],
  ];
  const run = response().step().tool('update_memory');
  for (const [name, data] of passing) run.data(name, data);
  run.complete().step().text(prose(HOLD + 50));
  await new Promise((resolve) => setImmediate(resolve));
  for (const [name, data] of passing) run.data(name, data);
  run.text(prose(100)).complete();
  await run.close();
  assert.deepEqual(run.effects.slice(0, 3), [...RELEASED, 'append']);
  assert.ok(!run.effects.some((effect) => effect.startsWith('retire') || effect.startsWith('intent:denied')));
});

// Defects caught: a resumed read releasing at another point, or writing its intent again.
test('a resumed read releases at the same point and records no intent again', async () => {
  const shape = (run: ReturnType<typeof response>) =>
    run.step().text(['Checking.']).tool('web_search').complete().step().text(prose(HOLD + 200)).complete();
  const first = shape(response());
  await first.close();
  const resumed = shape(response({ initial: { status: 'requested', toolCallId: HOST_RELEASE_INTENT_ID, requestedAt: 1 } }));
  await resumed.close();
  assert.equal(resumed.sent(), first.sent());
  // With no intent write to wait for, the resumed read's first append is the held text alone.
  const held = resumed.first();
  assert.notEqual(answerReleasePoint(held, HOLD), undefined, 'released at the hold');
  assert.equal(answerReleasePoint(held.slice(0, held.lastIndexOf(' ')), HOLD), undefined, 'and not a token later');
  assert.ok(!resumed.effects.some((effect) => effect.startsWith('intent:')));
});

test('a resumed read retires a recorded release when its replay meets a blocking condition first', async () => {
  const run = response({ initial: { status: 'requested', toolCallId: HOST_RELEASE_INTENT_ID, requestedAt: 1 } })
    .step().text(['Updating.']).tool('apply_workspace_changes');
  await run.drain();
  assert.deepEqual(run.effects, ['retire:draft_replacing_tool']);
});

test('only an unresolved or host-requested intent opens a host release', () => {
  for (const initial of [
    { status: 'pending', toolCallId: 'stream_call' },
    { status: 'requested', toolCallId: 'stream_call', requestedAt: 1 },
  ] as const) {
    assert.throws(() => response({ initial }), /host release/);
  }
});

// Defect caught: the release counted raw characters past a credential marker
// that redaction had not settled.
test('a credential marker inside the hold delays the release until the settled text reaches it', async () => {
  const opening = prose(150);
  const heldLine = ['\nSet', ' ADMIN_TOKEN', ...prose(500)];
  const run = response().step().text(opening).text(heldLine);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok([...opening, ...heldLine].join('').length > HOLD + 200, 'the raw text is well past the hold');
  assert.deepEqual(run.effects, [], 'nothing released while the marker holds the line');
  run.text(['\n']).complete();
  await run.close();
  assert.deepEqual(run.effects.slice(0, 3), [...RELEASED, 'append']);
});

test('the hold is the deployment\'s, not a constant', async () => {
  const short = await response({ holdChars: 1_000 }).step().text(prose(900)).complete().close();
  assert.deepEqual(short.effects, ['intent:not_requested']);
  const low = await response({ holdChars: 100 }).step().text(prose(150)).complete().close();
  assert.deepEqual(low.effects.slice(0, 3), [...RELEASED, 'append']);
});
