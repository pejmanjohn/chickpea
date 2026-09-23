import assert from 'node:assert/strict';
import test from 'node:test';
import * as v from 'valibot';
import type { AXNode } from '../src/browser/page.ts';
import {
  BROWSER_TOOL_NAMES,
  BrowserVisionUnavailableError,
  browserErrorMessage,
  createBrowserTools,
  MAX_SNAPSHOT_CHARS,
  resolveBrowserTarget,
  type BrowserToolsOptions,
} from '../src/browser/tools.ts';
import { BrowserTurnSession } from '../src/browser/turn-session.ts';
import { createWebsiteLogin, getWebsiteLogin, type WebsiteLogin } from '../src/browser/logins.ts';
import { BrowserProviderError, type BrowserProvider } from '../src/browser/provider.ts';
import { browserHandoffMessage, createSlackRequesterNotifier } from '../src/browser/requester.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import { generateCredentialKeyring } from '../src/slack/credential-keyring.ts';
import type { SlackArtifactStageInput, SlackArtifactStageOutcome } from '../src/sandbox/artifact-tool.ts';
import { FakeCdpSocket, fakeBrowserProvider } from './helpers/fake-cdp-socket.ts';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 9, 9]);
const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

const ax = (nodeId: string, role: string, extra: Partial<AXNode> & { label?: string } = {}): AXNode => {
  const { label, ...rest } = extra;
  return { nodeId, role: { type: 'role', value: role }, ...(label ? { name: { type: 'computedString', value: label } } : {}), ...rest };
};

const TREE: AXNode[] = [
  ax('1', 'RootWebArea', { childIds: ['2', '3'] }),
  ax('2', 'heading', { parentId: '1', label: 'Pricing', backendDOMNodeId: 5 }),
  ax('3', 'link', { parentId: '1', label: 'Plans', backendDOMNodeId: 7 }),
];

/** A scripted page: navigation sets the URL and title, and fires the load event. */
class ScriptedBrowser extends FakeCdpSocket {
  url = 'about:blank';
  title = '';
  tree: AXNode[] = TREE;

  constructor() {
    super();
    const pageSocket = FakeCdpSocket.withPage();
    for (const [method, responder] of pageSocket.responders) this.responders.set(method, responder);
    this.responders.set('Page.navigate', (message) => {
      this.url = String(message.params.url);
      this.title = this.url.includes('duckduckgo') ? 'Search results' : 'Example Pricing';
      queueMicrotask(() => this.emitEvent('Page.loadEventFired', {}, 'page-1'));
      return { result: { frameId: 'f1', loaderId: 'l1' } };
    });
    this.responders.set('Runtime.evaluate', (message) => ({
      result: String(message.params.expression).includes('location.href')
        ? { result: { type: 'object', value: { url: this.url, title: this.title } } }
        : { result: { type: 'string', value: 'complete' } },
    }));
    this.responders.set('Accessibility.getFullAXTree', () => ({ result: { nodes: this.tree } }));
    this.responders.set('DOM.getBoxModel', () => ({ result: { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } } }));
    this.responders.set('Page.captureScreenshot', (message) => ({
      result: { data: toBase64(message.params.format === 'jpeg' ? JPEG_BYTES : PNG_BYTES) },
    }));
  }
}

function fakeProvider() {
  return fakeBrowserProvider({
    async createSession() {
      return { id: 'sess-1', connectUrl: 'wss://connect.example/?signingKey=bb_live_secretvalue123' };
    },
    async listRecordingDownloads() {
      return [{ pageId: 'p1', status: 'COMPLETED', downloadUrl: 'https://recordings.example/sess-1.mp4?sig=abc' }];
    },
  });
}

