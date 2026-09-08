import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Also protect source exports and symlinks into any Git worktree. */
export function outsideGit(input, sourceRoot = SOURCE) {
  if (!isAbsolute(input)) throw new Error('Evidence paths must be absolute.');
  let existing = resolve(input);
  while (!existsSync(existing)) existing = dirname(existing);
  const canonical = resolve(realpathSync(existing), relative(existing, resolve(input)));
  const within = relative(realpathSync(sourceRoot), canonical);
  if (within === '' || (!isAbsolute(within) && within !== '..' && !within.startsWith(`..${sep}`))) {
    throw new Error('Evidence must be outside Git and the source checkout.');
  }
  let inGit = false;
  try {
    const directory = statSync(existing).isDirectory() ? realpathSync(existing) : dirname(realpathSync(existing));
    inGit = execFileSync('git', ['-C', directory, 'rev-parse', '--is-inside-work-tree'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === 'true';
  } catch { /* A private non-repository directory is expected. */ }
  if (inGit) throw new Error('Evidence must be outside Git, including through symlinks.');
  return canonical;
}
