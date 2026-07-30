import type { SafeRuntimeModelRouteEvidence } from '../config/runtime-model.ts';
import { opaqueId } from './admission.ts';
import { ShadowWorkLifecycle } from './lifecycle.ts';
import type {
  RunExecutionId,
  RunId,
  WorkStore,
} from './types.ts';
import { WorkStateError } from './types.ts';

const OPAQUE_REF = /^[a-z][a-z0-9_-]{7,127}$/;

export interface WorkExecutionDescriptor {
  runId: RunId | string;
  attemptNumber: number;
  fencingToken?: number;
  executorKind: 'agent' | 'workflow';
  agentName: string;
  canonicalModel: string;
  flueInstanceRef: string;
  routeEvidence: SafeRuntimeModelRouteEvidence;
  /** Interactive Flue resolves inside its agent factory. */
  deferRoute?: boolean;
}

export interface WorkActionStartInput {
  actionAttemptId: string;
  actionClass: string;
  targetKind: string;
  flueCorrelation: string;
  createdAt?: number;
}

export interface WorkActionOutcomeInput extends WorkActionStartInput {
  status: 'succeeded' | 'failed' | 'unknown';
  reasonCode?: string | null;
}

/**
 * Body-free receipt seam shared by Agent and Workflow executors. It records
 * correlation and outcome only; it deliberately has no argument/result/body
 * fields and is not wired to enable any side-effectful capability in v1.
 */
export interface WorkActionReceiptBoundary {
  executionId: RunExecutionId;
  recordStart(input: WorkActionStartInput): Promise<void>;
  recordOutcome(input: WorkActionOutcomeInput): Promise<void>;
}

export interface WorkExecutionBoundary {
  lifecycle: ShadowWorkLifecycle;
  actions: WorkActionReceiptBoundary;
}

export interface WorkExecutionBoundaryOptions {
  now?: () => number;
  onGap?: ConstructorParameters<typeof ShadowWorkLifecycle>[0]['onGap'];
  mode?: ConstructorParameters<typeof ShadowWorkLifecycle>[0]['mode'];
}

/**
 * Construct the product execution boundary from canonical Run state and an
 * immutable, opaque Flue correlation descriptor. This module neither parses
 * client coordinates nor resolves mutable client policy.
 */
export async function createWorkExecutionBoundary(
  store: WorkStore,
  descriptor: WorkExecutionDescriptor,
  options: WorkExecutionBoundaryOptions = {},
): Promise<WorkExecutionBoundary> {
  validateDescriptor(descriptor);
  const run = await store.getRun(descriptor.runId as RunId);
  if (!run) {
    throw new WorkStateError('work_run_not_found', 'The canonical Run was not found.');
  }
  const binding = await store.getBinding(run.bindingId);
  if (!binding) {
    throw new WorkStateError('work_binding_not_found', 'The canonical Binding was not found.');
  }
  if (binding.sourceVisibility === 'unknown') {
    throw new WorkStateError(
      'work_visibility_unresolved',
      'Execution cannot begin until source visibility is resolved.',
    );
  }
  const now = options.now ?? Date.now;
  const lifecycle = new ShadowWorkLifecycle({
    store,
    runId: run.id,
    attemptNumber: descriptor.attemptNumber,
    ...(descriptor.fencingToken === undefined
      ? {}
      : { fencingToken: descriptor.fencingToken }),
    executorKind: descriptor.executorKind,
    agentName: descriptor.agentName,
    canonicalModel: descriptor.canonicalModel,
    flueInstanceRef: descriptor.flueInstanceRef,
    sensitivity: binding.sourceVisibility,
    routeEvidence: descriptor.routeEvidence,
    ...(descriptor.deferRoute ? { deferRoute: true } : {}),
    now,
    ...(options.onGap ? { onGap: options.onGap } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  });
  const receiptBase = {
    runId: run.id,
    runExecutionId: lifecycle.executionId,
    fencingToken: lifecycle.fencingToken,
  };
  const record = async (
    input: WorkActionStartInput,
    status: 'started' | 'succeeded' | 'failed' | 'unknown',
    reasonCode?: string | null,
  ): Promise<void> => {
    const createdAt = input.createdAt ?? now();
    await store.recordWorkAction({
      eventId: opaqueId('audit', `${lifecycle.executionId}:${input.actionAttemptId}:${status}`),
      idempotencyKey: opaqueId(
        'auditkey',
        `${lifecycle.executionId}:${input.actionAttemptId}:${status}`,
      ),
      ...receiptBase,
      actionAttemptId: input.actionAttemptId,
      actionClass: input.actionClass,
      targetKind: input.targetKind,
      flueCorrelation: input.flueCorrelation,
      status,
      ...(reasonCode ? { reasonCode } : {}),
      createdAt,
    });
  };
  return {
    lifecycle,
    actions: {
      executionId: lifecycle.executionId,
      recordStart: (input) => record(input, 'started'),
      recordOutcome: (input) => record(input, input.status, input.reasonCode),
    },
  };
}

export async function createWorkExecutionLifecycle(
  store: WorkStore,
  descriptor: WorkExecutionDescriptor,
  options: WorkExecutionBoundaryOptions = {},
): Promise<ShadowWorkLifecycle> {
  return (await createWorkExecutionBoundary(store, descriptor, options)).lifecycle;
}

function validateDescriptor(descriptor: WorkExecutionDescriptor): void {
  if (!Number.isSafeInteger(descriptor.attemptNumber) || descriptor.attemptNumber < 1) {
    throw new WorkStateError(
      'work_execution_descriptor_invalid',
      'The execution attempt number is invalid.',
    );
  }
  if (
    descriptor.fencingToken !== undefined &&
    (!Number.isSafeInteger(descriptor.fencingToken) || descriptor.fencingToken < 1)
  ) {
    throw new WorkStateError(
      'work_execution_descriptor_invalid',
      'The execution fencing token is invalid.',
    );
  }
  if (!OPAQUE_REF.test(descriptor.flueInstanceRef)) {
    throw new WorkStateError(
      'work_execution_descriptor_invalid',
      'The Flue execution correlation must be an opaque safe reference.',
    );
  }
}