function setup(overrides: Partial<BrowserToolsOptions> & {
  maxBytes?: number;
  stage?: (input: SlackArtifactStageInput) => SlackArtifactStageOutcome;
  readOnly?: boolean;
  recordingResponse?: () => Response;
} = {}) {
  const browser = new ScriptedBrowser();
  const { provider, ended } = fakeProvider();
  const session = new BrowserTurnSession({
    provider,
    connect: async () => browser,
    sleep: async () => undefined,
    ...(overrides.readOnly === undefined ? {} : { policy: { readOnly: overrides.readOnly } }),
  });
  const staged: SlackArtifactStageInput[] = [];
  const fetched: string[] = [];
  const { maxBytes, stage, readOnly: _readOnly, recordingResponse, ...rest } = overrides;
  const tools = createBrowserTools({
    session,
    stageArtifact: async (input) => {
      staged.push(input);
      return stage ? stage(input) : { attached: true, byteLength: input.bytes.byteLength };
    },
    transportMaxBytes: async () => maxBytes,
    fetch: (async (url: string | URL | Request) => {
      fetched.push(String(url));
      return recordingResponse ? recordingResponse() : new Response(new Uint8Array(2048));
    }) as typeof fetch,
    recordingSleep: async () => undefined,
    now: () => new Date(Date.UTC(2026, 8, 22, 14, 5)),
    ...rest,
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const run = async (name: string, data: Record<string, unknown> = {}): Promise<any> => {
    const tool = byName.get(name);
    assert.ok(tool, `missing tool ${name}`);
    const parsed = tool.input ? v.parse(tool.input as v.GenericSchema, data) : undefined;
    const result = await (tool.run as (context: unknown) => Promise<{ output: unknown }>)({
      data: parsed,
      toolCallId: 'call_1',
      log: { info() {}, warn() {}, error() {} },
    });
    return JSON.parse(JSON.stringify(result.output));
  };
  return { browser, session, staged, fetched, ended, tools, run };
}

test('the browser toolset exposes its eight tools in a stable order', () => {
  const { tools } = setup();
  assert.deepEqual(tools.map((tool) => tool.name), [...BROWSER_TOOL_NAMES]);
  for (const tool of tools) assert.match(tool.description, /./);
  assert.match(tools[0]!.description, /untrusted/);
  assert.match(tools[5]!.description, /Call it last/);
});

test('resolveBrowserTarget keeps URLs, adds https to bare hosts, and searches everything else', () => {
  assert.deepEqual(resolveBrowserTarget('https://example.com/pricing'), { url: 'https://example.com/pricing', searched: false });
  assert.deepEqual(resolveBrowserTarget('example.com/pricing'), { url: 'https://example.com/pricing', searched: false });
  assert.deepEqual(resolveBrowserTarget('best pizza in Berkeley'), {
    url: 'https://duckduckgo.com/html/?q=best%20pizza%20in%20Berkeley',
    searched: true,
  });
  assert.equal(resolveBrowserTarget('javascript:alert(1)').searched, true);
  assert.equal(resolveBrowserTarget('file:///etc/passwd').searched, true);
});

test('browser_open with a URL starts the session, navigates, and returns a snapshot', async () => {
  const { run, browser, session } = setup();
  const output = await run('browser_open', { url: 'https://example.com/pricing' });
  assert.deepEqual(output, {
    url: 'https://example.com/pricing',
    title: 'Example Pricing',
    snapshot: '- heading "Pricing"\n- link "Plans" [ref=e1]',
    truncated: false,
  });
  assert.ok(browser.methods().includes('Page.navigate'));
  assert.equal(session.active, true);
  await session.close();
});

test('browser_open with plain words runs a web search', async () => {
  const { run, session } = setup();
  const output = await run('browser_open', { url: 'chickpea slack agents' });
  assert.equal(output.searched, true);
  assert.equal(output.url, 'https://duckduckgo.com/html/?q=chickpea%20slack%20agents');
  await session.close();
});

test('browser_snapshot caps very long pages', async () => {
  const { run, browser, session } = setup();
  browser.tree = [
    ax('1', 'RootWebArea', { childIds: Array.from({ length: 300 }, (_, i) => `n${i}`) }),
    ...Array.from({ length: 300 }, (_, i) => ax(`n${i}`, 'heading', { parentId: '1', label: `Heading ${'y'.repeat(100)} ${i}` })),
  ];
  await run('browser_open', { url: 'https://example.com/long' });
  const output = await run('browser_snapshot');
  assert.equal(output.truncated, true);
  assert.ok(output.snapshot.length <= MAX_SNAPSHOT_CHARS + 80);
  assert.match(output.snapshot, /snapshot cut at 12000 characters/);
  await session.close();
});

test('browser_act clicks by ref and returns a fresh snapshot', async () => {
  const { run, browser, session } = setup();
  await run('browser_open', { url: 'https://example.com/pricing' });
  const output = await run('browser_act', { ref: 'e1', action: 'click' });
  assert.equal(output.title, 'Example Pricing');
  assert.match(output.snapshot, /\[ref=e1\]/);
  const presses = browser.sent.filter((m) => m.method === 'Input.dispatchMouseEvent').map((m) => m.params.type);
  assert.deepEqual(presses, ['mouseMoved', 'mousePressed', 'mouseReleased']);
  await session.close();
});

test('browser_act refuses data-changing actions without touching the page', async () => {
  const { run, browser, session } = setup();
  const output = await run('browser_act', { ref: 'e1', action: 'click', mayChangeData: true });
  assert.deepEqual(output, {
    refused: true,
    reason: 'Public websites are read-only: changing data needs a website login that allows actions. Tell the person what they can do themselves.',
  });
  assert.equal(browser.sent.length, 0);
  assert.equal(session.active, false);
});

test('a public session stays read-only even when its policy is lifted', async () => {
  const { run, browser, session } = setup({ readOnly: false });
  await run('browser_open', { url: 'https://example.com/pricing' });
  const output = await run('browser_act', { ref: 'e1', action: 'click', mayChangeData: true });
  assert.equal(output.refused, true);
  assert.ok(!browser.methods().includes('Input.dispatchMouseEvent'));
  await session.close();
});

test('browser_open and browser_act read the page title once per call', async () => {
  const { run, browser, session } = setup();
  await run('browser_open', { url: 'https://example.com/pricing' });
  await run('browser_act', { ref: 'e1', action: 'click' });
  const infoReads = browser.sent.filter((m) => String(m.params.expression ?? '').includes('location.href'));
  assert.equal(infoReads.length, 2);
  await session.close();
});

test('browser_act reports an unknown ref in the output with a fresh snapshot', async () => {
  const { run, session } = setup();
  await run('browser_open', { url: 'https://example.com/pricing' });
  const output = await run('browser_act', { ref: 'e99', action: 'click' });
  assert.match(output.error, /Unknown element reference e99/);
  assert.match(output.snapshot, /link "Plans"/);
  await session.close();
});

test('browser_look answers from a JPEG screenshot, or explains that the model cannot see', async () => {
  const questions: Array<{ question: string; mimeType: string; size: number }> = [];
  const { run, browser, session } = setup({
    inspectScreenshot: async (input) => {
      questions.push({ question: input.question, mimeType: input.mimeType, size: input.bytes.byteLength });
      return 'The pricing table has three columns.';
    },
  });
  await run('browser_open', { url: 'https://example.com/pricing' });
  assert.deepEqual(await run('browser_look', { question: 'How many columns?' }), { answer: 'The pricing table has three columns.' });
  assert.deepEqual(questions, [{ question: 'How many columns?', mimeType: 'image/jpeg', size: JPEG_BYTES.byteLength }]);
  const shot = browser.sent.find((m) => m.method === 'Page.captureScreenshot');
  assert.deepEqual(shot?.params, { format: 'jpeg', quality: 70 });
  await session.close();

  const none = setup();
  assert.deepEqual(await none.run('browser_look', { question: 'Is it red?' }), {
    error: "This Agent's model cannot look at images. Use browser_snapshot instead.",
  });
  assert.equal(none.session.active, false);

  const blind = setup({ inspectScreenshot: async () => { throw new BrowserVisionUnavailableError(); } });
  await blind.run('browser_open', { url: 'https://example.com/pricing' });
  assert.deepEqual(await blind.run('browser_look', { question: 'Is it red?' }), {
    error: "This Agent's model cannot look at images. Use browser_snapshot instead.",
  });
  await blind.session.close();
});

test('only browser_open starts a session; the other page tools need an open page', async () => {
  const { run, session, staged } = setup({ inspectScreenshot: async () => 'unused' });
  const noPage = { error: 'No page is open in the browser. Call browser_open first.' };
  assert.deepEqual(await run('browser_snapshot'), noPage);
  assert.deepEqual(await run('browser_act', { ref: 'e1', action: 'click' }), noPage);
  assert.deepEqual(await run('browser_look', { question: 'Is it red?' }), noPage);
  assert.deepEqual(await run('browser_screenshot', {}), noPage);
  assert.equal(session.active, false);
  assert.equal(staged.length, 0);
});

test('browser_screenshot stages a PNG image with its caption', async () => {
  const { run, staged, session } = setup();
  await run('browser_open', { url: 'https://example.com/pricing' });
  const output = await run('browser_screenshot', { caption: 'Broken pricing table' });
  assert.deepEqual(output, { attached: true, filename: 'screenshot.png', byteLength: PNG_BYTES.byteLength });
  assert.equal(staged.length, 1);
  assert.equal(staged[0]!.kind, 'image');
  assert.equal(staged[0]!.title, 'Broken pricing table');
  assert.deepEqual([...staged[0]!.bytes], [...PNG_BYTES]);
  await session.close();

  const denied = setup({ stage: () => ({ attached: false, reason: 'missing-scope' }) });
  await denied.run('browser_open', { url: 'https://example.com' });
  assert.deepEqual(await denied.run('browser_screenshot'), { attached: false, reason: 'missing-scope' });
  await denied.session.close();
});

test('browser_recording ends the session, downloads the recording, and stages an MP4 file', async () => {
  const { run, staged, fetched, ended, session } = setup({ maxBytes: 8 * 1024 * 1024 });
  await run('browser_open', { url: 'https://example.com/pricing' });
  const output = await run('browser_recording', { caption: 'Checkout flow' });
  assert.equal(output.attached, true);
  assert.equal(output.filename, 'browser-session-20260922-1405.mp4');
  assert.equal(output.byteLength, 2048);
  assert.equal(typeof output.seconds, 'number');
  assert.match(output.note, /browser session has ended/);
  assert.deepEqual(ended, ['sess-1']);
  assert.deepEqual(fetched, ['https://recordings.example/sess-1.mp4?sig=abc']);
  assert.equal(staged[0]!.kind, 'file');
  assert.equal(staged[0]!.title, 'Checkout flow');
  assert.equal(session.active, false);
  // Nothing left to record.
  const again = await run('browser_recording');
  assert.equal(again.attached, false);
  assert.match(again.error, /No browser session is open/);
});

test('browser_recording reports too-large without staging', async () => {
  const { run, staged, session } = setup({ maxBytes: 1024 });
  await run('browser_open', { url: 'https://example.com/pricing' });
  const output = await run('browser_recording');
  assert.equal(output.attached, false);
  assert.equal(output.reason, 'too-large');
  assert.equal(output.byteLength, 2048);
  assert.equal(output.maxBytes, 1024);
  assert.match(output.hint, /larger than this workspace can attach/);
  assert.equal(staged.length, 0);
  assert.equal(session.active, false);
});

test('browser_recording refuses a declared oversize download without reading its body', async () => {
  let bodyRead = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      bodyRead = true;
      controller.enqueue(new Uint8Array(4096));
      controller.close();
    },
  }, { highWaterMark: 0 });
  const { run, staged } = setup({
    maxBytes: 1024,
    recordingResponse: () => new Response(body, { headers: { 'content-length': '4096' } }),
  });
  await run('browser_open', { url: 'https://example.com/pricing' });
  const output = await run('browser_recording');
  assert.equal(output.reason, 'too-large');
  assert.equal(output.byteLength, 4096);
  assert.equal(bodyRead, false);
  assert.equal(staged.length, 0);
});

