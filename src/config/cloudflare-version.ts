import type { PlatformEnv } from './state-backend.ts';

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
