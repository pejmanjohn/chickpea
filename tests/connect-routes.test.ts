import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createConnectRoutes } from '../src/management/connect-routes.ts';
import {
  AGENT_AUTHORING_GUIDE_URI,
  ADMIN_CODING_AGENTS_PATH,
  ADMIN_SETTINGS_PATH,
  CONNECT_CLIENTS,
  connectOrigin,
  connectPageHtml,
  connectPrompt,
} from '../src/management/connect.ts';
import { PUBLIC_ASSET_PATHS } from '../src/assets/public-assets.ts';

const ORIGIN = 'https://chickpea.example.test';

// The connect surface is public and unauthenticated, so nothing it renders may
// carry a credential or an internal identifier. Checked against both bodies.
const SECRET_MARKERS = ['xoxb', 'Bearer ', 'Authorization:', 'sk-', 'client_secret'];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BARE_HEX_32 = /\b[0-9a-f]{32}\b/i;

// AGENTS.md: customer-facing UI shows only what completes the product task.
const DIAGNOSTIC_WORDS = ['trace', 'receipt', 'revision', 'diagnostic', 'debug'];

async function connectMd(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return createConnectRoutes().request(url, { headers });
}

test('both public connect routes serve cacheable, sniff-proof documents', async () => {
  const markdown = await connectMd(`${ORIGIN}/connect.md`);
  assert.equal(markdown.status, 200);
  assert.equal(markdown.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(markdown.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(markdown.headers.get('vary'), 'Host, X-Forwarded-Host, X-Forwarded-Proto');
  assert.equal(markdown.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(markdown.headers.get('referrer-policy'), 'no-referrer');

  const page = await connectMd(`${ORIGIN}/connect`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('cache-control'), 'public, max-age=300');
  assert.equal(page.headers.get('vary'), 'Host, X-Forwarded-Host, X-Forwarded-Proto');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');

  // The inline copy script runs only because the response's own nonce allows it.
  const policy = page.headers.get('content-security-policy') ?? '';
  const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
  assert.ok(nonce, policy);
  const html = await page.text();
  assert.ok(html.includes(`<script nonce="${nonce}">`), 'page script carries the header nonce');
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);

  // A second request gets a fresh nonce rather than a reused constant.
  const again = await connectMd(`${ORIGIN}/connect`);
  const againNonce = /script-src 'nonce-([^']+)'/.exec(again.headers.get('content-security-policy') ?? '')?.[1];
  assert.notEqual(againNonce, nonce);
});

test('rendered URLs follow the origin the request actually arrived on', async () => {
  const direct = await (await connectMd(`${ORIGIN}/connect.md`)).text();
  assert.ok(direct.includes(`${ORIGIN}/mcp`), 'MCP endpoint');
  assert.ok(direct.includes(`${ORIGIN}/admin`), 'Admin link');
  assert.ok(direct.includes(`${ORIGIN}/connect.md`), 'self link');

  // Node behind a proxy chain: the LAST hop is the one the nearest proxy set.
  const forwarded = await connectMd('http://internal.invalid/connect.md', {
    'x-forwarded-proto': 'https',
    'x-forwarded-host': `a.internal, ${ORIGIN.replace('https://', '')}`,
  });
  assert.equal(forwarded.status, 200);
  assert.ok((await forwarded.text()).includes(`${ORIGIN}/mcp`));
});

test('an operator pin outranks every request header', async () => {
  const previous = process.env.SLACK_TAG_PUBLIC_URL;
  process.env.SLACK_TAG_PUBLIC_URL = 'https://pinned.example.test/';
  try {
    const response = await connectMd('http://spoofed.invalid/connect.md', {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'attacker.example.test',
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.includes('https://pinned.example.test/mcp'));
    assert.ok(!body.includes('attacker.example.test'));
    assert.ok(!body.includes('spoofed.invalid'));
  } finally {
    if (previous === undefined) delete process.env.SLACK_TAG_PUBLIC_URL;
    else process.env.SLACK_TAG_PUBLIC_URL = previous;
  }
});

test('an origin that does not validate renders nothing at all', async () => {
  for (const host of ['chickpea.example.test"', 'chickpea example.test', 'chickpea.example.test/mcp']) {
    for (const path of ['/connect.md', '/connect']) {
      const response = await connectMd(`https://good.example.test${path}`, { 'x-forwarded-host': host });
      assert.equal(response.status, 404, `${path} with host ${host}`);
    }
  }
});

test('the guide names every supported client and proves the connection before claiming it', async () => {
  const body = await (await connectMd(`${ORIGIN}/connect.md`)).text();

  for (const client of CONNECT_CLIENTS) {
    assert.ok(body.includes(`### ${client.title}`), `section for ${client.title}`);
    assert.ok(body.includes(client.snippet(`${ORIGIN}/mcp`)), `snippet for ${client.title}`);
  }
  for (const title of ['Claude Code', 'Codex', 'Cursor', 'VS Code', 'Windsurf', 'Gemini CLI', 'Any other MCP client']) {
    assert.ok(body.includes(title), title);
  }
  // The catch-all client's configuration is a plain remote-server JSON block.
  assert.ok(body.includes('"mcpServers"'), 'generic JSON block');
  assert.ok(body.includes('"type": "http"'), 'generic JSON block declares HTTP transport');
  assert.ok(body.includes(`"url": "${ORIGIN}/mcp"`), 'generic JSON block carries this deployment URL');

  assert.ok(body.includes('inspect_workspace'), 'read-only proof call');
  assert.ok(body.includes(AGENT_AUTHORING_GUIDE_URI), 'agent authoring resource');
  assert.ok(body.includes('chickpea://guide/agent-authoring/v1'), 'agent authoring resource URI');
  // Before Slack setup finishes, /mcp is a 404; the guide must say so instead of
  // letting the agent report a broken connection as a failure it caused.
  assert.ok(/404 at `\/mcp`/.test(body), '404-before-setup guidance');
  assert.ok(body.includes(`${ORIGIN}/admin`), 'points at Admin to finish setup');
});

test('neither public document leaks a credential or an internal identifier', async () => {
  const markdown = await (await connectMd(`${ORIGIN}/connect.md`)).text();
  const page = await connectMd(`${ORIGIN}/connect`);
  const nonce = /script-src 'nonce-([^']+)'/.exec(page.headers.get('content-security-policy') ?? '')?.[1];
  assert.ok(nonce);
  const html = (await page.text()).replaceAll(nonce, '');

  for (const [name, body] of [['markdown', markdown], ['html', html]] as const) {
    for (const marker of SECRET_MARKERS) {
      assert.ok(!body.includes(marker), `${name} contains ${marker}`);
    }
    assert.doesNotMatch(body, UUID, `${name} contains a UUID`);
    assert.doesNotMatch(body, BARE_HEX_32, `${name} contains an opaque identifier`);
  }

  // The client discovers OAuth; a token is never the answer to a failing step.
  assert.ok(markdown.includes('Never create, ask for, or paste a bearer token'), 'no-token instruction');
  assert.ok(markdown.includes('If a step asks you for a secret, stop and tell the person.'), 'secret escape hatch');
});

