import assert from 'node:assert/strict';
import { test } from 'node:test';

// @ts-expect-error Executable helpers are JavaScript, shared with the smoke runner.
import { openTab } from '../scripts/lib/lane-browser-tab.mjs';

/**
 * The tab Chrome opens for `/json/new?<query>`: the query up to its first
 * `&`, decoded once (Chrome 157, measured 2026-11-12).
 */
function chromeNewTabUrl(request: string): string {
  const query = request.slice(request.indexOf('?') + 1);
  return decodeURIComponent(query.split('&')[0]!);
}

/** A DevTools socket that opens at once and answers nothing. */
class OpenSocket {
  onopen?: () => void;
  constructor() {
    setTimeout(() => this.onopen?.(), 0);
  }
  send() {}
  close() {}
}

test('openTab opens the whole URL: every query parameter, encoded values and the fragment', async () => {
  const url = 'https://lane.example.workers.dev/api/auth/oauth2/authorize?response_type=code&client_id=chickpea-cli' +
    '&redirect_uri=http%3A%2F%2F127.0.0.1%3A53682%2Fcallback&scope=openid+profile&state=s%2F1#done';
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const fetchImpl = async (request: string, init: { method?: string } = {}) => {
    requests.push({ url: request, method: init.method });
    return new Response(JSON.stringify({ id: 'T1', webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/T1' }));
  };

  const tab = await openTab(9, url, { fetchImpl, WebSocketImpl: OpenSocket });
  await tab.close();

  assert.equal(requests[0]?.method, 'PUT');
  assert.equal(chromeNewTabUrl(requests[0]!.url), url);
  assert.equal(requests[1]?.url, 'http://127.0.0.1:9/json/close/T1');
});
