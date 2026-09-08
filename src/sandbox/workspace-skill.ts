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
  '## Screenshot recipe',
  '',
  '1. Use the write tool to create a small CommonJS Playwright script named `screenshot.cjs` in the workspace root (`/workspace/screenshot.cjs` in the container). Load Chromium with `const { chromium } = require("playwright")`, launch it with `chromium.launch({ headless: true, args: ["--no-sandbox"] })`, open the loopback URL, and save a full-page PNG as `screenshot.png` in the workspace root (`/workspace/screenshot.png` in the container). The image and Playwright package are already present; `require("playwright")` resolves through `NODE_PATH`.',
  '2. Run it from the workspace root, for example `node screenshot.cjs http://127.0.0.1:3000`. Always close the browser in a `finally` block.',
  '3. Call `post_artifact` with path `/workspace/screenshot.png`, filename `screenshot.png`, and a short title. If it returns `missing-scope`, keep the verification result and describe the screenshot in the final reply as captured but not attached.',
  '',
  '## Run and verify internally',
  '',
  '1. Start the repository dev server in the background on a loopback port and record its process id, for example `npm run dev > dev-server.log 2>&1 & echo $! > dev-server.pid`. Run this from the workspace root so those files stay under `/workspace` in the container.',
  '2. Poll the local endpoint from inside the workspace until it is ready, for example with `curl --fail --silent --show-error http://127.0.0.1:3000/`. Use the repository\'s actual port and health route. A headless Playwright navigation is the stronger check when client rendering matters.',
  '3. Run the relevant browser assertion and screenshot recipe while the server is live. Inspect `dev-server.log` if readiness or verification fails.',
  '4. Stop the server when verification finishes, including after a failure: `kill "$(cat dev-server.pid)"` and confirm it exited.',
  '',
  'Keep verification private to the workspace. Do not use `exposePort`, public preview URLs, quick tunnels, or any other public port exposure in v1.',
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
