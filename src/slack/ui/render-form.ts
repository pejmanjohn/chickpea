import type { SlackUiState } from './interaction-payload.ts';
import type { FormFieldSpec, RequestFormSpec } from './presentation-tools.ts';
import {
  parseUiOptionValue,
  uiActionId,
  uiBlockId,
  uiValue,
  type UiSurfaceRecord,
} from './surface.ts';

/**
 * request_form, compiled by the host. Up to three message-friendly fields
 * render inline with a Submit button; anything else is a card whose "Fill in"
 * button opens a modal. Submissions are validated against the stored spec
 * only, and the answered card becomes a read-only summary.
 */

type Block = Record<string, unknown>;

export interface RenderedForm {
  text: string;
  blocks: Block[];
}

export const FORM_VIEW_CALLBACK_ID = 'chickpea.ui.v1.form';
export const OTHER_ANSWER_VIEW_CALLBACK_ID = 'chickpea.ui.v1.other';
const INLINE_FIELD_TYPES = new Set<FormFieldSpec['type']>([
  'text', 'choice', 'choices', 'date', 'time', 'datetime', 'person', 'people', 'channel',
]);
const MAX_INLINE_FIELDS = 3;
const SUBMIT_BLOCK = 20;

export type FormLayout = 'inline' | 'modal';

export function formLayout(form: RequestFormSpec): FormLayout {
  return form.fields.length <= MAX_INLINE_FIELDS && form.fields.every((field) => INLINE_FIELD_TYPES.has(field.type))
    ? 'inline'
    : 'modal';
}

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

export function formFieldBlockId(surfaceId: string, index: number): string {
  return uiBlockId('ui', surfaceId, index + 1);
}

export function formFieldActionId(index: number): string {
  return uiActionId('ui', 'field', index);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TEXT_VALUE = 3_000;
const MAX_SUMMARY = 2_900;
const TIME = /^\d{2}:\d{2}$/;

function fieldElement(surfaceId: string, field: FormFieldSpec, index: number): Block {
  const action_id = formFieldActionId(index);
  const placeholder = field.placeholder ? { placeholder: plain(field.placeholder, 150) } : {};
  const options = (field.options ?? []).map((label, optionIndex) => ({
    text: plain(label), value: uiValue(surfaceId, optionIndex),
  }));
  const initialOption = field.initial !== undefined ? options.find((option) => option.text.text === field.initial) : undefined;
  switch (field.type) {
    case 'text':
    case 'long_text':
      return {
        type: 'plain_text_input', action_id, ...placeholder, max_length: MAX_TEXT_VALUE,
        ...(field.type === 'long_text' ? { multiline: true } : {}),
        ...(field.initial ? { initial_value: field.initial.slice(0, 3_000) } : {}),
      };
    case 'number':
      return {
        type: 'number_input', action_id, is_decimal_allowed: true, ...placeholder,
        ...(field.initial && Number.isFinite(Number(field.initial)) ? { initial_value: field.initial } : {}),
      };
    case 'email':
      return { type: 'email_text_input', action_id, ...placeholder, ...(field.initial ? { initial_value: field.initial } : {}) };
    case 'url':
      return { type: 'url_text_input', action_id, ...placeholder, ...(field.initial ? { initial_value: field.initial } : {}) };
    case 'date':
      return { type: 'datepicker', action_id, ...placeholder, ...(field.initial && DATE.test(field.initial) ? { initial_date: field.initial } : {}) };
    case 'time':
      return { type: 'timepicker', action_id, ...placeholder, ...(field.initial && TIME.test(field.initial) ? { initial_time: field.initial } : {}) };
    case 'datetime':
      return { type: 'datetimepicker', action_id };
    case 'choice':
      return { type: 'static_select', action_id, ...placeholder, options, ...(initialOption ? { initial_option: initialOption } : {}) };
    case 'choices':
      return { type: 'multi_static_select', action_id, ...placeholder, options };
    case 'person':
      return { type: 'users_select', action_id, ...placeholder };
    case 'people':
      return { type: 'multi_users_select', action_id, ...placeholder };
    case 'channel':
      return {
        type: 'conversations_select', action_id, ...placeholder,
        filter: { include: ['public', 'private'], exclude_external_shared_channels: true, exclude_bot_users: true },
      };
  }
}

function inputBlocks(record: UiSurfaceRecord, form: RequestFormSpec): Block[] {
  return form.fields.map((field, index) => ({
    type: 'input',
    block_id: formFieldBlockId(record.id, index),
    label: plain(field.label, 2_000),
    optional: field.required !== true,
    ...(field.hint ? { hint: plain(field.hint, 2_000) } : {}),
    element: fieldElement(record.id, field, index),
  }));
}

function header(record: UiSurfaceRecord, form: RequestFormSpec): Block {
  const description = form.description ? `\n${escape(form.description)}` : '';
  return { type: 'section', block_id: uiBlockId('ui', record.id, 0), text: mrkdwn(`*${escape(form.title)}*${description}`) };
}

function whoAnswers(record: UiSurfaceRecord, form: RequestFormSpec): Block {
  const who = form.answerFrom === 'thread'
    ? 'Anyone in this thread can fill this in'
    : `Only <@${record.requesterUserId}> can fill this in`;
  return { type: 'context', elements: [mrkdwn(`${who} · or reply in this thread`)] };
}

function fallback(form: RequestFormSpec): string {
  return `${escape(form.title)}: ${form.fields.map((field) => escape(field.label)).join(', ')}. Use the form below, or reply in this thread.`;
}

/** The message card: inline inputs with Submit, or a Fill in button for the modal. */
export function renderForm(record: UiSurfaceRecord, form: RequestFormSpec): RenderedForm {
  if (record.status === 'resolved' && record.resolution) {
    const values = parseFormValues(record.resolution.values);
    const summary: string[] = [];
    let length = 0;
    for (const field of form.fields) {
      const line = `*${escape(clamp(field.label, 48))}*: ${formValueDisplay(field, values[field.key])}`;
      if (length + line.length + 1 > MAX_SUMMARY) break;
      summary.push(line);
      length += line.length + 1;
    }
    const onBehalf = record.resolution.byUserId !== record.requesterUserId ? ` for <@${record.requesterUserId}>` : '';
    return {
      text: `${escape(form.title)}: submitted by <@${record.resolution.byUserId}>.`,
      blocks: [
        header(record, form),
        ...(summary.length ? [{ type: 'section', text: mrkdwn(summary.join('\n')) }] : []),
        { type: 'context', elements: [mrkdwn(`:white_check_mark: Submitted by <@${record.resolution.byUserId}>${onBehalf} · ${slackTime(record.resolution.at)}`)] },
      ],
    };
  }
  if (record.status !== 'open' && record.status !== 'pending_delivery') {
    return {
      text: `${escape(form.title)}: this form is closed.`,
      blocks: [header(record, form), { type: 'context', elements: [mrkdwn('This form is closed.')] }],
    };
  }
  if (formLayout(form) === 'inline') {
    return {
      text: fallback(form),
      blocks: [
        header(record, form),
        ...inputBlocks(record, form),
        {
          type: 'actions',
          block_id: uiBlockId('ui', record.id, SUBMIT_BLOCK),
          elements: [{
            type: 'button', style: 'primary', action_id: uiActionId('ui', 'form_submit', 0),
            text: plain(form.submitLabel ?? 'Submit'), value: uiValue(record.id, 0),
          }],
        },
        whoAnswers(record, form),
      ],
    };
  }
  return {
    text: fallback(form),
    blocks: [
      header(record, form),
      {
        type: 'actions',
        block_id: uiBlockId('ui', record.id, SUBMIT_BLOCK),
        elements: [{
          type: 'button', style: 'primary', action_id: uiActionId('ui', 'form_open', 0),
          text: plain('Fill in'), value: uiValue(record.id, 0),
        }],
      },
      whoAnswers(record, form),
    ],
  };
}

/** The modal a Fill in click opens; everything in it comes from the stored spec. */
export function formModalView(record: UiSurfaceRecord, form: RequestFormSpec): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: FORM_VIEW_CALLBACK_ID,
    private_metadata: record.id,
    title: plain(form.title, 24),
    submit: plain(form.submitLabel ?? 'Submit', 24),
    close: plain('Cancel', 24),
    blocks: [
      ...(form.description ? [{ type: 'section', text: mrkdwn(escape(form.description)) }] : []),
      ...inputBlocks(record, form),
    ],
  };
}

