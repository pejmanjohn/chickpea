// Explicit carry-forward receipts for an attended candidate upgrade. No live actions.
import { caseInputs, changedInputs, digest } from './verification-inputs.mjs';
import { repairInputs } from './verification-repairs.mjs';
import { REGRESSION_AREAS } from './regression-plan.mjs';

const need = (value, message) => { if (!value) throw new Error(message); };
const text = (value) => typeof value === 'string' && value.trim().length > 0;
const same = (left, right) => digest(left) === digest(right);
const outcomeFor = (run, id) => run.events.findLast((event) => ['finish', 'resolve'].includes(event.type) && event.attemptId === id);
const readbacks = (outcome) => [...(outcome.evidence ?? []), ...Object.values(outcome.proof ?? {}).flat()];
const withoutVersion = (context) => { const { servingVersion, ...stable } = context; return stable; };
const stableInputs = (inputs) => ({ ...inputs, context: withoutVersion(inputs.context) });
const fullSource = (source) => source && text(source.tree) && /^[a-f0-9]{40}$/.test(source.head)
  && source.dirty === false && source.areas && Object.keys(REGRESSION_AREAS).every((area) => text(source.areas[area]));
const attendedInputs = (run, spec, selected, source) => ({ ...caseInputs(spec, selected, source), ...repairInputs(run, selected.id) });

/** Project evidence across only its explicitly recorded, intact transition chain.
 * Original attempt inputs/outcomes remain untouched. Call only for status, never
 * to authorize finishing an attempt whose candidate changed mid-scenario.
 */
export function transitionInputs(run, attempt, outcome, currentInputs, intact) {
  let inputs = structuredClone(attempt.inputs), source = attempt.source;
  const transitionIds = [];
  if (outcome?.result !== 'pass' || !intact(readbacks(outcome))) return { inputs, transitionIds };
  for (const transition of run.events.filter((event) => event.type === 'candidate_transition' && event.sequence > outcome.sequence)) {
    const carry = transition.carried.find((entry) => entry.attemptId === attempt.id && entry.outcomeId === outcome.id);
    if (!carry || !same(carry.priorTransitionIds, transitionIds) || !intact(transition.evidence)) continue;
    if (!same(source, transition.beforeSource) || !same(inputs.context, transition.beforeContext)) continue;
    if (Object.keys(inputs.source).some((area) => transition.impactAreas.includes(area)
      || inputs.source[area] !== transition.afterSource.areas[area])) continue;
    if (!same(stableInputs(inputs), stableInputs(currentInputs))) continue;
    inputs = { ...inputs, context: structuredClone(transition.afterContext) };
    source = transition.afterSource;
    transitionIds.push(transition.id);
  }
  if (transitionIds.length) {
    const chain = transitionIds.map((id) => run.events.find((event) => event.id === id));
    const continuous = run.events.filter((event) => event.type === 'refresh' && event.sequence > outcome.sequence).every((event) => {
      const selected = event.spec.cases.find((candidate) => candidate.id === attempt.caseId);
      if (!selected) return false;
      const observed = attendedInputs(run, event.spec, selected, event.source);
      const next = chain.find((transition) => transition.sequence > event.sequence);
      const versions = next ? [next.beforeContext.servingVersion, next.afterContext.servingVersion]
        : [chain.at(-1).afterContext.servingVersion];
      return versions.includes(observed.context.servingVersion)
        && same(stableInputs(observed), stableInputs(currentInputs));
    });
    if (!continuous) return { inputs: structuredClone(attempt.inputs), transitionIds: [] };
  }
  return { inputs, transitionIds };
}

/** Validate a proof after a truthful refresh. Before inputs must already be in
 * this journal; the operator supplies private evidence linking both candidates
 * to those exact source snapshots and a conservative impact review.
 */
