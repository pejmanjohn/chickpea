import { randomUUID } from 'node:crypto';

import {
  AgentExistsError,
  AgentRevisionConflictError,
  AgentStillReferencedError,
  ChannelAssignmentConflictError,
  ChannelRevisionConflictError,
  UnknownAgentError,
} from '../config/errors.ts';
import type { ConfigAgentPatch, ConfigStore } from '../config/store.ts';
import type { ChannelConfig, CustomAgentConfig } from '../config/types.ts';
import type { IdentityStore, Membership } from '../identity/types.ts';
import {
  canonicalJson,
  effectiveConfigurationRevision,
  managementOperationDigest,
  managementOriginKey,
  validateManagementOperations,
} from './contracts.ts';
import { classifyManagementOperation } from './policy.ts';
import type { ManagementStore } from './store.ts';
import {
  ManagementError,
  type ApplyWorkspaceChangesInput,
  type ConfirmWorkspaceChangeInput,
  type LiveManagementActor,
  type ManagementApplyResult,
  type ManagementItemOutcome,
  type ManagementObjectRef,
  type ManagementOperation,
  type ManagementPreparedItem,
  type ManagementProposalRecord,
  type ManagementRequestProgress,
  type ManagementWorkspaceSnapshot,
  type UndoWorkspaceChangeInput,
} from './types.ts';

const PROPOSAL_TTL_MS = 15 * 60_000;

export interface WorkspaceManagementServiceInput {
  identity: Pick<
    IdentityStore,
    | 'getMembership'
    | 'getMembershipAccessOverlay'
    | 'updateMembershipAuthority'
  >;
  config: Pick<
    ConfigStore,
    | 'listAgents'
    | 'getAgent'
    | 'createAgent'
    | 'updateAgent'
    | 'deleteAgent'
    | 'listChannels'
    | 'getChannel'
    | 'putChannel'
    | 'putChannelPlacement'
    | 'getAssignment'
    | 'getAgentReferences'
  >;
  management: ManagementStore;
  now?: () => number;
  randomId?: () => string;
}

interface ImmediateMutation {
  changed: ManagementObjectRef[];
  inverse?: ManagementOperation;
  resultingRevisions: Record<string, number>;
}

/**
 * One requester-bound control plane shared by MCP, Slack, and Admin adapters.
 * Adapters supply trusted actor context; this service re-checks that authority
 * against live identity state on every call.
 */
export class WorkspaceManagementService {
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(private readonly stores: WorkspaceManagementServiceInput) {
    this.now = stores.now ?? Date.now;
    this.randomId = stores.randomId ?? randomUUID;
  }

  async inspectWorkspace(
    context: ApplyWorkspaceChangesInput['context'],
  ): Promise<ManagementWorkspaceSnapshot> {
    await this.requireLiveActor(context);
    return this.snapshot(context.organizationId);
  }

