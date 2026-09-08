import { createHash } from 'node:crypto';
import { compareVersions, STABLE_VERSION, RECOVERY_POLICIES } from './release-manifest.mjs';

// Literal, reviewed names: accepting a prefix would silently bless future
// configuration (or credentials) that the upgrader does not understand.
export const PRESERVED_VARIABLES = new Set(`
CHICKPEA_GATEWAY_URL SLACK_BOT_USER_ID SLACK_API_URL SLACK_TAG_PUBLIC_URL
SLACK_TAG_UNASSIGNED_HINT SLACK_TAG_WELCOME_ON_JOIN SLACK_TAG_PROGRESSIVE_STREAMING
SLACK_TAG_LEDGER_CANARY_CHANNELS SLACK_TAG_MODEL CHICKPEA_LIVE_CHANNEL_CONFIG
CHICKPEA_COMPOSIO_CONFIGURATION_MODE CHICKPEA_INSTALLATION_ID DO_NOT_TRACK
CHICKPEA_DISABLE_TELEMETRY CHICKPEA_TELEMETRY_ENVIRONMENT CHICKPEA_DEPLOYMENT_EPOCH
TAG_RUN_BODY_RETENTION_DAYS TAG_OPENAI_SUBSCRIPTION_ENABLED USAGE_RUNTIME_RECORDING
USAGE_ESTIMATES USAGE_ADMIN_UI
COMPOSIO_GMAIL_READ_AUTH_CONFIG_ID COMPOSIO_GMAIL_WRITE_AUTH_CONFIG_ID
COMPOSIO_CALENDAR_READ_AUTH_CONFIG_ID COMPOSIO_CALENDAR_WRITE_AUTH_CONFIG_ID
COMPOSIO_DRIVE_READ_AUTH_CONFIG_ID COMPOSIO_DRIVE_WRITE_AUTH_CONFIG_ID
COMPOSIO_SHEETS_READ_AUTH_CONFIG_ID COMPOSIO_SHEETS_WRITE_AUTH_CONFIG_ID
COMPOSIO_DOCS_READ_AUTH_CONFIG_ID COMPOSIO_DOCS_WRITE_AUTH_CONFIG_ID
COMPOSIO_SLIDES_READ_AUTH_CONFIG_ID COMPOSIO_SLIDES_WRITE_AUTH_CONFIG_ID
COMPOSIO_NOTION_READ_AUTH_CONFIG_ID COMPOSIO_NOTION_WRITE_AUTH_CONFIG_ID
COMPOSIO_SEARCH_CONSOLE_READ_AUTH_CONFIG_ID COMPOSIO_ANALYTICS_READ_AUTH_CONFIG_ID
COMPOSIO_GONG_READ_AUTH_CONFIG_ID COMPOSIO_HUBSPOT_READ_AUTH_CONFIG_ID COMPOSIO_HUBSPOT_WRITE_AUTH_CONFIG_ID
COMPOSIO_GOOGLE_ADS_READ_AUTH_CONFIG_ID COMPOSIO_GOOGLE_ADS_WRITE_AUTH_CONFIG_ID
COMPOSIO_GOOGLE_ADS_ACCESS_LEVEL COMPOSIO_GOOGLE_ADS_PERMISSIBLE_USE
COMPOSIO_YOUTUBE_READ_AUTH_CONFIG_ID COMPOSIO_YOUTUBE_WRITE_AUTH_CONFIG_ID
COMPOSIO_YOUTUBE_GENERAL_DAILY_QUOTA_UNITS COMPOSIO_YOUTUBE_SEARCH_DAILY_CALL_LIMIT
COMPOSIO_YOUTUBE_UPLOAD_DAILY_CALL_LIMIT COMPOSIO_YOUTUBE_QUOTA_AUDIT_APPROVED
ANTHROPIC_CREDENTIAL_ALIAS ANTHROPIC_CREDENTIAL_EPOCH OPENAI_CREDENTIAL_ALIAS OPENAI_CREDENTIAL_EPOCH
OPENROUTER_CREDENTIAL_ALIAS OPENROUTER_CREDENTIAL_EPOCH CLOUDFLARE_WORKERS_AI_CREDENTIAL_ALIAS CLOUDFLARE_WORKERS_AI_CREDENTIAL_EPOCH
ANTHROPIC_BASE_URL ANTHROPIC_API_URL OPENAI_API_URL OPENROUTER_API_URL
CLOUDFLARE_WORKERS_AI_BASE_URL CLOUDFLARE_API_URL
`.trim().split(/\s+/));

