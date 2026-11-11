import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  compareSizes, exportCommit, formatGrowth, GROWTH_ALLOWANCE_BYTES, growthFailure, growthLine, growthPlan, noteAllowance,
  // @ts-expect-error Build tooling JavaScript helper.
} from '../scripts/lib/budget-growth.mjs';

type Change = { from: string; to?: string; label: string; notes: string[]; allowance: number };

function repository(t: TestContext) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chickpea-budget-growth-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  const commit = (message: string, file = 'file.txt', content = `${message}\n`) => {
    writeFileSync(join(root, file), content);
    git('add', file);
    git('commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  const merge = (branch: string, message: string) => {
    git('merge', '-q', '--no-ff', '-m', message, branch);
    return git('rev-parse', 'HEAD');
  };
  /** Each tracked file's size at `commit`, or at HEAD for the clean working tree. */
  const sizes = (commit?: string) => new Map(git('ls-tree', '-r', '-l', commit ?? 'HEAD').split('\n').map((line) => {
    const [meta = '', name = ''] = line.split('\t');
    return [name, Number(meta.trim().split(/\s+/)[3])] as const;
  }));
  return { root, git, commit, merge, sizes };
}

test('a branch is one change from its merge base with origin/main to the working tree', (t) => {
  const { root, git, commit } = repository(t);
  const base = commit('base');
  git('update-ref', 'refs/remotes/origin/main', base);
  git('switch', '-qc', 'topic');
  commit('one', 'one.txt');
  commit('two\n\nWorker-Startup-Growth: 40 KiB, the new route loads with the Agent', 'two.txt');
  // origin/main moving on does not move the base: the merge base stays put.
  git('switch', '-q', 'main');
  git('update-ref', 'refs/remotes/origin/main', commit('later on main', 'later.txt'));
  git('switch', '-q', 'topic');

  const plan = growthPlan(root, {});
  assert.equal(plan.base, base);
  assert.equal(plan.ref, 'origin/main');
  assert.equal(plan.changes.length, 1);
  assert.deepEqual(plan.changes[0], {
    from: base, to: undefined, label: 'this branch',
    notes: ['40 KiB, the new route loads with the Agent'], allowance: 40 * 1024,
  });
});

test('a local merge onto origin/main, or a train of them, checks each merge on its own', (t) => {
  const { root, git, commit, merge } = repository(t);
  const base = commit('base');
  git('update-ref', 'refs/remotes/origin/main', base);
  for (const name of ['first', 'second']) {
    git('switch', '-qc', name, base);
    commit(`${name} work${name === 'second' ? '\n\nWorker-Startup-Growth: 20 KiB, a needed tool' : ''}`, `${name}.txt`);
  }
  git('switch', '-q', 'main');
  const first = merge('first', 'Merge pull request #1 from first');
  const second = merge('second', 'Merge pull request #2 from second');

  const plan = growthPlan(root, {});
  assert.deepEqual(plan.changes.map(({ from, to, allowance }: { from: string; to?: string; allowance: number }) =>
    ({ from, to, allowance })), [
    { from: base, to: first, allowance: GROWTH_ALLOWANCE_BYTES },
    // The last merge is HEAD, so it is measured in the working tree.
    { from: first, to: undefined, allowance: 20 * 1024 },
  ]);
  assert.match(plan.changes[0].label, new RegExp(`^merge ${first.slice(0, 9)} \\(Merge pull request #1 from first\\)$`));
  assert.ok(second);
});

test('plain commits on a train, such as its ceiling re-set, are a change of their own', (t) => {
  const { root, git, commit, merge, sizes } = repository(t);
  const base = commit('base');
  git('update-ref', 'refs/remotes/origin/main', base);
  for (const name of ['first', 'second']) {
    git('switch', '-qc', name, base);
    commit(`${name} work`, `${name}.txt`, 'x'.repeat(12 * 1024));
  }
  git('switch', '-q', 'main');
  const first = merge('first', 'Merge pull request #1 from first');
  const fix = commit('Fix the typo the review found', 'file.txt');
  const second = merge('second', 'Merge pull request #2 from second');
  commit('Note the train in the changelog', 'changelog.txt');
  const ceiling = commit('Re-set the startup ceiling for the train', 'ceiling.txt');

  const plan = growthPlan(root, {});
  assert.deepEqual(plan.changes.map(({ from, to, label }: Change) => ({ from, to, label })), [
    { from: base, to: first, label: `merge ${first.slice(0, 9)} (Merge pull request #1 from first)` },
    { from: first, to: fix, label: `commit ${fix.slice(0, 9)} (Fix the typo the review found)` },
    { from: fix, to: second, label: `merge ${second.slice(0, 9)} (Merge pull request #2 from second)` },
    { from: second, to: undefined, label: `2 commits to ${ceiling.slice(0, 9)} (Re-set the startup ceiling for the train)` },
  ]);
  // Each merge adds 12 KiB and fits; measured as one change, the train would add 24 KiB.
  for (const change of plan.changes as Change[]) {
    const { growth, rows } = compareSizes(sizes(change.from), sizes(change.to));
    assert.ok(growth <= change.allowance, growthFailure({ what: 'The fixture', change, ref: plan.ref, growth, rows }));
  }
  assert.ok(compareSizes(sizes(base), sizes()).growth > GROWTH_ALLOWANCE_BYTES);
});