  async applyWorkspaceChanges(input: ApplyWorkspaceChangesInput): Promise<ManagementApplyResult> {
    const actor = await this.requireLiveActor(input.context);
    const operations = validateManagementOperations(input.operations);
    const at = this.now();
    const reservation = await this.stores.management.reserveRequest({
      operationId: `management_${this.randomId()}`,
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      originKey: managementOriginKey(actor.origin),
      idempotencyKey: input.idempotencyKey,
      digest: managementOperationDigest(operations),
      operations,
      at,
    });
    if (reservation.request.status === 'completed' && reservation.request.result) {
      return reservation.request.result;
    }
    if (reservation.request.status === 'failed') {
      throw new ManagementError('operation_in_progress', 'The prior operation did not complete.');
    }

    let request = await this.stores.management.markRequestApplying(
      reservation.request.operationId,
      at,
    );
    let progress = request.progress;
    const clientRefs = agentClientRefs(request.operations);

    for (let index = progress.nextIndex; index < request.operations.length; index += 1) {
      const storedOperation = request.operations[index]!;
      const operation = resolveClientReferences(storedOperation, clientRefs);
      const dependencyFailed = (storedOperation.dependsOn ?? []).some((itemId) =>
        progress.outcomes.find((outcome) => outcome.itemId === itemId)?.disposition !== 'applied');
      if (dependencyFailed) {
        progress = appendOutcome(progress, index, {
          itemId: operation.itemId,
          operationKind: operation.kind,
          disposition: 'skipped',
          code: 'dependency_not_applied',
        });
        request = await this.stores.management.saveRequestProgress(
          request.operationId,
          progress,
          this.now(),
        );
        continue;
      }

      try {
        const facts = await this.policyFacts(actor, operation, request.operations, clientRefs);
        const policy = classifyManagementOperation(facts);
        if (!policy.allowed) {
          progress = appendOutcome(progress, index, {
            itemId: operation.itemId,
            operationKind: operation.kind,
            disposition: 'failed',
            code: policy.reason,
          });
        } else if (policy.posture === 'confirmation') {
          const proposal = await this.createProposal(actor, operation, policy.reason);
          progress = appendOutcome(progress, index, {
            itemId: operation.itemId,
            operationKind: operation.kind,
            disposition: 'confirmation_required',
            proposalId: proposal.proposalId,
          });
        } else {
          const mutation = await this.executeProgressiveItem(request.operationId, operation, progress);
          progress = appendOutcome(progress, index, {
            itemId: operation.itemId,
            operationKind: operation.kind,
            disposition: 'applied',
            changed: mutation.changed,
          });
          if (request.operations.length === 1 && mutation.inverse) {
            await this.stores.management.putUndo({
              operationId: request.operationId,
              organizationId: actor.organizationId,
              actorUserId: actor.userId,
              inverse: mutation.inverse,
              resultingRevisions: mutation.resultingRevisions,
              status: 'available',
              createdAt: this.now(),
              updatedAt: this.now(),
            });
            progress.outcomes[progress.outcomes.length - 1]!.undoAvailable = true;
          }
        }
        request = await this.stores.management.saveRequestProgress(
          request.operationId,
          progress,
          this.now(),
        );
      } catch (error) {
        if (!isExpectedMutationError(error)) throw error;
        progress = appendOutcome(progress, index, {
          itemId: operation.itemId,
          operationKind: operation.kind,
          disposition: 'failed',
          code: mutationErrorCode(error),
        });
        request = await this.stores.management.saveRequestProgress(
          request.operationId,
          progress,
          this.now(),
        );
      }
    }

    const result = await this.resultFor(request.operationId, input.idempotencyKey, progress.outcomes);
    const completed = await this.stores.management.completeRequest(
      request.operationId,
      result,
      this.now(),
    );
    return completed.result ?? result;
  }

  async confirmWorkspaceChange(input: ConfirmWorkspaceChangeInput): Promise<ManagementApplyResult> {
    const actor = await this.requireLiveActor(input.context);
    const existing = await this.stores.management.getProposal(input.proposalId);
    if (existing?.status === 'completed' && existing.result) return existing.result;
    if (existing?.status === 'applying') {
      const reconciled = await this.reconcileConfirmed(existing);
      if (reconciled) {
        const completed = await this.stores.management.completeProposal(
          existing.proposalId,
          reconciled,
          this.now(),
        );
        return completed.result ?? reconciled;
      }
      throw new ManagementError('operation_in_progress', 'The confirmation is already applying.');
    }
    const proposal = await this.stores.management.claimProposal({
      proposalId: input.proposalId,
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      originKey: managementOriginKey(actor.origin),
      at: this.now(),
    });
    try {
      await this.assertTargetRevisions(proposal);
    } catch (error) {
      await this.stores.management.markProposalStale(proposal.proposalId, this.now());
      throw error;
    }

    const mutation = await this.executeConfirmed(actor, proposal.operation, proposal.proposalId);
    const result = await this.resultFor(
      proposal.proposalId,
      `confirmation:${proposal.proposalId}`,
      [{
        itemId: proposal.operation.itemId,
        operationKind: proposal.operation.kind,
        disposition: 'applied',
        changed: mutation.changed,
      }],
    );
    const completed = await this.stores.management.completeProposal(
      proposal.proposalId,
      result,
      this.now(),
    );
    return completed.result ?? result;
  }

  async undoWorkspaceChange(input: UndoWorkspaceChangeInput): Promise<ManagementApplyResult> {
    const actor = await this.requireLiveActor(input.context);
    const undo = await this.stores.management.getUndo(input.operationId);
    if (!undo || undo.status !== 'available' || undo.organizationId !== actor.organizationId ||
        undo.actorUserId !== actor.userId) {
      throw new ManagementError('undo_unavailable', 'No undo action is available.');
    }
    await this.assertRevisionMap(undo.resultingRevisions);
    const result = await this.applyWorkspaceChanges({
      context: input.context,
      idempotencyKey: input.idempotencyKey,
      operations: [undo.inverse],
    });
    await this.stores.management.consumeUndo(input.operationId, this.now());
    return result;
  }

  async getOperation(
    context: ApplyWorkspaceChangesInput['context'],
    operationId: string,
  ): Promise<ManagementApplyResult | undefined> {
    const actor = await this.requireLiveActor(context);
    const request = await this.stores.management.getRequest(operationId);
    if (request) {
      if (request.organizationId !== actor.organizationId || request.actorUserId !== actor.userId) {
        throw new ManagementError('operation_not_found', 'The management operation was not found.');
      }
      return request.result;
    }
    const proposal = await this.stores.management.getProposal(operationId);
    if (!proposal || proposal.organizationId !== actor.organizationId ||
        proposal.actorUserId !== actor.userId) {
      throw new ManagementError('operation_not_found', 'The management operation was not found.');
    }
    return proposal.result;
  }

