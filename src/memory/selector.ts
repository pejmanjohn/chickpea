import { createHash } from 'node:crypto';

import type { MemoryEntry } from './types.ts';

export const MEMORY_PROMPT_ENTRY_LIMIT = 8;
export const MEMORY_PROMPT_BYTES_LIMIT = 8 * 1_024;
export const MEMORY_BODY_EXCERPT_BYTES_LIMIT = 2 * 1_024;
export const MEMORY_STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1_000;

export interface SelectedMemoryEntry {
  entry: MemoryEntry;
  bodyExcerpt: string;
  bodyTruncated: boolean;
  stale: boolean;
  score: number;
}

export interface MemorySelection {
  entries: SelectedMemoryEntry[];
  fingerprint: string;
  truncated: boolean;
}

export function selectMemoryEntries(input: {
  entries: readonly MemoryEntry[];
  query: string;
  sourceChannelId: string;
  now: number;
  maxEntries?: number;
  maxBytes?: number;
}): MemorySelection {
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
  const sourceReserve = candidates
    .filter((candidate) => candidate.entry.sourceChannelId === input.sourceChannelId)
    .slice(0, Math.min(2, maxEntries));
  chosen.push(...sourceReserve);
  for (const candidate of candidates) {
    if (chosen.length >= maxEntries) break;
    if (chosen.some((existing) => existing.entry.entryId === candidate.entry.entryId)) continue;
    if (candidate.score <= 0) continue;
    chosen.push(candidate);
  }
  chosen.sort(compareRanked);

  const selected: SelectedMemoryEntry[] = [];
  let usedBytes = 0;
  let truncated = candidates.length > chosen.length;
  for (const candidate of chosen) {
    const excerpt = truncateUtf8(candidate.entry.body, MEMORY_BODY_EXCERPT_BYTES_LIMIT);
    const projectedBytes = utf8Bytes(
      JSON.stringify({
        id: candidate.entry.entryId,
        version: candidate.entry.version,
        channel: candidate.entry.sourceChannelId,
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
    });
    truncated ||= excerpt.truncated;
  }

  const fingerprintInput = selected
    .map(({ entry }) => `${entry.entryId}:${entry.version}`)
    .join('|');
  return {
    entries: selected,
    fingerprint: createHash('sha256').update(fingerprintInput || 'none').digest('hex'),
    truncated,
  };
}

function rankEntry(
  entry: MemoryEntry,
  query: string,
  queryTokens: ReadonlySet<string>,
  sourceChannelId: string,
  now: number,
) {
  const qualified = `${entry.sourceChannelId.toLowerCase()}/${entry.slug}`;
  const wiki = `[[${entry.slug}]]`;
  const qualifiedWiki = `[[${qualified}]]`;
  let score = 0;
  if (query.includes(qualifiedWiki) || query.includes(qualified)) score += 1_000;
  if (entry.sourceChannelId === sourceChannelId && (query.includes(wiki) || hasPhrase(query, entry.slug))) {
    score += 900;
  }
  score += overlap(queryTokens, tokens(`${entry.slug} ${entry.description}`)) * 20;
  score += overlap(queryTokens, tokens(entry.body)) * 4;
  if (entry.sourceChannelId === sourceChannelId) score += 8;
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
    right.entry.modifiedAt - left.entry.modifiedAt ||
    left.entry.entryId.localeCompare(right.entry.entryId, 'en')
  );
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
