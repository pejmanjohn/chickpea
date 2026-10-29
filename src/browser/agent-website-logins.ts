import { AuthorizationError, canManageOwnedResource, requireAgentEdit } from '../auth/permissions.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import { AgentRevisionConflictError } from '../config/errors.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConfigStore } from '../config/store.ts';
import type { CustomAgentConfig, WebsiteLoginGrant } from '../config/types.ts';
import { deleteWebsiteLogin, listWebsiteLogins, type WebsiteLogin, type WebsiteLoginDependencies } from './logins.ts';

/** The only website-login shape Admin and management return. Never a password or TOTP seed. */
export interface WebsiteLoginView {
  loginId: string;
  host: string;
  label: string;
  ownerKind: WebsiteLogin['ownerKind'];
  ownerMembershipId?: string;
  method: WebsiteLogin['method'];
  username?: string;
  lastUsedAt?: number;
  level: WebsiteLoginGrant['level'];
  enabled: boolean;
}

export function websiteLoginView(login: WebsiteLogin, grant: WebsiteLoginGrant): WebsiteLoginView {
  return {
    loginId: login.id,
    host: login.host,
    label: login.label,
    ownerKind: login.ownerKind,
    ...(login.ownerMembershipId ? { ownerMembershipId: login.ownerMembershipId } : {}),
    method: login.method,
    ...(login.username ? { username: login.username } : {}),
    ...(login.lastUsedAt !== undefined ? { lastUsedAt: login.lastUsedAt } : {}),
    level: grant.level,
    enabled: grant.enabled,
  };
}

/** An Agent's website logins as one person sees them: another member's personal login stays private. */
export function projectAgentWebsiteLogins(
  grants: readonly WebsiteLoginGrant[] | undefined,
  logins: readonly WebsiteLogin[],
  principal: AuthPrincipal,
): WebsiteLoginView[] {
  const byId = new Map(logins.map((login) => [login.id, login]));
  return (grants ?? []).flatMap((grant) => {
    const login = byId.get(grant.loginId);
    if (!login) return [];
    if (login.ownerKind === 'member' && !canManageOwnedResource(principal, login)) return [];
    return [websiteLoginView(login, grant)];
  });
}

type AgentWebsiteLoginStore = Pick<ConfigStore, 'getAgent' | 'updateAgent'>;

/** Apply a grant-list change through the ordinary Agent update path. */
export async function updateAgentWebsiteLogins(
  config: AgentWebsiteLoginStore,
  agentId: string,
  change: (grants: WebsiteLoginGrant[]) => WebsiteLoginGrant[] | undefined,
): Promise<CustomAgentConfig | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await config.getAgent(agentId);
    const next = change([...(current.websiteLogins ?? [])]);
    if (!next) return current;
    try {
      return await config.updateAgent(agentId, { websiteLogins: next }, current.revision);
    } catch (error) {
      if (!(error instanceof AgentRevisionConflictError) || attempt === 2) throw error;
    }
  }
  return undefined;
}

export class WebsiteLoginGrantNotFoundError extends Error {
  readonly name = 'WebsiteLoginGrantNotFoundError';
  constructor() {
    super('The website login is not granted to this Agent.');
  }
}

export class WebsiteLoginsUnavailableError extends Error {
  readonly name = 'WebsiteLoginsUnavailableError';
  constructor() {
    super('Website logins are unavailable.');
  }
}

/** The login an Agent's grant names, after the checks Admin's Remove makes. */
export async function removableAgentWebsiteLogin(input: {
  principal: AuthPrincipal;
  agent: CustomAgentConfig;
  loginId: string;
  logins: Parameters<typeof listWebsiteLogins>[0];
}): Promise<WebsiteLogin | undefined> {
  requireAgentEdit(input.principal, input.agent);
  if (!(input.agent.websiteLogins ?? []).some((grant) => grant.loginId === input.loginId)) {
    throw new WebsiteLoginGrantNotFoundError();
  }
  const login = (await listWebsiteLogins(input.logins)).find((candidate) => candidate.id === input.loginId);
  // A grant whose login is already gone is removable by any editor.
  if (login && !canManageOwnedResource(input.principal, login)) throw new AuthorizationError();
  return login;
}

type WebsiteLoginDeletion = () => Pick<WebsiteLoginDependencies, 'store' | 'browserProvider'> | undefined;

/**
 * Admin's Remove: drop the Agent's grant, then delete the login and its
 * secret once no Agent is granted it.
 */
