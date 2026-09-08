import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { validateReleaseManifest, STABLE_VERSION } from './release-manifest.mjs';
import { readBuildIdentity } from './build-identity.mjs';

const REPOSITORY = 'https://github.com/pejmanjohn/chickpea.git';
const API = 'https://api.github.com/repos/pejmanjohn/chickpea';
const SHA = /^[a-f0-9]{40}$/;
export function releaseTag(value) {
  if (typeof value !== 'string' || !value.startsWith('v') || !STABLE_VERSION.test(value.slice(1))) throw new Error('Use an exact stable application tag, such as v0.1.1.');
  return value;
}

async function github(path, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetchImpl(`${API}${path}`, { redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'chickpea-upgrade' } });
    if (!response.ok || !response.headers.get('content-type')?.includes('json') || !response.body) throw new Error('Official release lookup failed. Check network access and GitHub rate limits.');
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Official release response exceeded its size limit.'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new Error('Unable to verify the official release. No source was executed.'); }
  finally { clearTimeout(timer); controller.abort(); }
}

export async function resolveOfficialRelease(tag, { fetchImpl = fetch } = {}) {
  releaseTag(tag);
  const release = await github(`/releases/tags/${tag}`, fetchImpl);
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false || release.immutable !== true ||
      release.html_url !== `https://github.com/pejmanjohn/chickpea/releases/tag/${tag}` || !Number.isFinite(Date.parse(release.published_at))) {
    throw new Error('The requested release is not an immutable, published official application release.');
  }
  let object = (await github(`/git/ref/tags/${tag}`, fetchImpl)).object;
  for (let depth = 0; object?.type === 'tag' && depth < 5; depth++) {
    if (!SHA.test(object.sha)) throw new Error('Invalid official tag object.');
    object = (await github(`/git/tags/${object.sha}`, fetchImpl)).object;
  }
  if (object?.type !== 'commit' || !SHA.test(object.sha)) throw new Error('The official release tag did not resolve to one commit.');
  return { tag, version: tag.slice(1), commit: object.sha };
}

function git(root, args) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', ...args],
    { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Unable to fetch or verify the official release source. No dependency scripts were executed.');
  return result.stdout.trim();
}

export function verifyReleaseSource(root, release) {
  const identity = readBuildIdentity(root);
  if (identity.version !== release.version || identity.sourceCommit !== release.commit || git(root, ['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('Release source identity or clean-checkout verification failed.');
  }
  const manifest = validateReleaseManifest(root);
  return { ...release, manifest };
}

export function fetchReleaseSource(root, release) {
  releaseTag(release.tag);
  if (!SHA.test(release.commit) || release.version !== release.tag.slice(1)) throw new Error('Invalid resolved release identity.');
  mkdirSync(root, { mode: 0o700 });
  git(root, ['init', '--quiet']);
  git(root, ['fetch', '--quiet', '--depth=1', REPOSITORY, `refs/tags/${release.tag}`]);
  if (git(root, ['rev-parse', 'FETCH_HEAD^{commit}']) !== release.commit) throw new Error('Fetched release tag disagrees with the verified GitHub commit.');
  git(root, ['checkout', '--quiet', '--detach', release.commit]);
  return verifyReleaseSource(root, release);
}
