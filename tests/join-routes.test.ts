import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';

import { createJoinRoutes } from '../src/join/routes.ts';
import { JOIN_STORAGE_KEY, RESET_STORAGE_KEY } from '../src/join/page.ts';

test('public join bootstrap is inert, no-store, and first-party only', async () => {
  const app = createJoinRoutes();
  const response = await app.request('https://chickpea.example.com/join');
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(
    response.headers.get('content-security-policy'),
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  assert.match(html, /<script src="\/join\/bootstrap\.js" defer><\/script>/);
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
  assert.doesNotMatch(html, /invite=|invitation_|@example\.com|analytics|telemetry/i);
});

test('bootstrap moves the fragment credential into same-tab storage, clears history, then crosses Access', async () => {
  const app = createJoinRoutes();
  const scriptResponse = await app.request('https://chickpea.example.com/join/bootstrap.js');
  const script = await scriptResponse.text();
  const secret = 's'.repeat(48);
  const credential = `invitation_123.${secret}`;
  const events: string[] = [];
  const stored = new Map<string, string>();
  const location = {
    hash: `#invite=${credential}`,
    pathname: '/join',
    search: '',
    replace(path: string) { events.push(`navigate:${path}`); },
  };

  vm.runInNewContext(script, {
    URLSearchParams,
    document: { getElementById() { return { textContent: '' }; } },
    history: { replaceState(_state: unknown, _title: string, path: string) { events.push(`history:${path}`); } },
    location,
    sessionStorage: {
      setItem(key: string, value: string) { events.push(`store:${key}`); stored.set(key, value); },
      removeItem(key: string) { stored.delete(key); },
    },
  }, { filename: 'join-bootstrap.js' });

  assert.equal(scriptResponse.status, 200);
  assert.match(scriptResponse.headers.get('content-type') ?? '', /^application\/javascript/);
  assert.equal(scriptResponse.headers.get('cache-control'), 'no-store');
  assert.equal(stored.get(JOIN_STORAGE_KEY), credential);
  assert.deepEqual(events, [
    `store:${JOIN_STORAGE_KEY}`,
    'history:/join',
    'navigate:/admin/join',
  ]);
  assert.equal(events.join(' ').includes(secret), false);

  const otherTab = new Map<string, string>();
  assert.equal(otherTab.get(JOIN_STORAGE_KEY), undefined);
});

test('incomplete join fragments are removed without creating invitation state', async () => {
  const app = createJoinRoutes();
  const script = await (await app.request('https://chickpea.example.com/join/bootstrap.js')).text();
  const stored = new Map<string, string>();
  const status = { textContent: '' };
  let navigated = false;
  let replaced = '';

  vm.runInNewContext(script, {
    URLSearchParams,
    document: { getElementById() { return status; } },
    history: { replaceState(_state: unknown, _title: string, path: string) { replaced = path; } },
    location: {
      hash: '#invite=incomplete', pathname: '/join', search: '',
      replace() { navigated = true; },
    },
    sessionStorage: {
      setItem(key: string, value: string) { stored.set(key, value); },
      removeItem(key: string) { stored.delete(key); },
    },
  });

  assert.equal(replaced, '/join');
  assert.equal(stored.size, 0);
  assert.equal(navigated, false);
  assert.match(status.textContent, /new invitation link/i);
});

test('reset bootstrap keeps the capability in same-tab storage and out of server-visible URLs', async () => {
  const app = createJoinRoutes();
  const response = await app.request('https://chickpea.example.com/reset/bootstrap.js');
  const script = await response.text();
  const credential = `auth_operation_reset.${'r'.repeat(48)}`;
  const stored = new Map<string, string>();
  const events: string[] = [];
  vm.runInNewContext(script, {
    URLSearchParams,
    document: { getElementById() { return { textContent: '' }; } },
    history: { replaceState(_state: unknown, _title: string, path: string) { events.push(`history:${path}`); } },
    location: {
      hash: `#reset=${credential}`,
      pathname: '/reset',
      search: '',
      replace(path: string) { events.push(`navigate:${path}`); },
    },
    sessionStorage: {
      setItem(key: string, value: string) { stored.set(key, value); },
      removeItem(key: string) { stored.delete(key); },
    },
  });
  assert.equal(response.status, 200);
  assert.equal(stored.get(RESET_STORAGE_KEY), credential);
  assert.deepEqual(events, ['history:/reset', 'navigate:/admin/reset']);
  assert.equal(events.join(' ').includes(credential), false);
});
