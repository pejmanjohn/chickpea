const MAX_SLUG_LENGTH = 64;

/** Produce a portable, deterministic file-safe slug. */
export function slugifyMemoryName(name: string, stableId: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
  const bounded = normalized.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, '');
  if (bounded.length > 0) return bounded;

  const stableSuffix = stableId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return `memory-${stableSuffix || 'entry'}`;
}
