import assert from 'node:assert/strict';
import { test } from 'node:test';

import { githubAuthorizationHeader } from '../src/sandbox/github-auth.ts';

test('GitHub Smart HTTP uses x-access-token basic auth while REST keeps bearer auth', () => {
  const token = 'installation-token';

  assert.equal(
    githubAuthorizationHeader(
      'https://github.com/Acme/Alpha.git/info/refs?service=git-upload-pack',
      token,
    ),
    `Basic ${btoa(`x-access-token:${token}`)}`,
  );
  assert.equal(
    githubAuthorizationHeader('https://api.github.com/repos/Acme/Alpha', token),
    `Bearer ${token}`,
  );
});

test('GitHub credential headers fail closed for any other host', () => {
  assert.throws(
    () => githubAuthorizationHeader('https://example.com/Acme/Alpha.git', 'secret'),
    /Unsupported GitHub credential host/,
  );
});
