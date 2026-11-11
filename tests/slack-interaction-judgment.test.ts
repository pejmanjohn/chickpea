import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CLEF_TIMEOUT_MS, type ClefOutcome } from '../src/slack/clef-intent.ts';
import {
  earlyInteractionJudgment,
  judgeGuaranteedInteraction,
  refineEarly,
  startJudgmentCalls,
  type EarlyIntent,
  type GuaranteedInteractionJudgmentOptions,
  type SlackInteractionClassification,
  type SlackInteractionIntent,
  type SlackInteractionIntentContext,
} from '../src/slack/interaction-intent.ts';
import { CLEF_PROFILES, clefWire, fakeClefEnv, type ClefProbabilities } from './helpers/fake-clef.ts';

const MESSAGE = 'Can you summarize what changed in the release notes this week?';
const PROFILE = 'You are Scout. Keep answers short.';

const context: SlackInteractionIntentContext & { guaranteed: true } = {
  workspaceId: 'T_JUDGE',
  channelId: 'D_JUDGE',
  eventId: 'Ev_JUDGE',
  text: MESSAGE,
  source: 'dm_message',
  guaranteed: true,
  profileInstructions: PROFILE,
};

function read(probabilities: ClefProbabilities, memory = 0.02): ClefOutcome {
  const [choice] = (Object.entries(probabilities) as Array<[keyof ClefProbabilities, number]>)
    .reduce((best, entry) => (entry[1] > best[1] ? entry : best));
  return { kind: 'read', reading: { choice, probabilities, memory, inputTokens: 878 }, ms: 260 };
}

const REPLY: SlackInteractionIntent = { disposition: 'reply', reason: 'substantive_request' };
const CLEF_WORK = { disposition: 'work', reason: 'substantive_request', checklist: [] };
const MODEL_WORK: SlackInteractionIntent = {
  disposition: 'work', reason: 'substantive_request', checklist: ['Release summary', 'Notable changes'],
};
const MODEL_REACT: SlackInteractionIntent = {
  disposition: 'react_only', reason: 'pure_ack', reaction: 'seen', target: 'thread_root',
};

// Defect caught: the threshold is off by one, or the gate reads the folded
// disposition's probability instead of Clef's own choice.
test('a reply at 0.60 dispatches and at 0.599 awaits the model', () => {
  assert.deepEqual(
    earlyInteractionJudgment(read({ reply: 0.6, work: 0.2, react_only: 0.15, ignore: 0.05 })),
    { kind: 'dispatch', intent: REPLY },
  );
  assert.deepEqual(
    earlyInteractionJudgment(read({ reply: 0.599, work: 0.2, react_only: 0.151, ignore: 0.05 })),
    { kind: 'await_model' },
  );
});

// Defect caught: Clef invents labels, or a work basis carries generic labels
// that would block the model's plan.
test('a confident work dispatches work with an empty checklist', () => {
  assert.deepEqual(
    earlyInteractionJudgment(read({ reply: 0.2, work: 0.7, react_only: 0.06, ignore: 0.04 })),
    { kind: 'dispatch', intent: CLEF_WORK },
  );
});

// Defect caught: Clef decides a reaction (its emoji is wrong 16 of 35 times),
// or the memory fold is lost and a memory request gets an emoji.
test('a confident react_only awaits the model, unless memory is possible, which folds to reply', () => {
  const quiet = { reply: 0.05, work: 0.03, react_only: 0.9, ignore: 0.02 };
  assert.deepEqual(earlyInteractionJudgment(read(quiet, 0.49)), { kind: 'await_model' });
  assert.deepEqual(earlyInteractionJudgment(read(quiet, 0.5)), { kind: 'dispatch', intent: REPLY });
});

// Defect caught: the evaluation's guaranteed-ignore fold dispatches on a guess
// instead of letting the model choose, as today.
test('a confident ignore awaits the model, memory or not', () => {
  const ignore = { reply: 0.05, work: 0.03, react_only: 0.02, ignore: 0.9 };
  assert.deepEqual(earlyInteractionJudgment(read(ignore)), { kind: 'await_model' });
  assert.deepEqual(earlyInteractionJudgment(read(ignore, 0.9)), { kind: 'await_model' });
});

