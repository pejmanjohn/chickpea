import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpClient } from '../src/browser/cdp.ts';
import { BrowserPage, type AXNode } from '../src/browser/page.ts';
import { FakeCdpSocket } from './helpers/fake-cdp-socket.ts';

const SESSION = 'page-sess';

function setup() {
  const socket = new FakeCdpSocket();
  socket.responders.set('Runtime.evaluate', (message) => {
    const expression = String(message.params.expression);
    if (expression.includes('location.href')) {
      return { result: { result: { type: 'object', value: { url: 'https://example.com/', title: 'Example Domain' } } } };
    }
    if (expression === 'document.readyState') return { result: { result: { type: 'string', value: 'complete' } } };
    return { result: { result: { type: 'number', value: 42 } } };
  });
  const client = new CdpClient(socket);
  const page = new BrowserPage(client, SESSION, { sleep: async () => undefined });
  return { socket, client, page };
}

const ax = (
  nodeId: string,
  role: string,
  extra: Partial<Omit<AXNode, 'nodeId' | 'role' | 'name'>> & { name?: string } = {},
): AXNode => {
  const { name, ...rest } = extra;
  const node: AXNode = { nodeId, role: { type: 'role', value: role }, ...rest };
  if (name !== undefined) node.name = { type: 'computedString', value: name };
  return node;
};

const SAMPLE_TREE: AXNode[] = [
  ax('1', 'RootWebArea', { name: 'Example Domain', childIds: ['2'], backendDOMNodeId: 1 }),
  ax('2', 'generic', { parentId: '1', childIds: ['3', '4', '5', '6', '8', '9', '10', '12'] }),
  ax('3', 'heading', {
    parentId: '2', name: 'Example Domain', childIds: ['31'], backendDOMNodeId: 10,
    properties: [{ name: 'level', value: { type: 'integer', value: 1 } }],
  }),
  ax('31', 'StaticText', { parentId: '3', name: 'Example Domain', childIds: ['311'] }),
  ax('311', 'InlineTextBox', { parentId: '31', name: 'Example Domain' }),
  ax('4', 'paragraph', { parentId: '2', childIds: ['41'] }),
  ax('41', 'StaticText', { parentId: '4', name: 'This domain is for   use in examples.' }),
  ax('5', 'link', { parentId: '2', name: 'Learn more', childIds: ['51'], backendDOMNodeId: 20 }),
  ax('51', 'StaticText', { parentId: '5', name: 'Learn more' }),
  ax('6', 'list', { parentId: '2', childIds: ['7'] }),
  ax('7', 'listitem', { parentId: '6', childIds: ['71'], backendDOMNodeId: 25 }),
  ax('71', 'link', { parentId: '7', name: 'Docs "v2"', backendDOMNodeId: 26 }),
  ax('8', 'textbox', { parentId: '2', name: 'Email', backendDOMNodeId: 30, value: { type: 'string', value: 'a@b.co' } }),
  ax('9', 'img', { parentId: '2', backendDOMNodeId: 35 }),
  ax('10', 'generic', { parentId: '2', ignored: true, childIds: ['101'] }),
  ax('101', 'button', { parentId: '10', name: 'Go', backendDOMNodeId: 40 }),
  ax('12', 'generic', { parentId: '2', name: 'Footer note' }),
];

test('snapshot renders a compact indented tree with refs for interactive nodes', async () => {
  const { socket, page, client } = setup();
  socket.responders.set('Accessibility.getFullAXTree', () => ({ result: { nodes: SAMPLE_TREE } }));
  const snap = await page.snapshot();
  assert.equal(
    snap.text,
    [
      '- heading "Example Domain" level=1',
      '- text "This domain is for use in examples."',
      '- link "Learn more" [ref=e1]',
      '- listitem',
      '  - link "Docs \\"v2\\"" [ref=e2]',
      '- textbox "Email" [ref=e3] value="a@b.co"',
      '- button "Go" [ref=e4]',
      '- generic "Footer note"',
    ].join('\n'),
  );
  assert.equal(snap.nodeCount, 8);
  assert.equal(snap.truncated, false);
  assert.equal(snap.url, 'https://example.com/');
  assert.equal(snap.title, 'Example Domain');
  assert.deepEqual([...page.refs.entries()], [
    ['e1', { backendDOMNodeId: 20, role: 'link', name: 'Learn more' }],
    ['e2', { backendDOMNodeId: 26, role: 'link', name: 'Docs "v2"' }],
    ['e3', { backendDOMNodeId: 30, role: 'textbox', name: 'Email' }],
    ['e4', { backendDOMNodeId: 40, role: 'button', name: 'Go' }],
  ]);
  assert.equal(socket.sent[0]!.sessionId, SESSION);
  client.close();
});

