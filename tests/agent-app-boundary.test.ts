import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULE = join(ROOT, 'src', 'slack', 'agent-apps');
const ENTRY_POINTS = new Set(['index.ts', 'host.ts']);
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) ? [path] : [];
  });
}

/** Every import of a file inside the module from a file outside it, as `importer -> target`. */
function moduleImports(): string[] {
  const roots = ['src', 'scripts', 'packages'].map((name) => join(ROOT, name)).filter((path) => existsSync(path));
  return roots.flatMap(sourceFiles)
    .filter((path) => !path.startsWith(MODULE + sep))
    .flatMap((path) => [...readFileSync(path, 'utf8').matchAll(SPECIFIER)].flatMap(([, specifier]) => {
      if (!specifier!.startsWith('.')) return [];
      const target = resolve(dirname(path), specifier!);
      if (!target.startsWith(MODULE + sep)) return [];
      return [`${relative(ROOT, path).split(sep).join('/')} -> ${relative(MODULE, target).split(sep).join('/')}`];
    }));
}

test('nothing outside the Agent app module imports past its index or the host port', () => {
  const imports = moduleImports();
  assert.ok(imports.includes('src/app.ts -> index.ts'), 'the scan sees the module being imported');
  assert.deepEqual(imports.filter((edge) => !ENTRY_POINTS.has(edge.split(' -> ')[1]!)), []);
});
