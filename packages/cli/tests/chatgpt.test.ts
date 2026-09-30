import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { connectChatgpt } from '../src/chatgpt.ts';

test('helper binds callback state and PKCE, hands off once, and waits for owner confirmation', async () => {
  let descriptor: { state: string; nonce: string; challenge: string; redirectUri: string };
  let staged = false;
  let posts = 0;
  const notes: string[] = [];
  await connectChatgpt('https://chickpea.example.test', {
    timeoutMs: 10_000,
    note: text => notes.push(text),
    openBrowser: async value => {
      const url = new URL(value);
      if (url.origin === 'https://chickpea.example.test') {
        descriptor = JSON.parse(Buffer.from(url.searchParams.get('chatgpt_connect')!, 'base64url').toString());
        return;
      }
      assert.equal(url.origin, 'https://auth.openai.com');
      const bad = new URL(descriptor.redirectUri); bad.searchParams.set('state', 'wrong');
      assert.equal((await fetch(bad)).status, 400);
      const good = new URL(descriptor.redirectUri);
      good.searchParams.set('state', descriptor.state); good.searchParams.set('code', 'one-time-code'); good.searchParams.set('client_id', 'oaiapp_test');
      const result = await fetch(good, { redirect: 'manual' });
      assert.equal(result.status, 303); assert.equal(result.headers.get('location'), '/complete');
      const complete = await fetch(new URL('/complete', good));
      assert.equal(complete.status, 200);
      assert.equal(complete.headers.get('cache-control'), 'no-store');
      assert.equal(complete.headers.get('referrer-policy'), 'no-referrer');
      assert.match(complete.headers.get('content-security-policy')!, /default-src 'none'; img-src https:\/\/chickpea\.example\.test;/);
      const page = await complete.text();
      assert.match(page, /href="https:\/\/chickpea\.example\.test\/admin\/settings\/providers">Continue to Chickpea/);
      for (const secret of ['one-time-code', descriptor.state, descriptor.nonce, descriptor.challenge]) assert.ok(!page.includes(secret));
      assert.equal((await fetch(good)).status, 400, 'replayed callback is refused');
    },
    fetch: async (url, init) => {
      assert.equal(url, 'https://chickpea.example.test/auth/chatgpt-plan/handoff');
      assert.equal(init?.redirect, 'manual');
      const body = JSON.parse(String(init?.body));
      assert.equal(createHash('sha256').update(body.verifier).digest('base64url'), descriptor.challenge);
      if (body.code) { posts++; staged = true; return Response.json({ state: 'awaiting_confirmation' }); }
      if (staged) return Response.json({ state: 'connected' });
      const authorization = new URL('https://auth.openai.com/api/accounts/authorize');
      for (const [key, value] of Object.entries({ state: descriptor.state, nonce: descriptor.nonce, code_challenge: descriptor.challenge, redirect_uri: descriptor.redirectUri })) authorization.searchParams.set(key, value);
      return Response.json({ state: 'ready', authorizationUrl: authorization.href });
    },
  });
  assert.equal(posts, 1);
  assert.doesNotMatch(notes.join('\n'), /one-time-code/);
  assert.match(notes.at(-1)!, /connected/);
});

test('helper refuses an authorization URL that changes the OpenAI destination', async () => {
  await assert.rejects(connectChatgpt('https://chickpea.example.test', {
    timeoutMs: 1000, note: () => {}, openBrowser: async () => {},
    fetch: async () => Response.json({ state: 'ready', authorizationUrl: 'https://attacker.test/authorize' }),
  }), /invalid sign-in request/);
});
