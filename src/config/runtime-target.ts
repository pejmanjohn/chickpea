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
