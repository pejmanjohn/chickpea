/**
 * Read a deployment value that may arrive either as a Workers binding or as a
 * local `process.env` entry. A bound string always wins, so a deliberately
 * blank binding is not silently overridden by a stale local variable, and the
 * `process` lookup is guarded because Workers has no process global.
 */
export function envValue(
  env: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  const bound = env?.[name];
  const value = typeof bound === 'string'
    ? bound
    : typeof process === 'undefined' ? undefined : process.env[name];
  const normalized = value?.trim();
  return normalized || undefined;
}
