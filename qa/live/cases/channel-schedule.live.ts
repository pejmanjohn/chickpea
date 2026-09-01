import {
  defineLiveCase,
  requiredSuitesForVariant,
  type AssertionToken,
  type CleanupIntent,
} from '../schema.ts';
import type { FoundationEvaluation } from './agent-lifecycle.live.ts';

const slackResidue: CleanupIntent = {
  strategy: 'attributed_residue',
  fixtureClass: 'attributed_residue',
  residue: {
    kind: 'slack_message',
    markerRequired: true,
    expectedState: 'The exact run-marked Slack message is attributed to this run.',
  },
};

export const CHANNEL_SCHEDULE_CONTRACT = defineLiveCase({
  id: 'LC-08',
  title: 'Channel recurring work',
  area: 'routines',
  feature: 'channel_routines',
  entryPoints: ['slack_root', 'admin', 'scheduled_delivery'],
  variants: [
    {
      id: 'LC08-V1-create-due',
      title: 'Create a Channel routine and observe due delivery',
      suites: requiredSuitesForVariant('LC08-V1-create-due'),
      fixtures: [
        { slot: 'member', kind: 'actor', fixtureClass: 'immutable_baseline' },
        { slot: 'channel', kind: 'slack_channel', fixtureClass: 'immutable_baseline' },
        { slot: 'agent', kind: 'agent', fixtureClass: 'resettable_fixture' },
      ],
      actions: [{
        id: 'routine.create',
        message: 'Create the run-marked Channel routine {{runMarker}} and acknowledge its due window.',
        mutation: 'create',
        humanGate: 'none',
        fixtureSlots: ['member', 'channel', 'agent'],
        cleanup: {
          strategy: 'exact_reversal',
          fixtureClass: 'run_owned',
          reversalActionId: 'routine.delete',
        },
      }],
      generatedEffects: [{
        id: 'slack.message.generated',
        message: 'Chickpea delivers the exact run-marked due result {{runMarker}} in the configured Channel.',
        fixtureSlots: ['channel'],
        observerId: 'slack.messages.read',
        cleanup: slackResidue,
      }],
      observers: ['routine.read', 'slack.messages.read'],
      expected: [
        { token: 'routine.exists', observerId: 'routine.read' },
        { token: 'routine.due_delivery', observerId: 'slack.messages.read' },
      ],
      forbidden: [{ token: 'forbidden.no_duplicate', observerId: 'slack.messages.read' }],
      regressions: [{
        candidateId: 'CAND-LC08-create-due',
        lesson: 'Creation acknowledgement and due delivery are distinct authoritative observations.',
      }],
      evidence: ['immutable_id', 'revision', 'observed_state', 'actor_alias', 'action_receipt', 'cleanup_receipt'],
    },
    {
      id: 'LC08-V2-pause-resume',
      title: 'Pause and resume a Channel routine',
      suites: requiredSuitesForVariant('LC08-V2-pause-resume'),
      fixtures: [
        { slot: 'member', kind: 'actor', fixtureClass: 'immutable_baseline' },
        { slot: 'routine', kind: 'routine', fixtureClass: 'resettable_fixture' },
      ],
      actions: [{
        id: 'routine.update',
        message: 'Pause and then resume the run-marked routine {{runMarker}} without changing its schedule.',
        mutation: 'update',
        humanGate: 'none',
        fixtureSlots: ['member', 'routine'],
        cleanup: {
          strategy: 'revision_restore',
          fixtureClass: 'resettable_fixture',
          reversalActionId: 'routine.update',
        },
      }],
      generatedEffects: [],
      observers: ['routine.read'],
      expected: [
        { token: 'routine.paused', observerId: 'routine.read' },
        { token: 'routine.active', observerId: 'routine.read' },
      ],
      forbidden: [{ token: 'forbidden.no_duplicate', observerId: 'routine.read' }],
      regressions: [{
        candidateId: 'CAND-LC08-pause-resume',
        lesson: 'Temporal control changes status without duplicating the routine.',
      }],
      evidence: ['immutable_id', 'revision', 'observed_state', 'actor_alias', 'action_receipt', 'cleanup_receipt'],
    },
    {
      id: 'LC08-V3-run-now',
      title: 'Run a Channel routine now exactly once',
      suites: requiredSuitesForVariant('LC08-V3-run-now'),
      fixtures: [
        { slot: 'member', kind: 'actor', fixtureClass: 'immutable_baseline' },
        { slot: 'channel', kind: 'slack_channel', fixtureClass: 'immutable_baseline' },
        { slot: 'routine', kind: 'routine', fixtureClass: 'resettable_fixture' },
      ],
      actions: [{
        id: 'routine.run_now',
        message: 'Run the run-marked routine {{runMarker}} now without advancing its recurring schedule twice.',
        mutation: 'update',
        humanGate: 'none',
        fixtureSlots: ['member', 'routine'],
        cleanup: {
          strategy: 'revision_restore',
          fixtureClass: 'resettable_fixture',
          reversalActionId: 'routine.update',
        },
      }],
      generatedEffects: [{
        id: 'slack.message.generated',
        message: 'Chickpea delivers the exact run-now result for {{runMarker}} in the configured Channel.',
        fixtureSlots: ['channel'],
        observerId: 'slack.messages.read',
        cleanup: slackResidue,
      }],
      observers: ['routine.read', 'slack.messages.read'],
      expected: [{ token: 'routine.run_once', observerId: 'routine.read' }],
      forbidden: [{ token: 'forbidden.no_duplicate', observerId: 'slack.messages.read' }],
      regressions: [{
        candidateId: 'CAND-LC08-run-now',
        lesson: 'Run now produces one attributed delivery and preserves the recurring schedule.',
      }],
      evidence: ['immutable_id', 'revision', 'observed_state', 'actor_alias', 'action_receipt', 'cleanup_receipt'],
    },
  ],
});