  private async requireLiveActor(
    context: ApplyWorkspaceChangesInput['context'],
  ): Promise<LiveManagementActor> {
    const [membership, overlay] = await Promise.all([
      this.stores.identity.getMembership(context.membershipId),
      this.stores.identity.getMembershipAccessOverlay(context.membershipId),
    ]);
    if (!membership || membership.id !== context.membershipId ||
        membership.userId !== context.userId ||
        membership.organizationId !== context.organizationId ||
        membership.status !== 'active' ||
        (overlay && (overlay.organizationId !== context.organizationId ||
          overlay.accessStatus !== 'active'))) {
      throw new ManagementError('forbidden', 'Workspace management is not available.');
    }
    return { ...context, role: membership.role };
  }

  private async snapshot(organizationId = ''): Promise<ManagementWorkspaceSnapshot> {
    const [agents, channels] = await Promise.all([
      this.stores.config.listAgents(),
      this.stores.config.listChannels(),
    ]);
    const placements = await Promise.all(channels.map((channel) =>
      this.stores.config.getAssignment(channel.workspaceId, channel.channelId)));
    const refs: ManagementObjectRef[] = [
      ...agents.map((agent) => ({ kind: 'agent' as const, id: agent.id, revision: agent.revision })),
      ...channels.map((channel) => ({
        kind: 'channel' as const,
        id: channelKey(channel.workspaceId, channel.channelId),
        revision: channel.revision ?? 1,
      })),
    ];
    return {
      organizationId,
      agents: agents.map(({ id, revision, name, enabled, model }) => ({
        id,
        revision,
        name,
        enabled,
        ...(model ? { model } : {}),
      })),
      channels: channels.map((channel, index) => ({
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        revision: channel.revision ?? 1,
        ...(channel.label ? { label: channel.label } : {}),
        lifecycle: channel.lifecycle,
        ...(placements[index] ? { agentId: placements[index]!.agentId } : {}),
      })),
      effectiveRevision: effectiveConfigurationRevision(refs),
    };
  }

  private async resultFor(
    operationId: string,
    idempotencyKey: string,
    outcomes: ManagementItemOutcome[],
  ): Promise<ManagementApplyResult> {
    const snapshot = await this.snapshot();
    const hasConfirmation = outcomes.some(({ disposition }) => disposition === 'confirmation_required');
    const hasFailure = outcomes.some(({ disposition }) =>
      disposition === 'failed' || disposition === 'skipped');
    return {
      operationId,
      idempotencyKey,
      status: hasFailure ? 'partial' : hasConfirmation ? 'confirmation_required' : 'completed',
      outcomes,
      effectiveRevision: snapshot.effectiveRevision,
      activation: 'next_turn',
    };
  }

  private async policyFacts(
    actor: LiveManagementActor,
    operation: ManagementOperation,
    requestOperations: ManagementOperation[],
    clientRefs: Map<string, string>,
  ) {
    if (operation.kind === 'update_member') return { actor, operation };
    if (operation.kind === 'update_agent') {
      const currentAgent = await this.stores.config.getAgent(operation.agentId);
      const agentReferences = await this.stores.config.getAgentReferences(operation.agentId);
      return {
        actor,
        operation,
        currentAgent,
        agentReferences,
        capabilityScopeExpanded: capabilityScopeExpanded(currentAgent, operation.patch),
      };
    }
    if (operation.kind === 'delete_agent') {
      return {
        actor,
        operation,
        currentAgent: await this.stores.config.getAgent(operation.agentId),
        agentReferences: await this.stores.config.getAgentReferences(operation.agentId),
      };
    }
    if (operation.kind === 'put_channel') {
      const currentChannelLifecycle = (await this.stores.config.getChannel(
        operation.channel.workspaceId,
        operation.channel.channelId,
      ))?.lifecycle;
      return {
        actor,
        operation,
        ...(currentChannelLifecycle ? { currentChannelLifecycle } : {}),
      };
    }
    if (operation.kind === 'place_agent') {
      const initialAgentBundle = Boolean(operation.agentClientRef &&
        clientRefs.has(operation.agentClientRef) &&
        requestOperations.some((candidate) =>
          candidate.kind === 'create_agent' && candidate.clientRef === operation.agentClientRef));
      return { actor, operation, initialAgentBundle };
    }
    return { actor, operation };
  }

