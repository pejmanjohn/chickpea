import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as v from 'valibot';

import {
  isValidRepositoryGrantShape,
  REPOSITORY_GRANT_SHAPE_MESSAGE,
} from '../src/config/github-app.ts';
import { validateManagementOperations } from '../src/management/contracts.ts';
import {
  managementOperationValibotSchema,
  managementOperationZodSchema,
} from '../src/management/schemas.ts';
import type { ManagementActorContext, ManagementOperation } from '../src/management/types.ts';
import { ManagementError } from '../src/management/types.ts';
import { validEnabledRepositoryGrants } from '../src/sandbox/egress-handler.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

// The live v0.1.28 grant: allRepos with a repository fullName. The runtime
// dropped it, so the Agent silently lost all repository access.
const inconsistentAllRepos = {
  id: 'repo_163907068_pejmanjohn_tag_team_test_proj_5mdtrn',
  installationId: 163907068,
  accountLogin: 'pejmanjohn',
  fullName: 'pejmanjohn/tag-team-test-proj',
  allRepos: true,
  enabled: true,
};
const validAllRepos = {
  id: 'repo_163907068_all',
  installationId: 163907068,
  accountLogin: 'pejmanjohn',
  fullName: '',
  allRepos: true,
  enabled: true,
};
const validSingleRepo = {
  id: 'repo_163907068_one',
  installationId: 163907068,
  accountLogin: 'pejmanjohn',
  fullName: 'pejmanjohn/tag-team-test-proj',
  enabled: true,
};

function updateRepositories(repositories: unknown[]): ManagementOperation {
  return {
    itemId: 'repos',
    kind: 'update_agent',
    agentId: 'agent_coder',
    expectedRevision: 1,
    patch: { repositories },
  } as ManagementOperation;
}

const isShapeError = (error: unknown) =>
  error instanceof ManagementError &&
  error.code === 'invalid_request' &&
  error.message === REPOSITORY_GRANT_SHAPE_MESSAGE;

test('one predicate defines the repository grant shape', () => {
  assert.equal(isValidRepositoryGrantShape(inconsistentAllRepos), false);
  assert.equal(isValidRepositoryGrantShape(validAllRepos, { requireInstallation: true }), true);
  assert.equal(isValidRepositoryGrantShape(validSingleRepo, { requireInstallation: true }), true);
  assert.equal(isValidRepositoryGrantShape({ ...validSingleRepo, fullName: '' }), false);
  // Runtime policy-only copies carry no installation id; configured grants must.
  assert.equal(isValidRepositoryGrantShape({ ...validAllRepos, installationId: null }), true);
  assert.equal(
    isValidRepositoryGrantShape({ ...validAllRepos, installationId: null }, { requireInstallation: true }),
    false,
  );
  assert.match(REPOSITORY_GRANT_SHAPE_MESSAGE, /set fullName to "" and keep installationId/);
});

test('management schemas refuse allRepos with a repository fullName and name the fix', () => {
  const invalid = updateRepositories([inconsistentAllRepos]);
  const zod = managementOperationZodSchema.safeParse(invalid);
  assert.equal(zod.success, false);
  assert.ok(zod.error?.issues.some(({ message }) => message === REPOSITORY_GRANT_SHAPE_MESSAGE));
  const valibot = v.safeParse(managementOperationValibotSchema, invalid);
  assert.equal(valibot.success, false);
  assert.ok(valibot.issues?.some(({ message }) => message === REPOSITORY_GRANT_SHAPE_MESSAGE));

  for (const repositories of [[validAllRepos], [validSingleRepo], [validAllRepos, validSingleRepo]]) {
    const valid = updateRepositories(repositories);
    assert.equal(managementOperationZodSchema.safeParse(valid).success, true);
    assert.equal(v.safeParse(managementOperationValibotSchema, valid).success, true);
  }
  // A single-repository grant still needs a repository name.
  const unnamed = updateRepositories([{ ...validSingleRepo, fullName: '' }]);
  assert.equal(managementOperationZodSchema.safeParse(unnamed).success, false);
  assert.equal(v.safeParse(managementOperationValibotSchema, unnamed).success, false);
});

test('shared operation validation refuses the inconsistent grant for propose and apply', () => {
  assert.throws(() => validateManagementOperations([updateRepositories([inconsistentAllRepos])]), isShapeError);
  assert.throws(
    () => validateManagementOperations([updateRepositories([{ ...validAllRepos, installationId: null }])]),
    isShapeError,
  );
  assert.doesNotThrow(() =>
    validateManagementOperations([updateRepositories([validAllRepos, validSingleRepo])]));
});

test('stored inconsistent grants still load; the service refuses to write new ones', async () => {
  const f = await createManagementAdapterFixture('repository-grant-shape');
  const context: ManagementActorContext = {
    userId: f.admin.user.id,
    membershipId: f.admin.membership.id,
    organizationId: f.admin.membership.organizationId,
    origin: { kind: 'mcp', clientId: 'repository-grant-shape-client' },
  };
  try {
    const agent = await f.config.createAgent({
      id: 'agent_coder',
      name: 'Coder',
      instructions: 'Write code.',
      enabled: true,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [inconsistentAllRepos],
      creatorMembershipId: f.admin.membership.id,
      lifecycle: 'active',
      configurationGeneration: 1,
    });
    const loaded = await f.config.getAgent(agent.id);
    assert.deepEqual(loaded.repositories, [inconsistentAllRepos]);
    assert.deepEqual(validEnabledRepositoryGrants(loaded.repositories), []);

    await assert.rejects(
      () => f.service.applyWorkspaceChanges({
        context,
        idempotencyKey: 'inconsistent-all-repos',
        operations: [{
          ...updateRepositories([inconsistentAllRepos]),
          expectedRevision: loaded.revision,
        } as ManagementOperation],
      }),
      isShapeError,
    );

    const corrected = await f.service.applyWorkspaceChanges({
      context,
      idempotencyKey: 'corrected-all-repos',
      operations: [{
        ...updateRepositories([validAllRepos]),
        expectedRevision: loaded.revision,
      } as ManagementOperation],
    });
    assert.notEqual(corrected.status, 'failed');
    assert.ok(!('outcomes' in corrected) ||
      corrected.outcomes.every(({ code }) => code !== 'invalid_request'));
  } finally {
    f.close();
  }
});
