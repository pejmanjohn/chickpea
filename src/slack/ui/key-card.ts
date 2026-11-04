import type { SavedKeyCheck } from '../../management/setup-wake.ts';
import type { SlackUiState } from './interaction-payload.ts';
import {
  KEY_FORM_CALLBACK_ID,
  uiActionId,
  uiBlockId,
  uiValue,
  type UiSurfaceRecord,
} from './surface.ts';
import { clampDisplay, escapeMrkdwn, mrkdwn, plain } from './text.ts';

export type KeySetupKind = 'api_credential' | 'mcp_credentials';
export type KeyWarning = Exclude<SavedKeyCheck, 'ok'>;

export type KeyRowState =
  | { is: 'waiting' }
  | { is: 'checking'; since: number }
  | { is: 'added' }
  | { is: 'added_warning'; check: KeyWarning }
  | { is: 'rejected' }
  /** Checked at the connection's bare prefix with no 2xx: not saved, and the Agent asks again with a read path. */
  | { is: 'unconfirmed' }
  | { is: 'expired' }
  | { is: 'superseded' };

export interface KeyRow {
  setupOperationId: string;
  connectionId: string;
  kind: KeySetupKind;
  label: string;
  destinations: string[];
  state: KeyRowState;
}

export interface KeyCardSpec {
  kind: 'key_card';
  agentName: string;
  rows: KeyRow[];
}

export type KeyUnsaved = 'rejected' | 'unconfirmed' | 'changed' | 'expired' | 'error';

export type KeyRowEvent =
  | { kind: 'check'; at: number }
  | { kind: 'saved'; check: SavedKeyCheck }
  | { kind: 'unsaved'; because: KeyUnsaved }
  | { kind: 'expired'; at: number }
  | { kind: 'superseded'; at: number };

const UNSAVED: Record<KeyUnsaved, KeyRowState> = {
  rejected: { is: 'rejected' },
  unconfirmed: { is: 'unconfirmed' },
  changed: { is: 'superseded' },
  expired: { is: 'expired' },
  error: { is: 'waiting' },
};

export const KEY_CHECK_STALE_MS = 2 * 60_000;
export const MAX_KEY_LENGTH = 3_000;
export const MAX_KEY_ROWS = 10;

export function keyRowFinal(state: KeyRowState): boolean {
  return state.is === 'added' || state.is === 'added_warning' || state.is === 'unconfirmed' ||
    state.is === 'expired' || state.is === 'superseded';
}

function checkingFresh(state: KeyRowState, at: number): boolean {
  return state.is === 'checking' && at - state.since < KEY_CHECK_STALE_MS;
}

export function keyRowTransition(state: KeyRowState, event: KeyRowEvent): KeyRowState | undefined {
  switch (event.kind) {
    case 'check':
      return state.is === 'waiting' || state.is === 'rejected' ||
          (state.is === 'checking' && !checkingFresh(state, event.at))
        ? { is: 'checking', since: event.at }
        : undefined;
    case 'saved':
      if (state.is !== 'checking') return undefined;
      return event.check === 'ok' ? { is: 'added' } : { is: 'added_warning', check: event.check };
    case 'unsaved':
      return state.is === 'checking' ? UNSAVED[event.because] : undefined;
    case 'expired':
    case 'superseded':
      return keyRowFinal(state) || checkingFresh(state, event.at) ? undefined : { is: event.kind };
  }
}

export function keyCardTransition(
  spec: KeyCardSpec,
  setupOperationId: string,
  event: KeyRowEvent,
): KeyCardSpec | undefined {
  const index = spec.rows.findIndex((row) => row.setupOperationId === setupOperationId);
  const row = spec.rows[index];
  const next = row ? keyRowTransition(row.state, event) : undefined;
  if (!row || !next) return undefined;
  return { ...spec, rows: spec.rows.map((candidate, at) => at === index ? { ...row, state: next } : candidate) };
}

