import type { WebClient } from '@slack/web-api';

import { activityStatus, type TypedActivityStatus } from '../activity/status.ts';
import { handedOverTurnDispatches, type HandedOverTurn } from './admission-agent-wake.ts';
import {
  SlackAgentViewPresentation,
  type SlackPresentationStatePort,
} from './agent-view-presentation.ts';
import {
  presentationUnstarted,
  transitionPresentationCopy,
  type SlackPresentationOwner,
  type SlackRunPresentation,
  type SlackRunPresentationV3,
} from './run-presentations.ts';
import { WebClientPresenter } from './web-client-presenter.ts';

interface AdmittedSlackActivityInput {
  client: WebClient;
  state: SlackPresentationStatePort;
  runId: string;
  runFencingToken: number;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  requesterUserId: string;
  owner: SlackPresentationOwner;
  agentId: string;
  activity: TypedActivityStatus;
  semanticActivityEnabled?: boolean;
}

/**
 * Project the intent persisted by canonical admission, before model or
 * sandbox work (showAdmissionStatus calls it before a turn's hand-off).
 * Keeping the write in the state owner lets one generation fence every
 * native status writer. Replays are safe: presentation state either returns
 * the same pending operation for receipt reconciliation or proves that the
 * activity is already visible.
 */
export async function presentAdmittedSlackActivity(
  input: AdmittedSlackActivityInput,
): Promise<boolean> {
  const agentName = input.owner.kind === 'selected_agent'
    ? input.owner.persona.name
    : input.owner.kind === 'agent_app'
      ? input.owner.agentName
      : 'Chickpea';
  const agentView = new SlackAgentViewPresentation({
    client: input.client,
    state: input.state,
    runId: input.runId,
    runFencingToken: input.runFencingToken,
    footer: { agentName, agentId: input.agentId },
  });
  const presenter = new WebClientPresenter(input.client, {
    channelId: input.channelId,
    threadTs: input.threadTs,
    agentName,
    visibleOwner: input.owner,
    agentId: input.agentId,
    userId: input.requesterUserId,
    workspaceId: input.workspaceId,
  }, undefined, {
    agentViewPresentation: agentView,
    ...(input.state.reserveSlackActivityStatus &&
        input.state.applySlackActivityStatusCooldown
      ? {
          activityStatusCoordinator: {
            reserve: async () => input.state.reserveSlackActivityStatus!(input.workspaceId),
            applyCooldown: async (retryAfterMs: number) =>
              input.state.applySlackActivityStatusCooldown!(input.workspaceId, retryAfterMs),
          },
        }
      : {}),
  });
  // Slack hides a custom assistant status while the Agent Session is in native
  // `processing`, and a non-empty assistant status itself moves the session to
  // processing. Use the native indicator only when no custom status shows.
  if (input.semanticActivityEnabled === false) {
    await agentView.beginAgentSessionProcessing();
    return true;
  }
  const write = await agentView.beginActivity(
    input.activity,
    presenter.preferredActivitySurface(),
  );
  // No write: a replay whose status is already resolved, or a fenced run.
  if (!write) return false;
  await presenter.setStatus(input.activity, write);
  const receipt = presenter.activityReceipt();
  await agentView.recordActivityReceipt(
    write.operationId,
    receipt.certainty,
    receipt.messageTs,
    receipt.unavailable,
  );
  if (receipt.certainty === 'failed' || write.surface !== 'assistant_status') {
    await agentView.beginAgentSessionProcessing();
  }
  return receipt.certainty === 'acknowledged';
}

/** How long a turn's hand-off waits for admission's status write (showAdmissionStatus). */
export const ADMISSION_STATUS_CAP_MS = 600;

/**
 * Slack drops a custom status two minutes after it was set, and the status
 * registry refreshes the one a turn starts with an interval (90 s) after the
 * turn registers it. A status shown less than this long before the turn
 * started still shows when that refresh lands, so the turn need not write it
 * again at once.
 */
const ADMISSION_STATUS_FRESH_MS = 30_000;

/** Whether the status the state store showed at `shownAt` (its clock), at this attempt's hand-off, is still fresh. */
export function admissionStatusFresh(shownAt: number | undefined): boolean {
  return shownAt !== undefined && Date.now() - shownAt < ADMISSION_STATUS_FRESH_MS;
}

