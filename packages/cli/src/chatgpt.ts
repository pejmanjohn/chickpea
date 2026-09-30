import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { chatgptReturnPage } from './chatgpt-page.ts';
import { CliError } from './errors.ts';

interface ConnectDeps {
  fetch: typeof fetch;
  openBrowser: (url: string) => Promise<void>;
  note: (text: string) => void;
  timeoutMs?: number;
}

/** The helper holds PKCE material in memory. OpenAI tokens never reach it. */
export async function connectChatgpt(origin: string, deps: ConnectDeps): Promise<void> {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const signal = AbortSignal.timeout(deps.timeoutMs ?? 15 * 60_000);
  let expectedClient: string | undefined;
  let ready = false;
  let callbackStarted = false;
  let callbackError = false;
  let authorized = false;
  const post = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await deps.fetch(`${origin}/auth/chatgpt-plan/handoff`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verifier, ...body }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new CliError('CHATGPT_CONNECTION_FAILED', 'Chickpea could not finish ChatGPT sign-in. Return to Model providers to start again.'); }
    return await response.json() as Record<string, unknown>;
  };
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    if (req.method !== 'GET' || req.headers.host !== new URL(redirectUri).host) { res.writeHead(400).end(); return; }
    const url = new URL(req.url ?? '/', redirectUri);
    if (url.pathname === '/complete') {
      res.setHeader('Content-Security-Policy', `default-src 'none'; img-src ${origin}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(chatgptReturnPage(origin));
      return;
    }
    if (url.pathname !== '/auth/callback' || !ready || callbackStarted || url.searchParams.get('state') !== state) { res.writeHead(400).end('This sign-in callback is not valid.'); return; }
    callbackStarted = true;
    const code = url.searchParams.get('code');
    const clientId = url.searchParams.get('client_id') ?? expectedClient;
    if (url.searchParams.has('error') || !code || !clientId || !/^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(clientId) || (expectedClient && clientId !== expectedClient)) {
      callbackError = true;
      res.writeHead(400).end('Sign-in was not completed. Return to Chickpea and try again.');
      return;
    }
    // Remove the single-use code from the browser's visible URL immediately.
    res.writeHead(303, { location: '/complete' }).end();
    void post({ code, clientId }).then(result => {
      authorized = result.state === 'awaiting_confirmation';
      callbackError = !authorized;
      if (authorized) deps.note('Sign-in received. Confirm the account in Chickpea Model providers.');
    }).catch(() => { callbackError = true; });
  });
  let redirectUri = '';
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback listener unavailable');
    redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
    const descriptor = Buffer.from(JSON.stringify({ challenge, state, nonce, redirectUri })).toString('base64url');
    const adminUrl = `${origin}/admin/settings/providers?chatgpt_connect=${descriptor}`;
    deps.note(`Opening ${origin}. Approve ChatGPT sign-in in Model providers.`);
    deps.note(`If the browser does not open, visit: ${adminUrl}`);
    await deps.openBrowser(adminUrl);
    while (!signal.aborted) {
      if (callbackError) throw new CliError('CHATGPT_SIGN_IN_FAILED', 'ChatGPT sign-in did not complete. Return to Chickpea to start again.');
      const result = await post({});
      if (result.state === 'connected') { deps.note('ChatGPT is connected to this Chickpea installation.'); return; }
      if (result.state === 'ready' && !ready) {
        const url = new URL(String(result.authorizationUrl));
        if (url.origin !== 'https://auth.openai.com' || url.pathname !== '/api/accounts/authorize' || url.searchParams.get('state') !== state || url.searchParams.get('nonce') !== nonce || url.searchParams.get('code_challenge') !== challenge || url.searchParams.get('redirect_uri') !== redirectUri) throw new CliError('CHATGPT_SIGN_IN_FAILED', 'Chickpea returned an invalid sign-in request.');
        expectedClient = typeof result.clientId === 'string' ? result.clientId : undefined;
        ready = true;
        deps.note('Opening OpenAI. Sign in with the account you want this installation to use.');
        await deps.openBrowser(url.href);
      }
      await delay(1500, undefined, { signal });
    }
    throw new CliError('CHATGPT_SIGN_IN_EXPIRED', 'Sign-in expired. Run the command again.');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
