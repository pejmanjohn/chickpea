import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConversationStreamChunk } from '@flue/runtime';

import {
  AnswerReleaseShadow,
  answerReleasePoint,
  RELEASE_AFTER_CHARS,
  type AnswerReleaseShadowRecord,
} from '../src/slack/answer-release.ts';
import { FILE_DELIVERY_DATA_NAME } from '../src/slack/file-delivery-completion.ts';
import { SLACK_AGENT_CREATION_TERMINAL_DATA_NAME } from '../src/slack/agent-creation-terminal.ts';
import { streamableSlackMarkdownPrefix } from '../src/slack/message-format.ts';

const SUBMISSION = 'submission_shadow';
const MESSAGE = 'message_shadow';
const SENTENCE = 'The synthetic forecast lists three dry days and one windy afternoon. ';

/** Plain prose of about `chars` characters, as model tokens: each word with its leading space. */
function prose(chars: number): string[] {
  const words = SENTENCE.repeat(Math.ceil(chars / SENTENCE.length)).slice(0, chars).split(/(?= )/);
  return words.filter((word) => word.length > 0);
}

/** One Flue response, read in order, with a clock that moves 10 ms per text token. */
function response() {
  let now = 1_000;
  let batch = 0;
  const shadow = new AnswerReleaseShadow(() => now);
  const emit = (body: Record<string, unknown> & { type: ConversationStreamChunk['type'] }) => {
    batch += 1;
    shadow.onEvent({
      conversationId: 'conversation_shadow',
      ...body,
      position: { batch, index: 0 },
    } as ConversationStreamChunk, SUBMISSION);
  };
  let calls = 0;
  const steps = {
    shadow,
    now: () => now,
    step() {
      emit({ type: 'message-started', messageId: MESSAGE, submissionId: SUBMISSION });
      return steps;
    },
    text(tokens: readonly string[]) {
      for (const delta of tokens) {
        now += 10;
        emit({ type: 'message-delta', messageId: MESSAGE, kind: 'text', delta });
      }
      return steps;
    },
    tool(toolName: string) {
      now += 10;
      calls += 1;
      const toolCallId = `call_${calls}`;
      emit({ type: 'tool-input', messageId: MESSAGE, toolCallId, toolName, input: {} });
      emit({ type: 'tool-output', toolCallId, output: 'synthetic result' });
      return steps;
    },
    data(name: string, data: unknown) {
      emit({ type: 'data-part', messageId: MESSAGE, name, data });
      return steps;
    },
    complete() {
      emit({ type: 'message-completed', messageId: MESSAGE });
      return steps;
    },
    record(): AnswerReleaseShadowRecord {
      const record = shadow.record();
      assert.ok(record, 'the shadow saw the response');
      return record;
    },
  };
  return steps;
}

const settled = (tokens: readonly string[]) => streamableSlackMarkdownPrefix(tokens.join('')).length;

test('the release rule counts settled characters, not raw ones', () => {
  const short = prose(RELEASE_AFTER_CHARS - 20).join('');
  assert.equal(answerReleasePoint(short), undefined);
  const long = prose(RELEASE_AFTER_CHARS + 60).join('');
  const point = answerReleasePoint(long);
  assert.ok(point !== undefined && point >= RELEASE_AFTER_CHARS, `released at ${point}`);
  assert.equal(point, streamableSlackMarkdownPrefix(long).length);
  // Open markup holds the rest of its line: raw length past the hold is not enough.
  const held = `${prose(120).join('')}\nSee \`the ${prose(500).join('')}`;
  assert.equal(answerReleasePoint(held), undefined, 'an unclosed code span holds its line');
});

// Defect caught: a shadow that never releases a long final answer, releases
// it late, or reports the raw length instead of the settled one.
test('a long final answer is released once it holds the settled threshold', () => {
  const answer = prose(900);
  const run = response().step().text(answer).complete();
  const record = run.record();
  assert.equal(record.outcome, 'released');
  assert.equal(record.holdChars, RELEASE_AFTER_CHARS);
  const tokensToRelease = answer.findIndex((_, index) => settled(answer.slice(0, index + 1)) >= RELEASE_AFTER_CHARS) + 1;
  assert.equal(record.releaseChars, settled(answer.slice(0, tokensToRelease)));
  assert.equal(record.releaseHoldMs, (tokensToRelease - 1) * 10, 'from the step\'s first text to the release');
  assert.equal(record.releasedAt, 1_000 + tokensToRelease * 10);
  assert.equal(record.finalAnswerChars, settled(answer));
  assert.deepEqual([record.toolSteps, record.answerSteps], [0, 1]);
  assert.equal(record.late, undefined);
});

