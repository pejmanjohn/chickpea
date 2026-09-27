import { getBrowserActionForThread } from '../../browser/actions.ts';
import type { SettingsStore } from '../../config/settings-store.ts';
import type { ResolvedAssignment } from '../../config/types.ts';
import type { IdentityStore } from '../../identity/types.ts';
import { resolveHostSlackManagementProposal } from '../../management/slack-approval.ts';
import type { ManagementStore } from '../../management/store.ts';
import type { SlackStateStore } from '../claim-store.ts';
import { conversationThreadTs, slackConversationKind } from '../thread-key.ts';
import { slackTimestampUnits } from '../thread-context.ts';
import type { NormalizedSlackTurn } from '../types.ts';
import { checkSlackBlocks } from './block-kit-limits.ts';
import { renderUiSurface, type RenderedUiSurface } from './render.ts';
import { renderCards, renderChart, renderDetails } from './render-display.ts';
import type { RenderedSlackComponents } from '../reply-continuations.ts';
import {
  isDisplaySurface,
  UI_SURFACE_TTL_MS,
  uiSurfaceId,
  type DisplaySurfaceSpec,
  type HostApprovalSpec,
  type UiSurfaceRecord,
  type UiSurfaceResolution,
} from './surface.ts';

/** Posts and edits the host's own surface messages (sender persona included). */
export interface UiSurfaceMessenger {
  post(rendered: RenderedUiSurface): Promise<string | undefined>;
  update(messageTs: string, rendered: RenderedUiSurface): Promise<void>;
}

type SurfaceState = Required<Pick<SlackStateStore, 'executeUiSurface'>>;

/** One surface request whose answer is a single record (or none). */
export async function uiSurfaceRecord(
  state: SurfaceState,
  request: Parameters<SurfaceState['executeUiSurface']>[0],
): Promise<UiSurfaceRecord | undefined> {
  const response = await state.executeUiSurface(request);
  return response.kind === 'surface' ? response.surface ?? undefined : undefined;
}

/** Redraw a posted surface from its stored state; a failed edit is only logged. */
export async function redrawUiSurface(
  messenger: Pick<UiSurfaceMessenger, 'update'>,
  surface: UiSurfaceRecord | undefined,
): Promise<void> {
  // Display components live inside the answer message, which is never redrawn.
  if (!surface?.messageTs || isDisplaySurface(surface.spec)) return;
  await messenger.update(surface.messageTs, renderUiSurface(surface)).catch(() => {
    console.warn('[chickpea] Slack card redraw failed');
  });
}

function turnStartedAtMs(turn: Pick<NormalizedSlackTurn, 'messageTs'>): number {
  const units = slackTimestampUnits(turn.messageTs);
  return units === null ? Date.now() : Number(units / 1000n);
}

/**
 * After a reply, find the approval this turn created (a workspace-change
 * proposal or a held browser step) and post it as a host-owned card with
 * Approve and Cancel/Stop buttons. The record is durable before the post and
 * its id derives from the turn, so a retried delivery never posts twice.
 * Typed "approve"/"stop" keep working; the card is an addition, not a gate.
 */
