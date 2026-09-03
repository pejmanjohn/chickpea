#!/usr/bin/env node
/**
 * Select the authored core Cloudflare deployment or its optional Sandbox
 * overlay. This module is imported by Vite and also backs the cross-platform
 * npm convenience commands; no shell-specific environment assignment is
 * required.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const CORE_DEPLOYMENT_PROFILE = 'core';
export const SANDBOX_DEPLOYMENT_PROFILE = 'sandbox';
export const ACTIVE_CLOUDFLARE_DEPLOYMENT_TARGETS = Object.freeze([
  'amber',
  'cobalt',
]);
const TARGET_DEFINITIONS = Object.freeze(Object.fromEntries(
  ACTIVE_CLOUDFLARE_DEPLOYMENT_TARGETS.map((target) => [target, Object.freeze({
    target,
    workerName: `chickpea-${target}-live`,
    authDatabaseBinding: 'AUTH_DB',
    authDatabaseName: `chickpea-auth-db-${target}-live`,
  })]),
));
const TARGET_VAR = 'CHICKPEA_DEPLOY_TARGET';
const TARGET_AUTH_DB_ID_VAR = 'CHICKPEA_DEPLOY_AUTH_DB_ID';
const TARGET_SCHEMA_GENERATION_VAR = 'CHICKPEA_DEPLOY_SCHEMA_GENERATION';
const AUTH_DB_SCHEMA_GENERATION_VAR = 'CHICKPEA_AUTH_DB_SCHEMA_GENERATION';
const DURABLE_OBJECT_SCHEMA_GENERATION_VAR = 'CHICKPEA_DURABLE_OBJECT_SCHEMA_GENERATION';
const TARGET_STATE_MODE_VAR = 'CHICKPEA_DEPLOY_STATE_MODE';
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

export function resolveCloudflareDeploymentTarget(value = process.env[TARGET_VAR]) {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'string' && ACTIVE_CLOUDFLARE_DEPLOYMENT_TARGETS.includes(value)) {
    return value;
  }
  throw new Error(
    `Invalid ${TARGET_VAR}=${JSON.stringify(value)}. ` +
      `Use exactly one of ${ACTIVE_CLOUDFLARE_DEPLOYMENT_TARGETS.join(', ')}.`,
  );
}

function trimmed(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function onlyAuthDatabase(config, target) {
  const authDatabases = (config.d1_databases ?? []).filter(
    (binding) => binding?.binding === 'AUTH_DB',
  );
  if (authDatabases.length !== 1) {
    throw new Error(
      `Cloudflare deployment target ${target} requires exactly one AUTH_DB binding.`,
    );
  }
  return authDatabases[0];
}

function d1SchemaGeneration(authDatabase) {
  const configuredDirectory = trimmed(authDatabase.migrations_dir);
  if (!configuredDirectory) {
    throw new Error('Cloudflare deployment target requires reviewed AUTH_DB migrations.');
  }
  const directory = path.isAbsolute(configuredDirectory)
    ? configuredDirectory
    : path.resolve(process.cwd(), configuredDirectory);
  let migrations;
  try {
    migrations = readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort();
  } catch (error) {
    throw new Error(
      `Unable to resolve the AUTH_DB schema generation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const current = migrations.at(-1);
  if (!current) throw new Error('Unable to resolve the AUTH_DB schema generation: no SQL migrations.');
  return path.basename(current, '.sql');
}

function durableObjectSchemaGeneration(config) {
  const migrations = config.migrations ?? [];
  const tags = migrations.map((migration) => trimmed(migration?.tag));
  if (tags.length === 0 || tags.some((tag) => tag === undefined) || new Set(tags).size !== tags.length) {
    throw new Error('Unable to resolve one ordered Durable Object schema generation.');
  }
  return tags.at(-1);
}

function combinedSchemaGeneration(d1Generation, durableObjectGeneration) {
  return `d1:${d1Generation};do:${durableObjectGeneration}`;
}

function targetDefinition(target) {
  return TARGET_DEFINITIONS[target];
}

/**
 * Validate the selected immutable identity against non-secret registrations
 * supplied by the environment-registry layer. This helper intentionally does
 * not load or define that registry; callers provide only its resolved target
 * coordinates.
 */
