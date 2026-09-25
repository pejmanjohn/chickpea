import type { SkillConfig } from '../config/types.ts';

/**
 * When to delegate to a coding worker and when to use the workspace tools
 * directly: the one statement of the rule, quoted by the coordinator's
 * standing instruction and the workspace skill.
 */
export const WORKSPACE_DELEGATION_GUIDANCE =
  'For repository work with several steps (clone, install dependencies, change several files, run tests or a build, push a branch, open a pull request), ' +
  'delegate to a coding worker with `workspace_task`. Use the workspace tools yourself (`workspace_exec`, `workspace_read`, `workspace_write`) ' +
  'only for a quick check or a single step, or when the worker fails.';

/**
 * The coordinator's standing instruction when a coding workspace is
 * available. The Agent itself always works in the virtual sandbox.
 */
export const CODING_WORKSPACE_INSTRUCTION =
  'You work in a private virtual sandbox: its filesystem is fresh for each request and it runs no real processes. ' +
  'Repository work that needs a real checkout, dependencies, tests, a build, a dev server, or screenshots happens in the coding workspace, ' +
  'a separate container you reach only through the workspace tools; ' +
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
  '## Several workspaces',
  '',
  'Every workspace tool takes an optional `workspace` name (default `main`). Use one workspace per repository when a request spans two, for example `api` and `web`; a name keeps its own files, checkpoint, and coding worker across requests in this thread. At most two workspaces can be open in this thread and each is its own container start, so prefer one workspace unless the work truly needs two. `workspace_list` shows every workspace, whether it is open, running, or checkpointed, and whether a task is running in it. If opening another is refused with `workspace_limit`, close one you no longer need with `workspace_close`. Only one `workspace_task` runs in a workspace at a time; a second is refused as `busy`, but tasks in two different workspaces can run in parallel.',
  '',
  '## Delegate multi-step work',
  '',
  `${WORKSPACE_DELEGATION_GUIDANCE} The worker runs the loop below with its own shell and file tools; tell it to push early. A follow-up task in the same thread continues the same worker, so "now fix the failing test" can be brief.`,
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

/** The workspace skill: the Agent reaches its coding workspace through tools. */
export function codingWorkspaceSkill(): SkillConfig {
  return {
    name: 'workspace',
    description: 'Clone, run, build, test, and verify repository changes in this thread\'s coding workspace through the workspace tools.',
    instructions: CODING_WORKSPACE_TOOLS_INSTRUCTIONS,
    enabled: true,
  };
}
