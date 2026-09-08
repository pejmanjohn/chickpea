import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { TurnPullRequestProgress } from '../src/config/state-rpc.ts';
import type { RepositoryGrant } from '../src/config/types.ts';
import {
  SandboxPolicyState,
  sandboxEgressGrantsForMode,
  type SandboxPolicyStorage,
} from '../src/sandbox/cloudflare-policy.ts';
import { decideSandboxEgress } from '../src/sandbox/egress-handler.ts';

class MemoryPolicyStorage implements SandboxPolicyStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }
}

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

const PULL_REQUEST: TurnPullRequestProgress = {
  number: 42,
  url: 'https://github.com/Acme/Alpha/pull/42',
  repository: 'Acme/Alpha',
  branch: 'chickpea/fix-42',
};

test('stored App policy preserves installation-wide grants for egress decisions', async () => {
  const state = new SandboxPolicyState(new MemoryPolicyStorage());
  await state.configureEgress(
    {
      mode: 'app',
      grants: [
        grant(),
        grant({
          id: 'all-acme',
          fullName: '',
          allRepos: true,
        }),
      ],
    },
    'turn-app-wide',
  );

  const policy = await state.getEgressPolicy();
  const appGrants = sandboxEgressGrantsForMode(policy, 'app');
  assert.ok(appGrants);
  assert.equal(appGrants.length, 2);
  assert.equal(
    decideSandboxEgress({
      url: 'https://api.github.com/repos/Acme/Beta/pulls',
      method: 'POST',
      grants: appGrants,
      allowedHosts: [],
    }).allowed,
    true,
  );
  assert.equal(
    decideSandboxEgress({
      url: 'https://api.github.com/repos/Other/Beta/pulls',
      method: 'POST',
      grants: appGrants,
      allowedHosts: [],
    }).allowed,
    false,
  );
});

test('stored egress policy denies a disconnected live credential mode', async () => {
  const state = new SandboxPolicyState(new MemoryPolicyStorage());
  await state.configureEgress(
    { mode: 'app', grants: [grant()] },
    'turn-app',
  );

  const policy = await state.getEgressPolicy();
  assert.equal(sandboxEgressGrantsForMode(policy, 'none'), undefined);
  assert.deepEqual(sandboxEgressGrantsForMode(policy, 'app'), [grant()]);
});

test('legacy stored non-App policy is rejected fail closed', async () => {
  const storage = new MemoryPolicyStorage();
  await storage.put('chickpea.sandbox.egress-policy.v2', {
    mode: 'pat',
    grants: [grant()],
  });
  const state = new SandboxPolicyState(storage);

  assert.deepEqual(await state.getEgressPolicy(), {
    mode: null,
    grants: [],
  });
});

test('pull request progress rejects a stale captured turn id', async () => {
  const state = new SandboxPolicyState(new MemoryPolicyStorage());
  await state.prepareTurn('turn-current');

  assert.equal(
    await state.recordPullRequestProgress(PULL_REQUEST, 'turn-stale'),
    false,
  );
  assert.deepEqual(await state.getTurnProgress(), {});
});

test('pull request progress records when the captured turn id still matches', async () => {
  const state = new SandboxPolicyState(new MemoryPolicyStorage());
  await state.prepareTurn('turn-current');

  assert.equal(
    await state.recordPullRequestProgress(PULL_REQUEST, 'turn-current'),
    true,
  );
  assert.deepEqual(await state.getTurnProgress(), {
    pullRequest: PULL_REQUEST,
  });
});

// The Worker-side egress handlers only ever see HTTP and HTTPS. The container
// base class defaults `enableInternet` to true, which leaves a raw socket path
// that never reaches `Sandbox.outbound` — a shell in the container could use it
// to reach any host directly. Cloudflare's own outbound-interception example
// pairs `enableInternet = false` with `interceptHttps = true`; assert both,
// because losing either one silently reopens the unmediated path.
test('the Cloudflare Sandbox class mediates outbound traffic and disables raw internet', () => {
  const source = readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8');
  const classBody = source.slice(
    source.indexOf('export class Sandbox extends CloudflareSandbox'),
  );
  assert.match(classBody.slice(0, 2_000), /^\s*interceptHttps = true;/m);
  assert.match(classBody.slice(0, 2_000), /^\s*enableInternet = false;/m);
  assert.match(source, /Sandbox\.outbound = denySandboxOutbound;/);
});
