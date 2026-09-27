import assert from 'node:assert/strict';
import { test } from 'node:test';

import { gatewayUiReceipt } from '../src/slack/gateway/ui-receipt.ts';
import type { GatewayUiActionDelivery, GatewayViewSubmissionDelivery } from '../src/slack/gateway/protocol.ts';
import { checkSlackBlocks } from '../src/slack/ui/block-kit-limits.ts';
import { parseSlackUiViewSubmission, type SlackUiState } from '../src/slack/ui/interaction-payload.ts';
import { modalForClick, readViewSubmission } from '../src/slack/ui/modals.ts';
import { validateRequestForm, type RequestFormSpec } from '../src/slack/ui/presentation-tools.ts';
import {
  FORM_VIEW_CALLBACK_ID,
  formFieldActionId,
  formFieldBlockId,
  formLayout,
  formModalView,
  formTurnText,
  OTHER_ANSWER_VIEW_CALLBACK_ID,
  otherAnswerModalView,
  parseFormValues,
  readFormSubmission,
} from '../src/slack/ui/render-form.ts';
import { QUESTION_OTHER_CHOICE } from '../src/slack/ui/render-interactive.ts';
import { renderUiSurface, uiResponseTurnText } from '../src/slack/ui/render.ts';
import { uiActionId, uiBlockId, uiSurfaceId, uiValue, type UiSurfaceRecord } from '../src/slack/ui/surface.ts';

const NOW = Date.UTC(2026, 8, 26, 16, 0);
const CARD_TS = '1.000300';

function surface(spec: UiSurfaceRecord['spec'], patch: Partial<UiSurfaceRecord> = {}): UiSurfaceRecord {
  return {
    id: uiSurfaceId('msg:C1:1.000001', 'interactive'), namespace: 'ui', workspaceId: 'T1', channelId: 'C1',
    threadTs: '1.000001', conversationThreadTs: '1.000001', conversationKind: 'channel', agentId: 'agent_a',
    turnJobId: 'msg:C1:1.000001', requesterUserId: 'U1', spec, status: 'open', messageTs: CARD_TS,
    createdAt: NOW, updatedAt: NOW, expiresAt: NOW + 60_000, ...patch,
  };
}

const INLINE: RequestFormSpec = validateRequestForm({
  title: 'Offsite details',
  fields: [
    { key: 'city', label: 'City', type: 'choice', options: ['Lisbon', 'Porto'], required: true },
    { key: 'start', label: 'Start date', type: 'date', required: true },
    { key: 'host', label: 'Host', type: 'person' },
  ],
});

const MODAL: RequestFormSpec = validateRequestForm({
  title: 'New vendor',
  description: 'Everything finance needs to set them up.',
  answerFrom: 'thread',
  fields: [
    { key: 'name', label: 'Legal name', type: 'text', required: true },
    { key: 'email', label: 'Billing email', type: 'email', required: true },
    { key: 'site', label: 'Website', type: 'url' },
    { key: 'budget', label: 'Annual budget', type: 'number' },
    { key: 'notes', label: 'Notes', type: 'long_text' },
  ],
});

function form(spec: RequestFormSpec, patch: Partial<UiSurfaceRecord> = {}): UiSurfaceRecord {
  return surface({ kind: 'form', form: spec }, patch);
}

function field(record: UiSurfaceRecord, index: number, value: { type: string; value?: string | null; selected?: string[] }): SlackUiState {
  return { [formFieldBlockId(record.id, index)]: { [formFieldActionId(index)]: value } };
}

function click(record: UiSurfaceRecord, kind: string, patch: Partial<GatewayUiActionDelivery> = {}): GatewayUiActionDelivery {
  return {
    protocolVersion: 1, kind: 'interaction.ui_action', deliveryId: 'ui:1', bindingId: 'b1', workspaceId: 'T1',
    userId: 'U1', containerType: 'message', channelId: 'C1', messageTs: CARD_TS, threadTs: '1.000001',
    isEphemeral: false, viewId: null, actionId: uiActionId('ui', kind, 0), blockId: uiBlockId('ui', record.id, 20),
    actionType: 'button', value: uiValue(record.id, 0), selected: [], state: {}, actionTs: '2.000001',
    triggerId: 'trigger1', ...patch,
  };
}

