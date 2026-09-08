import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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
