import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createRegressionPlan, REGRESSION_AREAS } from './regression-plan.mjs';

export const digest = (value) => createHash('sha256').update(
  typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value)),
).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export const CORE_AREA_NAMES = Object.freeze(Object.keys(REGRESSION_AREAS));
// A profile (v2) record fingerprints its profile's areas; a standalone (v1)
// record, which readRun guarantees has no profile block, fingerprints Core's.
export const areaNames = (run) => run.profile?.areas ?? CORE_AREA_NAMES;
const CORE_TEST_FILES = Object.values(REGRESSION_AREAS).flat().map((name) => `tests/${name}.test.ts`);

/** List one Git working tree's contents, including untracked inputs, without touching the index.
 * Ignored files are invisible. */
export function treeEntries(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  // A submodule would hash as a constant, so moving its commit could never
  // make evidence stale. Refuse one rather than weaken staleness silently.
  const submodules = git('ls-files', '-s', '-z').split('\0').filter((line) => line.startsWith('160000 ')).map((line) => line.slice(line.indexOf('\t') + 1));
  if (submodules.length) throw new Error(`Submodules are not supported by the verification fingerprint: ${submodules.join(', ')}.`);
  const files = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))].sort();
  const entries = files.map((file) => {
    let content;
    try {
      const stat = lstatSync(join(root, file));
      content = stat.isSymbolicLink() ? `link:${readlinkSync(join(root, file))}`
        : stat.isFile() ? `${stat.mode & 0o111}:${digest(readFileSync(join(root, file)))}` : 'non-file';
    } catch (error) { if (error.code !== 'ENOENT') throw error; content = 'deleted'; }
    return [file, content];
  });
  return { head: git('rev-parse', 'HEAD').trim(), dirty: git('status', '--porcelain').trim().length > 0, entries };
}

/** Fingerprint the whole tree and each named area over the entries `areasOf(file)` assigns to it. */
export function areaFingerprints(entries, names, areasOf) {
  const byArea = Object.fromEntries(names.map((area) => [area, []]));
  for (const entry of entries) {
    for (const area of areasOf(entry[0])) {
      if (!Object.hasOwn(byArea, area)) throw new Error(`Area classifier returned unknown area ${area}.`);
      byArea[area].push(entry);
    }
  }
  return { tree: digest(entries), areas: Object.fromEntries(Object.entries(byArea).map(([key, value]) => [key, digest(value)])) };
}

/** Core's per-file classification: the areas a change to this one file selects. */
export function coreAreasOf(file) {
  return createRegressionPlan({ files: [file], testFiles: [...new Set([...CORE_TEST_FILES, ...(file.startsWith('tests/') ? [file] : [])])] }).areas;
}

/** Hash working contents, including untracked inputs, without touching the index. */
export function sourceInputs(root) {
  const { head, dirty, entries } = treeEntries(root);
  return { head, dirty, ...areaFingerprints(entries, CORE_AREA_NAMES, coreAreasOf) };
}

export function caseInputs(spec, selected, source) {
  return {
    contract: digest(selected),
    // A missing area would serialize as nothing and never go stale.
    source: Object.fromEntries(selected.areas.map((area) => {
      if (typeof source.areas?.[area] !== 'string') throw new Error(`Source provider does not fingerprint area ${area}.`);
      return [area, source.areas[area]];
    })),
    context: spec.contexts[selected.context],
    actors: Object.fromEntries(selected.requires.filter((id) => spec.capabilities[id]?.kind === 'actor')
      .map((id) => [id, { identity: spec.capabilities[id].identity, role: spec.capabilities[id].role }])),
    prerequisites: prerequisiteInputs(spec, selected),
  };
}

export function prerequisiteInputs(spec, selected) {
  return Object.fromEntries(selected.requires.map((id) => [id, {
    kind: spec.capabilities[id]?.kind ?? null, expectedRole: spec.capabilities[id]?.expectedRole ?? null,
    ...(spec.capabilities[id]?.scope ? { scope: spec.capabilities[id].scope } : {}),
  }]));
}

// Older journals retain the complete spec at each refresh. Derive the missing
// contract from that historical snapshot without rewriting the original begin.
export function recordedInputs(run, attempt) {
  if (attempt.inputs.prerequisites) return attempt.inputs;
  const spec = run.events.findLast((e) => e.type === 'refresh' && e.sequence < attempt.sequence)?.spec ?? run.spec;
  return { ...attempt.inputs, prerequisites: prerequisiteInputs(spec, spec.cases.find((c) => c.id === attempt.caseId)) };
}

export function changedInputs(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => digest(before[key] ?? null) !== digest(after[key] ?? null));
}
