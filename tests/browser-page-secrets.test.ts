import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSecretInput,
  remoteFrameOwners,
  secretOnPage,
  type DocumentSnapshot,
  type PageCapture,
} from '../src/browser/page-secrets.ts';
import { TypedSecrets } from '../src/browser/redaction.ts';

interface Node {
  name: string;
  id?: number;
  attributes?: Record<string, string>;
  value?: string;
  /** The element's document is in this target. */
  local?: boolean;
}

/** A target's `DOMSnapshot.captureSnapshot` with one document, and `strings` holding anything else the browser reported. */
function capture(nodes: Node[], options: { main?: boolean; strings?: string[] } = {}): PageCapture {
  const strings: string[] = [];
  const at = (text: string) => {
    const index = strings.indexOf(text);
    return index >= 0 ? index : strings.push(text) - 1;
  };
  const document = {
    nodeName: [] as number[],
    backendNodeId: [] as number[],
    attributes: [] as number[][],
    inputValue: { index: [] as number[], value: [] as number[] },
    textValue: { index: [] as number[], value: [] as number[] },
    contentDocumentIndex: { index: [] as number[] },
  } satisfies DocumentSnapshot['nodes'];
  nodes.forEach((node, index) => {
    document.nodeName.push(at(node.name));
    document.backendNodeId.push(node.id ?? 1000 + index);
    document.attributes.push(Object.entries(node.attributes ?? {}).flatMap(([name, value]) => [at(name), at(value)]));
    if (node.value !== undefined) {
      const values = node.name === 'TEXTAREA' ? document.textValue : document.inputValue;
      values.index.push(index);
      values.value.push(node.value ? at(node.value) : -1);
    }
    if (node.local) document.contentDocumentIndex.index.push(index);
  });
  for (const text of options.strings ?? []) at(text);
  return { main: options.main ?? true, snapshot: { strings, documents: [{ nodes: document }] } };
}

function typed(...values: string[]): TypedSecrets {
  const secrets = new TypedSecrets();
  for (const value of values) secrets.add(value);
  return secrets;
}

const NONE = new Set<number>();

test('a password or code field holding a value withholds a picture, whoever filled it; an empty one does not', () => {
  const check = (node: Node) => secretOnPage([capture([node])], NONE, typed());
  assert.equal(check({ name: 'INPUT', attributes: { type: 'password' }, value: 'x' }), 'field');
  assert.equal(check({ name: 'INPUT', attributes: { type: 'PassWord ' }, value: 'x' }), 'field');
  assert.equal(check({ name: 'INPUT', attributes: { type: 'password' }, value: '' }), undefined);
  assert.equal(check({ name: 'INPUT', attributes: { autocomplete: 'section-login username current-password' }, value: 'x' }), 'field');
  assert.equal(check({ name: 'INPUT', attributes: { autocomplete: 'new-password' }, value: 'x' }), 'field');
  assert.equal(check({ name: 'INPUT', attributes: { autocomplete: 'one-time-code' }, value: '493817' }), 'field');
  assert.equal(check({ name: 'TEXTAREA', attributes: { autocomplete: 'one-time-code' }, value: '493817' }), 'field');
  assert.equal(check({ name: 'INPUT', attributes: { type: 'text', autocomplete: 'username' }, value: 'octo@example.com' }), undefined);
  assert.equal(check({ name: 'DIV', attributes: { type: 'password' }, value: 'x' }), undefined, 'only an input has a password type');
});

test("a field Chickpea filled withholds a picture while it holds a value, found in the page's own target only", () => {
  const filled = new Set([12]);
  assert.equal(secretOnPage([capture([{ name: 'INPUT', id: 12, value: 'Synthetic-' }])], filled, typed()), 'field');
  assert.equal(secretOnPage([capture([{ name: 'INPUT', id: 12, value: '' }])], filled, typed()), undefined, 'emptied');
  assert.equal(secretOnPage([capture([{ name: 'INPUT', id: 13, value: 'x' }])], filled, typed()), undefined, 'gone');
  assert.equal(
    secretOnPage([capture([{ name: 'INPUT', id: 12, value: 'x' }], { main: false })], filled, typed()),
    undefined,
    'a frame in another process numbers its nodes on its own',
  );
  assert.equal(secretOnPage([capture([{ name: 'DIV', id: 12 }])], filled, typed()), 'field', 'an editable element is taken to hold what was typed');
});

test('a field holding the start of a typed secret withholds a picture, as a copy of a field that cut it does', () => {
  const secrets = typed('Synthetic-Pass-1234');
  assert.equal(secretOnPage([capture([{ name: 'INPUT', id: 99, attributes: { type: 'text' }, value: 'Synthetic-' }])], NONE, secrets), 'field');
  assert.equal(secretOnPage([capture([{ name: 'INPUT', id: 99, value: 'Syn' }])], NONE, secrets), undefined);
});

test('once a secret was typed, any string the browser reports shows it: text in a closed shadow root or a frame, an attribute, CSS content', () => {
  const secrets = typed('Synthetic-Pass-1234', '493817');
  const page = (strings: string[], main = true) => secretOnPage([capture([{ name: 'P' }], { main, strings })], NONE, secrets);
  assert.equal(page(['closed Synthetic-Pass-1234']), 'text');
  assert.equal(page(['UPPER SYNTHETIC-PASS-1234'], false), 'text');
  assert.equal(page(['Synthetic%2DPass%2D1234']), 'text');
  assert.equal(page(['Your code is 493 817']), 'text');
  assert.equal(page(['Welcome back', 'Synthetic-']), undefined, 'text that only starts a secret is not a field');
  assert.equal(secretOnPage([capture([{ name: 'P' }], { strings: ['closed Synthetic-Pass-1234'] })], NONE, typed()), undefined, 'nothing typed');
  assert.equal(
    secretOnPage([capture([{ name: 'P' }], { strings: ['Welcome'] }), capture([{ name: 'P' }], { main: false, strings: ['Synthetic-Pass-1234'] })], NONE, secrets),
    'text',
    'every target is read',
  );
});

test('a page whose strings would take more matching work than one check may spend is unchecked', () => {
  const started = performance.now();
  const secrets = typed(`${'x'.repeat(1000)}y`);
  assert.equal(secretOnPage([capture([{ name: 'P' }], { strings: ['x'.repeat(1_000_000)] })], NONE, secrets), 'unchecked');
  // Each string alone fits the budget; together they do not.
  const many = Array.from({ length: 10 }, (_, index) => 'x'.repeat(100_000 - index));
  assert.equal(secretOnPage([capture([{ name: 'P' }], { strings: many })], NONE, secrets), 'unchecked');
  assert.ok(performance.now() - started < 200);
});

test('isSecretInput reads alternating attribute names and values, as DOM.describeNode gives them', () => {
  assert.equal(isSecretInput('INPUT', ['id', 'p', 'type', 'password']), true);
  assert.equal(isSecretInput('input', ['AUTOCOMPLETE', 'One-Time-Code']), true);
  assert.equal(isSecretInput('INPUT', ['type', 'text', 'name', 'password']), false);
  assert.equal(isSecretInput('INPUT', ['autocomplete']), false);
});

test('remoteFrameOwners lists the frame elements whose document another target holds', () => {
  const { snapshot } = capture([
    { name: 'IFRAME', id: 5, local: true },
    { name: 'IFRAME', id: 6 },
    { name: 'FRAME', id: 7 },
    { name: 'DIV', id: 8 },
  ]);
  assert.deepEqual(remoteFrameOwners(snapshot), [6, 7]);
});
