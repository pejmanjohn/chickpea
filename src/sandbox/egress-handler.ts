import {
  GITHUB_OWNER_PATTERN,
  isValidRepositoryFullName,
} from '../config/github-app.ts';
import { SANDBOX_PACKAGE_REGISTRY_HOSTS } from '../config/sandbox-settings.ts';
import type { RepositoryGrant } from '../config/types.ts';

export const REPOSITORY_METHODS = ['GET', 'POST', 'PATCH', 'PUT'] as const;

export const REPOSITORY_PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  issues: 'write',
  metadata: 'read',
  actions: 'write',
} as const;

const PACKAGE_REGISTRY_METHODS = new Set(['GET', 'HEAD', 'POST']);
const REPOSITORY_METHOD_SET = new Set<string>(REPOSITORY_METHODS);
const PACKAGE_REGISTRY_HOST_SET = new Set<string>(SANDBOX_PACKAGE_REGISTRY_HOSTS);

export type SandboxEgressDecision =
  | {
      allowed: true;
      kind: 'github' | 'package-registry';
      repositories: string[];
    }
  | {
      allowed: false;
      reason:
        | 'invalid-url'
        | 'plaintext-url'
        | 'url-credentials'
        | 'host-denied'
        | 'method-denied'
        | 'repository-required'
        | 'repository-denied'
        | 'endpoint-denied'
        | 'code-search-denied';
      repositories: string[];
    };

export interface SandboxEgressInput {
  url: string;
  method: string;
  grants: readonly RepositoryGrant[];
  allowedHosts: readonly string[];
}

const DENIED_REPOSITORY_ENDPOINTS = [
  /^\/repos\/[^/]+\/[^/]+\/dispatches$/, // repository_dispatch
  /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\/dispatches$/, // workflow_dispatch
  /^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/[^/]+\/(?:enable|disable)$/,
  /^\/repos\/[^/]+\/[^/]+\/actions\/runs\/[^/]+\/(?:approve|pending_deployments|deployment_protection_rule)$/,
];

export function validEnabledRepositoryGrants(
  grants: readonly RepositoryGrant[] | undefined,
): RepositoryGrant[] {
  return (grants ?? []).filter(
    (grant) =>
      grant.enabled &&
      GITHUB_OWNER_PATTERN.test(grant.accountLogin) &&
      (grant.allRepos === true
        ? grant.fullName === ''
        : isValidRepositoryFullName(grant.fullName)),
  );
}

export function repositoryGrantMatches(
  grant: RepositoryGrant,
  repository: string,
): boolean {
  if (!isValidRepositoryFullName(repository)) return false;
  if (grant.allRepos === true) {
    const slash = repository.indexOf('/');
    return repository.slice(0, slash).toLowerCase() === grant.accountLogin.toLowerCase();
  }
  return repository.toLowerCase() === grant.fullName.toLowerCase();
}

export function isDeniedRepositoryEndpoint(url: string): boolean {
  let pathname: string;
  try {
    // GitHub routes decoded path segments. Evaluate the same representation so
    // `%64ispatches` cannot bypass a deny rule that catches `dispatches`.
    pathname = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '');
  } catch {
    return true;
  }
  return DENIED_REPOSITORY_ENDPOINTS.some((pattern) => pattern.test(pathname));
}

export function matchesGrantedCodeSearch(
  url: string,
  grants: readonly RepositoryGrant[],
): boolean {
  return grantedCodeSearchRepositories(url, grants) !== undefined;
}

export function resolveRepositoryInstallationScope(
  grants: readonly RepositoryGrant[],
  repositories: readonly string[],
): { id: number; repositories?: string[] } | undefined {
  const enabled = validEnabledRepositoryGrants(grants);
  const installationIds = new Set<number>();
  const repositoryNames: string[] = [];
  let installationWide = false;
  for (const repository of repositories) {
    const grant =
      enabled.find(
        (candidate) =>
          candidate.allRepos === true &&
          candidate.installationId !== null &&
          repositoryGrantMatches(candidate, repository),
      ) ??
      enabled.find(
        (candidate) =>
          candidate.allRepos !== true &&
          candidate.installationId !== null &&
          repositoryGrantMatches(candidate, repository),
      );
    if (!grant || grant.installationId === null) return undefined;
    installationIds.add(grant.installationId);
    if (grant.allRepos === true) installationWide = true;
    repositoryNames.push(repository.slice(repository.indexOf('/') + 1));
  }
  const [id] = installationIds;
  if (id === undefined || installationIds.size !== 1) return undefined;
  return installationWide
    ? { id }
    : { id, repositories: [...new Set(repositoryNames)].sort() };
}