function submission(record: UiSurfaceRecord, state: SlackUiState, patch: Partial<GatewayViewSubmissionDelivery> = {}): GatewayViewSubmissionDelivery {
  return {
    protocolVersion: 1, kind: 'interaction.view_submission', deliveryId: 'view:1', bindingId: 'b1',
    workspaceId: 'T1', userId: 'U1', viewId: 'V1', callbackId: FORM_VIEW_CALLBACK_ID,
    privateMetadata: record.id, state, triggerId: null, ...patch,
  };
}

test('up to three message-friendly fields render inline; anything else opens a modal', () => {
  assert.equal(formLayout(INLINE), 'inline');
  assert.equal(formLayout(MODAL), 'modal');
  assert.equal(formLayout(validateRequestForm({
    title: 'One', fields: [{ key: 'email', label: 'Email', type: 'email' }],
  })), 'modal', 'email inputs are modal-only');
  assert.equal(formLayout(validateRequestForm({
    title: 'Four', fields: ['a', 'b', 'c', 'd'].map((key) => ({ key, label: key, type: 'text' as const })),
  })), 'modal');

  const inline = renderUiSurface(form(INLINE));
  assert.deepEqual(inline.blocks.map((block) => block.type), ['section', 'input', 'input', 'input', 'actions', 'context']);
  assert.deepEqual(checkSlackBlocks(inline.blocks, { text: inline.text }).issues, []);
  assert.match(inline.text, /Offsite details: City, Start date, Host\. Use the form below, or reply in this thread\./);

  const card = renderUiSurface(form(MODAL));
  assert.deepEqual(card.blocks.map((block) => block.type), ['section', 'actions', 'context']);
  assert.match(JSON.stringify(card.blocks), /"action_id":"chickpea\.ui\.v1\.form_open\.0"/);
  assert.match(JSON.stringify(card.blocks), /Anyone in this thread can fill this in/);
  const view = formModalView(form(MODAL), MODAL);
  assert.equal(view.callback_id, FORM_VIEW_CALLBACK_ID);
  assert.equal(view.private_metadata, form(MODAL).id);
  const blocks = view.blocks as Array<Record<string, unknown>>;
  assert.deepEqual(checkSlackBlocks(blocks, { surface: 'modal' }).issues, []);
  // The same email field would be refused in a message.
  assert.ok(checkSlackBlocks(blocks, { surface: 'message' }).issues.some((issue) => /modal-only/.test(issue)));
});

test('property: seeded valid request_form specs compile within Slack limits in every state', () => {
  let state = 4242;
  const next = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const nasty = ['<!channel>', '<@U1>', '&', '<', '>', '*b*', '😀', 'Submit', '|', ' '];
  const word = (max: number) => {
    let out = '';
    while (out.length < 1 + Math.floor(next() * max)) out += nasty[Math.floor(next() * nasty.length)]!;
    return out.slice(0, max);
  };
  const types = ['text', 'long_text', 'number', 'email', 'url', 'date', 'time', 'datetime', 'choice', 'choices', 'person', 'people', 'channel'] as const;
  let compiled = 0;
  for (let run = 0; run < 400; run += 1) {
    let spec: RequestFormSpec;
    try {
      spec = validateRequestForm({
        title: `F${word(23)}`,
        ...(next() < 0.5 ? { description: word(300) } : {}),
        ...(next() < 0.5 ? { submitLabel: word(24) } : {}),
        fields: Array.from({ length: 1 + Math.floor(next() * 10) }, (_, index) => {
          const type = types[Math.floor(next() * types.length)]!;
          const optionCount = 2 + Math.floor(next() * 49);
          return {
            key: `f${index}`,
            label: `${index}${word(47)}`,
            type,
            ...(next() < 0.5 ? { required: true } : {}),
            ...(next() < 0.4 ? { placeholder: word(150) } : {}),
            ...(next() < 0.4 ? { hint: word(150) } : {}),
            ...(type === 'choice' || type === 'choices'
              ? { options: Array.from({ length: optionCount }, (_, option) => `${option}${word(70)}`) }
              : {}),
            ...(next() < 0.3 ? { initial: word(200) } : {}),
          };
        }),
      });
    } catch {
      continue;
    }
    compiled += 1;
    const values = Object.fromEntries(spec.fields.map((f) => [f.key, f.type === 'people' ? ['U1', 'U2'] : word(3_000)]));
    for (const status of ['open', 'resolved', 'superseded'] as const) {
      const record = form(spec, {
        status,
        ...(status === 'resolved' ? { resolution: { byUserId: 'U2', at: NOW, choice: 0, values: [JSON.stringify(values)] } } : {}),
      });
      const rendered = renderUiSurface(record);
      assert.deepEqual(checkSlackBlocks(rendered.blocks, { text: rendered.text }).issues, [], `run ${run} ${status}`);
      assert.doesNotMatch(rendered.text, /<!(?:channel|here|everyone)>/);
    }
    if (formLayout(spec) === 'modal') {
      const view = formModalView(form(spec), spec);
      assert.deepEqual(checkSlackBlocks(view.blocks as Array<Record<string, unknown>>, { surface: 'modal' }).issues, [], `run ${run} modal`);
      assert.ok(String((view.title as { text: string }).text).length <= 24);
      assert.ok(String((view.submit as { text: string }).text).length <= 24);
    }
  }
  assert.ok(compiled > 300, `only ${compiled} specs compiled`);
});

