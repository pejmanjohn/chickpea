import { defineLiveCase, requiredSuitesForVariant, type AssertionToken } from '../schema.ts';
import type { FoundationEvaluation } from './_shared.ts';
import { integerAt, markerAt, objectAt, recordsAt, result, sha256Utf8, stringAt, upstreamRecord } from './_shared.ts';

export const AGENT_MEMORY_LIVE_BLOCKER =
  'Agent memory has durable body and revision state, but no content-safe authenticated digest projection; implicit preference capture has no separate durable proof.';

export const AGENT_MEMORY_CONTRACT = defineLiveCase({
  id: 'LC-07',
  title: 'Single-body Agent memory lifecycle',
  area: 'memory',
  feature: 'agent_memory',
  entryPoints: ['slack_dm', 'slack_root', 'slack_thread'],
  variants: [
    memoryVariant(
      'LC07-V1-explicit-memory',
      'Remember one explicit value across DM and Channel',
      'CAND-LC07-explicit-memory',
      'Remember the bounded run-marked Agent memory {{runMarker}} and read it from both Slack surfaces.',
      'Explicit memory is one Agent-owned body with the same revision on both Slack surfaces.',
    ),
    memoryVariant(
      'LC07-V2-implicit-preference',
      'Persist one implicit preference only with durable proof',
      'CAND-LC07-implicit-preference',
      'Use the concise preference implied by this run-marked request {{runMarker}} and prove a new durable memory revision.',
      'A plausible later answer cannot prove implicit memory without a durable Agent-memory revision.',
    ),
    {
      id: 'LC07-V3-conflict-replay-forget',
      title: 'Reject conflict, replay idempotently, and forget exactly',
      suites: requiredSuitesForVariant('LC07-V3-conflict-replay-forget'),
      fixtures: [
        { slot: 'member', kind: 'actor', fixtureClass: 'immutable_baseline' },
        { slot: 'agent', kind: 'agent', fixtureClass: 'resettable_fixture' },
        { slot: 'other-agent', kind: 'agent', fixtureClass: 'resettable_fixture' },
      ],
      actions: [
        {
          id: 'memory.write',
          message: 'Write and idempotently replay the bounded Agent memory for {{runMarker}}.',
          mutation: 'update',
          humanGate: 'none',
          fixtureSlots: ['member', 'agent', 'other-agent'],
          cleanup: { strategy: 'revision_restore', fixtureClass: 'resettable_fixture', reversalActionId: 'memory.write' },
        },
        {
          id: 'memory.forget',
          message: 'Forget the exact run-marked Agent memory {{runMarker}} after checking a stale revision conflict.',
          mutation: 'delete',
          humanGate: 'none',
          fixtureSlots: ['member', 'agent', 'other-agent'],
          cleanup: { strategy: 'revision_restore', fixtureClass: 'resettable_fixture', reversalActionId: 'memory.write' },
        },
      ],
      generatedEffects: [],
      observers: ['memory.read'],
      expected: [
        { token: 'memory.conflict_rejected', observerId: 'memory.read' },
        { token: 'memory.forgotten', observerId: 'memory.read' },
      ],
      forbidden: [
        { token: 'forbidden.no_unauthorized_mutation', observerId: 'memory.read' },
        { token: 'forbidden.no_raw_memory', observerId: 'memory.read' },
      ],
      regressions: [{
        candidateId: 'CAND-LC07-conflict-replay-forget',
        lesson: 'Memory retries keep one revision, stale writes fail, forget writes the empty body, and another Agent stays empty.',
      }],
      evidence: ['immutable_id', 'revision', 'observed_state', 'action_receipt', 'cleanup_receipt'],
    },
  ],
});

function memoryVariant(
  id: 'LC07-V1-explicit-memory' | 'LC07-V2-implicit-preference',
  title: string,
  candidateId: string,
  message: string,
  lesson: string,
) {
  return {
    id,
    title,
    suites: requiredSuitesForVariant(id),
    fixtures: [
      { slot: 'member', kind: 'actor' as const, fixtureClass: 'immutable_baseline' as const },
      { slot: 'agent', kind: 'agent' as const, fixtureClass: 'resettable_fixture' as const },
      { slot: 'dm', kind: 'slack_dm' as const, fixtureClass: 'immutable_baseline' as const },
      { slot: 'channel', kind: 'slack_channel' as const, fixtureClass: 'immutable_baseline' as const },
    ],
    actions: [{
      id: 'memory.write' as const,
      message,
      mutation: 'update' as const,
      humanGate: 'none' as const,
      fixtureSlots: ['member', 'agent', 'dm', 'channel'],
      cleanup: { strategy: 'revision_restore' as const, fixtureClass: 'resettable_fixture' as const, reversalActionId: 'memory.write' as const },
    }],
    generatedEffects: [],
    observers: ['memory.read' as const],
    expected: [
      { token: 'memory.digest_equal' as const, observerId: 'memory.read' as const },
      { token: 'memory.revision_advanced' as const, observerId: 'memory.read' as const },
    ],
    forbidden: [
      { token: 'forbidden.no_unauthorized_mutation' as const, observerId: 'memory.read' as const },
      { token: 'forbidden.no_raw_memory' as const, observerId: 'memory.read' as const },
    ],
    regressions: [{ candidateId, lesson }],
    evidence: ['immutable_id' as const, 'revision' as const, 'observed_state' as const, 'action_receipt' as const, 'cleanup_receipt' as const],
  };
}

