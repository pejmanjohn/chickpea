/**
 * One Slack Block Kit limits checker for every payload the host builds with
 * components: postMessage, stopStream and chat.update alike. It returns the
 * problems it finds instead of throwing, so a caller can fall back to the
 * text-only reply rather than lose it. It checks the documented limits
 * (docs.slack.dev, read 2026-09-26) plus the host's own contracts: ids are
 * structural and never carry model text, and no text can broadcast.
 */

export type SlackBlockSurface = 'message' | 'modal';

const MAX_BLOCKS: Record<SlackBlockSurface, number> = { message: 50, modal: 100 };
const MAX_ID = 255;
const MAX_BUTTON_VALUE = 2_000;
const MAX_OPTION_VALUE = 150;
const MAX_ACTIONS_ELEMENTS = 25;
const MAX_CONTEXT_ELEMENTS = 10;
const MAX_SECTION_TEXT = 3_000;
const MAX_SECTION_FIELDS = 10;
const MAX_FIELD_TEXT = 2_000;
const MAX_HEADER_TEXT = 150;
const MAX_BUTTON_TEXT = 75;
const MAX_OPTION_TEXT = 75;
const MAX_OPTION_DESCRIPTION = 75;
const MAX_PLACEHOLDER = 150;
const MAX_STATIC_OPTIONS = 100;
const MAX_CHOICE_OPTIONS = 10;
const MAX_MARKDOWN_TOTAL = 12_000;
const MAX_CARD_BUTTONS = 3;
const MAX_CAROUSEL_CARDS = 10;
const MAX_CONTAINER_CHILDREN = 10;
const MAX_CHARTS_PER_MESSAGE = 2;
const MAX_INPUT_LABEL = 2_000;
const MAX_CONFIRM_TITLE = 100;
const MAX_CONFIRM_TEXT = 300;
const MAX_CONFIRM_BUTTON = 30;

/** Host-minted ids: namespace, version, then only structural tokens. */
export const HOST_ACTION_ID_PATTERN = /^chickpea\.(?:ui|host)\.v1\.[a-z_]{1,24}(?:\.\d{1,3})?$/;
export const HOST_BLOCK_ID_PATTERN = /^chickpea\.(?:ui|host)\.v1\.[a-f0-9]{32}\.\d{1,3}$/;
/** Button and option values alike: the surface id and a choice index. */
export const HOST_VALUE_PATTERN = /^[a-f0-9]{32}:\d{1,3}$/;

/** `<!channel>`, `<!here>`, `<!everyone>` and user-group pings, however written. */
const BROADCAST_PATTERN = /<!(?:channel|here|everyone|subteam\^)[^>]*>/i;

const MESSAGE_BLOCK_TYPES = new Set([
  'section', 'context', 'actions', 'divider', 'header', 'markdown', 'rich_text', 'image',
  'table', 'data_table', 'data_visualization', 'card', 'carousel', 'container', 'input',
  'context_actions', 'plan', 'task_card', 'file',
]);
const MODAL_ONLY_BLOCK_TYPES = new Set(['alert']);
const CONTAINER_CHILD_EXCLUDED = new Set(['markdown', 'container', 'carousel']);
const MODAL_ONLY_ELEMENTS = new Set(['number_input', 'email_text_input', 'url_text_input', 'file_input']);

type Json = Record<string, unknown>;

interface CheckContext {
  surface: SlackBlockSurface;
  issues: string[];
  actionIds: Set<string>;
  blockIds: Set<string>;
  markdownTotal: number;
  charts: number;
}

export interface SlackBlocksCheck {
  ok: boolean;
  issues: string[];
}

