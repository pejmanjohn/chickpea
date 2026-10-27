import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import * as v from 'valibot';

import type { ConnectionAccountManagedPolicy } from '../src/config/types.ts';
import {
  COMPOSIO_MANIFESTS,
  HELD_COMPOSIO_MANIFESTS,
  compileComposioManifest,
  parseComposioManifest,
  type ComposioManifest,
} from '../src/connections/catalog/composio-manifests.ts';
import googleMaps from '../src/connections/catalog/manifests/google_maps.json' with { type: 'json' };
import linkedin from '../src/connections/catalog/manifests/linkedin.json' with { type: 'json' };
import { MANAGED_CONNECTOR_CATALOG, createManagedConnectorCatalog } from '../src/connections/catalog/index.ts';
import { ManagedProviderRequestError } from '../src/connections/managed-errors.ts';
import { ComposioManagedConnectionProvider } from '../src/connections/providers/composio.ts';
import {
  MANIFEST_DIRECTORY,
  checkComposioManifest,
  checkComposioManifestDirectory,
  draftComposioManifest,
  fetchComposioToolkit,
  readSnapshot,
  reviewedTools,
  snapshotFromComposio,
  type ComposioSnapshot,
  type ComposioSnapshotTool,
} from '../scripts/lib/composio-manifests.ts';

const VERSION = '20261001_00';

function tool(slug: string, tags: string[], input: unknown = { type: 'object', properties: {} }): ComposioSnapshotTool {
  return {
    slug,
    name: slug,
    description: `Synthetic ${slug.toLowerCase().replaceAll('_', ' ')}.`,
    version: VERSION,
    tags: ['important', ...tags],
    deprecated: false,
    input,
  };
}

function snapshot(tools: ComposioSnapshotTool[]): ComposioSnapshot {
  return {
    toolkit: {
      slug: 'acme',
      name: 'Acme',
      version: VERSION,
      description: 'Synthetic toolkit.',
      managedAuthSchemes: ['OAUTH2'],
      authModes: [{ mode: 'OAUTH2', fields: [] }],
      currentUserEndpoint: 'https://api.example.com/me',
    },
    tools: [tool('ACME_WHO_AM_I', ['readOnlyHint']), ...tools],
  };
}

function lanes(manifest: ComposioManifest): Record<string, string> {
  return Object.fromEntries(manifest.capabilities.map(({ tool: slug, lane }) => [slug, lane]));
}

const PILOT_MANIFESTS = [
  ...COMPOSIO_MANIFESTS,
  ...[googleMaps, linkedin].map((value) => parseComposioManifest(value)),
];

const pilotManifest = (toolkit: string) => structuredClone(
  PILOT_MANIFESTS.find((manifest) => manifest.toolkit === toolkit)!,
) as ComposioManifest;

const TRELLO_CONNECTOR = compileComposioManifest(pilotManifest('trello'));

const trelloCapability = (id: string) => TRELLO_CONNECTOR.capabilities.find((capability) => capability.id === id);

test('every committed manifest matches the generator output for its pinned snapshot', async () => {
  assert.deepEqual(await checkComposioManifestDirectory(), []);
});

type ToolPage = { items: unknown[]; next_cursor: string | null };

function composioCatalog(pages: Record<string, ToolPage> | ((cursor: string) => ToolPage)) {
  const requested: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const address = new URL(String(url));
    requested.push(address.search);
    const cursor = address.searchParams.get('cursor') ?? '';
    const body = address.pathname.endsWith('/toolkits/acme')
      ? { slug: 'acme', name: 'Acme', meta: { version: VERSION, description: '' }, composio_managed_auth_schemes: ['OAUTH2'] }
      : typeof pages === 'function' ? pages(cursor) : pages[cursor];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, requested };
}

const listed = (slug: string) => ({
  slug, name: slug, description: '', version: VERSION, tags: ['important', 'readOnlyHint'], input_parameters: {},
});

test('the snapshot fetch follows the tool list cursor to the last page', async () => {
  const { fetchImpl, requested } = composioCatalog({
    '': { items: [listed('ACME_WHO_AM_I')], next_cursor: 'page-2' },
    'page-2': { items: [listed('ACME_LIST_NOTES')], next_cursor: null },
  });

  const [detail, tools] = await fetchComposioToolkit('acme', 'test-key', fetchImpl);

  assert.deepEqual(snapshotFromComposio(detail, tools, new Set()).tools.map(({ slug }) => slug), [
    'ACME_LIST_NOTES', 'ACME_WHO_AM_I',
  ]);
  assert.equal(requested.filter((search) => search.includes('toolkit_slug=acme')).length, 2);
});

test('the snapshot fetch fails instead of looping on a cursor that never ends', async () => {
  const repeating = composioCatalog({
    '': { items: [listed('ACME_WHO_AM_I')], next_cursor: 'again' },
    again: { items: [], next_cursor: 'again' },
  });
  await assert.rejects(fetchComposioToolkit('acme', 'test-key', repeating.fetchImpl), /did not end/);

  const endless = composioCatalog((cursor) => ({ items: [], next_cursor: `${cursor}x` }));
  await assert.rejects(fetchComposioToolkit('acme', 'test-key', endless.fetchImpl), /did not end/);
  assert.ok(endless.requested.length < 100, `${endless.requested.length} requests`);
});

test('a read-tagged tool whose name or description writes is excluded, never placed in the read lane', () => {
  const { manifest, report } = draftComposioManifest(snapshot([
    tool('ACME_MARK_NOTEBOOK_AS_DELETED', ['readOnlyHint']),
    tool('ACME_PING_WEBHOOK_SUBSCRIPTION', ['readOnlyHint']),
    { ...tool('ACME_GET_EXPORT', ['readOnlyHint']), description: 'Creates a new export job.' },
    tool('ACME_LIST_NOTEBOOKS', ['readOnlyHint']),
  ]));

  assert.deepEqual(lanes(manifest), {
    ACME_LIST_NOTEBOOKS: 'read',
    ACME_WHO_AM_I: 'read',
  });
  assert.deepEqual(report.excluded.map(({ tool: slug }) => slug).sort(), [
    'ACME_GET_EXPORT', 'ACME_MARK_NOTEBOOK_AS_DELETED', 'ACME_PING_WEBHOOK_SUBSCRIPTION',
  ]);
});

test('no tool, read or write, picks who it acts as or makes the provider mint a shareable link', () => {
  const text = (description = 'Text.') => ({ type: 'string', description });
  const exportMode = (fallback: string) =>
    ({ type: 'string', enum: ['return_text', 'store_and_link'], default: fallback });
  const { manifest, report } = draftComposioManifest(snapshot([
    tool('ACME_SEARCH_FILES', ['readOnlyHint'], {
      type: 'object',
      properties: {
        query: text(),
        type: { type: 'string', enum: ['file', 'folder', 'web_link'] },
        include_recent_shared_links: { type: 'boolean' },
        'Acme-API-Select-User': text('Team member whose account the call reads.'),
        'Acme-API-Path-Root': text('Namespace that paths resolve in.'),
      },
    }),
    tool('ACME_EXPORT_FILE', ['readOnlyHint'], {
      type: 'object', properties: { path: text(), mode: exportMode('return_text') }, required: ['path'],
    }),
    tool('ACME_EXPORT_LINK', ['readOnlyHint'], {
      type: 'object', properties: { path: text(), mode: exportMode('store_and_link') }, required: ['path'],
    }),
    tool('ACME_EXPORT_PDF', ['readOnlyHint'], {
      type: 'object',
      properties: { path: text(), generate_public_url: { type: 'boolean', default: true } },
      required: ['path'],
    }),
    {
      ...tool('ACME_RENDER_IMAGES', ['readOnlyHint'], { type: 'object', properties: { ids: text() } }),
      description: 'Render nodes as images. Returns a map of node IDs to temporary image URLs.',
    },
    tool('ACME_CREATE_SHARED_LINK', ['createHint'], { type: 'object', properties: { path: text() } }),
    tool('ACME_UPDATE_DOCUMENT', ['updateHint'], {
      type: 'object',
      properties: { path: text(), title: text(), as_user: text(), create_download_link: { type: 'boolean' } },
      required: ['path'],
    }),
  ]));
  const capability = (slug: string) => manifest.capabilities.find(({ tool: name }) => name === slug)!;
  const excluded = (slug: string) => report.excluded.find(({ tool: name }) => name === slug)?.reason;

  assert.deepEqual(Object.keys(capability('ACME_SEARCH_FILES').input.properties),
    ['query', 'type', 'include_recent_shared_links']);
  assert.deepEqual(capability('ACME_SEARCH_FILES').withheldArguments, {
    'Acme-API-Select-User': 'picks the user, admin, or namespace the call acts as',
    'Acme-API-Path-Root': 'picks the user, admin, or namespace the call acts as',
  });
  assert.deepEqual(capability('ACME_EXPORT_FILE').withheldArguments,
    { mode: 'can make the provider mint a link anyone holding it can open' });
  assert.deepEqual(Object.keys(capability('ACME_UPDATE_DOCUMENT').input.properties), ['path', 'title']);
  assert.match(excluded('ACME_EXPORT_LINK') ?? '', /mode mints a shareable link by default/);
  assert.match(excluded('ACME_EXPORT_PDF') ?? '', /generate_public_url mints a shareable link by default/);
  assert.match(excluded('ACME_RENDER_IMAGES') ?? '', /read lint hit "temporary image URLs"/);
  assert.match(excluded('ACME_CREATE_SHARED_LINK') ?? '', /^external_publish/);
});

test('no tool takes a credential from the model, and a tool that needs one is excluded', () => {
  const text = (description: string) => ({ type: 'string', description });
  const { manifest, report } = draftComposioManifest(snapshot([
    tool('ACME_GET_FILE', ['readOnlyHint'], {
      type: 'object',
      properties: {
        file_id: text('File to read.'),
        access_token: text('Optional token that pre-authenticates the request so a link works without sign-in.'),
        oauth_token: text('OAuth 2.0 token for the current user.'),
        key: text('API key. Identifies your project for quota.'),
        shared_link_password: text('Password for the shared link.'),
        page_token: text('Opaque continuation token for the next page.'),
        pageToken: text('Page token returned by a previous call.'),
        skip_token: text('Skip token for paging through large result sets.'),
        delta_token: text('Delta token from a previous call to get only changes.'),
        token: text('A token used to retrieve a page of results or changes since a previous state.'),
        file_key: text('File key from the design URL.'),
        templateKey: text('The key of the metadata template used to filter results.'),
        alert_key: text('Alert de-duplication key.'),
        incident_key: text('Incident de-duplication key.'),
      },
      required: ['file_id'],
    }),
    tool('ACME_GET_COMPONENT', ['readOnlyHint'], {
      type: 'object', properties: { key: text('The unique identifier of the component.') }, required: ['key'],
    }),
    tool('ACME_UPDATE_TABLE', ['updateHint'], {
      type: 'object',
      properties: {
        table_id: text('Table to update.'),
        kmsKeyName: text('Cloud KMS encryption key name that protects the table.'),
        client_secret: text('Secret of the client application.'),
      },
      required: ['table_id'],
    }),
    tool('ACME_GET_EXPORT', ['readOnlyHint'], {
      type: 'object', properties: { id: text('Export to read.'), api_key: text('Key for the export service.') },
      required: ['id', 'api_key'],
    }),
    tool('ACME_GET_SESSION', ['readOnlyHint'], {
      type: 'object',
      properties: {
        token: text('Authentication token for the account.'),
        api_token: text('Token.'),
        apiToken: text('Token.'),
        session_token: text('Token.'),
        app_key: text('Key.'),
        sas_token: text('Signature.'),
        jwt: text('Signed claims.'),
        passcode: text('Code.'),
        header: text('Your api-key.'),
        auth: text('An API token for the workspace.'),
        cookie: text('A session token from the browser.'),
        token_id: text('The API token to use.'),
        credentialId: { type: 'integer', description: 'The numeric identifier for the credential of a connected calendar.' },
        is_passcode_required: { type: 'boolean', description: 'Whether joining needs a passcode.' },
      },
    }),
  ]));
  const capability = (slug: string) => manifest.capabilities.find(({ tool: name }) => name === slug)!;
  const credential = 'carries a credential the model would supply itself';

  assert.deepEqual(capability('ACME_GET_FILE').withheldArguments, {
    access_token: credential, oauth_token: credential, key: credential, shared_link_password: credential,
  });
  assert.deepEqual(Object.keys(capability('ACME_GET_SESSION').input.properties), ['credentialId', 'is_passcode_required']);
  assert.deepEqual(Object.keys(capability('ACME_GET_SESSION').withheldArguments!), [
    'token', 'api_token', 'apiToken', 'session_token', 'app_key', 'sas_token', 'jwt', 'passcode', 'header', 'auth', 'cookie',
    'token_id',
  ]);
  assert.deepEqual(Object.keys(capability('ACME_GET_FILE').input.properties), [
    'file_id', 'page_token', 'pageToken', 'skip_token', 'delta_token', 'token', 'file_key', 'templateKey',
    'alert_key', 'incident_key',
  ]);
  assert.deepEqual(capability('ACME_GET_COMPONENT').input.required, ['key']);
  assert.deepEqual(Object.keys(capability('ACME_UPDATE_TABLE').input.properties), ['table_id', 'kmsKeyName']);
  assert.deepEqual(capability('ACME_UPDATE_TABLE').withheldArguments, { client_secret: credential });
  assert.equal(report.excluded.find(({ tool: slug }) => slug === 'ACME_GET_EXPORT')?.reason,
    `required argument api_key ${credential}`);
});

