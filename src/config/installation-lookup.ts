import type { InstallationIdentity } from '../identity/installation-binding.ts';
import type { RoutineScheduledHandler } from '../routines/scheduler-adapter.ts';
import { InstallationContextError, scopeInstallationEnv } from './installation-scope.ts';

/** Where a host's registry says an installation stands. Only `active` admits work. */
export type InstallationStatus = 'provisioning' | 'active' | 'suspended' | 'revoked' | 'deleted';

export interface InstallationRecord {
  readonly identity: InstallationIdentity;
  readonly slackTeamId: string;
  readonly status: InstallationStatus;
}

export type InstallationKey = { slackTeamId: string } | { installationId: string };

/**
 * The registry of a host serving many installations. A record's routing
 * fields never change after activation; its status can, so it is read fresh
 * for every request.
 */
export interface InstallationLookup {
  find(key: InstallationKey): Promise<InstallationRecord | undefined>;
  listActive(): Promise<readonly InstallationRecord[]>;
}

/**
 * The env serving one active installation. An unknown installation and one
 * in any other state are refused alike, without naming a tenant.
 */
export async function resolveInstallationEnv<E extends Record<string, unknown>>(
  lookup: InstallationLookup,
  env: E,
  key: InstallationKey,
): Promise<E> {
  const record = await lookup.find(key);
  if (record?.status !== 'active') {
    throw new InstallationContextError('installation_context_missing', 'No active installation serves this request.');
  }
  const matches = 'slackTeamId' in key
    ? record.slackTeamId === key.slackTeamId
    : record.identity.installationId === key.installationId;
  if (!matches) {
    throw new InstallationContextError('installation_context_mismatch', 'The registry answered for another installation.');
  }
  return scopeInstallationEnv(env, { installationId: record.identity.installationId });
}

/**
 * A Worker `scheduled` handler that runs Core's once for each active
 * installation, each with that installation's env, so background work never
 * reaches a store without one. Each installation settles on its own: one
 * failing, including on an unusable record, never holds back the others.
 */
export function scheduledForEachInstallation(
  handler: RoutineScheduledHandler,
  lookupFor: (env: Record<string, unknown>) => InstallationLookup,
): RoutineScheduledHandler {
  return {
    scheduled(controller, env, context) {
      context.waitUntil(lookupFor(env).listActive().then((installations) => {
        for (const installation of installations) {
          context.waitUntil(Promise.resolve()
            .then(() => handler.scheduled(
              controller,
              scopeInstallationEnv(env, { installationId: installation.identity.installationId }),
              context,
            ))
            .catch((error: unknown) => {
              console.error('[chickpea] Scheduled duties failed for one installation:',
                error instanceof Error ? error.message : String(error));
            }));
        }
      }));
    },
  };
}
