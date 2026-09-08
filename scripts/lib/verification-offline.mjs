// Project the existing runner's receipts without discarding unfinished coverage
// when a subsequent invocation selects a smaller plan. No checks run here.
import { digest } from './verification-inputs.mjs';
import { isSupportedNodeVersion } from './node-version.mjs';
import { SOURCE_EXPORT_CHECKS } from './regression-plan.mjs';

export const offlineStepLabel = (step) => step.kind === 'npm' ? `npm:${step.script}`
  : step.kind === 'node' ? step.file : `tests:${digest(step.files).slice(0, 12)}`;
const coverage = (step, plan) => step.kind === 'npm' && step.script === 'verify:oss-export' && plan.sourceExportCoverage === 1
  ? [offlineStepLabel(step), ...SOURCE_EXPORT_CHECKS, ...(plan.testFiles ?? []).map((file) => `test:${file}`)]
  : step.kind === 'tests' ? step.files.map((file) => `test:${file}`)
  : step.kind === 'npm' && step.script === 'test' && Array.isArray(plan.testFiles)
    ? ['npm:test', 'npm:typecheck', ...plan.testFiles.map((file) => `test:${file}`)] : [offlineStepLabel(step)];
const configuration = (plan) => plan.executionFingerprint ?? plan.fingerprint;
const receiptsIntact = (refs, intact) => Array.isArray(refs) && refs.length > 0 && intact(refs);
const checkpointFamily = (node) => /^v24\./.test(node) ? 'v24' : node;

function planReceipts(run, plan, intact) {
  const labels = new Map(plan.steps.map((step) => [offlineStepLabel(step), coverage(step, plan)]));
  const entries = [];
  for (const event of run.events) {
    if (event.planId !== plan.id || !labels.has(event.label)) continue;
    if (event.type === 'offline_begin') {
      entries.push({ ...event, result: 'in_progress', covers: labels.get(event.label), plan });
    } else if (event.type === 'offline_finish') {
      const begin = run.events.find((e) => e.type === 'offline_begin' && e.id === event.attemptId);
      if (!begin || begin.planId !== plan.id || begin.label !== event.label || begin.sequence >= event.sequence
        || begin.fingerprint !== plan.fingerprint || event.fingerprint !== plan.fingerprint) continue;
      entries.push({ ...event, result: receiptsIntact(event.evidence, intact) ? event.result : 'stale', covers: labels.get(event.label), plan });
    } else if (event.type === 'offline_reuse') {
      const reused = run.events.find((e) => e.id === event.reusedId && e.type === 'offline_finish');
      // Reuse must still be the latest completed execution for these inputs.
      // A previous success cannot erase an intervening failure/open attempt.
      const latest = run.events.findLast((e) => e.sequence < event.sequence
        && ['offline_begin', 'offline_finish'].includes(e.type) && e.label === event.label);
      const valid = reused?.result === 'pass' && reused === latest && reused.label === event.label
        && reused.fingerprint === plan.fingerprint && event.fingerprint === plan.fingerprint
        && digest(event.evidence) === digest(reused.evidence)
        && receiptsIntact(event.evidence, intact) && receiptsIntact(reused.evidence, intact);
      entries.push({ ...event, result: valid ? 'pass' : 'stale', covers: labels.get(event.label), plan });
    }
  }
  const end = run.events.findLast((e) => e.type === 'offline_summary' && e.planId === plan.id);
  if (end?.result === 'fail' && plan.steps.every((step) => entries.findLast((e) => e.label === offlineStepLabel(step))?.result === 'pass')) {
    // The runner can detect source drift after the last successful command.
    // Its failed summary then invalidates those receipts until relevant reruns.
    for (const entry of entries) if (entry.result === 'pass') entry.result = 'stale';
  }
  return entries;
}

const aggregate = (items) => items.some((item) => item.result === 'fail') ? 'fail'
  : items.some((item) => item.result === 'in_progress') ? 'in_progress'
    : items.some((item) => item.result === 'stale') ? 'stale'
      : items.some((item) => item.result !== 'pass') ? 'not_run' : 'pass';

