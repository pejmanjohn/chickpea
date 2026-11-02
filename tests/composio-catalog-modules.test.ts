import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import {
  HELD_COMPOSIO_MANIFESTS,
  compileComposioManifest,
  composioManifestHeader,
} from '../src/connections/catalog/composio-manifests.ts';
import { COMPOSIO_MANIFEST_HEADERS } from '../src/connections/catalog/composio-headers.ts';
import { COMPOSIO_MANIFEST_LOADERS } from '../src/connections/catalog/composio-details.ts';
import {
  MANAGED_CONNECTOR_CATALOG,
  composioHeader,
  createManagedConnectorCatalog,
  loadConnectorDetails,
  requireConnectorDetails,
  type ManagedConnectorHeader,
} from '../src/connections/catalog/index.ts';
import { CapabilityNotLoadedError } from '../src/runtime/on-demand.ts';
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

/** A connector without its tools' descriptions and inputs, as the catalog lists it before its detail loads. */
function header(connector: ManagedConnectorHeader) {
  return {
    ...connector,
    capabilities: connector.capabilities.map((capability) => Object.fromEntries(Object.entries(
      Object.getOwnPropertyDescriptors(capability),
    ).filter(([key]) => key !== 'description' && key !== 'input').map(([key, { value }]) => [key, value]))),
  };
}

test('the headers plus each loaded detail rebuild the catalog that bundled every manifest', async () => {
  const manifests = await readBundledComposioManifests();
  const toolkits = manifests.map(({ toolkit }) => toolkit);
  assert.deepEqual(COMPOSIO_MANIFEST_HEADERS.map(({ toolkit }) => toolkit), toolkits);
  assert.deepEqual(Object.keys(COMPOSIO_MANIFEST_LOADERS), toolkits, 'one loader per header, in order');
  for (const held of Object.keys(HELD_COMPOSIO_MANIFESTS)) assert.equal(toolkits.includes(held), false);
  const handWritten = MANAGED_CONNECTOR_CATALOG.list().filter(({ toolkit }) => !composioHeader(toolkit));
  assert.deepEqual(MANAGED_CONNECTOR_CATALOG.list().map(({ toolkit }) => toolkit),
    [...handWritten.map(({ toolkit }) => toolkit), ...toolkits], 'hand-written connectors first, then manifests');
  for (const manifest of manifests) {
    assert.deepEqual(composioHeader(manifest.toolkit), composioManifestHeader(manifest), manifest.toolkit);
    const expected = compileComposioManifest(manifest);
    assert.deepEqual(header(MANAGED_CONNECTOR_CATALOG.connector(manifest.toolkit)!), header(expected));
    const detail = await MANAGED_CONNECTOR_CATALOG.detail(manifest.toolkit)!.load();
    assert.deepEqual(detail.manifest, manifest, `${manifest.toolkit} input schemas come from the manifest`);
    assert.deepEqual(header(detail.connector), header(expected));
    assert.deepEqual(detail.connector.capabilities.map(({ description }) => description),
      expected.capabilities.map(({ description }) => description));
  }
  for (const connector of handWritten) {
    const detail = await MANAGED_CONNECTOR_CATALOG.detail(connector.toolkit)!.load();
    assert.deepEqual(header(connector), header(detail.connector), connector.toolkit);
    assert.equal(detail.manifest, undefined);
  }
});

test('synchronous code finds a detail only after an async seam loaded it', async () => {
  const catalog = createManagedConnectorCatalog(
    [...(await loadConnectorDetails(['gmail', 'github'])).values()].map(({ connector }) => connector),
  );
  assert.throws(() => requireConnectorDetails(['github'], catalog), (error: unknown) =>
    error instanceof CapabilityNotLoadedError && error.capability === 'connector detail github');
  await loadConnectorDetails(['GitHub', 'unknown_toolkit'], catalog);
  assert.deepEqual([...requireConnectorDetails(['github', 'unknown_toolkit'], catalog).keys()], ['github']);
  assert.throws(() => requireConnectorDetails(['gmail'], catalog), CapabilityNotLoadedError);
});

test('a header leaves out every tool description and input schema', async () => {
  const github = (await readBundledComposioManifests()).find(({ toolkit }) => toolkit === 'github')!;
  const githubHeader = composioManifestHeader(github);
  assert.equal('review' in githubHeader, false);
  for (const capability of githubHeader.capabilities) {
    assert.deepEqual(Object.keys(capability).filter((key) => ['description', 'input', 'tool',
      'withheldArguments', 'preconditions'].includes(key)), []);
  }
  const bytes = (value: unknown) => JSON.stringify(value).length;
  assert.ok(bytes(COMPOSIO_MANIFEST_HEADERS) * 5 < bytes(await readBundledComposioManifests()),
    'the headers are a small part of the manifests');
});

test("a precondition's lookups name capabilities of the same manifest, which the provider compiles alone", async () => {
  for (const manifest of await readBundledComposioManifests()) {
    const ids = new Set(manifest.capabilities.map(({ id }) => id));
    for (const { id, preconditions } of manifest.capabilities) {
      for (const { current, target } of preconditions ?? []) {
        for (const lookup of [current, target]) assert.ok(ids.has(lookup.capability), `${id} looks up ${lookup.capability}`);
      }
    }
  }
});
