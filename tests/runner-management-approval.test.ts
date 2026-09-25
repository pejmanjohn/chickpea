import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import type { WebClient } from '@slack/web-api';
import ts from 'typescript';

import type { ResolvedAssignment } from '../src/config/types.ts';
import {
  executeHostSlackManagementApproval,
  type SlackManagementApprovalRpcRequest,
} from '../src/management/slack-approval.ts';
import { runTurn } from '../src/slack/run-turn.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { authoringProposalMetadata } from './helpers/agent-authoring.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

function sourceOf(relative: string): ts.SourceFile {
  return ts.createSourceFile(
    relative,
    readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

function find<T extends ts.Node>(root: ts.Node, match: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (match(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/**
 * The production `TagStateStore.slackManagementApprovalInvoke` RPC method,
 * evaluated with the state owner's local stores injected, so the runner-side
 * test applies an approval through the code the Worker ships.
 */
function productionApprovalRpc(collaborators: {
  appStores: unknown;
  service: unknown;
  nextOutboxDueAt: () => number | undefined;
}) {
  const source = sourceOf('src/cloudflare.ts');
  const [method] = find(source, (node): node is ts.MethodDeclaration =>
    ts.isMethodDeclaration(node) && node.name.getText(source) === 'slackManagementApprovalInvoke');
  assert.ok(method, 'the state store exposes slackManagementApprovalInvoke');
  const compiled = ts.transpileModule(`class Probe { ${method.getText(source)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const Probe = new Function(
    'localGatewayAppStores',
    'localManagementRuntime',
    'executeHostSlackManagementApproval',
    `${compiled}\nreturn Probe;`,
  )(
    () => collaborators.appStores,
    () => ({ service: collaborators.service }),
    executeHostSlackManagementApproval,
  ) as new () => {
    slackManagementApprovalInvoke(request: SlackManagementApprovalRpcRequest): Promise<unknown>;
  };
  const alarms: number[] = [];
  const probe = Object.assign(new Probe(), {
    env: {},
    stores: { management: { nextOutboxDueAt: collaborators.nextOutboxDueAt } },
    tryInit: () => undefined,
    armAlarmNoLaterThan: async (at: number) => { alarms.push(at); },
  });
  return { probe, alarms };
}

async function withCloudflareTarget<T>(run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { userAgent: 'Cloudflare-Workers' },
  });
  try {
    return await run();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

test('a thread runner approval turn applies the proposal in the state store over one RPC', async () => {
  const f = await createManagementAdapterFixture('runner-approval');
  try {
    const agent = await f.config.createAgent({
      id: 'agent_runner_approval',
      name: 'Runner Approval',
      instructions: 'Original instructions.',
      enabled: true,
      kind: 'user',
      lifecycle: 'active',
      creatorMembershipId: f.admin.membership.id,
      configurationGeneration: 1,
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    const workspaceId = f.admin.binding.slackTeamId;
    const installation = await f.config.ensureWorkspaceInstallation({
      workspaceId,
      transportMode: 'direct',
      defaultAgentId: agent.id,
      teamId: workspaceId,
      botUserId: 'U_CHICKPEA',
    });
    await f.config.updateWorkspaceInstallation(
      workspaceId,
      { runtimeContract: 'chickpea-v1', health: 'healthy' },
      installation.revision,
    );
    const proposed = await f.service.proposeWorkspaceChanges({
      context: {
        userId: f.admin.user.id,
        membershipId: f.admin.membership.id,
        organizationId: f.admin.membership.organizationId,
        actingAgentId: agent.id,
        origin: {
          kind: 'slack',
          workspaceId,
          channelId: 'D_RUNNER_APPROVAL',
          threadTs: '100.1',
          messageTs: '100.1',
          conversationKind: 'im',
          agentId: agent.id,
        },
      },
      ...authoringProposalMetadata('runner-approval'),
      operations: [{
        itemId: 'instructions',
        kind: 'update_agent',
        agentId: agent.id,
        expectedRevision: agent.revision,
        patch: { instructions: 'Instructions applied by a runner approval.' },
      }],
    });
    const assignment: ResolvedAssignment = {
      workspaceId,
      channelId: 'D_RUNNER_APPROVAL',
      agentId: agent.id,
      runtimeContract: 'chickpea-v1',
      agent,
    };
    const turn: NormalizedSlackTurn = {
      workspaceId,
      channelId: 'D_RUNNER_APPROVAL',
      eventId: 'Ev_RUNNER_APPROVAL',
      text: 'approve',
      userId: f.admin.binding.slackUserId,
      actorMembershipId: f.admin.membership.id,
      messageTs: '200.1',
      threadTs: '200.1',
      source: 'dm_message',
      contextMode: 'dm_history',
      interactionIntent: { disposition: 'reply', reason: 'substantive_request' },
      managementApprovalProposalId: proposed.proposalId,
    };
    const rpc = productionApprovalRpc({
      appStores: { identity: f.identity, config: f.config, management: f.management },
      service: f.service,
      nextOutboxDueAt: () => undefined,
    });
    const requests: SlackManagementApprovalRpcRequest[] = [];
    const delivered: string[] = [];
    const client = {
      conversations: { history: async () => ({ ok: true, messages: [] }) },
      chat: {
        startStream: async (input: { markdown_text: string }) => {
          delivered.push(input.markdown_text);
          return { ok: true, ts: '201.1' };
        },
        stopStream: async () => ({ ok: true }),
        postMessage: async (input: { text: string }) => {
          delivered.push(input.text);
          return { ok: true, channel: turn.channelId, ts: '201.1' };
        },
      },
    } as unknown as WebClient;

    // On Cloudflare, with the runner's ports: no local stores and no local
    // management runtime. Before the fix this threw "Cloudflare Slack
    // approvals require the local management runtime".
    await withCloudflareTarget(() => runTurn(turn, assignment, undefined, {
      client,
      turnId: 'turn_RUNNER_APPROVAL',
      publicUrl: null,
      agentPrompt: async () => {
        throw new Error('the Agent must not handle an approved proposal');
      },
      invokeManagementApproval: async (request) => {
        // Durable Object RPC arguments are structured clones.
        const sent = structuredClone(request);
        requests.push(sent);
        return await rpc.probe.slackManagementApprovalInvoke(sent) as never;
      },
      usageRecordingEnabled: false,
    }));

    assert.equal(requests.length, 1, 'one RPC per approval');
    assert.equal(requests[0]?.proposalId, proposed.proposalId);
    assert.equal(requests[0]?.turnJobId, 'turn_RUNNER_APPROVAL');
    assert.match(delivered.join('\n'), /Applied the approved changes\./);
    const applied = await f.config.getAgent(agent.id);
    assert.equal(applied.instructions, 'Instructions applied by a runner approval.');
  } finally {
    f.close();
  }
});

/**
 * Every `TurnExecutionPorts` member each executor supplies, read from the
 * production object literals. A port one executor supplies and the other
 * omits must be listed here with the reason; an unlisted divergence (like the
 * missing approval port that broke Slack approvals under the runner) fails.
 */
const INTENTIONAL_DIVERGENCE: Record<string, { executor: 'alarm' | 'runner'; reason: string }> = {
  settingsStore: { executor: 'alarm', reason: 'local store; the runner reaches settings over RPC' },
  usageStore: { executor: 'alarm', reason: 'local store; the runner reaches usage over RPC' },
  workStore: { executor: 'alarm', reason: 'local store; the runner reaches work over RPC' },
  appStores: { executor: 'alarm', reason: 'local stores; the runner reaches them over RPC' },
  managementApproval: {
    executor: 'alarm',
    reason: 'local management runtime; the runner uses invokeManagementApproval',
  },
  invokeManagementApproval: {
    executor: 'runner',
    reason: 'approvals apply in the state store over one RPC; the alarm is the state store',
  },
  statusRegistry: { executor: 'runner', reason: 'the runner owns its thread status registry' },
};

/** Capabilities each executor must provide through one of these ports. */
const REQUIRED_CAPABILITIES: Record<string, string[]> = {
  'management approval': ['managementApproval', 'invokeManagementApproval'],
};

function portLiteralKeys(relative: string, variable: string): Set<string> {
  const source = sourceOf(relative);
  const declarations = find(source, (node): node is ts.VariableDeclaration =>
    ts.isVariableDeclaration(node) && node.name.getText(source) === variable &&
    node.type?.getText(source) === 'TurnExecutionPorts');
  assert.equal(declarations.length, 1, `${relative} builds one TurnExecutionPorts literal`);
  const literal = declarations[0]!.initializer;
  assert.ok(literal && ts.isObjectLiteralExpression(literal));
  return new Set(literal.properties.map((property) => {
    assert.ok(!ts.isSpreadAssignment(property), `${relative} ports are listed explicitly`);
    return property.name!.getText(source);
  }));
}

test('the alarm and thread runner build the same turn execution ports', () => {
  const source = sourceOf('src/slack/turn-executor.ts');
  const [ports] = find(source, (node): node is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(node) && node.name.text === 'TurnExecutionPorts');
  assert.ok(ports);
  const required = new Set<string>();
  const optional = new Set<string>();
  for (const member of ports.members) {
    const name = member.name?.getText(source);
    if (!name) continue;
    (member.questionToken ? optional : required).add(name);
  }
  const alarm = portLiteralKeys('src/cloudflare.ts', 'turnPorts');
  const runner = portLiteralKeys('src/slack/thread-runner.ts', 'ports');

  for (const name of required) {
    assert.ok(alarm.has(name), `the alarm supplies ${name}`);
    assert.ok(runner.has(name), `the runner supplies ${name}`);
  }
  for (const name of optional) {
    const divergence = INTENTIONAL_DIVERGENCE[name];
    if (divergence) {
      assert.equal(alarm.has(name), divergence.executor === 'alarm',
        `${name}: only the ${divergence.executor} supplies it (${divergence.reason})`);
      assert.equal(runner.has(name), divergence.executor === 'runner',
        `${name}: only the ${divergence.executor} supplies it (${divergence.reason})`);
    } else {
      assert.equal(alarm.has(name), runner.has(name),
        `${name} is supplied by one executor only; supply it in both or list why it diverges`);
    }
  }
  for (const [capability, names] of Object.entries(REQUIRED_CAPABILITIES)) {
    assert.ok(names.some((name) => alarm.has(name)), `the alarm provides ${capability}`);
    assert.ok(names.some((name) => runner.has(name)), `the runner provides ${capability}`);
  }
  for (const name of [...alarm, ...runner]) {
    assert.ok(required.has(name) || optional.has(name), `${name} is a TurnExecutionPorts member`);
  }
});
