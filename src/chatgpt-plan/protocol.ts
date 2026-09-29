import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { OpenAiSubscriptionError } from '../openai-subscription/errors.ts';

export const CHATGPT_PLAN_API = 'https://api.openai.com/v1';
export const CHATGPT_PLAN_AUTH = 'https://auth.openai.com';
export const CHATGPT_PLAN_SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export interface ChatgptPlanSession {
  clientId: string;
  hostId: string;
  subject: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  idToken: string;
  scopes: string[];
  expiresAt: number;
}
export interface ChatgptPlanModel { id: string; name: string }
const terminalRefreshErrors = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

export function assertChatgptHostId(value: string): void {
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new OpenAiSubscriptionError('protocol_drift');
  }
}

export function chatgptAuthorizationUrl(input: {
  hostId: string; clientId?: string; redirectUri: string; state: string; nonce: string; challenge: string;
}): string {
  assertChatgptHostId(input.hostId);
  const callback = new URL(input.redirectUri);
  if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.pathname !== '/auth/callback' || callback.search || callback.hash || callback.username || callback.password || !callback.port) throw new OpenAiSubscriptionError('protocol_drift');
  const url = new URL('/api/accounts/authorize', CHATGPT_PLAN_AUTH);
  const values = {
    client_id: input.clientId ?? 'dynamic_agent_client',
    ...(!input.clientId ? { agent_name_hint: 'Chickpea' } : {}),
    ext_agent_host_id: input.hostId, response_type: 'code', redirect_uri: input.redirectUri,
    scope: CHATGPT_PLAN_SCOPES, resource: CHATGPT_PLAN_API,
    state: input.state, nonce: input.nonce, code_challenge_method: 'S256', code_challenge: input.challenge,
  };
  for (const [key, value] of Object.entries(values)) url.searchParams.set(key, value);
  return url.href;
}

export async function chatgptJson(url: string, init: RequestInit = {}, fetchImpl = fetch): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { ...init, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(20_000) });
  let payload: Record<string, unknown>;
  try {
    const text = await readBoundedText(response);
    payload = JSON.parse(text);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid response');
  } catch { throw new OpenAiSubscriptionError('invalid_response'); }
  if (!response.ok) {
    const error = typeof payload.error === 'string' ? payload.error : (payload.error as { code?: string } | undefined)?.code;
    throw new OpenAiSubscriptionError(
      terminalRefreshErrors.has(error ?? '') || response.status === 401 ? 'auth_reconnect_required'
        : response.status === 429 ? 'subscription_quota_exhausted'
          : response.status === 403 ? 'entitlement_denied' : 'provider_unavailable',
    );
  }
  return payload;
}

let verificationKey: ReturnType<typeof createRemoteJWKSet> | undefined;
export async function validateChatgptIdentity(idToken: string, clientId: string, nonce?: string) {
  if (!verificationKey) {
    const discovery = await chatgptJson(`${CHATGPT_PLAN_AUTH}/.well-known/openid-configuration`);
    const uri = new URL(String(discovery.jwks_uri));
    if (discovery.issuer !== CHATGPT_PLAN_AUTH || uri.origin !== CHATGPT_PLAN_AUTH) throw new OpenAiSubscriptionError('protocol_drift');
    verificationKey = createRemoteJWKSet(uri, { timeoutDuration: 20_000,
      [customFetch]: (url, init) => fetch(url, { ...init, redirect: 'manual' }),
    });
  }
  const { payload } = await jwtVerify(idToken, verificationKey, { issuer: CHATGPT_PLAN_AUTH, audience: clientId, algorithms: ['RS256'] });
  if (!payload.sub || !payload.exp || (nonce !== undefined && payload.nonce !== nonce)) throw new OpenAiSubscriptionError('protocol_drift');
  return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : '' };
}

