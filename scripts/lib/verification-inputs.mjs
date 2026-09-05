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

/** Hash working contents, including untracked inputs, without touching the index. */
export function sourceInputs(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const files = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))].sort();
  const testFiles = Object.values(REGRESSION_AREAS).flat().map((name) => `tests/${name}.test.ts`);
  const byArea = Object.fromEntries(Object.keys(REGRESSION_AREAS).map((area) => [area, []]));
  const entries = files.map((file) => {
    let content;
    try {
      const stat = lstatSync(join(root, file));
      content = stat.isSymbolicLink() ? `link:${readlinkSync(join(root, file))}`
        : stat.isFile() ? `${stat.mode & 0o111}:${digest(readFileSync(join(root, file)))}` : 'non-file';
    } catch (error) { if (error.code !== 'ENOENT') throw error; content = 'deleted'; }
    const entry = [file, content];
    const plan = createRegressionPlan({ files: [file], testFiles: [...new Set([...testFiles, ...(file.startsWith('tests/') ? [file] : [])])] });
    for (const area of plan.areas) byArea[area].push(entry);
    return entry;
  });
  return {
    head: git('rev-parse', 'HEAD').trim(), dirty: git('status', '--porcelain').trim().length > 0,
    tree: digest(entries), areas: Object.fromEntries(Object.entries(byArea).map(([key, value]) => [key, digest(value)])),
  };
}

export function caseInputs(spec, selected, source) {
  return {
    contract: digest(selected),
    source: Object.fromEntries(selected.areas.map((area) => [area, source.areas[area]])),
    context: spec.contexts[selected.context],
    actors: Object.fromEntries(selected.requires.filter((id) => spec.capabilities[id]?.kind === 'actor')
      .map((id) => [id, { identity: spec.capabilities[id].identity, role: spec.capabilities[id].role }])),
    prerequisites: prerequisiteInputs(spec, selected),
  };
}

export function prerequisiteInputs(spec, selected) {
  return Object.fromEntries(selected.requires.map((id) => [id, {
    kind: spec.capabilities[id]?.kind ?? null, expectedRole: spec.capabilities[id]?.expectedRole ?? null,
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
