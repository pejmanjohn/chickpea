import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

import { ONBOARDING_SCENES, onboardingSceneHtml, onboardingSceneId } from '../src/admin/onboarding-scenes.ts';
import { isPublicAssetPath } from '../src/assets/public-assets.ts';
// @ts-expect-error Executable helpers are JavaScript, shared with the verifiers.
import { allowedBinaryFiles } from '../scripts/lib/source-export-policy.mjs';

test('each onboarding stage has its scene: Chickpea setting up, coding, chatting, then celebrating', () => {
  const scene = (stage: string, onChickpeaModels = true, githubConnected = false) =>
    onboardingSceneId({ stage, onChickpeaModels, githubConnected });
  assert.equal(scene('choose_provider'), 'setting-up');
  assert.equal(scene('choose_model'), 'setting-up');
  assert.equal(scene('choose_provider', false), 'own-model');
  assert.equal(scene('choose_model', false), 'own-model');
  assert.equal(scene('connect_github'), 'github');
  assert.equal(scene('connect_github', true, true), 'github-connected');
  assert.equal(scene('try'), 'try');
  assert.equal(scene('complete'), 'ready');
  assert.equal(scene('connect_slack', false), 'add-to-slack');
  assert.equal(scene(undefined as unknown as string), 'add-to-slack');
});

test('a scene is a decorative pose under the arch and a caption in text; only Ready throws confetti', () => {
  for (const [id, { caption }] of Object.entries(ONBOARDING_SCENES)) {
    const html = onboardingSceneHtml(id as keyof typeof ONBOARDING_SCENES);
    const images = html.match(/<img [^>]*>/g) ?? [];
    assert.equal(images.length, 1, id);
    assert.match(images[0]!, / alt=""/, `${id}: the pose is decorative`);
    assert.ok(html.includes(`<p class="onboarding-caption">${caption}</p>`), `${id}: the caption is text`);
    assert.equal(html.includes('onboarding-confetti'), id === 'ready', id);
  }
  assert.match(onboardingSceneHtml('ready'), /<div class="onboarding-confetti" aria-hidden="true">(<i><\/i>)+<\/div>/);
});

test('every pose a scene shows ships as a public WebP the source export allows', () => {
  for (const { pose } of Object.values(ONBOARDING_SCENES)) {
    const path = `onboarding/pose-${pose}.webp`;
    assert.ok(existsSync(new URL(`../assets/${path}`, import.meta.url)), path);
    assert.ok(isPublicAssetPath(path), `${path} is served on Node`);
    assert.ok((allowedBinaryFiles as Map<string, string>).has(`assets/${path}`), `${path} is allowed in the export`);
  }
});
