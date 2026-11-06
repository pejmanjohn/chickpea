import { sha256HexNode } from '../../security/digest.ts';
import type { KeyCardSpec } from './key-card.ts';
import type {
  AskUserSpec,
  OfferActionsSpec,
  PresentCardsSpec,
  PresentChartSpec,
  PresentDetailsSpec,
  RequestFormSpec,
} from './presentation-tools.ts';

/**
 * A durable interactive surface: one host-owned Slack message whose controls
 * resolve against this record, never against text echoed back in a click.
 *
 * Two namespaces never mix. `ui` surfaces come from model-chosen components;
 * `host` surfaces are approvals and other host controls that only host code
 * can mint. A `ui` click can never resolve a `host` record, whatever its label.
 */
export type UiNamespace = 'ui' | 'host';
export type UiSurfaceStatus =
  | 'pending_delivery'
  | 'open'
  | 'resolved'
  | 'superseded'
  | 'expired'
  | 'failed';

export type HostApprovalSpec =
  | {
      kind: 'approval';
      approval: 'workspace_change';
      proposalId: string;
    }
  | {
      kind: 'approval';
      approval: 'browser_step';
      browserActionId: string;
      /** Host-authored step description, e.g. click "Confirm change". */
      description: string;
      host: string;
    };

/**
 * The front desk's card: the person picks which Agent takes their message.
 * It carries the message itself (`origin`), because the message's turn job
 * is gone long before the card is; a pick admits that message again. The
 * store drops that copy once the card is picked, closed, or past its day,
 * and an edit or delete of the message closes the card.
 */
export interface HostAgentChoiceSpec {
  kind: 'agent_choice';
  requesterUserId: string;
  options: Array<{ agentId: string; name: string }>;
  origin?: {
    userId: string;
    messageTs: string;
    text: string;
    attachments?: Array<{ fileId: string }>;
    attachmentIntake?: { status: 'ok' | 'too_many' | 'invalid_metadata'; count: number };
    requesterTimezone?: string;
  };
}

/** A model-chosen question (ask_user) the person answers with one click. */
export interface QuestionSurfaceSpec {
  kind: 'question';
  question: AskUserSpec;
}

/** A model-requested form (request_form): inline inputs or a modal. */
export interface FormSurfaceSpec {
  kind: 'form';
  form: RequestFormSpec;
}

/** Model-offered next steps (offer_actions): link and request buttons. */
export interface ActionsSurfaceSpec {
  kind: 'actions';
  actions: OfferActionsSpec;
}

/**
 * Display components ride in the answer message itself. They are stored so a
 * retried delivery can still render them, and so card request buttons resolve
 * like any click. Only a card set redraws the answer message, when one of its
 * cards settles.
 */
export type DisplaySurfaceSpec =
  | { kind: 'cards'; cards: PresentCardsSpec }
  | { kind: 'chart'; chart: PresentChartSpec }
  | { kind: 'details'; details: PresentDetailsSpec };

export const DISPLAY_SURFACE_KINDS = ['cards', 'chart', 'details'] as const;

export function isDisplaySurface(spec: UiSurfaceSpec): spec is DisplaySurfaceSpec {
  return (DISPLAY_SURFACE_KINDS as readonly string[]).includes(spec.kind);
}

export type UiSurfaceSpec =
  | HostApprovalSpec
  | HostAgentChoiceSpec
  | KeyCardSpec
  | QuestionSurfaceSpec
  | ActionsSurfaceSpec
  | FormSurfaceSpec
  | DisplaySurfaceSpec;
export type UiSurfaceKind = UiSurfaceSpec['kind'];

export interface UiSurfaceResolution {
  byUserId: string;
  at: number;
  /** Index of the chosen control; each surface kind names its choices. */
  choice: number;
  /** Chosen option indexes, person/channel ids, or a date, for pickers and multi-selects. */
  values?: string[];
  /** The answer arrived as typed text rather than a click. */
  typed?: true;
  /** The chosen Agent could not take the message; the card says so. */
  refused?: true;
  /**
   * The option now answering the message, set once the pick's takeover
   * settled. Absent, the card names nobody: the takeover never settled, or
   * the thread's owner is not on the card.
   */
  takenBy?: number;
}

/** A press on a card's request button; the slot names the card and the button. */
export interface CardPick {
  slot: number;
  byUserId: string;
  at: number;
}

export const CARD_OUTCOME_TONES = ['done', 'failed', 'info'] as const;
export type CardOutcomeTone = (typeof CARD_OUTCOME_TONES)[number];

/** What the Agent reported on a card (update_card); a later one replaces it. */
export interface CardOutcome {
  tone: CardOutcomeTone;
  text: string;
  at: number;
}

/** A settled card has a pick, an outcome, or both; its request buttons are gone. */
export type CardSettlement =
  | { pick: CardPick; outcome?: CardOutcome }
  | { pick?: undefined; outcome: CardOutcome };

