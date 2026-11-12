import assert from 'node:assert/strict';

import type { IdentityStore } from '../../src/identity/types.ts';
import type { WorkspaceManagementService } from '../../src/management/service.ts';
import { resolveSlackApprovalActor } from '../../src/management/slack-approval.ts';
import type { SlackManagementSignal } from '../../src/management/slack-tools.ts';
import type { WorkspaceManagementToolResult } from '../../src/management/tool-adapter.ts';
import type { ManagementActorContext } from '../../src/management/types.ts';
import { confirmThroughService } from './management-service-result.ts';

/**
 * The person's typed "approve" or Approve click on this signal's turn, as the
 * Slack host applies it (executeHostSlackManagementApproval): the service
 * confirms it for the approving person.
 */
export function approveAsPerson(input: {
  signal: SlackManagementSignal;
  identity: Pick<IdentityStore, 'resolveSlackIdentity'>;
  service: WorkspaceManagementService;
  args: { proposalId: string };
}): Promise<WorkspaceManagementToolResult> {
  const { proposalId } = input.args;
  return confirmThroughService(input.service, () => resolveSlackApprovalActor(input.signal, input.identity, proposalId), proposalId);
}

/** A Slack actor context carrying the host's stamp for the person's approval of one proposal. */
export function withPersonApproval(
  context: ManagementActorContext,
  proposalId: string,
): ManagementActorContext {
  assert.equal(context.origin.kind, 'slack');
  return { ...context, origin: { ...context.origin, approvedProposalId: proposalId } };
}
