import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRoutineTaskBoundToSource } from '../src/routines/provenance.ts';
import { RoutineStateError } from '../src/routines/types.ts';

test('routine source authority rejects avoid, refrain-from, and without directives', () => {
  const task = 'Check the inbox and report anything new.';
  for (const request of [
    `Avoid ${task}`,
    `Please refrain from ${task}`,
    `Without ${task}`,
  ]) {
    assert.throws(
      () => assertRoutineTaskBoundToSource(task, request),
      (error: unknown) => error instanceof RoutineStateError &&
        error.code === 'routine_source_authority_mismatch',
      request,
    );
  }
});
