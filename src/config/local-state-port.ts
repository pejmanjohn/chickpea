/**
 * Adapt synchronous state-owner logic to the Promise-shaped public port used
 * everywhere outside that owner. Keeping the asynchronous contract honest is
 * important even when most callers use `await`: some services intentionally
 * attach `.catch(...)` directly to best-effort persistence calls.
 */
export function promiseBackedStatePort<T extends object>(target: T): T {
  return new Proxy(target, {
    get(inner, property) {
      const value = Reflect.get(inner, property, inner);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => Promise.resolve().then(() => value.apply(inner, args));
    },
  });
}
