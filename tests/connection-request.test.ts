import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FlueEventContext, FlueObservation } from '@flue/runtime';
import * as v from 'valibot';

import { runtimePlanAllowsConnectionRequests } from '../src/agents/slack-thread.ts';
import type { RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { CHICKPEA_SLACK_AGENT_NAME } from '../src/agents/names.ts';
import { toolActivityStatus } from '../src/activity/status.ts';
import { connectorSkillsForConnections } from '../src/config/connector-skills.ts';
import type { ResolvedApiConnection } from '../src/config/egress.ts';
import { buildConnectionAccess, type ConnectionAccess } from '../src/connections/access.ts';
import {
  CONNECTION_REQUEST_TOOL_NAME,
  createConnectionRequestTool,
  MAX_CONNECTION_REQUEST_BODY_BYTES,
  MAX_CONNECTION_RESPONSE_CHARS,
  type ConnectionRequestLogEvent,
} from '../src/connections/request-tool.ts';
import {
  memoryToolPolicyInterceptor,
  observeMemoryToolPolicy,
  serializeCurrentRequestEnvelope,
} from '../src/memory/tool-policy.ts';

const TOKEN = 'asana-secret-token-0123456789';
const OTHER_TOKEN = 'second-asana-token-9876543210';

function asana(overrides: Partial<ResolvedApiConnection> = {}): ResolvedApiConnection {
  return {
    allowedHosts: ['app.asana.com'],
    pathPrefixes: ['/api/1.0'],
    headerName: 'Authorization',
    headerValue: `Bearer ${TOKEN}`,
    allowedMethods: ['GET', 'POST', 'PUT'],
    ...overrides,
  };
}

const GAMMA: ResolvedApiConnection = {
  allowedHosts: ['public-api.gamma.app'],
  pathPrefixes: ['/v1.0'],
  headerName: 'X-API-KEY',
  headerValue: 'sk-gamma-secret-value',
  allowedMethods: ['GET', 'POST'],
};

type Entry = { id: string; displayName: string; connectors: ResolvedApiConnection[] };

function access(entries: Entry[]): ConnectionAccess {
  return buildConnectionAccess(
    entries.map(({ id, displayName, connectors }) => ({
      policy: { id, displayName, headerName: connectors[0]!.headerName },
      connectors,
    })),
    { cloudflare: true, timeoutMs: 60_000 },
  );
}

const ASANA_ENTRY: Entry = { id: 'conn_asana', displayName: 'Asana', connectors: [asana()] };

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

/** Stub the platform fetch: DoH answers a public address, every other request is captured. */
async function withStubbedNetwork<T>(
  respond: (request: CapturedRequest) => Response,
  run: (requests: CapturedRequest[]) => Promise<T>,
): Promise<T> {
  const previous = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
      const type = new URL(url).searchParams.get('type');
      return Response.json({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] });
    }
    const body = init?.body === undefined || init.body === null
      ? undefined
      : new TextDecoder().decode(new Uint8Array(await new Response(init.body).arrayBuffer()));
    const request = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body };
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = previous;
  }
}

function requestTool(
  entries: Entry[] | (() => Promise<ConnectionAccess>),
  logs: ConnectionRequestLogEvent[] = [],
) {
  const tool = createConnectionRequestTool({
    agentId: 'agent_support',
    resolveAccess: typeof entries === 'function' ? entries : async () => access(entries),
    log: (event) => logs.push(event),
  });
  return async (data: Record<string, unknown>): Promise<any> => {
    const parsed = v.parse(tool.input as v.GenericSchema, data);
    const result = await (tool.run as (context: unknown) => Promise<{ output: unknown }>)({
      data: parsed,
      toolCallId: 'call_1',
      log: { info() {}, warn() {}, error() {} },
    });
    return JSON.parse(JSON.stringify(result.output));
  };
}

/** Run inside a managed submission whose model input has (or lacks) the current-request envelope. */
async function inSubmission<T>(withEnvelope: boolean, run: () => Promise<T>): Promise<T> {
  const context = { agentName: CHICKPEA_SLACK_AGENT_NAME, submissionId: 'connection-request' };
  return memoryToolPolicyInterceptor(
    { type: 'agent', operationId: 'connection-request', operationKind: 'prompt' },
    context as never,
    async () => {
      observeMemoryToolPolicy({
        type: 'turn_request', purpose: 'agent', request: {
          input: {
            messages: [{
              role: 'user',
              content: withEnvelope ? serializeCurrentRequestEnvelope('File it in Asana', false) : 'File it in Asana',
            }],
          },
        },
      } as unknown as FlueObservation, context as unknown as FlueEventContext);
      return run();
    },
  );
}

