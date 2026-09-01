import {
  defineLiveCase,
  requiredSuitesForVariant,
  type AssertionToken,
} from '../schema.ts';
import {
  hasSettledActivity,
  integerAt,
  markerAt,
  maybeObject,
  objectAt,
  result,
  stringAt,
  upstreamRecord,
  type FoundationEvaluation,
} from './_shared.ts';

export const CONNECTOR_SETUP_CONTRACT = defineLiveCase({
  id: 'LC-04',
  title: 'Connection ownership and setup attribution',
  area: 'connections',
  feature: 'connection_ownership',
  entryPoints: ['admin', 'oauth', 'provider'],
  variants: [
    connectorVariant({
      id: 'LC04-V1-personal-read',
      title: 'Authorize a Personal read-only connection',
      actorSlot: 'member',
      ownership: 'Personal',
      expectedToken: 'connection.owner_personal',
      candidateId: 'CAND-LC04-personal-read',
      lesson: 'Personal authority stays with the owning Agent and never becomes a silent team grant.',
    }),
    connectorVariant({
      id: 'LC04-V2-team-read',
      title: 'Authorize a Team read-only connection',
      actorSlot: 'admin',
      ownership: 'Team',
      expectedToken: 'connection.owner_team',
      candidateId: 'CAND-LC04-team-read',
      lesson: 'Team ownership is explicit and does not weaken Agent-scoped binding.',
    }),
    {
      id: 'LC04-V3-editor-race',
      title: 'Attribute the first successful editor completion',
      suites: requiredSuitesForVariant('LC04-V3-editor-race'),
      fixtures: [
        { slot: 'editor-one', kind: 'actor', fixtureClass: 'immutable_baseline' },
        { slot: 'editor-two', kind: 'actor', fixtureClass: 'immutable_baseline' },
        { slot: 'provider', kind: 'provider_account', fixtureClass: 'immutable_baseline' },
        { slot: 'agent', kind: 'agent', fixtureClass: 'resettable_fixture' },
      ],
      actions: [{
        id: 'connection.authorize',
        message: 'Complete the run-marked setup {{runMarker}} from two eligible editors; accept only the first successful completion.',
        mutation: 'authorize',
        humanGate: 'oauth_consent',
        fixtureSlots: ['editor-one', 'editor-two', 'provider', 'agent'],
        cleanup: {
          strategy: 'exact_reversal',
          fixtureClass: 'run_owned',
          reversalActionId: 'connection.revoke',
        },
      }],
      generatedEffects: [],
      observers: ['connection.read', 'provider.read'],
      expected: [{ token: 'connection.editor_attributed', observerId: 'connection.read' }],
      forbidden: [{ token: 'forbidden.no_duplicate', observerId: 'provider.read' }],
      regressions: [{
        candidateId: 'CAND-LC04-editor-race',
        lesson: 'Setup is non-reserving and records exactly one first-successful editor.',
      }],
      evidence: ['immutable_id', 'revision', 'observed_state', 'actor_alias', 'action_receipt', 'cleanup_receipt'],
    },
  ],
});

