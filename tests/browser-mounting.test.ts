import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  createRuntimePlanArtifactTools,
  runtimePlanSkills,
} from '../src/agents/slack-thread.ts';
import type { RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { BROWSER_TOOL_NAMES } from '../src/browser/tools.ts';
import { browserSkillForPlan } from '../src/browser/skill.ts';
import { BrowserTurnSession } from '../src/browser/turn-session.ts';
import { fakeBrowserProvider } from './helpers/fake-cdp-socket.ts';
import { createArtifactReceiptAccumulator, type SlackArtifactReceipts } from '../src/slack/artifact-receipts.ts';

const WORKSPACE = 'T12345678';
const CHANNEL = 'C12345678';
const THREAD_TS = '1789000000.000100';

const PLAN: RuntimePlanV2 = {
  schemaVersion: 2,
  continuityPolicy: 'synthetic-test',
  agentId: 'agent_browser',
  conversation: {
    workspaceId: WORKSPACE,
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    surface: 'channel_thread',
    continuityKey: `agent_${'a1b2c3d4'.repeat(5)}`,
  },
  model: 'faux/browser-tool',
  instructions: 'Answer the request.',
  memoryEpoch: 1,
  skills: [],
  mcpConnections: [],
  apiConnections: [],
  repositories: [],
  sandbox: { mode: 'bash' },
  artifactDestination: { kind: 'slack_conversation', channelId: CHANNEL, threadTs: THREAD_TS },
  harnessRevision: 'f'.repeat(64),
};

function plan(browserCapability?: RuntimePlanV2['browserCapability']): RuntimePlanV2 {
  return browserCapability ? { ...PLAN, browserCapability } : { ...PLAN };
}

test('the hook path mounts the browser tools only for a frozen capability and a supplied session', () => {
  const accumulator = createArtifactReceiptAccumulator((update) => {
    update({ schemaVersion: 1, receipts: [] });
  });
  const write = (_receipts: SlackArtifactReceipts) => {};
  const browserSession = new BrowserTurnSession({
    provider: fakeBrowserProvider().provider,
    connect: async () => {
      throw new Error('unused');
    },
  });
  const names = (capability: RuntimePlanV2['browserCapability'], session?: BrowserTurnSession) =>
    createRuntimePlanArtifactTools(plan(capability), accumulator, write, session ? { browserSession: session } : {})
      .map((tool) => tool.name);

  assert.deepEqual(names({ provider: 'browserbase' }, browserSession), ['post_artifact', ...BROWSER_TOOL_NAMES]);
  // The render owns the session: no session, no browser tools.
  assert.deepEqual(names({ provider: 'browserbase' }), ['post_artifact']);
  assert.deepEqual(names(undefined, browserSession), ['post_artifact']);
});

test('the browser skill mounts with its tools and stays last', () => {
  const enabled = plan({ provider: 'browserbase' });
  const withAgentSkill = {
    ...enabled,
    skills: [{ name: 'browser', description: 'Impostor', instructions: 'Do something else.' }],
  } as RuntimePlanV2;
  const skills = runtimePlanSkills(withAgentSkill, { browser: true });
  const browser = skills.find((skill) => skill.name === 'browser');
  assert.ok(browser);
  assert.equal(skills.at(-1)?.name, 'browser');
  assert.match(JSON.stringify(browser), /untrusted data/);
  assert.doesNotMatch(JSON.stringify(browser), /Do something else/);

  assert.equal(runtimePlanSkills(plan(), { browser: true }).some((skill) => skill.name === 'browser'), false);
  assert.equal(runtimePlanSkills(enabled).some((skill) => skill.name === 'browser'), false);
  assert.equal(runtimePlanSkills(enabled, { browser: false }).some((skill) => skill.name === 'browser'), false);
  assert.equal(browserSkillForPlan(plan()), undefined);
});

test('the browser skill covers finding pages, refs, proof, and the read-only boundary', () => {
  const skill = browserSkillForPlan(plan({ provider: 'browserbase' }));
  assert.ok(skill);
  for (const phrase of [/Exa or Firecrawl/, /ref=e3/, /browser_look/, /browser_screenshot/, /browser_recording/, /Call it last/,
    /untrusted data/, /Never enter passwords/, /Public websites and check-only logins are read-only/, /mayChangeData/]) {
    assert.match(skill.instructions, phrase);
  }
  // Without granted logins the skill says signing in is unavailable.
  assert.match(skill.instructions, /no granted website logins, so it cannot sign in/);
  assert.doesNotMatch(skill.instructions, /browser_sign_in` with its loginId/);
});

test('the browser skill lists granted websites and the sign-in rules', () => {
  const skill = browserSkillForPlan({
    ...plan({ provider: 'browserbase' }),
    websiteLogins: [
      { id: 'wl_' + 'a'.repeat(32), host: 'github.com', label: 'GitHub', level: 'check', method: 'credentials', username: 'octo@example.com' },
      { id: 'wl_' + 'b'.repeat(32), host: 'portal.example.com', label: 'Portal', level: 'act', method: 'handoff' },
    ],
  });
  assert.ok(skill);
  assert.match(skill.description, /sign in to granted websites/);
  assert.match(skill.instructions, /## Signing in/);
  assert.match(skill.instructions, new RegExp(`- GitHub: github\\.com \\(loginId \`wl_a{32}\`, saved password, check only\\)`));
  assert.match(skill.instructions, new RegExp(`- Portal: portal\\.example\\.com \\(loginId \`wl_b{32}\`, the person signs in, may take actions with approval\\)`));
  for (const phrase of [/open it with `browser_open` first/, /call `browser_sign_in`/, /call `browser_handoff`/,
    /Never type credentials with `browser_act`/, /never reveal a username or password/, /does not by itself permit changing data/]) {
    assert.match(skill.instructions, phrase);
  }
  // An action login adds the approval loop: ask, end the reply, continue with the actionId.
  assert.match(skill.instructions, /## Taking actions/);
  for (const phrase of [/mayChangeData set to true/, /reply "approve" in this thread/, /or "stop"\. Then end your reply/,
    /approvedActionId set to that actionId/, /An approval covers one step only/]) {
    assert.match(skill.instructions, phrase);
  }
  const checkOnly = browserSkillForPlan({
    ...plan({ provider: 'browserbase' }),
    websiteLogins: [{ id: 'wl_' + 'a'.repeat(32), host: 'github.com', label: 'GitHub', level: 'check', method: 'credentials' }],
  });
  assert.doesNotMatch(checkOnly!.instructions, /## Taking actions|approvedActionId/);
  // The display username is never part of the skill text.
  assert.doesNotMatch(skill.instructions, /octo@example\.com/);
});

test('the sign-in tools mount with the browser and explain when the plan has no logins', async () => {
  const accumulator = createArtifactReceiptAccumulator((update) => {
    update({ schemaVersion: 1, receipts: [] });
  });
  const browserSession = new BrowserTurnSession({
    provider: fakeBrowserProvider().provider,
    connect: async () => {
      throw new Error('unused');
    },
  });
  const tools = createRuntimePlanArtifactTools(plan({ provider: 'browserbase' }), accumulator, () => {}, { browserSession });
  for (const name of ['browser_sign_in', 'browser_handoff']) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, name);
    const result = await (tool.run as (context: unknown) => Promise<{ output: { error?: string } }>)({
      data: { loginId: 'wl_x', reason: 'sign in', passwordRef: 'e1' },
      toolCallId: 'c',
      log: { info() {}, warn() {}, error() {} },
    });
    assert.match(result.output.error ?? '', /no website logins/);
  }
});

test('the legacy app-identity assembler never mounts the browser tools', async () => {
  const source = await readFile(new URL('../src/agents/slack-thread.ts', import.meta.url), 'utf8');
  const start = source.indexOf('const artifactCapability = createWorkspaceArtifactCapability(');
  assert.ok(start > 0);
  const legacy = source.slice(start, source.indexOf('if (input.registerActivityContext !== false)', start));
  assert.doesNotMatch(legacy, /createBrowserTools|browserSession/);
});
