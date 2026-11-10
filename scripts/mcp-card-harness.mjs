#!/usr/bin/env node
/**
 * Renders the ChatGPT Agent card the way ChatGPT hosts it, against Core's real
 * MCP server on a fixture workspace, and drives it in Chrome: every state in
 * light and dark, 728 and 390 px wide. Saves one screenshot per state and
 * checks that a destructive confirmation waits for the click.
 *
 *   npm run mcp-cards:harness -- --out <dir> [--chrome <path>]
 *
 * Nothing here touches Slack, ChatGPT or a deployment.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { build } from 'esbuild';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import { AGENT_CARD_URI } from '../src/management/mcp-v5/cards.ts';
import { SLACK_SETTING_KEYS } from '../src/slack/credentials.ts';
import { createFixtureAgent, createManagementAdapterFixture } from '../tests/helpers/management-adapter-fixture.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    out: { type: 'string', default: join(tmpdir(), 'chickpea-card-screens') },
    chrome: { type: 'string', default: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
  },
});
const OUT = resolve(args.out);
mkdirSync(OUT, { recursive: true });

const STYLES = JSON.parse(readFileSync(join(HERE, 'mcp-card-harness', 'chatgpt-host-styles.json'), 'utf8'));
const HOST_SCRIPT = (await build({
  entryPoints: [join(HERE, 'mcp-card-harness', 'host.mjs')],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022', logLevel: 'silent',
})).outputFiles[0].text;

const FRAME_STYLE = `
  :root { color-scheme: light; --bg: #fff; --fg: #0d0d0d; --muted: #5d5d5d; --line: #e5e5e5; }
  :root[data-theme="dark"] { color-scheme: dark; --bg: rgb(14 14 14); --fg: rgb(237 237 237); --muted: rgb(205 205 205); --line: rgb(255 255 255 / 15%); }
  body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 13px -apple-system, system-ui, sans-serif; }
  #shot { display: inline-block; }
  .app { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; color: var(--muted); }
  .app i { width: 16px; height: 16px; border-radius: 5px; background: #e8901a; }
  #frame { border: 1px solid var(--line); border-radius: 20px; overflow: hidden; }
  iframe { display: block; width: 100%; height: 120px; border: 0; }`;

/** One fixture workspace with Core's MCP server; each run of the scenes gets its own. */
async function world() {
  const clock = { now: Date.now() };
  const f = await createManagementAdapterFixture(`harness_${Math.random().toString(36).slice(2, 8)}`,
    ({ settings }) => ({ settings, now: () => clock.now }));
  await f.settings.setSetting(SLACK_SETTING_KEYS.teamName, 'Acme');
  const teamId = f.owner.binding.slackTeamId;
  const principal = {
    betterAuthUserId: f.owner.binding.betterAuthUserId ?? 'ba_owner',
    userId: f.owner.user.id,
    membershipId: f.owner.membership.id,
    organizationId: f.owner.membership.organizationId,
    role: 'owner',
    clientId: 'client_harness',
  };
  const handler = createMcpHandler(
    () => createWorkspaceManagementMcpServer({ principal, service: f.service, baseUrl: 'https://app.chickpea.example' }),
    { legacy: 'stateless' },
  );
  const rpc = async (method, params) => {
    const response = await handler.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }));
    const body = await response.text();
    return JSON.parse(body.trimStart().startsWith('{') ? body : body.split('\n').find((line) => line.startsWith('data: ')).slice(6)).result;
  };
  const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  const version = async (agentId) => (await call('get_agent', { agentId })).structuredContent.version;

  // An installed Slack app, so results carry Slack's web link to it.
  const installation = await f.config.ensureWorkspaceInstallation({ workspaceId: teamId, transportMode: 'gateway', teamId, appId: 'A0CHICKPEA' });
  await f.config.updateWorkspaceInstallation(teamId, { appId: 'A0CHICKPEA' }, installation.revision);
  for (const [channelId, label] of [['C_FINANCE', 'finance'], ['C_SUPPORT', 'support'], ['C_BILLING', 'billing']]) {
    await f.config.putChannel({ workspaceId: teamId, channelId, label, lifecycle: 'active' });
  }
  await createFixtureAgent(f, 'agent_support', {
    name: 'Support Desk',
    slackPresence: { requestedHandle: 'support', normalizedHandle: 'support', desiredState: 'active', health: 'healthy', avatar: { kind: 'generated', revision: 1, seed: 'support' } },
  });
  for (const channelId of ['C_SUPPORT', 'C_BILLING']) {
    await f.config.putAgentChannelGrant({ workspaceId: teamId, channelId, agentId: 'agent_support', status: 'active', createdByMembershipId: f.owner.membership.id });
  }

  const created = () => f.config.getAgent('agent_invoice_chaser');
  const scenes = {
    proposal: () => call('propose_agent', {
      name: 'Invoice Chaser',
      handle: 'invoices',
      job: 'Chases invoices more than 30 days overdue and posts a summary in #finance every Monday.',
      instructions: '# Job\nChase invoices more than 30 days overdue.\n\n## Tone\nBe brief and polite.',
      sampleAsk: 'who\'s overdue this week?',
      promisedAnswer: 'I list every invoice past 30 days with the customer, amount and days overdue, each linked in Stripe, and flag anyone I\'ve already reminded twice.',
      services: ['Stripe'],
      channels: ['#finance'],
    }),
    change: async () => {
      const agent = (await call('get_agent', { agentId: 'agent_invoice_chaser' })).structuredContent;
      return call('propose_agent_change', {
        agentId: agent.agentId,
        version: agent.version,
        change: {
          instructions: agent.instructions.replace('Be brief and polite.', 'Be brief and polite. Keep each message under three sentences, and open with the customer\'s name.'),
          description: 'Chases invoices more than 30 days overdue and posts a summary in #finance every Monday and Thursday.',
        },
      });
    },
    confirm: async () => call('update_agent', { agentId: 'agent_support', version: await version('agent_support'), on: false, idempotencyKey: `off-${clock.now}` }),
    expired: async () => {
      const at = clock.now;
      clock.now = Date.now() - 31 * 60_000;
      try {
        await f.config.updateAgent('agent_support', { enabled: true });
        return await call('update_agent', { agentId: 'agent_support', version: await version('agent_support'), on: false, idempotencyKey: `stale-${at}` });
      } finally {
        clock.now = at;
      }
    },
  };
  /** Its Channels, joining or joined. */
  async function channels(status) {
    const agent = await created();
    for (const grant of (await f.config.listAgentChannelGrants()).filter(({ agentId }) => agentId === agent.id)) {
      await f.config.putAgentChannelGrant({ ...grant, status });
    }
  }
  /** The welcome Chickpea delivers once Slack has the Agent; a Channel may still be joining. */
  async function sayHello() {
    const agent = await created();
    await f.config.updateAgent(agent.id, { slackPresence: { ...agent.slackPresence, health: 'healthy' } });
    await channels('pending');
    // The fixture has no Slack, so create_agent's own hello is Chickpea's stand-in. With Slack,
    // the Agent posts it in its own name: that receipt, delivered as the outbox would.
    const claimed = await f.management.claimDueOutbox(clock.now, 25, clock.now + 60_000);
    const queued = claimed.find(({ receipt }) => receipt.kind === 'agent_created_welcome' && receipt.agentId === agent.id);
    assert.ok(queued, 'create_agent queued a hello');
    const welcome = {
      ...queued,
      outboxId: `${queued.outboxId}_published`,
      receipt: { ...queued.receipt, publication: { status: 'complete', incomplete: [] } },
      status: 'pending',
      createdAt: clock.now + 1,
      updatedAt: clock.now + 1,
      nextAttemptAt: clock.now,
    };
    await f.management.putOutbox(welcome);
    await f.management.claimDueOutbox(clock.now, 25, clock.now + 60_000);
    await f.management.settleOutbox({ outboxId: welcome.outboxId, outcome: 'delivered', at: clock.now, deliveryRef: 'D1:1.1' });
  }
  return { f, rpc, call, scenes, sayHello, joinChannels: () => channels('active'), close: () => f.close() };
}