export async function deliverHostApprovalSurfaces(input: {
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  turnJobId: string;
  state: SlackStateStore;
  settings?: SettingsStore;
  identity?: Pick<IdentityStore, 'resolveSlackIdentity'>;
  management?: Pick<ManagementStore, 'getActiveChangeSetProposal'>;
  messenger: UiSurfaceMessenger;
  now?: number;
}): Promise<void> {
  const { turn, assignment } = input;
  if (!input.state.executeUiSurface) return;
  const state = input.state as SurfaceState;
  const kind = slackConversationKind(turn);
  // Group DMs are not admitted as plain thread replies, so a click there
  // could never be admitted: keep typed approval only.
  if (kind === 'mpim') return;
  const startedAt = turnStartedAtMs(turn);
  const threadTs = conversationThreadTs(turn, assignment.runtimeContract);
  const specs: HostApprovalSpec[] = [];

  if (input.settings) {
    const held = await getBrowserActionForThread(input.settings, {
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      threadTs,
      agentId: assignment.agent.id,
    }).catch(() => undefined);
    if (held && held.status === 'pending' && held.createdAt >= startedAt &&
        held.actorSlackUserId === turn.userId && held.expiresAt > (input.now ?? Date.now())) {
      specs.push({
        kind: 'approval',
        approval: 'browser_step',
        browserActionId: held.id,
        description: held.description,
        host: held.host,
      });
    }
  }
  if (input.identity && input.management && turn.actorMembershipId && !turn.managementApprovalProposalId) {
    const proposal = await resolveHostSlackManagementProposal({
      turn,
      assignment,
      actorMembershipId: turn.actorMembershipId,
      identity: input.identity,
      management: input.management,
    }).catch(() => undefined);
    if (proposal && proposal.status === 'pending' && proposal.createdAt >= startedAt) {
      specs.push({ kind: 'approval', approval: 'workspace_change', proposalId: proposal.proposalId });
    }
  }
  if (specs.length === 0) return;

  // One live approval card per thread and Agent: a newer one closes older ones.
  const superseded = await state.executeUiSurface({
    kind: 'supersede_surfaces',
    scope: { workspaceId: turn.workspaceId, channelId: turn.channelId, threadTs: turn.threadTs, agentId: assignment.agent.id },
    exceptTurnJobId: input.turnJobId,
    kinds: ['approval'],
  });
  if (superseded.kind === 'surfaces') {
    for (const surface of superseded.surfaces) await redrawUiSurface(input.messenger, surface);
  }

  const now = input.now ?? Date.now();
  for (const spec of specs) {
    const stored = await uiSurfaceRecord(state, {
      kind: 'put_surface',
      record: {
        id: uiSurfaceId(input.turnJobId, `host-approval:${spec.approval}`),
        namespace: 'host',
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        threadTs: turn.threadTs,
        conversationThreadTs: threadTs,
        conversationKind: kind === 'im' ? 'im' : 'channel',
        agentId: assignment.agent.id,
        turnJobId: input.turnJobId,
        requesterUserId: turn.userId,
        spec,
        status: 'pending_delivery',
        createdAt: now,
        updatedAt: now,
        expiresAt: now + UI_SURFACE_TTL_MS,
      },
    });
    if (!stored || stored.messageTs || stored.status !== 'pending_delivery') continue;
    const rendered = renderUiSurface(stored);
    const check = checkSlackBlocks(rendered.blocks, { text: rendered.text });
    if (!check.ok) {
      // The typed path still works; never post a card Slack would reject.
      console.error('[chickpea] host approval card failed the Block Kit check', { issues: check.issues.slice(0, 5) });
      await uiSurfaceRecord(state, { kind: 'close_surface', id: stored.id, status: 'failed' });
      continue;
    }
    const messageTs = await input.messenger.post(rendered).catch(() => undefined);
    if (messageTs) {
      await uiSurfaceRecord(state, { kind: 'bind_surface_message', id: stored.id, messageTs });
    }
  }
}

/**
 * A typed answer settles the same approval its card offers: mark the card
 * answered (noting it was typed) and redraw it, so no live button remains.
 * The card is found by the approval it names anywhere in the channel: a DM's
 * approval can be typed at the top level while its card sits in a thread.
 */
export async function retireApprovalSurfacesForTypedAnswer(input: {
  state: SlackStateStore;
  messenger: Pick<UiSurfaceMessenger, 'update'>;
  scope: { workspaceId: string; channelId: string; agentId: string };
  match: { proposalId?: string; browserActionId?: string };
  resolution: Omit<UiSurfaceResolution, 'typed'>;
}): Promise<void> {
  if (!input.state.executeUiSurface) return;
  const state = input.state as SurfaceState;
  const open = await state.executeUiSurface({ kind: 'list_open_surfaces', scope: input.scope });
  if (open.kind !== 'surfaces') return;
  for (const surface of open.surfaces) {
    const spec = surface.spec;
    if (spec.kind !== 'approval') continue;
    const matches = spec.approval === 'workspace_change'
      ? spec.proposalId === input.match.proposalId
      : spec.browserActionId === input.match.browserActionId;
    if (!matches) continue;
    const resolved = await uiSurfaceRecord(state, {
      kind: 'resolve_surface',
      id: surface.id,
      resolution: { ...input.resolution, typed: true },
    });
    await redrawUiSurface(input.messenger, resolved);
  }
}

