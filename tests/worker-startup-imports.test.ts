import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Modules that load on first use and never at Worker startup, with where they
 * first load. Every module a Worker's entry imports statically loads before a
 * Durable Object's constructor runs, at about 0.1 s per MiB. One static import
 * from anything the entry reaches turns a lazy load into a no-op, which is how
 * the lazy loads of just-bash and shared-prefix.ts stopped working unnoticed.
 */
const LAZY_MODULES: Record<string, string> = {
  'just-bash': "a Flue agent's sandbox (agents/slack-thread.ts, config/egress.ts)",
  'src/agents/shared-prefix.ts': "the Anthropic platform-funded payload hook (config/model-access.ts)",
  'src/agents/shared-prefix-tools.json': "the Anthropic platform-funded payload hook (config/model-access.ts)",
  '@composio/core': 'the Composio client (config/composio-settings.ts)',
  'image-in-browser': 'image output preparation (images/prepare-output.ts)',
};

type Edge = { to: string; local: boolean; dynamic: boolean };

const packageImports = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).imports as
  Record<string, { workerd?: string; default: string }>;

/** An edge to a local module's repository path, or to a package's bare specifier. */
function edgeTo(from: string, specifier: string, dynamic: boolean): Edge {
  const mapped = packageImports[specifier];
  const path = specifier.startsWith('.') ? resolve(ROOT, dirname(from), specifier)
    : mapped ? resolve(ROOT, mapped.workerd ?? mapped.default)
      : undefined;
  return path ? { to: relative(ROOT, path), local: true, dynamic } : { to: specifier, local: false, dynamic };
}

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

const edgeCache = new Map<string, Edge[]>();

function edgesOf(file: string): Edge[] {
  const cached = edgeCache.get(file);
  if (cached) return cached;
  const edges: Edge[] = [];
  if (/\.(ts|mts|mjs|js)$/.test(file)) {
    const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
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
  const agents = readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(ts|mts|js|mjs)$/.test(file))
    .map((file) => join('src', file))
    .filter((file) => /^\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*['"]use agent['"]/
      .test(readFileSync(join(ROOT, file), 'utf8')));
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

function isModule(node: string, module: string): boolean {
  return node === module || node.startsWith(module + '/');
}

test('the lazily loaded modules stay out of what the Worker loads at startup', () => {
  const entries = workerEntries();
  assert.ok(entries.includes('src/agents/slack-thread.ts'), "the scan finds the 'use agent' modules");
  const startup = reachable(entries, false);
  const everything = reachable(entries, true);
  for (const [module, firstLoad] of Object.entries(LAZY_MODULES)) {
    // A renamed or removed module would otherwise pass without guarding anything.
    assert.ok([...everything.keys()].some((node) => isModule(node, module)),
      `${module} is still imported somewhere; update LAZY_MODULES`);
    const loaded = [...startup].find(([node]) => isModule(node, module));
    assert.equal(loaded, undefined,
      `${module} loads at Worker startup through ${loaded?.[1].join(' -> ')}. ` +
      `Import it with import() where it is used: ${firstLoad}.`);
  }
});