export async function exchangeChatgptCode(input: {
  clientId: string; hostId: string; code: string; verifier: string; redirectUri: string; nonce: string;
}, dependencies: { fetch?: typeof fetch; validateIdentity?: typeof validateChatgptIdentity; now?: () => number } = {}): Promise<ChatgptPlanSession> {
  const response = await chatgptJson(`${CHATGPT_PLAN_AUTH}/api/accounts/oauth/token`, {
    method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: input.clientId,
      code: input.code, code_verifier: input.verifier, redirect_uri: input.redirectUri, resource: CHATGPT_PLAN_API }),
  }, dependencies.fetch);
  const tokens = parseChatgptTokens(response, dependencies.now?.() ?? Date.now());
  if (!tokens.idToken) throw new OpenAiSubscriptionError('protocol_drift');
  const identity = await (dependencies.validateIdentity ?? validateChatgptIdentity)(tokens.idToken, input.clientId, input.nonce);
  return { ...tokens, idToken: tokens.idToken, ...identity, hostId: input.hostId, clientId: input.clientId };
}

export async function refreshChatgptSession(session: ChatgptPlanSession, fetchImpl = fetch, now = Date.now()): Promise<ChatgptPlanSession> {
  const response = await chatgptJson(`${CHATGPT_PLAN_AUTH}/api/accounts/oauth/token`, {
    method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: session.clientId,
      refresh_token: session.refreshToken, resource: CHATGPT_PLAN_API }),
  }, fetchImpl);
  const tokens = parseChatgptTokens(response, now, session.scopes);
  if (tokens.idToken) {
    const identity = await validateChatgptIdentity(tokens.idToken, session.clientId);
    if (identity.subject !== session.subject) throw new OpenAiSubscriptionError('auth_reconnect_required');
  }
  return { ...session, ...tokens, idToken: tokens.idToken ?? session.idToken };
}

function parseChatgptTokens(response: Record<string, unknown>, now: number, priorScopes?: string[]) {
  const scopes = typeof response.scope === 'string' ? response.scope.split(/\s+/) : priorScopes;
  if (!scopes?.includes('chatgpt.tokens.use.direct')) throw new OpenAiSubscriptionError('entitlement_denied');
  if (typeof response.access_token !== 'string' || !response.access_token || typeof response.refresh_token !== 'string' || !response.refresh_token || typeof response.expires_in !== 'number' || !Number.isFinite(response.expires_in) || response.expires_in <= 0 || response.expires_in > 86400 || response.token_type !== 'Bearer') throw new OpenAiSubscriptionError('protocol_drift');
  return { accessToken: response.access_token, refreshToken: response.refresh_token,
    idToken: typeof response.id_token === 'string' ? response.id_token : undefined,
    expiresAt: now + response.expires_in * 1000, scopes };
}

export async function listChatgptModels(accessToken: string, fetchImpl = fetch): Promise<ChatgptPlanModel[]> {
  const payload = await chatgptJson(`${CHATGPT_PLAN_API}/models`, { headers: { authorization: `Bearer ${accessToken}` } }, fetchImpl);
  if (!Array.isArray(payload.models)) throw new OpenAiSubscriptionError('invalid_response');
  return payload.models.filter((model): model is { slug: string; display_name: string; visibility: string } =>
    model?.visibility === 'list' && typeof model.slug === 'string' && /^[a-z0-9][a-z0-9._-]+$/i.test(model.slug) && typeof model.display_name === 'string',
  ).map(model => ({ id: model.slug, name: model.display_name }));
}

export async function revokeChatgptSession(session: ChatgptPlanSession, fetchImpl = fetch): Promise<void> {
  const discovery = await chatgptJson(`${CHATGPT_PLAN_AUTH}/.well-known/openid-configuration`, {}, fetchImpl);
  const endpoint = new URL(String(discovery.revocation_endpoint));
  if (endpoint.origin !== CHATGPT_PLAN_AUTH) throw new OpenAiSubscriptionError('protocol_drift');
  const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
    body: new URLSearchParams({ token: session.refreshToken, token_type_hint: 'refresh_token', client_id: session.clientId }) });
  await response.body?.cancel();
  if (response.status !== 200) throw new OpenAiSubscriptionError('provider_unavailable');
}

export async function readBoundedText(response: Response, limit = 1_048_576): Promise<string> {
  if (!response.body) throw new OpenAiSubscriptionError('invalid_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new OpenAiSubscriptionError('invalid_response');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { await reader.cancel(); }
}
