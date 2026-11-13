import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { Hono } from 'hono';

import { createBetterAuth, type BetterAuthAdmissionOperation } from '../src/auth/better-auth.ts';
import { createBetterAuthPublicHandler } from '../src/auth/better-auth-routes.ts';
import { NodeBetterAuthBackend } from '../src/auth/better-auth-node.ts';
import { mountMcpOAuthBrowserRoutes } from '../src/auth/mcp-oauth-routes.ts';
import { CODEX_DOCUMENT, metadataDocumentServer } from './helpers/client-metadata-documents.ts';

const ORIGIN = 'https://chickpea.example.test';
const RESOURCE = `${ORIGIN}/mcp`;
const CODEX = CODEX_DOCUMENT.url;
const CODEX_CALLBACK = 'http://127.0.0.1:57943/callback';
const CODEX_NAME = (JSON.parse(CODEX_DOCUMENT.body) as { client_name: string }).client_name;
const ALREADY_CONNECTED = 'is already connected to Chickpea';
const MARKER_ROWS = "SELECT identifier, value, expiresAt FROM verification WHERE identifier LIKE 'chickpea:mcp-redeemed:%'";

async function fixture(t: TestContext) {
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
  const browser = new Hono();
  mountMcpOAuthBrowserRoutes(browser, async () => ({ environment }));
  const person = await auth.chickpea.reconcileSlackIdentity({
    slackTeamId: 'T12345678', slackUserId: 'U12345678', displayName: 'Fixture Owner',
    organization: { name: 'Fixture', slug: 'fixture' },
  });
  admission = {
    operationId: 'fixture', status: 'active', chickpeaRole: 'owner',
    slackTeamId: 'T12345678', slackUserId: 'U12345678',
    betterAuthUserId: person.userId, betterAuthOrganizationId: person.organizationId,
    betterAuthMembershipId: person.membershipId,
  };
  const session = await auth.chickpea.issueSession('fixture', new Request(`${ORIGIN}/oauth/finalize`, {
    method: 'POST', headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
  }));
  const cookie = session.headers.get('set-cookie')!.split(';', 1)[0]!;

  /** Codex's authorization URL for one PKCE verifier, followed to the consent page it lands on. */
  async function consentFor(verifier: string): Promise<URL> {
    const query = new URLSearchParams({
      response_type: 'code', client_id: CODEX, redirect_uri: CODEX_CALLBACK,
      scope: 'chickpea:workspace', state: 'codex-state', resource: RESOURCE,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    });
    const authorization = await handler(new Request(`${ORIGIN}/api/auth/oauth2/authorize?${query}`, { headers: { cookie } }));
    assert.equal(authorization.status, 302, await authorization.clone().text());
    const consent = new URL(authorization.headers.get('location')!, ORIGIN);
    assert.equal(consent.pathname, '/auth/mcp/consent');
    return consent;
  }
  const showConsent = (consent: URL) => browser.request(`${ORIGIN}${consent.pathname}${consent.search}`, {
    headers: { cookie },
  });
  /** Allow as a browser does: from the page, sending back the session check it shows, if any. */
  const submitConsent = async (consent: URL) => {
    const page = await (await showConsent(consent)).text();
    const sessionCheck = /name="session_check" value="([^"]*)"/.exec(page)?.[1]?.replaceAll('&amp;', '&');
    return browser.request(`${ORIGIN}/auth/mcp/consent`, {
      method: 'POST',
      headers: {
        cookie, origin: ORIGIN, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        oauth_query: consent.search.slice(1), decision: 'allow',
        ...(sessionCheck === undefined ? {} : { session_check: sessionCheck }),
      }),
    });
  };
  /** The code a consent POST's callback document sends the browser to, if it sends it anywhere. */
  async function callbackCode(response: Response): Promise<string | undefined> {
    const destination = /url=([^"]+)"/.exec(await response.clone().text())?.[1]?.replaceAll('&amp;', '&');
    if (!destination) return undefined;
    assert.equal(`${new URL(destination).origin}${new URL(destination).pathname}`, CODEX_CALLBACK);
    return new URL(destination).searchParams.get('code') ?? undefined;
  }
  const token = (form: Record<string, string>) => handler(new Request(`${ORIGIN}/api/auth/oauth2/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  }));
  const exchange = (code: string, verifier: string) => token({
    grant_type: 'authorization_code', client_id: CODEX, code, code_verifier: verifier,
    redirect_uri: CODEX_CALLBACK, resource: RESOURCE,
  });
  /** Codex's whole first sign-in: consent, Allow, and the code exchanged by its loopback listener. */
  async function signIn(verifier: string): Promise<URL> {
    const consent = await consentFor(verifier);
    const code = await callbackCode(await submitConsent(consent));
    assert.ok(code, 'the first Allow returns a code to Codex');
    const exchanged = await exchange(code, verifier);
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    return consent;
  }
  const codes = () => (backend.database.prepare(
    "SELECT COUNT(*) AS n FROM verification WHERE identifier NOT LIKE 'chickpea:%'",
  ).get() as { n: number }).n;
  return { backend, consentFor, showConsent, submitConsent, callbackCode, token, exchange, signIn, codes };
}

const verifier = () => randomBytes(32).toString('base64url');

async function assertAlreadyConnected(response: Response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const page = await response.text();
  assert.ok(page.includes(`${CODEX_NAME} ${ALREADY_CONNECTED}`), page);
  assert.ok(!page.includes('<form'), 'no consent form');
  assert.ok(!page.includes('http-equiv="refresh"'), 'no redirect to the loopback callback');
  assert.ok(!page.includes('127.0.0.1'), 'no loopback URL');
  assert.ok(!page.includes('codex-state'), 'no OAuth parameters');
}

test('reopening an authorization Codex already exchanged shows the already-connected page and issues no code', async (t) => {
  const f = await fixture(t);
  const sameVerifier = verifier();
  await f.signIn(sameVerifier);
  const codesAfterSignIn = f.codes();

  const again = await f.consentFor(sameVerifier);
  await assertAlreadyConnected(await f.showConsent(again));
  await assertAlreadyConnected(await f.submitConsent(again));
  assert.equal(f.codes(), codesAfterSignIn, 'no new authorization code is stored');
});

test('Allow in a tab opened before the exchange shows the already-connected page and issues no code', async (t) => {
  const f = await fixture(t);
  const sameVerifier = verifier();
  const earlyTab = await f.consentFor(sameVerifier);
  assert.ok((await (await f.showConsent(earlyTab)).text()).includes('<form'), 'the early tab shows the consent form');

  await f.signIn(sameVerifier);
  const codesAfterSignIn = f.codes();
  await assertAlreadyConnected(await f.submitConsent(earlyTab));
  assert.equal(f.codes(), codesAfterSignIn, 'no new authorization code is stored');
});

test('a new authorization with a fresh PKCE challenge is asked for consent as before', async (t) => {
  const f = await fixture(t);
  await f.signIn(verifier());

  const fresh = await f.consentFor(verifier());
  const page = await (await f.showConsent(fresh)).text();
  assert.ok(page.includes('<form'), 'consent form');
  assert.ok(!page.includes(ALREADY_CONNECTED));
  assert.ok(await f.callbackCode(await f.submitConsent(fresh)), 'Allow returns a new code');
});

test('a second tab is asked for consent as before while the first tab\'s code is still unexchanged', async (t) => {
  const f = await fixture(t);
  const sameVerifier = verifier();
  const first = await f.consentFor(sameVerifier);
  const firstCode = await f.callbackCode(await f.submitConsent(first));
  assert.ok(firstCode);

  const second = await f.consentFor(sameVerifier);
  const page = await (await f.showConsent(second)).text();
  assert.ok(page.includes('<form'), 'consent form');
  assert.ok(!page.includes(ALREADY_CONNECTED));
  const secondCode = await f.callbackCode(await f.submitConsent(second));
  assert.ok(secondCode, 'Allow returns a code');
  assert.notEqual(secondCode, firstCode);
});

test('a failed code exchange records nothing', async (t) => {
  const f = await fixture(t);
  const sameVerifier = verifier();
  const consent = await f.consentFor(sameVerifier);
  const code = await f.callbackCode(await f.submitConsent(consent));
  assert.equal((await f.exchange(code!, verifier())).status, 400, 'a wrong verifier is refused');

  assert.deepEqual(f.backend.database.prepare(MARKER_ROWS).all(), []);
  assert.ok((await (await f.showConsent(await f.consentFor(sameVerifier))).text()).includes('<form'));
});

test('a refresh_token grant carrying a stray code_verifier records nothing', async (t) => {
  const f = await fixture(t);
  const first = verifier();
  const code = await f.callbackCode(await f.submitConsent(await f.consentFor(first)));
  const exchanged = await f.exchange(code!, first);
  assert.equal(exchanged.status, 200, await exchanged.clone().text());
  const { refresh_token: refreshToken } = await exchanged.json() as { refresh_token?: string };
  assert.ok(refreshToken, 'Codex registers the refresh_token grant, and offline_access is a default scope');
  const markersAfterExchange = f.backend.database.prepare(MARKER_ROWS).all();
  assert.equal(markersAfterExchange.length, 1);

  const stray = verifier();
  const refreshed = await f.token({ grant_type: 'refresh_token', client_id: CODEX, refresh_token: refreshToken, code_verifier: stray });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  assert.deepEqual(f.backend.database.prepare(MARKER_ROWS).all(), markersAfterExchange, 'the refresh grant records no marker');
  assert.ok((await (await f.showConsent(await f.consentFor(stray))).text()).includes('<form'), 'consent form');
});

test('the redeemed marker stores a digest of client and challenge for the authorization lifetime, never the verifier', async (t) => {
  const f = await fixture(t);
  const sameVerifier = verifier();
  const consent = await f.signIn(sameVerifier);
  const exchangedAt = Date.now();

  const rows = f.backend.database.prepare(MARKER_ROWS).all() as { identifier: string; value: string; expiresAt: string }[];
  assert.equal(rows.length, 1);
  const [row] = rows;
  const challenge = createHash('sha256').update(sameVerifier).digest('base64url');
  assert.equal(row!.identifier, `chickpea:mcp-redeemed:${createHash('sha256').update(`${CODEX}\n${challenge}`).digest('hex')}`);
  for (const secret of [sameVerifier, challenge]) {
    assert.ok(!JSON.stringify(row).includes(secret), 'neither the verifier nor the challenge is stored');
  }
  const signedLifetime = Number(consent.searchParams.get('exp')) * 1_000 - Number(consent.searchParams.get('ba_iat'));
  const markerLifetime = new Date(row!.expiresAt).getTime() - exchangedAt;
  assert.ok(Math.abs(markerLifetime - signedLifetime) < 2_000,
    `outlives every consent query signed before the exchange: ${markerLifetime} vs ${signedLifetime}`);
});

test('an expired marker is ignored', async (t) => {
  const f = await fixture(t);
  const sameVerifier = verifier();
  await f.signIn(sameVerifier);
  f.backend.database.prepare("UPDATE verification SET expiresAt = ? WHERE identifier LIKE 'chickpea:mcp-redeemed:%'")
    .run(new Date(Date.now() - 1_000).toISOString());

  const again = await f.consentFor(sameVerifier);
  assert.ok((await (await f.showConsent(again)).text()).includes('<form'), 'consent form');
  assert.ok(await f.callbackCode(await f.submitConsent(again)), 'Allow returns a code as before');
});

test('a marker that cannot be written leaves the token response and the next consent as before', async (t) => {
  const f = await fixture(t);
  f.backend.database.exec(`CREATE TRIGGER refuse_marker BEFORE INSERT ON verification
    WHEN NEW.identifier LIKE 'chickpea:mcp-redeemed:%' BEGIN SELECT RAISE(ABORT, 'marker store down'); END`);
  const sameVerifier = verifier();
  await f.signIn(sameVerifier);

  const again = await f.consentFor(sameVerifier);
  assert.ok((await (await f.showConsent(again)).text()).includes('<form'), 'consent form');
  assert.ok(await f.callbackCode(await f.submitConsent(again)), 'Allow returns a code as before');
});

test('a marker that cannot be read falls back to the consent form and a code', async (t) => {
  const f = await fixture(t);
  const sameVerifier = verifier();
  await f.signIn(sameVerifier);
  const again = await f.consentFor(sameVerifier);
  const database = f.backend.database;
  const prepare = database.prepare.bind(database);
  database.prepare = (sql: string) => {
    const statement = prepare(sql);
    const all = statement.all.bind(statement);
    statement.all = (...parameters: never[]) => {
      if (parameters.some((value) => String(value).startsWith('chickpea:mcp-redeemed:'))) {
        throw new Error('marker store down');
      }
      return all(...parameters);
    };
    return statement;
  };

  assert.ok((await (await f.showConsent(again)).text()).includes('<form'), 'consent form');
  assert.ok(await f.callbackCode(await f.submitConsent(again)), 'Allow returns a code as before');
});
