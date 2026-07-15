import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateMcpUrl } from '../src/config/mcp-url.ts';

test('accepts ordinary https MCP URLs', () => {
  for (const input of [
    'https://mcp.example.com/mcp',
    'https://mcp.example.com:8443/sse?x=1',
    'https://docs.mcp.cloudflare.com/mcp',
  ]) {
    const result = validateMcpUrl(input);
    assert.equal(result.ok, true, input + ' should be accepted');
  }
});

test('keeps the query string on accept', () => {
  const result = validateMcpUrl('https://mcp.example.com:8443/sse?x=1');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.match(result.url, /\?x=1$/);
  }
});

test('strips the hash fragment on accept', () => {
  const result = validateMcpUrl('https://mcp.example.com/mcp#frag');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(!result.url.includes('#frag'), 'hash must be stripped');
    assert.ok(!result.url.includes('#'), 'no # in normalized url');
  }
});

test('accepts public IP literals and RFC-1918 boundary IPs just outside private ranges', () => {
  for (const input of [
    'https://172.32.0.1/', // just past 172.16/12
    'https://100.128.0.1/', // just past 100.64/10 CGNAT
    'https://8.8.8.8/', // public IP literal
  ]) {
    const result = validateMcpUrl(input);
    assert.equal(result.ok, true, input + ' should be accepted');
  }
});

test('rejects non-https schemes', () => {
  const result = validateMcpUrl('http://mcp.example.com/mcp');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /https/i);
});

test('rejects embedded credentials', () => {
  const result = validateMcpUrl('https://user:pw@mcp.example.com/');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /credential/i);
});

test('rejects unparseable input', () => {
  const result = validateMcpUrl('not a url');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /valid url/i);
});

test('rejects localhost / .local / .internal / .localhost hostnames', () => {
  for (const input of [
    'https://localhost/mcp',
    'https://LOCALHOST:8443/',
    'https://foo.localhost/',
    'https://printer.local/',
    'https://svc.internal/',
  ]) {
    const result = validateMcpUrl(input);
    assert.equal(result.ok, false, input + ' should be rejected');
    if (!result.ok) assert.match(result.reason, /local|internal/i);
  }
});

test('rejects bare single-label hostnames', () => {
  const result = validateMcpUrl('https://mcp/');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /bare|qualified/i);
});

test('rejects private and reserved IPv4 literals', () => {
  for (const input of [
    'https://127.0.0.1/', // loopback
    'https://10.1.2.3/', // 10/8
    'https://172.16.0.1/', // 172.16/12 low
    'https://172.31.255.255/', // 172.16/12 high
    'https://192.168.1.1/', // 192.168/16
    'https://169.254.169.254/', // link-local / metadata
    'https://100.64.0.1/', // CGNAT
    'https://0.0.0.0/', // 0/8
  ]) {
    const result = validateMcpUrl(input);
    assert.equal(result.ok, false, input + ' should be rejected');
    if (!result.ok) assert.match(result.reason, /private|internal|ip/i);
  }
});

test('rejects private and reserved IPv6 literals', () => {
  for (const input of [
    'https://[::1]/', // loopback
    'https://[fc00::1]/', // ULA fc00::/7
    'https://[fd12:3456::1]/', // ULA fd
    'https://[fe80::1]/', // link-local
    'https://[::ffff:10.0.0.1]/', // v4-mapped private
  ]) {
    const result = validateMcpUrl(input);
    assert.equal(result.ok, false, input + ' should be rejected');
    if (!result.ok) assert.match(result.reason, /private|internal|ip/i);
  }
});
