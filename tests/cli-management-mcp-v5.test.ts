import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import { FakeDeployment, fakeBrowser } from '../packages/cli/tests/helpers/fake-deployment.ts';
import { runCli, temporaryStore } from '../packages/cli/tests/helpers/run-cli.ts';
import { createFixtureAgent, createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

test('CLI commands use Core 5.0 over local HTTP, including refusals and validation', async (t) => {
  const f = await createManagementAdapterFixture('cli_v5');
  t.after(() => f.close());
  await createFixtureAgent(f, 'agent_research');
  await createFixtureAgent(f, 'agent_retired', { name: 'Retired', lifecycle: 'archived', enabled: false });
  const deployment: FakeDeployment = new FakeDeployment({
    createMcpServer: () => createWorkspaceManagementMcpServer({
      principal: {
        betterAuthUserId: f.owner.binding.betterAuthUserId!,
        userId: f.owner.user.id,
        membershipId: f.owner.membership.id,
        organizationId: f.owner.membership.organizationId,
        role: 'owner',
        clientId: 'cli_v5',
      },
      service: f.service,
      baseUrl: deployment.url,
    }),
  });
  await deployment.start();
  t.after(() => deployment.stop());
  const store = temporaryStore();
  const login = await runCli(['login', deployment.url], { store, openBrowser: fakeBrowser, loginTimeoutMs: 10_000 });
  assert.equal(login.code, 0, login.stderr);
  const command = (args: string[], readBytes?: () => Uint8Array) => runCli(args, { store, ...(readBytes ? { readBytes } : {}) });

  const inspect = await command(['workspace', 'inspect', deployment.url, '--json']);
  assert.equal(inspect.code, 0, inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).workspace.you.role, 'owner');
  const listed = (stdout: string) => (JSON.parse(stdout).agents as Array<{ agentId: string }>).map(({ agentId }) => agentId);
  assert.ok(listed(inspect.stdout).includes('agent_research'));
  // A Core with list_agents paging (#761) leaves archived Agents out by default; an older one lists them.
  const pages = JSON.parse(inspect.stdout).archivedLeftOut === true;
  assert.equal(listed(inspect.stdout).includes('agent_retired'), !pages);
  const withArchived = await command(['workspace', 'inspect', deployment.url, '--include-archived', '--json']);
  assert.equal(withArchived.code, 0, withArchived.stderr);
  assert.deepEqual(listed(withArchived.stdout).sort(), ['agent_research', 'agent_retired']);
  assert.equal(JSON.parse(withArchived.stdout).archivedLeftOut, undefined);

  const exported = await command(['recipe', 'export', deployment.url, '--agents', 'agent_research']);
  assert.equal(exported.code, 0, exported.stderr);
  assert.equal(JSON.parse(exported.stdout).schemaVersion, 2);
  assert.equal(JSON.parse(exported.stdout).agents.length, 1);

  const preview = await command(['recipe', 'preview', deployment.url, 'unused.json']);
  assert.equal(preview.code, 1);
  assert.match(preview.stderr, /removed.*create_agent and update_agent/);

  const skill = (body: string) => () => Buffer.from(`---\nname: alpha\ndescription: A synthetic test skill.\n---\n${body}\n`);
  const uploadArgs = ['skills', 'upload', deployment.url, 'agent_research', 'SKILL.md'];
  const uploaded = await command([...uploadArgs, '--json'], skill('First instructions.'));
  assert.equal(uploaded.code, 0, uploaded.stderr);
  assert.deepEqual(JSON.parse(uploaded.stdout)[0].result.added, ['alpha']);
  assert.equal((await f.config.getAgent('agent_research'))?.skills[0]?.name, 'alpha');

  const conflict = await command(uploadArgs, skill('Changed instructions.'));
  assert.equal(conflict.code, 0, conflict.stderr);
  assert.match(conflict.stderr, /To replace alpha, run the same command with --replace/);
  const replaced = await command([...uploadArgs, '--replace', '--json'], skill('Changed instructions.'));
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.deepEqual(JSON.parse(replaced.stdout)[0].result.replaced, ['alpha']);

  const refused = await command(['call', deployment.url, 'get_agent', '--args', '{"agentId":"agent_missing"}']);
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.stdout).error.code, 'not_found');
  assert.equal(typeof JSON.parse(refused.stdout).error.message, 'string');
  const invalid = await command(['call', deployment.url, 'get_agent']);
  assert.equal(invalid.code, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'invalid_input');
  assert.equal(JSON.parse(invalid.stdout).error.message, 'Chickpea did not accept that request.');
});
