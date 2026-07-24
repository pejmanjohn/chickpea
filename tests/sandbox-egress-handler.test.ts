import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decideSandboxEgress,
  resolveRepositoryInstallationScope,
  type SandboxEgressDecision,
} from '../src/sandbox/egress-handler.ts';
import type { RepositoryGrant } from '../src/config/types.ts';

function repositoryGrant(overrides: Partial<RepositoryGrant> = {}): RepositoryGrant {
  return {
    id: 'repo-alpha',
    installationId: 50_001,
    accountLogin: 'Acme',
    fullName: 'Acme/Alpha',
    enabled: true,
    ...overrides,
  };
}

function allowedRepositories(decision: SandboxEgressDecision): string[] {
  assert.equal(decision.allowed, true);
  return decision.repositories;
}

test('sandbox GitHub egress identifies and enforces exact repository grants', () => {
  const grants = [repositoryGrant()];

  assert.deepEqual(
    allowedRepositories(
      decideSandboxEgress({
        url: 'https://api.github.com/repos/Acme/Alpha/contents/src/index.ts',
        method: 'GET',
        grants,
        allowedHosts: [],
      }),
    ),
    ['Acme/Alpha'],
  );
  assert.deepEqual(
    allowedRepositories(
      decideSandboxEgress({
        url: 'https://github.com/Acme/Alpha.git/info/refs?service=git-upload-pack',
        method: 'GET',
        grants,
        allowedHosts: [],
      }),
    ),
    ['Acme/Alpha'],
  );
  assert.equal(
    decideSandboxEgress({
      url: 'https://api.github.com/repos/Acme/Private/contents/README.md',
      method: 'GET',
      grants,
      allowedHosts: [],
    }).allowed,
    false,
  );
});

test('sandbox GitHub egress accepts account-wide grants without widening other accounts', () => {
  const grants = [
    repositoryGrant({
      id: 'all-acme',
      fullName: '',
      allRepos: true,
    }),
  ];

  assert.deepEqual(
    allowedRepositories(
      decideSandboxEgress({
        url: 'https://api.github.com/repos/acme/Beta/pulls',
        method: 'POST',
        grants,
        allowedHosts: [],
      }),
    ),
    ['acme/Beta'],
  );
  assert.equal(
    decideSandboxEgress({
      url: 'https://api.github.com/repos/Other/Beta/pulls',
      method: 'POST',
      grants,
      allowedHosts: [],
    }).allowed,
    false,
  );
});

test('sandbox GitHub egress denies protected Actions endpoints but keeps reruns', () => {
  const grants = [repositoryGrant()];
  const base = 'https://api.github.com/repos/Acme/Alpha';
  for (const url of [
    `${base}/dispatches`,
    `${base}/%64ispatches`,
    `${base}/actions/workflows/ci.yml/dispatches`,
    `${base}/actions/workflows/ci.yml/enable`,
    `${base}/actions/workflows/ci.yml/disable`,
    `${base}/actions/runs/7/approve`,
    `${base}/actions/runs/7/pending_deployments`,
    `${base}/actions/runs/7/pending_deployments/`,
    `${base}/actions/runs/7/deployment_protection_rule`,
  ]) {
    assert.equal(
      decideSandboxEgress({ url, method: 'POST', grants, allowedHosts: [] }).allowed,
      false,
      url,
    );
  }

  for (const url of [
    `${base}/actions/runs/7/rerun`,
    `${base}/actions/runs/7/rerun-failed-jobs`,
    `${base}/actions/runs/7/cancel`,
  ]) {
    assert.equal(
      decideSandboxEgress({ url, method: 'POST', grants, allowedHosts: [] }).allowed,
      true,
      url,
    );
  }
});

test('sandbox code search requires one q parameter and only granted repo qualifiers', () => {
  const grants = [repositoryGrant()];
  const granted = 'https://api.github.com/search/code?q=secret+repo%3AAcme%2FAlpha';

  assert.deepEqual(
    allowedRepositories(
      decideSandboxEgress({
        url: granted,
        method: 'GET',
        grants,
        allowedHosts: [],
      }),
    ),
    ['Acme/Alpha'],
  );
  assert.equal(
    decideSandboxEgress({
      url: `${granted}&q=secret+repo%3AAcme%2FPrivate`,
      method: 'GET',
      grants,
      allowedHosts: [],
    }).allowed,
    false,
  );
  assert.equal(
    decideSandboxEgress({
      url: 'https://api.github.com/search/code?q=secret',
      method: 'GET',
      grants,
      allowedHosts: [],
    }).allowed,
    false,
  );
  assert.equal(
    decideSandboxEgress({
      url: 'https://api.github.com/search/code?q=secret+repo%3AAcme%2FPrivate',
      method: 'GET',
      grants,
      allowedHosts: [],
    }).allowed,
    false,
  );
});