  private async createProposal(
    actor: LiveManagementActor,
    operation: ManagementOperation,
    reason: string,
  ): Promise<ManagementProposalRecord> {
    const at = this.now();
    return this.stores.management.putProposal({
      proposalId: `proposal_${this.randomId()}`,
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      originKey: managementOriginKey(actor.origin),
      operation,
      summary: proposalSummary(operation, reason),
      targetRevisions: await this.targetRevisions(operation),
      expiresAt: at + PROPOSAL_TTL_MS,
      at,
    });
  }

  private async executeProgressiveItem(
    requestId: string,
    operation: ManagementOperation,
    progress: ManagementRequestProgress,
  ): Promise<ImmediateMutation> {
    const prepared = progress.prepared?.itemId === operation.itemId
      ? progress.prepared
      : await this.prepareItem(operation);
    if (!progress.prepared) {
      await this.stores.management.saveRequestProgress(requestId, { ...progress, prepared }, this.now());
    }
    const reconciled = await this.reconcilePrepared(prepared);
    return reconciled ?? this.executeImmediate(operation, prepared);
  }

  private async prepareItem(operation: ManagementOperation): Promise<ManagementPreparedItem> {
    switch (operation.kind) {
      case 'create_agent': {
        const intendedAfter = { ...operation.agent, revision: 1 } satisfies CustomAgentConfig;
        return {
          itemId: operation.itemId,
          operation,
          intendedAfter,
          inverse: {
            itemId: `undo_${operation.itemId}`,
            kind: 'delete_agent',
            agentId: operation.agent.id,
            expectedRevision: 1,
          },
        };
      }
      case 'update_agent': {
        const before = await this.stores.config.getAgent(operation.agentId);
        requireExpectedRevision(operation.expectedRevision, before.revision);
        return {
          itemId: operation.itemId,
          operation,
          before,
          intendedAfter: applyAgentPatch(before, operation.patch),
          inverse: {
            itemId: `undo_${operation.itemId}`,
            kind: 'update_agent',
            agentId: before.id,
            expectedRevision: before.revision + 1,
            patch: fullAgentPatch(before),
          },
        };
      }
      case 'put_channel': {
        const before = await this.stores.config.getChannel(
          operation.channel.workspaceId,
          operation.channel.channelId,
        );
        requireExpectedRevision(operation.expectedRevision, before?.revision ?? 0);
        const intendedAfter = {
          ...operation.channel,
          revision: (before?.revision ?? 0) + 1,
        };
        return {
          itemId: operation.itemId,
          operation,
          ...(before ? { before } : {}),
          intendedAfter,
          ...(before ? {
            inverse: {
              itemId: `undo_${operation.itemId}`,
              kind: 'put_channel',
              channel: before,
              expectedRevision: intendedAfter.revision,
            } satisfies ManagementOperation,
          } : {}),
        };
      }
      case 'place_agent': {
        const [beforeChannel, assignment] = await Promise.all([
          this.stores.config.getChannel(operation.workspaceId, operation.channelId),
          this.stores.config.getAssignment(operation.workspaceId, operation.channelId),
        ]);
        if (!beforeChannel) {
          throw new ManagementError('revision_conflict', 'The Channel does not exist.');
        }
        requireExpectedRevision(operation.expectedRevision, beforeChannel.revision ?? 1);
        if ((assignment?.agentId ?? null) !== operation.expectedAgentId) {
          throw new ChannelAssignmentConflictError(
            operation.workspaceId,
            operation.channelId,
            operation.expectedAgentId,
            assignment?.agentId ?? null,
          );
        }
        const intendedAfter = {
          channel: { ...beforeChannel, revision: (beforeChannel.revision ?? 1) + 1 },
          agentId: operation.agentId ?? null,
        };
        return {
          itemId: operation.itemId,
          operation,
          before: { channel: beforeChannel, agentId: assignment?.agentId ?? null },
          intendedAfter,
          inverse: {
            itemId: `undo_${operation.itemId}`,
            kind: 'place_agent',
            workspaceId: operation.workspaceId,
            channelId: operation.channelId,
            expectedRevision: intendedAfter.channel.revision,
            expectedAgentId: intendedAfter.agentId,
            agentId: assignment?.agentId ?? null,
          },
        };
      }
      default:
        return { itemId: operation.itemId, operation };
    }
  }

