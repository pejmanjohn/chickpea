import {
  deploymentTenancy,
  InstallationContextError,
  INSTALLATION_OBJECT_NAME_VERSION,
  installationScopeOf,
  requireInstallationScope,
} from '../config/installation-scope.ts';

/**
 * Where coding-workspace checkpoints live in the `BACKUP_BUCKET` R2 bucket.
 *
 * Standalone: the bucket itself, as it always was. A deployment serving many
 * installations shares one bucket, and each installation sees only its own
 * prefix, `i1/<installationId>/`, through a view that adds the prefix to
 * every key it is given and strips it from every key it returns. The Sandbox
 * hands that view to the Sandbox SDK as its `BACKUP_BUCKET`, so the SDK's
 * keys (`backups/<id>/…`) land under the installation without the SDK
 * knowing; the sweep, erasure and census read the same view.
 *
 * The view offers exactly the R2 methods the Sandbox SDK 0.12.x calls on the
 * bucket (pinned by tests/hosted-sandbox-checkpoints.test.ts against the
 * installed SDK). Any other member throws, so an SDK that starts calling a
 * new method fails loudly instead of reaching the bare bucket; only the
 * members generic code probes on any object read as absent.
 */

/** The R2 bucket methods the view offers: the Sandbox SDK 0.12.x call set. */
export const CHECKPOINT_BUCKET_METHODS = [
  'createMultipartUpload',
  'delete',
  'get',
  'head',
  'list',
  'put',
  'resumeMultipartUpload',
] as const;
type CheckpointBucketMethod = typeof CHECKPOINT_BUCKET_METHODS[number];
const OFFERED = new Set<PropertyKey>(CHECKPOINT_BUCKET_METHODS);
/** Read by `await`, `JSON.stringify` and type checks on any value; no R2 method is one. */
const PROBED = new Set<PropertyKey>(['constructor', 'then', 'toJSON']);

/** The SDK's checkpoint layout: `backups/<backup id>/{data.sqsh,meta.json}`. */
const CHECKPOINT_KEY_PREFIX = 'backups';
const CHECKPOINT_OBJECT_NAMES = ['data.sqsh', 'meta.json'] as const;
/** The SDK names each backup with `crypto.randomUUID()`. */
const BACKUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Env = Record<string, unknown> | undefined;
type Bucket = Record<CheckpointBucketMethod, (...args: never[]) => unknown>;

/** The prefix of one installation's checkpoints in the shared bucket. */
export function installationCheckpointPrefix(installationId: string): string {
  return `${INSTALLATION_OBJECT_NAME_VERSION}/${installationId}/`;
}

/** Views made here, by the installation each serves: never wrapped twice. */
const views = new WeakMap<object, string>();

/**
 * The checkpoint bucket of the env's installation: the bare `BACKUP_BUCKET`
 * standalone, the installation's prefixed view under installation tenancy
 * (refused for an env that names no installation), or undefined without the
 * binding.
 */
export function installationCheckpointBucket<T = unknown>(env: Env): T | undefined {
  const bucket = env?.BACKUP_BUCKET;
  if (typeof bucket !== 'object' || bucket === null) return undefined;
  const scope = requireInstallationScope(env);
  if (!scope) return bucket as T;
  const viewed = views.get(bucket);
  if (viewed !== undefined) {
    if (viewed !== scope.installationId) throw foreignBucket();
    return bucket as T;
  }
  return prefixedCheckpointBucket(bucket as Bucket, scope.installationId) as T;
}

/**
 * The env a Sandbox hands the Sandbox SDK. Standalone: unchanged. Under
 * installation tenancy its `BACKUP_BUCKET` is the installation's view, and an
 * env that names no installation (the deployment's container probe, or a
 * wake that cannot tell) gets no bucket at all, so it can neither checkpoint
 * nor restore.
 */
export function sandboxCheckpointEnv<E>(env: E): E {
  const platformEnv = env as Env;
  if (!platformEnv || deploymentTenancy(platformEnv) === 'standalone') return env;
  if (typeof platformEnv.BACKUP_BUCKET !== 'object' || platformEnv.BACKUP_BUCKET === null) return env;
  const { BACKUP_BUCKET: _bucket, ...rest } = platformEnv;
  if (!installationScopeOf(platformEnv)) return Object.freeze(rest) as E;
  return Object.freeze({ ...rest, BACKUP_BUCKET: installationCheckpointBucket(platformEnv) }) as E;
}

/** The objects one stored checkpoint handle names, or undefined for a handle that is not the SDK's. */
export function checkpointObjectKeys(backup: unknown): string[] | undefined {
  const id = (backup as { id?: unknown } | null | undefined)?.id;
  if (typeof id !== 'string' || !BACKUP_ID.test(id)) return undefined;
  return CHECKPOINT_OBJECT_NAMES.map((name) => `${CHECKPOINT_KEY_PREFIX}/${id}/${name}`);
}