export function decideSandboxEgress(input: SandboxEgressInput): SandboxEgressDecision {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return denied('invalid-url');
  }
  if (url.protocol !== 'https:') return denied('plaintext-url');
  if (url.username !== '' || url.password !== '') return denied('url-credentials');
  if (url.port !== '') return denied('host-denied');

  const host = url.hostname.toLowerCase();
  const method = input.method.toUpperCase();
  if (host !== 'github.com' && host !== 'api.github.com') {
    const allowedHosts = new Set(input.allowedHosts.map((value) => value.toLowerCase()));
    if (!PACKAGE_REGISTRY_HOST_SET.has(host) || !allowedHosts.has(host)) {
      return denied('host-denied');
    }
    if (!PACKAGE_REGISTRY_METHODS.has(method)) return denied('method-denied');
    return { allowed: true, kind: 'package-registry', repositories: [] };
  }

  if (!REPOSITORY_METHOD_SET.has(method)) return denied('method-denied');
  const grants = validEnabledRepositoryGrants(input.grants);
  if (host === 'github.com') {
    const repository = githubRepositoryFromPath(url.pathname);
    if (!repository) return denied('repository-required');
    const canonical = canonicalGrantedRepository(repository, grants);
    return canonical
      ? { allowed: true, kind: 'github', repositories: [canonical] }
      : denied('repository-denied', [repository]);
  }

  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname === '/search/code') {
    const repositories = grantedCodeSearchRepositories(url.toString(), grants);
    if (repositories === undefined) return denied('code-search-denied');
    return {
      allowed: true,
      kind: 'github',
      repositories: repositories.map(
        (repository) => canonicalGrantedRepository(repository, grants) ?? repository,
      ),
    };
  }

  const repository = apiRepositoryFromPath(url.pathname);
  if (!repository) return denied('repository-required');
  if (isDeniedRepositoryEndpoint(url.toString())) {
    return denied('endpoint-denied', [repository]);
  }
  const canonical = canonicalGrantedRepository(repository, grants);
  if (!canonical) return denied('repository-denied', [repository]);
  if (isDeniedCrossRepositoryCompare(url, canonical, grants)) {
    return denied('endpoint-denied', [canonical]);
  }
  return { allowed: true, kind: 'github', repositories: [canonical] };
}

function denied(
  reason: Extract<SandboxEgressDecision, { allowed: false }>['reason'],
  repositories: string[] = [],
): SandboxEgressDecision {
  return { allowed: false, reason, repositories };
}

function canonicalGrantedRepository(
  repository: string,
  grants: readonly RepositoryGrant[],
): string | undefined {
  const exact = grants.find(
    (grant) =>
      grant.allRepos !== true &&
      grant.fullName.toLowerCase() === repository.toLowerCase(),
  );
  if (exact) return exact.fullName;
  return grants.some((grant) => repositoryGrantMatches(grant, repository))
    ? repository
    : undefined;
}

