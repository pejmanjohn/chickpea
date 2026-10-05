import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import ts from 'typescript';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  resolveModelCredentialAttribution,
  rotateInstallationModelCredential,
} from '../src/config/model-credential-refs.ts';
import { SettingsStoreLogic, type SettingsStore } from '../src/config/settings-store.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { createLiveWorkspaceManagementService } from '../src/management/live-service.ts';
import {
  invokeSlackWorkspaceManagementTool,
  type SlackManagementSignal,
} from '../src/management/slack-tools.ts';
import type {
  WorkspaceManagementToolArguments,
  WorkspaceManagementToolName,
  WorkspaceManagementToolResult,
} from '../src/management/tool-adapter.ts';
import { loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { resolveSlackPublicUrl } from '../src/slack/credentials.ts';
import { NodeStateDb } from '../src/state/node-state-db.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
import { authoringProposalMetadata } from './helpers/agent-authoring.ts';
import { useDeploymentKeyring } from './helpers/deployment-keyring.ts';
import { withEnv } from './helpers/env.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const HOSTED_ENV = scopeInstallationEnv(
  { CHICKPEA_TENANCY: 'installation' } as Record<string, unknown>,
  { installationId: 'inst_state_management' },
) as PlatformEnv;
const NO_DEPLOYMENT_KEYS = {
  CHICKPEA_TENANCY: undefined,
  ANTHROPIC_API_KEY: undefined,
  OPENAI_API_KEY: undefined,
  OPENROUTER_API_KEY: undefined,
  SLACK_STATE_DB_PATH: ':memory:',
};

interface StateProbe {
  workspaceManagementInvoke<TName extends WorkspaceManagementToolName>(request: {
    signal: SlackManagementSignal;
    name: TName;
    args: WorkspaceManagementToolArguments[TName];
  }): Promise<WorkspaceManagementToolResult>;
}

/**
 * The production `TagStateStore.workspaceManagementInvoke` RPC method with the
 * state store's own `localManagementRuntime` and `localSettingsStore`, so the
 * management a Slack turn asks the state store for runs on the settings port
 * the Worker ships, not on a store a test chose.
 */
