import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as v from 'valibot';

import type { ConnectionAccountManagedPolicy } from '../src/config/types.ts';
import {
  COMPOSIO_MANIFESTS,
  parseComposioManifest,
  type ComposioManifest,
} from '../src/connections/catalog/composio-manifests.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../src/connections/catalog/index.ts';
import { ManagedProviderRequestError } from '../src/connections/managed-errors.ts';
import { ComposioManagedConnectionProvider } from '../src/connections/providers/composio.ts';
import {
  checkComposioManifest,
  checkComposioManifestDirectory,
  draftComposioManifest,
  readSnapshot,
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

const pilotManifest = (toolkit: string) => structuredClone(
  COMPOSIO_MANIFESTS.find((manifest) => manifest.toolkit === toolkit)!,
) as ComposioManifest;

test('every committed manifest matches the generator output for its pinned snapshot', async () => {
  assert.deepEqual(await checkComposioManifestDirectory(), []);
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

test('Freshdesk replies reach only the ticket requester, and forwarding and outbound email are absent', () => {
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
  const compiled = MANAGED_CONNECTOR_CATALOG.capability('trello.add_boards')!.input;
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
  const addCard = MANAGED_CONNECTOR_CATALOG.capability('trello.add_cards')!;
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

  const compiled = MANAGED_CONNECTOR_CATALOG.capability('trello.add_cards')!.input;
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
  for (const toolkit of ['trello', 'freshdesk']) {
    const connector = MANAGED_CONNECTOR_CATALOG.connector(toolkit)!;
    assert.equal(connector.id, `${toolkit}-managed`);
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

const TRELLO_POLICY: ConnectionAccountManagedPolicy = {
  kind: 'managed',
  adapterId: 'composio',
  toolkit: 'trello',
  principalRef: 'chickpea:membership:membership_test',
  accountRef: 'ca_trello',
  allowedCapabilities: ['trello.who_am_i', 'trello.add_cards'],
};

function recordingProvider(data: Record<string, unknown>, calls: Array<Record<string, unknown>>) {
  return new ComposioManagedConnectionProvider({
    apiKey: 'test-key',
    getConnectedAccount: async () => ({
      id: TRELLO_POLICY.accountRef,
      status: 'ACTIVE',
      isDisabled: false,
      toolkit: 'trello',
      userId: TRELLO_POLICY.principalRef,
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
    policy: TRELLO_POLICY,
    capability: 'trello.add_cards',
    arguments: { idList: 'a'.repeat(24), name: 'Ship it' },
  });

  assert.deepEqual(calls, [{
    tool: 'TRELLO_ADD_CARDS',
    userId: TRELLO_POLICY.principalRef,
    connectedAccountId: TRELLO_POLICY.accountRef,
    version: pilotManifest('trello').version,
    arguments: { idList: 'a'.repeat(24), name: 'Ship it' },
  }]);
  assert.equal(result.data.truncated, true);
  assert.ok(new TextEncoder().encode(JSON.stringify(result.data)).byteLength <= 65_536);

  await assert.rejects(
    provider.execute({ policy: TRELLO_POLICY, capability: 'trello.add_cards', arguments: { name: 'No list' } }),
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
      policy: TRELLO_POLICY,
      capability: 'trello.add_cards',
      arguments: { idList: 'a'.repeat(24) },
    }),
    (error: unknown) => error instanceof ManagedProviderRequestError && error.code === 'ambiguous',
  );
});

test('connection validation runs the manifest validation capability', async () => {
  const calls: Array<Record<string, unknown>> = [];
  await recordingProvider({ id: 'member' }, calls).validate({ policy: TRELLO_POLICY });

  assert.deepEqual(calls.map(({ tool: slug, arguments: args }) => ({ slug, args })), [
    { slug: 'TRELLO_WHO_AM_I', args: {} },
  ]);
});

test('update tools lose requester and identity arguments while create tools keep them', () => {
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
  assert.deepEqual(properties('ACME_CREATE_CONTACT'), [
    'id', 'name', 'email', 'other_emails', 'mobile', 'requester_id', 'unique_external_id',
  ]);
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
  ...TRELLO_POLICY,
  allowedCapabilities: ['trello.who_am_i', 'trello.update_cards_by_id_card'],
};

function boardProvider(boards: { card: string; list: string }, calls: string[]) {
  return new ComposioManagedConnectionProvider({
    apiKey: 'test-key',
    getConnectedAccount: async () => { throw new Error('status unavailable'); },
    createClient: async () => ({
      sessions: { async create() { throw new Error('session execution must not be used'); } },
      tools: {
        async execute(slug) {
          calls.push(slug);
          const data = slug === 'TRELLO_GET_CARDS_BY_ID_CARD' ? { data: { id: 'card', idBoard: boards.card } }
            : slug === 'TRELLO_GET_LISTS_BOARD_BY_ID_LIST' ? { id: boards.list }
            : { id: 'card' };
          return { data, error: null, successful: true };
        },
      },
    }),
  });
}

test('moving a card to a list on another board is rejected before the write dispatches', async () => {
  const calls: string[] = [];
  const move = { idCard: 'c'.repeat(24), idList: 'l'.repeat(24) };

  await assert.rejects(
    boardProvider({ card: 'board_a', list: 'board_b' }, calls)
      .execute({ policy: CARD_POLICY, capability: 'trello.update_cards_by_id_card', arguments: move }),
    (error: unknown) => error instanceof ManagedProviderRequestError &&
      error.code === 'validation_failed' && error.metadata.capabilityToolDispatched === false,
  );
  assert.deepEqual(calls.sort(), ['TRELLO_GET_CARDS_BY_ID_CARD', 'TRELLO_GET_LISTS_BOARD_BY_ID_LIST']);

  calls.length = 0;
  await boardProvider({ card: 'board_a', list: 'board_a' }, calls)
    .execute({ policy: CARD_POLICY, capability: 'trello.update_cards_by_id_card', arguments: move });
  assert.equal(calls.at(-1), 'TRELLO_UPDATE_CARDS_BY_ID_CARD');

  calls.length = 0;
  await boardProvider({ card: 'board_a', list: 'board_b' }, calls).execute({
    policy: CARD_POLICY,
    capability: 'trello.update_cards_by_id_card',
    arguments: { idCard: 'c'.repeat(24), name: 'Renamed' },
  });
  assert.deepEqual(calls, ['TRELLO_UPDATE_CARDS_BY_ID_CARD']);
});
