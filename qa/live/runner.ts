import {
  diagnoseLiveTarget,
  type DoctorSnapshot,
} from './doctor.ts';
import { LIVE_MANIFEST, LIVE_MANIFEST_DIGEST } from './manifest.ts';
import { validateTargetOverlay, type LiveTargetOverlay } from './privacy.ts';
import { aggregateRunReport } from './report.ts';
import {
  PRIMARY_RESULTS,
  TYPED_REASONS,
  type CleanupResult,
  type LiveAction,
  type LiveVariant,
  type PrimaryResult,
  type Suite,
  type TypedReason,
} from './schema.ts';
import type { PostflightProof } from './safety/cleanup.ts';
import {
  appendRunJournal,
  createRunJournal,
  JournalValidationError,
  readRunJournal,
  type RunJournalEvent,
  type RunJournalEventData,
  type ReadJournalResult,
} from './safety/journal.ts';
import {
  assertRunTransition,
  primaryForReceiptOutcome,
  RunStateError,
  type ActionReceiptOutcome,
  type ActionRequiredRecord,
  type AssertionRecord,
  type CaseOutcome,
  type PrimaryOutcome,
  type ReadbackOutcome,
  type RunPhase,
  type RunnerRecord,
  type WaitingRecord,
} from './state.ts';
import { selectSuiteVariants } from './suites.ts';

export interface RunIdentity {
  targetFingerprint: string;
  repositoryRevision: string;
  servingVersion: string;
}

export type RunnerSignal =
  | { type: 'action_receipt'; actionRef: string; outcome: ActionReceiptOutcome }
  | { type: 'readback_result'; intentId: string; outcome: ReadbackOutcome }
  | { type: 'assertion_result'; variantId: string; result: PrimaryResult; reason?: TypedReason };

export interface AdvanceLiveRunRequest {
  journalPath: string;
  runId: string;
  suite: Suite;
  variantIds?: readonly string[];
  overlay: unknown;
  doctorSnapshot: DoctorSnapshot;
  identity: RunIdentity;
  signal?: RunnerSignal;
  now?: string;
}

export interface AdvanceLiveRunDependencies {
  /** Crash-injection seam: the intent is already fsynced when this callback runs. */
  afterIntentFlushed?: (intentId: string) => void;
  /** Crash-injection seam: the action receipt is already fsynced when this callback runs. */
  afterReceiptFlushed?: (intentId: string) => void;
  /** Crash-injection seam: the cleanup result is already fsynced when this callback runs. */
  afterCleanupResultFlushed?: (variantId: string) => void;
  /** Crash-injection seam: the terminal transition is already fsynced when this callback runs. */
  afterCompleteTransitionFlushed?: () => void;
  observationNotBefore?: (variantId: string) => string | undefined;
  /**
   * Advances at most one exact-ID cleanup step. The coordinator owns U4's
   * challenge, intent, receipt, and readback calls. The runner accepts only a
   * content-free postflight proof, never a hand-authored cleanup verdict.
   */
  progressCleanup?: (input: {
    journalPath: string;
    runId: string;
    manifestDigest: string;
    variantId: string;
    identity: RunIdentity;
  }) =>
    | { status: 'waiting' }
    | { status: 'complete'; postflight: PostflightProof };
}

export class LiveRunnerError extends Error {
  readonly code:
    | 'RUN_IDENTITY_DRIFT'
    | 'RUN_SELECTION_DRIFT'
    | 'SUITE_NOT_ALLOWED'
    | 'INVALID_RUN_SIGNAL';

  constructor(code: LiveRunnerError['code'], detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'LiveRunnerError';
    this.code = code;
  }
}

