/**
 * A capability loaded with `import()` on first use instead of at Worker
 * startup. Every module the entry imports statically loads before a Durable
 * Object's constructor runs, so code the reply path does not need sits behind
 * one of these and loads at a seam that is already async (a tool's `run`, an
 * RPC, `onStart`).
 *
 * Synchronous code takes the `Loaded<T>` that `load()` returns, so a path that
 * skipped the load does not compile. A Flue render is synchronous and takes no
 * parameter from its caller: it calls `require()` after a seam preloaded the
 * capability, and an unloaded one throws `CapabilityNotLoadedError` naming it.
 */
declare const loadedBrand: unique symbol;

/** A value that came from `OnDemand.load()` or `require()`. */
export type Loaded<T> = T & { readonly [loadedBrand]: true };

export class CapabilityNotLoadedError extends Error {
  constructor(readonly capability: string) {
    super(`${capability} is used before it was loaded. Load it at an async seam first.`);
    this.name = 'CapabilityNotLoadedError';
  }
}

export interface OnDemand<T> {
  readonly name: string;
  /** Imports once per isolate; concurrent callers share the import, and a failed one is retried. */
  load(): Promise<Loaded<T>>;
  /** The loaded capability, or `CapabilityNotLoadedError` until a `load()` resolved. */
  require(): Loaded<T>;
}

export function onDemand<T extends object>(name: string, importer: () => Promise<T>): OnDemand<T> {
  let loaded: Loaded<T> | undefined;
  let loading: Promise<Loaded<T>> | undefined;
  return {
    name,
    load() {
      if (loaded) return Promise.resolve(loaded);
      if (!loading) {
        const attempt = Promise.resolve().then(importer).then((value) => loaded = value as Loaded<T>);
        loading = attempt;
        attempt.catch(() => {
          if (loading === attempt) loading = undefined;
        });
      }
      return loading;
    },
    require() {
      if (!loaded) throw new CapabilityNotLoadedError(name);
      return loaded;
    },
  };
}