/**
 * After the Agent's own answer is delivered: close the questions and
 * next-step buttons its earlier replies in this thread left open (redrawn as
 * closed; link buttons stay), then post this turn's pending surface as its own
 * message under the answer and bind it. Records exist before the post and are
 * keyed by the turn, so a retried delivery never posts twice.
 */
export async function deliverInteractiveSurfaces(input: {
  turn: Pick<NormalizedSlackTurn, 'workspaceId' | 'channelId' | 'threadTs'>;
  agentId: string;
  turnJobId: string;
  state: SlackStateStore;
  messenger: UiSurfaceMessenger;
  /** The delivered answer text; a question it already states is not repeated. */
  answerText: string;
}): Promise<void> {
  if (!input.state.executeUiSurface) return;
  const state = input.state as SurfaceState;
  const superseded = await state.executeUiSurface({
    kind: 'supersede_surfaces',
    scope: {
      workspaceId: input.turn.workspaceId,
      channelId: input.turn.channelId,
      threadTs: input.turn.threadTs,
      agentId: input.agentId,
    },
    exceptTurnJobId: input.turnJobId,
    // Card request buttons close too; the answer they sit in is left as is.
    kinds: ['question', 'form', 'actions', 'cards'],
  });
  if (superseded.kind === 'surfaces') {
    for (const surface of superseded.surfaces) await redrawUiSurface(input.messenger, surface);
  }
  const own = await state.executeUiSurface({ kind: 'list_turn_surfaces', turnJobId: input.turnJobId });
  if (own.kind !== 'surfaces') return;
  for (const surface of own.surfaces) {
    if (surface.namespace !== 'ui' || surface.status !== 'pending_delivery' || surface.messageTs ||
        isDisplaySurface(surface.spec)) continue;
    if (surface.threadTs !== input.turn.threadTs || surface.channelId !== input.turn.channelId) {
      await uiSurfaceRecord(state, { kind: 'close_surface', id: surface.id, status: 'failed' });
      continue;
    }
    const restated = surface.spec.kind === 'question' &&
      input.answerText.trim() === surface.spec.question.question;
    const rendered = renderUiSurface(surface, { withHeader: !restated });
    const check = checkSlackBlocks(rendered.blocks, { text: rendered.text });
    if (!check.ok) {
      // The answer already stands on its own; never post a card Slack would reject.
      console.error('[chickpea] interactive card failed the Block Kit check', { issues: check.issues.slice(0, 5) });
      await uiSurfaceRecord(state, { kind: 'close_surface', id: surface.id, status: 'failed' });
      continue;
    }
    const messageTs = await input.messenger.post(rendered).catch(() => undefined);
    if (messageTs) await uiSurfaceRecord(state, { kind: 'bind_surface_message', id: surface.id, messageTs });
  }
}

/** Surfaces a turn recorded but will not deliver (its answer was replaced). */
export async function abandonTurnSurfaces(state: SlackStateStore, turnJobId: string): Promise<void> {
  if (!state.executeUiSurface) return;
  const own = await state.executeUiSurface({ kind: 'list_turn_surfaces', turnJobId });
  if (own.kind !== 'surfaces') return;
  for (const surface of own.surfaces) {
    if (surface.namespace === 'ui' && surface.status === 'pending_delivery') {
      await state.executeUiSurface({ kind: 'close_surface', id: surface.id, status: 'failed' });
    }
  }
}

/**
 * The display components the answer carries. A fresh result's components are
 * stored first (one slot each, in order), so a retried delivery that replays
 * the settled answer renders the same ones; a replay reads them back.
 */
