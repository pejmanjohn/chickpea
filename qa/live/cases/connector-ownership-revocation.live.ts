import { defineLiveCase, requiredSuitesForVariant, type AssertionToken } from '../schema.ts';
import type { FoundationEvaluation } from './_shared.ts';
import { markerAt, objectAt, recordsAt, result, stringsAt, upstreamRecord } from './_shared.ts';

export const CONNECTION_REVOCATION_LIVE_BLOCKER =
  'Provider revocation remains deterministic-only until a reviewed non-secret fault seam can revoke the exact resettable QA grant.';

export const CONNECTION_OWNERSHIP_REVOCATION_CONTRACT = defineLiveCase({
  id: 'LC-05',
  title: 'Connection isolation, revocation, and reconnect',
  area: 'connections',
  feature: 'connection_isolation',
  entryPoints: ['admin', 'oauth', 'provider'],
  variants: [
    connectionIsolationVariant(
      'LC05-V1-personal-isolation',
      'Isolate Personal accounts by Agent and member',
      'connection.owner_personal',
      'member-one',
      'CAND-LC05-personal-isolation',
      'Personal accounts for the same provider identity remain separate Agent-owned records.',
    ),
    connectionIsolationVariant(
      'LC05-V2-team-isolation',
      'Isolate Team accounts by Agent',
      'connection.owner_team',
      'admin',
      'CAND-LC05-team-isolation',
      'Team authority never creates an implicit binding on another Agent.',
    ),
    {
      id: 'LC05-V3-revoke-reconnect',
      title: 'Pause dependent work after revocation and reconnect exactly',
      suites: requiredSuitesForVariant('LC05-V3-revoke-reconnect'),
      fixtures: [
        { slot: 'admin', kind: 'actor', fixtureClass: 'immutable_baseline' },
        { slot: 'provider', kind: 'provider_account', fixtureClass: 'resettable_fixture' },
        { slot: 'agent', kind: 'agent', fixtureClass: 'resettable_fixture' },
        { slot: 'routine', kind: 'routine', fixtureClass: 'resettable_fixture' },
      ],
      actions: [
        {
          id: 'connection.revoke',
          message: 'Revoke the exact resettable connection for {{runMarker}} and observe dependent work stop.',
          mutation: 'revoke',
          humanGate: 'provider_permission',
          fixtureSlots: ['admin', 'provider', 'agent', 'routine'],
          cleanup: {
            strategy: 'revision_restore',
            fixtureClass: 'resettable_fixture',
            reversalActionId: 'connection.authorize',
          },
        },
        {
          id: 'connection.authorize',
          message: 'Reconnect the same run-marked account {{runMarker}} and resume only its dependent work.',
          mutation: 'authorize',
          humanGate: 'oauth_consent',
          fixtureSlots: ['admin', 'provider', 'agent', 'routine'],
          cleanup: {
            strategy: 'revision_restore',
            fixtureClass: 'resettable_fixture',
            reversalActionId: 'connection.authorize',
          },
        },
      ],
      generatedEffects: [],
      observers: ['connection.read', 'routine.read', 'provider.read', 'provider.revocation.read'],
      expected: [
        { token: 'connection.needs_attention', observerId: 'provider.revocation.read' },
        { token: 'routine.dependency_paused', observerId: 'routine.read' },
        { token: 'connection.reconnected', observerId: 'connection.read' },
      ],
      forbidden: [{ token: 'forbidden.no_duplicate', observerId: 'provider.read' }],
      regressions: [{
        candidateId: 'CAND-LC05-revoke-reconnect',
        lesson: 'Revocation records needs-attention state and pauses dependent work before exact reconnect resumes it.',
      }],
      evidence: ['immutable_id', 'revision', 'observed_state', 'action_receipt', 'cleanup_receipt'],
    },
  ],
});

function connectionIsolationVariant(
  id: 'LC05-V1-personal-isolation' | 'LC05-V2-team-isolation',
  title: string,
  ownerToken: 'connection.owner_personal' | 'connection.owner_team',
  actorSlot: 'member-one' | 'admin',
  candidateId: string,
  lesson: string,
) {
  return {
    id,
    title,
    suites: requiredSuitesForVariant(id),
    fixtures: [
      { slot: actorSlot, kind: 'actor' as const, fixtureClass: 'immutable_baseline' as const },
      { slot: 'member-two', kind: 'actor' as const, fixtureClass: 'immutable_baseline' as const },
      { slot: 'provider', kind: 'provider_account' as const, fixtureClass: 'resettable_fixture' as const },
      { slot: 'agent-one', kind: 'agent' as const, fixtureClass: 'resettable_fixture' as const },
      { slot: 'agent-two', kind: 'agent' as const, fixtureClass: 'resettable_fixture' as const },
    ],
    actions: [{
      id: 'connection.authorize' as const,
      message: 'Authorize separate run-marked connections {{runMarker}} for two Agents without reuse.',
      mutation: 'authorize' as const,
      humanGate: 'oauth_consent' as const,
      fixtureSlots: [actorSlot, 'member-two', 'provider', 'agent-one', 'agent-two'],
      cleanup: {
        strategy: 'exact_reversal' as const,
        fixtureClass: 'run_owned' as const,
        reversalActionId: 'connection.revoke' as const,
      },
    }],
    generatedEffects: [],
    observers: ['connection.read' as const, 'provider.read' as const],
    expected: [
      { token: ownerToken, observerId: 'connection.read' as const },
      { token: 'connection.agent_isolated' as const, observerId: 'connection.read' as const },
    ],
    forbidden: [{ token: 'forbidden.no_cross_agent_reuse' as const, observerId: 'connection.read' as const }],
    regressions: [{ candidateId, lesson }],
    evidence: ['immutable_id' as const, 'revision' as const, 'observed_state' as const, 'actor_alias' as const, 'action_receipt' as const, 'cleanup_receipt' as const],
  };
}

