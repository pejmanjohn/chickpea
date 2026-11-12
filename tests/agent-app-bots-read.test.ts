import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import ts from 'typescript';

import { CfConfigStore, FreshTagStateStubs } from '../src/config/cf-state-proxies.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import { ConfigStoreLogic } from '../src/config/store.ts';
import type { AgentCreateInput } from '../src/config/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { agentAppBots } from '../src/slack/agent-app-bots.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

/**
 * The bots of an installation's Agent apps are read on every Slack delivery.
 * The store answers them from the Agents' Slack presence alone, so a Worker
 * no longer loads every Agent's whole config to learn them, and a Worker that
 * meets a store on older code reads them the old way once.
 */

const AVATAR = { kind: 'generated', revision: 1, seed: 's' };

function app(state: string, botUserId?: string) {
  return {
    kind: 'agent_app', requestedHandle: 'h', normalizedHandle: 'h', desiredState: 'active', health: 'healthy', avatar: AVATAR,
    app: { state, at: 1, app: { appId: `A_${state}`, clientId: '1.c' }, ...(botUserId ? { botUserId } : {}) },
  };
}

function agent(id: string): AgentCreateInput {
  return {
    id, name: id, instructions: 'Help.', enabled: true, skills: [], mcpServers: [], apiConnections: [], repositories: [],
  };
}

/** Agents whose stored presence covers every shape the bot list reads: apps in each state, none, and damaged records. */
function seeded(): { config: ConfigStoreLogic; db: ReturnType<typeof openStateDb> } {
  const db = openStateDb(':memory:');
  const config = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
  config.materializeChickpeaAgent();
  const presences: Record<string, string> = {
    agent_live: JSON.stringify(app('active', 'UAPP_LIVE')),
    agent_removing: JSON.stringify(app('removing', 'UAPP_REMOVING')),
    agent_attention: JSON.stringify(app('needs_attention', 'UAPP_ATTENTION')),
    agent_installing: JSON.stringify(app('installing')),
    agent_no_app: JSON.stringify({ ...app('active', 'UAPP_NONE'), app: undefined }),
    agent_group: JSON.stringify({ requestedHandle: 'g', normalizedHandle: 'g', desiredState: 'active', health: 'healthy', avatar: AVATAR, userGroupId: 'SGROUP' }),
    agent_damaged: '{not json',
    agent_empty: '',
  };
  for (const [id, presence] of Object.entries(presences)) {
    config.createAgent(agent(id));
    db.run('UPDATE config_agents SET slack_presence_json = ? WHERE id = ?', presence, id);
  }
  config.createAgent(agent('agent_archived'));
  db.run('UPDATE config_agents SET slack_presence_json = ?, lifecycle = ? WHERE id = ?',
    JSON.stringify(app('active', 'UAPP_ARCHIVED')), 'archived', 'agent_archived');
  // A system Agent's row never carries a presence the bot list reads.
  db.run("UPDATE config_agents SET slack_presence_json = ? WHERE agent_kind = 'system'", JSON.stringify(app('active', 'UAPP_SYSTEM')));
  return { config, db };
}

// Defects caught: a bot list that differs from the one built from every
// Agent's config (an app state dropped or added, a system Agent's row read, a
// damaged record that throws), in members or order.
test("the store lists the Agent apps' bots exactly as they read from every Agent's config", () => {
  const { config, db } = seeded();
  const expected = agentAppBots(config.listAgents());
  assert.deepEqual(expected.map((bot) => bot.botUserId), ['UAPP_ARCHIVED', 'UAPP_ATTENTION', 'UAPP_LIVE', 'UAPP_REMOVING'],
    'the fixture covers every app that names its bot');
  assert.deepEqual(config.listAgentAppBots(), expected);
  db.close();
});

