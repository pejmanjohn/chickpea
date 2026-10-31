import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigStoreLogic, SqliteConfigStore } from '../src/config/store.ts';
import type { SlackPublicContextEntry } from '../src/config/types.ts';
import { agentRoutineDeletion } from '../src/routines/store.ts';
import type { CompletedSlackArtifactReceipt } from '../src/slack/artifact-receipts.ts';
import {
  assembleRetainedSlackContext,
  reconcileSlackPublicContextMutation,
  recordAcceptedSlackHumanMessage,
  recordDeliveredSlackAgentMessage,
  recordedArtifactFiles,
  recordedSlackFiles,
  recordSlackThreadEventMessage,
} from '../src/slack/public-context.ts';
import { hydrateTurnSlackContext } from '../src/slack/turn-context-reads.ts';
import type { NormalizedSlackTurn } from '../src/slack/types.ts';
import { openStateDb } from '../src/state/node-state-db.ts';

const ROOT = '1000.000100';
const KIT = { id: 'F0KIT000001', name: 'kit.zip', mimetype: 'application/zip', filetype: 'zip', size: 2_048 };
const NOTES = { id: 'F0PDF000001', name: 'notes.pdf', mimetype: 'application/pdf', filetype: 'pdf', size: 4_096 };
const LOGO = { id: 'F0LOGO00001', name: 'logo.png', mimetype: 'image/png', filetype: 'png', size: 1_024 };
const KIT_REF = { id: 'F0KIT000001', name: 'kit.zip', mimeType: 'application/zip', sizeBytes: 2_048 };
const NOTES_REF = { id: 'F0PDF000001', name: 'notes.pdf', mimeType: 'application/pdf', sizeBytes: 4_096 };
const LOGO_REF = { id: 'F0LOGO00001', name: 'logo.png', mimeType: 'image/png', sizeBytes: 1_024 };

function turn(overrides: Partial<NormalizedSlackTurn> = {}): NormalizedSlackTurn {
  return {
    workspaceId: 'T1', channelId: 'C1', eventId: 'Ev1', text: '<@UBOT> what is in these?', userId: 'U_DANA',
    messageTs: ROOT, threadTs: ROOT, source: 'app_mention', contextMode: 'thread', ...overrides,
  };
}

async function memoryStore() {
  const store = new SqliteConfigStore(':memory:', agentRoutineDeletion);
  await store.createAgent({
    id: 'agent_a', name: 'a', instructions: '', enabled: true, lifecycle: 'active', creatorMembershipId: 'owner',
    editPolicy: 'creator_and_admins', skills: [], mcpServers: [], apiConnections: [], repositories: [],
  } as never);
  return store;
}

const PACED_STATE = {
  reserveSlackRead: async () => ({ outcome: 'reserved' as const, budgetVersion: 1 }),
  applySlackReadCooldown: async () => ({ cooldownUntil: 0, budgetVersion: 1 }),
};
const NO_SLACK_READ = { conversations: { async replies() { throw new Error('no Slack read expected'); } } };

test('a row written before file_refs_json existed reads exactly as before, with no file references', () => {
  const db = openStateDb(':memory:');
  const writtenAt = Date.now();
  try {
    new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    db.exec('ALTER TABLE config_slack_public_context DROP COLUMN file_refs_json');
    db.run(
      `INSERT INTO config_slack_public_context (
        workspace_id, channel_id, root_ts, message_ts, role, text, agent_id, content_version_ts,
        author_kind, author_id, author_name, files_json, images_json, gap_before_ts, updated_at
      ) VALUES (?, ?, ?, ?, 'human', ?, NULL, NULL, 'person', ?, NULL, ?, ?, NULL, ?)`,
      'T1', 'C1', ROOT, ROOT, 'here is the zip', 'U_DANA',
      JSON.stringify([{ name: 'q3.zip', type: 'zip', sizeBytes: 2_048 }, { name: 'logo.png', type: 'png' }]),
      JSON.stringify([LOGO_REF]),
      writtenAt,
    );

    const upgraded = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    const column = db.all('PRAGMA table_info(config_slack_public_context)').find((row) => row.name === 'file_refs_json');
    assert.deepEqual([column?.type, column?.notnull, column?.dflt_value], ['TEXT', 0, null], 'added nullable, with no default');
    assert.deepEqual(upgraded.listSlackPublicContext('T1', 'C1', ROOT), [{
      workspaceId: 'T1', channelId: 'C1', rootTs: ROOT, messageTs: ROOT, role: 'human', text: 'here is the zip',
      authorId: 'U_DANA',
      files: [{ name: 'q3.zip', type: 'zip', sizeBytes: 2_048 }, { name: 'logo.png', type: 'png' }],
      images: [LOGO_REF],
      updatedAt: writtenAt,
    }] satisfies SlackPublicContextEntry[]);
  } finally { db.close(); }
});

test('a stored reference without a string id and name is dropped, and an unreadable value reads as none', () => {
  const db = openStateDb(':memory:');
  try {
    const store = new ConfigStoreLogic(db, agentRoutineDeletion, { agents: [] });
    store.putSlackPublicContext({
      workspaceId: 'T1', channelId: 'C1', rootTs: ROOT, messageTs: ROOT, role: 'human', text: 'files', fileRefs: [KIT_REF],
    });
    const refsAfter = (value: string) => {
      db.run('UPDATE config_slack_public_context SET file_refs_json = ?', value);
      return store.listSlackPublicContext('T1', 'C1', ROOT)[0]?.fileRefs;
    };
    assert.deepEqual(refsAfter(JSON.stringify([{ name: 'no-id.zip' }, { id: 'F0NONAME001' }, 'F0STRING001', KIT_REF])), [KIT_REF]);
    assert.equal(refsAfter('{not json'), undefined);
    assert.equal(refsAfter(JSON.stringify({ id: 'F0KIT000001', name: 'kit.zip' })), undefined);
  } finally { db.close(); }
});

