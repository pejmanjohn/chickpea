/**
 * Coding-sandbox deployment guards for `npm run deploy:sandbox`.
 *
 * `wrangler deploy` uploads the Worker version (with its SANDBOX Durable
 * Object binding) and routes all traffic to it *before* it builds the Docker
 * image and creates the Container application. A failure in either later step
 * leaves the live Worker half-applied. This module moves every predictable
 * failure ahead of the upload:
 *
 * - `preflightSandboxDeployment` checks the Docker daemon, pulls the base
 *   image (with retries: the build's metadata fetch is flaky right after
 *   Docker starts), and confirms the Wrangler credential can manage
 *   Containers. Each problem gets one actionable message, including a
 *   re-authentication command that is valid for how the operator signs in.
 * - `prebuildSandboxImage` builds and pushes the image with
 *   `wrangler containers build --push`, so the deploy only has to create or
 *   update the Container application from an image that already exists.
 * - `sandboxPartialDeployRecovery` and `verifySandboxContainerApplication`
 *   keep the epilogue honest when the upload happened but the Container step
 *   did not.
 *
 * Wrangler output can contain account details, so it is classified rather
 * than echoed, except for the build output that the operator watches live.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CONTAINERS_SCOPE = 'containers:write';
const MAX_OUTPUT = 256 * 1024;
const DOCKER_INFO_TIMEOUT_MS = 20_000;
const DOCKER_PULL_TIMEOUT_MS = 10 * 60_000;
const WRANGLER_READ_TIMEOUT_MS = 60_000;
const SCOPE_PATTERN = /^[a-z][a-z0-9_-]*[:.][a-z0-9_.-]+$/;
const PROFILE_NAME = /^[A-Za-z0-9_-]+$/;

function text(result) {
  return `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
}

function defaultRun(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_OUTPUT,
    ...options,
  });
}

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Mirrors Wrangler's own Docker selection so the preflight tests the same binary. */
export function dockerBinary(env = process.env) {
  return env.WRANGLER_DOCKER_BIN?.trim() || 'docker';
}

export function sandboxBaseImage(dockerfile) {
  const line = dockerfile.split(/\r?\n/).find((entry) => /^\s*FROM\s+/i.test(entry));
  const image = line?.trim().split(/\s+/)[1];
  if (!image || image.includes('$')) {
    throw new Error('The Sandbox Dockerfile has no literal base image; refusing to guess what to pull.');
  }
  return image;
}

/** Explicit `--profile` wins; otherwise a profile bound to this directory; otherwise the global login. */
export function resolveWranglerAuth({ env = process.env, providerContext = [], projectRoot, listProfiles }) {
  if (env.CLOUDFLARE_API_TOKEN?.trim() || env.CF_API_TOKEN?.trim() || env.CLOUDFLARE_API_KEY?.trim() || env.CF_API_KEY?.trim()) {
    return { kind: 'api-token' };
  }
  const index = providerContext.indexOf('--profile');
  if (index >= 0 && PROFILE_NAME.test(providerContext[index + 1] ?? '')) {
    return { kind: 'profile', profile: providerContext[index + 1], explicit: true };
  }
  const bound = boundProfile(listProfiles?.() ?? '', projectRoot);
  if (bound) return { kind: 'profile', profile: bound, explicit: false };
  return { kind: 'global' };
}

function canonical(directory) {
  const resolved = path.resolve(directory);
  try { return realpathSync(resolved); } catch {
    const parent = path.dirname(resolved);
    return parent === resolved ? resolved : path.join(canonical(parent), path.basename(resolved));
  }
}

/** Parse `wrangler auth list` (a table of profile names and bound directories). */
export function boundProfile(listing, projectRoot) {
  if (!projectRoot) return undefined;
  const root = canonical(projectRoot);
  let best;
  for (const line of listing.split(/\r?\n/)) {
    const cells = line.split(/[│|]/).map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 2 || !PROFILE_NAME.test(cells[0]) || cells[0] === 'Profile') continue;
    for (const directory of cells[1].split(',').map((entry) => entry.trim())) {
      if (!path.isAbsolute(directory)) continue;
      const bound = canonical(directory);
      const inside = root === bound || root.startsWith(`${bound}${path.sep}`);
      if (inside && (!best || bound.length > best.length)) best = { profile: cells[0], length: bound.length };
    }
  }
  return best?.profile;
}