export function advanceLiveRun(
  request: AdvanceLiveRunRequest,
  dependencies: AdvanceLiveRunDependencies = {},
): RunnerRecord {
  const at = request.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new LiveRunnerError('INVALID_RUN_SIGNAL', 'invalid timestamp');
  let target: LiveTargetOverlay | undefined;
  try {
    target = validateTargetOverlay(LIVE_MANIFEST, request.overlay);
  } catch {
    // Doctor owns the bounded invalid-overlay result. It will stop before the
    // runner reaches any path that requires a resolved target.
  }
  if (target !== undefined) assertTargetAllowsSuite(target, request.suite);
  const requestedVariantIds = selectSuiteVariants(request.suite, request.variantIds);
  if (target !== undefined) assertTargetAllowsVariants(target, request.suite, requestedVariantIds);
  const doctor = diagnoseLiveTarget({
    overlay: request.overlay,
    source: { read: () => request.doctorSnapshot },
    variantIds: requestedVariantIds,
  });
  let journal = readJournalIfPresent(request);

  if (journal === undefined) {
    if (request.signal !== undefined) throw new LiveRunnerError('INVALID_RUN_SIGNAL', 'new runs cannot begin with a signal');
    assertDoctorIdentity(request.identity, doctor);
    const variantIds = requestedVariantIds;
    try {
      createRunJournal(request.journalPath, {
        runId: request.runId,
        manifestDigest: LIVE_MANIFEST_DIGEST,
        ...request.identity,
        suite: request.suite,
        variantIds,
        createdAt: at,
      });
    } catch (error) {
      if (!(error instanceof JournalValidationError) || error.code !== 'JOURNAL_EXISTS') throw error;
      journal = readRunJournal(request.journalPath, {
        runId: request.runId,
        manifestDigest: LIVE_MANIFEST_DIGEST,
        incompleteFinal: 'discard',
      });
    }
    if (journal === undefined) {
      append(request, { type: 'doctor', ready: doctor.ready, diagnosticCodes: doctor.diagnostics.map(({ code }) => code) }, at);
      if (!doctor.ready) return blockNewRun(request, variantIds, doctor.diagnostics[0]?.code, at);
      if (target === undefined) throw new LiveRunnerError('RUN_SELECTION_DRIFT', 'validated target unavailable');
      return exposeNextAction(request, dependencies, target, variantIds[0] as string, 0, 'preflight', at);
    }
  }

  assertHeader(request, journal);
  if (target !== undefined) assertTargetAllowsVariants(target, request.suite, journal.header.variantIds);
  assertDoctorIdentity(request.identity, doctor);
  const phase = derivePhase(journal.events);
  if (phase === 'complete') return resumeTerminalRun(request, journal, at);
  append(request, { type: 'doctor', ready: doctor.ready, diagnosticCodes: doctor.diagnostics.map(({ code }) => code) }, at);
  if (!doctor.ready) {
    return stopForDoctorFailure(request, journal, phase, doctor.diagnostics[0]?.code, at);
  }
  if (target === undefined) throw new LiveRunnerError('RUN_SELECTION_DRIFT', 'validated target unavailable');

  const outstandingIntent = findOutstandingIntent(journal.events);
  if (outstandingIntent !== undefined && phase !== 'action_required' && phase !== 'recovery') {
    return enterReadbackRecovery(request, outstandingIntent, phase, at);
  }
  if (phase === 'recovery') {
    const recoveryIntent = findRecoveryIntent(journal.events);
    if (recoveryIntent === undefined) throw new RunStateError('INVALID_TRANSITION', 'recovery has no intent');
    return continueRecovery(request, dependencies, target, recoveryIntent, at);
  }
  if (phase === 'action_required') {
    if (outstandingIntent === undefined) {
      const durable = findDurableActionReceipt(journal.events);
      if (durable === undefined) throw new RunStateError('INVALID_TRANSITION', 'action state has neither intent nor receipt');
      return resumeDurableActionReceipt(request, dependencies, target, durable.intent, durable.receipt, at);
    }
    return continuePendingAction(request, dependencies, target, outstandingIntent, at);
  }
  if (phase === 'waiting') return continueObservationWait(request, journal, at);
  if (phase === 'assertion') return recordAssertion(request, dependencies, target, journal, at);
  if (phase === 'cleanup') return recordCleanup(request, dependencies, target, journal, at);
  if (phase === 'preflight') {
    if (request.signal !== undefined) throw new LiveRunnerError('INVALID_RUN_SIGNAL', 'preflight resume does not accept a signal');
    const variantId = activeVariantId(journal);
    if (variantId === undefined) throw new RunStateError('INVALID_TRANSITION', 'preflight has no pending variant');
    return exposeNextAction(request, dependencies, target, variantId, 0, 'preflight', at);
  }
  throw new RunStateError('INVALID_TRANSITION', `unsupported phase ${phase}`);
}

function assertTargetAllowsVariants(
  target: LiveTargetOverlay,
  suite: Suite,
  variantIds: readonly string[],
): void {
  const allowed = new Set(target.allowedVariants);
  if (variantIds.some((variantId) => !allowed.has(variantId))) {
    throw new LiveRunnerError('SUITE_NOT_ALLOWED', `${suite} inventory is not available on target ${target.targetAlias}`);
  }
}

function assertTargetAllowsSuite(target: LiveTargetOverlay, suite: Suite): void {
  const allowed = target.allowedSuites ?? ['case', 'smoke'];
  if (!allowed.includes(suite)) {
    throw new LiveRunnerError('SUITE_NOT_ALLOWED', `${suite} is not permitted for target ${target.targetAlias}`);
  }
}

