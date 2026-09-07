import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
// @ts-expect-error Build-only JavaScript helper.
import { readBuildIdentity } from '../scripts/lib/build-identity.mjs';

test('identity belongs to the target source, never its launcher or containing repository', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'chickpea-identity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(root, '.gitattributes'), 'release-source.json export-subst\n');
  writeFileSync(join(root, 'release-source.json'), '{"commit":"$Format:%H$"}\n');
  git('add', 'package.json', '.gitattributes', 'release-source.json');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  assert.deepEqual(readBuildIdentity(root), { version: '0.1.0', sourceCommit: commit });
  const archive = join(root, 'archive');
  mkdirSync(archive);
  writeFileSync(join(archive, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  assert.deepEqual(readBuildIdentity(archive), { version: '0.2.0', sourceCommit: null });
  writeFileSync(join(archive, 'release-source.json'), JSON.stringify({ commit: 'a'.repeat(40) }));
  assert.deepEqual(readBuildIdentity(archive), { version: '0.2.0', sourceCommit: 'a'.repeat(40) });
  writeFileSync(join(archive, 'release-source.json'), JSON.stringify({ commit: '$Format:%H$' }));
  assert.equal(readBuildIdentity(archive).sourceCommit, null);
  const exported = join(root, 'exported');
  mkdirSync(exported);
  execFileSync('tar', ['-xf', '-', '-C', exported], {
    input: execFileSync('git', ['-C', root, 'archive', 'HEAD']),
  });
  assert.deepEqual(readBuildIdentity(exported), { version: '0.1.0', sourceCommit: commit });
});