  private async executeImmediate(
    operation: ManagementOperation,
    prepared: ManagementPreparedItem,
  ): Promise<ImmediateMutation> {
    switch (operation.kind) {
      case 'create_agent': {
        const agent = await this.stores.config.createAgent(operation.agent);
        return mutationForAgent(agent, prepared.inverse);
      }
      case 'update_agent': {
        const agent = await this.stores.config.updateAgent(
          operation.agentId,
          operation.patch,
          operation.expectedRevision,
        );
        return mutationForAgent(agent, prepared.inverse);
      }
      case 'put_channel': {
        const channel = await this.stores.config.putChannel(
          operation.channel,
          operation.expectedRevision,
        );
        return mutationForChannel(channel, prepared.inverse);
      }
      case 'place_agent': {
        const current = await this.stores.config.getChannel(operation.workspaceId, operation.channelId);
        if (!current) throw new ManagementError('revision_conflict', 'The Channel does not exist.');
        const placed = await this.stores.config.putChannelPlacement({
          channel: current,
          agentId: operation.agentId ?? null,
          expectedAgentId: operation.expectedAgentId,
          expectedRevision: operation.expectedRevision,
        });
        return mutationForChannel(placed.channel, prepared.inverse);
      }
      default:
        throw new ManagementError('invalid_request', 'This operation cannot apply immediately.');
    }
  }

  private async reconcilePrepared(prepared: ManagementPreparedItem): Promise<ImmediateMutation | undefined> {
    const operation = prepared.operation;
    if (!prepared.intendedAfter) return undefined;
    if (operation.kind === 'create_agent' || operation.kind === 'update_agent') {
      const agentId = operation.kind === 'create_agent' ? operation.agent.id : operation.agentId;
      const current = await optionalAgent(this.stores.config, agentId);
      if (current && canonicalJson(current) === canonicalJson(prepared.intendedAfter)) {
        return mutationForAgent(current, prepared.inverse);
      }
      return undefined;
    }
    if (operation.kind === 'put_channel') {
      const current = await this.stores.config.getChannel(
        operation.channel.workspaceId,
        operation.channel.channelId,
      );
      if (current && canonicalJson(current) === canonicalJson(prepared.intendedAfter)) {
        return mutationForChannel(current, prepared.inverse);
      }
      return undefined;
    }
    if (operation.kind === 'place_agent') {
      const [channel, assignment] = await Promise.all([
        this.stores.config.getChannel(operation.workspaceId, operation.channelId),
        this.stores.config.getAssignment(operation.workspaceId, operation.channelId),
      ]);
      const intended = prepared.intendedAfter as { channel: ChannelConfig; agentId: string | null };
      if (channel && canonicalJson(channel) === canonicalJson(intended.channel) &&
          (assignment?.agentId ?? null) === intended.agentId) {
        return mutationForChannel(channel, prepared.inverse);
      }
    }
    return undefined;
  }

  private async executeConfirmed(
    actor: LiveManagementActor,
    operation: ManagementOperation,
    proposalId: string,
  ): Promise<ImmediateMutation> {
    if (operation.kind === 'delete_agent') {
      const references = await this.stores.config.getAgentReferences(operation.agentId);
      if (references.dmIdentityIds.length || references.identityReferenceIds.length) {
        throw new AgentStillReferencedError(
          operation.agentId,
          [...references.dmIdentityIds, ...references.identityReferenceIds].join(', '),
        );
      }
      const changed: ManagementObjectRef[] = [];
      for (const placement of references.channelAssignments) {
        const channel = await this.stores.config.getChannel(placement.workspaceId, placement.channelId);
        if (!channel) throw new ManagementError('proposal_stale', 'A placed Channel changed.');
        const result = await this.stores.config.putChannelPlacement({
          channel,
          agentId: null,
          expectedAgentId: operation.agentId,
          expectedRevision: channel.revision ?? 1,
        });
        changed.push({
          kind: 'channel',
          id: channelKey(placement.workspaceId, placement.channelId),
          revision: result.channel.revision ?? 1,
        });
      }
      await this.stores.config.deleteAgent(operation.agentId, operation.expectedRevision);
      changed.push({ kind: 'agent', id: operation.agentId });
      return { changed, resultingRevisions: Object.fromEntries(changed.map((ref) =>
        [objectRevisionKey(ref), ref.revision ?? 0])) };
    }
    if (operation.kind === 'update_member') {
      const result = await this.stores.identity.updateMembershipAuthority({
        membershipId: operation.membershipId,
        ...(operation.role ? { role: operation.role } : {}),
        ...(operation.status ? { status: operation.status } : {}),
        actorMembershipId: actor.membershipId,
        correlationId: proposalId,
        authenticationSurface: actor.origin.kind === 'slack' ? 'slack_event' : 'better_auth',
        reasonCode: 'workspace_management_confirmation',
        idempotencyKey: `management:${proposalId}`,
      });
      const changed = [{
        kind: 'membership' as const,
        id: result.membership.id,
        revision: membershipRevision(result.membership),
      }];
      return {
        changed,
        resultingRevisions: {
          [`membership:${result.membership.id}`]: membershipRevision(result.membership),
        },
      };
    }
    if (operation.kind === 'update_agent' && operation.patch.enabled === false) {
      const current = await this.stores.config.getAgent(operation.agentId);
      const references = await this.stores.config.getAgentReferences(operation.agentId);
      if (current.enabled && (references.dmIdentityIds.length || references.identityReferenceIds.length)) {
        throw new AgentStillReferencedError(
          operation.agentId,
          [...references.dmIdentityIds, ...references.identityReferenceIds].join(', '),
        );
      }
      const changed: ManagementObjectRef[] = [];
      for (const placement of references.channelAssignments) {
        const channel = await this.stores.config.getChannel(placement.workspaceId, placement.channelId);
        if (!channel) throw new ManagementError('proposal_stale', 'A placed Channel changed.');
        const result = await this.stores.config.putChannelPlacement({
          channel,
          agentId: null,
          expectedAgentId: operation.agentId,
          expectedRevision: channel.revision ?? 1,
        });
        changed.push({
          kind: 'channel',
          id: channelKey(placement.workspaceId, placement.channelId),
          revision: result.channel.revision ?? 1,
        });
      }
      const agent = await this.stores.config.updateAgent(
        operation.agentId,
        operation.patch,
        operation.expectedRevision,
      );
      changed.push({ kind: 'agent', id: agent.id, revision: agent.revision });
      return {
        changed,
        resultingRevisions: Object.fromEntries(changed.map((ref) =>
          [objectRevisionKey(ref), ref.revision ?? 0])),
      };
    }
    const prepared = await this.prepareItem(operation);
    return this.executeImmediate(operation, prepared);
  }