/** Two origins, like ChatGPT's page and its card sandbox. */
async function serve(current) {
  const listen = (handle) => new Promise((done) => {
    const server = createServer(handle);
    server.listen(0, '127.0.0.1', () => done(server));
  });
  const cardServer = await listen(async (_request, response) => {
    // The page ChatGPT gets: resources/read on the card's URI.
    const [card] = (await current().rpc('resources/read', { uri: AGENT_CARD_URI })).contents;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(card.text);
  });
  const hostServer = await listen(async (request, response) => {
    const url = new URL(request.url, 'http://host');
    const json = (value) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (url.pathname === '/scene') return json({ result: await current().scenes[url.searchParams.get('name')]() });
    if (url.pathname === '/call') {
      let body = '';
      for await (const chunk of request) body += chunk;
      const { name, arguments: callArgs } = JSON.parse(body);
      return json(await current().call(name, callArgs));
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><style>${FRAME_STYLE}</style>
      <script>window.HARNESS_STYLES = ${JSON.stringify(STYLES)};</script></head>
      <body><div id="shot"><div class="app"><i></i>Chickpea</div><div id="frame"></div></div>
      <script type="module">${HOST_SCRIPT}</script></body></html>`);
  });
  const origin = (server) => `http://127.0.0.1:${server.address().port}`;
  return { host: origin(hostServer), card: origin(cardServer), close: () => { hostServer.close(); cardServer.close(); } };
}

/** Chrome with a throwaway profile, driven over the DevTools protocol. */
async function chrome() {
  const profile = mkdtempSync(join(tmpdir(), 'chickpea-card-chrome-'));
  const child = spawn(args.chrome, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((done, fail) => {
    let log = '';
    child.stderr.on('data', (chunk) => {
      log += chunk;
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(log);
      if (match) done(match[1]);
    });
    child.on('exit', () => fail(new Error(`Chrome exited: ${log}`)));
  });
  const http = endpoint.replace(/^ws:\/\/([^/]+).*/, 'http://$1');
  const page = await (await fetch(`${http}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done) => socket.addEventListener('open', done, { once: true }));
  let id = 0;
  const waiting = new Map();
  const contexts = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.executionContextCreated') {
      const { context } = message.params;
      if (context.auxData?.isDefault) contexts.set(context.auxData.frameId, context.id);
    }
    if (message.method === 'Runtime.executionContextsCleared') contexts.clear();
    const pending = waiting.get(message.id);
    if (!pending) return;
    waiting.delete(message.id);
    if (message.error) pending.fail(new Error(message.error.message));
    else pending.done(message.result);
  });
  const send = (method, params = {}) => new Promise((done, fail) => {
    const messageId = ++id;
    waiting.set(messageId, { done, fail });
    socket.send(JSON.stringify({ id: messageId, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront');
  const evaluate = async (expression, contextId) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...contextId ? { contextId } : {} });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  };
  const cardContext = async () => {
    const { frameTree } = await send('Page.getFrameTree');
    const frameId = frameTree.childFrames?.[0]?.frame.id;
    return frameId && contexts.get(frameId);
  };
  const inCard = async (expression) => evaluate(expression, await cardContext());
  return {
    async open(url, { width, theme }) {
      await send('Emulation.setDeviceMetricsOverride', { width: width + 32, height: 900, deviceScaleFactor: 2, mobile: width < 500 });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme === 'dark' ? 'dark' : 'light' }] });
      await send('Page.navigate', { url });
    },
    inCard,
    host: (expression) => evaluate(expression),
    /** Waits until the card's page makes `expression` true. */
    async waitFor(expression, what, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await inCard(`Boolean(${expression})`).catch(() => false)) return;
        if (Date.now() > deadline) {
          const shown = await inCard('document.querySelector(".cp-card")?.innerText ?? ""').catch(() => '');
          throw new Error(`The card never showed ${what}. It shows:\n${shown}`);
        }
        await new Promise((done) => setTimeout(done, 100));
      }
    },
    waitForTitle(pattern, timeoutMs) {
      return this.waitFor(`${pattern}.test(document.querySelector(".cp-title")?.textContent ?? "")`, pattern, timeoutMs);
    },
    /** A real mouse click on the card's button. */
    async click(action) {
      const box = await inCard(`(() => { const r = document.querySelector('button[data-action="${action}"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      const frame = await evaluate('(() => { const r = document.querySelector("iframe").getBoundingClientRect(); return { x: r.x, y: r.y }; })()');
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: frame.x + box.x, y: frame.y + box.y });
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: frame.x + box.x, y: frame.y + box.y, button: 'left', clickCount: 1 });
      }
    },
    /**
     * The lowest WCAG contrast of any text on the card against what is behind
     * it, from the colors the page computed, so host variables count.
     */
    contrast: () => inCard(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const paint = canvas.getContext('2d', { willReadFrequently: true });
      const over = (colors) => {
        paint.clearRect(0, 0, 1, 1);
        for (const color of colors) { paint.fillStyle = color; paint.fillRect(0, 0, 1, 1); }
        return [...paint.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      const luminance = (rgb) => rgb.map((v) => v / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
      const backgrounds = (node) => {
        const layers = [];
        for (let at = node; at; at = at.parentElement) {
          const bg = getComputedStyle(at).backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') layers.unshift(bg);
        }
        return ['#ffffff', ...layers];
      };
      let worst = { ratio: 99 };
      for (const node of document.querySelectorAll('.cp-card *')) {
        const text = [...node.childNodes].filter((child) => child.nodeType === 3).map((child) => child.textContent.trim()).join('');
        if (!text || node.closest('[hidden]') || node.classList.contains('sr-only')) continue;
        const style = getComputedStyle(node);
        const behind = backgrounds(node);
        const [fg, bg] = [over([...behind, style.color]), over(behind)];
        const [a, b] = [luminance(fg), luminance(bg)];
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
        // A glyph hidden from screen readers is a graphic: WCAG 1.4.11 asks 3:1 of it.
        const needed = large || node.closest('[aria-hidden="true"]') ? 3 : 4.5;
        if (ratio / needed < worst.ratio / (worst.needed ?? 1)) worst = { ratio: Math.round(ratio * 100) / 100, needed, text: text.slice(0, 40) };
      }
      return worst;
    })()`),
    async screenshot(file) {
      await new Promise((done) => setTimeout(done, 400));
      const clip = await evaluate('(() => { const r = document.getElementById("shot").getBoundingClientRect(); return { x: r.x - 16, y: r.y - 16, width: r.width + 32, height: r.height + 32, scale: 1 }; })()');
      const { data } = await send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
      writeFileSync(file, Buffer.from(data, 'base64'));
    },
    async close() {
      socket.close();
      const exited = new Promise((done) => child.once('exit', done));
      child.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

let current;
const servers = await serve(() => current);
const browser = await chrome();
const shots = [];
const contrast = [];
const runs = [
  ...['light', 'dark'].flatMap((theme) => [728, 390].map((width) => ({ theme, width }))),
  { theme: 'none', width: 728 },
];
try {
  for (const { theme, width } of runs) {
    current = await world();
    const label = `${theme === 'none' ? 'no-host-theme' : theme}-${width}`;
    const open = (scene) => browser.open(`${servers.host}/?scene=${scene}&theme=${theme}&width=${width}&card=${encodeURIComponent(servers.card)}`, { width, theme });
    const shot = async (name) => {
      const file = join(OUT, `${name}-${label}.png`);
      await browser.screenshot(file);
      shots.push(file);
      const worst = await browser.contrast();
      contrast.push({ shot: `${name}-${label}`, ...worst });
      assert.ok(worst.ratio >= worst.needed, `${name}-${label}: "${worst.text}" has contrast ${worst.ratio}, under ${worst.needed}`);
    };

    await open('proposal');
    await browser.waitForTitle(/^Invoice Chaser$/);
    await shot('1-proposal');
    assert.equal(await browser.inCard('document.documentElement.style.getPropertyValue("--cursor-interaction")'), 'pointer',
      'the host\'s cursor for things to press');
    if (theme === 'light' && width === 728) {
      // A theme flip without new style variables drops the old theme's colors for the card's own.
      await browser.host('window.harness.flipTheme("dark")');
      await browser.waitFor('getComputedStyle(document.body).backgroundColor === "rgb(24, 24, 24)"', 'the dark fallback after a theme-only flip');
      const worst = await browser.contrast();
      assert.ok(worst.ratio >= worst.needed, `after the flip: "${worst.text}" has contrast ${worst.ratio}`);
      await open('proposal');
      await browser.waitForTitle(/^Invoice Chaser$/);
    }
    if (theme === 'none') {
      await open('confirm');
      await browser.waitForTitle(/^Turn off @support\?$/);
      await shot('6-confirm');
      current.close();
      continue;
    }
    await browser.click('create');
    await browser.waitFor('document.querySelector(".cp-steps")', 'the creation steps');
    await shot('2-creating');
    await current.sayHello();
    await browser.waitFor(`["Joining Slack as @invoices (done)", "Saying hello to you (done)", "Joining #finance (in progress)"]
      .every((step) => [...document.querySelectorAll('.cp-steps li')].some((li) => li.textContent.endsWith(step)))`, 'the hello done while its Channel joins');
    await shot('2-hello-joining');
    await current.joinChannels();
    await browser.waitForTitle(/said hello to you in Slack$/);
    await shot('2-ready');

    await open('change');
    await browser.waitForTitle(/^Change Invoice Chaser$/);
    await shot('5-change');
    await browser.click('save');
    await browser.waitForTitle(/^✓ Saved Invoice Chaser$/);
    await shot('5-saved');

    await open('confirm');
    await browser.waitForTitle(/^Turn off @support\?$/);
    await new Promise((done) => setTimeout(done, 3_000));
    await browser.inCard('window.dispatchEvent(new Event("focus"))');
    assert.deepEqual(await browser.host('window.harness.calls'), [], 'the card made no call before the click');
    assert.equal((await current.f.config.getAgent('agent_support')).enabled, true);
    await shot('6-confirm');
    await browser.click('confirm');
    await browser.waitForTitle(/^✓ Made the change you confirmed$/);
    assert.deepEqual(await browser.host('window.harness.calls'), ['confirm_change'], 'one click, one confirmation');
    assert.equal((await current.f.config.getAgent('agent_support')).enabled, false);
    await shot('6-confirmed');

    await open('expired');
    await browser.waitForTitle(/^This confirmation expired$/);
    await shot('6-expired');
    current.close();
  }
} finally {
  await browser.close();
  servers.close();
}
writeFileSync(join(OUT, 'contrast.json'), `${JSON.stringify(contrast, null, 2)}\n`);
console.log(`${shots.length} screenshots in ${OUT}; lowest text contrast ${Math.min(...contrast.map(({ ratio }) => ratio))}:1`);
