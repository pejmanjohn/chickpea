import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  buildSlackAppManifest,
  canonicalSlackAppManifestJson,
  slackManifestFingerprint,
  slackManifestPrefillUrl,
  validateSlackAppManifest,
} from '../src/slack/identity-manifest.ts';
import committedManifest from '../slack-app-manifest.json' with { type: 'json' };
import acceptedFixture from './fixtures/slack/slack-oauth-accepted-manifest.json' with { type: 'json' };

const ORIGIN = 'https://chickpea.example';

test('the committed manifest is byte-identical to the canonical reference builder', async () => {
  const committed = await readFile(new URL('../slack-app-manifest.json', import.meta.url), 'utf8');
  assert.equal(committed, canonicalSlackAppManifestJson());
  assert.deepEqual(JSON.parse(committed), buildSlackAppManifest({
    kind: 'control_plane',
    origin: ORIGIN,
  }));
});

test('programmatic and manual control-plane manifests are identical and retain the U11 contract', () => {
  const manifest = buildSlackAppManifest({ kind: 'control_plane', origin: ORIGIN });
  const prefill = new URL(slackManifestPrefillUrl(manifest));
  const manual = JSON.parse(prefill.searchParams.get('manifest_json') ?? '{}');
  assert.deepEqual(manual, manifest);

  assert.deepEqual(manifest.oauth_config.scopes, acceptedFixture.manifest.oauth_config.scopes);
  assert.deepEqual(
    manifest.oauth_config.redirect_urls!.map((url) => new URL(url).pathname),
    ['/auth/slack/install/callback', '/auth/slack/oidc/callback'],
  );
  assert.equal(manifest.settings.event_subscriptions.request_url, `${ORIGIN}/channels/slack/events`);
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes('user_change'));
  assert.equal('pkce_enabled' in manifest.oauth_config, false);
  assert.equal(manifest.oauth_config.scopes.bot.length, 14);
  assert.ok(manifest.oauth_config.scopes.bot.includes('mpim:read'));
  assert.deepEqual(validateSlackAppManifest(manual, manifest), {
    fingerprint: slackManifestFingerprint(manifest),
  });
});

test('deployment URLs change together without changing grant shape', () => {
  const first = buildSlackAppManifest({ kind: 'control_plane', origin: ORIGIN });
  const second = buildSlackAppManifest({
    kind: 'control_plane',
    origin: 'https://customer.example.workers.dev',
  });
  assert.deepEqual(first.oauth_config.scopes, second.oauth_config.scopes);
  assert.deepEqual(first.settings.event_subscriptions.bot_events, second.settings.event_subscriptions.bot_events);
  assert.notDeepEqual(first.oauth_config.redirect_urls, second.oauth_config.redirect_urls);
  assert.notEqual(
    first.settings.event_subscriptions.request_url,
    second.settings.event_subscriptions.request_url,
  );
});

test('dedicated bot manifests have a distinct bot-only intent with no OIDC grant', () => {
  const manifest = buildSlackAppManifest({
    kind: 'dedicated_bot',
    appName: 'Finance Copilot',
    botDisplayName: 'Finance',
    requestUrl: `${ORIGIN}/channels/slack/events/finance_ingress`,
  });
  assert.deepEqual(manifest.oauth_config.scopes, {
    bot: committedManifest.oauth_config.scopes.bot,
  });
  assert.equal('redirect_urls' in manifest.oauth_config, false);
  assert.equal('user' in manifest.oauth_config.scopes, false);
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes('app_uninstalled'));
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes('tokens_revoked'));
  assert.equal(manifest.settings.event_subscriptions.bot_events.includes('user_change'), false);
});

test('manifest validation rejects callback and scope drift without reflecting values', () => {
  const expected = buildSlackAppManifest({ kind: 'control_plane', origin: ORIGIN });
  const wrongCallback = structuredClone(expected);
  wrongCallback.oauth_config.redirect_urls![0] = 'https://attacker.example/callback';
  assert.throws(() => validateSlackAppManifest(wrongCallback, expected), /does not match/i);

  const wrongScopes = structuredClone(expected);
  wrongScopes.oauth_config.scopes.bot = wrongScopes.oauth_config.scopes.bot.slice(1);
  assert.throws(() => validateSlackAppManifest(wrongScopes, expected), /does not match/i);
});
