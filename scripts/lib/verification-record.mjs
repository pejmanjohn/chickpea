// Recordkeeping for the attended skill. This module performs no live actions.
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { outsideGit } from './private-evidence.mjs';
import { caseInputs, changedInputs, digest, recordedInputs } from './verification-inputs.mjs';
import { REGRESSION_AREAS } from './regression-plan.mjs';
import { isExactId } from '../live-test-resource-ledger.mjs';
import { recordRepair, repairBlocks, repairInputs, repairProgress } from './verification-repairs.mjs';
import { offlineProgress } from './verification-offline.mjs';
import { NODE_BASELINE } from './node-version.mjs';
import { recordTransition, transitionInputs } from './verification-transition.mjs';

const SCHEMA = 'chickpea-attended-run/v1';
const GRADES = ['local', 'deployed', 'model'];
const RESULTS = ['pass', 'fail', 'blocked', 'ambiguous'];
const CATEGORIES = ['product', 'model', 'tool', 'infrastructure', 'unknown'];
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const need = (v, message) => { if (!v) throw new Error(message); };
const list = (v) => Array.isArray(v) && v.every(text);
const number = (v) => Number.isFinite(v) && v >= 0;
const keys = (v, allowed) => need(v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).every((key) => allowed.includes(key)), 'Unexpected record fields.');
const date = (v) => text(v) && Number.isFinite(Date.parse(v));

function noSecrets(value) {
  if (typeof value === 'string') need(!/(?:xox[baprs]-|\bsk-[A-Za-z0-9]{12}|Bearer\s+|-----BEGIN .*PRIVATE KEY-----)/i.test(value), 'Secret-like record value refused.');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    need(!/(?:password|credential|authorization|cookie|secret|accessToken|refreshToken)/i.test(key), 'Secret-bearing record field refused.');
    noSecrets(child);
  }
}

