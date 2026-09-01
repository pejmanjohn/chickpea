import { defineLiveCase, requiredSuitesForVariant, type AssertionToken } from '../schema.ts';
import type { FoundationEvaluation } from './_shared.ts';
import { markerAt, objectAt, recordsAt, result, stringAt, upstreamRecord } from './_shared.ts';

export const DM_SCHEDULE_PRIVACY_LIVE_BLOCKER =
  'Admin correctly omits direct-thread routines; a separate content-free private-routine existence projection is still required for live grading.';

export const DM_SCHEDULE_PRIVACY_CONTRACT = defineLiveCase({
  id: 'LC-09',
  title: 'Private DM routine delivery and Admin omission',
  area: 'routines',
  feature: 'dm_routines',
  entryPoints: ['slack_dm', 'scheduled_delivery', 'admin'],
  variants: [
    dmRoutineVariant(
      'LC09-V1-one-shot-dm',
      'Deliver one private DM follow-up',
      'CAND-LC09-one-shot-dm',
      'A one-shot DM routine exists privately, delivers once in its source thread, and never appears in shared Admin.',
    ),
    dmRoutineVariant(
      'LC09-V2-recurring-dm',
      'Deliver recurring private DM work serially',
      'CAND-LC09-recurring-dm',
      'Recurring DM work preserves its exact private destination and never duplicates a due-window result.',
    ),
    {
      id: 'LC09-V3-admin-omission-authority-loss',
      title: 'Omit private work and disable it after authority loss',
      suites: requiredSuitesForVariant('LC09-V3-admin-omission-authority-loss'),
      fixtures: [
        { slot: 'member', kind: 'actor', fixtureClass: 'immutable_baseline' },
        { slot: 'dm', kind: 'slack_dm', fixtureClass: 'immutable_baseline' },
        { slot: 'agent', kind: 'agent', fixtureClass: 'resettable_fixture' },
        { slot: 'routine', kind: 'routine', fixtureClass: 'resettable_fixture' },
      ],
      actions: [{
        id: 'routine.update',
        message: 'Recheck authority for the private routine {{runMarker}} and disable it when the owner is no longer eligible.',
        mutation: 'update',
        humanGate: 'none',
        fixtureSlots: ['member', 'dm', 'agent', 'routine'],
        cleanup: { strategy: 'revision_restore', fixtureClass: 'resettable_fixture', reversalActionId: 'routine.update' },
      }],
      generatedEffects: [],
      observers: ['routine.read', 'private.routine.read'],
      expected: [
        { token: 'routine.private_exists', observerId: 'private.routine.read' },
        { token: 'routine.admin_omitted', observerId: 'routine.read' },
        { token: 'routine.authority_disabled', observerId: 'private.routine.read' },
      ],
      forbidden: [{ token: 'forbidden.no_duplicate', observerId: 'routine.read' }],
      regressions: [{
        candidateId: 'CAND-LC09-admin-omission-authority-loss',
        lesson: 'Private work remains absent from shared Admin and records a safe disabled state after its owner loses authority.',
      }],
      evidence: ['immutable_id', 'revision', 'observed_state', 'action_receipt', 'cleanup_receipt'],
    },
  ],
});

function dmRoutineVariant(
  id: 'LC09-V1-one-shot-dm' | 'LC09-V2-recurring-dm',
  title: string,
  candidateId: string,
  lesson: string,
) {
  return {
    id,
    title,
    suites: requiredSuitesForVariant(id),
    fixtures: [
      { slot: 'member', kind: 'actor' as const, fixtureClass: 'immutable_baseline' as const },
      { slot: 'dm', kind: 'slack_dm' as const, fixtureClass: 'immutable_baseline' as const },
      { slot: 'agent', kind: 'agent' as const, fixtureClass: 'resettable_fixture' as const },
    ],
    actions: [{
      id: 'routine.create' as const,
      message: 'Create the private run-marked DM routine {{runMarker}} for the current thread.',
      mutation: 'create' as const,
      humanGate: 'none' as const,
      fixtureSlots: ['member', 'dm', 'agent'],
      cleanup: { strategy: 'exact_reversal' as const, fixtureClass: 'run_owned' as const, reversalActionId: 'routine.delete' as const },
    }],
    generatedEffects: [{
      id: 'slack.message.generated' as const,
      message: 'Chickpea delivers the private run-marked result {{runMarker}} in the same DM thread.',
      fixtureSlots: ['dm'],
      observerId: 'slack.messages.read' as const,
      cleanup: {
        strategy: 'attributed_residue' as const,
        fixtureClass: 'attributed_residue' as const,
        residue: {
          kind: 'slack_message' as const,
          markerRequired: true as const,
          expectedState: 'The exact private run-marked delivery is attributed to this run.',
        },
      },
    }],
    observers: ['routine.read' as const, 'private.routine.read' as const, 'slack.messages.read' as const],
    expected: [
      { token: 'routine.private_exists' as const, observerId: 'private.routine.read' as const },
      { token: 'routine.admin_omitted' as const, observerId: 'routine.read' as const },
      { token: 'routine.private_delivery' as const, observerId: 'slack.messages.read' as const },
    ],
    forbidden: [{ token: 'forbidden.no_duplicate' as const, observerId: 'slack.messages.read' as const }],
    regressions: [{ candidateId, lesson }],
    evidence: ['immutable_id' as const, 'revision' as const, 'observed_state' as const, 'action_receipt' as const, 'cleanup_receipt' as const],
  };
}