/** Scopes Wrangler prints (as a table) when a command lacks a required OAuth scope. */
export function parseListedScopes(output) {
  const scopes = [];
  for (const line of output.split(/\r?\n/)) {
    const cells = line.split(/[│|]/).map((cell) => cell.trim()).filter(Boolean);
    const scope = cells[0];
    if (scope && SCOPE_PATTERN.test(scope) && scope !== CONTAINERS_SCOPE && !scopes.includes(scope)) {
      scopes.push(scope);
    }
  }
  return scopes;
}

/**
 * A re-authentication instruction that Wrangler 4.124 accepts:
 * `wrangler login --profile` is rejected, and `offline_access` is added
 * automatically so passing it is rejected as an invalid scope.
 */
export function containersReauthInstruction(auth, existingScopes = [], projectRoot) {
  const kept = existingScopes.filter((scope) => scope !== 'offline_access' && scope !== CONTAINERS_SCOPE);
  const scopes = [...kept, CONTAINERS_SCOPE].join(' ');
  const where = projectRoot ? `From ${projectRoot}, run:` : 'Run:';
  if (auth.kind === 'api-token') {
    return 'The Cloudflare API token in the environment cannot manage Containers. In the Cloudflare dashboard, open ' +
      'My Profile → API Tokens, edit that token, and add the account permission "Containers: Edit" while keeping its ' +
      'existing permissions (or create a replacement token with both). Then rerun the same command.';
  }
  const command = auth.kind === 'profile'
    ? `npx wrangler auth create ${auth.profile}${kept.length ? ` --scopes ${scopes}` : ''}`
    : `npx wrangler login${kept.length ? ` --scopes ${scopes}` : ''}`;
  const subject = auth.kind === 'profile'
    ? `The Wrangler auth profile "${auth.profile}" does not include ${CONTAINERS_SCOPE}.`
    : `The global Wrangler login does not include ${CONTAINERS_SCOPE}.`;
  const scopeNote = kept.length
    ? `This keeps the profile's current scopes and adds only ${CONTAINERS_SCOPE}; do not add offline_access, Wrangler adds it itself.`
    : `Wrangler did not report the current scopes, so this requests Wrangler's default scope set, which includes ${CONTAINERS_SCOPE}.`;
  const profileNote = auth.kind === 'profile'
    ? ' Re-authorizing replaces this profile\'s credentials in place (`wrangler auth create` is marked experimental; `wrangler login --profile` is not accepted).'
    : '';
  return `${subject} ${where}\n\n    ${command}\n\n${scopeNote}${profileNote} Authorize the same Cloudflare account, then rerun the same deploy command.`;
}

export function classifyContainersAccess(result) {
  if (!result.error && result.status === 0) {
    try {
      const apps = JSON.parse(result.stdout);
      if (Array.isArray(apps)) return { ok: true, apps };
    } catch { /* classified below */ }
  }
  const output = text(result);
  if (output.includes(`'${CONTAINERS_SCOPE}'`) || output.includes(`You need '${CONTAINERS_SCOPE}'`)) {
    return { ok: false, reason: 'scope', scopes: parseListedScopes(output) };
  }
  if (/not entitled|entitlement|subscription|paid plan|workers paid|upgrade your plan/i.test(output)) {
    return { ok: false, reason: 'plan' };
  }
  if (/Authentication error|code:\s*10000|\b403\b|forbidden|unauthori[sz]ed|not authorized/i.test(output)) {
    return { ok: false, reason: 'denied' };
  }
  if (/not authenticated|wrangler login/i.test(output)) return { ok: false, reason: 'signed-out' };
  return { ok: false, reason: 'unknown' };
}

function wranglerArgs(options, args) {
  return [options.wranglerBin, ...args, '--config', options.configPath, ...(options.providerContext ?? [])];
}

