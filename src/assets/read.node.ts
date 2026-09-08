import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { isPublicAssetPath } from './public-assets.ts';

export async function readPublicAsset(path: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!isPublicAssetPath(path)) throw new Error('Unknown public asset');
  // Like migrations and the runtime environment, assets belong to the release
  // checkout. Production runs with that checkout as its working directory.
  return Uint8Array.from(await readFile(resolve('assets', path)));
}
