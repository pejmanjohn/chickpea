import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpClient } from '../src/browser/cdp.ts';
import { BrowserPage, buildSnapshotLines, type AXNode } from '../src/browser/page.ts';
import { TypedSecrets } from '../src/browser/redaction.ts';
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

test('snapshot hands each name, text and value to the redactor as the page gave it, and refs keep the real name', async () => {
  const { socket, page, client } = setup();
  const shown = 'Synth"etic  Pass';
  socket.responders.set('Accessibility.getFullAXTree', () => ({
    result: {
      nodes: [
        ax('1', 'RootWebArea', { childIds: ['2', '3', '4'] }),
        ax('2', 'button', { parentId: '1', name: `Copy ${shown}`, backendDOMNodeId: 2 }),
        ax('3', 'StaticText', { parentId: '1', name: `You typed ${shown}` }),
        ax('4', 'textbox', { parentId: '1', name: 'Password', backendDOMNodeId: 4, value: { type: 'string', value: shown } }),
      ],
    },
  }));
  // Matches only the text as Chromium returned it: two spaces, the quote not escaped.
  const snap = await page.snapshot({ redact: (text) => text.split(shown).join('[redacted]') });
  assert.equal(snap.text, [
    '- button "Copy [redacted]" [ref=e1]',
    '- text "You typed [redacted]"',
    '- textbox "Password" [ref=e2] value="[redacted]"',
  ].join('\n'));
  assert.equal(page.refs.get('e1')?.name, 'Copy Synth"etic Pass');
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

test('fillSecret focuses the node, clears it, and inserts the value without touching refs or snapshots', async () => {
  const { socket, page, client } = await pageWithRefs();
  const refsBefore = JSON.stringify([...page.refs.entries()]);
  const secret = 'correct horse battery staple';
  await page.fillSecret('e3', secret);
  const methods = socket.sent.map((m) => m.method);
  const focusAt = methods.indexOf('DOM.focus');
  const insertAt = methods.indexOf('Input.insertText');
  assert.ok(focusAt >= 0 && insertAt > focusAt);
  assert.deepEqual(socket.sent[focusAt]!.params, { backendNodeId: 30 });
  assert.deepEqual(socket.sent[insertAt]!.params, { text: secret });
  // Cleared first: select-all then Delete, before the insert.
  assert.deepEqual(keys(socket).map((k) => [k.type, k.key]), [
    ['rawKeyDown', 'a'], ['keyUp', 'a'], ['rawKeyDown', 'Delete'], ['keyUp', 'Delete'],
  ]);
  // No click, no act path: the value never passes through a mouse or key event.
  assert.equal(methods.includes('Input.dispatchMouseEvent'), false);
  assert.equal(keys(socket).some((k) => JSON.stringify(k).includes(secret)), false);
  assert.equal(JSON.stringify([...page.refs.entries()]), refsBefore);
  assert.doesNotMatch(refsBefore, /correct horse/);
  const snap = await page.snapshot();
  assert.doesNotMatch(snap.text, /correct horse/);
  await assert.rejects(page.fillSecret('e9', secret), (error: Error) =>
    /Unknown element reference e9/.test(error.message) && !error.message.includes(secret));
  socket.responders.set('DOM.focus', () => ({ error: { code: -32000, message: 'Element is not focusable' } }));
  await assert.rejects(page.fillSecret('e1', secret), (error: Error) =>
    /cannot take text/.test(error.message) && !error.message.includes(secret));
  client.close();
});

test('fillSecret hides the field it fills, and each field its typing filled, until the page shows another document', async () => {
  const { socket, page, client } = setup();
  const code = '493817';
  let typed = '';
  let loaderId = 'l1';
  // One-digit code boxes that the page fills from the first, beside a search box that keeps its own text.
  socket.responders.set('Accessibility.getFullAXTree', () => ({
    result: {
      nodes: [
        ax('1', 'RootWebArea', { childIds: ['2', '3', '4', '5', '6', '7', '8'] }),
        ...[...code].map((_, index) => ax(String(index + 2), 'textbox', {
          parentId: '1', name: `Digit ${index + 1}`, backendDOMNodeId: 51 + index,
          ...(typed ? { value: { type: 'string', value: typed[index]! } } : {}),
        })),
        ax('8', 'searchbox', { parentId: '1', name: 'Search', backendDOMNodeId: 60, value: { type: 'string', value: 'invoices' } }),
      ],
    },
  }));
  socket.responders.set('Input.insertText', (message) => {
    typed = String(message.params.text);
    return {};
  });
  socket.responders.set('Page.getFrameTree', () => ({ result: { frameTree: { frame: { id: 'f1', loaderId } } } }));
  await page.snapshot();
  assert.equal(page.typedSecret, false);
  await page.fillSecret('e1', code);
  assert.equal(page.typedSecret, true);
  const hidden = (await page.snapshot()).text;
  assert.deepEqual(hidden.split('\n'), [
    ...[1, 2, 3, 4, 5, 6].map((n) => `- textbox "Digit ${n}" [ref=e${n}] value="[redacted]"`),
    '- searchbox "Search" [ref=e7] value="invoices"',
  ]);
  // Another document may reuse the node ids; its fields are not secret.
  loaderId = 'l2';
  assert.match((await page.snapshot()).text, /textbox "Digit 1" \[ref=e1\] value="4"/);
  assert.equal(page.typedSecret, true);
  client.close();
});

test('fillSecret with visible types a value that stays readable', async () => {
  const { socket, page, client } = setup();
  socket.responders.set('Accessibility.getFullAXTree', () => ({
    result: { nodes: [ax('1', 'textbox', { name: 'Email', backendDOMNodeId: 30, value: { type: 'string', value: 'octo@example.com' } })] },
  }));
  await page.snapshot();
  await page.fillSecret('e1', 'octo@example.com', { visible: true });
  assert.equal(page.typedSecret, false);
  assert.equal((await page.snapshot()).text, '- textbox "Email" [ref=e1] value="octo@example.com"');
  client.close();
});

test('a secret field shows [redacted] for any value and nothing of what it holds; other nodes with its id are not hidden', () => {
  const nodes = [
    ax('1', 'RootWebArea', { childIds: ['2', '5', '7', '8'] }),
    // A text field as Chromium gives it: its value again as a text node inside it.
    ax('2', 'textbox', { parentId: '1', name: 'Password', backendDOMNodeId: 9, value: { type: 'string', value: 'Synthetic-' }, childIds: ['3'] }),
    ax('3', 'generic', { parentId: '2', backendDOMNodeId: 10, childIds: ['4'], properties: [{ name: 'editable', value: { type: 'token', value: 'plaintext' } }] }),
    ax('4', 'StaticText', { parentId: '3', name: 'Synthetic-' }),
    ax('5', 'generic', {
      parentId: '1', backendDOMNodeId: 15, value: { type: 'string', value: '••••••' }, childIds: ['6'],
      properties: [{ name: 'editable', value: { type: 'token', value: 'richtext' } }],
    }),
    ax('6', 'StaticText', { parentId: '5', name: '••••••' }),
    ax('7', 'listitem', { parentId: '1', backendDOMNodeId: 20, childIds: ['9'] }),
    ax('9', 'StaticText', { parentId: '7', name: 'Welcome back' }),
    ax('8', 'textbox', { parentId: '1', name: 'Code', backendDOMNodeId: 21 }),
  ];
  const lines = buildSnapshotLines(nodes, { secretFields: new Set([9, 15, 20, 21]) }).map((line) => line.text);
  assert.deepEqual(lines, [
    '- textbox "Password" [ref=e1] value="[redacted]"',
    '- text "[redacted]"',
    '- listitem',
    '  - text "Welcome back"',
    '- textbox "Code" [ref=e2]',
  ]);
});

test('screenshot captures nothing when a secret was typed and the page cannot be masked', async () => {
  const socket = new FakeCdpSocket();
  const client = new CdpClient(socket);
  const secrets = new TypedSecrets();
  const page = new BrowserPage(client, SESSION, { secrets });
  socket.responders.set('Page.captureScreenshot', () => ({ result: { data: 'iVBORw0KGgo=' } }));
  assert.ok(await page.screenshot());
  assert.deepEqual(socket.methods(), ['Page.captureScreenshot'], 'with nothing typed, a plain screenshot');
  secrets.add('Synthetic-Pass-1234');
  // The fake browser refuses an isolated world.
  assert.equal(await page.screenshot(), undefined);
  assert.equal(socket.methods().filter((method) => method === 'Page.captureScreenshot').length, 1);
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
  assert.deepEqual([...bytes!], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