test('the page hands the person one line to paste and a way to copy it', async () => {
  const html = await (await connectMd(`${ORIGIN}/connect`)).text();

  assert.ok(html.includes(connectPrompt(ORIGIN)), 'the exact prompt');
  assert.ok(html.includes(`Connect my coding agent to my Chickpea using ${ORIGIN}/connect.md`), 'the prompt reads as a sentence');

  const snippetIds = [...html.matchAll(/<pre id="([^"]+)">/g)].map((match) => match[1]);
  const copyTargets = [...html.matchAll(/<button type="button" class="copy" data-copy="([^"]+)">Copy<\/button>/g)]
    .map((match) => match[1]);
  assert.deepEqual(copyTargets, snippetIds, 'one Copy button per snippet');
  assert.ok(snippetIds.length >= 3, snippetIds.join(','));

  assert.ok(html.includes(`href="${ADMIN_SETTINGS_PATH}"`), 'link to Admin Settings');
  assert.ok(html.includes(`href="${ADMIN_CODING_AGENTS_PATH}"`), 'link to Settings → MCP');
  assert.ok(html.includes(`href="${ORIGIN}/connect.md"`), 'link to the agent guide');
});

test('the page escapes whatever the origin turns out to be', () => {
  const clean = connectPageHtml(ORIGIN, 'nonce');
  assert.ok(clean.includes(ORIGIN));
  // The only tags in the document are the ones the template writes.
  assert.equal([...clean.matchAll(/<script/g)].length, 1);

  // connectOrigin never yields this, but the renderer must not depend on that.
  const hostile = connectPageHtml('https://evil.example"><img src=x onerror=alert(1)>', 'nonce');
  assert.ok(!hostile.includes('<img src=x'), 'no injected element');
  assert.equal([...hostile.matchAll(/<script/g)].length, 1);
  assert.ok(hostile.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'), 'escaped instead');
});

test('the page stays inside the product-UI boundary', async () => {
  const html = (await (await connectMd(`${ORIGIN}/connect`)).text()).toLowerCase();
  for (const word of DIAGNOSTIC_WORDS) {
    assert.ok(!html.includes(word), `page mentions ${word}`);
  }
});

test('the page only references images the deployment actually serves', async () => {
  const html = await (await connectMd(`${ORIGIN}/connect`)).text();
  const referenced = [
    ...[...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((match) => match[1]!),
    ...[...html.matchAll(/<link rel="icon" href="([^"]+)">/g)].map((match) => match[1]!),
  ];
  assert.deepEqual(referenced.sort(), ['/chickpea-favicon-32.png', '/chickpea-mark-128.png']);
  for (const path of referenced) {
    assert.ok(PUBLIC_ASSET_PATHS.includes(path.replace(/^\//, '')), path);
  }
});

test('connectOrigin accepts a bare origin and nothing else', () => {
  assert.equal(connectOrigin('https://x.example'), 'https://x.example');
  assert.equal(connectOrigin('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');

  for (const value of [
    'https://x.example/path',
    'https://x.example/connect.md',
    'https://x.example?next=/admin',
    'https://x.example#fragment',
    'https://user:secret@x.example',
    'ftp://x.example',
    'chickpea://guide',
    'x.example',
    'not a url',
    '',
  ]) {
    assert.equal(connectOrigin(value), undefined, value);
  }
});

test('the connect surface stays mounted on the application', async () => {
  const source = await readFile('src/app.ts', 'utf8');
  assert.ok(source.includes('createConnectRoutes()'), 'src/app.ts mounts the connect routes');
});