export async function removeAgentWebsiteLogin(input: {
  principal: AuthPrincipal;
  agentId: string;
  loginId: string;
  config: AgentWebsiteLoginStore & Pick<ConfigStore, 'listAgents'>;
  logins: Parameters<typeof listWebsiteLogins>[0];
  deletion: WebsiteLoginDeletion;
}): Promise<{ loginDeleted: boolean }> {
  const login = await removableAgentWebsiteLogin({
    principal: input.principal,
    agent: await input.config.getAgent(input.agentId),
    loginId: input.loginId,
    logins: input.logins,
  });
  await updateAgentWebsiteLogins(input.config, input.agentId, (grants) => {
    const next = grants.filter((grant) => grant.loginId !== input.loginId);
    return next.length === grants.length ? undefined : next;
  });
  if (!login) return { loginDeleted: false };
  if ((await grantedLoginIds(input.config)).has(input.loginId)) return { loginDeleted: false };
  const deps = input.deletion();
  if (!deps) throw new WebsiteLoginsUnavailableError();
  return { loginDeleted: await deleteWebsiteLogin(deps, input.loginId) };
}

export class WebsiteLoginNotRemovableError extends Error {
  readonly name = 'WebsiteLoginNotRemovableError';
  constructor() {
    super('This Agent uses a website login you can\'t remove. Ask its owner or an Admin to remove it first.');
  }
}

/**
 * The logins deleting this Agent would delete: those it is granted that no
 * other Agent, archived ones included, holds. Throws before anything changes
 * when the principal could not Remove one of them, so deleting an Agent never
 * reaches further than Remove does.
 */
export async function agentDeletionWebsiteLogins(input: {
  principal: AuthPrincipal;
  agent: Pick<CustomAgentConfig, 'id' | 'websiteLogins'>;
  config: Pick<ConfigStore, 'listAgents'>;
  logins: Parameters<typeof listWebsiteLogins>[0];
}): Promise<string[]> {
  const granted = new Set((input.agent.websiteLogins ?? []).map(({ loginId }) => loginId));
  if (!granted.size) return [];
  const held = await grantedLoginIds(input.config, input.agent.id);
  const removed = (await listWebsiteLogins(input.logins))
    .filter((login) => granted.has(login.id) && !held.has(login.id));
  if (removed.some((login) => !canManageOwnedResource(input.principal, login))) {
    throw new WebsiteLoginNotRemovableError();
  }
  return removed.map(({ id }) => id);
}

/**
 * Durable inventory of the logins an Agent's deletion removes, staged beside
 * the Agent's secret cleanup before the Agent is deleted, so a retry after a
 * partial failure, or after a delete whose response was lost, finishes them.
 * The marker holds login ids only.
 */
function websiteLoginCleanupMarkerKey(agentId: string, scope: string): string {
  if (!/^v1:[A-Za-z0-9_-]{43}$/.test(scope)) throw new Error('Invalid website login cleanup scope');
  return `website-login-cleanup.${agentId}.${scope.slice(3)}`;
}

export async function stageDeletedAgentWebsiteLogins(
  agentId: string,
  loginIds: readonly string[],
  settings: SettingsStore,
  scope: string,
): Promise<void> {
  if (loginIds.length) await settings.mergeSettingStringSet(websiteLoginCleanupMarkerKey(agentId, scope), loginIds);
}

export interface DeletedAgentWebsiteLogins {
  config: Pick<ConfigStore, 'listAgents'>;
  deletion: WebsiteLoginDeletion;
}

/**
 * Delete the logins `stageDeletedAgentWebsiteLogins` recorded, except one an
 * Agent was granted meanwhile. The marker goes last, so a store failure keeps
 * the inventory for the retry; a provider failure is the deletion queue's to
 * finish. True when a marker was found.
 */
export async function finishDeletedAgentWebsiteLogins(
  agentId: string,
  settings: SettingsStore,
  scope: string,
  logins: DeletedAgentWebsiteLogins,
): Promise<boolean> {
  const markerKey = websiteLoginCleanupMarkerKey(agentId, scope);
  const raw = await settings.getSetting(markerKey);
  if (raw === undefined) return false;
  const loginIds = parseLoginIds(raw);
  if (loginIds.length) {
    const deps = logins.deletion();
    if (!deps) throw new WebsiteLoginsUnavailableError();
    const held = await grantedLoginIds(logins.config);
    for (const loginId of loginIds) {
      if (!held.has(loginId)) await deleteWebsiteLogin(deps, loginId);
    }
  }
  await settings.deleteSetting(markerKey);
  return true;
}

function parseLoginIds(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid website login cleanup marker');
  }
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string')) {
    throw new Error('Invalid website login cleanup marker');
  }
  return parsed;
}

/** Every login some Agent other than `exceptAgentId` is granted. */
async function grantedLoginIds(config: Pick<ConfigStore, 'listAgents'>, exceptAgentId?: string): Promise<Set<string>> {
  return new Set((await config.listAgents())
    .filter(({ id }) => id !== exceptAgentId)
    .flatMap((agent) => (agent.websiteLogins ?? []).map(({ loginId }) => loginId)));
}
