import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
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
    '.agents/skills/chickpea-live-verification/SKILL.md',
    'AGENTS.md',
    'docs/runbooks/local-worker-development.md',
    'docs/runbooks/live-contract-acceptance-v1.md',
    'docs/runbooks/live-contract-verification.md',
    'scripts/chickpea-local-worker.mjs',
    'scripts/lib/local-worker-lane.mjs',
    ...filesBelow('qa/live'),
  ];
  assert.deepEqual(required.filter((path) => !packaged.has(path)), []);

  const packageJson = JSON.parse(read('package.json')) as { files?: string[] };
  assert.ok(packageJson.files?.includes('.agents/skills/chickpea-live-verification'));
  assert.ok(packageJson.files?.includes('AGENTS.md'));
  assert.ok(packageJson.files?.includes('qa/live'));
  assert.ok(packageJson.files?.includes('docs/runbooks/local-worker-development.md'));
  assert.ok(packageJson.files?.includes('docs/runbooks/live-contract-acceptance-v1.md'));
  assert.ok(packageJson.files?.includes('docs/runbooks/live-contract-verification.md'));
});

test('the explicit OSS verifier allowlist stays complete without admitting private artifacts', () => {
  const policy = read('scripts/verify-oss-export.mjs').split('const liveVerifierExportPolicy =')[1]
    ?.split('const forbiddenLiveVerifierArtifactPaths =')[0];
  assert.ok(policy);
  const paths = [...policy.matchAll(/exportPath\(([^)]+)\)/gu)]
    .map((match) => [...match[1]!.matchAll(/'([^']+)'/gu)].map((part) => part[1]).join('/'))
    .filter((path) => path.startsWith('qa/live/'));
  assert.deepEqual(paths.sort(), filesBelow('qa/live'));
});

test('source privacy policy permits only the exact discoverable skill path', () => {
  const script = read('scripts/verify-oss-export.mjs');
  const roots = script.slice(script.indexOf('const forbiddenSourcePathRoots ='),
    script.indexOf('const liveVerifierExportPolicy ='));
  const policy = script.slice(script.indexOf('function assertPublicSourceManifest(entries)'),
    script.indexOf('function isLiveVerifierPublicPath(path)'));
  // Run the real source-path filter without invoking the export/install pipeline.
  const check = new Function(`
    const exportPath = (...parts) => parts.join('/');
    ${roots}
    const forbiddenSourcePaths = new Set();
    const allowedPublicDocs = new Set();
    const allowedBinaryFiles = new Set();
    const assertLiveVerifierSourcePolicy = () => {};
    const fail = (message) => { throw new Error(message); };
    ${policy}
    return assertPublicSourceManifest;
  `)() as (entries: Array<{ path: string }>) => void;
  assert.doesNotThrow(() => check([{ path: '.agents/skills/chickpea-live-verification/SKILL.md' }]));
  for (const path of ['.agents/private.json', '.agents/skills/another/SKILL.md',
    '.agents/skills/chickpea-live-verification/evidence.json', '.agents/skills/chickpea-live-verification/skill.md']) {
    assert.throws(() => check([{ path }]), /forbidden public-source paths/u);
  }
});

test('public verifier files are not ignored and private artifact shapes are not packaged', () => {
  for (const path of [
    '.agents/skills/chickpea-live-verification/SKILL.md',
    'AGENTS.md',
    'qa/live/operator/SKILL.md',
    'qa/live/generated/feature-map.md',
    'docs/runbooks/live-contract-acceptance-v1.md',
    'docs/runbooks/live-contract-verification.md',
  ]) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', path], { cwd: ROOT });
    if (existsSync(resolve(ROOT, '.git'))) {
      assert.equal(result.status, 1, `${path} is ignored`);
    } else {
      assert.equal(result.status, 128, `${path} returned an unexpected git status`);
      assert.match(String(result.stderr), /not a git repository/i);
    }
  }

  const forbidden = [...packFiles()].filter((path) =>
    /^qa\/live\/(?:artifacts|evidence|private|resolved|runs|screenshots|transcripts)(?:\/|$)/i.test(path) ||
    /^qa\/live\/.*(?:\.journal\.jsonl|\.snapshot\.json|\.target\.json|\.transcript\.txt)$/i.test(path)
  );
  assert.deepEqual(forbidden, []);
});

test('operator skill stays small, discoverable, and separate from contract assertions', () => {
  const entrypoint = read('.agents/skills/chickpea-live-verification/SKILL.md');
  const skill = read('qa/live/operator/SKILL.md');
  const agents = read('AGENTS.md');
  const readme = read('README.md');
  assert.match(entrypoint, /^---\nname: chickpea-live-verification\n/);
  assert.match(entrypoint, /\.\.\/\.\.\/\.\.\/qa\/live\/operator\/SKILL\.md/);
  assert.match(entrypoint, /\.\.\/\.\.\/\.\.\/docs\/runbooks\/live-contract-verification\.md/);
  assert.ok(skill.split('\n').length <= 120);
  assert.match(skill, /^---\nname: chickpea-live-verification\n/);
  assert.match(skill, /\.\.\/\.\.\/\.\.\/docs\/runbooks\/live-contract-verification\.md/);
  assert.match(skill, /env claim <alias>/);
  assert.match(skill, /env target <alias>/);
  assert.match(skill, /env attest <alias>/);
  assert.match(skill, /Use only `amber` or `cobalt`/);
  assert.match(skill, /Reject `deep` on both targets/);
  assert.match(skill, /public catalog retains dormant deep contracts/);
  assert.doesNotMatch(skill, /\bLC-\d{2}\b|\b(?:xox[baprs]-|sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}/);
  assert.match(agents, /\$chickpea-live-verification/);
  assert.match(agents, /qa\/live\/operator\/SKILL\.md/);
  assert.match(readme, /\$chickpea-live-verification/);
  assert.match(readme, /\.agents\/skills\/chickpea-live-verification\/SKILL\.md/);
});

test('skill relative references resolve from their owning files to the canonical workflow', () => {
  for (const path of [
    '.agents/skills/chickpea-live-verification/SKILL.md',
    'qa/live/operator/SKILL.md',
  ]) {
    const references = [...read(path).matchAll(/`(\.\.\/[^`]+\.md)`/g)];
    assert.ok(references.length > 0, `${path} has no workflow references`);
    for (const [, reference] of references) {
      const resolved = resolve(ROOT, dirname(path), reference!);
      assert.ok(!relative(ROOT, resolved).startsWith('..'), `${path} references outside the repository`);
      assert.ok(statSync(resolved).isFile(), `${path} has a broken workflow reference`);
    }
  }
});
