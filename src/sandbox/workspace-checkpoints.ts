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

/** Checkpoint a running workspace at the end of a turn. Never starts a container. */
export async function checkpointWorkspace(input: {
  env: Record<string, unknown> | undefined;
  containerRunning: boolean;
  state: Pick<SandboxWorkspaceState, 'recordCheckpoint'>;
  now: () => number;
  create: () => Promise<unknown>;
}): Promise<'saved' | 'skipped' | 'failed'> {
  if (!input.containerRunning || !workspaceCheckpointsAvailable(input.env)) return 'skipped';
  try {
    const backup = await input.create();
    await input.state.recordCheckpoint(backup, input.now());
    return 'saved';
  } catch {
    console.warn('[chickpea] coding workspace checkpoint did not complete');
    return 'failed';
  }
}
