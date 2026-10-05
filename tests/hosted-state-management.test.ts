import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import ts from 'typescript';

import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import { promiseBackedStatePort } from '../src/config/local-state-port.ts';
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
import type { WorkspaceManagementToolResult } from '../src/management/tool-adapter.ts';
import { loadCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { resolveSlackPublicUrl } from '../src/slack/credentials.ts';
import { NodeStateDb } from '../src/state/node-state-db.ts';
import { SqliteUsageStore } from '../src/usage/store.ts';
import { SqliteWorkStore } from '../src/work/store.ts';
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
  workspaceManagementInvoke(request: {
    signal: SlackManagementSignal;
    name: 'inspect_workspace';
    args: Record<string, never>;
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

test('on a deployment serving many, the state store lists the workspace Agents for an installation with a saved model key', async (t) => {
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
    // The installation's own key, saved encrypted in its state store as setup saves it.
    await rotateInstallationModelCredential(
      'openai',
      { kind: 'save', apiKey: 'sk-hosted-state-management-test-key' },
      { env: HOSTED_ENV, settings: promiseBackedStatePort(settings) as unknown as SettingsStore, usage },
    );
    for (const [id, name] of [['agent_first_desk', 'First Desk'], ['agent_second_desk', 'Second Desk']]) {
      await f.config.createAgent({
        id: id!,
        name: name!,
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

    // The installing owner asks the built-in agent in a DM to list the Agents.
    const listed = await probe.workspaceManagementInvoke({
      signal: {
        agentId: 'agent_chickpea',
        workspaceId: f.owner.user.slackTeamId,
        channelId: 'D_HOSTED_STATE',
        threadTs: '500.1',
        conversationKind: 'im',
        slackUserId: f.owner.binding.slackUserId,
        eventId: 'Ev_HOSTED_STATE',
        messageTs: '500.1',
        turnJobId: 'turn_HOSTED_STATE',
        requesterText: 'List the names of the Agents.',
      },
      name: 'inspect_workspace',
      args: {},
    });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    const snapshot = (listed as Extract<WorkspaceManagementToolResult, { ok: true }>).result as {
      agents: Array<{ name: string }>;
      providers: Array<{ id: string; source: string }>;
    };
    assert.deepEqual(snapshot.agents.map(({ name }) => name).sort(), ['First Desk', 'Second Desk']);
    // The listing reads the installation's saved key, not a deployment's.
    assert.deepEqual(
      Object.fromEntries(snapshot.providers.map(({ id, source }) => [id, source])),
      { anthropic: 'missing', openai: 'stored', openrouter: 'missing' },
    );

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
  });
});
