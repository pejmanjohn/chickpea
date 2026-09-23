import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RepositoryGrant } from '../src/config/types.ts';
import {
  SandboxPolicyState,
  type SandboxPolicyStorage,
} from '../src/sandbox/cloudflare-policy.ts';
import {
  SandboxWorkspaceState,
  WORKSPACE_CHECKPOINT_EXCLUDES,
  workspaceFingerprint,
} from '../src/sandbox/workspace-lifecycle.ts';
import {
  checkpointBucket,
  isCheckpointSweepMinute,
  sweepExpiredWorkspaceCheckpoints,
  type CheckpointBucket,
} from '../src/sandbox/checkpoint-sweep.ts';
import {
  checkpointWorkspace,
  restoreWorkspaceCheckpoint,
  workspaceCheckpointsAvailable,
} from '../src/sandbox/workspace-checkpoints.ts';

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
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

test('a follow-up for the same Agent and grants reuses the warm workspace and its cap reservation', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());

  const first = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-1', containerRunning: false, now: NOW });
  assert.deepEqual(first, { state: 'fresh', reservationId: 'turn-1', retire: false, restorable: false });

  // Turn 1 activated the container; turn 2 arrives inside the warm window.
  const second = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-2', containerRunning: true, now: NOW });
  assert.deepEqual(second, { state: 'warm', reservationId: 'turn-1', retire: false, restorable: false });

  const third = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-3', containerRunning: true, now: NOW });
  assert.equal(third.reservationId, 'turn-1');
});

test('after the container sleeps the next turn starts fresh and counts as a new session', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());
  await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-1', containerRunning: false, now: NOW });

  const afterSleep = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-9', containerRunning: false, now: NOW });
  assert.deepEqual(afterSleep, { state: 'fresh', reservationId: 'turn-9', retire: false, restorable: false });

  const warmAgain = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-10', containerRunning: true, now: NOW });
  assert.equal(warmAgain.reservationId, 'turn-9');
});

test('a thread handed to a different Agent never inherits the warm checkout', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());
  await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-1', containerRunning: false, now: NOW });

  const otherAgent = workspaceFingerprint('agent_beta', [grant()]);
  const handoff = await state.beginTurn({ fingerprint: otherAgent, turnId: 'turn-2', containerRunning: true, now: NOW });
  assert.deepEqual(handoff, { state: 'retired', reservationId: 'turn-2', retire: true, restorable: false });
});

test('changed repository grants retire the warm workspace, including a revoked repository', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());
  const both = workspaceFingerprint('agent_alpha', [
    grant(),
    grant({ id: 'repo-beta', fullName: 'Acme/Beta' }),
  ]);
  await state.beginTurn({ fingerprint: both, turnId: 'turn-1', containerRunning: false, now: NOW });

  const revoked = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-2', containerRunning: true, now: NOW });
  assert.equal(revoked.retire, true);
  assert.equal(revoked.state, 'retired');

  const widened = await state.beginTurn({
    fingerprint: workspaceFingerprint('agent_alpha', [grant({ allRepos: true, fullName: '' })]),
    turnId: 'turn-3',
    containerRunning: true,
    now: NOW,
  });
  assert.equal(widened.retire, true);
});

test('a running container with no workspace record is retired rather than trusted', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());
  const decision = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-1', containerRunning: true, now: NOW });
  assert.deepEqual(decision, { state: 'retired', reservationId: 'turn-1', retire: true, restorable: false });
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

const BACKUP = { id: 'backup-1', dir: '/workspace', localBucket: true };

test('a cold follow-up for the same owner can restore the last checkpoint within three days', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());
  await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-1', containerRunning: false, now: NOW });
  await state.recordCheckpoint(BACKUP, NOW);

  // The container slept; the thread resumes two days later.
  const resumed = await state.beginTurn({
    fingerprint: ALPHA,
    turnId: 'turn-2',
    containerRunning: false,
    now: NOW + 48 * HOUR,
  });
  assert.deepEqual(resumed, { state: 'fresh', reservationId: 'turn-2', retire: false, restorable: true });
  assert.deepEqual(await state.checkpointForRestore(ALPHA, NOW + 48 * HOUR), BACKUP);

  // A warm follow-up never restores over the live workspace.
  const warm = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-3', containerRunning: true, now: NOW + 49 * HOUR });
  assert.equal(warm.restorable, false);
});

test('an expired checkpoint is not restored', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());
  await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-1', containerRunning: false, now: NOW });
  await state.recordCheckpoint(BACKUP, NOW);

  const late = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-2', containerRunning: false, now: NOW + 72 * HOUR });
  assert.equal(late.restorable, false);
  assert.equal(await state.checkpointForRestore(ALPHA, NOW + 72 * HOUR), undefined);
});

test('a checkpoint never crosses to another Agent or changed grants, even after they change back', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());
  await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-1', containerRunning: false, now: NOW });
  await state.recordCheckpoint(BACKUP, NOW);

  const beta = workspaceFingerprint('agent_beta', [grant()]);
  const handoff = await state.beginTurn({ fingerprint: beta, turnId: 'turn-2', containerRunning: false, now: NOW + HOUR });
  assert.equal(handoff.restorable, false);
  assert.equal(await state.checkpointForRestore(beta, NOW + HOUR), undefined);

  // The original owner returns: the checkpoint was dropped at the handoff.
  const back = await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-3', containerRunning: false, now: NOW + 2 * HOUR });
  assert.equal(back.restorable, false);
  assert.equal(await state.checkpointForRestore(ALPHA, NOW + 2 * HOUR), undefined);
});

