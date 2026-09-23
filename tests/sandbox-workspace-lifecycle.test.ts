import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RepositoryGrant } from '../src/config/types.ts';
import {
  SandboxPolicyState,
  type SandboxPolicyStorage,
} from '../src/sandbox/cloudflare-policy.ts';
import {
  SandboxWorkspaceState,
  workspaceFingerprint,
} from '../src/sandbox/workspace-lifecycle.ts';

class MemoryStorage implements SandboxPolicyStorage {
  readonly values = new Map<string, unknown>();

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

const ALPHA = workspaceFingerprint('agent_alpha', [grant()]);

test('a follow-up for the same Agent and grants reuses the warm workspace and its cap reservation', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());

  const first = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-1', containerRunning: false });
  assert.deepEqual(first, { state: 'fresh', reservationId: 'turn-1', retire: false });

  // Turn 1 activated the container; turn 2 arrives inside the warm window.
  const second = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-2', containerRunning: true });
  assert.deepEqual(second, { state: 'warm', reservationId: 'turn-1', retire: false });

  const third = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-3', containerRunning: true });
  assert.equal(third.reservationId, 'turn-1');
});

test('after the container sleeps the next turn starts fresh and counts as a new session', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());
  await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-1', containerRunning: false });

  const afterSleep = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-9', containerRunning: false });
  assert.deepEqual(afterSleep, { state: 'fresh', reservationId: 'turn-9', retire: false });

  const warmAgain = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-10', containerRunning: true });
  assert.equal(warmAgain.reservationId, 'turn-9');
});

test('a thread handed to a different Agent never inherits the warm checkout', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());
  await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-1', containerRunning: false });

  const otherAgent = workspaceFingerprint('agent_beta', [grant()]);
  const handoff = await state.beginTurn({ fingerprint: otherAgent, turnId: 'turn-2', containerRunning: true });
  assert.deepEqual(handoff, { state: 'retired', reservationId: 'turn-2', retire: true });
});

test('changed repository grants retire the warm workspace, including a revoked repository', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());
  const both = workspaceFingerprint('agent_alpha', [
    grant(),
    grant({ id: 'repo-beta', fullName: 'Acme/Beta' }),
  ]);
  await state.beginTurn({ fingerprint: both, turnId: 'turn-1', containerRunning: false });

  const revoked = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-2', containerRunning: true });
  assert.equal(revoked.retire, true);
  assert.equal(revoked.state, 'retired');

  const widened = await state.beginTurn({
    fingerprint: workspaceFingerprint('agent_alpha', [grant({ allRepos: true, fullName: '' })]),
    turnId: 'turn-3',
    containerRunning: true,
  });
  assert.equal(widened.retire, true);
});

test('a running container with no workspace record is retired rather than trusted', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());
  const decision = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-1', containerRunning: true });
  assert.deepEqual(decision, { state: 'retired', reservationId: 'turn-1', retire: true });
});

test('the fingerprint ignores grant order, repository casing, and disabled grants', () => {
  const a = grant();
  const b = grant({ id: 'repo-beta', fullName: 'Acme/Beta' });
  assert.equal(
    workspaceFingerprint('agent_alpha', [a, b]),
    workspaceFingerprint('agent_alpha', [
      { ...b, fullName: 'acme/beta', accountLogin: 'acme' },
      a,
      grant({ id: 'repo-off', fullName: 'Acme/Off', enabled: false }),
    ]),
  );
  assert.notEqual(
    workspaceFingerprint('agent_alpha', [a]),
    workspaceFingerprint('agent_alpha', [grant({ installationId: 60_002 })]),
  );
});

test('ending a turn revokes egress grants but keeps the turn id for recovery reads', async () => {
  const storage = new MemoryStorage();
  const policy = new SandboxPolicyState(storage);
  await policy.configureEgress({ grants: [grant()], mode: 'app' }, 'turn-1');
  assert.equal((await policy.getEgressPolicy()).grants.length, 1);

  await policy.revokeEgress();

  assert.deepEqual(await policy.getEgressPolicy(), { grants: [], mode: null });
  assert.equal(await policy.getTurnId(), 'turn-1');
});
