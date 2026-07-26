import { GOOGLE_WORKSPACE_SCOPES } from './api-oauth.ts';

const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_WRITE = 'https://www.googleapis.com/auth/gmail.modify';
const CALENDAR_READ = 'https://www.googleapis.com/auth/calendar.readonly';
const CALENDAR_WRITE = 'https://www.googleapis.com/auth/calendar.events';
const DRIVE_READ = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_WRITE = 'https://www.googleapis.com/auth/drive';

const SERVICE_SCOPES = [
  [GMAIL_READ, GMAIL_WRITE],
  [CALENDAR_READ, CALENDAR_WRITE],
  [DRIVE_READ, DRIVE_WRITE],
] as const;

export const GOOGLE_WORKSPACE_SCOPE_OPTIONS = {
  gmail: { read: GMAIL_READ, write: GMAIL_WRITE },
  calendar: { read: CALENDAR_READ, write: CALENDAR_WRITE },
  drive: { read: DRIVE_READ, write: DRIVE_WRITE },
} as const;

export type GoogleWorkspaceService = keyof typeof GOOGLE_WORKSPACE_SCOPE_OPTIONS;

export interface DerivedApiOAuthPolicy {
  allowedHosts: string[];
  pathPrefixes: string[];
  headerName: string;
  headerValuePrefix: string;
  allowedMethods: string[];
}

interface ApiOAuthPolicyCandidate {
  allowedHosts: string[];
  pathPrefixes: string[];
  headerName: string;
  headerValuePrefix?: string | undefined;
  allowedMethods: string[];
  authMode?: unknown;
  oauthProvider?: unknown;
  oauthScopes?: unknown;
}

export function googleWorkspaceApiPolicy(
  rawScopes: readonly string[],
): DerivedApiOAuthPolicy {
  const services = googleWorkspaceServicePolicies(rawScopes);
  return {
    allowedHosts: [...new Set(services.flatMap((service) => service.allowedHosts))],
    pathPrefixes: services.flatMap((service) => service.pathPrefixes),
    headerName: 'Authorization',
    headerValuePrefix: 'Bearer ',
    allowedMethods: [...new Set(services.flatMap((service) => service.allowedMethods))],
  };
}

/** Runtime scopes stay service-specific so Gmail write never widens Drive reads. */
export function googleWorkspaceServicePolicies(
  rawScopes: readonly string[],
): DerivedApiOAuthPolicy[] {
  const scopes = validatedScopeSelection(rawScopes);
  const readMethods = ['GET', 'HEAD'];
  const writeMethods = [...readMethods, 'POST', 'PUT', 'PATCH', 'DELETE'];
  const policies: DerivedApiOAuthPolicy[] = [];
  const gmail = selectedAccess(scopes, GMAIL_READ, GMAIL_WRITE);
  if (gmail) {
    policies.push({
      allowedHosts: ['gmail.googleapis.com'],
      pathPrefixes: ['/gmail/v1/users/me'],
      headerName: 'Authorization',
      headerValuePrefix: 'Bearer ',
      allowedMethods: gmail === 'write' ? writeMethods : readMethods,
    });
  }
  const calendar = selectedAccess(scopes, CALENDAR_READ, CALENDAR_WRITE);
  if (calendar) {
    policies.push({
      allowedHosts: ['www.googleapis.com'],
      pathPrefixes: ['/calendar/v3'],
      headerName: 'Authorization',
      headerValuePrefix: 'Bearer ',
      allowedMethods: calendar === 'write' ? writeMethods : readMethods,
    });
  }
  const drive = selectedAccess(scopes, DRIVE_READ, DRIVE_WRITE);
  if (drive) {
    policies.push({
      allowedHosts: ['www.googleapis.com'],
      pathPrefixes: drive === 'write' ? ['/drive/v3', '/upload/drive/v3'] : ['/drive/v3'],
      headerName: 'Authorization',
      headerValuePrefix: 'Bearer ',
      allowedMethods: drive === 'write' ? writeMethods : readMethods,
    });
  }
  return policies;
}

export function isValidApiOAuthConnectionPolicy(
  connection: ApiOAuthPolicyCandidate,
): boolean {
  if (
    connection.authMode !== 'oauth' ||
    connection.oauthProvider !== 'google' ||
    !Array.isArray(connection.oauthScopes) ||
    !connection.oauthScopes.every((scope) => typeof scope === 'string')
  ) {
    return false;
  }
  let expected: DerivedApiOAuthPolicy;
  try {
    expected = googleWorkspaceApiPolicy(connection.oauthScopes);
  } catch {
    return false;
  }
  return sameStringSet(connection.allowedHosts, expected.allowedHosts) &&
    sameStringSet(connection.pathPrefixes, expected.pathPrefixes) &&
    connection.headerName === expected.headerName &&
    connection.headerValuePrefix === expected.headerValuePrefix &&
    sameStringSet(connection.allowedMethods, expected.allowedMethods);
}

function validatedScopeSelection(rawScopes: readonly string[]): string[] {
  const allowed = new Set<string>(GOOGLE_WORKSPACE_SCOPES);
  const scopes = [...new Set(rawScopes)];
  if (scopes.length === 0 || scopes.some((scope) => !allowed.has(scope))) {
    throw new Error('Invalid Google Workspace scope selection');
  }
  for (const [read, write] of SERVICE_SCOPES) {
    if (scopes.includes(read) && scopes.includes(write)) {
      throw new Error('Choose read or write access once per Google service');
    }
  }
  return scopes;
}

function selectedAccess(
  scopes: readonly string[],
  readScope: string,
  writeScope: string,
): 'read' | 'write' | undefined {
  if (scopes.includes(writeScope)) return 'write';
  if (scopes.includes(readScope)) return 'read';
  return undefined;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((value) => right.includes(value));
}
