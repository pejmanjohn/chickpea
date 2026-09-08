import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error The deploy helper is a plain JavaScript CLI module.
import { hasScheduledComposition } from '../scripts/worker-artifact.mjs';

test('scheduled composition survives minification and renamed handlers', () => {
  assert.equal(hasScheduledComposition('var c=x({heartbeat:a,maintenance:b});async function a(){await s.heartbeat()}async function b(){await s.maintainWork()}'), true);
});

test('scheduled composition rejects missing, swapped, or inert handlers and string decoys', () => {
  for (const source of [
    'x({heartbeat:a}); async function a(){await s.heartbeat()}',
    'x({heartbeat:b,maintenance:a}); async function a(){await s.heartbeat()} async function b(){await s.maintainWork()}',
    'x({heartbeat:a,maintenance:b}); function a(){} function b(){}',
    '"heartbeat: runRoutineHeartbeat maintenance: runWorkMaintenance"',
    'x({heartbeat:false,maintenance:false})',
  ]) assert.equal(hasScheduledComposition(source), false, source);
});