function productionStateManagement(input: {
  env: PlatformEnv;
  settings: SettingsStoreLogic;
  appStores: Record<string, unknown>;
}): { probe: StateProbe; localSettingsStore: () => SettingsStore } {
  const source = ts.createSourceFile(
    'cloudflare.ts',
    readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const functionText = (name: string) => {
    const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(declaration, `production function ${name} exists`);
    return declaration.getText(source);
  };
  const stateClass = source.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'TagStateStore');
  assert.ok(stateClass);
  const method = stateClass.members.find((member) =>
    ts.isMethodDeclaration(member) && member.name.getText(source) === 'workspaceManagementInvoke');
  assert.ok(method, 'the state store exposes workspaceManagementInvoke');
  const compiled = ts.transpileModule([
    functionText('localSettingsStore'),
    functionText('localManagementRuntime'),
    functionText('workspaceManagementRpcFailure'),
    `class Probe { ${method.getText(source)} }`,
  ].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const { Probe, localSettingsStore } = new Function(
    'localGatewayAppStores',
    'createLiveWorkspaceManagementService',
    'loadCredentialKeyring',
    'resolveSlackPublicUrl',
    'invokeSlackWorkspaceManagementTool',
    `${compiled}\nreturn { Probe, localSettingsStore };`,
  )(
    () => input.appStores,
    createLiveWorkspaceManagementService,
    loadCredentialKeyring,
    resolveSlackPublicUrl,
    invokeSlackWorkspaceManagementTool,
  ) as {
    Probe: new () => StateProbe;
    localSettingsStore: (stores: unknown) => SettingsStore;
  };
  const stores = {
    settings: input.settings,
    management: { nextOutboxDueAt: () => undefined },
  };
  const probe = Object.assign(new Probe(), {
    env: input.env,
    stores,
    tryInit: () => stores,
    armAlarmNoLaterThan: async () => undefined,
  });
  return { probe, localSettingsStore: () => localSettingsStore(stores) };
}

test('on a deployment serving many, the state store lists the workspace Agents for an installation with a saved model key, then removes the key', async (t) => {
  await withEnv(NO_DEPLOYMENT_KEYS, async () => {
    useDeploymentKeyring(t);
    const f = await createManagementAdapterFixture('hosted-state-management');
    const settings = new SettingsStoreLogic(new NodeStateDb(new DatabaseSync(':memory:')));
    const usage = new SqliteUsageStore(':memory:');
    const work = new SqliteWorkStore(':memory:');
    t.after(() => {
      f.close();
      usage.close();
      work.close();
    });
    const { probe, localSettingsStore } = productionStateManagement({
      env: HOSTED_ENV,
      settings,
      appStores: {
        identity: f.identity,
        config: f.config,
        management: f.management,
        memory: f.memory,
        routines: f.routines,
        usage,
        work,
      },
    });
    // The installation's own key, saved encrypted through the state store's own settings port.
    await rotateInstallationModelCredential(
      'openai',
      { kind: 'save', apiKey: 'sk-hosted-state-management-test-key' },
      { env: HOSTED_ENV, settings: localSettingsStore(), usage },
    );
    for (const [id, name] of [['agent_first_desk', 'First Desk'], ['agent_second_desk', 'Second Desk']] as const) {
      await f.config.createAgent({
        id,
        name,
        instructions: 'Answer the team.',
        enabled: true,
        kind: 'user',
        lifecycle: 'active',
        creatorMembershipId: f.owner.membership.id,
        configurationGeneration: 1,
        skills: [],
        mcpServers: [],
        apiConnections: [],
        repositories: [],
      });
    }
    // The installing owner's messages to the built-in agent in one DM.
    const fromOwner = (messageTs: string, requesterText: string): SlackManagementSignal => ({
      agentId: 'agent_chickpea',
      workspaceId: f.owner.user.slackTeamId,
      channelId: 'D_HOSTED_STATE',
      threadTs: '500.1',
      conversationKind: 'im',
      slackUserId: f.owner.binding.slackUserId,
      eventId: `Ev_HOSTED_STATE_${messageTs}`,
      messageTs,
      turnJobId: `turn_HOSTED_STATE_${messageTs}`,
      requesterText,
    });
    const succeeded = (result: WorkspaceManagementToolResult) => {
      assert.equal(result.ok, true, JSON.stringify(result));
      return (result as Extract<WorkspaceManagementToolResult, { ok: true }>).result;
    };
    const inspect = async (signal: SlackManagementSignal) => succeeded(
      await probe.workspaceManagementInvoke({ signal, name: 'inspect_workspace', args: {} }),
    ) as {
      agents: Array<{ name: string }>;
      providers: Array<{ id: string; source: string }>;
    };
    const providerSources = (snapshot: Awaited<ReturnType<typeof inspect>>) =>
      Object.fromEntries(snapshot.providers.map(({ id, source }) => [id, source]));

    // The owner asks to list the Agents.
    const listed = await inspect(fromOwner('500.1', 'List the names of the Agents.'));
    assert.deepEqual(listed.agents.map(({ name }) => name).sort(), ['First Desk', 'Second Desk']);
    // The listing reads the installation's saved key, not a deployment's.
    assert.deepEqual(providerSources(listed), { anthropic: 'missing', openai: 'stored', openrouter: 'missing' });

    // A turn the state store runs itself attributes the same saved key.
    const attribution = await resolveModelCredentialAttribution(
      'openai/gpt-test',
      HOSTED_ENV,
      localSettingsStore(),
      usage,
      { registerUsage: false },
    );
    assert.equal(attribution?.providerId, 'openai');
    assert.equal(attribution?.sourceKind, 'stored');

    // The owner asks to remove the key, and approves the proposal in a later message.
    const proposed = succeeded(await probe.workspaceManagementInvoke({
      signal: fromOwner('500.2', 'Remove the OpenAI key.'),
      name: 'propose_workspace_changes',
      args: {
        ...authoringProposalMetadata('hosted-state-remove-openai'),
        operations: [{ itemId: 'remove_openai', kind: 'remove_provider_credential', providerId: 'openai' }],
      },
    })) as { proposalId: string };
    const confirmed = succeeded(await probe.workspaceManagementInvoke({
      signal: fromOwner('500.3', 'Approve.'),
      name: 'confirm_workspace_change',
      args: { proposalId: proposed.proposalId },
    })) as { status: string; outcomes: Array<{ disposition: string }> };
    assert.equal(confirmed.status, 'completed', JSON.stringify(confirmed));
    assert.deepEqual(confirmed.outcomes.map(({ disposition }) => disposition), ['applied']);
    // The removal reached the installation's saved key.
    assert.equal(providerSources(await inspect(fromOwner('500.4', 'List the providers.'))).openai, 'missing');
    assert.equal((await settings.readModelCredential('openai'))?.active, false);
  });
});
