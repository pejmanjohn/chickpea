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
import {
  UI_SURFACE_TTL_MS,
  uiSurfaceId,
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

async function surfaceResult(
  state: SurfaceState,
  request: Parameters<SurfaceState['executeUiSurface']>[0],
): Promise<UiSurfaceRecord | undefined> {
  const response = await state.executeUiSurface(request);
  return response.kind === 'surface' ? response.surface ?? undefined : undefined;
}

async function redraw(messenger: UiSurfaceMessenger, surface: UiSurfaceRecord | undefined): Promise<void> {
  if (!surface?.messageTs) return;
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
    for (const surface of superseded.surfaces) await redraw(input.messenger, surface);
  }

  const now = input.now ?? Date.now();
  for (const spec of specs) {
    const stored = await surfaceResult(state, {
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
      await surfaceResult(state, { kind: 'close_surface', id: stored.id, status: 'failed' });
      continue;
    }
    const messageTs = await input.messenger.post(rendered).catch(() => undefined);
    if (messageTs) {
      await surfaceResult(state, { kind: 'bind_surface_message', id: stored.id, messageTs });
    }
  }
}

/**
 * A typed answer settles the same approval its card offers: mark the card
 * answered (noting it was typed) and redraw it, so no live button remains.
 */
export async function retireApprovalSurfacesForTypedAnswer(input: {
  state: SlackStateStore;
  messenger: UiSurfaceMessenger;
  scope: { workspaceId: string; channelId: string; threadTs: string; agentId: string };
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
    const resolved = await surfaceResult(state, {
      kind: 'resolve_surface',
      id: surface.id,
      resolution: { ...input.resolution, typed: true },
    });
    await redraw(input.messenger, resolved);
  }
}
