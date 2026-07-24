import type { SkillConfig } from '../config/types.ts';
import type { SandboxSelection } from './select.ts';

export const WORKSPACE_SESSION_CAP_DECLINE =
  'The coding workspace is unavailable because this install has reached its monthly sandbox session cap. Decline requests that require running, building, testing, or screenshotting code, and explain that an operator must raise the cap or wait for the next UTC month. You may still use the Repositories skill for read-only questions or a small API-only change.';

const WORKSPACE_INSTRUCTIONS = [
  '# Coding workspace',
  '',
  'Choose the lightest repository path that can prove the result:',
  '',
  '- Use the **Repositories** GitHub API recipes to read code, answer repository questions, or make a small single-file pull request that does not need execution.',
  '- Open the full workspace with the shell and file tools when the task requires installing dependencies, changing multiple files, running or building code, executing tests, or taking a screenshot.',
  '',
  '## Full workspace loop',
  '',
  '1. Clone one of the granted repositories with a plain HTTPS URL, for example `git clone https://github.com/{owner}/{repo}.git`. Never add a credential to the URL. GitHub authentication is injected automatically at the sandbox egress boundary.',
  '2. Enter the clone and install its dependencies with the repository-native command, such as `npm ci` / `npm install` or `pip install`.',
  '3. Create a feature branch and make the requested changes.',
  '4. Run the relevant verification. Prefer the repository scripts; common fallbacks are `npm test` and `pytest`. Run a build when the task or repository requires one.',
  '5. Commit and push the branch early with normal Git commands. The workspace disk is ephemeral and a five-minute sleep wipes it, so the remote branch is the durable checkpoint.',
  '6. Open the pull request through the normal GitHub API recipe in the **Repositories** skill, then report the pull-request link. If retry context says a pull request was already recorded, report that link and do not open another.',
  '',
  '## Safety boundaries',
  '',
  '- Never place secrets, access tokens, private keys, credential files, or authenticated clone URLs in the workspace, command arguments, Git configuration, commits, or logs.',
  '- Do not attempt workflow dispatch or deployment approval operations. Sandbox egress denies them.',
  '- Stay inside the granted repository list and the allowed package registries. Explain policy denials instead of trying another host.',
].join('\n');

export function workspaceSkillForSandbox(
  selection: SandboxSelection,
  declineReason?: string,
): SkillConfig | undefined {
  if (selection === 'bash') return undefined;
  return {
    name: 'workspace',
    description:
      declineReason === undefined
        ? 'Run, build, test, and verify changes in an ephemeral coding workspace.'
        : 'Explain why the coding workspace is temporarily unavailable.',
    instructions:
      declineReason === undefined
        ? WORKSPACE_INSTRUCTIONS
        : ['# Coding workspace unavailable', '', declineReason].join('\n'),
    enabled: true,
  };
}
