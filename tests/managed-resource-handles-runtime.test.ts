import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { init, instrument, useModel } from '@flue/runtime';
import { start } from '@flue/runtime/node';

import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import type { RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { loadConnectorDetails } from '../src/connections/catalog/index.ts';
import { useManagedConnectionTools } from '../src/connections/managed-tools.ts';

const SELECTED = 'resource_0123456789abcdef0123456789abcdef';

function planWith(resourceConstraints: Record<string, string[]>): RuntimePlanV2 {
  return {
    agentId: 'agent_ads',
    actorMembershipId: 'membership_alice',
    conversation: { workspaceId: 'T_MANAGED' },
    skills: [],
    managedConnections: [{
      id: 'connection_ads',
      providerId: 'google',
      adapterId: 'composio',
      toolkit: 'googleads',
      allowedCapabilities: ['ads.customers.get', 'ads.budgets.report'],
      resourceConstraints,
    }],
  } as unknown as RuntimePlanV2;
}

async function modelRequestsFor(plan: RuntimePlanV2): Promise<string[]> {
  const model = 'faux/managed-resource-handles';
  const requests: string[] = [];
  const registration = instrument({
    key: Symbol('managed-resource-handles'),
    interceptor: (_operation, _context, next) => next(),
    observe(event) {
      if (event.type === 'turn_request' && event.purpose === 'agent') {
        requests.push(String(event.request.input.systemPrompt ?? ''));
      }
    },
    dispose() {},
  });
  await loadConnectorDetails(['googleads']);
  function ManagedResourceProbe() {
    useModel(model);
    useManagedConnectionTools(plan, async () => undefined);
    return 'Report the selected client account budgets.';
  }
  const faux = fauxProvider({ models: [{ id: 'managed-resource-handles' }] });
  faux.setResponses([fauxAssistantMessage('Done.')]);
  const flue = await start({
    agents: [{ agent: ManagedResourceProbe, name: CHICKPEA_SLACK_AGENT_NAME }],
    providers: [faux.provider],
  });
  try {
    const handle = init(ManagedResourceProbe, { id: 'managed-resource-handles-fixture' });
    const receipt = await handle.dispatch({ message: {
      kind: 'signal', type: 'slack.message', tagName: 'slack_message',
      body: 'Show the budgets.', attributes: { slackUserId: 'U_FIXTURE', messageTs: '1788000000.000001' },
    } });
    await handle.read(receipt);
  } finally {
    await flue.stop();
    await registration();
  }
  return requests;
}

test('the model sees the handle of each selected resource and the tool argument that takes it', async () => {
  const requests = await modelRequestsFor(planWith({ customerIds: [SELECTED] }));

  assert.equal(requests.length, 1);
  assert.ok(requests[0]!.includes(SELECTED), 'the selected handle reaches the model');
  assert.ok(
    requests[0]!.includes(`"argument":"customerHandle","handles":["${SELECTED}"]`),
    'the handle is listed under the tool argument that takes it',
  );
});

test('a toolkit backed by several accounts lists no handles, since its tools are withheld', async () => {
  const plan = planWith({ customerIds: [SELECTED] });
  plan.managedConnections!.push({ ...plan.managedConnections![0]!, id: 'connection_ads_second' });
  const requests = await modelRequestsFor(plan);

  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0]!, /resource_[0-9a-f]{32}/);
});

test('a connection with no selected resources lists no handles', async () => {
  const requests = await modelRequestsFor(planWith({}));

  assert.equal(requests.length, 1);
  assert.doesNotMatch(requests[0]!, /resource_[0-9a-f]{32}/);
});
