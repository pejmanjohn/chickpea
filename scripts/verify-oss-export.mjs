#!/usr/bin/env node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, posix, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'slack-flue-export-'));

const term = (...parts) => parts.join('');
const exportPath = (...parts) => posix.join(...parts);
const sourceDocsPath = exportPath('docs', term('sou', 'rce'));
const rehearsalScreenshotPath = (prefix) =>
  exportPath('docs', term(prefix, 'can', 'ary-2026-06-29.png'));

const denyPatterns = [
  ['private source project', new RegExp(term('ski', 'llet'), 'i')],
  ['deleted source path', new RegExp(term('docs', '\\/', 'sou', 'rce'), 'i')],
  ['local package-manager path', new RegExp(term('\\/', 'opt', '\\/', 'home', 'brew'), 'i')],
  ['internal product name', new RegExp(term('claude', '[- ]?', 'tag'), 'i')],
  ['private workspace name', new RegExp(term('paper', 'plane'), 'i')],
  ['private company name', new RegExp(term('mag', 'oosh'), 'i')],
  ['private channel name', new RegExp(term('all-', 'paper', 'plane-', 'labs'), 'i')],
  ['local user path', new RegExp(term('\\/', 'Users', '\\/'), 'i')],
  ['live rehearsal marker', new RegExp(term('can', 'ary'), 'i')],
];

const excludedPaths = [
  sourceDocsPath,
  exportPath('docs', 'START_HERE.md'),
  rehearsalScreenshotPath('slack-assistant-ux-'),
  rehearsalScreenshotPath('slack-assistant-ux-ephemeral-'),
];

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

function extractHeadArchive() {
  run('sh', [
    '-c',
    'git archive --format=tar HEAD | tar -x -C "$1"',
    'verify-oss-export',
    scratch,
  ]);
}

function assertMissing(path) {
  if (existsSync(join(scratch, path))) {
    fail(`Export still contains excluded path: ${path}`);
  }
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, files);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function scanExportTree() {
  const findings = [];
  for (const file of walk(scratch)) {
    const rel = relative(scratch, file);
    const extension = extname(file).toLowerCase();
    if (forbiddenBinaryExtensions.has(extension)) {
      findings.push(`${rel}: forbidden binary/image extension ${extension}`);
      continue;
    }

    const size = statSync(file).size;
    if (size > 5_000_000) {
      findings.push(`${rel}: file is too large for text leak scanning (${size} bytes)`);
      continue;
    }

    const buffer = readFileSync(file);
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

let passed = false;
try {
  console.log(`SCRATCH=${scratch}`);
  extractHeadArchive();

  rmSync(join(scratch, 'docs', 'plans'), { recursive: true, force: true });
  rmSync(join(scratch, 'docs', 'decisions'), { recursive: true, force: true });

  if (!existsSync(join(scratch, 'LICENSE'))) {
    fail('Export is missing LICENSE');
  }

  for (const path of excludedPaths) {
    assertMissing(path);
  }

  const packageJson = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'));
  if (packageJson.private || !packageJson.description || packageJson.license !== 'MIT' || !packageJson.repository) {
    fail('Export package.json is missing publish metadata or still has private:true');
  }

  scanExportTree();

  run('npm', ['ci'], { cwd: scratch });
  run('npm', ['test'], { cwd: scratch });
  run('node', ['scripts/verify-flue-offline-turn.mjs'], { cwd: scratch });
  run('node', ['scripts/verify-durability.mjs'], { cwd: scratch });
  run('node', ['scripts/verify-tool-policy.mjs'], { cwd: scratch });
  run('node', ['scripts/verify-providers.mjs'], { cwd: scratch });

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
