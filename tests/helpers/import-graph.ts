/**
 * The static import graph of this repository's sources, as TypeScript keeps
 * it: `import type` is erased, and `import()` inside a function is dynamic.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

type Edge = { to: string; local: boolean; dynamic: boolean };

/** An import or re-export TypeScript keeps in the output; `type` ones are erased. */
function keptDeclaration(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return true;
    if (clause.isTypeOnly) return false;
    const named = clause.namedBindings;
    return Boolean(clause.name) || !named || !ts.isNamedImports(named) ||
      named.elements.length === 0 || named.elements.some((element) => !element.isTypeOnly);
  }
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  return !clause || !ts.isNamedExports(clause) || clause.elements.some((element) => !element.isTypeOnly);
}

/** The graph of the sources under `root`: this checkout, or an export of another commit. */
export function importGraph(root: string) {
  const packageImports = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).imports as
    Record<string, { workerd?: string; default: string }>;

  /** An edge to a local module's repository path, or to a package's bare specifier. */
  function edgeTo(from: string, specifier: string, dynamic: boolean): Edge {
    const mapped = packageImports[specifier];
    const path = specifier.startsWith('.') ? resolve(root, dirname(from), specifier)
      : mapped ? resolve(root, mapped.workerd ?? mapped.default)
        : undefined;
    return path ? { to: relative(root, path), local: true, dynamic } : { to: specifier, local: false, dynamic };
  }

  const edgeCache = new Map<string, Edge[]>();

  function edgesOf(file: string): Edge[] {
    const cached = edgeCache.get(file);
    if (cached) return cached;
    const edges: Edge[] = [];
    if (/\.(ts|mts|mjs|js)$/.test(file)) {
      const source = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && keptDeclaration(node)) {
          edges.push(edgeTo(file, node.moduleSpecifier.text, false));
        } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const [argument] = node.arguments;
          if (argument && ts.isStringLiteralLike(argument)) {
            // An import() outside every function runs when the module is evaluated.
            edges.push(edgeTo(file, argument.text, ts.findAncestor(node, ts.isFunctionLike) !== undefined));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    edgeCache.set(file, edges);
    return edges;
  }

  /** The modules Flue's generated Worker entry imports: app.ts, cloudflare.ts and every `'use agent'` module. */
  function workerEntries(): string[] {
    const agents = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(ts|mts|js|mjs)$/.test(file))
      .map((file) => join('src', file))
      .filter((file) => /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use agent['"]/
        .test(readFileSync(join(root, file), 'utf8')));
    return ['src/app.ts', 'src/cloudflare.ts', ...agents];
  }

  /** Every module reachable from `entries`, each with the import chain that first reaches it. */
  function reachable(entries: string[], followDynamic: boolean): Map<string, string[]> {
    const chains = new Map(entries.map((entry) => [entry, [entry]]));
    const queue = [...entries];
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      for (const edge of edgesOf(file)) {
        if ((edge.dynamic && !followDynamic) || chains.has(edge.to)) continue;
        chains.set(edge.to, [...chains.get(file)!, edge.to]);
        if (edge.local) queue.push(edge.to);
      }
    }
    return chains;
  }

  return { workerEntries, reachable };
}

export const { workerEntries, reachable } = importGraph(ROOT);
