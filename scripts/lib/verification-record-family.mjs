import { outsideGit } from './private-evidence.mjs';
import { currentSpec, readRun, status } from './verification-record.mjs';

export function readRunFamily(file, source, maxDepth = 32) {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 128) throw new Error('Run family depth must be an integer from 1 to 128.');
  const records = [], seenIds = new Set(), seenPaths = new Set();
  let path = outsideGit(file), expectedId, child;
  for (let depth = 0; path; depth += 1) {
    if (depth >= maxDepth) throw new Error('Run family exceeds the traversal limit.');
    if (seenPaths.has(path)) throw new Error('Run family contains a path cycle.');
    seenPaths.add(path);
    let run;
    try { run = readRun(path); }
    catch (cause) {
      if (records.length) return { records, missingAncestor: { path, runId: expectedId, error: cause.message } };
      throw cause;
    }
    if (expectedId && run.id !== expectedId) throw new Error('Parent run ID does not match the linked record.');
    if (seenIds.has(run.id)) throw new Error('Run family contains a run ID cycle.');
    seenIds.add(run.id);
    if (child) for (const [childId, original] of Object.entries(child.lineage.originalCases)) {
      if (!currentSpec(child).cases.some((entry) => entry.id === childId)) throw new Error('Original-case child was not found in its current spec.');
      if (original.runId !== run.id || !currentSpec(run).cases.some((entry) => entry.id === original.caseId)) throw new Error('Original-case mapping does not match the parent current spec.');
    }
    const current = records.length === 0;
    const recordedSource = run.events.findLast((event) => event.type === 'refresh')?.source ?? run.source;
    const asOf = run.events.at(-1)?.at ?? run.createdAt;
    records.push({ path, run, view: status(run, current ? source : recordedSource, current ? Date.now() : Date.parse(asOf)),
      statusSource: current ? 'current' : 'historical-recorded', ...(current ? {} : { asOf }) });
    child = run;
    expectedId = run.lineage?.parent?.runId;
    path = run.lineage?.parent?.path ? outsideGit(run.lineage.parent.path) : undefined;
  }
  return { records };
}

export function familyStatus(family) {
  const [current, ...ancestors] = family.records;
  return { current: current.view, complete: !family.missingAncestor && current.view.complete && ancestors.every((entry) => entry.view.complete),
    ancestors: ancestors.map((entry) => ({ path: entry.path, runId: entry.run.id, complete: entry.view.complete, statusSource: entry.statusSource, asOf: entry.asOf,
      unresolvedCases: entry.view.cases.filter((item) => item.result !== 'pass').map((item) => ({ id: item.id, result: item.result })),
      cleanupPending: entry.view.resources.filter((item) => item.cleanup !== 'verified').map((item) => item.id),
      firstFailures: entry.view.cases.filter((item) => item.firstFailure).map((item) => ({ caseId: item.id, outcome: item.firstFailure })) })),
    missingAncestor: family.missingAncestor };
}

export function renderFamilyReport(view, renderCurrent) {
  const lines = [renderCurrent(view.current), '', '## Run family', '',
    `Family completion: ${view.complete}. A child run cannot satisfy incomplete ancestor scope.`];
  for (const ancestor of view.ancestors) {
    lines.push(`- Historical parent ${ancestor.runId} at ${ancestor.path}, graded as of ${ancestor.asOf} against its latest recorded source: complete ${ancestor.complete}; unresolved cases ${ancestor.unresolvedCases.map((item) => `${item.id}/${item.result}`).join(', ') || 'none'}; pending cleanup ${ancestor.cleanupPending.join(', ') || 'none'}.`);
    for (const failure of ancestor.firstFailures) lines.push(`- Parent ${ancestor.runId} first failure for ${failure.caseId}: ${failure.outcome.result} / ${failure.outcome.category}. ${failure.outcome.summary}`);
  }
  if (view.missingAncestor) lines.push(`- Missing ancestor ${view.missingAncestor.runId ?? 'unknown'} at ${view.missingAncestor.path}: ${view.missingAncestor.error}`);
  return lines.join('\n');
}