test('sandbox code search rejects GitHub query grammar that can widen repository scope', () => {
  const grants = [repositoryGrant()];
  const deniedQueries = [
    'needle repo:Acme/Alpha OR needle org:Other',
    '(repo:Other/Private OR repo:Acme/Alpha)',
    'needle repo:Acme/Alpha AND path:src',
    'needle repo:Acme/Alpha NOT language:markdown',
    'needle repo:Acme/Alpha user:Other',
    'needle repo:Acme/Alpha in:path',
    '(needle repo:Acme/Alpha)',
  ];

  for (const query of deniedQueries) {
    const decision = decideSandboxEgress({
      url: `https://api.github.com/search/code?q=${encodeURIComponent(query)}`,
      method: 'GET',
      grants,
      allowedHosts: [],
    });
    assert.equal(decision.allowed, false, query);
  }

  assert.deepEqual(
    allowedRepositories(
      decideSandboxEgress({
        url: `https://api.github.com/search/code?q=${encodeURIComponent(
          'needle exact phrase repo:Acme/Alpha',
        )}`,
        method: 'GET',
        grants,
        allowedHosts: [],
      }),
    ),
    ['Acme/Alpha'],
  );
});

test('sandbox token scope stays within one installation and names exact repositories', () => {
  const grants = [
    repositoryGrant(),
    repositoryGrant({
      id: 'repo-beta',
      fullName: 'Acme/Beta',
    }),
    repositoryGrant({
      id: 'all-other',
      installationId: 60_001,
      accountLogin: 'Other',
      fullName: '',
      allRepos: true,
    }),
  ];

  assert.deepEqual(resolveRepositoryInstallationScope(grants, ['Acme/Beta', 'Acme/Alpha']), {
    id: 50_001,
    repositories: ['Alpha', 'Beta'],
  });
  assert.deepEqual(resolveRepositoryInstallationScope(grants, ['Other/Private']), {
    id: 60_001,
    repositories: ['Private'],
  });
  assert.equal(
    resolveRepositoryInstallationScope(grants, ['Acme/Alpha', 'Other/Private']),
    undefined,
  );
});

test('sandbox package egress is limited to operator-enabled supported registries', () => {
  const allowedHosts = ['registry.npmjs.org', 'files.pythonhosted.org', 'packages.example.com'];

  for (const url of [
    'https://registry.npmjs.org/typescript',
    'https://files.pythonhosted.org/packages/example.whl',
  ]) {
    const decision = decideSandboxEgress({
      url,
      method: 'GET',
      grants: [],
      allowedHosts,
    });
    assert.equal(decision.allowed, true, url);
    assert.deepEqual(decision.repositories, []);
  }

  for (const url of [
    'https://pypi.org/simple/pytest/',
    'https://packages.example.com/private.tgz',
    'https://example.com/',
  ]) {
    assert.equal(
      decideSandboxEgress({
        url,
        method: 'GET',
        grants: [],
        allowedHosts,
      }).allowed,
      false,
      url,
    );
  }
});

test('sandbox egress rejects unsupported methods, plaintext URLs, and URL credentials', () => {
  const grants = [repositoryGrant()];
  for (const input of [
    {
      url: 'https://api.github.com/repos/Acme/Alpha',
      method: 'DELETE',
    },
    {
      url: 'http://api.github.com/repos/Acme/Alpha',
      method: 'GET',
    },
    {
      url: 'https://token@github.com/Acme/Alpha.git',
      method: 'GET',
    },
    {
      url: 'https://api.github.com:8443/repos/Acme/Alpha',
      method: 'GET',
    },
  ]) {
    assert.equal(
      decideSandboxEgress({ ...input, grants, allowedHosts: [] }).allowed,
      false,
      input.url,
    );
  }
});
