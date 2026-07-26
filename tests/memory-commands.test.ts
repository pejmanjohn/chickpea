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

test('explicit conversational memory intent parses without rigid command syntax', () => {
  assert.deepEqual(parseMemoryCommand('remember for this channel: Tone — Be concise'), {
    kind: 'remember', name: 'Tone', description: 'Be concise', body: 'Be concise',
  });
  assert.deepEqual(parseMemoryCommand('Please remember that release updates should be concise.'), {
    kind: 'remember',
    name: 'release updates should be concise',
    description: 'release updates should be concise.',
    body: 'release updates should be concise.',
  });
  assert.deepEqual(parseMemoryCommand('Can you remember that staging deploys require smoke tests?'), {
    kind: 'remember',
    name: 'staging deploys require smoke tests',
    description: 'staging deploys require smoke tests',
    body: 'staging deploys require smoke tests',
  });
  assert.deepEqual(parseMemoryCommand('update memory `tone`: Prefer short answers'), {
    kind: 'update', target: 'tone', description: 'Prefer short answers', body: 'Prefer short answers',
  });
  assert.deepEqual(
    parseMemoryCommand('Please update the memory `tone` to say that answers should use three bullets.'),
    {
      kind: 'update',
      target: 'tone',
      description: 'answers should use three bullets.',
      body: 'answers should use three bullets.',
    },
  );
});

test('ordinary or ambiguous prose never mutates memory', () => {
  assert.equal(parseMemoryCommand('I remember that the release was delayed.'), undefined);
  assert.equal(parseMemoryCommand('Keep this in mind for the current answer.'), undefined);
  assert.equal(parseMemoryCommand('Can you update the memory?'), undefined);
  assert.equal(parseMemoryCommand('!memory merge only-one')?.kind, 'invalid');
});
