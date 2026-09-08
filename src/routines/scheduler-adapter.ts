import { RoutineStateError } from './types.ts';

export interface RoutineCapability {
  target: 'cloudflare' | 'node';
  available: boolean;
  enabled: boolean;
  reason: 'enabled' | 'unsupported_target';
}

interface RoutineScheduledController {
  scheduledTime: number;
}

interface RoutineExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

async function settleScheduledDuties(tasks: Array<() => Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(tasks.map((task) => Promise.resolve().then(task)));
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Multiple scheduled duties failed');
  }
}

export async function runWithGuaranteedFinalizer(
  task: () => Promise<unknown>,
  finalizer: () => Promise<unknown>,
): Promise<void> {
  let taskFailed = false;
  let taskFailure: unknown;
  try {
    await task();
  } catch (error) {
    taskFailed = true;
    taskFailure = error;
    throw error;
  } finally {
    try {
      await finalizer();
    } catch (finalizerFailure) {
      if (taskFailed) {
        throw new AggregateError(
          [taskFailure, finalizerFailure],
          'Scheduled duty and its finalizer both failed',
        );
      }
      throw finalizerFailure;
    }
  }
}

export function createRoutineScheduledHandler(input: {
  heartbeat: (
    scheduledTime: number,
    owner: string,
    env: Record<string, unknown>,
    context: RoutineExecutionContext,
  ) => Promise<unknown>;
  maintenance?: (scheduledTime: number, env: Record<string, unknown>) => Promise<unknown>;
}): {
  scheduled(
    controller: RoutineScheduledController,
    env: Record<string, unknown>,
    context: RoutineExecutionContext,
  ): void;
} {
  return {
    scheduled(controller, env, context): void {
      const owner = `heartbeat:${controller.scheduledTime}`;
      const tasks: Array<() => Promise<unknown>> = [];
      // Generic Work recovery/retention cannot dispatch an agent, call a model,
      // or deliver Slack output; the Routine heartbeat is tracked alongside it.
      if (input.maintenance) {
        tasks.push(() => input.maintenance!(controller.scheduledTime, env));
      }
      tasks.push(() => input.heartbeat(controller.scheduledTime, owner, env, context));
      context.waitUntil(settleScheduledDuties(tasks));
    },
  };
}

export function resolveRoutineCapability(input: { cloudflare: boolean }): RoutineCapability {
  if (!input.cloudflare) {
    return {
      target: 'node',
      available: false,
      enabled: false,
      reason: 'unsupported_target',
    };
  }
  return {
    target: 'cloudflare',
    available: true,
    enabled: true,
    reason: 'enabled',
  };
}

export function requireRoutineScheduling(capability: RoutineCapability): void {
  if (!capability.available) {
    throw new RoutineStateError(
      'routines_unavailable_on_target',
      'Routine scheduling is currently available only on Cloudflare deployments.',
    );
  }
}
