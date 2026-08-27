import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import * as v from 'valibot';

import { SqliteConfigStore } from '../src/config/store.ts';
import { SqliteSettingsStore } from '../src/config/settings-store.ts';
import type { AuthPrincipal } from '../src/auth/types.ts';
import { MANAGED_CONNECTOR_CANARY_MANIFESTS } from '../src/connections/canary-manifests.ts';

import {
  MANAGED_CONNECTOR_CATALOG,
  createManagedConnectorCatalog,
  intersectManagedResourceConstraints,
  projectManagedResourceHandles,
  type ManagedConnectorDefinition,
} from '../src/connections/catalog/index.ts';
import {
  createManagedConnectionProviderRegistry,
  type ManagedConnectionProvider,
} from '../src/connections/managed.ts';
import {
  ConnectionAccountService,
  ManagedResourceSelectionError,
} from '../src/connections/store.ts';

test('the managed catalog retains Google Workspace contracts and adds productivity and Notion artifacts', () => {
  assert.deepEqual(
    MANAGED_CONNECTOR_CATALOG.list().map(({ toolkit }) => toolkit),
    [
      'gmail', 'googlecalendar', 'googledrive',
      'googlesheets', 'googledocs', 'googleslides',
      'google_search_console', 'google_analytics',
      'notion',
      'hubspot',
      'gong',
      'googleads',
      'youtube',
    ],
  );
  assert.deepEqual(
    MANAGED_CONNECTOR_CATALOG.connector('gmail')?.capabilities.map(({ id }) => id),
    [
      'gmail.profile.read',
      'gmail.messages.search',
      'gmail.drafts.create',
      'gmail.messages.send',
    ],
  );
  assert.equal(
    MANAGED_CONNECTOR_CATALOG.capability('drive.files.create')?.effect,
    'reversible_write',
  );
  assert.deepEqual(
    MANAGED_CONNECTOR_CATALOG.connector('googlesheets')?.capabilities.map(({ id }) => id),
    [
      'sheets.spreadsheets.search',
      'sheets.spreadsheets.metadata',
      'sheets.values.get',
      'sheets.tables.query',
      'sheets.spreadsheets.create',
      'sheets.values.update',
      'sheets.values.append',
      'sheets.rows.upsert',
      'sheets.sheets.add',
    ],
  );
  assert.deepEqual(
    MANAGED_CONNECTOR_CATALOG.connector('googledocs')?.capabilities.map(({ id }) => id),
    [
      'docs.documents.search',
      'docs.documents.get',
      'docs.documents.text',
      'docs.documents.export_pdf',
      'docs.documents.create',
      'docs.documents.create_markdown',
      'docs.documents.insert_text',
      'docs.documents.update_markdown',
      'docs.documents.update_section_markdown',
    ],
  );
  assert.deepEqual(
    MANAGED_CONNECTOR_CATALOG.connector('googleslides')?.capabilities.map(({ id }) => id),
    [
      'slides.presentations.get',
      'slides.pages.get',
      'slides.pages.thumbnail',
      'slides.presentations.create',
      'slides.presentations.create_markdown',
      'slides.presentations.copy_template',
      'slides.presentations.batch_update',
    ],
  );
  assert.equal(
    MANAGED_CONNECTOR_CATALOG.capability('slides.presentations.batch_update')?.effect,
    'reversible_write',
  );
  assert.deepEqual(MANAGED_CONNECTOR_CATALOG.connector('google_search_console')?.resources, [{
    key: 'siteUrls',
    label: 'Search Console sites',
    required: true,
    multiple: true,
    localArgument: 'siteHandle',
    providerArgument: 'siteUrl',
  }]);
  assert.deepEqual(
    MANAGED_CONNECTOR_CATALOG.connector('google_search_console')?.capabilities.map(({ id }) => id),
    [
      'search_console.sites.get',
      'search_console.sitemaps.list',
      'search_console.sitemaps.get',
      'search_console.urls.inspect',
      'search_console.analytics.query',
    ],
  );
  assert.deepEqual(MANAGED_CONNECTOR_CATALOG.connector('google_analytics')?.resources, [{
    key: 'propertyIds',
    label: 'GA4 properties',
    required: true,
    multiple: true,
    localArgument: 'propertyHandle',
    providerArgument: 'property',
  }]);
  assert.deepEqual(
    MANAGED_CONNECTOR_CATALOG.connector('google_analytics')?.capabilities.map(({ id }) => id),
    [
      'analytics.properties.get',
      'analytics.metadata.get',
      'analytics.quotas.get',
      'analytics.reports.run',
      'analytics.reports.realtime',
      'analytics.reports.pivot',
      'analytics.reports.funnel',
    ],
  );
  assert.ok(MANAGED_CONNECTOR_CATALOG.connector('google_search_console')?.capabilities.every(
    ({ accessLane, effect }) => accessLane === 'read' && effect === 'read',
  ));
  assert.ok(MANAGED_CONNECTOR_CATALOG.connector('google_analytics')?.capabilities.every(
    ({ accessLane, effect }) => accessLane === 'read' && effect === 'read',
  ));
  assert.deepEqual(
    MANAGED_CONNECTOR_CATALOG.connector('notion')?.capabilities.map(({ id }) => id),
    [
      'notion.content.search',
      'notion.pages.get',
      'notion.pages.markdown',
      'notion.databases.get',
      'notion.databases.query',
      'notion.data_sources.query',
      'notion.pages.create',
      'notion.pages.update_properties',
      'notion.pages.append_blocks',
    ],
  );
  assert.equal(MANAGED_CONNECTOR_CATALOG.connector('notion')?.resources, undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('notion.pages.archive'), undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('notion.permissions.update'), undefined);
  assert.deepEqual(
    MANAGED_CONNECTOR_CATALOG.connector('hubspot')?.capabilities.map(({ id }) => id),
    [
      'hubspot.account.get',
      'hubspot.objects.search',
      'hubspot.objects.get',
      'hubspot.owners.list',
      'hubspot.pipelines.list',
      'hubspot.associations.list',
      'hubspot.association_types.list',
      'hubspot.contacts.create',
      'hubspot.contacts.update',
      'hubspot.companies.create',
      'hubspot.companies.update',
      'hubspot.deals.create',
      'hubspot.deals.update',
      'hubspot.tickets.create',
      'hubspot.tickets.update',
      'hubspot.notes.create',
      'hubspot.tasks.create',
      'hubspot.meetings.create',
      'hubspot.associations.create',
    ],
  );
  assert.ok(MANAGED_CONNECTOR_CATALOG.connector('hubspot')?.capabilities
    .filter(({ accessLane }) => accessLane === 'write')
    .every(({ effect, sideEffectLabel }) =>
      effect === 'reversible_write' && Boolean(sideEffectLabel)));
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('hubspot.contacts.delete'), undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('hubspot.workflows.create'), undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('hubspot.triggers.create'), undefined);
  assert.deepEqual(MANAGED_CONNECTOR_CATALOG.connector('gong')?.resources, [{
    key: 'workspaceIds',
    label: 'Gong workspaces',
    required: true,
    multiple: true,
    localArgument: 'workspaceHandle',
    providerArgument: 'workspaceId',
  }]);
  assert.deepEqual(
    MANAGED_CONNECTOR_CATALOG.connector('gong')?.capabilities.map(({ id }) => id),
    [
      'gong.workspaces.list', 'gong.users.list', 'gong.calls.list', 'gong.calls.get',
      'gong.transcripts.get', 'gong.interactions.stats', 'gong.coaching.metrics',
      'gong.scorecards.list', 'gong.scorecards.activity', 'gong.tasks.list',
      'gong.trackers.list', 'gong.call_outcomes.list',
    ],
  );
  assert.ok(MANAGED_CONNECTOR_CATALOG.connector('gong')?.capabilities.every(
    ({ accessLane, effect }) => accessLane === 'read' && effect === 'read',
  ));
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('gong.permissions.update'), undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('gong.crm.register'), undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('gong.data.erase'), undefined);
  assert.deepEqual(MANAGED_CONNECTOR_CATALOG.connector('googleads')?.resources, [{
    key: 'customerIds',
    label: 'Google Ads client accounts',
    required: true,
    multiple: true,
    localArgument: 'customerHandle',
    providerArgument: 'customerId',
  }]);
  assert.equal(
    MANAGED_CONNECTOR_CATALOG.capability('ads.budgets.update_amount')?.effect,
    'spend_or_budget',
  );
  assert.equal(
    MANAGED_CONNECTOR_CATALOG.capability('ads.campaigns.enable')?.effect,
    'external_publish',
  );
  assert.equal(
    MANAGED_CONNECTOR_CATALOG.capability('ads.campaigns.pause')?.effect,
    'reversible_write',
  );
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('ads.gaql.raw'), undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('ads.customers.user_access'), undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('ads.conversions.upload'), undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('ads.campaigns.delete'), undefined);
  assert.deepEqual(MANAGED_CONNECTOR_CATALOG.connector('youtube')?.resources, [{
    key: 'channelIds',
    label: 'YouTube channels',
    required: true,
    multiple: true,
    localArgument: 'channelHandle',
    providerArgument: 'channelId',
  }]);
  assert.equal(
    MANAGED_CONNECTOR_CATALOG.capability('youtube.videos.upload')?.effect,
    'external_publish',
  );
  assert.deepEqual(
    MANAGED_CONNECTOR_CATALOG.capability('youtube.videos.upload')?.quota,
    [
      { bucket: 'video_insert_calls', units: 1 },
      { bucket: 'general_units', units: 2 },
    ],
  );
  assert.deepEqual(
    MANAGED_CONNECTOR_CATALOG.capability('youtube.search.public')?.quota,
    [{ bucket: 'search_calls', units: 1 }],
  );
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('youtube.videos.delete'), undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('youtube.comments.moderate'), undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('youtube.raw.request'), undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('sheets.batch_update'), undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.connector('unknown'), undefined);
  assert.equal(MANAGED_CONNECTOR_CATALOG.capability('unknown'), undefined);
});

