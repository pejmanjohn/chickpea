import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentConnectionBinding, ConnectionAccountManagedPolicy } from '../src/config/types.ts';
import {
  MANAGED_CONNECTOR_CATALOG,
  intersectManagedResourceConstraints,
} from '../src/connections/catalog/index.ts';
import {
  pageRoots,
  parseNotionId,
  readAgentPageChoice,
  writeAgentPageChoice,
  type NotionId,
  type NotionListedPage,
} from '../src/connections/notion-pages.ts';
import { applyConnectionCapabilityCeiling } from '../src/connections/runtime.ts';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(4)}-${digit.repeat(12)}` as NotionId;
const [A, B, C, D, F] = ['a', 'b', 'c', 'd', 'f'].map(id) as [NotionId, NotionId, NotionId, NotionId, NotionId];
const listed = (page: NotionId, parent?: NotionId): NotionListedPage =>
  ({ id: page, kind: 'page', label: page.slice(0, 1), ...(parent ? { parent } : {}) });

test('parseNotionId accepts dashed, bare and notion.so URL ids, and nothing else', () => {
  const canonical = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
  for (const raw of [
    canonical,
    canonical.toUpperCase(),
    '1a2b3c4d5e6f4a1b8c2d3e4f5a6b7c8d',
    ` 1A2B3C4D5E6F4A1B8C2D3E4F5A6B7C8D `,
    'https://www.notion.so/acme/Launch-plan-1a2b3c4d5e6f4a1b8c2d3e4f5a6b7c8d',
    'https://notion.so/1a2b3c4d5e6f4a1b8c2d3e4f5a6b7c8d?v=0123456789abcdef0123456789abcdef',
    'https://acme.notion.so/Roadmap-1a2b3c4d5e6f4a1b8c2d3e4f5a6b7c8d#9f8e7d6c5b4a39281706f5e4d3c2b1a0',
  ]) assert.equal(parseNotionId(raw), canonical, raw);

  for (const raw of [
    undefined, 42, '', 'page_1', '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8', '1a2b3c4d5e6f4a1b8c2d3e4f5a6b7c8d0',
    '1a2b3c4d-5e6f4a1b-8c2d-3e4f5a6b7c8d', 'g'.repeat(32),
    'https://evil.example/1a2b3c4d5e6f4a1b8c2d3e4f5a6b7c8d',
    'https://notion.so.evil.example/1a2b3c4d5e6f4a1b8c2d3e4f5a6b7c8d',
    'https://www.notion.so/acme/Launchplan1a2b3c4d5e6f4a1b8c2d3e4f5a6b7c8d',
    'ftp://www.notion.so/1a2b3c4d5e6f4a1b8c2d3e4f5a6b7c8d',
    `${canonical}/children`,
  ]) assert.equal(parseNotionId(raw), undefined, String(raw));
});

test('a stored choice that does not parse narrows instead of widening', () => {
  assert.equal(readAgentPageChoice(undefined), undefined);
  assert.equal(readAgentPageChoice({}), undefined);
  assert.deepEqual(readAgentPageChoice({ notionPages: [A, 'B', B.toUpperCase()] }), [A]);
  assert.deepEqual(readAgentPageChoice({ notionPages: 'all' as never }), []);
  assert.deepEqual(writeAgentPageChoice({ other: ['x'], notionPages: [A] }, undefined), { other: ['x'] });
  assert.deepEqual(writeAgentPageChoice(undefined, [B, B, C]), { notionPages: [B, C] });
  assert.deepEqual(writeAgentPageChoice(undefined, []), { notionPages: [] });
  assert.throws(() => writeAgentPageChoice(undefined, Array.from({ length: 257 }, (_, index) =>
    `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000` as NotionId)), /at most 256/);
});

test('page roots are the listed pages no listed page contains, at most 256', () => {
  const listing = { pages: [listed(A), listed(B, A), listed(C, F), listed(D)], complete: true };
  assert.deepEqual(pageRoots(listing), { roots: [listed(A), listed(C, F), listed(D)], complete: true });
  const wide = Array.from({ length: 257 }, (_, index) =>
    listed(`${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000` as NotionId));
  const capped = pageRoots({ pages: wide, complete: true });
  assert.equal(capped.roots.length, 256);
  assert.equal(capped.complete, false, 'a list cut at 256 is not the whole list');
});

const NOTION_POLICY: ConnectionAccountManagedPolicy = {
  kind: 'managed',
  adapterId: 'composio',
  toolkit: 'notion',
  principalRef: 'chickpea:organization:org_1',
  accountRef: 'ca_notion',
  allowedCapabilities: ['notion.content.search', 'notion.pages.get'],
};

function binding(resourceConstraints?: AgentConnectionBinding['resourceConstraints']): AgentConnectionBinding {
  return {
    agentId: 'agent_1',
    connectionAccountId: 'connection_notion',
    providerId: 'notion',
    allowedCapabilities: ['notion.content.search', 'notion.pages.get'],
    ...(resourceConstraints ? { resourceConstraints } : {}),
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

test('the Notion page choice is a scope on the effective policy, never an argument resource', () => {
  const notion = MANAGED_CONNECTOR_CATALOG.connector('notion')!;
  assert.deepEqual(intersectManagedResourceConstraints(notion, undefined, { notionPages: [B] }), {});
  assert.equal(
    intersectManagedResourceConstraints(notion, { notionPages: [] }, undefined),
    undefined,
    'an account holds no page list of its own',
  );
  assert.equal(
    intersectManagedResourceConstraints(MANAGED_CONNECTOR_CATALOG.connector('gmail')!, undefined, { notionPages: [B] }),
    undefined,
    'a connector without a page scope still refuses the key',
  );
  assert.deepEqual(applyConnectionCapabilityCeiling(NOTION_POLICY, binding()), NOTION_POLICY, 'no choice, no scope');
  const limited = applyConnectionCapabilityCeiling(NOTION_POLICY, binding({ notionPages: [B, C] }));
  assert.equal(limited.kind === 'managed' && limited.resourceConstraints, undefined);
  assert.deepEqual(limited.kind === 'managed' && limited.pageScope, { allow: new Set([B, C]) });
  assert.deepEqual(
    applyConnectionCapabilityCeiling(NOTION_POLICY, binding({ notionPages: [] })),
    { ...NOTION_POLICY, pageScope: { allow: new Set() } },
    'an empty choice reaches nothing',
  );
  assert.deepEqual(
    applyConnectionCapabilityCeiling(NOTION_POLICY, binding({ notionPages: [A, 'not a page'] })),
    { ...NOTION_POLICY, pageScope: { allow: new Set([A]) } },
  );
});