test('a read that returns expiring, signed, or outside-hosted URLs is excluded, and plain links stay', () => {
  const read = (slug: string, description: string) => ({ ...tool(slug, ['readOnlyHint']), description });
  const { manifest, report } = draftComposioManifest(snapshot([
    read('ACME_DOWNLOAD_IMAGES', 'Renders nodes as images. NOTE: Returned image URLs expire shortly after generation.'),
    read('ACME_GET_THUMBNAILS', 'Gets item thumbnails. Returned thumbnail URLs are external HTTP endpoints.'),
    read('ACME_GET_PREVIEW', 'Gets a preview of the item. Preview links that expire must be regenerated.'),
    read('ACME_GET_ASSET', 'Returns a signed URL for the asset.'),
    read('ACME_GET_ATTACHMENT', 'Returns an expiring download link for the attachment.'),
    read('ACME_GET_EMBED', 'Returns a pre-authenticated URL for an embedded view.'),
    read('ACME_GET_EXPORT', 'Returns a download URL which expires after an hour.'),
    read('ACME_GET_RECORDING', 'Returns the recording location, valid for 15 minutes.'),
    read('ACME_GET_CLIP', 'Returns the clip location, valid for an hour.'),
    read('ACME_GET_LOGO', 'Returns the logo. The returned URL is valid until the session ends.'),
    read('ACME_GET_COVER', 'Returns the cover image. Its URLs are temporary.'),
    read('ACME_GET_OBJECT', 'Returns a presigned address for the object.'),
    read('ACME_GET_TICKET', 'Returns a download ticket that expires in 10 minutes.'),
    read('ACME_GET_SNAPSHOT', 'Returns a short-lived address for the snapshot.'),
    read('ACME_GET_REPORT', 'Returns a time-limited address for the report.'),
    read('ACME_GET_BADGE', 'Returns an unauthenticated address for the badge image.'),
    read('ACME_LIST_PAGES', 'Lists pages with their URLs and the links between them.'),
  ]));
  const reason = (slug: string) => report.excluded.find(({ tool: name }) => name === slug)?.reason ?? '';

  assert.deepEqual(lanes(manifest), { ACME_LIST_PAGES: 'read', ACME_WHO_AM_I: 'read' });
  assert.match(reason('ACME_GET_EXPORT'), /read lint hit "URL which expires"/);
  assert.match(reason('ACME_GET_RECORDING'), /read lint hit "valid for 15 minutes"/);
  assert.match(reason('ACME_GET_CLIP'), /read lint hit "valid for an hour"/);
  assert.match(reason('ACME_GET_LOGO'), /read lint hit "URL is valid"/);
  assert.match(reason('ACME_GET_COVER'), /read lint hit "URLs are temporary"/);
  assert.match(reason('ACME_GET_OBJECT'), /read lint hit "presigned"/);
  assert.match(reason('ACME_GET_TICKET'), /read lint hit "expires in"/);
  assert.match(reason('ACME_GET_SNAPSHOT'), /read lint hit "short-lived"/);
  assert.match(reason('ACME_GET_REPORT'), /read lint hit "time-limited"/);
  assert.match(reason('ACME_GET_BADGE'), /read lint hit "unauthenticated"/);
  assert.match(reason('ACME_DOWNLOAD_IMAGES'), /read lint hit "URLs expire"/);
  assert.match(reason('ACME_GET_THUMBNAILS'), /read lint hit "URLs are external"/);
  assert.match(reason('ACME_GET_PREVIEW'), /read lint hit "links that expire"/);
  assert.match(reason('ACME_GET_ASSET'), /read lint hit "signed URL"/);
  assert.match(reason('ACME_GET_ATTACHMENT'), /read lint hit "expiring download link"/);
  assert.match(reason('ACME_GET_EMBED'), /read lint hit "pre-authenticated URL"/);
});

test('a tool whose result is a file on Composio storage is excluded, and the snapshot records which tools return one', () => {
  const file = { type: 'object', file_downloadable: true, properties: { s3url: { type: 'string' } } };
  const output = (content: unknown) => ({
    type: 'object',
    $defs: { Download: { type: 'object', properties: { content: { $ref: '#/$defs/File' } } }, File: content },
    properties: { data: { $ref: '#/$defs/Download' } },
  });
  const listing = (slug: string, content: unknown) => ({
    ...listed(slug), input_parameters: { type: 'object', properties: {} }, output_parameters: output(content),
  });
  const fetched = snapshotFromComposio(
    { slug: 'acme', name: 'Acme', meta: { version: VERSION, description: '' }, composio_managed_auth_schemes: ['OAUTH2'] },
    { items: [
      listing('ACME_WHO_AM_I', { type: 'object', properties: { name: { type: 'string' } } }),
      listing('ACME_READ_FILE', file),
      listing('ACME_EXPORT_SCAN', { type: 'object', file_downloadable: 'true', properties: { name: { type: 'string' } } }),
      listing('ACME_EXPORT_REPORT', { type: 'object', properties: { s3url: { type: 'string' }, mimetype: { type: 'string' } } }),
      listing('ACME_LIST_FILES', { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } } } }),
    ] },
    new Set(),
  );
  assert.deepEqual(fetched.tools.filter((entry) => entry.returnsHostedFile).map(({ slug }) => slug), [
    'ACME_EXPORT_REPORT', 'ACME_EXPORT_SCAN', 'ACME_READ_FILE',
  ]);

  const { manifest, report } = draftComposioManifest(fetched);
  assert.deepEqual(lanes(manifest), { ACME_LIST_FILES: 'read', ACME_WHO_AM_I: 'read' });
  assert.match(report.excluded.find(({ tool: slug }) => slug === 'ACME_READ_FILE')!.reason,
    /^returns the file as a download URL on Composio storage/);
});

test('every committed snapshot marks the tools that return a file on Composio storage, and none ships', async () => {
  const marked: string[] = [];
  for (const manifest of PILOT_MANIFESTS) {
    const pinned = await readSnapshot(manifest.toolkit, manifest.version);
    const hosted = new Set(pinned.tools.filter((entry) => entry.returnsHostedFile).map(({ slug }) => slug));
    marked.push(...hosted);
    assert.deepEqual(manifest.capabilities.filter(({ tool: slug }) => hosted.has(slug)), [], manifest.toolkit);
  }
  assert.deepEqual(marked.sort(), [
    'BITBUCKET_DOWNLOAD_REPOSITORY_ARCHIVE', 'BOX_DOWNLOAD_FILE', 'DROPBOX_READ_FILE', 'FIGMA_DOWNLOAD_FIGMA_IMAGES',
    'GOOGLE_MAPS_PLACE_PHOTO', 'MICROSOFT_TEAMS_GET_MEETING_RECORDING_CONTENT', 'ONE_DRIVE_DOWNLOAD_FILE',
    'OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT', 'SALESFORCE_GET_FILE_CONTENT', 'SHARE_POINT_DOWNLOAD_FILE_BY_SERVER_RELATIVE_URL',
    'ZOHO_DOWNLOAD_RECORD_ATTACHMENT', 'ZOHO_DOWNLOAD_RECORD_PHOTO',
  ]);
});

test('link, act-as, and overwrite rules see through optional wrappers, arrays, and share or download wording', () => {
  const flag = { type: 'boolean' };
  const { manifest, report } = draftComposioManifest(snapshot([
    tool('ACME_SEARCH_FILES', ['readOnlyHint'], {
      type: 'object',
      properties: {
        query: { type: 'string' },
        include_download_url: flag,
        get_link: flag,
        share_link: flag,
        include_recent_shared_links: flag,
        format: { type: 'string', enum: ['json', 'url'] },
        type: { type: 'string', enum: ['file', 'folder', 'web_link'] },
        export_modes: { type: 'array', items: { type: 'string', enum: ['text', 'store_and_link'] } },
        direct_link: flag,
        embed_link: flag,
        include_preview_url: flag,
        expiring_link: flag,
        thumbnail_url: flag,
        link_type: { type: 'string', enum: ['shared', 'direct_link'] },
        delivery: { type: 'string', enum: ['inline', 'presigned'] },
        view: { type: 'string', enum: ['full', 'preview_link'] },
        sudo: { type: 'string' },
        run_as: { type: 'string' },
        actor_id: { type: 'string' },
        as_admin: flag,
        actor: { type: 'string' },
        delegated_user: { type: 'string' },
      },
    }),
    tool('ACME_EXPORT_FILE', ['readOnlyHint'], {
      type: 'object',
      properties: {
        path: { type: 'string' },
        mode: { anyOf: [{ type: 'string', enum: ['text', 'store_and_link'], default: 'store_and_link' }, { type: 'null' }] },
      },
      required: ['path'],
    }),
    tool('ACME_EXPORT_NESTED', ['readOnlyHint'], {
      type: 'object',
      properties: {
        path: { type: 'string' },
        opts: { type: 'object', properties: { mode: { type: 'string', enum: ['text', 'store_and_link'], default: 'store_and_link' } } },
      },
      required: ['path'],
    }),
    tool('ACME_CREATE_FOLDERS', ['createHint'], {
      type: 'object',
      properties: {
        name: { type: 'string' },
        conflict_modes: { type: 'array', items: { type: 'string', enum: ['skip', 'replace'] } },
      },
      required: ['name'],
    }),
  ]));
  const capability = (slug: string) => manifest.capabilities.find(({ tool: name }) => name === slug)!;
  const link = 'can make the provider mint a link anyone holding it can open';
  const acting = 'picks the user, admin, or namespace the call acts as';

  assert.deepEqual(Object.keys(capability('ACME_SEARCH_FILES').input.properties), ['query', 'include_recent_shared_links', 'type']);
  assert.deepEqual(capability('ACME_SEARCH_FILES').withheldArguments, {
    include_download_url: link, get_link: link, share_link: link, format: link, export_modes: link,
    direct_link: link, embed_link: link, include_preview_url: link, expiring_link: link, thumbnail_url: link,
    link_type: link, delivery: link, view: link,
    sudo: acting, run_as: acting, actor_id: acting, as_admin: acting, actor: acting, delegated_user: acting,
  });
  assert.match(report.excluded.find(({ tool: slug }) => slug === 'ACME_EXPORT_FILE')!.reason,
    /mode mints a shareable link by default/);
  assert.equal(report.excluded.find(({ tool: slug }) => slug === 'ACME_EXPORT_NESTED')?.reason,
    'opts.mode mints a shareable link by default');
  assert.deepEqual(capability('ACME_CREATE_FOLDERS').withheldArguments, { conflict_modes: 'can replace an existing item' });
});