export function keyCardFinal(spec: KeyCardSpec): boolean {
  return spec.rows.every((row) => keyRowFinal(row.state));
}

export function isKeyCard(record: UiSurfaceRecord | undefined): record is UiSurfaceRecord & { spec: KeyCardSpec } {
  return record?.namespace === 'host' && record.spec.kind === 'key_card';
}

export function keyHost(row: Pick<KeyRow, 'destinations'>): string {
  try {
    return new URL(row.destinations[0] ?? '').host || 'the service';
  } catch {
    return 'the service';
  }
}

const WARNING: Record<KeyWarning, string> = {
  not_permitted: 'The service turned down Chickpea\'s check, so the key may be missing a permission',
  path_not_found: 'Chickpea\'s check hit an address the service doesn\'t serve, which says nothing about the key',
  unreachable: 'Chickpea couldn\'t reach the service to check it',
  inconclusive: 'Chickpea couldn\'t confirm the key with its check',
};

type Block = Record<string, unknown>;

export interface RenderedKeyCard {
  text: string;
  blocks: Block[];
}

function name(row: KeyRow): string {
  return escapeMrkdwn(clampDisplay(row.label, 100));
}

function label(row: KeyRow): string {
  return `*${name(row)}*`;
}

function agent(spec: KeyCardSpec): string {
  return escapeMrkdwn(clampDisplay(spec.agentName, 80));
}

function needs(row: KeyRow): string {
  return row.kind === 'mcp_credentials' ? 'needs an access token' : 'needs an API key';
}

/** The card's blocks mark up names and outcomes; its message text, which notifications and search read, does not. */
interface LineStyle {
  label(row: KeyRow): string;
  icon(emoji: string): string;
}

const IN_BLOCKS: LineStyle = { label, icon: (emoji) => `${emoji} ` };
const IN_TEXT: LineStyle = { label: name, icon: () => '' };

function statusLine(spec: KeyCardSpec, row: KeyRow, requester: string, style = IN_BLOCKS): string | undefined {
  const host = escapeMrkdwn(keyHost(row));
  switch (row.state.is) {
    case 'waiting':
      return undefined;
    case 'checking':
      return `Checking the key with ${host}…`;
    case 'added':
      return `${style.icon(':white_check_mark:')}${requester} added the ${style.label(row)} key.`;
    case 'added_warning':
      return `${style.icon(':white_check_mark:')}${requester} added the ${style.label(row)} key. ${WARNING[row.state.check]}.`;
    case 'rejected':
      return `${style.icon(':x:')}${host} rejected that key, so it wasn't saved.`;
    case 'unconfirmed':
      return `${host} didn't confirm that key, so it wasn't saved.`;
    case 'expired':
      return `This key request expired. Ask ${agent(spec)} for a new one.`;
    case 'superseded':
      return `The connection changed after this was posted. Ask ${agent(spec)} for a new one.`;
  }
}

/**
 * A checking row keeps Try again: while the check runs a click only says so
 * privately, and a check that never finished leaves the row open again.
 */
function rowButton(record: UiSurfaceRecord, row: KeyRow, index: number): Block | undefined {
  if (keyRowFinal(row.state)) return undefined;
  const text = row.state.is === 'waiting' ? 'Add key' : 'Try again';
  return {
    type: 'button',
    action_id: uiActionId('host', 'key_add', index),
    text: plain(text, 75),
    ...(row.state.is === 'waiting' ? { style: 'primary' } : {}),
    value: uiValue(record.id, index),
  };
}

function finalLine(spec: KeyCardSpec, row: KeyRow, requester: string, many: boolean, style = IN_BLOCKS): string {
  const line = statusLine(spec, row, requester, style)!;
  return many && (row.state.is === 'unconfirmed' || row.state.is === 'expired' || row.state.is === 'superseded')
    ? `${style.label(row)}: ${line}`
    : line;
}

