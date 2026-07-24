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
      localEnabled: false,
      appConnected: true,
      repositoryGrants: [grant()],
    }),
    'cloudflare',
  );

  for (const input of [
    {
      target: 'cloudflare' as const,
      enabled: false,
      localEnabled: false,
      appConnected: true,
      repositoryGrants: [grant()],
    },
    {
      target: 'cloudflare' as const,
      enabled: true,
      localEnabled: false,
      appConnected: true,
      repositoryGrants: [],
    },
    {
      target: 'cloudflare' as const,
      enabled: true,
      localEnabled: false,
      appConnected: true,
      repositoryGrants: [grant({ enabled: false })],
    },
    {
      target: 'cloudflare' as const,
      enabled: true,
      localEnabled: false,
      appConnected: true,
      repositoryGrants: [grant({ fullName: '../broader-scope' })],
    },
    {
      target: 'cloudflare' as const,
      enabled: true,
      localEnabled: false,
      appConnected: false,
      repositoryGrants: [grant()],
    },
  ]) {
    assert.equal(selectSandbox(input), 'bash');
  }
});

test('Node selects local only with both opt-ins, an App connection, and a valid grant', () => {
  assert.equal(
    selectSandbox({
      target: 'node',
      enabled: true,
      localEnabled: true,
      appConnected: false,
      repositoryGrants: [],
    }),
    'bash',
  );
  assert.equal(
    selectSandbox({
      target: 'node',
      enabled: true,
      localEnabled: true,
      appConnected: true,
      repositoryGrants: [],
    }),
    'bash',
  );
  assert.equal(
    selectSandbox({
      target: 'node',
      enabled: true,
      localEnabled: true,
      appConnected: true,
      repositoryGrants: [grant()],
    }),
    'local',
  );
  assert.equal(
    selectSandbox({
      target: 'node',
      enabled: true,
      localEnabled: false,
      appConnected: true,
      repositoryGrants: [grant()],
    }),
    'bash',
  );
  assert.equal(
    selectSandbox({
      target: 'node',
      enabled: false,
      localEnabled: true,
      appConnected: true,
      repositoryGrants: [grant()],
    }),
    'bash',
  );
});