function continuePendingAction(
  request: AdvanceLiveRunRequest,
  dependencies: AdvanceLiveRunDependencies,
  target: LiveTargetOverlay,
  intent: Extract<RunJournalEventData, { type: 'intent' }>,
  at: string,
): RunnerRecord {
  if (request.signal === undefined) {
    appendTransition(request, 'action_required', 'action_required', 'action_required', {
      variantId: intent.variantId,
      actionRef: intent.actionRef,
    }, at);
    return actionRecord(request, target, intent.variantId, intent.actionRef, intent.actionId);
  }
  if (request.signal.type !== 'action_receipt' || request.signal.actionRef !== intent.actionRef) {
    throw new LiveRunnerError('INVALID_RUN_SIGNAL', 'receipt must match the pending action');
  }
  append(request, {
    type: 'receipt',
    intentId: intent.intentId,
    variantId: intent.variantId,
    actionRef: intent.actionRef,
    outcome: request.signal.outcome,
  }, at);
  dependencies.afterReceiptFlushed?.(intent.intentId);
  if (request.signal.outcome === 'ambiguous') {
    return enterReadbackRecovery(request, intent, 'action_required', at);
  }
  const primary = primaryForReceiptOutcome(request.signal.outcome);
  if (primary !== undefined) {
    appendCaseResult(request, intent.variantId, primary, at);
    return enterCleanupOrContinue(request, dependencies, target, intent.variantId, primary, 'action_required', at);
  }
  return afterCompletedAction(request, dependencies, target, intent, 'action_required', at);
}

function continueRecovery(
  request: AdvanceLiveRunRequest,
  dependencies: AdvanceLiveRunDependencies,
  target: LiveTargetOverlay,
  intent: Extract<RunJournalEventData, { type: 'intent' }>,
  at: string,
): RunnerRecord {
  if (request.signal === undefined) {
    appendTransition(request, 'recovery', 'recovery', 'waiting', {
      variantId: intent.variantId,
      actionRef: intent.actionRef,
      reason: 'ambiguous_mutation',
    }, at);
    return recoveryRecord(request, intent);
  }
  if (request.signal.type !== 'readback_result' || request.signal.intentId !== intent.intentId) {
    throw new LiveRunnerError('INVALID_RUN_SIGNAL', 'readback result must match the outstanding intent');
  }
  append(request, {
    type: 'readback',
    intentId: intent.intentId,
    variantId: intent.variantId,
    actionRef: intent.actionRef,
    outcome: request.signal.outcome,
  }, at);
  if (request.signal.outcome === 'ambiguous') {
    const primary: PrimaryOutcome = {
      result: 'ambiguous', reason: 'ambiguous_mutation',
    };
    appendCaseResult(request, intent.variantId, primary, at);
    return enterCleanupOrContinue(request, dependencies, target, intent.variantId, primary, 'recovery', at);
  }
  if (request.signal.outcome === 'absent') {
    const actionIndex = actionIndexFromRef(intent.actionRef);
    return exposeNextAction(
      request,
      dependencies,
      target,
      intent.variantId,
      actionIndex,
      'recovery',
      at,
      attemptFromRef(intent.actionRef) + 1,
    );
  }
  if (request.signal.outcome === 'failed') {
    const primary: PrimaryOutcome = { result: 'fail', reason: 'assertion_failed' };
    appendCaseResult(request, intent.variantId, primary, at);
    return enterCleanupOrContinue(request, dependencies, target, intent.variantId, primary, 'recovery', at);
  }
  const primary: PrimaryOutcome = {
    result: 'ambiguous',
    reason: 'ambiguous_mutation',
  };
  appendCaseResult(request, intent.variantId, primary, at);
  return enterCleanupOrContinue(request, dependencies, target, intent.variantId, primary, 'recovery', at);
}

function resumeDurableActionReceipt(
  request: AdvanceLiveRunRequest,
  dependencies: AdvanceLiveRunDependencies,
  target: LiveTargetOverlay,
  intent: Extract<RunJournalEventData, { type: 'intent' }>,
  receipt: Extract<RunJournalEventData, { type: 'receipt' }>,
  at: string,
): RunnerRecord {
  if (request.signal !== undefined) {
    throw new RunStateError('ACTION_REPLAY', 'the durable action receipt is resumed without another signal');
  }
  if (receipt.outcome === 'ambiguous') {
    return enterReadbackRecovery(request, intent, 'action_required', at);
  }
  const primary = primaryForReceiptOutcome(receipt.outcome);
  if (primary !== undefined) {
    appendCaseResult(request, intent.variantId, primary, at);
    return enterCleanupOrContinue(request, dependencies, target, intent.variantId, primary, 'action_required', at);
  }
  return afterCompletedAction(request, dependencies, target, intent, 'action_required', at);
}

