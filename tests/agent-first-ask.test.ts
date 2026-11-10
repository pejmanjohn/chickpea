import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import ts from 'typescript';

import { CfConfigStore } from '../src/config/cf-state-proxies.ts';
import { UnknownAgentError } from '../src/config/errors.ts';
import type { StateRpcResult, TagStateRpc } from '../src/config/state-rpc.ts';
import { ConfigStoreLogic } from '../src/config/store.ts';
import type { AgentCreateInput } from '../src/config/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const ASK = 'Which deals closed this week?';

function agent(id: string): AgentCreateInput {
  return {
    id,
    name: id.replace('agent_', 'Agent '),
    instructions: 'Answer from the CRM.',
    enabled: true,
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  };
}

function configStore(): ConfigStoreLogic {
  return new ConfigStoreLogic(openStateDb(':memory:'), agentRoutineDeletion, { agents: [] });
}

test('an Agent keeps the first ask its creation carried through edits, archive and restore, outside its config', () => {
  const config = configStore();
  const created = config.createAgent(agent('agent_asked'), undefined, ASK);
  config.createAgent(agent('agent_unasked'));
  assert.equal(created.revision, 1);
  assert.doesNotMatch(JSON.stringify(created), /deals closed/, 'the ask is not part of the Agent\'s config');

  const edited = config.updateAgent('agent_asked', { instructions: 'Answer from the CRM, briefly.' }, created.revision);
  const archived = config.archiveAgent('agent_asked', {
    expectedRevision: edited.revision,
    expectedCredentialIncarnation: edited.credentialIncarnation!,
  });
  config.restoreAgent('agent_asked', archived.revision, archived.credentialIncarnation);

  assert.equal(config.getAgentFirstAsk('agent_asked'), ASK);
  assert.equal(config.getAgentFirstAsk('agent_unasked'), null, 'a creation without an ask stores none');
  assert.throws(() => config.getAgentFirstAsk('agent_missing'), UnknownAgentError);
});

/**
 * The state store's own `configCreateAgent` and `configGetAgentFirstAsk`
 * methods from `src/cloudflare.ts`, over a config store, so the Cloudflare
 * proxy reaches the store the way a Worker does, without workerd.
 */
function stateStoreRpc(config: ConfigStoreLogic): TagStateRpc {
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
    `class Probe { ${methodText('configCreateAgent')} ${methodText('configGetAgentFirstAsk')} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const Probe = new Function(`${compiled}\nreturn Probe;`)() as new () => object;
  return Object.assign(new Probe(), {
    call: <T>(fn: (stores: { config: ConfigStoreLogic }) => T): StateRpcResult<T> => ({ ok: true, value: fn({ config }) }),
  }) as unknown as TagStateRpc;
}

test('on Cloudflare, a creation\'s first ask crosses the state store RPC and reads back', async () => {
  const store = new CfConfigStore(stateStoreRpc(configStore()));
  await store.createAgent(agent('agent_asked'), undefined, ASK);
  await store.createAgent(agent('agent_unasked'));
  assert.equal(await store.getAgentFirstAsk('agent_asked'), ASK);
  assert.equal(await store.getAgentFirstAsk('agent_unasked'), null);
});