test('restore re-checks the owner at restore time', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());
  await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-1', containerRunning: false, now: NOW });
  await state.recordCheckpoint(BACKUP, NOW);
  const otherGrants = workspaceFingerprint('agent_alpha', [grant({ fullName: 'Acme/Other' })]);
  assert.equal(await state.checkpointForRestore(otherGrants, NOW + HOUR), undefined);
});

test('checkpoint excludes are bare directory names the container matches at any depth', () => {
  for (const name of ['node_modules', '.venv', '__pycache__']) {
    assert.ok(WORKSPACE_CHECKPOINT_EXCLUDES.includes(name), name);
  }
  // The container prefixes each pattern with `... ` (any depth). A wildcard or
  // path segment under that prefix makes mksquashfs exclude the whole tree,
  // which shipped as empty checkpoints before this guard (Cobalt, 2026-09-23).
  for (const pattern of WORKSPACE_CHECKPOINT_EXCLUDES) {
    assert.doesNotMatch(pattern, /[*/?[\]]/, pattern);
  }
});

class MemoryBucket implements CheckpointBucket {
  constructor(readonly objects: Map<string, Date>) {}
  listCalls = 0;

  async list(options?: { cursor?: string; limit?: number }) {
    this.listCalls += 1;
    // Like R2, the cursor continues after the last listed key, so deleting
    // already-listed objects never skips later ones.
    const after = options?.cursor;
    const keys = [...this.objects.keys()].sort().filter((key) => after === undefined || key > after);
    const page = keys.slice(0, options?.limit ?? 1000);
    const truncated = keys.length > page.length;
    return {
      objects: page.map((key) => ({ key, uploaded: this.objects.get(key)! })),
      truncated,
      ...(truncated ? { cursor: page[page.length - 1] } : {}),
    };
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key);
  }
}

test('the cleanup sweep deletes only checkpoint objects past the three-day window', async () => {
  const bucket = new MemoryBucket(new Map([
    ['backups/old/data.sqsh', new Date(NOW - 73 * HOUR)],
    ['backups/old/meta.json', new Date(NOW - 73 * HOUR)],
    ['backups/recent/data.sqsh', new Date(NOW - 71 * HOUR)],
  ]));
  assert.equal(await sweepExpiredWorkspaceCheckpoints(bucket, NOW), 2);
  assert.deepEqual([...bucket.objects.keys()], ['backups/recent/data.sqsh']);
});

test('the cleanup sweep pages through a large bucket', async () => {
  const objects = new Map<string, Date>();
  for (let index = 0; index < 2_500; index += 1) {
    objects.set(`backups/${String(index).padStart(5, '0')}/data.sqsh`, new Date(NOW - 100 * HOUR));
  }
  const bucket = new MemoryBucket(objects);
  assert.equal(await sweepExpiredWorkspaceCheckpoints(bucket, NOW), 2_500);
  assert.equal(bucket.objects.size, 0);
});

test('checkpoints are off without a bucket binding, and the sweep runs hourly', () => {
  assert.equal(checkpointBucket({}), undefined);
  assert.equal(checkpointBucket({ BACKUP_BUCKET: 'not-a-binding' }), undefined);
  assert.ok(checkpointBucket({ BACKUP_BUCKET: new MemoryBucket(new Map()) }));
  const sweepMinutes = Array.from({ length: 60 }, (_, minute) => NOW + minute * 60_000)
    .filter(isCheckpointSweepMinute);
  assert.equal(sweepMinutes.length, 1);
});

test('without the R2 bucket binding a cold follow-up clones again instead of restoring', async () => {
  const state = new SandboxWorkspaceState(new MemoryStorage());
  await state.beginTurn({ fingerprint: ALPHA, turnId: 'turn-1', containerRunning: false, now: NOW });
  const noBucket = {};
  const withBucket = { BACKUP_BUCKET: new MemoryBucket(new Map()) };
  assert.equal(workspaceCheckpointsAvailable(noBucket), false);
  assert.equal(workspaceCheckpointsAvailable(withBucket), true);

  // End of turn: no bucket means no backup is taken or recorded.
  let created = 0;
  const create = async () => { created += 1; return BACKUP; };
  assert.equal(await checkpointWorkspace({ env: noBucket, containerRunning: true, state, now: () => NOW, create }), 'skipped');
  assert.equal(created, 0);
  assert.equal(await state.checkpointForRestore(ALPHA, NOW + HOUR), undefined);

  // A checkpoint recorded while the bucket existed is still never restored without it.
  assert.equal(await checkpointWorkspace({ env: withBucket, containerRunning: true, state, now: () => NOW, create }), 'saved');
  assert.equal(created, 1);
  let restored = 0;
  const restore = async () => { restored += 1; };
  assert.equal(
    await restoreWorkspaceCheckpoint({ env: noBucket, state, fingerprint: ALPHA, now: () => NOW + HOUR, restore }),
    'unavailable',
  );
  assert.equal(restored, 0);
  assert.equal(
    await restoreWorkspaceCheckpoint({ env: withBucket, state, fingerprint: ALPHA, now: () => NOW + HOUR, restore }),
    'restored',
  );
  assert.equal(restored, 1);

  // A sleeping container is never started just to checkpoint it, and a failed backup is not fatal.
  assert.equal(await checkpointWorkspace({ env: withBucket, containerRunning: false, state, now: () => NOW, create }), 'skipped');
  const failing = async () => { throw new Error('backup failed'); };
  assert.equal(await checkpointWorkspace({ env: withBucket, containerRunning: true, state, now: () => NOW, create: failing }), 'failed');
});