  private async targetRevisions(operation: ManagementOperation): Promise<Record<string, number>> {
    if (operation.kind === 'create_agent') return {};
    if (operation.kind === 'update_agent' || operation.kind === 'delete_agent') {
      const target: Record<string, number> = { [`agent:${operation.agentId}`]: operation.expectedRevision };
      if (operation.kind === 'delete_agent' || operation.patch.enabled === false) {
        const references = await this.stores.config.getAgentReferences(operation.agentId);
        for (const placement of references.channelAssignments) {
          const channel = await this.stores.config.getChannel(placement.workspaceId, placement.channelId);
          target[`channel:${channelKey(placement.workspaceId, placement.channelId)}`] = channel?.revision ?? 0;
        }
      }
      return target;
    }
    if (operation.kind === 'put_channel') {
      return { [`channel:${channelKey(operation.channel.workspaceId, operation.channel.channelId)}`]: operation.expectedRevision };
    }
    if (operation.kind === 'place_agent') {
      return { [`channel:${channelKey(operation.workspaceId, operation.channelId)}`]: operation.expectedRevision };
    }
    const membership = await this.stores.identity.getMembership(operation.membershipId);
    return {
      [`membership:${operation.membershipId}`]: membership ? membershipRevision(membership) : 0,
    };
  }

  private async assertTargetRevisions(proposal: ManagementProposalRecord): Promise<void> {
    await this.assertRevisionMap(proposal.targetRevisions);
    if (proposal.operation.kind === 'delete_agent' ||
        (proposal.operation.kind === 'update_agent' && proposal.operation.patch.enabled === false)) {
      const references = await this.stores.config.getAgentReferences(proposal.operation.agentId);
      const expectedChannelKeys = Object.keys(proposal.targetRevisions)
        .filter((key) => key.startsWith('channel:')).sort();
      const actualChannelKeys = references.channelAssignments
        .map((placement) => `channel:${channelKey(placement.workspaceId, placement.channelId)}`)
        .sort();
      if (canonicalJson(expectedChannelKeys) !== canonicalJson(actualChannelKeys)) {
        throw new ManagementError('proposal_stale', 'The Agent placements changed.');
      }
    }
  }

  private async assertRevisionMap(revisions: Record<string, number>): Promise<void> {
    for (const [key, expected] of Object.entries(revisions)) {
      const actual = await this.currentRevision(key);
      if (actual !== expected) {
        throw new ManagementError('proposal_stale', 'The proposed target changed.');
      }
    }
  }

  private async currentRevision(key: string): Promise<number> {
    if (key.startsWith('agent:')) {
      return (await optionalAgent(this.stores.config, key.slice('agent:'.length)))?.revision ?? 0;
    }
    if (key.startsWith('channel:')) {
      const [workspaceId, channelId] = parseChannelKey(key.slice('channel:'.length));
      return (await this.stores.config.getChannel(workspaceId, channelId))?.revision ?? 0;
    }
    if (key.startsWith('membership:')) {
      const membership = await this.stores.identity.getMembership(key.slice('membership:'.length));
      return membership ? membershipRevision(membership) : 0;
    }
    throw new ManagementError('invalid_request', 'Unknown revision target.');
  }