test('submissions are validated against the stored spec, never the payload', () => {
  const record = form(MODAL);
  const ok = readFormSubmission(record, MODAL, {
    ...field(record, 0, { type: 'plain_text_input', value: '  Acme Ltd ' }),
    ...field(record, 1, { type: 'email_text_input', value: 'ap@acme.test' }),
    ...field(record, 2, { type: 'url_text_input', value: 'https://acme.test/about' }),
    ...field(record, 3, { type: 'number_input', value: '12000.5' }),
  });
  assert.deepEqual(ok, { ok: true, values: { name: 'Acme Ltd', email: 'ap@acme.test', site: 'https://acme.test/about', budget: '12000.5' } });

  const bad = readFormSubmission(record, MODAL, {
    ...field(record, 1, { type: 'email_text_input', value: 'not an email' }),
    ...field(record, 2, { type: 'url_text_input', value: 'javascript:alert(1)' }),
    ...field(record, 3, { type: 'number_input', value: 'lots' }),
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(!bad.ok && bad.errors, {
    [formFieldBlockId(record.id, 0)]: 'This field is required.',
    [formFieldBlockId(record.id, 1)]: 'Enter an email address.',
    [formFieldBlockId(record.id, 2)]: 'Enter a full web address.',
    [formFieldBlockId(record.id, 3)]: 'Enter a number.',
  });

  const inline = form(INLINE);
  const other = uiSurfaceId('msg:C1:9.000001', 'interactive');
  const choices = readFormSubmission(inline, INLINE, {
    ...field(inline, 0, { type: 'static_select', selected: [uiValue(other, 0)] }),
    ...field(inline, 1, { type: 'datepicker', selected: ['2026-10-01'] }),
    ...field(inline, 2, { type: 'users_select', selected: ['<!channel>'] }),
  });
  assert.equal(choices.ok, false, 'an option from another surface and a non-id pick are refused');
  assert.deepEqual(Object.keys(!choices.ok ? choices.errors : {}).length, 2);
  const good = readFormSubmission(inline, INLINE, {
    ...field(inline, 0, { type: 'static_select', selected: [uiValue(inline.id, 1)] }),
    ...field(inline, 1, { type: 'datepicker', selected: ['2026-10-01'] }),
  });
  assert.deepEqual(good, { ok: true, values: { city: 'Porto', start: '2026-10-01' } });
});

test('a submission becomes host-authored turn text, escaped like a typed message', () => {
  const record = form(MODAL);
  const values = { name: 'Acme <!channel> & Co', email: 'ap@acme.test' };
  const text = formTurnText(record, MODAL, values, 'U2');
  assert.match(text, /^Submitted the form "New vendor" for <@U1> \(form [a-f0-9]{8}\):\n- Legal name: Acme &lt;!channel&gt; &amp; Co\n- Billing email: ap@acme.test\n- Website: \(blank\)/);
  assert.equal(uiResponseTurnText(record, { choice: 0, values: [JSON.stringify(values)] }, 'U2'), text);
  assert.deepEqual(parseFormValues(['not json']), {});

  const answered = renderUiSurface(form(MODAL, {
    status: 'resolved', resolution: { byUserId: 'U2', at: NOW, choice: 0, values: [JSON.stringify(values)] },
  }));
  const json = JSON.stringify(answered.blocks);
  assert.match(json, /Acme &lt;!channel&gt; &amp;amp; Co|Acme &lt;!channel&gt; &amp; Co/);
  assert.match(json, /:white_check_mark: Submitted by <@U2> for <@U1>/);
  assert.ok(!answered.blocks.some((block) => block.type === 'actions' || block.type === 'input'));
});

test('a Fill in click opens its modal only for someone who may answer an open form', () => {
  const record = form(MODAL, { requesterUserId: 'U1' });
  const view = modalForClick(click(record, 'form_open'), record, NOW);
  assert.equal(view?.callback_id, FORM_VIEW_CALLBACK_ID);
  assert.ok(modalForClick(click(record, 'form_open', { userId: 'U2' }), record, NOW), 'answerFrom thread lets others fill it in');

  const mine = form({ ...MODAL, answerFrom: 'requester' });
  assert.equal(modalForClick(click(mine, 'form_open', { userId: 'U2' }), mine, NOW), undefined);
  assert.equal(modalForClick(click(record, 'form_open'), form(MODAL, { status: 'resolved' }), NOW), undefined);
  assert.equal(modalForClick(click(record, 'form_open'), form(MODAL, { expiresAt: NOW - 1 }), NOW), undefined);
  assert.equal(modalForClick(click(record, 'form_open', { channelId: 'C2' }), record, NOW), undefined);
  assert.equal(modalForClick(click(record, 'form_open', { messageTs: '9.000001' }), record, NOW), undefined);
  assert.equal(modalForClick(click(record, 'form_open', { isEphemeral: true }), record, NOW), undefined);
  // An inline form has no modal, and a submit button is not a modal control.
  const inline = form(INLINE);
  assert.equal(modalForClick(click(inline, 'form_open'), inline, NOW), undefined);
  assert.equal(modalForClick(click(record, 'form_submit'), record, NOW), undefined);
});

test('modal submissions answer Slack with field errors; only a valid one goes on', () => {
  const record = form(MODAL);
  const invalid = readViewSubmission(submission(record, field(record, 1, { type: 'email_text_input', value: 'x' })), record, NOW);
  assert.deepEqual(invalid, {
    ok: false,
    responseAction: {
      response_action: 'errors',
      errors: {
        [formFieldBlockId(record.id, 0)]: 'This field is required.',
        [formFieldBlockId(record.id, 1)]: 'Enter an email address.',
      },
    },
  });
  const valid = readViewSubmission(submission(record, {
    ...field(record, 0, { type: 'plain_text_input', value: 'Acme' }),
    ...field(record, 1, { type: 'email_text_input', value: 'ap@acme.test' }),
  }), record, NOW);
  assert.ok(valid.ok);
  assert.deepEqual(valid.ok && parseFormValues(valid.answer.values), { name: 'Acme', email: 'ap@acme.test' });

  const answered = readViewSubmission(submission(record, {}), form(MODAL, { status: 'resolved' }), NOW);
  assert.deepEqual(answered, { ok: false, responseAction: {
    response_action: 'errors', errors: { [formFieldBlockId(record.id, 0)]: 'This was already answered. Close this window.' },
  } });
  assert.deepEqual(readViewSubmission(submission(record, {}, { privateMetadata: 'forged' }), record, NOW),
    { ok: false, responseAction: { response_action: 'clear' } });
  const forOthers = readViewSubmission(submission(record, {}, { userId: 'U2' }), form({ ...MODAL, answerFrom: 'requester' }), NOW);
  assert.match(JSON.stringify(forOthers), /Only the person it was meant for can answer this/);
  const wrongKind = readViewSubmission(submission(record, {}, { callbackId: OTHER_ANSWER_VIEW_CALLBACK_ID }), record, NOW);
  assert.equal(wrongKind.ok, false);
});

test('"Something else…" opens a one-field modal whose answer is the person\'s own words', () => {
  const question = surface({
    kind: 'question',
    question: { question: 'Which region?', options: [{ label: 'EU' }, { label: 'US' }], answerFrom: 'requester' },
  });
  const rendered = renderUiSurface(question);
  assert.match(JSON.stringify(rendered.blocks), /"action_id":"chickpea\.ui\.v1\.question_other\.0".*"text":"Something else…"/);
  assert.deepEqual(checkSlackBlocks(rendered.blocks, { text: rendered.text }).issues, []);
  const picker = renderUiSurface(surface({
    kind: 'question', question: { question: 'Who?', pick: 'person', answerFrom: 'requester' },
  }));
  assert.doesNotMatch(JSON.stringify(picker.blocks), /question_other/);

  const view = modalForClick(click(question, 'question_other', { blockId: uiBlockId('ui', question.id, 1) }), question, NOW);
  assert.deepEqual(view, otherAnswerModalView(question, 'Which region?'));
  assert.deepEqual(checkSlackBlocks((view!.blocks as Array<Record<string, unknown>>), { surface: 'modal' }).issues, []);

  const empty = readViewSubmission(submission(question, field(question, 0, { type: 'plain_text_input', value: '  ' }), {
    callbackId: OTHER_ANSWER_VIEW_CALLBACK_ID,
  }), question, NOW);
  assert.equal(empty.ok, false);
  const answered = readViewSubmission(submission(question, field(question, 0, {
    type: 'plain_text_input', value: 'APAC, <@UBOT> please',
  }), { callbackId: OTHER_ANSWER_VIEW_CALLBACK_ID }), question, NOW);
  assert.ok(answered.ok);
  assert.deepEqual(answered.ok && answered.answer, { choice: QUESTION_OTHER_CHOICE, values: ['APAC, <@UBOT> please'] });
  // Escaped the way Slack escapes typed text, so it can never mention anyone.
  assert.match(uiResponseTurnText(question, answered.ok ? answered.answer : { choice: 0 }, 'U1'),
    /in their own words: APAC, &lt;@UBOT&gt; please$/);
  const done = renderUiSurface(surface(question.spec, {
    status: 'resolved', resolution: { byUserId: 'U1', at: NOW, choice: QUESTION_OTHER_CHOICE, values: ['APAC <b>'] },
  }));
  assert.match(JSON.stringify(done.blocks), /“APAC &lt;b&gt;”, answered by <@U1>/);
});

test('gateway receipts: a modal click carries openView, bad submissions carry errors, the rest are admitted', () => {
  const record = form(MODAL);
  const opened = gatewayUiReceipt(click(record, 'form_open'), record, NOW);
  assert.equal(opened?.outcome, 'accepted');
  assert.equal(opened?.interaction.openView?.callback_id, FORM_VIEW_CALLBACK_ID);
  // A click whose modal cannot open is admitted, and admission explains it.
  assert.equal(gatewayUiReceipt(click(record, 'form_open'), form(MODAL, { status: 'resolved' }), NOW), undefined);
  assert.equal(gatewayUiReceipt(click(record, 'question', { blockId: uiBlockId('ui', record.id, 1) }), record, NOW), undefined);
  const errors = gatewayUiReceipt(submission(record, {}), record, NOW);
  assert.equal((errors?.interaction.responseAction as { response_action: string }).response_action, 'errors');
  assert.equal(gatewayUiReceipt(submission(record, {
    ...field(record, 0, { type: 'plain_text_input', value: 'Acme' }),
    ...field(record, 1, { type: 'email_text_input', value: 'ap@acme.test' }),
  }), record, NOW), undefined);
});

test('direct view_submission payloads normalize to the gateway shape', () => {
  const record = form(MODAL);
  const parsed = parseSlackUiViewSubmission({
    type: 'view_submission', team: { id: 'T1' }, user: { id: 'U1' }, trigger_id: 't.1',
    view: {
      id: 'V1', callback_id: FORM_VIEW_CALLBACK_ID, private_metadata: record.id,
      state: { values: {
        [formFieldBlockId(record.id, 0)]: { [formFieldActionId(0)]: { type: 'plain_text_input', value: 'Acme' } },
        [formFieldBlockId(record.id, 1)]: { [formFieldActionId(1)]: { type: 'email_text_input', value: 'ap@acme.test' } },
        other_block: { other: { type: 'plain_text_input', value: 'ignored' } },
      } },
    },
  });
  assert.deepEqual(parsed?.state, {
    [formFieldBlockId(record.id, 0)]: { [formFieldActionId(0)]: { type: 'plain_text_input', value: 'Acme' } },
    [formFieldBlockId(record.id, 1)]: { [formFieldActionId(1)]: { type: 'email_text_input', value: 'ap@acme.test' } },
  });
  assert.equal(parseSlackUiViewSubmission({ type: 'view_submission', team: { id: 'T1' }, user: { id: 'U1' },
    view: { id: 'V1', callback_id: 'someone_else', private_metadata: '' } }), undefined);
});
