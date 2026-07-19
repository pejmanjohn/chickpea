#!/usr/bin/env node
/**
 * `npm run deploy` — build the current source, run wrangler deploy, then print
 * a next-steps epilogue. Pass `--skip-build` only when a caller has just run
 * `npm run build` and wants to reuse that exact artifact.
 *
 * Workers Builds streams the build and deploy steps into one log that ends,
 * without this, at wrangler's own output: a raw workers.dev URL and no hint
 * that /admin is the next stop. Wrangler 4.x has no command that reports the
 * account's workers.dev subdomain, but `wrangler deploy` prints the deployed
 * URL on success — so tee its stdout, grep the URL, and append instructions.
 *
 * The epilogue is additive: wrangler's output passes through untouched, a
 * non-zero exit propagates unchanged with no epilogue (never dress up a
 * failed deploy), and stdout is scanned line-by-line rather than buffered.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Invoke wrangler's bin with the current node (mirrors flue-build-cf.mjs):
// works whether or not node_modules/.bin is on PATH.
const wranglerBin = path.join(projectRoot, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const cliArgs = process.argv.slice(2);
const deployArgs = cliArgs.filter((arg) => arg !== '--skip-build');
const skipBuild = cliArgs.includes('--skip-build');

if (!skipBuild) {
  process.stdout.write('Building the Cloudflare artifact from current source...\n');
  const npmExecPath = process.env.npm_execpath;
  const buildCommand = npmExecPath
    ? [process.execPath, [npmExecPath, 'run', 'build']]
    : [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']];
  const build = spawnSync(buildCommand[0], buildCommand[1], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (build.error) {
    console.error(`Unable to start the Cloudflare build: ${build.error.message}`);
    process.exit(1);
  }
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }
}

const child = spawn(
  process.execPath,
  [wranglerBin, 'deploy', ...deployArgs],
  { cwd: projectRoot, stdio: ['inherit', 'pipe', 'inherit'] },
);

let deployedUrl = '';
let tail = '';
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  // Line-oriented scan without unbounded buffering: keep only a joining tail
  // in case the URL straddles a chunk boundary.
  const text = tail + chunk.toString('utf8');
  const match = text.match(/https?:\/\/[^\s]+\.workers\.dev\b/);
  if (match && !deployedUrl) {
    deployedUrl = match[0];
  }
  tail = text.slice(-256);
});

/** Worker name from the built (redirected) config, falling back to the root config. */
function workerName() {
  const candidates = ['dist-cf', 'dist'];
  for (const dist of candidates) {
    const distDir = path.join(projectRoot, dist);
    if (!existsSync(distDir)) continue;
    try {
      for (const entry of readFileSync(path.join(projectRoot, '.wrangler', 'deploy', 'config.json'), 'utf8').matchAll(/"configPath"\s*:\s*"([^"]+)"/g)) {
        const configPath = path.resolve(path.join(projectRoot, '.wrangler', 'deploy'), entry[1]);
        const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
        if (typeof parsed.name === 'string') return parsed.name;
      }
    } catch {
      /* fall through to wrangler.jsonc */
    }
  }
  try {
    const raw = readFileSync(path.join(projectRoot, 'wrangler.jsonc'), 'utf8');
    const match = raw.match(/"name"\s*:\s*"([^"]+)"/);
    if (match) return match[1];
  } catch {
    /* unknown */
  }
  return 'chickpea';
}

const RULE = '────────────────────────────────────────────────────────';

child.on('close', (code) => {
  if (code !== 0) {
    process.exit(code ?? 1);
  }
  // A dry run deploys nothing — next-steps instructions would be a lie.
  if (deployArgs.includes('--dry-run')) {
    process.exit(0);
  }
  if (deployedUrl) {
    process.stdout.write(
      [
        '',
        RULE,
        '  ✔ Deployed. Chickpea is live.',
        '',
        '  Next steps:',
        `    1. Open  ${deployedUrl}/admin`,
        '    2. Sign in with the TAG_ADMIN_TOKEN you set at deploy time.',
        '    3. Click "Connect Slack" and follow the two steps.',
        '',
        '  New to the Slack side? Hand SETUP_AGENT.md to an AI agent,',
        '  or follow it yourself — it has the exact console click path.',
        RULE,
        '',
      ].join('\n'),
    );
  } else {
    process.stdout.write(
      [
        '',
        RULE,
        '  ✔ Deploy finished.',
        '',
        '  Your admin URL is:  https://<worker-name>.<your-subdomain>.workers.dev/admin',
        `    (worker name: ${workerName()} — find <your-subdomain> in the Cloudflare`,
        '     dashboard → Workers & Pages → your account subdomain)',
        '',
        '  Then: sign in with your TAG_ADMIN_TOKEN and click "Connect Slack".',
        RULE,
        '',
      ].join('\n'),
    );
  }
  process.exit(0);
});
