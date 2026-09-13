import { currentSpec } from './verification-record.mjs';

const ARCHIVED_AGENT = { lifecycle: 'archived', channelCount: 0, dmAccess: 'unavailable' };
const ABSENT = { present: false };
const PROOF_SURFACES = new Set(['slack', 'admin', 'provider', 'model']);

const many = (value) => value ?? [];
const integer = (value, fallback) => value === undefined ? fallback : Number(value);

export function buildCase(spec, flags) {
  return {
    id: flags.case, title: flags.title, context: flags.context,
    areas: many(flags.area), requires: many(flags.require), proof: many(flags.proof),
    maxAttempts: integer(flags.maxAttempts, 2), maxWaitMs: integer(flags.maxWaitMs, 120_000),
    minObservationMs: integer(flags.minObservationMs, 0),
    ...Object.fromEntries(['originalRequest', 'expectedOutcome', 'variant', 'cleanup']
      .filter((key) => flags[key] !== undefined).map((key) => [key, flags[key]])),
  };
}

export function proofMap(values) {
  const proof = Object.create(null);
  for (const value of many(values)) {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) throw new Error('Proof must use SURFACE=/absolute/evidence/path.');
    const surface = value.slice(0, separator), path = value.slice(separator + 1);
    if (!PROOF_SURFACES.has(surface)) throw new Error('Unknown proof surface.');
    (proof[surface] ??= []).push(path);
  }
  return proof;
}

export function buildResource(run, flags, readJson) {
  const spec = currentSpec(run), selected = spec.cases.find((entry) => entry.id === flags.case);
  if (!selected) throw new Error('Unknown selected case.');
  let expected, before;
  if (flags.cleanupPreset && flags.expectedFile) throw new Error('Choose either --cleanup-preset or --expected-file.');
  if (flags.ownership === 'restore' || flags.ownership === 'retain') {
    if (flags.cleanupPreset || !flags.expectedFile) throw new Error('Restore and retain resources require an exact --expected-file and do not accept presets.');
    expected = readJson(flags.expectedFile); before = structuredClone(expected);
  } else if (flags.cleanupPreset === 'absent') expected = structuredClone(ABSENT);
  else if (flags.cleanupPreset === 'archived-agent') {
    if (flags.kind !== 'agent') throw new Error('The archived-agent preset only applies to Agent resources.');
    expected = structuredClone(ARCHIVED_AGENT);
  } else if (flags.cleanupPreset) throw new Error('Unknown cleanup preset.');
  else if (flags.expectedFile) expected = readJson(flags.expectedFile);
  else throw new Error('Resource needs --cleanup-preset or --expected-file.');
  return { type: 'resource', caseId: flags.case, target: spec.contexts[selected.context].target,
    provider: flags.provider, kind: flags.kind, immutableId: flags.resourceId, ownership: flags.ownership,
    expected, ...(before === undefined ? {} : { before }), evidence: many(flags.evidence),
    ...(flags.stopAt ? { stopAt: flags.stopAt } : {}),
    ...(flags.maxOccurrences === undefined ? {} : { maxOccurrences: Number(flags.maxOccurrences) }) };
}

export function buildOutcome(type, flags) {
  return { type, attemptId: flags.attempt, result: flags.result, summary: flags.summary,
    ...(flags.category ? { category: flags.category } : {}), evidence: many(flags.evidence), proof: proofMap(flags.proof),
    ...(flags.completedAt ? { completedAt: flags.completedAt } : {}),
    ...(flags.observedAt ? { observedAt: flags.observedAt } : {}),
    ...(flags.timingObservationMs === undefined ? {} : { timing: { observationMs: Number(flags.timingObservationMs) } }),
    ...(flags.costUsd === undefined ? {} : { costUsd: flags.costUsd === 'unknown' ? null : Number(flags.costUsd) }) };
}

export function buildCleanup(flags, readJson) {
  return { type: 'cleanup', resourceId: flags.resource, outcome: flags.outcome,
    ...(flags.observedFile ? { observed: readJson(flags.observedFile) } : {}), evidence: many(flags.evidence) };
}
