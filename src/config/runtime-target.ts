/**
 * Cloudflare-target detection, per the workers runtime's stable self
 * identification. This is a RUNTIME check (not build-time): the same modules
 * are bundled for both targets and pick their backend on first use. Kept in
 * its own leaf module so light consumers (model policy, provider availability)
 * can branch on the target without importing the whole store stack.
 */
export function isCloudflareTarget(): boolean {
  return globalThis.navigator?.userAgent === 'Cloudflare-Workers';
}

export type CloudflareBuildSource = 'workers-builds' | 'command' | 'unknown';

/**
 * How the running Cloudflare Worker was built, recorded at build time. Admin
 * uses it only to pick which redeploy steps to show first; `unknown` (Node,
 * a Vite serve lane, or direct source execution) shows both paths.
 */
export function cloudflareBuildSource(): CloudflareBuildSource {
  if (typeof __CHICKPEA_CLOUDFLARE_BUILD_SOURCE__ === 'undefined') return 'unknown';
  const value: string = __CHICKPEA_CLOUDFLARE_BUILD_SOURCE__;
  return value === 'workers-builds' || value === 'command' ? value : 'unknown';
}
