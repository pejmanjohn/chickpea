import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createMcpGuardedFetch,
  nodePinnedFetch,
  validateMcpUrl,
  type McpAddressResolver,
} from '../src/config/mcp-url.ts';

function resolved(address: string): Awaited<ReturnType<McpAddressResolver>> {
  return [{ address, family: address.includes(':') ? 6 : 4 }];
}

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

test('rejects trailing-dot (root-anchored FQDN) variants of blocked hosts', () => {
  // `localhost.` resolves identically to `localhost`; a trailing dot must not
  // dodge the blocklist.
  for (const input of [
    'https://localhost./mcp',
    'https://svc.internal./x',
    'https://printer.local./',
  ]) {
    const result = validateMcpUrl(input);
    assert.equal(result.ok, false, input + ' should be rejected');
    if (!result.ok) assert.match(result.reason, /local|internal/i);
  }
});

test('strips a trailing dot from an accepted public FQDN', () => {
  const result = validateMcpUrl('https://mcp.example.com./mcp');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.ok(!result.url.includes('.com.'), 'trailing dot must be stripped: ' + result.url);
    assert.match(result.url, /mcp\.example\.com\/mcp/);
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

test('guarded fetch rejects private and reserved Node DNS answers before network I/O', async () => {
  for (const address of [
    '127.0.0.1',
    '169.254.169.254',
    '192.0.2.1',
    '224.0.0.1',
    '::1',
    'fc00::1',
    '2001:db8::1',
  ]) {
    let fetched = false;
    const guarded = createMcpGuardedFetch({
      cloudflare: false,
      resolveAddresses: async () => resolved(address),
      pinnedFetch: async () => {
        fetched = true;
        return new Response('unexpected');
      },
    });

    await assert.rejects(guarded('https://mcp.example.com/mcp'), /blocked url/i, address);
    assert.equal(fetched, false, address + ' must be blocked before fetch');
  }
});

test('guarded fetch rejects a mixed public and private Node DNS answer set', async () => {
  let fetched = false;
  const guarded = createMcpGuardedFetch({
    cloudflare: false,
    resolveAddresses: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
    pinnedFetch: async () => {
      fetched = true;
      return new Response('unexpected');
    },
  });

  await assert.rejects(guarded('https://mcp.example.com/mcp'), /blocked url/i);
  assert.equal(fetched, false, 'one private answer must reject the entire DNS set');
});

test('production Node transport pins HTTPS lookup to the validated address set', async () => {
  const addresses = resolved('93.184.216.34');
  let requestOptions: import('node:https').RequestOptions | undefined;
  const stopBeforeNetwork = new Error('captured HTTPS options');
  const requestHttps = ((_url: unknown, options: import('node:https').RequestOptions) => {
    requestOptions = options;
    throw stopBeforeNetwork;
  }) as typeof import('node:https').request;

  await assert.rejects(
    nodePinnedFetch(new Request('https://mcp.example.com/mcp'), addresses, requestHttps),
    stopBeforeNetwork,
  );
  assert.equal(requestOptions?.agent, false, 'a global socket must never bypass pinned lookup');
  assert.equal(typeof requestOptions?.lookup, 'function');
  const lookup = requestOptions?.lookup;
  assert.ok(lookup);

  const runLookup = (options: Record<string, unknown>) =>
    new Promise<{ address: unknown; family: number | undefined }>((resolve, reject) => {
      Reflect.apply(lookup, undefined, [
        'mcp.example.com',
        options,
        (error: NodeJS.ErrnoException | null, address: unknown, family?: number) => {
          if (error) reject(error);
          else resolve({ address, family });
        },
      ]);
    });

  assert.deepEqual(await runLookup({ family: 0, all: false }), {
    address: '93.184.216.34',
    family: 4,
  });
  assert.deepEqual(await runLookup({ family: 0, all: true }), {
    address: addresses,
    family: undefined,
  });
  await assert.rejects(runLookup({ family: 6, all: false }), {
    code: 'EAI_ADDRFAMILY',
  });
});

test('guarded fetch allows public Node DNS answers', async () => {
  let fetchedUrl = '';
  const guarded = createMcpGuardedFetch({
    cloudflare: false,
    resolveAddresses: async () => resolved('93.184.216.34'),
    pinnedFetch: async (request, addresses) => {
      fetchedUrl = request.url;
      assert.equal(request.redirect, 'manual');
      assert.deepEqual(addresses, resolved('93.184.216.34'));
      return new Response('ok');
    },
  });

  const response = await guarded('https://mcp.example.com/mcp');
  assert.equal(response.status, 200);
  assert.equal(fetchedUrl, 'https://mcp.example.com/mcp');
});

test('guarded fetch allows standard NAT64 answers only when they embed public IPv4', async () => {
  let fetched = false;
  const publicAnswers = [
    { address: '216.24.57.7', family: 4 },
    { address: '64:ff9b::d818:3907', family: 6 },
  ];
  const guarded = createMcpGuardedFetch({
    cloudflare: false,
    resolveAddresses: async () => publicAnswers,
    pinnedFetch: async (_request, addresses) => {
      fetched = true;
      assert.deepEqual(addresses, publicAnswers);
      return new Response('ok');
    },
  });

  assert.equal((await guarded('https://mcp.example.com/mcp')).status, 200);
  assert.equal(fetched, true);

  for (const address of [
    '64:ff9b::7f00:1', // 127.0.0.1
    '64:ff9b::a00:1', // 10.0.0.1
    '64:ff9b::a9fe:a9fe', // 169.254.169.254
  ]) {
    let privateFetched = false;
    const privateGuarded = createMcpGuardedFetch({
      cloudflare: false,
      resolveAddresses: async () => resolved(address),
      pinnedFetch: async () => {
        privateFetched = true;
        return new Response('unexpected');
      },
    });
    await assert.rejects(
      privateGuarded('https://mcp.example.com/mcp'),
      /blocked url/i,
      address,
    );
    assert.equal(privateFetched, false, address + ' must inherit the embedded IPv4 policy');
  }
});

test('guarded fetch skips Node DNS APIs on Cloudflare while keeping URL guards', async () => {
  let resolverCalled = false;
  const guarded = createMcpGuardedFetch({
    cloudflare: true,
    resolveAddresses: async () => {
      resolverCalled = true;
      return resolved('127.0.0.1');
    },
    fetch: async () => new Response('ok'),
  });

  assert.equal((await guarded('https://mcp.example.com/mcp')).status, 200);
  assert.equal(resolverCalled, false, 'the Workers path must not invoke node:dns');
  await assert.rejects(guarded('https://127.0.0.1/mcp'), /blocked url/i);
});

test('guarded fetch follows and revalidates bounded same-origin redirects', async () => {
  const fetched: string[] = [];
  let resolutions = 0;
  const guarded = createMcpGuardedFetch({
    cloudflare: false,
    resolveAddresses: async () => {
      resolutions += 1;
      return resolved('93.184.216.34');
    },
    pinnedFetch: async (request) => {
      fetched.push(request.url);
      if (fetched.length === 1) {
        return new Response(null, { status: 307, headers: { location: '/mcp/v2' } });
      }
      return new Response('ok');
    },
  });

  assert.equal((await guarded('https://mcp.example.com/mcp')).status, 200);
  assert.deepEqual(fetched, [
    'https://mcp.example.com/mcp',
    'https://mcp.example.com/mcp/v2',
  ]);
  assert.equal(resolutions, 2, 'every redirect destination must be resolved again');
});

test('guarded fetch blocks a redirect when the same hostname resolves private on the next hop', async () => {
  let resolutions = 0;
  let fetches = 0;
  const guarded = createMcpGuardedFetch({
    cloudflare: false,
    resolveAddresses: async () => {
      resolutions += 1;
      return resolved(resolutions === 1 ? '93.184.216.34' : '127.0.0.1');
    },
    pinnedFetch: async () => {
      fetches += 1;
      return new Response(null, { status: 307, headers: { location: '/private' } });
    },
  });

  await assert.rejects(guarded('https://mcp.example.com/mcp'), /blocked url/i);
  assert.equal(fetches, 1, 'the private redirect destination must not be fetched');
});

test('guarded fetch rejects cross-origin redirects before arbitrary credential headers can move', async () => {
  const seen: Request[] = [];
  const guarded = createMcpGuardedFetch({
    cloudflare: false,
    resolveAddresses: async () => resolved('93.184.216.34'),
    pinnedFetch: async (request) => {
      seen.push(request);
      return new Response(null, {
        status: 307,
        headers: { location: 'https://other.example.net/mcp' },
      });
    },
  });

  await assert.rejects(
    guarded('https://mcp.example.com/mcp', {
      headers: { authorization: 'Bearer secret', 'x-custom-token': 'also-secret' },
    }),
    /blocked url.*cross-origin redirect/i,
  );
  assert.equal(seen.length, 1, 'the redirected origin must never receive a request');
  assert.equal(seen[0]?.headers.get('authorization'), 'Bearer secret');
});

test('guarded fetch pins all transport requests to the configured MCP origin', async () => {
  let fetched = false;
  const guarded = createMcpGuardedFetch({
    cloudflare: false,
    allowedOrigin: 'https://mcp.example.com',
    resolveAddresses: async () => resolved('93.184.216.34'),
    pinnedFetch: async () => {
      fetched = true;
      return new Response('unexpected');
    },
  });

  await assert.rejects(
    guarded('https://other.example.net/mcp', {
      headers: { 'x-custom-token': 'secret' },
    }),
    /blocked url.*outside the configured origin/i,
  );
  assert.equal(fetched, false, 'alternate transport endpoints must not receive credentials');
});

test('guarded fetch caps same-origin redirect chains', async () => {
  let fetches = 0;
  const guarded = createMcpGuardedFetch({
    cloudflare: false,
    maxRedirects: 1,
    resolveAddresses: async () => resolved('93.184.216.34'),
    pinnedFetch: async () => {
      fetches += 1;
      return new Response(null, {
        status: 307,
        headers: { location: '/redirect-' + fetches },
      });
    },
  });

  await assert.rejects(guarded('https://mcp.example.com/mcp'), /too many redirects/i);
  assert.equal(fetches, 2, 'one redirect is followed, the next is rejected');
});