test('provider failures become error outputs without secrets', async () => {
  const browser = new ScriptedBrowser();
  const { provider } = fakeProvider();
  provider.createSession = async () => {
    throw new Error('connect failed for wss://connect.example/?signingKey=bb_live_secretvalue123 apiKey=bb_live_secretvalue123');
  };
  const session = new BrowserTurnSession({ provider, connect: async () => browser });
  const [open] = createBrowserTools({
    session,
    stageArtifact: async () => ({ attached: false, reason: 'unavailable' }),
    transportMaxBytes: async () => undefined,
  });
  const result = await (open!.run as (context: unknown) => Promise<{ output: { error: string } }>)({
    data: { url: 'https://example.com' },
    toolCallId: 'c',
    log: { info() {}, warn() {}, error() {} },
  });
  assert.match(result.output.error, /connect failed/);
  assert.doesNotMatch(result.output.error, /secretvalue/);
  assert.doesNotMatch(browserErrorMessage(new Error('X-BB-API-Key token=abc123')), /abc123/);
});

test('a missing key surfaces the not-connected message', async () => {
  const { createLazyBrowserProvider } = await import('../src/browser/runtime.ts');
  const provider = createLazyBrowserProvider(async () => undefined);
  const session = new BrowserTurnSession({ provider, connect: async () => new ScriptedBrowser() });
  const [open] = createBrowserTools({
    session,
    stageArtifact: async () => ({ attached: false, reason: 'unavailable' }),
    transportMaxBytes: async () => undefined,
  });
  const result = await (open!.run as (context: unknown) => Promise<{ output: unknown }>)({
    data: { url: 'https://example.com' },
    toolCallId: 'c',
    log: { info() {}, warn() {}, error() {} },
  });
  assert.deepEqual(result.output, { error: 'The browser is not connected. Ask an Admin to connect it in Settings › Browser.' });
});

// ---------------------------------------------------------------------------
// Website logins (S2)
// ---------------------------------------------------------------------------

const PASSWORD = 'pw-Sentinel-9f3c-plaintext';
const USERNAME = 'octo@example.com';
// RFC 6238 seed; at the fixed test clock (2026-09-22T14:05Z) the code is computed by the tool.
const TOTP_SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const LIVE_VIEW_URL = 'https://www.browserbase.com/devtools-fullscreen/inspector.html?wss=connect.browserbase.com/debug/s/devtools&secret=lv-sentinel';

const LOGIN_TREE: AXNode[] = [
  ax('1', 'RootWebArea', { childIds: ['2', '3', '4', '5'] }),
  ax('2', 'textbox', { parentId: '1', label: 'Email', backendDOMNodeId: 11 }),
  ax('3', 'textbox', { parentId: '1', label: 'Password', backendDOMNodeId: 12 }),
  ax('4', 'textbox', { parentId: '1', label: 'Authentication code', backendDOMNodeId: 13 }),
  ax('5', 'button', { parentId: '1', label: 'Sign in', backendDOMNodeId: 14 }),
];

/** A login page that echoes whatever was typed into it, in its text and URL. */
class EchoingLoginBrowser extends ScriptedBrowser {
  inserted: string[] = [];
  constructor() {
    super();
    this.tree = LOGIN_TREE;
    this.responders.set('Input.insertText', (message) => {
      this.inserted.push(String(message.params.text));
      this.tree = [
        ...LOGIN_TREE.slice(0, 1).map((node) => ({ ...node, childIds: [...node.childIds!, '9'] })),
        ...LOGIN_TREE.slice(1),
        ax('9', 'StaticText', { parentId: '1', label: `You typed ${this.inserted.join(' and ')}` }),
      ];
      this.url = `https://github.com/session?echo=${encodeURIComponent(this.inserted.join(','))}`;
      this.title = `Welcome ${this.inserted.at(-1)}`;
      return { result: {} };
    });
  }
}

