import assert from 'node:assert/strict';
import test from 'node:test';

import * as v from 'valibot';

import { admitWebUrl, requestTokens, type WebUrlSources } from '../src/web/page.ts';
import { connectionPathSpaces, createWebTools, readWebPageInTurn, webRequest, type WebToolsInput } from '../src/web/tools.ts';
import { createWebTurn } from '../src/web/turn.ts';

const REQUEST = 'Our incident codename is Bluebird42, and the vendor is Statusboard';

function sources(overrides: Partial<WebUrlSources> = {}): WebUrlSources {
  return { typed: [], sourced: [], spaces: [], requestTokens: requestTokens(REQUEST), ...overrides };
}

/** A tool input over `spaces` that records every URL it would fetch. */
function recordingReader(request: string, connectionSpaces: WebToolsInput['connectionSpaces']) {
  const fetched: string[] = [];
  const input: WebToolsInput = {
    turn: createWebTurn('turn_spaces', { turnKey: 'turn_spaces', reads: 0, searches: 0, sourced: [] }),
    request: webRequest(request),
    connectionSpaces,
    readPage: async (url) => {
      fetched.push(url.href);
      return { outcome: 'unreadable', url: url.href, reason: 'unreachable', message: '' };
    },
  };
  return { fetched, read: (url: string) => readWebPageInTurn(input, url) };
}

/** Two connections on hosts many tenants share: an API scoped to `/v2`, and an MCP server at its tenant's path. */
const SHARED_HOST_CONNECTIONS = connectionPathSpaces({
  apiConnections: [{ allowedHosts: ['API.Shared.example'], pathPrefixes: ['/v2'] }],
  mcpConnections: [{ url: 'https://mcp.proxy.example/tenants/acme/mcp' }],
});

test('a URL the model writes for an arbitrary public host is refused before anything is fetched', async () => {
  for (const url of ['https://evil.example/collect/q3-revenue-4523000', 'https://docs.vendor.example/api/rate-limits']) {
    assert.deepEqual(admitWebUrl(url, sources()), { admitted: false, reason: 'host' }, url);
  }
  const fetched: string[] = [];
  const turn = createWebTurn('turn_host', { turnKey: 'turn_host', reads: 0, searches: 0, sourced: [] });
  const result = await readWebPageInTurn({
    turn,
    request: webRequest(REQUEST),
    connectionSpaces: [],
    readPage: async (url) => {
      fetched.push(url.href);
      throw new Error('nothing may be fetched');
    },
  }, 'https://evil.example/collect/q3-revenue-4523000');
  assert.equal(result.outcome, 'refused');
  assert.match(result.outcome === 'refused' ? result.message : '', /search for the page.*or ask the requester for the link/);
  assert.deepEqual(fetched, []);
  assert.equal(turn.takeRead(), true, 'a refused read takes none of the turn\'s reads');
});

test('a URL the model writes on a host the requester typed is read; its path may not carry the request', () => {
  const typed = sources({
    typed: [new URL('https://docs.statusboard.example/api')],
    spaces: [{ host: 'docs.statusboard.example', pathPrefixes: ['/'] }],
  });
  const admitted = admitWebUrl('https://docs.statusboard.example/api/authentication', typed);
  assert.equal(admitted.admitted && admitted.url.href, 'https://docs.statusboard.example/api/authentication',
    'the typed host\'s own name in the request does not refuse it');
  for (const url of [
    'https://docs.statusboard.example/leak/bluebird42',
    'https://docs.statusboard.example/leak/BLUEBIRD42',
    'https://docs.statusboard.example/leak/%42luebird42',
    'https://docs.statusboard.example/leak/blue-bird-42',
  ]) {
    assert.deepEqual(admitWebUrl(url, typed), { admitted: false, reason: 'request_text' }, url);
  }
  assert.deepEqual(admitWebUrl('https://docs.statusboard.example/leak/%2542luebird42', typed),
    { admitted: false, reason: 'encoded_path' }, 'a double-encoded word is refused before it is decoded');
  assert.deepEqual(admitWebUrl('https://docs.statusboard.example/api?page=2', typed), { admitted: false, reason: 'query' });
  assert.deepEqual(admitWebUrl(`https://docs.statusboard.example/${'a'.repeat(200)}`, typed), { admitted: false, reason: 'long_path' });
  assert.deepEqual(admitWebUrl('http://docs.statusboard.example:8080/api', typed), { admitted: false, reason: 'not_public' });
});

