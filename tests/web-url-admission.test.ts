import assert from 'node:assert/strict';
import test from 'node:test';

import * as v from 'valibot';

import { admitWebUrl, requestTokens, type WebUrlSources } from '../src/web/page.ts';
import { createWebTools, readWebPageInTurn, webRequest } from '../src/web/tools.ts';
import { createWebTurn } from '../src/web/turn.ts';

const REQUEST = 'Our incident codename is Bluebird42, and the vendor is Statusboard';

function sources(overrides: Partial<WebUrlSources> = {}): WebUrlSources {
  return { typed: [], sourced: [], hosts: [], requestTokens: requestTokens(REQUEST), ...overrides };
}

test('a URL the model writes for an arbitrary public host is refused before anything is fetched', async () => {
  for (const url of ['https://evil.example/collect/q3-revenue-4523000', 'https://docs.vendor.example/api/rate-limits']) {
    assert.deepEqual(admitWebUrl(url, sources()), { admitted: false, reason: 'host' }, url);
  }
  const fetched: string[] = [];
  const turn = createWebTurn('turn_host', { turnKey: 'turn_host', reads: 0, searches: 0, sourced: [] });
  const result = await readWebPageInTurn({
    turn,
    request: webRequest(REQUEST),
    connectionHosts: [],
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
  const typed = sources({ typed: [new URL('https://docs.statusboard.example/api')], hosts: ['docs.statusboard.example'] });
  const admitted = admitWebUrl('https://docs.statusboard.example/api/authentication', typed);
  assert.equal(admitted.admitted && admitted.url.href, 'https://docs.statusboard.example/api/authentication',
    'the typed host\'s own name in the request does not refuse it');
  for (const url of [
    'https://docs.statusboard.example/leak/bluebird42',
    'https://docs.statusboard.example/leak/BLUEBIRD42',
    'https://docs.statusboard.example/leak/%42luebird42',
    'https://docs.statusboard.example/leak/%2542luebird42',
    'https://docs.statusboard.example/leak/blue-bird-42',
  ]) {
    assert.deepEqual(admitWebUrl(url, typed), { admitted: false, reason: 'request_text' }, url);
  }
  assert.deepEqual(admitWebUrl('https://docs.statusboard.example/api?page=2', typed), { admitted: false, reason: 'query' });
  assert.deepEqual(admitWebUrl(`https://docs.statusboard.example/${'a'.repeat(200)}`, typed), { admitted: false, reason: 'long_path' });
  assert.deepEqual(admitWebUrl('http://docs.statusboard.example:8080/api', typed), { admitted: false, reason: 'not_public' });
});

test('the tool lets the model write URLs for the hosts the requester typed', async () => {
  const read: string[] = [];
  const result = await readWebPageInTurn({
    turn: createWebTurn('turn_typed', { turnKey: 'turn_typed', reads: 0, searches: 0, sourced: [] }),
    request: webRequest('connect Statusboard, docs at <https://docs.statusboard.example/api>'),
    connectionHosts: [],
    readPage: async (url) => {
      read.push(url.href);
      return { outcome: 'unreadable', url: url.href, reason: 'unreachable', message: '' };
    },
  }, 'https://docs.statusboard.example/api/authentication');
  assert.equal(result.outcome, 'unreadable');
  assert.deepEqual(read, ['https://docs.statusboard.example/api/authentication']);
});

test('a URL the model writes on one of the Agent\'s connection hosts is read', () => {
  const connected = sources({ hosts: ['API.Statusboard.example'] });
  const admitted = admitWebUrl('https://api.statusboard.example/v2/openapi.json', connected);
  assert.equal(admitted.admitted && admitted.url.hostname, 'api.statusboard.example');
  assert.deepEqual(admitWebUrl('https://other.statusboard.example/v2', connected), { admitted: false, reason: 'host' },
    'a sibling of a connection host is another host');
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
    connectionHosts: [],
  });
  const input = readTool!.input as v.GenericSchema;
  assert.equal(v.safeParse(input, { url: 'https://evil.example/x' }).success, true);
  for (const forged of [
    { url: 'https://evil.example/x', hosts: ['evil.example'] },
    { url: 'https://evil.example/x', connectionHosts: ['evil.example'] },
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
