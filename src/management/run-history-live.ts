import { resolveBetterAuthEnvironment } from '../auth/better-auth-environment.ts';
import { deploymentServesManyInstallations, installationScopeOf } from '../config/installation-scope.ts';
import { platformBilling, type BilledUsageRow } from '../config/platform-billing.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { RoutineStore } from '../routines/types.ts';
import type { UsageStore } from '../usage/types.ts';
import type { RunId, WorkStore } from '../work/types.ts';
import type { RunCharge, RunHistorySources } from './run-history-sources.ts';

const DAY_MS = 24 * 60 * 60 * 1_000;

/** Run history's sources on a live deployment; each store opens on first use. */
export function liveRunHistorySources(input: {
  env: PlatformEnv | undefined;
  identity: Pick<IdentityStore, 'getAuthControl'>;
  config: Pick<ConfigStore, 'listSlackPublicContext'>;
  usage: () => UsageStore;
  work: () => Pick<WorkStore, 'getRunVisibilities'>;
  routines: () => Pick<RoutineStore, 'getRun'>;
}): RunHistorySources {
  const { env } = input;
  return {
    usage: {
      listOperations: (query) => input.usage().listOperations(query),
      getOperation: (operationId) => input.usage().getOperation(operationId),
      summarize: (query) => input.usage().summarize(query),
    },
    async runVisibilities(runIds) {
      const found = await input.work().getRunVisibilities(runIds as RunId[]);
      return new Map(found.map(({ runId, public: isPublic }) => [runId, isPublic]));
    },
    threadRecord: (workspaceId, channelId, rootTs) => input.config.listSlackPublicContext(workspaceId, channelId, rootTs),
    async schedulePost(routineRunId) {
      const run = await input.routines().getRun(routineRunId);
      return run?.deliveryChannelId && run.deliveryMessageTs
        ? { channelId: run.deliveryChannelId, messageTs: run.deliveryMessageTs }
        : undefined;
    },
    async charges(items) {
      const port = platformBilling();
      const installationId = installationScopeOf(env)?.installationId;
      if (!port || !installationId) return undefined;
      // A bill that cannot be read shows no amount, never an estimate in its place.
      if (!port.usage || items.length === 0) return new Map();
      const now = Date.now();
      const from = Math.floor(Math.min(...items.map(({ operation }) => operation.startedAt)) / DAY_MS) * DAY_MS;
      const to = Math.min(now + 1, Math.max(...items.map(({ operation }) => operation.finishedAt ?? now)) + DAY_MS);
      const { rows } = await port.usage(installationId, { from: new Date(from), to: new Date(to) });
      const byRun = new Map<string, BilledUsageRow[]>();
      for (const row of rows) if (row.runId !== null) byRun.set(row.runId, [...byRun.get(row.runId) ?? [], row]);
      const charges = new Map<string, RunCharge>();
      for (const { operation, measurements } of items) {
        const keys = [...new Set(measurements.flatMap(({ billingRunId }) => billingRunId ? [billingRunId] : []))];
        const billed = keys.flatMap((runId) => byRun.get(runId) ?? []);
        // The bill leaves out a run whose rows net to nothing, so a run it was read for and does not name was billed
        // nothing. A billing key comes with the run's terminal; a run with none to look for has no amount.
        if (billed.length === 0) {
          if (keys.length > 0) charges.set(operation.operationId, { micros: 0 });
          continue;
        }
        charges.set(operation.operationId, {
          micros: billed.reduce((total, row) => total + row.modelMicros + row.feeMicros - row.creditedBackMicros, 0),
        });
      }
      return charges;
    },
    async handleSecret() {
      const scope = installationScopeOf(env);
      if (!scope && deploymentServesManyInstallations(env)) return undefined;
      const control = await input.identity.getAuthControl();
      const secret = control ? (await resolveBetterAuthEnvironment({ control, platformEnv: env }))?.secret : undefined;
      return secret ? { secret, installationId: scope?.installationId ?? 'standalone' } : undefined;
    },
  };
}
