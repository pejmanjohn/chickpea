import assert from 'node:assert/strict';
import test from 'node:test';

import type { IdentityResolution } from '../src/identity/types.ts';
import type { ReadPublicDocResult } from '../src/management/public-doc.ts';
import {
  invokeSlackWorkspaceManagementTool,
  type SlackManagementSignal,
} from '../src/management/slack-tools.ts';
import type { WorkspaceManagementToolResult } from '../src/management/tool-adapter.ts';
import { createManagementAdapterFixture } from './helpers/management-adapter-fixture.ts';

const DOCS = 'https://docs.statusboard.example/api';

async function fixture(read: (url: URL) => Promise<ReadPublicDocResult>) {
  const f = await createManagementAdapterFixture('read-public-doc', { readPublicDoc: read });
  let turn = 0;
  /** One Slack message to the Agent, then read_public_doc with the links this turn already holds. */
  const slack = (
    url: string,
    requesterText: string | undefined,
    options: { turnLinks?: readonly string[]; by?: IdentityResolution; source?: 'click' } = {},
  ): Promise<WorkspaceManagementToolResult> => {
    turn += 1;
    const by = options.by ?? f.admin;
    const signal: SlackManagementSignal = {
      agentId: 'agent_scribe',
      workspaceId: f.admin.user.slackTeamId,
      channelId: 'D_SCRIBE',
      threadTs: '700.1',
      conversationKind: 'im',
      slackUserId: by.binding.slackUserId,
      eventId: `Ev_DOC_${turn}`,
      messageTs: `700.${turn + 1}`,
      turnJobId: `turn_DOC_${turn}`,
      ...(requesterText === undefined ? {} : { requesterText }),
      ...(options.source ? { requesterTextSource: options.source } : {}),
    };
    return invokeSlackWorkspaceManagementTool({
      signal,
      identity: f.identity,
      service: f.service,
      name: 'read_public_doc',
      args: { url, turnLinks: options.turnLinks ?? [] },
    });
  };
  return { f, slack };
}

function refusal(result: WorkspaceManagementToolResult): string {
  assert.equal(result.ok, false, 'the read was refused');
  return result.ok ? '' : result.error.message;
}

test('a URL the requester did not type is refused before anything is fetched', async () => {
  const reads: URL[] = [];
  const { f, slack } = await fixture(async (url) => {
    reads.push(url);
    throw new Error('nothing may be fetched');
  });
  try {
    assert.match(refusal(await slack(DOCS, 'connect @Scribe to Statusboard so it can read our incidents')),
      /only a URL the requester typed in their own current message/);
    assert.match(refusal(await slack(DOCS, `Approved: read ${DOCS}`, { source: 'click' })),
      /only a URL the requester typed/, 'a click quotes the surface, not a command the person typed');
    assert.match(refusal(await slack(DOCS, undefined)), /only a URL the requester typed/,
      'a turn another Agent\'s ask started has no requester message');
    assert.match(refusal(await slack(DOCS, `<@U00000001> docs at <${DOCS}>`)), /only a URL the requester typed/,
      'a message that mentions someone else is addressed to them');
    assert.match(refusal(await slack(`${DOCS}/admin`, `docs at <${DOCS}>`)), /only a URL the requester typed/,
      'a page under a typed URL is not itself typed');
    assert.deepEqual(reads, []);
  } finally {
    f.close();
  }
});
