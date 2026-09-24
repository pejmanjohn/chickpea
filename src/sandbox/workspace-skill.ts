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
  '## Workspace lifetime',
  '',
  'The workspace belongs to this Slack thread. It stays warm between turns, so files from an earlier turn in this thread may still be there. After 30 minutes without a turn the container sleeps; when the thread resumes within three days, the workspace files are restored from a checkpoint, but installed dependencies such as `node_modules` or `.venv` are not, so reinstall them. The workspace is wiped when this Agent\'s repository access changes. Never assume either way: check before you clone.',
  '',
  '## Full workspace loop',
  '',
  '1. Run `ls /workspace` first. If the repository you need is already checked out, reuse it: enter it, run `git status`, and `git fetch` before relying on it. Otherwise clone one of the granted repositories with a plain HTTPS URL, for example `git clone https://github.com/{owner}/{repo}.git`. Never add a credential to the URL. GitHub authentication is injected automatically at the sandbox egress boundary.',
  '2. Enter the clone and install its dependencies with the repository-native command, such as `npm ci` / `npm install` or `pip install`.',
  '3. Create a feature branch and make the requested changes.',
  '4. Run the relevant verification. Prefer the repository scripts; common fallbacks are `npm test` and `pytest`. Run a build when the task or repository requires one.',
  '5. Commit and push the branch early with normal Git commands. The workspace disk does not outlive an idle thread, so the remote branch is the durable checkpoint. The Git author and committer are preset for this workspace: never set or change `user.name` or `user.email`, and never pass `--author`.',
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

/**
 * The coordinator's standing instruction when a coding workspace is
 * available. The Agent itself always works in the virtual sandbox.
 */
export const CODING_WORKSPACE_INSTRUCTION =
  'You work in a private virtual sandbox: its filesystem is fresh for each request and it runs no real processes. ' +
  'For repository work that needs a real checkout, dependencies, tests, a build, a dev server, or screenshots, ' +
  'open the coding workspace with workspace_open and work in it with workspace_exec, workspace_write, and workspace_read; ' +
  'use workspace_write and workspace_read to move files between your sandbox and the workspace. ' +
  'The workspace is ephemeral: its files survive only while it is warm or checkpointed, installed dependencies are never checkpointed, ' +
  'and a pushed branch is the only durable result. Never assume a file from an earlier request exists without checking, and never store secrets in it. ' +
  'If a workspace tool reports the workspace unavailable or its session limit reached, say so and use the Repositories API skill if it covers the request; ' +
  'do not retry the same call in the same reply.';