test('a GET through the connection injects its credential and returns parsed JSON', async () => {
  const logs: ConnectionRequestLogEvent[] = [];
  const run = requestTool([ASANA_ENTRY], logs);
  await withStubbedNetwork(
    () => Response.json(
      { data: { gid: '1', name: 'Me', echoed: `Bearer ${TOKEN}` } },
      { headers: { 'x-ratelimit-remaining': '99', 'set-cookie': 'session=abc', server: 'asana' } },
    ),
    async (requests) => {
      const output = await run({
        url: 'https://app.asana.com/api/1.0/users/me',
        query: { opt_fields: 'name,email', tag: ['a', 'b'] },
      });
      assert.equal(requests.length, 1);
      const [request] = requests;
      assert.equal(request!.url, 'https://app.asana.com/api/1.0/users/me?opt_fields=name%2Cemail&tag=a&tag=b');
      assert.equal(request!.method, 'GET');
      assert.equal(request!.headers.get('authorization'), `Bearer ${TOKEN}`);
      assert.equal(request!.headers.get('accept'), 'application/json');
      assert.equal(output.ok, true);
      assert.equal(output.status, 200);
      assert.equal(output.connection, 'conn_asana');
      assert.equal(output.displayName, 'Asana');
      assert.equal(output.response.data.name, 'Me');
      assert.deepEqual(Object.keys(output.headers).sort(), ['content-type', 'x-ratelimit-remaining']);
      assert.doesNotMatch(JSON.stringify(output), new RegExp(TOKEN));
      assert.equal(logs.length, 1);
      assert.deepEqual(
        { ...logs[0], durationMs: 0 },
        {
          agentId: 'agent_support', connectionId: 'conn_asana', method: 'GET', host: 'app.asana.com',
          pathname: '/api/1.0/users/me', status: 200, durationMs: 0, responseBytes: logs[0]!.responseBytes, truncated: false,
        },
      );
      assert.doesNotMatch(JSON.stringify(logs), /opt_fields|secret/);
    },
  );
});

test('a JSON write sends its body with the content type and requires the current-request envelope', async () => {
  const run = requestTool([ASANA_ENTRY]);
  await withStubbedNetwork(() => Response.json({ data: { gid: '9' } }, { status: 201 }), async (requests) => {
    const created = await inSubmission(true, () => run({
      method: 'POST',
      url: 'https://app.asana.com/api/1.0/tasks',
      json: { data: { name: 'Bug', projects: ['123'] } },
    }));
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(created.status, 201);
    assert.equal(requests[0]!.headers.get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(requests[0]!.body!), { data: { name: 'Bug', projects: ['123'] } });

    const refused = await inSubmission(false, () => run({
      method: 'PUT', url: 'https://app.asana.com/api/1.0/tasks/9', json: { data: { completed: true } },
    }));
    assert.equal(refused.reason, 'write_not_allowed');
    assert.equal(refused.sent, false);
    const read = await inSubmission(false, () => run({ url: 'https://app.asana.com/api/1.0/tasks/9' }));
    assert.equal(read.ok, true, 'reads need no envelope');
    assert.equal(requests.length, 2);
  });
});

test('URLs, methods, headers, and bodies the connection does not allow are refused before any request', async () => {
  const run = requestTool([ASANA_ENTRY]);
  await withStubbedNetwork(() => Response.json({}), async (requests) => {
    const cases: [Record<string, unknown>, string][] = [
      [{ url: 'https://evil.example/api/1.0/users/me' }, 'url_not_allowed'],
      [{ url: 'https://app.asana.com/api/10/users/me' }, 'url_not_allowed'],
      [{ url: 'https://app.asana.com/api/1.0x/users/me' }, 'url_not_allowed'],
      [{ url: 'http://app.asana.com/api/1.0/users/me' }, 'url_not_allowed'],
      [{ url: 'https://user:pw@app.asana.com/api/1.0/users/me' }, 'url_not_allowed'],
      [{ url: '/api/1.0/users/me' }, 'url_not_allowed'],
      [{ url: 'https://app.asana.com/api/1.0/tasks/1', method: 'DELETE' }, 'method_not_allowed'],
      [{ url: 'https://app.asana.com/api/1.0/users/me', headers: { Authorization: 'Bearer mine' } }, 'headers_not_allowed'],
      [{ url: 'https://app.asana.com/api/1.0/users/me', headers: { cookie: 'a=b' } }, 'headers_not_allowed'],
      [{ url: 'https://app.asana.com/api/1.0/users/me', body: 'x' }, 'body_not_allowed'],
      [{ url: 'https://app.asana.com/api/1.0/tasks', method: 'POST', body: 'x'.repeat(MAX_CONNECTION_REQUEST_BODY_BYTES + 1) }, 'body_too_large'],
      [{ url: 'https://app.asana.com/api/1.0/users/me', connection: 'conn_missing' }, 'no_connection'],
    ];
    for (const [input, reason] of cases) {
      const output = await run(input);
      assert.equal(output.reason, reason, JSON.stringify(input));
      assert.equal(output.sent, false);
    }
    assert.equal(requests.length, 0);
    assert.throws(() => v.parse(
      createConnectionRequestTool({ agentId: 'a', resolveAccess: async () => access([]) }).input as v.GenericSchema,
      { url: 'https://app.asana.com/api/1.0/tasks', json: {}, body: 'x' },
    ));
  });
});