export type ConnectionOwnershipRevocationVariant =
  typeof CONNECTION_OWNERSHIP_REVOCATION_CONTRACT.variants[number]['id'];
export type ConnectionOwnershipRevocationFailure =
  | 'account_count_mismatch'
  | 'owner_mismatch'
  | 'binding_mismatch'
  | 'cross_agent_reuse'
  | 'provider_account_mismatch'
  | 'revocation_not_recorded'
  | 'dependent_routine_not_paused'
  | 'reconnect_not_recorded'
  | 'provider_grant_duplicate';

export function evaluateConnectionOwnershipRevocation(
  variantId: ConnectionOwnershipRevocationVariant,
  upstream: unknown,
): FoundationEvaluation<ConnectionOwnershipRevocationFailure> {
  const input = upstreamRecord(upstream);
  if (!CONNECTION_OWNERSHIP_REVOCATION_CONTRACT.variants.some(({ id }) => id === variantId)) {
    throw new Error('UNKNOWN_VARIANT');
  }
  markerAt(input);
  const request = objectAt(input, 'request');
  const admin = objectAt(input, 'admin');
  const provider = objectAt(input, 'provider');
  const accountIds = stringsAt(request, 'connectionAccountIds');
  const agentIds = stringsAt(request, 'agentIds');
  const ownerMembershipIds = stringsAt(request, 'ownerMembershipIds');
  const accounts = recordsAt(admin, 'accounts').filter((account) => accountIds.includes(String(account.id)));
  const bindings = recordsAt(admin, 'bindings').filter((binding) => accountIds.includes(String(binding.connectionAccountId)));
  const failures: ConnectionOwnershipRevocationFailure[] = [];

  if (accounts.length !== accountIds.length) failures.push('account_count_mismatch');
  const expectedOwnerKind = variantId === 'LC05-V1-personal-isolation' ? 'member' : 'team';
  if (variantId !== 'LC05-V3-revoke-reconnect' && accounts.some((account) => {
    const index = accountIds.indexOf(String(account.id));
    return account.ownerKind !== expectedOwnerKind ||
      (expectedOwnerKind === 'member' && account.ownerMembershipId !== ownerMembershipIds[index]);
  })) failures.push('owner_mismatch');
  if (bindings.length !== agentIds.length || agentIds.some((agentId, index) =>
    !bindings.some((binding) => binding.agentId === agentId && binding.connectionAccountId === accountIds[index] && binding.enabled === true)
  )) failures.push('binding_mismatch');
  if (bindings.some((binding) =>
    !agentIds.includes(String(binding.agentId)) ||
    bindings.some((other) => other !== binding && other.connectionAccountId === binding.connectionAccountId)
  )) failures.push('cross_agent_reuse');
  const managedRefs = accounts.map((account) => {
    const policy = typeof account.policy === 'object' && account.policy !== null
      ? account.policy as Record<string, unknown>
      : undefined;
    return policy?.kind === 'managed' ? policy.accountRef : undefined;
  });
  if (managedRefs.some((ref) => ref !== request.providerAccountRef)) failures.push('provider_account_mismatch');
  const grants = recordsAt(provider, 'connected_accounts').filter((grant) => grant.id === request.providerAccountRef);
  if (grants.length !== 1) failures.push('provider_grant_duplicate');

  if (variantId === 'LC05-V3-revoke-reconnect') {
    const events = recordsAt(admin, 'events');
    if (!events.some((event) => event.eventType === 'connection.needs_attention' && event.subjectId === accountIds[0])) {
      failures.push('revocation_not_recorded');
    }
    if (!events.some((event) => event.eventType === 'routine.pause' && event.subjectId === request.routineId)) {
      failures.push('dependent_routine_not_paused');
    }
    const account = accounts[0];
    const routine = recordsAt(admin, 'routines').find((candidate) => candidate.id === request.routineId);
    if (account?.lifecycle !== 'ready' || routine?.state !== 'active' ||
        !events.some((event) => event.eventType === 'connection.reconnected' && event.subjectId === accountIds[0])) {
      failures.push('reconnect_not_recorded');
    }
  }

  const observed: AssertionToken[] = [];
  if (variantId === 'LC05-V1-personal-isolation' && !failures.includes('owner_mismatch')) {
    observed.push('connection.owner_personal');
  }
  if (variantId === 'LC05-V2-team-isolation' && !failures.includes('owner_mismatch')) {
    observed.push('connection.owner_team');
  }
  if (!failures.some((failure) => ['account_count_mismatch', 'binding_mismatch', 'cross_agent_reuse'].includes(failure))) {
    observed.push('connection.agent_isolated', 'forbidden.no_cross_agent_reuse');
  }
  if (variantId === 'LC05-V3-revoke-reconnect') {
    if (!failures.includes('revocation_not_recorded')) observed.push('connection.needs_attention');
    if (!failures.includes('dependent_routine_not_paused')) observed.push('routine.dependency_paused');
    if (!failures.includes('reconnect_not_recorded')) observed.push('connection.reconnected');
  }
  if (!failures.includes('provider_grant_duplicate')) observed.push('forbidden.no_duplicate');
  return result(observed, failures);
}