/** Admission's status write, as the hand-off carries it to the turn's first attempt for `turn_latency`. */
export interface AdmissionStatusMark {
  /** How long the hand-off waited for the write: at most the cap. */
  waitedMs: number;
  /** When the state store recorded the status Slack acknowledged (its clock); absent when it did not show. */
  shownAt?: number;
}

/** A carried mark as the runner takes it from a hand-off: anything malformed is none. */
export function parseAdmissionStatusMark(value: unknown): AdmissionStatusMark | undefined {
  const mark = value as Partial<AdmissionStatusMark> | null | undefined;
  const time = (field: unknown): field is number =>
    typeof field === 'number' && Number.isFinite(field) && field >= 0;
  if (!mark || !time(mark.waitedMs)) return undefined;
  return time(mark.shownAt)
    ? { waitedMs: mark.waitedMs, shownAt: mark.shownAt }
    : { waitedMs: mark.waitedMs };
}

/**
 * The presentation of a turn whose status admission may show before its
 * hand-off: V3, nothing shown or intended for it yet, holding the admitted
 * activity, of a turn that will dispatch (handedOverTurnDispatches). Not an
 * Agent with its own Slack app, whose status is its own bot's.
 */
export function admissionStatusPresentation(
  job: HandedOverTurn,
  presentation: SlackRunPresentation | undefined,
  botUserId: string | undefined,
): SlackRunPresentationV3 | undefined {
  if (presentation?.schemaVersion !== 3 || presentation.owner.kind === 'agent_app' ||
      presentation.currentActivity?.operation.certainty !== 'pending' ||
      !presentationUnstarted(presentation)) return undefined;
  return handedOverTurnDispatches(job, botUserId) ? presentation : undefined;
}

/**
 * Show a turn's admitted activity before its hand-off, waiting at most
 * `capMs`. The write runs on a copy of the presentation, committed only when
 * Slack acknowledged the status within the cap. The hand-off then carries
 * either the status shown, which the runner keeps without an opening write
 * of its own, or the presentation as admission left it, which the runner
 * shows as before. After the cap the copy takes no transition, so a write
 * that lands later changes no record the runner's copy competes with.
 */
export async function showAdmissionStatus(input: {
  presentation: SlackRunPresentationV3;
  agentId: string;
  /** The state store's own: the thread's generation fence and the workspace's status budget. */
  state: SlackPresentationStatePort;
  client(): Promise<WebClient>;
  /** Record the presentation with its status shown; false when the stored row moved meanwhile. */
  commit(shown: SlackRunPresentation): boolean;
  capMs?: number;
}): Promise<AdmissionStatusMark> {
  const startedAt = Date.now();
  const { runId, root, owner, runFencingToken } = input.presentation;
  let copy: SlackRunPresentation = input.presentation;
  let open = true;
  const state: SlackPresentationStatePort = {
    ...input.state,
    getRunPresentation: (id) => id === runId ? copy : input.state.getRunPresentation(id),
    transitionRunPresentation: (transition) => {
      if (!open || transition.runId !== runId) return { outcome: 'stale' };
      const result = transitionPresentationCopy(copy, transition, Date.now());
      if (result.outcome === 'applied') copy = result.presentation;
      return result;
    },
  };
  const admitted = input.presentation.currentActivity!;
  const write = input.client().then((client) => presentAdmittedSlackActivity({
    client,
    state,
    runId,
    runFencingToken,
    workspaceId: root.workspaceId,
    channelId: root.channelId,
    threadTs: root.threadTs,
    requesterUserId: root.requesterUserId,
    owner,
    agentId: input.agentId,
    activity: activityStatus(admitted.kind, admitted.action, admitted.object, admitted.family, admitted.phase),
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const shown = await Promise.race([
    write.catch(() => false),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), input.capMs ?? ADMISSION_STATUS_CAP_MS);
    }),
  ]);
  clearTimeout(timer);
  open = false;
  const at = Date.now();
  return shown && input.commit(copy)
    ? { waitedMs: at - startedAt, shownAt: at }
    : { waitedMs: at - startedAt };
}