export type ChannelScheduleVariant = typeof CHANNEL_SCHEDULE_CONTRACT.variants[number]['id'];

export const CHANNEL_SCHEDULE_FAILURES = [
  'routine_missing',
  'ack_missing',
  'ack_duplicate',
  'due_delivery_missing',
  'due_delivery_duplicate',
  'wrong_origin_thread',
  'occurrence_missing',
  'pause_not_effective',
  'resume_not_effective',
  'schedule_drift',
  'run_now_duplicate',
  'activity_lingering',
] as const;

export type ChannelScheduleFailure = typeof CHANNEL_SCHEDULE_FAILURES[number];

export function evaluateChannelSchedule(
  variantId: ChannelScheduleVariant,
  upstream: unknown,
): FoundationEvaluation<ChannelScheduleFailure> {
  const input = upstreamRecord(upstream);
  if (!CHANNEL_SCHEDULE_CONTRACT.variants.some(({ id }) => id === variantId)) throw new Error('UNKNOWN_VARIANT');
  if (variantId === 'LC08-V1-create-due') return evaluateCreateDue(input);
  if (variantId === 'LC08-V2-pause-resume') return evaluatePauseResume(input);
  return evaluateRunNow(input);
}

export function evaluateRoutineCleanup(upstream: unknown): FoundationEvaluation<'routine_not_absent' | 'cleanup_id_mismatch'> {
  const input = upstreamRecord(upstream);
  const expectedRoutineId = stringAt(input, 'expectedRoutineId');
  const deletion = objectAt(input, 'deletion');
  const readback = objectAt(input, 'readback');
  const failures: Array<'routine_not_absent' | 'cleanup_id_mismatch'> = [];
  if (stringAt(deletion, 'routine_id') !== expectedRoutineId) failures.push('cleanup_id_mismatch');
  if (readback.routine !== null || stringAt(readback, 'status') !== 'absent') failures.push('routine_not_absent');
  return { pass: failures.length === 0, observedTokens: [], failures };
}