/** Node 24 updates replace the execution target without dropping obligations.
 * Receipts still need the exact current Node/configuration; no cross-version
 * reuse. Other majors remain visible history, never current acceptance. */
export function offlineProgress(run, source, intact) {
  const plans = run.events.filter((e) => e.type === 'offline_plan');
  const byNode = new Map();
  const allReceipts = new Map(plans.map((plan) => [plan.id, planReceipts(run, plan, intact)]));
  const latestRelease = new Map(plans.filter((plan) => plan.mode === 'release')
    .map((plan) => [checkpointFamily(plan.node), plan.id]));
  for (const plan of plans) {
    const family = checkpointFamily(plan.node);
    if (!byNode.has(family)) byNode.set(family, []);
    byNode.get(family).push(plan);
  }
  const offlinePlans = [], offlineObligations = [], checkpoints = [];
  for (const nodePlans of byNode.values()) {
    const latest = nodePlans.at(-1), required = new Map();
    const node = latest.node, supported = isSupportedNodeVersion(node);
    const requiredTarget = checkpointFamily(node) === 'v24';
    for (const plan of nodePlans) for (const step of plan.steps) {
      for (const id of coverage(step, plan)) required.set(id, { id, node, required: requiredTarget, planId: plan.id, requiredAt: plan.sequence });
    }
    const receipts = nodePlans.flatMap((plan) => allReceipts.get(plan.id));
    const obligations = [...required.values()].map((item) => {
      const receipt = receipts.findLast((e) => e.sequence > item.requiredAt && e.covers.includes(item.id));
      const current = receipt?.plan.source.tree === source.tree
        && receipt.plan.node === node
        && configuration(receipt.plan) === configuration(latest);
      return { ...item, result: receipt ? current ? receipt.result : 'stale' : 'not_run',
        receiptId: receipt?.id, label: receipt?.label, evidence: receipt?.evidence ?? [] };
    });
    offlineObligations.push(...obligations);
    const summary = run.events.findLast((e) => e.type === 'offline_summary' && e.planId === latest.id);
    const result = aggregate(obligations);
    // Empty plans still need a successful summary and matching source. A
    // failed summary (e.g. detected source drift) remains an explicit blocker.
    offlinePlans.push({ id: latest.id, node, mode: latest.mode, required: requiredTarget,
      result: result !== 'pass' ? result : requiredTarget && !supported ? 'stale' : latest.source.tree !== source.tree ? 'stale'
        : !summary ? 'in_progress' : summary.result,
      obligationIds: obligations.map((item) => item.id) });

    const release = nodePlans.findLast((plan) => plan.mode === 'release');
    if (!supported || !release || release.node !== node || source.dirty || release.source.dirty || release.source.tree !== source.tree) continue;
    if (latestRelease.get(checkpointFamily(node)) !== release.id) continue;
    const end = run.events.findLast((e) => e.type === 'offline_summary' && e.planId === release.id);
    if (end?.result !== 'pass') continue;
    const released = allReceipts.get(release.id).filter((e) => e.sequence < end.sequence);
    const complete = release.steps.length > 0 && release.steps.every((step) => {
      const receipt = released.findLast((e) => e.label === offlineStepLabel(step));
      return receipt?.result === 'pass' && receipt.type === 'offline_finish'; // release never reuses
    });
    if (!complete) continue;
    const checkpoint = run.events.findLast((e) => e.type === 'checkpoint' && e.planId === release.id
      && e.sequence > end.sequence && e.result === 'pass' && e.node === node
      && e.source.tree === source.tree && !e.source.dirty && e.fingerprint === release.fingerprint
      && receiptsIntact(e.evidence, intact));
    if (!checkpoint || configuration(release) !== configuration(latest)) continue;
    const laterFailure = [...allReceipts.values()].flat().some((e) => e.sequence > checkpoint.sequence
      && checkpointFamily(e.plan.node) === checkpointFamily(node) && e.type === 'offline_finish' && e.result !== 'pass');
    if (!laterFailure) checkpoints.push(checkpoint);
  }
  return { offlinePlans, offlineObligations, checkpoints };
}
