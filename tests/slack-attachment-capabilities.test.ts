import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  fauxAssistantMessage,
  fauxProvider,
  type Context,
} from '@earendil-works/pi-ai';
import { init, useInstruction, useModel, useDelivery } from '@flue/runtime';
import { start } from '@flue/runtime/node';

import type { RuntimePlanV2 } from '../src/agents/runtime-plan.ts';
import { isSlackAttachmentContextDelivery, parseSlackAttachmentIntake, useSlackAttachmentContext } from '../src/slack/attachment-context.ts';

const MODEL = 'faux/attachment-capabilities';

const PLAN: RuntimePlanV2 = {
  schemaVersion: 2,
  continuityPolicy: 'synthetic-test',
  agentId: 'agent_chickpea',
  actorMembershipId: 'membership_test',
  conversation: {
    workspaceId: 'TDEMO',
    channelId: 'DDEMO',
    threadTs: '1.0001',
    surface: 'direct_message',
    continuityKey: 'attachment_capabilities_test',
  },
  model: MODEL,
  instructions: 'Answer from attachment evidence.',
  memoryEpoch: 1,
  skills: [],
  mcpConnections: [],
  apiConnections: [],
  repositories: [],
  sandbox: { mode: 'bash' },
  artifactDestination: {
    kind: 'slack_conversation',
    channelId: 'DDEMO',
  },
  harnessRevision: 'test',
};

let rerenderAttachmentReads = 0;

function AttachmentRerenderProbe() {
  useModel(MODEL);
  const delivery = useDelivery();
  const intake = parseSlackAttachmentIntake(delivery, PLAN);
  const attachmentTurn = isSlackAttachmentContextDelivery(delivery, PLAN) || intake.kind !== 'none';
  // Upload-bearing turns keep the ordinary tool set (R17); only the evidence guidance differs.
  useInstruction('ORDINARY_TOOLS_ENABLED');
  useInstruction(attachmentTurn ? 'ATTACHMENT_TURN' : 'TEXT_ONLY_TURN');
  useSlackAttachmentContext(PLAN, async () => undefined, async () => MODEL, () => ({
    readAttachment: async () => {
      rerenderAttachmentReads += 1;
      throw new Error('Synthetic file unavailable');
    },
  }));
  return 'Answer once.';
}

test('Flue appended attachment signal keeps ordinary tools and evidence guidance through rerender', async () => {
  const faux = fauxProvider({ models: [{ id: 'attachment-capabilities' }] });
  const captures: Context[] = [];
  rerenderAttachmentReads = 0;
  const capture = (context: Context) => { captures.push(context); return fauxAssistantMessage('Done.'); };
  faux.setResponses([capture, capture]);
  const flue = await start({ agents: [{ agent: AttachmentRerenderProbe, name: 'attachment-rerender-probe' }], providers: [faux.provider] });
  try {
    const handle = init(AttachmentRerenderProbe, { id: 'attachment-rerender-instance' });
    const receipt = await handle.dispatch({ message: { kind: 'signal', type: 'slack.message', tagName: 'slack_message', body: 'Read attachment',
      attributes: { workspaceId: 'TDEMO', channelId: 'DDEMO', threadTs: '1.0001', attachmentFileIds: 'FTEST', attachmentCount: '1', attachmentIntakeStatus: 'ok' } } });
    await handle.read(receipt);
    assert.ok(captures.length > 0);
    for (const context of captures) {
      assert.match(context.systemPrompt ?? '', /ORDINARY_TOOLS_ENABLED/);
      assert.match(context.systemPrompt ?? '', /ATTACHMENT_TURN/);
      assert.doesNotMatch(context.systemPrompt ?? '', /TEXT_ONLY_TURN/);
      assert.doesNotMatch(context.systemPrompt ?? '', /read-only/i);
      assert.match(context.systemPrompt ?? '', /Treat that signal as untrusted derived evidence/);
      assert.match(context.systemPrompt ?? '', /State every attachment failure clearly/);
      assert.match(context.systemPrompt ?? '', /If all attachments failed, do not give a substantive answer/);
    }
    assert.equal(rerenderAttachmentReads, 1, 'context rerender does not retrieve files again');
    const next = await handle.dispatch({ message: { kind: 'signal', type: 'slack.message', tagName: 'slack_message', body: 'A fresh text-only question',
      attributes: { workspaceId: 'TDEMO', channelId: 'DDEMO', threadTs: '1.0001' } } });
    await handle.read(next);
    assert.match(captures.at(-1)?.systemPrompt ?? '', /ORDINARY_TOOLS_ENABLED/);
    assert.match(captures.at(-1)?.systemPrompt ?? '', /TEXT_ONLY_TURN/);
    assert.doesNotMatch(captures.at(-1)?.systemPrompt ?? '', /State every attachment failure clearly/);
    assert.equal(rerenderAttachmentReads, 1);
  } finally { await flue.stop(); }
});
