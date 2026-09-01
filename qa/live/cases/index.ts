import {
  defineLiveCase,
  requiredSuitesForVariant,
  type CleanupIntent,
  type LiveCatalog,
} from '../schema.ts';

const agentResidue: CleanupIntent = {
  strategy: 'attributed_residue',
  fixtureClass: 'attributed_residue',
  residue: {
    kind: 'agent_tombstone',
    markerRequired: true,
    expectedState: 'The run-marked Agent is archived and has no active Slack route.',
  },
};

const slackResidue: CleanupIntent = {
  strategy: 'attributed_residue',
  fixtureClass: 'attributed_residue',
  residue: {
    kind: 'slack_message',
    markerRequired: true,
    expectedState: 'The exact run-marked Slack message is attributed to this run.',
  },
};

export const FOUNDATION_LIVE_CASES = [
  defineLiveCase({
    id: 'LC-01',
    title: 'Immediate Agent lifecycle',
    area: 'agents',
    feature: 'agent_lifecycle',
    entryPoints: ['admin', 'slack_root'],
    variants: [
      {
        id: 'LC01-V1-create-welcome',
        title: 'Create an Agent and observe its welcome',
        suites: requiredSuitesForVariant('LC01-V1-create-welcome'),
        fixtures: [
          { slot: 'owner', kind: 'actor', fixtureClass: 'immutable_baseline' },
          { slot: 'channel', kind: 'slack_channel', fixtureClass: 'immutable_baseline' },
        ],
        actions: [{
          id: 'agent.create',
          message: 'Create the run-marked acceptance Agent {{runMarker}} and assign it to the QA channel.',
          mutation: 'create',
          humanGate: 'none',
          fixtureSlots: ['owner', 'channel'],
          cleanup: agentResidue,
        }],
        generatedEffects: [{
          id: 'slack.message.generated',
          message: 'Chickpea publishes the exact welcome for Agent {{runMarker}} in its assigned channel.',
          fixtureSlots: ['channel'],
          observerId: 'slack.messages.read',
          cleanup: slackResidue,
        }],
        observers: ['agent.read', 'slack.messages.read'],
        expected: [
          { token: 'agent.exists', observerId: 'agent.read' },
          { token: 'slack.message_matches', observerId: 'slack.messages.read' },
        ],
        forbidden: [{ token: 'forbidden.no_duplicate', observerId: 'slack.messages.read' }],
        regressions: [{
          candidateId: 'CAND-LC01-create-welcome',
          lesson: 'Creation is incomplete until the Agent and its exact Slack welcome are both observable.',
        }],
        evidence: ['immutable_id', 'revision', 'observed_state', 'actor_alias', 'action_receipt', 'cleanup_receipt'],
      },
      {
        id: 'LC01-V2-update-approve',
        title: 'Apply the full frozen update through bare approval',
        suites: requiredSuitesForVariant('LC01-V2-update-approve'),
        fixtures: [
          { slot: 'owner', kind: 'actor', fixtureClass: 'immutable_baseline' },
          { slot: 'agent', kind: 'agent', fixtureClass: 'resettable_fixture' },
        ],
        actions: [{
          id: 'agent.update',
          message: 'Preview the complete run-marked update for {{runMarker}}, then apply that frozen value after bare approval.',
          mutation: 'update',
          humanGate: 'approval',
          fixtureSlots: ['owner', 'agent'],
          cleanup: {
            strategy: 'revision_restore',
            fixtureClass: 'resettable_fixture',
            reversalActionId: 'agent.update',
          },
        }],
        generatedEffects: [],
        observers: ['agent.read'],
        expected: [{ token: 'agent.instructions_equal', observerId: 'agent.read' }],
        forbidden: [{ token: 'forbidden.no_early_mutation', observerId: 'agent.read' }],
        regressions: [{
          candidateId: 'CAND-LC01-update-approve',
          lesson: 'Approval applies the complete frozen preview, never a partial or regenerated value.',
        }],
        evidence: ['immutable_id', 'revision', 'observed_state', 'actor_alias', 'action_receipt', 'cleanup_receipt'],
      },
    ],
  }),
  defineLiveCase({
    id: 'LC-04',
    title: 'Connection ownership and setup attribution',
    area: 'connections',
    feature: 'connection_ownership',
    entryPoints: ['admin', 'oauth', 'provider'],
    variants: [
      {
        id: 'LC04-V1-personal-read',
        title: 'Authorize a Personal read-only connection',
        suites: requiredSuitesForVariant('LC04-V1-personal-read'),
        fixtures: [
          { slot: 'member', kind: 'actor', fixtureClass: 'immutable_baseline' },
          { slot: 'provider', kind: 'provider_account', fixtureClass: 'immutable_baseline' },
          { slot: 'agent', kind: 'agent', fixtureClass: 'resettable_fixture' },
        ],
        actions: [{
          id: 'connection.authorize',
          message: 'Authorize the run-marked Personal read-only connection {{runMarker}} for this Agent.',
          mutation: 'authorize',
          humanGate: 'oauth_consent',
          fixtureSlots: ['member', 'provider', 'agent'],
          cleanup: {
            strategy: 'exact_reversal',
            fixtureClass: 'run_owned',
            reversalActionId: 'connection.revoke',
          },
        }],
        generatedEffects: [],
        observers: ['connection.read', 'provider.read'],
        expected: [{ token: 'connection.owner_personal', observerId: 'connection.read' }],
        forbidden: [{ token: 'forbidden.no_cross_agent_reuse', observerId: 'connection.read' }],
        regressions: [{
          candidateId: 'CAND-LC04-personal-read',
          lesson: 'Personal authority stays with the owning Agent and never becomes a silent team grant.',
        }],
        evidence: ['immutable_id', 'revision', 'observed_state', 'actor_alias', 'action_receipt', 'cleanup_receipt'],
      },
      {
        id: 'LC04-V2-team-read',
        title: 'Authorize a Team read-only connection',
        suites: requiredSuitesForVariant('LC04-V2-team-read'),
        fixtures: [
          { slot: 'admin', kind: 'actor', fixtureClass: 'immutable_baseline' },
          { slot: 'provider', kind: 'provider_account', fixtureClass: 'immutable_baseline' },
          { slot: 'agent', kind: 'agent', fixtureClass: 'resettable_fixture' },
        ],
        actions: [{
          id: 'connection.authorize',
          message: 'Authorize the run-marked Team read-only connection {{runMarker}} for this Agent.',
          mutation: 'authorize',
          humanGate: 'oauth_consent',
          fixtureSlots: ['admin', 'provider', 'agent'],
          cleanup: {
            strategy: 'exact_reversal',
            fixtureClass: 'run_owned',
            reversalActionId: 'connection.revoke',
          },
        }],
        generatedEffects: [],
        observers: ['connection.read', 'provider.read'],
        expected: [{ token: 'connection.owner_team', observerId: 'connection.read' }],
        forbidden: [{ token: 'forbidden.no_cross_agent_reuse', observerId: 'connection.read' }],
        regressions: [{
          candidateId: 'CAND-LC04-team-read',
          lesson: 'Team ownership is explicit and does not weaken Agent-scoped binding.',
        }],
        evidence: ['immutable_id', 'revision', 'observed_state', 'actor_alias', 'action_receipt', 'cleanup_receipt'],
      },
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
  }),
  defineLiveCase({
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
  }),
] as const;

export const PUBLIC_LIVE_CATALOG: LiveCatalog = {
  schemaVersion: 'chickpea-live-catalog/v1',
  release: 'v1.0',
  pendingContractIds: ['LC-02', 'LC-03', 'LC-05', 'LC-06', 'LC-07', 'LC-09', 'LC-10'],
  contracts: [...FOUNDATION_LIVE_CASES],
};
