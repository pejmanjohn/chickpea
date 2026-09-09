import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRoutineRequestProvenanceInput, assertRoutineTaskBoundToPrevious } from '../src/routines/provenance.ts';

test('request provenance retains authenticated text without interpreting its language', () => {
  const value = { sourceKind: 'slack_request' as const, authoritySource: 'current_request' as const, requestText: 'give me an update on TOEFL bookings in 5 minutes', eventId: 'Ev_source', messageTs: '1788988012.030979', threadTs: '1788987692.474889' };
  assert.equal(validateRoutineRequestProvenanceInput(value).requestText, value.requestText);
  assert.throws(() => validateRoutineRequestProvenanceInput({ ...value, messageTs: 'invalid' }), /provenance/i);
  assert.throws(() => validateRoutineRequestProvenanceInput({ ...value, sourceRoutineId: 'routine_source' }), /provenance/i);
});
test('a revision claiming to reuse a prior task must match that stored task', () => {
  assert.doesNotThrow(() => assertRoutineTaskBoundToPrevious('Report bookings.', 'Report bookings.', 'change the time'));
  assert.throws(() => assertRoutineTaskBoundToPrevious('Different task.', 'Report bookings.', 'change the time'), /prior task/);
});