test('snapshot truncates at maxNodes, long names at 120 chars, and drops refs past the cut', async () => {
  const { socket, page, client } = setup();
  const long = 'x'.repeat(200);
  socket.responders.set('Accessibility.getFullAXTree', () => ({
    result: {
      nodes: [
        ax('1', 'RootWebArea', { childIds: ['2', '3', '4'] }),
        ax('2', 'button', { parentId: '1', name: long, backendDOMNodeId: 2 }),
        ax('3', 'button', { parentId: '1', name: 'Two', backendDOMNodeId: 3 }),
        ax('4', 'button', { parentId: '1', name: 'Three', backendDOMNodeId: 4 }),
      ],
    },
  }));
  const snap = await page.snapshot({ maxNodes: 2 });
  assert.equal(snap.text, `- button "${'x'.repeat(120)}…" [ref=e1]\n- button "Two" [ref=e2]\n… (1 more nodes)`);
  assert.equal(snap.truncated, true);
  assert.equal(snap.nodeCount, 3);
  assert.deepEqual([...page.refs.keys()], ['e1', 'e2']);
  client.close();
});

test('navigate enables Page once, waits for loadEventFired, and returns url and title', async () => {
  const { socket, client } = setup();
  // Real sleep so readyState polling (after 500ms) cannot beat the load event.
  const page = new BrowserPage(client, SESSION);
  socket.responders.set('Page.navigate', () => {
    setTimeout(() => socket.emitEvent('Page.loadEventFired', {}, SESSION), 5);
    return { result: { frameId: 'f1', loaderId: 'l1' } };
  });
  const info = await page.navigate('https://example.com', { timeoutMs: 2000 });
  assert.deepEqual(info, { url: 'https://example.com/', title: 'Example Domain' });
  assert.deepEqual(socket.log, ['Page.enable', 'Page.navigate', 'event:Page.loadEventFired', 'Runtime.evaluate']);
  assert.deepEqual(socket.sent[1]!.params, { url: 'https://example.com' });
  assert.equal(socket.sent[1]!.sessionId, SESSION);
  await page.navigate('https://example.com/two', { timeoutMs: 2000 });
  assert.equal(socket.methods().filter((m) => m === 'Page.enable').length, 1);
  client.close();
});

test('navigate falls back to readyState polling when no load event arrives', async () => {
  const { socket, page, client } = setup();
  socket.responders.set('Page.navigate', () => ({ result: { frameId: 'f1', loaderId: 'l1' } }));
  const info = await page.navigate('https://example.com', { timeoutMs: 5000 });
  assert.equal(info.title, 'Example Domain');
  const evaluated = socket.sent.filter((m) => m.method === 'Runtime.evaluate').map((m) => m.params.expression);
  assert.equal(evaluated[0], 'document.readyState');
  client.close();
});

test('navigate surfaces Page.navigate errorText', async () => {
  const { socket, page, client } = setup();
  socket.responders.set('Page.navigate', () => ({ result: { frameId: 'f1', errorText: 'net::ERR_NAME_NOT_RESOLVED' } }));
  await assert.rejects(page.navigate('https://nope.invalid', { timeoutMs: 1000 }), /ERR_NAME_NOT_RESOLVED/);
  client.close();
});