export function validateCloudflareDeploymentTargetIdentity(
  selected,
  registeredTargetIdentities = [],
) {
  if (!Array.isArray(registeredTargetIdentities)) {
    throw new Error('Cloudflare deployment target identities must be an array.');
  }
  if (!ACTIVE_CLOUDFLARE_DEPLOYMENT_TARGETS.includes(selected?.target)) {
    throw new Error('Cloudflare selected deployment target identity is invalid.');
  }
  const selectedDefinition = targetDefinition(selected.target);
  if (
    selected.workerName !== selectedDefinition.workerName ||
    selected.authDatabaseBinding !== selectedDefinition.authDatabaseBinding ||
    selected.authDatabaseName !== selectedDefinition.authDatabaseName
  ) {
    throw new Error(
      `The immutable AUTH_DB identity for ${selected.target} does not agree with its Worker, binding, and database name.`,
    );
  }
  const immutableOwners = new Map();
  for (const registration of registeredTargetIdentities) {
    const target = registration?.target;
    if (!ACTIVE_CLOUDFLARE_DEPLOYMENT_TARGETS.includes(target)) {
      throw new Error(`Cloudflare registered deployment target ${JSON.stringify(target)} is invalid.`);
    }
    const definition = targetDefinition(target);
    const databaseId = trimmed(registration?.authDatabaseId);
    const coordinatesAgree =
      registration?.workerName === definition.workerName &&
      registration?.authDatabaseBinding === definition.authDatabaseBinding &&
      registration?.authDatabaseName === definition.authDatabaseName;
    if (!coordinatesAgree) {
      throw new Error(
        `The immutable AUTH_DB identity for ${target} does not agree with its Worker, binding, and database name.`,
      );
    }
    if (
      target === selected.target &&
      selected.authDatabaseId &&
      databaseId &&
      databaseId !== selected.authDatabaseId
    ) {
      throw new Error(`The immutable AUTH_DB identity for ${target} disagrees with the selected ID.`);
    }
    if (!databaseId) continue;
    const previousOwner = immutableOwners.get(databaseId);
    if (previousOwner && previousOwner !== target) {
      throw new Error(
        `AUTH_DB identity ${databaseId} is registered to both ${previousOwner} and ${target}.`,
      );
    }
    immutableOwners.set(databaseId, target);
    if (selected.authDatabaseId === databaseId && target !== selected.target) {
      throw new Error(
        `AUTH_DB identity ${databaseId} is registered to ${target}, not selected target ${selected.target}.`,
      );
    }
  }
  return selected;
}

function prepareCloudflareDeploymentTarget(config, env, options) {
  const target = resolveCloudflareDeploymentTarget(env[TARGET_VAR]);
  if (!target) return undefined;
  const definition = targetDefinition(target);
  const authDatabase = onlyAuthDatabase(config, target);
  const configuredDatabaseId = trimmed(authDatabase.database_id);
  const immutableDatabaseId = trimmed(env[TARGET_AUTH_DB_ID_VAR]);
  if (
    authDatabase.database_name === definition.authDatabaseName &&
    configuredDatabaseId &&
    configuredDatabaseId !== immutableDatabaseId
  ) {
    throw new Error(
      `Cloudflare deployment target ${target} has AUTH_DB identity ${configuredDatabaseId}, ` +
      `but ${TARGET_AUTH_DB_ID_VAR} does not select that immutable database.`,
    );
  }
  const d1Generation = d1SchemaGeneration(authDatabase);
  const durableObjectGeneration = durableObjectSchemaGeneration(config);
  const schemaGeneration = combinedSchemaGeneration(d1Generation, durableObjectGeneration);
  const stateMode = immutableDatabaseId ? 'permanent' : 'disposable';
  if (stateMode === 'permanent' && trimmed(env[TARGET_SCHEMA_GENERATION_VAR]) !== schemaGeneration) {
    throw new Error(
      `Cloudflare permanent target ${target} must be explicitly advanced to schema generation ` +
      `${schemaGeneration}; older revisions are barred.`,
    );
  }
  const selected = {
    ...definition,
    authDatabaseId: immutableDatabaseId,
    d1SchemaGeneration: d1Generation,
    durableObjectSchemaGeneration: durableObjectGeneration,
    schemaGeneration,
    stateMode,
  };
  validateCloudflareDeploymentTargetIdentity(
    selected,
    options.registeredTargetIdentities ?? [],
  );
  return { selected, authDatabase };
}

