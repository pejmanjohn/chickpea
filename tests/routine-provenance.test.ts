import assert from 'node:assert/strict';
import test from 'node:test';

import { assertRoutineTaskBoundToSource, preserveRoutineOutputInstruction, requestsChannelThreadDelivery } from '../src/routines/provenance.ts';
import { RoutineStateError } from '../src/routines/types.ts';

test('Channel thread delivery requires positive unquoted delivery intent, not acknowledgement location', () => {
  for (const request of [
    'Every morning post the digest in this thread.',
    "Deliver the result to this request's thread.",
  ]) assert.equal(requestsChannelThreadDelivery(request), true, request);
  for (const request of [
    'Post the digest in this channel.',
    'Do not post the digest in this thread.',
    'Deliver each result as a new message in this channel, not in this thread.',
    'Deliver the result to the channel, not to this thread.',
    'Post exactly "in this thread" every morning.',
    'Explain how to post in this thread.',
    'Post in this thread?',
    '> Post the digest in this thread.',
    'Post the digest in the channel. Acknowledge creation in this thread.',
  ]) assert.equal(requestsChannelThreadDelivery(request), false, request);
});

test('quoted exact replies retain their governing instruction without inventing a task', () => {
  for (const [request, expected] of [
    ['At that time reply exactly "Ready for review". Acknowledge the due time now.', 'reply exactly "Ready for review"'],
    ['Its task is to output exactly “The report is ready” without connectors.', 'output exactly “The report is ready”'],
  ]) {
    const payload = expected!.replace(/^.*?["“]/, '').slice(0, -1);
    assert.equal(preserveRoutineOutputInstruction(payload, request!), expected);
    assert.equal(preserveRoutineOutputInstruction(expected!, request!), expected);
  }
  assert.equal(preserveRoutineOutputInstruction('Summarize the report', 'Summarize the report daily.'), 'Summarize the report');
  assert.throws(() => preserveRoutineOutputInstruction('Ready', 'Do not reply exactly "Ready".'), RoutineStateError);
});

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
