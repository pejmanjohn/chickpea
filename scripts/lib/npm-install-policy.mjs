import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// npmrc cannot express denials. This historical policy explicitly reviews all
// seven hooks, including the harmless hooks denied in newer package manifests.
// Strict mode must accompany it: npm 11 otherwise executes unreviewed hooks.
const LEGACY_POLICY = Object.freeze(Object.fromEntries([
  '@google/genai@1.52.0', '@mongodb-js/zstd@7.0.0', 'core-js-pure@3.49.0',
  'esbuild@0.28.1', 'node-liblzma@2.2.0', 'protobufjs@7.6.5', 'workerd@1.20260815.1',
].map((spec) => [spec, true])));
const LEGACY_SOURCES = [{
  version: '0.1.16', commit: '42d0bf4b1aa85cb9946bdd8b9d8dea8aae2ffdbf',
  manifest: 'be5677e4b565210729e3733a663dff8d8c795a68cc47d4759b2bff87ef379617',
  lock: 'a24a713f323a48db9d1ab714f8458f71f597b8dede8e32ae1e5c0fc6d7db6e11',
}];
const EXACT_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

/** The caller verifies release provenance before entering and after npm ci. */
export function resolveNpmInstallPolicy(checkout, source) {
  const manifestBytes = readFileSync(path.join(checkout, 'package.json'));
  const lockBytes = readFileSync(path.join(checkout, 'package-lock.json'));
  const manifest = JSON.parse(manifestBytes);
  const lock = JSON.parse(lockBytes);
  const authored = manifest.allowScripts;
  let policy;
  let legacy = false;
  if (authored && typeof authored === 'object' && !Array.isArray(authored) && Object.keys(authored).length) {
    policy = authored;
  } else {
    const known = LEGACY_SOURCES.find((entry) => entry.version === source?.version && entry.commit === source?.commit &&
      entry.manifest === digest(manifestBytes) && entry.lock === digest(lockBytes));
    if (!known) throw fail('NPM_POLICY_UNKNOWN', 'This release has no matching reviewed dependency policy. Use a release with authored allowScripts or an updated Chickpea updater; do not edit retained source.');
    policy = LEGACY_POLICY;
    legacy = true;
  }
  for (const [spec, allowed] of Object.entries(policy)) {
    if (!EXACT_SPEC.test(spec) || typeof allowed !== 'boolean') {
      throw fail('NPM_POLICY_INVALID', 'Dependency approvals must name exact package versions with explicit true or false values.');
    }
  }
  if (!lock.packages || typeof lock.packages !== 'object') throw fail('NPM_POLICY_INVALID', 'A reviewed lockfile is required.');
  for (const [location, pkg] of Object.entries(lock.packages)) {
    if (!location.includes('node_modules/') || !pkg.hasInstallScript || pkg.link) continue;
    let name;
    try {
      const url = new URL(pkg.resolved);
      const segments = decodeURIComponent(url.pathname.split('/-/')[0]).split('/');
      const last = segments.at(-1);
      name = segments.at(-2)?.startsWith('@') ? `${segments.at(-2)}/${last}` : last;
      if (!['https:', 'http:'].includes(url.protocol) || !url.pathname.endsWith(`/-/${last}-${pkg.version}.tgz`)) throw new Error();
    } catch { throw fail('NPM_POLICY_INVALID', 'A dependency hook has an unreviewed source identity.'); }
    if (!Object.hasOwn(policy, `${name}@${pkg.version}`)) {
      throw fail('NPM_POLICY_INCOMPLETE', 'A locked dependency hook lacks an exact approval or denial. Review the release policy before installing.');
    }
  }
  return { policy, legacy };
}

function npmRead(args, { checkout, env, npmExecPath }) {
  const result = npmExecPath
    ? spawnSync(process.execPath, [npmExecPath, ...args], { cwd: checkout, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 256 * 1024 })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: checkout, env, encoding: 'utf8', timeout: 20_000, maxBuffer: 256 * 1024 });
  if (result.error || result.status !== 0) throw fail('NPM_CONFIG_UNAVAILABLE', 'Unable to read npm configuration. Check the npm installation and selected userconfig.');
  return result.stdout;
}

