import { defineLiveCase, requiredSuitesForVariant, type AssertionToken } from '../schema.ts';
import type { FoundationEvaluation } from './_shared.ts';
import {
  hasSettledActivity,
  markerAt,
  objectAt,
  recordsAt,
  result,
  stringAt,
  upstreamRecord,
} from './_shared.ts';

export const SLACK_ROUTING_LIVE_BLOCKER =
  'No authenticated read-only endpoint exposes AgentThreadRoute, ChannelGrant, and durable turn admission together.';

export const SLACK_ROUTING_CONTRACT = defineLiveCase({
  id: 'LC-03',
  title: 'Durable Slack route ownership',
  area: 'agents',
  feature: 'slack_routing',
  entryPoints: ['slack_root', 'slack_thread'],
  variants: [
    routingVariant(
      'LC03-V1-ingress-root-thread',
      'Admit one root and keep its thread owner',
      'CAND-LC03-ingress-root-thread',
      'A reply is valid only after durable admission, exact route ownership, and one persona delivery agree.',
      'slack.message.send',
    ),
    routingVariant(
      'LC03-V2-handoff',
      'Handoff one exact Slack thread',
      'CAND-LC03-handoff',
      'A handoff changes the durable thread owner once and never routes an ambiguous or unauthorized address.',
      'route.handoff',
    ),
    {
      ...routingVariant(
        'LC03-V3-archive-restore',
        'Archive and restore route eligibility',
        'CAND-LC03-archive-restore',
        'Archived Agents cannot retain an active route, and restoration must reestablish an authorized exact owner.',
        'route.handoff',
      ),
      actions: [
        {
          id: 'agent.archive',
          message: 'Archive the routed Agent marked {{runMarker}} and verify the route is unavailable.',
          mutation: 'archive',
          humanGate: 'none',
          fixtureSlots: ['member', 'channel', 'agent'],
          cleanup: {
            strategy: 'attributed_residue',
            fixtureClass: 'attributed_residue',
            residue: {
              kind: 'agent_tombstone',
              markerRequired: true,
              expectedState: 'The run-marked archive transition remains attributed to this run.',
            },
          },
        },
        {
          id: 'agent.restore',
          message: 'Restore the same run-marked Agent {{runMarker}} with its authorized Channel grant.',
          mutation: 'restore',
          humanGate: 'none',
          fixtureSlots: ['member', 'channel', 'agent'],
          cleanup: {
            strategy: 'revision_restore',
            fixtureClass: 'resettable_fixture',
            reversalActionId: 'agent.archive',
          },
        },
      ],
    },
  ],
});

function routingVariant(
  id: 'LC03-V1-ingress-root-thread' | 'LC03-V2-handoff' | 'LC03-V3-archive-restore',
  title: string,
  candidateId: string,
  lesson: string,
  actionId: 'slack.message.send' | 'route.handoff',
) {
  return {
    id,
    title,
    suites: requiredSuitesForVariant(id),
    fixtures: [
      { slot: 'member', kind: 'actor' as const, fixtureClass: 'immutable_baseline' as const },
      { slot: 'channel', kind: 'slack_channel' as const, fixtureClass: 'immutable_baseline' as const },
      { slot: 'agent', kind: 'agent' as const, fixtureClass: 'resettable_fixture' as const },
    ],
    actions: [{
      id: actionId,
      message: 'Assign the exact run-marked Slack thread {{runMarker}} to the authorized Agent.',
      mutation: actionId === 'slack.message.send' ? 'create' as const : 'update' as const,
      humanGate: 'none' as const,
      fixtureSlots: ['member', 'channel', 'agent'],
      cleanup: actionId === 'slack.message.send'
        ? {
            strategy: 'attributed_residue' as const,
            fixtureClass: 'attributed_residue' as const,
            residue: {
              kind: 'slack_message' as const,
              markerRequired: true as const,
              expectedState: 'The exact run-marked ingress message is attributed to this run.',
            },
          }
        : {
            strategy: 'revision_restore' as const,
            fixtureClass: 'resettable_fixture' as const,
            reversalActionId: 'route.handoff' as const,
          },
    }],
    generatedEffects: [{
      id: 'slack.message.generated' as const,
      message: 'Chickpea delivers one terminal reply for {{runMarker}} through the selected Agent persona.',
      fixtureSlots: ['channel', 'agent'],
      observerId: 'slack.messages.read' as const,
      cleanup: {
        strategy: 'attributed_residue' as const,
        fixtureClass: 'attributed_residue' as const,
        residue: {
          kind: 'slack_message' as const,
          markerRequired: true as const,
          expectedState: 'The exact run-marked terminal reply is attributed to this run.',
        },
      },
    }],
    observers: ['route.read' as const, 'slack.messages.read' as const, 'slack.persona.read' as const, 'cloudflare.version.read' as const],
    expected: [
      { token: 'route.ingress_admitted' as const, observerId: 'route.read' as const },
      { token: 'route.owner_exact' as const, observerId: 'route.read' as const },
      { token: 'slack.persona_matches' as const, observerId: 'slack.persona.read' as const },
      { token: 'slack.message_matches' as const, observerId: 'slack.messages.read' as const },
    ],
    forbidden: [
      { token: 'forbidden.no_duplicate' as const, observerId: 'slack.messages.read' as const },
      { token: 'forbidden.no_unauthorized_mutation' as const, observerId: 'route.read' as const },
    ],
    regressions: [{ candidateId, lesson }],
    evidence: ['immutable_id' as const, 'revision' as const, 'observed_state' as const, 'action_receipt' as const, 'cleanup_receipt' as const],
  };
}

