import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import { hostedSignUpOnboardingSteps, onboardingSteps } from '../src/admin/onboarding-steps.ts';
import { configureHostedGithub, configureHostedGithubConnect } from '../src/config/hosted-github.ts';
import { configurePlatformBilling, type PlatformBillingPort } from '../src/config/platform-billing.ts';

const labels = (steps: ReadonlyArray<{ label: string }>) => steps.map((step) => step.label);
const ids = (steps: ReadonlyArray<{ id: string }>) => steps.map((step) => step.id);
const notes = (steps: ReadonlyArray<{ note?: string }>) => steps.map((step) => step.note ?? null);

test('standalone keeps its four steps and never offers GitHub', () => {
  for (const githubOffered of [false, true]) {
    const steps = onboardingSteps({ selfHosted: true, onChickpeaModels: false, githubOffered });
    assert.deepEqual(labels(steps), ['Connect Slack', 'Choose provider', 'Choose model', 'Try Chickpea']);
    assert.deepEqual(ids(steps), ['slack', 'provider', 'model', 'try']);
  }
});

test('hosted starts at Add to Slack, drops the provider and model on Chickpea\'s models, and offers GitHub when the host can connect it', () => {
  assert.deepEqual(labels(onboardingSteps({ selfHosted: false, onChickpeaModels: false, githubOffered: true })),
    ['Add to Slack', 'Choose provider', 'Choose model', 'Connect GitHub', 'Try Chickpea']);
  assert.deepEqual(labels(onboardingSteps({ selfHosted: false, onChickpeaModels: false, githubOffered: false })),
    ['Add to Slack', 'Choose provider', 'Choose model', 'Try Chickpea']);
  assert.deepEqual(ids(onboardingSteps({ selfHosted: false, onChickpeaModels: true, githubOffered: true })), ['slack', 'github', 'try']);
  assert.deepEqual(labels(onboardingSteps({ selfHosted: false, onChickpeaModels: true, githubOffered: false })), ['Add to Slack', 'Try Chickpea']);
});

test('each step\'s bar says what it is for until it is done; the provider and model say nothing more than their labels', () => {
  assert.deepEqual(notes(onboardingSteps({ selfHosted: false, onChickpeaModels: true, githubOffered: true })),
    ['Your workspace', 'Optional', 'Say hi']);
  assert.deepEqual(notes(onboardingSteps({ selfHosted: false, onChickpeaModels: false, githubOffered: true })),
    ['Your workspace', null, null, 'Optional', 'Say hi']);
  assert.deepEqual(notes(onboardingSteps({ selfHosted: true, onChickpeaModels: false, githubOffered: false })),
    ['Your workspace', null, null, 'Say hi']);
});

const BILLING: PlatformBillingPort = {
  async summary() { throw new Error('not read'); },
  async checkout() { throw new Error('not read'); },
  async portal() { throw new Error('not read'); },
  async chooseFunding() { throw new Error('not read'); },
};
const APP = { appId: '900100', appSlug: 'chickpea-test', privateKeyPem: '-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----', botUserId: 900_200 };
const bindings = { list: async () => [], disconnect: async () => false, reportGone() {} };

function host(t: TestContext, input: { billing: boolean; app: () => unknown }) {
  configurePlatformBilling(input.billing ? BILLING : undefined);
  configureHostedGithub({ app: input.app, bindings });
  configureHostedGithubConnect({ path: '/github/connect' });
  t.after(() => {
    configurePlatformBilling(undefined);
    configureHostedGithub(undefined);
    configureHostedGithubConnect(undefined);
  });
}

test('the host\'s Add to Slack page reads the same plan the onboarding page will show', async (t) => {
  host(t, { billing: true, app: () => APP });
  assert.deepEqual(labels(await hostedSignUpOnboardingSteps()), ['Add to Slack', 'Connect GitHub', 'Try Chickpea']);
  configurePlatformBilling(undefined);
  assert.deepEqual(labels(await hostedSignUpOnboardingSteps()),
    ['Add to Slack', 'Choose provider', 'Choose model', 'Connect GitHub', 'Try Chickpea']);
});

test('a GitHub App that cannot be read leaves out the GitHub step instead of failing the page', async (t) => {
  host(t, { billing: true, app: () => { throw new Error('secrets unavailable'); } });
  assert.deepEqual(labels(await hostedSignUpOnboardingSteps()), ['Add to Slack', 'Try Chickpea']);
  configureHostedGithubConnect(undefined);
  assert.deepEqual(labels(await hostedSignUpOnboardingSteps()), ['Add to Slack', 'Try Chickpea']);
});
