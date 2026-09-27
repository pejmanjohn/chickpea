import { isModalControl, modalForClick, readViewSubmission, viewSubmissionSurfaceId } from '../ui/modals.ts';
import { parseUiControl, type UiSurfaceRecord } from '../ui/surface.ts';
import type { GatewayInboundDelivery, GatewayInteractionReceipt } from './protocol.ts';

/**
 * Gateway deliveries the session answers in its ack rather than its inbox: a
 * click that opens a modal (`openView`, while the trigger_id is still valid)
 * and a modal submission that Slack must answer with field errors
 * (`responseAction`). Each reads one stored surface; everything else,
 * including a click whose modal cannot open, is admitted as usual.
 */
export function gatewayReceiptSurfaceId(delivery: GatewayInboundDelivery): { surfaceId: string | undefined } | undefined {
  if (delivery.kind === 'interaction.view_submission') return { surfaceId: viewSubmissionSurfaceId(delivery) };
  if (delivery.kind !== 'interaction.ui_action') return undefined;
  const control = parseUiControl(delivery);
  return control && isModalControl(control) ? { surfaceId: control.surfaceId } : undefined;
}

export function gatewayUiReceipt(
  delivery: GatewayInboundDelivery,
  surface: UiSurfaceRecord | undefined,
  now = Date.now(),
): GatewayInteractionReceipt | undefined {
  if (delivery.kind === 'interaction.ui_action') {
    const view = modalForClick(delivery, surface, now);
    return view ? { outcome: 'accepted', interaction: { openView: view } } : undefined;
  }
  if (delivery.kind === 'interaction.view_submission') {
    const reading = readViewSubmission(delivery, surface, now);
    return reading.ok ? undefined : { outcome: 'accepted', interaction: { responseAction: reading.responseAction } };
  }
  return undefined;
}

/** Answer at receipt when the delivery calls for it; undefined means admit it. */
export async function answerGatewayUiAtReceipt(
  delivery: GatewayInboundDelivery,
  readSurface: (id: string) => Promise<UiSurfaceRecord | undefined> | UiSurfaceRecord | undefined,
): Promise<GatewayInteractionReceipt | undefined> {
  const target = gatewayReceiptSurfaceId(delivery);
  if (!target) return undefined;
  const surface = target.surfaceId ? await readSurface(target.surfaceId) : undefined;
  return gatewayUiReceipt(delivery, surface);
}

/** The same answer from a synchronous store (the Durable Object's own table). */
export function gatewayUiReceiptNow(
  delivery: GatewayInboundDelivery,
  surfaces: { get(id: string): UiSurfaceRecord | undefined },
): GatewayInteractionReceipt | undefined {
  const target = gatewayReceiptSurfaceId(delivery);
  if (!target) return undefined;
  return gatewayUiReceipt(delivery, target.surfaceId ? surfaces.get(target.surfaceId) : undefined);
}
