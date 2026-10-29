import assert from 'node:assert/strict';
import { test } from 'node:test';

import { McpOAuthError } from '../src/config/mcp-oauth.ts';
import {
  checkConnection,
  type ApiCheckTarget,
  type ApiConnectionScope,
} from '../src/connections/connection-check.ts';
import { withConnectionNetwork } from './helpers/connection-network.ts';

const KEY = 'pat-na1-0123456789abcdef0123';

const KB: ApiConnectionScope = {
  allowedHosts: ['api.hubapi.com'],
  pathPrefixes: ['/cms/knowledge-base/2027-03-beta/'],
  headerName: 'Authorization',
  headerValuePrefix: 'Bearer ',
  allowedMethods: ['GET', 'HEAD', 'POST', 'PATCH'],
};

function check(overrides: Partial<ApiCheckTarget> = {}, timeoutMs?: number) {
  return checkConnection(
    { kind: 'api', connection: KB, credential: KEY, ...overrides },
    { cloudflare: true, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  );
}

const echoKey = (status: number) => () =>
  Response.json({ message: `key Bearer ${KEY} is not valid here`, category: 'EXAMPLE' }, { status });

test('a 2xx is ok: one GET to the first host and prefix, carrying the key', async () => {
  await withConnectionNetwork(() => Response.json({ results: [{ title: 'Private article' }] }), async (requests) => {
    const outcome = await check();
    assert.deepEqual(outcome, { kind: 'ok', url: 'https://api.hubapi.com/cms/knowledge-base/2027-03-beta', status: 200 });
    assert.deepEqual(requests.map(({ url, method }) => [url, method]), [
      ['https://api.hubapi.com/cms/knowledge-base/2027-03-beta', 'GET'],
    ]);
    assert.equal(requests[0]!.headers.get('authorization'), `Bearer ${KEY}`);
  });
});

test('each status maps to its outcome, with a redacted excerpt of the answer', async () => {
  const cases = [
    [401, 'key_rejected'],
    [403, 'not_permitted'],
    [404, 'path_not_found'],
    [500, 'unreachable'],
    [503, 'unreachable'],
    [400, 'inconclusive'],
    [429, 'inconclusive'],
  ] as const;
  for (const [status, kind] of cases) {
    await withConnectionNetwork(echoKey(status), async () => {
      const outcome = await check();
      assert.equal(outcome.kind, kind, `HTTP ${status}`);
      assert.equal(outcome.status, status);
      assert.match(outcome.detail, /is not valid here/);
      assert.doesNotMatch(JSON.stringify(outcome), new RegExp(KEY), `HTTP ${status} never returns the key`);
    });
  }
});

test('an answer with no readable body gets a fixed detail', async () => {
  await withConnectionNetwork(() => new Response('<html>denied</html>', {
    status: 403, headers: { 'content-type': 'text/html' },
  }), async () => {
    assert.deepEqual(await check(), {
      kind: 'not_permitted',
      url: 'https://api.hubapi.com/cms/knowledge-base/2027-03-beta',
      status: 403,
      detail: 'The service accepted the key but did not permit this request.',
    });
  });
});

test('a key cut by the excerpt window is still redacted', async () => {
  const body = ' '.repeat(8 * 1024 - 10) + KEY;
  await withConnectionNetwork(() => new Response(body, { status: 401, headers: { 'content-type': 'text/plain' } }), async () => {
    const outcome = await check();
    assert.equal(outcome.kind, 'key_rejected');
    assert.doesNotMatch(JSON.stringify(outcome), new RegExp(KEY.slice(0, 8)));
  });
});

test('a key too short to redact never reaches the detail', async () => {
  const short = 'abc123';
  await withConnectionNetwork(
    () => Response.json({ message: `token ${short} is not valid` }, { status: 401 }),
    async () => {
      const outcome = await check({ credential: short });
      assert.equal(outcome.kind, 'key_rejected');
      assert.doesNotMatch(JSON.stringify(outcome), /abc123/);
    },
  );
});

test('a timeout and a network failure are unreachable', async () => {
  await withConnectionNetwork((_request, signal) => new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  }), async () => {
    const outcome = await check({}, 50);
    assert.equal(outcome.kind, 'unreachable');
    assert.equal(outcome.status, undefined);
  });
  await withConnectionNetwork(() => {
    throw new Error(`socket closed while sending Bearer ${KEY}`);
  }, async () => {
    const outcome = await check();
    assert.deepEqual(outcome, {
      kind: 'unreachable',
      url: 'https://api.hubapi.com/cms/knowledge-base/2027-03-beta',
      detail: 'The request did not complete (network error or timeout).',
    });
  });
});

