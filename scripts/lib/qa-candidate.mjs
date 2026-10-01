import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sourceInputs } from './verification-inputs.mjs';

export class QaCandidateError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.code = code; }
}
const fail = (code, message) => { throw new QaCandidateError(code, message); };
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const DEFAULT_SOURCE_REPOSITORY = 'pejmanjohn/chickpea';
const REPOSITORY_IDENTITY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/u;

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'] });
}
function revision(root, ref) {
  const result = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const value = result.stdout?.trim();
  return result.status === 0 && SHA.test(value) ? value : null;
}
function repository(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(?:git\+)?https:\/\/github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/u)
    ?? value.match(/^git@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/u)
    ?? value.match(/^ssh:\/\/git@github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?$/u);
  return match?.[1].toLowerCase() ?? null;
}

function expectedRepository(options) {
  const configured = (options.env ?? process.env).CHICKPEA_QA_SOURCE_REPOSITORY
    ?? DEFAULT_SOURCE_REPOSITORY;
  if (typeof configured !== 'string' || !REPOSITORY_IDENTITY.test(configured)) {
    fail('QA_SOURCE_REPOSITORY_INVALID', 'Configure the QA source repository as an owner/repository identity.');
  }
  return configured.toLowerCase();
}

/** No fetch, checkout, claim, provider call, or mutation of Git refs. */
export function admitQaCandidate(root, options = {}) {
  const canonical = realpathSync(resolve(root));
  const top = git(canonical, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== canonical) {
    fail('QA_SOURCE_CHECKOUT_REQUIRED', 'Use the canonical candidate checkout root.');
  }
  const remote = options.remote ?? process.env.CHICKPEA_QA_SOURCE_REMOTE ?? 'origin';
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(remote)) fail('QA_SOURCE_REMOTE_INVALID', 'Choose a configured remote name.');
  const reference = 'refs/heads/main';
  const url = git(canonical, ['remote', 'get-url', remote]);
  const declared = JSON.parse(readFileSync(join(canonical, 'package.json'), 'utf8')).repository;
  const expected = expectedRepository(options);
  if (repository(typeof declared === 'string' ? declared : declared?.url) !== expected) {
    fail('QA_SOURCE_REPOSITORY_MISMATCH', 'The candidate package repository must match the registered QA source repository.');
  }
  if (url.status !== 0 || repository(url.stdout.trim()) !== expected) {
    fail('QA_SOURCE_REMOTE_MISMATCH', 'The selected remote must identify the registered QA source repository. Use its registered remote for a fork.');
  }
  // Injection is an in-process test seam, never an argv/env bypass or saved receipt.
  const observation = options.observeRemote
    ? options.observeRemote({ root: canonical, remote, reference })
    : git(canonical, ['ls-remote', '--exit-code', remote, reference]);
  const match = observation.stdout?.trim().match(/^([a-f0-9]{40}(?:[a-f0-9]{24})?)\s+refs\/heads\/main$/u);
  if (observation.status !== 0 || !match) {
    fail('QA_SOURCE_REMOTE_UNAVAILABLE', 'Could not observe the remote main tip. Retain the pending work and retry when remote access is available; no stale tracking-ref fallback.');
  }
  const approvedTip = match[1];
  if (!revision(canonical, approvedTip)) {
    fail('QA_SOURCE_TIP_NOT_FETCHED', `Remote main ${approvedTip} is not in the local object store. Fetch ${remote}, then rerun admission.`);
  }
  const head = revision(canonical, 'HEAD');
  const ancestry = git(canonical, ['merge-base', '--is-ancestor', approvedTip, head ?? 'HEAD']);
  let releaseTag = null;
  if (ancestry.status !== 0) {
    // A published release stays verifiable after main moves on: the candidate
    // must be exactly the tagged commit, and that commit must be on remote main.
    if (options.releaseTag === undefined) {
      fail('QA_SOURCE_BEHIND_MAIN', `Candidate must contain remote main ${approvedTip}. Rebase or move the intended changes onto that base before QA deployment; do not import another task's unmerged branch. To verify a published release as tagged, deploy its tag with --release-tag <tag>.`);
    }
    if (!RELEASE_TAG.test(options.releaseTag)) fail('QA_RELEASE_TAG_INVALID', 'Name a release tag such as v0.1.33.');
    const tagged = revision(canonical, `refs/tags/${options.releaseTag}`);
    if (!tagged || tagged !== head) {
      fail('QA_RELEASE_TAG_MISMATCH', `HEAD must be the commit tagged ${options.releaseTag}. Check the tag out on a branch (git switch -c verify-${options.releaseTag} ${options.releaseTag}) and claim from there.`);
    }
    if (git(canonical, ['merge-base', '--is-ancestor', head, approvedTip]).status !== 0) {
      fail('QA_RELEASE_TAG_NOT_ON_MAIN', `${options.releaseTag} is not on remote main ${approvedTip}; only a release cut from main is admitted this way.`);
    }
    // A local tag proves nothing: anyone can tag an old main commit. Observe
    // the published tag (peeled, when annotated) and require it to be HEAD.
    const tagRef = `refs/tags/${options.releaseTag}`;
    const published = options.observeRemote
      ? options.observeRemote({ root: canonical, remote, reference: tagRef })
      : git(canonical, ['ls-remote', '--exit-code', '--tags', remote, tagRef, `${tagRef}^{}`]);
    const lines = published.status === 0 ? published.stdout.trim().split('\n')
      .map((line) => line.match(/^([a-f0-9]{40}(?:[a-f0-9]{24})?)\s+(\S+)$/u)).filter(Boolean) : [];
    const publishedCommit = (lines.find((m) => m[2] === `${tagRef}^{}`) ?? lines.find((m) => m[2] === tagRef))?.[1];
    if (!publishedCommit) {
      fail('QA_RELEASE_TAG_UNPUBLISHED', `${options.releaseTag} is not published on ${remote}; only a pushed release tag is admitted.`);
    }
    if (publishedCommit !== head) {
      fail('QA_RELEASE_TAG_MISMATCH', `${remote} publishes ${options.releaseTag} at ${publishedCommit}, not HEAD ${head}. Fetch the tag and check it out again.`);
    }
    releaseTag = options.releaseTag;
  }
  const source = sourceInputs(canonical);
  if (source.head !== head) fail('QA_SOURCE_CHANGED', 'HEAD changed during admission. Rerun from stable source.');
  if (releaseTag && source.dirty) {
    fail('QA_RELEASE_TAG_DIRTY', `The working tree has changes, so it is not ${releaseTag}. Commit or discard them, or verify them as an ordinary candidate.`);
  }
  const trackingTip = revision(canonical, `refs/remotes/${remote}/main`);
  return { schema: 'chickpea-qa-source-admission/v1', root: canonical, repository: expected,
    remote, reference, approvedTip, ...(releaseTag ? { releaseTag } : {}), trackingTip, trackingMatchesRemote: trackingTip === approvedTip,
    observedAt: new Date().toISOString(), source,
    coverage: 'Source ancestry and working contents only; claim, install, schema and runtime fences still apply. No live acceptance.' };
}

export function recheckQaCandidate(admission) {
  if (admission?.schema !== 'chickpea-qa-source-admission/v1') fail('QA_SOURCE_ADMISSION_REQUIRED', 'Obtain fresh QA source admission.');
  const current = sourceInputs(admission.root);
  if (current.head !== admission.source.head || current.tree !== admission.source.tree) {
    fail('QA_SOURCE_CHANGED', 'Candidate contents changed after admission/build. Preserve any deployment intent and reconcile it before a new build or upload.');
  }
  return current;
}