test('a bare url or link value is a link mode only on an argument that picks the output', () => {
  const { manifest } = draftComposioManifest(snapshot([
    tool('ACME_GET_AUTHORITY_PROFILE', ['readOnlyHint'], {
      type: 'object',
      properties: {
        target: { type: 'string' },
        target_type: { type: 'string', enum: ['root_domain', 'domain', 'subdomain', 'url'] },
        by: { type: 'array', items: { type: 'string', enum: ['$flow', 'url', 'link'] } },
        return_type: { type: 'string', enum: ['content', 'url'] },
        kind: { type: 'string', enum: ['inline', 'link'], description: 'Chooses how the results are returned.' },
      },
      required: ['target', 'target_type'],
    }),
  ]));
  const capability = manifest.capabilities.find(({ tool: name }) => name === 'ACME_GET_AUTHORITY_PROFILE')!;
  const link = 'can make the provider mint a link anyone holding it can open';
  assert.deepEqual(Object.keys(capability.input.properties), ['target', 'target_type', 'by']);
  assert.deepEqual(capability.withheldArguments, { return_type: link, kind: link });
});

test('a reviewer cannot keep a withheld argument on a read, and the error names why the rule withholds it', () => {
  const search = tool('ACME_SEARCH_FILES', ['readOnlyHint'], {
    type: 'object', properties: { query: { type: 'string' }, as_user: { type: 'string' } },
  });
  const generated = draftComposioManifest(snapshot([search]));
  assert.throws(() => draftComposioManifest(snapshot([search]), {
    ...generated.manifest,
    review: { add: ['ACME_SEARCH_FILES'], drop: {}, allowArguments: { ACME_SEARCH_FILES: ['as_user'] } },
  }), /review\.allowArguments keeps ACME_SEARCH_FILES as_user, which picks the user, admin, or namespace the call acts as; a read tool cannot keep a withheld argument/);
});

test('the check rejects a write tool hand-moved into the read lane', async () => {
  const manifest = pilotManifest('trello');
  const card = manifest.capabilities.find(({ tool: slug }) => slug === 'TRELLO_UPDATE_CARDS_BY_ID_CARD')!;
  const { sideEffectLabel: _label, ...rest } = card;
  manifest.capabilities[manifest.capabilities.indexOf(card)] = { ...rest, lane: 'read', effect: 'read' };

  const problems = checkComposioManifest(manifest, await readSnapshot('trello', manifest.version));

  assert.ok(
    problems.some((problem) => problem.includes('TRELLO_UPDATE_CARDS_BY_ID_CARD') && problem.includes('lane')),
    problems.join('\n'),
  );
});

test('a read-lane capability that declares a write effect does not parse', () => {
  const manifest = pilotManifest('trello');
  const read = manifest.capabilities.find(({ lane }) => lane === 'read')!;
  read.effect = 'reversible_write';
  assert.throws(() => parseComposioManifest(manifest), /inconsistent lane/);
});

test('destructive tools stay out unless a reviewer adds them, and then only in the write lane', () => {
  const tools = [
    tool('ACME_DELETE_NOTEBOOK', ['destructiveHint']),
    tool('ACME_SEND_INVOICE', ['createHint']),
    tool('ACME_CREATE_NOTEBOOK', ['createHint']),
  ];
  const generated = draftComposioManifest(snapshot(tools)).manifest;
  assert.deepEqual(lanes(generated), { ACME_CREATE_NOTEBOOK: 'write', ACME_WHO_AM_I: 'read' });

  const reviewed = draftComposioManifest(snapshot(tools), {
    ...generated,
    review: { add: ['ACME_DELETE_NOTEBOOK'], drop: {}, allowArguments: {} },
  }).manifest;
  const destructive = reviewed.capabilities.find(({ tool: slug }) => slug === 'ACME_DELETE_NOTEBOOK');
  assert.equal(destructive?.lane, 'write');
  assert.equal(destructive?.effect, 'destructive');
  assert.equal(reviewed.capabilities.some(({ tool: slug }) => slug === 'ACME_SEND_INVOICE'), false);
});

