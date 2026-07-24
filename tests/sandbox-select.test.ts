import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RepositoryGrant } from '../src/config/types.ts';
import {
  applySandboxSessionCap,
  selectSandbox,
} from '../src/sandbox/select.ts';

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
      repositoryGrants: [grant()],
    }),
    'cloudflare',
  );

  for (const input of [
    {
      target: 'cloudflare' as const,
      enabled: false,
      localEnabled: false,
      repositoryGrants: [grant()],
    },
    {
      target: 'cloudflare' as const,
      enabled: true,
      localEnabled: false,
      repositoryGrants: [],
    },
    {
      target: 'cloudflare' as const,
      enabled: true,
      localEnabled: false,
      repositoryGrants: [grant({ enabled: false })],
    },
    {
      target: 'cloudflare' as const,
      enabled: true,
      localEnabled: false,
      repositoryGrants: [grant({ fullName: '../broader-scope' })],
    },
  ]) {
    assert.equal(selectSandbox(input), 'bash');
  }
});

test('Node selects local only behind both install-level opt-ins', () => {
  assert.equal(
    selectSandbox({
      target: 'node',
      enabled: true,
      localEnabled: true,
      repositoryGrants: [],
    }),
    'local',
  );
  assert.equal(
    selectSandbox({
      target: 'node',
      enabled: true,
      localEnabled: false,
      repositoryGrants: [grant()],
    }),
    'bash',
  );
  assert.equal(
    selectSandbox({
      target: 'node',
      enabled: false,
      localEnabled: true,
      repositoryGrants: [grant()],
    }),
    'bash',
  );
});

test('a reached monthly cap declines before the Cloudflare sandbox is selected', () => {
  assert.equal(applySandboxSessionCap('cloudflare', false), 'bash');
  assert.equal(applySandboxSessionCap('cloudflare', true), 'cloudflare');
  assert.equal(applySandboxSessionCap('cloudflare', undefined), 'cloudflare');
  assert.equal(applySandboxSessionCap('local', false), 'local');
});
