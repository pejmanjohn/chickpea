import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSlackInteractionAck, withSlackInteractionAck } from '../src/slack/interaction-ack.ts';
import { validateRequestForm } from '../src/slack/ui/presentation-tools.ts';
import { formFieldActionId, formFieldBlockId } from '../src/slack/ui/render-form.ts';
import { uiSurfaceId } from '../src/slack/ui/surface.ts';
import { withDirectSlackInstall } from './helpers/direct-slack-install.ts';

/**
 * A modal for an installation that no longer serves it has nothing to post
 * through: answered in the modal while its answer is Slack's, and closed
 * quietly once a host has acknowledged in its place.
 */
test('a modal its installation no longer serves closes quietly once a host holds its acknowledgement', async () => {
  await withDirectSlackInstall({}, async (install) => {
    const now = Date.now();
    const surfaceId = uiSurfaceId('msg:C1:1800000000.000100', 'form:1');
    await install.stores.slackState.executeUiSurface!({
      kind: 'put_surface',
      record: {
        id: surfaceId, namespace: 'ui', workspaceId: 'T1', channelId: 'C1',
        threadTs: '1800000000.000100', conversationThreadTs: '1800000000.000100', conversationKind: 'channel',
        agentId: 'agent_ops', turnJobId: 'msg:C1:1800000000.000100', requesterUserId: 'U1',
        spec: {
          kind: 'form',
          form: validateRequestForm({
            title: 'Support feedback',
            fields: [
              { key: 'experience', label: 'Overall experience', type: 'text', required: true },
              { key: 'email', label: 'Your email', type: 'email' },
            ],
          }),
        },
        status: 'open', messageTs: '1800000000.000200', createdAt: now, updatedAt: now, expiresAt: now + 60_000,
      },
    });
    // Signed for this install, but from another app than the one it serves.
    const submission = {
      type: 'view_submission', api_app_id: 'A2', team: { id: 'T1' }, user: { id: 'U1' },
      view: {
        id: 'V1', callback_id: 'chickpea.ui.v1.form', private_metadata: surfaceId,
        state: {
          values: {
            [formFieldBlockId(surfaceId, 0)]: { [formFieldActionId(0)]: { type: 'plain_text_input', value: 'Great' } },
          },
        },
      },
    };

    const direct = await install.deliver('interactions', submission);
    assert.deepEqual(await direct.json(), {
      response_action: 'errors',
      errors: { [formFieldBlockId(surfaceId, 0)]: 'This is no longer available. Reply in the thread instead.' },
    });

    const held = createSlackInteractionAck(new Request('https://host.example'));
    assert.equal(held.claim(), true);
    const late = await install.deliver('interactions', submission, withSlackInteractionAck({}, held));
    assert.deepEqual([late.status, await late.text()], [200, '']);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(install.calls, []);
    const card = await install.stores.slackState.executeUiSurface!({ kind: 'get_surface', id: surfaceId });
    assert.equal(card.kind === 'surface' ? card.surface?.status : undefined, 'open');
  });
});