test('every managed connector has a safe read-only canary manifest', () => {
  assert.deepEqual(
    Object.keys(MANAGED_CONNECTOR_CANARY_MANIFESTS).sort(),
    MANAGED_CONNECTOR_CATALOG.list().map(({ toolkit }) => toolkit).sort(),
  );
  for (const connector of MANAGED_CONNECTOR_CATALOG.list()) {
    const manifest = MANAGED_CONNECTOR_CANARY_MANIFESTS[connector.toolkit];
    assert.ok(manifest, connector.toolkit);
    const capability = MANAGED_CONNECTOR_CATALOG.capability(manifest.capability);
    assert.equal(capability?.connectorToolkit, connector.toolkit);
    assert.equal(capability?.accessLane, 'read');
    assert.equal(capability?.effect, 'read');
  }
});

test('managed catalog rejects semantic overrides outside the closed vocabulary', () => {
  const connector = MANAGED_CONNECTOR_CATALOG.connector('gmail');
  assert.ok(connector);
  assert.throws(
    () => createManagedConnectorCatalog([{
      ...connector,
      id: 'gmail_invalid_semantic',
      toolkit: 'gmail_invalid_semantic',
      capabilities: [{
        ...connector.capabilities[0]!,
        id: 'gmail_invalid_semantic.profile.read',
        connectorToolkit: 'gmail_invalid_semantic',
        toolName: 'gmail_invalid_semantic_read',
        semantic: { operation: 'paste_prompt_text' },
      }],
    } as never]),
    /invalid semantic override/,
  );
});

