#!/usr/bin/env node
/**
 * Select the authored core Cloudflare deployment or its optional Sandbox
 * overlay. This module is imported by Vite and also backs the cross-platform
 * npm convenience commands; no shell-specific environment assignment is
 * required.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const CORE_DEPLOYMENT_PROFILE = 'core';
export const SANDBOX_DEPLOYMENT_PROFILE = 'sandbox';
// Vite bundles this helper into a temporary config module, so import.meta.url
// no longer points at `scripts/` during a build. Vite and the npm wrappers run
// from the project root; resolve there to match Wrangler's authored-path
// behavior and keep the generated deploy redirect valid.
const SANDBOX_DOCKERFILE_PATH = path.resolve(process.cwd(), 'Dockerfile');

export function resolveCloudflareDeploymentProfile(value = process.env.CHICKPEA_DEPLOY_PROFILE) {
  if (value === undefined || value === '' || value === CORE_DEPLOYMENT_PROFILE) {
    return CORE_DEPLOYMENT_PROFILE;
  }
  if (value === SANDBOX_DEPLOYMENT_PROFILE) return SANDBOX_DEPLOYMENT_PROFILE;
  throw new Error(
    `Invalid CHICKPEA_DEPLOY_PROFILE=${JSON.stringify(value)}. ` +
      'Use "core" (or leave it unset) or use "sandbox".',
  );
}

function sandboxResources(config) {
  const bindings = config.durable_objects?.bindings ?? [];
  const sandboxBindings = bindings.filter(
    (binding) => binding?.name === 'SANDBOX' || binding?.class_name === 'Sandbox',
  );
  const containers = config.containers ?? [];
  const sandboxContainers = containers.filter((container) => container?.class_name === 'Sandbox');
  return { bindings, sandboxBindings, containers, sandboxContainers };
}

export function classifyCloudflareDeploymentProfile(config) {
  const { sandboxBindings, containers, sandboxContainers } = sandboxResources(config);
  if (sandboxBindings.length === 0 && containers.length === 0) return CORE_DEPLOYMENT_PROFILE;
  const container = sandboxContainers[0];
  const effectiveWorkerName = config.topLevelName ?? config.name;
  const derivedContainerName =
    typeof effectiveWorkerName === 'string' ? `${effectiveWorkerName}-sandbox` : undefined;
  if (
    sandboxBindings.length === 1 &&
    sandboxBindings[0]?.name === 'SANDBOX' &&
    sandboxBindings[0]?.class_name === 'Sandbox' &&
    containers.length === 1 &&
    sandboxContainers.length === 1 &&
    container?.instance_type === 'standard-1' &&
    container?.max_instances === 25 &&
    path.isAbsolute(container?.image ?? '') &&
    path.resolve(container.image) === SANDBOX_DOCKERFILE_PATH &&
    (container.name === undefined || container.name === derivedContainerName)
  ) {
    return SANDBOX_DEPLOYMENT_PROFILE;
  }
  throw new Error('Cloudflare artifact contains partial or duplicate Sandbox infrastructure.');
}

export function applyCloudflareDeploymentProfile(config, env = process.env) {
  const profile = resolveCloudflareDeploymentProfile(env.CHICKPEA_DEPLOY_PROFILE);
  const overrideName = env.WRANGLER_CI_OVERRIDE_NAME;
  if (typeof overrideName === 'string' && overrideName.length > 0) {
    // Wrangler applies this name during Deploy-button builds. Applying it at
    // Vite config time too lets the plugin derive a matching, collision-safe
    // Container application name instead of reusing `chickpea-sandbox`.
    config.name = overrideName;
    config.topLevelName = overrideName;
  }

  if (profile === CORE_DEPLOYMENT_PROFILE) return;
  if (classifyCloudflareDeploymentProfile(config) !== CORE_DEPLOYMENT_PROFILE) {
    throw new Error('The Sandbox overlay must be applied to the slim core Cloudflare config.');
  }

  config.durable_objects ??= {};
  config.durable_objects.bindings ??= [];
  config.durable_objects.bindings.push({ name: 'SANDBOX', class_name: 'Sandbox' });
  config.containers = [
    {
      class_name: 'Sandbox',
      // The Vite customizer runs after Wrangler has resolved authored paths,
      // so keep the generated redirect portable by resolving this new path
      // explicitly just as the plugin does for authored container entries.
      image: SANDBOX_DOCKERFILE_PATH,
      instance_type: 'standard-1',
      max_instances: 25,
    },
  ];
}

function runNpmScript(profile, script, forwardedArgs) {
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = npmExecPath
    ? [npmExecPath, 'run', script, ...(forwardedArgs.length ? ['--', ...forwardedArgs] : [])]
    : ['run', script, ...(forwardedArgs.length ? ['--', ...forwardedArgs] : [])];
  const result = spawnSync(command, args, {
    env: { ...process.env, CHICKPEA_DEPLOY_PROFILE: profile },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [profileValue, script, ...forwardedArgs] = process.argv.slice(2);
  const profile = resolveCloudflareDeploymentProfile(profileValue);
  if (profile !== SANDBOX_DEPLOYMENT_PROFILE || !['build', 'deploy'].includes(script ?? '')) {
    console.error(
      'Usage: node scripts/cloudflare-deployment-profile.mjs sandbox <build|deploy> [arguments...]',
    );
    process.exit(2);
  }
  runNpmScript(profile, script, forwardedArgs);
}
