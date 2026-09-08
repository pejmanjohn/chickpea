import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RepositoryGrant } from '../src/config/types.ts';
import {
  resolveSandboxSelection,
  sandboxBindingInstalled,
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
      installed: true,
      enabled: true,
      appConnected: true,
      repositoryGrants: [grant()],
    }),
    'cloudflare',
  );

  for (const input of [
    {
      target: 'cloudflare' as const,
      installed: false,
      enabled: true,
      appConnected: true,
      repositoryGrants: [grant()],
    },
    {
      target: 'cloudflare' as const,
      installed: true,
      enabled: false,
      appConnected: true,
      repositoryGrants: [grant()],
    },
    {
      target: 'cloudflare' as const,
      installed: true,
      enabled: true,
      appConnected: true,
      repositoryGrants: [],
    },
    {
      target: 'cloudflare' as const,
      installed: true,
      enabled: true,
      appConnected: true,
      repositoryGrants: [grant({ enabled: false })],
    },
    {
      target: 'cloudflare' as const,
      installed: true,
      enabled: true,
      appConnected: true,
      repositoryGrants: [grant({ fullName: '../broader-scope' })],
    },
    {
      target: 'cloudflare' as const,
      installed: true,
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
          installed: true,
          enabled,
          appConnected,
          repositoryGrants: [grant()],
        }),
        'bash',
      );
    }
  }
});

test('live binding availability accepts only the supported Cloudflare binding aliases', () => {
  assert.equal(sandboxBindingInstalled(undefined), false);
  assert.equal(sandboxBindingInstalled({}), false);
  assert.equal(sandboxBindingInstalled({ SANDBOX: {} }), true);
  assert.equal(sandboxBindingInstalled({ Sandbox: {} }), true);
  assert.equal(sandboxBindingInstalled({ SANDBOX: undefined, Sandbox: undefined }), false);
});

test('selection identifies only a missing live binding as an unavailable fallback', () => {
  assert.deepEqual(
    resolveSandboxSelection({
      target: 'cloudflare',
      installed: false,
      enabled: true,
      appConnected: true,
      repositoryGrants: [grant()],
    }),
    { selection: 'bash', unavailableFallback: true },
  );
  assert.deepEqual(
    resolveSandboxSelection({
      target: 'cloudflare',
      installed: true,
      enabled: false,
      appConnected: true,
      repositoryGrants: [grant()],
    }),
    { selection: 'bash', unavailableFallback: false },
  );
  assert.deepEqual(
    resolveSandboxSelection({
      target: 'node',
      installed: false,
      enabled: true,
      appConnected: true,
      repositoryGrants: [grant()],
    }),
    { selection: 'bash', unavailableFallback: false },
  );
});