async function loginSetup(options: {
  provider?: Partial<BrowserProvider>;
  notify?: boolean;
  withLogins?: boolean;
  settings?: SqliteSettingsStore;
} = {}) {
  const settings = options.settings ?? new SqliteSettingsStore(':memory:');
  const deps = { store: settings, keyring: generateCredentialKeyring('browser_tools_test') };
  const existing = await import('../src/browser/logins.ts').then((m) => m.listWebsiteLogins(settings));
  const github = existing.find((login) => login.host === 'github.com') ?? await createWebsiteLogin(deps, {
    host: 'github.com', label: 'GitHub', ownerKind: 'team', createdByMembershipId: 'mem_owner',
    method: 'credentials', username: USERNAME, password: PASSWORD, totpSeed: TOTP_SEED,
  });
  const portal = existing.find((login) => login.host === 'portal.example.com') ?? await createWebsiteLogin(deps, {
    host: 'portal.example.com', label: 'Portal', ownerKind: 'team', createdByMembershipId: 'mem_owner', method: 'handoff',
  });
  const frozen = (login: WebsiteLogin) => ({
    id: login.id, host: login.host, label: login.label, level: 'check' as const, method: login.method,
    ...(login.username ? { username: login.username } : {}),
  });
  const granted = [frozen(github), frozen(portal)];
  const state = { live: [...granted], reads: 0 };
  const browsers: EchoingLoginBrowser[] = [];
  const fake = fakeBrowserProvider({
    async liveView() {
      return { fullscreenUrl: LIVE_VIEW_URL, url: 'https://debug.example/', pages: [] };
    },
    ...options.provider,
  });
  let contexts = 0;
  if (!options.provider?.createContext) {
    fake.provider.createContext = async () => ({ id: `ctx-${(contexts += 1)}` });
  }
  const session = new BrowserTurnSession({
    provider: fake.provider,
    connect: async () => {
      const browser = new EchoingLoginBrowser();
      browsers.push(browser);
      return browser;
    },
    sleep: async () => undefined,
  });
  const notices: Array<{ text: string }> = [];
  const warnings: unknown[] = [];
  const tools = createBrowserTools({
    session,
    stageArtifact: async (input) => ({ attached: true, byteLength: input.bytes.byteLength }),
    transportMaxBytes: async () => undefined,
    sleep: async () => undefined,
    now: () => new Date(Date.UTC(2026, 8, 22, 14, 5)),
    log: { warn: (...args: unknown[]) => { warnings.push(args); } },
    ...(options.withLogins === false ? {} : {
      logins: { granted, readLive: async () => { state.reads += 1; return state.live; }, dependencies: async () => deps },
    }),
    ...(options.notify === false ? {} : { notifyRequester: async (message: { text: string }) => { notices.push(message); } }),
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const run = async (name: string, data: Record<string, unknown> = {}): Promise<any> => {
    const tool = byName.get(name)!;
    const parsed = v.parse(tool.input as v.GenericSchema, data);
    const result = await (tool.run as (context: unknown) => Promise<{ output: unknown }>)({
      data: parsed, toolCallId: 'call_1', log: { info() {}, warn() {}, error() {} },
    });
    return JSON.parse(JSON.stringify(result.output));
  };
  return { settings, deps, github, portal, granted, state, browsers, session, notices, warnings, run, ...fake };
}

test('browser_open binds a granted host and its subdomains, and switches sessions when the site changes', async () => {
  const { run, created, ended, github, portal, settings, session } = await loginSetup();
  const first = await run('browser_open', { url: 'https://github.com/settings/profile' });
  assert.deepEqual(first.login, { id: github.id, label: 'GitHub', host: 'github.com', method: 'credentials', level: 'check' });
  assert.deepEqual(created[0], {
    recording: true, viewport: { width: 1280, height: 800 }, timeoutSeconds: 660,
    contextId: 'ctx-1', persistContext: true, allowedDomains: ['github.com'],
  });
  // The context is created once and remembered on the login.
  assert.equal((await getWebsiteLogin(settings, github.id))?.contextId, 'ctx-1');
  // A subdomain of the login host stays in the same bound session.
  const gist = await run('browser_open', { url: 'gist.github.com/octo' });
  assert.equal(gist.login.id, github.id);
  assert.equal(created.length, 1);
  // A public site ends the bound session and opens a public one.
  const publicPage = await run('browser_open', { url: 'https://example.com/' });
  assert.equal(publicPage.login, undefined);
  assert.deepEqual(ended, ['sess-1']);
  assert.equal(created[1]?.contextId, undefined);
  // A different login's site switches again, with its own context.
  const portalPage = await run('browser_open', { url: 'https://portal.example.com/home' });
  assert.equal(portalPage.login.id, portal.id);
  assert.deepEqual(ended, ['sess-1', 'sess-2']);
  assert.equal(created[2]?.contextId, 'ctx-2');
  assert.equal(session.binding?.loginId, portal.id);
  // Look-alike hosts and other ports are not the login's site.
  assert.equal((await run('browser_open', { url: 'https://notgithub.com/' })).login, undefined);
  assert.equal((await run('browser_open', { url: 'https://github.com:8443/' })).login, undefined);
  // A search never binds.
  assert.equal((await run('browser_open', { url: 'github login page' })).login, undefined);
  await session.close();
});

test('browser_open reuses a stored context, and a loginId must match the site', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const firstTurn = await loginSetup({ settings });
  await firstTurn.run('browser_open', { url: 'https://github.com/' });
  await firstTurn.session.close();
  const secondTurn = await loginSetup({ settings, provider: { createContext: async () => { throw new Error('should reuse'); } } });
  await secondTurn.run('browser_open', { url: 'https://github.com/' });
  assert.equal(secondTurn.created[0]?.contextId, 'ctx-1');
  const wrong = await secondTurn.run('browser_open', { url: 'https://example.com/', loginId: secondTurn.github.id });
  assert.match(wrong.error, /That login is for github\.com/);
  const unknown = await secondTurn.run('browser_open', { url: 'https://github.com/', loginId: 'wl_nope' });
  assert.match(unknown.error, /no website login with that id/);
  await secondTurn.session.close();
});

test('a grant revoked mid-turn refuses the site and closes its signed-in browser when it is next bound', async () => {
  const { run, state, github, ended, session } = await loginSetup();
  await run('browser_open', { url: 'https://github.com/' });
  state.live = state.live.filter(({ id }) => id !== github.id);
  // Reading the open page does not re-check grants.
  assert.ok((await run('browser_snapshot')).snapshot);
  const reopened = await run('browser_open', { url: 'https://github.com/' });
  assert.match(reopened.error, /access to that website login was removed.*browser was closed/);
  assert.deepEqual(ended, ['sess-1']);
  assert.equal(session.active, false);
  assert.match((await run('browser_open', { url: 'https://github.com/' })).error, /access to that website login was removed/);
  assert.match((await run('browser_sign_in', { loginId: github.id, passwordRef: 'e2' })).error, /access to that website login was removed/);
  assert.match((await run('browser_handoff', { loginId: github.id, reason: 'x' })).error, /access to that website login was removed/);
});

test('live grants are read once at mount and again only to bind, sign in, or claim', async () => {
  const { run, state, github, session } = await loginSetup();
  await run('browser_open', { url: 'https://github.com/' });
  // Mount intersection, then the binding check.
  assert.equal(state.reads, 2);
  await run('browser_snapshot');
  await run('browser_screenshot');
  await run('browser_act', { ref: 'e5', action: 'hover' });
  assert.equal(state.reads, 2);
  await run('browser_sign_in', { loginId: github.id, passwordRef: 'e3' });
  assert.equal(state.reads, 3);
  // Opening another page on the bound site re-checks once.
  await run('browser_open', { url: 'https://github.com/settings' });
  assert.equal(state.reads, 4);
  await session.close();
});

test('browser_sign_in types the stored secrets through fillSecret and never leaks them', async () => {
  const { run, browsers, github, settings, session } = await loginSetup();
  await run('browser_open', { url: 'https://github.com/login' });
  const result = await run('browser_sign_in', {
    loginId: github.id, usernameRef: 'e1', passwordRef: 'e2', codeRef: 'e3', submitRef: 'e4',
  });
  const browser = browsers[0]!;
  const [username, password, code] = browser.inserted;
  assert.equal(username, USERNAME);
  assert.equal(password, PASSWORD);
  assert.match(code ?? '', /^\d{6}$/);
  // Each value went in through focus + insertText on its own field.
  const focused = browser.sent.filter((m) => m.method === 'DOM.focus').map((m) => m.params.backendNodeId);
  assert.deepEqual(focused, [11, 12, 13]);
  // Submitted by clicking the button (no Enter key needed).
  assert.equal(browser.sent.filter((m) => m.method === 'Input.dispatchMouseEvent' && m.params.type === 'mousePressed').length, 1);
  assert.equal(result.signedIn, 'unknown');
  assert.match(result.note, /Judge from the page/);
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, new RegExp(PASSWORD));
  assert.doesNotMatch(text, new RegExp(code!));
  assert.match(result.snapshot, /You typed octo@example\.com and \[redacted\] and \[redacted\]/);
  assert.match(result.title, /\[redacted\]/);
  // Later reads keep redacting for the rest of the turn.
  assert.doesNotMatch(JSON.stringify(await run('browser_snapshot')), new RegExp(PASSWORD));
  assert.ok((await getWebsiteLogin(settings, github.id))?.lastUsedAt);
  await session.close();
});

