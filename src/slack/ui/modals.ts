import type { SlackUiAction, SlackUiViewSubmission } from './interaction-payload.ts';
import {
  encodeFormValues,
  FORM_VIEW_CALLBACK_ID,
  formFieldActionId,
  formFieldBlockId,
  formLayout,
  formModalView,
  MAX_OTHER_ANSWER,
  OTHER_ANSWER_VIEW_CALLBACK_ID,
  otherAnswerModalView,
  readFormSubmission,
} from './render-form.ts';
import {
  QUESTION_OTHER_CHOICE,
  questionTakesOtherAnswer,
  type InteractiveAnswer,
} from './render-interactive.ts';
import { parseUiControl, type ParsedUiControl, type UiSurfaceRecord } from './surface.ts';

/**
 * Modals are decided when Slack's request arrives, because a `trigger_id`
 * lasts three seconds and a submission's field errors must be the HTTP answer.
 * Both decisions read only the stored surface, so the direct handler and a
 * gateway session's receipt give the same answer; anything they cannot answer
 * goes through ordinary click admission, which explains it to the clicker.
 */

const MODAL_CONTROLS = new Set(['form_open', 'question_other']);
const SURFACE_ID = /^[a-f0-9]{32}$/;

export function isModalControl(control: ParsedUiControl | undefined): boolean {
  return Boolean(control && control.namespace === 'ui' && MODAL_CONTROLS.has(control.kind));
}

function answerFrom(surface: UiSurfaceRecord): 'requester' | 'thread' {
  const spec = surface.spec;
  if (spec.kind === 'question') return spec.question.answerFrom;
  if (spec.kind === 'form') return spec.form.answerFrom;
  return 'requester';
}

/** Whether this person may answer the surface at all (answerFrom). */
export function surfaceMayAnswer(surface: UiSurfaceRecord, userId: string): boolean {
  return answerFrom(surface) === 'thread' || userId === surface.requesterUserId;
}

function isOpen(surface: UiSurfaceRecord, now: number): boolean {
  return (surface.status === 'open' || surface.status === 'pending_delivery') && surface.expiresAt > now;
}

/**
 * The modal a Fill in or "Something else…" click opens, or undefined when the
 * click should instead be refused through ordinary admission.
 */
export function modalForClick(
  action: SlackUiAction,
  surface: UiSurfaceRecord | undefined,
  now = Date.now(),
): Record<string, unknown> | undefined {
  const control = parseUiControl(action);
  if (!control || !isModalControl(control) || !surface) return undefined;
  if (surface.id !== control.surfaceId || surface.namespace !== 'ui' ||
      surface.workspaceId !== action.workspaceId) return undefined;
  if (action.containerType !== 'message' || action.isEphemeral || action.channelId !== surface.channelId ||
      !action.messageTs || (surface.messageTs && surface.messageTs !== action.messageTs)) return undefined;
  if (!isOpen(surface, now) || !surfaceMayAnswer(surface, action.userId)) return undefined;
  const spec = surface.spec;
  if (control.kind === 'form_open' && spec.kind === 'form' && formLayout(spec.form) === 'modal') {
    return formModalView(surface, spec.form);
  }
  if (control.kind === 'question_other' && spec.kind === 'question' && questionTakesOtherAnswer(spec.question)) {
    return otherAnswerModalView(surface, spec.question.question);
  }
  return undefined;
}

/** The surface a submitted host modal names, if the metadata is one. */
export function viewSubmissionSurfaceId(submission: Pick<SlackUiViewSubmission, 'privateMetadata'>): string | undefined {
  return SURFACE_ID.test(submission.privateMetadata) ? submission.privateMetadata : undefined;
}

export type ViewSubmissionReading =
  | { ok: true; surface: UiSurfaceRecord; answer: InteractiveAnswer }
  | { ok: false; responseAction: Record<string, unknown> };

/**
 * Validate a submitted modal against the stored surface. Field problems, and
 * a form that can no longer be answered, come back as Slack `errors` so the
 * person sees them in the modal; only a valid answer goes on to admission.
 */
export function readViewSubmission(
  submission: SlackUiViewSubmission,
  surface: UiSurfaceRecord | undefined,
  now = Date.now(),
): ViewSubmissionReading {
  const surfaceId = viewSubmissionSurfaceId(submission);
  const first = surfaceId ? formFieldBlockId(surfaceId, 0) : undefined;
  const refuse = (message: string): ViewSubmissionReading => ({
    ok: false,
    // Without a surface there is no field to hang the message on; clearing
    // closes the modal, and the card in the thread still shows its state.
    responseAction: first
      ? { response_action: 'errors', errors: { [first]: message } }
      : { response_action: 'clear' },
  });
  if (!surfaceId || !surface || surface.id !== surfaceId || surface.namespace !== 'ui' ||
      surface.workspaceId !== submission.workspaceId) {
    return refuse('This is no longer available. Reply in the thread instead.');
  }
  if (surface.status === 'resolved') return refuse('This was already answered. Close this window.');
  if (!isOpen(surface, now)) return refuse('This has closed. Reply in the thread instead.');
  if (!surfaceMayAnswer(surface, submission.userId)) {
    return refuse('Only the person it was meant for can answer this. You can reply in the thread.');
  }
  const spec = surface.spec;
  if (submission.callbackId === FORM_VIEW_CALLBACK_ID && spec.kind === 'form' && formLayout(spec.form) === 'modal') {
    const read = readFormSubmission(surface, spec.form, submission.state);
    if (!read.ok) return { ok: false, responseAction: { response_action: 'errors', errors: read.errors } };
    return { ok: true, surface, answer: { choice: 0, values: encodeFormValues(read.values) } };
  }
  if (submission.callbackId === OTHER_ANSWER_VIEW_CALLBACK_ID && spec.kind === 'question' &&
      questionTakesOtherAnswer(spec.question)) {
    const value = submission.state[first!]?.[formFieldActionId(0)]?.value;
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return refuse('Write your answer, or close this window.');
    if (text.length > MAX_OTHER_ANSWER) return refuse('Keep this to 2,000 characters.');
    return { ok: true, surface, answer: { choice: QUESTION_OTHER_CHOICE, values: [text] } };
  }
  return refuse('This is no longer available. Reply in the thread instead.');
}