function evaluateCreateDue(input: Record<string, unknown>): FoundationEvaluation<ChannelScheduleFailure> {
  const request = objectAt(input, 'request');
  const marker = runMarker(stringAt(request, 'runMarker'));
  const originChannelId = stringAt(request, 'originChannelId');
  const originThreadTs = stringAt(request, 'originThreadTs');
  const expectedRoutineName = stringAt(request, 'expectedRoutineName');
  const expectedAcknowledgementText = stringAt(request, 'expectedAcknowledgementText');
  const expectedResultText = stringAt(request, 'expectedResultText');
  const admin = objectAt(input, 'admin');
  const slack = objectAt(input, 'slack');
  const routines = arrayAt(admin, 'routines').filter(isRecord)
    .filter((routine) => routine.name === expectedRoutineName && expectedRoutineName.includes(marker));
  const routine = routines[0];
  const messages = arrayAt(slack, 'messages').filter(isRecord);
  const acks = messages.filter((message) => message.text === expectedAcknowledgementText);
  const due = messages.filter((message) => message.text === expectedResultText);
  const occurrences = arrayAt(admin, 'runs').filter(isRecord)
    .filter((run) => run.routineId === routine?.id
      && run.status === 'succeeded'
      && run.deliveryStatus === 'delivered');
  const failures: ChannelScheduleFailure[] = [];
  if (routines.length !== 1 || routine?.state !== 'active' || routine.destination === undefined) {
    failures.push('routine_missing');
  }
  if (acks.length === 0) failures.push('ack_missing');
  if (acks.length > 1) failures.push('ack_duplicate');
  if (due.length === 0) failures.push('due_delivery_missing');
  if (due.length > 1) failures.push('due_delivery_duplicate');
  if ([...acks, ...due].some((message) =>
    message.channel !== originChannelId || message.thread_ts !== originThreadTs
  )) failures.push('wrong_origin_thread');
  if (occurrences.length !== 1
    || occurrences[0]?.deliveryChannelId !== originChannelId
    || occurrences[0]?.deliveryMessageTs !== due[0]?.ts) failures.push('occurrence_missing');
  if (!activitySettled(admin)) failures.push('activity_lingering');
  const observedTokens: AssertionToken[] = [];
  if (!failures.includes('routine_missing')) observedTokens.push('routine.exists');
  if (!failures.some((failure) => [
    'ack_missing', 'ack_duplicate', 'due_delivery_missing', 'due_delivery_duplicate',
    'wrong_origin_thread', 'occurrence_missing', 'activity_lingering',
  ].includes(failure))) observedTokens.push('routine.due_delivery', 'forbidden.no_duplicate');
  return { pass: failures.length === 0, observedTokens, failures };
}

function evaluatePauseResume(input: Record<string, unknown>): FoundationEvaluation<ChannelScheduleFailure> {
  const request = objectAt(input, 'request');
  runMarker(stringAt(request, 'runMarker'));
  const admin = objectAt(input, 'admin');
  const events = arrayAt(admin, 'events').filter(isRecord)
    .sort((left, right) => numberAt(left, 'createdAt') - numberAt(right, 'createdAt'));
  const baselineSchedule = stringAt(admin, 'baselineScheduleJson');
  const routine = objectAt(admin, 'routine');
  const pause = events.find((event) => event.eventType === 'routine.pause');
  const resume = events.find((event) => event.eventType === 'routine.resume');
  const runs = arrayAt(admin, 'runs').filter(isRecord);
  const skipped = runs.find((run) => run.triggerSource === 'schedule'
    && (run.status === 'cancelled' || run.status === 'skipped'));
  const delivered = runs.find((run) => run.triggerSource === 'schedule'
    && run.status === 'succeeded' && run.deliveryStatus === 'delivered');
  const failures: ChannelScheduleFailure[] = [];
  if (pause === undefined || skipped === undefined
    || numberAt(skipped ?? {}, 'queuedAt') < numberAt(pause ?? {}, 'createdAt')) {
    failures.push('pause_not_effective');
  }
  if (resume === undefined || delivered === undefined
    || numberAt(delivered ?? {}, 'queuedAt') < numberAt(resume ?? {}, 'createdAt')) {
    failures.push('resume_not_effective');
  }
  if (stringAt(routine, 'scheduleJson') !== baselineSchedule) failures.push('schedule_drift');
  if (routine.state !== 'active'
    || numberAt(routine, 'version') !== numberAt(admin, 'baselineVersion') + 2) failures.push('resume_not_effective');
  if (!activitySettled(admin)) failures.push('activity_lingering');
  const observedTokens: AssertionToken[] = [];
  if (!failures.includes('pause_not_effective')) observedTokens.push('routine.paused');
  if (!failures.includes('resume_not_effective')) observedTokens.push('routine.active');
  if (!failures.some((failure) => ['schedule_drift', 'activity_lingering'].includes(failure))) {
    observedTokens.push('forbidden.no_duplicate');
  }
  return { pass: failures.length === 0, observedTokens, failures };
}

