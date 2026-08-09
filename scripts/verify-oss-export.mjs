#!/usr/bin/env node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  lstatSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, extname, join, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'chickpea-export-'));

const term = (...parts) => parts.join('');
const exportPath = (...parts) => posix.join(...parts);
const localUserPathPattern = new RegExp(
  term('(?<![-A-Za-z0-9._/])', '\\/', 'users', '\\/', '[^\\/\\s]+', '\\/'),
  'i',
);

const denyPatterns = [
  ['private source project', new RegExp(term('ski', 'llet'), 'i')],
  ['deleted source path', new RegExp(term('docs', '\\/', 'sou', 'rce'), 'i')],
  ['internal product name', new RegExp(term('claude', '[- ]?', 'tag'), 'i')],
  ['private workspace name', new RegExp(term('paper', 'plane'), 'i')],
  ['private company name', new RegExp(term('mag', 'oosh'), 'i')],
  ['private channel name', new RegExp(term('all-', 'paper', 'plane-', 'labs'), 'i')],
  // Require both a home-directory owner and a following path segment. This
  // catches case-insensitive macOS paths while allowing `/users/...` API route
  // segments whose preceding character is part of a URL path.
  ['local user path', localUserPathPattern],
];

// `canary` is public rollout vocabulary used by the ledger authority contract,
// so it cannot also serve as a generic private rehearsal marker.

for (const value of [
  term('/', 'Users', '/', 'alice', '/', 'code/project'),
  term('/', 'users', '/', 'bob', '/', '.codex/state'),
]) {
  if (!localUserPathPattern.test(value)) {
    throw new Error(`Local user path deny fixture did not match: ${value}`);
  }
}
for (const value of [
  term('/api/1.0/', 'users', '/', 'me'),
  term('/api/v2/', 'users', '/', 'me.json'),
  term('https://gmail.googleapis.com/gmail/v1/', 'users', '/', 'me/messages'),
]) {
  if (localUserPathPattern.test(value)) {
    throw new Error(`API route allow fixture matched local user path pattern: ${value}`);
  }
}

// These paths are local agent/tool state or internal working material, not
// public source. `.github/` and `design/` are deliberately absent: both are
// tracked parts of the public repository even though npm does not package them.
const forbiddenSourcePathRoots = [
  exportPath('.agents'),
  exportPath('.claude'),
  exportPath('.codex'),
  exportPath('.gstack'),
  exportPath('.superpowers'),
  exportPath('tmp'),
];

const allowedPublicDocs = new Set([
  exportPath('docs', 'architecture', 'agent-runtime-boundary.md'),
  exportPath('docs', 'authentication.md'),
  exportPath('docs', 'plans', '2026-07-28-001-feat-openai-subscription-auth-plan.md'),
  exportPath('docs', 'runbooks', 'access-recovery.md'),
  exportPath('docs', 'runbooks', 'auth-db-upgrade.md'),
  exportPath('docs', 'runbooks', 'coding-sandbox-deployment.md'),
  exportPath('docs', 'runbooks', 'password-recovery.md'),
  exportPath('docs', 'runbooks', 'agent-runtime-rollout.md'),
  exportPath('docs', 'runbooks', 'openai-subscription.md'),
  exportPath('docs', 'runbooks', 'slack-interaction-operations.md'),
]);

const forbiddenSourcePaths = new Set([
  exportPath('.worktreeinclude'),
  exportPath('design-qa.md'),
]);

const forbiddenBinaryExtensions = new Set([
  '.avif',
  '.gif',
  '.heic',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp4',
  '.pdf',
  '.png',
  '.webp',
]);

