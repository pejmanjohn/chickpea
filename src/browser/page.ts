/**
 * Text-first page operations over a flattened CDP page session.
 *
 * The Agent reads the page as a compact accessibility snapshot, then acts on
 * elements by the refs (e1, e2, ...) that snapshot handed out.
 */
import { base64ToBytes } from '../security/base64url.ts';
import type { CdpClient } from './cdp.ts';
import { escapeQuoted, REDACTED, TypedSecrets } from './redaction.ts';

export interface PageInfo {
  url: string;
  title: string;
}

export interface PageSnapshot extends PageInfo {
  text: string;
  nodeCount: number;
  truncated: boolean;
}

export interface ElementRef {
  backendDOMNodeId: number;
  role: string;
  name: string;
}

export type BrowserAction = 'click' | 'type' | 'press' | 'select' | 'scroll' | 'hover' | 'clear';

export interface BrowserActOptions {
  /** Text for `type`, or the option text/value for `select`. */
  text?: string;
  /** Key name for `press` (Enter, Tab, Escape, ArrowDown, a, ...). */
  key?: string;
  /** Press Enter after `type`. */
  submit?: boolean;
  /** Wheel delta for `scroll` (default 600). */
  deltaY?: number;
}

export interface BrowserPageOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Secrets typed this turn: no screenshot shows them. */
  secrets?: TypedSecrets;
}

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
}

/** Time to wait after an action for a navigation to start. */
const SETTLE_MS = 150;
/** Maximum time to wait for a started navigation to load after an action. */
const ACTION_LOAD_TIMEOUT_MS = 1500;
/** Delay before `navigate` starts polling document.readyState. */
const READY_STATE_POLL_DELAY_MS = 500;
const READY_STATE_POLL_MS = 250;

export interface AXValue {
  type?: string;
  value?: unknown;
}

export interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: Array<{ name: string; value?: AXValue }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

/** Roles that always appear in a snapshot. */
const STRUCTURAL_ROLES = new Set([
  'link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'listbox', 'heading', 'listitem', 'cell', 'gridcell', 'columnheader', 'rowheader', 'img', 'image', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'tab', 'option',
]);

/** Roles that receive an actionable ref. */
const INTERACTIVE_ROLES = new Set([
  'link', 'button', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton',
  'listbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option',
]);

/** Roles of form fields: a secret typed into one of them is hidden by identity. */
const FIELD_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);

/** Roles that are pure containers and never produce their own line. */
const TRANSPARENT_ROLES = new Set(['RootWebArea', 'WebArea', 'none', 'presentation', 'InlineTextBox']);

const MAX_NAME_LENGTH = 120;

const KEY_DEFINITIONS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

const KEY_ALIASES: Record<string, string> = {
  return: 'Enter', enter: 'Enter', tab: 'Tab', esc: 'Escape', escape: 'Escape', backspace: 'Backspace',
  delete: 'Delete', del: 'Delete', space: 'Space', ' ': 'Space', arrowup: 'ArrowUp', up: 'ArrowUp',
  arrowdown: 'ArrowDown', down: 'ArrowDown', arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowright: 'ArrowRight',
  right: 'ArrowRight', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
};

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
const MODIFIER_CTRL = 2;

