// Third-party skill import (capabilities plan, Phase 3). Resolves a pasted
// GitHub repo / skills.sh link into a list of importable skill candidates by
// reading SKILL.md files over the GitHub REST API + raw file host. Pure logic
// with an injected fetch so it runs identically on the Node and Cloudflare
// lanes and is unit-testable offline.

import { declaredContentLength, readBoundedText } from '../http/bounded-body.ts';
import { inspectSkillPackage, type SkillPackageInspection } from './skill-package.ts';
import { skillImportSource } from './skill-provenance.ts';
import type { SkillConfig } from './types.ts';

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
  /** Unescaped URL tail, retained until GitHub resolves the ref/path boundary. */
  refPath?: string;
  exactDocument?: boolean;
}

/** One importable skill discovered in a source. */
interface ResolvedSkillCandidate {
  name: string;
  description: string;
  instructions: string;
  /** The skill directory carries executable scripts that will not run here. */
  hasScripts: boolean;
  inspection?: SkillPackageInspection;
  /** Directory path within the repo (for display + de-duplication). */
  path: string;
  /** Provenance link back to the skill's directory on GitHub. */
  sourceUrl: string;
  importSource?: NonNullable<SkillConfig['importSource']>;
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

interface SkillResolutionAccess {
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
const MAX_GITHUB_DIRECTORY_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_DOCUMENT_BYTES = 512 * 1024;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKIP_DIR_RE = /(^|\/)(tests?|node_modules|\.git|dist|build|__pycache__|fixtures)(\/|$)/;
const MAX_PACKAGE_ENTRIES = 2000;
const MAX_PACKAGE_DEPTH = 8;
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
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  let segments: string[];
  try { segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  if (segments.some((part) => part === '.' || part === '..' || part.includes('\\'))) return null;

  if (host === 'github.com' || host === 'raw.githubusercontent.com') {
    if (segments.length < 2) return null;
    const owner = segments[0]!;
    const repo = stripGitSuffix(segments[1]!);
    const raw = host === 'raw.githubusercontent.com';
    if (!raw && segments.length === 2) return { owner, repo };
    const kind = raw ? 'blob' : segments[2];
    const refIndex = raw ? 2 : 3;
    const ref = segments[refIndex];
    if (!ref || (kind !== 'tree' && kind !== 'blob')) return null;
    const pathParts = segments.slice(refIndex + 1);
    if (kind === 'blob' && pathParts.pop() !== 'SKILL.md') return null;
    const skillPath = pathParts.join('/');
    return {
      owner, repo, ref,
      ...(kind === 'blob' ? { exactDocument: true } : {}),
      ...(skillPath ? { skillPath } : {}),
      ...(!/^[0-9a-f]{40,64}$/i.test(ref) && !ref.includes('/') && skillPath
        ? { refPath: `${ref}/${skillPath}` } : {}),
    };
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
  mode?: string;
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
  fetchImpl = budgetedFetch(fetchImpl);
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
  let ref = parsed.ref ?? metadata?.defaultBranch ?? 'main';
  const visibility = metadata?.private ? 'private' : 'public';

  // A public tree URL already identifies one directory. Inspect that bounded
  // directory page directly instead of downloading the repository's complete
  // recursive tree, which avoids anonymous API quota and keeps the common
  // Slack import path fast even for very large repositories.
  if (!authenticated && parsed.ref && parsed.skillPath) {
    try {
      return await resolveExactPublicSkillFromGithubPage({
        ...parsed,
        ref: parsed.ref,
        skillPath: parsed.skillPath,
      }, fetchImpl);
    } catch (error) {
      if (!(error instanceof SkillImportError) || error.code !== 'not_exact_skill_directory') {
        throw error;
      }
      if (error instanceof ParentSkillDirectoryError) {
        parsed = error.source;
        ref = parsed.ref!;
      }
      // A parent directory still honors the documented multi-candidate path.
      // Continue to the bounded recursive tree scan below.
    }
  }

  if (parsed.refPath && !/^[0-9a-f]{40,64}$/i.test(ref)) {
    parsed = await resolveUrlRefBoundary(parsed, fetchImpl, headers, authenticated);
    ref = parsed.ref!;
  }
  if (!/^[0-9a-f]{40,64}$/i.test(ref)) {
    const commitRes = await githubRequest(fetchImpl,
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, { headers });
    assertRepositoryResponse(commitRes, authenticated, owner, repo);
    const commit = await readJsonResponseBounded<{ sha?: string }>(commitRes, MAX_REPOSITORY_METADATA_BYTES, 'GitHub commit metadata is too large.');
    if (!commit.sha || !/^[0-9a-f]{40,64}$/i.test(commit.sha)) throw new SkillImportError('github_error', 'GitHub did not resolve an immutable commit for this source.');
    ref = commit.sha;
  }

  const treeRes = await githubRequest(
    fetchImpl,
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { headers },
  );
  assertRepositoryResponse(treeRes, authenticated, owner, repo);
  const tree = await readJsonResponseBounded<{ tree?: GitTreeEntry[]; truncated?: boolean }>(
    treeRes,
    MAX_REPOSITORY_TREE_BYTES,
    'GitHub repository tree is too large to import safely. Use a direct skill-directory URL.',
  );
  if (tree.truncated || !Array.isArray(tree.tree)) {
    throw new SkillImportError('incomplete_inspection', 'GitHub returned an incomplete repository tree. Use an exact skill-directory URL.');
  }
  const blobs = tree.tree.filter((entry) => entry.type === 'blob');

  const scopedDirs = blobs
    .filter((entry) => entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md'))
    .map((entry) => ({ path: entry.path, dir: entry.path.replace(/\/?SKILL\.md$/, '') }))
    .filter((entry) => !SKIP_DIR_RE.test(entry.path))
    .filter((entry) => parsed.exactDocument ? entry.dir === (parsed.skillPath ?? '') : parsed.skillPath
      ? entry.dir === parsed.skillPath || entry.dir.startsWith(`${parsed.skillPath}/`)
      : true)
    ;
  const canonicalDirs = parsed.skillFilter ? scopedDirs.filter((entry) => basename(entry.dir) === parsed.skillFilter) : scopedDirs;
  const searchingDeclaredNames = Boolean(parsed.skillFilter && canonicalDirs.length === 0);
  const skillDirs = searchingDeclaredNames ? scopedDirs : canonicalDirs;

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
    assertDocumentResponse(rawRes, authenticated, owner, repo, entry.path);
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
    const packageEntries = tree.tree.filter(({ path }) => !entry.dir || path.startsWith(`${entry.dir}/`));
    assertPackageBounds(entry.dir, packageEntries);
    const inspection = inspectSkillPackage(entry.dir, packageEntries);
    const hasScripts = inspection.scriptPaths.length > 0;
    if (parsed.skillFilter && name !== parsed.skillFilter) {
      skipped += 1;
      continue;
    }
    const importSource = skillImportSource(`${owner}/${repo}`, ref, entry.dir, { name, description, instructions });
    skills.push({
      name,
      description,
      instructions,
      hasScripts,
      inspection,
      path: entry.dir,
      sourceUrl: `https://github.com/${owner}/${repo}/tree/${ref}/${entry.dir}`,
      ...(importSource ? { importSource } : {}),
    });
  }

  if (parsed.skillFilter && total > scan.length) {
    throw new SkillImportError('incomplete_search', 'The skill-name search reached its 40-document limit. Use the exact skill-directory URL; matching or duplicate skills may remain uninspected.');
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

interface GithubDirectoryItem {
  name?: string;
  path?: string;
  contentType?: string;
  mode?: string;
}

/**
 * GitHub's anonymous REST quota is shared by many Worker invocations. A tree
 * URL already names one exact public directory, so inspect the public
 * directory page plus raw SKILL.md without spending that quota. The inspected
 * commit OID, not the mutable branch name, pins the imported bytes. The
 * embedded directory listing also preserves the packaged-script check; if the
 * page is incomplete, fail closed instead of guessing about sibling content.
 */
async function resolveExactPublicSkillFromGithubPage(
  parsed: ParsedSkillSource & { ref: string; skillPath: string },
  fetchImpl: typeof fetch,
): Promise<SkillResolution> {
  const { owner, repo, ref } = parsed;
  let skillPath = parsed.skillPath;
  const requestedSourceUrl = `https://github.com/${owner}/${repo}/tree/${encodeURIComponent(ref)}/${encodeGithubPath(skillPath)}`;
  const pageRes = await githubRequest(fetchImpl, requestedSourceUrl, {
    headers: { 'user-agent': 'chickpea-skill-import' },
  });
  assertRepositoryResponse(pageRes, false, owner, repo);
  const html = await readResponseTextBounded(
    pageRes,
    MAX_GITHUB_DIRECTORY_PAGE_BYTES,
    'GitHub skill directory is too large to import safely.',
  );
  const embedded = html.match(
    /<script\b[^>]*data-target=["']react-app\.embeddedData["'][^>]*>([\s\S]*?)<\/script>/i,
  )?.[1];
  let route: {
    path?: string;
    refInfo?: { name?: string; currentOid?: string };
    tree?: { items?: GithubDirectoryItem[]; totalCount?: number };
  } | undefined;
  try {
    route = embedded
      ? JSON.parse(embedded)?.payload?.codeViewTreeRoute
      : undefined;
  } catch {
    route = undefined;
  }
  const items = route?.tree?.items;
  const refMatches = route?.refInfo?.name === ref || (/^[0-9a-f]{7,64}$/i.test(ref) && route?.refInfo?.currentOid?.startsWith(ref));
  const boundaryMatches = parsed.refPath && route?.refInfo?.name && route.path !== undefined &&
    `${route.refInfo.name}/${route.path}` === parsed.refPath;
  if (!route || !(boundaryMatches || (route.path === skillPath && refMatches)) || !Array.isArray(items)) {
    throw new SkillImportError(
      'incomplete_inspection',
      'GitHub did not return a complete listing for the requested path and revision.',
    );
  }
  if (route.tree?.totalCount !== undefined && route.tree.totalCount !== items.length) {
    throw new SkillImportError(
      'source_too_large',
      'GitHub skill directory could not be inspected completely. Use Admin to review this source.',
    );
  }

  skillPath = route.path!;
  parsed = { ...parsed, skillPath };
  const skillDocumentPath = `${skillPath}/SKILL.md`;
  const hasSkillDocument = items.some(
    (item) => item.path === skillDocumentPath && item.contentType === 'file',
  );
  if (!hasSkillDocument) {
    if (parsed.exactDocument) throw new SkillImportError('document_not_found', `GitHub could not find ${skillDocumentPath} at the selected revision.`);
    throw new ParentSkillDirectoryError({ ...parsed, ref: route.refInfo?.currentOid ?? ref, skillPath });
  }
  const resolvedRef = route.refInfo?.currentOid;
  if (!resolvedRef || !/^[0-9a-f]{40,64}$/i.test(resolvedRef)) {
    throw new SkillImportError(
      'github_error',
      'GitHub did not provide immutable provenance for this skill. Try again.',
    );
  }
  const sourceUrl = `https://github.com/${owner}/${repo}/tree/${resolvedRef}/${encodeGithubPath(skillPath)}`;
  const entries = await inspectPublicDirectories(parsed, resolvedRef, items, fetchImpl);
  const inspection = inspectSkillPackage(skillPath, entries);
  const hasScripts = inspection.scriptPaths.length > 0;
  const rawRes = await githubRequest(
    fetchImpl,
    `https://raw.githubusercontent.com/${owner}/${repo}/${resolvedRef}/${encodeGithubPath(skillDocumentPath)}`,
  );
  assertDocumentResponse(rawRes, false, owner, repo, skillDocumentPath);
  const markdown = await readResponseTextBounded(
    rawRes,
    MAX_SKILL_DOCUMENT_BYTES,
    'GitHub skill document is too large to import safely.',
  );
  const front = parseFrontmatter(markdown);
  const name = sanitizeSkillName(front.name || basename(skillPath));
  const description = (front.description || '').trim().slice(0, MAX_DESCRIPTION);
  const instructions = (front.body || markdown).trim().slice(0, MAX_INSTRUCTIONS);
  if (!name || !description || !instructions) {
    return exactPublicSkillResolution({ ...parsed, ref: resolvedRef }, [], 1, 1);
  }
  return exactPublicSkillResolution({ ...parsed, ref: resolvedRef }, [{
    name,
    description,
    instructions,
    hasScripts,
    inspection,
    path: skillPath,
    sourceUrl,
    importSource: skillImportSource(`${owner}/${repo}`, resolvedRef, skillPath, { name, description, instructions })!,
  }], 1, 0);
}

function exactPublicSkillResolution(
  parsed: ParsedSkillSource & { ref: string; skillPath: string },
  skills: ResolvedSkillCandidate[],
  total: number,
  skipped: number,
): SkillResolution {
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    ref: parsed.ref,
    source: { visibility: 'public', access: 'anonymous' },
    skills,
    total,
    capped: false,
    skipped,
  };
}

class ParentSkillDirectoryError extends SkillImportError {
  constructor(readonly source: ParsedSkillSource) {
    super('not_exact_skill_directory', 'The selected directory contains multiple possible skill directories.');
  }
}

async function resolveUrlRefBoundary(parsed: ParsedSkillSource, fetchImpl: typeof fetch,
  headers: Record<string, string>, authenticated: boolean): Promise<ParsedSkillSource> {
  const names: string[] = [];
  for (const namespace of ['heads', 'tags']) {
    const response = await githubRequest(fetchImpl,
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/matching-refs/${namespace}/${encodeURIComponent(parsed.ref!)}`, { headers });
    assertRepositoryResponse(response, authenticated, parsed.owner, parsed.repo);
    const refs = await readJsonResponseBounded<Array<{ ref?: string }>>(response, MAX_REPOSITORY_METADATA_BYTES, 'GitHub ref listing is too large. Use an immutable commit URL.');
    if (!Array.isArray(refs)) throw new SkillImportError('ambiguous_ref', 'GitHub could not resolve the URL revision and path. Use an immutable commit URL.');
    for (const entry of refs) {
      const name = entry.ref?.startsWith(`refs/${namespace}/`) ? entry.ref.slice(`refs/${namespace}/`.length) : undefined;
      if (name && (parsed.refPath === name || parsed.refPath?.startsWith(`${name}/`))) names.push(name);
    }
  }
  if (names.length !== 1) throw new SkillImportError('ambiguous_ref', 'The URL revision/path is missing or ambiguous. Use an immutable commit URL or an explicitly encoded branch name.');
  return { ...parsed, ref: names[0]!, skillPath: parsed.refPath!.slice(names[0]!.length + 1) };
}

function assertPackageBounds(directory: string, entries: GitTreeEntry[]): void {
  if (entries.length > MAX_PACKAGE_ENTRIES || entries.some(({ path }) =>
    path.slice(directory ? directory.length + 1 : 0).split('/').length > MAX_PACKAGE_DEPTH + 1)) {
    throw new SkillImportError('incomplete_inspection', 'Skill package exceeds the inspection limit (2000 entries or 8 directory levels).');
  }
}

async function inspectPublicDirectories(
  parsed: ParsedSkillSource & { skillPath: string },
  commit: string,
  initial: GithubDirectoryItem[],
  fetchImpl: typeof fetch,
): Promise<GitTreeEntry[]> {
  const entries: GitTreeEntry[] = [];
  const queue = [{ path: parsed.skillPath, items: initial }];
  for (let index = 0; index < queue.length; index++) {
    if (index >= 12) throw new SkillImportError('incomplete_inspection', 'Skill package exceeds the 12-directory inspection limit.');
    const directory = queue[index]!;
    const seen = new Set<string>();
    for (const item of directory.items) {
      const prefix = directory.path ? `${directory.path}/` : '';
      if (!item.path?.startsWith(prefix) || item.path.slice(prefix.length).includes('/') ||
          !item.path.slice(prefix.length) || /(?:^|\/)(?:\.|\.\.)(?:\/|$)/.test(item.path) || seen.has(item.path)) {
        throw new SkillImportError('incomplete_inspection', 'GitHub returned an invalid skill directory listing.');
      }
      seen.add(item.path);
      entries.push({ path: item.path, type: item.contentType === 'directory' ? 'tree' : item.contentType === 'file' ? 'blob' : 'unknown',
        ...(item.mode ? { mode: item.mode } : {}) });
      assertPackageBounds(parsed.skillPath, entries);
      if (item.contentType !== 'directory') continue;
      if (queue.length >= 12) throw new SkillImportError('incomplete_inspection', 'Skill package exceeds the 12-directory inspection limit.');
      const response = await githubRequest(fetchImpl,
        `https://github.com/${parsed.owner}/${parsed.repo}/tree/${commit}/${encodeGithubPath(item.path)}`);
      assertDocumentResponse(response, false, parsed.owner, parsed.repo, item.path);
      const html = await readResponseTextBounded(response, MAX_GITHUB_DIRECTORY_PAGE_BYTES, 'GitHub skill directory is too large to inspect.');
      const embedded = html.match(/<script\b[^>]*data-target=["']react-app\.embeddedData["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
      let route;
      try { route = embedded ? JSON.parse(embedded)?.payload?.codeViewTreeRoute : undefined; } catch { /* rejected below */ }
      if (route?.path !== item.path || route?.refInfo?.currentOid !== commit || !Array.isArray(route?.tree?.items) ||
          (route.tree.totalCount !== undefined && route.tree.totalCount !== route.tree.items.length)) {
        throw new SkillImportError('incomplete_inspection', `Could not completely inspect ${item.path} at the selected commit.`);
      }
      queue.push({ path: item.path, items: route.tree.items });
    }
  }
  return entries;
}

function assertDocumentResponse(response: Response, authenticated: boolean, owner: string, repo: string, path: string): void {
  if (response.status === 404 && !authenticated) {
    throw new SkillImportError('document_not_found', `GitHub could not find ${path} at the selected revision.`);
  }
  assertRepositoryResponse(response, authenticated, owner, repo);
}

/** One budget covers discovery, parent fallback and every package read. */
function budgetedFetch(fetchImpl: typeof fetch): typeof fetch {
  let requests = 0;
  let bytes = 0;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (++requests > 46) throw new SkillImportError('incomplete_inspection', 'Skill import reached its 46-request inspection limit. Use an exact skill-directory URL.');
    const response = await fetchImpl(input, init);
    // Count actual streamed bytes across all responses, not only Content-Length.
    if (!response.body) return response;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > 24 * 1024 * 1024) throw new SkillImportError('incomplete_inspection', 'Skill import reached its total inspection byte limit.');
        controller.enqueue(chunk);
      },
    }));
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }) as typeof fetch;
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
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new SkillImportError(
      authenticated ? 'repository_inaccessible' : 'access_candidate',
      REPOSITORY_NOT_FOUND,
    );
  }
  throw new SkillImportError('github_error', `GitHub returned ${response.status} for ${owner}/${repo}.`);
}

function isRateLimited(response: Response): boolean {
  return response.status === 429 ||
    Boolean(response.headers?.get('retry-after')) ||
    response.headers?.get('x-ratelimit-remaining') === '0';
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
  const tooLarge = () => new SkillImportError('source_too_large', tooLargeMessage);
  if (!response.body) {
    const declaredLength = declaredContentLength(response.headers);
    if (declaredLength !== undefined && declaredLength > maxBytes) throw tooLarge();
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw tooLarge();
    return text;
  }
  return readBoundedText(response, { maxBytes, onOversize: tooLarge });
}

function encodeGithubPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}
