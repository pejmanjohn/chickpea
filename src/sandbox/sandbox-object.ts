import { createHash } from 'node:crypto';

import type { getSandbox } from '@cloudflare/sandbox';

import {
  deploymentTenancy,
  InstallationContextError,
  installationScopeOfObjectName,
  objectInstallationEnv,
  requireInstallationScope,
  scopeInstallationEnv,
  scopedObjectName,
  type ObjectContext,
} from '../config/installation-scope.ts';
import { getSlackStateStore } from '../config/state-backend.ts';
import type { SandboxTurnReader, TurnExecutionPorts } from '../slack/turn-executor.ts';
import type { InstallationWorkspaceObject } from '../state/object-inventory.ts';
import { CLOUDFLARE_SANDBOX_OPTIONS, cloudflareSandboxOptionVariants } from './lifecycle.ts';
import { reconnectingSandboxStub } from './reconnect.ts';

/**
 * Where a coding workspace's Sandbox Durable Object lives.
 *
 * Records (coding-worker bindings, rosters, coding-task records, the egress
 * turn) keep the standalone workspace ID. Only the address differs: a
 * standalone deployment addresses the Sandbox by the workspace ID itself, as
 * it always has, and a deployment serving many installations by a name that
 * carries the installation (installation-scope.ts). The workspace ID there
 * is hashed, because the Sandbox SDK caps an ID at 63 characters and the
 * installation prefix alone takes 41 of them.
 */

/** The Sandbox SDK's limit on a Sandbox ID (`sanitizeSandboxId`). */
export const SANDBOX_ID_MAX_CHARS = 63;

/** Changing this addresses every hosted workspace anew: a visible rename, never a silent one. */
const HOSTED_SANDBOX_DIGEST_DOMAIN = 'chickpea.sandbox.v1:';
/** 105 bits of the workspace ID's digest, unique within one installation. */
const HOSTED_SANDBOX_DIGEST_CHARS = 21;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

type Env = Record<string, unknown>;

/**
 * The Sandbox Durable Object name of a workspace. Standalone: the workspace
 * ID, unchanged. Installation tenancy: `i1~<installationId>~w<21 base32>`,
 * lowercase, at most 63 characters; an installation ID too long for that, or
 * with an uppercase letter, is refused, as is an env that serves no
 * installation.
 */
export function sandboxObjectName(env: Env | undefined, workspaceId: string): string {
  if (!workspaceId) throw new Error('A coding workspace ID is required.');
  const scope = requireInstallationScope(env);
  if (!scope) return workspaceId;
  // The SDK's normalized IDs lowercase a name, so an uppercase installation
  // ID could reach the Sandbox of the installation it lowercases to.
  if (/[A-Z]/.test(scope.installationId)) {
    throw new InstallationContextError(
      'installation_context_invalid',
      'A coding workspace Sandbox needs a lowercase installation ID.',
    );
  }
  const digest = createHash('sha256').update(`${HOSTED_SANDBOX_DIGEST_DOMAIN}${workspaceId}`).digest();
  const name = scopedObjectName(scope, `w${base32(digest).slice(0, HOSTED_SANDBOX_DIGEST_CHARS)}`);
  if (name.length > SANDBOX_ID_MAX_CHARS) {
    throw new InstallationContextError(
      'installation_context_invalid',
      'The installation ID is too long to name a coding workspace Sandbox.',
    );
  }
  return name;
}

type SandboxOptions = typeof CLOUDFLARE_SANDBOX_OPTIONS | Record<string, unknown>;

/** Opens a Sandbox stub by its exact name; `getSandbox` in production. */
export type SandboxOpener = (binding: unknown, name: string, options: SandboxOptions) => unknown;

export interface SandboxStubDependencies {
  open?: SandboxOpener;
  record?: WorkspaceObjectRecorder;
}

/**
 * The stub of a workspace's Sandbox. Every Sandbox Core addresses by name is
 * opened here, so under installation tenancy its name is in the
 * installation's object inventory before the object is first contacted.
 * Cheap and lazy otherwise: it starts no container.
 */
export async function sandboxStub<T = unknown>(
  env: Env | undefined,
  workspaceId: string,
  options: SandboxOptions = CLOUDFLARE_SANDBOX_OPTIONS,
  dependencies: SandboxStubDependencies = {},
): Promise<T> {
  const binding = env?.SANDBOX ?? env?.Sandbox;
  if (!binding) throw new Error('No Sandbox binding');
  const name = sandboxObjectName(env, workspaceId);
  await recordWorkspaceObject(env, { kind: 'sandbox', name }, dependencies.record);
  return (await (dependencies.open ?? openCloudflareSandbox)(binding, name, options)) as T;
}