export function readPrivateJson(file) {
  const path = outsideGit(file);
  need(lstatSync(path).size <= 8 * 1024 * 1024, 'Record input exceeds 8 MiB.');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function validateSpec(spec) {
  keys(spec, ['mode', 'purpose', 'contexts', 'capabilities', 'cases']);
  noSecrets(spec);
  need(['changed', 'regression', 'release'].includes(spec.mode), 'Choose changed, regression, or release.');
  need(['verification', 'reliability'].includes(spec.purpose), 'Choose verification or intentional reliability testing.');
  need(spec.contexts && typeof spec.contexts === 'object', 'Contexts are required.');
  for (const [id, context] of Object.entries(spec.contexts)) {
    need(isExactId(id), 'Invalid context ID.');
    keys(context, ['grade', 'target', 'servingVersion', 'model', 'actor', 'fixtures', 'state', 'config']);
    need(GRADES.includes(context.grade), 'Context grade must be local, deployed, or model.');
    for (const field of ['target', 'servingVersion', 'model', 'actor', 'fixtures', 'state', 'config']) need(text(context[field]), `Context needs ${field}.`);
  }
  need(spec.capabilities && typeof spec.capabilities === 'object', 'Capabilities are required.');
  for (const [id, cap] of Object.entries(spec.capabilities)) {
    need(isExactId(id), 'Invalid capability ID.');
    keys(cap, ['available', 'kind', 'registered', 'identity', 'role', 'expectedRole', 'observedAt', 'expiresAt', 'evidence', 'reason']);
    need(typeof cap.available === 'boolean' && ['actor', 'fixture', 'tool', 'target'].includes(cap.kind), 'Capability needs availability and kind.');
    need(cap.expectedRole === undefined || ['owner', 'admin', 'member'].includes(cap.expectedRole), 'Invalid expected actor role.');
    need(date(cap.observedAt) && date(cap.expiresAt) && Date.parse(cap.expiresAt) > Date.parse(cap.observedAt), 'Capability needs a bounded observation window.');
    need(list(cap.evidence), 'Capability evidence references must be a list.');
    if (cap.available) {
      need(cap.evidence.length > 0, 'Available capability needs readback evidence.');
      if (cap.kind === 'actor') need(text(cap.identity) && ['owner', 'admin', 'member'].includes(cap.role), 'Actor needs observed identity and role.');
    } else need(text(cap.reason), 'Missing capability needs a reason.');
  }
  need(Array.isArray(spec.cases), 'Selected cases must be a list.');
  const ids = new Set();
  for (const selected of spec.cases) {
    keys(selected, ['id', 'title', 'context', 'areas', 'requires', 'proof', 'maxAttempts', 'maxWaitMs', 'minObservationMs']);
    need(isExactId(selected.id) && !ids.has(selected.id), 'Case IDs must be unique exact IDs.'); ids.add(selected.id);
    need(text(selected.title) && spec.contexts[selected.context], 'Case needs a title and a known context.');
    need(list(selected.areas) && selected.areas.length > 0 && selected.areas.every((area) => Object.hasOwn(REGRESSION_AREAS, area)), 'Case needs known dependency areas.');
    need(list(selected.requires) && selected.requires.length > 0, 'Declare case capabilities, including required actors and fixtures.');
    need(list(selected.proof) && selected.proof.length > 0 && selected.proof.every((p) => ['slack', 'admin', 'provider', 'model'].includes(p)), 'Declare proof surfaces.');
    if (spec.contexts[selected.context].grade !== 'model') need(selected.proof.includes('slack'), 'Live cases require Slack proof.');
    need(Number.isSafeInteger(selected.maxAttempts) && selected.maxAttempts > 0 && selected.maxAttempts <= (spec.purpose === 'reliability' ? 100 : 3), 'Attempt budget must be 1..3, or 1..100 for reliability.');
    need(number(selected.maxWaitMs) && selected.maxWaitMs > 0 && selected.maxWaitMs <= 120_000, 'Each observation wait must be bounded to 120 seconds.');
    need(number(selected.minObservationMs ?? 0) && (selected.minObservationMs ?? 0) <= selected.maxWaitMs, 'Invalid minimum observation duration.');
  }
  if (spec.mode === 'release') need(spec.cases.some((c) => spec.contexts[c.context].grade === 'deployed'), 'Release scope needs deployed acceptance cases.');
  return spec;
}

export function evidenceRefs(refs) {
  need(list(refs) && refs.length > 0, 'Evidence references are required.');
  return refs.map((file) => {
    const path = outsideGit(file);
    need(lstatSync(path).isFile(), 'Evidence must be a regular file.');
    return { path, digest: digest(readFileSync(path)) };
  });
}
function intact(refs) {
  return refs.every((ref) => {
    try { return digest(readFileSync(outsideGit(ref.path))) === ref.digest; } catch { return false; }
  });
}

function atomicWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, file);
}

