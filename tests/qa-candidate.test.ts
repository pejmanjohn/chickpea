import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
// @ts-expect-error Executable JavaScript helper.
import { admitQaCandidate, recheckQaCandidate } from '../scripts/lib/qa-candidate.mjs';

function fixture(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-source-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Synthetic verifier'); git('config', 'user.email', 'verifier@example.test');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ repository: { url: 'git+https://github.com/pejmanjohn/chickpea.git' } }));
  writeFileSync(join(root, 'source.txt'), 'baseline'); git('add', '.'); git('commit', '-m', 'baseline');
  const old = git('rev-parse', 'HEAD');
  writeFileSync(join(root, 'source.txt'), 'current transport'); git('add', '.'); git('commit', '-m', 'current transport');
  const tip = git('rev-parse', 'HEAD'); git('remote', 'add', 'origin', 'git@github.com:pejmanjohn/chickpea.git');
  git('update-ref', 'refs/remotes/origin/main', old);
  const observeRemote = () => ({ status: 0, stdout: `${tip}\trefs/heads/main\n` });
  return { root, git, old, tip, observeRemote };
}

test('fresh admission observes the remote without changing a stale shared tracking ref', (t) => {
  const f = fixture(t);
  const before = f.git('show-ref');
  const admission = admitQaCandidate(f.root, { observeRemote: f.observeRemote });
  assert.equal(admission.approvedTip, f.tip);
  assert.equal(admission.trackingTip, f.old);
  assert.equal(admission.trackingMatchesRemote, false);
  assert.equal(f.git('show-ref'), before);
  assert.equal(recheckQaCandidate(admission).tree, admission.source.tree);
});

test('old-main and old-main feature candidates are refused before acceptance', (t) => {
  const f = fixture(t);
  f.git('checkout', '-b', 'old-feature', f.old);
  assert.throws(() => admitQaCandidate(f.root, { observeRemote: f.observeRemote }), /QA_SOURCE_BEHIND_MAIN/);
  writeFileSync(join(f.root, 'feature.txt'), 'synthetic feature'); f.git('add', '.'); f.git('commit', '-m', 'feature on old main');
  assert.throws(() => admitQaCandidate(f.root, { observeRemote: f.observeRemote }), /QA_SOURCE_BEHIND_MAIN/);
});

test('independent QA feature branches from the same current main are both eligible', (t) => {
  const f = fixture(t);
  for (const branch of ['first', 'second']) {
    f.git('checkout', '-b', branch, f.tip);
    writeFileSync(join(f.root, `${branch}.txt`), branch); f.git('add', '.'); f.git('commit', '-m', branch);
    assert.equal(admitQaCandidate(f.root, { observeRemote: f.observeRemote }).approvedTip, f.tip);
  }
});

test('missing remote objects and unavailable remote observation never fall back to origin/main', (t) => {
  const f = fixture(t);
  assert.throws(() => admitQaCandidate(f.root, { observeRemote: () => ({ status: 1, stdout: '' }) }), /QA_SOURCE_REMOTE_UNAVAILABLE/);
  assert.throws(() => admitQaCandidate(f.root, { observeRemote: () => ({ status: 0, stdout: `${'f'.repeat(40)}\trefs/heads/main` }) }), /QA_SOURCE_TIP_NOT_FETCHED/);
  f.git('remote', 'set-url', 'origin', 'git@github.com:example/different-repository.git');
  assert.throws(() => admitQaCandidate(f.root, { observeRemote: () => { throw new Error('must not query wrong remote'); } }), /QA_SOURCE_REMOTE_MISMATCH/);
});

test('working contents and HEAD are rechecked even when the dirty boolean stays true', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'source.txt'), 'first dirty state');
  const admission = admitQaCandidate(f.root, { observeRemote: f.observeRemote });
  writeFileSync(join(f.root, 'source.txt'), 'second dirty state');
  assert.throws(() => recheckQaCandidate(admission), /QA_SOURCE_CHANGED/);
  writeFileSync(join(f.root, 'source.txt'), 'first dirty state');
  const next = admitQaCandidate(f.root, { observeRemote: f.observeRemote });
  f.git('add', '.'); f.git('commit', '-m', 'commit during deployment');
  assert.throws(() => recheckQaCandidate(next), /QA_SOURCE_CHANGED/);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'package.json'), 'utf8')).repository.url, 'git+https://github.com/pejmanjohn/chickpea.git');
});

test('candidate package and remote rewrites cannot replace the default repository authority', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({
    repository: { url: 'git+https://github.com/example/stale-fork.git' },
  }));
  f.git('remote', 'set-url', 'origin', 'git@github.com:example/stale-fork.git');
  assert.throws(() => admitQaCandidate(f.root, {
    observeRemote: () => { throw new Error('must not query an unregistered repository'); },
  }), /QA_SOURCE_REPOSITORY_MISMATCH/u);
});

test('an explicitly registered fork must match both package metadata and the selected remote', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({
    repository: { url: 'git+https://github.com/example/registered-fork.git' },
  }));
  f.git('remote', 'set-url', 'origin', 'git@github.com:example/registered-fork.git');
  const admission = admitQaCandidate(f.root, {
    env: { CHICKPEA_QA_SOURCE_REPOSITORY: 'Example/Registered-Fork' },
    observeRemote: f.observeRemote,
  });
  assert.equal(admission.repository, 'example/registered-fork');

  f.git('remote', 'set-url', 'origin', 'git@github.com:example/different-fork.git');
  assert.throws(() => admitQaCandidate(f.root, {
    env: { CHICKPEA_QA_SOURCE_REPOSITORY: 'example/registered-fork' },
    observeRemote: () => { throw new Error('must not query a mismatched remote'); },
  }), /QA_SOURCE_REMOTE_MISMATCH/u);
});

test('invalid configured repository identities are refused before remote observation', (t) => {
  const f = fixture(t);
  for (const configured of [
    '',
    'pejmanjohn',
    'https://github.com/pejmanjohn/chickpea',
    '../chickpea',
    'pejmanjohn/chickpea/extra',
  ]) {
    assert.throws(() => admitQaCandidate(f.root, {
      env: { CHICKPEA_QA_SOURCE_REPOSITORY: configured },
      observeRemote: () => { throw new Error('must not observe for an invalid identity'); },
    }), /QA_SOURCE_REPOSITORY_INVALID/u);
  }
});
