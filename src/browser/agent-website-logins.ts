import { AuthorizationError, canManageOwnedResource, requireAgentEdit } from '../auth/permissions.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import { AgentRevisionConflictError } from '../config/errors.ts';
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

/**
 * After an Agent is deleted, the same rule as Remove for each login it was
 * granted: delete the ones no remaining Agent holds, which nothing else can
 * reach. Never throws, since the Agent is gone either way: a failure is
 * logged without content, and a login that went is the queue's to finish.
 */
export async function removeDeletedAgentWebsiteLogins(input: {
  grants: readonly WebsiteLoginGrant[] | undefined;
  config: Pick<ConfigStore, 'listAgents'>;
  deletion: WebsiteLoginDeletion;
}): Promise<void> {
  if (!input.grants?.length) return;
  try {
    const deps = input.deletion();
    if (!deps) return;
    const held = await grantedLoginIds(input.config);
    for (const { loginId } of input.grants) {
      if (held.has(loginId)) continue;
      await deleteWebsiteLogin(deps, loginId).catch(() => {
        console.warn('[chickpea] A deleted Agent\'s website login could not be removed');
      });
    }
  } catch {
    console.warn('[chickpea] A deleted Agent\'s website logins could not be removed');
  }
}

/** Every login some Agent is granted. */
async function grantedLoginIds(config: Pick<ConfigStore, 'listAgents'>): Promise<Set<string>> {
  return new Set((await config.listAgents()).flatMap((agent) => (agent.websiteLogins ?? []).map(({ loginId }) => loginId)));
}