const SETUP_NAMES = ['CHICKPEA_SETUP_CAPABILITY_DIGEST', 'CHICKPEA_SETUP_CAPABILITY_ISSUED_AT'];
const BUILD_NAMES = new Set(['CHICKPEA_APP_VERSION', 'CHICKPEA_SOURCE_COMMIT', 'CHICKPEA_DEPLOYMENT_ACTIVATION_DIGEST', 'CHICKPEA_DEPLOYMENT_ACTIVATION_ISSUED_AT']);
const RESOURCE_TYPES = new Set(['d1', 'durable_object_namespace', 'ai', 'assets', 'version_metadata', 'service']);
const stableJson = (value) => JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
export const inventoryDigest = (value) => createHash('sha256').update(stableJson(value)).digest('hex');

export function validateTarget(target) {
  if (target?.profile === 'sandbox') throw new Error('Guided upgrades currently support the core profile only. Sandbox container images require the existing coding-sandbox deployment runbook.');
  if (!target || !/^[a-f0-9]{32}$/i.test(target.account) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(target.worker) || target.profile !== 'core') {
    throw new Error('Select an existing Cloudflare account ID, Worker name, and core profile.');
  }
  if (target.wranglerProfile !== undefined && (typeof target.wranglerProfile !== 'string' ||
      !/^[a-zA-Z0-9_-]+$/.test(target.wranglerProfile) || target.wranglerProfile.toLowerCase() === 'staging')) {
    throw new Error('Use a valid Wrangler authentication profile name.');
  }
  let origin;
  if (target.url) {
    try {
      const url = new URL(target.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname.includes('.')) throw new Error();
      origin = url.origin;
    } catch { throw new Error('Use the existing public HTTPS Chickpea origin, without a path or credentials.'); }
  }
  return { account: target.account, worker: target.worker, profile: target.profile, ...(target.wranglerProfile !== undefined ? { wranglerProfile: target.wranglerProfile } : {}), ...(origin ? { url: origin } : {}) };
}

// Authentication selection must survive temporary config and retained-source directories.
export function wranglerProfileArgs(target) {
  return target.wranglerProfile ? ['--profile', target.wranglerProfile] : [];
}

export function validateInstallation(remote) {
  if (!remote.exists) throw new Error('The selected Worker does not exist. Upgrade never provisions an installation.');
  if (remote.versions.length !== 1 || Number(remote.versions[0].percentage) !== 100) throw new Error('Split or ambiguous serving traffic is unsupported.');
  const secrets = [...new Set(remote.secretNames)].sort();
  if (!secrets.includes('CHICKPEA_AUTH_SECRET') || !secrets.includes('CHICKPEA_CREDENTIAL_KEY_CURRENT_ID') || !secrets.some((name) => /^CHICKPEA_CREDENTIAL_KEY_(?!CURRENT_ID$)[A-Z0-9_]+$/.test(name))) {
    throw new Error('Permanent auth or credential-encryption secrets are missing. Restore the existing authority before upgrading.');
  }
  const variables = {};
  const resources = [];
  const names = new Set();
  for (const binding of remote.bindings) {
    if (!binding || typeof binding.name !== 'string' || names.has(binding.name)) throw new Error('Duplicate or unreadable Worker binding.');
    names.add(binding.name);
    if (binding.type === 'secret_text') {
      if (!secrets.includes(binding.name)) throw new Error('Worker secret inventories disagree.');
      continue;
    }
    if (binding.type === 'plain_text') {
      if (!PRESERVED_VARIABLES.has(binding.name) && !SETUP_NAMES.includes(binding.name) && !BUILD_NAMES.has(binding.name)) {
        throw new Error('Unsupported plain Worker variable. Review configuration and move any plaintext credentials into Cloudflare secrets; values were not printed.');
      }
      const value = binding.text ?? binding.value;
      if (typeof value !== 'string') throw new Error('Unreadable plain Worker variable.');
      variables[binding.name] = value;
    } else {
      if (!RESOURCE_TYPES.has(binding.type)) throw new Error('Unsupported Worker resource binding. Review the installation before upgrading.');
      resources.push(binding);
    }
  }
  const databases = resources.filter((binding) => binding.type === 'd1');
  const databaseId = databases[0]?.id ?? databases[0]?.database_id;
  if (databases.length !== 1 || databases[0].name !== 'AUTH_DB' || typeof databaseId !== 'string' || !databaseId) throw new Error('Exactly one existing AUTH_DB is required.');
  for (const binding of resources.filter((entry) => entry.type === 'durable_object_namespace')) {
    if (typeof binding.namespace_id !== 'string' || !binding.namespace_id || typeof binding.class_name !== 'string' || !binding.class_name) throw new Error('Unreadable Durable Object identity.');
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(variables[SETUP_NAMES[0]] ?? '') || !/^\d{13}$/.test(variables[SETUP_NAMES[1]] ?? '')) throw new Error('Existing setup authority is missing or unreadable; upgrade will not replace it.');
  if (!STABLE_VERSION.test(variables.CHICKPEA_APP_VERSION ?? '') || !/^[a-f0-9]{40}$/.test(variables.CHICKPEA_SOURCE_COMMIT ?? '')) {
    throw new Error('This installation has no verified release identity. Follow the unversioned-installation guide; assigning a version label is insufficient.');
  }
  const preservedVars = Object.fromEntries(Object.entries(variables).filter(([name]) => !BUILD_NAMES.has(name)));
  const result = { version: variables.CHICKPEA_APP_VERSION, commit: variables.CHICKPEA_SOURCE_COMMIT, fingerprint: remote.fingerprint,
    workerVersion: remote.versions[0].version_id, databaseId, resources: resources.sort((a, b) => a.name.localeCompare(b.name)), variables: preservedVars, secretNames: secrets };
  return { ...result, resourceDigest: inventoryDigest({ resources: result.resources, variables: preservedVars, secretNames: secrets }) };
}

