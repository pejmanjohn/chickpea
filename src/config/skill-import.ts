// Third-party skill import (capabilities plan, Phase 3). Resolves a pasted
// GitHub repo / skills.sh link into a list of importable skill candidates by
// reading SKILL.md files over the GitHub REST API + raw file host. Pure logic
// with an injected fetch so it runs identically on the Node and Cloudflare
// lanes and is unit-testable offline.

/** Parsed coordinates of a skill source. */
export interface ParsedSkillSource {
  owner: string;
  repo: string;
  /** Branch/tag when the input pinned one; otherwise the repo default is used. */
  ref?: string;
  /** Directory selected by a GitHub tree URL, relative to the repository root. */
  skillPath?: string;
  /** A single skill slug to keep (e.g. `owner/repo@triage` or a skills.sh link). */
  skillFilter?: string;
}

/** One importable skill discovered in a source. */
export interface ResolvedSkillCandidate {
  name: string;
  description: string;
  instructions: string;
  /** The skill directory carries executable scripts that will not run here. */
  hasScripts: boolean;
  /** Directory path within the repo (for display + de-duplication). */
  path: string;
  /** Provenance link back to the skill's directory on GitHub. */
  sourceUrl: string;
}

export interface SkillResolution {
  owner: string;
  repo: string;
  ref: string;
  source: {
    visibility: 'public' | 'private';
    access: 'anonymous' | 'github_app';
  };
  skills: ResolvedSkillCandidate[];
  /** Total SKILL.md directories found (before the scan cap). */
  total: number;
  /** True when more skills exist than were scanned (see MAX_SCANNED_SKILLS). */
  capped: boolean;
  /** Skills found but skipped because a required field was missing/invalid. */
  skipped: number;
}

export interface SkillResolutionAccess {
  token: string;
}

export class SkillImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SkillImportError';
    this.code = code;
  }
}

// Free-plan Workers allow 50 subrequests/invocation. Resolution costs
// 2 (repo meta + tree) + one raw fetch per scanned skill, so cap the scan well
// under the ceiling. Larger repos report `capped: true` and the user narrows
// with an `@skill` filter.
const MAX_SCANNED_SKILLS = 40;
const SKILL_IMPORT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_DESCRIPTION = 1024;
const MAX_INSTRUCTIONS = 100_000;
const MAX_REPOSITORY_METADATA_BYTES = 64 * 1024;
const MAX_REPOSITORY_TREE_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_DOCUMENT_BYTES = 512 * 1024;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKIP_DIR_RE = /(^|\/)(tests?|node_modules|\.git|dist|build|__pycache__|fixtures)(\/|$)/;
const SCRIPT_EXT_RE = /\.(sh|py|js|mjs|cjs|ts|rb|bash|zsh)$/i;
const REPOSITORY_NOT_FOUND =
  'Repository not found or not accessible. Check the source and GitHub App access.';
const GITHUB_RATE_LIMITED = 'GitHub rate limit reached. Try again after it resets.';

/**
 * Parse a pasted source into `{ owner, repo, ref?, skillFilter? }`, or null if
 * it is not a recognized GitHub / skills.sh reference. Accepts:
 *   - `owner/repo`, `owner/repo@skill`
 *   - github.com URLs (optionally `/tree/<ref>/...`)
 *   - skills.sh / www.skills.sh page links (`/owner/repo[/slug]`)
 */