test('a create or update tool whose name or description is irreversible is destructive and needs review', () => {
  const tools = [
    tool('ACME_MERGE_TICKETS', ['updateHint']),
    tool('ACME_MOVE_NOTE_TO_TRASH', ['updateHint']),
    tool('ACME_VOID_RECEIPT', ['updateHint']),
    tool('ACME_CANCEL_BOOKING', ['updateHint']),
    tool('ACME_DELETE_DRAFT', ['createHint']),
    tool('ACME_SET_BOOKING_CANCELLED', ['updateHint']),
    { ...tool('ACME_UPDATE_RECORD_STATE', ['updateHint']), description: 'Archives a record so it no longer appears.' },
    tool('ACME_UPDATE_NOTE', ['updateHint']),
  ];
  const { manifest, report } = draftComposioManifest(snapshot(tools));

  assert.deepEqual(lanes(manifest), { ACME_UPDATE_NOTE: 'write', ACME_WHO_AM_I: 'read' });
  assert.deepEqual(report.irreversible, [
    { tool: 'ACME_CANCEL_BOOKING', verb: 'CANCEL' },
    { tool: 'ACME_DELETE_DRAFT', verb: 'DELETE' },
    { tool: 'ACME_MERGE_TICKETS', verb: 'MERGE' },
    { tool: 'ACME_MOVE_NOTE_TO_TRASH', verb: 'TRASH' },
    { tool: 'ACME_SET_BOOKING_CANCELLED', verb: 'CANCELLED' },
    { tool: 'ACME_UPDATE_RECORD_STATE', verb: 'archive' },
    { tool: 'ACME_VOID_RECEIPT', verb: 'VOID' },
  ]);
  for (const { tool: slug } of report.irreversible) {
    assert.match(report.excluded.find((entry) => entry.tool === slug)!.reason, /^destructive \(irreversible verb/, slug);
  }

  const merge = draftComposioManifest(snapshot(tools), {
    ...manifest,
    review: { add: ['ACME_MERGE_TICKETS'], drop: {}, allowArguments: {} },
  }).manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_MERGE_TICKETS');
  assert.equal(merge?.lane, 'write');
  assert.equal(merge?.effect, 'destructive');
});

const IRREVERSIBLE_SYNONYMS = [
  'DROP', 'WIPE', 'TRUNCATE', 'DISCARD', 'TERMINATE', 'EXPIRE', 'CLEAR', 'EMPTY', 'UNLINK', 'DETACH',
];
const ONE_WAY_ACTIONS = [
  'RESET', 'ROTATE', 'REGENERATE', 'OVERWRITE', 'SUBMIT', 'APPROVE', 'REJECT', 'DECLINE', 'FINALIZE', 'EXECUTE', 'DEPLOY',
];

for (const [kind, verbs] of [['delete synonym', IRREVERSIBLE_SYNONYMS], ['one-way action', ONE_WAY_ACTIONS]] as const) {
  test(`a create or update tool named for a ${kind} is destructive and needs review`, () => {
    const tools = verbs.map((verb, index) => tool(`ACME_${verb}_WIDGET`, [index % 2 ? 'createHint' : 'updateHint']));
    const { manifest, report } = draftComposioManifest(snapshot([...tools, tool('ACME_UPDATE_WIDGET', ['updateHint'])]));

    assert.deepEqual(lanes(manifest), { ACME_UPDATE_WIDGET: 'write', ACME_WHO_AM_I: 'read' });
    assert.deepEqual(
      report.irreversible.map(({ verb }) => verb).sort(),
      [...verbs].sort(),
    );
    for (const { tool: slug } of report.irreversible) {
      assert.match(report.excluded.find((entry) => entry.tool === slug)!.reason, /^destructive \(irreversible verb/, slug);
    }
  });
}

test('the irreversibility lint reads past participles and a leading adverb in the description', () => {
  const { manifest, report } = draftComposioManifest(snapshot([
    tool('ACME_SET_FORM_SUBMITTED', ['updateHint']),
    tool('ACME_MARK_TABLE_DROPPED', ['updateHint']),
    { ...tool('ACME_UPDATE_RECORD_STATE', ['updateHint']), description: 'Permanently deletes the record and its history.' },
    { ...tool('ACME_PATCH_VAULT', ['updateHint']), description: 'Irreversibly wipes every entry in the vault.' },
    { ...tool('ACME_GET_RECORD', ['readOnlyHint']), description: 'Permanently deletes the record.' },
  ]));

  assert.deepEqual(lanes(manifest), { ACME_WHO_AM_I: 'read' });
  assert.deepEqual(report.irreversible, [
    { tool: 'ACME_MARK_TABLE_DROPPED', verb: 'DROPPED' },
    { tool: 'ACME_PATCH_VAULT', verb: 'wipe' },
    { tool: 'ACME_SET_FORM_SUBMITTED', verb: 'SUBMITTED' },
    { tool: 'ACME_UPDATE_RECORD_STATE', verb: 'delete' },
  ]);
  assert.match(report.excluded.find(({ tool: slug }) => slug === 'ACME_GET_RECORD')!.reason, /^read lint hit "delete"/);
});

test('clear and empty count only as verbs, and a query read that executes stays a read', () => {
  const { manifest } = draftComposioManifest(snapshot([
    tool('ACME_CLEAR_CACHE', ['updateHint']),
    tool('ACME_CREATE_EMPTY_BOARD', ['createHint']),
    tool('ACME_UPDATE_CLEAR_TEXT_NOTE', ['updateHint']),
    tool('ACME_ENRICH_WITH_CLEARBIT', ['updateHint']),
    { ...tool('ACME_GET_CLEARBIT_COMPANY', ['readOnlyHint']), description: 'Clearbit firmographics for a company domain.' },
    { ...tool('ACME_LIST_CLEARED_PAYMENTS', ['readOnlyHint']), description: 'Cleared payments in a date range.' },
    { ...tool('ACME_RUN_QUERY', ['readOnlyHint']), description: 'Executes a SOQL query and returns the matching records.' },
  ]));

  assert.deepEqual(lanes(manifest), {
    ACME_CREATE_EMPTY_BOARD: 'write',
    ACME_ENRICH_WITH_CLEARBIT: 'write',
    ACME_GET_CLEARBIT_COMPANY: 'read',
    ACME_LIST_CLEARED_PAYMENTS: 'read',
    ACME_RUN_QUERY: 'read',
    ACME_UPDATE_CLEAR_TEXT_NOTE: 'write',
    ACME_WHO_AM_I: 'read',
  });
});

test('a write that sets a password, credential, secret, token, or API key is administrative and needs review', () => {
  const slugs = [
    'ACME_SET_PASSWORD', 'ACME_UPDATE_USER_PASSWORD', 'ACME_CREATE_CREDENTIAL', 'ACME_UPDATE_SECRETS',
    'ACME_CREATE_ACCESS_TOKEN', 'ACME_CREATE_API_KEY', 'ACME_RESET_PASSWORD',
  ];
  const { manifest, report } = draftComposioManifest(snapshot(slugs.map((slug) => tool(slug, ['createHint']))));

  assert.deepEqual(lanes(manifest), { ACME_WHO_AM_I: 'read' });
  for (const slug of slugs) {
    assert.match(report.excluded.find((entry) => entry.tool === slug)!.reason, /^(?:administrative|destructive)\b/, slug);
  }
  assert.match(report.excluded.find(({ tool: slug }) => slug === 'ACME_SET_PASSWORD')!.reason, /^administrative/);
});

test('the check rejects a destructive tool slipped into a manifest without review', async () => {
  const manifest = pilotManifest('trello');
  const snapshotValue = await readSnapshot('trello', manifest.version);
  const deleteCard = snapshotValue.tools.find(({ slug }) => slug === 'TRELLO_DELETE_CARDS_BY_ID_CARD')!;
  manifest.capabilities.push({
    id: 'trello.delete_cards_by_id_card',
    tool: deleteCard.slug,
    toolName: 'trello_delete_cards_by_id_card',
    lane: 'write',
    effect: 'destructive',
    description: deleteCard.description,
    sideEffectLabel: 'Trello: Delete card',
    maxResultBytes: 65_536,
    input: {
      type: 'object',
      properties: { idCard: { type: 'string', maxLength: 20_000 } },
      required: ['idCard'],
    },
  });

  const problems = checkComposioManifest(manifest, snapshotValue);

  assert.ok(problems.some((problem) => problem.includes('TRELLO_DELETE_CARDS_BY_ID_CARD')), problems.join('\n'));
});

test('a tool whose required argument cannot be bounded is excluded rather than sent without it', () => {
  const { manifest, report } = draftComposioManifest(snapshot([
    tool('ACME_CREATE_CONTACT', ['createHint'], {
      type: 'object',
      properties: {
        name: { type: 'string' },
        custom_fields: { type: 'object', additionalProperties: true },
      },
      required: ['name', 'custom_fields'],
    }),
    tool('ACME_UPDATE_CONTACT', ['updateHint'], {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        custom_fields: { type: 'object', additionalProperties: true },
      },
      required: ['id'],
    }),
  ]));

  assert.equal(manifest.capabilities.some(({ tool: slug }) => slug === 'ACME_CREATE_CONTACT'), false);
  assert.match(report.excluded.find(({ tool: slug }) => slug === 'ACME_CREATE_CONTACT')!.reason, /required/);
  const update = manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_UPDATE_CONTACT')!;
  assert.deepEqual(update.input.required, ['id']);
  assert.deepEqual(report.withheldArguments, [{
    tool: 'ACME_UPDATE_CONTACT', arguments: { custom_fields: 'unsupported schema' },
  }]);
});

test('write tools lose sharing, permission, move, and copy arguments, and the report names each one', () => {
  const string = (description = 'Text.') => ({ type: 'string', description });
  const { manifest, report } = draftComposioManifest(snapshot([
    tool('ACME_CREATE_BOARD', ['createHint'], {
      type: 'object',
      properties: {
        name: string(),
        prefs_permissionLevel: string("Board visibility ('org', 'private', 'public')."),
        prefs__comments: string('Who can comment on cards.'),
        idMembers: string(),
        idOrganization: string(),
        idBoardSource: string(),
        idWorkspace: string(),
      },
    }),
    tool('ACME_UPDATE_CARD', ['updateHint'], {
      type: 'object',
      properties: { idCard: string(), idBoard: string(), idList: string(), name: string() },
      required: ['idCard'],
    }),
    tool('ACME_UPDATE_FOLDER', ['updateHint'], {
      type: 'object',
      properties: {
        folder_id: string(),
        name: string(),
        parent: { type: 'object', properties: { id: string('The new parent folder.') } },
      },
      required: ['folder_id'],
    }),
    tool('ACME_LIST_BOARDS', ['readOnlyHint'], {
      type: 'object',
      properties: { filter_visibility: string('Only boards with this visibility.') },
    }),
  ]));
  const properties = (slug: string) =>
    Object.keys(manifest.capabilities.find(({ tool: name }) => name === slug)!.input.properties);

  assert.deepEqual(properties('ACME_CREATE_BOARD'), ['name', 'idWorkspace']);
  assert.deepEqual(properties('ACME_UPDATE_CARD'), ['idCard', 'idList', 'name']);
  assert.deepEqual(properties('ACME_UPDATE_FOLDER'), ['folder_id', 'name']);
  assert.deepEqual(properties('ACME_LIST_BOARDS'), ['filter_visibility']);
  assert.deepEqual(Object.keys(report.withheldArguments.find(({ tool: slug }) => slug === 'ACME_CREATE_BOARD')!.arguments), [
    'prefs_permissionLevel', 'prefs__comments', 'idMembers', 'idOrganization', 'idBoardSource',
  ]);
  assert.deepEqual(
    manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_UPDATE_CARD')!.withheldArguments,
    { idBoard: 'moves the record to another container' },
  );
  assert.deepEqual(
    manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_UPDATE_FOLDER')!.withheldArguments,
    { parent: 'moves the record to another container' },
  );
});

test('update tools lose a destination given as an optional object, a list of parents, or a path', () => {
  const text = { type: 'string' };
  const { manifest } = draftComposioManifest(snapshot([
    tool('ACME_UPDATE_ITEM', ['updateHint'], {
      type: 'object',
      properties: {
        item_id: text,
        name: text,
        folder_name: text,
        parent: { anyOf: [{ type: 'object', properties: { id: text } }, { type: 'null' }] },
        parents: { type: 'array', items: text },
        destination_folder: text,
        parent_reference: { type: 'object', properties: { path: text } },
        folder: { type: ['object', 'null'], properties: { id: text } },
        parent_folder: text,
        new_parent: text,
        move_to: text,
      },
      required: ['item_id'],
    }),
    tool('ACME_CREATE_PULL_REQUEST', ['createHint'], {
      type: 'object', properties: { title: text, destination_branch: text, parent_folder: text }, required: ['title'],
    }),
  ]));
  const capability = (slug: string) => manifest.capabilities.find(({ tool: name }) => name === slug)!;
  const move = 'moves the record to another container';

  assert.deepEqual(Object.keys(capability('ACME_UPDATE_ITEM').input.properties), ['item_id', 'name', 'folder_name']);
  assert.deepEqual(capability('ACME_UPDATE_ITEM').withheldArguments, {
    parent: move, parents: move, destination_folder: move, parent_reference: move,
    folder: move, parent_folder: move, new_parent: move, move_to: move,
  });
  assert.deepEqual(Object.keys(capability('ACME_CREATE_PULL_REQUEST').input.properties),
    ['title', 'destination_branch', 'parent_folder']);
});

test('update tools lose plural phone, mobile, username, and login lists', () => {
  const list = { type: 'array', items: { type: 'string' } };
  const person = {
    type: 'object',
    properties: { id: { type: 'integer' }, name: { type: 'string' }, phones: list, mobiles: list, usernames: list, logins: list },
  };
  const { manifest } = draftComposioManifest(snapshot([
    tool('ACME_UPDATE_PERSON', ['updateHint'], { ...person, required: ['id'] }),
    tool('ACME_CREATE_PERSON', ['createHint'], person),
  ]));
  const properties = (slug: string) =>
    Object.keys(manifest.capabilities.find(({ tool: name }) => name === slug)!.input.properties);

  assert.deepEqual(properties('ACME_UPDATE_PERSON'), ['id', 'name']);
  assert.deepEqual(properties('ACME_CREATE_PERSON'), ['id', 'name', 'phones', 'mobiles', 'usernames', 'logins']);
});

test('reviewed manifests keep expiry, import, credential, and system arguments from the model', () => {
  const withheld: Array<[toolkit: string, tool: string, argument: string]> = [
    ['box', 'BOX_FIND_FILE_FOR_SHARED_LINK', 'boxapi'],
    ['box', 'BOX_FIND_FILE_FOR_SHARED_LINK', 'shared_link_password'],
    ['box', 'BOX_GET_FILE_INFORMATION', 'fields'],
    ['box', 'BOX_SEARCH_FOR_CONTENT', 'fields'],
    ['box', 'BOX_LIST_RECENTLY_ACCESSED_ITEMS', 'fields'],
    ['googlebigquery', 'GOOGLEBIGQUERY_CREATE_TABLE', 'expirationTime'],
    ['googlebigquery', 'GOOGLEBIGQUERY_CREATE_TABLE', 'timePartitioning.expirationMs'],
    ['googlebigquery', 'GOOGLEBIGQUERY_CREATE_DATASET', 'defaultTableExpirationMs'],
    ['googlebigquery', 'GOOGLEBIGQUERY_CREATE_DATASET', 'defaultPartitionExpirationMs'],
    ['googlebigquery', 'GOOGLEBIGQUERY_PATCH_DATASET', 'defaultTableExpirationMs'],
    ['googlebigquery', 'GOOGLEBIGQUERY_PATCH_DATASET', 'defaultPartitionExpirationMs'],
    ...['key', 'oauth_token', 'access_token', 'callback', 'alt', 'xgafv', 'uploadType', 'upload_protocol', 'prettyPrint', 'quotaUser']
      .map((argument) => ['googlebigquery', 'GOOGLEBIGQUERY_GET_QUERY_RESULTS', argument] as [string, string, string]),
    ['mailchimp', 'MAILCHIMP_SET_CAMPAIGN_CONTENT', 'url'],
    ['mailchimp', 'MAILCHIMP_UPDATE_CAMPAIGN_SETTINGS', 'rss__opts__feed__url'],
    ['mailchimp', 'MAILCHIMP_ADD_CAMPAIGN', 'rss__opts__feed__url'],
    ['pipedrive', 'PIPEDRIVE_UPDATE_PERSON_V2', 'phones'],
    ...['REDDIT_ADS_CREATE_CAMPAIGN', 'REDDIT_ADS_UPDATE_CAMPAIGN'].flatMap((slug) => ['data.bid_strategy',
      'data.bid_type', 'data.bid_value', 'data.goal_type', 'data.goal_value', 'data.spend_cap']
      .map((argument) => ['reddit_ads', slug, argument] as [string, string, string])),
  ];
  // A rule change cannot release these: the review withholds each one by name.
  const reviewed: Array<[toolkit: string, tool: string, argument: string]> = [
    ...['BOX_FIND_FILE_FOR_SHARED_LINK', 'BOX_GET_FILE_INFORMATION', 'BOX_LIST_ITEMS_IN_FOLDER',
      'BOX_LIST_RECENTLY_ACCESSED_ITEMS', 'BOX_SEARCH_FOR_CONTENT']
      .map((slug) => ['box', slug, 'fields'] as [string, string, string]),
    ['cal', 'CAL_RESCHEDULE_BOOKING_BY_UID', 'rescheduledBy'],
    ...['document_body', 'file_name', 'mime_type']
      .map((argument) => ['dynamics365', 'DYNAMICS365_CREATE_ANNOTATION', argument] as [string, string, string]),
    ['googletasks', 'GOOGLETASKS_INSERT_TASK', 'deleted'],
    ['googletasks', 'GOOGLETASKS_PATCH_TASK', 'deleted'],
    ['gorgias', 'GORGIAS_CREATE_CUSTOMER', 'channels'],
    ['gorgias', 'GORGIAS_UPDATE_CUSTOMER', 'channels'],
    ['gorgias', 'GORGIAS_UPDATE_TICKET', 'customer_id'],
    ...['excluded_audiences', 'included_audiences', 'send_strategy_method', 'static_is_local_timezone',
      'static_send_datetime', 'sto_send_date', 'throttle_percentage', 'throttled_send_datetime']
      .map((argument) => ['klaviyo', 'KLAVIYO_UPDATE_CAMPAIGN', argument] as [string, string, string]),
    ['klaviyo', 'KLAVIYO_UPDATE_PROFILE', 'data__attributes__anonymous__id'],
    ['klaviyo', 'KLAVIYO_UPDATE_PROFILE', 'data__meta__patch__properties__unset'],
    ['microsoft_teams', 'MICROSOFT_TEAMS_CREATE_MEETING', 'chat_info'],
    ['microsoft_teams', 'MICROSOFT_TEAMS_CREATE_MEETING', 'lobby_bypass_settings'],
    ['square', 'SQUARE_UPDATE_CUSTOMER', 'reference_id'],
    ['trello', 'TRELLO_ADD_BOARDS', 'prefs__calendarFeedEnabled'],
    ['trello', 'TRELLO_GET_MEMBERS_BY_ID_MEMBER', 'tokens'],
    ['wrike', 'WRIKE_CREATE_TASK', 'parents'],
    ['wrike', 'WRIKE_CREATE_TASK', 'superTasks'],
    ...['addParents', 'addSuperTasks', 'convertToCustomItemType', 'customFields', 'dates', 'removeParents',
      'removeSuperTasks']
      .map((argument) => ['wrike', 'WRIKE_MODIFY_TASK', argument] as [string, string, string]),
    ...['ZOHO_CREATE_CONTACT', 'ZOHO_CREATE_DEAL', 'ZOHO_CREATE_LEAD']
      .map((slug) => ['zoho', slug, 'lar_id'] as [string, string, string]),
    ['zoom', 'ZOOM_GET_MEETING_RECORDINGS', 'include_fields'],
    ...['ZOOM_CREATE_A_MEETING', 'ZOOM_UPDATE_A_MEETING'].flatMap((slug) => ['schedule_for',
      'settings__alternative__hosts', 'settings__join__before__host', 'settings__meeting__authentication',
      'settings__resources', 'settings__use__pmi', 'settings__waiting__room']
      .map((argument) => ['zoom', slug, argument] as [string, string, string])),
  ];
  const offered = (schema: unknown, path: string[]): boolean => {
    const properties = (schema as { properties?: Record<string, unknown> }).properties ?? {};
    const [head, ...rest] = path;
    return head! in properties && (rest.length === 0 || offered(properties[head!], rest));
  };
  for (const [toolkit, slug, argument] of [...withheld, ...reviewed]) {
    const capability = pilotManifest(toolkit).capabilities.find(({ tool: name }) => name === slug)!;
    assert.equal(argument in (capability.withheldArguments ?? {}), true, `${slug}.${argument} is withheld`);
    assert.equal(offered(capability.input, argument.split('.')), false, `${slug}.${argument} is not offered`);
  }
  for (const [toolkit, slug, argument] of reviewed) {
    const capability = pilotManifest(toolkit).capabilities.find(({ tool: name }) => name === slug)!;
    assert.match(capability.withheldArguments![argument]!, /^reviewer: /, `${slug}.${argument} is withheld by review`);
  }
});

test('write tools lose budget, bid, and spend arguments, and a CRM field that records a budget stays', () => {
  const { manifest } = draftComposioManifest(snapshot([tool('ACME_UPDATE_CAMPAIGN', ['updateHint'], {
    type: 'object',
    properties: {
      campaign_id: { type: 'string' },
      name: { type: 'string' },
      daily_budget: { type: 'integer' },
      bidAmount: { type: 'integer' },
      spend_cap: { type: 'integer' },
      goal_value: { type: 'integer', description: 'Campaign goal value in micros.' },
      goal_type: { type: 'string', enum: ['LIFETIME_SPEND', 'DAILY_SPEND'] },
      BudgetedCost: { type: 'number' },
    },
    required: ['campaign_id'],
  })]));
  const capability = manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_UPDATE_CAMPAIGN')!;
  const spend = 'sets a budget, bid, or spend amount';
  assert.deepEqual(Object.keys(capability.input.properties), ['campaign_id', 'name', 'BudgetedCost']);
  assert.deepEqual(capability.withheldArguments,
    { daily_budget: spend, bidAmount: spend, spend_cap: spend, goal_value: spend, goal_type: spend });
});

test('review.allowValues narrows a string enum the model can set and fails on a value the input does not offer', () => {
  const campaigns = snapshot([tool('ACME_UPDATE_CAMPAIGNS', ['updateHint', 'destructiveHint'], {
    type: 'object',
    properties: {
      updates: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string' }, status: { type: 'string', enum: ['ACTIVE', 'PAUSED'] } },
          required: ['id'],
        },
      },
    },
    required: ['updates'],
  })]);
  const reviewed = (allowValues: NonNullable<ComposioManifest['review']['allowValues']>) => ({
    ...draftComposioManifest(campaigns).manifest,
    review: { add: ['ACME_UPDATE_CAMPAIGNS'], drop: {}, allowArguments: {}, allowValues },
  });
  const pause = { values: ['PAUSED'], reason: 'ACTIVE restarts delivery and spend.' };

  const { manifest, report } = draftComposioManifest(campaigns, reviewed({ ACME_UPDATE_CAMPAIGNS: { 'updates[].status': pause } }));
  const input = compileComposioManifest(manifest).capabilities.find(({ id }) => id === 'acme.update_campaigns')!.input;
  assert.equal(v.is(input, { updates: [{ id: '1', status: 'PAUSED' }] }), true);
  assert.equal(v.is(input, { updates: [{ id: '1', status: 'ACTIVE' }] }), false);
  assert.deepEqual(report.allowedValues, [{ tool: 'ACME_UPDATE_CAMPAIGNS', argument: 'updates[].status', values: ['PAUSED'] }]);
  assert.deepEqual(checkComposioManifest(manifest, campaigns), []);

  for (const [argument, values] of [['updates[].status', ['DRAFT']], ['updates[].id', ['1']], ['status', ['PAUSED']]] as const) {
    assert.throws(
      () => draftComposioManifest(campaigns, reviewed({ ACME_UPDATE_CAMPAIGNS: { [argument]: { ...pause, values: [...values] } } })),
      /review\.allowValues names ACME_UPDATE_CAMPAIGNS/,
      argument,
    );
  }
});

