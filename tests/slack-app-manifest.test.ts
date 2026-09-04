import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import {
  buildSlackAppManifest,
  canonicalSlackAppManifestJson,
  slackManifestFingerprint,
  slackManifestPrefillUrl,
  validateSlackAppManifest,
} from '../src/slack/app-manifest.ts';
import acceptedFixture from './fixtures/slack/slack-oauth-accepted-manifest.json' with { type: 'json' };

const ORIGIN = 'https://chickpea.example';

test('the committed manifest is byte-identical to the canonical reference builder', async () => {
  const committed = await readFile(new URL('../slack-app-manifest.json', import.meta.url), 'utf8');
  assert.equal(committed, canonicalSlackAppManifestJson());
  assert.deepEqual(JSON.parse(committed), buildSlackAppManifest({
    kind: 'workspace_app',
    origin: ORIGIN,
  }));
});

test('programmatic and manual control-plane manifests are identical and retain the U11 contract', () => {
  const manifest = buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN });
  const prefill = new URL(slackManifestPrefillUrl(manifest));
  const manual = JSON.parse(prefill.searchParams.get('manifest_json') ?? '{}');
  assert.deepEqual(manual, manifest);
  assert.equal(manifest.display_information.background_color, '#bd5732');

  assert.ok(
    acceptedFixture.manifest.oauth_config.scopes.bot.every((scope) =>
      manifest.oauth_config.scopes.bot.includes(scope)
    ),
  );
  assert.deepEqual(manifest.oauth_config.scopes.user, ['openid', 'profile', 'email']);
  assert.deepEqual(
    manifest.oauth_config.redirect_urls!.map((url) => new URL(url).pathname),
    ['/auth/slack/install/callback', '/auth/slack/oidc/callback'],
  );
  assert.equal(manifest.settings.event_subscriptions.request_url, `${ORIGIN}/channels/slack/events`);
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes('user_change'));
  assert.equal('pkce_enabled' in manifest.oauth_config, false);
  assert.deepEqual(
    manifest.oauth_config.scopes.bot.filter((scope) =>
      ['chat:write.customize', 'usergroups:read', 'usergroups:write', 'users:read.email']
        .includes(scope)
    ),
    ['chat:write.customize', 'usergroups:read', 'usergroups:write', 'users:read.email'],
  );
  assert.ok(manifest.oauth_config.scopes.bot.includes('mpim:read'));
  assert.equal(manifest.features.app_home.home_tab_enabled, true);
  assert.deepEqual(manifest.settings.interactivity, {
    is_enabled: true,
    request_url: `${ORIGIN}/channels/slack/interactions`,
  });
  assert.deepEqual(validateSlackAppManifest(manual, manifest), {
    fingerprint: slackManifestFingerprint(manifest),
  });
});

test('deployment URLs change together without changing grant shape', () => {
  const first = buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN });
  const second = buildSlackAppManifest({
    kind: 'workspace_app',
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

test('manifest validation rejects callback and scope drift without reflecting values', () => {
  const expected = buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN });
  const wrongCallback = structuredClone(expected);
  wrongCallback.oauth_config.redirect_urls![0] = 'https://attacker.example/callback';
  assert.throws(() => validateSlackAppManifest(wrongCallback, expected), /does not match/i);

  const wrongScopes = structuredClone(expected);
  wrongScopes.oauth_config.scopes.bot = wrongScopes.oauth_config.scopes.bot.slice(1);
  assert.throws(() => validateSlackAppManifest(wrongScopes, expected), /does not match/i);
});

test('manifest validation accepts Slack exported PKCE defaults without accepting enabled or malformed values', () => {
  const expected = buildSlackAppManifest({ kind: 'workspace_app', origin: ORIGIN });
  const exported = structuredClone({
    ...expected,
    oauth_config: { ...expected.oauth_config, pkce_enabled: false },
  });
  assert.deepEqual(validateSlackAppManifest(exported, expected), {
    fingerprint: slackManifestFingerprint(expected),
  });
  assert.equal('pkce_enabled' in expected.oauth_config, false);

  for (const value of [null, undefined]) {
    const absent = { ...exported, oauth_config: { ...exported.oauth_config, pkce_enabled: value } };
    assert.deepEqual(validateSlackAppManifest(absent, expected), {
      fingerprint: slackManifestFingerprint(expected),
    });
  }

  for (const value of [true, 'false', 0, {}, []]) {
    const drifted = {
      ...exported,
      oauth_config: { ...exported.oauth_config, pkce_enabled: value },
    };
    assert.throws(() => validateSlackAppManifest(drifted, expected), /does not match/i);
  }
  exported.oauth_config.scopes.bot = exported.oauth_config.scopes.bot.slice(1);
  assert.throws(() => validateSlackAppManifest(exported, expected), /does not match/i);
});