function connectorVariant(input: {
  id: 'LC04-V1-personal-read' | 'LC04-V2-team-read';
  title: string;
  actorSlot: 'member' | 'admin';
  ownership: 'Personal' | 'Team';
  expectedToken: 'connection.owner_personal' | 'connection.owner_team';
  candidateId: string;
  lesson: string;
}) {
  return {
    id: input.id,
    title: input.title,
    suites: requiredSuitesForVariant(input.id),
    fixtures: [
      { slot: input.actorSlot, kind: 'actor' as const, fixtureClass: 'immutable_baseline' as const },
      { slot: 'provider', kind: 'provider_account' as const, fixtureClass: 'immutable_baseline' as const },
      { slot: 'agent', kind: 'agent' as const, fixtureClass: 'resettable_fixture' as const },
    ],
    actions: [{
      id: 'connection.authorize' as const,
      message: `Authorize the run-marked ${input.ownership} read-only connection {{runMarker}} for this Agent.`,
      mutation: 'authorize' as const,
      humanGate: 'oauth_consent' as const,
      fixtureSlots: [input.actorSlot, 'provider', 'agent'],
      cleanup: {
        strategy: 'exact_reversal' as const,
        fixtureClass: 'run_owned' as const,
        reversalActionId: 'connection.revoke' as const,
      },
    }],
    generatedEffects: [],
    observers: ['connection.read' as const, 'provider.read' as const],
    expected: [{ token: input.expectedToken, observerId: 'connection.read' as const }],
    forbidden: [{ token: 'forbidden.no_cross_agent_reuse' as const, observerId: 'connection.read' as const }],
    regressions: [{ candidateId: input.candidateId, lesson: input.lesson }],
    evidence: ['immutable_id' as const, 'revision' as const, 'observed_state' as const, 'actor_alias' as const, 'action_receipt' as const, 'cleanup_receipt' as const],
  };
}

export type ConnectorSetupVariant = typeof CONNECTOR_SETUP_CONTRACT.variants[number]['id'];

export const CONNECTOR_SETUP_FAILURES = [
  'ownership_not_selected',
  'ownership_mismatch',
  'editor_not_authorized',
  'completion_attribution_mismatch',
  'agent_binding_missing',
  'provider_account_mismatch',
  'provider_grant_missing',
  'connection_missing',
  'tool_read_failed',
  'worksheet_shape_mismatch',
  'marker_row_missing',
  'setup_replayed',
  'duplicate_completion',
  'stale_callback_won',
  'activity_lingering',
] as const;

export type ConnectorSetupFailure = typeof CONNECTOR_SETUP_FAILURES[number];