test('paid-ads status writes can only pause, and a new Reddit campaign starts paused', () => {
  const pinterest = (status: string) => ({ ad_account_id: '1', updates: [{ id: '2', status }] });
  const pauseOnly: Array<[capability: string, input: (status: string) => Record<string, unknown>]> = [
    ['pinterest_ads.update_ad_groups', pinterest],
    ['pinterest_ads.update_ads', pinterest],
    ['pinterest_ads.update_campaigns', pinterest],
    ['reddit_ads.update_campaign', (status) => ({ campaign_id: 'c', data: { configured_status: status } })],
    ['reddit_ads.create_campaign',
      (status) => ({ ad_account_id: 'a2_x', data: { name: 'Draft', objective: 'CLICKS', configured_status: status } })],
  ];
  for (const [id, input] of pauseOnly) {
    const schema = MANAGED_CONNECTOR_CATALOG.capability(id)!.input;
    assert.equal(v.is(schema, input('PAUSED')), true, `${id} pauses`);
    for (const status of ['ACTIVE', 'ARCHIVED', 'DELETED']) {
      assert.equal(v.is(schema, input(status)), false, `${id} refuses ${status}`);
    }
  }
  assert.equal(v.is(MANAGED_CONNECTOR_CATALOG.capability('reddit_ads.create_campaign')!.input,
    { ad_account_id: 'a2_x', data: { name: 'Draft', objective: 'CLICKS' } }), false,
  'a new campaign must name its status, and PAUSED is the only one');
});

test('reviewer drops stay out of their manifests', () => {
  // A rule change cannot release these: the review drops each one by name.
  const dropped: Array<[toolkit: string, tool: string]> = [
    ['contentful', 'CONTENTFUL_QUERY_ASSET_COLLECTION'],
    ['contentful', 'CONTENTFUL_QUERY_GRAPHQL_CONTENT_TYPE_COLLECTION'],
  ];
  for (const [toolkit, slug] of dropped) {
    const manifest = pilotManifest(toolkit);
    assert.ok(manifest.review.drop[slug], `${slug} is dropped by review`);
    assert.equal(manifest.capabilities.some(({ tool: name }) => name === slug), false, `${slug} is not offered`);
  }
});

test('write tools lose file and copy-source arguments but keep a plain source field and a file name', () => {
  const text = { type: 'string' };
  const { manifest } = draftComposioManifest(snapshot([
    tool('ACME_CREATE_CARD', ['createHint'], {
      type: 'object',
      properties: {
        name: text,
        source: { type: 'integer', description: 'Channel the card came from.' },
        fileSource: { type: 'string', description: 'Binary data of a file to attach.' },
        file_url: text,
        files: { type: 'array', items: text },
        templateSource: text,
        file_name: text,
        fileName: text,
      },
    }),
  ]));
  const card = manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_CREATE_CARD')!;

  assert.deepEqual(Object.keys(card.input.properties), ['name', 'source', 'file_name', 'fileName']);
  assert.deepEqual(Object.keys(card.withheldArguments!), ['fileSource', 'file_url', 'files', 'templateSource']);

  for (const [id, card] of [
    ['trello.add_cards', { idList: 'l'.repeat(24), name: 'Ship it' }],
    ['trello.update_cards_by_id_card', { idCard: 'c'.repeat(24), name: 'Ship it' }],
  ] as const) {
    const input = trelloCapability(id)!.input;
    assert.equal(v.safeParse(input, card).success, true, id);
    assert.equal(v.safeParse(input, { ...card, fileSource: 'aGVsbG8=' }).success, false, id);
  }
});

test('write tools lose options that replace an existing item, and a tool that replaces by default needs review', () => {
  const name = { type: 'string' };
  const { manifest, report } = draftComposioManifest(snapshot([
    tool('ACME_CREATE_FOLDER', ['createHint'], {
      type: 'object',
      properties: {
        name,
        conflict_behavior: { type: 'string', enum: ['fail', 'rename', 'replace'], default: 'rename' },
        on_conflict: { anyOf: [{ type: 'string', enum: ['skip', 'Overwrite'] }, { type: 'null' }] },
        sort: { type: 'string', enum: ['name', 'size'] },
      },
      required: ['name'],
    }),
    tool('ACME_UPLOAD_FILE', ['createHint'], {
      type: 'object',
      properties: { name, overwrite: { type: 'boolean', default: true } },
      required: ['name'],
    }),
    tool('ACME_LIST_FOLDERS', ['readOnlyHint'], {
      type: 'object',
      properties: { conflict_behavior: { type: 'string', enum: ['fail', 'replace'] } },
    }),
  ]));
  const folder = manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_CREATE_FOLDER')!;

  assert.deepEqual(Object.keys(folder.input.properties), ['name', 'sort']);
  assert.deepEqual(folder.withheldArguments, {
    conflict_behavior: 'can replace an existing item',
    on_conflict: 'can replace an existing item',
  });
  assert.equal(folder.effect, 'reversible_write');
  assert.equal(lanes(manifest).ACME_UPLOAD_FILE, undefined);
  assert.match(report.excluded.find(({ tool: slug }) => slug === 'ACME_UPLOAD_FILE')!.reason,
    /^administrative: argument overwrite can replace an existing item by default/);
  assert.ok('conflict_behavior' in manifest.capabilities
    .find(({ tool: slug }) => slug === 'ACME_LIST_FOLDERS')!.input.properties);
});

