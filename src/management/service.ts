import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  AgentExistsError,
  AgentRevisionConflictError,
  AgentStillReferencedError,
  ChannelAssignmentConflictError,
  ChannelRevisionConflictError,
  SlackIdentityExistsError,
  SlackIdentityLifecycleError,
  SlackIdentityRevisionConflictError,
  SlackIdentityStillReferencedError,
  UnknownAgentError,
  UnknownSlackIdentityError,
  WorkspaceDefaultSlackIdentityProtectedError,
} from '../config/errors.ts';
import { generateSlackIdentityIngressKey, type ConfigAgentPatch, type ConfigStore } from '../config/store.ts';
import type { ChannelConfig, CustomAgentConfig, SlackIdentity } from '../config/types.ts';
import type { SlackIdentityAuditEventType } from '../audit/types.ts';
import type { IdentityStore, Invitation, Membership } from '../identity/types.ts';
import { ownerMemoryStoreId } from '../memory/ids.ts';
import type {
  MemoryOwnerRef,
  MemoryStateStore,
  OwnerMemoryEntry,
} from '../memory/types.ts';
import { validateMemoryContent } from '../memory/validation.ts';
import {
  normalizeOneTimeSchedule,
  normalizeRoutineSchedule,
} from '../routines/schedule.ts';
import { RoutineService } from '../routines/service.ts';
import type { RoutineDefinition, RoutineStore } from '../routines/types.ts';
import { REQUIRED_SLACK_BOT_SCOPES } from '../slack/scopes.ts';
import type { WorkStore } from '../work/types.ts';
import {
  canonicalJson,
  effectiveConfigurationRevision,
  managementOperationDigest,
  managementOriginKey,
  validateManagementOperations,
} from './contracts.ts';
import { classifyManagementOperation } from './policy.ts';
import {
  exportWorkspaceRecipe,
  previewWorkspaceRecipe,
  type PreviewWorkspaceRecipeInput,
  type WorkspaceRecipe,
  type WorkspaceRecipePreview,
} from './recipes.ts';
import type { ManagementStore } from './store.ts';
import { emitManagementMetric } from './telemetry.ts';
import {
  ManagementError,
  type ApplyWorkspaceChangesInput,
  type ConfirmWorkspaceChangeInput,
  type LiveManagementActor,
  type ManagementApplyResult,
  type ManagementItemOutcome,
  type ManagementMemorySnapshot,
  type ManagementObjectRef,
  type ManagementOperation,
  type ManagementOperationResult,
  type ManagementPreparedItem,
  type ManagementProposalRecord,
  type ManagementRequestProgress,
  type ManagementRoutineInspectionInput,
  type ManagementRoutineSnapshot,
  type ManagementSetupPublicStatus,
  type ManagementSetupRecord,
  type ManagementSetupTarget,
  type ManagementWorkspaceSnapshot,
  type UndoWorkspaceChangeInput,
} from './types.ts';

const PROPOSAL_TTL_MS = 15 * 60_000;
const SETUP_TTL_MS = 24 * 60 * 60_000;
const INVITATION_TTL_MS = 24 * 60 * 60_000;
const MANAGED_PROVIDER_IDS = ['anthropic', 'openai', 'openrouter'] as const;
type ManagedProviderId = typeof MANAGED_PROVIDER_IDS[number];
type ManagedProviderSource = 'env' | 'stored' | 'missing';

export interface WorkspaceManagementServiceInput {
  identity: Pick<
    IdentityStore,
    | 'getMembership'
    | 'getMembershipAccessOverlay'
    | 'updateMembershipAuthority'
    | 'listMemberships'
    | 'listExternalIdentities'
    | 'listInvitations'
    | 'getUser'
    | 'getOrganization'
    | 'createInvitation'
    | 'resendInvitation'
    | 'revokeInvitation'
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
    | 'listSlackIdentities'
    | 'getSlackIdentity'
    | 'getSlackIdentityReferences'
    | 'createSlackIdentity'
    | 'updateSlackIdentity'
    | 'setSlackIdentityDmBinding'
    | 'retireSlackIdentity'
    | 'appendSlackIdentityAudit'
  >;
  management: ManagementStore;
  memory?: Pick<
    MemoryStateStore,
    | 'getOwner'
    | 'listOwnerEntries'
    | 'getOwnerEntry'
    | 'createOwnerEntry'
    | 'updateOwnerEntry'
    | 'forgetOwnerEntry'
  >;
  routines?: RoutineStore;
  work?: Pick<WorkStore, 'getWork' | 'getBinding'>;
  routineSchedulingAvailable?: boolean | (() => boolean | Promise<boolean>);
  setupBaseUrl?: string | (() => string | undefined | Promise<string | undefined>);
  providerCredentialSource?: (
    providerId: ManagedProviderId,
  ) => Promise<ManagedProviderSource>;
  removeProviderCredential?: (
    providerId: ManagedProviderId,
  ) => Promise<ManagedProviderSource>;
  resolveSlackInvitee?: (slackUserId: string) => Promise<{
    slackTeamId: string;
    displayName: string | null;
  }>;
  countPendingSlackIdentityDeliveries?: (identityId: string) => Promise<number>;
  clearSlackIdentityCredentials?: (identityId: string) => Promise<void>;
  cancelSlackIdentitySetup?: (
    identityId: string,
    expectedRevision: number,
  ) => Promise<SlackIdentity>;
  now?: () => number;
  randomId?: () => string;
  randomCapability?: () => string;
}

interface ImmediateMutation {
  changed: ManagementObjectRef[];
  inverse?: ManagementOperation;
  resultingRevisions: Record<string, number>;
  handoffUrl?: string;
}

/**
 * One requester-bound control plane shared by MCP, Slack, and Admin adapters.
 * Adapters supply trusted actor context; this service re-checks that authority
 * against live identity state on every call.
 */
export class WorkspaceManagementService {
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly randomCapability: () => string;

  constructor(private readonly stores: WorkspaceManagementServiceInput) {
    this.now = stores.now ?? Date.now;
    this.randomId = stores.randomId ?? randomUUID;
    this.randomCapability = stores.randomCapability ?? (() => randomBytes(32).toString('base64url'));
  }

  async inspectWorkspace(
    context: ApplyWorkspaceChangesInput['context'],
  ): Promise<ManagementWorkspaceSnapshot> {
    const actor = await this.requireLiveActor(context);
    return this.snapshot(context.organizationId, actor.role === 'owner');
  }

  async inspectMemory(
    context: ApplyWorkspaceChangesInput['context'],
    ownerRef: MemoryOwnerRef,
  ): Promise<ManagementMemorySnapshot> {
    const actor = await this.requireLiveActor(context);
    const owner = await this.requireMemoryOwner(actor, ownerRef);
    const entries = await this.stores.memory!.listOwnerEntries(ownerRef);
    return {
      owner: {
        workspaceId: owner.workspaceId,
        ownerKind: owner.ownerKind,
        ownerId: owner.ownerId,
        storeId: owner.storeId,
        lifecycle: owner.lifecycle,
        resetEpoch: owner.resetEpoch,
      },
      entries: entries.map((entry) => ({
        ...entry,
        body: entry.status === 'forgotten' ? null : entry.body,
      })),
    };
  }

  async inspectRoutines(
    context: ApplyWorkspaceChangesInput['context'],
    input: ManagementRoutineInspectionInput,
  ): Promise<ManagementRoutineSnapshot> {
    const actor = await this.requireLiveActor(context);
    await this.requireWorkspaceScope(actor, input.workspaceId);
    if (!this.stores.routines) {
      throw new ManagementError('invalid_request', 'Routine management is unavailable.');
    }
    let routines = await this.stores.routines.listRoutines(input.workspaceId, input.channelId);
    if (input.routineId) routines = routines.filter(({ id }) => id === input.routineId);
    return {
      routines: await Promise.all(routines.map(async (routine) => {
        const contentAccess = await routineContentAccess(this.stores.work, routine);
        const readable = contentAccess === 'public';
        return {
          id: routine.id,
          workspaceId: routine.workspaceId,
          channelId: routine.channelId,
          creatorUserId: routine.creatorUserId,
          state: routine.deletedAt === null ? routine.state : 'deleted',
          version: routine.version,
          name: readable ? routine.name : null,
          description: readable ? routine.description : null,
          taskText: readable && routine.deletedAt === null ? routine.taskText : null,
          triggerKind: routine.triggerKind,
          scheduleInput: routine.scheduleInput,
          scheduleJson: routine.scheduleJson,
          timezone: routine.timezone,
          outputPolicy: routine.outputPolicy,
          nextRunAt: routine.nextRunAt,
          contentAccess,
        };
      })),
    };
  }