test('the tool lets the model write URLs for the hosts the requester typed', async () => {
  const read: string[] = [];
  const result = await readWebPageInTurn({
    turn: createWebTurn('turn_typed', { turnKey: 'turn_typed', reads: 0, searches: 0, sourced: [] }),
    request: webRequest('connect Statusboard, docs at <https://docs.statusboard.example/api>'),
    connectionSpaces: [],
    readPage: async (url) => {
      read.push(url.href);
      return { outcome: 'unreadable', url: url.href, reason: 'unreachable', message: '' };
    },
  }, 'https://docs.statusboard.example/api/authentication');
  assert.equal(result.outcome, 'unreadable');
  assert.deepEqual(read, ['https://docs.statusboard.example/api/authentication']);
});

test('a URL the model writes on a connection\'s host outside its path scope is refused before anything is fetched', async () => {
  const reader = recordingReader('what does the proxy offer', SHARED_HOST_CONNECTIONS);
  for (const url of [
    'https://api.shared.example/v3/collect',
    'https://api.shared.example/v20/collect',
    'https://api.shared.example/v2x',
    'https://api.shared.example/v2/../v3/collect',
    'https://api.shared.example/v2/%2e%2e/v3/collect',
    'https://api.shared.example/',
    'https://mcp.proxy.example/tenants/other/mcp',
    'https://mcp.proxy.example/tenants/acme',
    'https://mcp.proxy.example/tenants/acme/mcpx',
  ]) {
    const result = await reader.read(url);
    assert.equal(result.outcome, 'refused', url);
    assert.match(result.outcome === 'refused' ? result.message : '', /within that connection's path scope/, url);
  }
  assert.deepEqual(reader.fetched, []);
});

test('a URL the model writes may not percent-encode path syntax, which a decoding proxy would resolve', async () => {
  const reader = recordingReader('what does the proxy offer', SHARED_HOST_CONNECTIONS);
  for (const url of [
    'https://api.shared.example/v2/..%2Fv3/collect',
    'https://api.shared.example/v2/%252e%252e/v3/collect',
    'https://api.shared.example/v2/..%5Cv3/collect',
    'https://api.shared.example/v2/%2E%2E%2fv3',
    'https://mcp.proxy.example/tenants/acme/mcp/..%2F..%2Fother/mcp',
  ]) {
    const result = await reader.read(url);
    assert.equal(result.outcome, 'refused', url);
    assert.match(result.outcome === 'refused' ? result.message : '', /may not percent-encode/, url);
  }
  assert.deepEqual(reader.fetched, []);
});

test('a URL the model writes inside a connection\'s path scope is read', async () => {
  const reader = recordingReader('what does the proxy offer', SHARED_HOST_CONNECTIONS);
  for (const url of ['https://api.shared.example/v2', 'https://api.shared.example/v2/openapi.json']) {
    assert.equal((await reader.read(url)).outcome, 'unreadable', url);
  }
  assert.deepEqual(reader.fetched, ['https://api.shared.example/v2', 'https://api.shared.example/v2/openapi.json']);
  assert.equal((await reader.read('https://other.shared.example/v2')).outcome, 'refused',
    'a sibling of a connection host is another host');

  const wholeHost = recordingReader('what does the API offer', connectionPathSpaces({
    apiConnections: [{ allowedHosts: ['api.statusboard.example'], pathPrefixes: [] }],
    mcpConnections: [],
  }));
  assert.equal((await wholeHost.read('https://api.statusboard.example/changelog')).outcome, 'unreadable',
    'an API connection with no path scope reaches its whole host');
});

test('an MCP connection\'s space is its server URL\'s path', async () => {
  const reader = recordingReader('what does the proxy offer', connectionPathSpaces({
    apiConnections: [],
    mcpConnections: [{ url: 'https://mcp.proxy.example/tenants/acme/mcp/?session=1' }],
  }));
  assert.equal((await reader.read('https://mcp.proxy.example/tenants/acme/mcp/tools')).outcome, 'unreadable');
  assert.equal((await reader.read('https://mcp.proxy.example/tenants/beta/mcp/tools')).outcome, 'refused');
  assert.deepEqual(reader.fetched, ['https://mcp.proxy.example/tenants/acme/mcp/tools']);
});

test('a URL the model writes on a host the requester typed may take any path, even on a connection\'s host', async () => {
  const reader = recordingReader('docs at <https://api.shared.example/v2>', SHARED_HOST_CONNECTIONS);
  assert.equal((await reader.read('https://api.shared.example/changelog')).outcome, 'unreadable');
  assert.equal((await reader.read('https://mcp.proxy.example/tenants/other/mcp')).outcome, 'refused',
    'only the typed host takes any path');
  assert.deepEqual(reader.fetched, ['https://api.shared.example/changelog']);
});

test('a search result or page link is read as given, on any public host, query string and all', () => {
  const result = 'https://community.vendor.example/t/statusboard-bluebird42?page=3&sort=new';
  const sourced = sources({ sourced: [result] });
  const admitted = admitWebUrl(`${result}#reply-4`, sourced);
  assert.equal(admitted.admitted && admitted.url.href, result, 'not the model\'s text, so neither host nor words refuse it');
  assert.deepEqual(admitWebUrl('https://community.vendor.example/t/other', sourced), { admitted: false, reason: 'host' },
    'a source vouches for its own URL, not its host');
  assert.deepEqual(admitWebUrl(result.replace('page=3', 'page=4'), sourced), { admitted: false, reason: 'query' });

  const typedWithQuery = sources({ typed: [new URL('https://docs.vendor.example/search?q=statusboard')] });
  assert.equal(admitWebUrl('https://docs.vendor.example/search?q=statusboard', typedWithQuery).admitted, true);
});

test('hosts named in the tool call are not hosts the model may write for', async () => {
  const [readTool] = createWebTools({
    turn: createWebTurn('turn_forged', { turnKey: 'turn_forged', reads: 0, searches: 0, sourced: [] }),
    request: webRequest(REQUEST),
    connectionSpaces: [],
  });
  const input = readTool!.input as v.GenericSchema;
  assert.equal(v.safeParse(input, { url: 'https://evil.example/x' }).success, true);
  for (const forged of [
    { url: 'https://evil.example/x', hosts: ['evil.example'] },
    { url: 'https://evil.example/x', spaces: [{ host: 'evil.example', pathPrefixes: ['/'] }] },
    { url: 'https://evil.example/x', connectionSpaces: [{ host: 'evil.example', pathPrefixes: ['/'] }] },
    { url: 'https://evil.example/x', sourced: ['https://evil.example/x'] },
  ]) {
    assert.equal(v.safeParse(input, forged).success, false, JSON.stringify(forged));
  }
  const output = JSON.parse(String(await readTool!.run({ data: { url: 'https://evil.example/x' } } as never)));
  assert.equal(output.outcome, 'refused');
});

test('the request\'s long words count whole, through punctuation and case', () => {
  const tokens = requestTokens('Use key ab12-cd34-ef56 for <https://docs.statusboard.example/api|the docs>, then Incidents.');
  for (const expected of ['ab12cd34ef56', 'statusboard', 'incidents']) assert.ok(tokens.includes(expected), expected);
  assert.ok(!tokens.includes('docs'), 'short words are not tokens');
  assert.deepEqual(requestTokens(undefined), []);
});