// Defect caught: a failure dispatches.
test('every non-read outcome awaits the model', () => {
  const outcomes: ClefOutcome[] = [
    { kind: 'unavailable' },
    { kind: 'timeout', ms: 1000 },
    { kind: 'error', ms: 12 },
    { kind: 'unparseable', ms: 240 },
  ];
  for (const outcome of outcomes) {
    assert.deepEqual(earlyInteractionJudgment(outcome), { kind: 'await_model' }, outcome.kind);
  }
});

// Defect caught: a model answer refines the recorded disposition, or labels
// attach to a turn the model did not judge work.
test('refineEarly yields labels only for work agreeing with work, and never a disposition', () => {
  const early = earlyInteractionJudgment(read({ reply: 0.2, work: 0.7, react_only: 0.06, ignore: 0.04 }));
  assert.equal(early.kind, 'dispatch');
  if (early.kind !== 'dispatch') return;
  const work = early.intent;
  assert.deepEqual(refineEarly(work, { intent: MODEL_WORK, failed: false }), { kind: 'labels', labels: MODEL_WORK.checklist });
  assert.deepEqual(refineEarly(work, { intent: REPLY, failed: false }), { kind: 'discarded', why: 'disagreed' });
  assert.deepEqual(refineEarly(work, { intent: REPLY, failed: true }), { kind: 'discarded', why: 'model_unavailable' });
  const reply: EarlyIntent = REPLY;
  assert.deepEqual(refineEarly(reply, { intent: REPLY, failed: false }), { kind: 'none' });
  assert.deepEqual(refineEarly(reply, { intent: MODEL_WORK, failed: false }), { kind: 'discarded', why: 'disagreed' });
  // @ts-expect-error a model-decided work is not an early intent: its labels are not owed
  refineEarly(MODEL_WORK, { intent: MODEL_WORK, failed: false });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(input: {
  clef: Parameters<typeof fakeClefEnv>[0] | 'absent';
  clefDelayMs?: number;
  manage?: NonNullable<Parameters<typeof fakeClefEnv>[1]>['manage'];
  record?: GuaranteedInteractionJudgmentOptions['record'];
  meter?: GuaranteedInteractionJudgmentOptions['meter'];
}) {
  const timeline: string[] = [];
  const recorded: SlackInteractionIntent[] = [];
  const metered: SlackInteractionClassification[] = [];
  const model = deferred<SlackInteractionClassification>();
  let classifyCalls = 0;
  const fake = input.clef === 'absent'
    ? undefined
    : fakeClefEnv(input.clef, { delayMs: input.clefDelayMs ?? 0, ...(input.manage === undefined ? {} : { manage: input.manage }) });
  const options: GuaranteedInteractionJudgmentOptions = {
    env: fake?.env,
    record: input.record ?? (async (intent) => {
      timeline.push(`record:${intent.disposition}`);
      recorded.push(intent);
    }),
    meter: input.meter ?? (async (classification) => {
      timeline.push(`meter:${classification.intent.disposition}`);
      metered.push(classification);
    }),
    classify: () => {
      classifyCalls += 1;
      timeline.push('classify');
      return model.promise;
    },
  };
  const judgment = judgeGuaranteedInteraction(context, options);
  const basisSeen = judgment.basis.then(
    (intent) => { timeline.push(`basis:${intent.disposition}`); },
    () => { timeline.push('basis:rejected'); },
  );
  return {
    judgment, timeline, recorded, metered, model, basisSeen,
    clefCalls: () => fake?.calls.length ?? 0,
    managementCalls: () => fake?.managementCalls.length ?? 0,
    dispositionQuestions: () => fake?.calls[0]?.inputs.questions,
    classifyCalls: () => classifyCalls,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

// Defect caught: the dispatch proceeds on an unrecorded intent, or waits for
// the model it no longer needs.
test('a confident reply records and resolves the basis before the held model answers', async () => {
  const h = harness({ clef: 'reply' });
  const basis = await h.judgment.basis;
  assert.deepEqual(basis, REPLY);
  assert.deepEqual(h.recorded, [REPLY]);
  await h.basisSeen;
  assert.deepEqual(h.timeline, ['classify', 'record:reply', 'basis:reply']);
  assert.equal(h.classifyCalls(), 1, 'the model still runs for the agreement signal');
  assert.equal(h.clefCalls(), 1);

  // Defect caught: the model's late react_only flips the recorded disposition.
  h.model.resolve({ intent: MODEL_REACT, failed: false });
  const trace = await h.judgment.settled;
  assert.deepEqual(h.recorded, [REPLY], 'the record is written once');
  assert.equal(await h.judgment.lateChecklist, undefined);
  assert.equal(trace.recordedBy, 'clef');
  assert.equal(trace.basis, 'reply');
  assert.equal(trace.model, 'react_only');
  assert.equal(trace.refinement, 'disagreed');
  assert.equal(trace.agreed, false);
  assert.equal(trace.gate, 'dispatch');
  assert.equal(trace.clef, 'read');
  assert.equal(trace.clefChoice, 'reply');
  assert.equal(trace.clefTop, 0.81);
  assert.equal(trace.clefInputTokens, 878);
});

// Defect caught: late labels lost, or labels attached when the model disagreed or failed.
test('a confident work gets the model\'s labels late only when the model also says work', async () => {
  const agreeing = harness({ clef: 'work' });
  assert.deepEqual(await agreeing.judgment.basis, CLEF_WORK);
  agreeing.model.resolve({ intent: MODEL_WORK, failed: false });
  assert.deepEqual(await agreeing.judgment.lateChecklist, MODEL_WORK.checklist);
  const agreed = await agreeing.judgment.settled;
  assert.equal(agreed.refinement, 'labels');
  assert.equal(agreed.agreed, true);
  assert.deepEqual(agreeing.recorded, [CLEF_WORK], 'the record keeps its empty checklist');

  const disagreeing = harness({ clef: 'work' });
  await disagreeing.judgment.basis;
  disagreeing.model.resolve({ intent: REPLY, failed: false });
  assert.equal(await disagreeing.judgment.lateChecklist, undefined);
  assert.equal((await disagreeing.judgment.settled).refinement, 'disagreed');

  const failing = harness({ clef: 'work' });
  await failing.judgment.basis;
  failing.model.resolve({ intent: { disposition: 'reply', reason: 'classifier_fallback' }, failed: true });
  assert.equal(await failing.judgment.lateChecklist, undefined);
  const failed = await failing.judgment.settled;
  assert.equal(failed.refinement, 'model_unavailable');
  assert.equal(failed.modelFailed, true);
  assert.equal(failed.agreed, undefined);
});

// Defect caught: classifier usage lost or double-metered on the Clef path, or
// a usage failure failing a turn that was already delivered.
test('on a Clef basis the model is metered once after it settles, and a failing meter is contained', async () => {
  const h = harness({ clef: 'reply' });
  await h.judgment.basis;
  assert.deepEqual(h.metered, [], 'the meter waits for the model');
  let settledEarly = false;
  void h.judgment.settled.then(() => { settledEarly = true; });
  await tick();
  assert.equal(settledEarly, false, 'settled waits for the model and its meter');
  const classification = { intent: REPLY, failed: false };
  h.model.resolve(classification);
  await h.judgment.settled;
  assert.deepEqual(h.metered, [classification]);

  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(String(args[0])); };
  try {
    const rejecting = harness({ clef: 'reply', meter: async () => { throw new Error('usage store down'); } });
    assert.deepEqual(await rejecting.judgment.basis, REPLY);
    rejecting.model.resolve({ intent: REPLY, failed: false });
    const trace = await rejecting.judgment.settled;
    assert.equal(trace.recordedBy, 'clef');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.includes('usage store down'), false, 'the warning carries no error text');
  } finally {
    console.warn = warn;
  }
});

// Defect caught: Clef delays a turn the model already decided, or records over it.
test('a model that answers first decides, and Clef\'s later confident answer records nothing', async () => {
  const h = harness({ clef: 'reply', clefDelayMs: 60 });
  h.model.resolve({ intent: MODEL_WORK, failed: false });
  assert.deepEqual(await h.judgment.basis, MODEL_WORK);
  const trace = await h.judgment.settled;
  assert.deepEqual(h.recorded, [MODEL_WORK]);
  assert.deepEqual(h.metered.map((c) => c.intent.disposition), ['work']);
  assert.equal(trace.recordedBy, 'model');
  assert.equal(trace.gate, 'dispatch');
  assert.equal(trace.clefLate, true);
  assert.equal(trace.agreed, false);
  assert.equal(await h.judgment.lateChecklist, undefined);
});

// Defect caught: the fallback path differs from today's order (record and
// meter together, then the basis), or a Clef failure changes behavior.
for (const [name, clef] of [
  ['not confident', 'uncertain'],
  ['a confident react_only', 'react_only'],
  ['an erroring binding', 'error'],
  ['no binding', 'absent'],
] as const) {
  test(`Clef ${name}: the basis waits for the model, recorded and metered first`, async () => {
    const h = harness({ clef });
    await tick();
    assert.deepEqual(h.recorded, [], 'nothing is recorded before the model answers');
    h.model.resolve({ intent: MODEL_REACT, failed: false });
    assert.deepEqual(await h.judgment.basis, MODEL_REACT);
    await h.basisSeen;
    assert.deepEqual(h.timeline, ['classify', 'record:react_only', 'meter:react_only', 'basis:react_only']);
    const trace = await h.judgment.settled;
    assert.equal(trace.recordedBy, 'model');
    assert.equal(trace.gate, 'await_model');
    assert.equal(trace.clefLate, undefined);
    assert.equal(h.clefCalls(), clef === 'absent' ? 0 : 1);
    assert.equal(await h.judgment.lateChecklist, undefined);
  });
}

// Defect caught: a Clef that never answers holds the turn longer than the model.
test('a Clef that never settles leaves the model to decide at the model\'s time', async () => {
  const hanging = { AI: { run: () => new Promise<never>(() => undefined) } };
  const model = deferred<SlackInteractionClassification>();
  const recorded: string[] = [];
  const judgment = judgeGuaranteedInteraction(context, {
    env: hanging,
    record: async (intent) => { recorded.push(intent.disposition); },
    meter: async () => undefined,
    classify: () => model.promise,
  });
  model.resolve({ intent: REPLY, failed: false });
  assert.deepEqual(await judgment.basis, REPLY);
  assert.deepEqual(recorded, ['reply']);
});

// Defect caught: Clef or the model runs for a deterministic turn, or usage is
// recorded for one.
test('a shortcut records without asking Clef or the model', async () => {
  for (const [text, expected] of [
    ['<@UBOT> thanks!', { disposition: 'react_only', reason: 'pure_ack', reaction: 'appreciation', target: 'trigger' }],
    ['Please investigate the failing deploy logs.', { disposition: 'work', reason: 'substantive_request', checklist: ['Investigation result', 'Supporting evidence'] }],
  ] as const) {
    const fake = fakeClefEnv('reply');
    const recorded: SlackInteractionIntent[] = [];
    let classifyCalls = 0;
    let meterCalls = 0;
    const judgment = judgeGuaranteedInteraction({ ...context, text }, {
      env: fake.env,
      record: async (intent) => { recorded.push(intent); },
      meter: async () => { meterCalls += 1; },
      classify: async () => { classifyCalls += 1; return { intent: REPLY, failed: false }; },
    });
    assert.deepEqual(await judgment.basis, expected);
    assert.deepEqual(recorded, [expected]);
    assert.equal(await judgment.lateChecklist, undefined);
    const trace = await judgment.settled;
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.managementCalls.length, 0, 'nor the management question');
    assert.equal(await judgment.managementLikely, false);
    assert.equal(trace.management, undefined);
    assert.equal(classifyCalls, 0);
    assert.equal(meterCalls, 0);
    assert.equal(trace.recordedBy, 'shortcut');
    assert.equal(trace.clef, 'skipped');
    assert.equal(trace.basis, expected.disposition);
  }
});

// Defect caught: a record failure is swallowed (a dispatch without a record)
// or escapes as an unhandled rejection.
test('a rejecting record rejects the basis, settles the judgment, and leaks no rejection', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const failure = new Error('state store unavailable');
    const h = harness({ clef: 'reply', record: async () => { throw failure; } });
    await assert.rejects(h.judgment.basis, (error) => error === failure);
    h.model.resolve({ intent: REPLY, failed: false });
    const trace = await h.judgment.settled;
    assert.equal(trace.recordedBy, 'unrecorded');
    assert.equal(trace.basis, undefined);
    assert.equal(await h.judgment.lateChecklist, undefined);

    const onModelPath = harness({ clef: 'uncertain', record: async () => { throw failure; } });
    onModelPath.model.resolve({ intent: REPLY, failed: false });
    await assert.rejects(onModelPath.judgment.basis, (error) => error === failure);
    assert.equal((await onModelPath.judgment.settled).recordedBy, 'unrecorded');
    await tick();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// Defect caught: a judged turn logs no event, logs more than one, or logs
// message or profile text.
test('a judged turn emits exactly one content-free interaction_judgment event', async () => {
  const records: Array<Record<string, unknown>> = [];
  const info = console.info;
  console.info = (record: unknown) => {
    if (typeof record === 'object' && record !== null) records.push(record as Record<string, unknown>);
  };
  try {
    const h = harness({ clef: 'reply' });
    await h.judgment.basis;
    h.model.resolve({ intent: REPLY, failed: false });
    await h.judgment.settled;
    const events = records.filter((record) => record.event === 'interaction_judgment');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.recordedBy, 'clef');
    assert.equal(events[0]?.agreed, true);
    assert.equal(events[0]?.clefTop, 810);
    assert.equal(events[0]?.management, 'read');
    assert.equal(events[0]?.managementTop, 20);
    assert.equal(events[0]?.managementFired, false);
    const serialized = JSON.stringify(events[0]);
    for (const content of [MESSAGE, PROFILE, context.channelId, context.eventId]) {
      assert.equal(serialized.includes(content), false, `the event must not contain ${content}`);
    }
  } finally {
    console.info = info;
  }
});

// Defect caught: the trace leaks message or profile text, or lacks the fields
// production monitoring needs to confirm the gate holds.
test('the settled trace is content-free and carries the agreement signal', async () => {
  const h = harness({ clef: clefWire({ reply: 0.45, work: 0.2, react_only: 0.3, ignore: 0.05 }, { memory: 0.3, inputTokens: 905 }) });
  h.model.resolve({ intent: REPLY, failed: false });
  await h.judgment.basis;
  const trace = await h.judgment.settled;
  assert.deepEqual(
    Object.keys(trace).sort(),
    [
      'agreed', 'basis', 'basisMs', 'clef', 'clefChoice', 'clefInputTokens', 'clefMemory', 'clefMs', 'clefTextMass', 'clefTop', 'gate',
      'management', 'managementFired', 'managementInputTokens', 'managementMs', 'managementTop',
      'model', 'modelFailed', 'modelMs', 'recordedBy',
    ],
  );
  assert.equal(trace.management, 'read');
  assert.equal(trace.managementTop, 0.02);
  assert.equal(trace.managementFired, false);
  assert.equal(trace.managementInputTokens, 414);
  assert.equal(trace.recordedBy, 'model');
  assert.equal(trace.gate, 'await_model');
  assert.equal(trace.clefChoice, 'reply');
  assert.equal(trace.clefTop, 0.45);
  assert.equal(trace.clefTextMass, 0.65);
  assert.equal(trace.clefMemory, 0.3);
  assert.equal(trace.clefInputTokens, 905);
  assert.equal(trace.agreed, true);
  const serialized = JSON.stringify(trace);
  for (const content of [MESSAGE, PROFILE, 'release', 'Scout', context.channelId, context.workspaceId, context.eventId]) {
    assert.equal(serialized.includes(content), false, `the trace must not contain ${content}`);
  }
});

// Defect caught: the management question shares the disposition call (which
// moved its calibrated answers on the evaluation), or its answer leaks into
// the recorded disposition, the order of record and meter, or the gate.
test('both Clef calls run, and the management answer never changes the disposition', async () => {
  const outcome = async (clef: 'reply' | 'work' | 'uncertain' | 'react_only', manage: number | 'error') => {
    const h = harness({ clef, manage });
    await tick();
    h.model.resolve({ intent: clef === 'work' ? MODEL_WORK : clef === 'reply' ? REPLY : MODEL_REACT, failed: false });
    const basis = await h.judgment.basis;
    await h.basisSeen;
    const trace = await h.judgment.settled;
    assert.equal(h.clefCalls(), 1, 'one disposition call');
    assert.equal(h.managementCalls(), 1, 'one management call');
    assert.equal(Object.hasOwn(h.dispositionQuestions() as object, 'manage'), false,
      'the disposition call does not carry the management question');
    const disposition = Object.fromEntries(
      Object.entries(trace).filter(([key]) => !key.startsWith('management') && !key.endsWith('Ms')),
    );
    return {
      likely: await h.judgment.managementLikely,
      fired: trace.managementFired,
      top: trace.managementTop,
      decided: { basis, recorded: h.recorded, metered: h.metered.length, timeline: h.timeline, disposition },
    };
  };
  for (const clef of ['reply', 'work', 'uncertain', 'react_only'] as const) {
    const quiet = await outcome(clef, 0.01);
    const change = await outcome(clef, 0.97);
    const failed = await outcome(clef, 'error');
    assert.deepEqual(change.decided, quiet.decided, `${clef}: a firing management answer changes nothing else`);
    assert.deepEqual(failed.decided, quiet.decided, `${clef}: a failed management call changes nothing else`);
    assert.deepEqual([quiet.likely, quiet.fired, quiet.top], [false, false, 0.01]);
    assert.deepEqual([change.likely, change.fired, change.top], [true, true, 0.97]);
    assert.deepEqual([failed.likely, failed.fired, failed.top], [false, false, undefined]);
  }
});

// Defect caught: the threshold is off by one, or it reads the disposition's
// memory noul instead of the management call's.
test('the management signal fires at 0.5 and not at 0.499', async () => {
  for (const [manage, likely] of [[0.5, true], [0.499, false]] as const) {
    const h = harness({ clef: clefWire(CLEF_PROFILES.reply, { memory: 0.9 }), manage });
    h.model.resolve({ intent: REPLY, failed: false });
    assert.equal(await h.judgment.managementLikely, likely, String(manage));
    assert.equal((await h.judgment.settled).managementFired, likely);
  }
});

// Defect caught: a management call that never answers holds the turn's
// basis, or reads as a signal once Clef's bound passes.
test('a management call that never answers is no signal at Clef\'s bound, and the basis does not wait for it', async () => {
  const h = harness({ clef: 'reply', manage: 'hang' });
  assert.deepEqual(await h.judgment.basis, REPLY, 'the confident disposition dispatches as before');
  const started = Date.now();
  assert.equal(await h.judgment.managementLikely, false);
  assert.ok(Date.now() - started <= CLEF_TIMEOUT_MS + 250, 'no longer than Clef\'s bound');
  h.model.resolve({ intent: REPLY, failed: false });
  const trace = await h.judgment.settled;
  assert.equal(trace.management, 'timeout');
  assert.equal(trace.managementFired, false);
  assert.equal(trace.managementTop, undefined);
});

// Defect caught: the judgment asks Clef and the model again about the request
// its early calls already asked, doubling both on every turn; or its basisMs
// counts from the calls' start, which hides what starting them early saved.
test('calls started before the fold are adopted for the same context: nothing is asked twice, and basisMs counts from the judgment', async () => {
  const fake = fakeClefEnv('reply', { delayMs: 40 });
  const model = deferred<SlackInteractionClassification>();
  let classifyCalls = 0;
  const classify = () => {
    classifyCalls += 1;
    return model.promise;
  };
  const early = startJudgmentCalls(context, { env: fake.env, classify });
  assert.ok(early, 'a request with no shortcut starts its calls');
  await new Promise((resolve) => setTimeout(resolve, 80));
  const recorded: SlackInteractionIntent[] = [];
  const metered: SlackInteractionClassification[] = [];
  const judgment = judgeGuaranteedInteraction({ ...context }, {
    env: fake.env,
    record: async (intent) => { recorded.push(intent); },
    meter: async (classification) => { metered.push(classification); },
    classify,
    early,
  });
  assert.deepEqual(await judgment.basis, REPLY);
  model.resolve({ intent: REPLY, failed: false });
  const trace = await judgment.settled;
  assert.equal(fake.calls.length, 1, 'one interaction call');
  assert.equal(fake.managementCalls.length, 1, 'one management call');
  assert.equal(classifyCalls, 1, 'one classifier call');
  assert.deepEqual(recorded, [REPLY]);
  assert.equal(metered.length, 1, 'the adopted classification is metered once');
  assert.equal(trace.recordedBy, 'clef');
  assert.equal(trace.rejudged, undefined);
  assert.ok(trace.earlyMs !== undefined && trace.earlyMs >= 80, `earlyMs ${trace.earlyMs}`);
  assert.ok(trace.basisMs !== undefined && trace.clefMs !== undefined && trace.basisMs < trace.clefMs,
    `basisMs ${trace.basisMs} counts from the judgment; Clef took ${trace.clefMs} ms`);
});

// Defect caught: a fold that added follow-ups is judged on the head's text
// alone, or the head's answer is recorded or metered as the turn's.
test('a fold that changed the text drops the early calls and asks again about the folded text', async () => {
  const fake = fakeClefEnv('uncertain');
  const headModel = deferred<SlackInteractionClassification>();
  const foldedModel = deferred<SlackInteractionClassification>();
  const asked: string[] = [];
  const early = startJudgmentCalls(context, {
    env: fake.env,
    classify: (input) => {
      asked.push(input.text);
      return headModel.promise;
    },
  });
  const folded = { ...context, text: `${MESSAGE}\n\nAlso, which of them changed the API?` };
  const recorded: SlackInteractionIntent[] = [];
  const metered: SlackInteractionClassification[] = [];
  const judgment = judgeGuaranteedInteraction(folded, {
    env: fake.env,
    record: async (intent) => { recorded.push(intent); },
    meter: async (classification) => { metered.push(classification); },
    classify: (input) => {
      asked.push(input.text);
      return foldedModel.promise;
    },
    ...(early ? { early } : {}),
  });
  headModel.resolve({ intent: MODEL_WORK, failed: false });
  await tick();
  const folding = { intent: REPLY, failed: false };
  foldedModel.resolve(folding);
  assert.deepEqual(await judgment.basis, REPLY, 'the folded request decides, not the head alone');
  const trace = await judgment.settled;
  assert.deepEqual(asked, [MESSAGE, folded.text]);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.managementCalls.length, 2);
  assert.ok(JSON.stringify(fake.calls[1]!.inputs).includes('changed the API'), 'Clef is asked about the folded text');
  assert.deepEqual(recorded, [REPLY]);
  assert.deepEqual(metered, [folding], 'only the classification the turn acted on is metered');
  assert.equal(trace.rejudged, true);
  assert.equal(trace.earlyMs, undefined);
});

// Defect caught: a turn a shortcut decides spends Clef and classifier calls
// before its fold.
test('no calls start for a request a shortcut decides', () => {
  const fake = fakeClefEnv('reply');
  let classifyCalls = 0;
  const early = startJudgmentCalls({ ...context, text: '<@UBOT> thanks!' }, {
    env: fake.env,
    classify: async () => {
      classifyCalls += 1;
      return { intent: REPLY, failed: false };
    },
  });
  assert.equal(early, undefined);
  assert.equal(fake.calls.length + fake.managementCalls.length + classifyCalls, 0);
});
