import {
  AuthorizationError,
  canManageOwnedResource,
  canManageWebsiteLogin,
  requireAgentEdit,
} from '../auth/permissions.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import { AgentRevisionConflictError } from '../config/errors.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConfigStore } from '../config/store.ts';
import type { CustomAgentConfig, WebsiteLoginGrant } from '../config/types.ts';
import { deleteWebsiteLogin, listWebsiteLogins, type WebsiteLogin, type WebsiteLoginDependencies } from './logins.ts';

export const WEBSITE_LOGIN_ADMIN_ONLY = 'Only Owners and Admins can add website logins.';

/**
 * The only website-login shape Admin and management return. Never a password
 * or TOTP seed. Every login is the team's, whatever owner its record names.
 */
export interface WebsiteLoginView {
  loginId: string;
  host: string;
  label: string;
  ownerKind: 'team';
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
    ownerKind: 'team',
    method: login.method,
    ...(login.username ? { username: login.username } : {}),
    ...(login.lastUsedAt !== undefined ? { lastUsedAt: login.lastUsedAt } : {}),
    level: grant.level,
    enabled: grant.enabled,
  };
}

/** An Agent's website logins, the same for everyone who may see the Agent. */
export function projectAgentWebsiteLogins(
  grants: readonly WebsiteLoginGrant[] | undefined,
  logins: readonly WebsiteLogin[],
): WebsiteLoginView[] {
  const byId = new Map(logins.map((login) => [login.id, login]));
  return (grants ?? []).flatMap((grant) => {
    const login = byId.get(grant.loginId);
    return login ? [websiteLoginView(login, grant)] : [];
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
  if (login && !canManageWebsiteLogin(input.principal)) throw new AuthorizationError();
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
    super('This Agent uses a website login you can\'t remove. Ask an Owner or Admin to remove it first.');
  }
}

/** Whose authority an Agent deletion's logins were found under, and which they are. */
export interface AgentDeletionWebsiteLogins {
  by: Pick<AuthPrincipal, 'role' | 'membershipId'>;
  loginIds: string[];
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
}): Promise<AgentDeletionWebsiteLogins> {
  const by = { role: input.principal.role, membershipId: input.principal.membershipId };
  const granted = new Set((input.agent.websiteLogins ?? []).map(({ loginId }) => loginId));
  if (!granted.size) return { by, loginIds: [] };
  const held = await grantedLoginIds(input.config, input.agent.id);
  const removed = (await listWebsiteLogins(input.logins))
    .filter((login) => granted.has(login.id) && !held.has(login.id));
  if (removed.length && !canManageWebsiteLogin(input.principal)) throw new WebsiteLoginNotRemovableError();
  return { by, loginIds: removed.map(({ id }) => id) };
}

/**
 * Durable inventory of the logins one attempt to delete an Agent removes,
 * written beside the Agent's secret cleanup before the Agent is deleted, so a
 * retry after a partial failure, or after a delete whose response was lost,
 * finishes them. It holds login ids and the deleting principal's authority,
 * never a secret. Each attempt replaces the last one's, and an attempt that
 * leaves the Agent in place clears it.
 */
function websiteLoginCleanupMarkerKey(agentId: string, scope: string): string {
  if (!/^v1:[A-Za-z0-9_-]{43}$/.test(scope)) throw new Error('Invalid website login cleanup scope');
  return `website-login-cleanup.${agentId}.${scope.slice(3)}`;
}

export async function stageDeletedAgentWebsiteLogins(
  agentId: string,
  logins: AgentDeletionWebsiteLogins,
  settings: SettingsStore,
  scope: string,
): Promise<void> {
  const markerKey = websiteLoginCleanupMarkerKey(agentId, scope);
  if (!logins.loginIds.length) await settings.deleteSetting(markerKey);
  else await settings.setSetting(markerKey, JSON.stringify(logins));
}

export async function clearDeletedAgentWebsiteLogins(
  agentId: string,
  settings: SettingsStore,
  scope: string,
): Promise<void> {
  await settings.deleteSetting(websiteLoginCleanupMarkerKey(agentId, scope));
}

export interface DeletedAgentWebsiteLogins {
  /** Who finishes the cleanup: the deleting principal, or whoever retries it. */
  principal: AuthPrincipal;
  config: Pick<ConfigStore, 'listAgents'>;
  deletion: WebsiteLoginDeletion;
}

/**
 * Delete the logins `stageDeletedAgentWebsiteLogins` recorded. Each is checked
 * again first: one an Agent was granted meanwhile stays, and so does one the
 * principal who staged it, or the one finishing it, could not Remove itself.
 * A recorded login whose catalog entry is already gone loses only a leftover
 * secret. The marker goes last, so a store failure keeps the inventory for
 * the retry; a provider failure is the deletion queue's to finish. A login
 * kept back only because the one finishing could not Remove it stays in the
 * marker for a retry by someone who can. True when a marker was found.
 *
 * These checks keep the owner rule logins had before they became team-only.
 * Staging now refuses a member any login, so a marker naming one under a
 * member's authority was staged before that change, for their own personal
 * login on an Agent already deleted. The owner rule lets their retry finish
 * it; the team rule would drop it from the marker, leaving the login and its
 * secret on no Agent, where nothing lists or removes them.
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
  const staged = parseStagedLogins(raw);
  const deferred: string[] = [];
  if (staged?.loginIds.length) {
    const deps = logins.deletion();
    if (!deps) throw new WebsiteLoginsUnavailableError();
    const held = await grantedLoginIds(logins.config);
    const catalog = new Map((await listWebsiteLogins(deps.store)).map((login) => [login.id, login]));
    for (const loginId of staged.loginIds) {
      const login = catalog.get(loginId);
      if (login && (held.has(loginId) || !canManageOwnedResource(staged.by, login))) continue;
      if (login && !canManageOwnedResource(logins.principal, login)) {
        deferred.push(loginId);
        continue;
      }
      await deleteWebsiteLogin(deps, loginId);
    }
  }
  if (staged && deferred.length) await settings.setSetting(markerKey, JSON.stringify({ ...staged, loginIds: deferred }));
  else await settings.deleteSetting(markerKey);
  return true;
}

/** A marker that does not parse deletes nothing. */
function parseStagedLogins(raw: string): AgentDeletionWebsiteLogins | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const { by, loginIds } = parsed as Record<string, unknown>;
  if (!by || typeof by !== 'object') return undefined;
  const { role, membershipId } = by as Record<string, unknown>;
  if ((role !== 'owner' && role !== 'admin' && role !== 'member') || typeof membershipId !== 'string' ||
      !Array.isArray(loginIds) || !loginIds.every((id) => typeof id === 'string')) {
    return undefined;
  }
  return { by: { role, membershipId }, loginIds };
}

/** Every login some Agent other than `exceptAgentId` is granted. */
async function grantedLoginIds(config: Pick<ConfigStore, 'listAgents'>, exceptAgentId?: string): Promise<Set<string>> {
  return new Set((await config.listAgents())
    .filter(({ id }) => id !== exceptAgentId)
    .flatMap((agent) => (agent.websiteLogins ?? []).map(({ loginId }) => loginId)));
}