export function evaluateConnectorSetup(
  variantId: ConnectorSetupVariant,
  upstream: unknown,
): FoundationEvaluation<ConnectorSetupFailure> {
  const input = upstreamRecord(upstream);
  if (!CONNECTOR_SETUP_CONTRACT.variants.some(({ id }) => id === variantId)) throw new Error('UNKNOWN_VARIANT');
  const request = objectAt(input, 'request');
  const admin = objectAt(input, 'admin');
  const provider = objectAt(input, 'provider');
  const marker = markerAt(input);
  const agentId = stringAt(request, 'agentId');
  const providerAccountId = stringAt(request, 'providerAccountId');
  const authorizedEditorIds = stringArrayAt(request, 'authorizedEditorIds');
  const authorizedMembershipIds = stringArrayAt(request, 'authorizedMembershipIds');
  const expectedOwnerKind = variantId === 'LC04-V2-team-read' ? 'team' : 'member';
  const expectedToken: AssertionToken = variantId === 'LC04-V2-team-read'
    ? 'connection.owner_team'
    : variantId === 'LC04-V3-editor-race'
      ? 'connection.editor_attributed'
      : 'connection.owner_personal';
  const failures: ConnectorSetupFailure[] = [];

  const setupOperationId = stringAt(request, 'setupOperationId');
  const setupForm = objectAt(input, 'setupForm');
  const setups = arrayAt(admin, 'setups').filter(isRecord)
    .filter((setup) => setup.setupOperationId === setupOperationId);
  const completed = setups.filter((setup) => setup.status === 'completed');
  const completion = completed[0];
  const target = maybeObject(completion?.target);
  if (setupForm.ownerKind !== expectedOwnerKind || setupForm.access !== 'read') {
    failures.push('ownership_not_selected');
  }
  if (target?.ownerKind !== expectedOwnerKind || target.accessLane !== 'read') failures.push('ownership_mismatch');
  const completedBy = completion?.completedByUserId;
  const completedByMembershipId = completion?.completedByMembershipId;
  if (typeof completedBy !== 'string' || !authorizedEditorIds.includes(completedBy)) failures.push('editor_not_authorized');
  if (typeof completedByMembershipId !== 'string' || !authorizedMembershipIds.includes(completedByMembershipId)) {
    failures.push('editor_not_authorized');
  }
  const accountId = completion?.connectionAccountId;
  const account = arrayAt(admin, 'accounts').filter(isRecord)
    .find((candidate) => candidate.id === accountId);
  const binding = arrayAt(admin, 'bindings').filter(isRecord)
    .find((candidate) => candidate.connectionAccountId === accountId && candidate.agentId === agentId);
  if (account === undefined) {
    failures.push('connection_missing');
  } else {
    if (account.createdByMembershipId !== completedByMembershipId
      || (expectedOwnerKind === 'member' && account.ownerMembershipId !== completedByMembershipId)) {
      failures.push('completion_attribution_mismatch');
    }
    if (account.ownerKind !== expectedOwnerKind) failures.push('ownership_mismatch');
    if (account.lifecycle !== 'active') failures.push('connection_missing');
  }
  if (binding === undefined || binding.enabled !== true) failures.push('agent_binding_missing');

  const grants = arrayAt(provider, 'connected_accounts').filter(isRecord)
    .filter((grant) => grant.id === providerAccountId && grant.status === 'ACTIVE');
  if (grants.length !== 1) failures.push('provider_grant_missing');
  if (account?.policy !== undefined) {
    const policy = maybeObject(account.policy);
    if (policy?.kind !== 'managed' || policy.accountRef !== providerAccountId) {
      failures.push('provider_account_mismatch');
    }
  }

  const toolResult = objectAt(provider, 'tool_result');
  if (toolResult.successful !== true || toolResult.error !== null) failures.push('tool_read_failed');
  const sheet = maybeObject(toolResult.data);
  if (sheet === undefined || !Array.isArray(sheet.values)
    || !Array.isArray(sheet.values[0])
    || !sameStrings(sheet.values[0], ['case_marker', 'status'])) {
    failures.push('worksheet_shape_mismatch');
  } else if (!sheet.values.slice(1).some((row) => Array.isArray(row) && row[0] === marker && row[1] === 'ready')) {
    failures.push('marker_row_missing');
  }

  if (variantId === 'LC04-V3-editor-race') {
    if (completed.length !== 1 || grants.length > 1) failures.push('duplicate_completion');
    const callbacks = arrayAt(provider, 'callbacks').filter(isRecord);
    const successful = callbacks.filter((callback) => callback.result === 'completed')
      .sort((left, right) => integerAt(left, 'sequence') - integerAt(right, 'sequence'));
    if (successful[0]?.completedByUserId !== completedBy) failures.push('stale_callback_won');
    if (callbacks.some((callback) => callback.afterCompletion === true && callback.result !== 'already_completed')) {
      failures.push('setup_replayed');
    }
  }
  if (!hasSettledActivity(admin)) {
    failures.push('activity_lingering');
  }

  const observedTokens: AssertionToken[] = [];
  if (failures.length === 0) observedTokens.push(expectedToken);
  if (!failures.includes('agent_binding_missing')) observedTokens.push('forbidden.no_cross_agent_reuse');
  if (variantId === 'LC04-V3-editor-race' && !failures.some((failure) =>
    ['duplicate_completion', 'setup_replayed', 'stale_callback_won'].includes(failure)
  )) observedTokens.push('forbidden.no_duplicate');
  return result(observedTokens, failures);
}

function arrayAt(input: Record<string, unknown>, key: string): unknown[] {
  const value = input[key];
  if (!Array.isArray(value)) throw new Error('INVALID_UPSTREAM_SHAPE');
  return value;
}

function stringArrayAt(input: Record<string, unknown>, key: string): string[] {
  const values = arrayAt(input, key);
  if (!values.every((value) => typeof value === 'string' && value.length > 0)) throw new Error('INVALID_UPSTREAM_SHAPE');
  return values as string[];
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

function sameStrings(input: unknown[], expected: string[]): boolean {
  return input.length === expected.length && input.every((value, index) => value === expected[index]);
}
