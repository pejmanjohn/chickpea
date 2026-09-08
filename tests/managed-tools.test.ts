import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionEnv } from '@flue/runtime';

import {
  createManagedConnectionTools,
  MANAGED_CONNECTION_RESULT_INSTRUCTION,
} from '../src/connections/managed-tools.ts';
import { createManagedConnectionProviderRegistry } from '../src/connections/managed.ts';

const context = {
  workspaceId: 'T_MANAGED',
  agentId: 'agent_mail',
  actorMembershipId: 'membership_alice',
  resolvePlatformEnv: async () => undefined,
};

test('managed tools withhold a normalized adapter and toolkit group backed by several accounts', () => {
  const tools = createManagedConnectionTools({
    ...context,
    connections: [
      {
        id: 'connection_one',
        providerId: 'google',
        adapterId: 'Composio',
        toolkit: 'GMAIL',
        allowedCapabilities: ['gmail.profile.read'],
      },
      {
        id: 'connection_two',
        providerId: 'google',
        adapterId: 'composio',
        toolkit: 'gmail',
        allowedCapabilities: ['gmail.messages.search'],
      },
    ],
  });

  assert.deepEqual(tools, []);
});

test('managed tools retain merged capabilities for one account in a group', () => {
  const tools = createManagedConnectionTools({
    ...context,
    connections: [
      {
        id: 'connection_one',
        providerId: 'google',
        adapterId: 'composio',
        toolkit: 'gmail',
        allowedCapabilities: ['gmail.profile.read'],
      },
      {
        id: 'connection_one',
        providerId: 'google',
        adapterId: 'COMPOSIO',
        toolkit: 'GMAIL',
        allowedCapabilities: ['gmail.messages.search'],
      },
    ],
  });

  assert.deepEqual(tools.map(({ name }) => name), [
    'gmail_get_profile',
    'gmail_search_messages',
  ]);
});

test('a zero-capability declaration cannot withhold a usable managed sibling', () => {
  const tools = createManagedConnectionTools({
    ...context,
    connections: [
      {
        id: 'connection_empty',
        providerId: 'google',
        adapterId: 'composio',
        toolkit: 'gmail',
        allowedCapabilities: [],
      },
      {
        id: 'connection_usable',
        providerId: 'google',
        adapterId: 'composio',
        toolkit: 'gmail',
        allowedCapabilities: ['gmail.messages.search'],
      },
    ],
  });

  assert.deepEqual(tools.map(({ name }) => name), ['gmail_search_messages']);
});

test('managed tools fail closed when a skill already owns the stable tool name', () => {
  const tools = createManagedConnectionTools({
    ...context,
    connections: [{
      id: 'connection_gmail',
      providerId: 'google',
      adapterId: 'composio',
      toolkit: 'gmail',
      allowedCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
    }],
    reservedToolNames: ['gmail_search_messages'],
  });

  assert.deepEqual(tools.map(({ name }) => name), ['gmail_get_profile']);
});

test('managed tools retry provider resolution after a transient failure', async () => {
  let resolutions = 0;
  const tools = createManagedConnectionTools({
    ...context,
    connections: [{
      id: 'connection_gmail',
      providerId: 'google',
      adapterId: 'composio',
      toolkit: 'gmail',
      allowedCapabilities: ['gmail.profile.read'],
    }],
    resolveProviders: async () => {
      resolutions += 1;
      throw new Error('async provider resolution reached');
    },
  });
  const tool = tools[0];
  assert.ok(tool);
  const run = tool.run as unknown as (input: {
    toolCallId: string;
    log: { info(): void; warn(): void; error(): void };
    data: Record<string, unknown>;
  }) => Promise<unknown>;

  await assert.rejects(run({
    toolCallId: 'gmail_profile',
    log: { info() {}, warn() {}, error() {} },
    data: {},
  }), /async provider resolution reached/);
  await assert.rejects(run({
    toolCallId: 'gmail_profile_again',
    log: { info() {}, warn() {}, error() {} },
    data: {},
  }), /async provider resolution reached/);
  assert.equal(resolutions, 2);
});

