import { RoutineStateError } from './types.ts';

export interface RoutineCapability {
  target: 'cloudflare' | 'node';
  available: boolean;
  enabled: boolean;
  reason: 'enabled' | 'unsupported_target';
}

export interface RoutineScheduledController {
  scheduledTime: number;
}

export interface RoutineExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export function createRoutineScheduledHandler(input: {
  heartbeat: (scheduledTime: number, owner: string, env: Record<string, unknown>) => Promise<unknown>;
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
      const tasks: Promise<unknown>[] = [];
      // Generic Work recovery/retention cannot dispatch an agent, call a model,
      // or deliver Slack output; the Routine heartbeat is tracked alongside it.
      if (input.maintenance) {
        tasks.push(input.maintenance(controller.scheduledTime, env));
      }
      tasks.push(input.heartbeat(controller.scheduledTime, owner, env));
      context.waitUntil(Promise.all(tasks));
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