// Defect caught: a hold of 0, or one counted in raw characters, would
// release a short answer.
test('a short answer is never released', () => {
  const answer = prose(260);
  const record = response().step().text(answer).complete().record();
  assert.equal(record.outcome, 'below_hold');
  assert.equal(record.releasedAt, undefined);
  assert.equal(record.releaseChars, undefined);
  assert.equal(record.finalAnswerChars, settled(answer));
  assert.equal(record.answerSteps, 1);
});

// Defect caught: narration before a tool counted as a release, or its
// length lost from the per-call counts.
test('a short preamble before a tool call is counted and never released', () => {
  const preamble = prose(150);
  const record = response()
    .step().text(preamble).tool('web_search').complete()
    .step().text(prose(250)).complete()
    .record();
  assert.equal(record.outcome, 'below_hold');
  assert.equal(record.toolSteps, 1);
  assert.equal(record.answerSteps, 1);
  assert.deepEqual(
    [record.preToolText1, record.preToolText100, record.preToolText200, record.preToolText400],
    [1, 1, 0, 0],
  );
});

// Defect caught: a release in a step that then calls a tool is reported as
// a streamed answer (the would-be retirement the threshold exists to bound),
// or a later long answer is released a second time.
test('a long preamble then a tool call is released and retired, and the answer after it is not released again', () => {
  const preamble = prose(700);
  const run = response().step().text(preamble);
  const releasedAt = run.record().releasedAt;
  assert.ok(releasedAt !== undefined, 'released before the tool call arrived');
  const toolAt = run.now() + 10;
  run.tool('web_search').complete().step().text(prose(900)).complete();
  const record = run.record();
  assert.equal(record.outcome, 'retired');
  assert.equal(record.late, 'tool');
  assert.equal(record.releasedAt, releasedAt, 'the first release stands; nothing releases after a retirement');
  assert.equal(record.releaseToLateMs, toolAt - releasedAt, 'how long the retired text would show');
  assert.deepEqual(
    [record.preToolText400, record.preToolText600, record.preToolText800],
    [1, settled(preamble) >= 600 ? 1 : 0, 0],
  );
  assert.equal(record.finalAnswerChars, settled(prose(900)));
});

// Defect caught: tool work before the answer blocks or delays its release.
test('tool calls then a long answer: the answer step is released', () => {
  const record = response()
    .step().tool('web_search').tool('read_slack_thread').complete()
    .step().text(prose(900)).complete()
    .record();
  assert.equal(record.outcome, 'released');
  assert.equal(record.toolSteps, 1, 'two calls in one step are one tool step');
  assert.equal(record.preToolText1, 0, 'no text before the calls');
  assert.equal(record.answerSteps, 1);
});

// Defect caught: a draft the host may replace still counted as a release.
test('a draft-replacing tool keeps the response blocked, whatever follows', () => {
  const answer = prose(900);
  const record = response()
    .step().tool('apply_workspace_changes').complete()
    .step().text(answer).complete()
    .record();
  assert.equal(record.outcome, 'blocked');
  assert.equal(record.block, 'draft_replacing_tool');
  assert.equal(record.releasedAt, undefined);
  assert.equal(record.finalAnswerChars, settled(answer), 'the answer is still measured');
});

// Defect caught: a blocking condition missed, one counted that is not, or a
// presentation tool after released text not told apart from other tools.
test('each blocking condition blocks before a release and retires after one', () => {
  const blockers: Array<[string, (run: ReturnType<typeof response>) => unknown, string]> = [
    ['draft_replacing_tool', (run) => run.tool('undo_workspace_change'), 'tool'],
    ['file_delivery', (run) => run.tool('post_artifact'), 'tool'],
    ['interactive_component', (run) => run.tool('ask_user'), 'presentation_tool'],
    ['agent_creation', (run) => run.data(SLACK_AGENT_CREATION_TERMINAL_DATA_NAME, { kind: 'created' }), 'agent_creation'],
    ['file_delivery', (run) => run.data(FILE_DELIVERY_DATA_NAME, { unresolved: false, files: [{ name: 'report.csv' }] }), 'file_delivery'],
  ];
  for (const [block, apply, late] of blockers) {
    const before = response().step();
    apply(before);
    before.complete().step().text(prose(900)).complete();
    assert.deepEqual([before.record().outcome, before.record().block], ['blocked', block], `${block} blocks`);

    const after = response().step().text(prose(900));
    apply(after);
    assert.deepEqual([after.record().outcome, after.record().late], ['retired', late], `${block} retires`);
  }

  const notBlocking = response().step()
    .data(FILE_DELIVERY_DATA_NAME, { unresolved: false, files: [] })
    .tool('complete_file_delivery').tool('present_table').complete()
    .step().text(prose(900)).complete()
    .record();
  assert.equal(notBlocking.outcome, 'released', 'an empty file check and a table before the answer do not block');

  const tableAfter = response().step().text(prose(900)).tool('present_table').record();
  assert.deepEqual([tableAfter.outcome, tableAfter.late], ['retired', 'presentation_tool']);
});