const CODING_WORKSPACE_TOOLS_INSTRUCTIONS = [
  '# Coding workspace',
  '',
  'Choose the lightest repository path that can prove the result:',
  '',
  '- Use the **Repositories** GitHub API recipes to read code, answer repository questions, or make a small single-file pull request that does not need execution.',
  '- Use the coding workspace when the task requires cloning, installing dependencies, changing multiple files, running or building code, executing tests, or taking a screenshot.',
  '',
  'The coding workspace is a separate Linux container. Your own shell and file tools (`bash`, `read`, `write`, `edit`) run in your virtual sandbox, never in the workspace, and cannot clone a repository. Reach the workspace only through the workspace tools: `workspace_open`, `workspace_exec` (one shell command per call), `workspace_write`, `workspace_read`, `workspace_list_files`, `workspace_close`, and `post_artifact` with `workspace: "main"`.',
  '',
  '## Workspace lifetime',
  '',
  'The workspace belongs to this Agent in this Slack thread. It stays warm between requests, so files from an earlier request in this thread may still be there. After 30 minutes without use the container sleeps; when the thread resumes within three days, the workspace files are restored from a checkpoint, but installed dependencies such as `node_modules` or `.venv` are not, so reinstall them. The workspace is wiped when this Agent\'s repository access changes. Never assume either way: check before you clone.',
  '',
  '## Delegate multi-step work',
  '',
  'For work with several steps (clone, install, change files, test, push, open a pull request), prefer `workspace_task`: a coding worker does the whole loop in the workspace with its own shell and file tools and returns its answer and any pull request links. It cannot see this conversation, so write a complete brief: the repository, what to change, how to verify it, the branch name, and whether to open a pull request. Tell it to push early. Report the pull request links it returns. A follow-up task in the same thread continues the same worker, so "now fix the failing test" can be brief. Use the loop below yourself for a quick check or a single step, or when the worker fails.',
  '',
  '## Workspace loop',
  '',
  '1. Call `workspace_open`, then run `ls /workspace` with `workspace_exec`. If the repository you need is already checked out, reuse it: run `git status` and `git fetch` in it before relying on it. Otherwise clone one of the granted repositories with a plain HTTPS URL, for example `git clone https://github.com/{owner}/{repo}.git`. Never add a credential to the URL. GitHub authentication is injected automatically at the workspace egress boundary.',
  '2. Every `workspace_exec` call starts a fresh shell, so pass the repository directory as `cwd` (for example `/workspace/{repo}`) or chain steps with `&&` in one command. Install dependencies with the repository-native command, such as `npm ci` / `npm install` or `pip install`.',
  '3. Create a feature branch and make the requested changes: write whole files with `workspace_write`, or edit in place with a command such as `sed` or `git apply` through `workspace_exec`. Read files back with `workspace_read`.',
  '4. Run the relevant verification. Prefer the repository scripts; common fallbacks are `npm test` and `pytest`. Run a build when the task or repository requires one. Give long commands a larger `timeoutMs`.',
  '5. Commit and push the branch early with normal Git commands. The workspace disk does not outlive an idle thread, so the remote branch is the durable checkpoint. The Git author and committer are preset for this workspace: never set or change `user.name` or `user.email`, and never pass `--author`.',
  '6. Open the pull request through the normal GitHub API recipe in the **Repositories** skill, then report the pull-request link. If retry context says a pull request was already recorded, report that link and do not open another.',
  '',
  '## Screenshot recipe',
  '',
  '1. Use `workspace_write` to create a small CommonJS Playwright script at `/workspace/screenshot.cjs`. Load Chromium with `const { chromium } = require("playwright")`, launch it with `chromium.launch({ headless: true, args: ["--no-sandbox"] })`, open the loopback URL, and save a full-page PNG as `/workspace/screenshot.png`. The image and Playwright package are already present; `require("playwright")` resolves through `NODE_PATH`.',
  '2. Run it with `workspace_exec` from `/workspace`, for example `node screenshot.cjs http://127.0.0.1:3000`. Always close the browser in a `finally` block.',
  '3. Call `post_artifact` with `workspace: "main"`, path `/workspace/screenshot.png`, filename `screenshot.png`, and a short title. If it returns `missing-scope`, keep the verification result and describe the screenshot in the final reply as captured but not attached.',
  '',
  '## Run and verify internally',
  '',
  '1. Start the repository dev server in the background on a loopback port with one `workspace_exec` call, and record its process id, for example `nohup npm run dev > /workspace/dev-server.log 2>&1 & echo $! > /workspace/dev-server.pid`.',
  '2. Poll the local endpoint with later `workspace_exec` calls until it is ready, for example `curl --fail --silent --show-error http://127.0.0.1:3000/`. Use the repository\'s actual port and health route. A headless Playwright navigation is the stronger check when client rendering matters.',
  '3. Run the relevant browser assertion and screenshot recipe while the server is live. Read `/workspace/dev-server.log` if readiness or verification fails.',
  '4. Stop the server when verification finishes, including after a failure: `kill "$(cat /workspace/dev-server.pid)"` and confirm it exited.',
  '',
  'Keep verification private to the workspace. Do not use `exposePort`, public preview URLs, quick tunnels, or any other public port exposure in v1.',
  '',
  '## When the workspace fails',
  '',
  '- A workspace tool that returns `ok: false` with `workspace_unavailable` or `session_cap` means the coding workspace cannot be used for this request. Say so plainly, offer the Repositories API path if it covers the request, and do not retry the same call in the same reply. Everything else you can do, including connections and files in your own sandbox, still works.',
  '- If the workspace is broken (commands hang or its contents are wrong), call `workspace_close` with `discard: true` and open it again; it starts empty.',
  '',
  '## Safety boundaries',
  '',
  '- Never place secrets, access tokens, private keys, credential files, or authenticated clone URLs in the workspace, command arguments, Git configuration, commits, or logs.',
  '- Do not attempt workflow dispatch or deployment approval operations. Workspace egress denies them.',
  '- The workspace reaches only the granted repositories and the allowed package registries; it cannot reach connected services. Call connections from your own tools and write any results the workspace needs into it. Explain policy denials instead of trying another host.',
].join('\n');

/** The workspace skill for a current plan, whose Agent reaches the workspace through tools. */
export function codingWorkspaceSkill(): SkillConfig {
  return {
    name: 'workspace',
    description: 'Clone, run, build, test, and verify repository changes in this thread\'s coding workspace through the workspace tools.',
    instructions: CODING_WORKSPACE_TOOLS_INSTRUCTIONS,
    enabled: true,
  };
}

/** The in-container workspace skill for a plan admitted with an attached container. */
export function workspaceSkillForSandbox(
  selection: SandboxSelection,
  declineReason?: string,
): SkillConfig | undefined {
  if (selection === 'bash') return undefined;
  return {
    name: 'workspace',
    description:
      declineReason === undefined
        ? 'Run, build, test, and verify changes in this thread\'s coding workspace.'
        : 'Explain why the coding workspace is temporarily unavailable.',
    instructions:
      declineReason === undefined
        ? WORKSPACE_INSTRUCTIONS
        : ['# Coding workspace unavailable', '', declineReason].join('\n'),
    enabled: true,
  };
}
