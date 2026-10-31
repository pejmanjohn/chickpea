import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_UPLOAD_BYTES,
  resolveUploadedSkills,
  SkillUploadError,
  type UploadedSkillFile,
} from '../src/config/skill-upload.ts';
import { buildZip, skillMarkdown } from './helpers/zip.ts';

const text = (value: string) => new TextEncoder().encode(value);
const file = (name: string, bytes: Uint8Array | string): UploadedSkillFile =>
  ({ name, bytes: typeof bytes === 'string' ? text(bytes) : bytes });
const codes = (issues: Array<{ path: string; code: string }>) => issues.map(({ path, code }) => `${path} ${code}`);

test('a zip of skill folders lists each skill and drops macOS archive junk', async () => {
  const archive = buildZip([
    { path: 'skills/' },
    { path: '__MACOSX/._skills', content: '\u0000\u0005\u0016\u0007 binary' },
    { path: 'skills/alpha/SKILL.md', content: skillMarkdown('alpha', 'First skill.') },
    { path: '__MACOSX/skills/alpha/._SKILL.md', content: '\u0000\u0005\u0016\u0007 binary' },
    { path: 'skills/beta/SKILL.md', content: skillMarkdown(undefined, 'Named by its folder.'), method: 0 },
    { path: 'skills/beta/.DS_Store', content: 'Bud1' },
  ]);
  const resolution = await resolveUploadedSkills([file('skills.zip', archive)]);
  assert.deepEqual(resolution.skills.map(({ name, path, description }) => ({ name, path, description })), [
    { name: 'alpha', path: 'skills.zip/skills/alpha', description: 'First skill.' },
    { name: 'beta', path: 'skills.zip/skills/beta', description: 'Named by its folder.' },
  ]);
  assert.equal(resolution.skills[0]?.instructions, '# Steps\nDo the work.\n');
  assert.deepEqual(resolution.issues, []);
  assert.equal(resolution.skipped, 0);
});

test('a root-level SKILL.md takes its header name, or the .skill archive name when the header has none', async () => {
  const resolution = await resolveUploadedSkills([
    file('field-notes.skill', buildZip([{ path: 'SKILL.md', content: skillMarkdown(undefined, 'Packaged skill.') }])),
    file('bundle.zip', buildZip([{ path: 'SKILL.md', content: skillMarkdown('Release Notes', 'Root skill.') }])),
  ]);
  assert.deepEqual(resolution.skills.map(({ name, path }) => `${name} ${path}`), [
    'field-notes field-notes.skill',
    'release-notes bundle.zip',
  ]);
});

