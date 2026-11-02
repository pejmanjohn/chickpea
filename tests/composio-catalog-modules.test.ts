import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  COMPOSIO_MANIFESTS,
  HELD_COMPOSIO_MANIFESTS,
  composioManifestHeader,
  parseComposioManifest,
} from '../src/connections/catalog/composio-manifests.ts';
import { COMPOSIO_MANIFEST_HEADERS } from '../src/connections/catalog/composio-headers.ts';
import { COMPOSIO_MANIFEST_LOADERS } from '../src/connections/catalog/composio-details.ts';
import {
  COMPOSIO_CATALOG_MODULES,
  readBundledComposioManifests,
  renderComposioCatalogModules,
} from '../scripts/lib/composio-manifests.ts';

test('regenerating the catalog modules from the committed manifests changes nothing', async () => {
  const modules = renderComposioCatalogModules(await readBundledComposioManifests());
  for (const [name, file] of Object.entries(COMPOSIO_CATALOG_MODULES)) {
    assert.equal(await readFile(file, 'utf8'), modules[name as keyof typeof modules],
      `${path.basename(file)} is stale; run npm run connectors:composio -- generate`);
  }
});

test('the headers and the per-toolkit manifests rebuild the bundled manifests exactly', async () => {
  const toolkits = COMPOSIO_MANIFEST_HEADERS.map(({ toolkit }) => toolkit);
  assert.deepEqual(Object.keys(COMPOSIO_MANIFEST_LOADERS), toolkits, 'one loader per header, in order');
  for (const held of Object.keys(HELD_COMPOSIO_MANIFESTS)) assert.equal(toolkits.includes(held), false);
  const manifests = await Promise.all(COMPOSIO_MANIFEST_HEADERS.map(async (header) => {
    const manifest = parseComposioManifest((await COMPOSIO_MANIFEST_LOADERS[header.toolkit]!()).default);
    assert.deepEqual(header, composioManifestHeader(manifest), `${header.toolkit} header`);
    return manifest;
  }));
  assert.deepEqual(manifests, COMPOSIO_MANIFESTS);
});

test('a header leaves out every tool description and input schema', () => {
  const header = composioManifestHeader(COMPOSIO_MANIFESTS.find(({ toolkit }) => toolkit === 'github')!);
  assert.equal('review' in header, false);
  for (const capability of header.capabilities) {
    assert.deepEqual(Object.keys(capability).filter((key) => ['description', 'input', 'tool',
      'withheldArguments', 'preconditions'].includes(key)), []);
  }
  const bytes = (value: unknown) => JSON.stringify(value).length;
  assert.ok(bytes(COMPOSIO_MANIFEST_HEADERS) * 5 < bytes(COMPOSIO_MANIFESTS),
    'the headers are a small part of the manifests');
});
