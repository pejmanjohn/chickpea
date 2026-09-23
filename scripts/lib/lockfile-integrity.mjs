// Every package-lock entry that npm downloads must carry a Subresource
// Integrity hash; `npm ci` verifies a tarball only against `integrity`.
import { readFileSync } from 'node:fs';

export function lockfileIntegrityReport(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (lock.lockfileVersion < 2) {
    throw new Error(`package-lock.json is lockfileVersion ${lock.lockfileVersion}; integrity verification needs version 2 or newer.`);
  }
  const packages = lock.packages ?? {};
  const unverified = [];
  for (const [name, meta] of Object.entries(packages)) {
    if (name === '') continue;
    if (meta.link || meta.inBundle) continue;
    // A workspace package's own entry (e.g. `packages/cli`) is local source,
    // not a downloaded tarball; its `node_modules/<name>` link is exempt above.
    if (!name.startsWith('node_modules/') && !name.includes('/node_modules/')) continue;
    if (typeof meta.integrity === 'string' && meta.integrity.length > 0) continue;
    unverified.push(name);
  }
  unverified.sort();
  return { total: Object.keys(packages).length - 1, unverified };
}
