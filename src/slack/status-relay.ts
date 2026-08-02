import { isCloudflareTarget } from '../config/runtime-target.ts';
import { tagStateStub } from '../config/state-rpc.ts';

/**
 * Cloudflare only: the durable agent runs in its own DO isolate, while the
 * live turn's status registry lives in the TagStateStore alarm isolate — an
 * observed activity can never hit the local Map there. Relay the already
 * sanitized status text to the singleton state DO, which routes it into ITS
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
  statusText: string,
  providedEnv?: Record<string, unknown>,
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
    await tagStateStub(env).observedStatus(instanceId, submissionId, statusText);
  } catch {
    // Outside a DO handler (no ALS context) or a transient RPC failure —
    // the status line simply skips this stage.
  }
}
