import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConnectionAccount } from '../src/config/types.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../src/connections/catalog/index.ts';
import {
  actorSignedOtherKind,
  signInMix,
  signInMixRefusal,
  signInOtherKindNotice,
  signInSigner,
} from '../src/connections/sign-in-mix.ts';

const notion = MANAGED_CONNECTOR_CATALOG.connector('notion')!;
const gmail = MANAGED_CONNECTOR_CATALOG.connector('gmail')!;

function account(input: {
  id: string;
  ownerKind: 'team' | 'member';
  signer: string;
  person?: string;
  /** Whoever completed the sign-in, when it was recorded; `signer` stays the owner or creator. */
  signedBy?: string;
  toolkit?: string;
  lifecycle?: ConnectionAccount['lifecycle'];
}): ConnectionAccount {
  return {
    id: input.id,
    workspaceId: 'T_MIX',
    revision: 1,
    ownerKind: input.ownerKind,
    ...(input.ownerKind === 'member' ? { ownerMembershipId: input.signer } : {}),
    createdByMembershipId: input.signer,
    providerId: input.toolkit ?? 'notion',
    label: input.id,
    secretRefId: `secret_${input.id}`,
    lifecycle: input.lifecycle ?? 'ready',
    createdAt: 1,
    updatedAt: 1,
    policy: {
      kind: 'managed',
      adapterId: 'composio',
      toolkit: input.toolkit ?? 'notion',
      principalRef: `principal_${input.id}`,
      accountRef: `ca_${input.id}`,
      allowedCapabilities: ['notion.content.search'],
      ...(input.person
        ? { signIn: { person: input.person, accessLane: 'read' as const, ...(input.signedBy ? { signedBy: input.signedBy } : {}) } }
        : {}),
    },
  };
}

const lane = (ownerKind: 'team' | 'member', actorMembershipId: string, accounts: ConnectionAccount[]) =>
  ({ connector: notion, adapterId: 'composio', ownerKind, actorMembershipId, accounts });

test('the pre-check finds a live connection of the other kind that the actor signed', () => {
  const team = account({ id: 'team', ownerKind: 'team', signer: 'm_maya' });
  const personal = account({ id: 'personal', ownerKind: 'member', signer: 'm_ravi' });
  const accounts = [team, personal];

  assert.equal(actorSignedOtherKind(lane('member', 'm_maya', accounts))?.id, 'team',
    'Maya created the team connection, so her personal sign-in stops first');
  assert.equal(actorSignedOtherKind(lane('team', 'm_ravi', accounts))?.id, 'personal',
    'Ravi owns a personal connection, so his team sign-in stops first');
  assert.equal(actorSignedOtherKind(lane('member', 'm_ravi', accounts)), undefined,
    'a member who signed no team connection proceeds');
  assert.equal(actorSignedOtherKind(lane('team', 'm_maya', accounts)), undefined,
    'an Admin who did not sign the personal connection proceeds');
  assert.equal(actorSignedOtherKind(lane('member', 'm_maya',
    [account({ id: 'team', ownerKind: 'team', signer: 'm_maya', lifecycle: 'revoked' })])), undefined,
    'a revoked connection never counts');
  assert.equal(actorSignedOtherKind({ ...lane('member', 'm_maya', accounts), connector: gmail }), undefined,
    'a connector without shared sign-ins is untouched');
  assert.equal(actorSignedOtherKind(lane('member', 'm_maya',
    [account({ id: 'gmail', ownerKind: 'team', signer: 'm_maya', toolkit: 'gmail' })])), undefined,
    'another toolkit never counts');
});

