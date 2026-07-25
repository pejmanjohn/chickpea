import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pullRequestProgressFromGithubResponse } from '../src/sandbox/progress.ts';

test('successful GitHub PR creation becomes a durable progress marker', () => {
  assert.deepEqual(
    pullRequestProgressFromGithubResponse({
      requestUrl: 'https://api.github.com/repos/Acme/Alpha/pulls',
      requestMethod: 'POST',
      responseStatus: 201,
      responseBody: {
        number: 42,
        html_url: 'https://github.com/Acme/Alpha/pull/42',
        head: { ref: 'chickpea/fix-42' },
      },
    }),
    {
      number: 42,
      url: 'https://github.com/Acme/Alpha/pull/42',
      repository: 'Acme/Alpha',
      branch: 'chickpea/fix-42',
    },
  );
});

test('non-create requests and unsuccessful responses do not record PR progress', () => {
  for (const input of [
    {
      requestUrl: 'https://api.github.com/repos/Acme/Alpha/pulls',
      requestMethod: 'GET',
      responseStatus: 200,
      responseBody: { number: 42 },
    },
    {
      requestUrl: 'https://api.github.com/repos/Acme/Alpha/pulls',
      requestMethod: 'POST',
      responseStatus: 422,
      responseBody: { number: 42 },
    },
    {
      requestUrl: 'https://api.github.com/repos/Acme/Alpha/issues',
      requestMethod: 'POST',
      responseStatus: 201,
      responseBody: { number: 42 },
    },
  ]) {
    assert.equal(pullRequestProgressFromGithubResponse(input), undefined);
  }
});