export function assertCompatibleRelease(before, after) {
  if (!after.supportedOrigins?.includes(before.version) || compareVersions(before.version, after.version) >= 0) throw new Error('This release has not declared the installed version as a supported upgrade origin.');
  if (before.storageGeneration !== after.storageGeneration || stableJson(before.migrations) !== stableJson(after.migrations)) throw new Error('Storage generation or migration content changed. This updater supports only reviewed transitions with unchanged storage.');
  if (!RECOVERY_POLICIES.has(before.recovery) || !RECOVERY_POLICIES.has(after.recovery)) throw new Error('Code recovery is not declared for this transition.');
}

export function assertSameInstallation(before, after, { allowVersionChange = false } = {}) {
  if (before.resourceDigest !== after.resourceDigest || (!allowVersionChange && before.fingerprint !== after.fingerprint)) {
    throw new Error('The serving installation changed after inspection. Stop and review the other deployment or configuration edit.');
  }
}

export function overlayInstallation(config, installation, target) {
  if (config.name !== target.worker) throw new Error('Generated Worker name disagrees with the selected installation.');
  const resources = installation.resources;
  const used = new Set();
  function match(name, type) {
    const binding = resources.find((entry) => entry.name === name && entry.type === type);
    if (!binding || used.has(name)) throw new Error('Generated bindings differ from the existing installation.');
    used.add(name); return binding;
  }
  const dbs = config.d1_databases ?? [];
  if (dbs.length !== 1 || dbs[0].binding !== 'AUTH_DB') throw new Error('Generated AUTH_DB binding is ambiguous.');
  match('AUTH_DB', 'd1');
  if (dbs[0].database_id && dbs[0].database_id !== installation.databaseId) throw new Error('Generated AUTH_DB identity differs.');
  dbs[0].database_id = installation.databaseId;
  for (const binding of config.durable_objects?.bindings ?? []) {
    const remote = match(binding.name, 'durable_object_namespace');
    if (binding.class_name !== remote.class_name || (remote.script_name && remote.script_name !== target.worker) || binding.script_name || remote.environment || remote.dispatch_namespace) throw new Error('Durable Object class or owning Worker differs.');
  }
  for (const [key, type] of [['ai', 'ai'], ['assets', 'assets'], ['version_metadata', 'version_metadata']]) {
    if (config[key]) match(config[key].binding, type);
  }
  for (const binding of config.services ?? []) {
    const remote = match(binding.binding, 'service');
    if (typeof remote.service !== 'string' || !remote.service || remote.environment) throw new Error('Unsupported service binding.');
    binding.service = remote.service;
    if (remote.entrypoint) binding.entrypoint = remote.entrypoint;
  }
  if (used.size !== resources.length) throw new Error('Existing installation has bindings absent from the release.');
  for (const key of ['kv_namespaces', 'r2_buckets', 'workflows', 'vectorize', 'hyperdrive', 'analytics_engine_datasets', 'dispatch_namespaces', 'mtls_certificates', 'pipelines', 'secrets_store_secrets', 'send_email', 'worker_loaders', 'ratelimits', 'vpc_services', 'vpc_networks']) {
    if (config[key]?.length) throw new Error('The generated release introduces an unsupported resource class.');
  }
  if (config.queues?.producers?.length || config.queues?.consumers?.length || config.unsafe?.bindings?.length) throw new Error('The generated release introduces unsupported queue or unsafe bindings.');
  if (target.profile !== 'sandbox' && config.containers?.length) throw new Error('The generated release changes the deployment profile.');
  for (const name of Object.keys(config.vars ?? {})) {
    if (!BUILD_NAMES.has(name) && !Object.hasOwn(installation.variables, name)) throw new Error('The release introduces a new Worker variable. This transition requires updated upgrade tooling before deployment.');
  }
  config.vars = { ...installation.variables, ...config.vars };
  // Target source may own new app identity, but never overwrite preserved
  // installation values (including setup authority) with authored defaults.
  for (const [name, value] of Object.entries(installation.variables)) config.vars[name] = value;
  return config;
}
