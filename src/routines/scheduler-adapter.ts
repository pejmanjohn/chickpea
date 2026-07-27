import { RoutineStateError } from './types.ts';

export interface RoutineCapability {
  target: 'cloudflare' | 'node';
  available: boolean;
  enabled: boolean;
  reason: 'enabled' | 'operator_disabled' | 'unsupported_target';
}

export interface RoutineScheduledController {
  scheduledTime: number;
}

export interface RoutineExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export function createRoutineScheduledHandler(input: {
  heartbeat: (scheduledTime: number, owner: string, env: Record<string, unknown>) => Promise<unknown>;
}): {
  scheduled(
    controller: RoutineScheduledController,
    env: Record<string, unknown>,
    context: RoutineExecutionContext,
  ): void;
} {
  return {
    scheduled(controller, env, context): void {
      const flag = env.TAG_ROUTINES_ENABLED;
      const capability = resolveRoutineCapability({
        cloudflare: true,
        ...(typeof flag === 'string' ? { enabledFlag: flag } : {}),
      });
      // Existing installations receive the Cron event after deploy, but do no
      // state scan, Workflow admission, model call, or Slack work until the
      // operator flag is explicitly enabled.
      if (!capability.enabled) return;
      const owner = `heartbeat:${controller.scheduledTime}`;
      context.waitUntil(input.heartbeat(controller.scheduledTime, owner, env));
    },
  };
}

export function resolveRoutineCapability(input: {
  cloudflare: boolean;
  enabledFlag?: string;
}): RoutineCapability {
  if (!input.cloudflare) {
    return {
      target: 'node',
      available: false,
      enabled: false,
      reason: 'unsupported_target',
    };
  }
  const enabled = input.enabledFlag === '1';
  return {
    target: 'cloudflare',
    available: true,
    enabled,
    reason: enabled ? 'enabled' : 'operator_disabled',
  };
}

export function requireRoutineScheduling(capability: RoutineCapability): void {
  if (!capability.available) {
    throw new RoutineStateError(
      'routines_unavailable_on_target',
      'Routine scheduling is currently available only on Cloudflare deployments.',
    );
  }
  if (!capability.enabled) {
    throw new RoutineStateError(
      'routines_disabled',
      'Routine scheduling is disabled by the deployment operator.',
    );
  }
}
