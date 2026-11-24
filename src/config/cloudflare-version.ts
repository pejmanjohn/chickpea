import type { PlatformEnv } from './state-backend.ts';
import { tagStateStub } from './state-rpc.ts';

interface WorkerVersionMetadataBinding {
  id?: unknown;
}

const CLOUDFLARE_VERSION_METADATA_BINDING = 'CF_VERSION_METADATA';

export function cloudflareWorkerVersionId(rawEnv: unknown): string | undefined {
  const env = rawEnv as PlatformEnv | undefined;
  const metadata = env?.[CLOUDFLARE_VERSION_METADATA_BINDING] as
    | WorkerVersionMetadataBinding
    | undefined;
  return typeof metadata?.id === 'string' && metadata.id.trim()
    ? metadata.id.trim()
    : undefined;
}

/**
 * Whether this installation's state store runs the Worker version serving
 * this request. A deploy leaves the store on the code before for minutes,
 * and the store applies every change made through Chickpea in Slack. With no
 * version to compare (Node) there is one process, so it does.
 */
export async function stateStoreRunsThisVersion(rawEnv: unknown): Promise<boolean> {
  const version = cloudflareWorkerVersionId(rawEnv);
  if (!version) return true;
  try {
    const serving = await tagStateStub(rawEnv as PlatformEnv).threadRunnerTurn({ kind: 'servingVersion' });
    return serving.ok && serving.value === version;
  } catch {
    return false;
  }
}
