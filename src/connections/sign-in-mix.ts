import type { ConnectionAccount, ConnectionAccountOwnerKind } from '../config/types.ts';
import type { ManagedConnectorDefinition } from './catalog/index.ts';

/*
 * Notion keeps one page list per person for Composio's Notion app, so one
 * Notion account behind both a personal and a team connection would let team
 * Agents reach pages shared for personal use. In a workspace, one account of a
 * shared-sign-in connector therefore backs connections of one owner kind only.
 */

interface SignInLane {
  connector: ManagedConnectorDefinition;
  adapterId: string;
  /** The owner kind of the connection being signed in. */
  ownerKind: ConnectionAccountOwnerKind;
  actorMembershipId: string;
  /** The workspace's connection accounts. */
  accounts: readonly ConnectionAccount[];
}

/**
 * The member a connection's sign-in belongs to: whoever completed it. Another
 * member can add a row to that sign-in, so a row's owner or creator stands in
 * only for a sign-in recorded before signers were.
 */
export function signInSigner(account: ConnectionAccount): string | undefined {
  const signedBy = account.policy.kind === 'managed' ? account.policy.signIn?.signedBy : undefined;
  return signedBy ?? (account.ownerKind === 'member' ? account.ownerMembershipId : account.createdByMembershipId);
}

/** A live connection of the other owner kind that the actor signed, checked before the provider opens. */
export function actorSignedOtherKind(lane: SignInLane): ConnectionAccount | undefined {
  return otherKindAccounts(lane).find((account) => signInSigner(account) === lane.actorMembershipId);
}

/**
 * A live connection of the other owner kind that a completed sign-in would mix
 * with: the same Notion person, or, when either person cannot be compared, a
 * connection the actor signed. `samePerson` tells the two apart, so the
 * refusal does not claim the account is shared when that is unknown.
 */
export function signInMix(
  lane: SignInLane & { person: string | undefined },
): { account: ConnectionAccount; samePerson: boolean } | undefined {
  for (const account of otherKindAccounts(lane)) {
    const theirs = account.policy.kind === 'managed' ? account.policy.signIn?.person : undefined;
    if (providerNamedPerson(lane.person) && providerNamedPerson(theirs)) {
      if (lane.person === theirs) return { account, samePerson: true };
    } else if (signInSigner(account) === lane.actorMembershipId) {
      return { account, samePerson: false };
    }
  }
  return undefined;
}

/** Chickpea refused a completed sign-in and saved nothing; the message is for the person who signed in. */
export class ManagedSignInMixError extends Error {
  readonly name = 'ManagedSignInMixError';
}

/** Chickpea stopped before the provider opened; the person may continue with a different account. */
export class ManagedSignInOtherKindError extends Error {
  readonly name = 'ManagedSignInOtherKindError';
}

export function signInOtherKindNotice(
  connector: ManagedConnectorDefinition,
  otherKind: ConnectionAccountOwnerKind,
): string {
  const { label } = connector;
  const pages = connector.providerSelection?.label ?? 'pages';
  return `You already connected ${label} for ${ownerKindWord(otherKind)} use in this workspace. ` +
    `One ${label} account can't be both personal and team here, so ${pages} shared for personal use stay out of team Agents. ` +
    `To continue, sign in with a different ${label} account. Switch accounts in ${label} before you choose ${pages}.`;
}

export function signInMixRefusal(
  connector: ManagedConnectorDefinition,
  otherKind: ConnectionAccountOwnerKind,
  mix: {
    /** Whether the provider named the same person on both sign-ins, or the signer alone matched. */
    samePerson: boolean;
    /** Whether the person who signed in can change that connection's pages themselves. */
    manageable: boolean;
  },
): string {
  const { label } = connector;
  const pages = connector.providerSelection?.label ?? 'pages';
  const change = `Change ${label} ${pages}`;
  const kind = ownerKindWord(otherKind);
  return (mix.samePerson
    ? `Chickpea didn't connect ${label}. That ${label} account is already used for a ${kind} connection in this workspace, ` +
      `and one ${label} account can't be both personal and team here. ` +
      `The ${pages} you just chose in ${label} stay shared with that connection. `
    : `Chickpea didn't connect ${label}, because it can't tell whether that ${label} account is the one behind your ${kind} connection in this workspace. ` +
      `One ${label} account can't be both personal and team here. ` +
      `If it is the same account, the ${pages} you just chose in ${label} stay shared with that connection. `) +
    (mix.manageable
      ? `To remove them, open that connection's menu and choose ${change}.`
      : `To remove them, ask whoever manages that connection to choose ${change} in its menu.`);
}

function otherKindAccounts(lane: SignInLane): ConnectionAccount[] {
  if (!lane.connector.sharedSignIn) return [];
  const adapterId = lane.adapterId.trim().toLowerCase();
  return lane.accounts.filter((account) =>
    account.lifecycle !== 'revoked' &&
    account.ownerKind !== lane.ownerKind &&
    account.policy.kind === 'managed' &&
    account.policy.adapterId.trim().toLowerCase() === adapterId &&
    account.policy.toolkit === lane.connector.toolkit);
}

/** Only a person the provider named can be compared; a `member:` fallback cannot. */
export function providerNamedPerson(person: string | undefined): person is string {
  return person?.startsWith('notion:') === true;
}

function ownerKindWord(ownerKind: ConnectionAccountOwnerKind): string {
  return ownerKind === 'team' ? 'team' : 'personal';
}
