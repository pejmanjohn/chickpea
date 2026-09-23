import { WORKSPACE_CHECKPOINT_TTL_SECONDS } from './workspace-lifecycle.ts';

/**
 * The slice of an R2 bucket binding the checkpoint store uses. The bucket is
 * dedicated to coding-workspace checkpoints, so every object in it is ours.
 */
export interface CheckpointBucket {
  list(options?: { cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string; uploaded: Date }>;
    truncated: boolean;
    cursor?: string;
  }>;
  delete(keys: string | string[]): Promise<void>;
}

export function checkpointBucket(env: Record<string, unknown> | undefined): CheckpointBucket | undefined {
  const candidate = env?.BACKUP_BUCKET as Partial<CheckpointBucket> | undefined;
  return candidate &&
    typeof candidate.list === 'function' &&
    typeof candidate.delete === 'function'
    ? (candidate as CheckpointBucket)
    : undefined;
}

// Sweep once an hour on the every-minute maintenance cron.
const SWEEP_MINUTE = 17;
const MAX_PAGES = 10;
const PAGE_SIZE = 1_000;

export function isCheckpointSweepMinute(scheduledTime: number): boolean {
  return new Date(scheduledTime).getUTCMinutes() === SWEEP_MINUTE;
}

/**
 * Delete checkpoint objects past their restore window. The Sandbox SDK only
 * checks a backup's TTL when restoring, and R2 lifecycle rules are not
 * provisioned with the binding, so without this sweep abandoned threads'
 * checkpoints would accumulate indefinitely.
 */
export async function sweepExpiredWorkspaceCheckpoints(
  bucket: CheckpointBucket,
  now: number,
): Promise<number> {
  const cutoff = now - WORKSPACE_CHECKPOINT_TTL_SECONDS * 1000;
  let cursor: string | undefined;
  let deleted = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const listing = await bucket.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
    const expired = listing.objects
      .filter((object) => object.uploaded.getTime() < cutoff)
      .map((object) => object.key);
    if (expired.length > 0) {
      await bucket.delete(expired);
      deleted += expired.length;
    }
    if (!listing.truncated || !listing.cursor) break;
    cursor = listing.cursor;
  }
  return deleted;
}
