import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as v from 'valibot';

import type { ConnectionAccountManagedPolicy } from '../src/config/types.ts';
import {
  COMPOSIO_MANIFESTS,
  compileComposioManifest,
  parseComposioManifest,
  type ComposioManifest,
} from '../src/connections/catalog/composio-manifests.ts';
import trello from '../src/connections/catalog/manifests/trello.json' with { type: 'json' };
import { MANAGED_CONNECTOR_CATALOG } from '../src/connections/catalog/index.ts';
import { ManagedProviderRequestError } from '../src/connections/managed-errors.ts';
import { ComposioManagedConnectionProvider } from '../src/connections/providers/composio.ts';
import { manifestComposioCapabilities } from '../src/connections/providers/composio/manifest-capabilities.ts';
import {
  checkComposioManifest,
  checkComposioManifestDirectory,
  draftComposioManifest,
  fetchComposioToolkit,
  readSnapshot,
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

const PILOT_MANIFESTS = [...COMPOSIO_MANIFESTS, parseComposioManifest(trello)];

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
    tool('ACME_LIST_BOARDS', ['readOnlyHint'], {
      type: 'object',
      properties: { filter_visibility: string('Only boards with this visibility.') },
    }),
  ]));
  const properties = (slug: string) =>
    Object.keys(manifest.capabilities.find(({ tool: name }) => name === slug)!.input.properties);

  assert.deepEqual(properties('ACME_CREATE_BOARD'), ['name', 'idWorkspace']);
  assert.deepEqual(properties('ACME_UPDATE_CARD'), ['idCard', 'idList', 'name']);
  assert.deepEqual(properties('ACME_LIST_BOARDS'), ['filter_visibility']);
  assert.deepEqual(Object.keys(report.withheldArguments.find(({ tool: slug }) => slug === 'ACME_CREATE_BOARD')!.arguments), [
    'prefs_permissionLevel', 'prefs__comments', 'idMembers', 'idOrganization', 'idBoardSource',
  ]);
  assert.deepEqual(
    manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_UPDATE_CARD')!.withheldArguments,
    { idBoard: 'moves the record to another container' },
  );
});

test('write tools lose file and copy-source arguments but keep a plain source field', () => {
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
      },
    }),
  ]));
  const card = manifest.capabilities.find(({ tool: slug }) => slug === 'ACME_CREATE_CARD')!;

  assert.deepEqual(Object.keys(card.input.properties), ['name', 'source']);
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

const FRESHDESK_POLICY: ConnectionAccountManagedPolicy = {
  kind: 'managed',
  adapterId: 'composio',
  toolkit: 'freshdesk',
  principalRef: 'chickpea:membership:membership_test',
  accountRef: 'ca_freshdesk',
  allowedCapabilities: ['freshdesk.currently_authenticated_agent', 'freshdesk.add_note_to_ticket'],
};

function recordingProvider(data: Record<string, unknown>, calls: Array<Record<string, unknown>>) {
  return new ComposioManagedConnectionProvider({
    apiKey: 'test-key',
    getConnectedAccount: async () => ({
      id: FRESHDESK_POLICY.accountRef,
      status: 'ACTIVE',
      isDisabled: false,
      toolkit: 'freshdesk',
      userId: FRESHDESK_POLICY.principalRef,
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
    },
  };
  const { manifest } = draftComposioManifest(snapshot([
    tool('ACME_UPDATE_CONTACT', ['updateHint'], { ...contact, required: ['id'] }),
    tool('ACME_CREATE_CONTACT', ['createHint'], contact),
  ]));
  const properties = (slug: string) =>
    Object.keys(manifest.capabilities.find(({ tool: name }) => name === slug)!.input.properties);

  assert.deepEqual(properties('ACME_UPDATE_CONTACT'), ['id', 'name']);
  assert.deepEqual(properties('ACME_CREATE_CONTACT'), ['id', 'name', 'mobile', 'requester_id', 'unique_external_id']);
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

const MOVE_CARD = manifestComposioCapabilities([pilotManifest('trello')])['trello.update_cards_by_id_card']!;

function boardLookups(card: () => Record<string, unknown>, list: Record<string, unknown>, calls: string[]) {
  return async (tool: string): Promise<Record<string, unknown>> => {
    calls.push(tool);
    if (tool === 'TRELLO_GET_CARDS_BY_ID_CARD') return card();
    if (tool === 'TRELLO_GET_LISTS_BOARD_BY_ID_LIST') return list;
    throw new Error(`unexpected lookup ${tool}`);
  };
}

const sameBoardRule = /idList must stay in the record's current container/;

test('moving a card to a list on another board fails its precondition', async () => {
  const calls: string[] = [];
  const move = { idCard: 'c'.repeat(24), idList: 'l'.repeat(24) };
  const boards = (card: string, list: string) =>
    boardLookups(() => ({ data: { id: 'card', idBoard: card } }), { id: list }, calls);

  await assert.rejects(MOVE_CARD.beforeDispatch!(move, boards('board_a', 'board_b')), sameBoardRule);
  assert.deepEqual(calls.sort(), ['TRELLO_GET_CARDS_BY_ID_CARD', 'TRELLO_GET_LISTS_BOARD_BY_ID_LIST']);

  calls.length = 0;
  await MOVE_CARD.beforeDispatch!(move, boards('board_a', 'board_a'));
  assert.deepEqual(calls.sort(), ['TRELLO_GET_CARDS_BY_ID_CARD', 'TRELLO_GET_LISTS_BOARD_BY_ID_LIST']);

  calls.length = 0;
  await MOVE_CARD.beforeDispatch!({ idCard: 'c'.repeat(24), name: 'Renamed' }, boards('board_a', 'board_b'));
  assert.deepEqual(calls, []);
});

test('a list move fails closed when the card lookup is empty, shaped differently, or fails', async () => {
  const board = { id: 'board_a' };
  const cases: Array<[string, () => Record<string, unknown>, Record<string, unknown>]> = [
    ['empty card body', () => ({}), board],
    ['board id under another key', () => ({ card: { idBoard: 'board_a' } }), board],
    ['board id two data levels down', () => ({ data: { data: { idBoard: 'board_a' } } }), board],
    ['lookup that throws', () => { throw new Error('socket hang up'); }, board],
    ['both lookups empty', () => ({}), {}],
  ];

  for (const [name, card, list] of cases) {
    const calls: string[] = [];
    await assert.rejects(
      MOVE_CARD.beforeDispatch!({ idCard: 'c'.repeat(24), idList: 'l'.repeat(24) }, boardLookups(card, list, calls)),
      sameBoardRule,
      name,
    );
    assert.ok(calls.includes('TRELLO_GET_CARDS_BY_ID_CARD'), name);
  }
});