async function pageWithRefs() {
  const ctx = setup();
  ctx.socket.responders.set('Accessibility.getFullAXTree', () => ({ result: { nodes: SAMPLE_TREE } }));
  ctx.socket.responders.set('DOM.getBoxModel', () => ({
    result: { model: { content: [10, 20, 110, 20, 110, 60, 10, 60], border: [], width: 100, height: 40 } },
  }));
  await ctx.page.snapshot();
  ctx.socket.sent.length = 0;
  ctx.socket.log.length = 0;
  return ctx;
}

const mouse = (socket: FakeCdpSocket) =>
  socket.sent.filter((m) => m.method === 'Input.dispatchMouseEvent').map((m) => m.params);
const keys = (socket: FakeCdpSocket) =>
  socket.sent.filter((m) => m.method === 'Input.dispatchKeyEvent').map((m) => m.params);

test('act click scrolls into view, reads the box model, and clicks its center', async () => {
  const { socket, page, client } = await pageWithRefs();
  const info = await page.act('e1', 'click');
  assert.deepEqual(info, { url: 'https://example.com/', title: 'Example Domain' });
  assert.deepEqual(socket.methods(), [
    'Page.enable',
    'DOM.scrollIntoViewIfNeeded',
    'DOM.getBoxModel',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Runtime.evaluate',
  ]);
  assert.deepEqual(socket.sent[1]!.params, { backendNodeId: 20 });
  assert.deepEqual(socket.sent[2]!.params, { backendNodeId: 20 });
  assert.deepEqual(mouse(socket), [
    { type: 'mouseMoved', x: 60, y: 40 },
    { type: 'mousePressed', x: 60, y: 40, button: 'left', clickCount: 1 },
    { type: 'mouseReleased', x: 60, y: 40, button: 'left', clickCount: 1 },
  ]);
  assert.ok(socket.sent.every((m) => m.sessionId === SESSION));
  client.close();
});

test('act click waits for the load event when a navigation starts', async () => {
  const socket = new FakeCdpSocket();
  socket.responders.set('Accessibility.getFullAXTree', () => ({ result: { nodes: SAMPLE_TREE } }));
  socket.responders.set('DOM.getBoxModel', () => ({ result: { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } } }));
  socket.responders.set('Runtime.evaluate', () => ({ result: { result: { value: { url: 'https://example.com/next', title: 'Next' } } } }));
  socket.responders.set('Input.dispatchMouseEvent', (message) => {
    if (message.params.type === 'mouseReleased') {
      setTimeout(() => socket.emitEvent('Page.frameStartedLoading', {}, SESSION), 0);
      setTimeout(() => socket.emitEvent('Page.loadEventFired', {}, SESSION), 30);
    }
    return undefined;
  });
  const client = new CdpClient(socket);
  const page = new BrowserPage(client, SESSION, { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))) });
  await page.snapshot();
  socket.log.length = 0;
  const info = await page.act('e1', 'click');
  assert.deepEqual(info, { url: 'https://example.com/next', title: 'Next' });
  const loadIndex = socket.log.indexOf('event:Page.loadEventFired');
  const infoIndex = socket.log.lastIndexOf('Runtime.evaluate');
  assert.ok(loadIndex >= 0 && loadIndex < infoIndex, socket.log.join(','));
  client.close();
});