test('browser_sign_in without a submit ref presses Enter in the last field, and errors stay redacted', async () => {
  const { run, browsers, github, session } = await loginSetup();
  await run('browser_open', { url: 'https://github.com/login' });
  await run('browser_sign_in', { loginId: github.id, usernameRef: 'e1', passwordRef: 'e2' });
  const browser = browsers[0]!;
  const enter = browser.sent.filter((m) => m.method === 'Input.dispatchKeyEvent' && m.params.key === 'Enter');
  assert.equal(enter.length, 2);
  // The Enter went to the password field, the last one filled.
  const focusedLast = browser.sent.filter((m) => m.method === 'DOM.focus').at(-1)?.params.backendNodeId;
  assert.equal(focusedLast, 12);
  // A failure whose message echoes the password is redacted.
  browser.responders.set('DOM.getBoxModel', () => ({ error: { code: -1, message: `node ${PASSWORD} detached` } }));
  browser.responders.set('Input.insertText', () => ({ error: { code: -1, message: `cannot insert ${PASSWORD}` } }));
  await run('browser_snapshot');
  const failed = await run('browser_sign_in', { loginId: github.id, passwordRef: 'e2' });
  assert.ok(failed.error);
  assert.doesNotMatch(JSON.stringify(failed), new RegExp(PASSWORD));
  await session.close();
});

test('browser_sign_in refuses without a bound session, without fields, and for hand-off logins', async () => {
  const { run, github, portal, session } = await loginSetup();
  assert.match((await run('browser_sign_in', { loginId: github.id, passwordRef: 'e2' })).error, /Open github\.com with browser_open first/);
  await run('browser_open', { url: 'https://example.com/' });
  assert.match((await run('browser_sign_in', { loginId: github.id, passwordRef: 'e2' })).error, /Open github\.com/);
  await run('browser_open', { url: 'https://github.com/' });
  assert.match((await run('browser_sign_in', { loginId: github.id })).error, /at least one sign-in field/);
  assert.match((await run('browser_sign_in', { loginId: portal.id, passwordRef: 'e2' })).error, /Portal has no saved password.*browser_handoff/);
  assert.match((await run('browser_sign_in', { loginId: 'wl_nope', passwordRef: 'e2' })).error, /no website login with that id/);
  await session.close();
});

test('the sign-in tools explain when the Agent has no website logins', async () => {
  const { run, session } = await loginSetup({ withLogins: false });
  assert.match((await run('browser_sign_in', { loginId: 'wl_x', passwordRef: 'e1' })).error, /no website logins/);
  assert.match((await run('browser_handoff', { loginId: 'wl_x', reason: 'x' })).error, /no website logins/);
  // Browsing is unchanged: a would-be login host opens publicly.
  const opened = await run('browser_open', { url: 'https://github.com/' });
  assert.equal(opened.login, undefined);
  assert.equal(opened.title, 'Example Pricing');
  await session.close();
});