test('a message\'s files split into image references and file references that never overlap', () => {
  const recorded = recordedSlackFiles([
    KIT,
    LOGO,
    NOTES,
    { id: 'F0SVG000001', name: 'logo.svg', mimetype: 'image/svg+xml', size: 300 },
    { id: 'F0NOTES0002', name: 'drafts/notes.md', mimetype: 'text/markdown; charset=utf-8', size: -1 },
    { id: 'F0GONE00001', mode: 'tombstone' },
    { id: 'F0HIDDEN001', name: 'old.pdf', mimetype: 'application/pdf', mode: 'hidden_by_limit' },
    { id: 'F0DRIVE0001', name: 'plan.gdoc', mode: 'external', is_external: true },
    { id: 'not-a-file-id', name: 'bad.zip' },
    'F0STRING001',
  ]);
  assert.deepEqual(recorded.images, [LOGO_REF]);
  assert.deepEqual(recorded.fileRefs, [
    KIT_REF,
    NOTES_REF,
    { id: 'F0SVG000001', name: 'logo.svg', mimeType: 'image/svg+xml', sizeBytes: 300 },
    { id: 'F0NOTES0002', name: 'notes.md', mimeType: 'text/markdown' },
  ]);
  assert.deepEqual(recordedSlackFiles(undefined), { images: [], fileRefs: [] });
});

test('an Agent reply records the files it shares: images as images, everything else as file references', () => {
  const receipt = (fileId: string, filename: string): CompletedSlackArtifactReceipt => ({
    schemaVersion: 2, fileId, filename, kind: 'file', byteLength: 900, stagedAt: 1,
    permalink: `https://example.slack.com/files/U1/${fileId}/${filename}`,
  } as never);
  assert.deepEqual(recordedArtifactFiles([receipt('F0CHART0001', 'chart.png'), receipt('F0REPORT001', 'report.pdf')]), {
    images: [{ id: 'F0CHART0001', name: 'chart.png', mimeType: 'image/png', sizeBytes: 900 }],
    fileRefs: [{ id: 'F0REPORT001', name: 'report.pdf', sizeBytes: 900 }],
  });
});

test('the message that addressed the Agent keeps its file labels and references, so a record-based follow-up still sees them', async () => {
  const store = await memoryStore();
  try {
    await recordAcceptedSlackHumanMessage(store, turn(), { runtimeContract: 'chickpea-v1' } as never, [KIT, NOTES, LOGO]);
    await recordDeliveredSlackAgentMessage(store, turn(), { runtimeContract: 'chickpea-v1', agentId: 'agent_a' } as never,
      { messageTs: '1001.000100', text: 'The zip holds a plan.' });
    const [addressed] = await store.listSlackPublicContext('T1', 'C1', ROOT);
    assert.deepEqual(addressed?.files, [
      { name: 'kit.zip', type: 'zip', sizeBytes: 2_048 },
      { name: 'notes.pdf', type: 'pdf', sizeBytes: 4_096 },
      { name: 'logo.png', type: 'png', sizeBytes: 1_024 },
    ]);
    assert.deepEqual(addressed?.images, [LOGO_REF]);
    assert.deepEqual(addressed?.fileRefs, [KIT_REF, NOTES_REF]);

    const followUp = turn({ messageTs: '1002.000100', text: '<@UBOT> now open the plan', eventId: 'Ev2' });
    const hydrated = await hydrateTurnSlackContext({
      client: NO_SLACK_READ as never, turn: followUp, sharedAppReads: true, state: PACED_STATE as never, record: store,
    });
    assert.equal(hydrated.window?.reason, 'thread_record');
    const assembled = await assembleRetainedSlackContext(hydrated, followUp, { store, agentId: 'agent_a' });
    assert.deepEqual(assembled.messages.find((message) => message.ts === ROOT)?.files?.map(({ name }) => name),
      ['kit.zip', 'notes.pdf', 'logo.png']);
  } finally { store.close(); }
});

test('a thread reply records its file references, an absent list keeps them, and an edit that removes the files clears them', async () => {
  const store = await memoryStore();
  try {
    const reply = { type: 'message', channel: 'C1', user: 'U_SAM', text: 'the deck', ts: '1003.000100', thread_ts: ROOT };
    assert.equal(await recordSlackThreadEventMessage(store, 'T1', { ...reply, files: [KIT, LOGO] } as never, {}), true);
    const stored = async () => (await store.listSlackPublicContext('T1', 'C1', ROOT)).find((entry) => entry.messageTs === reply.ts);
    assert.deepEqual((await stored())?.fileRefs, [KIT_REF]);

    await store.putSlackPublicContext({ workspaceId: 'T1', channelId: 'C1', rootTs: ROOT, messageTs: reply.ts, role: 'human', text: 'the deck, again' });
    assert.deepEqual((await stored())?.fileRefs, [KIT_REF], 'a write without the list keeps the stored references');

    await reconcileSlackPublicContextMutation(store, 'T1', {
      type: 'message', subtype: 'message_changed', channel: 'C1', ts: '1004.000100',
      message: { ...reply, text: 'never mind the deck', files: [], edited: { ts: '1004.000100' } },
    } as never);
    const edited = await stored();
    assert.equal(edited?.text, 'never mind the deck');
    assert.equal(edited?.fileRefs, undefined, 'the edit wrote an empty list');
  } finally { store.close(); }
});
