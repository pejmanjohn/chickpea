import { isValidApiOAuthConnectionPolicy } from './api-oauth-policy.ts';
import { getGithubConnection, isGithubAppManagedHost, mintableInstallation } from './github-app.ts';
import { deploymentServesManyInstallations } from './installation-scope.ts';
import { validateMcpUrl } from './mcp-url.ts';
import type { SettingsStore } from './settings-store.ts';
import type { PlatformEnv } from './state-backend.ts';
import type { RepositoryGrant } from './types.ts';

/**
 * The Agent write rules Admin and workspace management both enforce. Each
 * check returns what is wrong in words a person can act on, or undefined.
 */

/**
 * Every connection id an Agent write may name, on both doors: a provider id
 * for a connection account, or the id of a legacy Agent-row connection.
 */
export const CONNECTION_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Flue's `defineSkill` name rule, so a stored skill never fails a turn. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
/** Path-only: a query or fragment would widen credential injection to the whole path. */
const PATH_PREFIX_PATTERN = /^\/[^\s?#]*$/;
const API_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const GITHUB_API_CONNECTION_ERROR =
  'GitHub is managed by the GitHub App integration; connect it in Settings → GitHub';
export const REVIEWED_CONNECTOR_SETUP_MESSAGE =
  'Add this connector from the Agent’s Connections tab so you can review its tool access.';
export const OVERLAPPING_CONNECTIONS_ERROR =
  'enabled connections must not cover overlapping URLs; narrow their hosts or path prefixes so each connection governs a distinct URL space';

interface SkillRuleInput {
  name: string;
  description: string;
  instructions: string;
}

interface McpConnectionRuleInput {
  id: string;
  url: string;
  headerNames: string[];
  credentialHeaderName?: string | undefined;
}

interface ApiConnectionRuleInput {
  id: string;
  allowedHosts: string[];
  pathPrefixes: string[];
  headerName: string;
  headerValuePrefix?: string | undefined;
  allowedMethods: string[];
  enabled: boolean;
  authMode?: 'credential' | 'oauth' | undefined;
  oauthProvider?: 'google' | undefined;
  oauthScopes?: string[] | undefined;
  oauthAppType?: 'workspace-internal' | 'external' | undefined;
  identity?: object | undefined;
}

export function skillsWriteProblem(skills: readonly SkillRuleInput[]): string | undefined {
  for (const { name, description, instructions } of skills) {
    if (!SKILL_NAME_PATTERN.test(name) || name.length > SKILL_NAME_MAX_LENGTH) {
      return `Skill name ${name} must be lowercase letters, digits, and single hyphens, at most ${SKILL_NAME_MAX_LENGTH} characters.`;
    }
    if (!description.trim() || description.trim().length > SKILL_DESCRIPTION_MAX_LENGTH) {
      return `Skill ${name} needs a description of at most ${SKILL_DESCRIPTION_MAX_LENGTH} characters.`;
    }
    if (!instructions.trim()) return `Skill ${name} needs instructions.`;
  }
  return uniqueIds(skills.map(({ name }) => name)) ? undefined : 'skill names must be unique';
}

export function mcpConnectionsWriteProblem(connections: readonly McpConnectionRuleInput[]): string | undefined {
  for (const connection of connections) {
    if (!validateMcpUrl(connection.url).ok) return `The URL of connection ${connection.id} is not allowed.`;
    if (!connection.headerNames.every((name) => HEADER_NAME_PATTERN.test(name))) {
      return `Connection ${connection.id} has a header name that is not allowed.`;
    }
    const credentialHeader = connection.credentialHeaderName?.toLowerCase();
    if (credentialHeader !== undefined &&
        !connection.headerNames.some((name) => name.toLowerCase() === credentialHeader)) {
      return 'credential header must be declared in headerNames';
    }
  }
  return uniqueIds(connections.map(({ id }) => id)) ? undefined : 'connection ids must be unique';
}

export function apiConnectionsWriteProblem(connections: readonly ApiConnectionRuleInput[]): string | undefined {
  for (const connection of connections) {
    if (connection.allowedHosts.length === 0) return 'allowed hosts must not be empty';
    if (connection.allowedHosts.some(isGithubAppManagedHost)) return GITHUB_API_CONNECTION_ERROR;
    if (!connection.allowedHosts.every(isAllowedConnectorHost)) {
      return `Connection ${connection.id} has a host that is not allowed.`;
    }
    if (!connection.pathPrefixes.every((prefix) => PATH_PREFIX_PATTERN.test(prefix) && prefix.length <= 512)) {
      return `Connection ${connection.id} path prefixes must be paths without a query or fragment.`;
    }
    if (!HEADER_NAME_PATTERN.test(connection.headerName)) {
      return `Connection ${connection.id} has a header name that is not allowed.`;
    }
    if (connection.allowedMethods.length === 0 ||
        !connection.allowedMethods.every((method) => API_METHODS.has(method))) {
      return `Connection ${connection.id} methods must be GET, HEAD, POST, PUT, PATCH or DELETE.`;
    }
    const oauthPolicyValid = connection.authMode === 'oauth'
      ? isValidApiOAuthConnectionPolicy(connection) && connection.oauthAppType !== undefined
      : connection.oauthProvider === undefined && connection.oauthScopes === undefined &&
        connection.oauthAppType === undefined && connection.identity === undefined;
    if (!oauthPolicyValid) return 'OAuth connection policy is invalid';
  }
  if (!uniqueIds(connections.map(({ id }) => id))) return 'connection ids must be unique';
  return hasOverlappingConnections(connections) ? OVERLAPPING_CONNECTIONS_ERROR : undefined;
}

export function isAllowedConnectorHost(host: string): boolean {
  // Wildcards need a custom SecureFetch wrapper (documented follow-up).
  if (host.includes('*')) return false;
  const result = validateMcpUrl(`https://${host}`);
  if (!result.ok) return false;
  // `allowedHosts` stores hosts, not URLs. Keep the SSRF validation above as
  // the security boundary, then reject values that smuggle in URL components.
  const url = new URL(result.url);
  return url.hostname.toLowerCase() === host.toLowerCase() &&
    url.port === '' && url.pathname === '/' && url.search === '';
}

// just-bash applies EVERY allow-list transform whose prefix matches a request,
// so two connections that cover an overlapping URL space would inject both
// credentials into one request, leaking one connection's secret to the other's
// endpoint. Each connection must govern a distinct URL space.
type ConnectionScope = { allowedHosts: readonly string[]; pathPrefixes: readonly string[]; enabled: boolean };

export function hasOverlappingConnections(connections: readonly ConnectionScope[]): boolean {
  return connections.some((left, index) =>
    connections.slice(index + 1).some((right) => connectionsOverlap(left, right)));
}

/**
 * On a deployment that serves many installations, each repository grant takes
 * its installation from the workspace's own GitHub connection. A grant the
 * connection cannot mint stays only exactly as it was stored.
 */
export async function platformRepositoryGrants(
  settingsStore: SettingsStore,
  env: PlatformEnv | undefined,
  grants: RepositoryGrant[],
  stored: RepositoryGrant[] = [],
): Promise<RepositoryGrant[] | 'github_account_not_connected'> {
  if (!deploymentServesManyInstallations(env) || grants.length === 0) return grants;
  const connection = await getGithubConnection(settingsStore, env);
  const saved: RepositoryGrant[] = [];
  for (const grant of grants) {
    const installationId = mintableInstallation(connection, grant);
    if (installationId !== undefined) {
      saved.push({ ...grant, installationId });
      continue;
    }
    const prior = stored.find(({ id }) => id === grant.id);
    if (!prior || prior.accountLogin !== grant.accountLogin || prior.fullName !== grant.fullName ||
        (prior.allRepos === true) !== (grant.allRepos === true) || prior.installationId !== grant.installationId) {
      return 'github_account_not_connected';
    }
    saved.push({ ...prior, enabled: grant.enabled });
  }
  return saved;
}

function uniqueIds(ids: readonly string[]): boolean {
  return new Set(ids).size === ids.length;
}

// Two path prefixes overlap when they are equal or one is a segment-ancestor
// of the other (`/v1` and `/v1/tasks`, but not `/v1` and `/v10`). An empty
// list means the whole host, which overlaps every path.
function pathPrefixesOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return true;
  return left.some((rawLeft) => right.some((rawRight) => {
    const a = rawLeft.replace(/\/+$/, '');
    const b = rawRight.replace(/\/+$/, '');
    if (a === b) return true;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    return shorter === '' || longer.startsWith(shorter + '/');
  }));
}

function connectionsOverlap(left: ConnectionScope, right: ConnectionScope): boolean {
  if (!left.enabled || !right.enabled) return false;
  const rightHosts = new Set(right.allowedHosts.map((host) => host.toLowerCase()));
  return left.allowedHosts.some((host) => rightHosts.has(host.toLowerCase())) &&
    pathPrefixesOverlap(left.pathPrefixes, right.pathPrefixes);
}