test('a completed sign-in mixes with the other kind on the same Notion person or a signer it cannot tell apart', () => {
  const maya = 'notion:ws-1:user-maya';
  const ravi = 'notion:ws-1:user-ravi';
  /** The mixing connection and how it matched: `<id> same person` or `<id> same signer`. */
  const check = (
    ownerKind: 'team' | 'member',
    actor: string,
    person: string | undefined,
    accounts: ConnectionAccount[],
  ) => {
    const mix = signInMix({ ...lane(ownerKind, actor, accounts), person });
    return mix && `${mix.account.id} same ${mix.samePerson ? 'person' : 'signer'}`;
  };

  const team = account({ id: 'team', ownerKind: 'team', signer: 'm_admin', person: maya });
  assert.equal(check('member', 'm_maya', maya, [team]), 'team same person',
    'the same Notion person is refused even when someone else created the team connection');
  assert.equal(check('member', 'm_admin', ravi, [team]), undefined,
    'different Notion persons are allowed even for the team connection\'s creator');

  const fallbackTeam = account({ id: 'team', ownerKind: 'team', signer: 'm_maya', person: 'member:m_maya' });
  assert.equal(check('member', 'm_maya', maya, [fallbackTeam]), 'team same signer',
    'a member: person on the other connection fails closed for its signer');
  assert.equal(check('member', 'm_ravi', ravi, [fallbackTeam]), undefined,
    'a member: person does not refuse someone who did not sign it');
  assert.equal(check('member', 'm_maya', 'member:m_maya', [team]), undefined,
    'a member: person on the new sign-in compares signers, and Maya did not sign this team connection');
  assert.equal(check('team', 'm_maya', 'member:m_maya',
    [account({ id: 'personal', ownerKind: 'member', signer: 'm_maya', person: ravi })]), 'personal same signer',
    'a member: person on the new sign-in fails closed against a connection the actor signed');
  assert.equal(check('member', 'm_maya', maya,
    [account({ id: 'legacy', ownerKind: 'team', signer: 'm_maya' })]), 'legacy same signer',
    'a legacy connection without a person fails closed for its signer');

  assert.equal(check('member', 'm_maya', maya,
    [account({ id: 'team', ownerKind: 'team', signer: 'm_admin', person: maya, lifecycle: 'revoked' })]), undefined,
    'a revoked connection never counts');
  assert.equal(check('member', 'm_maya', maya,
    [account({ id: 'personal', ownerKind: 'member', signer: 'm_other', person: maya })]), undefined,
    'a connection of the same kind is not a mix');
  assert.equal(signInMix({ ...lane('member', 'm_maya', [team]), connector: gmail, person: maya }), undefined,
    'a connector without shared sign-ins is untouched');
});

test('the member a sign-in records as its signer is the signer; one recorded before that falls back to the owner or creator', () => {
  // Maya signed the team sign-in; Bob created this row by adding another Agent to it.
  const added = account({ id: 'team', ownerKind: 'team', signer: 'm_bob', person: 'member:m_maya', signedBy: 'm_maya' });
  assert.equal(signInSigner(added), 'm_maya');
  assert.equal(actorSignedOtherKind(lane('member', 'm_maya', [added]))?.id, 'team');
  assert.equal(actorSignedOtherKind(lane('member', 'm_bob', [added])), undefined);
  assert.equal(signInMix({ ...lane('member', 'm_maya', [added]), person: 'member:m_maya' })?.account.id, 'team');
  assert.equal(signInMix({ ...lane('member', 'm_bob', [added]), person: 'member:m_bob' }), undefined);

  const older = account({ id: 'team', ownerKind: 'team', signer: 'm_bob', person: 'member:m_maya' });
  assert.equal(signInSigner(older), 'm_bob', 'a team sign-in recorded before signers names its creator');
  assert.equal(signInMix({ ...lane('member', 'm_bob', [older]), person: 'member:m_bob' })?.account.id, 'team');
  assert.equal(signInMix({ ...lane('member', 'm_maya', [older]), person: 'member:m_maya' }), undefined);
  assert.equal(signInSigner(account({ id: 'personal', ownerKind: 'member', signer: 'm_zed' })), 'm_zed',
    'a personal sign-in recorded before signers names its owner');
});

test('the notice and refusal explain the rule without naming anyone', () => {
  assert.equal(signInOtherKindNotice(notion, 'team'),
    'You already connected Notion for team use in this workspace. ' +
    'One Notion account can\'t be both personal and team here, so pages shared for personal use stay out of team Agents. ' +
    'To continue, sign in with a different Notion account. Switch accounts in Notion before you choose pages.');
  assert.match(signInOtherKindNotice(notion, 'member'), /^You already connected Notion for personal use in this workspace\./);
  assert.equal(signInMixRefusal(notion, 'team', { samePerson: true, manageable: true }),
    'Chickpea didn\'t connect Notion. That Notion account is already used for a team connection in this workspace, ' +
    'and one Notion account can\'t be both personal and team here. ' +
    'The pages you just chose in Notion stay shared with that connection. ' +
    'To remove them, open that connection\'s menu and choose Change Notion pages.');
  assert.match(signInMixRefusal(notion, 'member', { samePerson: true, manageable: false }),
    /already used for a personal connection.*ask whoever manages that connection to choose Change Notion pages in its menu\.$/);
  assert.equal(signInMixRefusal(notion, 'team', { samePerson: false, manageable: true }),
    'Chickpea didn\'t connect Notion, because it can\'t tell whether that Notion account is the one behind your team connection in this workspace. ' +
    'One Notion account can\'t be both personal and team here. ' +
    'If it is the same account, the pages you just chose in Notion stay shared with that connection. ' +
    'To remove them, open that connection\'s menu and choose Change Notion pages.',
    'a signer-only match does not claim the account is shared');
});