/** A one-field modal for an answer the question's buttons don't offer. */
export function otherAnswerModalView(record: UiSurfaceRecord, question: string): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: OTHER_ANSWER_VIEW_CALLBACK_ID,
    private_metadata: record.id,
    title: plain('Your answer', 24),
    submit: plain('Send', 24),
    close: plain('Cancel', 24),
    blocks: [{
      type: 'input',
      block_id: formFieldBlockId(record.id, 0),
      label: plain(question, 2_000),
      element: { type: 'plain_text_input', action_id: formFieldActionId(0), multiline: true, max_length: MAX_OTHER_ANSWER },
    }],
  };
}

export type FormValues = Record<string, string | string[]>;

/** Longest free-text answer the "Something else…" modal takes. */
export const MAX_OTHER_ANSWER = 2_000;

const USER_ID = /^[UW][A-Z0-9]{2,30}$/;
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,30}$/;
const EMAIL = /^[^\s@<>|]+@[^\s@<>|]+\.[^\s@<>|]+$/;

function fieldState(state: SlackUiState, surfaceId: string, index: number) {
  return state[formFieldBlockId(surfaceId, index)]?.[formFieldActionId(index)];
}

/**
 * Validate a submission against the stored spec: required fields, types,
 * option membership and id shapes. Errors are keyed by the field's block id
 * (what a modal's `errors` response needs) and phrased for the person.
 */
