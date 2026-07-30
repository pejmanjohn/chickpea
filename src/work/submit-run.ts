import type {
  ActorTrustTier,
  AdmitShadowRunInput,
  BindingAdapterKind,
  BindingConfigMode,
  BindingId,
  RunCoordinatorKind,
  RunExecutionAuthority,
  RunId,
  RunKind,
  SafeEffectiveConfigInput,
  ShadowRunAdmission,
  SourceVisibility,
  WorkId,
  WorkKind,
  WorkStore,
} from './types.ts';
import { WorkStateError } from './types.ts';

const SUPPORTED_ADAPTER_KINDS = new Set<BindingAdapterKind>([
  'slack',
  'routine',
  'web_admin',
  'conformance',
]);

/**
 * The target-neutral product admission contract. Client adapters retain
 * verification, normalization, rendering, and delivery; this input contains
 * only opaque correlation, source truth, safe configuration, and lifecycle
 * authority required to create canonical Work state.
 */
export interface SubmitRunInput {
  work: {
    id: WorkId | string;
    kind: WorkKind;
    createdAt: number;
  };
  binding: {
    id: BindingId | string;
    adapterKind: string;
    externalAccountId: string;
    externalConversationId: string;
    generation: number;
    sourceVisibility: SourceVisibility;
    configMode: BindingConfigMode;
    orderingKey: string;
    createdAt: number;
  };
  trigger: {
    runId: RunId | string;
    runKind: RunKind;
    kind: string;
    ref: string;
    dedupeKey: string;
    body?: string | null;
    createdAt: number;
  };
  actor: {
    ref?: string | null;
    trustTier: ActorTrustTier;
  };
  sourceContextWatermark?: string | null;
  safeConfig: SafeEffectiveConfigInput;
  execution: {
    authority: RunExecutionAuthority;
    coordinatorKind: RunCoordinatorKind;
    authorityEpoch: number;
  };
  audit: {
    eventId: string;
    idempotencyKey: string;
  };
}

/**
 * Pure preparation for submitters that must compose admission into a broader
 * transaction (Slack claims/relay and Routine occurrence creation).
 */
export function prepareSubmitRun(input: SubmitRunInput): AdmitShadowRunInput {
  const adapterKind = supportedAdapterKind(input.binding.adapterKind);
  const visibility = input.binding.sourceVisibility;
  const body = input.trigger.body;
  if (visibility === 'unknown' && body !== undefined && body !== null) {
    throw new WorkStateError(
      'work_visibility_unresolved',
      'Trigger content cannot be retained until source visibility is resolved.',
    );
  }
  const workId = input.work.id as WorkId;
  const bindingId = input.binding.id as BindingId;
  return {
    work: {
      id: workId,
      kind: input.work.kind,
      maximumSensitivity: visibility === 'public' ? 'public' : 'private',
      createdAt: input.work.createdAt,
    },
    binding: {
      id: bindingId,
      workId,
      adapterKind,
      externalAccountId: input.binding.externalAccountId,
      externalConversationId: input.binding.externalConversationId,
      generation: input.binding.generation,
      sourceVisibility: visibility,
      configMode: input.binding.configMode,
      orderingKey: input.binding.orderingKey,
      createdAt: input.binding.createdAt,
    },
    run: {
      id: input.trigger.runId as RunId,
      workId,
      bindingId,
      kind: input.trigger.runKind,
      triggerKind: input.trigger.kind,
      triggerRef: input.trigger.ref,
      dedupeKey: input.trigger.dedupeKey,
      actorRef: input.actor.ref ?? null,
      actorTrustTier: input.actor.trustTier,
      sourceContextWatermark: input.sourceContextWatermark ?? null,
      effectiveCapabilityDigest: input.safeConfig.capabilityDigest,
      executionAuthority: input.execution.authority,
      coordinatorKind: input.execution.coordinatorKind,
      authorityEpoch: input.execution.authorityEpoch,
      createdAt: input.trigger.createdAt,
    },
    safeConfig: input.safeConfig,
    triggerContent: typeof body === 'string'
      ? {
          sensitivity: visibility === 'public' ? 'public' : 'private',
          body,
        }
      : null,
    auditEventId: input.audit.eventId,
    auditIdempotencyKey: input.audit.idempotencyKey,
  };
}

/** Ordinary adapters use this entry point. Composite transactional submitters
 * call prepareSubmitRun and pass its result to their transaction owner. */
export async function submitRun(
  store: WorkStore,
  input: SubmitRunInput,
): Promise<ShadowRunAdmission> {
  return store.admitShadowRun(prepareSubmitRun(input));
}

function supportedAdapterKind(value: string): BindingAdapterKind {
  if (!SUPPORTED_ADAPTER_KINDS.has(value as BindingAdapterKind)) {
    throw new WorkStateError(
      'work_adapter_unsupported',
      'The requested client adapter is not supported by this Chickpea release.',
      { adapterKind: value },
    );
  }
  return value as BindingAdapterKind;
}
