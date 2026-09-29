import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import { cancelPlanConnection, completePlanHandoff, confirmPlanConnection, disconnectPlan, planStatus, pollPlanHandoff, preparePlanConnection, resolvePlanSession, type PlanDependencies } from '../src/chatgpt-plan/connection.ts';
import { completedResponse, normalizePlanPayload, planFetch } from '../src/chatgpt-plan/provider.ts';
import { chatgptAuthorizationUrl, exchangeChatgptCode } from '../src/chatgpt-plan/protocol.ts';

function harness() {
  const store = new SqliteSettingsStore(':memory:');
  let time = 1_800_000_000_000;
  let exchanges = 0;
  let refreshes = 0;
  const revoked: string[] = [];
  const verifier = randomBytes(32).toString('base64url');
  const descriptor = { challenge: createHash('sha256').update(verifier).digest('base64url'), state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), redirectUri: 'http://127.0.0.1:12345/auth/callback' };
  const d: PlanDependencies = {
    settings: store, credentials: store, keyring: generateCredentialKeyring('test'), now: () => time,
    exchange: async input => { exchanges++; return { clientId: input.clientId, hostId: input.hostId, subject: 'test-user', email: 'owner@example.test', accessToken: 'secret-access', refreshToken: 'secret-refresh', idToken: 'secret-id', scopes: ['chatgpt.tokens.use.direct'], expiresAt: time + 3600000 }; },
    refresh: async session => { refreshes++; return { ...session, accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresAt: time + 3600000 }; },
    revoke: async session => { revoked.push(session.refreshToken); },
    fetch: async () => Response.json({ models: [{ slug: 'gpt-future', display_name: 'Future', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' }] }),
  };
  const handoff = () => completePlanHandoff(d, { verifier, code: 'single-use-code', clientId: 'oaiapp_test' });
  const connect = async () => { await preparePlanConnection(d, descriptor); await handoff(); await confirmPlanConnection(d, descriptor.challenge); };
  return { store, d, descriptor, verifier, handoff, connect, revoked, advance: (ms: number) => { time += ms; }, counts: () => ({ exchanges, refreshes }) };
}

test('ChatGPT requires owner approval, proof, and account confirmation; credentials remain encrypted', async t => {
  const h = harness(); t.after(() => h.store.close());
  assert.equal((await pollPlanHandoff(h.d, h.verifier)).state, 'waiting_for_approval');
  await assert.rejects(h.handoff());
  await assert.rejects(preparePlanConnection(h.d, { ...h.descriptor, redirectUri: 'https://attacker.test/auth/callback' }));
  await preparePlanConnection(h.d, h.descriptor);
  const auth = await pollPlanHandoff(h.d, h.verifier);
  assert.equal(auth.state, 'ready');
  assert.equal(new URL(auth.authorizationUrl!).searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal((await pollPlanHandoff(h.d, randomBytes(32).toString('base64url'))).state, 'waiting_for_approval');
  await assert.rejects(completePlanHandoff(h.d, { verifier: randomBytes(32).toString('base64url'), code: 'code', clientId: 'oaiapp_test' }));
  await h.handoff();
  await h.handoff();
  assert.equal(h.counts().exchanges, 1, 'callback replay does not exchange twice');
  assert.equal((await planStatus(h.d)).state, 'disconnected', 'staging does not activate billing');
  await assert.rejects(confirmPlanConnection(h.d, 'wrong-attempt'));
  await confirmPlanConnection(h.d, h.descriptor.challenge);
  assert.equal((await pollPlanHandoff(h.d, h.verifier)).state, 'connected');
  assert.deepEqual((await planStatus(h.d)).models, [{ id: 'gpt-future', name: 'Future' }]);
  const record = await h.store.getEncryptedCredentialRevision('chatgpt-plan.session');
  assert.ok(record);
  assert.doesNotMatch(JSON.stringify(record), /secret-access|secret-refresh|secret-id/);
  assert.doesNotMatch(JSON.stringify(await planStatus(h.d)), /secret-access|secret-refresh|secret-id/);
  assert.equal(await h.store.getSetting('provider.openai.authMethod'), 'subscription');
});

test('parallel turns rotate one token pair; disconnect revokes the rotated session and fails closed', async t => {
  const h = harness(); t.after(() => h.store.close()); await h.connect();
  h.advance(3590000);
  const bundles = await Promise.all([resolvePlanSession(h.d), resolvePlanSession(h.d), resolvePlanSession(h.d)]);
  assert.equal(h.counts().refreshes, 1);
  assert.ok(bundles.every(bundle => bundle.session.refreshToken === 'rotated-refresh'));
  await disconnectPlan(h.d);
  assert.deepEqual(h.revoked, ['rotated-refresh']);
  await assert.rejects(resolvePlanSession(h.d));
  assert.equal(await h.store.getSetting('provider.openai.authMethod'), 'subscription', 'no API key fallback');
});

test('cancellation and expiration revoke only the staged session', async t => {
  const h = harness(); t.after(() => h.store.close());
  await preparePlanConnection(h.d, h.descriptor); await h.handoff();
  h.advance(16 * 60_000);
  await assert.rejects(confirmPlanConnection(h.d, h.descriptor.challenge));
  await planStatus(h.d);
  assert.deepEqual(h.revoked, ['secret-refresh']);
  assert.equal(await h.store.getEncryptedCredentialRevision('chatgpt-plan.candidate'), undefined);
  await cancelPlanConnection(h.d);
});

test('subscription transport uses public Responses, namespaces tools, strips unsupported parameters, and never redirects', async t => {
  const h = harness(); t.after(() => h.store.close()); await h.connect();
  const payload = normalizePlanPayload({ model: 'gpt-future', stream: false, store: true, temperature: 1, max_output_tokens: 100, previous_response_id: 'old', input: [{ role: 'system', content: 'policy' }, { type: 'function_call', name: 'lookup', call_id: 'c', arguments: '{}' }], tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] });
  assert.equal(payload.store, false); assert.equal(payload.stream, true);
  assert.equal(payload.temperature, undefined); assert.equal(payload.previous_response_id, undefined);
  assert.equal((payload.input as Array<{role: string}>)[0]?.role, 'developer');
  assert.equal((payload.tools as Array<{type: string}>)[0]?.type, 'namespace');
  let sent = false;
  h.d.fetch = async (url, init) => {
    sent = true;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret-access');
    return new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  };
  const call = planFetch(h.d);
  await assert.rejects(call('https://attacker.test/responses', { method: 'POST' })); assert.equal(sent, false);
  const response = await call('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: 'Bearer unrelated-api-key' }, body: JSON.stringify({ model: 'gpt-future', input: [{ role: 'user', content: 'hello' }] }) });
  await response.text(); assert.equal(sent, true);
  await h.store.setSetting('provider.openai.authMethod', 'api_key');
  await assert.rejects(call('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify(payload) }));
});

test('stream completion requires response.completed and rejects late failures', async () => {
  for (const text of ['data: {"type":"response.output_text.delta","delta":"partial"}\n\n', 'data: {"type":"response.completed"}\n\ndata: {"type":"error"}\n\n']) {
    await assert.rejects(completedResponse(new Response(text)).text());
  }
  await completedResponse(new Response('data: {"type":"response.completed"}\n\n')).text();
});

test('OAuth code exchange enforces plan scope and bound identity; discovery cannot supply an arbitrary callback', async () => {
  const input = { clientId: 'oaiapp_test', hostId: 'urn:uuid:00000000-0000-4000-8000-000000000001', code: 'code', verifier: 'verifier', redirectUri: 'http://127.0.0.1:1234/auth/callback', nonce: 'nonce' };
  assert.throws(() => chatgptAuthorizationUrl({ ...input, challenge: 'c', state: 's', redirectUri: 'http://127.0.0.1:1234/auth/callback?forward=https://attacker.test' }));
  await assert.rejects(exchangeChatgptCode(input, { fetch: async () => Response.json({ access_token: 'a', refresh_token: 'r', id_token: 'i', expires_in: 3600, token_type: 'Bearer', scope: 'openid' }) }));
  const session = await exchangeChatgptCode(input, {
    fetch: async (_url, init) => {
      assert.equal(init?.redirect, 'manual');
      assert.equal((init?.body as URLSearchParams).get('resource'), 'https://api.openai.com/v1');
      return Response.json({ access_token: 'a', refresh_token: 'r', id_token: 'i', expires_in: 3600, token_type: 'Bearer', scope: 'chatgpt.tokens.use.direct' });
    },
    validateIdentity: async (_token, clientId, nonce) => { assert.equal(clientId, input.clientId); assert.equal(nonce, input.nonce); return { subject: 'user', email: 'owner@example.test' }; },
  });
  assert.equal(session.subject, 'user');
});
