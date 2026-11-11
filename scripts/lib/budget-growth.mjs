/**
 * Growth budgets for Worker startup: a change may add at most
 * GROWTH_ALLOWANCE_BYTES over its merge base. The startup-source check
 * (tests/worker-startup-imports.test.ts) also keeps a fixed ceiling that
 * backstops its total; the built closure (scripts/worker-closure.mjs) has
 * only the growth rule. Two PRs that each fit a ceiling set just above
 * today's size fail together once both merge; measured against their own
 * merge bases, each passes alone.
 *
 * The merge base. Every check runs locally with no CI to name a PR's base,
 * so Git supplies it: `git merge-base HEAD origin/main`, using origin/main
 * as of the last `git fetch`. CHICKPEA_BUDGET_BASE names another ref, such
 * as the branch a stacked PR is based on; one with no merge base fails. A
 * checkout with no Git history (a source export), or no origin/main, skips
 * the growth rule and says why.
 *
 * The unit. A branch is one change, measured from the base to the working
 * tree, including a branch that merged main in. A train is HEAD's
 * first-parent history when it starts on the base and holds a merge, as when
 * PRs are merged onto origin/main with --no-ff. Each merge in it is one
 * change, measured from its first parent, and so is each run of plain
 * commits between merges, such as the train's startup-source ceiling re-set.
 * So a train of PRs that each fit still passes. A branch shaped like a train
 * is measured like one. The last change is measured to the working tree.
 *
 * A note. A commit trailer `Worker-Startup-Growth: 40 KiB, <why>` raises the
 * allowance of the change that holds it to the size it names, at most
 * NOTE_LIMIT_BYTES. It never lifts a ceiling. Each check prints the notes
 * it counts, and a PR that carries one lists it in its description.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const KIB = 1024;
export const GROWTH_ALLOWANCE_BYTES = 16 * KIB;
export const NOTE_LIMIT_BYTES = 128 * KIB;
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

/** A note's size in bytes, or undefined unless it starts with one such as `40 KiB`, at most NOTE_LIMIT_BYTES. */
export function noteAllowance(note) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*KiB\b/i.exec(note);
  const bytes = match ? Math.round(Number(match[1]) * KIB) : undefined;
  return bytes !== undefined && bytes <= NOTE_LIMIT_BYTES ? bytes : undefined;
}

function change(git, from, to, tip, label) {
  const notes = lines(git('log', `--format=%(trailers:key=${GROWTH_NOTE_TRAILER},valueonly)`, `${from}..${tip}`));
  const sizes = notes.map(noteAllowance).filter((size) => size !== undefined);
  return { from, to, label, notes, allowance: Math.max(GROWTH_ALLOWANCE_BYTES, ...sizes) };
}

/**
 * What a growth check compares: `{ base, ref, changes }`, `{ skip }` saying
 * why it cannot, or `{ error }` when CHICKPEA_BUDGET_BASE names a ref with no
 * merge base. Each change is `{ from, to, label, notes, allowance }`, where
 * `to` is a commit, or undefined for the working tree.
 */
export function growthPlan(root, env = process.env) {
  const git = gitIn(root);
  const named = env[BUDGET_BASE_ENV];
  const ref = named || DEFAULT_BASE_REF;
  try {
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)) throw new Error('not this checkout');
  } catch {
    return { skip: 'This checkout has no Git history, so growth over a merge base is not checked.' };
  }
  let base;
  try {
    base = git('merge-base', 'HEAD', ref);
  } catch {
    if (named) return { error: `${BUDGET_BASE_ENV}=${named} has no merge base with HEAD. Set it to the branch this one is based on.` };
    return {
      skip: `No merge base with ${ref}, so growth is not checked. ` +
        `Run git fetch origin main, or set ${BUDGET_BASE_ENV} to the branch this one is based on.`,
    };
  }
  const chain = lines(git('rev-list', '--first-parent', '--reverse', `${base}..HEAD`));
  const parents = chain.map((commit) => git('rev-list', '--parents', '-n', '1', commit).split(' ').slice(1));
  const merge = (index) => parents[index].length > 1;
  const train = chain.length > 0 && parents[0][0] === base && chain.some((_, index) => merge(index));
  if (!train) return { base, ref, changes: [change(git, base, undefined, 'HEAD', 'this branch')] };
  const changes = [];
  let from = base;
  let start = 0;
  chain.forEach((commit, index) => {
    const last = index === chain.length - 1;
    // A run of plain commits ends before the next merge or at HEAD.
    if (!merge(index) && !last && !merge(index + 1)) return;
    const subject = git('log', '-1', '--format=%s', commit);
    const what = merge(index) ? 'merge' : index === start ? 'commit' : `${index - start + 1} commits to`;
    changes.push(change(git, from, last ? undefined : commit, commit, `${what} ${short(commit)} (${subject})`));
    from = commit;
    start = index + 1;
  });
  return { base, ref, changes };
}

/** A temporary directory holding `commit`'s tracked files, or those under `paths`, as `git archive` writes them. */
export function exportCommit(root, commit, paths = []) {
  const directory = mkdtempSync(path.join(tmpdir(), 'chickpea-budget-'));
  const archive = execFileSync('git', ['-C', root, 'archive', commit, ...paths], { maxBuffer: 1024 * 1024 * 1024 });
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

/** What a check prints for each change it measures, pass or fail: its growth, allowance and notes. */
export function growthLine(change, growth) {
  const notes = change.notes.length ? ` ${GROWTH_NOTE_TRAILER}: ${change.notes.join('; ')}.` : '';
  return `Growth in ${change.label} since ${short(change.from)}: ${kib(growth)}, allowed ${kib(change.allowance)}.${notes}`;
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
    ...(unread.length ? [`These ${GROWTH_NOTE_TRAILER} notes were not counted, since a note starts with its size, ` +
      `at most ${kib(NOTE_LIMIT_BYTES)}: ${unread.join('; ')}`] : []),
    `The base comes from ${ref}; run git fetch origin main if it is behind.`,
  ].join('\n');
}
