import { defineLiveCase, requiredSuitesForVariant, type AssertionToken } from '../schema.ts';
import type { FoundationEvaluation } from './agent-lifecycle.live.ts';
import {
  hasSettledActivity,
  integerAt,
  markerAt,
  objectAt,
  recordsAt,
  result,
  sha256Utf8,
  stringAt,
  upstreamRecord,
} from './_shared.ts';

export const QA_STYLE_GUARD_DIGEST =
  'sha256:d57c79be705f98b4f4cc5ef19f095c32068253d68e3515d5488ecbd98bc57811';

export const SKILL_MANAGEMENT_LIVE_BLOCKER =
  'SkillConfig stores no durable source commit, path, or digest, so live provenance cannot yet be graded.';

export const SKILL_MANAGEMENT_CONTRACT = defineLiveCase({
  id: 'LC-06',
  title: 'Pinned scriptless skill lifecycle',
  area: 'skills',
  feature: 'skill_lifecycle',
  entryPoints: ['slack_root', 'slack_thread'],
  variants: [
    {
      id: 'LC06-V1-import-behavior-remove',
      title: 'Import, use, and remove one pinned scriptless skill',
      suites: requiredSuitesForVariant('LC06-V1-import-behavior-remove'),
      fixtures: [
        { slot: 'editor', kind: 'actor', fixtureClass: 'immutable_baseline' },
        { slot: 'agent', kind: 'agent', fixtureClass: 'resettable_fixture' },
        { slot: 'qa-style-guard', kind: 'source_fixture', fixtureClass: 'immutable_baseline', sourceDigest: QA_STYLE_GUARD_DIGEST },
      ],
      actions: [
        {
          id: 'skill.import',
          message: 'Import the pinned scriptless QA style guard for Agent {{runMarker}}.',
          mutation: 'create',
          humanGate: 'none',
          fixtureSlots: ['editor', 'agent', 'qa-style-guard'],
          cleanup: { strategy: 'exact_reversal', fixtureClass: 'run_owned', reversalActionId: 'skill.remove' },
        },
        {
          id: 'skill.remove',
          message: 'Remove the exact run-marked QA style guard {{runMarker}} after its structural result settles.',
          mutation: 'delete',
          humanGate: 'none',
          fixtureSlots: ['editor', 'agent', 'qa-style-guard'],
          cleanup: { strategy: 'revision_restore', fixtureClass: 'resettable_fixture', reversalActionId: 'skill.import' },
        },
      ],
      generatedEffects: [{
        id: 'slack.message.generated',
        message: 'The Agent returns the QA style guard structural result for {{runMarker}}.',
        fixtureSlots: ['agent'],
        observerId: 'slack.messages.read',
        cleanup: {
          strategy: 'attributed_residue',
          fixtureClass: 'attributed_residue',
          residue: {
            kind: 'slack_message',
            markerRequired: true,
            expectedState: 'The exact run-marked skill result is attributed to this run.',
          },
        },
      }],
      observers: ['skill.read', 'slack.messages.read'],
      expected: [
        { token: 'skill.provenance_pinned', observerId: 'skill.read' },
        { token: 'skill.enabled', observerId: 'skill.read' },
        { token: 'skill.behavior_matches', observerId: 'slack.messages.read' },
        { token: 'skill.removed', observerId: 'skill.read' },
      ],
      forbidden: [{ token: 'forbidden.no_duplicate', observerId: 'slack.messages.read' }],
      regressions: [{
        candidateId: 'CAND-LC06-import-behavior-remove',
        lesson: 'A named skill is insufficient proof without immutable source resolution, immediate durable enablement, behavior, and removal.',
      }],
      evidence: ['immutable_id', 'revision', 'observed_state', 'source_commit', 'source_digest', 'action_receipt', 'cleanup_receipt'],
    },
    {
      id: 'LC06-V2-cross-agent-denial',
      title: 'Deny cross-Agent skill mutation',
      suites: requiredSuitesForVariant('LC06-V2-cross-agent-denial'),
      fixtures: [
        { slot: 'editor', kind: 'actor', fixtureClass: 'immutable_baseline' },
        { slot: 'agent-one', kind: 'agent', fixtureClass: 'resettable_fixture' },
        { slot: 'agent-two', kind: 'agent', fixtureClass: 'resettable_fixture' },
        { slot: 'qa-style-guard', kind: 'source_fixture', fixtureClass: 'immutable_baseline', sourceDigest: QA_STYLE_GUARD_DIGEST },
      ],
      actions: [{
        id: 'skill.remove',
        message: 'Attempt the run-marked cross-Agent removal {{runMarker}} without target-Agent authority.',
        mutation: 'delete',
        humanGate: 'none',
        fixtureSlots: ['editor', 'agent-one', 'agent-two', 'qa-style-guard'],
        cleanup: { strategy: 'revision_restore', fixtureClass: 'resettable_fixture', reversalActionId: 'skill.import' },
      }],
      generatedEffects: [],
      observers: ['skill.read'],
      expected: [{ token: 'skill.enabled', observerId: 'skill.read' }],
      forbidden: [{ token: 'forbidden.no_unauthorized_mutation', observerId: 'skill.read' }],
      regressions: [{
        candidateId: 'CAND-LC06-cross-agent-denial',
        lesson: 'Agent edit authority is checked again at the exact skill mutation boundary.',
      }],
      evidence: ['immutable_id', 'revision', 'observed_state', 'action_receipt', 'cleanup_receipt'],
    },
  ],
});