function afterCompletedAction(
  request: AdvanceLiveRunRequest,
  dependencies: AdvanceLiveRunDependencies,
  target: LiveTargetOverlay,
  intent: Extract<RunJournalEventData, { type: 'intent' }>,
  phase: 'action_required' | 'recovery',
  at: string,
): RunnerRecord {
  const variant = variantById(intent.variantId);
  const nextActionIndex = actionIndexFromRef(intent.actionRef) + 1;
  if (nextActionIndex < variant.actions.length) {
    return exposeNextAction(request, dependencies, target, intent.variantId, nextActionIndex, phase, at);
  }
  const notBefore = dependencies.observationNotBefore?.(intent.variantId);
  if (notBefore !== undefined && Date.parse(at) < Date.parse(notBefore)) {
    appendTransition(request, phase, 'waiting', 'waiting', {
      variantId: intent.variantId,
      notBefore,
    }, at);
    return observationWaitingRecord(request, intent.variantId, notBefore);
  }
  return enterAssertion(request, intent.variantId, phase, at);
}

function continueObservationWait(
  request: AdvanceLiveRunRequest,
  journal: ReadJournalResult,
  at: string,
): RunnerRecord {
  if (request.signal !== undefined) throw new LiveRunnerError('INVALID_RUN_SIGNAL', 'observation wait does not accept a signal');
  const transition = lastTransition(journal.events);
  if (transition?.notBefore === undefined || transition.variantId === undefined) {
    throw new RunStateError('INVALID_TRANSITION', 'waiting state lacks an observation deadline');
  }
  if (Date.parse(at) < Date.parse(transition.notBefore)) {
    appendTransition(request, 'waiting', 'waiting', 'waiting', {
      variantId: transition.variantId,
      notBefore: transition.notBefore,
    }, at);
    return observationWaitingRecord(request, transition.variantId, transition.notBefore);
  }
  return enterAssertion(request, transition.variantId, 'waiting', at);
}

function recordAssertion(
  request: AdvanceLiveRunRequest,
  dependencies: AdvanceLiveRunDependencies,
  target: LiveTargetOverlay,
  journal: ReadJournalResult,
  at: string,
): RunnerRecord {
  const transition = lastTransition(journal.events);
  const variantId = transition?.variantId;
  if (request.signal?.type === 'action_receipt') {
    throw new RunStateError('ACTION_REPLAY', 'the completed mutation receipt cannot be replayed');
  }
  if (variantId === undefined || request.signal?.type !== 'assertion_result' || request.signal.variantId !== variantId) {
    throw new LiveRunnerError('INVALID_RUN_SIGNAL', 'assertion result must match the pending variant');
  }
  if (!(PRIMARY_RESULTS as readonly string[]).includes(request.signal.result)
    || (request.signal.reason !== undefined && !(TYPED_REASONS as readonly string[]).includes(request.signal.reason))) {
    throw new LiveRunnerError('INVALID_RUN_SIGNAL', 'invalid assertion result');
  }
  const assertionEvent: Extract<RunJournalEventData, { type: 'assertion' }> = {
    type: 'assertion',
    variantId,
    result: request.signal.result,
  };
  if (request.signal.reason !== undefined) assertionEvent.reason = request.signal.reason;
  append(request, assertionEvent, at);
  const primary = outcome(request.signal.result, request.signal.reason);
  appendCaseResult(request, variantId, primary, at);
  return enterCleanupOrContinue(request, dependencies, target, variantId, primary, 'assertion', at);
}

function recordCleanup(
  request: AdvanceLiveRunRequest,
  dependencies: AdvanceLiveRunDependencies,
  target: LiveTargetOverlay,
  journal: ReadJournalResult,
  at: string,
): RunnerRecord {
  const variantId = variantAwaitingCleanup(journal.events);
  if (variantId === undefined) {
    const transition = lastTransition(journal.events);
    if (transition?.variantId !== undefined && completedVariantIds(journal.events).has(transition.variantId)) {
      return continueSuite(request, dependencies, target, 'cleanup', at);
    }
    throw new LiveRunnerError('INVALID_RUN_SIGNAL', 'cleanup has no pending variant');
  }
  if (request.signal !== undefined) {
    throw new LiveRunnerError('INVALID_RUN_SIGNAL', 'cleanup does not accept an asserted result');
  }
  const progress = dependencies.progressCleanup?.({
    journalPath: request.journalPath,
    runId: request.runId,
    manifestDigest: LIVE_MANIFEST_DIGEST,
    variantId,
    identity: request.identity,
  });
  if (progress === undefined || progress.status === 'waiting') {
    return {
      kind: 'waiting',
      runId: request.runId,
      suite: request.suite,
      variantId,
      waitingFor: 'cleanup',
    };
  }
  append(request, {
    type: 'cleanup_result',
    variantId,
    result: progress.postflight.status === 'pass' ? 'pass' : 'failed',
  }, at);
  dependencies.afterCleanupResultFlushed?.(variantId);
  return continueSuite(request, dependencies, target, 'cleanup', at);
}

