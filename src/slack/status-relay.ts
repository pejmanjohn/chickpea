import { isCloudflareTarget } from '../config/runtime-target.ts';
import { tagStateStub } from '../config/state-rpc.ts';

/**
 * Cloudflare only: the durable agent runs in its own DO isolate, while the
 * live turn's status registry lives in the TagStateStore alarm isolate — an
 * observed tool_start can never hit the local Map there. Relay the tool name
 * to the singleton state DO, which routes it into ITS registry (where the
 * alarm registered the turn). On node the local registry always hits first,
 * so this is never called with work to do.
 *
 * Best-effort by contract: a dropped status update must never fail a turn, so
 * every miss (no ALS context, no binding, RPC failure) is swallowed.
 */
export async function relayObservedToolStatus(instanceId: string, toolName: string): Promise<void> {
  if (!isCloudflareTarget()) {
    return;
  }
  try {
    const { getCloudflareContext } = await import('@flue/runtime/cloudflare');
    const env = getCloudflareContext().env as Record<string, unknown> | undefined;
    if (!env || !('TAG_STATE' in env)) {
      return;
    }
    await tagStateStub(env).observedToolStatus(instanceId, toolName);
  } catch {
    // Outside a DO handler (no ALS context) or a transient RPC failure —
    // the status line simply skips this stage.
  }
}
