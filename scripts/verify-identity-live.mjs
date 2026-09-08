#!/usr/bin/env node
// Check the supported runtime before loading TypeScript or making requests.
import { assertNodeVersion } from './lib/node-version.mjs';
try { assertNodeVersion(); } catch (error) {
  console.error(`FAIL    env - ${error.message}`);
  process.exit(1);
}

const { WebClient } = await import('@slack/web-api');
const { defaultBotIdentity, IdentityStore } = await import('../src/config/identity.ts');
const { checkIdentity, readManifestIdentity } = await import('../src/slack/identity-check.ts');

const results = [];

function record(status, name, detail) {
  results.push({ status, name });
  console.log(`${status.padEnd(7)} ${name}${detail ? ` - ${detail}` : ''}`);
}

const token = process.env.SLACK_BOT_TOKEN;
if (!token) {
  record('FAIL', 'env', 'SLACK_BOT_TOKEN is required');
  process.exit(1);
}

const client = new WebClient(token, {
  retryConfig: { retries: 0 },
  ...(process.env.SLACK_API_URL ? { slackApiUrl: process.env.SLACK_API_URL } : {}),
});

try {
  const identity = new IdentityStore().get();
  const manifest = process.env.SLACK_APP_MANIFEST_PATH
    ? readManifestIdentity(process.env.SLACK_APP_MANIFEST_PATH)
    : readManifestIdentity();
  const result = await checkIdentity(client, identity, manifest);

  record(
    result.name === 'match' ? 'PASS' : 'FAIL',
    'name',
    result.name === 'match'
      ? `live display name "${result.details.liveName}" matches slack-app-manifest.json`
      : `expected "${result.details.expectedName}", live "${result.details.liveName || '(empty)'}"`,
  );

  if (result.icon === 'custom') {
    record('PASS', 'icon', `custom Slack-hosted avatar detected at ${result.details.iconUrl}`);
  } else if (result.icon === 'default') {
    record('FAIL', 'icon', `Slack stock avatar detected at ${result.details.iconUrl}`);
  } else if (process.env.SLACK_IDENTITY_ACCEPT_UNKNOWN_ICON === '1') {
    record(
      'UNKNOWN',
      'icon',
      `could not classify avatar URL ${result.details.iconUrl ?? '(empty)'} ` +
        '(accepted via SLACK_IDENTITY_ACCEPT_UNKNOWN_ICON=1)',
    );
  } else {
    record(
      'FAIL',
      'icon',
      `could not classify avatar URL ${result.details.iconUrl ?? '(empty)'} - verify the avatar ` +
        'visually in the app console below, then re-run with SLACK_IDENTITY_ACCEPT_UNKNOWN_ICON=1 to accept',
    );
  }

  console.log('');
  console.log(`Slack app console: ${result.details.consoleUrl}`);
  console.log(`App name: ${manifest.name}`);
  console.log(`Bot user display name: ${manifest.botDisplayName}`);
  console.log(`Description: ${manifest.description}`);
  console.log(`Avatar file: ${defaultBotIdentity.avatarPath}`);
} catch (error) {
  record('FAIL', 'identity-check', error instanceof Error ? error.message : String(error));
}

const failed = results.filter((result) => result.status === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} blocking checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