function enterCleanupOrContinue(
  request: AdvanceLiveRunRequest,
  dependencies: AdvanceLiveRunDependencies,
  target: LiveTargetOverlay,
  variantId: string,
  caseResult: PrimaryOutcome,
  phase: 'action_required' | 'recovery' | 'assertion',
  at: string,
): RunnerRecord {
  const cleanupRequired = variantById(variantId).actions.some(({ cleanup }) => cleanup.strategy !== 'not_required');
  if (!cleanupRequired) {
    append(request, { type: 'cleanup_result', variantId, result: 'not_required' }, at);
    return continueSuite(request, dependencies, target, phase, at);
  }
  appendTransition(request, phase, 'cleanup', 'waiting', {
    variantId,
    ...(caseResult.reason === undefined ? {} : { reason: caseResult.reason }),
  }, at);
  const waiting: WaitingRecord = {
    kind: 'waiting',
    runId: request.runId,
    suite: request.suite,
    variantId,
    waitingFor: 'cleanup',
  };
  if (caseResult.reason !== undefined) waiting.reason = caseResult.reason;
  return waiting;
}

function continueSuite(
  request: AdvanceLiveRunRequest,
  dependencies: AdvanceLiveRunDependencies,
  target: LiveTargetOverlay,
  phase: 'action_required' | 'recovery' | 'assertion' | 'cleanup',
  at: string,
): RunnerRecord {
  const journal = readRunJournal(request.journalPath, {
    runId: request.runId,
    manifestDigest: LIVE_MANIFEST_DIGEST,
  });
  const completeIds = completedVariantIds(journal.events);
  const nextVariantId = journal.header.variantIds.find((variantId) => !completeIds.has(variantId));
  if (nextVariantId !== undefined) {
    return exposeNextAction(request, dependencies, target, nextVariantId, 0, phase, at);
  }
  return finishRun(request, journal, phase, at, dependencies);
}

function exposeNextAction(
  request: AdvanceLiveRunRequest,
  dependencies: AdvanceLiveRunDependencies,
  target: LiveTargetOverlay,
  variantId: string,
  actionIndex: number,
  phase: 'preflight' | 'action_required' | 'recovery' | 'assertion' | 'cleanup',
  at: string,
  attempt = 1,
): ActionRequiredRecord {
  const variant = variantById(variantId);
  const action = variant.actions[actionIndex];
  if (action === undefined) throw new LiveRunnerError('RUN_SELECTION_DRIFT', `missing action ${variantId}:${actionIndex}`);
  const actionRef = `${variantId}:${actionIndex + 1}:${attempt}`;
  const intentId = `intent:${actionRef}`;
  append(request, {
    type: 'intent',
    intentId,
    variantId,
    actionRef,
    actionId: action.id,
    mutation: action.mutation,
    direction: 'forward',
  }, at);
  dependencies.afterIntentFlushed?.(intentId);
  appendTransition(request, phase, 'action_required', 'action_required', { variantId, actionRef }, at);
  return actionRecord(request, target, variantId, actionRef, action.id);
}

function actionRecord(
  request: AdvanceLiveRunRequest,
  target: LiveTargetOverlay,
  variantId: string,
  actionRef: string,
  actionId: LiveAction['id'],
): ActionRequiredRecord {
  const variant = variantById(variantId);
  const action = variant.actions[actionIndexFromRef(actionRef)];
  if (action === undefined || action.id !== actionId) {
    throw new LiveRunnerError('RUN_SELECTION_DRIFT', `missing action ${actionId}`);
  }
  const binding = target.bindings[variantId];
  if (binding === undefined) throw new LiveRunnerError('RUN_SELECTION_DRIFT', `missing binding ${variantId}`);
  return {
    kind: 'action_required',
    runId: request.runId,
    suite: request.suite,
    variantId,
    actionRef,
    actionId: action.id,
    mutation: action.mutation,
    humanGate: action.humanGate,
    fixtureAliases: action.fixtureSlots.map((slot) => binding.fixtures[slot] as string),
    semanticAction: action.message,
  };
}

