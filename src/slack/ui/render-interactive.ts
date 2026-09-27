import type { SlackUiAction } from './interaction-payload.ts';
import type { AskUserSpec, OfferActionsSpec } from './presentation-tools.ts';
import {
  parseUiOptionValue,
  uiActionId,
  uiBlockId,
  uiValue,
  type ParsedUiControl,
  type UiSurfaceRecord,
} from './surface.ts';

/**
 * Host-owned widgets for model-chosen questions and next steps. The model says
 * what it needs (ask_user / offer_actions); the host picks buttons, a select,
 * checkboxes or a picker, applies the mobile rules, and writes the fallback
 * text that notifications and screen readers see.
 */

type Block = Record<string, unknown>;

export interface RenderedInteractive {
  text: string;
  blocks: Block[];
}

const SHORT_LABEL = 30;
const MAX_ROW_BUTTONS = 5;
const MAX_CHECKBOXES = 10;

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clamp(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function plain(text: string, max = 75) {
  return { type: 'plain_text', text: clamp(text, max), emoji: true };
}

function mrkdwn(text: string) {
  return { type: 'mrkdwn', text };
}

function slackTime(at: number): string {
  return `<!date^${Math.floor(at / 1000)}^{time}|${new Date(at).toISOString().slice(11, 16)} UTC>`;
}

// ── questions ─────────────────────────────────────────────────────────────

export type QuestionWidget =
  | 'buttons'
  | 'option_rows'
  | 'select'
  | 'checkboxes'
  | 'multi_select'
  | 'person'
  | 'people'
  | 'channel'
  | 'channels'
  | 'date';

/** The one widget-mapping decision, shared by render, click and tests. */
export function questionWidget(question: AskUserSpec): QuestionWidget {
  if (question.pick === 'person') return question.multiSelect ? 'people' : 'person';
  if (question.pick === 'channel') return question.multiSelect ? 'channels' : 'channel';
  if (question.pick === 'date') return 'date';
  const options = question.options ?? [];
  if (question.multiSelect) return options.length <= MAX_CHECKBOXES ? 'checkboxes' : 'multi_select';
  if (options.length > MAX_ROW_BUTTONS) return 'select';
  const compact = options.every((option) => !option.description && option.label.length <= SHORT_LABEL);
  return compact ? 'buttons' : 'option_rows';
}

function confirmFor(label: string) {
  return {
    title: plain('Are you sure?', 100),
    text: plain(`${clamp(label, 200)}. This can't be undone.`, 300),
    confirm: plain('Yes, continue', 30),
    deny: plain('Go back', 30),
    style: 'danger',
  };
}

function answerButton(record: UiSurfaceRecord, index: number, label: string, option: {
  recommended?: true;
  destructive?: true;
}): Block {
  return {
    type: 'button',
    action_id: uiActionId('ui', 'question', index),
    text: plain(label),
    value: uiValue(record.id, index),
    ...(option.destructive ? { style: 'danger', confirm: confirmFor(label) } : option.recommended ? { style: 'primary' } : {}),
  };
}

function questionHeader(record: UiSurfaceRecord, question: AskUserSpec): Block {
  return {
    type: 'section',
    block_id: uiBlockId('ui', record.id, 0),
    text: mrkdwn(`*${escape(question.question)}*`),
  };
}

function whoAnswers(record: UiSurfaceRecord, question: AskUserSpec): Block {
  const who = question.answerFrom === 'thread'
    ? 'Anyone in this thread can answer'
    : `Only <@${record.requesterUserId}> can answer`;
  return { type: 'context', elements: [mrkdwn(`${who} · or reply in this thread`)] };
}

function submitButton(record: UiSurfaceRecord): Block {
  return {
    type: 'button',
    action_id: uiActionId('ui', 'question_submit', 0),
    text: plain('Submit'),
    style: 'primary',
    value: uiValue(record.id, 0),
  };
}

function optionObject(record: UiSurfaceRecord, index: number, option: { label: string; description?: string }) {
  return {
    text: plain(option.label),
    value: uiValue(record.id, index),
    ...(option.description ? { description: plain(option.description) } : {}),
  };
}

function questionFallback(question: AskUserSpec): string {
  const options = question.options ?? [];
  if (options.length) {
    const listed = options.map((option, index) => `${index + 1}. ${escape(option.label)}`).join(' ');
    const how = question.multiSelect ? 'Reply with the numbers' : 'Reply with a number';
    return `${escape(question.question)} ${listed}. ${how}, or use the buttons.`;
  }
  const what = question.pick === 'person' ? 'a person' : question.pick === 'channel' ? 'a channel' : 'a date';
  return `${escape(question.question)} Pick ${what} below, or reply in this thread.`;
}

function renderOpenQuestion(record: UiSurfaceRecord, question: AskUserSpec, withHeader: boolean): RenderedInteractive {
  const widget = questionWidget(question);
  const options = question.options ?? [];
  const header = questionHeader(record, question);
  const blocks: Block[] = [];
  const controls = uiBlockId('ui', record.id, 1);
  switch (widget) {
    case 'buttons':
      if (withHeader) blocks.push(header);
      blocks.push({
        type: 'actions',
        block_id: controls,
        elements: options.map((option, index) => answerButton(record, index, option.label, option)),
      });
      break;
    case 'option_rows':
      if (withHeader) blocks.push(header);
      options.forEach((option, index) => {
        const description = option.description ? `\n${escape(option.description)}` : '';
        blocks.push({
          type: 'section',
          block_id: uiBlockId('ui', record.id, index + 1),
          text: mrkdwn(`*${index + 1}. ${escape(option.label)}*${description}`),
          accessory: answerButton(record, index, 'Choose', option),
        });
      });
      break;
    case 'select':
      blocks.push({
        ...header,
        ...(withHeader ? {} : { text: mrkdwn('Choose one:') }),
        accessory: {
          type: 'static_select',
          action_id: uiActionId('ui', 'question_select', 0),
          placeholder: plain('Choose an option', 150),
          options: options.map((option, index) => optionObject(record, index, option)),
        },
      });
      break;
    case 'checkboxes':
    case 'multi_select':
      if (withHeader) blocks.push(header);
      blocks.push({
        type: 'actions',
        block_id: controls,
        elements: [
          widget === 'checkboxes'
            ? {
                type: 'checkboxes',
                action_id: uiActionId('ui', 'question_multi', 0),
                options: options.map((option, index) => optionObject(record, index, option)),
              }
            : {
                type: 'multi_static_select',
                action_id: uiActionId('ui', 'question_multi', 0),
                placeholder: plain('Choose options', 150),
                options: options.map((option, index) => optionObject(record, index, option)),
              },
          submitButton(record),
        ],
      });
      break;
    case 'person':
    case 'channel':
      blocks.push({
        ...header,
        ...(withHeader ? {} : { text: mrkdwn(widget === 'person' ? 'Choose a person:' : 'Choose a channel:') }),
        accessory: widget === 'person'
          ? { type: 'users_select', action_id: uiActionId('ui', 'question_pick', 0), placeholder: plain('Choose a person', 150) }
          : {
              type: 'conversations_select',
              action_id: uiActionId('ui', 'question_pick', 0),
              placeholder: plain('Choose a channel', 150),
              filter: { include: ['public', 'private'], exclude_external_shared_channels: true, exclude_bot_users: true },
            },
      });
      break;
    case 'people':
    case 'channels':
    case 'date':
      if (withHeader) blocks.push(header);
      blocks.push({
        type: 'actions',
        block_id: controls,
        elements: [
          widget === 'people'
            ? { type: 'multi_users_select', action_id: uiActionId('ui', 'question_pick', 0), placeholder: plain('Choose people', 150) }
            : widget === 'channels'
            ? {
                type: 'multi_conversations_select',
                action_id: uiActionId('ui', 'question_pick', 0),
                placeholder: plain('Choose channels', 150),
                filter: { include: ['public', 'private'], exclude_external_shared_channels: true, exclude_bot_users: true },
              }
            : { type: 'datepicker', action_id: uiActionId('ui', 'question_pick', 0), placeholder: plain('Choose a date', 150) },
          submitButton(record),
        ],
      });
      break;
  }
  blocks.push(whoAnswers(record, question));
  return { text: questionFallback(question), blocks };
}

/** Display text for a resolved answer, from the stored spec and values only. */
export function questionAnswerLabel(question: AskUserSpec, values: readonly string[]): string {
  if (question.pick === 'person') return values.map((id) => `<@${id}>`).join(', ');
  if (question.pick === 'channel') return values.map((id) => `<#${id}>`).join(', ');
  if (question.pick === 'date') return values.join(', ');
  const options = question.options ?? [];
  return values.map((value) => options[Number(value)]?.label ?? '?').join(', ');
}

function renderQuestion(record: UiSurfaceRecord, question: AskUserSpec, withHeader: boolean): RenderedInteractive {
  if (record.status === 'open' || record.status === 'pending_delivery') {
    return renderOpenQuestion(record, question, withHeader);
  }
  const header = questionHeader(record, question);
  if (record.status === 'resolved' && record.resolution) {
    const { resolution } = record;
    const values = resolution.values ?? [String(resolution.choice)];
    const answer = questionAnswerLabel(question, values);
    const shown = question.pick ? answer : `*${escape(answer)}*`;
    const onBehalf = resolution.byUserId !== record.requesterUserId ? ` for <@${record.requesterUserId}>` : '';
    const via = resolution.typed ? ' (typed reply)' : '';
    return {
      text: `${escape(question.question)} Answered: ${question.pick ? answer : escape(answer)}.`,
      blocks: [header, {
        type: 'context',
        elements: [mrkdwn(`:white_check_mark: ${shown}, answered by <@${resolution.byUserId}>${onBehalf}${via} · ${slackTime(resolution.at)}`)],
      }],
    };
  }
  return {
    text: `${escape(question.question)} This question is closed.`,
    blocks: [header, { type: 'context', elements: [mrkdwn('This question is closed.')] }],
  };
}

// ── next-step actions ─────────────────────────────────────────────────────

function renderActions(record: UiSurfaceRecord, spec: OfferActionsSpec): RenderedInteractive {
  const links = spec.actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action.url);
  const linkButton = ({ action, index }: { action: OfferActionsSpec['actions'][number]; index: number }) => ({
    type: 'button',
    action_id: uiActionId('ui', 'link', index),
    text: plain(action.label),
    url: action.url,
    ...(action.recommended ? { style: 'primary' } : {}),
  });
  const labels = spec.actions.map((action) => escape(action.label)).join(' · ');
  if (record.status === 'open' || record.status === 'pending_delivery') {
    return {
      text: `Next steps: ${labels}`,
      blocks: [{
        type: 'actions',
        block_id: uiBlockId('ui', record.id, 1),
        elements: spec.actions.map((action, index) => action.url
          ? linkButton({ action, index })
          : {
              type: 'button',
              action_id: uiActionId('ui', 'actions', index),
              text: plain(action.label),
              value: uiValue(record.id, index),
              ...(action.recommended ? { style: 'primary' } : {}),
            }),
      }],
    };
  }
  const blocks: Block[] = [];
  let text = 'Next steps closed.';
  if (record.status === 'resolved' && record.resolution) {
    const chosen = spec.actions[record.resolution.choice];
    const label = chosen ? escape(chosen.label) : 'a next step';
    text = `${label}, requested by <@${record.resolution.byUserId}>.`;
    blocks.push({ type: 'context', elements: [mrkdwn(`:leftwards_arrow_with_hook: <@${record.resolution.byUserId}>: ${label}`)] });
  }
  // Link buttons stay usable after the requests close.
  if (links.length) {
    blocks.push({ type: 'actions', block_id: uiBlockId('ui', record.id, 2), elements: links.map(linkButton) });
  }
  if (!blocks.length) blocks.push({ type: 'context', elements: [mrkdwn('_Suggested next steps closed._')] });
  return { text, blocks };
}