test('browser_handoff sends a private live-view link, detaches the session, and keeps the link out of outputs', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const { run, notices, created, ended, portal, session } = await loginSetup({ settings });
  await run('browser_open', { url: 'https://portal.example.com/reports?q=1' });
  const result = await run('browser_handoff', { loginId: portal.id, reason: 'The portal needs a person to sign in.' });
  assert.deepEqual(result, {
    handedOff: true,
    host: 'portal.example.com',
    note: 'Tell the person you have sent them a private sign-in link and that you will continue when they reply. End your reply now.',
  });
  assert.doesNotMatch(JSON.stringify(result), /lv-sentinel|browserbase\.com/);
  // The bound browsing session ended; the hand-off session is kept alive and detached.
  assert.deepEqual(ended, ['sess-1']);
  assert.equal(created[1]?.keepAlive, true);
  assert.equal(created[1]?.timeoutSeconds, 600);
  assert.equal(created[1]?.contextId, created[0]?.contextId);
  assert.equal(session.active, false);
  assert.equal(await session.close(), undefined);
  assert.deepEqual(ended, ['sess-1']);
  assert.equal((await getWebsiteLogin(settings, portal.id))?.handoffSessionId, 'sess-2');
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.text, browserHandoffMessage('portal.example.com', LIVE_VIEW_URL));
  assert.match(notices[0]!.text, /^portal\.example\.com needs you to sign in before I can continue\. <https:\/\/www\.browserbase\.com\/.*&amp;secret=lv-sentinel\|Open the browser> and sign in; it stays open for 10 minutes/);
  // Browsing that site again this turn waits for the person.
  assert.match((await run('browser_open', { url: 'https://portal.example.com/' })).error, /already sent the person a private sign-in link/);
  assert.match((await run('browser_handoff', { loginId: portal.id, reason: 'again' })).error, /already sent/);

  // The next turn ends the kept-alive session first so its sign-in is saved.
  const next = await loginSetup({ settings });
  await next.run('browser_open', { url: 'https://portal.example.com/' });
  assert.deepEqual(next.ended, ['sess-2']);
  assert.equal((await getWebsiteLogin(settings, portal.id))?.handoffSessionId, undefined);
  await next.session.close();
});

test('browser_handoff continues from the page reached on that site', async () => {
  const { run, browsers, portal } = await loginSetup();
  await run('browser_open', { url: 'https://portal.example.com/reports?q=1' });
  await run('browser_handoff', { loginId: portal.id, reason: 'sign in' });
  const navigated = browsers[1]!.sent.find((m) => m.method === 'Page.navigate')?.params.url;
  assert.equal(navigated, 'https://portal.example.com/reports?q=1');
});

test('browser_handoff refuses without keep-alive support or a requester, and cleans up a failed send', async () => {
  const paid = await loginSetup({
    provider: {
      async createSession(options) {
        if (options.keepAlive) {
          throw new BrowserProviderError('Browserbase POST /v1/sessions returned 402: upgrade your plan to use keepAlive', 402);
        }
        return { id: 'sess-x', connectUrl: 'wss://connect.example/' };
      },
    },
  });
  const refused = await paid.run('browser_handoff', { loginId: paid.portal.id, reason: 'sign in' });
  assert.match(refused.error, /needs a paid Browserbase plan/);
  assert.equal(paid.notices.length, 0);

  const scheduled = await loginSetup({ notify: false });
  const noPerson = await scheduled.run('browser_handoff', { loginId: scheduled.portal.id, reason: 'sign in' });
  assert.match(noPerson.error, /no person in this conversation/);
  assert.equal(scheduled.created.length, 0);

  const broken = await loginSetup();
  const tools = createBrowserTools({
    session: broken.session,
    stageArtifact: async () => ({ attached: false, reason: 'unused' } as never),
    transportMaxBytes: async () => undefined,
    sleep: async () => undefined,
    logins: { granted: broken.granted, readLive: async () => broken.state.live, dependencies: async () => broken.deps },
    notifyRequester: async () => { throw new Error(`channel_not_found ${LIVE_VIEW_URL}`); },
  });
  const handoffTool = tools.find((tool) => tool.name === 'browser_handoff')!;
  const failed = await (handoffTool.run as (context: unknown) => Promise<{ output: any }>)({
    data: { loginId: broken.portal.id, reason: 'sign in' }, toolCallId: 'c', log: { info() {}, warn() {}, error() {} },
  });
  assert.match(failed.output.error, /could not be sent/);
  assert.doesNotMatch(JSON.stringify(failed.output), /lv-sentinel/);
  // The kept-alive session was ended rather than left open.
  assert.deepEqual(broken.ended, ['sess-1']);
  assert.equal(broken.session.active, false);
});

test('the requester notifier posts ephemerally in channels and group DMs, and directly only in a 1:1 DM', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client = {
    postMessage: async (args: Record<string, unknown>) => { calls.push(['postMessage', args]); },
    postEphemeral: async (args: Record<string, unknown>) => { calls.push(['postEphemeral', args]); },
  };
  const requester = { slackUserId: 'U123', channelId: 'C999' };
  await createSlackRequesterNotifier({
    requester: { ...requester, conversationKind: 'channel' }, surface: 'channel_thread', threadTs: '1.2', client: async () => client,
  })({ text: 'hi' });
  await createSlackRequesterNotifier({
    requester: { ...requester, channelId: 'D1', conversationKind: 'im' }, surface: 'direct_message', client: async () => client,
  })({ text: 'hi' });
  await createSlackRequesterNotifier({
    requester: { ...requester, channelId: 'G1', conversationKind: 'mpim' }, surface: 'direct_message', threadTs: '3.4', client: async () => client,
  })({ text: 'hi' });
  await createSlackRequesterNotifier({
    requester: { ...requester, channelId: 'D2' }, surface: 'direct_message', client: async () => client,
  })({ text: 'hi' });
  assert.deepEqual(calls, [
    ['postEphemeral', { channel: 'C999', user: 'U123', text: 'hi', thread_ts: '1.2' }],
    ['postMessage', { channel: 'D1', text: 'hi', unfurl_links: false, unfurl_media: false }],
    ['postEphemeral', { channel: 'G1', user: 'U123', text: 'hi', thread_ts: '3.4' }],
    ['postEphemeral', { channel: 'D2', user: 'U123', text: 'hi' }],
  ]);
});

// ---------------------------------------------------------------------------
// Login levels and approval before data-changing steps (S3)
// ---------------------------------------------------------------------------

const FORM_TREE: AXNode[] = [
  ax('1', 'RootWebArea', { childIds: ['2', '3', '4', '5'] }),
  ax('2', 'textbox', { parentId: '1', label: 'Customer name', backendDOMNodeId: 21 }),
  ax('3', 'button', { parentId: '1', label: 'Cancel', backendDOMNodeId: 22 }),
  ax('4', 'button', { parentId: '1', label: 'Confirm change', backendDOMNodeId: 23 }),
  ax('5', 'link', { parentId: '1', label: 'Help', backendDOMNodeId: 24 }),
];
// The same page in a new session: another element first, so every ref shifts.
const FORM_TREE_SHIFTED: AXNode[] = [
  ax('1', 'RootWebArea', { childIds: ['9', '2', '3', '4', '5'] }),
  ax('9', 'link', { parentId: '1', label: 'Skip to content', backendDOMNodeId: 30 }),
  ...FORM_TREE.slice(1),
];
const TURN_1_TS = '1800000001.000100';
const TURN_2_TS = '1800000002.000100';

