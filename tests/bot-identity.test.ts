import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { WebClient } from '@slack/web-api';

import { defaultBotIdentity, IdentityStore } from '../src/config/identity.ts';
import { checkIdentity, classifySlackIconUrl } from '../src/slack/identity-check.ts';
import { loopbackListenSkipReason } from './helpers/listen.ts';
import { FakeSlackBackend } from './parity/fake-slack.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST_PATH = join(REPO_ROOT, 'slack-app-manifest.json');
// The verify script loads TypeScript modules, which needs Node >= 22.19; honor
// the same escape hatch the parity suite (tests/parity/lane-b.ts) documents.
const NODE_BIN = process.env.FLUE_NODE_BIN ?? process.execPath;
const execFileAsync = promisify(execFile);

const CUSTOM_ICON_URL = 'https://avatars.slack-edge.com/2026-07-02/T123_512.png';
const DEFAULT_APP_ICON_URL = 'https://a.slack-edge.com/80588/img/plugins/app/bot_512.png';
const DEFAULT_AVATAR_URL = 'https://a.slack-edge.com/80588/img/avatars/default_avatar.png';
const LIVE_DEFAULT_GRAVATAR_URL =
  'https://secure.gravatar.com/avatar/1035a1e39388cffdb24d3f02e9b82f78.jpg?s=512&d=https%3A%2F%2Fa.slack-edge.com%2Fdf10d%2Fimg%2Favatars%2Fava_0005-512.png';
const BARE_GRAVATAR_URL = 'https://secure.gravatar.com/avatar/1035a1e39388cffdb24d3f02e9b82f78.jpg?s=512&d=identicon';
const UNKNOWN_ICON_URL = 'https://cdn.example.test/flue-assistant.png';
const loopbackSkipReason = await loopbackListenSkipReason();

test('IdentityStore returns the seeded install-wide avatar path', () => {
  const identity = new IdentityStore().get();

  assert.deepEqual(identity, defaultBotIdentity);
  assert.deepEqual(Object.keys(identity), ['avatarPath']);
  assert.equal(identity.avatarPath, 'assets/bot-avatar.png');
});

test('Slack manifest defaults the app and bot display names to Chickpea', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
    display_information?: { name?: unknown; description?: unknown };
    features?: { bot_user?: { display_name?: unknown } };
  };
  const displayName = manifest.display_information?.name;
  const botDisplayName = manifest.features?.bot_user?.display_name;
  const description = manifest.display_information?.description;

  assert.equal(displayName, 'Chickpea');
  assert.equal(botDisplayName, 'Chickpea');
  assert.ok(typeof description === 'string');
  assert.notEqual(description.trim(), '');
});

test('Slack manifest uses the minimal Agent View contract without enabling actions', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as {
    features?: {
      agent_view?: {
        agent_description?: unknown;
        suggested_prompts?: unknown;
        actions?: unknown;
      };
      assistant_view?: unknown;
    };
    oauth_config?: { scopes?: { bot?: unknown[] } };
    settings?: {
      event_subscriptions?: { bot_events?: unknown[] };
      interactivity?: { is_enabled?: unknown };
    };
  };

  assert.equal(manifest.features?.assistant_view, undefined);
  assert.ok(typeof manifest.features?.agent_view?.agent_description === 'string');
  assert.deepEqual(manifest.features?.agent_view?.suggested_prompts, [
    {
      title: 'Summarize supplied text',
      message: 'Summarize the conversation or material I paste here.',
    },
    {
      title: 'Investigate a question',
      message:
        'Investigate this question using only material I supply or you are authorized to access:',
    },
    { title: 'Plan a task', message: 'Help me plan this task:' },
  ]);
  assert.equal(manifest.features?.agent_view?.actions, undefined);
  assert.equal(manifest.settings?.interactivity?.is_enabled, false);

  const scopes = manifest.oauth_config?.scopes?.bot ?? [];
  assert.ok(scopes.includes('assistant:write'));
  const events = manifest.settings?.event_subscriptions?.bot_events ?? [];
  assert.ok(events.includes('app_home_opened'));
  assert.ok(events.includes('app_context_changed'));
  assert.ok(events.includes('message.im'));
  assert.ok(!events.includes('assistant_thread_started'));
  assert.ok(!events.includes('assistant_thread_context_changed'));
  assert.ok(!events.includes('message.app_home'));
});