test('YouTube schemas keep channels local, uploads confined, and publication narrow', () => {
  const upload = MANAGED_CONNECTOR_CATALOG.capability('youtube.videos.upload');
  const search = MANAGED_CONNECTOR_CATALOG.capability('youtube.search.public');
  const update = MANAGED_CONNECTOR_CATALOG.capability('youtube.videos.update');
  assert.ok(upload && search && update);
  assert.equal(v.safeParse(upload.input, {
    channelHandle: 'channel_primary',
    artifactPath: '/workspace/acceptance/tiny.mp4',
    mimeType: 'video/mp4',
    title: 'Disposable acceptance upload',
    privacyStatus: 'private',
  }).success, true);
  assert.equal(v.safeParse(upload.input, {
    channelHandle: 'channel_primary',
    channelId: 'UCprovider',
    artifactPath: '/etc/passwd',
    mimeType: 'application/octet-stream',
    title: 'Unsafe',
    privacyStatus: 'public',
  }).success, false);
  assert.equal(v.safeParse(search.input, {
    channelHandle: 'channel_primary', query: 'research', maxResults: 26,
  }).success, false);
  assert.equal(v.safeParse(update.input, {
    channelHandle: 'channel_primary', videoId: 'video_1', privacyStatus: 'members-only',
  }).success, false);
});

test('Google Ads schemas reject free-form queries, raw customer IDs, excessive reports, and unsafe amounts', () => {
  const report = MANAGED_CONNECTOR_CATALOG.capability('ads.campaigns.report');
  const budget = MANAGED_CONNECTOR_CATALOG.capability('ads.budgets.update_amount');
  const ad = MANAGED_CONNECTOR_CATALOG.capability('ads.ads.create_paused');
  assert.ok(report && budget && ad);

  assert.equal(v.safeParse(report.input, {
    customerHandle: 'customer_acme',
    startDate: '2026-08-01', endDate: '2026-08-23',
    metrics: ['impressions', 'clicks', 'costMicros'], limit: 100,
  }).success, true);
  assert.equal(v.safeParse(report.input, {
    customerHandle: 'customer_acme', customerId: '1234567890',
    query: 'SELECT * FROM customer',
    startDate: '2026-08-01', endDate: '2026-08-23',
  }).success, false);
  assert.equal(v.safeParse(report.input, {
    customerHandle: 'customer_acme',
    startDate: '2025-01-01', endDate: '2026-08-23', limit: 501,
  }).success, false);
  assert.equal(v.safeParse(budget.input, {
    customerHandle: 'customer_acme', campaignBudgetId: '456',
    amountMicros: 25_000_000, currencyCode: 'usd',
  }).success, false);
  assert.equal(v.safeParse(ad.input, {
    customerHandle: 'customer_acme', adGroupId: '789',
    finalUrls: ['file:///tmp/ad.html'],
    headlines: ['One', 'Two'], descriptions: ['One', 'Two'],
  }).success, false);
});

test('Gong schemas bound workspaces, date ranges, task filters, and transcript chunks', () => {
  const calls = MANAGED_CONNECTOR_CATALOG.capability('gong.calls.list');
  const transcript = MANAGED_CONNECTOR_CATALOG.capability('gong.transcripts.get');
  const tasks = MANAGED_CONNECTOR_CATALOG.capability('gong.tasks.list');
  assert.ok(calls && transcript && tasks);
  assert.equal(v.safeParse(calls.input, {
    workspaceHandle: 'workspace_primary',
    fromDateTime: '2026-08-01T00:00:00Z',
    toDateTime: '2026-08-23T00:00:00Z',
  }).success, true);
  assert.equal(v.safeParse(calls.input, {
    workspaceHandle: 'workspace_primary',
    fromDateTime: '2026-01-01T00:00:00Z',
    toDateTime: '2026-08-23T00:00:00Z',
  }).success, false);
  assert.equal(v.safeParse(transcript.input, {
    workspaceHandle: 'workspace_primary', callId: '123',
    maxSegments: 101, maxCharacters: 100_001,
  }).success, false);
  assert.equal(v.safeParse(tasks.input, {
    workspaceHandle: 'workspace_primary', workspaceId: '999', userId: '123',
    status: ['OPEN'], actions: ['EMAIL'],
  }).success, false);
});

