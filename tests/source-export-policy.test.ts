import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// @ts-expect-error Executable helpers are JavaScript, shared with the verifiers.
import { archiveFindings, docsIgnoreFindings, extractArchive, leakScanFindings, publicSourceManifestFindings, readContents, readIndexManifest, readTrackedManifest } from '../scripts/lib/source-export-policy.mjs';

type Entry = { mode: string; type: string; object: string; path: string };

// The private company name the leak scan denies, assembled so this test file
// never contains it either.
const PRIVATE_NAME = ['mag', 'oosh'].join('');

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
}

function fixtureRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-policy-'));
  git(root, 'init', '-q', '-b', 'main');
  mkdirSync(join(root, 'docs', 'runbooks'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), 'docs/*\n!docs/runbooks/\ndocs/runbooks/*\n!docs/runbooks/public.md\n');
  writeFileSync(join(root, '.gitattributes'), 'release-source.json export-subst\n');
  writeFileSync(join(root, 'release-source.json'), '{ "commit": "$Format:%H$" }\n');
  writeFileSync(join(root, 'docs', 'runbooks', 'public.md'), '# Public runbook\n');
  writeFileSync(join(root, 'docs', 'runbooks', 'forced.md'), '# Added with git add -f\n');
  writeFileSync(join(root, 'src', 'clean.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'src', 'leaky.ts'), `export const sample = 'https://${PRIVATE_NAME}.example';\n`);
  git(root, 'add', '.');
  git(root, 'add', '-f', 'docs/runbooks/forced.md');
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
}

test('tracked and index manifests agree on a committed tree and reject unsafe entries', (context) => {
  const root = fixtureRepository();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const tracked = readTrackedManifest(root, 'HEAD') as { entries: Entry[]; sourceCommit: string };
  const index = readIndexManifest(root) as { entries: Entry[]; sourceCommit: null };
  assert.match(tracked.sourceCommit, /^[0-9a-f]{40}$/);
  assert.equal(index.sourceCommit, null);
  assert.deepEqual(tracked.entries.map(({ path }) => path), index.entries.map(({ path }) => path));
  assert.deepEqual(tracked.entries.map(({ path }) => path), [
    '.gitattributes', '.gitignore', 'docs/runbooks/forced.md', 'docs/runbooks/public.md',
    'release-source.json', 'src/clean.ts', 'src/leaky.ts',
  ]);
  assert.ok(tracked.entries.every(({ type, mode }) => type === 'blob' && mode === '100644'));
  assert.throws(() => readTrackedManifest(root, 'no-such-revision'), /git rev-parse failed/);
});

test('contents come from one batched blob read, or from the working tree when asked', (context) => {
  const root = fixtureRepository();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { entries } = readTrackedManifest(root, 'HEAD') as { entries: Entry[] };
  const committed = readContents(root, entries) as Map<string, Buffer>;
  assert.equal(committed.get('src/clean.ts')?.toString('utf8'), 'export const value = 1;\n');
  assert.equal(committed.size, entries.length);

  writeFileSync(join(root, 'src', 'clean.ts'), 'export const value = 2; // edited, not staged\n');
  rmSync(join(root, 'src', 'leaky.ts'));
  const working = readContents(root, entries, { workingTree: true }) as Map<string, Buffer>;
  assert.match(working.get('src/clean.ts')!.toString('utf8'), /value = 2/);
  // A file deleted from disk but still in the index falls back to the index blob.
  assert.match(working.get('src/leaky.ts')!.toString('utf8'), new RegExp(PRIVATE_NAME));
  assert.match(committed.get('src/clean.ts')!.toString('utf8'), /value = 1/);
});

test('a tracked docs file that .gitignore denies is reported; deliberately un-ignored files are not', (context) => {
  const root = fixtureRepository();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { entries } = readTrackedManifest(root, 'HEAD') as { entries: Entry[] };
  const findings = docsIgnoreFindings(root, entries) as string[];
  assert.deepEqual(findings.map((finding) => finding.split(':')[0]), ['docs/runbooks/forced.md']);
  assert.match(findings[0]!, /tracked although \.gitignore denies it/);
  assert.deepEqual(docsIgnoreFindings(root, entries.filter(({ path }) => !path.startsWith('docs/'))), []);
});

test('the leak scan names the file and the denied term, and refuses unlisted binaries and NUL bytes', (context) => {
  const root = fixtureRepository();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { entries } = readTrackedManifest(root, 'HEAD') as { entries: Entry[] };
  const contents = readContents(root, entries) as Map<string, Buffer>;
  const findings = leakScanFindings(entries, contents) as string[];
  assert.deepEqual(findings, ['src/leaky.ts: matched denied term private company name']);

  const extra = [
    { mode: '100644', type: 'blob', object: 'a'.repeat(40), path: 'assets/new.png' },
    { mode: '100644', type: 'blob', object: 'b'.repeat(40), path: 'src/binary.ts' },
    { mode: '100644', type: 'blob', object: 'c'.repeat(40), path: 'notes/home.md' },
    { mode: '120000', type: 'symlink', object: 'd'.repeat(40), path: 'link' },
  ];
  const extraContents = new Map([
    ['assets/new.png', Buffer.from('png')],
    ['src/binary.ts', Buffer.from([0x61, 0x00, 0x62])],
    ['notes/home.md', Buffer.from(['/Users', '/somebody', '/code/project'].join(''))],
  ]);
  assert.deepEqual(leakScanFindings(extra, extraContents), [
    'assets/new.png: forbidden binary/image extension .png',
    'src/binary.ts: binary content is not allowed in the OSS export',
    'notes/home.md: matched denied term local user path',
    'link: unsupported non-file entry (symlink)',
  ]);
});

test('the archive check proves every tracked byte was exported, including the substituted commit', (context) => {
  const root = fixtureRepository();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const { entries, sourceCommit } = readTrackedManifest(root, 'HEAD') as { entries: Entry[]; sourceCommit: string };
  const contents = readContents(root, entries) as Map<string, Buffer>;
  const scratch = extractArchive(root, sourceCommit) as string;
  context.after(() => rmSync(scratch, { recursive: true, force: true }));
  assert.deepEqual(archiveFindings(scratch, entries, contents, sourceCommit), []);
  rmSync(join(scratch, 'src', 'clean.ts'));
  writeFileSync(join(scratch, 'src', 'leaky.ts'), 'tampered\n');
  assert.deepEqual(archiveFindings(scratch, entries, contents, sourceCommit), [
    'src/clean.ts: tracked archive entry is missing (ENOENT)',
    'src/leaky.ts: archived bytes differ from the tracked blob',
  ]);
});

test('the public manifest policy reports private docs, forbidden roots, and verifier inventory drift', () => {
  const entries = [
    { path: 'docs/plans/2026-09-23-secret.md' },
    { path: 'docs/runbooks/releasing.md' },
    { path: 'qa/live/evidence/run.log' },
    { path: 'qa/live/new-case.ts' },
    { path: 'tmp/scratch.txt' },
  ];
  const findings = publicSourceManifestFindings(entries) as string[];
  assert.ok(findings.includes('docs/plans/2026-09-23-secret.md: private plans under docs/ is not public'));
  assert.ok(findings.includes('tmp/scratch.txt: forbidden public-source path'));
  assert.ok(findings.includes('forbidden private verifier artifact: qa/live/evidence/run.log'));
  assert.ok(findings.includes('unreviewed verifier file: qa/live/new-case.ts'));
  assert.ok(findings.some((finding) => finding.startsWith('missing public verifier file: qa/live/manifest.ts')));
  assert.equal(findings.some((finding) => finding.startsWith('docs/runbooks/releasing.md')), false);
});
