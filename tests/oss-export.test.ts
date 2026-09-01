import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function filesBelow(path: string): string[] {
  const absolute = resolve(ROOT, path);
  return readdirSync(absolute, { recursive: true })
    .map((entry) => resolve(absolute, String(entry)))
    .filter((entry) => statSync(entry).isFile())
    .map((entry) => relative(ROOT, entry).replaceAll('\\', '/'))
    .sort();
}

function packFiles(): Set<string> {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(result.stdout) as Array<{ files?: Array<{ path: string }> }>;
  return new Set(manifest[0]?.files?.map(({ path }) => path) ?? []);
}

test('npm package includes every public live verifier file and discovery entrypoint', () => {
  const packaged = packFiles();
  const required = [
    'AGENTS.md',
    'docs/runbooks/live-contract-verification.md',
    ...filesBelow('qa/live'),
  ];
  assert.deepEqual(required.filter((path) => !packaged.has(path)), []);

  const packageJson = JSON.parse(read('package.json')) as { files?: string[] };
  assert.ok(packageJson.files?.includes('AGENTS.md'));
  assert.ok(packageJson.files?.includes('qa/live'));
  assert.ok(packageJson.files?.includes('docs/runbooks/live-contract-verification.md'));
});

test('public verifier files are not ignored and private artifact shapes are not packaged', () => {
  for (const path of [
    'AGENTS.md',
    'qa/live/operator/SKILL.md',
    'qa/live/generated/feature-map.md',
    'docs/runbooks/live-contract-verification.md',
  ]) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', path], { cwd: ROOT });
    assert.equal(result.status, 1, `${path} is ignored`);
  }

  const forbidden = [...packFiles()].filter((path) =>
    /^qa\/live\/(?:artifacts|evidence|private|resolved|runs|screenshots|transcripts)(?:\/|$)/i.test(path) ||
    /^qa\/live\/.*(?:\.journal\.jsonl|\.snapshot\.json|\.target\.json|\.transcript\.txt)$/i.test(path)
  );
  assert.deepEqual(forbidden, []);
});

test('operator skill stays small, discoverable, and separate from contract assertions', () => {
  const skill = read('qa/live/operator/SKILL.md');
  const agents = read('AGENTS.md');
  const readme = read('README.md');
  assert.ok(skill.split('\n').length <= 120);
  assert.match(skill, /^---\nname: chickpea-live-verification\n/);
  assert.match(skill, /docs\/runbooks\/live-contract-verification\.md/);
  assert.doesNotMatch(skill, /\bLC-\d{2}\b|\b(?:xox[baprs]-|sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}/);
  assert.match(agents, /qa\/live\/operator\/SKILL\.md/);
  assert.match(readme, /copy `qa\/live\/operator`.+`chickpea-live-verification`/);
});