test('HubSpot schemas keep CRM properties typed, allowlisted, and bounded', () => {
  const search = MANAGED_CONNECTOR_CATALOG.capability('hubspot.objects.search');
  const create = MANAGED_CONNECTOR_CATALOG.capability('hubspot.contacts.create');
  const update = MANAGED_CONNECTOR_CATALOG.capability('hubspot.deals.update');
  assert.ok(search && create && update);

  assert.equal(v.safeParse(search.input, {
    objectType: 'contacts',
    query: 'Pejman',
    filters: [{ property: 'email', operator: 'CONTAINS_TOKEN', value: 'example.com' }],
    properties: ['firstname', 'lastname', 'email'],
    limit: 25,
  }).success, true);
  assert.equal(v.safeParse(search.input, {
    objectType: 'contacts', properties: ['dealstage'],
  }).success, false);
  assert.equal(v.safeParse(search.input, {
    objectType: 'contacts', properties: ['custom_unreviewed_property'],
  }).success, false);
  assert.equal(v.safeParse(search.input, {
    objectType: 'contacts', portalId: '12345',
  }).success, false);
  assert.equal(v.safeParse(create.input, { custom_properties: { dangerous: 'value' } }).success, false);
  assert.equal(v.safeParse(create.input, { email: 'person@example.com', firstName: 'P' }).success, true);
  assert.equal(v.safeParse(update.input, { objectId: '123' }).success, false);
  assert.equal(v.safeParse(update.input, { objectId: '123', stageId: 'qualified' }).success, true);
});

test('analytics schemas bound resource handles, dates, dimensions, metrics, and result rows', () => {
  const search = MANAGED_CONNECTOR_CATALOG.capability('search_console.analytics.query');
  const report = MANAGED_CONNECTOR_CATALOG.capability('analytics.reports.run');
  const funnel = MANAGED_CONNECTOR_CATALOG.capability('analytics.reports.funnel');
  assert.ok(search && report && funnel);

  assert.equal(v.safeParse(search.input, {
    siteHandle: 'site_primary',
    startDate: '2026-07-01',
    endDate: '2026-07-31',
    dimensions: ['query', 'page'],
    rowLimit: 100,
  }).success, true);
  assert.equal(v.safeParse(search.input, {
    siteHandle: 'site_primary',
    startDate: '2026-07-01',
    endDate: '2026-07-31',
    dimensions: ['searchAppearance', 'query'],
  }).success, false);
  assert.equal(v.safeParse(search.input, {
    siteHandle: 'site_primary',
    startDate: '2026-02-31',
    endDate: '2026-03-02',
  }).success, false);
  assert.equal(v.safeParse(report.input, {
    propertyHandle: 'property_primary',
    startDate: '2025-01-01',
    endDate: '2026-08-01',
    metrics: ['sessions'],
  }).success, false);
  assert.equal(v.safeParse(report.input, {
    propertyHandle: 'property_primary',
    property: 'properties/999',
    startDate: '2026-07-01',
    endDate: '2026-07-31',
    dimensions: ['date'],
    metrics: ['sessions'],
  }).success, false);
  assert.equal(v.safeParse(funnel.input, {
    propertyHandle: 'property_primary',
    startDate: '2026-07-01',
    endDate: '2026-07-31',
    steps: [
      { name: 'View', eventName: 'page_view' },
      { name: 'Purchase', eventName: 'purchase' },
    ],
  }).success, true);
});

test('Notion schemas permit bounded scalar edits but reject archive and raw block shapes', () => {
  const properties = MANAGED_CONNECTOR_CATALOG.capability('notion.pages.update_properties');
  const blocks = MANAGED_CONNECTOR_CATALOG.capability('notion.pages.append_blocks');
  assert.ok(properties && blocks);
  assert.equal(v.safeParse(properties.input, {
    pageId: 'page_1',
    properties: [
      { name: 'Status', type: 'select', value: 'Done' },
      { name: 'Published', type: 'checkbox', value: 'True' },
    ],
  }).success, true);
  assert.equal(v.safeParse(properties.input, {
    pageId: 'page_1',
    archived: true,
    properties: [{ name: 'Status', type: 'select', value: 'Done' }],
  }).success, false);
  assert.equal(v.safeParse(properties.input, {
    pageId: 'page_1',
    properties: [{ name: 'Related', type: 'relation', value: 'page_2' }],
  }).success, false);
  assert.equal(v.safeParse(blocks.input, {
    parentBlockId: 'page_1',
    blocks: [{ type: 'paragraph', content: 'A bounded paragraph.' }, { type: 'divider' }],
  }).success, true);
  assert.equal(v.safeParse(blocks.input, {
    parentBlockId: 'page_1',
    blocks: [{ type: 'image', image: { external: { url: 'https://example.test/x.png' } } }],
  }).success, false);
});