/** Deletes one checkpoint's objects from `bucket`; returns how many keys it named. */
export async function deleteCheckpointObjects(
  bucket: { delete(keys: string | string[]): Promise<unknown> },
  backup: unknown,
): Promise<number> {
  const keys = checkpointObjectKeys(backup);
  if (!keys) return 0;
  await bucket.delete(keys);
  return keys.length;
}

function prefixedCheckpointBucket(bucket: Bucket, installationId: string): object {
  const prefix = installationCheckpointPrefix(installationId);
  const call = <M extends CheckpointBucketMethod>(method: M, ...args: unknown[]) =>
    (bucket[method] as (...a: unknown[]) => unknown).apply(bucket, args);
  const full = (key: unknown): string => {
    if (typeof key !== 'string' || key.length === 0) throw new Error('A checkpoint key must be a non-empty string.');
    return `${prefix}${key}`;
  };
  const strip = (key: unknown): string => {
    if (typeof key !== 'string' || !key.startsWith(prefix)) {
      throw new Error('The checkpoint bucket returned a key outside the installation.');
    }
    return key.slice(prefix.length);
  };
  const object = <T>(value: T): T =>
    value !== null && typeof value === 'object' ? withKey(value, strip((value as { key?: unknown }).key)) : value;
  const upload = <T>(value: T): T => {
    if (value === null || typeof value !== 'object') return value;
    return withKey(value, strip((value as { key?: unknown }).key), {
      complete: (complete) => async (...args: unknown[]) => object(await complete(...args)),
    });
  };

  const methods: Record<CheckpointBucketMethod, (...args: never[]) => unknown> = {
    async head(key: string) {
      return object(await call('head', full(key)));
    },
    async get(key: string, options?: unknown) {
      return object(await call('get', full(key), ...(options === undefined ? [] : [options])));
    },
    async put(key: string, value: unknown, options?: unknown) {
      return object(await call('put', full(key), value, ...(options === undefined ? [] : [options])));
    },
    async delete(keys: string | string[]) {
      await call('delete', Array.isArray(keys) ? keys.map(full) : full(keys));
    },
    async list(options: Record<string, unknown> = {}) {
      if (options.prefix !== undefined && typeof options.prefix !== 'string') {
        throw new Error('A checkpoint list prefix must be a string.');
      }
      const listing = await call('list', {
        ...options,
        prefix: `${prefix}${(options.prefix as string | undefined) ?? ''}`,
        ...(options.startAfter === undefined ? {} : { startAfter: full(options.startAfter) }),
      }) as {
        objects: object[];
        truncated: boolean;
        cursor?: string;
        delimitedPrefixes?: string[];
      };
      return {
        objects: listing.objects.map(object),
        truncated: listing.truncated,
        ...(listing.truncated ? { cursor: listing.cursor } : {}),
        delimitedPrefixes: (listing.delimitedPrefixes ?? []).map(strip),
      };
    },
    async createMultipartUpload(key: string, options?: unknown) {
      return upload(await call('createMultipartUpload', full(key), ...(options === undefined ? [] : [options])));
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      return upload(call('resumeMultipartUpload', full(key), uploadId));
    },
  };
  const view = new Proxy(Object.freeze(methods), {
    get(target, property) {
      if (OFFERED.has(property)) return target[property as CheckpointBucketMethod];
      // Inspection reads symbols (util.inspect, Symbol.toStringTag); no R2 method is one.
      if (typeof property === 'symbol' || PROBED.has(property)) return undefined;
      throw new Error(`The coding workspace checkpoint bucket offers no ${property}.`);
    },
    has(_target, property) {
      return OFFERED.has(property);
    },
    set() {
      throw new Error('The coding workspace checkpoint bucket cannot be changed.');
    },
    defineProperty() {
      throw new Error('The coding workspace checkpoint bucket cannot be changed.');
    },
    deleteProperty() {
      throw new Error('The coding workspace checkpoint bucket cannot be changed.');
    },
  });
  views.set(view, installationId);
  return view;
}

/**
 * `value` with its `key` replaced, its other members read from `value`
 * itself (methods bound to it, as R2's runtime objects require), and any
 * method in `wrap` decorated. The target is an empty object whose prototype
 * is `value`, so no proxy invariant ties `key` to `value`'s own property.
 */
function withKey<T>(
  value: T,
  key: string,
  wrap: Record<string, (method: (...args: unknown[]) => Promise<unknown>) => unknown> = {},
): T {
  const original = value as object;
  return new Proxy(Object.create(original) as object, {
    get(_target, property) {
      if (property === 'key') return key;
      const member = Reflect.get(original, property, original) as unknown;
      if (typeof member !== 'function') return member;
      const bound = (member as (...args: unknown[]) => Promise<unknown>).bind(original);
      return typeof property === 'string' && wrap[property] ? wrap[property](bound) : bound;
    },
  }) as T;
}

function foreignBucket(): InstallationContextError {
  return new InstallationContextError(
    'installation_context_mismatch',
    'The checkpoint bucket belongs to another installation.',
  );
}