function readUserConfig(file) {
  try {
    // Resolve symlinks before checking the size/type of the file we will read.
    const resolved = realpathSync(file);
    if (process.platform !== 'win32' && resolved === '/dev/null') return '';
    const stat = lstatSync(resolved);
    if (!stat.isFile()) throw new Error();
    if (stat.size > 256 * 1024) throw new Error();
    return readFileSync(resolved, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw fail('NPM_CONFIG_UNAVAILABLE', 'Unable to read the selected npm userconfig safely.');
  }
}

function inside(candidate, directory) {
  const relative = path.relative(realpathSync(directory), candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Copy the selected user layer without moving credentials into retained source. */
export function createPrivateNpmUserconfig({ userconfig, approved, checkout, receiptRoot, temporaryRoot = tmpdir() }) {
  if (typeof userconfig !== 'string' || !path.isAbsolute(userconfig)) throw fail('NPM_CONFIG_UNAVAILABLE', 'npm did not identify its selected userconfig.');
  if (!approved.every((spec) => EXACT_SPEC.test(spec))) throw fail('NPM_POLICY_INVALID', 'Private approvals must name exact package versions.');
  const original = readUserConfig(userconfig);
  const directory = realpathSync(mkdtempSync(path.join(temporaryRoot, 'chickpea-npm-install-')));
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  try {
    chmodSync(directory, 0o700);
    if (inside(directory, checkout) || (receiptRoot && inside(directory, receiptRoot))) {
      throw fail('NPM_CONFIG_LOCATION_INVALID', 'Select a temporary directory outside the retained source and receipt directories.');
    }
    const file = path.join(directory, 'npmrc');
    // Keep credentials, paths and literal substitutions byte-for-byte. npm
    // reads them in its ordinary config cascade; only the policy is added.
    writeFileSync(file, `${original}\n${approved.map((spec) => `allow-scripts[]=${spec}`).join('\n')}\n`, { mode: 0o600 });
    return { file, dispose };
  } catch (error) { dispose(); throw error; }
}

/** Configuration only: all dependency commands stay in the verified updater. */
export function prepareNpmInstallPolicy(options) {
  const { checkout, source, receiptRoot } = options;
  const env = { ...(options.env ?? process.env) };
  const { policy, legacy } = resolveNpmInstallPolicy(checkout, source);
  for (const [key, value] of Object.entries(env)) {
    if (/^npm_config_allow[_-]scripts$/i.test(key) && value) {
      throw fail('NPM_POLICY_CONFLICT', 'npm rejects environment allow-scripts overrides for project installs. Remove that override for this operation.');
    }
  }
  const context = { checkout, env, npmExecPath: options.npmExecPath ?? env.npm_execpath };
  const version = npmRead(['--version'], context).trim();
  const parsedVersion = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!parsedVersion || Number(parsedVersion[1]) !== 11 || Number(parsedVersion[2]) < 19) {
    throw fail('NPM_VERSION_UNSUPPORTED', 'Use npm 11.19.0 or a compatible newer npm 11 version; the pinned Node 24 baseline includes npm 11.19.0.');
  }
  let config;
  try { config = JSON.parse(npmRead(['config', 'list', '--json'], context)); }
  catch { throw fail('NPM_CONFIG_UNAVAILABLE', 'Unable to read npm configuration. No dependencies were installed.'); }
  if (config['ignore-scripts'] !== false || config['dangerously-allow-all-scripts'] === true) {
    throw fail('NPM_POLICY_CONFLICT', 'Remove ignore-scripts or dangerously-allow-all-scripts for this operation so the reviewed policy can run.');
  }
  const configured = (Array.isArray(config['allow-scripts']) ? config['allow-scripts'] : [config['allow-scripts'] ?? ''])
    .flatMap((entry) => String(entry).split(',')).map((entry) => entry.trim()).filter(Boolean);
  const approved = Object.entries(policy).filter(([, allowed]) => allowed).map(([spec]) => spec).sort();
  if (configured.length && JSON.stringify([...new Set(configured)].sort()) !== JSON.stringify(approved)) {
    throw fail('NPM_POLICY_CONFLICT', 'An existing npm script policy conflicts with this release. Select a userconfig without that override; preserve its registry and authentication settings.');
  }
  let sidecar;
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  const dispose = () => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    sidecar?.dispose();
    sidecar = undefined;
  };
  const args = ['--strict-allow-scripts'];
  try {
    if (legacy) {
      sidecar = createPrivateNpmUserconfig({ userconfig: config.userconfig, approved, checkout, receiptRoot, temporaryRoot: options.temporaryRoot });
      args.push('--userconfig', sidecar.file);
    }
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    return { args, env, signal: controller.signal, dispose, version, legacy };
  } catch (error) { dispose(); throw error; }
}