test('a custom header shape injects its own header and refuses the same header from the request', async () => {
  const run = requestTool([{ id: 'conn_gamma', displayName: 'Gamma', connectors: [GAMMA] }]);
  await withStubbedNetwork(() => Response.json({ id: 'gen_1' }), async (requests) => {
    const ok = await run({ url: 'https://public-api.gamma.app/v1.0/generations/gen_1', headers: { 'X-Trace': 't1' } });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(requests[0]!.headers.get('x-api-key'), 'sk-gamma-secret-value');
    assert.equal(requests[0]!.headers.get('authorization'), null);
    assert.equal(requests[0]!.headers.get('x-trace'), 't1');
    const refused = await run({ url: 'https://public-api.gamma.app/v1.0/generations', headers: { 'x-api-key': 'mine' } });
    assert.equal(refused.reason, 'headers_not_allowed');
    assert.equal(requests.length, 1);
  });
});

test('two connections on one host: the chosen one sends with its own credential, and omission is ambiguous', async () => {
  const second: Entry = { id: 'conn_asana_2', displayName: 'Asana (Marketing)', connectors: [asana({ headerValue: `Bearer ${OTHER_TOKEN}` })] };
  const run = requestTool([ASANA_ENTRY, second]);
  await withStubbedNetwork(() => Response.json({ data: {} }), async (requests) => {
    const ambiguous = await run({ url: 'https://app.asana.com/api/1.0/users/me' });
    assert.equal(ambiguous.reason, 'ambiguous_connection');
    assert.deepEqual(ambiguous.connections.map(({ id }: { id: string }) => id), ['conn_asana', 'conn_asana_2']);
    const chosen = await run({ url: 'https://app.asana.com/api/1.0/users/me', connection: 'conn_asana_2' });
    assert.equal(chosen.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.headers.get('authorization'), `Bearer ${OTHER_TOKEN}`);
  });
});

test('a connection revoked, disabled, or narrowed mid-turn is refused on the next call', async () => {
  let authorized = true;
  let entries: Entry[] = [{ ...ASANA_ENTRY, connectors: [asana({ authorize: async () => authorized })] }];
  const run = requestTool(async () => access(entries));
  await withStubbedNetwork(() => Response.json({ data: {} }), async (requests) => {
    assert.equal((await run({ url: 'https://app.asana.com/api/1.0/users/me' })).ok, true);
    authorized = false;
    assert.equal((await run({ url: 'https://app.asana.com/api/1.0/users/me' })).reason, 'url_not_allowed');
    entries = [{ ...ASANA_ENTRY, connectors: [asana({ allowedMethods: ['GET'] })] }];
    assert.equal((await inSubmission(true, () => run({
      method: 'POST', url: 'https://app.asana.com/api/1.0/tasks', json: {},
    }))).reason, 'method_not_allowed');
    entries = [];
    assert.equal((await run({ url: 'https://app.asana.com/api/1.0/users/me' })).reason, 'no_connection');
    assert.equal(requests.length, 1);
  });
});

test('reads follow redirects only within the scope; a write reports a redirect instead of following it', async () => {
  const run = requestTool([ASANA_ENTRY]);
  await withStubbedNetwork((request) => {
    if (request.url.endsWith('/moved')) return new Response(null, { status: 302, headers: { location: 'https://app.asana.com/api/1.0/users/me' } });
    if (request.url.endsWith('/offsite')) return new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
    return Response.json({ data: { gid: '1' } });
  }, async (requests) => {
    const followed = await run({ url: 'https://app.asana.com/api/1.0/moved' });
    assert.equal(followed.ok, true, JSON.stringify(followed));
    assert.equal(requests.length, 2);
    const offsite = await run({ url: 'https://app.asana.com/api/1.0/offsite' });
    assert.equal(offsite.reason, 'url_not_allowed');
    assert.ok(requests.every(({ url }) => !url.startsWith('https://evil.example')));
    const write = await inSubmission(true, () => run({ method: 'POST', url: 'https://app.asana.com/api/1.0/moved', json: {} }));
    assert.equal(write.ok, false);
    assert.equal(write.status, 302);
    assert.match(write.note, /does not follow redirects for writes/);
    assert.equal(requests.at(-1)!.url, 'https://app.asana.com/api/1.0/moved');
  });
});