function isDeniedCrossRepositoryCompare(
  url: URL,
  repository: string,
  grants: readonly RepositoryGrant[],
): boolean {
  const segments = url.pathname.replace(/\/+$/, '').split('/');
  const rawEndpoint = segments[4];
  if (rawEndpoint === undefined) return false;

  let endpoint: string;
  try {
    endpoint = decodeURIComponent(rawEndpoint);
  } catch {
    return true;
  }
  if (endpoint !== 'compare') return false;

  // A compare basehead is exactly one path segment containing two refs
  // separated by `..` or `...`. Git refs cannot contain `..`, so any other
  // run of dots or number of separators is ambiguous and must fail closed.
  const rawBasehead = segments[5];
  if (segments.length !== 6 || rawBasehead === undefined) return true;
  let basehead: string;
  try {
    basehead = decodeURIComponent(rawBasehead);
  } catch {
    return true;
  }
  const separators = [...basehead.matchAll(/\.{2,}/g)];
  const separator = separators[0];
  if (
    separators.length !== 1 ||
    separator === undefined ||
    (separator[0] !== '..' && separator[0] !== '...')
  ) {
    return true;
  }
  const separatorIndex = separator.index;
  if (separatorIndex === undefined) return true;
  const refs = [
    basehead.slice(0, separatorIndex),
    basehead.slice(separatorIndex + separator[0].length),
  ];
  if (refs.some((ref) => ref.length === 0)) return true;

  const grantedOwner = grantedOwnerForRepository(repository, grants);
  if (!grantedOwner) return true;
  for (const ref of refs) {
    const colon = ref.indexOf(':');
    if (colon === -1) continue;
    if (colon === 0 || colon !== ref.lastIndexOf(':') || colon === ref.length - 1) {
      return true;
    }
    const repositoryPrefix = ref.slice(0, colon);
    const slash = repositoryPrefix.indexOf('/');
    const owner =
      slash === -1 ? repositoryPrefix : repositoryPrefix.slice(0, slash);
    if (
      (slash === -1
        ? !GITHUB_OWNER_PATTERN.test(repositoryPrefix)
        : !isValidRepositoryFullName(repositoryPrefix)) ||
      owner.toLowerCase() !== grantedOwner.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}

function grantedOwnerForRepository(
  repository: string,
  grants: readonly RepositoryGrant[],
): string | undefined {
  const exact = grants.find(
    (grant) =>
      grant.allRepos !== true &&
      grant.fullName.toLowerCase() === repository.toLowerCase(),
  );
  if (exact) return exact.fullName.slice(0, exact.fullName.indexOf('/'));
  return grants.find(
    (grant) => grant.allRepos === true && repositoryGrantMatches(grant, repository),
  )?.accountLogin;
}

function apiRepositoryFromPath(pathname: string): string | undefined {
  const segments = pathname.split('/');
  if (segments[1] !== 'repos') return undefined;
  return repositoryFromSegments(segments[2], segments[3]);
}

function githubRepositoryFromPath(pathname: string): string | undefined {
  const segments = pathname.split('/');
  const rawRepository = segments[2];
  const repository =
    rawRepository?.toLowerCase().endsWith('.git')
      ? rawRepository.slice(0, -'.git'.length)
      : rawRepository;
  return repositoryFromSegments(segments[1], repository);
}

function repositoryFromSegments(
  rawOwner: string | undefined,
  rawRepository: string | undefined,
): string | undefined {
  if (!rawOwner || !rawRepository) return undefined;
  let owner: string;
  let repository: string;
  try {
    owner = decodeURIComponent(rawOwner);
    repository = decodeURIComponent(rawRepository);
  } catch {
    return undefined;
  }
  const fullName = `${owner}/${repository}`;
  return isValidRepositoryFullName(fullName) ? fullName : undefined;
}

function codeSearchRepositories(url: string): string[] | undefined {
  let query: string;
  try {
    // Validate exactly what GitHub will evaluate: with duplicate q params,
    // `.get()` reads the first while GitHub may honor another.
    const values = new URL(url).searchParams.getAll('q');
    if (values.length !== 1 || values[0] === undefined) return undefined;
    query = values[0];
  } catch {
    return undefined;
  }
  const repositoryQualifierPattern = /(?:^|\s)repo:([^\s]+)/gi;
  const qualifiers = [...query.matchAll(repositoryQualifierPattern)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  );
  if (!qualifiers.every(isValidRepositoryFullName)) return undefined;

  // GitHub's search grammar can combine an allowed repo qualifier with a
  // wider branch (`OR org:Other`, parentheses, exclusions, etc.). Remove only
  // the repository qualifiers we understand, then reject every remaining
  // grammar construct that can change scope. Plain search terms are the sole
  // accepted remainder.
  const remainder = query.replace(repositoryQualifierPattern, ' ');
  if (
    /\w+:/.test(remainder) ||
    /[()]/.test(remainder) ||
    /\b(?:OR|AND|NOT)\b/i.test(remainder)
  ) {
    return undefined;
  }

  const repositories = qualifiers;
  return repositories.length > 0 ? [...new Set(repositories)] : undefined;
}

function grantedCodeSearchRepositories(
  url: string,
  grants: readonly RepositoryGrant[],
): string[] | undefined {
  const repositories = codeSearchRepositories(url);
  return repositories?.every((repository) =>
    grants.some((grant) => repositoryGrantMatches(grant, repository)),
  )
    ? repositories
    : undefined;
}