function runWrangler(options, args, timeout = WRANGLER_READ_TIMEOUT_MS) {
  const run = options.run ?? defaultRun;
  return run(process.execPath, wranglerArgs(options, args), {
    cwd: options.projectRoot,
    env: options.env ?? process.env,
    timeout,
  });
}

export function checkDockerDaemon(options) {
  const run = options.run ?? defaultRun;
  const docker = dockerBinary(options.env);
  const result = run(docker, ['info', '--format', '{{.ServerVersion}}'], {
    env: options.env ?? process.env, timeout: DOCKER_INFO_TIMEOUT_MS,
  });
  if (result.error?.code === 'ENOENT') {
    return 'Docker is not installed or not on PATH. `npm run deploy:sandbox` builds the Sandbox image locally: ' +
      'install Docker Desktop (or another Docker engine), start it, then rerun the same command. ' +
      'Set WRANGLER_DOCKER_BIN if Docker lives outside PATH.';
  }
  if (result.error || result.status !== 0) {
    return 'The Docker daemon is not reachable. Start Docker Desktop (or your Docker engine), wait until ' +
      '`docker info` succeeds, then rerun the same command. Nothing was built or uploaded.';
  }
  return undefined;
}

export function pullBaseImage(options) {
  const run = options.run ?? defaultRun;
  const sleep = options.sleep ?? defaultSleep;
  const attempts = options.attempts ?? 3;
  const docker = dockerBinary(options.env);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = run(docker, ['pull', '--platform', 'linux/amd64', options.image], {
      env: options.env ?? process.env, timeout: DOCKER_PULL_TIMEOUT_MS,
    });
    if (!result.error && result.status === 0) return undefined;
    if (attempt < attempts) {
      options.log?.(`Pulling ${options.image} failed (attempt ${attempt} of ${attempts}); retrying...\n`);
      sleep(attempt * (options.retryDelayMs ?? 5_000));
    }
  }
  return `Docker could not pull the Sandbox base image ${options.image} after ${attempts} attempts. ` +
    `Check network access to Docker Hub, run \`docker pull --platform linux/amd64 ${options.image}\` until it succeeds, ` +
    'then rerun the same command. Nothing was uploaded.';
}

export function checkContainersAccess(options) {
  const result = runWrangler(options, ['containers', 'list', '--json']);
  const access = classifyContainersAccess(result);
  if (access.ok) return { access };
  const account = options.accountId ? ` for account ${options.accountId}` : '';
  // `auth list` rejects --profile, so it runs without the provider context.
  const listProfiles = () => text((options.run ?? defaultRun)(process.execPath, [options.wranglerBin, 'auth', 'list'], {
    cwd: options.projectRoot, env: options.env ?? process.env, timeout: WRANGLER_READ_TIMEOUT_MS,
  }));
  const auth = resolveWranglerAuth({
    env: options.env ?? process.env,
    providerContext: options.providerContext ?? [],
    projectRoot: options.projectRoot,
    listProfiles: options.listProfiles ?? listProfiles,
  });
  switch (access.reason) {
    case 'scope':
      return { access, problem: containersReauthInstruction(auth, access.scopes, options.projectRoot) };
    case 'denied':
      return {
        access,
        problem: auth.kind === 'api-token'
          ? containersReauthInstruction(auth)
          : `Cloudflare refused Containers access${account}. Confirm the signed-in user can manage Containers on this ` +
            'account (Super Administrator or a role with Containers edit) and that the account is on Workers Paid. ' +
            containersReauthInstruction(auth, [], options.projectRoot),
      };
    case 'plan':
      return {
        access,
        problem: `Cloudflare Containers are not available${account}. The coding sandbox requires Workers Paid: ` +
          'upgrade under Workers & Pages → Plans in the Cloudflare dashboard, then rerun the same command.',
      };
    case 'signed-out':
      return { access, problem: 'Wrangler is not signed in for this deployment. Sign in the same way as for `npm run deploy`, then rerun.' };
    default:
      return {
        access,
        problem: `Wrangler could not confirm Containers access${account} (\`wrangler containers list\` failed). ` +
          'Confirm the account is on Workers Paid and that `npx wrangler containers list` works with the same ' +
          'flags you deploy with, then rerun. Nothing was uploaded.',
      };
  }
}

