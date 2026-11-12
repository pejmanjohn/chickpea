import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { createConnectRoutes } from '../src/management/connect-routes.ts';
import { DISCOVERY_GUIDE_URI as DISCOVERY_RESOURCE_URI } from '../src/management/agent-authoring/index.ts';
import {
  DISCOVERY_GUIDE_URI,
  ADMIN_CODING_AGENTS_PATH,
  ADMIN_SETTINGS_PATH,
  CONNECT_CLIENTS,
  connectOrigin,
  connectPageHtml,
  connectPrompt,
  firstAgentPrompt,
} from '../src/management/connect.ts';
import { CONNECT_FONTS, fontFaceCss } from '../src/assets/fonts.ts';
import { PUBLIC_ASSET_PATHS } from '../src/assets/public-assets.ts';

const ORIGIN = 'https://chickpea.example.test';

test('ChatGPT setup guide targets this installation and delegates local setup without secrets', async () => {
  const response = await createConnectRoutes().request(`${ORIGIN}/connect-chatgpt.md`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/markdown/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const guide = await response.text();
  assert.ok(guide.includes(`${ORIGIN}/chickpea-chatgpt-connect.mjs`));
  assert.ok(guide.includes(`${ORIGIN}/admin/settings/providers`));
  assert.match(guide, /same computer as the user's browser/);
  assert.match(guide, /Do not ask the user to download a helper/);
  assert.match(guide, /same origin without redirects/);
  assert.match(guide, /Image generation requires/);
  for (const marker of SECRET_MARKERS) assert.ok(!guide.includes(marker));
});

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

  assert.match(policy, /(?:^|; )font-src 'self'(?:;|$)/);
  assert.ok(html.includes(`<style>${fontFaceCss(CONNECT_FONTS)}\n`), 'the page loads the fonts its style names');

  // A second request gets a fresh nonce rather than a reused constant.
  const again = await connectMd(`${ORIGIN}/connect`);
  const againNonce = /script-src 'nonce-([^']+)'/.exec(again.headers.get('content-security-policy') ?? '')?.[1];
  assert.notEqual(againNonce, nonce);
});

test('the managed sign-in return page closes its tab and reads the same whatever the provider appends', async () => {
  const plain = await connectMd(`${ORIGIN}/managed-connections/return`);
  const injected = await connectMd(
    `${ORIGIN}/managed-connections/return?status=success&connected_account_id=ca_injected` +
      '&appName=%22%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E&error=%3Cimg%20src%3Dx%3E',
  );
  for (const page of [plain, injected]) {
    assert.equal(page.status, 200, 'served with no session or cookie');
    assert.equal(page.headers.get('content-type'), 'text/html; charset=UTF-8');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('cross-origin-opener-policy'), null,
      'no opener policy that could switch the tab out of its script-opened context');
  }

  const policy = injected.headers.get('content-security-policy') ?? '';
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /form-action 'none'/);
  const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1];
  assert.ok(nonce, policy);
  const html = await injected.text();
  assert.ok(html.includes(`<script nonce="${nonce}">window.close();</script>`), 'the close attempt runs under the header nonce');

  const plainNonce = /script-src 'nonce-([^']+)'/.exec(plain.headers.get('content-security-policy') ?? '')?.[1];
  assert.ok(plainNonce);
  assert.equal(html.replaceAll(nonce, 'N'), (await plain.text()).replaceAll(plainNonce, 'N'),
    'nothing from the query reaches the page');
  for (const marker of ['ca_injected', 'alert(1)', '<img']) {
    assert.ok(!html.includes(marker), marker);
  }

  const text = html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<[^>]+>/g, ' ');
  assert.match(text, /You're done here/);
  assert.match(text, /Go back to your Chickpea Admin tab to see the result\./);
  assert.match(text, /You can close this tab\./);
  assert.doesNotMatch(text, /\b(?:connected|updated|ready|success)\b/i,
    'the person may have declined, so the page claims no outcome');
  for (const word of DIAGNOSTIC_WORDS) assert.ok(!text.toLowerCase().includes(word), word);
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
    for (const path of ['/connect.md', '/connect', '/connect-chatgpt.md']) {
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
  for (const title of ['Claude app', 'Claude Code', 'Codex', 'Cursor', 'VS Code', 'Windsurf', 'Gemini CLI', 'Any other MCP client']) {
    assert.ok(body.includes(title), title);
  }
  // The catch-all client's configuration is a plain remote-server JSON block.
  assert.ok(body.includes('"mcpServers"'), 'generic JSON block');
  assert.ok(body.includes('"type": "http"'), 'generic JSON block declares HTTP transport');
  assert.ok(body.includes(`"url": "${ORIGIN}/mcp"`), 'generic JSON block carries this deployment URL');

  assert.ok(body.includes('Call `get_account`, which changes nothing.'), 'read-only proof call');
  assert.equal(DISCOVERY_GUIDE_URI, DISCOVERY_RESOURCE_URI, 'the guide names the URI the MCP server serves');
  assert.ok(body.includes(`\`${DISCOVERY_GUIDE_URI}\``), 'discovery resource URI');
  // Before Slack setup finishes, /mcp is a 404; the guide must say so instead of
  // letting the agent report a broken connection as a failure it caused.
  assert.ok(/404 at `\/mcp`/.test(body), '404-before-setup guidance');
  assert.ok(body.includes(`${ORIGIN}/admin`), 'points at Admin to finish setup');
});