function enterAssertion(
  request: AdvanceLiveRunRequest,
  variantId: string,
  phase: 'action_required' | 'waiting' | 'recovery',
  at: string,
): AssertionRecord {
  appendTransition(request, phase, 'assertion', 'assertion', { variantId }, at);
  const variant = variantById(variantId);
  return {
    kind: 'assertion',
    runId: request.runId,
    suite: request.suite,
    variantId,
    tokens: [...variant.expected, ...variant.forbidden],
  };
}

function finishRun(
  request: AdvanceLiveRunRequest,
  journal: ReadJournalResult,
  phase: 'preflight' | 'action_required' | 'recovery' | 'assertion' | 'cleanup',
  at: string,
  dependencies: AdvanceLiveRunDependencies = {},
): RunnerRecord {
  const report = reportFromJournal(journal);
  appendTransition(request, phase, 'complete', 'terminal', {}, at);
  dependencies.afterCompleteTransitionFlushed?.();
  append(request, { type: 'run_result', aggregate: report.aggregate }, at);
  return { kind: 'terminal', runId: request.runId, report };
}

function resumeTerminalRun(
  request: AdvanceLiveRunRequest,
  journal: ReadJournalResult,
  at: string,
): RunnerRecord {
  const report = reportFromJournal(journal);
  const result = journal.events.findLast(({ event }) => event.type === 'run_result')?.event;
  if (result?.type === 'run_result') {
    if (result.aggregate !== report.aggregate) {
      throw new RunStateError('INVALID_TRANSITION', 'terminal aggregate does not match the journal');
    }
  } else {
    append(request, { type: 'run_result', aggregate: report.aggregate }, at);
  }
  return { kind: 'terminal', runId: request.runId, report };
}

function reportFromJournal(journal: ReadJournalResult) {
  return aggregateRunReport({
    suite: journal.header.suite,
    manifestDigest: journal.header.manifestDigest,
    targetFingerprint: journal.header.targetFingerprint,
    repositoryRevision: journal.header.repositoryRevision,
    servingVersion: journal.header.servingVersion,
    declaredVariantIds: journal.header.variantIds,
    cases: projectCaseOutcomes(journal.events),
  });
}

function blockNewRun(
  request: AdvanceLiveRunRequest,
  variantIds: string[],
  diagnosticCode: string | undefined,
  at: string,
): RunnerRecord {
  const primary = doctorFailureOutcome(diagnosticCode);
  for (const variantId of variantIds) {
    appendCaseResult(request, variantId, primary, at);
    append(request, { type: 'cleanup_result', variantId, result: 'not_required' }, at);
  }
  const journal = readRunJournal(request.journalPath, { runId: request.runId, manifestDigest: LIVE_MANIFEST_DIGEST });
  return finishRun(request, journal, 'preflight', at);
}

function stopForDoctorFailure(
  request: AdvanceLiveRunRequest,
  journal: ReadJournalResult,
  phase: RunPhase,
  diagnosticCode: string | undefined,
  at: string,
): RunnerRecord {
  const variantId = activeVariantId(journal);
  if (variantId === undefined) throw new LiveRunnerError('INVALID_RUN_SIGNAL', 'doctor failed without an active variant');
  if (phase === 'cleanup') {
    appendTransition(request, 'cleanup', 'cleanup', 'waiting', { variantId, reason: 'target_drift' }, at);
    return { kind: 'waiting', runId: request.runId, suite: request.suite, variantId, waitingFor: 'cleanup', reason: 'target_drift' };
  }
  appendCaseResult(request, variantId, doctorFailureOutcome(diagnosticCode), at);
  appendTransition(request, phase, 'cleanup', 'waiting', { variantId, reason: 'target_drift' }, at);
  return { kind: 'waiting', runId: request.runId, suite: request.suite, variantId, waitingFor: 'cleanup', reason: 'target_drift' };
}

function enterReadbackRecovery(
  request: AdvanceLiveRunRequest,
  intent: Extract<RunJournalEventData, { type: 'intent' }>,
  phase: RunPhase,
  at: string,
): WaitingRecord {
  appendTransition(request, phase, 'recovery', 'waiting', {
    variantId: intent.variantId,
    actionRef: intent.actionRef,
    reason: 'ambiguous_mutation',
  }, at);
  return recoveryRecord(request, intent);
}