test('productivity schemas reject unbounded payloads and arbitrary Slides requests', () => {
  const sheetsWrite = MANAGED_CONNECTOR_CATALOG.capability('sheets.values.update');
  const docsMarkdown = MANAGED_CONNECTOR_CATALOG.capability('docs.documents.create_markdown');
  const slidesUpdate = MANAGED_CONNECTOR_CATALOG.capability('slides.presentations.batch_update');
  assert.ok(sheetsWrite && docsMarkdown && slidesUpdate);

  assert.equal(v.safeParse(sheetsWrite.input, {
    spreadsheetId: 'sheet_1',
    range: 'Data!A1:B2',
    values: [['name', 'amount'], ['Ada', 42]],
  }).success, true);
  assert.equal(v.safeParse(sheetsWrite.input, {
    spreadsheetId: 'sheet_1',
    range: 'Data!A1:B2',
    values: Array.from({ length: 501 }, () => ['too many rows']),
  }).success, false);
  assert.equal(v.safeParse(docsMarkdown.input, {
    title: 'Too large',
    markdown: 'x'.repeat(100_001),
  }).success, false);
  assert.equal(v.safeParse(slidesUpdate.input, {
    presentationId: 'deck_1',
    operations: [{ kind: 'delete_object', objectId: 'slide_1' }],
  }).success, false);
  assert.equal(v.safeParse(slidesUpdate.input, {
    presentationId: 'deck_1',
    operations: [{
      kind: 'replace_all_text', findText: '{{name}}', replaceText: 'Ada', matchCase: true,
    }],
  }).success, true);
});

test('catalog construction rejects duplicate and cross-connector capabilities', () => {
  const connector = syntheticResourceConnector();
  assert.throws(
    () => createManagedConnectorCatalog([connector, connector]),
    /Duplicate managed connector toolkit analytics_fixture/,
  );
  assert.throws(
    () => createManagedConnectorCatalog([{
      ...connector,
      capabilities: [{ ...connector.capabilities[0]!, connectorToolkit: 'other' }],
    }]),
    /does not belong to connector analytics_fixture/,
  );
});

test('resource constraints narrow account grants by local handle and fail closed', () => {
  const connector = syntheticResourceConnector();
  const accountMaximum = {
    propertyIds: [
      {
        handle: 'property_primary',
        providerRef: 'properties/123',
        label: 'Primary property',
      },
      {
        handle: 'property_secondary',
        providerRef: 'properties/456',
        label: 'Secondary property',
      },
    ],
  };

  const effective = intersectManagedResourceConstraints(
    connector,
    accountMaximum,
    { propertyIds: ['property_secondary'] },
  );
  assert.deepEqual(effective, {
    propertyIds: [{
      handle: 'property_secondary',
      providerRef: 'properties/456',
      label: 'Secondary property',
    }],
  });
  assert.deepEqual(projectManagedResourceHandles(effective), {
    propertyIds: ['property_secondary'],
  });

  assert.equal(intersectManagedResourceConstraints(connector, accountMaximum, {}), undefined);
  assert.equal(intersectManagedResourceConstraints(
    connector,
    accountMaximum,
    { propertyIds: ['property_unknown'] },
  ), undefined);
  assert.equal(intersectManagedResourceConstraints(
    connector,
    accountMaximum,
    { unexpected: ['property_primary'] },
  ), undefined);
});

test('the config store adds resource constraints to a pre-migration binding table', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'chickpea-managed-migration-'));
  const databasePath = join(directory, 'state.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const initial = new SqliteConfigStore(databasePath, { agents: [] });
  initial.close();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`DROP TABLE config_agent_connection_bindings;
  CREATE TABLE config_agent_connection_bindings (
    agent_id TEXT NOT NULL,
    connection_account_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    allowed_capabilities_json TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, connection_account_id)
  )`);
  legacy.close();

  const config = new SqliteConfigStore(databasePath, { agents: [] });
  try {
    await config.createAgent({
      id: 'agent_migration',
      name: 'Migration fixture',
      instructions: 'Test resource migration.',
      enabled: true,
      creatorMembershipId: 'membership_owner',
      editPolicy: 'creator_and_admins',
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    await config.putConnectionAccount({
      id: 'connection_migration',
      workspaceId: 'T_MIGRATION',
      ownerKind: 'team',
      createdByMembershipId: 'membership_owner',
      providerId: 'google',
      label: 'Migration Gmail',
      policy: {
        kind: 'managed',
        adapterId: 'composio',
        toolkit: 'gmail',
        principalRef: 'chickpea:organization:migration',
        accountRef: 'ca_migration',
        allowedCapabilities: ['gmail.messages.search'],
      },
      secretRefId: 'secret_migration',
      lifecycle: 'ready',
    }, 0);
    await config.putAgentConnectionBinding({
      agentId: 'agent_migration',
      connectionAccountId: 'connection_migration',
      providerId: 'google',
      allowedCapabilities: ['gmail.messages.search'],
      resourceConstraints: { propertyIds: ['property_primary'] },
      enabled: true,
    });
    assert.deepEqual(
      (await config.listAgentConnectionBindings('agent_migration'))[0]?.resourceConstraints,
      { propertyIds: ['property_primary'] },
    );

    const inspection = new DatabaseSync(databasePath);
    try {
      assert.ok(inspection.prepare(
        "SELECT name FROM pragma_table_info('config_agent_connection_bindings') WHERE name = ?",
      ).get('resource_constraints_json'));
      inspection.prepare(
        'UPDATE config_agent_connection_bindings SET resource_constraints_json = ?',
      ).run('{malformed');
    } finally {
      inspection.close();
    }
    assert.deepEqual(
      (await config.listAgentConnectionBindings('agent_migration'))[0]?.resourceConstraints,
      {},
    );
  } finally {
    config.close();
  }
});

