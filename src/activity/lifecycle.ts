import {
  narrateSemanticActivity,
  thinkingSemanticActivity,
  unknownSemanticDescriptor,
  type SemanticActivityDescriptor,
  type SemanticInvocationFact,
  type TypedActivityStatus,
} from './semantic.ts';

export interface ActivityLifecycleObservation {
  readonly type: string;
  readonly instanceId?: string | undefined;
  readonly submissionId?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly descriptor?: SemanticActivityDescriptor | undefined;
  readonly isError?: boolean | undefined;
  readonly attemptCount?: number | undefined;
}

interface ActiveWorkCall {
  descriptor: SemanticActivityDescriptor;
  sequence: number;
}

interface SubmissionLifecycleState {
  readonly instanceId: string;
  attemptCount?: number;
  nextSequence: number;
  activeWork: Map<string, ActiveWorkCall>;
  nonWorkCallIds: Set<string>;
  seenCallIds: Set<string>;
  invocationFacts: Map<string, SemanticActivityDescriptor>;
  completedDescriptors: SemanticActivityDescriptor[];
  batchUnsuccessful: boolean;
  suppressed: boolean;
  lastStatusText?: string;
}

const MAX_SUBMISSIONS = 256;
const MAX_CALLS_PER_SUBMISSION = 256;

/**
 * Reduce only content-free Flue lifecycle facts. The reducer deliberately has
 * no fields for prompts, deltas, arguments, results, descriptions, or errors.
 */
export class ActivityLifecycleReducer {
  private readonly submissions = new Map<string, SubmissionLifecycleState>();
  private readonly settledSubmissions = new Set<string>();

  observe(event: ActivityLifecycleObservation): TypedActivityStatus | undefined {
    const instanceId = event.instanceId;
    const submissionId = event.submissionId;
    if (!instanceId || !submissionId) return undefined;
    const key = submissionKey(instanceId, submissionId);

    if (event.type === 'submission_settled') {
      this.submissions.delete(key);
      addBounded(this.settledSubmissions, key, MAX_SUBMISSIONS);
      return undefined;
    }
    if (this.settledSubmissions.has(key)) return undefined;

    if (event.type === 'submission_queued') {
      this.state(instanceId, submissionId);
      return undefined;
    }
    if (event.type === 'submission_running') {
      return this.observeAttempt(instanceId, submissionId, event.attemptCount);
    }
    if (event.type !== 'tool_start' && event.type !== 'tool') return undefined;
    if (!event.toolCallId || !event.descriptor) return undefined;

    const state = this.state(instanceId, submissionId);
    if (state.suppressed) return undefined;
    return event.type === 'tool_start'
      ? this.observeToolStart(state, event.toolCallId, event.descriptor)
      : this.observeToolSettlement(state, event.toolCallId, event.isError);
  }

  registerInvocationFact(
    instanceId: string,
    submissionId: string,
    fact: SemanticInvocationFact,
  ): TypedActivityStatus | undefined {
    const key = submissionKey(instanceId, submissionId);
    if (this.settledSubmissions.has(key)) return undefined;
    const state = this.state(instanceId, submissionId);
    if (state.suppressed ||
        state.seenCallIds.has(fact.toolCallId) && !state.activeWork.has(fact.toolCallId)) {
      return undefined;
    }

    setBounded(
      state.invocationFacts,
      fact.toolCallId,
      fact.descriptor,
      MAX_CALLS_PER_SUBMISSION,
    );
    const active = state.activeWork.get(fact.toolCallId);
    if (!active || fact.descriptor.role !== 'work') return undefined;
    active.descriptor = fact.descriptor;
    if (latestActiveCall(state)?.[0] !== fact.toolCallId) return undefined;
    return this.emit(state, narrateSemanticActivity(fact.descriptor, { phase: 'started' }));
  }

  clearInstance(instanceId: string): void {
    for (const [key, state] of this.submissions) {
      if (state.instanceId === instanceId) this.submissions.delete(key);
    }
    for (const key of this.settledSubmissions) {
      if (key.startsWith(`${JSON.stringify(instanceId)}:`)) {
        this.settledSubmissions.delete(key);
      }
    }
  }

  private observeAttempt(
    instanceId: string,
    submissionId: string,
    attemptCount: number | undefined,
  ): TypedActivityStatus | undefined {
    const state = this.state(instanceId, submissionId);
    if (typeof attemptCount !== 'number' || !Number.isInteger(attemptCount) || attemptCount < 1) {
      return undefined;
    }
    if (state.attemptCount === undefined) {
      state.attemptCount = attemptCount;
      return undefined;
    }
    if (attemptCount <= state.attemptCount) return undefined;
    state.attemptCount = attemptCount;
    resetAttempt(state);
    return this.emit(state, thinkingSemanticActivity());
  }

  private observeToolStart(
    state: SubmissionLifecycleState,
    toolCallId: string,
    baseline: SemanticActivityDescriptor,
  ): TypedActivityStatus | undefined {
    if (state.activeWork.has(toolCallId) || state.nonWorkCallIds.has(toolCallId)) return undefined;
    if (!recordNewCall(state, toolCallId)) return undefined;
    const descriptor = state.invocationFacts.get(toolCallId) ?? baseline;
    state.invocationFacts.delete(toolCallId);

    if (descriptor.role !== 'work') {
      addBounded(state.nonWorkCallIds, toolCallId, MAX_CALLS_PER_SUBMISSION);
      if (descriptor.role !== 'answer_generation' || state.activeWork.size > 0) {
        return undefined;
      }
      return this.emit(state, narrateSemanticActivity(descriptor, { phase: 'started' }));
    }
    state.activeWork.set(toolCallId, {
      descriptor,
      sequence: state.nextSequence++,
    });
    if (latestActiveCall(state)?.[0] !== toolCallId) return undefined;
    return this.emit(state, narrateSemanticActivity(descriptor, { phase: 'started' }));
  }

