import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { Hono } from 'hono';
import { decodeJwt } from 'jose';
import { makeSignature } from 'better-auth/crypto';

import {
  createBetterAuth,
  createBetterAuthSessionReader,
  type BetterAuthAdmissionOperation,
} from '../src/auth/better-auth.ts';
import { createBetterAuthPublicHandler } from '../src/auth/better-auth-routes.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import {
  mcpConsentAccount,
  mountMcpOAuthBrowserRoutes,
  renderMcpConsentPage,
  type McpConsentAccount,
} from '../src/auth/mcp-oauth-routes.ts';
import type { BetterAuthPrincipalRecord } from '../src/identity/types.ts';
import { CODEX_DOCUMENT, metadataDocumentServer } from './helpers/client-metadata-documents.ts';

const ORIGIN = 'https://chickpea.example.test';
const RESOURCE = `${ORIGIN}/mcp`;
const CODEX = CODEX_DOCUMENT.url;
const CODEX_CALLBACK = 'http://127.0.0.1:57943/callback';
const SESSION_COOKIE = '__Secure-better-auth.session_token';
const CHATGPT = 'https://chatgpt.com/oauth/client.json';

const BROWSER_FORM = {
  origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded',
};

/**
 * Better Auth in memory with Codex known by its metadata document (asked for
 * consent every time), two people in two workspaces, and the browser pages
 * mounted with a describe that names each.
 */