/** The card as one plain message text, kept current with every redraw. */
function cardText(spec: KeyCardSpec, requester: string): string {
  const many = spec.rows.length > 1;
  if (keyCardFinal(spec)) return spec.rows.map((row) => finalLine(spec, row, requester, many, IN_TEXT)).join('\n');
  if (many) return `${spec.rows.length} connections need a key.`;
  const row = spec.rows[0]!;
  const line = statusLine(spec, row, requester, IN_TEXT);
  return `${name(row)} ${needs(row)}.${line ? ` ${line}` : ''}`;
}

export function renderKeyCard(record: UiSurfaceRecord, spec: KeyCardSpec): RenderedKeyCard {
  const requester = `<@${record.requesterUserId}>`;
  const many = spec.rows.length > 1;
  const text = cardText(spec, requester);
  if (keyCardFinal(spec)) {
    const lines = spec.rows.map((row) => finalLine(spec, row, requester, many)).join('\n');
    return {
      text,
      blocks: [{ type: 'section', block_id: uiBlockId('host', record.id, 0), text: mrkdwn(lines) }],
    };
  }
  if (!many) {
    const row = spec.rows[0]!;
    const line = statusLine(spec, row, requester);
    const button = rowButton(record, row, 0);
    return {
      text,
      blocks: [
        { type: 'section', block_id: uiBlockId('host', record.id, 0), text: mrkdwn(`:key: ${label(row)} ${needs(row)}`) },
        ...(line ? [{ type: 'context', elements: [mrkdwn(line)] }] : []),
        ...(button ? [{ type: 'actions', block_id: uiBlockId('host', record.id, 1), elements: [button] }] : []),
        { type: 'context', elements: [mrkdwn(`Only ${requester} can add it.`)] },
      ],
    };
  }
  return {
    text,
    blocks: [
      {
        type: 'section',
        block_id: uiBlockId('host', record.id, 0),
        text: mrkdwn(`:key: *${spec.rows.length} connections need a key*`),
      },
      ...spec.rows.map((row, index) => {
        const line = statusLine(spec, row, requester);
        const button = rowButton(record, row, index);
        const rowText = keyRowFinal(row.state) ? finalLine(spec, row, requester, true)
          : line ? `${label(row)}\n${line}` : label(row);
        return {
          type: 'section',
          block_id: uiBlockId('host', record.id, index + 1),
          text: mrkdwn(rowText),
          ...(button ? { accessory: button } : {}),
        };
      }),
      { type: 'context', elements: [mrkdwn(`Only ${requester} can add them.`)] },
    ],
  };
}

export interface KeySetupFacts {
  setup?: {
    status: string;
    expiresAt: number;
    credentialBinding?: string;
  };
  target?: KeyTarget;
}

export interface KeyTarget {
  binding: string;
  valuePrefix: string;
  ownerKind: 'team' | 'member';
  destinations: string[];
}

export type KeyRowRefusal = 'unavailable' | 'wrong_user' | 'busy' | 'done' | 'expired' | 'superseded';

export type KeyRowAvailability =
  | { ok: true; row: KeyRow; target: KeyTarget }
  | { ok: false; refusal: KeyRowRefusal; row?: KeyRow };

export function keyRowAvailability(input: {
  card: UiSurfaceRecord | undefined;
  workspaceId: string;
  userId: string;
  setupOperationId: string;
  facts: KeySetupFacts;
  now: number;
}): KeyRowAvailability {
  const { card, facts, now } = input;
  if (!isKeyCard(card) || card.workspaceId !== input.workspaceId) return { ok: false, refusal: 'unavailable' };
  const row = card.spec.rows.find((candidate) => candidate.setupOperationId === input.setupOperationId);
  if (!row) return { ok: false, refusal: 'unavailable' };
  if (input.userId !== card.requesterUserId) return { ok: false, refusal: 'wrong_user', row };
  if (row.state.is === 'expired' || row.state.is === 'superseded') return { ok: false, refusal: row.state.is, row };
  if (row.state.is === 'unconfirmed') return { ok: false, refusal: 'unavailable', row };
  if (keyRowFinal(row.state)) return { ok: false, refusal: 'done', row };
  if (checkingFresh(row.state, now)) return { ok: false, refusal: 'busy', row };
  const { setup, target } = facts;
  if (!setup || setup.status !== 'pending' || setup.expiresAt <= now) return { ok: false, refusal: 'expired', row };
  if (!target || !setup.credentialBinding || target.binding !== setup.credentialBinding) {
    return { ok: false, refusal: 'superseded', row };
  }
  return { ok: true, row, target };
}

