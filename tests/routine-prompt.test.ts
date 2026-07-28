import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashRoutineValue } from '../src/routines/ids.ts';
import {
  normalizeRoutineModelResult,
  routineExecutionInstructions,
} from '../src/routines/prompt.ts';
import { RoutineRuntimeError } from '../src/routines/runtime.ts';
import type { RoutineDefinition, RoutineRun } from '../src/routines/types.ts';

const routine = { outputPolicy: 'post_on_change' } as RoutineDefinition;
const run = { baselineChangeKeyHash: hashRoutineValue('same') } as RoutineRun;

test('the unattended prompt makes host-owned Slack delivery explicit', () => {
  const instructions = routineExecutionInstructions().join('\n');
  assert.match(instructions, /Chickpea itself delivers your returned message/i);
  assert.match(instructions, /do not use tools, sandbox commands, network calls, credentials, tokens, or Chickpea internals/i);
  assert.match(instructions, /do not duplicate host delivery/i);
  assert.match(instructions, /additional Slack side effect distinct from posting this routine result/i);
});

test('post-on-change hashes raw keys and suppresses an unchanged result', () => {
  assert.deepEqual(
    normalizeRoutineModelResult(
      { outcome: 'succeeded', message: 'No visible change.', changeKey: 'same' },
      run,
      routine,
    ),
    {
      status: 'no_op', message: '', changeKeyHash: hashRoutineValue('same'), suppressedAsNoOp: true,
    },
  );
  const changed = normalizeRoutineModelResult(
    { outcome: 'succeeded', message: 'Project moved.', changeKey: 'new-state' },
    run,
    routine,
  );
  assert.equal(changed.status, 'succeeded');
  assert.equal(changed.message, 'Project moved.');
  assert.equal(changed.changeKeyHash, hashRoutineValue('new-state'));
});

test('no-op is first-class and invalid/oversized output fails closed', () => {
  assert.equal(
    normalizeRoutineModelResult({ outcome: 'no_op', message: '' }, run, routine).status,
    'no_op',
  );
  for (const result of [
    { outcome: 'succeeded' as const, message: '' },
    { outcome: 'succeeded' as const, message: 'Changed without a key.' },
    { outcome: 'succeeded' as const, message: 'x'.repeat(4_001), changeKey: 'changed' },
  ]) {
    assert.throws(
      () => normalizeRoutineModelResult(result, run, routine),
      (error: unknown) => error instanceof RoutineRuntimeError && error.failureClass === 'result_invalid',
    );
  }
});