export type DmSchedulePrivacyVariant = typeof DM_SCHEDULE_PRIVACY_CONTRACT.variants[number]['id'];
export type DmSchedulePrivacyFailure =
  | 'private_routine_missing'
  | 'wrong_private_destination'
  | 'admin_leak'
  | 'delivery_missing'
  | 'delivery_duplicate'
  | 'wrong_delivery_thread'
  | 'run_receipt_missing'
  | 'recurrence_missing'
  | 'authority_not_disabled';

export function evaluateDmSchedulePrivacy(
  variantId: DmSchedulePrivacyVariant,
  upstream: unknown,
): FoundationEvaluation<DmSchedulePrivacyFailure> {
  const input = upstreamRecord(upstream);
  if (!DM_SCHEDULE_PRIVACY_CONTRACT.variants.some(({ id }) => id === variantId)) throw new Error('UNKNOWN_VARIANT');
  markerAt(input);
  const request = objectAt(input, 'request');
  const privateState = objectAt(input, 'privateState');
  const adminApi = objectAt(input, 'adminApi');
  const slack = objectAt(input, 'slack');
  const routineId = stringAt(request, 'routineId');
  const routine = recordsAt(privateState, 'routines').find((candidate) => candidate.id === routineId);
  const failures: DmSchedulePrivacyFailure[] = [];

  if (!routine) failures.push('private_routine_missing');
  const destination = routine && typeof routine.destination === 'object' && routine.destination !== null
    ? routine.destination as Record<string, unknown>
    : undefined;
  if (destination?.kind !== 'direct_thread' || destination.conversationId !== request.conversationId ||
      destination.threadTs !== request.threadTs || destination.ownerMembershipId !== request.ownerMembershipId) {
    failures.push('wrong_private_destination');
  }
  for (const key of ['routines', 'runs', 'events'] as const) {
    if (recordsAt(adminApi, key).some((entry) => entry.id === routineId || entry.routineId === routineId || entry.subjectId === routineId)) {
      failures.push('admin_leak');
      break;
    }
  }

  if (variantId !== 'LC09-V3-admin-omission-authority-loss') {
    if (variantId === 'LC09-V1-one-shot-dm' &&
        (routine?.triggerKind !== 'once' || routine.state !== 'completed')) failures.push('run_receipt_missing');
    if (variantId === 'LC09-V2-recurring-dm' &&
        (routine?.triggerKind !== 'schedule' || routine.state !== 'active' ||
         typeof routine.nextRunAt !== 'number' || !Number.isSafeInteger(routine.nextRunAt))) {
      failures.push('recurrence_missing');
    }
    const messages = recordsAt(slack, 'messages').filter((message) => message.routineId === routineId);
    if (messages.length === 0) failures.push('delivery_missing');
    if (messages.length > 1) failures.push('delivery_duplicate');
    if (messages.some((message) =>
      message.channel !== request.conversationId || message.thread_ts !== request.threadTs
    )) failures.push('wrong_delivery_thread');
    const runs = recordsAt(privateState, 'runs').filter((run) =>
      run.routineId === routineId && run.status === 'succeeded' && run.deliveryStatus === 'delivered'
    );
    if (runs.length !== 1 || runs[0]?.deliveryMessageTs !== messages[0]?.ts) failures.push('run_receipt_missing');
  } else if (routine?.state !== 'disabled' || routine.disabledReason !== 'creator_ineligible') {
    failures.push('authority_not_disabled');
  }

  const observed: AssertionToken[] = [];
  if (!failures.includes('private_routine_missing')) observed.push('routine.private_exists');
  if (!failures.includes('admin_leak')) observed.push('routine.admin_omitted');
  if (variantId !== 'LC09-V3-admin-omission-authority-loss' && !failures.some((failure) => [
    'delivery_missing', 'delivery_duplicate', 'wrong_delivery_thread', 'run_receipt_missing', 'recurrence_missing',
  ].includes(failure))) observed.push('routine.private_delivery', 'forbidden.no_duplicate');
  if (variantId === 'LC09-V3-admin-omission-authority-loss' && !failures.includes('authority_not_disabled')) {
    observed.push('routine.authority_disabled', 'forbidden.no_duplicate');
  }
  return result(observed, failures);
}
