import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ANSWER_RELEASE_CHARS_VARIABLE,
  ANSWER_RELEASE_VARIABLE,
  answerReleaseSetting,
  parseAnswerReleaseChars,
} from '../src/slack/answer-release-setting.ts';

// Defects caught: host release on by default or for a value other than `host`,
// the hold not configurable, or an unreadable hold guessed instead of turning it off.
test('host answer release is off unless the deployment sets it, with a hold of 400 by default', () => {
  assert.equal(answerReleaseSetting(undefined), undefined);
  assert.equal(answerReleaseSetting({}), undefined);
  for (const value of ['', 'on', 'true', 'model', '1']) {
    assert.equal(answerReleaseSetting({ [ANSWER_RELEASE_VARIABLE]: value }), undefined, value);
  }
  assert.deepEqual(answerReleaseSetting({ [ANSWER_RELEASE_VARIABLE]: 'host' }), { holdChars: 400 });
  assert.deepEqual(answerReleaseSetting({ [ANSWER_RELEASE_VARIABLE]: ' Host ' }), { holdChars: 400 });
  assert.deepEqual(
    answerReleaseSetting({ [ANSWER_RELEASE_VARIABLE]: 'host', [ANSWER_RELEASE_CHARS_VARIABLE]: '650' }),
    { holdChars: 650 },
  );
  assert.equal(
    answerReleaseSetting({ [ANSWER_RELEASE_VARIABLE]: 'host', [ANSWER_RELEASE_CHARS_VARIABLE]: '40O' }),
    undefined,
    'a hold the deploy refuses turns host release off',
  );
});

test('the hold parser takes whole numbers from 100 to 4000 and refuses the rest', () => {
  assert.equal(parseAnswerReleaseChars(undefined), 400);
  assert.equal(parseAnswerReleaseChars(''), 400);
  assert.equal(parseAnswerReleaseChars('100'), 100);
  assert.equal(parseAnswerReleaseChars(4_000), 4_000);
  for (const value of ['0', '99', '4001', '400.5', '-400', '4e2', 'four hundred', ' 400']) {
    assert.throws(() => parseAnswerReleaseChars(value), new RegExp(ANSWER_RELEASE_CHARS_VARIABLE), value);
  }
});
