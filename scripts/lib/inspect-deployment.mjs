import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function deploymentFingerprint(versions) {
  return versions.map((version) => `${version.version_id.trim()}:${Number(version.percentage)}`).sort().join(',');
}

// The injectable boundary accepts only the read commands below. This module
// never edits a config, provisions a resource, or reads a secret's value.
export function createDeploymentInspector(run) {
  function json(args, label) {
    const result = run(args);
    if (result.error || result.status !== 0) throw new Error(`Unable to inspect ${label}. Check Cloudflare access; no deployment was attempted.`);
    try { return JSON.parse(result.stdout); } catch { throw new Error(`Unreadable ${label} inspection response.`); }
  }
  function worker() {
    const result = run(['secret', 'list', '--format', 'json']);
    if (!result.error && result.status !== 0 && /Worker\s+"[^"]+"[^\n]*not found/i.test(`${result.stdout}\n${result.stderr}`)) {
      return { exists: false, names: new Set() };
    }
    if (result.error || result.status !== 0) throw new Error('Unable to inspect Worker secrets. The deploy credential must allow secret listing before Chickpea can deploy safely.');
    let entries;
    try { entries = JSON.parse(result.stdout); } catch { throw new Error('Worker secret discovery returned an unreadable response.'); }
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry?.name !== 'string' || !entry.name)) throw new Error('Worker secret discovery returned an unexpected response.');
    return { exists: true, names: new Set(entries.map((entry) => entry.name)) };
  }
  function active() {
    const deployment = json(['deployments', 'status', '--json'], 'the active Worker deployment');
    const versions = Array.isArray(deployment?.versions) ? deployment.versions.filter((version) => Number(version?.percentage) > 0) : [];
    if (!versions.length || versions.some((version) => typeof version.version_id !== 'string' || !version.version_id.trim() || !Number.isFinite(Number(version.percentage)))) {
      throw new Error('Active Worker deployment discovery returned no readable serving versions.');
    }
    return versions;
  }
  function version(id) { return json(['versions', 'view', id, '--json'], 'active Worker version bindings'); }
  function inspect() {
    const remote = worker();
    if (!remote.exists) return { exists: false, secretNames: [], versions: [], bindings: [], fingerprint: '' };
    const versions = active();
    const details = versions.map((entry) => version(entry.version_id));
    if (details.some((entry) => !Array.isArray(entry?.resources?.bindings))) throw new Error('Unreadable Worker resource inventory.');
    const bindings = details[0].resources.bindings;
    // The script-wide secrets endpoint can briefly return an empty inventory
    // after versions upload, while the serving version retains its secrets.
    // Bind authority to the same exact version as the rest of this inventory.
    const secretNames = bindings.filter((binding) => binding?.type === 'secret_text').map((binding) => binding.name).sort();
    return { exists: true, secretNames, versions, fingerprint: deploymentFingerprint(versions), bindings, details };
  }
  return { worker, active, version, inspect };
}

export function wranglerInspector({ root, configPath, args = [], env = process.env, timeout = 30_000 }) {
  return createDeploymentInspector((command) => spawnSync(process.execPath,
    [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), ...command, '--config', configPath, ...args],
    { cwd: root, env, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 }));
}
