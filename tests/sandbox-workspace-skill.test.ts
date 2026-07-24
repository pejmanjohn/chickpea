import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  WORKSPACE_SESSION_CAP_DECLINE,
  workspaceSkillForSandbox,
} from '../src/sandbox/workspace-skill.ts';

test('workspace judge attaches only for a selected full workspace tier', () => {
  assert.equal(workspaceSkillForSandbox('bash'), undefined);
  assert.equal(workspaceSkillForSandbox('cloudflare')?.name, 'workspace');
  assert.equal(workspaceSkillForSandbox('local')?.name, 'workspace');
});

test('workspace skill teaches the coding loop without embedding credentials', () => {
  const instructions = workspaceSkillForSandbox('cloudflare')?.instructions ?? '';

  for (const expected of [
    'Use the **Repositories** GitHub API recipes',
    'running or building code',
    'git clone https://github.com/{owner}/{repo}.git',
    'npm install',
    'pip install',
    'npm test',
    'pytest',
    'Commit and push the branch early',
    'Open the pull request through the normal GitHub API recipe',
    'five-minute sleep wipes it',
    'require("playwright")',
    '--no-sandbox',
    '/workspace/screenshot.png',
    'post_artifact',
    'npm run dev',
    'curl --fail',
    '127.0.0.1',
    'kill "$(cat dev-server.pid)"',
    'Do not use `exposePort`',
    'public port exposure',
    'workflow dispatch',
    'deployment approval',
  ]) {
    assert.ok(instructions.includes(expected), expected);
  }

  assert.doesNotMatch(instructions, /Authorization\s*:/i);
  assert.doesNotMatch(instructions, /\bBearer\s+\S+/i);
  assert.doesNotMatch(instructions, /\$GITHUB_[A-Z_]*TOKEN/i);
  assert.doesNotMatch(instructions, /https:\/\/[^/\s]+@github\.com/i);
  assert.doesNotMatch(instructions, /\b(?:xox[baprs]-|gh[opsu]_|sk-[A-Za-z0-9])/i);
});

test('workspace skill gives a clear decline signal when the monthly cap is reached', () => {
  const skill = workspaceSkillForSandbox('cloudflare', WORKSPACE_SESSION_CAP_DECLINE);
  assert.match(skill?.instructions ?? '', /reached its monthly sandbox session cap/i);
  assert.match(skill?.instructions ?? '', /Decline requests that require running/i);
  assert.doesNotMatch(skill?.instructions ?? '', /git clone/i);
});