/** Run every check and return all problems, in the order an operator should fix them. */
export function preflightSandboxDeployment(options) {
  const problems = [];
  const log = options.log ?? ((message) => process.stdout.write(message));
  log('Checking coding sandbox prerequisites (Docker, base image, Containers access)...\n');
  const dockerProblem = checkDockerDaemon(options);
  if (dockerProblem) problems.push(dockerProblem);
  else {
    const image = sandboxBaseImage(readFileSync(options.dockerfilePath, 'utf8'));
    log(`Pulling Sandbox base image ${image}...\n`);
    const pullProblem = pullBaseImage({ ...options, image, log });
    if (pullProblem) problems.push(pullProblem);
  }
  if (options.checkContainers !== false) {
    const { problem } = checkContainersAccess(options);
    if (problem) problems.push(problem);
  }
  return problems;
}

export function formatPreflightProblems(problems) {
  return [
    `Coding sandbox preflight found ${problems.length} problem${problems.length === 1 ? '' : 's'}. Nothing was built, migrated, or uploaded.`,
    ...problems.map((problem, index) => `\n${index + 1}. ${problem}`),
  ].join('\n');
}

export function sandboxApplicationName(config) {
  const container = (config.containers ?? []).find((entry) => entry?.class_name === 'Sandbox');
  return container?.name ?? `${config.topLevelName ?? config.name}-sandbox`;
}

function defaultStream(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const collect = (target) => (chunk) => {
      target.write(chunk);
      output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT);
    };
    child.stdout.on('data', collect(process.stdout));
    child.stderr.on('data', collect(process.stderr));
    child.once('error', (error) => resolve({ status: null, error, output }));
    child.once('close', (status) => resolve({ status, output }));
  });
}

/**
 * Build and push the Sandbox image before the Worker upload. Returns the image
 * reference to put in the generated config so `wrangler deploy` only applies
 * the Container application. Retries are safe: nothing is live yet.
 */
export async function prebuildSandboxImage(options) {
  const stream = options.stream ?? defaultStream;
  const log = options.log ?? ((message) => process.stdout.write(message));
  const sleep = options.sleepAsync ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attempts = options.attempts ?? 3;
  const dockerfile = readFileSync(options.dockerfilePath);
  const digest = createHash('sha256').update(dockerfile).digest('hex').slice(0, 12);
  const tag = `${options.applicationName}:${digest}-${(options.now ?? Date.now)().toString(36)}`;
  // The Dockerfile copies nothing from the checkout, so a context holding only
  // the Dockerfile avoids sending the whole repository to the Docker daemon.
  const context = mkdtempSync(path.join(tmpdir(), 'chickpea-sandbox-image-'));
  try {
    copyFileSync(options.dockerfilePath, path.join(context, 'Dockerfile'));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      log(`Building and pushing the Sandbox image ${tag} before the Worker upload (attempt ${attempt} of ${attempts})...\n`);
      const result = await stream(process.execPath,
        wranglerArgs(options, ['containers', 'build', context, '--tag', tag, '--push']),
        { cwd: options.projectRoot, env: options.env ?? process.env });
      if (!result.error && result.status === 0) return pushedImageReference(result.output, tag);
      if (attempt < attempts) await sleep(attempt * (options.retryDelayMs ?? 10_000));
    }
  } finally {
    rmSync(context, { recursive: true, force: true });
  }
  throw new Error(
    `The Sandbox image did not build and push after ${attempts} attempts. Nothing was uploaded and the live Worker is unchanged. ` +
    'Read the Docker output above: a "DeadlineExceeded" or registry timeout usually clears once Docker has fully started ' +
    '(check with `docker pull --platform linux/amd64 <base image>`). Then rerun the same command.',
  );
}

/**
 * Wrangler rejects a bare `name:tag` in `containers[].image`, so the generated
 * config needs the account-registry reference. Wrangler first probes the
 * image by digest (`.../name@sha256:...`) and only then prints the tagged push
 * reference; prefer that exact reference, else pair the account registry with
 * the tag that was just pushed.
 */
