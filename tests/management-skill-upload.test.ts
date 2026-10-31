import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMcpHandler } from '@modelcontextprotocol/server';

import type { SkillConfig } from '../src/config/types.ts';
import { createWorkspaceManagementMcpServer } from '../src/management/mcp.ts';
import { invokeWorkspaceManagementTool, type WorkspaceManagementToolArguments } from '../src/management/tool-adapter.ts';
import type {
  ManagementActorContext,
  ManagementApplyResult,
  UploadSkillsResult,
} from '../src/management/types.ts';
import {
  createFixtureAgent,
  ownerMcpContext,
  ownerSlackDmContext,
  withManagementAdapterFixture,
  type ManagementAdapterFixture,
} from './helpers/management-adapter-fixture.ts';
import { buildZip, skillMarkdown } from './helpers/zip.ts';

type UploadArgs = WorkspaceManagementToolArguments['upload_skills'];
type Envelope = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

const KEPT: SkillConfig[] = [
  { name: 'house-style', description: 'Write in the house style.', instructions: 'Use short sentences.', enabled: true },
  { name: 'triage', description: 'Sort incoming requests.', instructions: 'Label each request.', enabled: false },
];

const archive = Buffer.from(buildZip([
  { path: 'skills/alpha/SKILL.md', content: skillMarkdown('alpha', 'First skill.') },
  { path: 'skills/beta/SKILL.md', content: skillMarkdown('beta', 'Second skill.', '# Beta\nRun the helper.\n') },
  { path: 'skills/beta/scripts/run.py', content: 'print(1)\n' },
  { path: '__MACOSX/skills/alpha/._SKILL.md', content: '\u0000junk' },
  { path: 'NOTES.md', content: '# Notes\nNot a skill.\n' },
])).toString('base64');

function uploadFiles(): NonNullable<UploadArgs['files']> {
  return [
    { name: 'skills.zip', base64: archive },
    { name: 'SKILL.md', text: skillMarkdown('gamma', 'Third skill.') },
  ];
}

async function call(
  f: ManagementAdapterFixture,
  args: UploadArgs,
  context: ManagementActorContext = ownerMcpContext(f),
): Promise<Envelope> {
  return invokeWorkspaceManagementTool({ service: f.service, resolveContext: async () => context }, 'upload_skills', args);
}

async function upload(f: ManagementAdapterFixture, args: UploadArgs): Promise<UploadSkillsResult> {
  const response = await call(f, args);
  assert.equal(response.ok, true, JSON.stringify(response));
  return (response as { result: UploadSkillsResult }).result;
}

const names = (skills: Array<{ name: string }>) => skills.map(({ name }) => name);

test('upload_skills installs every skill in the files and keeps the Agent\'s other skills', () =>
  withManagementAdapterFixture('upload-add', async (f) => {
    const agent = await createFixtureAgent(f, 'agent_upload', { skills: KEPT });
    const result = await upload(f, { agentId: agent.id, files: uploadFiles(), idempotencyKey: 'upload-1' });

    assert.equal(result.status, 'updated');
    assert.deepEqual(names(result.added), ['alpha', 'beta', 'gamma']);
    assert.deepEqual([result.replaced, result.unchanged, result.conflicts], [[], [], []]);
    assert.deepEqual(result.issues.map(({ path, code }) => `${path} ${code}`), ['skills.zip/NOTES.md not_a_skill']);
    assert.deepEqual(result.added[1], {
      name: 'beta',
      path: 'skills.zip/skills/beta',
      omittedPaths: ['scripts/run.py'],
    });
    assert.equal(result.undoAvailable, true);
    assert.equal(result.links?.admin, 'http://localhost/admin/agents/agent_upload');
    assert.equal(result.instruction, undefined);
    assert.equal(result.presentation.markdown, [
      'Added 3 skills to Research: `alpha`, `beta`, `gamma`.',
      '`beta`: Only its instructions were installed; supporting files omitted: scripts/run.py.',
      'Left out skills.zip/NOTES.md: Not a skill. To upload a markdown file as a skill, give it a YAML header with a name and a description.',
      'The skills are active from the next message. You can undo this change.',
    ].join('\n'));

    const saved = await f.config.getAgent(agent.id);
    assert.deepEqual(saved.skills, [
      ...KEPT,
      { name: 'alpha', description: 'First skill.', instructions: '# Steps\nDo the work.\n', enabled: true },
      { name: 'beta', description: 'Second skill.', instructions: '# Beta\nRun the helper.\n', enabled: true },
      { name: 'gamma', description: 'Third skill.', instructions: '# Steps\nDo the work.\n', enabled: true },
    ]);
    assert.equal(saved.revision, agent.revision + 1);

    assert.ok(result.status === 'updated');
    const operation = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => ownerMcpContext(f),
    }, 'get_operation', { operationId: result.operationId });
    assert.equal(
      ((operation as { result: { operation: ManagementApplyResult } }).result.operation).status,
      'completed',
      'the change is on the durable operation record',
    );
  }));

