import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// @ts-expect-error Executable helpers are JavaScript, shared with the verifiers.
import { docsReferenceFindings, liveVerifierExportPolicy, publicSourceManifestFindings, readContents, readIndexManifest } from '../scripts/lib/source-export-policy.mjs';

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
  const paths = [...liveVerifierExportPolicy.requiredPaths].filter((path: string) => path.startsWith('qa/live/'));
  assert.deepEqual(paths.sort(), filesBelow('qa/live'));
});

test('source privacy policy permits only the exact discoverable skill path', () => {
  // Run the real source-path filter without invoking the export/install pipeline.
  const forbidden = (path: string) => publicSourceManifestFindings([{ path }])
    .filter((finding: string) => finding.startsWith(`${path}: `));
  assert.deepEqual(forbidden('.agents/skills/chickpea-live-verification/SKILL.md'), []);
  assert.deepEqual(forbidden('docs/runbooks/releasing.md'), []);
  for (const path of ['.agents/private.json', '.agents/skills/another/SKILL.md',
    '.agents/skills/chickpea-live-verification/evidence.json', '.agents/skills/chickpea-live-verification/skill.md',
    'tmp/notes.md', 'evidence/run.json', '.worktreeinclude']) {
    assert.match(forbidden(path).join('\n'), /forbidden public-source path/u, path);
  }
  // docs/ has no hand-kept allowlist any more: private roots and artifact
  // shapes are denied, the leak scan covers content, and .gitignore stays the
  // deliberate per-file gate.
  for (const path of ['docs/plans/2026-09-23-private-plan.md', 'docs/plans/evidence/run.json',
    'docs/evidence/screenshot.txt', 'docs/private/notes.md', 'docs/runbooks/rehearsal.transcript.txt',
    'docs/runbooks/lane.target.json', 'docs/runbooks/debug.log']) {
    assert.match(forbidden(path).join('\n'), /under docs\/ is not public/u, path);
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

test('operator skill stays discoverable and separate from contract assertions', () => {
  const entrypoint = read('.agents/skills/chickpea-live-verification/SKILL.md');
  assert.equal(read('.claude/skills/chickpea-live-verification/SKILL.md'), entrypoint, 'Host wrappers must share exactly one canonical workflow');
  const skill = read('qa/live/operator/SKILL.md');
  const agents = read('AGENTS.md');
  const readme = read('README.md');
  assert.match(entrypoint, /^---\nname: chickpea-live-verification\n/);
  assert.match(entrypoint, /\.\.\/\.\.\/\.\.\/qa\/live\/operator\/SKILL\.md/);
  assert.match(skill, /^---\nname: chickpea-live-verification\n/);
  assert.doesNotMatch(skill, /\bLC-\d{2}\b|\b(?:xox[baprs]-|sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}/);
  assert.match(agents, /\$chickpea-live-verification/);
  assert.match(agents, /qa\/live\/operator\/SKILL\.md/);
  assert.match(readme, /\$chickpea-live-verification/);
  assert.match(readme, /\.agents\/skills\/chickpea-live-verification\/SKILL\.md/);
});

// The clean source export has no .git, so it cannot read the index manifest.
// verify:hygiene and the export itself run the same docs-reference check on
// the exact committed tree (inspectSource), so skipping here loses nothing.
const IN_GIT_CHECKOUT = existsSync(resolve(ROOT, '.git'));

test('skill relative references resolve from their owning files to the canonical workflow', {
  skip: IN_GIT_CHECKOUT ? false : 'no .git in the source export; inspectSource covers this check',
}, () => {
  // The same check runs in verify:hygiene; this keeps it in the full suite too.
  // Both inline-code references in the discovery wrapper and actual Markdown
  // links in the operator instructions must survive source publication.
  const { entries } = readIndexManifest(ROOT);
  assert.deepEqual(docsReferenceFindings(entries, readContents(ROOT, entries, { workingTree: true })), []);
});