export function recordTransition(run, spec, input, source, evidenceRefs, intact) {
  need(input.type === 'candidate_transition', 'Expected a candidate transition.');
  need(Object.keys(input).every((key) => ['type', 'fromId', 'context', 'impactAreas', 'summary', 'evidence'].includes(key)), 'Unexpected candidate transition fields.');
  need(text(input.summary) && spec.contexts[input.context], 'Transition needs a known context and source/impact/readback summary.');
  const anchor = run.events.find((event) => event.id === input.fromId && ['begin', 'candidate_transition'].includes(event.type));
  need(anchor, 'Transition must reference a recorded passed attempt or prior candidate transition.');
  if (anchor.type === 'begin') {
    const outcome = outcomeFor(run, anchor.id);
    need(outcome?.result === 'pass' && intact(readbacks(outcome)), 'Transition baseline requires intact passing evidence.');
  } else need(intact(anchor.evidence), 'Transition baseline proof changed or is missing.');
  const beforeSource = anchor.type === 'begin' ? anchor.source : anchor.afterSource;
  const beforeContext = anchor.type === 'begin' ? anchor.inputs.context : anchor.afterContext;
  const afterContext = spec.contexts[input.context];
  need(fullSource(beforeSource) && fullSource(source), 'Carry-forward requires clean complete recorded source fingerprints; unknown source impact requires fresh evidence.');
  need(beforeContext.servingVersion !== afterContext.servingVersion, 'Truthfully refresh to a different serving version before recording its transition.');
  need(same(withoutVersion(beforeContext), withoutVersion(afterContext)), 'Changed runtime, target, grade, model, actor, fixtures, state or configuration requires fresh evidence.');
  const refresh = run.events.findLast((event) => event.type === 'refresh');
  need(refresh && refresh.sequence > anchor.sequence && same(refresh.source, source)
    && same(refresh.spec.contexts[input.context], afterContext), 'Transition needs a current refresh matching the candidate source and serving version.');
  const intervening = run.events.filter((event) => event.type === 'refresh' && event.sequence > anchor.sequence);
  need(intervening.every((event) => {
    const context = event.spec.contexts[input.context];
    return context && same(withoutVersion(beforeContext), withoutVersion(context))
      && [beforeContext.servingVersion, afterContext.servingVersion].includes(context.servingVersion);
  }), 'Unproven intermediate runtime or serving-version changes require fresh evidence.');
  need(!run.events.some((event) => {
    if (event.type !== 'begin' || event.inputs.context.target !== afterContext.target) return false;
    const outcome = outcomeFor(run, event.id);
    const reconciliation = run.events.findLast((end) => end.type === 'reconcile' && end.attemptId === event.id);
    return !outcome || outcome.result === 'ambiguous' && reconciliation?.outcome !== 'not_applied';
  }), 'Finish/reconcile open scenarios on this target before recording a candidate transition.');
  need(!run.events.some((event) => {
    if (event.type !== 'resource' || event.target !== afterContext.target) return false;
    const cleanup = run.events.findLast((end) => end.type === 'cleanup' && end.resourceId === event.id);
    return cleanup?.outcome !== 'verified' || !intact(cleanup.evidence);
  }), 'Record exact cleanup of this target before a candidate transition.');
  const changedAreas = Object.keys(REGRESSION_AREAS).filter((area) => beforeSource.areas[area] !== source.areas[area]);
  need(Array.isArray(input.impactAreas) && new Set(input.impactAreas).size === input.impactAreas.length
    && input.impactAreas.every((area) => Object.hasOwn(REGRESSION_AREAS, area))
    && changedAreas.every((area) => input.impactAreas.includes(area)), 'Declared impact must include every changed source area.');
  need(beforeSource.tree === source.tree || changedAreas.length > 0, 'Unmapped source change requires fresh evidence.');
  const evidence = evidenceRefs(input.evidence);
  const carried = [];
  for (const selected of spec.cases.filter((selected) => selected.context === input.context)) {
    if (selected.areas.some((area) => input.impactAreas.includes(area))) continue;
    const attempt = run.events.findLast((event) => event.type === 'begin' && event.caseId === selected.id);
    const outcome = attempt && outcomeFor(run, attempt.id);
    if (outcome?.result !== 'pass' || !intact(readbacks(outcome))) continue;
    const current = attendedInputs(run, spec, selected, source);
    const previous = { ...current, context: beforeContext };
    // The new refresh is not yet a proved transition. Project the prior
    // chain at its anchor; continuity from that anchor is checked below.
    const priorRun = { ...run, events: run.events.filter((event) => event.type !== 'refresh' || event.sequence <= anchor.sequence) };
    const projected = transitionInputs(priorRun, attempt, outcome, previous, intact);
    const priorSource = projected.transitionIds.length ? run.events.find((event) => event.id === projected.transitionIds.at(-1)).afterSource : attempt.source;
    if (!same(priorSource, beforeSource) || changedInputs(projected.inputs, previous).length) continue;
    // An actor/contract change that was later reversed is still a break in the
    // proof chain; a final matching value cannot erase that history.
    if (!intervening.every((event) => {
      const then = event.spec.cases.find((candidate) => candidate.id === selected.id);
      return then && same(stableInputs(attendedInputs(run, event.spec, then, source)), stableInputs(current));
    })) continue;
    carried.push({ caseId: selected.id, attemptId: attempt.id, outcomeId: outcome.id, priorTransitionIds: projected.transitionIds });
  }
  return { ...input, evidence, beforeSource: structuredClone(beforeSource), afterSource: structuredClone(source),
    beforeContext: structuredClone(beforeContext), afterContext: structuredClone(afterContext), changedAreas, carried };
}