test('a branch of merges that merged main in is one change, from its merge base', (t) => {
  const { root, git, commit, merge } = repository(t);
  const start = commit('start');
  git('switch', '-qc', 'side');
  commit('side work', 'side.txt');
  git('switch', '-q', 'main');
  const main = commit('main work', 'main.txt');
  git('update-ref', 'refs/remotes/origin/main', main);
  git('switch', '-qc', 'topic', start);
  merge('side', 'Merge side into topic');
  merge('main', 'Merge main into topic');

  // Its first commit's parent is not the merge base, so it is not a train on origin/main.
  const plan = growthPlan(root, {});
  assert.deepEqual(plan.changes.map(({ from, to, label }: Change) => ({ from, to, label })),
    [{ from: main, to: undefined, label: 'this branch' }]);
});

test('a branch that merged main in is still one change', (t) => {
  const { root, git, commit, merge } = repository(t);
  const start = commit('start');
  git('switch', '-qc', 'topic');
  commit('topic work', 'topic.txt');
  git('switch', '-q', 'main');
  const main = commit('main work', 'main.txt');
  git('update-ref', 'refs/remotes/origin/main', main);
  git('switch', '-q', 'topic');
  merge('main', 'Merge main into topic');

  const plan = growthPlan(root, {});
  assert.equal(plan.base, main);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].from, main);
  assert.ok(start);
});

test('CHICKPEA_BUDGET_BASE names the base branch of a stacked change', (t) => {
  const { root, git, commit } = repository(t);
  git('update-ref', 'refs/remotes/origin/main', commit('base'));
  git('switch', '-qc', 'lower');
  const lower = commit('lower', 'lower.txt');
  git('switch', '-qc', 'upper');
  commit('upper', 'upper.txt');
  assert.equal(growthPlan(root, { CHICKPEA_BUDGET_BASE: 'lower' }).base, lower);
  // A named base that does not exist fails instead of skipping the growth rule.
  assert.deepEqual(growthPlan(root, { CHICKPEA_BUDGET_BASE: 'lowr' }), {
    error: 'CHICKPEA_BUDGET_BASE=lowr has no merge base with HEAD. Set it to the branch this one is based on.',
  });
});

test('with no Git history or no base ref, growth is skipped with the reason', (t) => {
  const { root, git, commit } = repository(t);
  commit('base');
  assert.match(growthPlan(root, {}).skip, /No merge base with origin\/main.*git fetch origin main.*CHICKPEA_BUDGET_BASE/);
  const exported = exportCommit(root, git('rev-parse', 'HEAD'));
  t.after(() => rmSync(exported, { recursive: true, force: true }));
  assert.equal(readFileSync(join(exported, 'file.txt'), 'utf8'), 'base\n');
  assert.match(growthPlan(exported, {}).skip, /no Git history, so growth over a merge base is not checked\.$/);
});

test('growth lists the modules that grew, largest first, and marks new ones', () => {
  const before = new Map([['src/a.ts', 1000], ['src/b.ts', 500], ['src/gone.ts', 300]]);
  const after = new Map([['src/a.ts', 1200], ['src/b.ts', 400], ['src/new.ts', 20 * 1024]]);
  const { growth, rows } = compareSizes(before, after);
  assert.equal(growth, 1200 + 400 + 20 * 1024 - 1800);
  assert.deepEqual(rows.map((row: { name: string }) => row.name), ['src/new.ts', 'src/a.ts', 'src/b.ts', 'src/gone.ts']);
  assert.equal(formatGrowth(rows), '    +20.0 KiB  src/new.ts (new)\n     +0.2 KiB  src/a.ts');
  assert.equal(formatGrowth(compareSizes(after, after).rows), '  (no module grew)');

  const message = growthFailure({
    what: "Worker startup's repository source", ref: 'origin/main', growth, rows,
    change: { from: 'a'.repeat(40), to: undefined, label: 'this branch', notes: ['soon', '200 KiB, all of it'], allowance: GROWTH_ALLOWANCE_BYTES },
  });
  assert.match(message, /^Worker startup's repository source grew 19\.8 KiB in this branch \(aaaaaaaaa\.\.the working tree\), over the 16\.0 KiB/);
  assert.match(message, /\+20\.0 KiB {2}src\/new\.ts \(new\)/);
  assert.match(message, /"Worker-Startup-Growth: <size> KiB, <why>"/);
  assert.match(message, /notes were not counted, since a note starts with its size, at most 128\.0 KiB: soon; 200 KiB, all of it$/m);
});

test('each measured change prints its growth, allowance and notes', () => {
  const change = { from: 'b'.repeat(40), label: 'merge ccccccccc (Merge pull request #3)', notes: ['40 KiB, the connect route'], allowance: 40 * 1024 };
  assert.equal(growthLine(change, 30 * 1024),
    'Growth in merge ccccccccc (Merge pull request #3) since bbbbbbbbb: 30.0 KiB, allowed 40.0 KiB. ' +
    'Worker-Startup-Growth: 40 KiB, the connect route.');
  assert.equal(growthLine({ ...change, notes: [], allowance: GROWTH_ALLOWANCE_BYTES }, -512),
    'Growth in merge ccccccccc (Merge pull request #3) since bbbbbbbbb: -0.5 KiB, allowed 16.0 KiB.');
});

test('a note counts only when it starts with a size in KiB, up to 128 KiB', () => {
  assert.equal(noteAllowance('40 KiB, the connect route'), 40 * 1024);
  assert.equal(noteAllowance('2.5 kib'), 2560);
  assert.equal(noteAllowance('128 KiB, two ceilings of headroom'), 128 * 1024);
  assert.equal(noteAllowance('129 KiB, more than that'), undefined);
  assert.equal(noteAllowance('99999 KiB, whatever'), undefined);
  assert.equal(noteAllowance('about 40 KiB'), undefined);
  assert.equal(noteAllowance('40 KB'), undefined);
});
