import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CODING_WORKSPACE_INSTRUCTION,
  codingWorkspaceSkill,
} from '../src/sandbox/workspace-skill.ts';

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
