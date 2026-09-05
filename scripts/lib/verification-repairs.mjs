// Optional repair notes in the attended record, not a scheduler or deploy driver.
import { REGRESSION_AREAS } from './regression-plan.mjs';
import { isExactId } from '../live-test-resource-ledger.mjs';

const need = (value, message) => { if (!value) throw new Error(message); };
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const list = (value) => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;
const fields = (value, allowed) => need(Object.keys(value).every((key) => allowed.includes(key)), 'Unexpected repair/batch fields.');
const latest = (events, type, key) => [...new Map(events.filter((e) => e.type === type).map((e) => [e[key], e])).values()];
const failureCase = (run, id) => {
  const failure = run.events.find((e) => ['finish', 'resolve'].includes(e.type) && e.id === id && e.result !== 'pass');
  return failure && run.events.find((e) => e.type === 'begin' && e.id === failure.attemptId)?.caseId;
};

function candidateIdle(run, spec, affected) {
  const targets = new Set(spec.cases.filter((c) => affected.includes(c.id)).map((c) => spec.contexts[c.context].target));
  return !run.events.some((e) => {
    if (e.type !== 'begin' || !targets.has(e.inputs.context.target)) return false;
    const outcome = run.events.findLast((end) => ['finish', 'resolve'].includes(end.type) && end.attemptId === e.id);
    const reconciliation = run.events.findLast((end) => end.type === 'reconcile' && end.attemptId === e.id);
    return !outcome || outcome.result === 'ambiguous' && reconciliation?.outcome !== 'not_applied';
  });
}

function prerequisitesRefreshed(run, spec, batch, caseId) {
  const refresh = run.events.findLast((e) => e.type === 'refresh' && e.sequence > batch.sequence);
  const selected = spec.cases.find((c) => c.id === caseId);
  return !!refresh && selected.requires.every((id) => Date.parse(spec.capabilities[id]?.observedAt) >= Date.parse(batch.at));
}

export function repairState(run, spec) {
  const batches = latest(run.events, 'batch', 'batchId').map((batch) => ({ ...batch }));
  const repairs = latest(run.events, 'repair', 'repairId').map((repair) => {
    const batch = batches.find((b) => b.state === 'integrated' && b.repairIds.includes(repair.repairId));
    const affected = spec.cases.filter((c) => repair.areas.some((a) => c.areas.includes(a))).map((c) => c.id);
    return { ...repair, batchId: batch?.batchId, state: batch ? 'retest' : repair.state,
      affected: [...new Set([...affected, ...repair.blocks, ...repair.failureIds.map((id) => failureCase(run, id))])].sort() };
  });
  return { repairs, batches };
}

export function repairBlocks(run, spec, caseId) {
  const { repairs, batches } = repairState(run, spec);
  return repairs.filter((r) => r.batchId
    ? r.affected.includes(caseId) && !prerequisitesRefreshed(run, spec, batches.find((b) => b.batchId === r.batchId), caseId)
    : r.blocks.includes(caseId)).map((r) => r.repairId);
}

export function repairInputs(run, caseId) {
  const integrated = run.events.filter((e) => e.type === 'batch' && e.state === 'integrated' && e.affected.includes(caseId));
  // No key for old records without batches: do not invalidate them on upgrade.
  return integrated.length ? { repairBatches: integrated.map((e) => e.id) } : {};
}

