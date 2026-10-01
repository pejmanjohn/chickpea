import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Packages whose installed version (npm's node_modules/.package-lock.json)
 * differs from package-lock.json. Optional packages are platform-dependent and
 * skipped; a missing hidden lockfile reports one entry.
 */
export function lockfileDrift(root) {
  const hidden = path.join(root, 'node_modules', '.package-lock.json');
  if (!existsSync(hidden)) return [{ name: 'node_modules/.package-lock.json', locked: 'present', installed: 'missing' }];
  const locked = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages ?? {};
  const installed = JSON.parse(readFileSync(hidden, 'utf8')).packages ?? {};
  const drift = [];
  for (const [key, entry] of Object.entries(locked)) {
    if (!key.startsWith('node_modules/') || entry.optional || (entry.devOptional && !installed[key])) continue;
    if (installed[key]?.version !== entry.version) {
      drift.push({ name: key.slice('node_modules/'.length), locked: entry.version, installed: installed[key]?.version ?? 'missing' });
    }
  }
  return drift;
}

/** One sentence for a drift list, shared by the regression gate and the guarded deploy. */
export function staleDependenciesMessage(drift, consequence = '') {
  const sample = drift.slice(0, 3).map(({ name, locked, installed }) => `${name} ${installed} (locked ${locked})`).join(', ');
  return `STALE_DEPENDENCIES: node_modules does not match package-lock.json for ${drift.length} package(s): ${sample}. ` +
    `Run npm ci --strict-allow-scripts with the repository Node version, then retry.${consequence ? ` ${consequence}` : ''}`;
}
