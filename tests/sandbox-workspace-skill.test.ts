import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CODING_WORKSPACE_INSTRUCTION,
  WORKSPACE_SESSION_CAP_DECLINE,
  codingWorkspaceSkill,
  workspaceSkillForSandbox,
} from '../src/sandbox/workspace-skill.ts';

test('workspace judge attaches only for a selected full workspace tier', () => {
  assert.equal(workspaceSkillForSandbox('bash'), undefined);
  assert.equal(workspaceSkillForSandbox('cloudflare')?.name, 'workspace');
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
    'The Git author and committer are preset',
    'Open the pull request through the normal GitHub API recipe',
    'After 30 minutes without a turn the container sleeps',
    'restored from a checkpoint',
    'reinstall them',
    'Run `ls /workspace` first',
    'does not outlive an idle thread',
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

test('the coordinator workspace skill drives the container through tools without embedding credentials', () => {
  const skill = codingWorkspaceSkill();
  assert.equal(skill.name, 'workspace');
  for (const expected of [
    'Use the **Repositories** GitHub API recipes',
    '`workspace_open`',
    '`workspace_exec`',
    '`workspace_write`',
    'git clone https://github.com/{owner}/{repo}.git',
    'pass the repository directory as `cwd`',
    'Commit and push the branch early',
    'never set or change `user.name` or `user.email`',
    'Open the pull request through the normal GitHub API recipe',
    'restored from a checkpoint',
    'post_artifact` with `workspace: "main"`',
    '`workspace_unavailable` or `session_cap`',
    'do not retry the same call in the same reply',
    '`discard: true`',
    'cannot reach connected services',
    'Do not use `exposePort`',
  ]) {
    assert.ok(skill.instructions.includes(expected), expected);
  }
  for (const text of [skill.instructions, CODING_WORKSPACE_INSTRUCTION]) {
    assert.doesNotMatch(text, /Authorization\s*:/i);
    assert.doesNotMatch(text, /\bBearer\s+\S+/i);
    assert.doesNotMatch(text, /https:\/\/[^/\s]+@github\.com/i);
  }
  assert.match(CODING_WORKSPACE_INSTRUCTION, /private virtual sandbox/);
  assert.match(CODING_WORKSPACE_INSTRUCTION, /Repositories API skill/);
});