function evaluateRunNow(input: Record<string, unknown>): FoundationEvaluation<ChannelScheduleFailure> {
  const request = objectAt(input, 'request');
  runMarker(stringAt(request, 'runMarker'));
  const admin = objectAt(input, 'admin');
  const slack = objectAt(input, 'slack');
  const baselineNextDueAt = numberAt(admin, 'baselineNextRunAt');
  const routine = objectAt(admin, 'routine');
  const occurrences = arrayAt(admin, 'runs').filter(isRecord)
    .filter((run) => run.triggerSource === 'run_now'
      && run.routineId === routine.id
      && run.status === 'succeeded'
      && run.deliveryStatus === 'delivered');
  const expectedResultText = stringAt(request, 'expectedResultText');
  const messages = arrayAt(slack, 'messages').filter(isRecord)
    .filter((message) => message.text === expectedResultText);
  const failures: ChannelScheduleFailure[] = [];
  if (occurrences.length !== 1 || messages.length !== 1) failures.push('run_now_duplicate');
  if (messages.some((message) =>
    message.channel !== request.originChannelId || message.thread_ts !== request.originThreadTs
  )) failures.push('wrong_origin_thread');
  if (numberAt(routine, 'nextRunAt') !== baselineNextDueAt) failures.push('schedule_drift');
  if (occurrences[0]?.deliveryMessageTs !== messages[0]?.ts) failures.push('occurrence_missing');
  if (!activitySettled(admin)) failures.push('activity_lingering');
  const observedTokens: AssertionToken[] = [];
  if (failures.length === 0) observedTokens.push('routine.run_once', 'forbidden.no_duplicate');
  return { pass: failures.length === 0, observedTokens, failures };
}

function activitySettled(admin: Record<string, unknown>): boolean {
  const presentation = objectAt(admin, 'presentation');
  const projection = objectAt(presentation, 'activityProjection');
  return projection.state === 'cleared' || projection.state === 'not_required';
}

function upstreamRecord(input: unknown): Record<string, unknown> {
  if (!isRecord(input) || 'observedTokens' in input) throw new Error('INVALID_UPSTREAM_SHAPE');
  return input;
}

function objectAt(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = input[key];
  if (!isRecord(value)) throw new Error('INVALID_UPSTREAM_SHAPE');
  return value;
}

function arrayAt(input: Record<string, unknown>, key: string): unknown[] {
  const value = input[key];
  if (!Array.isArray(value)) throw new Error('INVALID_UPSTREAM_SHAPE');
  return value;
}

function stringAt(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error('INVALID_UPSTREAM_SHAPE');
  return value;
}

function numberAt(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isSafeInteger(value)) throw new Error('INVALID_UPSTREAM_SHAPE');
  return value as number;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function runMarker(input: string): string {
  if (!/^qa-[a-z0-9]{6,40}$/u.test(input)) throw new Error('INVALID_UPSTREAM_SHAPE');
  return input;
}
