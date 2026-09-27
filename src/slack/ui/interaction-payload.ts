/**
 * One normalized click, whether it arrived from Slack directly or through the
 * shared gateway (`interaction.ui_action`). Only controls in the host
 * namespaces are ever normalized; everything else stays with its own handler.
 */
export interface SlackUiAction {
  workspaceId: string;
  userId: string;
  containerType: 'message' | 'view';
  channelId: string | null;
  messageTs: string | null;
  threadTs: string | null;
  isEphemeral: boolean;
  viewId: string | null;
  actionId: string;
  blockId: string;
  actionType: string;
  value: string | null;
  selected: string[];
  state: SlackUiState;
  actionTs: string;
  triggerId: string;
}

/**
 * A submitted host modal (a request_form modal or a "Something else…"
 * answer), direct from Slack or through the gateway. `privateMetadata` names
 * the surface; the stored spec decides what the state means.
 */
export interface SlackUiViewSubmission {
  workspaceId: string;
  userId: string;
  viewId: string;
  callbackId: string;
  privateMetadata: string;
  state: SlackUiState;
  triggerId: string | null;
}

export type SlackUiState = Record<string, Record<string, SlackUiStateValue>>;

export interface SlackUiStateValue {
  type: string;
  value?: string | null;
  selected?: string[];
}

export const UI_ACTION_PREFIXES = ['chickpea.ui.v1.', 'chickpea.host.v1.'] as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACTION_TS = /^\d{1,16}\.\d{1,16}$/;
const MAX_ACTION_ID = 255;
const MAX_ACTION_TYPE = 64;
const MAX_VALUE = 2_000;
const MAX_SELECTED = 100;
const MAX_STATE_BYTES = 32 * 1024;

export function isHostUiActionId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ACTION_ID &&
    UI_ACTION_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined;
}

/** Selected values of one element, in Slack's per-type shapes. */
function selectedValues(element: Record<string, unknown>): string[] | undefined {
  const option = record(element.selected_option);
  const options = Array.isArray(element.selected_options) ? element.selected_options : undefined;
  const values: unknown[] = [];
  if (option) values.push(option.value);
  if (options) values.push(...options.map((entry) => record(entry)?.value));
  for (const key of ['selected_user', 'selected_conversation', 'selected_channel', 'selected_date', 'selected_time']) {
    if (element[key] !== undefined && element[key] !== null) values.push(element[key]);
  }
  if (element.selected_date_time !== undefined && element.selected_date_time !== null) {
    values.push(String(element.selected_date_time));
  }
  for (const key of ['selected_users', 'selected_conversations', 'selected_channels']) {
    if (Array.isArray(element[key])) values.push(...(element[key] as unknown[]));
  }
  if (values.length > MAX_SELECTED) return undefined;
  if (values.some((value) => typeof value !== 'string' || value.length > MAX_VALUE)) return undefined;
  return values as string[];
}

/**
 * Raw Slack `state.values` to the normalized shape the gateway also sends:
 * host blocks only, each element as `{type, value?, selected?}`. Bounds are
 * then checked once by `parseNormalizedUiState`.
 */
export function normalizeSlackUiState(value: unknown, maxBytes = MAX_STATE_BYTES): SlackUiState | undefined {
  const values = record(record(value)?.values) ?? record(value);
  if (!values) return {};
  const state: Record<string, Record<string, unknown>> = {};
  for (const [blockId, block] of Object.entries(values)) {
    if (!blockId.startsWith('chickpea.')) continue;
    const elements = record(block);
    if (!elements) return undefined;
    const normalizedBlock: Record<string, unknown> = {};
    for (const [actionId, raw] of Object.entries(elements)) {
      const element = record(raw);
      if (!element) return undefined;
      const selected = selectedValues(element);
      if (!selected) return undefined;
      normalizedBlock[actionId] = {
        type: element.type,
        ...(element.value === null || typeof element.value === 'string' ? { value: element.value } : {}),
        ...(selected.length ? { selected } : {}),
      };
    }
    state[blockId] = normalizedBlock;
  }
  return parseNormalizedUiState(state, { maxBytes });
}

/**
 * Validate state the gateway already normalized to `{type, value?, selected?}`.
 * Returns undefined for any malformed or oversized shape.
 */