export type SlackRoutingVariant = typeof SLACK_ROUTING_CONTRACT.variants[number]['id'];
export type SlackRoutingFailure =
  | 'target_identity_changed'
  | 'route_missing'
  | 'route_owner_mismatch'
  | 'grant_missing'
  | 'ingress_not_durable'
  | 'handoff_receipt_missing'
  | 'unauthorized_route_mutation'
  | 'terminal_delivery_missing'
  | 'terminal_delivery_duplicate'
  | 'persona_mismatch'
  | 'activity_lingering'
  | 'agent_not_restored';

export function evaluateSlackRouting(
  variantId: SlackRoutingVariant,
  upstream: unknown,
): FoundationEvaluation<SlackRoutingFailure> {
  const input = upstreamRecord(upstream);
  if (!SLACK_ROUTING_CONTRACT.variants.some(({ id }) => id === variantId)) throw new Error('UNKNOWN_VARIANT');
  markerAt(input);
  const request = objectAt(input, 'request');
  const admin = objectAt(input, 'admin');
  const slack = objectAt(input, 'slack');
  const target = objectAt(input, 'target');
  const expectedAgentId = stringAt(request, 'expectedAgentId');
  const route = recordsAt(admin, 'routes').find((candidate) =>
    candidate.workspaceId === request.workspaceId &&
    candidate.channelId === request.channelId &&
    candidate.threadTs === request.threadTs
  );
  const failures: SlackRoutingFailure[] = [];

  if (target.workerVersionId !== target.afterWorkerVersionId ||
      target.gatewayVersionId !== target.afterGatewayVersionId) failures.push('target_identity_changed');
  if (!route) failures.push('route_missing');
  if (route?.agentId !== expectedAgentId || route?.revision !== request.expectedRouteRevision) {
    failures.push('route_owner_mismatch');
  }
  const grant = recordsAt(admin, 'channelGrants').find((candidate) =>
    candidate.agentId === expectedAgentId && candidate.channelId === request.channelId && candidate.status === 'active'
  );
  if (!grant) failures.push('grant_missing');
  const jobs = recordsAt(admin, 'turnJobs').filter((candidate) => {
    const turn = candidate.turn;
    const assignment = candidate.assignment;
    return typeof turn === 'object' && turn !== null && typeof assignment === 'object' && assignment !== null &&
      (turn as Record<string, unknown>).eventId === request.eventId &&
      (assignment as Record<string, unknown>).agentId === expectedAgentId;
  });
  if (jobs.length !== 1) failures.push('ingress_not_durable');
  if (variantId === 'LC03-V2-handoff') {
    const handoff = route && typeof route.handoff === 'object' && route.handoff !== null
      ? route.handoff as Record<string, unknown>
      : undefined;
    if (handoff?.previousAgentId !== request.previousAgentId || handoff?.transferMessageTs !== request.transferMessageTs) {
      failures.push('handoff_receipt_missing');
    }
  }
  if (recordsAt(admin, 'routingAttempts').some((attempt) =>
    attempt.kind === 'routed' && attempt.authorized !== true
  )) failures.push('unauthorized_route_mutation');
  if (variantId === 'LC03-V3-archive-restore') {
    const agent = recordsAt(admin, 'agents').find((candidate) => candidate.id === expectedAgentId);
    if (agent?.enabled !== true || agent.lifecycle !== 'active') failures.push('agent_not_restored');
  }

  const messages = recordsAt(slack, 'messages').filter((message) =>
    message.channel === request.channelId && message.thread_ts === request.threadTs && message.subtype !== 'bot_message_deleted'
  );
  if (messages.length === 0) failures.push('terminal_delivery_missing');
  if (messages.length > 1) failures.push('terminal_delivery_duplicate');
  const presentation = objectAt(admin, 'presentation');
  const owner = objectAt(presentation, 'owner');
  const persona = objectAt(owner, 'persona');
  const botProfile = messages[0] && typeof messages[0].bot_profile === 'object' && messages[0].bot_profile !== null
    ? messages[0].bot_profile as Record<string, unknown>
    : undefined;
  const selectedAgent = recordsAt(admin, 'agents').find((candidate) => candidate.id === expectedAgentId);
  const selectedPresence = selectedAgent && typeof selectedAgent.slackPresence === 'object' && selectedAgent.slackPresence !== null
    ? selectedAgent.slackPresence as Record<string, unknown>
    : undefined;
  const selectedAvatar = selectedPresence && typeof selectedPresence.avatar === 'object' && selectedPresence.avatar !== null
    ? selectedPresence.avatar as Record<string, unknown>
    : undefined;
  if (owner.kind !== 'selected_agent' || botProfile?.name !== persona.name ||
      selectedAgent?.name !== persona.name || selectedAvatar?.revision !== persona.avatarRevision) {
    failures.push('persona_mismatch');
  }
  if (!hasSettledActivity(admin)) failures.push('activity_lingering');

  const observed: AssertionToken[] = [];
  if (!failures.includes('ingress_not_durable')) observed.push('route.ingress_admitted');
  if (!failures.some((failure) => [
    'route_missing', 'route_owner_mismatch', 'grant_missing', 'handoff_receipt_missing', 'agent_not_restored',
  ].includes(failure))) observed.push('route.owner_exact');
  if (!failures.includes('persona_mismatch')) observed.push('slack.persona_matches');
  if (!failures.includes('terminal_delivery_missing')) observed.push('slack.message_matches');
  if (!failures.includes('terminal_delivery_duplicate')) observed.push('forbidden.no_duplicate');
  if (!failures.includes('unauthorized_route_mutation')) observed.push('forbidden.no_unauthorized_mutation');
  return result(observed, failures);
}
