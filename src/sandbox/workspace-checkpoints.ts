import { checkpointObjectKeys, deleteCheckpointObjects } from './checkpoint-bucket.ts';
import { checkpointBucket } from './checkpoint-sweep.ts';
import type { SandboxWorkspaceState } from './workspace-lifecycle.ts';

/**
 * Coding-workspace checkpoints need the `BACKUP_BUCKET` R2 binding. A
 * deployment on an account without R2 omits it: every checkpoint step is then
 * skipped, and a cold follow-up starts from an empty workspace where the Agent
 * clones the repository again, exactly as before checkpoints existed.
 */
export function workspaceCheckpointsAvailable(env: Record<string, unknown> | undefined): boolean {
  return checkpointBucket(env) !== undefined;
}

/**
 * Bring back the thread's last checkpoint into a cold container. Best effort:
 * no bucket, an expired or missing checkpoint, or a failed restore leaves an
 * empty workspace and the Agent clones again.
 */
export async function restoreWorkspaceCheckpoint(input: {
  env: Record<string, unknown> | undefined;
  state: Pick<SandboxWorkspaceState, 'checkpointForRestore'>;
  fingerprint: string;
  now: () => number;
  restore: (backup: unknown) => Promise<void>;
}): Promise<'restored' | 'unavailable'> {
  if (!workspaceCheckpointsAvailable(input.env)) return 'unavailable';
  const backup = await input.state.checkpointForRestore(input.fingerprint, input.now());
  if (!backup) return 'unavailable';
  try {
    await input.restore(backup);
    return 'restored';
  } catch {
    console.warn('[chickpea] coding workspace checkpoint restore did not complete');
    return 'unavailable';
  }
}

/**
 * Checkpoint a running workspace at the end of a turn, then delete the
 * checkpoint it replaced: only the latest is ever restored, so the restore
 * window is unchanged. Never starts a container.
 */
export async function checkpointWorkspace(input: {
  env: Record<string, unknown> | undefined;
  containerRunning: boolean;
  state: Pick<SandboxWorkspaceState, 'recordCheckpoint'>;
  now: () => number;
  create: () => Promise<unknown>;
}): Promise<'saved' | 'skipped' | 'failed'> {
  if (!input.containerRunning || !workspaceCheckpointsAvailable(input.env)) return 'skipped';
  let replaced: unknown;
  let backup: unknown;
  try {
    backup = await input.create();
    replaced = await input.state.recordCheckpoint(backup, input.now());
  } catch {
    console.warn('[chickpea] coding workspace checkpoint did not complete');
    return 'failed';
  }
  await deleteUnusedCheckpoint(input.env, replaced, backup);
  return 'saved';
}

/**
 * Forget a discarded workspace's checkpoint, then delete its objects: it is
 * never restored. Leaves the container to the caller.
 */
export async function discardWorkspaceCheckpoint(input: {
  env: Record<string, unknown> | undefined;
  state: Pick<SandboxWorkspaceState, 'currentCheckpoint' | 'dropCheckpoint'>;
}): Promise<void> {
  const dropped = await input.state.currentCheckpoint();
  await input.state.dropCheckpoint();
  await deleteUnusedCheckpoint(input.env, dropped);
}

/**
 * Delete a checkpoint nothing restores any more (unless it is `current`).
 * Best effort: what is left behind, the hourly sweep deletes after the
 * restore window.
 */
async function deleteUnusedCheckpoint(
  env: Record<string, unknown> | undefined,
  unused: unknown,
  current?: unknown,
): Promise<void> {
  const keys = checkpointObjectKeys(unused);
  if (!keys || keys[0] === checkpointObjectKeys(current)?.[0]) return;
  const bucket = checkpointBucket(env);
  if (!bucket) return;
  try {
    await deleteCheckpointObjects(bucket, unused);
  } catch {
    console.warn('[chickpea] an unused coding workspace checkpoint was not deleted');
  }
}