/** The state store's own config methods from src/cloudflare.ts, over `config`, without workerd. */
function stateStore(config: ConfigStoreLogic, methods: readonly string[]) {
  const source = ts.createSourceFile(
    'cloudflare.ts',
    readFileSync(new URL('../src/cloudflare.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const stateClass = source.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'TagStateStore');
  assert.ok(stateClass);
  const methodText = (name: string) => {
    const method = stateClass.members.find((member) =>
      ts.isMethodDeclaration(member) && member.name.getText(source) === name);
    assert.ok(method, `the state store exposes ${name}`);
    return method.getText(source);
  };
  const compiled = ts.transpileModule(
    `class Probe { ${methods.map(methodText).join('\n')} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const Probe = new Function(`${compiled}\nreturn Probe;`)() as new () => object;
  const calls: string[] = [];
  const store = Object.assign(new Probe(), {
    call: <T>(fn: (stores: { config: ConfigStoreLogic }) => T): StateRpcResult<T> => ({ ok: true, value: fn({ config }) }),
  }) as unknown as Record<string, (...args: unknown[]) => unknown>;
  // Calls are recorded as a Worker's stub makes them; a method the class lacks is missing on the stub too.
  const stub = new Proxy(store, {
    get(target, name) {
      if (typeof name !== 'string' || typeof target[name] !== 'function') return Reflect.get(target, name);
      return (...args: unknown[]) => {
        calls.push(name);
        return target[name]!.apply(target, args);
      };
    },
  }) as unknown as TagStateRpc;
  return { stub, calls };
}

// Defects caught: the Worker's read still loading every Agent's config
// (configListAgents), and a store answer other than the store's own list.
test("over the state store's RPC, the bots are one call that loads no Agent's config", async () => {
  const { config, db } = seeded();
  const store = stateStore(config, ['configListAgents', 'configListAgentAppBots']);
  assert.deepEqual(await new CfConfigStore(store.stub).listAgentAppBots(), agentAppBots(config.listAgents()));
  assert.deepEqual(store.calls, ['configListAgentAppBots']);
  db.close();
});

// Defects caught: a new Worker failing every delivery against a store still on
// older code (no fallback), a fallback that answers differently, one that
// repeats, and one that hides a store's own failure (an `ok: false` answer
// read again the old way).
test('a store on older code is read the old way once, and a store that answers is never second-guessed', async (t) => {
  const logged: unknown[] = [];
  t.mock.method(console, 'info', (record: unknown) => { logged.push(record); });
  const { config, db } = seeded();
  const expected = agentAppBots(config.listAgents());

  const old = stateStore(config, ['configListAgents']);
  assert.deepEqual(await new CfConfigStore(old.stub).listAgentAppBots(), expected, 'the same bots, from the whole list');
  assert.deepEqual(old.calls, ['configListAgents'], 'one fallback read');
  assert.deepEqual(logged, [{ component: 'runtime', event: 'state_rpc_fallback', method: 'configListAgentAppBots', reason: 'method_missing' }]);

  // A store replaced or unreachable mid-call rejects; a fresh stub per call reads the old way, once.
  logged.length = 0;
  const reached: string[] = [];
  const fresh = new FreshTagStateStubs(() => ({
    configListAgentAppBots: () => { reached.push('configListAgentAppBots'); return Promise.reject(new Error('the object was reset')); },
    configListAgents: () => { reached.push('configListAgents'); return Promise.resolve({ ok: true, value: config.listAgents() }); },
  }) as unknown as TagStateRpc);
  assert.deepEqual(await new CfConfigStore(fresh).listAgentAppBots(), expected);
  assert.deepEqual(reached, ['configListAgentAppBots', 'configListAgents']);
  assert.deepEqual(logged.map((record) => (record as { reason?: unknown }).reason), ['rejected']);

  logged.length = 0;
  const failing: string[] = [];
  const answersFailure = {
    configListAgentAppBots: () => { failing.push('configListAgentAppBots'); return Promise.resolve({ ok: false, error: { code: 'internal', message: 'init failed' } }); },
    configListAgents: () => { failing.push('configListAgents'); return Promise.resolve({ ok: true, value: [] }); },
  } as unknown as TagStateRpc;
  await assert.rejects(new CfConfigStore(answersFailure).listAgentAppBots(), /init failed/);
  assert.deepEqual(failing, ['configListAgentAppBots'], 'an answer, even a failure, is not followed by the old read');
  assert.deepEqual(logged, []);
  db.close();
});
