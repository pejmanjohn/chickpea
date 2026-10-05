import { SandboxPolicyState, type SandboxPolicyStorage } from './cloudflare-policy.ts';
import { readStoredCodingTasks } from './coding-task-record.ts';
import { WORKSPACE_WARM_WINDOW_MS } from './lifecycle.ts';

/**
 * When a warm container's idle window ends, kept in the Sandbox Durable
 * Object's own storage. The Containers SDK keeps its idle deadline in memory
 * and re-arms it a full window out whenever the object restarts (a deploy, a
 * runtime update, a log tail attaching), so restarts less than a window
 * apart would keep the container running forever. A turn's end stores the
 * window's end, the next turn's start clears it, and the alarm stops the
 * container once it has passed.
 */
const SANDBOX_WARM_UNTIL_STORAGE_KEY = 'chickpea.sandbox.warm-until.v1';

export interface WarmWindowStorage extends SandboxPolicyStorage {
  delete(key: string): Promise<boolean>;
}

/** At a turn's end, with the container running: warm for one window from now. */
export async function holdWarmWindow(storage: WarmWindowStorage, now: number): Promise<void> {
  await storage.put(SANDBOX_WARM_UNTIL_STORAGE_KEY, now + WORKSPACE_WARM_WINDOW_MS);
}

/** At a turn's start: the turn is using the workspace. */
export async function clearWarmWindow(storage: WarmWindowStorage): Promise<void> {
  await storage.delete(SANDBOX_WARM_UNTIL_STORAGE_KEY);
}

/**
 * From the alarm: stop a running container whose stored window has passed,
 * through the SDK's own idle stop. A coding task of the last turn that has
 * not settled may still be using the workspace, so it keeps the container
 * until it settles. With nothing stored, the SDK's own deadline is the only
 * one, as before.
 */
export async function stopPastWarmWindow(input: {
  storage: WarmWindowStorage;
  running: boolean;
  now: number;
  stop: () => Promise<void>;
}): Promise<void> {
  if (!input.running) return;
  const until = await input.storage.get<number>(SANDBOX_WARM_UNTIL_STORAGE_KEY);
  if (until === undefined || until > input.now) return;
  const turnId = await new SandboxPolicyState(input.storage).getTurnId();
  if (turnId && (await readStoredCodingTasks(input.storage, turnId)).length > 0) return;
  await input.stop();
  await clearWarmWindow(input.storage);
}