test('responses are bounded, redacted, and summarized when binary', async () => {
  const run = requestTool([ASANA_ENTRY]);
  const long = 'x'.repeat(MAX_CONNECTION_RESPONSE_CHARS + 10);
  await withStubbedNetwork((request) => {
    if (request.url.includes('/long')) return Response.json({ data: long });
    if (request.url.includes('/text')) return new Response(`token Bearer ${TOKEN} here`, { headers: { 'content-type': 'text/plain' } });
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { headers: { 'content-type': 'image/png' } });
  }, async () => {
    const truncated = await run({ url: 'https://app.asana.com/api/1.0/long' });
    assert.equal(truncated.responseTruncated, true);
    assert.equal(typeof truncated.response, 'string');
    assert.equal(truncated.response.length, MAX_CONNECTION_RESPONSE_CHARS);
    assert.match(truncated.hint, /paginate/);
    const text = await run({ url: 'https://app.asana.com/api/1.0/text' });
    assert.doesNotMatch(text.response, new RegExp(TOKEN));
    const binary = await run({ url: 'https://app.asana.com/api/1.0/file.png' });
    assert.deepEqual(
      { binary: binary.binary, byteLength: binary.byteLength, contentType: binary.contentType, response: binary.response },
      { binary: true, byteLength: 4, contentType: 'image/png', response: undefined },
    );
  });
});

test('a network failure is reported with a static message', async () => {
  const run = requestTool([ASANA_ENTRY]);
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).startsWith('https://cloudflare-dns.com/')) {
      return Response.json({ Status: 0, Answer: [{ type: 1, data: '93.184.216.34' }] });
    }
    throw new Error(`socket closed while sending Bearer ${TOKEN}`);
  }) as typeof fetch;
  try {
    const output = await run({ url: 'https://app.asana.com/api/1.0/users/me' });
    assert.equal(output.reason, 'failed');
    assert.doesNotMatch(JSON.stringify(output), new RegExp(TOKEN));
  } finally {
    globalThis.fetch = previous;
  }
});

test('a DNS resolver outage is a transient failure, not a scope refusal', async () => {
  const run = requestTool([ASANA_ENTRY]);
  const previous = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://cloudflare-dns.com/')) return new Response('unavailable', { status: 503 });
    requests.push(url);
    return Response.json({});
  }) as typeof fetch;
  try {
    const output = await run({ url: 'https://app.asana.com/api/1.0/users/me' });
    assert.equal(output.reason, 'failed', JSON.stringify(output));
    assert.equal(requests.length, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test('the tool mounts for any API connection with an actor, and narration names the call', () => {
  const plan = {
    actorMembershipId: 'mem_1',
    apiConnections: [{ id: 'conn_asana', allowedHosts: ['app.asana.com'], pathPrefixes: ['/api/1.0'], allowedMethods: ['GET'], headerName: 'Authorization', authMode: 'credential' }],
  } as unknown as RuntimePlanV2;
  assert.equal(runtimePlanAllowsConnectionRequests(plan), true, 'read-only connections still mount');
  assert.equal(runtimePlanAllowsConnectionRequests({ ...plan, actorMembershipId: undefined } as unknown as RuntimePlanV2), false);
  assert.equal(runtimePlanAllowsConnectionRequests({ ...plan, apiConnections: [] } as RuntimePlanV2), false);
  assert.deepEqual(
    toolActivityStatus(CONNECTION_REQUEST_TOOL_NAME, { url: 'https://app.asana.com/api/1.0/users/me' }),
    toolActivityStatus(CONNECTION_REQUEST_TOOL_NAME, {}),
  );
  assert.match(JSON.stringify(toolActivityStatus(CONNECTION_REQUEST_TOOL_NAME, {})), /Calling/);
});

test('the Google Workspace skill teaches connection_request, not curl', () => {
  const [google] = connectorSkillsForConnections([{
    allowedHosts: ['www.googleapis.com'], pathPrefixes: ['/drive/v3'], allowedMethods: ['GET'],
    presetId: 'google-workspace', oauthScopes: ['https://www.googleapis.com/auth/drive.readonly'],
  }]);
  assert.equal(google?.name, 'google-workspace');
  assert.doesNotMatch(google!.instructions, /\bcurl\b/);
  assert.match(google!.instructions, /`connection_request`/);
});
