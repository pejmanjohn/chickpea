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
  if (ancestry.status !== 0) {
    fail('QA_SOURCE_BEHIND_MAIN', `Candidate must contain remote main ${approvedTip}. Rebase or move the intended changes onto that base before QA deployment; do not import another task's unmerged branch.`);
  }
  const source = sourceInputs(canonical);
  if (source.head !== head) fail('QA_SOURCE_CHANGED', 'HEAD changed during admission. Rerun from stable source.');
  const trackingTip = revision(canonical, `refs/remotes/${remote}/main`);
  return { schema: 'chickpea-qa-source-admission/v1', root: canonical, repository: expected,
    remote, reference, approvedTip, trackingTip, trackingMatchesRemote: trackingTip === approvedTip,
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
