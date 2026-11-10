/**
 * Growth budgets for Worker startup: a change may add at most
 * GROWTH_ALLOWANCE_BYTES over its merge base, beside a fixed ceiling that
 * backstops the total. Two PRs that each fit a ceiling set just above
 * today's size fail together once both merge; measured against their own
 * merge bases, each passes alone.
 *
 * The merge base. Every check runs locally with no CI to name a PR's base,
 * so Git supplies it: `git merge-base HEAD origin/main`, using origin/main
 * as of the last `git fetch`. CHICKPEA_BUDGET_BASE names another ref, such
 * as the branch a stacked PR is based on. A checkout with no Git history (a
 * source export) or no such ref checks the ceiling alone, and says why.
 *
 * The unit. The commits from the base to HEAD are one change, measured from
 * the base to the working tree. When HEAD's first-parent history since the
 * base is only merges, as on a local merge of a PR onto origin/main or a
 * train of several, each merge is its own change, so a train of PRs that
 * each fit still passes.
 *
 * A note. A commit trailer `Worker-Startup-Growth: 40 KiB, <why>` in a
 * change raises its allowance to that size. It never lifts the ceiling.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const KIB = 1024;
export const GROWTH_ALLOWANCE_BYTES = 16 * KIB;
export const GROWTH_NOTE_TRAILER = 'Worker-Startup-Growth';
export const BUDGET_BASE_ENV = 'CHICKPEA_BUDGET_BASE';
const DEFAULT_BASE_REF = 'origin/main';

const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);
export const short = (commit) => commit.slice(0, 9);
export const kib = (bytes) => `${(bytes / KIB).toFixed(1)} KiB`;
const signedKib = (bytes) => `${bytes > 0 ? '+' : ''}${kib(bytes)}`;

function gitIn(root) {
  return (...args) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

/** A note's size in bytes, or undefined when it does not start with one such as `40 KiB`. */
export function noteAllowance(note) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*KiB\b/i.exec(note);
  return match ? Math.round(Number(match[1]) * KIB) : undefined;
}

function change(git, from, to, tip, label) {
  const notes = lines(git('log', `--format=%(trailers:key=${GROWTH_NOTE_TRAILER},valueonly)`, `${from}..${tip}`));
  const sizes = notes.map(noteAllowance).filter((size) => size !== undefined);
  return { from, to, label, notes, allowance: Math.max(GROWTH_ALLOWANCE_BYTES, ...sizes) };
}

/**
 * What a growth check compares: `{ base, ref, changes }`, or `{ skip }` saying
 * why it cannot. Each change is `{ from, to, label, notes, allowance }`, where
 * `to` is a commit, or undefined for the working tree.
 */
export function growthPlan(root, env = process.env) {
  const git = gitIn(root);
  const ref = env[BUDGET_BASE_ENV] || DEFAULT_BASE_REF;
  try {
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)) throw new Error('not this checkout');
  } catch {
    return { skip: 'This checkout has no Git history, so growth over a merge base is not checked; the ceiling still is.' };
  }
  let base;
  try {
    base = git('merge-base', 'HEAD', ref);
  } catch {
    return {
      skip: `No merge base with ${ref}, so growth is not checked; the ceiling still is. ` +
        `Run git fetch origin main, or set ${BUDGET_BASE_ENV} to the branch this one is based on.`,
    };
  }
  const chain = lines(git('rev-list', '--first-parent', '--reverse', `${base}..HEAD`));
  const parents = chain.map((commit) => git('rev-list', '--parents', '-n', '1', commit).split(' ').slice(1));
  const train = chain.length > 0 && parents.every((list) => list.length > 1) && parents[0][0] === base;
  const changes = train
    ? chain.map((commit, index) => change(git, parents[index][0], index === chain.length - 1 ? undefined : commit,
      commit, `merge ${short(commit)} (${git('log', '-1', '--format=%s', commit)})`))
    : [change(git, base, undefined, 'HEAD', 'this branch')];
  return { base, ref, changes };
}

/** A temporary directory holding `commit`'s tracked files, as `git archive` writes them. */
export function exportCommit(root, commit) {
  const directory = mkdtempSync(path.join(tmpdir(), 'chickpea-budget-'));
  const archive = execFileSync('git', ['-C', root, 'archive', commit], { maxBuffer: 1024 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  return directory;
}

/** Each module whose size changed, largest growth first, and the change in the total. */
export function compareSizes(before, after) {
  const total = (sizes) => [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
  const rows = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const delta = (after.get(name) ?? 0) - (before.get(name) ?? 0);
    if (delta !== 0) rows.push({ name, delta, added: !before.has(name), removed: !after.has(name) });
  }
  rows.sort((a, b) => b.delta - a.delta || a.name.localeCompare(b.name));
  return { growth: total(after) - total(before), rows };
}

/** The modules that grew, one per line, largest first. */
export function formatGrowth(rows, limit = 12) {
  const grew = rows.filter((row) => row.delta > 0);
  if (grew.length === 0) return '  (no module grew)';
  const shown = grew.slice(0, limit)
    .map((row) => `  ${signedKib(row.delta).padStart(11)}  ${row.name}${row.added ? ' (new)' : ''}`);
  if (grew.length > limit) shown.push(`  and ${grew.length - limit} more`);
  return shown.join('\n');
}

/** Why a change failed its growth allowance, naming the modules that grew. */
export function growthFailure({ what, change, ref, growth, rows }) {
  const span = `${short(change.from)}..${change.to ? short(change.to) : 'the working tree'}`;
  const unread = change.notes.filter((note) => noteAllowance(note) === undefined);
  return [
    `${what} grew ${kib(growth)} in ${change.label} (${span}), over the ${kib(change.allowance)} a change may add without a note.`,
    rows ? `Modules that grew:\n${formatGrowth(rows)}` : 'Rebuild with this checkout to see which modules grew.',
    'Load new code with import() where it is used, or, when the growth is deliberate, add a commit trailer ' +
      `"${GROWTH_NOTE_TRAILER}: <size> KiB, <why>" to this change.`,
    ...(unread.length ? [`These ${GROWTH_NOTE_TRAILER} notes name no size and were not counted: ${unread.join('; ')}`] : []),
    `The base comes from ${ref}; run git fetch origin main if it is behind.`,
  ].join('\n');
}