const allowedBinaryFiles = new Map([
  [
    exportPath('assets', 'bot-avatar.png'),
    '3cee85ef83c9132393b57ef52ce73dcd3f2b1724a71f1fa8ef37dafd6f5ecdb4',
  ],
  [
    exportPath('assets', 'admin-page.png'),
    '68c94f054f6492300e77c62304f896735ef2fc3c81a37225c9539f179c073098',
  ],
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed with exit ${result.status}`);
  }
  return result;
}

function capture(command, args, options = {}) {
  if (!options.quiet) {
    console.log(`$ ${[command, ...args].join(' ')}`);
  }
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString('utf8') ?? '';
    fail(`${command} ${args.join(' ')} failed with exit ${result.status}: ${detail}`);
  }
  return result.stdout;
}

function readTrackedManifest() {
  const sourceCommit = capture('git', ['rev-parse', '--verify', 'HEAD^{commit}'])
    .toString('utf8')
    .trim();
  if (!/^[0-9a-f]{40,64}$/.test(sourceCommit)) {
    fail(`git rev-parse returned an invalid commit id: ${sourceCommit}`);
  }

  const output = capture('git', [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    sourceCommit,
  ]);
  const decoded = output.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(output)) {
    fail('Tracked source manifest contains a non-UTF-8 path');
  }

  const records = decoded.split('\0');
  if (records.pop() !== '') {
    fail('git ls-tree returned a non-NUL-terminated manifest');
  }

  const seen = new Set();
  const entries = records.map((record) => {
    const separator = record.indexOf('\t');
    if (separator < 0) {
      fail(`Malformed git ls-tree record: ${record}`);
    }

    const [mode, type, object, ...extra] = record.slice(0, separator).split(' ');
    const path = record.slice(separator + 1);
    if (!mode || !type || !object || extra.length > 0) {
      fail(`Malformed git ls-tree metadata for ${path || '<empty path>'}`);
    }
    if (!/^[0-9a-f]{40,64}$/.test(object)) {
      fail(`Malformed git object id for ${path || '<empty path>'}: ${object}`);
    }
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) {
      fail(`${path}: unsupported tracked entry (${mode} ${type})`);
    }
    if (
      path.length === 0 ||
      path.includes('\\') ||
      posix.normalize(path) !== path ||
      path.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      fail(`Tracked source manifest contains an unsafe path: ${path}`);
    }
    if (seen.has(path)) {
      fail(`Tracked source manifest contains a duplicate path: ${path}`);
    }
    seen.add(path);
    return { mode, object, path };
  });

  assertNoPathCollisions(entries);
  return { entries, sourceCommit };
}

function assertNoPathCollisions(entries) {
  const aliases = new Map();
  for (const { path } of entries) {
    const alias = path.normalize('NFC').toLowerCase().normalize('NFC');
    const existing = aliases.get(alias);
    if (existing && existing !== path) {
      fail(`Tracked source paths alias on common filesystems: ${existing} and ${path}`);
    }
    aliases.set(alias, path);
  }
}

function assertPublicSourceManifest(entries) {
  const forbidden = entries.filter(
    ({ path }) => {
      const normalizedPath = path.toLowerCase();
      return (
        forbiddenSourcePaths.has(normalizedPath) ||
        (normalizedPath.startsWith('docs/') && !allowedPublicDocs.has(normalizedPath)) ||
        forbiddenSourcePathRoots.some(
          (root) =>
            normalizedPath === root || normalizedPath.startsWith(`${root}/`),
        )
      );
    },
  );
  if (forbidden.length > 0) {
    fail(
      [
        'OSS export contains forbidden public-source paths:',
        ...forbidden.map(({ path }) => path),
      ].join('\n'),
    );
  }
}

function extractHeadArchive(sourceCommit) {
  run('sh', [
    '-c',
    'git archive --format=tar "$1" | tar -x -C "$2"',
    'verify-oss-export',
    sourceCommit,
    scratch,
  ]);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function scanExportTree(entries) {
  const findings = [];
  const blobs = new Map();
  for (const { object, path: rel } of entries) {
    let buffer = blobs.get(object);
    if (!buffer) {
      buffer = capture('git', ['cat-file', 'blob', object], { quiet: true });
      blobs.set(object, buffer);
    }

    const file = join(scratch, rel);
    let fileStat;
    try {
      fileStat = lstatSync(file);
    } catch (error) {
      findings.push(`${rel}: tracked archive entry is missing (${error.code ?? error.message})`);
    }
    if (fileStat && !fileStat.isFile()) {
      findings.push(`${rel}: unsupported non-file archive entry`);
    } else if (fileStat) {
      const extracted = readFileSync(file);
      if (!extracted.equals(buffer)) {
        findings.push(`${rel}: archived bytes differ from tracked blob ${object}`);
      }
    }

    const extension = extname(rel).toLowerCase();
    const size = buffer.length;
    if (forbiddenBinaryExtensions.has(extension)) {
      const expectedHash = allowedBinaryFiles.get(rel);
      if (!expectedHash) {
        findings.push(`${rel}: forbidden binary/image extension ${extension}`);
        continue;
      }

      const actualHash = sha256(buffer);
      if (actualHash !== expectedHash) {
        findings.push(`${rel}: allowed binary hash mismatch (${actualHash})`);
      }
      continue;
    }

    if (size > 5_000_000) {
      findings.push(`${rel}: file is too large for text leak scanning (${size} bytes)`);
      continue;
    }

    if (buffer.includes(0)) {
      findings.push(`${rel}: binary content is not allowed in the OSS export`);
      continue;
    }

    const text = buffer.toString('utf8');
    for (const [label, pattern] of denyPatterns) {
      if (pattern.test(text)) {
        findings.push(`${rel}: matched denied term ${label}`);
      }
    }
  }

  if (findings.length > 0) {
    fail(`OSS export leak scan failed:\n${findings.join('\n')}`);
  }
}

function verifyNpmPackManifest() {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: scratch,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    fail(`npm pack manifest failed:\n${result.stderr || result.stdout}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(result.stdout);
  } catch {
    fail(`npm pack returned invalid JSON:\n${result.stdout}`);
  }
  const files = new Set((manifest[0]?.files ?? []).map((entry) => entry.path));
  const required = [
    '.dev.vars.example',
    '.env.example',
    'LICENSE',
    'README.md',
    'SETUP_AGENT.md',
    'assets/admin-page.png',
    'assets/bot-avatar.png',
    'assets/chickpea-mark.svg',
    'scripts/cloudflare-deployment-profile.mjs',
    'scripts/deploy-with-epilogue.mjs',
    'scripts/recover-auth.mjs',
    'docs/authentication.md',
    'docs/runbooks/access-recovery.md',
    'docs/runbooks/auth-db-upgrade.md',
    'docs/runbooks/coding-sandbox-deployment.md',
    'docs/runbooks/password-recovery.md',
    'migrations/better-auth/0001_better_auth.sql',
    'scripts/flue-build-cf.mjs',
    'scripts/generate-common-passwords.mjs',
    'slack-app-manifest.json',
    'src/app.ts',
    'src/cloudflare.ts',
    'src/auth/generated-common-passwords.license.txt',
    'vite.config.ts',
    'vite.node.config.ts',
    'wrangler.jsonc',
  ];
  const missing = required.filter((path) => !files.has(path));
  const forbidden = [...files].filter(
    (path) =>
      path === '.worktreeinclude' ||
      path.startsWith('.claude/') ||
      path.startsWith('.github/') ||
      path.startsWith('design/') ||
      (path.startsWith('docs/') && !allowedPublicDocs.has(path)) ||
      path.startsWith('tmp/'),
  );
  if (missing.length > 0 || forbidden.length > 0) {
    fail(
      [
        'npm package manifest is not release-clean:',
        ...missing.map((path) => `missing required file: ${path}`),
        ...forbidden.map((path) => `forbidden packaged file: ${path}`),
      ].join('\n'),
    );
  }
}

