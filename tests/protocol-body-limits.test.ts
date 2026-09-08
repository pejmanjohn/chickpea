import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminRoutes } from '../src/admin/routes.ts';
import {
  createMcpOAuthRuntimeRoutes,
  MCP_PROTOCOL_BODY_LIMIT_BYTES,
} from '../src/auth/mcp-oauth-routes.ts';
import {
  channel,
  MAX_SLACK_INGRESS_BYTES,
} from '../src/channels/slack.ts';
import { testAdminAuthority, testAdminHeaders } from './helpers/admin-auth.ts';

function chunkedBody(chunkSize: number, chunkCount: number): {
  body: ReadableStream<Uint8Array>;
  pulls: () => number;
} {
  let count = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (count >= chunkCount) {
        controller.close();
        return;
      }
      count += 1;
      controller.enqueue(new Uint8Array(chunkSize));
    },
  });
  return { body, pulls: () => count };
}

test('anonymous Slack Events bodies are capped before credential resolution', async () => {
  const chunkSize = 64 * 1024;
  const streamed = chunkedBody(chunkSize, 100);
  const request = new Request('http://localhost/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: streamed.body,
    duplex: 'half',
  } as RequestInit);

  const response = await channel.route().request(request);

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request_too_large' });
  assert.ok(streamed.pulls() <= Math.ceil(MAX_SLACK_INGRESS_BYTES / chunkSize) + 1);
});

test('Slack Events bodies cannot bypass the cap with a false Content-Length', async () => {
  const request = new Request('http://localhost/events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': '1',
    },
    body: 'x'.repeat(MAX_SLACK_INGRESS_BYTES + 1),
  });

  const response = await channel.route().request(request);

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request_too_large' });
});

test('MCP protocol bodies are capped before authentication or JSON parsing', async () => {
  const request = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(MCP_PROTOCOL_BODY_LIMIT_BYTES + 1),
  });

  const response = await createMcpOAuthRuntimeRoutes().request(request);

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request_too_large' });
});

test('MCP protocol bodies cannot bypass the cap with a false Content-Length', async () => {
  const request = new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': '1',
    },
    body: 'x'.repeat(MCP_PROTOCOL_BODY_LIMIT_BYTES + 1),
  });

  const response = await createMcpOAuthRuntimeRoutes().request(request);

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request_too_large' });
});

test('MCP browser consent cannot bypass the cap with a false Content-Length', async () => {
  const request = new Request('http://localhost/auth/mcp/consent', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'content-length': '1',
    },
    body: 'x'.repeat(16 * 1024 + 1),
  });

  const response = await createMcpOAuthRuntimeRoutes().request(request);

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request_too_large' });
});

test('Admin mutations cannot bypass the cap with a false Content-Length', async () => {
  const token = 'body-limit-token';
  const request = new Request('http://localhost/admin/api/agents', {
    method: 'POST',
    headers: {
      ...testAdminHeaders(token),
      'content-type': 'application/json',
      'content-length': '1',
    },
    body: 'x'.repeat(1_048_576 + 1),
  });

  const response = await createAdminRoutes(testAdminAuthority(token)).request(request);

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'request_too_large' });
});

test('public webhooks cannot bypass the cap with a false Content-Length', async () => {
  const request = new Request('http://localhost/webhooks/composio', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': '1',
      'webhook-id': 'msg_body_limit',
      'webhook-timestamp': '1',
      'webhook-signature': 'v1,invalid',
    },
    body: 'x'.repeat(256 * 1024 + 1),
  });

  const response = await createAdminRoutes().request(request, undefined, {
    COMPOSIO_WEBHOOK_SECRET: 'test-webhook-secret',
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'payload_too_large' });
});