  private observeToolSettlement(
    state: SubmissionLifecycleState,
    toolCallId: string,
    isError: boolean | undefined,
  ): TypedActivityStatus | undefined {
    if (state.nonWorkCallIds.has(toolCallId)) {
      state.nonWorkCallIds.delete(toolCallId);
      return undefined;
    }

    const completed = state.activeWork.get(toolCallId);
    if (!completed) {
      if (!recordNewCall(state, toolCallId)) return undefined;
      return undefined;
    }
    state.activeWork.delete(toolCallId);
    state.completedDescriptors.push(completed.descriptor);
    if (isError !== false) state.batchUnsuccessful = true;

    const remaining = latestActiveCall(state);
    if (remaining) {
      return this.emit(
        state,
        narrateSemanticActivity(remaining[1].descriptor, { phase: 'started' }),
      );
    }

    const status = state.batchUnsuccessful
      ? narrateSemanticActivity(unknownSemanticDescriptor(), {
          phase: 'settled',
          outcome: 'ambiguous',
        })
      : successfulBatchReview(state.completedDescriptors);
    state.completedDescriptors = [];
    state.batchUnsuccessful = false;
    return this.emit(state, status);
  }

  private emit(
    state: SubmissionLifecycleState,
    status: TypedActivityStatus | undefined,
  ): TypedActivityStatus | undefined {
    if (!status || status.text === state.lastStatusText) return undefined;
    state.lastStatusText = status.text;
    return status;
  }

  private state(instanceId: string, submissionId: string): SubmissionLifecycleState {
    const key = submissionKey(instanceId, submissionId);
    const existing = this.submissions.get(key);
    if (existing) {
      this.submissions.delete(key);
      this.submissions.set(key, existing);
      return existing;
    }
    const created: SubmissionLifecycleState = {
      instanceId,
      nextSequence: 0,
      activeWork: new Map(),
      nonWorkCallIds: new Set(),
      seenCallIds: new Set(),
      invocationFacts: new Map(),
      completedDescriptors: [],
      batchUnsuccessful: false,
      suppressed: false,
    };
    this.submissions.set(key, created);
    while (this.submissions.size > MAX_SUBMISSIONS) {
      const oldest = this.submissions.keys().next().value;
      if (oldest === undefined) break;
      this.submissions.delete(oldest);
      addBounded(this.settledSubmissions, oldest, MAX_SUBMISSIONS);
    }
    return created;
  }
}

function successfulBatchReview(
  descriptors: readonly SemanticActivityDescriptor[],
): TypedActivityStatus | undefined {
  const first = descriptors[0];
  if (!first) return undefined;
  const oneObject = descriptors.every((descriptor) =>
    descriptor.target === first.target &&
    descriptor.object === first.object &&
    descriptor.label?.id === first.label?.id
  );
  return narrateSemanticActivity(
    oneObject ? first : unknownSemanticDescriptor(),
    { phase: 'settled', outcome: 'succeeded' },
  );
}

function latestActiveCall(
  state: SubmissionLifecycleState,
): [string, ActiveWorkCall] | undefined {
  let latest: [string, ActiveWorkCall] | undefined;
  let latestSpecific: [string, ActiveWorkCall] | undefined;
  for (const entry of state.activeWork) {
    if (!latest || entry[1].sequence > latest[1].sequence) latest = entry;
    if (entry[1].descriptor.target !== 'unknown' &&
        (!latestSpecific || entry[1].sequence > latestSpecific[1].sequence)) {
      latestSpecific = entry;
    }
  }
  return latestSpecific ?? latest;
}

function resetAttempt(state: SubmissionLifecycleState): void {
  state.nextSequence = 0;
  state.activeWork.clear();
  state.nonWorkCallIds.clear();
  state.seenCallIds.clear();
  state.invocationFacts.clear();
  state.completedDescriptors = [];
  state.batchUnsuccessful = false;
  state.suppressed = false;
  delete state.lastStatusText;
}

function suppressSubmission(state: SubmissionLifecycleState): void {
  state.activeWork.clear();
  state.nonWorkCallIds.clear();
  state.invocationFacts.clear();
  state.completedDescriptors = [];
  state.batchUnsuccessful = true;
  state.suppressed = true;
}

function recordNewCall(state: SubmissionLifecycleState, toolCallId: string): boolean {
  if (state.seenCallIds.has(toolCallId)) return false;
  if (state.seenCallIds.size >= MAX_CALLS_PER_SUBMISSION) {
    suppressSubmission(state);
    return false;
  }
  state.seenCallIds.add(toolCallId);
  return true;
}

function submissionKey(instanceId: string, submissionId: string): string {
  return `${JSON.stringify(instanceId)}:${JSON.stringify(submissionId)}`;
}

function addBounded<T>(set: Set<T>, value: T, limit: number): void {
  set.delete(value);
  set.add(value);
  while (set.size > limit) {
    const oldest = set.values().next().value;
    if (oldest === undefined) break;
    set.delete(oldest);
  }
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}