export function checkSlackBlocks(
  blocks: readonly unknown[],
  options: { surface?: SlackBlockSurface; text?: string } = {},
): SlackBlocksCheck {
  const context: CheckContext = {
    surface: options.surface ?? 'message',
    issues: [],
    actionIds: new Set(),
    blockIds: new Set(),
    markdownTotal: 0,
    charts: 0,
  };
  if (!Array.isArray(blocks)) return { ok: false, issues: ['blocks must be an array'] };
  if (blocks.length > MAX_BLOCKS[context.surface]) {
    context.issues.push(`${blocks.length} blocks exceed the ${context.surface} limit of ${MAX_BLOCKS[context.surface]}`);
  }
  if (options.text !== undefined) checkBroadcast(options.text, 'text', context);
  blocks.forEach((block, index) => checkBlock(block, `blocks[${index}]`, context, false));
  if (context.markdownTotal > MAX_MARKDOWN_TOTAL) {
    context.issues.push(`markdown blocks total ${context.markdownTotal} characters; the limit is ${MAX_MARKDOWN_TOTAL}`);
  }
  if (context.charts > MAX_CHARTS_PER_MESSAGE && context.surface === 'message') {
    context.issues.push(`${context.charts} charts exceed the per-message limit of ${MAX_CHARTS_PER_MESSAGE}`);
  }
  return { ok: context.issues.length === 0, issues: context.issues };
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkBlock(value: unknown, at: string, context: CheckContext, nested: boolean): void {
  if (!isRecord(value)) {
    context.issues.push(`${at} is not an object`);
    return;
  }
  const type = value.type;
  if (typeof type !== 'string') {
    context.issues.push(`${at}.type is missing`);
    return;
  }
  const allowed = MESSAGE_BLOCK_TYPES.has(type) ||
    (context.surface === 'modal' && MODAL_ONLY_BLOCK_TYPES.has(type));
  if (!allowed) context.issues.push(`${at} has unsupported block type ${type} for a ${context.surface}`);
  if (value.block_id !== undefined) checkBlockId(value.block_id, `${at}.block_id`, context);
  switch (type) {
    case 'section': return checkSection(value, at, context);
    case 'context': return checkContext(value, at, context);
    case 'actions': return checkActions(value, at, context);
    case 'header': return checkText(value.text, `${at}.text`, context, { max: MAX_HEADER_TEXT, kind: 'plain_text' });
    case 'markdown': {
      const text = value.text;
      if (typeof text !== 'string' || !text) {
        context.issues.push(`${at}.text must be a non-empty string`);
        return;
      }
      context.markdownTotal += text.length;
      checkBroadcast(text, `${at}.text`, context);
      return;
    }
    case 'divider': return;
    case 'image': return checkImageBlock(value, at, context);
    case 'input': return checkInput(value, at, context);
    case 'card': return checkCard(value, at, context);
    case 'carousel': return checkCarousel(value, at, context);
    case 'container': return checkContainer(value, at, context, nested);
    case 'data_visualization': return checkChart(value, at, context);
    case 'alert': return checkText(value.text, `${at}.text`, context, { max: MAX_SECTION_TEXT });
    default: return;
  }
}

function checkBlockId(value: unknown, at: string, context: CheckContext): void {
  if (typeof value !== 'string' || !value || value.length > MAX_ID) {
    context.issues.push(`${at} must be 1–${MAX_ID} characters`);
    return;
  }
  if (value.startsWith('chickpea.') && !HOST_BLOCK_ID_PATTERN.test(value)) {
    context.issues.push(`${at} is not a structural host block id`);
  }
  if (context.blockIds.has(value)) context.issues.push(`${at} duplicates block_id ${value}`);
  context.blockIds.add(value);
}

interface TextRule {
  max: number;
  kind?: 'plain_text' | 'mrkdwn';
  required?: boolean;
}

function checkText(value: unknown, at: string, context: CheckContext, rule: TextRule): void {
  if (value === undefined) {
    if (rule.required !== false) context.issues.push(`${at} is required`);
    return;
  }
  if (!isRecord(value)) {
    context.issues.push(`${at} must be a text object`);
    return;
  }
  if (value.type !== 'plain_text' && value.type !== 'mrkdwn') {
    context.issues.push(`${at}.type must be plain_text or mrkdwn`);
    return;
  }
  if (rule.kind && value.type !== rule.kind) {
    context.issues.push(`${at} must be ${rule.kind}`);
  }
  if (typeof value.text !== 'string' || value.text.length === 0) {
    context.issues.push(`${at}.text must be non-empty`);
    return;
  }
  if (value.text.length > rule.max) {
    context.issues.push(`${at}.text is ${value.text.length} characters; the limit is ${rule.max}`);
  }
  // plain_text is never parsed for mentions; only formatted text can ping.
  if (value.type === 'mrkdwn') checkBroadcast(value.text, `${at}.text`, context);
}

function checkBroadcast(text: string, at: string, context: CheckContext): void {
  if (BROADCAST_PATTERN.test(text)) context.issues.push(`${at} contains a broadcast mention`);
}

function checkSection(value: Json, at: string, context: CheckContext): void {
  const hasText = value.text !== undefined;
  const fields = value.fields;
  if (!hasText && !Array.isArray(fields)) context.issues.push(`${at} needs text or fields`);
  if (hasText) checkText(value.text, `${at}.text`, context, { max: MAX_SECTION_TEXT });
  if (fields !== undefined) {
    if (!Array.isArray(fields) || fields.length < 1 || fields.length > MAX_SECTION_FIELDS) {
      context.issues.push(`${at}.fields must hold 1–${MAX_SECTION_FIELDS} items`);
    } else {
      fields.forEach((field, index) => checkText(field, `${at}.fields[${index}]`, context, { max: MAX_FIELD_TEXT }));
    }
  }
  if (value.accessory !== undefined) checkElement(value.accessory, `${at}.accessory`, context, 'section');
}

function checkContext(value: Json, at: string, context: CheckContext): void {
  const elements = value.elements;
  if (!Array.isArray(elements) || elements.length < 1 || elements.length > MAX_CONTEXT_ELEMENTS) {
    context.issues.push(`${at}.elements must hold 1–${MAX_CONTEXT_ELEMENTS} items`);
    return;
  }
  elements.forEach((element, index) => {
    if (isRecord(element) && element.type === 'image') {
      checkImageElement(element, `${at}.elements[${index}]`, context);
    } else {
      checkText(element, `${at}.elements[${index}]`, context, { max: MAX_SECTION_TEXT });
    }
  });
}

function checkActions(value: Json, at: string, context: CheckContext): void {
  const elements = value.elements;
  if (!Array.isArray(elements) || elements.length < 1 || elements.length > MAX_ACTIONS_ELEMENTS) {
    context.issues.push(`${at}.elements must hold 1–${MAX_ACTIONS_ELEMENTS} items`);
    return;
  }
  elements.forEach((element, index) => checkElement(element, `${at}.elements[${index}]`, context, 'actions'));
}

function checkActionId(value: unknown, at: string, context: CheckContext): void {
  if (typeof value !== 'string' || !value || value.length > MAX_ID) {
    context.issues.push(`${at} must be 1–${MAX_ID} characters`);
    return;
  }
  if (!HOST_ACTION_ID_PATTERN.test(value)) context.issues.push(`${at} is not a structural host action id`);
  if (context.actionIds.has(value)) context.issues.push(`${at} duplicates action_id ${value}`);
  context.actionIds.add(value);
}

function checkElement(
  value: unknown,
  at: string,
  context: CheckContext,
  parent: 'actions' | 'section' | 'input' | 'card',
): void {
  if (!isRecord(value) || typeof value.type !== 'string') {
    context.issues.push(`${at} is not an element`);
    return;
  }
  const type = value.type;
  if (type === 'image') {
    if (parent !== 'section') context.issues.push(`${at} image elements belong in a section accessory`);
    checkImageElement(value, at, context);
    return;
  }
  if (MODAL_ONLY_ELEMENTS.has(type) && context.surface !== 'modal') {
    context.issues.push(`${at} ${type} is modal-only`);
  }
  // Only a link button may omit its action_id.
  if (type !== 'button' || value.url === undefined || value.action_id !== undefined) {
    checkActionId(value.action_id, `${at}.action_id`, context);
  }
  if (value.placeholder !== undefined) {
    checkText(value.placeholder, `${at}.placeholder`, context, { max: MAX_PLACEHOLDER, kind: 'plain_text' });
  }
  if (value.confirm !== undefined) checkConfirm(value.confirm, `${at}.confirm`, context);
  switch (type) {
    case 'button': {
      checkText(value.text, `${at}.text`, context, { max: MAX_BUTTON_TEXT, kind: 'plain_text' });
      if (value.style !== undefined && value.style !== 'primary' && value.style !== 'danger') {
        context.issues.push(`${at}.style must be primary or danger`);
      }
      if (value.url !== undefined) {
        if (typeof value.url !== 'string' || !/^https:\/\//.test(value.url) || value.url.length > 3_000) {
          context.issues.push(`${at}.url must be an https link of at most 3000 characters`);
        }
        if (value.value !== undefined) context.issues.push(`${at} a link button carries no value`);
      } else if (value.value !== undefined) {
        if (typeof value.value !== 'string' || value.value.length > MAX_BUTTON_VALUE) {
          context.issues.push(`${at}.value must be at most ${MAX_BUTTON_VALUE} characters`);
        } else if (!HOST_VALUE_PATTERN.test(value.value)) {
          context.issues.push(`${at}.value is not a structural host value`);
        }
      } else {
        context.issues.push(`${at} needs a host value or a url`);
      }
      return;
    }
    case 'static_select':
    case 'multi_static_select':
      return checkOptions(value.options, `${at}.options`, context, MAX_STATIC_OPTIONS);
    case 'checkboxes':
    case 'radio_buttons':
      return checkOptions(value.options, `${at}.options`, context, MAX_CHOICE_OPTIONS);
    case 'overflow':
      context.issues.push(`${at} overflow menus are excluded`);
      return;
    case 'external_select':
    case 'multi_external_select':
      context.issues.push(`${at} ${type} needs an options-load URL and is excluded`);
      return;
    case 'workflow_button':
      context.issues.push(`${at} workflow buttons are excluded`);
      return;
    default:
      return;
  }
}

function checkOptions(value: unknown, at: string, context: CheckContext, max: number): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    context.issues.push(`${at} must hold 1–${max} options`);
    return;
  }
  const seen = new Set<string>();
  value.forEach((option, index) => {
    const where = `${at}[${index}]`;
    if (!isRecord(option)) {
      context.issues.push(`${where} is not an option`);
      return;
    }
    checkText(option.text, `${where}.text`, context, { max: MAX_OPTION_TEXT });
    if (option.description !== undefined) {
      checkText(option.description, `${where}.description`, context, { max: MAX_OPTION_DESCRIPTION, kind: 'plain_text' });
    }
    if (typeof option.value !== 'string' || !option.value || option.value.length > MAX_OPTION_VALUE) {
      context.issues.push(`${where}.value must be 1–${MAX_OPTION_VALUE} characters`);
      return;
    }
    if (!HOST_VALUE_PATTERN.test(option.value)) {
      context.issues.push(`${where}.value is not a structural host value`);
    }
    if (seen.has(option.value)) context.issues.push(`${where}.value duplicates ${option.value}`);
    seen.add(option.value);
  });
}

