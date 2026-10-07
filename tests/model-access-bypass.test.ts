import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const KEY_SOURCES = {
  callResolvingModelAccess: String.raw`\bresolve\w*ModelAccess\w*\(`,
  resolverCall: String.raw`\.resolve\(grant\b`,
  credentialReader: String.raw`\b(?:resolveProviderApiKey|readHostedModelCredential|readStoredModelCredentials|readStoredProviderKeys|resolveOpenAiSubscriptionCredentials)\b`,
  savedKeySetting: String.raw`\b(?:modelCredentialSettingKeys|PROVIDER_KEY_SETTING_KEYS)\b`,
  deploymentKeyVariable: String.raw`\[\s*(?:PROVIDER_KEY_ENV_VARS|ENV_KEY_NAMES)\s*\[|process\.env(?:\.|\[\s*['"\x60])(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|CLOUDFLARE_API_TOKEN)\b`,
};
const READS_MODEL_KEY = new RegExp(Object.values(KEY_SOURCES).join('|'));

const NAMES_PROVIDER_HOST =
  /\b(?:api\.openai\.com|api\.anthropic\.com|openrouter\.ai\/api|chatgpt\.com\/backend-api|api\.cloudflare\.com\/client\/v4)\b/;

const SUBSCRIPTION_LANE =
  'ChatGPT subscription lane, image generation included: the member\'s ChatGPT sign-in pays, not a model key, ' +
  'so it is never funded by credits; it is unavailable on Cloudflare, where hosted installations run.';
const CHATGPT_PLAN_LANE =
  'ChatGPT plan lane: signs in with ChatGPT and lists its models with that session, not a model key.';

const ALLOWED = new Map<string, string>([
  ['src/config/model-access.ts',
    'The proxy: resolves each grant to its key and sends image requests with it.'],
  ['src/config/installation-model-access.ts',
    'The resolver the proxy calls: turns a grant into the installation\'s key.'],
  ['src/config/model-credential-refs.ts',
    'Reads, rotates and decrypts saved keys for the resolver and readiness; sends nothing.'],
  ['src/config/model-credential-settings.ts', 'Names the settings a saved key is kept in.'],
  ['src/config/settings-store.ts', 'Persists saved keys; sends nothing.'],
  ['src/config/hosted-credential-operations.ts', 'Encrypts plaintext saved keys at rest; sends nothing.'],
  ['src/config/provider-keys.ts',
    'Saves and deletes keys and reports which exist, for Admin and readiness; sends nothing.'],
  ['src/config/runtime-model.ts', 'Readiness: checks that a key exists before a run starts; sends nothing.'],
  ['src/config/provider-models.ts',
    'Admin key validation and model discovery: lists the provider\'s models with the key; no model request.'],
  ['src/admin/routes.ts', 'Reports whether the Workers AI token is set; sends nothing.'],
  ['src/runtime-bootstrap.ts',
    'Registers the standalone Workers AI lane with its deployment token; its requests pass the proxy, which ' +
    'refuses the lane on a deployment serving many installations.'],
  ['src/model-catalog/profiles.ts', 'Catalog endpoint metadata; requests to it go through the proxy.'],
  ['src/model-catalog/image-profiles.ts', 'Catalog endpoint metadata; image requests to it go through the proxy.'],
  ['src/slack/attachment-model-context.ts',
    'Compares a model\'s endpoint origin to decide native PDF support; sends nothing.'],
  ['src/openai-subscription/credentials.ts', SUBSCRIPTION_LANE],
  ['src/openai-subscription/protocol.ts', SUBSCRIPTION_LANE],
  ['src/openai-subscription/provider.ts', SUBSCRIPTION_LANE],
  ['src/openai-subscription/images-client.ts', SUBSCRIPTION_LANE],
  ['src/chatgpt-plan/protocol.ts', CHATGPT_PLAN_LANE],
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) ? [path] : [];
  });
}

function modulesReachingModels(root: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of sourceFiles(join(root, 'src'))) {
    const line = readFileSync(path, 'utf8').split('\n')
      .find((text) => READS_MODEL_KEY.test(text) || NAMES_PROVIDER_HOST.test(text));
    if (line !== undefined) found.set(relative(root, path).split(sep).join('/'), line.trim());
  }
  return found;
}

test('only the proxy and the modules listed with a reason read a model key or name a provider host', () => {
  const found = modulesReachingModels(ROOT);
  const unlisted = [...found].filter(([path]) => !ALLOWED.has(path)).map(([path, line]) => `${path}: ${line}`);
  assert.deepEqual(unlisted, [],
    'send each model request through sendImageRequest or the provider proxy in src/config/model-access.ts');
  const stale = [...ALLOWED.keys()].filter((path) => !found.has(path));
  assert.deepEqual(stale, [], 'an allowed module no longer reads a key or names a host; remove its entry');
});

test('the scan finds a key source and a provider host wherever they appear', () => {
  for (const line of [
    'const key = await resolveProviderApiKey(id, env, store);',
    'const access = await requireResolver().resolve(grant, env);',
    "const key = (await resolveInstallationModelAccess('openai', env, 'image-generation'))?.apiKey;",
    'const key = process.env[PROVIDER_KEY_ENV_VARS[providerId]];',
    'const key = process.env.OPENAI_API_KEY;',
    "const key = process.env['ANTHROPIC_API_KEY'];",
  ]) assert.match(line, READS_MODEL_KEY, line);
  for (const line of [
    "fetch('https://api.openai.com/v1/images/generations')",
    "const base = 'https://openrouter.ai/api/v1';",
  ]) assert.match(line, NAMES_PROVIDER_HOST, line);
  assert.doesNotMatch("const docs = 'https://developers.openai.com/api/docs/pricing';", NAMES_PROVIDER_HOST);
  assert.doesNotMatch("envVars: ['OPENAI_API_KEY'],", READS_MODEL_KEY, 'naming a variable reads nothing');
});