class FormBrowser extends ScriptedBrowser {
  inserted: string[] = [];
  redirectTo: string | undefined;
  constructor(tree: AXNode[]) {
    super();
    this.tree = tree;
    const navigate = this.responders.get('Page.navigate')!;
    this.responders.set('Page.navigate', (message) => {
      const reply = navigate(message);
      if (this.redirectTo) this.url = this.redirectTo;
      return reply;
    });
    this.responders.set('Input.insertText', (message) => {
      this.inserted.push(String(message.params.text));
      return { result: {} };
    });
    this.responders.set('DOM.getBoxModel', (message) => {
      const id = Number(message.params.backendNodeId);
      return { result: { model: { content: [id, id, id + 2, id, id + 2, id + 2, id, id + 2] } } };
    });
  }
  /** Backend node ids of elements clicked, by their box centre. */
  clicked(): number[] {
    return this.sent
      .filter((m) => m.method === 'Input.dispatchMouseEvent' && m.params.type === 'mousePressed')
      .map((m) => Number(m.params.x) - 1);
  }
}

async function actTurn(options: {
  settings: SqliteSettingsStore;
  messageTs: string;
  level?: 'check' | 'act';
  liveLevel?: 'check' | 'act';
  tree?: AXNode[];
  redirectTo?: string;
  approvals?: boolean;
}) {
  const deps = { store: options.settings, keyring: generateCredentialKeyring('browser_tools_test') };
  const existing = await import('../src/browser/logins.ts').then((m) => m.listWebsiteLogins(options.settings));
  const billing = existing.find((login) => login.host === 'billing.example.com') ?? await createWebsiteLogin(deps, {
    host: 'billing.example.com', label: 'Billing', ownerKind: 'team', createdByMembershipId: 'mem_owner', method: 'handoff',
  });
  const granted = [{ id: billing.id, host: billing.host, label: billing.label, level: options.level ?? 'act', method: billing.method }];
  const live = [{ ...granted[0]!, level: options.liveLevel ?? options.level ?? 'act' }];
  const fake = fakeBrowserProvider();
  fake.provider.createContext = async () => ({ id: 'ctx-billing' });
  const browsers: FormBrowser[] = [];
  const session = new BrowserTurnSession({
    provider: fake.provider,
    connect: async () => {
      const browser = new FormBrowser(options.tree ?? FORM_TREE);
      if (options.redirectTo) browser.redirectTo = options.redirectTo;
      browsers.push(browser);
      return browser;
    },
    sleep: async () => undefined,
  });
  const staged: SlackArtifactStageInput[] = [];
  let waiting = 0;
  let liveReads = 0;
  const tools = createBrowserTools({
    session,
    stageArtifact: async (input) => {
      staged.push(input);
      return { attached: true, byteLength: input.bytes.byteLength };
    },
    transportMaxBytes: async () => undefined,
    sleep: async () => undefined,
    now: () => new Date(Date.UTC(2026, 8, 22, 14, 5)),
    logins: { granted, readLive: async () => { liveReads += 1; return live; }, dependencies: async () => deps },
    ...(options.approvals === false ? {} : {
      approvals: {
        scope: {
          workspaceId: 'T_TEST', channelId: 'C_TEST', threadTs: '1800000000.000100', agentId: 'agent_ops',
          actorSlackUserId: 'U_ASKER', actorMembershipId: 'membership_asker',
        },
        messageTs: options.messageTs,
        settings: async () => options.settings,
        onAwaitingApproval: () => { waiting += 1; },
      },
    }),
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const run = async (name: string, data: Record<string, unknown> = {}): Promise<any> => {
    const tool = byName.get(name)!;
    const parsed = v.parse(tool.input as v.GenericSchema, data);
    const result = await (tool.run as (context: unknown) => Promise<{ output: unknown }>)({
      data: parsed, toolCallId: 'call_1', log: { info() {}, warn() {}, error() {} },
    });
    return JSON.parse(JSON.stringify(result.output));
  };
  return { run, session, browsers, staged, billing, waiting: () => waiting, liveReads: () => liveReads, ...fake };
}

async function approveFromSlack(settings: SqliteSettingsStore, messageTs: string) {
  const { resolveBrowserActionReply } = await import('../src/browser/actions.ts');
  return resolveBrowserActionReply({
    settings,
    word: 'approve',
    scope: {
      workspaceId: 'T_TEST', channelId: 'C_TEST', threadTs: '1800000000.000100', agentId: 'agent_ops',
      actorSlackUserId: 'U_ASKER', actorMembershipId: 'membership_asker',
    },
    messageTs,
    now: Date.UTC(2026, 8, 22, 14, 6),
  });
}

test('a check-only login keeps its session read-only and names the site in the refusal', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const turn = await actTurn({ settings, messageTs: TURN_1_TS, level: 'check' });
  const opened = await turn.run('browser_open', { url: 'https://billing.example.com/plan' });
  assert.equal(opened.login.level, 'check');
  assert.equal(turn.session.policy.readOnly, true);
  const output = await turn.run('browser_act', { ref: 'e3', action: 'click', mayChangeData: true });
  assert.deepEqual(output, {
    refused: true,
    reason: 'This login allows checking only. Ask an Admin to allow actions on billing.example.com if this step should be taken.',
  });
  assert.deepEqual(turn.browsers[0]!.clicked(), []);
  await turn.session.close();
});

test('an action login holds a data-changing step for approval with a screenshot, then takes it once after approval', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const ask = await actTurn({ settings, messageTs: TURN_1_TS });
  const opened = await ask.run('browser_open', { url: 'https://billing.example.com/plan' });
  assert.equal(opened.login.level, 'act');
  assert.equal(ask.session.policy.readOnly, false);
  // Filling a field is not data-changing and happens right away.
  await ask.run('browser_act', { ref: 'e1', action: 'type', text: 'Ada Lovelace' });
  assert.deepEqual(ask.browsers[0]!.inserted, ['Ada Lovelace']);

  const readsBeforeAsking = ask.liveReads();
  const held = await ask.run('browser_act', { ref: 'e3', action: 'click', mayChangeData: true });
  // Asking relies on the grants read at mount and binding.
  assert.equal(ask.liveReads(), readsBeforeAsking);
  assert.deepEqual(Object.keys(held).sort(), ['actionId', 'awaitingApproval', 'description', 'instruction']);
  assert.equal(held.awaitingApproval, true);
  assert.match(held.actionId, /^[a-f0-9]{32}$/);
  assert.equal(held.description, 'click "Confirm change"');
  assert.equal(held.instruction, 'Ask the person to reply exactly "approve" in this thread to let you take this step, or "stop". End your reply after asking.');
  assert.deepEqual(ask.browsers[0]!.clicked(), [21], 'only the field was clicked; the button waits');
  assert.equal(ask.staged.length, 1);
  assert.equal(ask.staged[0]!.kind, 'image');
  assert.equal(ask.staged[0]!.title, 'About to: click "Confirm change"');
  assert.match(ask.staged[0]!.filename, /\.jpg$/);
  assert.deepEqual([...ask.staged[0]!.bytes], [...JPEG_BYTES]);
  assert.equal(ask.waiting(), 1);
  // Approval in this same turn is not possible: the person has not replied yet.
  assert.match((await ask.run('browser_act', { ref: 'e3', action: 'click', approvedActionId: held.actionId })).error, /has not approved/);
  await ask.session.close();

  // The person replies "approve"; the next turn reopens the page in a new
  // session where every ref has shifted, restores the typed name, and clicks
  // the same button by its role and name.
  assert.deepEqual(await approveFromSlack(settings, TURN_2_TS), { kind: 'approved', id: held.actionId });
  const approved = await actTurn({ settings, messageTs: TURN_2_TS, tree: FORM_TREE_SHIFTED });
  const done = await approved.run('browser_act', { ref: 'e3', action: 'click', approvedActionId: held.actionId });
  assert.equal(done.approvedStepTaken, 'click "Confirm change"');
  // One live read covers the claim and binding the new session.
  assert.equal(approved.liveReads(), 1);
  assert.match(done.snapshot, /button "Confirm change" \[ref=e4\]/);
  const browser = approved.browsers[0]!;
  assert.ok(browser.sent.some((m) => m.method === 'Page.navigate' && m.params.url === 'https://billing.example.com/plan'));
  assert.deepEqual(browser.inserted, ['Ada Lovelace']);
  assert.deepEqual(browser.clicked(), [21, 23]);
  assert.equal(approved.created[0]?.contextId, 'ctx-billing');
  // Spent: a second use is refused and nothing more is clicked.
  assert.match((await approved.run('browser_act', { ref: 'e4', action: 'click', approvedActionId: held.actionId })).error, /already used/);
  assert.deepEqual(browser.clicked(), [21, 23]);
  await approved.session.close();
});