export function keyRefusalNotice(card: UiSurfaceRecord & { spec: KeyCardSpec }, refusal: KeyRowRefusal): string {
  const who = `<@${card.requesterUserId}>`;
  const name = agent(card.spec);
  switch (refusal) {
    case 'wrong_user':
      return `Only ${who} can add this key.`;
    case 'expired':
      return `This key request expired. Ask ${name} for a new one.`;
    case 'superseded':
      return `The connection changed after this was posted. Ask ${name} for a new one.`;
    case 'busy':
      return 'Chickpea is already checking a key for this.';
    case 'done':
      return 'This key was already added.';
    case 'unavailable':
      return 'This button isn\'t available right now. Reply in the thread instead.';
  }
}

/** A form answer checked after Slack had closed the form: what its field would have said. */
export function keyInvalidNotice(problem: string): string {
  return `That key wasn't saved. ${escapeMrkdwn(problem)}`;
}

export function keyNotSavedNotice(card: UiSurfaceRecord & { spec: KeyCardSpec }): string {
  return `That key wasn't saved. Try again, or ask ${agent(card.spec)} for help.`;
}

/** The setup's notice, which the thread shows if the Agent's wake fails before it replies. */
export function keyUnsavedNotice(row: KeyRow, finding: 'rejected' | 'unconfirmed'): string {
  const host = escapeMrkdwn(keyHost(row));
  return finding === 'rejected'
    ? `${host} rejected the key for ${name(row)}, so it wasn't saved.`
    : `${host} didn't confirm the key for ${name(row)}, so it wasn't saved.`;
}

export interface KeyFormMetadata {
  cardId: string;
  setupOperationId: string;
  binding: string;
}

const METADATA = /^([a-f0-9]{32})\|(setup_[A-Za-z0-9_-]{1,128})\|(v\d{1,3}:[A-Za-z0-9_-]{1,128})$/;

export function encodeKeyFormMetadata(metadata: KeyFormMetadata): string {
  return `${metadata.cardId}|${metadata.setupOperationId}|${metadata.binding}`;
}

export function parseKeyFormMetadata(value: string): KeyFormMetadata | undefined {
  const match = METADATA.exec(value);
  return match ? { cardId: match[1]!, setupOperationId: match[2]!, binding: match[3]! } : undefined;
}

export function keyFieldBlockId(cardId: string): string {
  return uiBlockId('host', cardId, 0);
}

export const KEY_FIELD_ACTION_ID = 'chickpea.host.v1.key_field';

export function keyModalView(input: {
  card: UiSurfaceRecord & { spec: KeyCardSpec };
  row: KeyRow;
  target: KeyTarget;
}): Record<string, unknown> {
  const { card, row, target } = input;
  const name = agent(card.spec);
  const mcp = row.kind === 'mcp_credentials';
  const sentTo = target.destinations.map((destination) => `\`${escapeMrkdwn(clampDisplay(destination, 200))}\``);
  return {
    type: 'modal',
    callback_id: KEY_FORM_CALLBACK_ID,
    private_metadata: encodeKeyFormMetadata({
      cardId: card.id,
      setupOperationId: row.setupOperationId,
      binding: target.binding,
    }),
    title: plain(mcp ? 'Add access token' : 'Add API key', 24),
    submit: plain('Save key', 24),
    close: plain('Cancel', 24),
    blocks: [
      { type: 'section', text: mrkdwn(`${label(row)} for ${name}`) },
      { type: 'context', elements: [mrkdwn(`Sent only to ${sentTo.join(', ')}`)] },
      {
        type: 'input',
        block_id: keyFieldBlockId(card.id),
        label: plain(mcp ? 'Access token' : 'API key', 2_000),
        hint: plain(
          `Only you can see this while you type. It won't be posted in Slack, and ${clampDisplay(card.spec.agentName, 80)} uses it without ever seeing it.`,
          2_000,
        ),
        element: {
          type: 'plain_text_input',
          action_id: KEY_FIELD_ACTION_ID,
          placeholder: plain('Paste the key', 150),
          max_length: MAX_KEY_LENGTH,
        },
      },
      {
        type: 'context',
        elements: [mrkdwn(target.ownerKind === 'team'
          ? `${name} uses this key for everyone who asks it.`
          : `${name} uses this key only when you ask it.`)],
      },
    ],
  };
}

