import { env } from 'cloudflare:workers';

import { isPublicAssetPath } from './public-assets.ts';

export async function readPublicAsset(path: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!isPublicAssetPath(path)) throw new Error('Unknown public asset');
  // This is a binding call, not a public fetch. It also works from an Agent's
  // Durable Object, where there is no incoming browser URL to use as a base.
  const response = await env.ASSETS.fetch(`https://chickpea-assets.invalid/${path}`);
  if (!response.ok) throw new Error(`Public asset unavailable (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}