export function parseSkillSource(input: string): ParsedSkillSource | null {
  const trimmed = (input || '').trim();
  if (!trimmed) return null;

  // Bare shorthand: owner/repo or owner/repo@skill (no scheme, no host).
  if (!/^[a-z]+:\/\//i.test(trimmed) && !trimmed.includes(' ')) {
    const shorthand = matchShorthand(trimmed);
    if (shorthand) return shorthand;
  }

  let url: URL;
  try {
    url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  const segments = url.pathname.split('/').filter(Boolean);

  if (host === 'github.com') {
    if (segments.length < 2) return null;
    const owner = segments[0]!;
    const repo = stripGitSuffix(segments[1]!);
    // .../tree/<ref>/<path...> pins a branch/tag and narrows discovery to
    // that directory. A parent directory may still contain multiple skills;
    // the resolver reports each one so the caller can require a selection.
    if (segments[2] === 'tree' && segments[3]) {
      const skillPath = segments.slice(4).join('/').replace(/\/+$/, '');
      return {
        owner,
        repo,
        ref: segments[3],
        ...(skillPath ? { skillPath } : {}),
      };
    }
    return { owner, repo };
  }

  if (host === 'skills.sh') {
    // skills.sh/<owner>/<repo>[/<slug>] — the path is the GitHub coordinates.
    if (segments.length < 2) return null;
    const owner = segments[0]!;
    const repo = stripGitSuffix(segments[1]!);
    return segments[2] ? { owner, repo, skillFilter: segments[2] } : { owner, repo };
  }

  return null;
}

function matchShorthand(value: string): ParsedSkillSource | null {
  const match = value.match(/^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*?)(?:@([\w.-]+))?$/);
  if (!match) return null;
  return {
    owner: match[1]!,
    repo: stripGitSuffix(match[2]!),
    ...(match[3] ? { skillFilter: match[3] } : {}),
  };
}

function stripGitSuffix(repo: string): string {
  return repo.replace(/\.git$/, '');
}

/**
 * Parse SKILL.md frontmatter. Returns the recognized `name`/`description` plus
 * the markdown body (everything after the closing `---`). A minimal `key: value`
 * scan — sufficient for the Agent Skills frontmatter shape, no YAML dependency.
 */
export function parseFrontmatter(markdown: string): {
  name?: string;
  description?: string;
  body: string;
} {
  const match = markdown.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { body: markdown };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (kv) fields[kv[1]!.toLowerCase()] = unquote(kv[2]!.trim());
  }
  return {
    ...(fields.name ? { name: fields.name } : {}),
    ...(fields.description ? { description: fields.description } : {}),
    body: match[2] ?? '',
  };
}