test('loose files: SKILL.md and headed markdown are skills, other files are left out with a reason', async () => {
  const resolution = await resolveUploadedSkills([
    file('SKILL.md', skillMarkdown('triage', 'Sort requests.')),
    file('voice.md', skillMarkdown('voice', 'House style.')),
    file('README.md', '# About these skills\nNo header here.'),
    file('notes.markdown', '---\ntitle: Notes\n---\nA header without a name.'),
    file('diagram.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    file('.DS_Store', 'Bud1'),
  ]);
  assert.deepEqual(resolution.skills.map(({ name, path }) => `${name} ${path}`), ['triage SKILL.md', 'voice voice.md']);
  assert.deepEqual(codes(resolution.issues), [
    'README.md not_a_skill',
    'notes.markdown not_a_skill',
    'diagram.png unsupported_file',
  ]);
  assert.equal(resolution.skipped, 2);
  assert.match(resolution.issues[0]!.message, /YAML header with a name and a description/);
});

test('a loose SKILL.md without a name says the header needs one', async () => {
  const resolution = await resolveUploadedSkills([file('SKILL.md', skillMarkdown(undefined, 'No name.'))]);
  assert.deepEqual(resolution.skills, []);
  assert.deepEqual(resolution.issues, [{
    path: 'SKILL.md', code: 'invalid_document', message: 'SKILL.md needs a name in its YAML header.',
  }]);
});

test('package files are omitted with the same warnings GitHub import gives, and are not offered as skills', async () => {
  const resolution = await resolveUploadedSkills([file('pack.zip', buildZip([
    { path: 'alpha/SKILL.md', content: skillMarkdown('alpha', 'With extras.', 'Read references/guide.md.') },
    { path: 'alpha/references/guide.md', content: '# Guide without a header' },
    { path: 'alpha/scripts/run.py', content: 'print("never runs")' },
    { path: 'gamma/notes.md', content: '# Loose notes' },
  ]))]);
  assert.equal(resolution.skills.length, 1);
  const [alpha] = resolution.skills;
  assert.equal(alpha?.hasScripts, true);
  assert.deepEqual(alpha?.inspection.scriptPaths, ['scripts/run.py']);
  assert.deepEqual(alpha?.inspection.auxiliaryPaths, ['references/guide.md']);
  assert.ok(alpha?.inspection.warnings.includes('Instructions that depend on omitted files may be incomplete.'));
  assert.deepEqual(codes(resolution.issues), ['pack.zip/gamma/notes.md not_a_skill']);
});

test('skill folders under tests, fixtures and node_modules are ignored like GitHub import ignores them', async () => {
  const resolution = await resolveUploadedSkills([file('repo.zip', buildZip([
    { path: 'skills/real/SKILL.md', content: skillMarkdown('real', 'Kept.') },
    { path: 'tests/fixtures/fake/SKILL.md', content: skillMarkdown('fake', 'Ignored.') },
    { path: 'node_modules/pkg/README.md', content: '# Package' },
    { path: 'skills\\windows\\SKILL.md', content: skillMarkdown('windows', 'Backslash path.') },
  ]))]);
  assert.deepEqual(resolution.skills.map(({ name, path }) => `${name} ${path}`), [
    'real repo.zip/skills/real',
    'windows repo.zip/skills/windows',
  ]);
  assert.deepEqual(resolution.issues, []);
});

test('duplicate names keep the first skill and report the rest', async () => {
  const resolution = await resolveUploadedSkills([
    file('one.zip', buildZip([{ path: 'shared/SKILL.md', content: skillMarkdown('shared', 'First.') }])),
    file('SKILL.md', skillMarkdown('shared', 'Second.')),
  ]);
  assert.deepEqual(resolution.skills.map(({ description }) => description), ['First.']);
  assert.deepEqual(codes(resolution.issues), ['SKILL.md duplicate_name']);
  assert.equal(resolution.skipped, 1);
});

test('instructions over 100,000 characters name the file and the overage', async () => {
  const resolution = await resolveUploadedSkills([
    file('long.zip', buildZip([{ path: 'long/SKILL.md', content: skillMarkdown('long', 'Too long.', 'x'.repeat(100_250)) }])),
  ]);
  assert.deepEqual(resolution.skills, []);
  assert.deepEqual(resolution.issues, [{
    path: 'long.zip/long',
    code: 'document_too_large',
    message: 'The instructions are 100,250 characters, 250 over the 100,000 limit. No content was shortened.',
  }]);
});

test('a markdown document over 512 KB is refused before it is inflated', async () => {
  const resolution = await resolveUploadedSkills([
    file('big.zip', buildZip([{ path: 'big/SKILL.md', content: skillMarkdown('big', 'Huge.', 'y'.repeat(600 * 1024)) }])),
  ]);
  assert.deepEqual(codes(resolution.issues), ['big.zip/big document_too_large']);
  assert.match(resolution.issues[0]!.message, /^This file is 601 KB\. The limit is 512 KB\.$/);
});

test('an entry that inflates past its declared size is refused, so a lying header cannot grow memory', async () => {
  const resolution = await resolveUploadedSkills([file('bomb.zip', buildZip([
    { path: 'bomb/SKILL.md', content: skillMarkdown('bomb', 'Lies.', 'z'.repeat(4 * 1024 * 1024)), declaredSize: 1024 },
    { path: 'fine/SKILL.md', content: skillMarkdown('fine', 'Still read.') },
  ]))]);
  assert.deepEqual(resolution.skills.map(({ name }) => name), ['fine']);
  assert.deepEqual(resolution.issues, [{
    path: 'bomb.zip/bomb', code: 'invalid_archive', message: 'This file does not match its declared size.',
  }]);
});

test('total markdown read per upload stops at 16 MB', async () => {
  const header = '---\ndescription: Fills the budget.\n---\n';
  const entries = Array.from({ length: 33 }, (_, index) => ({
    path: `doc-${index}/SKILL.md`,
    content: header + 'w'.repeat(512 * 1024 - header.length),
  }));
  const resolution = await resolveUploadedSkills([file('budget.zip', buildZip(entries))]);
  const issueCodes = resolution.issues.map(({ code }) => code);
  assert.deepEqual(issueCodes.slice(0, 32), Array(32).fill('document_too_large'));
  assert.deepEqual(issueCodes.slice(32), ['too_much_markdown']);
});

test('archives the reader refuses are reported once and offer no skills', async () => {
  const valid = { path: 'ok/SKILL.md', content: skillMarkdown('ok', 'Fine.') };
  const resolution = await resolveUploadedSkills([
    file('locked.zip', buildZip([valid, { path: 'secret/SKILL.md', content: skillMarkdown('secret', 'Hidden.'), flags: 1 }])),
    file('huge.zip', buildZip([valid, { path: 'wide/SKILL.md', content: skillMarkdown('wide', 'Zip64.'), zip64: true }])),
    file('escape.zip', buildZip([valid, { path: '../outside/SKILL.md', content: skillMarkdown('outside', 'Traversal.') }])),
    file('rooted.zip', buildZip([valid, { path: '/etc/SKILL.md', content: skillMarkdown('rooted', 'Absolute.') }])),
    file('crowded.zip', buildZip(Array.from({ length: 2001 }, (_, index) => ({ path: `f${index}.txt`, method: 0 })))),
    file('broken.zip', text('not a zip at all')),
  ]);
  assert.deepEqual(resolution.skills, []);
  assert.deepEqual(resolution.issues.map(({ path, code, message }) => `${path} ${code} ${message}`), [
    'locked.zip invalid_archive This archive is encrypted.',
    'huge.zip invalid_archive This archive uses Zip64, which upload does not support.',
    'escape.zip invalid_archive This archive has a path outside the archive: ../outside/SKILL.md.',
    'rooted.zip invalid_archive This archive has a path outside the archive: /etc/SKILL.md.',
    'crowded.zip invalid_archive This archive has 2001 entries. The limit is 2000.',
    'broken.zip invalid_archive This file is not a readable zip archive.',
  ]);
});

test('an unreadable markdown entry is one issue; the rest of its archive still resolves', async () => {
  const resolution = await resolveUploadedSkills([file('mixed.zip', buildZip([
    { path: 'bzip/SKILL.md', content: skillMarkdown('bzip', 'Method 12.'), method: 12 },
    { path: 'moved/SKILL.md', content: skillMarkdown('moved', 'Header mismatch.'), localPath: 'other/SKILL.md' },
    { path: 'stored/SKILL.md', content: skillMarkdown('stored', 'Method 0.'), method: 0 },
  ]))]);
  assert.deepEqual(resolution.skills.map(({ name }) => name), ['stored']);
  assert.deepEqual(resolution.issues.map(({ path, code, message }) => `${path} ${code} ${message}`), [
    'mixed.zip/bzip invalid_archive This file uses zip compression method 12. Upload reads stored and deflated files.',
    'mixed.zip/moved invalid_archive This file does not match its zip header.',
  ]);
});

test('an archive entry the reader refuses is reported, and the first copy of a repeated path is the one read', async () => {
  const resolution = await resolveUploadedSkills([file('dup.zip', buildZip([
    { path: 'alpha/SKILL.md', content: skillMarkdown('alpha', 'First copy.') },
    { path: 'alpha/SKILL.md', content: skillMarkdown('alpha', 'Second copy.') },
  ]))]);
  assert.deepEqual(resolution.skills.map(({ description }) => description), ['First copy.']);
  assert.deepEqual(resolution.issues, [{
    path: 'dup.zip/alpha/SKILL.md',
    code: 'invalid_archive',
    message: 'This archive lists this path more than once. Only the first copy was read.',
  }]);
});

test('an upload offers at most 100 skills and reports the cap once', async () => {
  const entries = Array.from({ length: 103 }, (_, index) => ({
    path: `s${index}/SKILL.md`, content: skillMarkdown(`s${index}`, 'One of many.'),
  }));
  const resolution = await resolveUploadedSkills([file('many.zip', buildZip(entries))]);
  assert.equal(resolution.skills.length, 100);
  assert.equal(resolution.skipped, 3);
  assert.deepEqual(codes(resolution.issues), ['many.zip/s100 too_many_skills']);
});

test('more than 50 files or 8 MB refuses the whole upload', async () => {
  await assert.rejects(
    resolveUploadedSkills(Array.from({ length: 51 }, (_, index) => file(`s${index}.md`, '# x'))),
    (error: unknown) => error instanceof SkillUploadError && error.code === 'too_many_files',
  );
  await assert.rejects(
    resolveUploadedSkills([file('a.zip', new Uint8Array(MAX_UPLOAD_BYTES)), file('b.md', '#')]),
    (error: unknown) => error instanceof SkillUploadError && error.code === 'upload_too_large',
  );
});