test('act type clicks, inserts text, and presses Enter on submit', async () => {
  const { socket, page, client } = await pageWithRefs();
  await page.act('e3', 'type', { text: 'me@example.com', submit: true });
  assert.equal(mouse(socket).length, 3);
  const insert = socket.sent.find((m) => m.method === 'Input.insertText');
  assert.deepEqual(insert?.params, { text: 'me@example.com' });
  assert.deepEqual(keys(socket), [
    { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
    { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
  ]);
  client.close();
});

test('act press focuses the element and dispatches the named key', async () => {
  const { socket, page, client } = await pageWithRefs();
  await page.act('e3', 'press', { key: 'ArrowDown' });
  assert.deepEqual(socket.sent.find((m) => m.method === 'DOM.focus')?.params, { backendNodeId: 30 });
  assert.deepEqual(keys(socket), [
    { type: 'rawKeyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ]);
  await assert.rejects(page.act('e3', 'press', { key: 'Hyper' }), /Unsupported key/);
  client.close();
});

test('act clear selects all and deletes', async () => {
  const { socket, page, client } = await pageWithRefs();
  await page.act('e3', 'clear');
  assert.deepEqual(keys(socket).map((k) => [k.type, k.key, k.modifiers ?? 0]), [
    ['rawKeyDown', 'a', 2],
    ['keyUp', 'a', 2],
    ['rawKeyDown', 'Delete', 0],
    ['keyUp', 'Delete', 0],
  ]);
  client.close();
});

test('act select resolves the node and sets the matching option', async () => {
  const { socket, page, client } = await pageWithRefs();
  socket.responders.set('DOM.resolveNode', () => ({ result: { object: { type: 'object', objectId: 'obj-1' } } }));
  socket.responders.set('Runtime.callFunctionOn', () => ({ result: { result: { type: 'object', value: { ok: true, value: 'ca' } } } }));
  await page.act('e3', 'select', { text: 'Canada' });
  assert.deepEqual(socket.sent.find((m) => m.method === 'DOM.resolveNode')?.params, { backendNodeId: 30 });
  const call = socket.sent.find((m) => m.method === 'Runtime.callFunctionOn')!;
  assert.equal(call.params.objectId, 'obj-1');
  assert.deepEqual(call.params.arguments, [{ value: 'Canada' }]);
  assert.equal(call.params.returnByValue, true);
  assert.match(String(call.params.functionDeclaration), /dispatchEvent\(new Event\('change'/);

  socket.responders.set('Runtime.callFunctionOn', () => ({
    result: { result: { value: { ok: false, reason: 'no-match', options: ['Canada', 'Mexico'] } } },
  }));
  await assert.rejects(page.act('e3', 'select', { text: 'France' }), /No option matches "France"\. Available options: Canada, Mexico/);
  client.close();
});

test('act scroll and hover dispatch wheel and move events at the element center', async () => {
  const { socket, page, client } = await pageWithRefs();
  await page.act('e1', 'scroll');
  await page.act('e1', 'hover');
  assert.deepEqual(mouse(socket), [
    { type: 'mouseWheel', x: 60, y: 40, deltaX: 0, deltaY: 600 },
    { type: 'mouseMoved', x: 60, y: 40 },
  ]);
  client.close();
});

test('act with an unknown ref asks for a new snapshot', async () => {
  const { page, client } = await pageWithRefs();
  await assert.rejects(page.act('e9', 'click'), { message: 'Unknown element reference e9; take a new snapshot' });
  client.close();
});

test('screenshot decodes base64 image data', async () => {
  const { socket, page, client } = setup();
  socket.responders.set('Page.captureScreenshot', () => ({ result: { data: 'iVBORw0KGgo=' } }));
  const bytes = await page.screenshot({ format: 'jpeg', quality: 70 });
  assert.deepEqual([...bytes], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(socket.sent[0]!.params, { format: 'jpeg', quality: 70 });

  socket.responders.set('Page.getLayoutMetrics', () => ({ result: { cssContentSize: { x: 0, y: 0, width: 1280.4, height: 3000 } } }));
  await page.screenshot({ fullPage: true });
  const full = socket.sent.filter((m) => m.method === 'Page.captureScreenshot')[1]!;
  assert.deepEqual(full.params, {
    format: 'png',
    clip: { x: 0, y: 0, width: 1281, height: 3000, scale: 1 },
    captureBeyondViewport: true,
  });
  client.close();
});

test('evaluate returns values and throws on page exceptions', async () => {
  const { socket, page, client } = setup();
  assert.equal(await page.evaluate('6 * 7'), 42);
  assert.deepEqual(socket.sent[0]!.params, { expression: '6 * 7', returnByValue: true, awaitPromise: true });
  socket.responders.set('Runtime.evaluate', () => ({
    result: { result: { type: 'object' }, exceptionDetails: { text: 'Uncaught', exception: { description: 'ReferenceError: nope is not defined' } } },
  }));
  await assert.rejects(page.evaluate('nope'), /ReferenceError: nope is not defined/);
  client.close();
});