export function recordRepair(run, spec, event, source, evidenceRefs, now, intact) {
  const { repairs, batches } = repairState(run, spec);
  if (event.type === 'batch_check') {
    fields(event, ['type', 'batchId', 'reviewer', 'summary', 'evidence']);
    const batch = batches.find((b) => b.batchId === event.batchId && b.state === 'integrated');
    need(batch && text(event.summary), 'Batch check needs an integrated batch and combined-check summary.');
    need(text(event.reviewer) && batch.repairIds.every((id) => repairs.find((r) => r.repairId === id).owner !== event.reviewer), 'Batch check needs a reviewer separate from its repair owners.');
    need(candidateIdle(run, spec, batch.affected), 'Finish/reconcile open scenarios on the affected target before checking the candidate.');
    event.evidence = evidenceRefs(event.evidence);
    event.source = source;
    return event;
  }
  if (event.type === 'repair') {
    fields(event, ['type', 'repairId', 'failureIds', 'priority', 'owner', 'state', 'kind', 'group', 'paths', 'areas', 'blocks', 'summary', 'commits', 'reviewer', 'evidence']);
    need(isExactId(event.repairId) && text(event.owner) && text(event.summary), 'Repair needs an exact ID, owner and diagnosis/next step.');
    need(list(event.failureIds) && event.failureIds.length > 0 && event.failureIds.every((id) => failureCase(run, id)), 'Repair must reference preserved failed/blocked/ambiguous outcomes.');
    need(['urgent', 'isolated'].includes(event.priority) && ['queued', 'diagnosing', 'repairing', 'ready'].includes(event.state), 'Invalid repair priority or readiness.');
    event.kind ??= 'code';
    need(['code', 'recovery'].includes(event.kind), 'Repair kind must be code or recovery.');
    need(list(event.areas) && event.areas.length > 0 && event.areas.every((a) => Object.hasOwn(REGRESSION_AREAS, a)), 'Repair needs known affected areas.');
    need(list(event.blocks) && event.blocks.every((id) => spec.cases.some((c) => c.id === id)), 'Repair blocks must name selected cases.');
    need(event.group === undefined || isExactId(event.group), 'Invalid common-cause group.');
    need(event.paths === undefined || list(event.paths) && event.paths.every((p) => !p.startsWith('/') && !p.split('/').includes('..')), 'Overlap paths must be repository-relative.');
    if (event.paths) event.paths = [...new Set(event.paths.map((p) => p.replace(/\/+$/, '')))];
    const previous = repairs.find((r) => r.repairId === event.repairId);
    need(!previous?.batchId, 'An integrated repair is immutable; preserve a new failure under a new repair ID.');
    if (previous) need(['failureIds', 'areas', 'blocks'].every((key) => previous[key].every((v) => event[key].includes(v))), 'Repair updates cannot discard failures, impact, or suspended cases.');
    if (event.state === 'ready') {
      if (event.kind === 'code') need(list(event.commits) && event.commits.length > 0 && event.commits.every((c) => /^[a-f0-9]{40}$/.test(c)), 'Ready repair needs its individual commit IDs.');
      else need(event.commits === undefined || Array.isArray(event.commits) && event.commits.length === 0, 'Recovery records observed restoration, not code commits.');
      need(text(event.reviewer) && event.reviewer !== event.owner, 'Ready repair needs a separate reviewer.');
      event.evidence = evidenceRefs(event.evidence);
    } else if (event.evidence) event.evidence = evidenceRefs(event.evidence);
    return event;
  }
  fields(event, ['type', 'batchId', 'repairIds', 'state', 'reason', 'reviewAt', 'evidence']);
  need(isExactId(event.batchId) && list(event.repairIds) && event.repairIds.length > 0 && text(event.reason), 'Batch needs IDs and a useful-work/dependency/checkpoint reason.');
  need(['planned', 'integrated'].includes(event.state), 'Batch state must be planned or integrated.');
  need(!batches.some((b) => b.batchId === event.batchId && b.state === 'integrated'), 'Integrated batch is immutable.');
  const members = event.repairIds.map((id) => repairs.find((r) => r.repairId === id));
  need(members.every((r) => r && !r.batchId), 'Batch members must be known, not yet integrated repairs.');
  need(!batches.some((b) => b.state === 'planned' && b.batchId !== event.batchId && b.repairIds.some((id) => event.repairIds.includes(id))), 'Repair already belongs to another planned batch.');
  event.affected = [...new Set(members.flatMap((r) => r.affected))].sort();
  event.areas = [...new Set([...members.flatMap((r) => r.areas), ...spec.cases.filter((c) => event.affected.includes(c.id)).flatMap((c) => c.areas)])].sort();
  if (event.state === 'planned') {
    need(text(event.reviewAt) && Number.isFinite(Date.parse(event.reviewAt)) && Date.parse(event.reviewAt) > now && Date.parse(event.reviewAt) - now <= 86_400_000, 'Planned batch needs a bounded review time within 24 hours.');
  } else {
    need(members.every((r) => r.state === 'ready' && intact(r.evidence)), 'Integrate only independently reviewed, ready repairs with intact evidence; leave unfinished work queued.');
    need(candidateIdle(run, spec, event.affected), 'Finish/reconcile open scenarios on the affected target before integrating a candidate.');
    event.evidence = evidenceRefs(event.evidence);
    event.source = source;
    event.commits = [...new Set(members.flatMap((r) => r.commits ?? []))];
  }
  return event;
}