export type KeySubmissionReading =
  | { ok: true; key: string; row: KeyRow; target: KeyTarget }
  | {
      ok: false;
      refusal: KeyRowRefusal | 'invalid';
      /** What the form's field says, as plain text. */
      problem: string;
      responseAction: Record<string, unknown>;
      row?: KeyRow;
    };

export function readKeySubmission(input: {
  submission: { workspaceId: string; userId: string; privateMetadata: string; state: SlackUiState };
  card: UiSurfaceRecord | undefined;
  facts: KeySetupFacts;
  now: number;
}): KeySubmissionReading {
  const metadata = parseKeyFormMetadata(input.submission.privateMetadata);
  const fail = (refusal: KeyRowRefusal | 'invalid', message: string, row?: KeyRow): KeySubmissionReading => ({
    ok: false,
    refusal,
    problem: message,
    responseAction: metadata
      ? { response_action: 'errors', errors: { [keyFieldBlockId(metadata.cardId)]: message } }
      : { response_action: 'clear' },
    ...(row ? { row } : {}),
  });
  const card = input.card;
  if (!metadata || !isKeyCard(card) || card.id !== metadata.cardId) {
    return fail('unavailable', 'This is no longer available. Reply in the thread instead.');
  }
  const available = keyRowAvailability({
    card,
    workspaceId: input.submission.workspaceId,
    userId: input.submission.userId,
    setupOperationId: metadata.setupOperationId,
    facts: input.facts,
    now: input.now,
  });
  const name = clampDisplay(card.spec.agentName, 80);
  const changed = `Where this key goes changed after this form opened. Close it and ask ${name} for a new one.`;
  if (!available.ok) {
    const inForm: Partial<Record<KeyRowRefusal, string>> = {
      superseded: changed,
      busy: 'Chickpea is already checking a key for this. Close this window.',
      done: 'This key was already added. Close this window.',
    };
    return fail(available.refusal, inForm[available.refusal] ?? keyRefusalNotice(card, available.refusal), available.row);
  }
  const { row, target } = available;
  if (metadata.binding !== target.binding) return fail('superseded', changed, row);
  const value = input.submission.state[keyFieldBlockId(metadata.cardId)]?.[KEY_FIELD_ACTION_ID]?.value;
  const key = withoutRepeatedScheme(typeof value === 'string' ? value.trim() : '', target.valuePrefix);
  if (!key) return fail('invalid', 'Paste the key.', row);
  if (/\s/.test(key)) return fail('invalid', 'Paste only the key. It can\'t contain spaces or line breaks.', row);
  if (key.length > MAX_KEY_LENGTH) {
    return fail('invalid', `This key is too long for Slack. Ask ${name} for a setup link instead.`, row);
  }
  return { ok: true, key, row, target };
}

function withoutRepeatedScheme(key: string, prefix: string): string {
  const scheme = prefix.trim();
  if (!scheme || key.length <= scheme.length) return key;
  const head = key.slice(0, scheme.length);
  return head.toLowerCase() === scheme.toLowerCase() && /\s/.test(key[scheme.length]!)
    ? key.slice(scheme.length).trimStart()
    : key;
}