test('identical skills are unchanged and different same-name skills wait for replaceExisting', () =>
  withManagementAdapterFixture('upload-conflict', async (f) => {
    const agent = await createFixtureAgent(f, 'agent_upload', { skills: KEPT });
    await upload(f, { agentId: agent.id, files: uploadFiles(), idempotencyKey: 'upload-1' });
    const installed = await f.config.getAgent(agent.id);

    const again = await upload(f, {
      agentId: agent.id,
      files: [...uploadFiles(), { name: 'triage.md', text: skillMarkdown('triage', KEPT[1]!.description, KEPT[1]!.instructions) }],
      idempotencyKey: 'upload-2',
    });
    assert.equal(again.status, 'unchanged');
    assert.equal(again.undoAvailable, false);
    assert.deepEqual(names(again.unchanged), ['alpha', 'beta', 'gamma', 'triage']);
    assert.match(again.presentation.markdown, /Still turned off: `triage`\. Turn it on in Admin to use it\./);
    assert.match(again.presentation.markdown, /No changes were made\.$/);
    assert.deepEqual(await f.config.getAgent(agent.id), installed, 'nothing was written, and triage stays disabled');

    const edited = [{ name: 'SKILL.md', text: skillMarkdown('alpha', 'First skill.', '# Steps\nDo the work twice.\n') }];
    const conflict = await upload(f, { agentId: agent.id, files: edited, idempotencyKey: 'upload-3' });
    assert.equal(conflict.status, 'unchanged');
    assert.deepEqual(names(conflict.conflicts), ['alpha']);
    assert.match(conflict.instruction ?? '', /^alpha already exists on the Agent with different content\. .*replaceExisting true/);
    assert.match(conflict.presentation.markdown, /^Left unchanged because Research already has a skill with the same name and different content: `alpha`\./);
    assert.deepEqual(await f.config.getAgent(agent.id), installed);

    const replaced = await upload(f, { agentId: agent.id, files: edited, replaceExisting: true, idempotencyKey: 'upload-4' });
    assert.equal(replaced.status, 'updated');
    assert.deepEqual(names(replaced.replaced), ['alpha']);
    const after = await f.config.getAgent(agent.id);
    assert.deepEqual(after.skills, installed.skills.map((skill) =>
      skill.name === 'alpha' ? { ...skill, instructions: '# Steps\nDo the work twice.\n' } : skill));
  }));

test('undo restores the skills from before the upload', () =>
  withManagementAdapterFixture('upload-undo', async (f) => {
    const agent = await createFixtureAgent(f, 'agent_upload', { skills: KEPT });
    const result = await upload(f, { agentId: agent.id, files: uploadFiles(), idempotencyKey: 'upload-1' });
    assert.ok(result.status === 'updated');
    const undone = await invokeWorkspaceManagementTool({
      service: f.service,
      resolveContext: async () => ownerMcpContext(f),
    }, 'undo_workspace_change', { operationId: result.operationId, idempotencyKey: 'undo-upload' });
    assert.equal((undone as { result: ManagementApplyResult }).result.status, 'completed', JSON.stringify(undone));
    assert.deepEqual((await f.config.getAgent(agent.id)).skills, KEPT);
  }));

test('a retry with the same key returns the first receipt without writing again', () =>
  withManagementAdapterFixture('upload-retry', async (f) => {
    const agent = await createFixtureAgent(f, 'agent_upload', { skills: KEPT });
    const args = { agentId: agent.id, files: uploadFiles(), idempotencyKey: 'upload-1' };
    const first = await upload(f, args);
    const written = await f.config.getAgent(agent.id);

    assert.deepEqual(await upload(f, args), first);
    assert.deepEqual(await f.config.getAgent(agent.id), written, 'the retry wrote nothing');

    const reused = await call(f, { ...args, files: [{ name: 'SKILL.md', text: skillMarkdown('delta', 'Fourth skill.') }] });
    assert.equal(reused.ok ? undefined : reused.error.code, 'idempotency_conflict');
    const sameNames = uploadFiles().map((file) => file.name === 'SKILL.md'
      ? { ...file, text: skillMarkdown('epsilon', 'Fifth skill, in the same file name.') }
      : file);
    const edited = await call(f, { ...args, files: sameNames });
    assert.equal(edited.ok ? undefined : edited.error.code, 'idempotency_conflict', 'the same names with other bytes are another upload');
    assert.deepEqual(await f.config.getAgent(agent.id), written);
  }));

