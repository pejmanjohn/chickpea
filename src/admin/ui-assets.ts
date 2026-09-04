import { readPublicAsset } from '#chickpea-assets';

import { ADMIN_UI_ASSET_PATHS } from '../assets/public-assets.ts';
import { fnv1aHash } from '../slack/agent-presence/hash.ts';

export {
  ADMIN_UI_ASSET_PATHS,
  ADMIN_UI_SCRIPT_PATH,
  ADMIN_UI_STYLESHEET_PATH,
} from '../assets/public-assets.ts';

export function adminUiAssetUrl(path: string, version: string): string {
  return `/${path}?v=${encodeURIComponent(version)}`;
}

let cachedVersion: Promise<string> | undefined;

/**
 * Content hash of the shipped script and stylesheet. Assets are served with a
 * public cache lifetime, so the shell (which is never cached) must reference
 * the exact bytes deployed alongside it.
 */
export function adminUiAssetVersion(): Promise<string> {
  cachedVersion ??= (async () => {
    const hashes = await Promise.all(ADMIN_UI_ASSET_PATHS.map(async (path) => {
      const bytes = await readPublicAsset(path);
      let hash = 0x811c9dc5;
      for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
      return hash.toString(16).padStart(8, '0');
    }));
    return fnv1aHash(hashes.join(':')).toString(16).padStart(8, '0');
  })().catch((error: unknown) => {
    cachedVersion = undefined;
    throw error;
  });
  return cachedVersion;
}