test('a description that names the caller\'s OAuth grant does not withhold an argument', () => {
  const { manifest } = draftComposioManifest(snapshot([
    tool('ACME_UPDATE_RANGE', ['updateHint'], {
      type: 'object',
      properties: {
        item_id: { type: 'string' },
        drive_id: { type: 'string', description: 'Optional drive ID. Required for application-level permissions (s2s_oauth).' },
        session_id: { type: 'string', description: 'Workbook session. Uses delegated permissions when omitted.' },
        audience: { type: 'string', description: 'Sets the permissions other people get on the workbook.' },
        scopes: { type: 'string', description: 'Application permissions to grant to the installed app.' },
        access: { type: 'string', description: 'App permissions requested for all repositories.' },
        grant: { type: 'string', description: 'Grants delegated permissions on the mailbox to the named principal.' },
      },
      required: ['item_id'],
    }),
  ]));
  const range = manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_UPDATE_RANGE')!;

  assert.deepEqual(Object.keys(range.input.properties), ['item_id', 'drive_id', 'session_id']);
  assert.deepEqual(Object.keys(range.withheldArguments!), ['audience', 'scopes', 'access', 'grant']);
});

test('a write that needs a permission argument is administrative and needs an explicit reviewer opt-in', () => {
  const share = tool('ACME_SHARE_BOARD', ['updateHint'], {
    type: 'object',
    properties: { idBoard: { type: 'string' }, permissionLevel: { type: 'string' } },
    required: ['idBoard', 'permissionLevel'],
  });
  const generated = draftComposioManifest(snapshot([share]));
  assert.equal(generated.manifest.capabilities.some(({ tool: slug }) => slug === 'ACME_SHARE_BOARD'), false);
  assert.match(generated.report.excluded.find(({ tool: slug }) => slug === 'ACME_SHARE_BOARD')!.reason, /^administrative/);

  const allowedOnly = draftComposioManifest(snapshot([share]), {
    ...generated.manifest,
    review: { add: [], drop: {}, allowArguments: { ACME_SHARE_BOARD: ['permissionLevel'] } },
  });
  assert.equal(allowedOnly.manifest.capabilities.some(({ tool: slug }) => slug === 'ACME_SHARE_BOARD'), false);

  const reviewed = draftComposioManifest(snapshot([share]), {
    ...generated.manifest,
    review: { add: ['ACME_SHARE_BOARD'], drop: {}, allowArguments: { ACME_SHARE_BOARD: ['permissionLevel'] } },
  }).manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_SHARE_BOARD')!;
  assert.equal(reviewed.effect, 'administrative');
  assert.deepEqual(reviewed.input.required, ['idBoard', 'permissionLevel']);
});

test('a reviewer withholds an argument no rule catches, and a stale or required one fails loudly', () => {
  const update = tool('ACME_UPDATE_DEAL', ['updateHint'], {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      title: { type: 'string' },
      is_deleted: { type: 'boolean', description: 'Marks the deal as deleted.' },
    },
    required: ['id'],
  });
  const generated = draftComposioManifest(snapshot([update]));
  const draftWith = (withholdArguments: Record<string, Record<string, string>>) =>
    draftComposioManifest(snapshot([update]), {
      ...generated.manifest,
      review: { add: [], drop: {}, allowArguments: {}, withholdArguments },
    });
  assert.ok('is_deleted' in generated.manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_UPDATE_DEAL')!.input.properties);

  const reviewed = draftWith({ ACME_UPDATE_DEAL: { is_deleted: 'Deletes the deal.' } });
  const capability = reviewed.manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_UPDATE_DEAL')!;
  assert.deepEqual(Object.keys(capability.input.properties), ['id', 'title']);
  assert.deepEqual(capability.withheldArguments, { is_deleted: 'reviewer: Deletes the deal.' });
  assert.equal(capability.effect, 'reversible_write');
  assert.deepEqual(reviewed.manifest.review.withholdArguments, { ACME_UPDATE_DEAL: { is_deleted: 'Deletes the deal.' } });
  assert.deepEqual(checkComposioManifest(reviewed.manifest, snapshot([update])), []);

  assert.throws(() => draftWith({ ACME_UPDATE_DEAL: { archived: 'Archives the deal.' } }),
    /names ACME_UPDATE_DEAL archived, which its input does not accept/);
  assert.match(draftWith({ ACME_UPDATE_DEAL: { id: 'Names the deal.' } }).report.excluded
    .find(({ tool: slug }) => slug === 'ACME_UPDATE_DEAL')!.reason, /required argument id is withheld by review/);
});

test('a tool cannot be both added and dropped by review', () => {
  const post = tool('ACME_POST_MESSAGE', ['createHint']);
  const generated = draftComposioManifest(snapshot([post]));
  const both = {
    ...generated.manifest,
    review: { add: ['ACME_POST_MESSAGE'], drop: { ACME_POST_MESSAGE: 'Reaches everyone in the channel.' }, allowArguments: {} },
  };
  assert.throws(() => draftComposioManifest(snapshot([post]), both),
    /review\.add names ACME_POST_MESSAGE, which review\.drop also names/);
  assert.match(checkComposioManifest(both, snapshot([post])).join('\n'), /review\.drop also names/);
});

test('a re-snapshot keeps a tool the review drops even when Composio stops marking it important', () => {
  const detail = { slug: 'acme', name: 'Acme', meta: { version: VERSION, description: '' }, composio_managed_auth_schemes: ['OAUTH2'] };
  const generated = draftComposioManifest(snapshot([tool('ACME_LIST_NOTES', ['readOnlyHint'])]));
  const manifest = {
    ...generated.manifest,
    review: { add: [], drop: { ACME_UPDATE_SETTINGS: 'Changes workspace settings.' }, allowArguments: {} },
  };
  const entry = (slug: string, tags = ['important', 'readOnlyHint']) =>
    ({ ...listed(slug), tags, input_parameters: { type: 'object', properties: {} } });
  const items = [entry('ACME_WHO_AM_I'), entry('ACME_LIST_NOTES'), entry('ACME_UPDATE_SETTINGS', ['updateHint'])];

  const refreshed = snapshotFromComposio(detail, { items }, new Set(reviewedTools(manifest)));

  assert.ok(refreshed.tools.some(({ slug }) => slug === 'ACME_UPDATE_SETTINGS'));
  assert.deepEqual(checkComposioManifest(manifest, refreshed), []);
  assert.equal(snapshotFromComposio(detail, { items }, new Set()).tools.some(({ slug }) => slug === 'ACME_UPDATE_SETTINGS'), false);
});

test('a write that sends to people stays out unless a reviewer adds it', () => {
  const send = tool('ACME_SEND_MESSAGE', ['createHint'], {
    type: 'object',
    properties: { thread_id: { type: 'integer' }, body: { type: 'string' } },
    required: ['thread_id', 'body'],
  });
  const generated = draftComposioManifest(snapshot([send]));
  assert.equal(generated.manifest.capabilities.some(({ tool: slug }) => slug === 'ACME_SEND_MESSAGE'), false);
  assert.match(generated.report.excluded.find(({ tool: slug }) => slug === 'ACME_SEND_MESSAGE')!.reason, /^external_publish/);

  const reviewed = draftComposioManifest(snapshot([send]), {
    ...generated.manifest,
    review: { add: ['ACME_SEND_MESSAGE'], drop: {}, allowArguments: {} },
  }).manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_SEND_MESSAGE');
  assert.equal(reviewed?.lane, 'write');
  assert.equal(reviewed?.effect, 'external_publish');
});

test('write tools lose recipient arguments, and a tool that needs one is administrative', () => {
  const list = { type: 'array', items: { type: 'string' } };
  const reply = tool('ACME_REPLY_TO_THREAD', ['createHint'], {
    type: 'object',
    properties: {
      thread_id: { type: 'integer' },
      body: { type: 'string' },
      to_emails: list,
      cc_emails: list,
      bcc_emails: list,
      from_email: { type: 'string' },
      replyTo: { type: 'string' },
      recipients: list,
      notify_emails: list,
      notifyUsers: { type: 'boolean' },
    },
    required: ['thread_id', 'body'],
  });
  const forward = tool('ACME_FORWARD_THREAD', ['createHint'], {
    type: 'object',
    properties: { thread_id: { type: 'integer' }, to: list },
    required: ['thread_id', 'to'],
  });
  const reviewed = { add: ['ACME_REPLY_TO_THREAD', 'ACME_FORWARD_THREAD'], drop: {}, allowArguments: {} };
  const base = draftComposioManifest(snapshot([reply, forward])).manifest;
  const { manifest, report } = draftComposioManifest(snapshot([reply, forward]), { ...base, review: reviewed });
  const capability = manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_REPLY_TO_THREAD')!;

  assert.deepEqual(Object.keys(capability.input.properties), ['thread_id', 'body']);
  assert.deepEqual(Object.keys(capability.withheldArguments!).sort(), [
    'bcc_emails', 'cc_emails', 'from_email', 'notifyUsers', 'notify_emails', 'recipients', 'replyTo', 'to_emails',
  ]);
  assert.equal(manifest.capabilities.some(({ tool: slug }) => slug === 'ACME_FORWARD_THREAD'), false);
  assert.match(report.excluded.find(({ tool: slug }) => slug === 'ACME_FORWARD_THREAD')!.reason, /^administrative: required argument to /);
});

test('Freshdesk replies cannot add recipients, and forwarding and outbound email are absent', () => {
  const ids = MANAGED_CONNECTOR_CATALOG.connector('freshdesk')!.capabilities.map(({ id }) => id);
  assert.equal(ids.includes('freshdesk.reply_to_forward_ticket'), false);
  assert.equal(ids.includes('freshdesk.create_ticket_outbound_email'), false);

  const reply = MANAGED_CONNECTOR_CATALOG.capability('freshdesk.reply_to_ticket')!.input;
  const answer = { ticket_id: 42, body: 'Thanks, fixed.' };
  assert.equal(v.safeParse(reply, answer).success, true);
  for (const field of ['to_emails', 'cc_emails', 'bcc_emails']) {
    assert.equal(v.safeParse(reply, { ...answer, [field]: ['someone@example.com'] }).success, false, field);
  }
  assert.equal(v.safeParse(reply, { ...answer, from_email: 'support@example.com' }).success, false);

  const note = MANAGED_CONNECTOR_CATALOG.capability('freshdesk.add_note_to_ticket')!.input;
  assert.equal(v.safeParse(note, { ticket_id: 42, body: 'Internal.', notify_emails: ['a@example.com'] }).success, false);
});

test('the check rejects a withheld permission argument added back to a pilot manifest', async () => {
  const manifest = pilotManifest('trello');
  const board = manifest.capabilities.find(({ tool: slug }) => slug === 'TRELLO_ADD_BOARDS')!;
  board.input.properties.prefs_permissionLevel = { type: 'string', maxLength: 20_000 };

  const problems = checkComposioManifest(manifest, await readSnapshot('trello', manifest.version));

  assert.ok(problems.some((problem) => problem.includes('TRELLO_ADD_BOARDS') && problem.includes('input')), problems.join('\n'));
  const compiled = trelloCapability('trello.add_boards')!.input;
  assert.equal(v.safeParse(compiled, { name: 'Roadmap' }).success, true);
  assert.equal(v.safeParse(compiled, { name: 'Roadmap', prefs_permissionLevel: 'public' }).success, false);
});

test('the check rejects a manifest that drops a required argument', async () => {
  const manifest = pilotManifest('trello');
  const card = manifest.capabilities.find(({ tool: slug }) => slug === 'TRELLO_ADD_CARDS')!;
  delete card.input.properties.idList;
  delete card.input.required;

  const problems = checkComposioManifest(manifest, await readSnapshot('trello', manifest.version));

  assert.ok(problems.some((problem) => problem.includes('TRELLO_ADD_CARDS') && problem.includes('input')), problems.join('\n'));
});

