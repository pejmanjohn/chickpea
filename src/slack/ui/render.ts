import {
  interactiveTurnText,
  renderInteractiveSurface,
  type InteractiveAnswer,
} from './render-interactive.ts';
import {
  uiActionId,
  uiBlockId,
  uiValue,
  type HostApprovalSpec,
  type UiSurfaceRecord,
} from './surface.ts';

/**
 * Surfaces render only from their durable record: the open card, the answered
 * card, and the closed card are pure functions of stored state. A redraw never
 * reads blocks echoed back by Slack, so escaping cannot compound across edits.
 */
export interface RenderedUiSurface {
  text: string;
  blocks: Array<Record<string, unknown>>;
}

/** Model- or user-supplied text shown in mrkdwn: no markup and no pings. */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Display text only is ever clamped; ids and values are refused instead. */
export function clampDisplay(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function plain(text: string, max: number): { type: 'plain_text'; text: string; emoji: true } {
  return { type: 'plain_text', text: clampDisplay(text, max), emoji: true };
}

function mrkdwn(text: string): { type: 'mrkdwn'; text: string } {
  return { type: 'mrkdwn', text };
}

function slackTime(at: number): string {
  const seconds = Math.floor(at / 1000);
  const fallback = new Date(at).toISOString().slice(11, 16);
  return `<!date^${seconds}^{time}|${fallback} UTC>`;
}

type ApprovalChoice = 'approve' | 'decline';

/** Approval controls: index 0 approves, index 1 declines (Cancel or Stop). */
export function approvalChoice(index: number): ApprovalChoice | undefined {
  return index === 0 ? 'approve' : index === 1 ? 'decline' : undefined;
}

function approvalPrompt(spec: HostApprovalSpec): string {
  if (spec.approval === 'workspace_change') return '*Apply these workspace changes?*';
  return `*Approve this step?* ${escapeMrkdwn(clampDisplay(spec.description, 200))} on \`${escapeMrkdwn(clampDisplay(spec.host, 120))}\``;
}

function approvalFallback(spec: HostApprovalSpec): string {
  return spec.approval === 'workspace_change'
    ? 'Apply the proposed workspace changes? Use the buttons, or reply approve.'
    : `Approve this step: ${escapeMrkdwn(clampDisplay(spec.description, 200))} on ${escapeMrkdwn(clampDisplay(spec.host, 120))}? Use the buttons, or reply approve or stop.`;
}

function approvalOutcome(spec: HostApprovalSpec, record: UiSurfaceRecord): { text: string; line: string } {
  const resolution = record.resolution!;
  const by = `<@${resolution.byUserId}>`;
  const when = slackTime(resolution.at);
  const via = resolution.typed ? ' (typed reply)' : '';
  if (approvalChoice(resolution.choice) === 'approve') {
    return { text: `Approved by ${by}.`, line: `:white_check_mark: Approved by ${by}${via} · ${when}` };
  }
  const verb = spec.approval === 'browser_step' ? 'Stopped' : 'Cancelled';
  return { text: `${verb} by ${by}.`, line: `:heavy_multiplication_x: ${verb} by ${by}${via} · ${when}` };
}

function renderHostApproval(record: UiSurfaceRecord, spec: HostApprovalSpec): RenderedUiSurface {
  const prompt = {
    type: 'section',
    block_id: uiBlockId('host', record.id, 0),
    text: mrkdwn(approvalPrompt(spec)),
  };
  if (record.status === 'resolved' && record.resolution) {
    const outcome = approvalOutcome(spec, record);
    return {
      text: outcome.text,
      blocks: [prompt, { type: 'context', elements: [mrkdwn(outcome.line)] }],
    };
  }
  if (record.status !== 'open' && record.status !== 'pending_delivery') {
    const line = record.status === 'expired'
      ? 'This approval expired.'
      : 'This approval is closed.';
    return { text: line, blocks: [prompt, { type: 'context', elements: [mrkdwn(line)] }] };
  }
  const approveLabel = spec.approval === 'browser_step' ? 'Approve step' : 'Approve';
  const declineLabel = spec.approval === 'browser_step' ? 'Stop' : 'Cancel';
  const typed = spec.approval === 'browser_step' ? '`approve` or `stop`' : '`approve`';
  return {
    text: approvalFallback(spec),
    blocks: [
      prompt,
      {
        type: 'actions',
        block_id: uiBlockId('host', record.id, 1),
        elements: [
          {
            type: 'button',
            action_id: uiActionId('host', 'approval', 0),
            text: plain(approveLabel, 75),
            style: 'primary',
            value: uiValue(record.id, 0),
          },
          {
            type: 'button',
            action_id: uiActionId('host', 'approval', 1),
            text: plain(declineLabel, 75),
            value: uiValue(record.id, 1),
          },
        ],
      },
      {
        type: 'context',
        elements: [mrkdwn(`Only <@${record.requesterUserId}> can approve · or reply ${typed}`)],
      },
    ],
  };
}

export function renderUiSurface(
  record: UiSurfaceRecord,
  options: { withHeader?: boolean } = {},
): RenderedUiSurface {
  if (record.spec.kind === 'approval') return renderHostApproval(record, record.spec);
  return renderInteractiveSurface(record, options)!;
}

/**
 * The host-authored turn text a click becomes. It names who answered and what,
 * from the stored spec; clicked labels and payload text never reach the model.
 */
export function uiResponseTurnText(record: UiSurfaceRecord, answer: InteractiveAnswer, byUserId: string): string {
  const spec = record.spec;
  if (spec.kind !== 'approval') return interactiveTurnText(record, answer, byUserId);
  const decision = approvalChoice(answer.choice);
  if (spec.approval === 'workspace_change') {
    return decision === 'approve'
      ? 'Approved the proposed workspace changes with the Approve button.'
      : 'Cancelled the proposed workspace changes with the Cancel button. Do not apply them.';
  }
  return decision === 'approve'
    ? `Approved the browser step with the Approve step button: ${spec.description} on ${spec.host}.`
    : `Stopped the browser step with the Stop button: ${spec.description} on ${spec.host}. Do not take it.`;
}