function recoveryRecord(
  request: AdvanceLiveRunRequest,
  intent: Extract<RunJournalEventData, { type: 'intent' }>,
): WaitingRecord {
  return {
    kind: 'waiting',
    runId: request.runId,
    suite: request.suite,
    variantId: intent.variantId,
    waitingFor: 'authoritative_readback',
    actionRef: intent.actionRef,
    reason: 'ambiguous_mutation',
  };
}

function observationWaitingRecord(request: AdvanceLiveRunRequest, variantId: string, notBefore: string): WaitingRecord {
  return {
    kind: 'waiting',
    runId: request.runId,
    suite: request.suite,
    variantId,
    waitingFor: 'observation_window',
    notBefore,
  };
}

function appendTransition(
  request: AdvanceLiveRunRequest,
  from: RunPhase,
  to: RunPhase,
  output: 'action_required' | 'waiting' | 'assertion' | 'terminal',
  details: { variantId?: string; actionRef?: string; reason?: TypedReason; notBefore?: string },
  at: string,
): void {
  assertRunTransition(from, to);
  const event: Extract<RunJournalEventData, { type: 'transition' }> = { type: 'transition', from, to, output };
  if (details.variantId !== undefined) event.variantId = details.variantId;
  if (details.actionRef !== undefined) event.actionRef = details.actionRef;
  if (details.reason !== undefined) event.reason = details.reason;
  if (details.notBefore !== undefined) event.notBefore = details.notBefore;
  append(request, event, at);
}

function appendCaseResult(request: AdvanceLiveRunRequest, variantId: string, primary: PrimaryOutcome, at: string): void {
  const event: Extract<RunJournalEventData, { type: 'case_result' }> = {
    type: 'case_result',
    variantId,
    result: primary.result,
  };
  if (primary.reason !== undefined) event.reason = primary.reason;
  append(request, event, at);
}

function append(request: AdvanceLiveRunRequest, event: RunJournalEventData, at: string): void {
  appendRunJournal(request.journalPath, event, {
    runId: request.runId,
    manifestDigest: LIVE_MANIFEST_DIGEST,
    at,
  });
}

function readJournalIfPresent(request: AdvanceLiveRunRequest): ReadJournalResult | undefined {
  try {
    return readRunJournal(request.journalPath, {
      runId: request.runId,
      manifestDigest: LIVE_MANIFEST_DIGEST,
      incompleteFinal: 'discard',
    });
  } catch (error) {
    if (error instanceof JournalValidationError && error.code === 'JOURNAL_MISSING') return undefined;
    throw error;
  }
}

function derivePhase(events: readonly RunJournalEvent[]): RunPhase {
  let phase: RunPhase = 'preflight';
  for (const record of events) {
    if (record.event.type !== 'transition') continue;
    if (record.event.from !== phase) {
      throw new RunStateError('INVALID_TRANSITION', `journal expected ${phase}, found ${record.event.from}`);
    }
    assertRunTransition(record.event.from, record.event.to);
    phase = record.event.to;
  }
  return phase;
}

function lastTransition(events: readonly RunJournalEvent[]): Extract<RunJournalEventData, { type: 'transition' }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === 'transition') return event;
  }
  return undefined;
}

function findOutstandingIntent(events: readonly RunJournalEvent[]): Extract<RunJournalEventData, { type: 'intent' }> | undefined {
  const receipts = new Set(events.flatMap((record) =>
    record.event.type === 'receipt' || record.event.type === 'readback'
      ? [record.event.intentId]
      : []
  ));
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === 'intent' && !receipts.has(event.intentId)) return event;
  }
  return undefined;
}

function findRecoveryIntent(events: readonly RunJournalEvent[]): Extract<RunJournalEventData, { type: 'intent' }> | undefined {
  const transition = lastTransition(events);
  if (transition?.to !== 'recovery' || transition.actionRef === undefined) return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === 'intent' && event.actionRef === transition.actionRef) return event;
  }
  return undefined;
}

function findDurableActionReceipt(events: readonly RunJournalEvent[]): {
  intent: Extract<RunJournalEventData, { type: 'intent' }>;
  receipt: Extract<RunJournalEventData, { type: 'receipt' }>;
} | undefined {
  const transition = lastTransition(events);
  if (transition?.to !== 'action_required' || transition.actionRef === undefined) return undefined;
  const intent = events
    .map(({ event }) => event)
    .findLast((event): event is Extract<RunJournalEventData, { type: 'intent' }> =>
      event.type === 'intent' && event.actionRef === transition.actionRef
    );
  if (intent === undefined) return undefined;
  const receipt = events
    .map(({ event }) => event)
    .findLast((event): event is Extract<RunJournalEventData, { type: 'receipt' }> =>
      event.type === 'receipt' && event.intentId === intent.intentId
    );
  return receipt === undefined ? undefined : { intent, receipt };
}