export function readCloudflareDeploymentTargetTuple(config, env = process.env) {
  const requestedTarget = resolveCloudflareDeploymentTarget(env[TARGET_VAR]);
  const stampedTarget = trimmed(config.vars?.[TARGET_VAR]);
  if (!requestedTarget) {
    if (stampedTarget) {
      throw new Error(
        `Cloudflare deployment target mismatch: no target selected, generated ${stampedTarget}.`,
      );
    }
    return undefined;
  }
  const definition = targetDefinition(requestedTarget);
  const authDatabase = onlyAuthDatabase(config, requestedTarget);
  const immutableDatabaseId = trimmed(env[TARGET_AUTH_DB_ID_VAR]);
  const databaseId = trimmed(authDatabase.database_id);
  const d1Generation = trimmed(config.vars?.[AUTH_DB_SCHEMA_GENERATION_VAR]);
  const durableObjectGeneration = trimmed(config.vars?.[DURABLE_OBJECT_SCHEMA_GENERATION_VAR]);
  const schemaGeneration = trimmed(config.vars?.[TARGET_SCHEMA_GENERATION_VAR]);
  const stateMode = trimmed(config.vars?.[TARGET_STATE_MODE_VAR]);
  const expectedSchemaGeneration = d1Generation && durableObjectGeneration
    ? combinedSchemaGeneration(d1Generation, durableObjectGeneration)
    : undefined;
  const failures = [];
  if (stampedTarget !== requestedTarget) failures.push(`target stamp ${requestedTarget}`);
  if (config.name !== definition.workerName) failures.push(`Worker ${definition.workerName}`);
  if (config.topLevelName !== undefined && config.topLevelName !== definition.workerName) {
    failures.push(`top-level Worker ${definition.workerName}`);
  }
  if (authDatabase.database_name !== definition.authDatabaseName) {
    failures.push(`AUTH_DB name ${definition.authDatabaseName}`);
  }
  if (!d1Generation) failures.push('D1 schema generation');
  if (!durableObjectGeneration) failures.push('Durable Object schema generation');
  if (!schemaGeneration || schemaGeneration !== expectedSchemaGeneration) {
    failures.push('one combined schema generation');
  }
  if (immutableDatabaseId && databaseId !== immutableDatabaseId) {
    failures.push(`immutable AUTH_DB ID ${immutableDatabaseId}`);
  }
  const expectedStateMode = immutableDatabaseId ? 'permanent' : 'disposable';
  if (stateMode !== expectedStateMode) failures.push(`${expectedStateMode} state mode`);
  if (
    immutableDatabaseId &&
    trimmed(env[TARGET_SCHEMA_GENERATION_VAR]) !== schemaGeneration
  ) {
    failures.push(`permanent schema advancement ${schemaGeneration}`);
  }
  if (failures.length) {
    throw new Error(
      `Cloudflare deployment target ${requestedTarget} is missing or unsafe: ${failures.join(', ')}.`,
    );
  }
  return {
    ...definition,
    authDatabaseId: databaseId,
    d1SchemaGeneration: d1Generation,
    durableObjectSchemaGeneration: durableObjectGeneration,
    schemaGeneration,
    stateMode,
  };
}

export function formatCloudflareDeploymentTargetTuple(tuple) {
  return (
    `Deployment target: target=${tuple.target} worker=${tuple.workerName} ` +
    `auth_db=${tuple.authDatabaseBinding}/${tuple.authDatabaseName} ` +
    `auth_db_id=${tuple.authDatabaseId ?? 'disposable'} ` +
    `d1_schema=${tuple.d1SchemaGeneration} ` +
    `do_schema=${tuple.durableObjectSchemaGeneration} state=${tuple.stateMode}`
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

export function applyCloudflareDeploymentProfile(config, env = process.env, options = {}) {
  const profile = resolveCloudflareDeploymentProfile(env.CHICKPEA_DEPLOY_PROFILE);
  if (profile === SANDBOX_DEPLOYMENT_PROFILE && classifyCloudflareDeploymentProfile(config) !== CORE_DEPLOYMENT_PROFILE) {
    throw new Error('The Sandbox overlay must be applied to the slim core Cloudflare config.');
  }
  const preparedTarget = prepareCloudflareDeploymentTarget(config, env, options);
  const overrideName = env.WRANGLER_CI_OVERRIDE_NAME;
  if (
    preparedTarget &&
    typeof overrideName === 'string' &&
    overrideName.length > 0 &&
    overrideName !== preparedTarget.selected.workerName
  ) {
    throw new Error(
      `WRANGLER_CI_OVERRIDE_NAME must match selected target Worker ${preparedTarget.selected.workerName}.`,
    );
  }
  if (preparedTarget) {
    const { selected, authDatabase } = preparedTarget;
    config.name = selected.workerName;
    config.topLevelName = selected.workerName;
    authDatabase.database_name = selected.authDatabaseName;
    authDatabase.database_id = selected.authDatabaseId ?? '';
    config.vars = {
      ...(config.vars ?? {}),
      [TARGET_VAR]: selected.target,
      [AUTH_DB_SCHEMA_GENERATION_VAR]: selected.d1SchemaGeneration,
      [DURABLE_OBJECT_SCHEMA_GENERATION_VAR]: selected.durableObjectSchemaGeneration,
      [TARGET_SCHEMA_GENERATION_VAR]: selected.schemaGeneration,
      [TARGET_STATE_MODE_VAR]: selected.stateMode,
    };
  } else if (typeof overrideName === 'string' && overrideName.length > 0) {
    // Wrangler applies this name during Deploy-button builds. Applying it at
    // Vite config time too lets the plugin derive a matching, collision-safe
    // Container application name instead of reusing `chickpea-sandbox`.
    config.name = overrideName;
    config.topLevelName = overrideName;
  }

  if (profile === SANDBOX_DEPLOYMENT_PROFILE) {
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
  return preparedTarget?.selected;
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