test('compiled tools require every required argument and reject unknown ones', () => {
  const addCard = trelloCapability('trello.add_cards')!;
  assert.equal(v.safeParse(addCard.input, { name: 'Ship it' }).success, false);
  assert.equal(v.safeParse(addCard.input, { idList: 'a'.repeat(24), name: 'Ship it' }).success, true);
  assert.equal(v.safeParse(addCard.input, { idList: 'a'.repeat(24), boardSecret: 'x' }).success, false);
});

test('derived schemas cap strings, arrays, and depth, and unbounded manifest schemas do not parse', () => {
  const { manifest } = draftComposioManifest(snapshot([
    tool('ACME_CREATE_NOTE', ['createHint'], {
      type: 'object',
      properties: {
        body: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        deep: { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: {
          c: { type: 'object', properties: { d: { type: 'string' } } },
        } } } } } },
      },
      required: ['body'],
    }),
  ]));
  const note = manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_CREATE_NOTE')!;
  assert.deepEqual(note.input.properties.body, { type: 'string', maxLength: 20_000 });
  assert.deepEqual(note.input.properties.tags, {
    type: 'array', items: { type: 'string', maxLength: 20_000 }, maxItems: 100,
  });
  assert.equal('deep' in note.input.properties, false);

  const compiled = trelloCapability('trello.add_cards')!.input;
  assert.equal(v.safeParse(compiled, { idList: 'a'.repeat(24), desc: 'x'.repeat(20_001) }).success, false);

  for (const unbounded of [
    { type: 'string' },
    { type: 'array', items: { type: 'string', maxLength: 10 } },
    { type: 'object', additionalProperties: true },
  ]) {
    const value = pilotManifest('trello');
    value.capabilities[0]!.input.properties.extra = unbounded as never;
    assert.throws(() => parseComposioManifest(value), /schema subset/, JSON.stringify(unbounded));
  }
});

test('manifest connectors use the same catalog contract as hand-written ones', () => {
  for (const connector of [TRELLO_CONNECTOR, MANAGED_CONNECTOR_CATALOG.connector('freshdesk')!]) {
    assert.equal(connector.id, `${connector.toolkit}-managed`);
    assert.ok(connector.capabilities.some(({ accessLane }) => accessLane === 'read'));
    assert.ok(connector.capabilities.some(({ accessLane }) => accessLane === 'write'));
    for (const capability of connector.capabilities) {
      assert.equal(capability.accessLane === 'write', capability.effect !== 'read', capability.id);
      assert.equal(capability.accessLane === 'write', Boolean(capability.sideEffectLabel), capability.id);
    }
  }
  assert.equal(MANAGED_CONNECTOR_CATALOG.capabilities('freshdesk', 'read')
    .some(({ id }) => id === 'freshdesk.reply_to_ticket'), false);
});

test('every held manifest compiles into the managed catalog beside the shipped connectors', async () => {
  for (const toolkit of Object.keys(HELD_COMPOSIO_MANIFESTS)) {
    const manifest = parseComposioManifest(
      JSON.parse(await readFile(path.join(MANIFEST_DIRECTORY, `${toolkit}.json`), 'utf8')),
    );
    const catalog = createManagedConnectorCatalog([
      ...MANAGED_CONNECTOR_CATALOG.list(),
      compileComposioManifest(manifest),
    ]);
    const connector = catalog.connector(toolkit);
    assert.ok(connector, toolkit);
    for (const capability of connector.capabilities) assert.ok(capability.input, capability.id);
  }
});

const FRESHDESK_POLICY: ConnectionAccountManagedPolicy = {
  kind: 'managed',
  adapterId: 'composio',
  toolkit: 'freshdesk',
  principalRef: 'chickpea:membership:membership_test',
  accountRef: 'ca_freshdesk',
  allowedCapabilities: ['freshdesk.currently_authenticated_agent', 'freshdesk.add_note_to_ticket'],
};

function recordingProvider(
  data: Record<string, unknown>,
  calls: Array<Record<string, unknown>>,
  policy: ConnectionAccountManagedPolicy = FRESHDESK_POLICY,
) {
  return new ComposioManagedConnectionProvider({
    apiKey: 'test-key',
    getConnectedAccount: async () => ({
      id: policy.accountRef,
      status: 'ACTIVE',
      isDisabled: false,
      toolkit: policy.toolkit,
      userId: policy.principalRef,
    }),
    createClient: async () => ({
      sessions: { async create() { throw new Error('session execution must not be used'); } },
      tools: {
        async execute(slug, input) {
          calls.push({ tool: slug, ...input });
          return { data, error: null, successful: true, logId: 'log_manifest' };
        },
      },
    }),
  });
}

test('manifest execution sends validated arguments at the pinned version and bounds the result', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const large = { cards: Array.from({ length: 400 }, (_, index) => ({ id: index, desc: 'x'.repeat(2_000) })) };
  const provider = recordingProvider(large, calls);

  const result = await provider.execute({
    policy: FRESHDESK_POLICY,
    capability: 'freshdesk.add_note_to_ticket',
    arguments: { ticket_id: 42, body: 'Printer fixed.' },
  });

  assert.deepEqual(calls, [{
    tool: 'FRESHDESK_ADD_NOTE_TO_TICKET',
    userId: FRESHDESK_POLICY.principalRef,
    connectedAccountId: FRESHDESK_POLICY.accountRef,
    version: pilotManifest('freshdesk').version,
    arguments: { ticket_id: 42, body: 'Printer fixed.' },
  }]);
  assert.equal(result.data.truncated, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(result.data)).byteLength <= 65_536);

  await assert.rejects(
    provider.execute({
      policy: FRESHDESK_POLICY,
      capability: 'freshdesk.add_note_to_ticket',
      arguments: { body: 'No ticket' },
    }),
    (error: unknown) => error instanceof ManagedProviderRequestError &&
      error.code === 'validation_failed' && error.metadata.capabilityToolDispatched === false,
  );
  assert.equal(calls.length, 1);
});

test('a write that times out after dispatch is reported as possibly completed', async () => {
  const provider = new ComposioManagedConnectionProvider({
    apiKey: 'test-key',
    getConnectedAccount: async () => { throw new Error('status unavailable'); },
    createClient: async () => ({
      sessions: { async create() { throw new Error('session execution must not be used'); } },
      tools: { async execute() { throw Object.assign(new Error('upstream'), { status: 502 }); } },
    }),
  });

  await assert.rejects(
    provider.execute({
      policy: FRESHDESK_POLICY,
      capability: 'freshdesk.add_note_to_ticket',
      arguments: { ticket_id: 42, body: 'Printer fixed.' },
    }),
    (error: unknown) => error instanceof ManagedProviderRequestError && error.code === 'ambiguous',
  );
});

test('connection validation runs the manifest validation capability', async () => {
  const calls: Array<Record<string, unknown>> = [];
  await recordingProvider({ id: 'agent' }, calls).validate({ policy: FRESHDESK_POLICY });

  assert.deepEqual(calls.map(({ tool: slug, arguments: args }) => ({ slug, args })), [
    { slug: 'FRESHDESK_CURRENTLY_AUTHENTICATED_AGENT', args: {} },
  ]);
});

test('connection validation sends the manifest validationArguments to its validation capability', async () => {
  const policy: ConnectionAccountManagedPolicy = {
    ...FRESHDESK_POLICY,
    toolkit: 'zoom',
    accountRef: 'ca_zoom',
    allowedCapabilities: ['zoom.get_user', 'zoom.list_meetings'],
  };
  const calls: Array<Record<string, unknown>> = [];
  await recordingProvider({ id: 'user' }, calls, policy).validate({ policy });

  assert.deepEqual(calls.map(({ tool: slug, arguments: args }) => ({ slug, args })), [
    { slug: 'ZOOM_GET_USER', args: { user_id: 'me' } },
  ]);
});

test('a validation capability may need input only when validationArguments supply it within its schema', () => {
  const getUser = tool('ACME_GET_USER', ['readOnlyHint'], {
    type: 'object',
    properties: {
      user_id: { type: 'string', maxLength: 64 },
      detail: { type: 'string', enum: ['basic', 'full'] },
    },
    required: ['user_id'],
  });
  const tools = [getUser, tool('ACME_LIST_MEETINGS', ['readOnlyHint'], {
    type: 'object', properties: { user_id: { type: 'string' } }, required: ['user_id'],
  })];
  const value = (validationArguments: Record<string, unknown>) => {
    const { manifest } = draftComposioManifest({ ...snapshot(tools), tools }, undefined, {
      validationArguments: { user_id: 'me' },
    });
    return { ...structuredClone(manifest), validationArguments };
  };

  assert.throws(() => draftComposioManifest({ ...snapshot(tools), tools }), /no read tool whose required input/);
  const { manifest, report } = draftComposioManifest({ ...snapshot(tools), tools }, undefined, {
    validationArguments: { user_id: 'me' },
  });
  assert.equal(manifest.validationCapability, 'acme.get_user');
  assert.deepEqual(manifest.validationArguments, { user_id: 'me' });
  assert.deepEqual(report.validationArguments, { user_id: 'me' });
  assert.deepEqual(draftComposioManifest({ ...snapshot(tools), tools }, manifest).manifest, manifest);
  assert.deepEqual(parseComposioManifest(value({ user_id: 'me', detail: 'full' })).validationArguments,
    { user_id: 'me', detail: 'full' });

  for (const rejected of [{ user_id: 'me', include_deleted: true }, { detail: 'full' }, { user_id: 7 },
    { user_id: 'me', detail: 'everything' }, { user_id: 'x'.repeat(65) }]) {
    assert.throws(() => parseComposioManifest(value(rejected)), /validation capability whose input accepts/,
      JSON.stringify(rejected));
  }
  for (const malformed of [{}, { user_id: { nested: 'me' } }, { user_id: ['me'] }]) {
    assert.throws(() => parseComposioManifest(value(malformed)), /invalid at validationArguments/,
      JSON.stringify(malformed));
  }
});

test('update tools lose requester and identity arguments; create tools keep them except email addresses', () => {
  const contact = {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      name: { type: 'string' },
      email: { type: 'string' },
      other_emails: { type: 'array', items: { type: 'string' } },
      mobile: { type: 'string' },
      requester_id: { type: 'integer' },
      unique_external_id: { type: 'string' },
      emailaddress1: { type: 'string' },
      telephone1: { type: 'string' },
      mobilephone: { type: 'string' },
    },
  };
  const { manifest } = draftComposioManifest(snapshot([
    tool('ACME_UPDATE_CONTACT', ['updateHint'], { ...contact, required: ['id'] }),
    tool('ACME_CREATE_CONTACT', ['createHint'], contact),
  ]));
  const properties = (slug: string) =>
    Object.keys(manifest.capabilities.find(({ tool: name }) => name === slug)!.input.properties);

  assert.deepEqual(properties('ACME_UPDATE_CONTACT'), ['id', 'name']);
  assert.deepEqual(properties('ACME_CREATE_CONTACT'),
    ['id', 'name', 'mobile', 'requester_id', 'unique_external_id', 'telephone1', 'mobilephone']);
});

test('an update tool whose required argument changes the requester is administrative and needs review', () => {
  const { manifest, report } = draftComposioManifest(snapshot([
    tool('ACME_UPDATE_TICKET_REQUESTER', ['updateHint'], {
      type: 'object',
      properties: { ticket_id: { type: 'integer' }, requester_id: { type: 'integer' } },
      required: ['ticket_id', 'requester_id'],
    }),
  ]));
  assert.equal(manifest.capabilities.some(({ tool: slug }) => slug === 'ACME_UPDATE_TICKET_REQUESTER'), false);
  assert.match(report.excluded.find(({ tool: slug }) => slug === 'ACME_UPDATE_TICKET_REQUESTER')!.reason,
    /^administrative: required argument requester_id /);
});

