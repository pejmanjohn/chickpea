import { isCloudflareTarget } from '../config/runtime-target.ts';
import { tagStateStub, type TagStateRpc } from '../config/state-rpc.ts';
import { activityStatus, type TypedActivityStatus } from '../activity/status.ts';
import { threadRunnerStub } from './thread-runner-rpc.ts';
import type { FlueTurnObservationV1 } from './turn-job-types.ts';

/** The Durable Object whose registry holds the turn's live status. */
export type ObservedStatusTarget = Pick<TagStateRpc, 'observedStatus'>;

/**
 * Finds the owner of a turn's live status registry. Today every turn runs in
 * the singleton state store's alarm; a per-thread runner resolves itself.
 */
export type ObservedStatusTargetResolver = (
  env: Record<string, unknown> | undefined,
  instanceId: string,
  submissionId: string,
) => ObservedStatusTarget;

/** The singleton state store, where the alarm registers every turn. */
export const singletonObservedStatusTarget: ObservedStatusTargetResolver = (env) =>
  tagStateStub(env);

/**
 * The executor recorded with the turn's dispatch: its thread runner when one
 * executes the turn, else the singleton state store.
 */
export function observedStatusTargetFor(
  route: Pick<FlueTurnObservationV1, 'executor' | 'runnerKey'> | undefined,
): ObservedStatusTargetResolver {
  if (route?.executor !== 'runner' || !route.runnerKey) return singletonObservedStatusTarget;
  const runnerKey = route.runnerKey;
  return (env, instanceId, submissionId) =>
    threadRunnerStub(env, runnerKey) ?? singletonObservedStatusTarget(env, instanceId, submissionId);
}

/**
 * Cloudflare only: the durable agent runs in its own DO isolate, while the
 * live turn's status registry lives in the TagStateStore alarm isolate — an
 * observed activity can never hit the local Map there. Relay the already
 * sanitized typed activity to the singleton state DO, which routes it into ITS
 * registry (where the alarm registered the turn). The opaque generation lets
 * the registry reject an old RPC even after another turn registers under the
 * same conversation key; runTurn also closes its sink before final delivery.
 * On node the local registry always hits first, so this is never called with
 * work to do.
 *
 * Best-effort by contract: a dropped status update must never fail a turn, so
 * every miss (no ALS context, no binding, RPC failure) is swallowed.
 */
export async function relayObservedStatus(
  instanceId: string,
  submissionId: string,
  status: TypedActivityStatus,
  providedEnv?: Record<string, unknown>,
  resolveTarget: ObservedStatusTargetResolver = singletonObservedStatusTarget,
): Promise<void> {
  if (!isCloudflareTarget()) {
    return;
  }
  try {
    let env = providedEnv;
    if (!env) {
      const { getCloudflareContext } = await import('@flue/runtime/cloudflare');
      env = getCloudflareContext().env as Record<string, unknown> | undefined;
    }
    await resolveTarget(env, instanceId, submissionId).observedStatus(
      instanceId,
      submissionId,
      activityStatus(
        status.kind,
        status.action,
        status.object,
        status.family,
        status.phase,
      ),
    );
  } catch {
    // Outside a DO handler (no ALS context) or a transient RPC failure —
    // the status line simply skips this stage.
  }
}