test('step 6 researches before it proposes, and a new Agent says hello in Slack', async () => {
  const body = await (await connectMd(`${ORIGIN}/connect.md`)).text();
  const step6 = body.slice(body.indexOf('## 6.'), body.indexOf('## Good to know'));
  assert.match(step6, /^## 6\. Find the first teammate$/m);
  assert.ok(step6.includes(`Read the resource \`${DISCOVERY_GUIDE_URI}\` and follow it: research the person's recent work on this machine before you propose an Agent.`));
  assert.doesNotMatch(step6, /\/mcp__chickpea__|slash command|MCP prompts/, 'no 4.x prompt: a 5.0 session lists none');
  assert.doesNotMatch(step6, /What should your first teammate do/, 'no opening question ahead of the research');

  const goodToKnow = body.slice(body.indexOf('## Good to know'));
  assert.match(goodToKnow, /After you create an Agent, it messages the person in Slack, and `links\.slack` opens that conversation\./);
  assert.doesNotMatch(goodToKnow, /mention it in Slack by its handle/);
});

const PROOF_LINE = 'Call Chickpea\'s get_account and tell me the workspace name and who I am signed in as.';
const FIRST_AGENT_ADD_ON = /If they asked for their first Agent and no install guide owns the first teammate, they also add `Then help me create my first Chickpea Agent\.`/;

function client(id: string) {
  return CONNECT_CLIENTS.find((candidate) => candidate.id === id)!;
}

function guideStep(body: string, step: number): string {
  return body.slice(body.indexOf(`## ${step}.`), body.indexOf(`## ${step + 1}.`));
}

test('a client that loads servers per session or thread gets a new one, not a restart', async () => {
  const body = await (await connectMd(`${ORIGIN}/connect.md`)).text();
  const step4 = guideStep(body, 4);

  assert.match(step4, /^## 4\. Open a new session or thread if your client needs it$/m);
  assert.match(step4, /Codex: start a new thread\./);
  assert.ok(step4.includes(`\`${PROOF_LINE}\``), 'a line to paste into the new session or thread');
  assert.match(client('claude-code').restart, /new Claude Code session/);
  assert.doesNotMatch(client('claude-code').restart, /thread/, 'Claude Code has sessions, not threads');
  assert.match(client('codex').restart, /new Codex thread/);
  assert.doesNotMatch(body, /restart the session|next start|do not need to quit/i, 'nothing tells the person to restart, or that quitting is never needed');
});

// The old conversation never sees step 5: the pasted check runs in the new one.
test('step 4 is a list that reports Tested as pending and stops', async () => {
  const step4 = guideStep(await (await connectMd(`${ORIGIN}/connect.md`)).text(), 4);
  const items = step4.split('\n').filter((line) => /^\d\. /.test(line));
  assert.equal(items.length, 5, step4);
  assert.match(items[0]!, /Cursor, VS Code, or Windsurf.*go to step 5 in this conversation/);
  assert.match(items[1]!, /Report the three step 5 lines now, with Tested as pending/);
  assert.match(items.at(-1)!, /^5\. Stop\. Do not open the new session or thread yourself\. If an install guide sent you here, go back to it/);
});

// A new terminal session is the same command run again, and the resume flag
// keeps the conversation (claude --help, gemini --help).
test('terminal clients rerun their command, and the resume flag keeps the conversation', async () => {
  const step4 = guideStep(await (await connectMd(`${ORIGIN}/connect.md`)).text(), 4);
  assert.match(step4, /Claude Code or Gemini CLI in a terminal: exit, then run `claude --continue` or `gemini --resume latest` in the same directory\. That resumes this conversation with Chickpea loaded\./);
  assert.match(client('claude-code').restart, /`claude --continue` in the same directory resumes this conversation/);
  assert.match(client('gemini-cli').restart, /`gemini --resume latest` in the same directory resumes this conversation/);
});

// Gemini CLI 0.36 /mcp reload restarts the servers the session loaded at
// start; it does not read a server `gemini mcp add` wrote afterward.
test('Gemini CLI\'s /mcp reload is named for what it reloads', () => {
  assert.match(client('gemini-cli').restart, /`\/mcp reload` reconnects the servers the session already has and does not load a new one\./);
});

// Claude Code 2.1.311 `claude mcp login` stops without a terminal on stdin,
// and a running session does not list a server added from the terminal. Admin
// shows the login line to people, so the agent-only part lives in step 3.
test('Claude Code signs in with claude mcp login in the person\'s terminal, /mcp as the fallback', async () => {
  const login = client('claude-code').login;
  assert.match(login, /^Run `claude mcp login chickpea` in a terminal and finish the browser sign-in\./);
  assert.match(login, /prints `Authenticated with "chickpea"\.`/);
  assert.doesNotMatch(login, /shell tool|stdin/, 'nothing about the agent in the line Admin shows');
  assert.match(login, /A Claude Code session that lists `chickpea` can sign in from `\/mcp` instead\./);
  const body = await (await connectMd(`${ORIGIN}/connect.md`)).text();
  assert.match(guideStep(body, 3), /In Claude Code, ask the person to run `claude mcp login chickpea` themselves: it needs an interactive terminal, and your shell tool has none\./);
});

test('both hand-off paths ask for the first Agent the same way, unless an install guide owns it', async () => {
  const body = await (await connectMd(`${ORIGIN}/connect.md`)).text();
  const claudeApp = body.slice(body.indexOf('### Claude app'), body.indexOf('### Every other client'));
  for (const [name, section] of [['Claude app', claudeApp], ['step 4', guideStep(body, 4)]] as const) {
    assert.ok(section.includes(`\`${PROOF_LINE}\``), `${name}: the proof line`);
    assert.match(section, FIRST_AGENT_ADD_ON, `${name}: the first-Agent add-on`);
  }
  assert.match(claudeApp, /Report the three step 5 lines now, with Tested as pending.*then stop\./);
});

// Production 2026-11-06: Codex printed its sign-in URL and opened the browser.
// The agent showed the printed URL too; the second open landed on a dead
// loopback callback after the first had already signed in.
test('sign-in uses the tab the client opened and never relays its single-use URL', async () => {
  const body = await (await connectMd(`${ORIGIN}/connect.md`)).text();
  const step3 = body.slice(body.indexOf('## 3.'), body.indexOf('## 4.'));

  assert.match(step3, /single-use/);
  assert.match(step3, /already opened it in the browser/);
  assert.match(step3, /Do not show the URL to the person unless the command reports that it could not open the browser/);
  assert.match(step3, /Wait for the command to finish before you report anything/);
  const leftover = step3.split('\n\n').find((paragraph) => /127\.0\.0\.1/.test(paragraph));
  assert.ok(leftover, 'a leftover-tab note');
  assert.equal(leftover.split(/(?<=\.) /).length, 1, 'the leftover-tab note is one sentence');

  assert.match(client('codex').login, /Browser launch failed/);
  assert.match(client('codex').login, /Successfully logged in/);
});

// Measured 2026-11-06: reopening the same Codex thread after an app restart
// loads the server and keeps the thread's history.
test('step 4 offers reopening a restored thread, after the new-thread default', async () => {
  const step4 = guideStep(await (await connectMd(`${ORIGIN}/connect.md`)).text(), 4);
  const newThread = step4.indexOf('Codex: start a new thread.');
  const reopen = step4.search(/Restarting the app and reopening this thread also works and keeps the conversation\./);
  assert.ok(newThread >= 0 && reopen > newThread, 'a new thread stays the default; reopening comes after it');
});

test('step 5 warns that the first Chickpea call may ask for approval', async () => {
  const body = await (await connectMd(`${ORIGIN}/connect.md`)).text();
  const step5 = body.slice(body.indexOf('## 5.'), body.indexOf('## 6.'));
  assert.match(step5, /first Chickpea call may show an approval prompt/);
  assert.match(step5, /ask the person to approve it/);
  assert.match(step5, /3\. Tested: the signed-in person and the workspace from `get_account`/);
  assert.doesNotMatch(body, /inspect_workspace/, 'the proof uses a 5.0 tool, which every client lists');
});

const CLAUDE_LINK = 'https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Chickpea&connectorUrl=https%3A%2F%2Fchickpea.example.test%2Fmcp';
const CLAUDE_ORGANIZATION_LINK = 'https://claude.ai/admin-settings/connectors?modal=add-custom-connector&connectorName=Chickpea&connectorUrl=https%3A%2F%2Fchickpea.example.test%2Fmcp';

test('the guide hands an agent inside the Claude app the pre-filled connector links', async () => {
  const guide = await (await connectMd(`${ORIGIN}/connect.md`)).text();
  const claudeApp = guide.slice(guide.indexOf('### Claude app'), guide.indexOf('### Every other client'));
  assert.ok(guide.indexOf('### Claude app') > guide.indexOf('## 2. Add the server'), 'inside step 2');
  assert.ok(claudeApp.includes(CLAUDE_LINK), 'personal link');
  assert.ok(claudeApp.includes(CLAUDE_ORGANIZATION_LINK), 'organization link');
  assert.ok(claudeApp.includes(`\`${PROOF_LINE}\``), 'proof in a new conversation');
  // Claude Code in a terminal keeps its command, after a check for a connector it already has.
  const otherClients = guide.slice(guide.indexOf('### Every other client'));
  assert.ok(otherClients.indexOf('`claude.ai Chickpea`') < otherClients.indexOf('| Client | Where |'), 'connector check comes before the table');
  assert.ok(otherClients.includes(`claude mcp add --transport http --scope user chickpea ${ORIGIN}/mcp`));
});

test('the page offers Add to Claude with the same links', async () => {
  const html = await (await connectMd(`${ORIGIN}/connect`)).text();
  const attribute = (href: string) => href.replaceAll('&', '&amp;');
  assert.ok(html.includes(`<a class="install" href="${attribute(CLAUDE_LINK)}" target="_blank" rel="noopener noreferrer">Add to Claude</a>`));
  assert.ok(html.includes(`<a href="${attribute(CLAUDE_ORGANIZATION_LINK)}" target="_blank" rel="noopener noreferrer">`));
});

test('a hosted installation\'s Claude links carry its own origin', async () => {
  const hosted = 'https://team-7.hosted.example';
  const encoded = 'https%3A%2F%2Fteam-7.hosted.example%2Fmcp';
  const env = { CHICKPEA_TENANCY: 'installation' };
  const guide = await (await createConnectRoutes().request(`${hosted}/connect.md`, {}, env)).text();
  const html = await (await createConnectRoutes().request(`${hosted}/connect`, {}, env)).text();
  for (const body of [guide, html.replaceAll('&amp;', '&')]) {
    assert.ok(body.includes(`https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Chickpea&connectorUrl=${encoded}`));
    assert.ok(body.includes(`https://claude.ai/admin-settings/connectors?modal=add-custom-connector&connectorName=Chickpea&connectorUrl=${encoded}`));
  }
});

test('the hosted guide names only the Admin settings its Admin shows; standalone names them all', async () => {
  const sentence = (body: string) => body.split('\n').find((line) => line.includes('are managed in Admin at'));
  const standalone = await (await connectMd(`${ORIGIN}/connect.md`)).text();
  assert.equal(
    sentence(standalone),
    `- Model provider keys, GitHub setup, and the coding sandbox are managed in Admin at ${ORIGIN}${ADMIN_SETTINGS_PATH}. Send the person there with the link rather than asking for the values.`,
  );
  const hosted = await (await createConnectRoutes().request(`${ORIGIN}/connect.md`, {}, { CHICKPEA_TENANCY: 'installation' })).text();
  assert.equal(
    sentence(hosted),
    `- Model provider keys and GitHub setup are managed in Admin at ${ORIGIN}${ADMIN_SETTINGS_PATH}. Send the person there with the link rather than asking for the values.`,
  );
  assert.doesNotMatch(hosted, /coding sandbox|outbound access/i);
  assert.doesNotMatch(standalone, /outbound access/i, 'Outbound access is retired in both modes');
  assert.equal(hosted.replace(sentence(hosted)!, ''), standalone.replace(sentence(standalone)!, ''), 'only that sentence differs');
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
  assert.ok(PUBLIC_ASSET_PATHS.every((path) => !path.startsWith('chickpea/')), 'the art kit is never served');
});

test('the first-Agent prompt is the connect line, then a request for the first Agent', () => {
  assert.equal(
    firstAgentPrompt(ORIGIN),
    `Connect my coding agent to my Chickpea using ${ORIGIN}/connect.md, then help me create my first Chickpea Agent.`,
  );
  assert.ok(firstAgentPrompt(ORIGIN).startsWith(connectPrompt(ORIGIN)), 'the same guide line the connect page copies');
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