test('an approved step is refused when the page changed, moved host, expired, or the grant was lowered', async () => {
  const setupHeld = async () => {
    const settings = new SqliteSettingsStore(':memory:');
    const ask = await actTurn({ settings, messageTs: TURN_1_TS });
    await ask.run('browser_open', { url: 'https://billing.example.com/plan' });
    const held = await ask.run('browser_act', { ref: 'e3', action: 'click', mayChangeData: true });
    await ask.session.close();
    await approveFromSlack(settings, TURN_2_TS);
    return { settings, held };
  };

  // The button is gone from the page.
  {
    const { settings, held } = await setupHeld();
    const turn = await actTurn({ settings, messageTs: TURN_2_TS, tree: FORM_TREE.filter((node) => node.nodeId !== '4') });
    const output = await turn.run('browser_act', { ref: 'e3', action: 'click', approvedActionId: held.actionId });
    assert.equal(output.error, 'The page changed since approval; take a new snapshot and ask again if the step is still right.');
    assert.deepEqual(turn.browsers[0]!.clicked(), []);
    await turn.session.close();
  }
  // The recorded URL now lands on another host.
  {
    const { settings, held } = await setupHeld();
    const turn = await actTurn({ settings, messageTs: TURN_2_TS, redirectTo: 'https://sso.other-host.example/login' });
    const output = await turn.run('browser_act', { ref: 'e3', action: 'click', approvedActionId: held.actionId });
    assert.equal(output.error, 'The page changed since approval; take a new snapshot and ask again if the step is still right.');
    assert.deepEqual(turn.browsers[0]!.clicked(), []);
    await turn.session.close();
  }
  // The grant was lowered to checking only after approval.
  {
    const { settings, held } = await setupHeld();
    const turn = await actTurn({ settings, messageTs: TURN_2_TS, liveLevel: 'check' });
    const output = await turn.run('browser_act', { ref: 'e3', action: 'click', approvedActionId: held.actionId });
    assert.match(output.error, /This login allows checking only/);
    assert.equal(turn.session.active, false);
  }
  // Expired before the approved turn ran.
  {
    const { settings, held } = await setupHeld();
    const raw = await settings.getSetting(`browseraction_${held.actionId}`);
    await settings.setSetting(`browseraction_${held.actionId}`, JSON.stringify({ ...JSON.parse(raw!), expiresAt: 1 }));
    const turn = await actTurn({ settings, messageTs: TURN_2_TS });
    const output = await turn.run('browser_act', { ref: 'e3', action: 'click', approvedActionId: held.actionId });
    assert.match(output.error, /approval expired/);
    assert.equal(turn.session.active, false);
  }
  // Another message's turn cannot use the approval.
  {
    const { settings, held } = await setupHeld();
    const turn = await actTurn({ settings, messageTs: '1800000003.000100' });
    const output = await turn.run('browser_act', { ref: 'e3', action: 'click', approvedActionId: held.actionId });
    assert.match(output.error, /has not approved/);
  }
});

test('a data-changing step without a person to ask, or after a live downgrade, is refused', async () => {
  const settings = new SqliteSettingsStore(':memory:');
  const scheduled = await actTurn({ settings, messageTs: TURN_1_TS, approvals: false });
  await scheduled.run('browser_open', { url: 'https://billing.example.com/plan' });
  assert.match((await scheduled.run('browser_act', { ref: 'e3', action: 'click', mayChangeData: true })).error, /no person in this conversation to approve/);
  assert.deepEqual(scheduled.staged, []);
  await scheduled.session.close();

  const lowered = await actTurn({ settings, messageTs: TURN_1_TS, liveLevel: 'check' });
  await lowered.run('browser_open', { url: 'https://billing.example.com/plan' });
  const output = await lowered.run('browser_act', { ref: 'e3', action: 'click', mayChangeData: true });
  assert.equal(output.refused, true);
  assert.match(output.reason, /checking only/);
  await lowered.session.close();
});