async function fixture(t: TestContext, options: { workspaceSwitch?: boolean } = {}) {
  const backend = new NodeBetterAuthBackend(':memory:');
  t.after(() => backend.close());
  let admission: BetterAuthAdmissionOperation | null = null;
  const environment = {
    backend, baseURL: ORIGIN, secret: randomBytes(32).toString('base64url'),
    clientMetadataDocuments: true,
    fetchClientMetadataResource: metadataDocumentServer({ [CODEX]: CODEX_DOCUMENT.body }).fetch,
  };
  const auth = await createBetterAuth({ ...environment, privateSeam: { async resolveAdmissionOperation() { return admission; } } });
  const handler = createBetterAuthPublicHandler(environment);

  const person = async (slackTeamId: string, slackUserId: string, slug: string) => {
    const reconciled = await auth.chickpea.reconcileSlackIdentity({
      slackTeamId, slackUserId, displayName: slug, organization: { name: slug, slug },
    });
    return { ...reconciled, slackTeamId, slackUserId };
  };
  const acme = await person('T0ACME0001', 'U0ACME0001', 'acme');
  const beta = await person('T0BETA0001', 'U0BETA0001', 'beta');
  /** A new browser session for `who`, as Slack sign-in would issue it. */
  async function signIn(who: typeof acme): Promise<string> {
    admission = {
      operationId: `op-${who.slackUserId}`, status: 'active', chickpeaRole: 'owner',
      slackTeamId: who.slackTeamId, slackUserId: who.slackUserId,
      betterAuthUserId: who.userId, betterAuthOrganizationId: who.organizationId,
      betterAuthMembershipId: who.membershipId,
    };
    const session = await auth.chickpea.issueSession(admission.operationId, new Request(`${ORIGIN}/oauth/finalize`, {
      method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    }));
    return session.headers.get('set-cookie')!.split(';', 1)[0]!;
  }

  const accounts = new Map<string, McpConsentAccount>([
    [acme.userId, { workspaceName: 'Acme', personName: 'Dana Reyes', role: 'owner' }],
    [beta.userId, { workspaceName: 'Beta Labs', personName: 'Sam Lee', role: 'member' }],
  ]);
  const described: string[] = [];
  const browser = new Hono();
  mountMcpOAuthBrowserRoutes(browser, async () => ({
    environment,
    workspaceSwitch: options.workspaceSwitch ?? true,
    describe: async (betterAuthUserId) => {
      described.push(betterAuthUserId);
      return accounts.get(betterAuthUserId);
    },
  }));

  const authorize = (path: string | URL, cookie: string) =>
    handler(new Request(new URL(path, ORIGIN), { headers: { cookie } }));
  /** Codex's authorization for one PKCE verifier, followed to where Better Auth sends the browser. */
  async function authorizeCodex(verifier: string, cookie: string): Promise<URL> {
    const query = new URLSearchParams({
      response_type: 'code', client_id: CODEX, redirect_uri: CODEX_CALLBACK,
      scope: 'chickpea:workspace', state: 'codex-state', resource: RESOURCE,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    const response = await authorize(`/api/auth/oauth2/authorize?${query}`, cookie);
    assert.equal(response.status, 302, await response.clone().text());
    return new URL(response.headers.get('location')!, ORIGIN);
  }
  async function consentFor(verifier: string, cookie: string): Promise<URL> {
    const consent = await authorizeCodex(verifier, cookie);
    assert.equal(consent.pathname, '/auth/mcp/consent');
    return consent;
  }
  const show = (consent: URL, cookie: string) =>
    browser.request(`${ORIGIN}${consent.pathname}${consent.search}`, { headers: { cookie } });
  /** The consent page's HTML and the session check its form carries. */
  async function page(consent: URL, cookie: string): Promise<{ html: string; sessionCheck: string | undefined }> {
    const response = await show(consent, cookie);
    assert.equal(response.status, 200);
    const html = await response.text();
    return { html, sessionCheck: /name="session_check" value="([^"]*)"/.exec(html)?.[1]?.replaceAll('&amp;', '&') };
  }
  const allow = (oauthQuery: string, cookie: string, sessionCheck: string | undefined) =>
    browser.request(`${ORIGIN}/auth/mcp/consent`, {
      method: 'POST',
      headers: { cookie, ...BROWSER_FORM },
      body: new URLSearchParams({
        oauth_query: oauthQuery, decision: 'allow', ...(sessionCheck === undefined ? {} : { session_check: sessionCheck }),
      }),
    });
  const switchFrom = (oauthQuery: string, cookie: string, headers: Record<string, string> = BROWSER_FORM) =>
    browser.request(`${ORIGIN}/auth/mcp/switch`, {
      method: 'POST',
      headers: { cookie, ...headers },
      body: new URLSearchParams({ oauth_query: oauthQuery }),
    });
  const resume = (path: string) => browser.request(`${ORIGIN}${path}`);
  /** The code a consent POST's callback document sends the browser to, if it sends it anywhere. */
  async function callbackCode(response: Response): Promise<string | undefined> {
    const destination = /url=([^"]+)"/.exec(await response.clone().text())?.[1]?.replaceAll('&amp;', '&');
    return destination ? new URL(destination).searchParams.get('code') ?? undefined : undefined;
  }
  const exchange = (code: string, verifier: string) => handler(new Request(`${ORIGIN}/api/auth/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: CODEX, code, code_verifier: verifier,
      redirect_uri: CODEX_CALLBACK, resource: RESOURCE,
    }),
  }));
  /** The Better Auth user a browser cookie signs in as now, if any. */
  async function sessionUser(cookie: string): Promise<string | undefined> {
    const reader = await createBetterAuthSessionReader(environment);
    const session = await reader.api.getSession({ headers: new Headers({ cookie }), query: { disableRefresh: true } });
    return session?.user.id;
  }
  const codes = () => (backend.database.prepare(
    "SELECT COUNT(*) AS n FROM verification WHERE identifier NOT LIKE 'chickpea:%'",
  ).get() as { n: number }).n;
  const continuations = () => (backend.database.prepare(
    'SELECT COUNT(*) AS n FROM chickpea_mcp_oauth_continuation',
  ).get() as { n: number }).n;
  return {
    environment, acme, beta, signIn, described, authorize, authorizeCodex, consentFor, show, page, allow, switchFrom,
    resume, callbackCode, exchange, sessionUser, codes, continuations,
  };
}

const verifier = () => randomBytes(32).toString('base64url');

/** `query` signed as Better Auth signs it, with its own `exp`. */
async function resigned(query: URLSearchParams, secret: string, exp: number): Promise<string> {
  const unsigned = new URLSearchParams(query);
  unsigned.delete('sig');
  unsigned.set('exp', String(exp));
  const canonical = new URLSearchParams([...unsigned.entries()].sort(([a, x], [b, y]) =>
    a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  unsigned.set('sig', await makeSignature(canonical.toString(), secret));
  return unsigned.toString();
}

/** Whether a response expires the browser's session cookie. */
function expiresSessionCookie(response: Response): boolean {
  return response.headers.getSetCookie().some((cookie) =>
    cookie.startsWith(`${SESSION_COOKIE}=;`) && /max-age=0/i.test(cookie));
}

test('consent names the workspace and the signed-in person, read for the session\'s own user', async (t) => {
  const f = await fixture(t);
  const cookie = await f.signIn(f.acme);
  const { html, sessionCheck } = await f.page(await f.consentFor(verifier(), cookie), cookie);

  assert.deepEqual(f.described, [f.acme.userId], 'described once, for the user the session signs in as');
  assert.ok(html.includes(
    '<div class="account"><span class="mark" aria-hidden="true">A</span><span><b>Acme</b><small>Slack workspace · signed in as Dana Reyes, Owner</small></span></div>',
  ), html);
  assert.ok(sessionCheck, 'the form is bound to the session the page names');
  assert.ok(!html.includes(f.acme.userId) && !html.includes('T0ACME0001'), 'no internal IDs');
});

test('Allow from the page grants to the session it named', async (t) => {
  const f = await fixture(t);
  const cookie = await f.signIn(f.acme);
  const sameVerifier = verifier();
  const consent = await f.consentFor(sameVerifier, cookie);
  const { sessionCheck } = await f.page(consent, cookie);
  const code = await f.callbackCode(await f.allow(consent.search.slice(1), cookie, sessionCheck));
  assert.ok(code, 'Allow returns a code');
  const exchanged = await f.exchange(code, sameVerifier);
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  assert.equal(decodeJwt((await exchanged.json() as { access_token: string }).access_token).sub, f.acme.userId);
});

// Defect caught: a page naming one workspace granted access to whatever session the browser held at Allow.
test('Allow from a page that named another session grants nothing and offers the request again', async (t) => {
  const f = await fixture(t);
  const acmeCookie = await f.signIn(f.acme);
  const consent = await f.consentFor(verifier(), acmeCookie);
  const acmePage = await f.page(consent, acmeCookie);
  const betaCookie = await f.signIn(f.beta);
  const before = f.codes();

  for (const check of [acmePage.sessionCheck, '', 'forged']) {
    const response = await f.allow(consent.search.slice(1), betaCookie, check);
    assert.equal(response.status, 409, String(check));
    const html = await response.text();
    assert.ok(html.includes('<h1>Your sign-in changed</h1>'));
    assert.ok(!html.includes('http-equiv="refresh"') && !html.includes(CODEX_CALLBACK), 'nothing is sent to the client');
    const review = /<a href="([^"]+)">Review the request<\/a>/.exec(html)?.[1]?.replaceAll('&amp;', '&');
    assert.equal(review, `/auth/mcp/consent${consent.search}`, 'the same signed request, on this origin');
  }
  assert.equal(f.codes(), before, 'no authorization code is stored');
  const again = await f.page(consent, betaCookie);
  assert.ok(again.html.includes('<b>Beta Labs</b>'), 'reviewing again names the session held now');
  assert.ok(await f.callbackCode(await f.allow(consent.search.slice(1), betaCookie, again.sessionCheck)),
    'and its Allow grants');
});

// Defect caught: a page that named no one (opened before the check, or one that could not read the session) granted to whatever session the browser held at Allow.
test('a consent form that named no session grants nothing and offers the request again', async (t) => {
  const f = await fixture(t);
  const cookie = await f.signIn(f.acme);
  const consent = await f.consentFor(verifier(), cookie);
  const before = f.codes();
  const response = await f.allow(consent.search.slice(1), cookie, undefined);
  assert.equal(response.status, 409);
  assert.ok((await response.text()).includes('<h1>Your sign-in changed</h1>'));
  assert.equal(f.codes(), before, 'no authorization code is stored');
  const again = await f.page(consent, cookie);
  assert.ok(await f.callbackCode(await f.allow(consent.search.slice(1), cookie, again.sessionCheck)),
    'the page shown again names the session, and its Allow grants');
});

test('consent offers Switch only where sign-in can choose another workspace', async (t) => {
  const pinned = await fixture(t, { workspaceSwitch: false });
  const cookie = await pinned.signIn(pinned.acme);
  const consent = await pinned.consentFor(verifier(), cookie);
  const { html } = await pinned.page(consent, cookie);
  assert.ok(!html.includes('/auth/mcp/switch'));
  assert.ok(!html.includes('Switch signs you out'));
  assert.equal((await pinned.switchFrom(consent.search.slice(1), cookie)).status, 404);
  assert.equal(await pinned.sessionUser(cookie), pinned.acme.userId, 'the session is untouched');

  const hosted = await fixture(t);
  const hostedCookie = await hosted.signIn(hosted.acme);
  const hostedConsent = await hosted.consentFor(verifier(), hostedCookie);
  const offered = (await hosted.page(hostedConsent, hostedCookie)).html;
  assert.ok(offered.includes('<form method="post" action="/auth/mcp/switch" class="switch">'));
  assert.ok(offered.includes(`<input type="hidden" name="oauth_query" value="${hostedConsent.search.slice(1).replaceAll('&', '&amp;')}">`));
  assert.ok(offered.includes('Not this workspace? <button type="submit">Switch</button>'));
  assert.ok(offered.includes('<p class="foot">Switch signs you out here and takes you to Slack to choose another workspace. You can disconnect'));
});

test('Switch signs out, then resumes the same signed request once, and the grant goes to the workspace chosen', async (t) => {
  const f = await fixture(t);
  const acmeCookie = await f.signIn(f.acme);
  const sameVerifier = verifier();
  const consent = await f.consentFor(sameVerifier, acmeCookie);
  const acmePage = await f.page(consent, acmeCookie);

  const switched = await f.switchFrom(consent.search.slice(1), acmeCookie);
  assert.equal(switched.status, 303, await switched.clone().text());
  assert.equal(switched.headers.get('cache-control'), 'no-store');
  assert.ok(expiresSessionCookie(switched), 'the browser drops its session cookie');
  assert.equal(await f.sessionUser(acmeCookie), undefined, 'the old session is ended, not only forgotten');
  const signIn = new URL(switched.headers.get('location')!, ORIGIN);
  assert.equal(signIn.origin, ORIGIN);
  assert.equal(signIn.pathname, '/auth/slack/sign-in');
  const destination = signIn.searchParams.get('destination')!;
  assert.match(destination, /^\/auth\/mcp\/resume\/[A-Za-z0-9_-]{43}$/);

  // Slack sign-in, now to the other workspace, lands on the continuation.
  const betaCookie = await f.signIn(f.beta);
  const resumed = await f.resume(destination);
  assert.equal(resumed.status, 303);
  const authorization = new URL(resumed.headers.get('location')!, ORIGIN);
  assert.equal(authorization.pathname, '/api/auth/oauth2/authorize');
  assert.equal(authorization.search, consent.search, 'the signed request survives unchanged');
  assert.equal((await f.resume(destination)).status, 410, 'the continuation is used once');

  const betaConsent = new URL((await f.authorize(authorization, betaCookie)).headers.get('location')!, ORIGIN);
  assert.equal(betaConsent.pathname, '/auth/mcp/consent');
  const betaPage = await f.page(betaConsent, betaCookie);
  assert.ok(betaPage.html.includes('<b>Beta Labs</b><small>Slack workspace · signed in as Sam Lee, Member</small>'));

  const before = f.codes();
  assert.equal((await f.allow(consent.search.slice(1), betaCookie, acmePage.sessionCheck)).status, 409,
    'the abandoned page, still naming Acme, grants nothing');
  assert.notEqual((await f.allow(consent.search.slice(1), acmeCookie, acmePage.sessionCheck)).status, 200,
    'the ended session grants nothing');
  assert.equal(f.codes(), before);

  const code = await f.callbackCode(await f.allow(betaConsent.search.slice(1), betaCookie, betaPage.sessionCheck));
  assert.ok(code);
  const exchanged = await f.exchange(code, sameVerifier);
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  assert.equal(decodeJwt((await exchanged.json() as { access_token: string }).access_token).sub, f.beta.userId);

  const replayed = await f.switchFrom(consent.search.slice(1), betaCookie);
  assert.equal(replayed.status, 200);
  assert.ok((await replayed.text()).includes('is already connected to Chickpea'), 'a redeemed request is not switched again');
  assert.ok(!expiresSessionCookie(replayed));
  assert.equal(await f.sessionUser(betaCookie), f.beta.userId, 'and its session stays');
});

test('Switch refuses a tampered, expired, cross-site or unsigned request before it ends anything', async (t) => {
  const f = await fixture(t);
  const cookie = await f.signIn(f.acme);
  const consent = await f.consentFor(verifier(), cookie);
  const query = new URLSearchParams(consent.search);

  const refusals: Array<[string, string, Record<string, string> | undefined, number]> = [];
  for (const [field, value] of [
    ['redirect_uri', 'https://attacker.example/callback'],
    ['client_id', 'https://attacker.example/client.json'],
    ['state', 'other-state'],
    ['scope', 'chickpea:workspace'],
  ] as const) {
    const tampered = new URLSearchParams(query);
    tampered.set(field, value);
    refusals.push([`tampered ${field}`, tampered.toString(), undefined, 400]);
  }
  const added = new URLSearchParams(query);
  added.append('prompt', 'none');
  refusals.push(['added parameter', added.toString(), undefined, 400]);
  refusals.push(['expired', await resigned(query, f.environment.secret, Math.floor(Date.now() / 1_000) - 1), undefined, 400]);
  refusals.push(['unsigned', new URLSearchParams([...query].filter(([key]) => key !== 'sig')).toString(), undefined, 400]);
  refusals.push(['cross-site', query.toString(), { ...BROWSER_FORM, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }, 403]);
  refusals.push(['no origin', query.toString(), { 'content-type': 'application/x-www-form-urlencoded' }, 403]);

  const continuations = f.continuations();
  for (const [name, oauthQuery, headers, status] of refusals) {
    const response = await f.switchFrom(oauthQuery, cookie, headers);
    assert.equal(response.status, status, name);
    assert.equal(response.headers.get('location'), null, name);
    assert.ok(!expiresSessionCookie(response), name);
    assert.equal(await f.sessionUser(cookie), f.acme.userId, `${name}: the session is untouched`);
  }
  assert.equal(f.continuations(), continuations, 'no continuation is issued');
});

// Defect caught: Switch ended the session first, so a request whose continuation could not be issued left the person signed out with nowhere to go.
test('Switch ends no session when it cannot issue the way back', async (t) => {
  const f = await fixture(t);
  const cookie = await f.signIn(f.acme);
  const consent = await f.consentFor(verifier(), cookie);
  // Signed and in date, but too long to carry as a continuation's authorization path.
  const padded = new URLSearchParams(consent.search);
  const exp = Number(padded.get('exp'));
  padded.set('state', 'x'.repeat(4_090 - padded.toString().length + padded.get('state')!.length));
  const oauthQuery = await resigned(padded, f.environment.secret, exp);
  assert.ok(oauthQuery.length <= 4_096 && oauthQuery.length > 4_070, String(oauthQuery.length));

  const continuations = f.continuations();
  const response = await f.switchFrom(oauthQuery, cookie);
  assert.equal(response.status, 500);
  assert.ok(!expiresSessionCookie(response));
  assert.equal(await f.sessionUser(cookie), f.acme.userId, 'the session is untouched');
  assert.equal(f.continuations(), continuations);
});

test('consent wording names the workspace for a known app and stays generic without one', () => {
  const base = { scope: 'chickpea:workspace', oauthQuery: 'sig=test' };
  const named = renderMcpConsentPage({
    ...base, clientId: CHATGPT, account: { workspaceName: 'Northwind Studio', personName: 'Dana Reyes', role: 'admin' },
  });
  assert.ok(named.includes('<h1>Allow ChatGPT to manage Northwind Studio?</h1>'));
  assert.ok(named.includes('<small>Slack workspace · signed in as Dana Reyes, Admin</small>'));
  assert.ok(named.includes('<p>ChatGPT will act as you in this Chickpea workspace. It can do only what you can do.</p>'));

  const personOnly = renderMcpConsentPage({ ...base, clientId: CHATGPT, account: { personName: 'Dana Reyes', role: 'member' } });
  assert.ok(personOnly.includes('<h1>Allow ChatGPT to manage your workspace?</h1>'), 'no stored name keeps today\'s heading');
  assert.ok(personOnly.includes('<p class="account">Signed in as Dana Reyes, Member.</p>'));

  const workspaceOnly = renderMcpConsentPage({ ...base, clientId: CHATGPT, account: { workspaceName: 'Acme' } });
  assert.ok(workspaceOnly.includes('<b>Acme</b><small>Slack workspace</small>'));

  const unknownApp = renderMcpConsentPage({ ...base, clientName: 'Some app', account: { workspaceName: 'Acme' } });
  assert.ok(unknownApp.includes('<h1>Allow workspace management?</h1>'), 'an unknown app\'s heading stays generic');
  assert.ok(unknownApp.includes('<b>Acme</b>'), 'the box still names the workspace');

  const nobody = renderMcpConsentPage({ ...base, clientId: CHATGPT });
  assert.ok(!nobody.includes('class="account"'));
  assert.ok(!nobody.includes('session_check'));
  assert.ok(!nobody.includes('/auth/mcp/switch'));
});

test('consent escapes, cleans and bounds workspace and person names', () => {
  const html = renderMcpConsentPage({
    clientId: CHATGPT, scope: 'chickpea:workspace', oauthQuery: 'sig=test',
    account: {
      workspaceName: '<img src=x onerror=alert(1)>‮evil',
      personName: '"><script>alert(1)</script>',
      role: 'owner',
    },
    sessionCheck: 'a"b',
  });
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('‮'), 'bidi overrides are stripped');
  assert.ok(html.includes('<h1>Allow ChatGPT to manage &lt;img src=x onerror=alert(1)&gt;evil?</h1>'));
  assert.ok(html.includes('<span class="mark" aria-hidden="true">&lt;</span>'));
  assert.ok(html.includes('signed in as &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;, Owner'));
  assert.ok(html.includes('name="session_check" value="a&quot;b"'));
  const long = renderMcpConsentPage({
    clientId: CHATGPT, scope: 'chickpea:workspace', oauthQuery: 'sig=test', account: { workspaceName: 'W'.repeat(200) },
  });
  assert.ok(!long.includes('W'.repeat(60)), 'bounded like an app name');
});

test('the account consent shows comes from the principal and the stored name, with a role only while active', () => {
  const principal = (status: 'active' | 'suspended'): BetterAuthPrincipalRecord => ({
    binding: {} as BetterAuthPrincipalRecord['binding'],
    organization: null,
    user: { displayName: '  Dana Reyes ' } as BetterAuthPrincipalRecord['user'],
    membership: { role: 'admin', status } as BetterAuthPrincipalRecord['membership'],
    overlay: null,
  });
  assert.deepEqual(mcpConsentAccount(principal('active'), ' Acme '), { workspaceName: 'Acme', personName: 'Dana Reyes', role: 'admin' });
  assert.deepEqual(mcpConsentAccount(principal('suspended'), undefined), { personName: 'Dana Reyes' });
  assert.deepEqual(mcpConsentAccount(undefined, '  '), {});
});