test('resource selection revalidates fresh discovery and stores provider IDs outside the response', async () => {
  const connector = syntheticResourceConnector();
  const catalog = createManagedConnectorCatalog([connector]);
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let validations = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() { validations += 1; },
    async execute() { return { data: {} }; },
    async revoke() {},
    async discoverResources() {
      return {
        resources: [
          { providerRef: 'properties/123', label: 'Primary property' },
          { providerRef: 'properties/456', label: 'Secondary property' },
        ],
      };
    },
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedCatalog: catalog,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
  });
  const owner: AuthPrincipal = {
    userId: 'user_owner',
    membershipId: 'membership_owner',
    organizationId: 'organization_test',
    role: 'owner',
    authenticatorKind: 'test',
    credentialId: 'credential_test',
    correlationId: 'correlation_test',
    machine: false,
  };
  try {
    await config.createAgent({
      id: 'agent_resources',
      name: 'Resource fixture',
      instructions: 'Use only selected properties.',
      enabled: true,
      creatorMembershipId: owner.membershipId,
      editPolicy: 'creator_and_admins',
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    await config.createAgent({
      id: 'agent_resources_secondary',
      name: 'Secondary resource fixture',
      instructions: 'Use only the secondary selected property.',
      enabled: true,
      creatorMembershipId: owner.membershipId,
      editPolicy: 'creator_and_admins',
      skills: [],
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_RESOURCES',
      transportMode: 'direct',
      defaultAgentId: 'agent_resources',
    });
    const account = await config.putConnectionAccount({
      id: 'connection_resources',
      workspaceId: 'T_RESOURCES',
      ownerKind: 'team',
      createdByMembershipId: owner.membershipId,
      providerId: 'google',
      label: 'Analytics fixture',
      policy: {
        kind: 'managed',
        adapterId: 'composio',
        toolkit: connector.toolkit,
        principalRef: 'chickpea:organization:organization_test',
        accountRef: 'ca_resources',
        allowedCapabilities: ['analytics_fixture.reports.read'],
      },
      secretRefId: 'secret_resources',
      lifecycle: 'pending',
    }, 0);
    await config.putAgentConnectionBinding({
      agentId: 'agent_resources',
      connectionAccountId: account.id,
      providerId: 'google',
      allowedCapabilities: ['analytics_fixture.reports.read'],
      resourceConstraints: {},
      enabled: true,
    });

    const discovered = await service.listManagedResources({
      principal: owner,
      connectionAccountId: account.id,
      resourceKey: 'propertyIds',
    });
    assert.equal(discovered.resources.length, 2);
    assert.doesNotMatch(JSON.stringify(discovered), /properties\/123|properties\/456/);
    const selectedHandle = discovered.resources[0]!.handle;

    await assert.rejects(
      service.selectManagedResources({
        principal: owner,
        agentId: 'agent_resources',
        connectionAccountId: account.id,
        expectedRevision: account.revision,
        resourceConstraints: { propertyIds: ['resource_not_discovered'] },
      }),
      (error) => error instanceof ManagedResourceSelectionError && error.code === 'invalid',
    );

    const selected = await service.selectManagedResources({
      principal: owner,
      agentId: 'agent_resources',
      connectionAccountId: account.id,
      expectedRevision: account.revision,
      resourceConstraints: { propertyIds: [selectedHandle] },
    });
    assert.equal(selected.account.lifecycle, 'ready');
    assert.equal(validations, 1);
    assert.deepEqual(selected.binding.resourceConstraints, { propertyIds: [selectedHandle] });
    assert.doesNotMatch(JSON.stringify(selected), /properties\/123|properties\/456/);

    const persisted = (await config.listConnectionAccounts('T_RESOURCES'))[0];
    assert.equal(persisted?.policy.kind, 'managed');
    if (persisted?.policy.kind !== 'managed') assert.fail('expected managed policy');
    assert.equal(
      persisted.policy.resourceConstraints?.propertyIds?.[0]?.providerRef,
      'properties/123',
    );

    await service.attach({
      principal: owner,
      agentId: 'agent_resources_secondary',
      connectionAccountId: account.id,
      allowedCapabilities: ['analytics_fixture.reports.read'],
      resourceConstraints: {},
    });
    const secondaryHandle = discovered.resources[1]!.handle;
    const secondary = await service.selectManagedResources({
      principal: owner,
      agentId: 'agent_resources_secondary',
      connectionAccountId: account.id,
      expectedRevision: selected.account.revision,
      resourceConstraints: { propertyIds: [secondaryHandle] },
    });
    assert.deepEqual(secondary.binding.resourceConstraints, {
      propertyIds: [secondaryHandle],
    });
    const sharedAccount = (await config.listConnectionAccounts('T_RESOURCES'))[0];
    if (sharedAccount?.policy.kind !== 'managed') assert.fail('expected managed policy');
    assert.deepEqual(
      sharedAccount.policy.resourceConstraints?.propertyIds?.map(({ providerRef }) => providerRef),
      ['properties/123', 'properties/456'],
    );
    const bindings = await Promise.all([
      config.listAgentConnectionBindings('agent_resources'),
      config.listAgentConnectionBindings('agent_resources_secondary'),
    ]);
    assert.ok(intersectManagedResourceConstraints(
      connector,
      sharedAccount.policy.resourceConstraints,
      bindings[0]![0]!.resourceConstraints,
    ));
    assert.ok(intersectManagedResourceConstraints(
      connector,
      sharedAccount.policy.resourceConstraints,
      bindings[1]![0]!.resourceConstraints,
    ));

    await assert.rejects(
      service.selectManagedResources({
        principal: owner,
        agentId: 'agent_resources',
        connectionAccountId: account.id,
        expectedRevision: account.revision,
        resourceConstraints: { propertyIds: [selectedHandle] },
      }),
      (error) => error instanceof ManagedResourceSelectionError && error.code === 'stale',
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('resource selection can save an item from the bounded window of a longer provider list', async () => {
  const connector = syntheticResourceConnector();
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const owner = resourceOwner();
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
    async discoverResources(input) {
      const page = Number(input.cursor ?? '0');
      return {
        resources: [{ providerRef: `properties/${page}`, label: `Property ${page}` }],
        ...(page < 20 ? { nextCursor: String(page + 1) } : {}),
      };
    },
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedCatalog: createManagedConnectorCatalog([connector]),
    managedProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    await createResourceAgent(config, owner, 'agent_long_resources');
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_LONG_RESOURCES', transportMode: 'direct',
      defaultAgentId: 'agent_long_resources',
    });
    const account = await config.putConnectionAccount({
      id: 'connection_long_resources', workspaceId: 'T_LONG_RESOURCES', ownerKind: 'team',
      createdByMembershipId: owner.membershipId, providerId: 'google', label: 'Long analytics',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: connector.toolkit,
        principalRef: 'chickpea:organization:organization_test', accountRef: 'ca_long_resources',
        allowedCapabilities: ['analytics_fixture.reports.read'],
      },
      secretRefId: 'secret_long_resources', lifecycle: 'pending',
    }, 0);
    await config.putAgentConnectionBinding({
      agentId: 'agent_long_resources', connectionAccountId: account.id, providerId: 'google',
      allowedCapabilities: ['analytics_fixture.reports.read'], resourceConstraints: {}, enabled: true,
    });
    const page = await service.listManagedResources({
      principal: owner, connectionAccountId: account.id, resourceKey: 'propertyIds',
    });

    const selected = await service.selectManagedResources({
      principal: owner,
      agentId: 'agent_long_resources',
      connectionAccountId: account.id,
      expectedRevision: account.revision,
      resourceConstraints: { propertyIds: [page.resources[0]!.handle] },
    });
    assert.equal(selected.account.lifecycle, 'ready');
  } finally {
    config.close();
    settings.close();
  }
});