export function readFormSubmission(
  record: UiSurfaceRecord,
  form: RequestFormSpec,
  state: SlackUiState,
): { ok: true; values: FormValues } | { ok: false; errors: Record<string, string> } {
  const values: FormValues = {};
  const errors: Record<string, string> = {};
  form.fields.forEach((field, index) => {
    const blockId = formFieldBlockId(record.id, index);
    const entry = fieldState(state, record.id, index);
    const text = typeof entry?.value === 'string' ? entry.value.trim() : '';
    const selected = entry?.selected ?? [];
    const missing = () => {
      if (field.required) errors[blockId] = 'This field is required.';
    };
    switch (field.type) {
      case 'text':
      case 'long_text':
        if (!text) return missing();
        if (text.length > MAX_TEXT_VALUE) errors[blockId] = 'Keep this to 3,000 characters.';
        else values[field.key] = text;
        return;
      case 'number':
        if (!text) return missing();
        if (!Number.isFinite(Number(text))) errors[blockId] = 'Enter a number.';
        else values[field.key] = text;
        return;
      case 'email':
        if (!text) return missing();
        if (!EMAIL.test(text)) errors[blockId] = 'Enter an email address.';
        else values[field.key] = text;
        return;
      case 'url':
        if (!text) return missing();
        try {
          const url = new URL(text);
          if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('scheme');
          values[field.key] = url.href;
        } catch {
          errors[blockId] = 'Enter a full web address.';
        }
        return;
      case 'date':
      case 'time':
      case 'datetime': {
        const value = selected[0] ?? '';
        if (!value) return missing();
        const pattern = field.type === 'date' ? DATE : field.type === 'time' ? TIME : /^\d{9,11}$/;
        if (!pattern.test(value)) errors[blockId] = 'Choose a valid value.';
        else values[field.key] = field.type === 'datetime' ? new Date(Number(value) * 1000).toISOString() : value;
        return;
      }
      case 'choice':
      case 'choices': {
        if (!selected.length) return missing();
        const labels = selected.map((value) => {
          const optionIndex = parseUiOptionValue(record.id, value);
          return optionIndex === undefined ? undefined : field.options?.[optionIndex];
        });
        if (labels.some((label) => label === undefined) || (field.type === 'choice' && labels.length !== 1)) {
          errors[blockId] = 'Choose from the list.';
        } else {
          values[field.key] = field.type === 'choice' ? labels[0]! : labels as string[];
        }
        return;
      }
      case 'person':
      case 'people':
      case 'channel': {
        if (!selected.length) return missing();
        const pattern = field.type === 'channel' ? CHANNEL_ID : USER_ID;
        if (!selected.every((value) => pattern.test(value)) || (field.type !== 'people' && selected.length !== 1)) {
          errors[blockId] = 'Choose from the list.';
        } else {
          values[field.key] = field.type === 'people' ? [...new Set(selected)] : selected[0]!;
        }
        return;
      }
    }
  });
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, values };
}

/** Inline forms cannot show field errors in place: one private notice lists them. */
export function formErrorsText(record: UiSurfaceRecord, form: RequestFormSpec, errors: Record<string, string>): string {
  const lines = form.fields.flatMap((field, index) => {
    const error = errors[formFieldBlockId(record.id, index)];
    return error ? [`• ${escape(clamp(field.label, 48))}: ${error}`] : [];
  });
  return `Not sent yet. Fix these, then press ${escape(clamp(form.submitLabel ?? 'Submit', 24))} again:\n${lines.join('\n')}`;
}

/** One stored value for the answered card: names render as mentions, never pings. */
export function formValueDisplay(field: FormFieldSpec, value: string | string[] | undefined): string {
  if (value === undefined || value.length === 0) return '_(blank)_';
  return fieldValueText(field, value, (text) => escape(clamp(text, 300)));
}

/** Ids render as mentions only when they are ids; everything else is escaped text. */
function fieldValueText(field: FormFieldSpec, value: string | string[], text: (value: string) => string): string {
  const list = Array.isArray(value) ? value : [value];
  if (field.type === 'person' || field.type === 'people') {
    return list.map((id) => USER_ID.test(id) ? `<@${id}>` : text(id)).join(', ');
  }
  if (field.type === 'channel') return list.map((id) => CHANNEL_ID.test(id) ? `<#${id}>` : text(id)).join(', ');
  return text(list.join(', '));
}

/** A submission travels and is stored as one JSON object in the answer's values. */
export function encodeFormValues(values: FormValues): string[] {
  return [JSON.stringify(values)];
}

export function parseFormValues(values: readonly string[] | undefined): FormValues {
  try {
    const parsed = values?.[0] ? JSON.parse(values[0]) as unknown : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as FormValues : {};
  } catch {
    return {};
  }
}

/** The host-authored turn a submission becomes; free text is the person's own input. */
export function formTurnText(record: UiSurfaceRecord, form: RequestFormSpec, values: FormValues, byUserId: string): string {
  const forWhom = byUserId !== record.requesterUserId ? ` for <@${record.requesterUserId}>` : '';
  const lines = form.fields.map((field) => {
    const value = values[field.key];
    const shown = value === undefined || value.length === 0 ? '(blank)' : fieldValueText(field, value, escape);
    return `- ${field.label}: ${shown}`;
  });
  return `Submitted the form "${form.title}"${forWhom} (form ${record.id.slice(0, 8)}):\n${lines.join('\n')}`;
}