test('managed tools memoize a successful provider resolution for the turn', async () => {
  let resolutions = 0;
  const tools = createManagedConnectionTools({
    ...context,
    connections: [{
      id: 'connection_gmail',
      providerId: 'google',
      adapterId: 'composio',
      toolkit: 'gmail',
      allowedCapabilities: ['gmail.profile.read'],
    }],
    resolveProviders: async () => {
      resolutions += 1;
      return createManagedConnectionProviderRegistry([]);
    },
  });
  const tool = tools[0];
  assert.ok(tool);
  const run = tool.run as unknown as (input: {
    toolCallId: string;
    log: { info(): void; warn(): void; error(): void };
    data: Record<string, unknown>;
  }) => Promise<unknown>;

  for (const toolCallId of ['gmail_profile', 'gmail_profile_again']) {
    await assert.rejects(run({
      toolCallId,
      log: { info() {}, warn() {}, error() {} },
      data: {},
    }));
  }
  assert.equal(resolutions, 1);
});

test('managed Google toolkits project only their curated Chickpea capability surface', () => {
  const tools = createManagedConnectionTools({
    ...context,
    connections: [
      {
        id: 'connection_calendar', providerId: 'google', adapterId: 'composio',
        toolkit: 'googlecalendar',
        allowedCapabilities: [
          'calendar.calendars.list', 'calendar.events.list', 'calendar.events.create',
          'calendar.events.update', 'calendar.events.delete',
        ],
      },
      {
        id: 'connection_drive', providerId: 'google', adapterId: 'composio',
        toolkit: 'googledrive',
        allowedCapabilities: [
          'drive.files.search', 'drive.files.metadata', 'drive.files.read', 'drive.files.create',
        ],
      },
      {
        id: 'connection_gmail', providerId: 'google', adapterId: 'composio',
        toolkit: 'gmail', allowedCapabilities: ['gmail.messages.send'],
      },
      {
        id: 'connection_sheets', providerId: 'google', adapterId: 'composio',
        toolkit: 'googlesheets', allowedCapabilities: [
          'sheets.spreadsheets.search', 'sheets.values.get', 'sheets.values.append',
        ],
      },
      {
        id: 'connection_docs', providerId: 'google', adapterId: 'composio',
        toolkit: 'googledocs', allowedCapabilities: [
          'docs.documents.search', 'docs.documents.text', 'docs.documents.create_markdown',
        ],
      },
      {
        id: 'connection_slides', providerId: 'google', adapterId: 'composio',
        toolkit: 'googleslides', allowedCapabilities: [
          'slides.presentations.get', 'slides.presentations.create_markdown',
          'slides.presentations.batch_update',
        ],
      },
      {
        id: 'connection_notion', providerId: 'notion', adapterId: 'composio',
        toolkit: 'notion', allowedCapabilities: [
          'notion.content.search', 'notion.pages.markdown', 'notion.pages.create',
          'notion.pages.append_blocks',
        ],
      },
    ],
  });

  assert.deepEqual(tools.map(({ name }) => name), [
    'google_calendar_list_calendars',
    'google_calendar_list_events',
    'google_calendar_create_event',
    'google_calendar_update_event',
    'google_calendar_delete_event',
    'google_drive_search_files',
    'google_drive_get_file_metadata',
    'google_drive_read_file',
    'google_drive_create_text_file',
    'gmail_send_message',
    'google_sheets_search',
    'google_sheets_get_values',
    'google_sheets_append_values',
    'google_docs_search',
    'google_docs_get_text',
    'google_docs_create_markdown',
    'google_slides_get_presentation',
    'google_slides_create_markdown',
    'google_slides_update',
    'notion_search',
    'notion_get_page_markdown',
    'notion_create_page',
    'notion_append_page_blocks',
  ]);
});