test('shared resource accounts reject a second Agent that would exceed the durable ceiling', async () => {
  const connector = syntheticResourceConnector();
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  const owner = resourceOwner();
  const providerResources = Array.from({ length: 257 }, (_, index) => ({
    providerRef: `properties/${index}`,
    label: `Property ${index}`,
  }));
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() {},
    async execute() { return { data: {} }; },
    async revoke() {},
    async discoverResources(input) {
      const offset = Number(input.cursor ?? '0');
      const resources = providerResources.slice(offset, offset + 250);
      return {
        resources,
        ...(offset + resources.length < providerResources.length
          ? { nextCursor: String(offset + resources.length) }
          : {}),
      };
    },
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedCatalog: createManagedConnectorCatalog([connector]),
    managedProviders: createManagedConnectionProviderRegistry([provider]),
  });
  try {
    for (const id of ['agent_resource_first', 'agent_resource_second']) {
      await createResourceAgent(config, owner, id);
    }
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_RESOURCE_LIMIT', transportMode: 'direct',
      defaultAgentId: 'agent_resource_first',
    });
    const account = await config.putConnectionAccount({
      id: 'connection_resource_limit', workspaceId: 'T_RESOURCE_LIMIT', ownerKind: 'team',
      createdByMembershipId: owner.membershipId, providerId: 'google', label: 'Large analytics',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: connector.toolkit,
        principalRef: 'chickpea:organization:organization_test', accountRef: 'ca_resource_limit',
        allowedCapabilities: ['analytics_fixture.reports.read'],
      },
      secretRefId: 'secret_resource_limit', lifecycle: 'pending',
    }, 0);
    for (const agentId of ['agent_resource_first', 'agent_resource_second']) {
      await config.putAgentConnectionBinding({
        agentId, connectionAccountId: account.id, providerId: 'google',
        allowedCapabilities: ['analytics_fixture.reports.read'], resourceConstraints: {}, enabled: true,
      });
    }
    const firstPage = await service.listManagedResources({
      principal: owner, connectionAccountId: account.id, resourceKey: 'propertyIds',
    });
    assert.equal(firstPage.resources.length, 250);
    const secondCursor = firstPage.nextCursor;
    assert.ok(secondCursor);
    const secondPage = await service.listManagedResources({
      principal: owner, connectionAccountId: account.id, resourceKey: 'propertyIds',
      cursor: secondCursor,
    });
    assert.equal(secondPage.resources.length, 7);
    const first = await service.selectManagedResources({
      principal: owner,
      agentId: 'agent_resource_first',
      connectionAccountId: account.id,
      expectedRevision: account.revision,
      resourceConstraints: { propertyIds: firstPage.resources.slice(0, 200).map(({ handle }) => handle) },
    });

    await assert.rejects(
      service.selectManagedResources({
        principal: owner,
        agentId: 'agent_resource_second',
        connectionAccountId: account.id,
        expectedRevision: first.account.revision,
        resourceConstraints: {
          propertyIds: [
            ...firstPage.resources.slice(200).map(({ handle }) => handle),
            ...secondPage.resources.map(({ handle }) => handle),
          ],
        },
      }),
      (error) => error instanceof ManagedResourceSelectionError && error.code === 'invalid' &&
        /at most 256 properties/i.test(error.message),
    );
    const persisted = (await config.listConnectionAccounts('T_RESOURCE_LIMIT'))[0];
    assert.equal(
      persisted?.policy.kind === 'managed'
        ? persisted.policy.resourceConstraints?.propertyIds?.length
        : undefined,
      200,
    );
  } finally {
    config.close();
    settings.close();
  }
});

