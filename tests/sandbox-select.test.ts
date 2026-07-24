import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RepositoryGrant } from '../src/config/types.ts';
import { selectSandbox } from '../src/sandbox/select.ts';

function grant(overrides: Partial<RepositoryGrant> = {}): RepositoryGrant {
  return {
    id: 'repo-alpha',
    installationId: 50_001,
    accountLogin: 'Acme',
    fullName: 'Acme/Alpha',
    enabled: true,
    ...overrides,
  };
}

test('Cloudflare selects its Flue sandbox only when the tier and a valid grant are enabled', () => {
  assert.equal(
    selectSandbox({
      target: 'cloudflare',
      enabled: true,
      appConnected: true,
      repositoryGrants: [grant()],
    }),
    'cloudflare',
  );

  for (const input of [
    {
      target: 'cloudflare' as const,
      enabled: false,
      appConnected: true,
      repositoryGrants: [grant()],
    },
    {
      target: 'cloudflare' as const,
      enabled: true,
      appConnected: true,
      repositoryGrants: [],
    },
    {
      target: 'cloudflare' as const,
      enabled: true,
      appConnected: true,
      repositoryGrants: [grant({ enabled: false })],
    },
    {
      target: 'cloudflare' as const,
      enabled: true,
      appConnected: true,
      repositoryGrants: [grant({ fullName: '../broader-scope' })],
    },
    {
      target: 'cloudflare' as const,
      enabled: true,
      appConnected: false,
      repositoryGrants: [grant()],
    },
  ]) {
    assert.equal(selectSandbox(input), 'bash');
  }
});

test('Node always selects the in-memory bash sandbox', () => {
  for (const enabled of [false, true]) {
    for (const appConnected of [false, true]) {
      assert.equal(
        selectSandbox({
          target: 'node',
          enabled,
          appConnected,
          repositoryGrants: [grant()],
        }),
        'bash',
      );
    }
  }
});