/** A card set's settled cards by card index; a card without an entry is still open. */
export type CardSettlements = Partial<Record<number, CardSettlement>>;

export interface UiSurfaceRecord {
  id: string;
  namespace: UiNamespace;
  workspaceId: string;
  channelId: string;
  /** The Slack thread the surface message is posted in. */
  threadTs: string;
  /** The Agent conversation thread (legacy contracts use a session key). */
  conversationThreadTs: string;
  conversationKind: 'channel' | 'im';
  agentId: string;
  turnJobId: string;
  requesterUserId: string;
  spec: UiSurfaceSpec;
  status: UiSurfaceStatus;
  messageTs?: string;
  /** A card set settled whole by an older build carries this, not `cardSettlements`. */
  resolution?: UiSurfaceResolution;
  /** A card set's cards, each settled on its own. */
  cardSettlements?: CardSettlements;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export const UI_SURFACE_ID_PATTERN = /^[a-f0-9]{32}$/;
export const UI_SURFACE_TTL_MS = 7 * 24 * 60 * 60_000;
export const UI_SURFACE_MAX_SPEC_BYTES = 16 * 1024;

/**
 * Surface ids derive from the owning turn and a slot, so a retried or replayed
 * delivery mints identical ids and never a second card. An id is a lookup key,
 * not an authorization credential: every click is re-authorized.
 */
export function uiSurfaceId(turnJobId: string, slot: string): string {
  return sha256HexNode(`chickpea.ui-surface.v1\n${turnJobId}\n${slot}`).slice(0, 32);
}

/** A reply's display components, one slot each in call order. */
export function displaySurfaceId(turnJobId: string, index: number): string {
  return uiSurfaceId(turnJobId, `display:${index}`);
}

/** How a card set is named to the model: "cards 1a2b3c4d". */
export function cardSetRef(surfaceId: string): string {
  return surfaceId.slice(0, 8);
}

export function uiActionId(namespace: UiNamespace, kind: string, index: number): string {
  return `chickpea.${namespace}.v1.${kind}.${index}`;
}

export function uiBlockId(namespace: UiNamespace, surfaceId: string, index: number): string {
  return `chickpea.${namespace}.v1.${surfaceId}.${index}`;
}

export function uiValue(surfaceId: string, index: number): string {
  return `${surfaceId}:${index}`;
}

// The shared gateway forwards only `chickpea.ui.v1.` view callbacks.
export const KEY_FORM_CALLBACK_ID = 'chickpea.ui.v1.key';
const KEY_ADD_ACTION = /^chickpea\.host\.v1\.key_add\.\d{1,3}$/;

export function isKeyFormAction(actionId: string): boolean {
  return KEY_ADD_ACTION.test(actionId);
}

/**
 * Reply data a Slack turn writes when it ran a management tool that can ask
 * for a key with the Add key card (apply_workspace_changes,
 * save_connection_key). Only such a turn looks for the card's setups after
 * its reply. Not persisted with the settlement: a replayed answer looks.
 */
export const KEY_SETUP_TOOL_DATA_NAME = 'slackKeySetupTool';

export function keySetupToolRanFromReplyData(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) =>
    typeof entry === 'object' && entry !== null && (entry as { ran?: unknown }).ran === true);
}

const ACTION_ID = /^chickpea\.(ui|host)\.v1\.([a-z_]{1,24})(?:\.(\d{1,3}))?$/;
const BLOCK_ID = /^chickpea\.(ui|host)\.v1\.([a-f0-9]{32})\.(\d{1,3})$/;
const VALUE = /^([a-f0-9]{32}):(\d{1,3})$/;

export interface ParsedUiControl {
  namespace: UiNamespace;
  kind: string;
  surfaceId: string;
  /** From the control's own value, when the control carries one. */
  valueIndex?: number;
}

/**
 * Parsing grants no authority. The block id names the surface; a button's
 * value must name the same surface, so a value moved between cards is refused.
 */
export function parseUiControl(input: {
  actionId: string;
  blockId: string;
  value?: string | null;
}): ParsedUiControl | undefined {
  const action = ACTION_ID.exec(input.actionId);
  const block = BLOCK_ID.exec(input.blockId);
  if (!action || !block || action[1] !== block[1]) return undefined;
  const parsed: ParsedUiControl = {
    namespace: action[1] as UiNamespace,
    kind: action[2]!,
    surfaceId: block[2]!,
  };
  if (input.value !== undefined && input.value !== null && input.value !== '') {
    const value = VALUE.exec(input.value);
    if (!value || value[1] !== parsed.surfaceId) return undefined;
    parsed.valueIndex = Number(value[2]);
  }
  return parsed;
}

/** A selected option's value, bound to its surface like a button value. */
export function parseUiOptionValue(surfaceId: string, value: string): number | undefined {
  const match = VALUE.exec(value);
  return match && match[1] === surfaceId ? Number(match[2]) : undefined;
}