test('config persistence rejects managed account resource ceilings above 256', async () => {
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  try {
    await assert.rejects(config.putConnectionAccount({
      id: 'connection_oversized_resources', workspaceId: 'T_RESOURCE_LIMIT', ownerKind: 'team',
      createdByMembershipId: 'membership_owner', providerId: 'google', label: 'Too large',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: 'analytics_fixture',
        principalRef: 'chickpea:organization:organization_test', accountRef: 'ca_too_large',
        allowedCapabilities: ['analytics_fixture.reports.read'],
        resourceConstraints: {
          propertyIds: Array.from({ length: 257 }, (_, index) => ({
            handle: `resource_${index}`, providerRef: `properties/${index}`, label: `Property ${index}`,
          })),
        },
      },
      secretRefId: 'secret_too_large', lifecycle: 'ready',
    }, 0), /resource constraints are invalid/);
  } finally {
    config.close();
  }
});

test('a newly authorized resource connector stays pending and attaches without runtime authority', async () => {
  const connector = syntheticResourceConnector();
  const catalog = createManagedConnectorCatalog([connector]);
  const config = new SqliteConfigStore(':memory:', { agents: [] });
  const settings = new SqliteSettingsStore(':memory:');
  let validations = 0;
  const provider: ManagedConnectionProvider = {
    id: 'composio',
    async validate() { validations += 1; },
    async execute() { return { data: {} }; },
    async revoke() {},
  };
  const service = new ConnectionAccountService({
    config,
    settings,
    managedCatalog: catalog,
    managedProviders: createManagedConnectionProviderRegistry([provider]),
    randomId: (() => { let value = 0; return () => `resource${++value}`; })(),
  });
  const owner: AuthPrincipal = {
    userId: 'user_owner',
    membershipId: 'membership_owner',
    organizationId: 'organization_test',
    role: 'owner',
    authenticatorKind: 'test',
    credentialId: 'credential_test',
    correlationId: 'correlation_test',
    machine: false,
  };
  try {
    await config.createAgent({
      id: 'agent_pending_resources',
      name: 'Pending resources',
      instructions: 'Wait for an explicit resource selection.',
      enabled: true,
      creatorMembershipId: owner.membershipId,
      editPolicy: 'creator_and_admins',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
    });
    await config.ensureWorkspaceInstallation({
      workspaceId: 'T_RESOURCES', transportMode: 'direct',
      defaultAgentId: 'agent_pending_resources',
    });
    const account = await service.create({
      principal: owner,
      workspaceId: 'T_RESOURCES',
      ownerKind: 'team',
      providerId: 'google',
      label: 'Pending analytics',
      policy: {
        kind: 'managed', adapterId: 'composio', toolkit: connector.toolkit,
        principalRef: 'chickpea:organization:organization_test',
        accountRef: 'ca_pending_resources',
        allowedCapabilities: ['analytics_fixture.reports.read'],
      },
    });
    assert.equal(account.lifecycle, 'pending');
    assert.equal(validations, 1);

    const binding = await service.attach({
      principal: owner,
      agentId: 'agent_pending_resources',
      connectionAccountId: account.id,
      allowedCapabilities: ['analytics_fixture.reports.read'],
    });
    assert.deepEqual(binding.resourceConstraints, {});
  } finally {
    config.close();
    settings.close();
  }
});

function syntheticResourceConnector(): ManagedConnectorDefinition {
  return {
    id: 'analytics-fixture',
    toolkit: 'analytics_fixture',
    providerId: 'google',
    label: 'Analytics fixture',
    description: 'Test-only resource-scoped connector.',
    securityDescription: 'Only selected properties are available.',
    resources: [{
      key: 'propertyIds',
      label: 'Properties',
      required: true,
      multiple: true,
      localArgument: 'propertyHandle',
      providerArgument: 'propertyId',
    }],
    capabilities: [{
      id: 'analytics_fixture.reports.read',
      connectorToolkit: 'analytics_fixture',
      accessLane: 'read',
      effect: 'read',
      toolName: 'analytics_fixture_read_report',
      description: 'Read a fixture report.',
      input: v.strictObject({ propertyHandle: v.string() }),
      maxResultBytes: 16_384,
    }],
  };
}

function resourceOwner(): AuthPrincipal {
  return {
    userId: 'user_owner',
    membershipId: 'membership_owner',
    organizationId: 'organization_test',
    role: 'owner',
    authenticatorKind: 'test',
    credentialId: 'credential_test',
    correlationId: 'correlation_test',
    machine: false,
  };
}

async function createResourceAgent(
  config: SqliteConfigStore,
  owner: AuthPrincipal,
  id: string,
): Promise<void> {
  await config.createAgent({
    id,
    name: id,
    instructions: 'Use only selected properties.',
    enabled: true,
    creatorMembershipId: owner.membershipId,
    editPolicy: 'creator_and_admins',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    repositories: [],
  });
}