export type SkillManagementVariant = typeof SKILL_MANAGEMENT_CONTRACT.variants[number]['id'];
export type SkillManagementFailure =
  | 'source_not_pinned'
  | 'source_digest_mismatch'
  | 'source_ambiguous'
  | 'packaged_scripts_present'
  | 'skill_missing'
  | 'skill_duplicate'
  | 'import_receipt_missing'
  | 'behavior_mismatch'
  | 'activity_lingering'
  | 'skill_not_removed'
  | 'cross_agent_mutation';

export function evaluateSkillManagement(
  variantId: SkillManagementVariant,
  upstream: unknown,
): FoundationEvaluation<SkillManagementFailure> {
  const input = upstreamRecord(upstream);
  if (!SKILL_MANAGEMENT_CONTRACT.variants.some(({ id }) => id === variantId)) throw new Error('UNKNOWN_VARIANT');
  markerAt(input);
  const request = objectAt(input, 'request');
  const resolution = objectAt(input, 'resolution');
  const admin = objectAt(input, 'admin');
  const failures: SkillManagementFailure[] = [];
  const expectedDigest = stringAt(request, 'expectedSourceDigest');
  if (!/^[a-f0-9]{40}$/u.test(stringAt(request, 'expectedCommit')) || resolution.ref !== request.expectedCommit) {
    failures.push('source_not_pinned');
  }
  if (expectedDigest !== QA_STYLE_GUARD_DIGEST || sha256Utf8(stringAt(input, 'skillMarkdown')) !== expectedDigest) {
    failures.push('source_digest_mismatch');
  }
  const resolvedSkills = recordsAt(resolution, 'skills');
  if (resolvedSkills.length !== 1 || resolution.total !== 1 || resolution.capped === true) {
    failures.push('source_ambiguous');
  }
  if (resolvedSkills.some((skill) => skill.hasScripts === true)) failures.push('packaged_scripts_present');

  const expectedName = stringAt(request, 'skillName');
  const importedAgent = objectAt(admin, 'afterImportAgent');
  const importedSkills = recordsAt(importedAgent, 'skills').filter((skill) => skill.name === expectedName);
  if (importedSkills.length === 0 || importedSkills[0]?.enabled !== true) failures.push('skill_missing');
  if (importedSkills.length > 1) failures.push('skill_duplicate');
  const receipt = objectAt(admin, 'importReceipt');
  const imported = objectAt(receipt, 'import');
  if (imported.name !== expectedName || imported.replacedExisting !== false) failures.push('import_receipt_missing');

  if (variantId === 'LC06-V1-import-behavior-remove') {
    const slack = objectAt(input, 'slack');
    const messages = recordsAt(slack, 'messages');
    if (messages.length !== 1) failures.push('behavior_mismatch');
    const output = messages[0] && typeof messages[0].result === 'object' && messages[0].result !== null
      ? messages[0].result as Record<string, unknown>
      : undefined;
    if (output?.style !== 'plain' || output.status !== 'checked' || output.marker_present !== true ||
        (output && Object.keys(output).length !== 3)) failures.push('behavior_mismatch');
    if (!hasSettledActivity(admin)) failures.push('activity_lingering');
    const removedAgent = objectAt(admin, 'afterRemoveAgent');
    if (recordsAt(removedAgent, 'skills').some((skill) => skill.name === expectedName) ||
        integerAt(removedAgent, 'revision') !== integerAt(importedAgent, 'revision') + 1) {
      failures.push('skill_not_removed');
    }
  } else {
    const beforeRevision = integerAt(admin, 'targetBeforeRevision');
    const target = objectAt(admin, 'targetAfterAgent');
    if (integerAt(target, 'revision') !== beforeRevision ||
        !recordsAt(target, 'skills').some((skill) => skill.name === expectedName && skill.enabled === true) ||
        objectAt(admin, 'denial').code !== 'agent_edit_forbidden') {
      failures.push('cross_agent_mutation');
    }
  }

  const observed: AssertionToken[] = [];
  if (!failures.some((failure) => [
    'source_not_pinned', 'source_digest_mismatch', 'source_ambiguous', 'packaged_scripts_present',
  ].includes(failure))) observed.push('skill.provenance_pinned');
  if (!failures.some((failure) => ['skill_missing', 'skill_duplicate'].includes(failure))) observed.push('skill.enabled');
  if (variantId === 'LC06-V1-import-behavior-remove') {
    if (!failures.includes('behavior_mismatch')) observed.push('skill.behavior_matches', 'forbidden.no_duplicate');
    if (!failures.includes('skill_not_removed')) observed.push('skill.removed');
  } else if (!failures.includes('cross_agent_mutation')) {
    observed.push('forbidden.no_unauthorized_mutation');
  }
  return result(observed, failures);
}