function verifyAuthenticationExportContract(packageJson) {
  const bindings = packageJson.cloudflare?.bindings ?? {};
  if (JSON.stringify(Object.keys(bindings).sort()) !== JSON.stringify(['CHICKPEA_RECOVERY_TOKEN'])) {
    fail('Deploy metadata must prompt only for CHICKPEA_RECOVERY_TOKEN');
  }
  const recovery = readFileSync(join(scratch, 'scripts', 'recover-auth.mjs'), 'utf8');
  if (/\bfetch\s*\(/.test(recovery) || /node:https/.test(recovery)) {
    fail('Token-mode recovery must remain an operator-side state command with no HTTP transport');
  }
  const identityTypes = readFileSync(join(scratch, 'src', 'identity', 'types.ts'), 'utf8');
  if (!identityTypes.includes("Omit<Invitation, 'tokenHash' | 'normalizedEmail'>") ||
      !identityTypes.includes("Omit<PersonalTokenRecord, 'tokenHash'>") ||
      !identityTypes.includes("Omit<BrowserSessionRecord, 'sessionHash'>")) {
    fail('Identity export summary must omit invitation, personal-token, and session hashes');
  }
  const example = readFileSync(join(scratch, '.dev.vars.example'), 'utf8');
  if (!/CHICKPEA_RECOVERY_TOKEN=""/.test(example)) {
    fail('Cloudflare recovery example must keep the credential value empty');
  }
  const activeExampleKeys = example.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => line.slice(0, line.indexOf('=')));
  if (JSON.stringify(activeExampleKeys) !== JSON.stringify(['CHICKPEA_RECOVERY_TOKEN'])) {
    fail('Cloudflare Deploy example must expose exactly one active recovery-secret prompt');
  }
  const wrangler = readFileSync(join(scratch, 'wrangler.jsonc'), 'utf8');
  if (/"vars"\s*:/.test(wrangler)) {
    fail('Cloudflare Deploy config must not expose runtime defaults as customer-editable fields');
  }
  if (!/"binding"\s*:\s*"AUTH_DB"/.test(wrangler) ||
      !/"migrations_dir"\s*:\s*"migrations\/better-auth"/.test(wrangler)) {
    fail('Cloudflare config must bind AUTH_DB to the reviewed Better Auth migrations');
  }
  const publicAuthCopy = [
    readFileSync(join(scratch, 'README.md'), 'utf8'),
    readFileSync(join(scratch, 'docs', 'authentication.md'), 'utf8'),
  ].join('\n');
  if (/Cloudflare Access is the default|Choose \*\*new Zero Trust organization\*\*/i.test(publicAuthCopy)) {
    fail('Public authentication copy still describes Access as the fresh-install default');
  }
  if (/BETTER_AUTH_SECRET\s*=/.test(publicAuthCopy + example)) {
    fail('Public setup material must not expose or request a Better Auth secret');
  }
}

