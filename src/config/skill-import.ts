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
  skills: ResolvedSkillCandidate[];
  /** Total SKILL.md directories found (before the scan cap). */
  total: number;
  /** True when more skills exist than were scanned (see MAX_SCANNED_SKILLS). */
  capped: boolean;
  /** Skills found but skipped because a required field was missing/invalid. */
  skipped: number;
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
const MAX_DESCRIPTION = 1024;
const MAX_INSTRUCTIONS = 100_000;
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKIP_DIR_RE = /(^|\/)(tests?|node_modules|\.git|dist|build|__pycache__|fixtures)(\/|$)/;
const SCRIPT_EXT_RE = /\.(sh|py|js|mjs|cjs|ts|rb|bash|zsh)$/i;

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
    // .../tree/<ref>/<path...> pins a branch/tag.
    if (segments[2] === 'tree' && segments[3]) {
      return { owner, repo, ref: segments[3] };
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
 * Resolve a parsed source into importable skill candidates. Costs
 * 2 + min(N, MAX_SCANNED_SKILLS) subrequests. `token` (a GitHub PAT) is
 * optional; when present it raises rate limits and reaches private repos.
 */
export async function resolveSkillSource(
  parsed: ParsedSkillSource,
  fetchImpl: typeof fetch,
  token?: string,
): Promise<SkillResolution> {
  const { owner, repo } = parsed;
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'chickpea-skill-import',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

  const ref = parsed.ref ?? (await fetchDefaultBranch(owner, repo, fetchImpl, headers));

  const treeRes = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    { headers },
  );
  if (treeRes.status === 404) {
    throw new SkillImportError('not_found', `Could not read ${owner}/${repo} at ${ref}.`);
  }
  if (treeRes.status === 403) {
    throw new SkillImportError('rate_limited', 'GitHub rate limit hit. Add a GITHUB_TOKEN or try later.');
  }
  if (!treeRes.ok) {
    throw new SkillImportError('github_error', `GitHub returned ${treeRes.status} for ${owner}/${repo}.`);
  }
  const tree = (await treeRes.json()) as { tree?: GitTreeEntry[] };
  const blobs = (tree.tree ?? []).filter((entry) => entry.type === 'blob');

  const skillDirs = blobs
    .filter((entry) => entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md'))
    .map((entry) => ({ path: entry.path, dir: entry.path.replace(/\/?SKILL\.md$/, '') }))
    .filter((entry) => !SKIP_DIR_RE.test(entry.path))
    .filter((entry) =>
      parsed.skillFilter ? basename(entry.dir) === parsed.skillFilter : true,
    );

  const total = skillDirs.length;
  const scan = skillDirs.slice(0, MAX_SCANNED_SKILLS);

  const skills: ResolvedSkillCandidate[] = [];
  let skipped = 0;
  for (const entry of scan) {
    const rawRes = await fetchImpl(
      `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${entry.path}`,
      token ? { headers: { authorization: `Bearer ${token}` } } : undefined,
    );
    if (!rawRes.ok) {
      skipped += 1;
      continue;
    }
    const md = await rawRes.text();
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

  return { owner, repo, ref, skills, total, capped: total > scan.length, skipped };
}

async function fetchDefaultBranch(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): Promise<string> {
  const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (res.status === 404) {
    throw new SkillImportError('not_found', `Repository ${owner}/${repo} was not found.`);
  }
  if (res.status === 403) {
    throw new SkillImportError('rate_limited', 'GitHub rate limit hit. Add a GITHUB_TOKEN or try later.');
  }
  if (!res.ok) {
    throw new SkillImportError('github_error', `GitHub returned ${res.status} for ${owner}/${repo}.`);
  }
  const meta = (await res.json()) as { default_branch?: string };
  return meta.default_branch || 'main';
}

function basename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}
