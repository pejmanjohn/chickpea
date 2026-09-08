interface WorkChecklistHeartbeat {
  /** Cancel future refreshes without waiting for an active Slack request. */
  cancel(): void;
  /** Cancel future refreshes and wait a bounded time for the active request. */
  stop(): Promise<boolean>;
}

interface WorkChecklistHeartbeatOptions {
  intervalMs: number;
  drainTimeoutMs?: number;
  update(): void | Promise<void>;
  onError?(error: unknown): void;
  onDrainTimeout?(): void;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 12_000;

/**
 * Refresh one existing Slack checklist while work is quiet. Updates are
 * serialized so a slow Slack response cannot overlap the next heartbeat, and
 * stop drains the last in-flight update before terminal checklist cleanup.
 */
export function startWorkChecklistHeartbeat(
  options: WorkChecklistHeartbeatOptions,
): WorkChecklistHeartbeat {
  const intervalMs = Math.max(1_000, Math.floor(options.intervalMs));
  const drainTimeoutMs = Math.max(
    1,
    Math.floor(options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS),
  );
  let stopped = false;
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped) return;
    pending = pending
      .then(() => stopped ? undefined : options.update())
      .catch((error: unknown) => {
        options.onError?.(error);
      });
  }, intervalMs);
  timer.unref?.();

  const cancel = (): void => {
    if (!stopped) {
      stopped = true;
      clearInterval(timer);
    }
  };

  return {
    cancel,
    async stop(): Promise<boolean> {
      cancel();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const drained = await Promise.race([
        pending.then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), drainTimeoutMs);
          timeout.unref?.();
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      if (!drained) options.onDrainTimeout?.();
      return drained;
    },
  };
}