test('default avatar path resolves to a square PNG at least 512px wide', () => {
  const avatarPath = join(REPO_ROOT, defaultBotIdentity.avatarPath);
  assert.ok(existsSync(avatarPath), `expected ${defaultBotIdentity.avatarPath} to exist`);

  const bytes = readFileSync(avatarPath);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR');

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.equal(width, height);
  assert.ok(width >= 512, `expected avatar to be at least 512px square, got ${width}x${height}`);
});

test('Slack icon URL classifier separates custom, default, and unknown URLs', () => {
  assert.equal(classifySlackIconUrl(CUSTOM_ICON_URL), 'custom');
  assert.equal(classifySlackIconUrl(DEFAULT_APP_ICON_URL), 'default');
  assert.equal(classifySlackIconUrl(DEFAULT_AVATAR_URL), 'default');
  assert.equal(classifySlackIconUrl(LIVE_DEFAULT_GRAVATAR_URL), 'default');
  assert.equal(classifySlackIconUrl(BARE_GRAVATAR_URL), 'default');
  assert.equal(classifySlackIconUrl(UNKNOWN_ICON_URL), 'unknown');
  assert.equal(classifySlackIconUrl('not a url'), 'unknown');
});

test('checkIdentity compares manifest name and icon state through fake Slack', { skip: loopbackSkipReason }, async () => {
  const backend = new FakeSlackBackend({
    slack: {
      identity: {
        appId: 'A_FLUE',
        botUserId: 'UBOT',
        displayName: 'Chickpea',
        image512Url: CUSTOM_ICON_URL,
      },
    },
  });
  const server = await backend.listen();

  try {
    const client = new WebClient('xoxb-test', {
      slackApiUrl: `${server.url}/api/`,
      retryConfig: { retries: 0 },
    });

    const result = await checkIdentity(client, defaultBotIdentity);

    assert.equal(result.name, 'match');
    assert.equal(result.icon, 'custom');
    assert.equal(result.details.appId, 'A_FLUE');
    assert.equal(result.details.botUserId, 'UBOT');
    assert.equal(result.details.expectedName, 'Chickpea');
    assert.equal(result.details.liveName, 'Chickpea');
    assert.equal(result.details.iconUrl, CUSTOM_ICON_URL);
    assert.equal(result.details.consoleUrl, 'https://api.slack.com/apps/A_FLUE/general');
    assert.deepEqual(
      backend.callsOfMethod('users.info').map((entry) => entry.body),
      [{ user: 'UBOT' }],
    );
  } finally {
    await server.close();
  }
});

test('checkIdentity reports a name mismatch from fake Slack', { skip: loopbackSkipReason }, async () => {
  const backend = new FakeSlackBackend({
    slack: {
      identity: {
        appId: 'A_FLUE',
        botUserId: 'UBOT',
        displayName: 'Drifted Bot Name',
        image512Url: CUSTOM_ICON_URL,
      },
    },
  });
  const server = await backend.listen();

  try {
    const client = new WebClient('xoxb-test', {
      slackApiUrl: `${server.url}/api/`,
      retryConfig: { retries: 0 },
    });

    const result = await checkIdentity(client, defaultBotIdentity);

    assert.equal(result.name, 'mismatch');
    assert.equal(result.details.expectedName, 'Chickpea');
    assert.equal(result.details.liveName, 'Drifted Bot Name');
  } finally {
    await server.close();
  }
});

