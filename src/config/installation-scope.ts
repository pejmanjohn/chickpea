/**
 * Which installation a request or Durable Object serves.
 *
 * A standalone deployment is one installation and keeps every object name it
 * has today. A deployment that declares `CHICKPEA_TENANCY=installation` serves
 * many: each request reaches Core with an env scoped to one installation, and
 * every object an installation owns is named under it, so two installations
 * never share a state store, thread runner, Agent transcript or Sandbox. An
 * unscoped env there fails closed instead of falling back to the standalone
 * names.
 *
 * The scope rides in an immutable copy of the platform env under a
 * module-private symbol: only this module can create it, and no request
 * payload or deployment variable can impersonate it. Durable Objects recover
 * it from their own name, which the host chose when it addressed them.
 */

export const TENANCY_VARIABLE = 'CHICKPEA_TENANCY';

/**
 * Version of the object naming rule. Changing the rule addresses different
 * objects, so it is a visible version bump with a migration, never a silent
 * switch to empty replacements.
 */
export const INSTALLATION_OBJECT_NAME_VERSION = 'i1';

export type DeploymentTenancy = 'standalone' | 'installation';

export interface InstallationScope {
  readonly installationId: string;
}

/** Nonsecret ownership persisted with the work an installation admits; versioned, unlike the in-memory scope. */
export interface InstallationOwnership {
  readonly version: 1;
  readonly installationId: string;
}

export type InstallationContextErrorCode =
  | 'installation_context_missing'
  | 'installation_context_mismatch'
  | 'installation_context_invalid';

export class InstallationContextError extends Error {
  readonly code: InstallationContextErrorCode;

  constructor(code: InstallationContextErrorCode, message: string) {
    super(message);
    this.name = 'InstallationContextError';
    this.code = code;
  }
}

type Env = Record<string, unknown>;

const INSTALLATION_SCOPE = Symbol('chickpea.installation-scope');
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const NAME_SEPARATOR = '~';
const NAME_PREFIX = `${INSTALLATION_OBJECT_NAME_VERSION}${NAME_SEPARATOR}`;

export function deploymentTenancy(env: Env | undefined): DeploymentTenancy {
  const declared = env?.[TENANCY_VARIABLE];
  if (declared === undefined || declared === '' || declared === 'standalone') return 'standalone';
  if (declared === 'installation') return 'installation';
  throw new InstallationContextError(
    'installation_context_invalid',
    `${TENANCY_VARIABLE} must be "standalone", "installation" or unset.`,
  );
}

/** An env that serves exactly one installation. The input is never changed. */
export function scopeInstallationEnv<E extends Env>(env: E, scope: InstallationScope): E {
  if (deploymentTenancy(env) !== 'installation') {
    throw new InstallationContextError(
      'installation_context_invalid',
      'Only a deployment with installation tenancy scopes its env.',
    );
  }
  const installationId = validInstallationIdentityId(scope.installationId, 'installation');
  const current = installationScopeOf(env);
  if (current) {
    if (current.installationId === installationId) return env;
    throw new InstallationContextError(
      'installation_context_mismatch',
      'The env is already scoped to another installation.',
    );
  }
  return Object.freeze({
    ...env,
    [INSTALLATION_SCOPE]: Object.freeze({ installationId }),
  });
}

export function installationScopeOf(env: Env | undefined): InstallationScope | undefined {
  return (env as { [INSTALLATION_SCOPE]?: InstallationScope } | undefined)?.[INSTALLATION_SCOPE];
}

/** Key of a process-wide cache entry holding one installation's data. */
export function installationCacheKey(env: Env | undefined): string {
  return installationScopeOf(env)?.installationId ?? '';
}

/** Standalone: undefined. Installation tenancy: the scope, or a refusal. */
export function requireInstallationScope(env: Env | undefined): InstallationScope | undefined {
  if (deploymentTenancy(env) === 'standalone') return undefined;
  const scope = installationScopeOf(env);
  if (!scope) {
    throw new InstallationContextError(
      'installation_context_missing',
      'This deployment serves many installations and the request has none.',
    );
  }
  return scope;
}

