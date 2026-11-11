/**
 * Whether a picture of the page could show a sign-in secret, read from the
 * browser's own snapshot of each document: every frame, and inside shadow
 * roots, open or closed. Page scripts cannot see or change this reading, and
 * nothing on the page changes for it.
 */
import { RedactionBudget, RedactionBudgetError, type TypedSecrets } from './redaction.ts';

/**
 * Why the page is not pictured: a sign-in field holds a value, the page shows
 * a secret typed this turn, or the page could not be checked.
 */
export type SecretOnPage = 'field' | 'text' | 'unchecked';

interface RareStringData {
  index: number[];
  value: number[];
}

/** One document of `DOMSnapshot.captureSnapshot`; each string is an index into the snapshot's `strings`. */
export interface DocumentSnapshot {
  nodes: {
    nodeName?: number[];
    backendNodeId?: number[];
    attributes?: number[][];
    inputValue?: RareStringData;
    textValue?: RareStringData;
    contentDocumentIndex?: { index: number[] };
  };
}

export interface DomSnapshot {
  documents: DocumentSnapshot[];
  /** Every string in the documents: names, text, attribute and form values, and the text drawn for `::before` and `::after`. */
  strings: string[];
}

export interface PageCapture {
  snapshot: DomSnapshot;
  /** The page's own target, whose backend node ids the filled fields use. Each out-of-process frame has its own. */
  main: boolean;
}

const SECRET_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'one-time-code']);
const FRAME_OWNERS = new Set(['IFRAME', 'FRAME']);
const FORM_VALUES = new Set(['INPUT', 'TEXTAREA']);

/**
 * An input of type password, or a field whose autocomplete names a password
 * or a one-time code. `attributes` alternates names and values.
 */
export function isSecretInput(nodeName: string, attributes: readonly string[]): boolean {
  const attribute = (name: string) => {
    for (let index = 0; index + 1 < attributes.length; index += 2) {
      if (attributes[index]!.toLowerCase() === name) return attributes[index + 1]!.toLowerCase();
    }
    return undefined;
  };
  if (nodeName.toUpperCase() === 'INPUT' && attribute('type')?.trim() === 'password') return true;
  return (attribute('autocomplete') ?? '').split(/\s+/).some((token) => SECRET_AUTOCOMPLETE.has(token));
}

/** The frame elements whose document lives in another target, by backend node id. */
export function remoteFrameOwners({ documents, strings }: DomSnapshot): number[] {
  return documents.flatMap(({ nodes }) => {
    const local = new Set(nodes.contentDocumentIndex?.index ?? []);
    return (nodes.nodeName ?? []).flatMap((name, node) =>
      FRAME_OWNERS.has(strings[name] ?? '') && !local.has(node) && nodes.backendNodeId?.[node] !== undefined
        ? [nodes.backendNodeId[node]!]
        : []);
  });
}

/**
 * Why a picture of these documents could show a sign-in secret, if it could.
 * A field holding a value withholds it when Chickpea filled it (`filled`, by
 * backend node id in the main target), when it is a password or code field,
 * or when its value is the start of a typed secret. Once a secret was typed,
 * any text, attribute or form value, or text drawn by CSS, that shows it in a
 * form `TypedSecrets` matches withholds it too.
 */
export function secretOnPage(
  captures: readonly PageCapture[],
  filled: ReadonlySet<number>,
  secrets: TypedSecrets,
): SecretOnPage | undefined {
  for (const { snapshot: { documents, strings }, main } of captures) {
    for (const { nodes } of documents) {
      const name = (node: number) => strings[nodes.nodeName?.[node] ?? -1] ?? '';
      const values = new Map<number, string>();
      for (const rare of [nodes.inputValue, nodes.textValue]) {
        rare?.index.forEach((node, at) => values.set(node, strings[rare.value[at] ?? -1] ?? ''));
      }
      for (const [node, value] of values) {
        if (!value) continue;
        const attributes = (nodes.attributes?.[node] ?? []).map((index) => strings[index] ?? '');
        if (isSecretInput(name(node), attributes) || secrets.startsSecret(value)) return 'field';
      }
      if (!main || filled.size === 0) continue;
      const found = (nodes.backendNodeId ?? []).some((id, node) =>
        filled.has(id) && (FORM_VALUES.has(name(node)) ? Boolean(values.get(node)) : true));
      if (found) return 'field';
    }
  }
  if (secrets.empty) return undefined;
  const budget = new RedactionBudget();
  try {
    for (const { snapshot } of captures) {
      if (snapshot.strings.some((text) => text && secrets.shows(text, budget))) return 'text';
    }
  } catch (error) {
    if (error instanceof RedactionBudgetError) return 'unchecked';
    throw error;
  }
  return undefined;
}
