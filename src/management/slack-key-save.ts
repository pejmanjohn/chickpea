import type { AuthPrincipal } from '../auth/types.ts';
import type { AppStores, PlatformEnv } from '../config/state-backend.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../connections/catalog/index.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { SavedKeyCheck } from './setup-wake.ts';
import {
  completeFormAction,
  completeSetupWithReceipt,
  requireCurrentLegacySetupAuthority,
  safeFailureCode,
  SetupKeyRejectedError,
  type ManagementSetupRoutesOptions,
  type SetupDependencies,
} from './setup-routes.ts';
import type { ManagementSetupRecord } from './types.ts';

export type SlackFormKeyOutcome =
  | { kind: 'saved'; check: SavedKeyCheck }
  | { kind: 'rejected'; host: string }
  | { kind: 'target_changed' }
  | { kind: 'expired' }
  | { kind: 'access_lost' }
  | { kind: 'not_saved' };

export async function saveSlackFormKey(input: {
  setupOperationId: string;
  slackUserId: string;
  key: string;
  stores: Pick<AppStores, 'management' | 'config' | 'settings' | 'identity' | 'usage'>;
  platformEnv?: PlatformEnv;
  options?: Pick<ManagementSetupRoutesOptions, 'connectionCheck' | 'discoverMcp' | 'identifyMcp'>;
  now?: () => number;
}): Promise<SlackFormKeyOutcome> {
  const now = input.now ?? Date.now;
  const dependencies: SetupDependencies = {
    ...input.stores,
    catalog: MANAGED_CONNECTOR_CATALOG,
    ...(input.platformEnv ? { platformEnv: input.platformEnv } : {}),
  };
  const setup = await dependencies.management.getSetup(input.setupOperationId, now());
  const field = setup?.target.formFields?.[0];
  if (!setup || setup.status !== 'pending' || setup.target.form !== 'slack' || !field ||
      (setup.action !== 'api_credential' && setup.action !== 'mcp_credentials')) {
    return { kind: 'expired' };
  }
  const principal = await slackSetupPrincipal(input.stores.identity, setup, input.slackUserId);
  if (!principal) return { kind: 'access_lost' };
  try {
    await requireCurrentLegacySetupAuthority(principal, setup, dependencies);
  } catch {
    return { kind: 'access_lost' };
  }
  let result: Awaited<ReturnType<typeof completeFormAction>>;
  try {
    result = await completeFormAction(setup, { [field]: input.key }, dependencies, input.options ?? {}, now());
  } catch (error) {
    if (error instanceof SetupKeyRejectedError) return { kind: 'rejected', host: error.host };
    return safeFailureCode(error) === 'target_changed' ? { kind: 'target_changed' } : { kind: 'not_saved' };
  }
  await completeSetupWithReceipt(setup, { ...result, via: 'slack_form' }, {
    slackForm: { userId: principal.userId, membershipId: principal.membershipId },
  }, dependencies, now())
    .catch(() => {
      console.warn('[chickpea] Slack key form saved a key but could not complete its setup');
    });
  return { kind: 'saved', check: setup.action === 'mcp_credentials' ? 'ok' : result.check ?? 'ok' };
}

async function slackSetupPrincipal(
  identity: Pick<IdentityStore, 'resolveSlackIdentity' | 'getMembershipAccessOverlay'>,
  setup: ManagementSetupRecord,
  slackUserId: string,
): Promise<AuthPrincipal | undefined> {
  if (setup.origin.kind !== 'slack') return undefined;
  const { workspaceId } = setup.origin;
  const resolution = await identity.resolveSlackIdentity(workspaceId, slackUserId).catch(() => undefined);
  const membership = resolution?.membership;
  if (!resolution || !membership || membership.status !== 'active' ||
      resolution.binding.slackTeamId !== workspaceId || resolution.binding.slackUserId !== slackUserId ||
      resolution.user.id !== setup.actorUserId || membership.id !== setup.actorMembershipId ||
      membership.organizationId !== setup.organizationId) return undefined;
  const overlay = await identity.getMembershipAccessOverlay(membership.id).catch(() => undefined);
  if (overlay && (overlay.organizationId !== setup.organizationId || overlay.accessStatus !== 'active')) {
    return undefined;
  }
  return {
    userId: resolution.user.id,
    membershipId: membership.id,
    organizationId: membership.organizationId,
    role: membership.role,
    authenticatorKind: 'slack',
    credentialId: `slack:${membership.id}`,
    correlationId: `slack:${workspaceId}:${slackUserId}`,
    machine: false,
  };
}
