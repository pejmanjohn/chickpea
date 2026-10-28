import type {
  ConnectionAccount,
  ConnectionAccountInput,
  ConnectionAccountManagedPolicy,
} from './types.ts';

/*
 * A sign-in group is the set of live managed accounts that share one remote
 * account: equal `policy.adapterId` and `policy.accountRef`. Each Agent keeps
 * its own account and binding. Every member holds the shared fields equal;
 * while a group has more than one member, only `ConfigStore.applySignInGroup`
 * changes them. A new field must be classified here before it compiles.
 */
const ACCOUNT_FIELDS = {
  workspaceId: 'shared',
  providerId: 'shared',
  ownerKind: 'shared',
  ownerMembershipId: 'shared',
  identity: 'shared',
  id: 'row',
  revision: 'row',
  label: 'row',
  purpose: 'row',
  secretRefId: 'row',
  lifecycle: 'row',
  createdByMembershipId: 'row',
  createdAt: 'row',
  updatedAt: 'row',
} as const satisfies Record<Exclude<keyof ConnectionAccount, 'policy'>, 'shared' | 'row'>;

const POLICY_FIELDS = {
  adapterId: 'shared',
  toolkit: 'shared',
  principalRef: 'shared',
  accountRef: 'shared',
  signIn: 'shared',
  grantSummary: 'shared',
  providerGeneration: 'shared',
  providerLineage: 'shared',
  resourceConstraints: 'shared',
  kind: 'row',
  allowedCapabilities: 'row',
  oauthAttemptId: 'row',
} as const satisfies Record<keyof ConnectionAccountManagedPolicy, 'shared' | 'row'>;

type SharedFields<T> = { [K in keyof T]: T[K] extends 'shared' ? K : never }[keyof T];

export const SIGN_IN_GROUP_SHARED_FIELDS = {
  account: sharedFields(ACCOUNT_FIELDS),
  policy: sharedFields(POLICY_FIELDS),
};

export type SignInGroupPolicy = Pick<ConnectionAccountManagedPolicy, SharedFields<typeof POLICY_FIELDS>>;

/** `ManagedSignIn.person`: a Notion workspace and user, or the signer's membership. */
export const MANAGED_SIGN_IN_PERSON =
  /^(?:notion:[A-Za-z0-9-]{1,64}:[A-Za-z0-9-]{1,64}|member:[A-Za-z0-9_.:@-]{1,200})$/;

/** Whether two managed accounts hold every shared field equal. */
export function sameSignInGroup(a: ConnectionAccountInput, b: ConnectionAccountInput): boolean {
  const left = a.policy;
  const right = b.policy;
  if (left.kind !== 'managed' || right.kind !== 'managed') return false;
  return SIGN_IN_GROUP_SHARED_FIELDS.account.every((field) => sameJson(a[field], b[field])) &&
    SIGN_IN_GROUP_SHARED_FIELDS.policy.every((field) => sameJson(left[field], right[field]));
}

/** The remote account a live managed account holds; undefined for any other account. */
export function signInGroupKey(account: ConnectionAccount): string | undefined {
  return account.lifecycle !== 'revoked' && account.policy.kind === 'managed'
    ? `${account.policy.adapterId.trim().toLowerCase()}\u0000${account.policy.accountRef}`
    : undefined;
}

export function signInGroupPolicy(policy: ConnectionAccountManagedPolicy): SignInGroupPolicy {
  return Object.fromEntries(SIGN_IN_GROUP_SHARED_FIELDS.policy
    .flatMap((field) => policy[field] === undefined ? [] : [[field, policy[field]]])) as SignInGroupPolicy;
}

/** A member's own policy fields with exactly the group's `shared` fields. */
export function withSignInGroupPolicy(
  policy: ConnectionAccountManagedPolicy,
  shared: SignInGroupPolicy,
): ConnectionAccountManagedPolicy {
  const own = Object.entries(policy)
    .filter(([field]) => POLICY_FIELDS[field as keyof typeof POLICY_FIELDS] !== 'shared');
  return { ...Object.fromEntries(own), ...signInGroupPolicy(shared as ConnectionAccountManagedPolicy) } as
    ConnectionAccountManagedPolicy;
}

function sharedFields<T extends Record<string, 'shared' | 'row'>>(fields: T): Array<SharedFields<T>> {
  return Object.keys(fields).filter((field) => fields[field] === 'shared') as Array<SharedFields<T>>;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortedJson(left)) === JSON.stringify(sortedJson(right));
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, member]) => [key, sortedJson(member)]));
}
