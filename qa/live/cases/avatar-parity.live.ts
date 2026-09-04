import { defineLiveCase, requiredSuitesForVariant, type AssertionToken } from '../schema.ts';
import type { FoundationEvaluation } from './_shared.ts';
import {
  integerAt,
  markerAt,
  objectAt,
  result,
  sha256Base64,
  stringAt,
  upstreamRecord,
} from './_shared.ts';

export const AVATAR_PARITY_LIVE_BLOCKER =
  'Chickpea does not expose one authenticated canonical source digest with Admin and Slack persona readback.';

export const AVATAR_PARITY_CONTRACT = defineLiveCase({
  id: 'LC-02',
  title: 'Canonical Agent avatar parity',
  area: 'agents',
  feature: 'avatar_parity',
  entryPoints: ['admin', 'slack_root'],
  variants: [{
    id: 'LC02-V1-avatar-parity',
    title: 'Publish one canonical avatar across Admin and Slack',
    suites: requiredSuitesForVariant('LC02-V1-avatar-parity'),
    fixtures: [
      { slot: 'agent', kind: 'agent', fixtureClass: 'resettable_fixture' },
    ],
    actions: [{
      id: 'agent.update',
      message: 'Select the canonical run-marked avatar for Agent {{runMarker}}.',
      mutation: 'update',
      humanGate: 'none',
      fixtureSlots: ['agent'],
      cleanup: {
        strategy: 'revision_restore',
        fixtureClass: 'resettable_fixture',
        reversalActionId: 'agent.update',
      },
    }],
    generatedEffects: [],
    observers: ['agent.avatar.read', 'slack.persona.read', 'asset.digest.read'],
    expected: [
      { token: 'avatar.source_digest_parity', observerId: 'asset.digest.read' },
      { token: 'avatar.presentation_parity', observerId: 'agent.avatar.read' },
      { token: 'avatar.presentation_parity', observerId: 'slack.persona.read' },
    ],
    forbidden: [],
    regressions: [{
      candidateId: 'CAND-LC02-avatar-parity',
      lesson: 'A matching image in one view does not prove the canonical source, Admin row, and Slack persona agree.',
    }],
    evidence: ['immutable_id', 'revision', 'observed_state', 'source_digest', 'cleanup_receipt'],
  }],
});

export type AvatarParityVariant = 'LC02-V1-avatar-parity';
export type AvatarParityFailure =
  | 'source_digest_mismatch'
  | 'published_asset_mismatch'
  | 'agent_identity_mismatch'
  | 'avatar_revision_mismatch'
  | 'presentation_mismatch';

export function evaluateAvatarParity(
  variantId: AvatarParityVariant,
  upstream: unknown,
): FoundationEvaluation<AvatarParityFailure> {
  const input = upstreamRecord(upstream);
  if (variantId !== 'LC02-V1-avatar-parity') throw new Error('UNKNOWN_VARIANT');
  markerAt(input);
  const request = objectAt(input, 'request');
  const admin = objectAt(input, 'admin');
  const agent = objectAt(admin, 'agent');
  const presence = objectAt(agent, 'slackPresence');
  const avatar = objectAt(presence, 'avatar');
  const slack = objectAt(input, 'slack');
  const presentation = objectAt(slack, 'presentation');
  const owner = objectAt(presentation, 'owner');
  const persona = objectAt(owner, 'persona');
  const assets = objectAt(input, 'assets');
  const expectedDigest = stringAt(request, 'expectedSourceDigest');
  const canonicalDigest = sha256Base64(stringAt(assets, 'canonicalBytesBase64'));
  const publishedDigest = sha256Base64(stringAt(assets, 'publishedBytesBase64'));
  const failures: AvatarParityFailure[] = [];

  if (canonicalDigest !== expectedDigest) failures.push('source_digest_mismatch');
  if (publishedDigest !== canonicalDigest) failures.push('published_asset_mismatch');
  if (agent.id !== request.agentId) failures.push('agent_identity_mismatch');
  if (integerAt(avatar, 'revision') !== integerAt(persona, 'avatarRevision')) {
    failures.push('avatar_revision_mismatch');
  }
  if (typeof avatar.url !== 'string' || avatar.url.length === 0 ||
      typeof persona.avatarUrl !== 'string' || persona.avatarUrl.length === 0 ||
      owner.kind !== 'selected_agent') {
    failures.push('presentation_mismatch');
  }

  const observed: AssertionToken[] = [];
  if (!failures.some((failure) => ['source_digest_mismatch', 'published_asset_mismatch'].includes(failure))) {
    observed.push('avatar.source_digest_parity');
  }
  if (!failures.some((failure) => [
    'agent_identity_mismatch', 'avatar_revision_mismatch', 'presentation_mismatch',
  ].includes(failure))) observed.push('avatar.presentation_parity');
  return result(observed, failures);
}
