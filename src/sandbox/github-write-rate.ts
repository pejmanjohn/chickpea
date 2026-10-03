/**
 * The rate at which one installation's coding workspaces may write to GitHub
 * through egress, on a deployment serving many installations. Every
 * installation shares the platform's GitHub App, so one runaway loop must
 * not spend its reputation or its rate limit. Standalone has no such limit.
 *
 * The egress decision says what a request does (egress-handler.ts), from
 * the same URL and method it allows and forwards: anything that does not
 * surely read is a write, and one that may open a pull request (the REST
 * create call; GraphQL and the uploads host are not reachable through
 * egress) also counts per day.
 */
import type { SettingsStore } from '../config/settings-store.ts';
import type { GithubRequestEffect } from './egress-handler.ts';

export const GITHUB_WRITES_KEY = 'sandbox.githubWrites';
export const GITHUB_WRITE_WINDOW_MS = 10 * 60_000;
export const GITHUB_WRITES_PER_WINDOW = 60;
export const GITHUB_PULL_REQUEST_WINDOW_MS = 24 * 60 * 60_000;
export const GITHUB_PULL_REQUESTS_PER_WINDOW = 30;
const MAX_CAS_ATTEMPTS = 12;

/**
 * Count one write, or refuse it when the installation's ten-minute writes or
 * daily pull requests are spent. A refused write is not counted.
 */
export async function admitGithubWrite(input: {
  store: Pick<SettingsStore, 'getSetting' | 'applySettingsPatch'>;
  kind: Exclude<GithubRequestEffect, 'read'>;
  now: number;
}): Promise<boolean> {
  const { store, kind, now } = input;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
    const raw = await store.getSetting(GITHUB_WRITES_KEY);
    const stored = parseWrites(raw);
    const writes = stored.writes.filter((at) => at > now - GITHUB_WRITE_WINDOW_MS);
    const pullRequests = stored.pullRequests.filter((at) => at > now - GITHUB_PULL_REQUEST_WINDOW_MS);
    if (writes.length >= GITHUB_WRITES_PER_WINDOW) return false;
    if (kind === 'pull_request' && pullRequests.length >= GITHUB_PULL_REQUESTS_PER_WINDOW) return false;
    writes.push(now);
    if (kind === 'pull_request') pullRequests.push(now);
    const applied = await store.applySettingsPatch({
      expected: { key: GITHUB_WRITES_KEY, value: raw ?? null },
      set: [{ key: GITHUB_WRITES_KEY, value: JSON.stringify({ writes, pullRequests }) }],
    });
    if (applied) return true;
  }
  throw new Error('Could not count a GitHub write after concurrent updates');
}

/** A refused write: the container sees an HTTP "slow down", never a policy denial. */
export function githubWriteRateLimited(): Response {
  return new Response(null, {
    status: 429,
    headers: { 'Retry-After': String(GITHUB_WRITE_WINDOW_MS / 1_000) },
  });
}

function parseWrites(raw: string | undefined): { writes: number[]; pullRequests: number[] } {
  if (raw === undefined) return { writes: [], pullRequests: [] };
  try {
    const parsed = JSON.parse(raw) as { writes?: unknown; pullRequests?: unknown } | null;
    return { writes: timestamps(parsed?.writes), pullRequests: timestamps(parsed?.pullRequests) };
  } catch {
    return { writes: [], pullRequests: [] };
  }
}

function timestamps(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((at): at is number => typeof at === 'number' && Number.isFinite(at)) : [];
}