function unquote(value: string): string {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Normalize an arbitrary skill name (or directory basename) into Chickpea's
 * strict rule (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, ≤64). Returns "" if nothing usable
 * survives (the caller skips those).
 */
export function sanitizeSkillName(raw: string): string {
  const slug = (raw || '')
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return SKILL_NAME_RE.test(slug) ? slug : '';
}

interface GitTreeEntry {
  path: string;
  type: string;
}

/**
 * Resolve a parsed source into importable skill candidates. Anonymous calls
 * preserve the public path; an optional request-local App token enables the
 * same bounded scan for one server-authorized private repository.
 */
export async function resolveSkillSource(
  parsed: ParsedSkillSource,
  fetchImpl: typeof fetch,
  access?: SkillResolutionAccess,
): Promise<SkillResolution> {
  const { owner, repo } = parsed;
  const authenticated = access !== undefined;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'chickpea-skill-import',
    ...(access ? { authorization: `Bearer ${access.token}` } : {}),
  };

  const metadata = !parsed.ref || access
    ? await fetchRepositoryMetadata(owner, repo, fetchImpl, headers, authenticated)
    : undefined;
  const ref = parsed.ref ?? metadata?.defaultBranch ?? 'main';
  const visibility = metadata?.private ? 'private' : 'public';

  const treeRes = await githubRequest(
    fetchImpl,
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { headers },
  );
  assertRepositoryResponse(treeRes, authenticated, owner, repo);
  const tree = await readJsonResponseBounded<{ tree?: GitTreeEntry[] }>(
    treeRes,
    MAX_REPOSITORY_TREE_BYTES,
    'GitHub repository tree is too large to import safely. Use a direct skill-directory URL.',
  );
  const blobs = (tree.tree ?? []).filter((entry) => entry.type === 'blob');

  const skillDirs = blobs
    .filter((entry) => entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md'))
    .map((entry) => ({ path: entry.path, dir: entry.path.replace(/\/?SKILL\.md$/, '') }))
    .filter((entry) => !SKIP_DIR_RE.test(entry.path))
    .filter((entry) => parsed.skillPath
      ? entry.dir === parsed.skillPath || entry.dir.startsWith(`${parsed.skillPath}/`)
      : true)
    .filter((entry) =>
      parsed.skillFilter ? basename(entry.dir) === parsed.skillFilter : true,
    );

  const total = skillDirs.length;
  const scan = skillDirs.slice(0, MAX_SCANNED_SKILLS);

  const skills: ResolvedSkillCandidate[] = [];
  let skipped = 0;
  for (const entry of scan) {
    const rawRes = access
      ? await githubRequest(
          fetchImpl,
          `https://api.github.com/repos/${owner}/${repo}/contents/${encodeGithubPath(entry.path)}?ref=${encodeURIComponent(ref)}`,
          {
            headers: {
              ...headers,
              accept: 'application/vnd.github.raw+json',
            },
          },
        )
      : await githubRequest(
          fetchImpl,
          `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${entry.path}`,
        );
    if (!rawRes.ok) {
      if (access && (rawRes.status === 401 || rawRes.status === 403 || rawRes.status === 404 || rawRes.status === 429)) {
        assertRepositoryResponse(rawRes, true, owner, repo);
      }
      skipped += 1;
      continue;
    }
    const md = await readResponseTextBounded(
      rawRes,
      MAX_SKILL_DOCUMENT_BYTES,
      'GitHub skill document is too large to import safely.',
    );
    const front = parseFrontmatter(md);
    const name = sanitizeSkillName(front.name || basename(entry.dir));
    const description = (front.description || '').trim().slice(0, MAX_DESCRIPTION);
    const instructions = (front.body || md).trim().slice(0, MAX_INSTRUCTIONS);
    if (!name || !description || !instructions) {
      skipped += 1;
      continue;
    }
    const hasScripts = blobs.some(
      (blob) => blob.path.startsWith(entry.dir + '/') && blob.path !== entry.path && SCRIPT_EXT_RE.test(blob.path),
    );
    skills.push({
      name,
      description,
      instructions,
      hasScripts,
      path: entry.dir || '(root)',
      sourceUrl: `https://github.com/${owner}/${repo}/tree/${ref}/${entry.dir}`,
    });
  }

  return {
    owner,
    repo,
    ref,
    source: {
      visibility,
      access: authenticated ? 'github_app' : 'anonymous',
    },
    skills,
    total,
    capped: total > scan.length,
    skipped,
  };
}

async function fetchRepositoryMetadata(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
  authenticated: boolean,
): Promise<{ defaultBranch: string; private: boolean }> {
  const res = await githubRequest(
    fetchImpl,
    `https://api.github.com/repos/${owner}/${repo}`,
    { headers },
  );
  assertRepositoryResponse(res, authenticated, owner, repo);
  const meta = await readJsonResponseBounded<{ default_branch?: string; private?: boolean }>(
    res,
    MAX_REPOSITORY_METADATA_BYTES,
    'GitHub repository metadata is too large to import safely.',
  );
  return {
    defaultBranch: meta.default_branch || 'main',
    private: meta.private === true,
  };
}

function assertRepositoryResponse(
  response: Response,
  authenticated: boolean,
  owner: string,
  repo: string,
): void {
  if (response.ok) return;
  if (isRateLimited(response)) {
    throw new SkillImportError('rate_limited', GITHUB_RATE_LIMITED);
  }
  if (response.status === 403 || response.status === 404) {
    throw new SkillImportError(
      authenticated ? 'repository_inaccessible' : 'access_candidate',
      REPOSITORY_NOT_FOUND,
    );
  }
  throw new SkillImportError('github_error', `GitHub returned ${response.status} for ${owner}/${repo}.`);
}

function isRateLimited(response: Response): boolean {
  return response.status === 429 ||
    response.headers.get('retry-after') !== null ||
    response.headers.get('x-ratelimit-remaining') === '0';
}

async function githubRequest(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const signal =
    init.signal ??
    (typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(SKILL_IMPORT_REQUEST_TIMEOUT_MS)
      : undefined);
  try {
    return await fetchImpl(input, { ...init, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (error instanceof SkillImportError) throw error;
    throw new SkillImportError(
      'github_error',
      'GitHub could not complete the skill import request. Try again.',
    );
  }
}

async function readJsonResponseBounded<T>(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<T> {
  if (!response.body) return await response.json() as T;
  const text = await readResponseTextBounded(response, maxBytes, tooLargeMessage);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SkillImportError('github_error', 'GitHub returned invalid skill import data.');
  }
}

async function readResponseTextBounded(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SkillImportError('source_too_large', tooLargeMessage);
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new SkillImportError('source_too_large', tooLargeMessage);
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SkillImportError('source_too_large', tooLargeMessage);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function encodeGithubPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}