export function renderInteractiveSurface(
  record: UiSurfaceRecord,
  options: { withHeader?: boolean } = {},
): RenderedInteractive | undefined {
  const spec = record.spec;
  if (spec.kind === 'question') return renderQuestion(record, spec.question, options.withHeader ?? true);
  if (spec.kind === 'actions') return renderActions(record, spec.actions);
  return undefined;
}

// ── clicks ────────────────────────────────────────────────────────────────

export interface InteractiveAnswer {
  choice: number;
  values?: string[];
}

const USER_ID = /^[UW][A-Z0-9]{2,30}$/;
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,30}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a click answers, read from the stored spec and the click's own
 * selections. `undefined` means the control is not an answer yet (a checkbox
 * toggled before Submit) or does not belong to this surface; neither consumes.
 */
export function interactiveAnswer(
  record: UiSurfaceRecord,
  control: ParsedUiControl,
  action: Pick<SlackUiAction, 'selected' | 'state' | 'value'>,
): InteractiveAnswer | undefined {
  const spec = record.spec;
  if (spec.kind === 'actions') {
    const index = control.valueIndex;
    if (control.kind !== 'actions' || index === undefined) return undefined;
    const chosen = spec.actions.actions[index];
    return chosen && !chosen.url ? { choice: index } : undefined;
  }
  if (spec.kind !== 'question') return undefined;
  const question = spec.question;
  const widget = questionWidget(question);
  const optionCount = question.options?.length ?? 0;
  const optionIndexes = (values: readonly string[]) => {
    const indexes = values.map((value) => parseUiOptionValue(record.id, value));
    return indexes.every((index) => index !== undefined && index < optionCount)
      ? [...new Set(indexes as number[])].sort((a, b) => a - b)
      : undefined;
  };
  const stateSelection = () => {
    const block = action.state[uiBlockId('ui', record.id, 1)] ?? action.state[uiBlockId('ui', record.id, 0)];
    const element = block?.[uiActionId('ui', widget === 'checkboxes' || widget === 'multi_select' ? 'question_multi' : 'question_pick', 0)];
    return element?.selected ?? [];
  };
  switch (widget) {
    case 'buttons':
    case 'option_rows': {
      const index = control.valueIndex;
      if (control.kind !== 'question' || index === undefined || index >= optionCount) return undefined;
      return { choice: index, values: [String(index)] };
    }
    case 'select': {
      if (control.kind !== 'question_select') return undefined;
      const indexes = optionIndexes(action.selected);
      return indexes?.length === 1 ? { choice: indexes[0]!, values: [String(indexes[0])] } : undefined;
    }
    case 'checkboxes':
    case 'multi_select': {
      if (control.kind !== 'question_submit') return undefined;
      const indexes = optionIndexes(stateSelection());
      return indexes?.length ? { choice: indexes[0]!, values: indexes.map(String) } : undefined;
    }
    case 'person':
    case 'channel': {
      if (control.kind !== 'question_pick') return undefined;
      const pattern = widget === 'person' ? USER_ID : CHANNEL_ID;
      return action.selected.length === 1 && pattern.test(action.selected[0]!)
        ? { choice: 0, values: [action.selected[0]!] }
        : undefined;
    }
    case 'people':
    case 'channels':
    case 'date': {
      if (control.kind !== 'question_submit') return undefined;
      const selected = stateSelection();
      const pattern = widget === 'people' ? USER_ID : widget === 'channels' ? CHANNEL_ID : DATE;
      if (!selected.length || selected.length > 25 || !selected.every((value) => pattern.test(value))) {
        return undefined;
      }
      return { choice: 0, values: widget === 'date' ? [selected[0]!] : [...new Set(selected)] };
    }
  }
}

/**
 * The host-authored turn a click becomes. It quotes the stored question and
 * labels, never text from the click payload, and names who answered.
 */
export function interactiveTurnText(record: UiSurfaceRecord, answer: InteractiveAnswer, byUserId: string): string {
  const spec = record.spec;
  const reference = `(${record.spec.kind} ${record.id.slice(0, 8)})`;
  if (spec.kind === 'actions') {
    const label = spec.actions.actions[answer.choice]?.label ?? 'a suggested next step';
    return `Pressed the suggested next step "${label}" under your previous reply ${reference}.`;
  }
  if (spec.kind !== 'question') return 'Answered with a button.';
  const question = spec.question;
  const values = answer.values ?? [String(answer.choice)];
  const answered = questionAnswerLabel(question, values);
  const forWhom = byUserId !== record.requesterUserId ? ` for <@${record.requesterUserId}>` : '';
  return `Answered your question "${question.question}"${forWhom} ${reference}: ${answered}`;
}
