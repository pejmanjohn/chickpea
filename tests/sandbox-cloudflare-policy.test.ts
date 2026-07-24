import assert from 'node:assert/strict';
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

test('stored PAT policy filters App-wide grants before the egress decision', async () => {
  const state = new SandboxPolicyState(new MemoryPolicyStorage());
  await state.configureEgress(
    {
      mode: 'pat',
      grants: [
        grant(),
        grant({
          id: 'all-acme',
          fullName: '',
          allRepos: true,
        }),
      ],
    },
    'turn-pat',
  );

  const policy = await state.getEgressPolicy();
  const patGrants = sandboxEgressGrantsForMode(policy, 'pat');
  assert.ok(patGrants);
  assert.deepEqual(patGrants, [grant()]);
  assert.equal(
    decideSandboxEgress({
      url: 'https://api.github.com/repos/Acme/Beta/pulls',
      method: 'POST',
      grants: patGrants,
      allowedHosts: [],
    }).allowed,
    false,
  );
  assert.equal(
    decideSandboxEgress({
      url: 'https://api.github.com/repos/Acme/Alpha/pulls',
      method: 'POST',
      grants: patGrants,
      allowedHosts: [],
    }).allowed,
    true,
  );
});

test('stored egress policy rejects a different live credential mode', async () => {
  const state = new SandboxPolicyState(new MemoryPolicyStorage());
  await state.configureEgress(
    { mode: 'app', grants: [grant()] },
    'turn-app',
  );

  const policy = await state.getEgressPolicy();
  assert.equal(sandboxEgressGrantsForMode(policy, 'pat'), undefined);
  assert.deepEqual(sandboxEgressGrantsForMode(policy, 'app'), [grant()]);
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