test('upload_skills keeps edit authority, refuses bad input whole, and takes no file content in Slack', () =>
  withManagementAdapterFixture('upload-refusals', async (f) => {
    const agent = await createFixtureAgent(f, 'agent_upload', { skills: KEPT });
    const member = (await f.identity.provisionSlackMember({
      slackTeamId: f.owner.binding.slackTeamId,
      slackUserId: 'UUPLOADMEMBER',
      displayName: 'Upload Member',
    })).resolution!;
    const memberContext: ManagementActorContext = {
      userId: member.user.id,
      membershipId: member.membership.id,
      organizationId: member.membership.organizationId,
      origin: { kind: 'mcp', clientId: 'upload-member' },
    };
    const files = uploadFiles();
    const fullSkills = Array.from({ length: 100 }, (_, index) => ({ ...KEPT[0]!, name: `full-${index}` }));
    const full = await createFixtureAgent(f, 'agent_full', { skills: fullSkills });
    const refusals = [
      await call(f, { agentId: agent.id, files, idempotencyKey: 'member' }, memberContext),
      await call(f, { agentId: agent.id, files: [{ name: 'skills.zip', base64: '%%%' }], idempotencyKey: 'bad-base64' }),
      await call(f, {
        agentId: agent.id,
        files: Array.from({ length: 51 }, (_, index) => ({ name: `${index}.md`, text: '# Note' })),
        idempotencyKey: 'too-many',
      }),
      await call(f, { agentId: agent.id, files, idempotencyKey: 'slack' }, ownerSlackDmContext(f)),
      await call(f, { agentId: agent.id, files: [{ name: 'empty.md' }], idempotencyKey: 'neither' }),
      await call(f, { agentId: full.id, files: [{ name: 'SKILL.md', text: skillMarkdown('alpha', 'First skill.') }], idempotencyKey: 'over-cap' }),
    ];
    assert.deepEqual(refusals.map((response) => response.ok ? 'ok' : `${response.error.code}: ${response.error.message}`), [
      'forbidden: The Agent is not available to this member.',
      'invalid_request: skills.zip is not valid base64. No change was made.',
      'invalid_request: Upload up to 50 files at a time. No change was made.',
      'invalid_request: In Slack, upload_skills reads the files attached to the person\'s message and takes no file content or replaceExisting. No change was made.',
      'invalid_request: empty.md must carry text or base64, not both. No change was made.',
      `invalid_request: ${full.name} would have 101 skills; an Agent holds at most 100. Remove some first, or upload fewer. No change was made.`,
    ]);
    assert.deepEqual((await f.config.getAgent(agent.id)).skills, KEPT);
    assert.deepEqual((await f.config.getAgent(full.id)).skills, fullSkills);
  }));

test('the MCP door lists upload_skills and installs an archive sent as base64', () =>
  withManagementAdapterFixture('upload-mcp', async (f) => {
    const agent = await createFixtureAgent(f, 'agent_upload', { skills: KEPT });
    const handler = createMcpHandler(() => createWorkspaceManagementMcpServer({
      principal: {
        betterAuthUserId: f.owner.binding.betterAuthUserId!,
        userId: f.owner.user.id,
        membershipId: f.owner.membership.id,
        organizationId: f.owner.membership.organizationId,
        role: 'owner',
        clientId: 'upload-mcp',
      },
      service: f.service,
      baseUrl: 'http://localhost',
    }), { legacy: 'stateless' });

    const listed = await mcpCall(handler.fetch, 'tools/list', {}) as {
      tools: Array<{ name: string; inputSchema: { required?: string[] } }>;
    };
    const tool = listed.tools.find(({ name }) => name === 'upload_skills');
    assert.deepEqual(tool?.inputSchema.required?.toSorted(), ['agentId', 'files', 'idempotencyKey']);
    const item = (tool?.inputSchema as { properties: { files: { items: Record<string, unknown> } } }).properties.files.items;
    assert.equal(item.anyOf ?? item.oneOf, undefined, 'a file is one flat object, not a union clients must pick from');
    assert.deepEqual(item.required, ['name']);

    const called = await mcpCall(handler.fetch, 'tools/call', {
      name: 'upload_skills',
      arguments: { agentId: agent.id, files: [{ name: 'skills.zip', base64: archive }], idempotencyKey: 'mcp-upload' },
    }) as { structuredContent: { ok: boolean; result: UploadSkillsResult } };
    assert.equal(called.structuredContent.ok, true, JSON.stringify(called));
    assert.deepEqual(names(called.structuredContent.result.added), ['alpha', 'beta']);
    assert.deepEqual(names((await f.config.getAgent(agent.id)).skills), ['house-style', 'triage', 'alpha', 'beta']);

    const both = await mcpCall(handler.fetch, 'tools/call', {
      name: 'upload_skills',
      arguments: { agentId: agent.id, files: [{ name: 'SKILL.md', text: 'x', base64: 'eA==' }], idempotencyKey: 'mcp-both' },
    }) as { isError?: boolean; content: Array<{ text: string }> };
    assert.equal(both.isError, true, 'a file carries text or base64, not both');
    assert.match(both.content[0]!.text, /^Input validation error/);
  }));

async function mcpCall(
  fetch: (request: Request) => Promise<Response>,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
  }));
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const json = body.trimStart().startsWith('{')
    ? body
    : body.split('\n').find((line) => line.startsWith('data: '))!.slice('data: '.length);
  return (JSON.parse(json) as { result: unknown }).result;
}