  async exportRecipe(
    context: ApplyWorkspaceChangesInput['context'],
    input: { agentIds?: string[] | undefined },
  ): Promise<WorkspaceRecipe> {
    await this.requireLiveActor(context);
    return exportWorkspaceRecipe(this.stores.config, input);
  }

  async previewRecipe(
    context: ApplyWorkspaceChangesInput['context'],
    input: PreviewWorkspaceRecipeInput,
  ): Promise<WorkspaceRecipePreview> {
    await this.requireLiveActor(context);
    const preview = await previewWorkspaceRecipe(
      this.stores.config,
      async (providerId) => this.stores.providerCredentialSource?.(providerId) ?? 'missing',
      input,
    );
    emitManagementMetric('recipe.preview', {
      surface: context.origin.kind,
      outcome: 'success',
      agentCount: preview.agents.length,
      channelCount: preview.channels.length,
      operationCount: preview.operations.length,
      conflictCount: preview.agents.filter(({ status }) =>
        status === 'conflict' || status === 'ambiguous').length,
      setupRequiredCount: preview.agents.reduce(
        (total, agent) => total + agent.setupRequired.length,
        0,
      ),
    });
    return preview;
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
      return emitOperationOutcomes(actor.origin.kind, reservation.request.result);
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
          withoutSetupCapabilitiesFromProgress(progress),
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
            warning: proposal.summary,
          });
        } else if (operation.kind === 'request_setup') {
          const setup = await this.issueSetup(actor, operation);
          progress = appendOutcome(progress, index, {
            itemId: operation.itemId,
            operationKind: operation.kind,
            disposition: 'setup_required',
            setupOperationId: setup.record.setupOperationId,
            setupUrl: setup.url,
          });
        } else {
          const mutation = await this.executeProgressiveItem(
            actor,
            request.operationId,
            operation,
            progress,
          );
          progress = appendOutcome(progress, index, {
            itemId: operation.itemId,
            operationKind: operation.kind,
            disposition: 'applied',
            changed: mutation.changed,
            ...(mutation.handoffUrl ? { handoffUrl: mutation.handoffUrl } : {}),
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
          withoutSetupCapabilitiesFromProgress(progress),
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
          withoutSetupCapabilitiesFromProgress(progress),
          this.now(),
        );
      }
    }

    const result = await this.resultFor(request.operationId, input.idempotencyKey, progress.outcomes);
    await this.stores.management.completeRequest(
      request.operationId,
      withoutSetupCapabilities(result),
      this.now(),
    );
    return emitOperationOutcomes(actor.origin.kind, result);
  }

  async confirmWorkspaceChange(input: ConfirmWorkspaceChangeInput): Promise<ManagementApplyResult> {
    const actor = await this.requireLiveActor(input.context);
    const existing = await this.stores.management.getProposal(input.proposalId);
    if (existing?.status === 'completed' && existing.result) {
      return emitOperationOutcomes(actor.origin.kind, existing.result);
    }
    if (existing?.status === 'applying') {
      const reconciled = await this.reconcileConfirmed(existing);
      if (reconciled) {
        await this.auditConfirmedSlackIdentityMutation(actor, existing, undefined);
        const completed = await this.stores.management.completeProposal(
          existing.proposalId,
          reconciled,
          this.now(),
        );
        return emitOperationOutcomes(actor.origin.kind, completed.result ?? reconciled);
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

    if (proposal.operation.kind === 'request_setup') {
      const setup = await this.issueSetup(actor, proposal.operation);
      const result = await this.resultFor(
        proposal.proposalId,
        `confirmation:${proposal.proposalId}`,
        [{
          itemId: proposal.operation.itemId,
          operationKind: proposal.operation.kind,
          disposition: 'setup_required',
          setupOperationId: setup.record.setupOperationId,
          setupUrl: setup.url,
        }],
      );
      await this.stores.management.completeProposal(
        proposal.proposalId,
        withoutSetupCapabilities(result),
        this.now(),
      );
      return emitOperationOutcomes(actor.origin.kind, result);
    }

    const identityBefore = proposal.operation.kind === 'retire_slack_identity' ||
        proposal.operation.kind === 'cancel_slack_identity_setup'
      ? await this.stores.config.getSlackIdentity(proposal.operation.identityId)
      : undefined;
    const mutation = await this.executeConfirmed(actor, proposal.operation, proposal.proposalId);
    await this.auditConfirmedSlackIdentityMutation(actor, proposal, identityBefore);
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
    return emitOperationOutcomes(actor.origin.kind, completed.result ?? result);
  }

  private async auditConfirmedSlackIdentityMutation(
    actor: LiveManagementActor,
    proposal: ManagementProposalRecord,
    before: SlackIdentity | undefined,
  ): Promise<void> {
    if (proposal.operation.kind !== 'retire_slack_identity' &&
        proposal.operation.kind !== 'cancel_slack_identity_setup') return;
    const after = await this.stores.config.getSlackIdentity(proposal.operation.identityId);
    await this.appendSlackIdentityAudit(
      actor,
      proposal.proposalId,
      proposal.operation.kind === 'retire_slack_identity'
        ? 'slack_identity.retired'
        : 'slack_identity.setup_canceled',
      before ?? after,
      after,
    );
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
  ): Promise<ManagementOperationResult | undefined> {
    const actor = await this.requireLiveActor(context);
    const request = await this.stores.management.getRequest(operationId);
    if (request) {
      if (request.organizationId !== actor.organizationId || request.actorUserId !== actor.userId) {
        throw new ManagementError('operation_not_found', 'The management operation was not found.');
      }
      return request.result;
    }
    const proposal = await this.stores.management.getProposal(operationId);
    if (proposal) {
      if (proposal.organizationId !== actor.organizationId || proposal.actorUserId !== actor.userId) {
        throw new ManagementError('operation_not_found', 'The management operation was not found.');
      }
      return proposal.result;
    }
    const setup = await this.stores.management.getSetup(operationId, this.now());
    if (!setup || setup.organizationId !== actor.organizationId || setup.actorUserId !== actor.userId) {
      throw new ManagementError('operation_not_found', 'The management operation was not found.');
    }
    return this.setupPublicStatus(setup);
  }

  async revokeSetupLink(
    context: ApplyWorkspaceChangesInput['context'],
    setupOperationId: string,
    reissue = false,
  ): Promise<{ revoked: ManagementSetupPublicStatus; replacement?: { setupOperationId: string; setupUrl: string } }> {
    const actor = await this.requireLiveActor(context);
    const existing = await this.stores.management.getSetup(setupOperationId, this.now());
    if (!existing || existing.organizationId !== actor.organizationId ||
        existing.actorUserId !== actor.userId) {
      throw new ManagementError('setup_not_found', 'The setup operation was not found.');
    }
    const revoked = await this.stores.management.revokeSetup({
      setupOperationId,
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      at: this.now(),
    });
    if (!reissue) return { revoked: await this.setupPublicStatus(revoked) };
    const replacement = await this.issueSetupRecord(actor, {
      action: existing.action,
      target: existing.target,
      scopes: existing.scopes,
      supersedesSetupOperationId: existing.setupOperationId,
    });
    return {
      revoked: await this.setupPublicStatus(revoked),
      replacement: {
        setupOperationId: replacement.record.setupOperationId,
        setupUrl: replacement.url,
      },
    };
  }

  private async setupPublicStatus(
    setup: ManagementSetupRecord,
  ): Promise<ManagementSetupPublicStatus> {
    const outbox = await this.stores.management.getOutboxForOperation(setup.setupOperationId);
    return {
      setupOperationId: setup.setupOperationId,
      action: setup.action,
      target: setup.target,
      scopes: setup.scopes,
      status: setup.status,
      expiresAt: setup.expiresAt,
      ...(setup.receipt ? { receipt: setup.receipt } : {}),
      ...(outbox ? { delivery: { status: outbox.status, attempts: outbox.attempts } } : {}),
    };
  }

  private async issueSetup(
    actor: LiveManagementActor,
    operation: Extract<ManagementOperation, { kind: 'request_setup' }>,
  ): Promise<{ record: ManagementSetupRecord; url: string }> {
    const frozen = await this.resolveSetupTarget(operation.target);
    return this.issueSetupRecord(actor, frozen);
  }

  private async issueSetupRecord(
    actor: LiveManagementActor,
    input: {
      action: ManagementSetupRecord['action'];
      target: ManagementSetupTarget;
      scopes: string[];
      supersedesSetupOperationId?: string;
    },
  ): Promise<{ record: ManagementSetupRecord; url: string }> {
    const baseUrl = await this.resolveSetupBaseUrl();
    const rawCapability = this.randomCapability();
    if (!/^[A-Za-z0-9_-]{43}$/.test(rawCapability)) {
      throw new ManagementError('invalid_request', 'Setup capability generation failed.');
    }
    const at = this.now();
    const record = await this.stores.management.putSetup({
      record: {
        setupOperationId: `setup_${this.randomId()}`,
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        origin: actor.origin,
        action: input.action,
        target: input.target,
        scopes: [...input.scopes],
        tokenDigest: capabilityDigest(rawCapability),
        status: 'pending',
        ...(input.supersedesSetupOperationId
          ? { supersedesSetupOperationId: input.supersedesSetupOperationId }
          : {}),
        expiresAt: at + SETUP_TTL_MS,
        createdAt: at,
        updatedAt: at,
      },
    });
    const url = new URL(`/setup/${encodeURIComponent(record.setupOperationId)}`, baseUrl);
    url.hash = `setup=${rawCapability}`;
    return { record, url: url.href };
  }

  private async resolveSetupBaseUrl(): Promise<string> {
    const configured = typeof this.stores.setupBaseUrl === 'function'
      ? await this.stores.setupBaseUrl()
      : this.stores.setupBaseUrl;
    if (!configured) {
      throw new ManagementError('invalid_request', 'The public setup URL is unavailable.');
    }
    const url = new URL(configured);
    const local = url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !local) {
      throw new ManagementError('invalid_request', 'The public setup URL must use HTTPS.');
    }
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.href;
  }

  private async resolveSetupTarget(
    request: Extract<ManagementOperation, { kind: 'request_setup' }>['target'],
  ): Promise<{
    action: ManagementSetupRecord['action'];
    target: ManagementSetupTarget;
    scopes: string[];
  }> {
    if (request.kind === 'provider_credential') {
      const source = await this.stores.providerCredentialSource?.(request.providerId) ?? 'missing';
      if (source === 'env') {
        throw new ManagementError('invalid_request', 'Deployment-provided credentials are read-only.');
      }
      return {
        action: 'provider_credential',
        target: {
          kind: request.kind,
          provider: request.providerId,
          targetId: `provider:${request.providerId}`,
          targetLabel: `Workspace ${providerLabel(request.providerId)} model provider`,
          expectedRevision: source === 'stored' ? 1 : 0,
          replacement: source === 'stored',
          formFields: ['apiKey'],
        },
        scopes: [`models:${request.providerId}`],
      };
    }

    if (request.kind === 'slack_identity') {
      const identity = await this.stores.config.getSlackIdentity(request.identityId);
      if (identity.kind !== 'dedicated' || identity.lifecycle === 'retired') {
        throw new ManagementError('invalid_request', 'This Slack identity cannot be connected.');
      }
      const replacement = identity.lifecycle === 'connected' || identity.lifecycle === 'degraded';
      return {
        action: 'slack_identity',
        target: {
          kind: request.kind,
          provider: 'slack',
          targetId: `slack_identity:${identity.id}`,
          targetLabel: identity.observedDisplayName ??
            identity.setupIntent?.displayName ??
            identity.setupIntent?.appName ??
            'Slack identity',
          expectedRevision: identity.connectionRevision,
          identityId: identity.id,
          replacement,
          formFields: ['botToken', 'signingSecret'],
        },
        scopes: [...REQUIRED_SLACK_BOT_SCOPES],
      };
    }

    if (!request.agentId) {
      throw new ManagementError('invalid_request', 'The setup Agent could not be resolved.');
    }
    const agent = await this.stores.config.getAgent(request.agentId);
    if (request.kind === 'api_connection') {
      const connection = agent.apiConnections.find(({ id }) => id === request.connectionId);
      if (!connection) throw new ManagementError('invalid_request', 'The API connection was not found.');
      const oauth = connection.authMode === 'oauth';
      return {
        action: oauth ? 'api_oauth' : 'api_credential',
        target: {
          kind: request.kind,
          provider: connection.oauthProvider ?? connection.presetId ?? connection.displayName,
          targetId: `agent:${agent.id}:api:${connection.id}`,
          targetLabel: connection.displayName,
          expectedRevision: agent.revision,
          agentId: agent.id,
          agentName: agent.name,
          connectionId: connection.id,
          replacement: connection.lifecycleStatus === 'ready',
          formFields: oauth ? ['clientId', 'clientSecret'] : ['credential'],
        },
        scopes: oauth ? [...connection.oauthScopes ?? []] : [`header:${connection.headerName}`],
      };
    }
    if (request.kind === 'mcp_connection') {
      const connection = agent.mcpServers.find(({ id }) => id === request.connectionId);
      if (!connection) throw new ManagementError('invalid_request', 'The MCP connection was not found.');
      const oauth = connection.authMode === 'oauth';
      if (connection.authMode === 'none') {
        throw new ManagementError('invalid_request', 'This MCP connection does not require setup.');
      }
      return {
        action: oauth ? 'mcp_oauth' : 'mcp_credentials',
        target: {
          kind: request.kind,
          provider: connection.presetId ?? connection.displayName,
          targetId: `agent:${agent.id}:mcp:${connection.id}`,
          targetLabel: connection.displayName,
          expectedRevision: agent.revision,
          agentId: agent.id,
          agentName: agent.name,
          connectionId: connection.id,
          replacement: connection.lifecycleStatus === 'ready',
          formFields: oauth
            ? []
            : ['bearerToken', ...connection.headerNames.map((name) => `header:${name}`)],
        },
        scopes: oauth ? scopeTokens(connection.oauthScope) : [...connection.allowedTools],
      };
    }
    const repository = agent.repositories.find(({ id }) => id === request.repositoryId);
    if (!repository) throw new ManagementError('invalid_request', 'The repository grant was not found.');
    return {
      action: 'repository_access',
      target: {
        kind: request.kind,
        provider: 'github',
        targetId: `agent:${agent.id}:repository:${repository.id}`,
        targetLabel: repository.fullName,
        expectedRevision: agent.revision,
        agentId: agent.id,
        agentName: agent.name,
        repositoryId: repository.id,
        replacement: false,
      },
      scopes: [`repository:${repository.fullName}`],
    };
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

  private async snapshot(
    organizationId = '',
    includeTeam = false,
  ): Promise<ManagementWorkspaceSnapshot> {
    const [agents, channels, providerSources, slackIdentities] = await Promise.all([
      this.stores.config.listAgents(),
      this.stores.config.listChannels(),
      Promise.all(MANAGED_PROVIDER_IDS.map(async (id) => [
        id,
        await this.stores.providerCredentialSource?.(id) ?? 'missing',
      ] as const)),
      this.stores.config.listSlackIdentities(),
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
      ...slackIdentities.map((identity) => ({
        kind: 'slack_identity' as const,
        id: identity.id,
        revision: identity.connectionRevision,
      })),
    ];
    const team = includeTeam ? await this.teamSnapshot(organizationId) : undefined;
    return {
      organizationId,
      agents: agents.map(({
        id,
        revision,
        name,
        instructions,
        enabled,
        model,
        skills,
        mcpServers,
        apiConnections,
        repositories,
        slackIdentityId,
      }) => ({
        id,
        revision,
        name,
        instructions,
        enabled,
        ...(model ? { model } : {}),
        skills,
        mcpServers,
        apiConnections,
        repositories,
        ...(slackIdentityId ? { slackIdentityId } : {}),
      })),
      channels: channels.map((channel, index) => ({
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        revision: channel.revision ?? 1,
        ...(channel.label ? { label: channel.label } : {}),
        ...(channel.additionalInstructions
          ? { additionalInstructions: channel.additionalInstructions }
          : {}),
        participationMode: channel.participationMode,
        lifecycle: channel.lifecycle,
        ...(placements[index] ? { agentId: placements[index]!.agentId } : {}),
      })),
      providers: providerSources.map(([id, source]) => ({
        id,
        source,
        mutable: source !== 'env',
        affectedAgents: agents
          .filter((agent) => modelBelongsToProvider(agent.model, id))
          .map(({ id: agentId, name }) => ({ id: agentId, name })),
      })),
      slackIdentities: await Promise.all(slackIdentities.map(async (identity) => {
        const references = await this.stores.config.getSlackIdentityReferences(identity.id);
        return {
          id: identity.id,
          kind: identity.kind,
          lifecycle: identity.lifecycle,
          ...(identity.teamId ? { teamId: identity.teamId } : {}),
          ...(identity.appId ? { appId: identity.appId } : {}),
          ...(identity.botUserId ? { botUserId: identity.botUserId } : {}),
          dmState: identity.dmState,
          ...(identity.dmAgentId ? { dmAgentId: identity.dmAgentId } : {}),
          credentialProvenance: identity.credentialProvenance,
          connectionRevision: identity.connectionRevision,
          ...(identity.observedDisplayName
            ? { observedDisplayName: identity.observedDisplayName }
            : {}),
          health: identity.health,
          agentIds: references.agentIds,
        };
      })),
      ...(team ? { team } : {}),
      effectiveRevision: effectiveConfigurationRevision(refs),
    };
  }

  private async teamSnapshot(
    organizationId: string,
  ): Promise<NonNullable<ManagementWorkspaceSnapshot['team']>> {
    const [memberships, bindings, invitations] = await Promise.all([
      this.stores.identity.listMemberships(),
      this.stores.identity.listExternalIdentities(),
      this.stores.identity.listInvitations(),
    ]);
    const scopedMemberships = memberships.filter((membership) =>
      membership.organizationId === organizationId);
    const users = await Promise.all(scopedMemberships.map(({ userId }) =>
      this.stores.identity.getUser(userId)));
    const usersById = new Map(users.filter(Boolean).map((user) => [user!.id, user!]));
    const bindingsByMembership = new Map(bindings
      .filter((binding) => binding.organizationId === organizationId)
      .map((binding) => [binding.membershipId, binding]));
    const activeOwners = scopedMemberships.filter((membership) =>
      membership.role === 'owner' && membership.status === 'active').length;
    return {
      soleOwnerWarning: activeOwners === 1,
      members: scopedMemberships.map((membership) => {
        const binding = bindingsByMembership.get(membership.id);
        return {
          id: membership.id,
          userId: membership.userId,
          displayName: usersById.get(membership.userId)?.displayName ?? null,
          slackTeamId: binding?.slackTeamId ?? null,
          slackUserId: binding?.slackUserId ?? null,
          role: membership.role,
          status: membership.status,
          revision: membershipRevision(membership),
        };
      }),
      invitations: invitations
        .filter((invitation) => invitation.organizationId === organizationId && invitation.status === 'pending')
        .map((invitation) => ({
          id: invitation.id,
          slackTeamId: invitation.slackTeamId,
          slackUserId: invitation.slackUserId,
          displayName: invitation.displayName,
          role: invitation.role,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
          revision: invitationRevision(invitation),
        })),
    };
  }

  private async requireMemoryOwner(
    actor: LiveManagementActor,
    ownerRef: MemoryOwnerRef,
    writable = false,
  ) {
    if (!this.stores.memory) {
      throw new ManagementError('invalid_request', 'Memory management is unavailable.');
    }
    const organization = await this.stores.identity.getOrganization();
    if (!organization || organization.id !== actor.organizationId ||
        organization.slackTeamId !== ownerRef.workspaceId) {
      throw new ManagementError('invalid_request', 'The memory owner was not found.');
    }
    const owner = await this.stores.memory.getOwner(ownerMemoryStoreId(ownerRef));
    if (!owner || owner.workspaceId !== ownerRef.workspaceId ||
        owner.ownerKind !== ownerRef.ownerKind || owner.ownerId !== ownerRef.ownerId ||
        (writable && owner.lifecycle !== 'active')) {
      throw new ManagementError('invalid_request', 'The memory owner was not found.');
    }
    return owner;
  }

  private async requireWorkspaceScope(
    actor: LiveManagementActor,
    workspaceId: string,
  ): Promise<void> {
    const organization = await this.stores.identity.getOrganization();
    if (!organization || organization.id !== actor.organizationId ||
        organization.slackTeamId !== workspaceId) {
      throw new ManagementError('invalid_request', 'The workspace was not found.');
    }
  }

  private async requireRoutineMutation(
    actor: LiveManagementActor,
    operation: Extract<ManagementOperation, {
      kind: 'save_routine' | 'control_routine' | 'delete_routine';
    }>,
  ): Promise<void> {
    if (!this.stores.routines) {
      throw new ManagementError('invalid_request', 'Routine management is unavailable.');
    }
    await this.requireWorkspaceScope(actor, operation.workspaceId);
    const channel = await this.stores.config.getChannel(operation.workspaceId, operation.channelId);
    if (!channel || channel.lifecycle !== 'active') {
      throw new ManagementError('invalid_request', 'The routine Channel was not found.');
    }
    if (operation.kind === 'save_routine') {
      const available = typeof this.stores.routineSchedulingAvailable === 'function'
        ? await this.stores.routineSchedulingAvailable()
        : this.stores.routineSchedulingAvailable ?? true;
      if (!available) {
        throw new ManagementError('invalid_request', 'Routine scheduling is unavailable on this deployment.');
      }
    }
    if (operation.kind === 'save_routine' && !operation.routineId) {
      if (operation.expectedVersion !== undefined) {
        throw new ManagementError('invalid_request', 'A new routine cannot have an expected version.');
      }
      return;
    }
    const routineId = operation.routineId;
    if (!routineId) throw new ManagementError('invalid_request', 'The routine was not found.');
    const routine = await this.stores.routines.getRoutine(routineId);
    if (!routine || routine.deletedAt !== null || routine.workspaceId !== operation.workspaceId ||
        routine.channelId !== operation.channelId || routine.version !== operation.expectedVersion) {
      throw new ManagementError('revision_conflict', 'The routine changed.');
    }
  }

  private async requireMemoryEntry(
    actor: LiveManagementActor,
    ownerRef: MemoryOwnerRef,
    entryId: string,
    writable = false,
  ): Promise<OwnerMemoryEntry> {
    const owner = await this.requireMemoryOwner(actor, ownerRef, writable);
    const entry = await this.stores.memory!.getOwnerEntry(entryId);
    if (!entry || entry.storeId !== owner.storeId || entry.workspaceId !== owner.workspaceId ||
        entry.ownerKind !== owner.ownerKind || entry.ownerId !== owner.ownerId) {
      throw new ManagementError('invalid_request', 'The memory entry was not found.');
    }
    return entry;
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
    if (operation.kind === 'invite_member') return { actor, operation };
    if (operation.kind === 'revoke_invitation') {
      const invitation = (await this.stores.identity.listInvitations())
        .find(({ id }) => id === operation.invitationId);
      if (!invitation || invitation.organizationId !== actor.organizationId ||
          invitation.status !== 'pending' ||
          invitationRevision(invitation) !== operation.expectedRevision) {
        throw new ManagementError('invalid_request', 'The invitation is unavailable.');
      }
      return { actor, operation };
    }
    if (operation.kind === 'create_memory_entry') {
      await this.requireMemoryOwner(actor, operation.owner, true);
      return { actor, operation };
    }
    if (operation.kind === 'update_memory_entry' || operation.kind === 'forget_memory_entry') {
      const entry = await this.requireMemoryEntry(actor, operation.owner, operation.entryId, true);
      if (entry.version !== operation.expectedVersion || entry.status === 'forgotten') {
        throw new ManagementError('revision_conflict', 'The memory entry changed.');
      }
      return { actor, operation };
    }
    if (operation.kind === 'save_routine' || operation.kind === 'control_routine' ||
        operation.kind === 'delete_routine') {
      await this.requireRoutineMutation(actor, operation);
      return { actor, operation };
    }
    if (operation.kind === 'remove_provider_credential') {
      const source = await this.stores.providerCredentialSource?.(operation.providerId) ?? 'missing';
      if (source === 'env') {
        throw new ManagementError('invalid_request', 'Deployment-provided credentials are read-only.');
      }
      if (source !== 'stored') {
        throw new ManagementError('invalid_request', 'No stored provider credential is available to remove.');
      }
      return { actor, operation };
    }
    if (operation.kind === 'create_slack_identity') {
      const dmAgent = await this.stores.config.getAgent(operation.initialDmAgentId);
      if (!dmAgent.enabled) {
        throw new ManagementError('invalid_request', 'Choose an enabled Agent to handle DMs.');
      }
      return { actor, operation };
    }
    if (operation.kind === 'set_slack_identity_dms' ||
        operation.kind === 'retire_slack_identity' ||
        operation.kind === 'cancel_slack_identity_setup') {
      const identity = await this.stores.config.getSlackIdentity(operation.identityId);
      if (identity.connectionRevision !== operation.expectedRevision) {
        throw new ManagementError('revision_conflict', 'The Slack identity changed.');
      }
      return { actor, operation };
    }
    if (operation.kind === 'request_setup') {
      const setup = await this.resolveSetupTarget(operation.target);
      return {
        actor,
        operation,
        credentialReplacement: setup.target.replacement,
      };
    }
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
    const targetRevisions = await this.targetRevisions(operation);
    // Never mint a confirmation for an already-stale preview. The requester
    // must inspect again instead of confirming a proposal for superseded state.
    await this.assertRevisionMap(targetRevisions);
    const summary = operation.kind === 'remove_provider_credential'
      ? await this.providerRemovalSummary(operation.providerId, reason)
      : proposalSummary(operation, reason);
    return this.stores.management.putProposal({
      proposalId: `proposal_${this.randomId()}`,
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      originKey: managementOriginKey(actor.origin),
      operation,
      summary,
      targetRevisions,
      expiresAt: at + PROPOSAL_TTL_MS,
      at,
    });
  }

  private async providerRemovalSummary(
    providerId: ManagedProviderId,
    reason: string,
  ): Promise<string> {
    const affected = (await this.stores.config.listAgents())
      .filter((agent) => modelBelongsToProvider(agent.model, providerId))
      .map(({ id, name }) => `${name} (${id})`);
    return `${reason}:remove_provider_credential:provider:${providerId}:affected=${
      affected.length ? affected.join(', ') : 'none'
    }`;
  }

  private async issueMemberInvitation(
    actor: LiveManagementActor,
    slackUserId: string,
  ): Promise<ImmediateMutation> {
    if (!this.stores.resolveSlackInvitee) {
      throw new ManagementError('invalid_request', 'Slack member invitation is unavailable.');
    }
    const [organization, invitee, bindings, memberships, invitations] = await Promise.all([
      this.stores.identity.getOrganization(),
      this.stores.resolveSlackInvitee(slackUserId),
      this.stores.identity.listExternalIdentities(),
      this.stores.identity.listMemberships(),
      this.stores.identity.listInvitations(),
    ]);
    if (!organization || organization.id !== actor.organizationId || !organization.slackTeamId ||
        invitee.slackTeamId !== organization.slackTeamId) {
      throw new ManagementError('invalid_request', 'The Slack member is unavailable.');
    }
    const statusByMembership = new Map(memberships.map((membership) =>
      [membership.id, membership.status]));
    const alreadyBound = bindings.some((binding) =>
      binding.organizationId === actor.organizationId &&
      binding.slackTeamId === organization.slackTeamId &&
      binding.slackUserId === slackUserId &&
      statusByMembership.get(binding.membershipId) !== 'removed');
    if (alreadyBound) {
      throw new ManagementError('invalid_request', 'The Slack member already belongs to Chickpea.');
    }
    const rawCapability = this.randomCapability();
    if (!/^[A-Za-z0-9_-]{43}$/.test(rawCapability)) {
      throw new ManagementError('invalid_request', 'Invitation capability generation failed.');
    }
    const at = this.now();
    const existing = invitations.find((invitation) =>
      invitation.organizationId === actor.organizationId &&
      invitation.slackTeamId === organization.slackTeamId &&
      invitation.slackUserId === slackUserId &&
      invitation.status === 'pending');
    const invitation = existing
      ? await this.stores.identity.resendInvitation({
          invitationId: existing.id,
          locatorHash: invitationDigest(rawCapability),
          expiresAt: at + INVITATION_TTL_MS,
        })
      : await this.stores.identity.createInvitation({
          organizationId: actor.organizationId,
          slackTeamId: organization.slackTeamId,
          slackUserId,
          displayName: invitee.displayName,
          role: 'admin',
          locatorHash: invitationDigest(rawCapability),
          inviterMembershipId: actor.membershipId,
          expiresAt: at + INVITATION_TTL_MS,
        });
    const baseUrl = await this.resolveSetupBaseUrl();
    const url = new URL('/auth/slack/invite', baseUrl);
    url.hash = `invite=${encodeURIComponent(rawCapability)}`;
    const revision = invitationRevision(invitation);
    return {
      changed: [{ kind: 'invitation', id: invitation.id, revision }],
      resultingRevisions: { [`invitation:${invitation.id}`]: revision },
      handoffUrl: url.href,
    };
  }

  private async executeMemoryMutation(
    actor: LiveManagementActor,
    mutationId: string,
    operation: Extract<ManagementOperation, {
      kind: 'create_memory_entry' | 'update_memory_entry';
    }>,
  ): Promise<ImmediateMutation> {
    try {
      if (operation.kind === 'create_memory_entry') {
        const owner = await this.requireMemoryOwner(actor, operation.owner, true);
        const content = validateMemoryContent(operation.entry);
        const idempotencyKey = `management:memory:create:${mutationId}:${operation.itemId}`;
        const entryId = `mem_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)}`;
        const entry = await this.stores.memory!.createOwnerEntry({
          entryId,
          storeId: owner.storeId,
          workspaceId: owner.workspaceId,
          slug: operation.entry.slug,
          slugSeed: operation.entry.slug,
          ...content,
          actorId: actor.userId,
          actorClass: 'operator',
          writeOrigin: actor.origin.kind === 'slack'
            ? { kind: 'slack_channel', channelId: actor.origin.channelId }
            : { kind: 'admin' },
          idempotencyKey,
        });
        return memoryMutation(entry);
      }
      await this.requireMemoryEntry(actor, operation.owner, operation.entryId, true);
      const content = validateMemoryContent(operation);
      const entry = await this.stores.memory!.updateOwnerEntry({
        entryId: operation.entryId,
        expectedVersion: operation.expectedVersion,
        ...content,
        actorId: actor.userId,
        actorClass: 'operator',
        idempotencyKey: `management:memory:update:${mutationId}:${operation.itemId}`,
      });
      return memoryMutation(entry);
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      throw new ManagementError('revision_conflict', 'The memory mutation could not be applied.');
    }
  }

  private async executeRoutineMutation(
    actor: LiveManagementActor,
    mutationId: string,
    operation: Extract<ManagementOperation, {
      kind: 'save_routine' | 'control_routine';
    }>,
  ): Promise<ImmediateMutation> {
    await this.requireRoutineMutation(actor, operation);
    const service = new RoutineService(this.stores.routines!, {
      now: this.now,
      routineId: () => `routine_${createHash('sha256')
        .update(`${mutationId}:${operation.itemId}`)
        .digest('hex')
        .slice(0, 32)}`,
    });
    try {
      if (operation.kind === 'control_routine') {
        return routineMutation(await service.control({
          routineId: operation.routineId,
          expectedVersion: operation.expectedVersion,
          action: operation.action,
          actorId: actor.userId,
          actorClass: 'operator',
          reasonCode: 'workspace_management',
          idempotencyKey: `management:routine:control:${mutationId}:${operation.itemId}`,
        }));
      }
      const projection = operation.schedule.kind === 'cron'
        ? normalizeRoutineSchedule(operation.schedule.expression, operation.timezone, this.now())
        : normalizeOneTimeSchedule(operation.schedule.localDateTime, operation.timezone, this.now());
      const definition = {
        name: operation.name,
        description: operation.description,
        taskText: operation.taskText,
        triggerKind: operation.schedule.kind === 'cron' ? 'schedule' as const : 'once' as const,
        scheduleInput: operation.schedule.kind === 'cron'
          ? operation.schedule.expression
          : operation.schedule.localDateTime,
        scheduleJson: projection.scheduleJson,
        timezone: operation.timezone,
        outputPolicy: operation.outputPolicy,
        authorityMode: 'live_channel_v1' as const,
      };
      const request = operation.routineId
        ? {
            action: 'edit' as const,
            routineId: operation.routineId,
            ...(operation.expectedVersion !== undefined
              ? { expectedVersion: operation.expectedVersion }
              : {}),
            definition,
          }
        : { action: 'create' as const, definition };
      return routineMutation(await service.save({
        ...request,
        actorId: actor.userId,
        actorClass: 'operator',
        workspaceId: operation.workspaceId,
        channelId: operation.channelId,
        nextRunAt: projection.nextRunAt,
        projectedDailyStarts: projection.projectedDailyStarts,
        reservations: projection.reservations,
        sourceVisibility: 'unknown',
      }, `management:routine:save:${mutationId}:${operation.itemId}`));
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      throw new ManagementError('revision_conflict', 'The routine mutation could not be applied.');
    }
  }

  private async executeProgressiveItem(
    actor: LiveManagementActor,
    requestId: string,
    operation: ManagementOperation,
    progress: ManagementRequestProgress,
  ): Promise<ImmediateMutation> {
    const prepared = progress.prepared?.itemId === operation.itemId
      ? progress.prepared
      : await this.prepareItem(operation);
    if (!progress.prepared) {
      await this.stores.management.saveRequestProgress(
        requestId,
        withoutSetupCapabilitiesFromProgress({ ...progress, prepared }),
        this.now(),
      );
    }
    const reconciled = await this.reconcilePrepared(prepared);
    const mutation = reconciled ?? await this.executeImmediate(actor, requestId, operation, prepared);
    await this.auditProgressiveSlackIdentityMutation(
      actor,
      requestId,
      operation,
      prepared,
    );
    return mutation;
  }

  private async auditProgressiveSlackIdentityMutation(
    actor: LiveManagementActor,
    requestId: string,
    operation: ManagementOperation,
    prepared: ManagementPreparedItem,
  ): Promise<void> {
    if (operation.kind !== 'create_slack_identity' &&
        operation.kind !== 'set_slack_identity_dms') return;
    const after = await this.stores.config.getSlackIdentity(operation.identityId);
    const before = operation.kind === 'set_slack_identity_dms' && prepared.before
      ? prepared.before as SlackIdentity
      : after;
    await this.appendSlackIdentityAudit(
      actor,
      requestId,
      operation.kind === 'create_slack_identity'
        ? 'slack_identity.setup_started'
        : 'slack_identity.dm_binding_changed',
      before,
      after,
    );
  }

  private async appendSlackIdentityAudit(
    actor: LiveManagementActor,
    requestId: string,
    eventType: SlackIdentityAuditEventType,
    before: SlackIdentity,
    after: SlackIdentity,
  ): Promise<void> {
    const operation = eventType.slice('slack_identity.'.length);
    await this.stores.config.appendSlackIdentityAudit({
      eventId: `audit_${createHash('sha256')
        .update(`${requestId}:${after.id}:${operation}:${after.connectionRevision}`)
        .digest('hex')
        .slice(0, 32)}`,
      domain: 'slack_identity',
      eventType,
      outcome: 'success',
      actorClass: 'chickpea_user',
      actorId: actor.userId,
      workspaceId: after.teamId ?? before.teamId ?? null,
      subjectId: after.id,
      subjectVersion: after.connectionRevision,
      createdAt: this.now(),
      metadataJson: JSON.stringify({
        operation,
        priorLifecycle: before.lifecycle,
        newLifecycle: after.lifecycle,
        requestId,
      }),
      idempotencyKey:
        `slack_identity:${after.id}:${operation}:${after.connectionRevision}:${requestId}:success`,
    });
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
      case 'create_slack_identity': {
        const dmAgent = await this.stores.config.getAgent(operation.initialDmAgentId);
        if (!dmAgent.enabled) {
          throw new ManagementError('invalid_request', 'Choose an enabled Agent to handle DMs.');
        }
        const at = this.now();
        return {
          itemId: operation.itemId,
          operation,
          intendedAfter: {
            id: operation.identityId,
            ingressKey: generateSlackIdentityIngressKey(),
            kind: 'dedicated',
            lifecycle: 'setup_incomplete',
            dmState: 'on',
            dmAgentId: dmAgent.id,
            credentialProvenance: 'none',
            connectionRevision: 0,
            health: 'unknown',
            createdAt: at,
            updatedAt: at,
            setupIntent: {
              appName: operation.appName,
              displayName: operation.displayName,
              sourceAgentId: dmAgent.id,
              sourceAgentSlackIdentityId: dmAgent.slackIdentityId ?? null,
            },
          } satisfies SlackIdentity,
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
      case 'set_slack_identity_dms': {
        const before = await this.stores.config.getSlackIdentity(operation.identityId);
        requireExpectedRevision(operation.expectedRevision, before.connectionRevision);
        return {
          itemId: operation.itemId,
          operation,
          before,
          intendedAfter: {
            ...before,
            dmState: operation.dmState,
            ...(operation.dmAgentId ? { dmAgentId: operation.dmAgentId } : {}),
            ...(!operation.dmAgentId ? { dmAgentId: undefined } : {}),
            connectionRevision: before.connectionRevision + 1,
          },
          ...(before.dmState !== 'needs_setup' ? {
            inverse: {
              itemId: `undo_${operation.itemId}`,
              kind: 'set_slack_identity_dms',
              identityId: before.id,
              expectedRevision: before.connectionRevision + 1,
              dmState: before.dmState,
              ...(before.dmAgentId ? { dmAgentId: before.dmAgentId } : {}),
            } satisfies ManagementOperation,
          } : {}),
        };
      }
      default:
        return { itemId: operation.itemId, operation };
    }
  }

  private async executeImmediate(
    actor: LiveManagementActor,
    mutationId: string,
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
      case 'create_slack_identity': {
        const identity = await this.stores.config.createSlackIdentity(
          prepared.intendedAfter as SlackIdentity,
        );
        return mutationForSlackIdentity(identity);
      }
      case 'set_slack_identity_dms': {
        const identity = await this.stores.config.setSlackIdentityDmBinding(
          operation.identityId,
          operation.expectedRevision,
          operation.dmState,
          operation.dmAgentId,
        );
        return mutationForSlackIdentity(identity, prepared.inverse);
      }
      case 'invite_member':
        return this.issueMemberInvitation(actor, operation.slackUserId);
      case 'create_memory_entry':
      case 'update_memory_entry':
        return this.executeMemoryMutation(actor, mutationId, operation);
      case 'save_routine':
      case 'control_routine':
        return this.executeRoutineMutation(actor, mutationId, operation);
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
    if (operation.kind === 'create_slack_identity') {
      const identity = await optionalSlackIdentity(this.stores.config, operation.identityId);
      if (identity && canonicalJson(identity) === canonicalJson(prepared.intendedAfter)) {
        return mutationForSlackIdentity(identity);
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
    if (operation.kind === 'set_slack_identity_dms') {
      const identity = await optionalSlackIdentity(this.stores.config, operation.identityId);
      if (identity && identity.connectionRevision === operation.expectedRevision + 1 &&
          identity.dmState === operation.dmState &&
          (identity.dmAgentId ?? undefined) === operation.dmAgentId) {
        return mutationForSlackIdentity(identity, prepared.inverse);
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
    if (operation.kind === 'remove_provider_credential') {
      if (!this.stores.removeProviderCredential) {
        throw new ManagementError('invalid_request', 'Provider credential removal is unavailable.');
      }
      const source = await this.stores.removeProviderCredential(operation.providerId);
      const changed = [{
        kind: 'provider' as const,
        id: operation.providerId,
        revision: providerRevision(source),
      }];
      return {
        changed,
        resultingRevisions: { [`provider:${operation.providerId}`]: providerRevision(source) },
      };
    }
    if (operation.kind === 'retire_slack_identity') {
      const before = await this.stores.config.getSlackIdentity(operation.identityId);
      const pendingDeliveries = await this.stores.countPendingSlackIdentityDeliveries?.(
        operation.identityId,
      ) ?? 0;
      if (pendingDeliveries > 0) {
        throw new ManagementError('proposal_stale', 'The Slack identity has pending deliveries.');
      }
      if (before.credentialProvenance === 'stored' && !this.stores.clearSlackIdentityCredentials) {
        throw new ManagementError('invalid_request', 'Slack credential retirement is unavailable.');
      }
      let retired = await this.stores.config.retireSlackIdentity(
        operation.identityId,
        operation.expectedRevision,
      );
      if (before.credentialProvenance === 'stored') {
        await this.stores.clearSlackIdentityCredentials!(operation.identityId);
        retired = await this.stores.config.updateSlackIdentity(
          operation.identityId,
          retired.connectionRevision,
          { credentialProvenance: 'none' },
        );
      }
      return mutationForSlackIdentity(retired);
    }
    if (operation.kind === 'cancel_slack_identity_setup') {
      if (!this.stores.cancelSlackIdentitySetup) {
        throw new ManagementError('invalid_request', 'Slack identity setup cancellation is unavailable.');
      }
      return mutationForSlackIdentity(await this.stores.cancelSlackIdentitySetup(
        operation.identityId,
        operation.expectedRevision,
      ));
    }
    if (operation.kind === 'revoke_invitation') {
      const current = (await this.stores.identity.listInvitations())
        .find(({ id }) => id === operation.invitationId);
      if (!current || current.organizationId !== actor.organizationId || current.status !== 'pending') {
        throw new ManagementError('proposal_stale', 'The invitation changed.');
      }
      const invitation = await this.stores.identity.revokeInvitation(operation.invitationId);
      const revision = invitationRevision(invitation);
      return {
        changed: [{ kind: 'invitation', id: invitation.id, revision }],
        resultingRevisions: { [`invitation:${invitation.id}`]: revision },
      };
    }
    if (operation.kind === 'forget_memory_entry') {
      await this.requireMemoryEntry(actor, operation.owner, operation.entryId, true);
      try {
        const entry = await this.stores.memory!.forgetOwnerEntry({
          entryId: operation.entryId,
          expectedVersion: operation.expectedVersion,
          actorId: actor.userId,
          actorClass: 'operator',
          reasonCode: 'admin_delete',
          idempotencyKey: `management:memory:forget:${proposalId}:${operation.itemId}`,
        });
        return memoryMutation(entry);
      } catch (error) {
        if (error instanceof ManagementError) throw error;
        throw new ManagementError('revision_conflict', 'The memory entry changed.');
      }
    }
    if (operation.kind === 'delete_routine') {
      await this.requireRoutineMutation(actor, operation);
      const seed = createHash('sha256').update(proposalId).digest('hex');
      const service = new RoutineService(this.stores.routines!, {
        now: this.now,
        confirmationId: () => `rconfirm_${seed.slice(0, 32)}`,
        token: () => seed.slice(0, 48),
      });
      try {
        const confirmation = await service.createConfirmation({
          action: 'delete',
          routineId: operation.routineId,
          expectedVersion: operation.expectedVersion,
          actorId: actor.userId,
          actorClass: 'operator',
          workspaceId: operation.workspaceId,
          channelId: operation.channelId,
        });
        return routineMutation(await service.confirm({
          token: confirmation.token,
          actorId: actor.userId,
          workspaceId: operation.workspaceId,
          channelId: operation.channelId,
          previewHash: confirmation.previewHash,
          idempotencyKey: `management:routine:delete:${proposalId}:${operation.itemId}`,
        }));
      } catch (error) {
        if (error instanceof ManagementError) throw error;
        throw new ManagementError('revision_conflict', 'The routine changed.');
      }
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
    return this.executeImmediate(actor, proposalId, operation, prepared);
  }

  private async targetRevisions(operation: ManagementOperation): Promise<Record<string, number>> {
    if (operation.kind === 'create_agent' || operation.kind === 'create_slack_identity') return {};
    if (operation.kind === 'invite_member') return {};
    if (operation.kind === 'create_memory_entry') return {};
    if (operation.kind === 'update_memory_entry' || operation.kind === 'forget_memory_entry') {
      const entry = await this.stores.memory?.getOwnerEntry(operation.entryId);
      return { [`memory:${operation.entryId}`]: entry?.version ?? 0 };
    }
    if (operation.kind === 'save_routine' && !operation.routineId) return {};
    if (operation.kind === 'save_routine' || operation.kind === 'control_routine' ||
        operation.kind === 'delete_routine') {
      const routineId = operation.routineId!;
      const routine = await this.stores.routines?.getRoutine(routineId);
      return { [`routine:${routineId}`]: routine?.version ?? 0 };
    }
    if (operation.kind === 'revoke_invitation') {
      const invitation = (await this.stores.identity.listInvitations())
        .find(({ id }) => id === operation.invitationId);
      return {
        [`invitation:${operation.invitationId}`]: invitation
          ? invitationRevision(invitation)
          : 0,
      };
    }
    if (operation.kind === 'remove_provider_credential') {
      const source = await this.stores.providerCredentialSource?.(operation.providerId) ?? 'missing';
      return { [`provider:${operation.providerId}`]: providerRevision(source) };
    }
    if (operation.kind === 'request_setup') {
      const setup = await this.resolveSetupTarget(operation.target);
      return setup.target.kind === 'provider_credential'
        ? { [setup.target.targetId]: setup.target.expectedRevision }
        : setup.target.kind === 'slack_identity'
          ? { [`slack_identity:${setup.target.identityId}`]: setup.target.expectedRevision }
          : { [`agent:${setup.target.agentId}`]: setup.target.expectedRevision };
    }
    if (operation.kind === 'set_slack_identity_dms' ||
        operation.kind === 'retire_slack_identity' ||
        operation.kind === 'cancel_slack_identity_setup') {
      return { [`slack_identity:${operation.identityId}`]: operation.expectedRevision };
    }
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
    if (key.startsWith('provider:')) {
      const providerId = key.slice('provider:'.length);
      if (!['anthropic', 'openai', 'openrouter'].includes(providerId)) {
        throw new ManagementError('invalid_request', 'Unknown provider revision target.');
      }
      const source = await this.stores.providerCredentialSource?.(
        providerId as 'anthropic' | 'openai' | 'openrouter',
      ) ?? 'missing';
      return providerRevision(source);
    }
    if (key.startsWith('slack_identity:')) {
      return (await optionalSlackIdentity(
        this.stores.config,
        key.slice('slack_identity:'.length),
      ))?.connectionRevision ?? 0;
    }
    if (key.startsWith('invitation:')) {
      const invitationId = key.slice('invitation:'.length);
      const invitation = (await this.stores.identity.listInvitations())
        .find(({ id }) => id === invitationId);
      return invitation ? invitationRevision(invitation) : 0;
    }
    if (key.startsWith('memory:')) {
      return (await this.stores.memory?.getOwnerEntry(key.slice('memory:'.length)))?.version ?? 0;
    }
    if (key.startsWith('routine:')) {
      return (await this.stores.routines?.getRoutine(key.slice('routine:'.length)))?.version ?? 0;
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
    } else if (operation.kind === 'remove_provider_credential') {
      const source = await this.stores.providerCredentialSource?.(operation.providerId) ?? 'missing';
      if (source === 'missing') {
        changed = [{ kind: 'provider', id: operation.providerId, revision: providerRevision(source) }];
      }
    } else if (operation.kind === 'retire_slack_identity') {
      const identity = await optionalSlackIdentity(this.stores.config, operation.identityId);
      if (identity?.lifecycle === 'retired' && identity.credentialProvenance !== 'stored') {
        changed = [{
          kind: 'slack_identity',
          id: identity.id,
          revision: identity.connectionRevision,
        }];
      }
    } else if (operation.kind === 'cancel_slack_identity_setup') {
      const identity = await optionalSlackIdentity(this.stores.config, operation.identityId);
      if (identity?.lifecycle === 'setup_incomplete' &&
          identity.credentialProvenance === 'none' &&
          identity.connectionRevision > operation.expectedRevision) {
        changed = [{
          kind: 'slack_identity',
          id: identity.id,
          revision: identity.connectionRevision,
        }];
      }
    } else if (operation.kind === 'revoke_invitation') {
      const invitation = (await this.stores.identity.listInvitations())
        .find(({ id }) => id === operation.invitationId);
      if (invitation?.status === 'revoked') {
        changed = [{
          kind: 'invitation',
          id: invitation.id,
          revision: invitationRevision(invitation),
        }];
      }
    } else if (operation.kind === 'forget_memory_entry') {
      const entry = await this.stores.memory?.getOwnerEntry(operation.entryId);
      if (entry?.status === 'forgotten') {
        changed = [{ kind: 'memory', id: entry.entryId, revision: entry.version }];
      }
    } else if (operation.kind === 'delete_routine') {
      const routine = await this.stores.routines?.getRoutine(operation.routineId);
      if (routine && routine.deletedAt !== null) {
        changed = [{ kind: 'routine', id: routine.id, revision: routine.version }];
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

function emitOperationOutcomes(
  surface: LiveManagementActor['origin']['kind'],
  result: ManagementApplyResult,
): ManagementApplyResult {
  for (const outcome of result.outcomes) {
    emitManagementMetric('operation.outcome', {
      surface,
      operation: outcome.operationKind,
      outcome: outcome.disposition,
      ...(outcome.code ? { reason: outcome.code } : {}),
    });
  }
  return result;
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
  if (operation.kind === 'place_agent' && operation.agentClientRef) {
    const agentId = clientRefs.get(operation.agentClientRef);
    if (!agentId) throw new ManagementError('invalid_request', 'The Agent clientRef was not found.');
    return { ...operation, agentId };
  }
  if (operation.kind === 'request_setup' &&
      ['api_connection', 'mcp_connection', 'repository_access'].includes(operation.target.kind) &&
      'agentClientRef' in operation.target && operation.target.agentClientRef) {
    const agentId = clientRefs.get(operation.target.agentClientRef);
    if (!agentId) throw new ManagementError('invalid_request', 'The Agent clientRef was not found.');
    const { agentClientRef: _agentClientRef, ...target } = operation.target;
    return { ...operation, target: { ...target, agentId } };
  }
  return operation;
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

function mutationForSlackIdentity(
  identity: SlackIdentity,
  inverse?: ManagementOperation,
): ImmediateMutation {
  return {
    changed: [{
      kind: 'slack_identity',
      id: identity.id,
      revision: identity.connectionRevision,
    }],
    resultingRevisions: {
      [`slack_identity:${identity.id}`]: identity.connectionRevision,
    },
    ...(inverse ? { inverse } : {}),
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

async function optionalSlackIdentity(
  config: Pick<ConfigStore, 'getSlackIdentity'>,
  identityId: string,
): Promise<SlackIdentity | undefined> {
  try {
    return await config.getSlackIdentity(identityId);
  } catch (error) {
    if (error instanceof UnknownSlackIdentityError) return undefined;
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
    : operation.kind === 'remove_provider_credential'
      ? `provider:${operation.providerId}`
    : operation.kind === 'create_slack_identity' ||
        operation.kind === 'set_slack_identity_dms' ||
        operation.kind === 'retire_slack_identity' ||
        operation.kind === 'cancel_slack_identity_setup'
      ? operation.identityId
    : operation.kind === 'invite_member'
      ? `slack:${operation.slackUserId}`
    : operation.kind === 'revoke_invitation'
      ? `invitation:${operation.invitationId}`
    : operation.kind === 'create_memory_entry'
      ? `memory-owner:${operation.owner.ownerKind}:${operation.owner.ownerId}`
    : operation.kind === 'update_memory_entry' || operation.kind === 'forget_memory_entry'
      ? `memory:${operation.entryId}`
    : operation.kind === 'save_routine' || operation.kind === 'control_routine' ||
        operation.kind === 'delete_routine'
      ? `routine:${operation.routineId ?? operation.channelId}`
    : operation.kind === 'put_channel'
      ? channelKey(operation.channel.workspaceId, operation.channel.channelId)
      : operation.kind === 'place_agent'
        ? channelKey(operation.workspaceId, operation.channelId)
        : operation.kind === 'create_agent'
          ? operation.agent.id
          : operation.kind === 'request_setup'
            ? operation.target.kind === 'provider_credential'
              ? `provider:${operation.target.providerId}`
              : operation.target.kind === 'slack_identity'
                ? operation.target.identityId
                : operation.target.agentId ?? operation.target.agentClientRef ?? 'agent'
            : operation.agentId;
  return `${reason}:${operation.kind}:${target}`;
}

function capabilityDigest(capability: string): string {
  return createHash('sha256').update(capability).digest('base64url');
}

function providerLabel(providerId: 'anthropic' | 'openai' | 'openrouter'): string {
  if (providerId === 'openai') return 'OpenAI';
  if (providerId === 'openrouter') return 'OpenRouter';
  return 'Anthropic';
}

function providerRevision(source: ManagedProviderSource): number {
  if (source === 'stored') return 1;
  if (source === 'env') return 2;
  return 0;
}

function invitationRevision(invitation: Invitation): number {
  let hash = 2_166_136_261;
  for (const character of `${invitation.id}:${invitation.status}:${invitation.expiresAt}:${invitation.updatedAt}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function invitationDigest(capability: string): string {
  return createHash('sha256').update(capability).digest('hex');
}

function memoryMutation(entry: OwnerMemoryEntry): ImmediateMutation {
  return {
    changed: [{ kind: 'memory', id: entry.entryId, revision: entry.version }],
    resultingRevisions: { [`memory:${entry.entryId}`]: entry.version },
  };
}

function routineMutation(routine: RoutineDefinition): ImmediateMutation {
  return {
    changed: [{ kind: 'routine', id: routine.id, revision: routine.version }],
    resultingRevisions: { [`routine:${routine.id}`]: routine.version },
  };
}

async function routineContentAccess(
  store: Pick<WorkStore, 'getWork' | 'getBinding'> | undefined,
  routine: RoutineDefinition,
): Promise<'public' | 'private' | 'authorization_unknown'> {
  if (!store || !routine.workId || !routine.bindingId) return 'authorization_unknown';
  try {
    const [work, binding] = await Promise.all([
      store.getWork(routine.workId as Parameters<WorkStore['getWork']>[0]),
      store.getBinding(routine.bindingId as Parameters<WorkStore['getBinding']>[0]),
    ]);
    if (!work || !binding || binding.workId !== work.id ||
        work.id !== routine.workId || binding.id !== routine.bindingId) {
      return 'authorization_unknown';
    }
    if (work.maximumSensitivity === 'public' && binding.sourceVisibility === 'public') {
      return 'public';
    }
    return binding.sourceVisibility === 'private' ? 'private' : 'authorization_unknown';
  } catch {
    return 'authorization_unknown';
  }
}

function modelBelongsToProvider(model: string | undefined, provider: ManagedProviderId): boolean {
  return Boolean(model?.startsWith(`${provider}/`));
}

function withoutSetupCapabilities(result: ManagementApplyResult): ManagementApplyResult {
  return {
    ...result,
    outcomes: result.outcomes.map(({
      setupUrl: _setupUrl,
      handoffUrl: _handoffUrl,
      ...outcome
    }) => outcome),
  };
}

function withoutSetupCapabilitiesFromProgress(
  progress: ManagementRequestProgress,
): ManagementRequestProgress {
  return {
    ...progress,
    outcomes: progress.outcomes.map(({
      setupUrl: _setupUrl,
      handoffUrl: _handoffUrl,
      ...outcome
    }) => outcome),
  };
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
    error instanceof AgentStillReferencedError ||
    error instanceof UnknownSlackIdentityError ||
    error instanceof SlackIdentityExistsError ||
    error instanceof SlackIdentityRevisionConflictError ||
    error instanceof SlackIdentityStillReferencedError ||
    error instanceof SlackIdentityLifecycleError ||
    error instanceof WorkspaceDefaultSlackIdentityProtectedError;
}

function mutationErrorCode(error: unknown): string {
  if (error instanceof ManagementError) return error.code;
  if (error instanceof AgentRevisionConflictError || error instanceof ChannelRevisionConflictError ||
      error instanceof ChannelAssignmentConflictError) return 'revision_conflict';
  if (error instanceof UnknownAgentError) return 'not_found';
  if (error instanceof AgentExistsError) return 'already_exists';
  if (error instanceof AgentStillReferencedError) return 'still_referenced';
  if (error instanceof SlackIdentityRevisionConflictError) return 'revision_conflict';
  if (error instanceof UnknownSlackIdentityError) return 'not_found';
  if (error instanceof SlackIdentityExistsError) return 'already_exists';
  if (error instanceof SlackIdentityStillReferencedError) return 'still_referenced';
  if (error instanceof SlackIdentityLifecycleError ||
      error instanceof WorkspaceDefaultSlackIdentityProtectedError) return 'invalid_state';
  return 'mutation_failed';
}