/** The name of an installation's object whose standalone name is `name`. */
export function installationObjectName(env: Env | undefined, name: string): string {
  const scope = requireInstallationScope(env);
  return scope ? scopedObjectName(scope, name) : name;
}

export function scopedObjectName(scope: InstallationScope, name: string): string {
  if (!name) throw new InstallationContextError('installation_context_invalid', 'Object names are non-empty.');
  return `${NAME_PREFIX}${validInstallationIdentityId(scope.installationId, 'installation')}${NAME_SEPARATOR}${name}`;
}

/** An object name's installation, if it was scoped to one, and its standalone name. */
export function splitInstallationObjectName(name: string): { scope?: InstallationScope; name: string } {
  if (name.startsWith(NAME_PREFIX)) {
    const end = name.indexOf(NAME_SEPARATOR, NAME_PREFIX.length);
    const installationId = end < 0 ? '' : name.slice(NAME_PREFIX.length, end);
    const standaloneName = end < 0 ? '' : name.slice(end + 1);
    if (ID_PATTERN.test(installationId) && standaloneName) {
      return { scope: { installationId }, name: standaloneName };
    }
  }
  return { name };
}

/** The installation an object name was scoped to, if it was. */
export function installationScopeOfObjectName(name: string | undefined): InstallationScope | undefined {
  return name === undefined ? undefined : splitInstallationObjectName(name).scope;
}

/** What a Durable Object constructor knows about its own address. */
export interface ObjectContext {
  readonly id: { readonly name?: string };
}

/**
 * The env a Durable Object constructor hands its base class. Standalone: the
 * platform env, unchanged, and an object named under an installation refuses
 * to run rather than serve the standalone stores. Installation tenancy:
 * scoped to the installation the object's name carries; an object without
 * one keeps an unscoped env, so every store it touches fails closed.
 */
export function objectInstallationEnv<E>(ctx: ObjectContext, env: E): E {
  const platformEnv = env as Env | undefined;
  const scope = installationScopeOfObjectName(ctx.id.name);
  if (!platformEnv || deploymentTenancy(platformEnv) === 'standalone') {
    if (scope) {
      throw new InstallationContextError(
        'installation_context_mismatch',
        'A standalone deployment serves no installation\'s objects.',
      );
    }
    return env;
  }
  return scope ? scopeInstallationEnv(platformEnv, scope) as E : env;
}

/** The ownership work admitted through this env records: none on standalone. */
export function installationOwnershipOf(env: Env | undefined): InstallationOwnership | undefined {
  const scope = requireInstallationScope(env);
  return scope ? Object.freeze({ version: 1, installationId: scope.installationId }) : undefined;
}

export function parseInstallationOwnership(value: unknown): InstallationOwnership {
  const record = value as Partial<Record<keyof InstallationOwnership, unknown>> | null;
  if (typeof record !== 'object' || record === null || record.version !== 1 ||
      Object.keys(record).some((key) => key !== 'version' && key !== 'installationId')) {
    throw new InstallationContextError('installation_context_invalid', 'Installation ownership is malformed.');
  }
  return Object.freeze({ version: 1, installationId: validInstallationIdentityId(record.installationId, 'installation') });
}

/**
 * Persisted ownership agrees with the env that is about to act on it: absent
 * on standalone, and naming this env's installation under installation
 * tenancy.
 */
export function assertInstallationOwnership(
  ownership: InstallationOwnership | undefined,
  env: Env | undefined,
): void {
  const scope = requireInstallationScope(env);
  if (!scope && !ownership) return;
  if (!scope || !ownership || ownership.installationId !== scope.installationId) {
    throw new InstallationContextError(
      'installation_context_mismatch',
      'The work belongs to another installation.',
    );
  }
}

/** An organization or installation ID a host assigned: short, and safe inside object names. */
export function validInstallationIdentityId(value: unknown, kind: 'organization' | 'installation'): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new InstallationContextError('installation_context_invalid', `The ${kind} ID is malformed.`);
  }
  return value;
}
