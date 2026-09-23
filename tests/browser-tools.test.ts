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

test('the browser toolset exposes the six tools in a stable order', () => {
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
    reason: 'Changing data on websites is not available yet. This version can read and navigate only.',
  });
  assert.equal(browser.sent.length, 0);
  assert.equal(session.active, false);
});

test('a session whose policy allows changes lets a data-changing action through', async () => {
  const { run, browser, session } = setup({ readOnly: false });
  await run('browser_open', { url: 'https://example.com/pricing' });
  const output = await run('browser_act', { ref: 'e1', action: 'click', mayChangeData: true });
  assert.equal(output.refused, undefined);
  assert.ok(browser.methods().includes('Input.dispatchMouseEvent'));
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
