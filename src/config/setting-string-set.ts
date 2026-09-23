/**
 * Small helpers for settings rows that hold a JSON array of strings (an
 * index of record ids) or one JSON record updated by compare-and-set. They
 * build only on the SettingsStore interface, so they work the same on the
 * Node backend and the Durable Object RPC proxy.
 */
import type { SettingsStore } from './settings-store.ts';

const MAX_CAS_ATTEMPTS = 4;

/** The distinct string members of a JSON-array setting; malformed rows read as empty. */
export async function readSettingStringSet(
  store: Pick<SettingsStore, 'getSetting'>,
  key: string,
  isValue: (value: string) => boolean = () => true,
): Promise<string[]> {
  return parseStringSet(await store.getSetting(key)).filter(isValue);
}

/** Atomically union members into a JSON-array setting. */
export async function addSettingStringSetValues(
  store: Pick<SettingsStore, 'mergeSettingStringSet'>,
  key: string,
  values: readonly string[],
): Promise<string[]> {
  return store.mergeSettingStringSet(key, values);
}

/**
 * Remove members from a JSON-array setting by compare-and-set, deleting the
 * row once it is empty. Gives up quietly after a few contended attempts.
 */
export async function removeSettingStringSetValues(
  store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>,
  key: string,
  values: readonly string[],
): Promise<void> {
  const removed = new Set(values);
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const raw = await store.getSetting(key);
    if (!raw) return;
    const remaining = parseStringSet(raw).filter((value) => !removed.has(value));
    const changed = await store.applySettingsPatch({
      expected: { key, value: raw },
      ...(remaining.length
        ? { set: [{ key, value: JSON.stringify(remaining) }] }
        : { delete: [key] }),
    });
    if (changed) return;
  }
}

/**
 * Compare-and-set one JSON setting. `change` receives the stored value
 * (undefined when absent) and returns the next value, `null` to delete the
 * row, or undefined to leave it. Returns the value written, or undefined
 * when nothing was written.
 */
export async function updateJsonSetting<T>(
  store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>,
  key: string,
  change: (current: T | undefined, raw: string | undefined) => T | null | undefined,
  parse: (raw: string) => T | undefined = defaultParse,
): Promise<T | null | undefined> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const raw = await store.getSetting(key);
    const next = change(raw === undefined ? undefined : parse(raw), raw);
    if (next === undefined) return undefined;
    if (next === null && raw === undefined) return null;
    const changed = await store.applySettingsPatch({
      expected: { key, value: raw ?? null },
      ...(next === null ? { delete: [key] } : { set: [{ key, value: JSON.stringify(next) }] }),
    });
    if (changed) return next;
  }
  return undefined;
}

function parseStringSet(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string'))]
      : [];
  } catch {
    return [];
  }
}

function defaultParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
