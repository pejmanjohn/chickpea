/**
 * One async facade for the Node SQLite stores.
 *
 * Every store is written twice: a synchronous `*Logic` class that owns the SQL
 * (so the same code runs inside a Durable Object, where transactions cannot
 * span awaits) and a `Sqlite*Store` class that satisfies the app-level async
 * store interface by forwarding each method to the logic instance. The second
 * half is pure mechanism — hundreds of lines of `async m(a) { return
 * this.logic.m(a); }` whose only failure mode is drift — so it lives here once.
 *
 * The forwarding is a Proxy over the logic instance: methods resolve to
 * promises, `close` stays SYNCHRONOUS (callers do `store.close()` unawaited),
 * and non-function properties pass through untouched so the store never looks
 * like a thenable.
 */

/** The async view of a synchronous logic class: every method returns a promise. */
export type Promisified<L> = {
  [K in keyof L]: L[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/**
 * Wrap a synchronous store logic instance in its async facade.
 *
 * The Proxy loses the `implements` compile check that a hand-written facade
 * class gave us, so every caller MUST pin the contract with a conformance
 * assertion next to the constructor:
 *
 * ```ts
 * const _conforms: UsageStore = undefined as unknown as
 *   Promisified<UsageStoreLogic> & { close(): void };
 * ```
 *
 * Without it, a logic method that stops matching the interface silently stops
 * failing typecheck.
 */
export function promisify<L extends object>(
  logic: L,
  extra: { close(): void },
): Promisified<L> & { close(): void } {
  const proxy = new Proxy(logic, {
    get(target, prop) {
      // `close` belongs to the facade (it owns the connection), and it must
      // stay synchronous: callers never await it.
      if (prop === 'close') return extra.close;
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== 'function') return value;
      // `apply` on the raw target, not the proxy: internal `this.x()` calls
      // must keep hitting the synchronous logic. The async arrow reproduces
      // the hand-written `async m(...) { return this.logic.m(...); }` exactly,
      // including turning a synchronous throw into a rejected promise.
      return async (...args: unknown[]) =>
        (value as (...a: unknown[]) => unknown).apply(target, args);
    },
  });
  return proxy as unknown as Promisified<L> & { close(): void };
}