export function keyDefinition(name: string): { key: string; code: string; keyCode: number; text?: string } {
  const canonical = KEY_DEFINITIONS[name] ? name : KEY_ALIASES[name.toLowerCase()];
  const known = canonical ? KEY_DEFINITIONS[canonical] : undefined;
  if (known) return known;
  if ([...name].length === 1) {
    const upper = name.toUpperCase();
    const isLetter = /^[A-Z]$/.test(upper);
    const isDigit = /^[0-9]$/.test(name);
    return {
      key: name,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${name}` : '',
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: name,
    };
  }
  throw new Error(`Unsupported key "${name}". Use a single character or one of: ${Object.keys(KEY_DEFINITIONS).join(', ')}`);
}

function axString(value: AXValue | undefined): string {
  if (!value || value.value === undefined || value.value === null) return '';
  return typeof value.value === 'string' ? value.value : String(value.value);
}

function cleanName(raw: string): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  const truncated = collapsed.length > MAX_NAME_LENGTH ? `${collapsed.slice(0, MAX_NAME_LENGTH)}…` : collapsed;
  return escapeQuoted(truncated);
}

function roleOf(node: AXNode): string {
  return axString(node.role);
}

function property(node: AXNode, name: string): unknown {
  return node.properties?.find((p) => p.name === name)?.value?.value;
}

/** A form field or other text a person can edit. */
function isField(node: AXNode): boolean {
  return FIELD_ROLES.has(roleOf(node)) || property(node, 'editable') !== undefined;
}

/** Each field's value, by backend node id. */
function fieldValues(nodes: AXNode[]): Map<number, string> {
  const values = new Map<number, string>();
  for (const node of nodes) {
    if (typeof node.backendDOMNodeId === 'number' && isField(node)) values.set(node.backendDOMNodeId, axString(node.value));
  }
  return values;
}

/**
 * Whether text the browser draws shows a typed secret, as its accessibility
 * tree reports that text after styles apply. A field's value is left to the
 * text node inside it, which shows bullets once the field is masked. The page
 * title is not drawn in a screenshot.
 */
function accessibleTextShows(nodes: AXNode[], secrets: TypedSecrets): boolean {
  return nodes.some((node) => {
    if (node.ignored) return false;
    const role = roleOf(node);
    if (role !== 'RootWebArea' && role !== 'WebArea' && secrets.shows(axString(node.name))) return true;
    return !isField(node) && secrets.shows(axString(node.value));
  });
}

/** Text nodes and form values a screenshot would draw, as the page masking function reads them. */
interface PageText {
  texts: string[];
  inputs: string[];
  /** An element drawn as bullets lost that style, as a page script may undo it. */
  hiddenShown: boolean;
}

export interface SnapshotLine {
  text: string;
  ref?: { id: string; target: ElementRef };
}

export class BrowserPage {
  refs = new Map<string, ElementRef>();
  /**
   * Fields a sign-in secret was typed into, by backend node id, and the
   * document that holds them. Another document may reuse the ids.
   */
  private secretFields: { loaderId: string | undefined; ids: Set<number> } | undefined;
  private typed = false;
  private pageEnabled = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly secrets: TypedSecrets;

  constructor(readonly client: CdpClient, readonly sessionId: string, options: BrowserPageOptions = {}) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.secrets = options.secrets ?? new TypedSecrets();
  }

  private cdp<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    return this.client.send<T>(method, params, this.sessionId, timeoutMs);
  }

  private async ensurePageEnabled(): Promise<void> {
    if (this.pageEnabled) return;
    await this.cdp('Page.enable');
    this.pageEnabled = true;
  }

  async navigate(url: string, options: { timeoutMs?: number } = {}): Promise<PageInfo> {
    const timeoutMs = options.timeoutMs ?? 30_000;
    await this.ensurePageEnabled();
    const abort = new AbortController();
    const loaded = this.client.waitForEvent('Page.loadEventFired', this.sessionId, timeoutMs, abort.signal);
    try {
      const result = await this.cdp<{ errorText?: string; loaderId?: string }>('Page.navigate', { url }, timeoutMs);
      if (result.errorText) throw new Error(`Navigation to ${url} failed: ${result.errorText}`);
      if (result.loaderId) {
        // Race the load event against readyState polling; whichever finishes first wins.
        await Promise.race([loaded, this.pollReadyState(timeoutMs, abort.signal)]);
      }
    } finally {
      abort.abort();
    }
    this.refs = new Map();
    return this.pageInfo();
  }

  private async pollReadyState(timeoutMs: number, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    await this.sleep(Math.min(READY_STATE_POLL_DELAY_MS, timeoutMs));
    while (!signal.aborted && Date.now() < deadline) {
      try {
        const state = await this.evaluate('document.readyState');
        if (state === 'complete') return;
      } catch {
        // The execution context may be replaced mid-navigation; keep polling.
      }
      if (signal.aborted) return;
      await this.sleep(READY_STATE_POLL_MS);
    }
  }

  async pageInfo(): Promise<PageInfo> {
    const value = await this.evaluate('({ url: location.href, title: document.title })');
    const info = (value && typeof value === 'object' ? value : {}) as { url?: unknown; title?: unknown };
    return {
      url: typeof info.url === 'string' ? info.url : '',
      title: typeof info.title === 'string' ? info.title : '',
    };
  }

  async evaluate(expression: string): Promise<unknown> {
    const result = await this.cdp<{
      result?: { value?: unknown; type?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(`Page script failed: ${details.exception?.description ?? details.text ?? 'unknown error'}`);
    }
    return result.result?.value;
  }

  /** Whether a sign-in secret was typed into this page; it stays true after the page navigates. */
  get typedSecret(): boolean {
    return this.typed;
  }

  private async accessibilityNodes(): Promise<AXNode[]> {
    return (await this.cdp<{ nodes?: AXNode[] }>('Accessibility.getFullAXTree')).nodes ?? [];
  }

  private async mainFrame(): Promise<{ id?: string; loaderId?: string }> {
    const tree = await this.cdp<{ frameTree?: { frame?: { id?: string; loaderId?: string } } }>('Page.getFrameTree');
    return tree.frameTree?.frame ?? {};
  }

  /** The secret fields of the document the page now shows. */
  private async currentSecretFields(): Promise<ReadonlySet<number>> {
    if (!this.secretFields) return new Set();
    if ((await this.mainFrame()).loaderId !== this.secretFields.loaderId) this.secretFields = undefined;
    return this.secretFields?.ids ?? new Set();
  }

  private async addSecretFields(ids: number[]): Promise<void> {
    const { loaderId } = await this.mainFrame();
    const fields = this.secretFields && this.secretFields.loaderId === loaderId
      ? this.secretFields
      : { loaderId, ids: new Set<number>() };
    for (const id of ids) fields.ids.add(id);
    this.secretFields = fields;
    this.typed = true;
  }

  /**
   * Reads the page as an accessibility snapshot. Pass the `pageInfo` a
   * `navigate` or `act` just returned to skip reading it again. `redact` gets
   * each name and value as the page gave it, before the snapshot collapses,
   * cuts or escapes it. A field a secret was typed into shows its value as
   * [redacted], whatever it holds.
   */
  async snapshot(options: { maxNodes?: number; pageInfo?: PageInfo; redact?: (text: string) => string } = {}): Promise<PageSnapshot> {
    const maxNodes = options.maxNodes ?? 400;
    const lines = buildSnapshotLines(await this.accessibilityNodes(), {
      ...(options.redact ? { redact: options.redact } : {}),
      secretFields: await this.currentSecretFields(),
    });
    const kept = lines.slice(0, maxNodes);
    const truncated = lines.length > kept.length;
    const refs = new Map<string, ElementRef>();
    for (const line of kept) if (line.ref) refs.set(line.ref.id, line.ref.target);
    this.refs = refs;
    let text = kept.map((line) => line.text).join('\n');
    if (truncated) text += `\n… (${lines.length - kept.length} more nodes)`;
    const info = options.pageInfo ?? await this.pageInfo();
    return { text, nodeCount: lines.length, truncated, url: info.url, title: info.title };
  }

  async act(ref: string, action: BrowserAction, options: BrowserActOptions = {}): Promise<PageInfo> {
    const target = this.refs.get(ref);
    if (!target) throw new Error(`Unknown element reference ${ref}; take a new snapshot`);
    const backendNodeId = target.backendDOMNodeId;
    await this.ensurePageEnabled();

    let navigationStarted = false;
    const stopWatching = this.client.on('Page.frameStartedLoading', (event) => {
      if (event.sessionId === this.sessionId) navigationStarted = true;
    });
    const abort = new AbortController();
    const loaded = this.client.waitForEvent(
      'Page.loadEventFired',
      this.sessionId,
      SETTLE_MS + ACTION_LOAD_TIMEOUT_MS,
      abort.signal,
    );
    try {
      switch (action) {
        case 'click':
          await this.clickAt(await this.elementCenter(backendNodeId));
          break;
        case 'hover': {
          const { x, y } = await this.elementCenter(backendNodeId);
          await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          break;
        }
        case 'type': {
          if (options.text === undefined) throw new Error('The type action needs text');
          await this.clickAt(await this.elementCenter(backendNodeId));
          await this.cdp('Input.insertText', { text: options.text });
          if (options.submit) await this.pressKey('Enter');
          break;
        }
        case 'press': {
          if (!options.key) throw new Error('The press action needs a key');
          const definition = keyDefinition(options.key);
          await this.cdp('DOM.focus', { backendNodeId }).catch(() => undefined);
          await this.pressDefinition(definition);
          break;
        }
        case 'clear': {
          await this.clickAt(await this.elementCenter(backendNodeId));
          await this.selectAllAndDelete();
          break;
        }
        case 'select':
          await this.selectOption(backendNodeId, options.text);
          break;
        case 'scroll': {
          const { x, y } = await this.elementCenter(backendNodeId);
          await this.cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: options.deltaY ?? 600 });
          break;
        }
        default:
          throw new Error(`Unsupported browser action ${String(action)}`);
      }
      await this.sleep(SETTLE_MS);
      if (navigationStarted) await loaded;
    } finally {
      abort.abort();
      stopWatching();
    }
    return this.pageInfo();
  }

  /**
   * Types a sign-in value into the element behind `ref`: focus it, clear it,
   * and insert the value as one text input. The value never passes through
   * `act`, a snapshot, or an error message, and the refs map is left
   * untouched. Unless `visible`, the field becomes a secret field, and so does
   * any other field the typing changed, such as the code boxes a page fills
   * from the first: snapshots and screenshots never show what they hold.
   */
  async fillSecret(ref: string, value: string, options: { visible?: boolean } = {}): Promise<void> {
    const target = this.refs.get(ref);
    if (!target) throw new Error(`Unknown element reference ${ref}; take a new snapshot`);
    const backendNodeId = target.backendDOMNodeId;
    const secret = !options.visible;
    const before = secret ? await this.accessibilityNodes().then(fieldValues, () => undefined) : undefined;
    if (secret) await this.addSecretFields([backendNodeId]);
    await this.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
    try {
      await this.cdp('DOM.focus', { backendNodeId });
    } catch {
      throw new Error(`Element ${ref} cannot take text; take a new snapshot and pick the input field`);
    }
    await this.selectAllAndDelete();
    await this.cdp('Input.insertText', { text: value });
    if (!before) return;
    // A page may spread the typed value over other fields from a timer.
    await this.sleep(SETTLE_MS);
    const after = await this.accessibilityNodes().then(fieldValues, () => new Map<number, string>());
    await this.addSecretFields([...after].flatMap(([id, now]) => (now && before.get(id) !== now ? [id] : [])));
  }

  /** Waits until the document finishes loading, up to `timeoutMs`. */
  async waitForReady(timeoutMs: number): Promise<void> {
    const abort = new AbortController();
    try {
      await this.pollReadyState(timeoutMs, abort.signal);
    } finally {
      abort.abort();
    }
  }

  /**
   * A screenshot that shows no secret typed this turn. While the browser
   * captures it, each secret field, and each text or form value that matches
   * a typed secret, is drawn as bullets; the page is put back afterwards.
   * Undefined, with nothing captured, when masking fails or the page still
   * shows a secret after it. With no secret typed, it is a plain screenshot.
   */
  async screenshot(options: ScreenshotOptions = {}): Promise<Uint8Array | undefined> {
    if (!this.typedSecret && this.secrets.empty) return this.capture(options);
    let world: number;
    try {
      world = await this.isolatedWorld();
    } catch {
      return undefined;
    }
    try {
      const hidden = await this.hideSecrets(world).catch(() => false);
      return hidden ? await this.capture(options) : undefined;
    } finally {
      await this.runMask(world, 'restore').catch(() => undefined);
    }
  }

  /** An execution context on the page that the page's own scripts cannot see or change. */
  private async isolatedWorld(): Promise<number> {
    const frameId = (await this.mainFrame()).id;
    if (!frameId) throw new Error('The page has no main frame');
    const world = await this.cdp<{ executionContextId?: number }>('Page.createIsolatedWorld', { frameId, worldName: 'chickpea-mask' });
    if (typeof world.executionContextId !== 'number') throw new Error('The page refused an isolated world');
    return world.executionContextId;
  }

  private async runMask<T = unknown>(
    world: number,
    step: 'hide' | 'read' | 'mask' | 'restore',
    payload: unknown = null,
    objectIds: string[] = [],
  ): Promise<T> {
    const result = await this.cdp<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
      executionContextId: world,
      functionDeclaration: MASK_FUNCTION,
      arguments: [{ value: step }, { value: payload }, ...objectIds.map((objectId) => ({ objectId }))],
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error('Masking the page failed');
    return result.result?.value as T;
  }

  /** Draws every typed secret on the page as bullets; false when the page still shows one. */
  private async hideSecrets(world: number): Promise<boolean> {
    const { secrets } = this;
    const fields = await Promise.all([...await this.currentSecretFields()].map((backendNodeId) =>
      this.cdp<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId, executionContextId: world })
        // A field the page has since removed draws nothing.
        .then((resolved) => resolved.object?.objectId, () => undefined)));
    await this.runMask(world, 'hide', null, fields.filter((objectId): objectId is string => objectId !== undefined));
    const shown = await this.runMask<PageText>(world, 'read');
    await this.runMask(world, 'mask', {
      texts: shown.texts.flatMap((text, index) => {
        const masked = secrets.mask(text);
        return masked === text ? [] : [[index, masked]];
      }),
      inputs: shown.inputs.flatMap((value, index) => (secrets.shows(value) ? [index] : [])),
    });
    const left = await this.runMask<PageText>(world, 'read');
    if (left.hiddenShown || [...left.texts, ...left.inputs].some((text) => secrets.shows(text))) return false;
    return !accessibleTextShows(await this.accessibilityNodes(), secrets);
  }

  private async capture(options: ScreenshotOptions): Promise<Uint8Array> {
    const format = options.format ?? 'png';
    const params: Record<string, unknown> = { format };
    if (format === 'jpeg' && options.quality !== undefined) params.quality = Math.max(0, Math.min(100, Math.round(options.quality)));
    if (options.fullPage) {
      const metrics = await this.cdp<{
        cssContentSize?: { width: number; height: number };
        contentSize?: { width: number; height: number };
      }>('Page.getLayoutMetrics');
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size) {
        params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
        params.captureBeyondViewport = true;
      }
    }
    const result = await this.cdp<{ data?: string }>('Page.captureScreenshot', params, 60_000);
    if (!result.data) throw new Error('The browser returned an empty screenshot');
    return base64ToBytes(result.data);
  }

  private async elementCenter(backendNodeId: number): Promise<{ x: number; y: number }> {
    await this.cdp('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
    let model: { model?: { content?: number[]; border?: number[] } };
    try {
      model = await this.cdp('DOM.getBoxModel', { backendNodeId });
    } catch {
      throw new Error('That element is not visible on the page; take a new snapshot');
    }
    const quad = model.model?.content ?? model.model?.border;
    if (!quad || quad.length < 8) throw new Error('That element has no on-screen box; take a new snapshot');
    let x = 0;
    let y = 0;
    for (let i = 0; i < 8; i += 2) {
      x += quad[i] ?? 0;
      y += quad[i + 1] ?? 0;
    }
    return { x: x / 4, y: y / 4 };
  }

  private async clickAt({ x, y }: { x: number; y: number }): Promise<void> {
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  private async selectAllAndDelete(): Promise<void> {
    const a = keyDefinition('a');
    await this.cdp('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: a.key, code: a.code, windowsVirtualKeyCode: a.keyCode, modifiers: MODIFIER_CTRL,
      commands: ['selectAll'],
    });
    await this.cdp('Input.dispatchKeyEvent', {
      type: 'keyUp', key: a.key, code: a.code, windowsVirtualKeyCode: a.keyCode, modifiers: MODIFIER_CTRL,
    });
    await this.pressKey('Delete');
  }

  private pressKey(name: string): Promise<void> {
    return this.pressDefinition(keyDefinition(name));
  }

  private async pressDefinition(definition: { key: string; code: string; keyCode: number; text?: string }): Promise<void> {
    const base = { key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode };
    await this.cdp('Input.dispatchKeyEvent', {
      type: definition.text ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(definition.text ? { text: definition.text, unmodifiedText: definition.text } : {}),
    });
    await this.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  private async selectOption(backendNodeId: number, wanted: string | undefined): Promise<void> {
    if (wanted === undefined) throw new Error('The select action needs the option text or value');
    const resolved = await this.cdp<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error('That element is no longer on the page; take a new snapshot');
    const result = await this.cdp<{
      result?: { value?: { ok?: boolean; reason?: string; options?: string[] } };
      exceptionDetails?: { text?: string };
    }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: SELECT_OPTION_FUNCTION,
      arguments: [{ value: wanted }],
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(`Selecting an option failed: ${result.exceptionDetails.text ?? 'script error'}`);
    const outcome = result.result?.value;
    if (!outcome?.ok) {
      if (outcome?.reason === 'not-select') throw new Error('That element is not a dropdown; click it and pick an option instead');
      const available = outcome?.options?.length ? ` Available options: ${outcome.options.join(', ')}` : '';
      throw new Error(`No option matches "${wanted}".${available}`);
    }
  }
}

/**
 * Masks typed secrets for a screenshot, run in an isolated world one step at
 * a time. `hide` draws the given elements' text as bullets. `read` lists the
 * text nodes and form values outside hidden elements, in the page and its
 * open shadow roots. `mask` replaces listed text with the masked text it is
 * given and hides listed form fields. `restore` undoes each change the page
 * has not overwritten since.
 */
const MASK_FUNCTION = `function (step, payload, ...elements) {
  const state = globalThis.__chickpeaMask ??= { hidden: new Set(), texts: [], inputs: [], undo: [] };
  const hide = (element) => {
    if (!element || !element.style || state.hidden.has(element)) return;
    state.hidden.add(element);
    const attribute = element.getAttribute('style');
    element.style.setProperty('-webkit-text-security', 'disc', 'important');
    const masked = element.getAttribute('style');
    state.undo.push(() => {
      if (element.getAttribute('style') !== masked) return;
      if (attribute === null) element.removeAttribute('style');
      else element.setAttribute('style', attribute);
    });
  };
  if (step === 'hide') {
    elements.forEach(hide);
  } else if (step === 'read') {
    const skipped = new Set(['script', 'style', 'noscript', 'template']);
    state.texts = [];
    state.inputs = [];
    const roots = [document];
    for (let index = 0; index < roots.length; index += 1) {
      const walker = document.createTreeWalker(roots[index], NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
          if (state.hidden.has(node) || skipped.has(node.localName)) return NodeFilter.FILTER_REJECT;
          // A text area draws its value, not the text inside it.
          if (node.localName === 'textarea') {
            state.inputs.push(node);
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (node.data.trim()) state.texts.push(node);
          continue;
        }
        if (node.shadowRoot) roots.push(node.shadowRoot);
        if (node.localName === 'input' && node.type !== 'hidden') state.inputs.push(node);
      }
    }
    const hiddenShown = [...state.hidden].some((element) =>
      element.isConnected && getComputedStyle(element).getPropertyValue('-webkit-text-security') !== 'disc');
    return { texts: state.texts.map((node) => node.data), inputs: state.inputs.map((node) => node.value), hiddenShown };
  } else if (step === 'mask') {
    for (const [index, masked] of payload.texts) {
      const node = state.texts[index];
      const original = node.data;
      node.data = masked;
      state.undo.push(() => {
        if (node.data === masked) node.data = original;
      });
    }
    payload.inputs.forEach((index) => hide(state.inputs[index]));
  } else if (step === 'restore') {
    while (state.undo.length) state.undo.pop()();
    state.hidden = new Set();
  }
  return true;
}`;

const SELECT_OPTION_FUNCTION = `function (wanted) {
  if (!(this instanceof HTMLSelectElement)) return { ok: false, reason: 'not-select' };
  const options = Array.from(this.options);
  const target = String(wanted).trim();
  const match = options.find((o) => o.value === wanted)
    || options.find((o) => o.text.trim() === target)
    || options.find((o) => o.label.trim() === target);
  if (!match) return { ok: false, reason: 'no-match', options: options.slice(0, 20).map((o) => o.text.trim()) };
  this.value = match.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: match.value };
}`;

export interface SnapshotRedaction {
  /** Gets each name and value as the page gave it, before the snapshot collapses, cuts or escapes it. */
  redact?: (text: string) => string;
  /** Fields a secret was typed into: a value shows as [redacted], whatever it is, and nothing inside them shows. */
  secretFields?: ReadonlySet<number>;
}

/**
 * Builds the indented snapshot lines from a flat CDP AX node list. Refs keep
 * an element's real name, so an approved step finds it again in a later turn.
 */
export function buildSnapshotLines(
  nodes: AXNode[],
  { redact = (text) => text, secretFields = new Set() }: SnapshotRedaction = {},
): SnapshotLine[] {
  const byId = new Map<string, AXNode>();
  for (const node of nodes) byId.set(node.nodeId, node);
  const roots = nodes.filter((node) => !node.parentId || !byId.has(node.parentId));
  const lines: SnapshotLine[] = [];
  let refCounter = 0;
  const interestingMemo = new Map<string, boolean>();

  const children = (node: AXNode): AXNode[] =>
    (node.childIds ?? []).map((id) => byId.get(id)).filter((child): child is AXNode => child !== undefined);

  const isStructural = (node: AXNode): boolean => {
    if (node.ignored) return false;
    const role = roleOf(node);
    if (!STRUCTURAL_ROLES.has(role)) return false;
    if ((role === 'img' || role === 'image') && !axString(node.name).trim()) return false;
    return true;
  };

  const hasInterestingDescendant = (node: AXNode, seen: Set<string>): boolean => {
    const memo = interestingMemo.get(node.nodeId);
    if (memo !== undefined) return memo;
    let found = false;
    for (const child of children(node)) {
      if (seen.has(child.nodeId)) continue;
      seen.add(child.nodeId);
      if (isStructural(child) || hasInterestingDescendant(child, seen)) {
        found = true;
        break;
      }
    }
    interestingMemo.set(node.nodeId, found);
    return found;
  };

  const visit = (node: AXNode, depth: number, parentName: string, visited: Set<string>): void => {
    if (visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    const role = roleOf(node);
    const axName = axString(node.name);
    const rawName = axName.replace(/\s+/g, ' ').trim();
    const indent = '  '.repeat(depth);
    // Only a field shows what was typed into it, whatever ref the sign-in was given.
    const secret = typeof node.backendDOMNodeId === 'number' && secretFields.has(node.backendDOMNodeId) && isField(node);

    if (isStructural(node)) {
      let text = `${indent}- ${role}`;
      if (rawName) text += ` "${cleanName(redact(axName))}"`;
      const line: SnapshotLine = { text: '' };
      if (INTERACTIVE_ROLES.has(role) && typeof node.backendDOMNodeId === 'number') {
        refCounter += 1;
        const id = `e${refCounter}`;
        text += ` [ref=${id}]`;
        line.ref = { id, target: { backendDOMNodeId: node.backendDOMNodeId, role, name: rawName } };
      }
      text += describeState(node, redact, secret);
      line.text = text;
      lines.push(line);
      // A field's children repeat its value as text.
      if (!secret) for (const child of children(node)) visit(child, depth + 1, rawName, visited);
      return;
    }

    if (secret) {
      if (axString(node.value).trim()) lines.push({ text: `${indent}- text "${REDACTED}"` });
      return;
    }

    const textLike = !node.ignored && !TRANSPARENT_ROLES.has(role) && rawName !== '';
    if (textLike && !hasInterestingDescendant(node, new Set([node.nodeId]))) {
      // Skip text that only repeats its parent's accessible name (e.g. a link's label).
      if (parentName && (rawName === parentName || parentName.includes(rawName))) return;
      const label = role === 'StaticText' ? 'text' : role;
      lines.push({ text: `${indent}- ${label} "${cleanName(redact(axName))}"` });
      return;
    }

    for (const child of children(node)) visit(child, depth, parentName, visited);
  };

  const visited = new Set<string>();
  for (const root of roots) visit(root, 0, '', visited);
  return lines;
}

function describeState(node: AXNode, redact: (text: string) => string, secret: boolean): string {
  const parts: string[] = [];
  const role = roleOf(node);
  const level = property(node, 'level');
  if (role === 'heading' && typeof level === 'number') parts.push(`level=${level}`);
  const checked = property(node, 'checked');
  if (checked === true || checked === 'true') parts.push('checked');
  else if (checked === 'mixed') parts.push('checked=mixed');
  const selected = property(node, 'selected');
  if (selected === true || selected === 'true') parts.push('selected');
  const expanded = property(node, 'expanded');
  if (expanded === true || expanded === 'true') parts.push('expanded');
  const disabled = property(node, 'disabled');
  if (disabled === true || disabled === 'true') parts.push('disabled');
  const raw = axString(node.value);
  const value = secret ? (raw.trim() ? REDACTED : '') : redact(raw).replace(/\s+/g, ' ').trim();
  if (value && role !== 'heading') parts.push(`value="${cleanName(value)}"`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}
