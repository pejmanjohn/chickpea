import type { PlatformEnv } from '../config/state-backend.ts';

/**
 * When a host's Worker received a Slack delivery's request, before any of its
 * own work (routing, a health gate). A direct delivery's receipt counts from
 * here, so `turn_latency` covers that work and a state store that boots for
 * it. The time rides in a frozen copy of the env under a module-private
 * symbol, like the hosted Slack app, so no payload or variable can set it.
 */
const SLACK_ARRIVAL = Symbol('chickpea.slack-arrival');

/** The env Core serves one Slack delivery with, carrying its arrival time (epoch milliseconds). */
export function withSlackArrival<E extends PlatformEnv>(env: E, arrivedAt: number): E {
  return Object.freeze({ ...env, [SLACK_ARRIVAL]: arrivedAt });
}

/**
 * A delivery's receipt time: the host's arrival time when it attached one
 * that is not in the future, else now.
 */
export function slackReceiptAt(env: PlatformEnv | undefined, now = Date.now()): number {
  const arrivedAt = (env as { [SLACK_ARRIVAL]?: unknown } | undefined)?.[SLACK_ARRIVAL];
  return typeof arrivedAt === 'number' && arrivedAt > 0 && arrivedAt <= now ? arrivedAt : now;
}
