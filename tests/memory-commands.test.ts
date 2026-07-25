import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMemoryCommand } from '../src/memory/commands.ts';

test('canonical memory commands parse after a Slack mention', () => {
  assert.deepEqual(parseMemoryCommand('<@U_BOT> !memory'), { kind: 'list' });
  assert.deepEqual(parseMemoryCommand('!memory show release-checklist'), {
    kind: 'show', target: 'release-checklist',
  });
  assert.deepEqual(parseMemoryCommand('!remember Release checklist — How releases work\nRun tests.'), {
    kind: 'remember',
    name: 'Release checklist',
    description: 'How releases work',
    body: 'Run tests.',
  });
  assert.deepEqual(parseMemoryCommand('!memory update release-checklist — Updated\nRun all tests.'), {
    kind: 'update', target: 'release-checklist', description: 'Updated', body: 'Run all tests.',
  });
  assert.deepEqual(
    parseMemoryCommand('!memory merge one two as combined — Combined guidance\nUse both.'),
    {
      kind: 'merge', targets: ['one', 'two'], name: 'combined',
      description: 'Combined guidance', body: 'Use both.',
    },
  );
  assert.deepEqual(parseMemoryCommand('!forget public/release-checklist'), {
    kind: 'forget_request', target: 'public/release-checklist',
  });
  assert.deepEqual(parseMemoryCommand('!forget confirm token-123'), {
    kind: 'forget_confirm', token: 'token-123',
  });
  assert.deepEqual(parseMemoryCommand('!memory report C123/release-checklist unsafe'), {
    kind: 'report', target: 'c123/release-checklist', reason: 'unsafe',
  });
});

test('narrow natural-language aliases parse but ordinary or ambiguous prose does not mutate', () => {
  assert.deepEqual(parseMemoryCommand('remember for this channel: Tone — Be concise'), {
    kind: 'remember', name: 'Tone', description: 'Be concise', body: 'Be concise',
  });
  assert.deepEqual(parseMemoryCommand('update memory `tone`: Prefer short answers'), {
    kind: 'update', target: 'tone', description: 'Prefer short answers', body: 'Prefer short answers',
  });
  assert.equal(parseMemoryCommand('Please remember that I like this'), undefined);
  assert.equal(parseMemoryCommand('Can you update the memory?'), undefined);
  assert.equal(parseMemoryCommand('!memory merge only-one')?.kind, 'invalid');
});