function projectCaseOutcomes(events: readonly RunJournalEvent[]): CaseOutcome[] {
  const cleanup = new Map<string, CleanupResult>();
  for (const record of events) {
    if (record.event.type === 'cleanup_result') cleanup.set(record.event.variantId, record.event.result);
  }
  return events.flatMap((record): CaseOutcome[] => {
    if (record.event.type !== 'case_result') return [];
    const primary = outcome(record.event.result, record.event.reason);
    return [{
      variantId: record.event.variantId,
      primary,
      cleanup: cleanup.get(record.event.variantId) ?? 'not_required',
    }];
  });
}

function variantAwaitingCleanup(events: readonly RunJournalEvent[]): string | undefined {
  const cleaned = new Set(events
    .filter((record) => record.event.type === 'cleanup_result')
    .map((record) => (record.event as Extract<RunJournalEventData, { type: 'cleanup_result' }>).variantId));
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]?.event;
    if (event?.type === 'case_result' && !cleaned.has(event.variantId)) return event.variantId;
  }
  return undefined;
}

function completedVariantIds(events: readonly RunJournalEvent[]): Set<string> {
  return new Set(events.flatMap((record) =>
    record.event.type === 'cleanup_result' ? [record.event.variantId] : []
  ));
}

function activeVariantId(journal: ReadJournalResult): string | undefined {
  const complete = completedVariantIds(journal.events);
  return journal.header.variantIds.find((variantId) => !complete.has(variantId));
}

function variantById(variantId: string): LiveVariant {
  const variant = LIVE_MANIFEST.contracts
    .flatMap((contract) => contract.variants)
    .find(({ id }) => id === variantId);
  if (variant === undefined) throw new LiveRunnerError('RUN_SELECTION_DRIFT', `variant ${variantId} is not in LIVE_MANIFEST`);
  return variant;
}

function actionIndexFromRef(actionRef: string): number {
  const value = Number(actionRef.split(':').at(-2));
  if (!Number.isSafeInteger(value) || value < 1) throw new LiveRunnerError('INVALID_RUN_SIGNAL', 'invalid action reference');
  return value - 1;
}

function attemptFromRef(actionRef: string): number {
  const value = Number(actionRef.split(':').at(-1));
  if (!Number.isSafeInteger(value) || value < 1) throw new LiveRunnerError('INVALID_RUN_SIGNAL', 'invalid action reference');
  return value;
}

function assertHeader(request: AdvanceLiveRunRequest, journal: ReadJournalResult): void {
  if (journal.header.suite !== request.suite) throw new LiveRunnerError('RUN_SELECTION_DRIFT', 'suite changed');
  if (journal.header.targetFingerprint !== request.identity.targetFingerprint
    || journal.header.repositoryRevision !== request.identity.repositoryRevision
    || journal.header.servingVersion !== request.identity.servingVersion) {
    throw new LiveRunnerError('RUN_IDENTITY_DRIFT', 'target, source, or serving identity changed');
  }
  if (request.variantIds !== undefined) {
    const selected = selectSuiteVariants(request.suite, request.variantIds);
    if (selected.length !== journal.header.variantIds.length
      || selected.some((value, index) => value !== journal.header.variantIds[index])) {
      throw new LiveRunnerError('RUN_SELECTION_DRIFT', 'variant inventory changed');
    }
  }
}

function assertDoctorIdentity(identity: RunIdentity, doctor: ReturnType<typeof diagnoseLiveTarget>): void {
  if (doctor.targetFingerprint !== identity.targetFingerprint
    || doctor.repositoryRevision !== identity.repositoryRevision
    || doctor.servingVersion !== identity.servingVersion) {
    throw new LiveRunnerError('RUN_IDENTITY_DRIFT', 'doctor identity does not match the requested run');
  }
}

function doctorFailureOutcome(code: string | undefined): PrimaryOutcome {
  if (code === 'missing_actor' || code === 'invalid_target_overlay' || code === 'unavailable_observer') {
    return { result: 'blocked', reason: 'fixture_missing' };
  }
  if (code === 'wrong_workspace' || code === 'live_lock' || code === 'stale_lock') {
    return { result: 'blocked', reason: 'authority_denied' };
  }
  return { result: 'blocked', reason: 'target_drift' };
}

function outcome(result: PrimaryResult, reason: TypedReason | undefined): PrimaryOutcome {
  return reason === undefined ? { result } : { result, reason };
}
