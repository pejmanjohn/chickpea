import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderAuthSetupCompletePage, renderAuthSetupPage } from '../src/admin/page.ts';

test('Access setup page covers new and existing Zero Trust teams accessibly', () => {
  const html = renderAuthSetupPage({
    state: 'fresh',
    origin: 'https://chickpea.example.com',
  });
  assert.match(html, /Create Zero Trust organization/i);
  assert.match(html, /existing Zero Trust organization/i);
  assert.match(html, /Advanced manual setup/i);
  assert.match(html, /one-time PIN/i);
  assert.match(html, /authentication-only policy/i);
  assert.match(html, /Later teammate changes happen only in Chickpea/i);
  assert.doesNotMatch(html, /add each invited address|exact-email Allow policy/i);
  assert.match(html, /https:\/\/chickpea\.example\.com\/admin/);
  assert.match(html, /https:\/\/chickpea\.example\.com\/admin\/\*/);
  assert.match(html, /data-copy=/);
  assert.match(html, /aria-pressed=/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /<label[^>]*for="owner-email"/i);
  assert.match(html, /@media/i);
});

test('pending Access setup resumes at verification without skipping configuration', () => {
  const html = renderAuthSetupPage({
    state: 'access_pending',
    origin: 'https://chickpea.example.com',
    issuer: 'https://team.cloudflareaccess.com',
    audience: 'audience-value',
  });
  assert.match(html, /Configuration saved/);
  assert.match(html, /href="\/admin\/setup\/verify"/);
  assert.match(html, /resumes from the saved configuration/);
  assert.match(html, /value="https:\/\/team\.cloudflareaccess\.com"/);
  assert.match(html, /value="audience-value"/);
});

test('completed setup has an auth-neutral Slack handoff', () => {
  const html = renderAuthSetupCompletePage();
  assert.match(html, /Your Chickpea is ready/);
  assert.match(html, /owner account and workspace are ready/);
  assert.doesNotMatch(html, /Cloudflare Access/);
  assert.match(html, /href="\/admin">Continue to Slack setup/);
});