let passed = false;
try {
  console.log(`SCRATCH=${scratch}`);
  const { entries, sourceCommit } = readTrackedManifest();
  assertPublicSourceManifest(entries);
  extractHeadArchive(sourceCommit);
  // GitHub is the distribution surface, so scan every tracked source entry
  // before any package-specific checks.
  // Only immutable HEAD entries are scanned, so npm-generated scratch content
  // cannot expand or otherwise change the source scan's scope.
  scanExportTree(entries);

  if (!existsSync(join(scratch, 'LICENSE'))) {
    fail('Export is missing LICENSE');
  }

  const packageJson = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'));
  if (packageJson.private !== true || !packageJson.description || packageJson.license !== 'MIT' || !packageJson.repository) {
    fail('Export package.json must remain private and include its source metadata');
  }

  verifyAuthenticationExportContract(packageJson);

  verifyNpmPackManifest();

  run('npm', ['ci'], { cwd: scratch });
  run('npm', ['run', 'test:ci'], { cwd: scratch });
  run('node', ['scripts/verify-flue-offline-turn.mjs'], { cwd: scratch });
  run('npm', ['run', 'verify:durability'], { cwd: scratch });
  run('npm', ['run', 'verify:providers'], { cwd: scratch });
  // The default source export is the slim core profile, so its full build and
  // Wrangler dry run must succeed without a Docker-specific escape hatch.
  run('npm', ['run', 'deploy', '--', '--dry-run'], { cwd: scratch });

  console.log('OSS export verification passed');
  passed = true;
} finally {
  if (passed && process.env.KEEP_EXPORT_SCRATCH !== '1') {
    rmSync(scratch, { recursive: true, force: true });
    console.log(`Cleaned SCRATCH=${scratch}`);
  } else {
    console.log(`Export scratch preserved at ${scratch}`);
  }
}
