import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import {
  configureHostedActivity,
  hostedActivityConfigured,
  reportInteractiveDelivery,
  resetHostedActivityForTests,
  type HostedActivityPort,
} from '../src/config/hosted-activity.ts';

function clock(t: TestContext) {
  const state = { now: 1_800_000_000_000 };
  resetHostedActivityForTests({ now: () => state.now });
  t.after(() => resetHostedActivityForTests());
  return state;
}

function recordingPort(): HostedActivityPort & { reported: string[] } {
  const reported: string[] = [];
  return { reported, interactiveDelivered: async (installationId) => { reported.push(installationId); } };
}

test('without a port, a report resolves at once and logs nothing', async (t) => {
  clock(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const error = t.mock.method(console, 'error', () => {});
  assert.equal(hostedActivityConfigured(), false);
  assert.equal(await reportInteractiveDelivery('inst_a'), undefined);
  assert.equal(warn.mock.callCount() + error.mock.callCount(), 0);
});

test('a configured port hears each report once, with the installation id', async (t) => {
  clock(t);
  const port = recordingPort();
  configureHostedActivity(port);
  assert.equal(hostedActivityConfigured(), true);
  await reportInteractiveDelivery('inst_a');
  await reportInteractiveDelivery('inst_b');
  await reportInteractiveDelivery('inst_a');
  assert.deepEqual(port.reported, ['inst_a', 'inst_b', 'inst_a']);
});

test('a port that throws or rejects is swallowed and logged at most once a minute, naming no installation', async (t) => {
  const time = clock(t);
  const warn = t.mock.method(console, 'warn', () => {});
  configureHostedActivity({ interactiveDelivered: () => { throw new Error('registry down'); } });
  await reportInteractiveDelivery('inst_a');
  configureHostedActivity({ interactiveDelivered: async () => { throw new Error('registry down'); } });
  await reportInteractiveDelivery('inst_b');
  time.now += 59_999;
  await reportInteractiveDelivery('inst_a');
  const lines = () => warn.mock.calls.map(({ arguments: [line] }) => String(line));
  assert.deepEqual(lines().map((line) => JSON.parse(line)),
    [{ component: 'hosted_activity', event: 'interactive_delivery_failed' }]);
  time.now += 1;
  await reportInteractiveDelivery('inst_a');
  assert.equal(lines().length, 2, 'a minute later the failure is logged again');
  assert.ok(lines().every((line) => !line.includes('inst_')), 'the log names no installation');
});

test('removing the port, or the test reset, stops every report', async (t) => {
  clock(t);
  const port = recordingPort();
  configureHostedActivity(port);
  configureHostedActivity(undefined);
  await reportInteractiveDelivery('inst_a');
  configureHostedActivity(port);
  resetHostedActivityForTests();
  assert.equal(hostedActivityConfigured(), false);
  await reportInteractiveDelivery('inst_a');
  assert.deepEqual(port.reported, []);
});