export function repairProgress(run, spec, cases, source, now, intact) {
  const { repairs, batches } = repairState(run, spec);
  for (const batch of batches) {
    const check = run.events.findLast((e) => e.type === 'batch_check' && e.batchId === batch.batchId) ?? batch;
    const pending = batch.state === 'integrated' ? batch.affected.filter((id) => {
      const c = cases.find((c) => c.id === id);
      const attempt = run.events.find((e) => e.id === c?.attemptId);
      return c?.result !== 'pass' || attempt?.sequence <= batch.sequence;
    }) : batch.affected;
    batch.pendingRetests = pending;
    batch.prerequisitesPending = batch.state === 'integrated' ? batch.affected.filter((id) => !prerequisitesRefreshed(run, spec, batch, id)) : [];
    batch.reviewDue = batch.state === 'planned' && Date.parse(batch.reviewAt) <= now;
    batch.readyRepairIds = batch.repairIds.filter((id) => { const r = repairs.find((r) => r.repairId === id); return r?.state === 'ready' && intact(r.evidence); });
    batch.checksStale = batch.state === 'integrated' && (batch.areas.some((area) => check.source.areas[area] !== source.areas[area])
      || !intact(check.evidence) || check.type !== 'batch_check' && batch.repairIds.some((id) => !intact(repairs.find((r) => r.repairId === id).evidence)));
    batch.checkId = batch.state === 'integrated' ? check.id : undefined;
    batch.complete = batch.state === 'integrated' && pending.length === 0 && !batch.checksStale;
  }
  for (const repair of repairs) {
    if (repair.batchId && batches.find((b) => b.batchId === repair.batchId)?.complete) repair.state = 'verified';
    if (repair.state === 'ready' && !intact(repair.evidence)) repair.state = 'evidence_stale';
  }
  for (const repair of repairs) {
    repair.overlapWith = repairs.filter((other) => other.repairId !== repair.repairId && other.state !== 'verified'
      && (repair.paths ?? []).some((p) => (other.paths ?? []).some((q) => p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`))))
      .map((other) => other.repairId);
  }
  const actions = [];
  const urgent = repairs.filter((r) => r.priority === 'urgent' && !['retest', 'verified'].includes(r.state));
  if (urgent.length) actions.push({ action: 'prioritize_repair', repairIds: urgent.map((r) => r.repairId) });
  for (const batch of batches.filter((b) => b.reviewDue)) actions.push({ action: 'review_batch_boundary', batchId: batch.batchId, readyRepairIds: batch.readyRepairIds });
  for (const batch of batches.filter((b) => b.checksStale)) actions.push({ action: 'refresh_batch_check_evidence', batchId: batch.batchId });
  for (const batch of batches.filter((b) => b.prerequisitesPending.length)) actions.push({ action: 'refresh_batch_prerequisites', batchId: batch.batchId, caseIds: batch.prerequisitesPending });
  const retest = [...new Set(batches.filter((b) => b.state === 'integrated').flatMap((b) => b.pendingRetests))];
  if (retest.length) actions.push({ action: 'retest_batch', caseIds: retest });
  const next = cases.filter((c) => ['not_run', 'stale'].includes(c.result) && c.blockers.length === 0 && !retest.includes(c.id)).map((c) => c.id);
  if (next.length) actions.push({ action: 'continue_independent_cases', caseIds: next });
  const ready = repairs.filter((r) => r.state === 'ready' && !batches.some((b) => b.repairIds.includes(r.repairId)));
  if (ready.length) actions.push({ action: 'choose_batch_boundary', repairIds: ready.map((r) => r.repairId) });
  return { repairs, batches, nextActions: actions };
}
