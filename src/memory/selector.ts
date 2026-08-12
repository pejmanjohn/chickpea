import { sha256Hex } from './markdown.ts';
import type { MemoryEntry, OwnerMemoryEntry } from './types.ts';

export const MEMORY_PROMPT_ENTRY_LIMIT = 8;
export const MEMORY_PROMPT_BYTES_LIMIT = 8 * 1_024;
export const MEMORY_BODY_EXCERPT_BYTES_LIMIT = 2 * 1_024;
export const MEMORY_STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1_000;

export interface SelectedMemoryEntry<T extends SelectableMemoryEntry = MemoryEntry> {
  entry: T;
  bodyExcerpt: string;
  bodyTruncated: boolean;
  stale: boolean;
  score: number;
}

export type SelectableMemoryEntry = MemoryEntry | OwnerMemoryEntry;

export interface MemorySelection<T extends SelectableMemoryEntry = MemoryEntry> {
  entries: SelectedMemoryEntry<T>[];
  fingerprint: string;
  truncated: boolean;
}

export function selectMemoryEntries<T extends SelectableMemoryEntry>(input: {
  entries: readonly T[];
  query: string;
  /** Legacy selector seam removed when U4 switches runtime to owner scopes. */
  sourceChannelId?: string;
  now: number;
  maxEntries?: number;
  maxBytes?: number;
}): MemorySelection<T> {
  const maxEntries = input.maxEntries ?? MEMORY_PROMPT_ENTRY_LIMIT;
  const maxBytes = input.maxBytes ?? MEMORY_PROMPT_BYTES_LIMIT;
  const query = normalize(input.query);
  const queryTokens = tokens(query);
  const candidates = input.entries
    .filter(
      (entry) =>
        (entry.status === 'active' || entry.status === 'stale') &&
        (entry.expiresAt === null || entry.expiresAt > input.now),
    )
    .map((entry) => rankEntry(entry, query, queryTokens, input.sourceChannelId, input.now))
    .sort(compareRanked);

  const chosen: ReturnType<typeof rankEntry>[] = [];
  const sourceReserve = input.sourceChannelId === undefined || candidates.some(({ entry }) => isOwnerEntry(entry))
    ? []
    : candidates
      .filter((candidate) => legacySourceChannelId(candidate.entry) === input.sourceChannelId)
      .slice(0, Math.min(2, maxEntries));
  chosen.push(...sourceReserve);
  for (const candidate of candidates) {
    if (chosen.length >= maxEntries) break;
    if (chosen.some((existing) => existing.entry.entryId === candidate.entry.entryId)) continue;
    if (candidate.score <= 0) continue;
    chosen.push(candidate);
  }
  chosen.sort(compareRanked);

  const selected: SelectedMemoryEntry<T>[] = [];
  let usedBytes = 0;
  let truncated = candidates.length > chosen.length;
  for (const candidate of chosen) {
    const excerpt = truncateUtf8(candidate.entry.body, MEMORY_BODY_EXCERPT_BYTES_LIMIT);
    const projectedBytes = utf8Bytes(
      JSON.stringify({
        id: candidate.entry.entryId,
        version: candidate.entry.version,
        origin: entryOrigin(candidate.entry),
        slug: candidate.entry.slug,
        description: candidate.entry.description,
        type: candidate.entry.type,
        body: excerpt.text,
      }),
    );
    if (usedBytes + projectedBytes > maxBytes) {
      truncated = true;
      continue;
    }
    usedBytes += projectedBytes;
    selected.push({
      ...candidate,
      bodyExcerpt: excerpt.text,
      bodyTruncated: excerpt.truncated,
    } as SelectedMemoryEntry<T>);
    truncated ||= excerpt.truncated;
  }

  return {
    entries: selected,
    fingerprint: memorySelectionFingerprint(selected),
    truncated,
  };
}

export function memorySelectionFingerprint(
  entries: readonly Pick<SelectedMemoryEntry<SelectableMemoryEntry>, 'entry'>[],
): string {
  const input = entries.map(({ entry }) =>
    `${entry.storeId}:${entry.entryId}:${entry.version}:${entry.contentHash ?? contentFingerprint(entry)}`,
  ).join('|');
  return sha256Hex(input || 'none');
}

function rankEntry<T extends SelectableMemoryEntry>(
  entry: T,
  query: string,
  queryTokens: ReadonlySet<string>,
  sourceChannelId: string | undefined,
  now: number,
) {
  const origin = entryOrigin(entry);
  const qualified = `${origin.id.toLowerCase()}/${entry.slug}`;
  const wiki = `[[${entry.slug}]]`;
  const qualifiedWiki = `[[${qualified}]]`;
  let score = 0;
  if (query.includes(qualifiedWiki) || query.includes(qualified)) score += 1_000;
  if (sourceChannelId !== undefined && legacySourceChannelId(entry) === sourceChannelId &&
      (query.includes(wiki) || hasPhrase(query, entry.slug))) {
    score += 900;
  }
  score += overlap(queryTokens, tokens(`${entry.slug} ${entry.description}`)) * 20;
  score += overlap(queryTokens, tokens(entry.body)) * 4;
  if (sourceChannelId !== undefined && legacySourceChannelId(entry) === sourceChannelId) score += 8;
  const stale = entry.status === 'stale' || now - entry.modifiedAt >= MEMORY_STALE_AFTER_MS;
  if (stale) score -= 6;
  return { entry, stale, score };
}

function compareRanked(
  left: ReturnType<typeof rankEntry>,
  right: ReturnType<typeof rankEntry>,
): number {
  return (
    right.score - left.score ||
    ownerSpecificity(right.entry) - ownerSpecificity(left.entry) ||
    right.entry.modifiedAt - left.entry.modifiedAt ||
    left.entry.entryId.localeCompare(right.entry.entryId, 'en')
  );
}

export function memoryEntryOrigin(entry: SelectableMemoryEntry): {
  kind: 'agent' | 'channel' | 'legacy_channel'; id: string;
} {
  return entryOrigin(entry);
}

function isOwnerEntry(entry: SelectableMemoryEntry): entry is OwnerMemoryEntry {
  return 'ownerKind' in entry;
}

function entryOrigin(entry: SelectableMemoryEntry): { kind: 'agent' | 'channel' | 'legacy_channel'; id: string } {
  return isOwnerEntry(entry)
    ? { kind: entry.ownerKind, id: entry.ownerId }
    : { kind: 'legacy_channel', id: entry.sourceChannelId };
}

function legacySourceChannelId(entry: SelectableMemoryEntry): string | undefined {
  return isOwnerEntry(entry) ? undefined : entry.sourceChannelId;
}

function ownerSpecificity(entry: SelectableMemoryEntry): number {
  return isOwnerEntry(entry) && entry.ownerKind === 'channel' ? 1 : 0;
}

function contentFingerprint(entry: SelectableMemoryEntry): string {
  return sha256Hex(`${entry.description}\0${entry.body}`);
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}

function tokens(value: string): Set<string> {
  return new Set(normalize(value).match(/[a-z0-9]{2,}/g) ?? []);
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function hasPhrase(query: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:$|[^a-z0-9-])`, 'i').test(query);
}

function truncateUtf8(value: string, maximum: number): { text: string; truncated: boolean } {
  if (utf8Bytes(value) <= maximum) return { text: value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, midpoint)) <= maximum) low = midpoint;
    else high = midpoint - 1;
  }
  while (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1]!)) low -= 1;
  return { text: value.slice(0, low), truncated: true };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