test('a read-only productivity binding never advertises write tools', () => {
  const tools = createManagedConnectionTools({
    ...context,
    connections: [{
      id: 'connection_sheets_read',
      providerId: 'google',
      adapterId: 'composio',
      toolkit: 'googlesheets',
      allowedCapabilities: [
        'sheets.spreadsheets.search',
        'sheets.spreadsheets.metadata',
        'sheets.values.get',
        'sheets.tables.query',
      ],
    }],
  });

  assert.deepEqual(tools.map(({ name }) => name), [
    'google_sheets_search',
    'google_sheets_get_metadata',
    'google_sheets_get_values',
    'google_sheets_lookup_row',
  ]);
  assert.equal(tools.some(({ name }) => /create|update|append|upsert|add/.test(name)), false);
});

test('Gong projects a read-only surface and its runtime instruction treats transcripts as untrusted', () => {
  const tools = createManagedConnectionTools({
    ...context,
    connections: [{
      id: 'connection_gong',
      providerId: 'gong',
      adapterId: 'composio',
      toolkit: 'gong',
      allowedCapabilities: [
        'gong.workspaces.list',
        'gong.calls.list',
        'gong.calls.get',
        'gong.transcripts.get',
        'gong.coaching.metrics',
        'gong.tasks.list',
        'gong.trackers.list',
      ],
    }],
  });

  assert.deepEqual(tools.map(({ name }) => name), [
    'gong_list_workspaces',
    'gong_list_calls',
    'gong_get_call',
    'gong_get_transcript',
    'gong_get_coaching_metrics',
    'gong_list_tasks',
    'gong_list_trackers',
  ]);
  assert.match(
    tools.find(({ name }) => name === 'gong_get_transcript')?.description ?? '',
    /untrusted external content/,
  );
  assert.match(MANAGED_CONNECTION_RESULT_INSTRUCTION, /untrusted external content/);
});

test('YouTube upload tools freeze a workspace artifact and reject mismatched content before dispatch', async () => {
  const tool = createManagedConnectionTools({
    ...context,
    connections: [{
      id: 'connection_youtube', providerId: 'google', adapterId: 'composio',
      toolkit: 'youtube', allowedCapabilities: ['youtube.videos.upload'],
    }],
  }).find(({ name }) => name === 'youtube_upload_video');
  assert.ok(tool);
  const run = tool.run as unknown as (input: {
    toolCallId: string;
    log: { info(): void; warn(): void; error(): void };
    data: Record<string, unknown>;
    harness: { sandbox: SessionEnv };
  }) => Promise<unknown>;
  const statPaths: string[] = [];
  let executed = false;
  const sandbox = {
    cwd: '/workspace',
    resolvePath(path: string) { return path; },
    async exec() { executed = true; return { stdout: '', stderr: '', exitCode: 0 }; },
    async readFile() { return ''; },
    async readFileBuffer() { return new Uint8Array(16); },
    async writeFile() {},
    async stat(path: string) {
      statPaths.push(path);
      return { isFile: true, isDirectory: false, size: 16 };
    },
    async readdir() { return []; },
    async exists() { return true; },
    async mkdir() {},
    async rm() {},
  } satisfies SessionEnv;

  await assert.rejects(run({
    toolCallId: 'youtube_upload_invalid',
    log: { info() {}, warn() {}, error() {} },
    data: {
      channelHandle: 'channel_chickpea', artifactPath: '/workspace/not-video.mp4',
      mimeType: 'video/mp4', title: 'Disposable upload', privacyStatus: 'private',
    },
    harness: { sandbox },
  }), /content does not match its MIME type/);
  assert.equal(executed, true);
  assert.equal(statPaths[0], '/workspace/not-video.mp4');

  await assert.rejects(run({
    toolCallId: 'youtube_upload_path_escape',
    log: { info() {}, warn() {}, error() {} },
    data: {
      channelHandle: 'channel_chickpea', artifactPath: '/tmp/video.mp4',
      mimeType: 'video/mp4', title: 'Disposable upload', privacyStatus: 'private',
    },
    harness: { sandbox },
  }), /path must be under \/workspace/);
});