export function createRun(file, spec, source, now = Date.now()) {
  const path = outsideGit(file);
  validateSpec(spec);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const run = { schema: SCHEMA, id: randomUUID(), createdAt: new Date(now).toISOString(), spec, source, events: [] };
  // Capture the initial capability receipts, so later changes to evidence are visible.
  run.capabilityEvidence = captureCapabilities(spec);
  writeFileSync(path, `${JSON.stringify(run, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return run;
}
function captureCapabilities(spec) {
  return Object.fromEntries(Object.entries(spec.capabilities).map(([id, cap]) => [id, cap.evidence.length ? evidenceRefs(cap.evidence) : []]));
}
export function readRun(file) {
  const run = readPrivateJson(file);
  need(run.schema === SCHEMA && text(run.id) && Array.isArray(run.events), 'Not an attended run record. Do not migrate an active legacy journal.');
  validateSpec(run.spec);
  noSecrets(run);
  need(run.events.every((event, index) => event.sequence === index + 1 && event.runId === run.id), 'Run event sequence is invalid.');
  return run;
}

/** Atomic whole-record replacement; refuse concurrent writers, never steal a lock. */
export function updateRun(file, callback) {
  const path = outsideGit(file);
  const lock = `${path}.lock`;
  let fd;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new Error('Run record is locked. Reconcile the owning process before removing its exact lock file.'); }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const run = readRun(path);
    const result = callback(run);
    noSecrets(run);
    atomicWrite(path, run);
    return result;
  } finally { closeSync(fd); unlinkSync(lock); }
}

// Only the existing offline runner calls this API. The attended event CLI
// cannot manufacture automated check receipts or release checkpoints.
export function offlineEvent(run, value, now = Date.now()) {
  need(['offline_plan', 'offline_begin', 'offline_finish', 'offline_reuse', 'offline_summary', 'checkpoint'].includes(value.type), 'Invalid offline receipt.');
  const event = { ...value, id: randomUUID(), runId: run.id, sequence: run.events.length + 1, at: new Date(now).toISOString() };
  run.events.push(event);
  return event;
}

export function reusableOffline(run, label, fingerprint) {
  // Builds regenerate ignored artifacts even when the source is identical.
  if (label === 'npm:build') return undefined;
  const latest = run.events.findLast((e) => ['offline_begin', 'offline_finish'].includes(e.type) && e.label === label);
  if (latest?.type === 'offline_finish' && latest.result === 'pass' && latest.fingerprint === fingerprint && intact(latest.evidence)) return latest;
  return undefined;
}

export function currentSpec(run) {
  return run.events.findLast((event) => event.type === 'refresh')?.spec ?? run.spec;
}
function capabilities(run) {
  return run.events.findLast((event) => event.type === 'refresh')?.capabilityEvidence ?? run.capabilityEvidence;
}
function attempts(run, caseId) { return run.events.filter((event) => event.type === 'begin' && event.caseId === caseId); }
function resultFor(run, id) { return run.events.findLast((event) => ['finish', 'resolve'].includes(event.type) && event.attemptId === id); }
function reconcileFor(run, id) { return run.events.findLast((event) => event.type === 'reconcile' && event.attemptId === id); }
const attendedInputs = (run, spec, selected, source) => ({ ...caseInputs(spec, selected, source), ...repairInputs(run, selected.id) });

export function preflight(run, now = Date.now()) {
  const spec = currentSpec(run);
  const receipts = capabilities(run);
  const cases = spec.cases.map((selected) => {
    const blockers = [], warnings = [];
    const actors = new Map();
    for (const [key, value] of Object.entries(spec.contexts[selected.context])) {
      if (value === 'unresolved') blockers.push(`context.${key}: not resolved`);
    }
    for (const id of selected.requires) {
      const cap = spec.capabilities[id];
      if (!cap?.available) blockers.push(`${id}: ${cap?.reason ?? 'not inventoried'}`);
      else if (Date.parse(cap.observedAt) > now || Date.parse(cap.expiresAt) <= now || !intact(receipts[id] ?? [])) blockers.push(`${id}: observation expired or evidence changed`);
      else if (cap.kind === 'actor') {
        if (cap.expectedRole && cap.role !== cap.expectedRole) blockers.push(`${id}: expected ${cap.expectedRole}, observed ${cap.role}`);
        if (actors.has(cap.identity) && actors.get(cap.identity) !== id) blockers.push(`${id}: distinct actor required; identity duplicates ${actors.get(cap.identity)}`);
        actors.set(cap.identity, id);
        if (cap.registered === false) warnings.push(`${id}: registry warning; observed ${cap.role} identity has readback evidence`);
      }
    }
    const suspendedBy = repairBlocks(run, spec, selected.id);
    blockers.push(...suspendedBy.map((id) => `repair ${id}: dependent actions suspended`));
    return { id: selected.id, ready: blockers.length === 0, blockers, warnings, suspendedBy };
  });
  return { ready: cases.every((c) => c.ready), runnable: cases.filter((c) => c.ready).map((c) => c.id), cases };
}

export function ownedResources(run, now = Date.now()) {
  return run.events.filter((event) => event.type === 'resource').map((resource) => {
    const cleanup = run.events.findLast((event) => event.type === 'cleanup' && event.resourceId === resource.id);
    const occurrences = new Set(run.events.filter((event) => event.type === 'occurrence' && event.resourceId === resource.id).map((event) => event.occurrenceId)).size;
    const verified = cleanup?.outcome === 'verified' && intact(cleanup.evidence);
    const failedCase = run.events.some((event) => ['finish', 'resolve'].includes(event.type)
      && event.sequence > resource.sequence && event.result !== 'pass'
      && attempts(run, resource.caseId).some((attempt) => attempt.id === event.attemptId));
    const stopDue = !verified && resource.kind === 'schedule' && (now >= Date.parse(resource.stopAt) || occurrences >= resource.maxOccurrences || failedCase);
    return { ...resource, cleanup: verified ? 'verified' : cleanup?.outcome === 'failed' ? 'failed' : 'pending', occurrences, stopDue };
  });
}

export function appendEvent(run, input, source, now = Date.now()) {
  noSecrets(input);
  const spec = currentSpec(run);
  const event = { ...structuredClone(input), id: randomUUID(), runId: run.id, sequence: run.events.length + 1, at: new Date(now).toISOString() };
  const selected = spec.cases.find((c) => c.id === input.caseId);
  const attempt = run.events.find((e) => e.type === 'begin' && e.id === input.attemptId);
  const resource = run.events.find((e) => e.type === 'resource' && e.id === input.resourceId);
  switch (input.type) {
    case 'candidate_transition':
      Object.assign(event, recordTransition(run, spec, structuredClone(input), source, evidenceRefs, intact, now));
      break;
    case 'repair':
    case 'batch':
    case 'batch_check':
      Object.assign(event, recordRepair(run, spec, structuredClone(input), source, evidenceRefs, now, intact));
      break;
    case 'refresh': {
      keys(input, ['type', 'spec', 'reason']);
      validateSpec(input.spec); need(text(input.reason), 'Refresh needs a reason.');
      // A resume cannot silently shrink selected acceptance or change its mode.
      need(input.spec.mode === spec.mode && input.spec.purpose === spec.purpose && spec.cases.every((c) => input.spec.cases.some((next) => next.id === c.id
        && ['areas', 'requires', 'proof'].every((field) => c[field].every((item) => next[field].includes(item)))
        && (next.minObservationMs ?? 0) >= (c.minObservationMs ?? 0) && next.maxAttempts <= c.maxAttempts)), 'Refresh cannot drop or weaken selected coverage or expand its attempt budget.');
      need(spec.cases.every((c) => {
        const next = input.spec.cases.find((item) => item.id === c.id);
        return input.spec.contexts[next.context].grade === spec.contexts[c.context].grade;
      }), 'Refresh cannot change a selected case acceptance grade; add a separate Local repair case.');
      const required = new Set(spec.cases.flatMap((c) => c.requires));
      need([...required].every((id) => {
        const before = spec.capabilities[id], after = input.spec.capabilities[id];
        return !before || after && before.kind === after.kind && (!before.expectedRole || after.expectedRole === before.expectedRole);
      }), 'Refresh cannot remove a required capability contract or weaken its kind/expected actor role.');
      event.capabilityEvidence = captureCapabilities(input.spec);
      event.source = source;
      break;
    }
    case 'begin': {
      keys(input, ['type', 'caseId', 'reason']);
      need(selected, 'Unknown selected case.');
      need(preflight(run, now).cases.find((c) => c.id === selected.id)?.ready, 'Case preflight is blocked. Refresh its capability readbacks.');
      need(!ownedResources(run, now).some((r) => r.stopDue), 'A schedule reached its stop condition. Reconcile and record exact cleanup first.');
      const prior = attempts(run, selected.id);
      need(prior.length < selected.maxAttempts, 'Attempt budget exhausted. Preserve the failure and choose an explicitly bounded follow-up run.');
      if (prior.length) {
        const last = prior.at(-1), result = resultFor(run, last.id), reconciliation = reconcileFor(run, last.id);
        need(result, 'Prior attempt is still open. Observe it and finish it before retrying.');
        need(result.result !== 'ambiguous' || reconciliation?.outcome === 'not_applied', 'Ambiguous action needs authoritative not_applied readback before replay.');
        need(text(input.reason), 'Retest needs a diagnosis and changed variable.');
      }
      event.inputs = attendedInputs(run, spec, selected, source);
      event.source = source;
      event.deadline = new Date(now + selected.maxWaitMs).toISOString();
      break;
    }
    case 'finish':
    case 'resolve': {
      keys(input, ['type', 'attemptId', 'result', 'category', 'summary', 'evidence', 'proof', 'timing', 'costUsd']);
      need(attempt, 'Attempt not found.');
      const prior = resultFor(run, attempt.id);
      if (input.type === 'finish') need(!prior, 'Attempt already finished; its first outcome is immutable.');
      else need(prior?.result === 'ambiguous' && reconcileFor(run, attempt.id)?.outcome === 'applied', 'Resolve requires an applied readback of the ambiguous action.');
      need(RESULTS.includes(input.result) && text(input.summary), 'Finish needs a result and expected/observed summary.');
      if (input.result !== 'pass') need(CATEGORIES.includes(input.category), 'Classify product, model, tool, infrastructure, or unknown failure.');
      event.evidence = evidenceRefs(input.evidence);
      need(input.proof && typeof input.proof === 'object' && !Array.isArray(input.proof), 'Proof must map surfaces to evidence paths.');
      event.proof = Object.fromEntries(Object.entries(input.proof).map(([surface, refs]) => {
        need(['slack', 'admin', 'provider', 'model'].includes(surface), 'Unknown proof surface.');
        return [surface, evidenceRefs(refs)];
      }));
      const contract = spec.cases.find((c) => c.id === attempt.caseId);
      if (input.result === 'pass') {
        need(changedInputs(recordedInputs(run, attempt), attendedInputs(run, spec, contract, source)).length === 0, 'Attempt inputs changed; preserve it as a non-pass and retest.');
        need(repairBlocks(run, spec, contract.id).length === 0, 'Dependent actions are suspended by a repair; preserve a non-pass until safe retesting.');
        need(contract.proof.every((p) => event.proof[p]?.length > 0), 'Pass lacks a required Slack/Admin/provider/model readback.');
        need((input.timing?.observationMs ?? 0) >= (contract.minObservationMs ?? 0), 'Declared observation window is incomplete.');
      }
      if (input.timing) {
        keys(input.timing, ['automatedMs', 'browserMs', 'modelMs', 'humanWaitMs', 'observationMs']);
        need(Object.values(input.timing).every((v) => number(v) && v <= now - Date.parse(attempt.at)), 'Timing must fit the elapsed attempt.');
      }
      need(input.costUsd === undefined || input.costUsd === null || number(input.costUsd), 'Cost must be measured or null.');
      event.elapsedMs = now - Date.parse(attempt.at);
      break;
    }
    case 'reconcile':
      keys(input, ['type', 'attemptId', 'outcome', 'summary', 'evidence']);
      need(attempt && resultFor(run, attempt.id)?.result === 'ambiguous', 'Only ambiguous attempts need reconciliation.');
      need(['applied', 'not_applied', 'unknown'].includes(input.outcome) && text(input.summary), 'Reconciliation needs an observed outcome.');
      event.evidence = evidenceRefs(input.evidence);
      break;
    case 'offline_interrupted': {
      keys(input, ['type', 'attemptId', 'summary', 'processesStopped', 'evidence']);
      const started = run.events.find((e) => e.type === 'offline_begin' && e.id === input.attemptId);
      need(started && !run.events.some((e) => e.type === 'offline_finish' && e.attemptId === started.id), 'No open offline attempt with that ID.');
      need(input.processesStopped === true && text(input.summary), 'Inspect the owning command and its descendants before recording interruption.');
      let alive = true;
      try { process.kill(started.ownerPid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      need(!alive, 'The owning offline process still exists; do not retry concurrently.');
      Object.assign(event, { type: 'offline_finish', planId: started.planId, attemptId: started.id,
        label: started.label, fingerprint: started.fingerprint, node: started.node,
        result: 'fail', category: 'infrastructure', durationMs: now - Date.parse(started.at), evidence: evidenceRefs(input.evidence) });
      break;
    }
    case 'resource': {
      keys(input, ['type', 'caseId', 'target', 'provider', 'kind', 'immutableId', 'ownership', 'expected', 'before', 'evidence', 'stopAt', 'maxOccurrences']);
      need(selected && input.target === spec.contexts[selected.context].target, 'Resource must match its selected case target.');
      need([input.provider, input.kind, input.immutableId].every(isExactId), 'Resource needs exact provider, kind, and immutable ID.');
      need(['owned', 'restore', 'retain'].includes(input.ownership), 'Declare owned, restore, or retain.');
      need(input.expected && typeof input.expected === 'object', 'Record exact expected cleanup state.');
      if (input.ownership !== 'owned') need(input.before !== undefined && digest(input.before) === digest(input.expected), 'Baseline fixtures must be restored to their exact before-value.');
      need(!ownedResources(run).some((r) => r.cleanup !== 'verified' && ['target', 'provider', 'kind', 'immutableId'].every((key) => r[key] === input[key])), 'Resource already has pending cleanup.');
      if (input.kind === 'schedule') {
        need(date(input.stopAt) && Date.parse(input.stopAt) > now && Date.parse(input.stopAt) - now <= (spec.purpose === 'reliability' ? 86_400_000 : 7_200_000), 'Schedule needs a future stop within 2 hours, or 24 hours for reliability.');
        need(Number.isSafeInteger(input.maxOccurrences) && input.maxOccurrences > 0 && input.maxOccurrences <= (spec.purpose === 'reliability' ? 100 : 3), 'Schedule occurrence budget must be 1..3, or 1..100 for reliability.');
      }
      event.evidence = evidenceRefs(input.evidence);
      break;
    }
    case 'cleanup':
      keys(input, ['type', 'resourceId', 'outcome', 'observed', 'evidence']);
      need(resource, 'Cleanup must reference an exact resource registration.');
      need(['verified', 'failed'].includes(input.outcome), 'Cleanup needs verified or failed.');
      if (input.outcome === 'verified') need(input.observed !== undefined && digest(input.observed) === digest(resource.expected), 'Cleanup readback differs from the declared exact state.');
      event.evidence = evidenceRefs(input.evidence);
      break;
    case 'occurrence':
      keys(input, ['type', 'resourceId', 'occurrenceId', 'evidence']);
      need(resource?.kind === 'schedule' && isExactId(input.occurrenceId), 'Occurrence needs an exact registered schedule and occurrence ID.');
      event.evidence = evidenceRefs(input.evidence);
      break;
    default: throw new Error('Unsupported attended event.');
  }
  run.events.push(event);
  return event;
}

export function status(run, source, now = Date.now()) {
  const spec = currentSpec(run), readiness = preflight(run, now);
  const cases = spec.cases.map((selected) => {
    const history = attempts(run, selected.id), last = history.at(-1);
    const outcome = last && resultFor(run, last.id);
    const currentInputs = attendedInputs(run, spec, selected, source);
    const projection = last ? transitionInputs(run, last, outcome, currentInputs, intact) : undefined;
    const invalidation = last ? changedInputs(projection.inputs, currentInputs) : [];
    const refs = outcome ? [...outcome.evidence, ...Object.values(outcome.proof).flat()] : [];
    if (outcome && !intact(refs)) invalidation.push('evidence');
    const ready = readiness.cases.find((c) => c.id === selected.id);
    const result = last && !outcome ? now >= Date.parse(last.deadline) ? 'observe_overdue' : 'in_progress'
      : ready.suspendedBy.length ? 'blocked' : invalidation.length ? 'stale' : outcome?.result ?? (ready.ready ? 'not_run' : 'blocked');
    return { id: selected.id, title: selected.title, grade: spec.contexts[selected.context].grade,
      target: spec.contexts[selected.context].target, result, invalidation, attempts: history.length,
      attemptId: last?.id, blockers: ready.blockers, warnings: ready.warnings,
      originalServingVersion: last?.inputs.context.servingVersion,
      effectiveServingVersion: projection?.inputs.context.servingVersion,
      transitionIds: projection?.transitionIds ?? [],
      firstFailure: run.events.find((event) => event.type === 'finish' && event.result !== 'pass' && history.some((a) => a.id === event.attemptId)),
      outcome };
  });
  const resources = ownedResources(run, now);
  const coordination = repairProgress(run, spec, cases, source, now, intact);
  const openCases = cases.filter((c) => ['in_progress', 'observe_overdue'].includes(c.result)).map((c) => c.id);
  if (openCases.length) coordination.nextActions.unshift({ action: 'observe_open_attempts', caseIds: openCases });
  if (resources.some((r) => r.stopDue)) coordination.nextActions.unshift({ action: 'stop_owned_schedules', resourceIds: resources.filter((r) => r.stopDue).map((r) => r.id) });
  const offline = run.events.filter((e) => e.type === 'offline_finish');
  const { offlinePlans, offlineObligations, checkpoints } = offlineProgress(run, source, intact);
  const releasePending = spec.mode === 'release' && !checkpoints.some((e) => e.node === `v${NODE_BASELINE}`);
  const openOffline = run.events.filter((e) => e.type === 'offline_begin' && !offline.some((end) => end.attemptId === e.id));
  const cleanupPending = resources.filter((r) => r.cleanup !== 'verified');
  const totals = { automatedMs: offline.reduce((sum, e) => sum + e.durationMs, 0), browserMs: 0, modelMs: 0, humanWaitMs: 0, observationMs: 0 };
  // A resolution's measurements are cumulative for the same attempt. Count
  // the latest receipt once, while retaining its first outcome in the journal.
  const outcomes = [...new Map(run.events.filter((e) => ['finish', 'resolve'].includes(e.type))
    .map((e) => [e.attemptId, e])).values()];
  for (const e of outcomes) for (const [key, value] of Object.entries(e.timing ?? {})) totals[key] += value;
  return {
    runId: run.id, mode: spec.mode, purpose: spec.purpose, source, readiness, cases, resources, ...coordination,
    releasePending, openOffline, offline, offlinePlans, offlineObligations,
    reused: run.events.filter((e) => e.type === 'offline_reuse'),
    complete: (cases.length > 0 || offlinePlans.some((p) => p.required)) && cases.every((c) => c.result === 'pass') && cleanupPending.length === 0 && !releasePending && openOffline.length === 0 && offlinePlans.filter((p) => p.required).every((p) => p.result === 'pass') && coordination.repairs.every((r) => r.state === 'verified'),
    timing: { wallMs: now - Date.parse(run.createdAt), measured: totals,
      unmeasuredAttempts: outcomes.filter((e) => !e.timing).length,
      unknownByCategory: Object.fromEntries(Object.keys(totals).map((key) => [key,
        outcomes.filter((e) => e.timing?.[key] === undefined).length])),
      knownCostUsd: outcomes.reduce((sum, e) => sum + (e.costUsd ?? 0), 0), unknownCostAttempts: outcomes.filter((e) => e.costUsd == null).length },
  };
}

const cell = (value) => String(value ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
export function renderReport(view) {
  const lines = [`# Verification run ${view.runId}`, '',
    `${view.mode} / ${view.purpose}. ${view.complete ? 'Selected evidence complete' : 'Incomplete'}. This report records operator evidence; it does not independently certify live behavior.`, '',
    `Source ${view.source.head}; working tree ${view.source.tree}; dirty: ${view.source.dirty}.`, '',
    '| Case | Grade / target | Current result | Attempts | Invalidation / blockers |', '| --- | --- | --- | --- | --- |',
    ...view.cases.map((c) => `| ${cell(c.id)} | ${cell(c.grade)} / ${cell(c.target)} | ${c.result} | ${c.attempts} | ${cell([...c.invalidation, ...c.blockers].join('; '))} |`), '',
    '## Attempts and first failures', ''];
  for (const c of view.cases) {
    if (c.firstFailure) lines.push(`- ${cell(c.id)} first outcome: ${cell(c.firstFailure.result)} / ${cell(c.firstFailure.category)}. ${cell(c.firstFailure.summary)} Evidence: ${cell(c.firstFailure.evidence.map((e) => e.path).join(', '))}`);
    if (c.outcome) lines.push(`- ${cell(c.id)} latest: ${cell(c.outcome.summary)} Evidence: ${cell(c.outcome.evidence.map((e) => e.path).join(', '))}`);
    if (c.transitionIds.length) lines.push(`- ${cell(c.id)} evidence originally observed on ${cell(c.originalServingVersion)}; carried to ${cell(c.effectiveServingVersion)} by transitions ${cell(c.transitionIds.join(', '))}.`);
    for (const warning of c.warnings) lines.push(`- ${cell(c.id)} warning: ${cell(warning)}`);
  }
  if (view.repairs.length) {
    lines.push('', '## Repairs, batches, and next useful work', '',
      '| Repair / owner | Priority / state | Suspended cases | Cause group / overlap |', '| --- | --- | --- | --- |',
      ...view.repairs.map((r) => `| ${cell(r.repairId)} / ${cell(r.owner)} | ${r.priority} / ${r.state} | ${cell(r.batchId ? view.batches.find((b) => b.batchId === r.batchId).prerequisitesPending.join(', ') : r.blocks.join(', '))} | ${cell(r.group ?? '')} / ${cell(r.overlapWith.join(', '))} |`),
      ...view.batches.map((b) => `- Batch ${cell(b.batchId)}: ${b.complete ? 'retests verified' : b.state}; repairs ${cell(b.repairIds.join(', '))}; union areas ${cell(b.areas.join(', '))}; pending retests ${cell(b.pendingRetests.join(', '))}; review ${cell(b.reviewAt ?? 'integration recorded')}${b.reviewDue ? ' DUE' : ''}. ${cell(b.reason)}`),
      ...view.nextActions.map((a) => `- Next: ${cell(a.action)} ${cell((a.caseIds ?? a.repairIds ?? a.resourceIds ?? [a.batchId]).join(', '))}`));
  }
  lines.push('', '## Exact resource cleanup', '', '| Registration | Target / kind / immutable ID | Cleanup | Required state | Stop condition |', '| --- | --- | --- | --- | --- |',
    ...view.resources.map((r) => `| ${r.id} | ${cell(r.target)} / ${cell(r.kind)} / ${cell(r.immutableId)} | ${r.cleanup} | ${cell(JSON.stringify(r.expected))} | ${r.stopDue ? 'STOP DUE' : r.stopAt ?? ''} ${r.maxOccurrences ? `${r.occurrences}/${r.maxOccurrences} occurrences` : ''} |`), '',
    '## Offline checks and release checkpoint', '',
    ...view.offline.map((e) => `- ${cell(e.label)}: ${e.result}, ${e.durationMs} ms, ${cell(e.node)}. Log: ${cell(e.evidence[0]?.path)}`),
    ...view.reused.map((e) => `- Reused ${cell(e.label)} from receipt ${e.reusedId}; original measured duration ${e.priorDurationMs} ms. Log: ${cell(e.evidence[0]?.path)}`),
    ...view.offlinePlans.map((e) => `- ${e.required ? 'Required' : 'Historical, unsupported'} ${cell(e.node)} coverage across plans: ${e.result}`),
    ...view.offlineObligations.filter((e) => e.required && e.result !== 'pass').map((e) => `- Outstanding ${cell(e.node)} ${cell(e.id)}: ${cell(e.result)}`),
    `Open offline attempts: ${view.openOffline.length}. Final Node ${NODE_BASELINE} release checkpoint ${view.releasePending ? 'pending' : view.mode === 'release' ? 'present for current source' : 'not requested'}.`, '',
    '## Measured time and cost', '', `Wall time: ${view.timing.wallMs} ms. Categories can overlap; do not add them to infer wall time.`,
    ...Object.entries(view.timing.measured).map(([key, value]) => `- ${key}: ${value}; unmeasured attended attempts: ${view.timing.unknownByCategory[key]}`),
    `Unmeasured attended attempts: ${view.timing.unmeasuredAttempts}. Known cost: USD ${view.timing.knownCostUsd}. Unknown-cost attempts: ${view.timing.unknownCostAttempts}.`, '');
  return lines.join('\n');
}