  private async reconcileConfirmed(
    proposal: ManagementProposalRecord,
  ): Promise<ManagementApplyResult | undefined> {
    const operation = proposal.operation;
    let changed: ManagementObjectRef[] | undefined;
    if (operation.kind === 'delete_agent') {
      const current = await optionalAgent(this.stores.config, operation.agentId);
      if (!current) changed = [{ kind: 'agent', id: operation.agentId }];
    } else if (operation.kind === 'update_member') {
      const membership = await this.stores.identity.getMembership(operation.membershipId);
      if (membership && (!operation.role || membership.role === operation.role) &&
          (!operation.status || membership.status === operation.status)) {
        changed = [{
          kind: 'membership',
          id: membership.id,
          revision: membershipRevision(membership),
        }];
      }
    } else if (operation.kind === 'update_agent') {
      const current = await optionalAgent(this.stores.config, operation.agentId);
      if (current?.revision === operation.expectedRevision + 1 &&
          agentPatchMatches(current, operation.patch)) {
        changed = [{ kind: 'agent', id: current.id, revision: current.revision }];
      }
    }
    if (!changed) return undefined;
    return this.resultFor(
      proposal.proposalId,
      `confirmation:${proposal.proposalId}`,
      [{
        itemId: operation.itemId,
        operationKind: operation.kind,
        disposition: 'applied',
        changed,
      }],
    );
  }
}

function appendOutcome(
  progress: ManagementRequestProgress,
  index: number,
  outcome: ManagementItemOutcome,
): ManagementRequestProgress {
  return { nextIndex: index + 1, outcomes: [...progress.outcomes, outcome] };
}

function agentClientRefs(operations: readonly ManagementOperation[]): Map<string, string> {
  return new Map(operations.flatMap((operation) =>
    operation.kind === 'create_agent' && operation.clientRef
      ? [[operation.clientRef, operation.agent.id] as const]
      : []));
}

function resolveClientReferences(
  operation: ManagementOperation,
  clientRefs: Map<string, string>,
): ManagementOperation {
  if (operation.kind !== 'place_agent' || !operation.agentClientRef) return operation;
  const agentId = clientRefs.get(operation.agentClientRef);
  if (!agentId) throw new ManagementError('invalid_request', 'The Agent clientRef was not found.');
  return { ...operation, agentId };
}

function requireExpectedRevision(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new ManagementError('revision_conflict', 'The target revision changed.');
  }
}

function applyAgentPatch(agent: CustomAgentConfig, patch: ConfigAgentPatch): CustomAgentConfig {
  const next = {
    ...agent,
    ...patch,
    revision: agent.revision + 1,
  } as CustomAgentConfig & { model?: string | null; slackIdentityId?: string | null };
  if (patch.model === null) delete next.model;
  if (patch.slackIdentityId === null) delete next.slackIdentityId;
  return next as CustomAgentConfig;
}

function fullAgentPatch(agent: CustomAgentConfig): ConfigAgentPatch {
  return {
    name: agent.name,
    instructions: agent.instructions,
    enabled: agent.enabled,
    model: agent.model ?? null,
    skills: agent.skills,
    mcpServers: agent.mcpServers,
    apiConnections: agent.apiConnections,
    repositories: agent.repositories,
    slackIdentityId: agent.slackIdentityId ?? null,
  };
}

function mutationForAgent(
  agent: CustomAgentConfig,
  inverse?: ManagementOperation,
): ImmediateMutation {
  const changed = [{ kind: 'agent' as const, id: agent.id, revision: agent.revision }];
  return {
    changed,
    ...(inverse ? { inverse } : {}),
    resultingRevisions: { [`agent:${agent.id}`]: agent.revision },
  };
}

function mutationForChannel(
  channel: ChannelConfig,
  inverse?: ManagementOperation,
): ImmediateMutation {
  const revision = channel.revision ?? 1;
  const id = channelKey(channel.workspaceId, channel.channelId);
  const changed = [{ kind: 'channel' as const, id, revision }];
  return {
    changed,
    ...(inverse ? { inverse } : {}),
    resultingRevisions: { [`channel:${id}`]: revision },
  };
}

async function optionalAgent(
  config: Pick<ConfigStore, 'getAgent'>,
  agentId: string,
): Promise<CustomAgentConfig | undefined> {
  try {
    return await config.getAgent(agentId);
  } catch (error) {
    if (error instanceof UnknownAgentError) return undefined;
    throw error;
  }
}