export type AgentMemoryVariant = typeof AGENT_MEMORY_CONTRACT.variants[number]['id'];
export type AgentMemoryFailure =
  | 'agent_mismatch'
  | 'memory_digest_mismatch'
  | 'revision_not_advanced'
  | 'surface_read_mismatch'
  | 'conflict_not_rejected'
  | 'retry_not_idempotent'
  | 'forget_failed'
  | 'cross_agent_leak'
  | 'raw_memory_exposed';

export function evaluateAgentMemory(
  variantId: AgentMemoryVariant,
  upstream: unknown,
): FoundationEvaluation<AgentMemoryFailure> {
  const input = upstreamRecord(upstream);
  if (!AGENT_MEMORY_CONTRACT.variants.some(({ id }) => id === variantId)) throw new Error('UNKNOWN_VARIANT');
  const marker = markerAt(input);
  const request = objectAt(input, 'request');
  const admin = objectAt(input, 'admin');
  const expectedBody = variantId === 'LC07-V2-implicit-preference'
    ? `case_marker: ${marker}\nimplicit_preference: concise`
    : `case_marker: ${marker}\npreference: concise`;
  const expectedDigest = sha256Utf8(expectedBody);
  const afterWrite = objectAt(admin, 'afterWrite');
  const failures: AgentMemoryFailure[] = [];

  if (afterWrite.agentId !== request.agentId) failures.push('agent_mismatch');
  if (sha256Utf8(stringAt(afterWrite, 'body')) !== expectedDigest) failures.push('memory_digest_mismatch');
  if (integerAt(afterWrite, 'revision') !== integerAt(request, 'beforeRevision') + 1) {
    failures.push('revision_not_advanced');
  }
  const surfaceReads = recordsAt(admin, 'surfaceReads');
  if (surfaceReads.some((read) => {
    const memory = typeof read.memory === 'object' && read.memory !== null
      ? read.memory as Record<string, unknown>
      : undefined;
    return !memory || !['direct', 'channel'].includes(String(read.surface)) ||
      memory.agentId !== request.agentId ||
      typeof memory.body !== 'string' || sha256Utf8(memory.body) !== expectedDigest ||
      memory.revision !== afterWrite.revision;
  }) || surfaceReads.length !== 2
    || new Set(surfaceReads.map((read) => String(read.surface))).size !== 2
    || !surfaceReads.some((read) => read.surface === 'direct')
    || !surfaceReads.some((read) => read.surface === 'channel')) {
    failures.push('surface_read_mismatch');
  }

  if (variantId === 'LC07-V3-conflict-replay-forget') {
    const retry = objectAt(admin, 'afterRetry');
    if (retry.revision !== afterWrite.revision || sha256Utf8(stringAt(retry, 'body')) !== expectedDigest) {
      failures.push('retry_not_idempotent');
    }
    const conflict = objectAt(admin, 'conflict');
    if (conflict.code !== 'memory_version_conflict' || conflict.currentRevision !== afterWrite.revision) {
      failures.push('conflict_not_rejected');
    }
    const forgotten = objectAt(admin, 'afterForget');
    if (forgotten.agentId !== request.agentId || forgotten.body !== '' ||
        forgotten.revision !== Number(afterWrite.revision) + 1) failures.push('forget_failed');
    const other = objectAt(admin, 'otherAgent');
    if (other.body !== '' || other.revision !== 0) failures.push('cross_agent_leak');
  }
  const publicEvidence = objectAt(input, 'publicEvidence');
  if (Object.keys(publicEvidence).some((key) => /body|memory|content|text/i.test(key)) ||
      Object.values(publicEvidence).includes(expectedBody)) failures.push('raw_memory_exposed');

  const observed: AssertionToken[] = [];
  if (!failures.some((failure) => ['memory_digest_mismatch', 'surface_read_mismatch'].includes(failure))) {
    observed.push('memory.digest_equal');
  }
  if (!failures.includes('revision_not_advanced')) observed.push('memory.revision_advanced');
  if (variantId === 'LC07-V3-conflict-replay-forget') {
    if (!failures.includes('conflict_not_rejected')) observed.push('memory.conflict_rejected');
    if (!failures.includes('forget_failed')) observed.push('memory.forgotten');
  }
  if (!failures.includes('cross_agent_leak')) observed.push('forbidden.no_unauthorized_mutation');
  if (!failures.includes('raw_memory_exposed')) observed.push('forbidden.no_raw_memory');
  return result(observed, failures);
}