// Defect caught: the release counted on raw text, so a line held at a
// credential marker would be released before redaction could settle it.
test('a credential marker holds the settled prefix until its line ends', () => {
  const opening = prose(150);
  const heldLine = ['\nSet', ' ADMIN_TOKEN', ...prose(500)];
  const run = response().step().text(opening).text(heldLine);
  const raw = [...opening, ...heldLine].join('');
  assert.ok(raw.length > RELEASE_AFTER_CHARS + 200, 'the raw text is well past the hold');
  assert.ok(settled([...opening, ...heldLine]) < RELEASE_AFTER_CHARS, 'the marker holds the line');
  assert.equal(run.record().outcome, 'below_hold');

  const lineEndsAt = run.now() + 10;
  run.text(['\n']).complete();
  const record = run.record();
  assert.equal(record.outcome, 'released');
  assert.equal(record.releasedAt, lineEndsAt, 'released when the line ended, not before');
  assert.ok(Number(record.releaseChars) >= RELEASE_AFTER_CHARS);
});

// Defects caught: another submission's text or a replayed chunk counted, a
// read's opening snapshot taken for a reset, or a reset mid-response ignored.
test('the shadow reads only its submission, once, and stops at a reset after the response began', () => {
  const shadow = new AnswerReleaseShadow(() => 0);
  const chunk = (body: Record<string, unknown>, batch: number) =>
    ({ conversationId: 'conversation_shadow', ...body, position: { batch, index: 0 } }) as ConversationStreamChunk;
  const reset = (batch: number) => chunk({
    type: 'conversation-reset',
    snapshot: { v: 1, conversationId: 'conversation_shadow', offset: '0', messages: [], settlements: [] },
  }, batch);
  shadow.onEvent(reset(0), SUBMISSION);
  assert.equal(shadow.record(), undefined, 'nothing began yet');
  shadow.onEvent(chunk({ type: 'message-started', messageId: 'other', submissionId: 'submission_other' }, 1), SUBMISSION);
  shadow.onEvent(chunk({ type: 'message-delta', messageId: 'other', kind: 'text', delta: prose(900).join('') }, 2), SUBMISSION);
  assert.equal(shadow.record(), undefined, 'another submission is not this response');
  shadow.onEvent(chunk({ type: 'message-started', messageId: MESSAGE, submissionId: SUBMISSION }, 3), SUBMISSION);
  shadow.onEvent(chunk({ type: 'message-delta', messageId: MESSAGE, kind: 'text', delta: prose(200).join('') }, 4), SUBMISSION);
  shadow.onEvent(chunk({ type: 'message-delta', messageId: MESSAGE, kind: 'text', delta: prose(200).join('') }, 4), SUBMISSION);
  shadow.onEvent(chunk({ type: 'message-completed', messageId: MESSAGE }, 5), SUBMISSION);
  assert.equal(shadow.record()?.outcome, 'below_hold', 'a replayed chunk is read once');
  shadow.onEvent(reset(6), SUBMISSION);
  shadow.onEvent(chunk({ type: 'message-started', messageId: MESSAGE, submissionId: SUBMISSION }, 7), SUBMISSION);
  shadow.onEvent(chunk({ type: 'message-delta', messageId: MESSAGE, kind: 'text', delta: prose(900).join('') }, 8), SUBMISSION);
  assert.deepEqual([shadow.record()?.outcome, shadow.record()?.block], ['blocked', 'conversation_reset']);
});

// Defect caught: the record carries text, or a field the log would drop.
test('the record holds only numbers and fixed tokens', () => {
  const run = response().step().text(prose(700)).tool('web_search').complete().step().text(prose(900)).complete();
  const record = run.record();
  const serialized = JSON.stringify(record);
  assert.equal(serialized.includes('forecast'), false);
  for (const [key, value] of Object.entries(record)) {
    assert.ok(typeof value === 'number' || /^[a-z_]+$/.test(String(value)), `${key} is a number or a token`);
  }
});