test('verify-identity-live reports custom, default, and unknown icon states against fake Slack', { skip: loopbackSkipReason }, async () => {
  const backend = new FakeSlackBackend();
  const server = await backend.listen();

  async function run(
    iconUrl: string,
    extraEnv: Record<string, string> = {},
  ): Promise<{ code: number; output: string }> {
    backend.configure({
      slack: {
        identity: {
          appId: 'A_FLUE',
          botUserId: 'UBOT',
          displayName: 'Chickpea',
          image512Url: iconUrl,
        },
      },
    });

    try {
      const result = await execFileAsync(NODE_BIN, ['scripts/verify-identity-live.mjs'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          SLACK_BOT_TOKEN: 'xoxb-test',
          SLACK_API_URL: `${server.url}/api/`,
          ...extraEnv,
        },
      });
      return { code: 0, output: result.stdout + result.stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return {
        code: failed.code ?? 1,
        output: `${failed.stdout ?? ''}${failed.stderr ?? ''}`,
      };
    }
  }

  try {
    const custom = await run(CUSTOM_ICON_URL);
    assert.equal(custom.code, 0);
    assert.match(custom.output, /PASS\s+name/);
    assert.match(custom.output, /PASS\s+icon/);
    assert.match(custom.output, /https:\/\/api\.slack\.com\/apps\/A_FLUE\/general/);

    const defaultIcon = await run(DEFAULT_APP_ICON_URL);
    assert.equal(defaultIcon.code, 1);
    assert.match(defaultIcon.output, /PASS\s+name/);
    assert.match(defaultIcon.output, /FAIL\s+icon/);

    const unknown = await run(UNKNOWN_ICON_URL);
    assert.equal(unknown.code, 1);
    assert.match(unknown.output, /PASS\s+name/);
    assert.match(unknown.output, /FAIL\s+icon/);
    assert.match(unknown.output, /SLACK_IDENTITY_ACCEPT_UNKNOWN_ICON=1/);

    const acceptedUnknown = await run(UNKNOWN_ICON_URL, { SLACK_IDENTITY_ACCEPT_UNKNOWN_ICON: '1' });
    assert.equal(acceptedUnknown.code, 0);
    assert.match(acceptedUnknown.output, /UNKNOWN\s+icon/);

    backend.configure({
      slack: {
        identity: {
          appId: 'A_FLUE',
          botUserId: 'UBOT',
          displayName: 'Drifted Bot Name',
          image512Url: CUSTOM_ICON_URL,
        },
      },
    });
    let mismatch: { code: number; stdout: string; stderr: string };
    try {
      const success = await execFileAsync(NODE_BIN, ['scripts/verify-identity-live.mjs'], {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          SLACK_BOT_TOKEN: 'xoxb-test',
          SLACK_API_URL: `${server.url}/api/`,
        },
      });
      mismatch = { code: 0, stdout: success.stdout, stderr: success.stderr };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      mismatch = {
        code: failed.code ?? 1,
        stdout: failed.stdout ?? '',
        stderr: failed.stderr ?? '',
      };
    }
    assert.equal(mismatch.code, 1);
    assert.match(`${mismatch.stdout}${mismatch.stderr}`, /FAIL\s+name/);
  } finally {
    await server.close();
  }
});

test('verify-identity-live reports malformed manifest errors without a stack trace', async () => {
  const manifestDir = mkdtempSync(join(tmpdir(), 'flue-identity-manifest-'));
  const manifestPath = join(manifestDir, 'slack-app-manifest.json');
  writeFileSync(manifestPath, '{not json');

  let result: { code: number; stdout: string; stderr: string };
  try {
    const success = await execFileAsync(NODE_BIN, ['scripts/verify-identity-live.mjs'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        SLACK_BOT_TOKEN: 'xoxb-test',
        SLACK_APP_MANIFEST_PATH: manifestPath,
        SLACK_API_URL: 'http://127.0.0.1:9/api/',
      },
    });
    result = { code: 0, stdout: success.stdout, stderr: success.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    result = {
      code: failed.code ?? 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }

  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.code, 1);
  assert.match(output, /FAIL\s+identity-check/);
  assert.match(output, /manifest|JSON|Unexpected|Expected property name/i);
  assert.doesNotMatch(output, /\n\s+at\s+/);
});