export function parseNormalizedUiState(
  value: unknown,
  options: { hostBlocksOnly?: boolean; maxBytes?: number } = {},
): SlackUiState | undefined {
  const blocks = record(value);
  if (!blocks) return undefined;
  if (new TextEncoder().encode(JSON.stringify(blocks)).byteLength > (options.maxBytes ?? MAX_STATE_BYTES)) {
    return undefined;
  }
  const state: SlackUiState = {};
  for (const [blockId, block] of Object.entries(blocks)) {
    if (blockId.length > MAX_ACTION_ID) return undefined;
    if (options.hostBlocksOnly !== false && !blockId.startsWith('chickpea.')) return undefined;
    const elements = record(block);
    if (!elements) return undefined;
    const normalizedBlock: Record<string, SlackUiStateValue> = {};
    for (const [actionId, raw] of Object.entries(elements)) {
      const element = record(raw);
      if (!element || actionId.length > MAX_ACTION_ID) return undefined;
      if (Object.keys(element).some((key) => key !== 'type' && key !== 'value' && key !== 'selected')) {
        return undefined;
      }
      const type = boundedString(element.type, MAX_ACTION_TYPE);
      if (!type) return undefined;
      const text = element.value === undefined || element.value === null
        ? element.value
        : boundedString(element.value, 3_000);
      if (text === undefined && element.value !== undefined) return undefined;
      const selected = element.selected;
      if (selected !== undefined && (!Array.isArray(selected) || selected.length > MAX_SELECTED ||
          selected.some((entry) => typeof entry !== 'string' || entry.length > MAX_VALUE))) {
        return undefined;
      }
      normalizedBlock[actionId] = {
        type,
        ...(element.value !== undefined ? { value: text as string | null } : {}),
        ...(Array.isArray(selected) ? { selected: [...selected] as string[] } : {}),
      };
    }
    state[blockId] = normalizedBlock;
  }
  return state;
}

/**
 * Parse a verified direct `block_actions` payload. Parsing grants no
 * authority; it only returns clicks on host-namespace controls.
 */
export function parseSlackUiBlockAction(payload: unknown): SlackUiAction | undefined {
  const root = record(payload);
  if (root?.type !== 'block_actions' || !Array.isArray(root.actions) || root.actions.length !== 1) {
    return undefined;
  }
  const action = record(root.actions[0]);
  if (!action || !isHostUiActionId(action.action_id)) return undefined;
  const team = record(root.team);
  const user = record(root.user);
  const container = record(root.container);
  if (!safeId(team?.id) || !safeId(user?.id) || !container) return undefined;
  const containerType = container.type === 'view' ? 'view' : container.type === 'message' ? 'message' : undefined;
  if (!containerType) return undefined;
  const blockId = boundedString(action.block_id, MAX_ACTION_ID);
  const actionType = boundedString(action.type, MAX_ACTION_TYPE);
  const actionTs = typeof action.action_ts === 'string' && ACTION_TS.test(action.action_ts)
    ? action.action_ts
    : undefined;
  const triggerId = boundedString(root.trigger_id, 256);
  if (!blockId || !actionType || !actionTs || !triggerId) return undefined;
  const value = action.value === undefined || action.value === null
    ? null
    : boundedString(action.value, MAX_VALUE);
  if (value === undefined) return undefined;
  const selected = selectedValues(action);
  const state = normalizeSlackUiState(root.state);
  if (!selected || !state) return undefined;
  const channel = record(root.channel);
  const message = record(root.message);
  const view = record(root.view);
  const channelId = containerType === 'message' ? container.channel_id ?? channel?.id : null;
  const messageTs = containerType === 'message' ? container.message_ts : null;
  if (containerType === 'message' && (!safeId(channelId) || typeof messageTs !== 'string' ||
      !ACTION_TS.test(messageTs))) {
    return undefined;
  }
  const threadTs = typeof message?.thread_ts === 'string' && ACTION_TS.test(message.thread_ts)
    ? message.thread_ts
    : null;
  return {
    workspaceId: team.id,
    userId: user.id,
    containerType,
    channelId: (channelId as string | null) ?? null,
    messageTs: (messageTs as string | null) ?? null,
    threadTs,
    isEphemeral: container.is_ephemeral === true,
    viewId: containerType === 'view' && safeId(view?.id) ? view.id : null,
    actionId: action.action_id,
    blockId,
    actionType,
    value,
    selected,
    state,
    actionTs,
    triggerId,
  };
}

const MAX_VIEW_STATE_BYTES = 64 * 1024;

/** Parse a verified direct `view_submission` for a host modal. */
export function parseSlackUiViewSubmission(payload: unknown): SlackUiViewSubmission | undefined {
  const root = record(payload);
  if (root?.type !== 'view_submission') return undefined;
  const view = record(root.view);
  const team = record(root.team);
  const user = record(root.user);
  const callbackId = boundedString(view?.callback_id, MAX_ACTION_ID);
  const privateMetadata = boundedString(view?.private_metadata, 3_000);
  if (!view || !safeId(team?.id) || !safeId(user?.id) || !safeId(view.id) ||
      !callbackId?.startsWith('chickpea.ui.v1.') || privateMetadata === undefined) return undefined;
  const state = normalizeSlackUiState(view.state, MAX_VIEW_STATE_BYTES);
  if (!state) return undefined;
  return {
    workspaceId: team.id,
    userId: user.id,
    viewId: view.id,
    callbackId,
    privateMetadata,
    state,
    triggerId: boundedString(root.trigger_id, 256) ?? null,
  };
}

/** Slack session generations need a microsecond timestamp. */
export function microsecondSlackTs(value: string): string | undefined {
  const match = /^(\d{1,16})\.(\d{1,16})$/.exec(value);
  if (!match) return undefined;
  return `${match[1]}.${match[2]!.padEnd(6, '0').slice(0, 6)}`;
}
