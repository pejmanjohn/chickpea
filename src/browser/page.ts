/**
 * Text-first page operations over a flattened CDP page session.
 *
 * The Agent reads the page as a compact accessibility snapshot, then acts on
 * elements by the refs (e1, e2, ...) that snapshot handed out.
 */
import { base64ToBytes } from '../security/base64url.ts';
import type { CdpClient } from './cdp.ts';
import { isSecretInput, remoteFrameOwners, secretOnPage, type DomSnapshot, type SecretOnPage } from './page-secrets.ts';
import { keyDefinition } from './keys.ts';
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
  /** Secrets typed this turn: no snapshot or screenshot shows them. */
  secrets?: TypedSecrets;
  /**
   * Whether the session could hold a sign-in secret before one is typed into
   * it: the run grants a website login, or a person is handed it to sign in.
   * Absent, it could. Only false skips the picture check (`secretOnPage`).
   */
  mayHoldSecret?: boolean;
}

export interface ScreenshotOptions {
  format?: 'png' | 'jpeg';
  quality?: number;
  fullPage?: boolean;
}

/** A screenshot, or why none was taken. */
export type Screenshot = { bytes: Uint8Array } | { withheld: SecretOnPage };

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

/** CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8. */
const MODIFIER_CTRL = 2;

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
  /**
   * The out-of-process frames attached under this page, by CDP session id,
   * with their target ids. Undefined until a screenshot first needs them.
   */
  private frames: Map<string, string> | undefined;
  /** Attachments in progress: a frame's own frames attach once it has. */
  private readonly attaching = new Set<Promise<void>>();
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly secrets: TypedSecrets;
  /** Set once, by the session or by typing a secret, and never cleared. */
  private mayHoldSecret: boolean;

  constructor(readonly client: CdpClient, readonly sessionId: string, options: BrowserPageOptions = {}) {
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.secrets = options.secrets ?? new TypedSecrets();
    this.mayHoldSecret = options.mayHoldSecret ?? true;
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
   * The fields of the shown document that hold a password or code, whoever
   * filled them and whenever they were made: each field a secret was typed
   * into, and each field holding a value that is a password input's, whose
   * autocomplete names a password or one-time code, or that is the start of
   * a typed secret, as a copy of a field that cut it holds.
   */
  private async secretFieldsIn(nodes: AXNode[]): Promise<ReadonlySet<number>> {
    const fields = new Set(await this.currentSecretFields());
    await Promise.all(nodes.map(async (node) => {
      const id = node.backendDOMNodeId;
      const value = axString(node.value);
      if (typeof id !== 'number' || fields.has(id) || !isField(node) || !value.trim()) return;
      if (this.secrets.startsSecret(value)) {
        fields.add(id);
        return;
      }
      const described = await this.cdp<{ node?: { nodeName?: string; attributes?: string[] } }>('DOM.describeNode', { backendNodeId: id })
        .catch(() => undefined);
      // A field that cannot be described is taken to hold a secret.
      if (!described?.node || isSecretInput(described.node.nodeName ?? '', described.node.attributes ?? [])) fields.add(id);
    }));
    return fields;
  }

  /**
   * Reads the page as an accessibility snapshot. Pass the `pageInfo` a
   * `navigate` or `act` just returned to skip reading it again. `redact` gets
   * each name and value the snapshot keeps, as the page gave it, before the
   * snapshot collapses, cuts or escapes it. A field that holds a password or
   * code shows its value as [redacted], whatever it holds.
   */
  async snapshot(options: { maxNodes?: number; pageInfo?: PageInfo; redact?: (text: string) => string } = {}): Promise<PageSnapshot> {
    const maxNodes = options.maxNodes ?? 400;
    const nodes = await this.accessibilityNodes();
    const lines = buildSnapshotLines(nodes, {
      ...(options.redact ? { redact: options.redact } : {}),
      secretFields: await this.secretFieldsIn(nodes),
      maxLines: maxNodes,
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
    if (secret) this.mayHoldSecret = true;
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
   * A screenshot, unless the page could show a sign-in secret in it: in a
   * session that could hold one, the page is checked before and after the
   * capture, and the capture is withheld when either check finds one
   * (`secretOnPage`). Nothing on the page changes.
   */
  async screenshot(options: ScreenshotOptions = {}): Promise<Screenshot> {
    const before = await this.secretOnPage();
    if (before) return { withheld: before };
    const bytes = await this.capture(options);
    const after = await this.secretOnPage();
    return after ? { withheld: after } : { bytes };
  }

  /**
   * Why a picture of the page now could show a sign-in secret, if it could:
   * read from the browser's snapshot of every document in the page and in
   * each out-of-process frame, open and closed shadow roots included. A frame
   * that cannot be read makes the page `unchecked`. A session that could not
   * hold a secret, in a turn that typed none, is not read: that costs tens of
   * milliseconds a picture, and more on a large page.
   */
  async secretOnPage(): Promise<SecretOnPage | undefined> {
    if (!this.mayHoldSecret && this.secrets.empty) return undefined;
    try {
      const frames = await this.frameSessions();
      const captures = await Promise.all([this.sessionId, ...frames.keys()].map(async (sessionId) => ({
        sessionId,
        main: sessionId === this.sessionId,
        snapshot: await this.client.send<DomSnapshot & Record<string, unknown>>(
          'DOMSnapshot.captureSnapshot', { computedStyles: [] }, sessionId),
      })));
      const attached = new Set(frames.values());
      for (const { sessionId, snapshot } of captures) {
        const owners = await Promise.all(remoteFrameOwners(snapshot).map((backendNodeId) =>
          this.client.send<{ node?: { frameId?: string } }>('DOM.describeNode', { backendNodeId }, sessionId)));
        if (owners.some(({ node }) => node?.frameId !== undefined && !attached.has(node.frameId))) return 'unchecked';
      }
      return secretOnPage(captures, await this.currentSecretFields(), this.secrets);
    } catch {
      return 'unchecked';
    }
  }

  /**
   * The out-of-process frames under this page, attached as CDP sessions the
   * first time they are needed and kept up to date by the browser after.
   */
  private async frameSessions(): Promise<ReadonlyMap<string, string>> {
    if (!this.frames) {
      const frames = new Map<string, string>();
      this.frames = frames;
      this.client.on('Target.attachedToTarget', (event) => {
        const child = event.params.sessionId;
        const info = event.params.targetInfo as { type?: unknown; targetId?: unknown } | undefined;
        if (event.sessionId !== this.sessionId && !frames.has(event.sessionId ?? '')) return;
        if (typeof child !== 'string' || info?.type !== 'iframe' || typeof info.targetId !== 'string') return;
        frames.set(child, info.targetId);
        this.autoAttach(child);
      });
      this.client.on('Target.detachedFromTarget', (event) => {
        if (typeof event.params.sessionId === 'string') frames.delete(event.params.sessionId);
      });
      this.autoAttach(this.sessionId);
    }
    while (this.attaching.size) await Promise.all(this.attaching);
    return this.frames;
  }

  /**
   * Asks the browser to attach every frame of `sessionId` that runs in another
   * process, now and from then on. It reports those already there before it
   * answers. Should it refuse, a frame it did not attach leaves the page
   * unchecked.
   */
  private autoAttach(sessionId: string): void {
    const attaching: Promise<void> = this.client.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe' }],
    }, sessionId).then(() => undefined, () => undefined).finally(() => this.attaching.delete(attaching));
    this.attaching.add(attaching);
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
  /** Fields that hold a password or code: a value shows as [redacted], whatever it is, and nothing inside them shows. */
  secretFields?: ReadonlySet<number>;
  /** Lines after this many are counted but left empty, without a ref and without redacting their text. */
  maxLines?: number;
}

/**
 * Builds the indented snapshot lines from a flat CDP AX node list. Refs keep
 * an element's real name, so an approved step finds it again in a later turn.
 */
export function buildSnapshotLines(
  nodes: AXNode[],
  { redact = (text) => text, secretFields = new Set(), maxLines = Infinity }: SnapshotRedaction = {},
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

    const shown = lines.length < maxLines;

    if (isStructural(node)) {
      const line: SnapshotLine = { text: '' };
      if (shown) {
        let text = `${indent}- ${role}`;
        if (rawName) text += ` "${cleanName(redact(axName))}"`;
        if (INTERACTIVE_ROLES.has(role) && typeof node.backendDOMNodeId === 'number') {
          refCounter += 1;
          const id = `e${refCounter}`;
          text += ` [ref=${id}]`;
          line.ref = { id, target: { backendDOMNodeId: node.backendDOMNodeId, role, name: rawName } };
        }
        line.text = text + describeState(node, redact, secret);
      }
      lines.push(line);
      // A field's children repeat its value as text.
      if (!secret) for (const child of children(node)) visit(child, depth + 1, rawName, visited);
      return;
    }

    if (secret) {
      if (axString(node.value).trim()) lines.push({ text: shown ? `${indent}- text "${REDACTED}"` : '' });
      return;
    }

    const textLike = !node.ignored && !TRANSPARENT_ROLES.has(role) && rawName !== '';
    if (textLike && !hasInterestingDescendant(node, new Set([node.nodeId]))) {
      // Skip text that only repeats its parent's accessible name (e.g. a link's label).
      if (parentName && (rawName === parentName || parentName.includes(rawName))) return;
      const label = role === 'StaticText' ? 'text' : role;
      lines.push({ text: shown ? `${indent}- ${label} "${cleanName(redact(axName))}"` : '' });
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
