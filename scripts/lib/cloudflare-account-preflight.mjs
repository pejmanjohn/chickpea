import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const ACCOUNT = /^[a-f0-9]{32}$/i;
const MAX_BODY = 64 * 1024;
const TIMEOUT = 20_000;

function failure(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function effectiveConfig(options) {
  try {
    const readConfig = options.readConfig ?? createRequire(path.join(options.runnerRoot, 'package.json'))('wrangler').unstable_readConfig;
    const context = options.providerContext ?? [];
    const index = context.indexOf('--env');
    return readConfig({ config: options.configPath, ...(index >= 0 ? { env: context[index + 1] } : {}) },
      { hideWarnings: true, useRedirectIfAvailable: false });
  } catch {
    throw failure('CLOUDFLARE_CONFIG_INVALID', 'Unable to resolve the selected Wrangler configuration. Check its configuration and environment.');
  }
}

function configuredAccount(config, env, expectedAccount) {
  const values = [config.account_id, env.CLOUDFLARE_ACCOUNT_ID, env.CF_ACCOUNT_ID, expectedAccount]
    .filter((value) => value !== undefined && value !== '');
  if (values.some((value) => typeof value !== 'string' || !ACCOUNT.test(value))) {
    throw failure('CLOUDFLARE_ACCOUNT_INVALID', 'Select a valid Cloudflare account ID.');
  }
  if (new Set(values).size > 1) {
    throw failure('CLOUDFLARE_ACCOUNT_CONFLICT', 'The configuration, environment or selected target names different Cloudflare accounts. Select the intended account consistently.');
  }
  return values[0];
}

function usesWorkersDev(config) {
  // Wrangler defaults to workers.dev only when there are no configured routes.
  return config.workers_dev ?? (!config.route && !(config.routes?.length));
}

function commandJson(options, args) {
  try {
    const result = (options.runWrangler ?? ((args) => spawnSync(process.execPath,
      [path.join(options.runnerRoot, 'node_modules/wrangler/bin/wrangler.js'), ...args], {
        cwd: options.projectRoot, env: options.env ?? process.env, encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'], timeout: TIMEOUT, maxBuffer: MAX_BODY,
      })))([...args, ...(options.providerContext ?? [])]);
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string' || result.stdout.length > MAX_BODY) throw new Error();
    return JSON.parse(result.stdout);
  } catch {
    // Wrangler output can contain credentials. Never include it in diagnostics.
    throw failure('CLOUDFLARE_AUTH_UNAVAILABLE', 'Wrangler could not confirm account access. Complete wrangler login with the selected profile, then retry.');
  }
}

async function boundedJson(response) {
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  let length = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY) throw new Error();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

/** Read-only account readiness. No configurable API URL, redirects or credential files. */
export async function preflightCloudflareAccount(options) {
  const env = options.env ?? process.env;
  const config = effectiveConfig(options);
  let accountId = configuredAccount(config, env, options.expectedAccount);
  if (!usesWorkersDev(config)) return { workersDev: false, accountId };
  if (!accountId) {
    // whoami only inspects the active profile and rejects --profile. Never
    // infer a named profile's account from a different login's identity.
    if ((options.providerContext ?? []).includes('--profile')) {
      throw failure('CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED', 'Choose the intended account in the Cloudflare dashboard and set CLOUDFLARE_ACCOUNT_ID (or account_id in the selected Wrangler configuration) before retrying with the same profile.');
    }
    const identity = commandJson(options, ['whoami', '--json']);
    if (!Array.isArray(identity.accounts) || identity.accounts.length !== 1) {
      throw failure('CLOUDFLARE_ACCOUNT_SELECTION_REQUIRED', 'Choose the intended account from wrangler whoami and set CLOUDFLARE_ACCOUNT_ID before retrying.');
    }
    accountId = configuredAccount({}, {}, identity.accounts[0]?.id);
    if (!accountId) throw failure('CLOUDFLARE_AUTH_UNAVAILABLE', 'Wrangler returned no account. Complete sign-in and retry.');
  }
  const auth = commandJson(options, ['auth', 'token', '--json']);
  const text = (value) => typeof value === 'string' && value.length > 0 && value.length < 4096 && !/[\r\n]/.test(value);
  let headers;
  if (['oauth', 'api_token'].includes(auth?.type) && text(auth.token)) headers = { Authorization: `Bearer ${auth.token}` };
  else if (auth?.type === 'api_key' && text(auth.key) && text(auth.email)) headers = { 'X-Auth-Key': auth.key, 'X-Auth-Email': auth.email };
  else throw failure('CLOUDFLARE_AUTH_UNAVAILABLE', 'Wrangler returned no usable account credentials. Complete sign-in and retry.');
  let response;
  let body;
  try {
    response = await (options.fetchImpl ?? fetch)(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
      method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT),
    });
    if (response.status === 401 || response.status === 403) {
      throw failure('CLOUDFLARE_ACCOUNT_ACCESS_DENIED', `Wrangler cannot read Workers settings for account ${accountId}. Check the selected profile and account permissions, then retry.`);
    }
    body = await boundedJson(response);
  } catch (error) {
    if (error?.code === 'CLOUDFLARE_ACCOUNT_ACCESS_DENIED') throw error;
    throw failure('CLOUDFLARE_SUBDOMAIN_UNKNOWN', 'Unable to confirm workers.dev registration. Retry after checking Cloudflare connectivity; no account changes were made.');
  }
  if (response.ok && body?.success === true && typeof body.result?.subdomain === 'string' &&
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(body.result.subdomain)) {
    return { workersDev: true, accountId };
  }
  // Code 10007 on this exact endpoint means the account has no subdomain.
  // Generic 404s, authentication errors and malformed data are not that proof.
  if ([400, 404].includes(response.status) && body?.success === false && Array.isArray(body.errors) &&
      body.errors.length === 1 && body.errors[0]?.code === 10007) {
    throw failure('CLOUDFLARE_SUBDOMAIN_MISSING', `Account ${accountId} has no workers.dev subdomain. Open https://dash.cloudflare.com/${accountId}/workers-and-pages and choose and register your account's subdomain. Then rerun the same npm run deploy command. Existing resources and secrets can be reused.`);
  }
  throw failure('CLOUDFLARE_SUBDOMAIN_UNKNOWN', 'Cloudflare did not confirm workers.dev registration. Check account access and retry; no account changes were made.');
}

/** Verify that the generated artifact still uses the account checked before build. */
export function assertCloudflareAccountConfig(options, checked) {
  const config = effectiveConfig(options);
  const account = configuredAccount(config, options.env ?? process.env, options.expectedAccount);
  if (usesWorkersDev(config) !== checked.workersDev || account !== checked.accountId) {
    throw failure('CLOUDFLARE_ACCOUNT_CHANGED', 'The generated artifact differs from the account or workers.dev configuration checked before build. Check the selected target and rebuild.');
  }
}
