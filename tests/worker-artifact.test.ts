import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error The deploy helper is a plain JavaScript CLI module.
import { hasScheduledComposition } from '../scripts/worker-artifact.mjs';

test('scheduled composition survives minification and renamed handlers', () => {
  assert.equal(hasScheduledComposition('var c=x({heartbeat:a,maintenance:b});async function a(){await s.heartbeat()}async function b(){await s.maintainWork()}'), true);
  assert.equal(hasScheduledComposition('x({heartbeat:a,maintenance:b});async function a(){return c()}async function c(){await s.heartbeat()}async function b(){return d()}async function d(){await s.maintainWork()}'), true);
});

test('scheduled composition rejects missing, swapped, inert, unresolved, or unrelated handlers and string decoys', () => {
  for (const source of [
    'x({heartbeat:a}); async function a(){await s.heartbeat()}',
    'x({heartbeat:b,maintenance:a}); async function a(){await s.heartbeat()} async function b(){await s.maintainWork()}',
    'x({heartbeat:a,maintenance:b}); function a(){} function b(){}',
    'x({heartbeat:a,maintenance:b}); function a(){return missing()} function b(){return s.maintainWork()}',
    'x({heartbeat:a,maintenance:b}); function a(){} function b(){return s.maintainWork()} function unrelated(){return s.heartbeat()}',
    '"heartbeat: runRoutineHeartbeat maintenance: runWorkMaintenance"',
    'x({heartbeat:false,maintenance:false})',
  ]) assert.equal(hasScheduledComposition(source), false, source);
});

test('scheduled composition rejects cyclic local delegation without overflowing', () => {
  const source = 'x({heartbeat:a,maintenance:b});function a(){return c()}function c(){return a()}function b(){return d()}function d(){return b()}';
  assert.equal(hasScheduledComposition(source), false);
});