export async function prepareDisplaySurfaces(input: {
  state: SlackStateStore;
  turn: Pick<NormalizedSlackTurn, 'workspaceId' | 'channelId' | 'threadTs' | 'userId'> &
    Partial<Pick<NormalizedSlackTurn, 'channelType' | 'source'>>;
  agentId: string;
  turnJobId: string;
  /** This attempt's components; undefined when replaying a settled answer. */
  fresh?: readonly DisplaySurfaceSpec[];
  now?: number;
}): Promise<UiSurfaceRecord[]> {
  if (!input.state.executeUiSurface) return [];
  const state = input.state as SurfaceState;
  const now = input.now ?? Date.now();
  if (input.fresh) {
    const ids = new Set<string>();
    for (const [index, spec] of input.fresh.entries()) {
      const id = uiSurfaceId(input.turnJobId, `display:${index}`);
      ids.add(id);
      await uiSurfaceRecord(state, {
        kind: 'put_surface',
        record: {
          id,
          namespace: 'ui',
          workspaceId: input.turn.workspaceId,
          channelId: input.turn.channelId,
          threadTs: input.turn.threadTs,
          conversationThreadTs: input.turn.threadTs,
          conversationKind: input.turn.channelId.startsWith('D') ? 'im' : 'channel',
          agentId: input.agentId,
          turnJobId: input.turnJobId,
          requesterUserId: input.turn.userId,
          spec,
          status: 'pending_delivery',
          // Slots keep call order: listing sorts by creation time.
          createdAt: now + index,
          updatedAt: now,
          expiresAt: now + UI_SURFACE_TTL_MS,
        },
      });
    }
    // An earlier attempt's extra components never reach Slack.
    const listed = await state.executeUiSurface({ kind: 'list_turn_surfaces', turnJobId: input.turnJobId });
    for (const surface of listed.kind === 'surfaces' ? listed.surfaces : []) {
      if (isDisplaySurface(surface.spec) && !ids.has(surface.id) && surface.status === 'pending_delivery') {
        await state.executeUiSurface({ kind: 'close_surface', id: surface.id, status: 'failed' });
      }
    }
  }
  const listed = await state.executeUiSurface({ kind: 'list_turn_surfaces', turnJobId: input.turnJobId });
  return (listed.kind === 'surfaces' ? listed.surfaces : []).filter((surface) =>
    isDisplaySurface(surface.spec) && (surface.status === 'pending_delivery' || surface.status === 'open'));
}

/**
 * Compile stored display components for the answer's closing. Each one must
 * pass the Block Kit checker on its own; one that does not is left out and the
 * prose still stands.
 */
export function renderDisplayComponents(records: readonly UiSurfaceRecord[]): RenderedSlackComponents | undefined {
  const blocks: Array<Record<string, unknown>> = [];
  const fallback: string[] = [];
  for (const record of records) {
    const spec = record.spec;
    if (!isDisplaySurface(spec)) continue;
    const rendered = spec.kind === 'cards'
      ? renderCards(spec.cards, record.id)
      : spec.kind === 'chart' ? renderChart(spec.chart) : renderDetails(spec.details);
    const check = checkSlackBlocks(rendered.blocks);
    if (!check.ok) {
      console.error('[chickpea] display component failed the Block Kit check', {
        kind: spec.kind, issues: check.issues.slice(0, 5),
      });
      continue;
    }
    blocks.push(...rendered.blocks);
    fallback.push(rendered.fallbackText);
  }
  return blocks.length ? { blocks, fallbackText: fallback.join('\n\n') } : undefined;
}

/** After the answer is delivered, its display components are open for card clicks. */
export async function markDisplaySurfacesDelivered(
  state: SlackStateStore,
  records: readonly UiSurfaceRecord[],
): Promise<void> {
  if (!state.executeUiSurface) return;
  for (const record of records) {
    if (record.status === 'pending_delivery') {
      await state.executeUiSurface({ kind: 'open_surface', id: record.id });
    }
  }
}
