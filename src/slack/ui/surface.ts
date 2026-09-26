import { sha256HexNode } from '../../security/digest.ts';

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

export type UiSurfaceSpec = HostApprovalSpec;
export type UiSurfaceKind = UiSurfaceSpec['kind'];

export interface UiSurfaceResolution {
  byUserId: string;
  at: number;
  /** Index of the chosen control; each surface kind names its choices. */
  choice: number;
  /** The answer arrived as typed text rather than a click. */
  typed?: true;
}

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
  resolution?: UiSurfaceResolution;
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

export function uiActionId(namespace: UiNamespace, kind: string, index: number): string {
  return `chickpea.${namespace}.v1.${kind}.${index}`;
}

export function uiBlockId(namespace: UiNamespace, surfaceId: string, index: number): string {
  return `chickpea.${namespace}.v1.${surfaceId}.${index}`;
}

export function uiValue(surfaceId: string, index: number): string {
  return `${surfaceId}:${index}`;
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