function capabilityScopeExpanded(agent: CustomAgentConfig, patch: ConfigAgentPatch): boolean {
  if (patch.slackIdentityId !== undefined &&
      patch.slackIdentityId !== (agent.slackIdentityId ?? null)) return true;
  if (patch.repositories && containsExpandedRepositories(agent.repositories, patch.repositories)) return true;
  if (patch.mcpServers && containsExpandedMcp(agent.mcpServers, patch.mcpServers)) return true;
  if (patch.apiConnections && containsExpandedApi(agent.apiConnections, patch.apiConnections)) return true;
  return false;
}

function containsExpandedRepositories(
  before: CustomAgentConfig['repositories'],
  after: CustomAgentConfig['repositories'],
): boolean {
  return after.some((grant) => {
    if (!grant.enabled) return false;
    const prior = before.find((candidate) => candidate.fullName === grant.fullName &&
      candidate.accountLogin === grant.accountLogin);
    return !prior?.enabled || Boolean(grant.allRepos && !prior.allRepos);
  });
}

function containsExpandedMcp(
  before: CustomAgentConfig['mcpServers'],
  after: CustomAgentConfig['mcpServers'],
): boolean {
  return after.some((connection) => {
    if (!connection.enabled) return false;
    const prior = before.find(({ id }) => id === connection.id);
    return !prior?.enabled || !isSubset(connection.allowedTools, prior.allowedTools) ||
      !isSubset(scopeTokens(connection.oauthScope), scopeTokens(prior.oauthScope));
  });
}

function containsExpandedApi(
  before: CustomAgentConfig['apiConnections'],
  after: CustomAgentConfig['apiConnections'],
): boolean {
  return after.some((connection) => {
    if (!connection.enabled) return false;
    const prior = before.find(({ id }) => id === connection.id);
    return !prior?.enabled || !isSubset(connection.allowedHosts, prior.allowedHosts) ||
      !isSubset(connection.pathPrefixes, prior.pathPrefixes) ||
      !isSubset(connection.allowedMethods, prior.allowedMethods);
  });
}

function isSubset(values: readonly string[], allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return values.every((value) => set.has(value));
}

function scopeTokens(scope?: string): string[] {
  return scope?.trim().split(/\s+/).filter(Boolean) ?? [];
}

function agentPatchMatches(agent: CustomAgentConfig, patch: ConfigAgentPatch): boolean {
  const expected = applyAgentPatch({ ...agent, revision: agent.revision - 1 }, patch);
  return canonicalJson(agent) === canonicalJson(expected);
}

function proposalSummary(operation: ManagementOperation, reason: string): string {
  const target = operation.kind === 'update_member'
    ? operation.membershipId
    : operation.kind === 'put_channel'
      ? channelKey(operation.channel.workspaceId, operation.channel.channelId)
      : operation.kind === 'place_agent'
        ? channelKey(operation.workspaceId, operation.channelId)
        : operation.kind === 'create_agent'
          ? operation.agent.id
          : operation.agentId;
  return `${reason}:${operation.kind}:${target}`;
}

function channelKey(workspaceId: string, channelId: string): string {
  return `${workspaceId}/${channelId}`;
}

function parseChannelKey(key: string): [string, string] {
  const separator = key.indexOf('/');
  if (separator <= 0 || separator === key.length - 1) {
    throw new ManagementError('invalid_request', 'Invalid Channel revision target.');
  }
  return [key.slice(0, separator), key.slice(separator + 1)];
}

function objectRevisionKey(ref: ManagementObjectRef): string {
  return `${ref.kind}:${ref.id}`;
}

function membershipRevision(membership: Membership): number {
  let hash = 2_166_136_261;
  for (const character of `${membership.id}:${membership.role}:${membership.status}:${membership.updatedAt}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function isExpectedMutationError(error: unknown): boolean {
  return error instanceof ManagementError ||
    error instanceof UnknownAgentError ||
    error instanceof AgentExistsError ||
    error instanceof AgentRevisionConflictError ||
    error instanceof ChannelRevisionConflictError ||
    error instanceof ChannelAssignmentConflictError ||
    error instanceof AgentStillReferencedError;
}

function mutationErrorCode(error: unknown): string {
  if (error instanceof ManagementError) return error.code;
  if (error instanceof AgentRevisionConflictError || error instanceof ChannelRevisionConflictError ||
      error instanceof ChannelAssignmentConflictError) return 'revision_conflict';
  if (error instanceof UnknownAgentError) return 'not_found';
  if (error instanceof AgentExistsError) return 'already_exists';
  if (error instanceof AgentStillReferencedError) return 'still_referenced';
  return 'mutation_failed';
}
