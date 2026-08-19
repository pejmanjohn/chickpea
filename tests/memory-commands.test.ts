import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseMemoryCommand } from '../src/memory/commands.ts';

test('canonical memory commands parse after a Slack mention', () => {
  assert.deepEqual(parseMemoryCommand('<@UBOT> !memory', 'UBOT'), { kind: 'list' });
  assert.deepEqual(parseMemoryCommand('<@UBOT> !memory'), { kind: 'candidate' });
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
  assert.deepEqual(parseMemoryCommand('!memory confirm write-token_123'), {
    kind: 'owner_write_confirm', token: 'write-token_123',
  });
  assert.deepEqual(parseMemoryCommand('!memory report C123/release-checklist unsafe'), {
    kind: 'report', target: 'c123/release-checklist', reason: 'unsafe',
  });
});

test('natural-language save requests defer to semantic Agent assessment', () => {
  assert.equal(parseMemoryCommand('remember for this channel: Tone — Be concise'), undefined);
  assert.equal(parseMemoryCommand('Please remember that release updates should be concise.'), undefined);
  assert.equal(parseMemoryCommand('Can you remember that staging deploys require smoke tests?'), undefined);
  assert.equal(parseMemoryCommand("Don't forget this: memory acceptance color is cobalt."), undefined);
  assert.equal(parseMemoryCommand('dont forget that staging deploys require smoke tests'), undefined);
  assert.equal(parseMemoryCommand('Keep this preference around for the next time we talk.'), undefined);
  assert.equal(parseMemoryCommand('Make a note for later: production releases need my approval.'), undefined);
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
  assert.deepEqual(
    parseMemoryCommand(
      '<@UBOT> Update the memory tone so future answers use two bullets.',
      'UBOT',
    ),
    {
      kind: 'update',
      target: 'tone',
      description: 'future answers use two bullets.',
      body: 'future answers use two bullets.',
    },
  );
});

test('ordinary or ambiguous prose never mutates memory', () => {
  assert.equal(parseMemoryCommand('I remember that the release was delayed.'), undefined);
  assert.equal(parseMemoryCommand('Remember that the release was delayed?'), undefined);
  assert.equal(
    parseMemoryCommand('<@U_TEAMMATE> Remember that the release was delayed?', 'UBOT'),
    undefined,
  );
  assert.deepEqual(
    parseMemoryCommand('<@UBOT> !remember Open question — Is the release delayed?', 'UBOT'),
    {
      kind: 'remember',
      name: 'Open question',
      description: 'Is the release delayed?',
      body: 'Is the release delayed?',
    },
  );
  assert.equal(parseMemoryCommand('Keep this in mind for the current answer.'), undefined);
  assert.equal(parseMemoryCommand("Don't forget this"), undefined);
  assert.equal(parseMemoryCommand('Do not forget that'), undefined);
  assert.equal(parseMemoryCommand('Can you update the memory?'), undefined);
  assert.equal(parseMemoryCommand('!memory merge only-one')?.kind, 'invalid');
});
