/**
 * Read-only page probes through a running lane browser daemon. A probe opens
 * one tab of its own over the Chrome DevTools protocol, waits for the page,
 * reads its address, title and text, and closes the tab. It never clicks,
 * types, or reads cookies, so it cannot change product state or leak a session.
 */

const PROBE_TIMEOUT_MS = 30_000;

/**
 * @returns {Promise<{ url: string, title: string, text: string, settled: boolean }>}
 */
export async function probePage({
  port, url, settledWhen = () => true, timeoutMs = PROBE_TIMEOUT_MS,
  fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const base = `http://127.0.0.1:${port}`;
  const target = await (await fetchImpl(`${base}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5_000) })).json();
  const socket = new WebSocketImpl(target.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error('Could not open the DevTools socket.'));
    });
    let sequence = 0;
    const pending = new Map();
    socket.onmessage = (message) => {
      const data = JSON.parse(String(message.data));
      if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); }
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      sequence += 1;
      pending.set(sequence, resolve);
      socket.send(JSON.stringify({ id: sequence, method, params }));
    });
    await send('Page.navigate', { url });
    const read = async () => {
      const reply = await send('Runtime.evaluate', {
        expression: 'JSON.stringify({ state: document.readyState, url: location.href, title: document.title, text: document.body ? document.body.innerText.slice(0, 20000) : "" })',
        returnByValue: true,
      });
      try { return JSON.parse(reply.result?.result?.value ?? '{}'); } catch { return {}; }
    };
    const deadline = Date.now() + timeoutMs;
    let page = {};
    while (Date.now() < deadline) {
      page = await read();
      if (page.state === 'complete' && page.url && page.url !== 'about:blank' && settledWhen(page)) {
        return { url: page.url, title: page.title ?? '', text: page.text ?? '', settled: true };
      }
      await sleep(1_000);
    }
    return { url: page.url ?? '', title: page.title ?? '', text: page.text ?? '', settled: false };
  } finally {
    try { socket.close(); } catch { /* already closed */ }
    await fetchImpl(`${base}/json/close/${target.id}`, { signal: AbortSignal.timeout(5_000) }).catch(() => {});
  }
}

/** The Admin shell shows its navigation only to a signed-in member. */
export function adminSession(page) {
  if (/\bNew Agent\b/u.test(page.text) && /\bSettings\b/u.test(page.text)) return 'signed_in';
  if (/sign in|log in/iu.test(page.text) || /\/(?:login|signin|sign-in)\b/iu.test(page.url)) return 'signed_out';
  return 'unknown';
}

/** Slack keeps a signed-in browser on the workspace client; otherwise it redirects to sign in. */
export function slackSession(page, workspaceId) {
  const client = page.url.match(/^https:\/\/app\.slack\.com\/client\/([A-Z0-9]+)/u);
  if (client) return client[1] === workspaceId ? 'signed_in' : 'other_workspace';
  if (/signin|sign_in|get-started/iu.test(page.url) || /sign in to/iu.test(page.text)) return 'signed_out';
  return 'unknown';
}

export const adminSettled = (page) => adminSession(page) !== 'unknown';
export const slackSettled = (workspaceId) => (page) => slackSession(page, workspaceId) !== 'unknown';