/** The coding Sandbox readers of one thread (identical for both executors). */
export function sandboxTurnReaders(env: Env): TurnExecutionPorts['sandboxes'] {
  return (sandboxKey) => {
    if (!(env.SANDBOX ?? env.Sandbox)) return [];
    // An unscoped env, or a malformed tenancy, throws here: never "no Sandbox".
    const scope = requireInstallationScope(env);
    if (scope) {
      try {
        sandboxObjectName(env, sandboxKey);
      } catch (error) {
        // An installation that cannot name a Sandbox never opened one.
        if (error instanceof InstallationContextError) return [];
        throw error;
      }
    }
    // The uppercase bridge reopens a standalone thread key under its
    // normalized name. It would lowercase an installation ID too, so an
    // installation's Sandbox is opened under its own name only.
    const variants = scope ? [CLOUDFLARE_SANDBOX_OPTIONS] : cloudflareSandboxOptionVariants(sandboxKey);
    // A replaced Sandbox instance leaves a dead stub; reconnect instead.
    return variants.map((options) => () =>
      reconnectingSandboxStub(() => sandboxStub(env, sandboxKey, options)) as ReturnType<typeof getSandbox> & SandboxTurnReader);
  };
}

async function openCloudflareSandbox(binding: unknown, name: string, options: SandboxOptions): Promise<unknown> {
  const { getSandbox } = await import('@cloudflare/sandbox');
  return getSandbox(binding as Parameters<typeof getSandbox>[0], name, options as Parameters<typeof getSandbox>[2]);
}

/** Durably records one coding workspace object for the env's installation. */
export type WorkspaceObjectRecorder = (env: Env, object: InstallationWorkspaceObject) => Promise<void>;

/** Names this isolate already recorded; the inventory never forgets one, so neither does this. */
// A tenant-store restore that drops inventory rows needs a fresh isolate to record them again.
const recordedObjects = new Set<string>();
const MAX_REMEMBERED_OBJECTS = 10_000;

/**
 * Record a coding workspace's Sandbox or coding worker in its installation's
 * object inventory, once per isolate; a deployment serving one installation
 * records nothing. A failure propagates, so the caller does not address an
 * object it could not record.
 */
export async function recordWorkspaceObject(
  env: Env | undefined,
  object: InstallationWorkspaceObject,
  record: WorkspaceObjectRecorder = recordInStateStore,
): Promise<void> {
  if (deploymentTenancy(env) !== 'installation') return;
  const key = `${object.kind}\u0000${object.name}`;
  if (recordedObjects.has(key)) return;
  await record(env!, object);
  if (recordedObjects.size >= MAX_REMEMBERED_OBJECTS) recordedObjects.clear();
  recordedObjects.add(key);
}

async function recordInStateStore(env: Env, object: InstallationWorkspaceObject): Promise<void> {
  const store = getSlackStateStore(env);
  if (!store.recordWorkspaceObject) throw new Error('This state store keeps no object inventory.');
  await store.recordWorkspaceObject(object);
}

export function resetRecordedWorkspaceObjectsForTests(): void {
  recordedObjects.clear();
}

/** Where a Sandbox keeps the installation it serves, for wakes that carry no name. */
export const SANDBOX_INSTALLATION_STORAGE_KEY = 'chickpea.sandbox.installation.v1';

/** What a Sandbox Durable Object constructor knows about itself. */
export interface SandboxObjectContext extends ObjectContext {
  readonly storage: {
    readonly kv: {
      get(key: string): unknown;
      put(key: string, value: unknown): void;
    };
  };
}

/**
 * The env a Sandbox Durable Object hands its base class, so its settings,
 * Git identity and checkpoints read that installation's stores.
 *
 * Standalone: as every object (`objectInstallationEnv`). Installation
 * tenancy: the installation its name carries. Egress handlers wake the
 * object by ID, which carries no name, so the first named construction also
 * stores the installation and an unnamed wake recovers it from there. An
 * object with neither keeps an unscoped env, so everything tenant-owned it
 * touches fails closed.
 */
export function sandboxObjectEnv<E>(ctx: SandboxObjectContext, env: E): E {
  const platformEnv = env as Env | undefined;
  if (!platformEnv || deploymentTenancy(platformEnv) === 'standalone') return objectInstallationEnv(ctx, env);
  const stored = ctx.storage.kv.get(SANDBOX_INSTALLATION_STORAGE_KEY);
  const storedId = typeof stored === 'string' ? stored : undefined;
  let installationId: string | undefined;
  if (ctx.id.name !== undefined) {
    // A named object serves only the installation its name carries; an
    // unscoped name (the deployment's container probe) serves none.
    installationId = installationScopeOfObjectName(ctx.id.name)?.installationId;
    if (storedId !== undefined && storedId !== installationId) {
      throw new InstallationContextError(
        'installation_context_mismatch',
        'This Sandbox recorded another installation than its name carries.',
      );
    }
    if (installationId && storedId === undefined) {
      ctx.storage.kv.put(SANDBOX_INSTALLATION_STORAGE_KEY, installationId);
    }
  } else {
    installationId = storedId;
  }
  return installationId ? scopeInstallationEnv(platformEnv, { installationId }) as E : env;
}

/** RFC 4648 base32, lowercase, without padding. */
function base32(bytes: Uint8Array): string {
  let output = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return output;
}
