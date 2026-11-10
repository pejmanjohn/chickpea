import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readBuildIdentity } from './build-identity.mjs';

// Vite chooses the output directory from the Worker name. Follow the same
// redirect Wrangler consumes instead of guessing that directory's spelling.
export function builtWorkerConfigPath(projectRoot) {
  const redirectPath = path.join(projectRoot, '.wrangler', 'deploy', 'config.json');
  if (!existsSync(redirectPath)) {
    throw new Error('Cloudflare build did not emit .wrangler/deploy/config.json. Run the build first.');
  }
  const redirect = JSON.parse(readFileSync(redirectPath, 'utf8'));
  if (typeof redirect.configPath !== 'string' || redirect.configPath.length === 0) {
    throw new Error('Cloudflare deploy redirect has no configPath.');
  }
  const configPath = path.resolve(path.dirname(redirectPath), redirect.configPath);
  const relativeConfig = path.relative(path.join(projectRoot, 'dist-cf'), configPath);
  if (relativeConfig === '..' || relativeConfig.startsWith(`..${path.sep}`) || path.isAbsolute(relativeConfig)) {
    throw new Error(`Cloudflare deploy config escaped dist-cf: ${configPath}`);
  }
  if (!existsSync(configPath)) throw new Error(`Cloudflare deploy config is missing: ${configPath}`);
  return configPath;
}

/**
 * Why dist-cf is not a build of this checkout, or undefined when it is. Each
 * build stamps its Worker config with the commit it was built from
 * (CHICKPEA_SOURCE_COMMIT, from build-identity.mjs); a lane deploy or an
 * earlier build leaves dist-cf behind when the checkout moves to another
 * commit. Uncommitted edits made after a build are not detected.
 */
export function staleBuildReason(projectRoot) {
  let configPath;
  try {
    configPath = builtWorkerConfigPath(projectRoot);
  } catch (error) {
    return error.message;
  }
  const built = JSON.parse(readFileSync(configPath, 'utf8')).vars?.CHICKPEA_SOURCE_COMMIT;
  const current = readBuildIdentity(projectRoot).sourceCommit;
  if (!current) return 'This checkout has no source commit, so no build in dist-cf can be matched to it.';
  if (built !== current) {
    return `dist-cf was built from ${String(built).slice(0, 9)}, not this checkout's ${current.slice(0, 9)}. ` +
      'Run npm run build to check a build of this source.';
  }
  return undefined;
}
