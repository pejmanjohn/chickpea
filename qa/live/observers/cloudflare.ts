import {
  blockedObservation,
  boundedObserverString,
  closedObservation,
  hasExactObserverKeys,
  observerRecord,
  validObserverDeadline,
  type ClosedObservation,
} from './capabilities.ts';

export interface CloudflareTargetSnapshot {
  workerName: string;
  deployments: Array<{ versionId: string; percentage: number }>;
  bindingIdentities: Record<string, string>;
}

export interface CloudflareObservation extends ClosedObservation {
  snapshot?: CloudflareTargetSnapshot;
}

export const CLOUDFLARE_KNOWN_BAD_FIXTURE: unknown = Object.freeze({
  workerName: 'qa-worker',
  deployments: [
    { versionId: 'version-one', percentage: 90 },
    { versionId: 'version-two', percentage: 10 },
  ],
  bindingIdentities: { AUTH_DB: 'auth-db' },
});

export async function observeCloudflare(input: {
  deadlineMs: number;
  read(options: { signal: AbortSignal }): Promise<unknown>;
}): Promise<CloudflareObservation> {
  if (!validObserverDeadline(input.deadlineMs, 60_000)) {
    return blockedObservation('cloudflare.version.read');
  }
  try {
    const value = await input.read({ signal: AbortSignal.timeout(input.deadlineMs) });
    if (!validSnapshot(value)
      || value.deployments.length !== 1
      || value.deployments[0]?.percentage !== 100) {
      return blockedObservation('cloudflare.version.read');
    }
    const snapshot: CloudflareTargetSnapshot = {
      workerName: value.workerName,
      deployments: value.deployments.map((deployment) => ({ ...deployment })),
      bindingIdentities: { ...value.bindingIdentities },
    };
    return Object.freeze({
      ...closedObservation({
        observerId: 'cloudflare.version.read',
        status: 'observed',
        tokens: [],
        metadata: {
          attempts: 1,
          deadlineMs: input.deadlineMs,
          versionId: snapshot.deployments[0]!.versionId,
        },
      }),
      snapshot: Object.freeze(snapshot),
    });
  } catch {
    return closedObservation({
      observerId: 'cloudflare.version.read',
      status: 'unavailable',
      tokens: [],
      metadata: { attempts: 1 },
    });
  }
}

function validSnapshot(input: unknown): input is CloudflareTargetSnapshot {
  return observerRecord(input)
    && hasExactObserverKeys(input, ['workerName', 'deployments', 'bindingIdentities'])
    && boundedObserverString(input.workerName, 512)
    && Array.isArray(input.deployments)
    && input.deployments.every((deployment) => observerRecord(deployment)
      && hasExactObserverKeys(deployment, ['versionId', 'percentage'])
      && boundedObserverString(deployment.versionId, 512)
      && typeof deployment.percentage === 'number'
      && Number.isFinite(deployment.percentage)
      && deployment.percentage >= 0
      && deployment.percentage <= 100)
    && observerRecord(input.bindingIdentities)
    && Object.keys(input.bindingIdentities).length > 0
    && Object.entries(input.bindingIdentities).every(([key, value]) =>
      /^[A-Z][A-Z0-9_]{0,63}$/.test(key) && boundedObserverString(value, 512)
    );
}