function checkConfirm(value: unknown, at: string, context: CheckContext): void {
  if (!isRecord(value)) {
    context.issues.push(`${at} must be a confirmation object`);
    return;
  }
  checkText(value.title, `${at}.title`, context, { max: MAX_CONFIRM_TITLE, kind: 'plain_text' });
  checkText(value.text, `${at}.text`, context, { max: MAX_CONFIRM_TEXT });
  checkText(value.confirm, `${at}.confirm`, context, { max: MAX_CONFIRM_BUTTON, kind: 'plain_text' });
  checkText(value.deny, `${at}.deny`, context, { max: MAX_CONFIRM_BUTTON, kind: 'plain_text' });
}

function checkImageBlock(value: Json, at: string, context: CheckContext): void {
  checkImageElement(value, at, context);
  if (value.title !== undefined) checkText(value.title, `${at}.title`, context, { max: 2_000, kind: 'plain_text' });
}

function checkImageElement(value: Json, at: string, context: CheckContext): void {
  const hasUrl = typeof value.image_url === 'string';
  const hasFile = isRecord(value.slack_file);
  if (!hasUrl && !hasFile) context.issues.push(`${at} needs image_url or slack_file`);
  if (hasUrl && (!/^https:\/\//.test(value.image_url as string) || (value.image_url as string).length > 3_000)) {
    context.issues.push(`${at}.image_url must be an https link of at most 3000 characters`);
  }
  if (typeof value.alt_text !== 'string' || !value.alt_text || value.alt_text.length > 2_000) {
    context.issues.push(`${at}.alt_text must be 1–2000 characters`);
  }
}

function checkInput(value: Json, at: string, context: CheckContext): void {
  checkText(value.label, `${at}.label`, context, { max: MAX_INPUT_LABEL, kind: 'plain_text' });
  if (value.hint !== undefined) checkText(value.hint, `${at}.hint`, context, { max: MAX_INPUT_LABEL, kind: 'plain_text' });
  checkElement(value.element, `${at}.element`, context, 'input');
}

function checkCard(value: Json, at: string, context: CheckContext): void {
  const hasContent = value.title !== undefined || value.body !== undefined ||
    value.hero_image !== undefined || value.actions !== undefined;
  if (!hasContent) context.issues.push(`${at} needs a title, body, hero_image or actions`);
  if (value.title !== undefined) checkText(value.title, `${at}.title`, context, { max: 150 });
  if (value.subtitle !== undefined) checkText(value.subtitle, `${at}.subtitle`, context, { max: 150 });
  if (value.body !== undefined) checkText(value.body, `${at}.body`, context, { max: 200 });
  if (value.actions !== undefined) {
    if (!Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > MAX_CARD_BUTTONS) {
      context.issues.push(`${at}.actions must hold 1–${MAX_CARD_BUTTONS} buttons`);
    } else {
      value.actions.forEach((element, index) => {
        if (!isRecord(element) || element.type !== 'button') {
          context.issues.push(`${at}.actions[${index}] must be a button`);
          return;
        }
        checkElement(element, `${at}.actions[${index}]`, context, 'card');
      });
    }
  }
  if (value.hero_image !== undefined) {
    if (!isRecord(value.hero_image)) context.issues.push(`${at}.hero_image must be an image`);
    else checkImageElement(value.hero_image, `${at}.hero_image`, context);
  }
}

function checkCarousel(value: Json, at: string, context: CheckContext): void {
  const elements = value.elements;
  if (!Array.isArray(elements) || elements.length < 1 || elements.length > MAX_CAROUSEL_CARDS) {
    context.issues.push(`${at}.elements must hold 1–${MAX_CAROUSEL_CARDS} cards`);
    return;
  }
  elements.forEach((element, index) => {
    if (!isRecord(element) || element.type !== 'card') {
      context.issues.push(`${at}.elements[${index}] must be a card`);
      return;
    }
    checkCard(element, `${at}.elements[${index}]`, context);
  });
}

function checkContainer(value: Json, at: string, context: CheckContext, nested: boolean): void {
  if (nested) context.issues.push(`${at} containers cannot nest`);
  const children = value.elements ?? value.blocks;
  if (!Array.isArray(children) || children.length < 1 || children.length > MAX_CONTAINER_CHILDREN) {
    context.issues.push(`${at} must hold 1–${MAX_CONTAINER_CHILDREN} child blocks`);
    return;
  }
  if (value.title !== undefined) checkText(value.title, `${at}.title`, context, { max: 150, kind: 'plain_text' });
  children.forEach((child, index) => {
    if (isRecord(child) && typeof child.type === 'string' && CONTAINER_CHILD_EXCLUDED.has(child.type)) {
      context.issues.push(`${at} child ${index} cannot be a ${child.type} block`);
    }
    checkBlock(child, `${at}.children[${index}]`, context, true);
  });
}

function checkChart(value: Json, at: string, context: CheckContext): void {
  context.charts += 1;
  const chart = isRecord(value.chart) ? value.chart : value;
  const title = chart.title;
  if (typeof title !== 'string' || !title || title.length > 50) {
    context.issues.push(`${at} chart title must be 1–50 characters`);
  }
  const type = chart.chart_type ?? chart.type;
  if (!['bar', 'line', 'area', 'pie'].includes(String(type))) {
    context.issues.push(`${at} chart type must be bar, line, area or pie`);
  }
  const labels = chart.labels ?? chart.categories;
  if (!Array.isArray(labels) || labels.length < 1 || labels.length > 20) {
    context.issues.push(`${at} chart needs 1–20 labels`);
    return;
  }
  if (labels.some((label) => typeof label !== 'string' || !label || label.length > 20)) {
    context.issues.push(`${at} chart labels must be 1–20 characters`);
  }
  if (new Set(labels).size !== labels.length) context.issues.push(`${at} chart labels must be unique`);
  const series = chart.series ?? chart.datasets;
  if (!Array.isArray(series) || series.length < 1 || series.length > 12) {
    context.issues.push(`${at} chart needs 1–12 series`);
    return;
  }
  series.forEach((entry, index) => {
    if (!isRecord(entry)) {
      context.issues.push(`${at} series ${index} is not an object`);
      return;
    }
    const name = entry.name ?? entry.label;
    if (typeof name !== 'string' || !name || name.length > 20) {
      context.issues.push(`${at} series ${index} name must be 1–20 characters`);
    }
    const values = entry.values ?? entry.data;
    if (!Array.isArray(values) || values.length !== labels.length ||
        values.some((point) => typeof point !== 'number' || !Number.isFinite(point))) {
      context.issues.push(`${at} series ${index} needs one finite number per label`);
    } else if (type === 'pie' && values.some((point) => (point as number) <= 0)) {
      context.issues.push(`${at} pie values must be greater than 0`);
    }
  });
  if (type === 'pie' && series.length !== 1) context.issues.push(`${at} pie charts take one series`);
}
