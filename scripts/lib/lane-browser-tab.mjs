/**
 * Run-owned tabs in a lane browser daemon over the Chrome DevTools protocol,
 * and the two signed-in sessions a scripted case acts through.
 *
 * A tab is opened by the caller, used, and closed by it; nothing here touches
 * a tab it did not open. A function evaluated in a tab runs there with the
 * page's own session and returns only what it returns: the caller never reads
 * cookies or the page's credentials.
 *
 * - Slack: Web API calls made inside the Slack client's tab with the page's
 *   own session, as the signed-in test user (the runner matrix's harness does
 *   the same). The session credential stays in the page.
 * - Admin: same-origin calls to the lane's Admin API from a tab on that
 *   origin, with the Owner's standing Chickpea session.
 */

const CALL_TIMEOUT_MS = 30_000;

/** Opens a tab on `url` in the browser debugging on `port`. */
export async function openTab(port, url, { fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const target = await (await fetchImpl(`${base}/json/new?${encodeURI(url)}`, { method: 'PUT', signal: AbortSignal.timeout(10_000) })).json();
  const socket = new WebSocketImpl(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error(`Could not open the DevTools socket of a tab on port ${port}.`));
  });
  let sequence = 0;
  const pending = new Map();
  const failAll = (reason) => {
    for (const { reject } of pending.values()) reject(new Error(reason));
    pending.clear();
  };
  socket.onmessage = (message) => {
    const data = JSON.parse(String(message.data));
    if (data.id && pending.has(data.id)) {
      pending.get(data.id).resolve(data);
      pending.delete(data.id);
    }
  };
  socket.onclose = () => failAll('The tab\'s DevTools socket closed.');
  socket.onerror = () => failAll('The tab\'s DevTools socket failed.');
  const send = (method, params = {}, timeoutMs = CALL_TIMEOUT_MS) => new Promise((resolve, reject) => {
    sequence += 1;
    const id = sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} took over ${timeoutMs} ms.`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (data) => {
        clearTimeout(timer);
        if (data.error) reject(new Error(`${method}: ${data.error.message}`));
        else resolve(data.result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });

  /** Runs `fn(...args)` in the page and returns its JSON-serialisable result; a throw in the page rejects with its message. */
  const evaluate = async (fn, args = [], { timeoutMs = CALL_TIMEOUT_MS } = {}) => {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] ?? result.exceptionDetails.text ?? 'The page threw.');
    }
    return result.result?.value;
  };

  /** Evaluates `fn` until it returns a truthy value, or throws after `timeoutMs`. */
  const waitFor = async (fn, args = [], { timeoutMs = 30_000, intervalMs = 500, what = 'the page' } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      try {
        last = await evaluate(fn, args);
        if (last) return last;
      } catch (error) {
        last = error.message;
      }
      if (Date.now() > deadline) throw new Error(`Waited ${timeoutMs} ms for ${what}; last: ${JSON.stringify(last)?.slice(0, 200)}.`);
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  };

  return {
    evaluate,
    waitFor,
    async close() {
      socket.onclose = null;
      failAll('The tab was closed.');
      socket.close();
      await fetchImpl(`${base}/json/close/${target.id}`, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
    },
  };
}

/** In the page: one Slack Web API call with the client's session for `teamId`. */
async function pageSlackCall(teamId, method, params) {
  const config = JSON.parse(localStorage.getItem('localConfig_v2') || '{}');
  const team = config.teams ? config.teams[teamId] : null;
  if (!team || typeof team.token !== 'string') throw new Error('This tab is not signed in to the lane workspace.');
  const body = new FormData();
  body.append('token', team.token);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) body.append(key, String(value));
  for (let retries = 0; ; retries += 1) {
    // Same-origin API path: the workspace host refuses the client's cross-origin fetch from app.slack.com.
    const response = await fetch(`${location.origin}/api/${method}`, { method: 'POST', body, credentials: 'include' });
    if (response.status === 429 && retries < 5) {
      await new Promise((resolve) => setTimeout(resolve, (Number(response.headers.get('retry-after')) || 1) * 1000));
      continue;
    }
    const json = await response.json();
    if (json && json.error === 'ratelimited' && retries < 5) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    return json;
  }
}

function pageSlackReady(teamId) {
  const config = JSON.parse(localStorage.getItem('localConfig_v2') || '{}');
  return Boolean(config.teams && config.teams[teamId] && typeof config.teams[teamId].token === 'string');
}

/** In the page: one same-origin Admin API call; a `null` body sends none. */
async function pageAdminCall(method, path, body, headers) {
  const response = await fetch(path, {
    method, cache: 'no-store', redirect: 'manual', credentials: 'same-origin',
    headers: { ...(body === null ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === null ? undefined : JSON.stringify(body),
  });
  let text = '';
  try {
    text = await response.text();
  } catch {
    // An opaque redirect has no body.
  }
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON: kept as text.
  }
  return { status: response.status, body: parsed };
}

/** A tab on the workspace's Slack client; `call(method, params)` returns the Web API's JSON answer. */
export async function slackSession({ port, teamId }) {
  const tab = await openTab(port, `https://app.slack.com/client/${teamId}`);
  try {
    await tab.waitFor(pageSlackReady, [teamId], { timeoutMs: 60_000, what: `the Slack client of ${teamId}` });
  } catch (error) {
    await tab.close();
    throw error;
  }
  return {
    call: (method, params = {}) => tab.evaluate(pageSlackCall, [teamId, method, params], { timeoutMs: 60_000 }),
    close: () => tab.close(),
  };
}

/** A tab on the lane's Admin origin, already signed in; `call` answers `{ status, body }`. */
export async function adminSession({ port, origin }) {
  const tab = await openTab(port, `${origin}/admin`);
  try {
    await tab.waitFor((expected) => document.readyState === 'complete' && location.origin === expected, [origin], { timeoutMs: 60_000, what: 'the Admin page' });
  } catch (error) {
    await tab.close();
    throw error;
  }
  return {
    call: (method, apiPath, body, { headers = {} } = {}) => tab.evaluate(pageAdminCall, [method, apiPath, body ?? null, headers], { timeoutMs: 60_000 }),
    close: () => tab.close(),
  };
}