test('write tools lose domain, assignee, follower, owner, and webhook arguments', () => {
  const text = { type: 'string' };
  const list = { type: 'array', items: text };
  const { manifest } = draftComposioManifest(snapshot([
    tool('ACME_UPDATE_COMPANY', ['updateHint'], {
      type: 'object',
      properties: {
        company_id: { type: 'integer' },
        name: text,
        domains: list,
        domain: text,
        assignee_id: text,
        assignees: list,
        watchers: list,
        follower_ids: list,
        subscribers: list,
        collaborators: list,
        owner_id: text,
        webhook_url: text,
        callbackUrl: text,
      },
      required: ['company_id'],
    }),
  ]));
  const company = manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_UPDATE_COMPANY')!;

  assert.deepEqual(Object.keys(company.input.properties), ['company_id', 'name']);
  assert.ok(Object.values(company.withheldArguments!).every((reason) => reason.includes('who acts')),
    JSON.stringify(company.withheldArguments));

  const update = MANAGED_CONNECTOR_CATALOG.capability('freshdesk.update_companies')!.input;
  assert.equal(v.safeParse(update, { company_id: 9, name: 'Acme' }).success, true);
  assert.equal(v.safeParse(update, { company_id: 9, domains: ['example.com'] }).success, false);
});

test('a Freshdesk ticket can only be opened for someone already in the helpdesk, so a reply cannot reach a new address', () => {
  const create = MANAGED_CONNECTOR_CATALOG.capability('freshdesk.create_ticket')!.input;
  const ticket = { subject: 'Printer jam', description: 'Tray 2 is stuck.' };
  assert.equal(v.safeParse(create, { ...ticket, requester_id: 7 }).success, true);
  assert.equal(v.safeParse(create, { ...ticket, email: 'someone@example.com' }).success, false);
  assert.equal(v.safeParse(create, { ...ticket, requester_id: 7, email_config_id: 3 }).success, false);
});

test('create and update tools lose company and product IDs unless a reviewer keeps them', () => {
  const ticket = (required: string[]) => ({
    type: 'object',
    properties: {
      ticket_id: { type: 'integer' },
      subject: { type: 'string' },
      company_id: { type: 'integer', description: 'Company of the requester.' },
      product_id: { type: 'integer', description: 'Product linked to the ticket.' },
    },
    required,
  });
  const create = tool('ACME_CREATE_TICKET', ['createHint'], ticket(['subject']));
  const update = tool('ACME_UPDATE_TICKET', ['updateHint'], ticket(['ticket_id']));
  const ofProduct = (slug: string, hint: string) => tool(slug, [hint], {
    type: 'object', properties: { product_id: { type: 'integer' }, title: { type: 'string' } }, required: ['product_id'],
  });
  const tools = [
    create, update,
    ofProduct('ACME_CREATE_PRODUCT_IMAGE', 'createHint'),
    ofProduct('ACME_UPDATE_PRODUCT', 'updateHint'),
    ofProduct('ACME_DELETE_PRODUCT', 'destructiveHint'),
  ];
  const generated = draftComposioManifest(snapshot(tools));
  const capability = (manifest: ComposioManifest, slug: string) =>
    manifest.capabilities.find(({ tool: name }) => name === slug);

  assert.deepEqual(Object.keys(capability(generated.manifest, 'ACME_CREATE_TICKET')!.input.properties), ['ticket_id', 'subject']);
  assert.deepEqual(Object.keys(capability(generated.manifest, 'ACME_UPDATE_TICKET')!.input.properties), ['ticket_id', 'subject']);
  assert.deepEqual(Object.keys(capability(generated.manifest, 'ACME_CREATE_TICKET')!.withheldArguments!), ['company_id', 'product_id']);
  assert.deepEqual(Object.keys(capability(generated.manifest, 'ACME_UPDATE_TICKET')!.withheldArguments!), ['company_id', 'product_id']);
  assert.deepEqual(capability(generated.manifest, 'ACME_UPDATE_PRODUCT')!.input.required, ['product_id']);
  assert.equal(capability(generated.manifest, 'ACME_CREATE_PRODUCT_IMAGE'), undefined);
  assert.match(generated.report.excluded.find(({ tool: slug }) => slug === 'ACME_CREATE_PRODUCT_IMAGE')!.reason,
    /^administrative: required argument product_id /);
  assert.match(generated.report.excluded.find(({ tool: slug }) => slug === 'ACME_DELETE_PRODUCT')!.reason, /^destructive;/);

  const reviewed = draftComposioManifest(snapshot(tools), {
    ...generated.manifest,
    review: {
      add: ['ACME_CREATE_TICKET', 'ACME_DELETE_PRODUCT'],
      drop: {},
      allowArguments: { ACME_CREATE_TICKET: ['company_id', 'product_id'] },
    },
  }).manifest;
  assert.deepEqual(Object.keys(capability(reviewed, 'ACME_CREATE_TICKET')!.input.properties), [
    'ticket_id', 'subject', 'company_id', 'product_id',
  ]);
  assert.equal(capability(reviewed, 'ACME_CREATE_TICKET')!.effect, 'administrative');
  assert.deepEqual(capability(reviewed, 'ACME_DELETE_PRODUCT')!.input.required, ['product_id']);

  for (const id of ['freshdesk.create_ticket', 'freshdesk.update_ticket']) {
    const input = MANAGED_CONNECTOR_CATALOG.capability(id)!.input;
    const base = id === 'freshdesk.create_ticket'
      ? { subject: 'Printer jam', description: 'Tray 2 is stuck.', requester_id: 7 }
      : { ticket_id: 42, subject: 'Printer jam' };
    assert.equal(v.safeParse(input, base).success, true, id);
    assert.equal(v.safeParse(input, { ...base, company_id: 9 }).success, false, `${id} company_id`);
    assert.equal(v.safeParse(input, { ...base, product_id: 3 }).success, false, `${id} product_id`);
  }
});

test('the Freshdesk security copy says a reply reaches the requester and the existing CCs', () => {
  const copy = MANAGED_CONNECTOR_CATALOG.connector('freshdesk')!.securityDescription;
  assert.match(copy, /A reply reaches the ticket's requester and its existing CCs\./);
  assert.doesNotMatch(copy, /goes only to/);
});

test('the draft report names each argument that carries a precondition', async () => {
  const manifest = pilotManifest('trello');
  const { report } = draftComposioManifest(await readSnapshot('trello', manifest.version), manifest);
  assert.deepEqual(report.preconditions, [{ tool: 'TRELLO_UPDATE_CARDS_BY_ID_CARD', argument: 'idList' }]);
});

test('a precondition must compare two read capabilities over arguments the write accepts', () => {
  const manifest = pilotManifest('trello');
  const card = manifest.capabilities.find(({ tool: slug }) => slug === 'TRELLO_UPDATE_CARDS_BY_ID_CARD')!;
  card.preconditions![0]!.target.capability = 'trello.add_lists';
  assert.throws(() => parseComposioManifest(manifest), /invalid precondition/);
});

const CARD_POLICY: ConnectionAccountManagedPolicy = {
  kind: 'managed',
  adapterId: 'composio',
  toolkit: 'trello',
  principalRef: 'chickpea:membership:membership_test',
  accountRef: 'ca_trello',
  allowedCapabilities: ['trello.who_am_i', 'trello.update_cards_by_id_card'],
};

type ToolResult = { data: Record<string, unknown>; error?: string | null; successful?: boolean };

function trelloProvider(execute: (slug: string) => ToolResult, calls: string[]) {
  return new ComposioManagedConnectionProvider({
    apiKey: 'test-key',
    getConnectedAccount: async () => { throw new Error('status unavailable'); },
    createClient: async () => ({
      sessions: { async create() { throw new Error('session execution must not be used'); } },
      tools: {
        async execute(slug) {
          calls.push(slug);
          return { error: null, successful: true, ...execute(slug) };
        },
      },
    }),
  });
}

function boardProvider(boards: { card: string; list: string }, calls: string[]) {
  return trelloProvider((slug) => ({
    data: slug === 'TRELLO_GET_CARDS_BY_ID_CARD' ? { data: { id: 'card', idBoard: boards.card } }
      : slug === 'TRELLO_GET_LISTS_BOARD_BY_ID_LIST' ? { id: boards.list }
      : { id: 'card' },
  }), calls);
}

function cardLookupProvider(card: () => ToolResult, list: Record<string, unknown>, calls: string[]) {
  return trelloProvider((slug) => slug === 'TRELLO_GET_CARDS_BY_ID_CARD' ? card()
    : slug === 'TRELLO_GET_LISTS_BOARD_BY_ID_LIST' ? { data: list }
    : { data: { id: 'card' } }, calls);
}

const MOVE = { idCard: 'c'.repeat(24), idList: 'l'.repeat(24) };

const rejectedBeforeDispatch = (error: unknown) => error instanceof ManagedProviderRequestError &&
  error.code === 'validation_failed' && error.metadata.capabilityToolDispatched === false &&
  /idList must stay in the record's current container/.test(error.message);

test('moving a card to a list on another board is rejected before the write dispatches', async () => {
  const calls: string[] = [];

  await assert.rejects(
    boardProvider({ card: 'board_a', list: 'board_b' }, calls)
      .execute({ policy: CARD_POLICY, capability: 'trello.update_cards_by_id_card', arguments: MOVE }),
    rejectedBeforeDispatch,
  );
  assert.deepEqual(calls.sort(), ['TRELLO_GET_CARDS_BY_ID_CARD', 'TRELLO_GET_LISTS_BOARD_BY_ID_LIST']);

  calls.length = 0;
  await boardProvider({ card: 'board_a', list: 'board_a' }, calls)
    .execute({ policy: CARD_POLICY, capability: 'trello.update_cards_by_id_card', arguments: MOVE });
  assert.equal(calls.at(-1), 'TRELLO_UPDATE_CARDS_BY_ID_CARD');

  calls.length = 0;
  await boardProvider({ card: 'board_a', list: 'board_b' }, calls).execute({
    policy: CARD_POLICY,
    capability: 'trello.update_cards_by_id_card',
    arguments: { idCard: 'c'.repeat(24), name: 'Renamed' },
  });
  assert.deepEqual(calls, ['TRELLO_UPDATE_CARDS_BY_ID_CARD']);
});

test('a list move fails closed when the card lookup is empty, shaped differently, or fails', async () => {
  const board = { id: 'board_a' };
  const cases: Array<[string, () => ToolResult, Record<string, unknown>]> = [
    ['empty card body', () => ({ data: {} }), board],
    ['board id under another key', () => ({ data: { card: { idBoard: 'board_a' } } }), board],
    ['board id two data levels down', () => ({ data: { data: { data: { idBoard: 'board_a' } } } }), board],
    ['failed lookup that still carries a body',
      () => ({ data: { idBoard: 'board_a' }, error: 'Card not found', successful: false }), board],
    ['unsuccessful lookup with no error text', () => ({ data: { idBoard: 'board_a' }, successful: false }), board],
    ['lookup that throws', () => { throw new Error('socket hang up'); }, board],
    ['both lookups empty', () => ({ data: {} }), {}],
  ];

  for (const [name, card, list] of cases) {
    const calls: string[] = [];
    await assert.rejects(
      cardLookupProvider(card, list, calls).execute({
        policy: CARD_POLICY,
        capability: 'trello.update_cards_by_id_card',
        arguments: MOVE,
      }),
      rejectedBeforeDispatch,
      name,
    );
    assert.ok(calls.includes('TRELLO_GET_CARDS_BY_ID_CARD'), name);
    assert.equal(calls.includes('TRELLO_UPDATE_CARDS_BY_ID_CARD'), false, name);
  }
});