test('a redirect is followed inside the scope and stopped outside it', async () => {
  await withConnectionNetwork((request) => {
    if (request.url.endsWith('/moved')) {
      return new Response(null, { status: 302, headers: { location: 'https://api.hubapi.com/cms/knowledge-base/2027-03-beta/articles' } });
    }
    if (request.url.endsWith('/offsite')) {
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/collect' } });
    }
    return Response.json({});
  }, async (requests) => {
    assert.equal((await check({ path: '/cms/knowledge-base/2027-03-beta/moved' })).kind, 'ok');
    const offsite = await check({ path: '/cms/knowledge-base/2027-03-beta/offsite' });
    assert.equal(offsite.kind, 'inconclusive');
    assert.ok(requests.every(({ url }) => !url.startsWith('https://evil.example')), 'nothing reaches the offsite host');
  });
});

test('a path outside the connection, or a changed connection, sends nothing', async () => {
  await withConnectionNetwork(() => Response.json({}), async (requests) => {
    assert.equal((await check({ path: '/crm/v3/objects/contacts' })).kind, 'inconclusive');
    assert.equal((await check({ path: '@evil.example/' })).kind, 'inconclusive');
    assert.equal((await check({ authorize: async () => false })).kind, 'inconclusive');
    assert.equal((await check({ connection: { ...KB, allowedHosts: [] } })).kind, 'inconclusive');
    assert.deepEqual(requests, []);
  });
});

test('a check never writes: a write-only connection sends nothing, and a write-capable one sends only GET', async () => {
  await withConnectionNetwork(() => Response.json({}), async (requests) => {
    const writeOnly = await check({ connection: { ...KB, allowedMethods: ['POST', 'PATCH'] } });
    assert.equal(writeOnly.kind, 'inconclusive');
    assert.equal(requests.length, 0);
    await check({ connection: { ...KB, allowedMethods: ['DELETE', 'PUT', 'POST', 'GET'] } });
    assert.deepEqual(requests.map(({ method }) => method), ['GET']);
  });
});

test('an MCP check lists tools, and a failure maps to an outcome without the server\'s text', async () => {
  const server = { id: 'wiki', url: 'https://wiki.example.com/mcp', transport: 'streamable-http' as const, headers: {} };
  const discovered = await checkConnection({ kind: 'mcp', server }, {
    discoverMcp: async () => ({ tools: [{ name: 'search_pages' }] }),
  });
  assert.deepEqual(discovered, { kind: 'ok', tools: [{ name: 'search_pages' }] });

  const failing = (error: unknown) => checkConnection({ kind: 'mcp', server }, {
    discoverMcp: async () => { throw error; },
  });
  assert.deepEqual(await failing(Object.assign(new Error(`HTTP 401 for Bearer ${KEY}`), { code: 401 })), {
    kind: 'key_rejected',
    status: 401,
    detail: 'The MCP server rejected the connection. Check the token or headers.',
  });
  assert.deepEqual(await failing(Object.assign(new Error('Forbidden'), { code: 403 })), {
    kind: 'not_permitted',
    status: 403,
    detail: 'The MCP server rejected the connection. Check the token or headers.',
  });
  assert.equal((await failing(new Error('Request timed out'))).kind, 'unreachable');
  assert.equal((await failing(Object.assign(new Error('Bad gateway'), { code: 502 }))).kind, 'unreachable');
  assert.equal((await failing(new Error('something odd'))).kind, 'inconclusive');
  assert.deepEqual(await failing(new McpOAuthError('reauthorization_required', 'sign in again')), {
    kind: 'key_rejected',
    detail: 'This connection needs OAuth authorization.',
  });
});