export function pushedImageReference(output, tag) {
  const references = [...output.matchAll(/registry\.cloudflare\.com\/[a-f0-9]{32}\/[^\s'"`]+/gi)]
    .map(([reference]) => reference);
  const exact = references.find((reference) => reference.endsWith(`/${tag}`));
  if (exact) return exact;
  const registry = references[0]?.match(/^registry\.cloudflare\.com\/[a-f0-9]{32}\//i)?.[0];
  if (registry) return `${registry}${tag}`;
  throw new Error(
    `The Sandbox image ${tag} was built, but Wrangler did not report the Cloudflare registry it was pushed to. ` +
    'Nothing was uploaded and the live Worker is unchanged. Rerun the same command; if this repeats, ' +
    'check the `wrangler containers build --push` output above.',
  );
}

/** Point the generated config at the prebuilt image instead of the Dockerfile. */
export function useSandboxImage(config, image) {
  const container = (config.containers ?? []).find((entry) => entry?.class_name === 'Sandbox');
  if (!container) throw new Error('The Sandbox artifact has no Container to point at the prebuilt image.');
  container.image = image;
  return config;
}

export function rerunCommand({ explicitProductionTarget, deployArgs = [], workersBuilds = false }) {
  if (workersBuilds) return 'retry the Workers Builds deployment (keep the CHICKPEA_DEPLOY_PROFILE=sandbox build variable)';
  const prefix = explicitProductionTarget ? 'CHICKPEA_DEPLOY_TARGET=production ' : '';
  const args = deployArgs.filter((arg) => arg !== '--skip-build');
  return `${prefix}npm run deploy:sandbox${args.length ? ` -- ${args.join(' ')}` : ''}`;
}

/** Wrangler prints `Uploaded <worker>` once the version is live, before the Container step. */
export function uploadedBeforeFailure(stdout) {
  return /^Uploaded\s+\S+/m.test(stdout);
}

export function sandboxPartialDeployRecovery({ workerName, previousVersionId, providerContext = [], rerun }) {
  const profile = providerContext.includes('--profile')
    ? ` --profile ${providerContext[providerContext.indexOf('--profile') + 1]}` : '';
  return [
    '',
    'PARTIAL SANDBOX DEPLOY: the new Worker version is live with the SANDBOX binding, but its Container application',
    'was not created or updated. Ordinary Chickpea replies keep working; Admin → Settings → Coding sandbox reports',
    'Redeploy required until a Container application exists. Coding work cannot use the sandbox yet. Choose one:',
    '',
    `  1. Fix the error above and rerun the same command (the migrations and image push are safe to repeat):`,
    `       ${rerun}`,
    previousVersionId
      ? `  2. Or return to the version that was serving before this deploy:\n       npx wrangler rollback ${previousVersionId} --name ${workerName}${profile} --message "Undo partial sandbox deploy"`
      : '  2. Or roll back to the previous Worker version from Workers & Pages → your Worker → Deployments.',
    '',
  ].join('\n');
}

/**
 * After a successful deploy, confirm the Container application exists. Its
 * first rollout can still be in progress; that is reported, not hidden.
 */
export function verifySandboxContainerApplication(options) {
  const result = runWrangler(options, ['containers', 'list', '--json']);
  const access = classifyContainersAccess(result);
  if (!access.ok) {
    return { ok: false, message: 'The deploy finished, but Wrangler could not list Container applications to confirm the Sandbox. Check Workers & Pages → Containers before enabling the sandbox.' };
  }
  const app = access.apps.find((entry) => entry?.name === options.applicationName);
  if (!app) {
    return { ok: false, missing: true, message: `The deploy finished, but no Container application named ${options.applicationName} exists.` };
  }
  const state = typeof app.state === 'string' && /^[a-z_ -]{1,40}$/i.test(app.state) ? app.state : 'unknown';
  return { ok: true, state, message: `Container application ${options.applicationName} exists (state: ${state}).` };
}
