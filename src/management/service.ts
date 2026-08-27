import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { canEditAgent } from '../auth/permissions.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import { CHICKPEA_AGENT_ID, isAgentId } from '../config/agent-id.ts';
import {
  REUSABLE_CONNECTOR_PRESETS,
  resolveReusableConnectorPreset,
} from '../config/presets.ts';
import {
  AgentExistsError,
  AgentRevisionConflictError,
  AgentStillReferencedError,
  ChannelRevisionConflictError,
  UnknownAgentError,
} from '../config/errors.ts';
import type { ConfigAgentPatch, ConfigStore } from '../config/store.ts';
import {
  resolveProviderRuntimeImpact,
  resolveProviderRuntimeImpacts,
} from '../config/provider-impact.ts';
import {
  type AgentChannelGrant,
  type AgentScheduleReference,
  type AgentConnectionBinding,
  type AgentCreateInput,
  type ChannelConfig,
  type ConnectionAccount,
  type ConnectionAccountPolicy,
  type CustomAgentConfig,
  type ResolvedAssignment,
} from '../config/types.ts';
import {
  applyConnectionCapabilityCeiling,
  projectRecoverableConnectionAccounts,
} from '../connections/runtime.ts';
import type { IdentityStore, Membership } from '../identity/types.ts';
import type {
  AgentMemory,
  MemoryStateStore,
} from '../memory/types.ts';
import {
  normalizeOneTimeSchedule,
  normalizeRoutineSchedule,
} from '../routines/schedule.ts';
import { RoutineService } from '../routines/service.ts';
import {
  bindRoutineAgentAuthority,
  reassignDirectRoutineAgent,
} from '../routines/agent-authority.ts';
import { routineDestinationBindingDigest } from '../routines/ids.ts';
import type { RoutineDefinition, RoutineStore } from '../routines/types.ts';
import type { WorkStore } from '../work/types.ts';
import { normalizeAgentHandle } from '../slack/agent-presence/handles.ts';
import { AgentPresenceError } from '../slack/agent-presence/errors.ts';
import { nextDefaultAgentAvatarSeed } from '../slack/agent-presence/default-avatar-pool.ts';
import {
  AGENT_AUTHORING_GUIDE_DIGEST,
  AGENT_AUTHORING_GUIDE_URI,
  AGENT_AUTHORING_GUIDE_VERSION,
} from './agent-authoring/index.ts';
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
import {
  agentAuthoringArtifactClass,
  emitManagementMetric,
  type ManagementMetricValue,
} from './telemetry.ts';
import {
  ChickpeaHandoffRequired,
  ManagementError,
  type ApplyWorkspaceChangesInput,
  type ConfirmWorkspaceChangeInput,
  type LiveManagementActor,
  type ManagementApplyResult,
  type ManagementChangeSetPreview,
  type ManagementChangeSetProposalRecord,
  type ChickpeaManagementHandoff,
  type ManagementItemOutcome,
  type ManagementMemorySnapshot,
  type ManagementAgentCreateInput,
  type ManagementAgentPatch,
  type ManagementObjectRef,
  type ManagementOperation,
  type ManagementOrigin,
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
  type PrepareConnectorSetupInput,
  type PrepareConnectorSetupResult,
  type ProposeWorkspaceChangesInput,
  type ProposeWorkspaceChangesResult,
  type UndoWorkspaceChangeInput,
} from './types.ts';

const PROPOSAL_TTL_MS = 15 * 60_000;
const CHANGE_SET_APPLY_LEASE_MS = 30_000;
const SETUP_TTL_MS = 24 * 60 * 60_000;
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
    | 'getUser'
    | 'getOrganization'
  >;
  config: Pick<
    ConfigStore,
    | 'listUserAgents'
    | 'getAgent'
    | 'createAgent'
    | 'updateAgent'
    | 'deleteAgent'
    | 'archiveAgent'
    | 'restoreAgent'
    | 'getWorkspaceInstallation'
    | 'listWorkspaceInstallations'
    | 'getWorkspaceModelDefault'
    | 'listChannels'
    | 'getChannel'
    | 'putChannel'
    | 'listAgentChannelGrants'
    | 'putAgentChannelGrant'
    | 'deleteAgentChannelGrant'
    | 'getAgentReferences'
    | 'getAgentScheduleReference'
    | 'putAgentScheduleReference'
    | 'listConnectionAccounts'
    | 'listAgentConnectionBindings'
  >;
  management: ManagementStore;
  memory?: Pick<
    MemoryStateStore,
    | 'getAgentMemory'
    | 'putAgentMemory'
  >;
  routines?: RoutineStore;
  work?: Pick<WorkStore, 'getWork' | 'getBinding'>;
  routineSchedulingAvailable?: boolean | (() => boolean | Promise<boolean>);
  /** Server-side gate for private DM creation. Defaults closed. */
  directRoutineSchedulingAvailable?: boolean | (() => boolean | Promise<boolean>);
  setupBaseUrl?: string | (() => string | undefined | Promise<string | undefined>);
  providerCredentialSource?: (
    providerId: ManagedProviderId,
  ) => Promise<ManagedProviderSource>;
  providerCredentialRevision?: (
    providerId: ManagedProviderId,
  ) => Promise<number>;
  removeProviderCredential?: (
    providerId: ManagedProviderId,
  ) => Promise<ManagedProviderSource>;
  prepareAgentUpdate?: (
    agent: CustomAgentConfig,
    patch: ConfigAgentPatch,
  ) => Promise<void>;
  reconcileAgentUpdate?: (input: {
    actor: LiveManagementActor;
    previous: CustomAgentConfig;
    agent: CustomAgentConfig;
    patch: ConfigAgentPatch;
  }) => Promise<CustomAgentConfig>;
  discoverSlackChannels?: (
    refresh: boolean,
    actor: LiveManagementActor,
  ) => Promise<unknown>;
  testMcpConnection?: (agentId: string, connectionId: string) => Promise<unknown>;
  listAvailableModels?: () => Promise<Array<{ id: string; name?: string }>>;
  publishAgentChannel?: (input: {
    actor: LiveManagementActor;
    workspaceId: string;
    channelId: string;
    agentId: string;
  }) => Promise<{ agent: CustomAgentConfig; grant: AgentChannelGrant }>;
  assertAgentChannelMembership?: (input: {
    actor: LiveManagementActor;
    workspaceId: string;
    channelId: string;
  }) => Promise<void>;
  archiveAgent?: (input: {
    actor: LiveManagementActor;
    agentId: string;
    expectedRevision: number;
    replacementDefaultAgentId?: string;
  }) => Promise<CustomAgentConfig>;
  restoreAgent?: (input: {
    actor: LiveManagementActor;
    agentId: string;
    expectedRevision: number;
  }) => Promise<CustomAgentConfig>;
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

type ActingAgentScopeTarget = {
  requestedAction: ChickpeaManagementHandoff['requestedAction'];
  target: ChickpeaManagementHandoff['target'];
} & (
  | { scope: 'agent'; agentId: string }
  | { scope: 'authority' }
);

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
    return this.snapshot(actor);
  }

  async prepareConnectorSetup(
    context: ApplyWorkspaceChangesInput['context'],
    input: PrepareConnectorSetupInput,
  ): Promise<PrepareConnectorSetupResult> {
    const actor = await this.requireLiveActor(context, { cleanupRetention: false });
    if (!isAgentId(input.agentId)) {
      throw new ManagementError('invalid_request', 'Choose a valid Agent before preparing connector setup.');
    }
    this.assertActingAgentScope(actor, {
      scope: 'agent',
      agentId: input.agentId,
      requestedAction: 'prepare_connector_setup',
      target: { kind: 'agent', id: input.agentId },
    });
    const agent = await this.requireEditableAgent(actor, input.agentId);
    const connector = resolveReusableConnectorPreset(input.connector);
    if (!connector) {
      throw new ManagementError(
        'invalid_request',
        `Unknown connector. Choose one of: ${REUSABLE_CONNECTOR_PRESETS.map(({ name }) => name).join(', ')}.`,
      );
    }
    const baseUrl = await this.resolveSetupBaseUrl();
    const url = new URL([
      '/admin/agents',
      encodeURIComponent(agent.id),
      'connections/new',
      encodeURIComponent(connector.id),
      input.ownerKind,
    ].join('/'), baseUrl);
    return {
      agent: { id: agent.id, name: agent.name },
      connector: { id: connector.id, name: connector.name },
      ownerKind: input.ownerKind,
      handoffUrl: url.href,
    };
  }

  async discoverSlackChannels(
    context: ApplyWorkspaceChangesInput['context'],
    refresh = false,
  ): Promise<unknown> {
    const actor = await this.requireLiveActor(context);
    this.assertActingAgentScope(actor, {
      scope: 'agent',
      agentId: actor.actingAgentId ?? CHICKPEA_AGENT_ID,
      requestedAction: 'discover_slack_channels',
      target: { kind: 'workspace', id: actor.organizationId },
    });
    if (!this.stores.discoverSlackChannels) {
      throw new ManagementError('invalid_request', 'Slack Channel discovery is unavailable.');
    }
    return this.stores.discoverSlackChannels(refresh, actor);
  }

  async testMcpConnection(
    context: ApplyWorkspaceChangesInput['context'],
    agentId: string,
    connectionId: string,
  ): Promise<unknown> {
    const actor = await this.requireLiveActor(context);
    this.assertActingAgentScope(actor, {
      scope: 'agent',
      agentId,
      requestedAction: 'test_mcp_connection',
      target: { kind: 'agent', id: agentId },
    });
    await this.requireEditableAgent(actor, agentId);
    if (!this.stores.testMcpConnection) {
      throw new ManagementError('invalid_request', 'MCP connection testing is unavailable.');
    }
    return this.stores.testMcpConnection(agentId, connectionId);
  }

  async inspectMemory(
    context: ApplyWorkspaceChangesInput['context'],
    agentId: string,
  ): Promise<ManagementMemorySnapshot> {
    const actor = await this.requireLiveActor(context);
    this.assertActingAgentScope(actor, {
      scope: 'agent',
      agentId,
      requestedAction: 'inspect_memory',
      target: { kind: 'agent', id: agentId },
    });
    await this.requireEditableAgent(actor, agentId);
    await this.requireAgentMemory(agentId);
    return this.stores.memory!.getAgentMemory(agentId);
  }

  async inspectRoutines(
    context: ApplyWorkspaceChangesInput['context'],
    input: ManagementRoutineInspectionInput,
  ): Promise<ManagementRoutineSnapshot> {
    const actor = await this.requireLiveActor(context);
    this.assertActingAgentScope(actor, {
      scope: 'agent',
      agentId: actor.actingAgentId ?? CHICKPEA_AGENT_ID,
      requestedAction: 'inspect_routines',
      target: { kind: 'workspace', id: input.workspaceId },
    });
    await this.requireWorkspaceScope(actor, input.workspaceId);
    if (!this.stores.routines) {
      throw new ManagementError('invalid_request', 'Routine management is unavailable.');
    }
    const directOrigin = slackDirectOrigin(actor);
    const inspectedChannelId = directOrigin ? directOrigin.channelId : input.channelId;
    if (directOrigin && input.channelId && input.channelId !== directOrigin.channelId) {
      return { routines: [] };
    }
    let routines = await this.stores.routines.listRoutines(input.workspaceId, inspectedChannelId);
    if (input.routineId) routines = routines.filter(({ id }) => id === input.routineId);
    const visible = await Promise.all(routines.map(async (routine) => {
      const reference = await this.stores.config.getAgentScheduleReference(routine.id);
      if (!reference) return undefined;
      if (routine.destination.kind === 'direct_thread') {
        return this.directRoutineIsVisible(actor, routine, reference)
          ? { routine, reference }
          : undefined;
      }
      if (directOrigin) return undefined;
      if (actor.role !== 'member' && !isUserAgentScoped(actor)) return { routine, reference };
      const agent = await optionalAgent(this.stores.config, reference.agentId);
      return agent && this.actorCanEditAgent(actor, agent) &&
        (!isUserAgentScoped(actor) || reference.agentId === actor.actingAgentId)
        ? { routine, reference }
        : undefined;
    }));
    const visibleRoutines = visible.filter((entry): entry is NonNullable<typeof entry> =>
      entry !== undefined);
    return {
      routines: await Promise.all(visibleRoutines.map(async ({ routine, reference }) => {
        const contentAccess = routine.destination.kind === 'direct_thread'
          ? 'private' as const
          : await routineContentAccess(this.stores.work, routine);
        const readable = contentAccess === 'public' || routine.destination.kind === 'direct_thread';
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
          owningAgentId: reference.agentId,
        };
      })),
    };
  }

  async exportRecipe(
    context: ApplyWorkspaceChangesInput['context'],
    input: { agentIds?: string[] | undefined },
  ): Promise<WorkspaceRecipe> {
    const actor = await this.requireLiveActor(context);
    this.assertActingAgentScope(actor, {
      scope: 'authority',
      requestedAction: 'export_workspace_recipe',
      target: { kind: 'workspace', id: actor.organizationId },
    });
    const editable = await this.editableAgents(actor);
    return exportWorkspaceRecipe({ listUserAgents: async () => editable }, input);
  }

  async previewRecipe(
    context: ApplyWorkspaceChangesInput['context'],
    input: PreviewWorkspaceRecipeInput,
  ): Promise<WorkspaceRecipePreview> {
    const actor = await this.requireLiveActor(context);
    this.assertActingAgentScope(actor, {
      scope: 'authority',
      requestedAction: 'preview_workspace_recipe',
      target: { kind: 'workspace', id: actor.organizationId },
    });
    const editable = await this.editableAgents(actor);
    const preview = await previewWorkspaceRecipe(
      { listUserAgents: async () => editable },
      actor.role === 'member'
        ? async () => 'missing'
        : async (providerId) => this.stores.providerCredentialSource?.(providerId) ?? 'missing',
      input,
    );
    emitManagementMetric('recipe.preview', {
      surface: context.origin.kind,
      outcome: 'success',
      agentCount: preview.agents.length,
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
    assertBaseAgentCreationContract(operations);
    const storageIdempotencyKey = managementStorageIdempotencyKey(actor, input.idempotencyKey);
    const at = this.now();
    const reservation = await this.stores.management.reserveRequest({
      operationId: `management_${this.randomId()}`,
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      originKey: managementActorOriginKey(actor),
      idempotencyKey: storageIdempotencyKey,
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
    if (progress.outcomes.some(({ disposition }) => disposition === 'confirmation_required')) {
      const pending = await this.resultFor(request.operationId, input.idempotencyKey, progress.outcomes);
      return emitOperationOutcomes(actor.origin.kind, pending);
    }

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
        const actingAgentHandoff = await this.actingAgentOperationHandoff(actor, operation);
        if (actingAgentHandoff) {
          progress = appendOutcome(progress, index, {
            itemId: operation.itemId,
            operationKind: operation.kind,
            disposition: 'chickpea_handoff',
            handoff: actingAgentHandoff,
          });
          request = await this.stores.management.saveRequestProgress(
            request.operationId,
            withoutSetupCapabilitiesFromProgress(progress),
            this.now(),
          );
          continue;
        }
        const facts = await this.policyFacts(actor, operation);
        const policy = classifyManagementOperation(facts);
        if (!policy.allowed) {
          progress = appendOutcome(progress, index, {
            itemId: operation.itemId,
            operationKind: operation.kind,
            disposition: 'failed',
            code: policy.reason,
          });
        } else if (policy.posture === 'confirmation') {
          const proposal = await this.createProposal(
            actor,
            operation,
            policy.reason,
            request.operationId,
          );
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
        if (progress.outcomes.at(-1)?.disposition === 'confirmation_required') break;
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
    if (progress.outcomes.some(({ disposition }) => disposition === 'confirmation_required')) {
      return emitOperationOutcomes(actor.origin.kind, result);
    }
    await this.stores.management.completeRequest(
      request.operationId,
      withoutSetupCapabilities(result),
      this.now(),
    );
    return emitOperationOutcomes(actor.origin.kind, result);
  }

  async proposeWorkspaceChanges(
    input: ProposeWorkspaceChangesInput,
  ): Promise<ProposeWorkspaceChangesResult> {
    const actor = await this.requireLiveActor(input.context);
    if (input.guideVersion !== AGENT_AUTHORING_GUIDE_VERSION) {
      throw new ManagementError(
        'invalid_request',
        `Read ${AGENT_AUTHORING_GUIDE_URI} and use guide version ${AGENT_AUTHORING_GUIDE_VERSION}.`,
      );
    }
    const operations = validateManagementOperations(input.operations);
    assertBaseAgentCreationContract(operations);
    if (operations.some(({ kind }) => kind === 'request_setup')) {
      throw new ManagementError(
        'invalid_request',
        'Prepare connector or repository setup separately after the reviewed Agent change.',
      );
    }
    if (operations.some(({ kind }) => kind === 'create_agent') && operations.length !== 1) {
      throw new ManagementError(
        'base_agent_capabilities_require_setup',
        'Create the base Agent in its own proposal. Add reach, capabilities, and schedules afterward.',
      );
    }

    const proposalId = `changeset_${this.randomId()}`;
    const targetRevisions: Record<string, number> = {};
    const changes: ManagementChangeSetPreview['changes'] = [];
    const missingSetup: ManagementChangeSetPreview['missingSetup'] = [];
    for (const operation of operations) {
      const handoff = await this.actingAgentOperationHandoff(actor, operation);
      if (handoff) {
        emitAgentAuthoringOutcome(actor, operations, {
          proposalOutcome: 'denied',
          handoffClass: handoff.target.kind === 'agent' ? 'cross_agent' : 'workspace_authority',
        });
        throw new ChickpeaHandoffRequired(handoff);
      }
      const policy = classifyManagementOperation(await this.policyFacts(actor, operation));
      if (!policy.allowed) {
        emitAgentAuthoringOutcome(actor, operations, { proposalOutcome: 'denied' });
        throw new ManagementError('forbidden', 'Current workspace authority does not permit this proposal.');
      }
      const revisions = await this.targetRevisions(operation);
      for (const [key, revision] of Object.entries(revisions)) {
        const existing = targetRevisions[key];
        if (existing !== undefined && existing !== revision) {
          throw new ManagementError('revision_conflict', 'The proposal has conflicting target revisions.');
        }
        targetRevisions[key] = revision;
      }
      const prepared = await this.preflightProposalItem(actor, operation, proposalId);
      changes.push({
        itemId: operation.itemId,
        operationKind: operation.kind,
        target: managementPreviewTarget(operation),
        ...(prepared.before === undefined ? {} : { before: prepared.before }),
        ...(prepared.intendedAfter === undefined ? {} : { after: prepared.intendedAfter }),
      });
      if (operation.kind === 'request_setup') {
        const setup = await this.resolveSetupTarget(operation.target);
        missingSetup.push({
          itemId: operation.itemId,
          kind: operation.target.kind,
          target: setup.target.targetId,
        });
      }
    }
    await this.assertRevisionMap(targetRevisions);
    const preview = boundedChangeSetPreview({
      summary: `${operations.length} reviewed workspace change${operations.length === 1 ? '' : 's'}`,
      changes,
      missingSetup,
    });
    const at = this.now();
    const proposal = await this.stores.management.putChangeSetProposal({
      proposalId,
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      originKey: managementActorOriginKey(actor),
      idempotencyKey: input.idempotencyKey,
      guideVersion: input.guideVersion,
      authoringReason: input.authoringReason,
      operations,
      digest: managementOperationDigest(operations),
      preview,
      targetRevisions,
      expiresAt: at + PROPOSAL_TTL_MS,
      at,
    });
    emitAgentAuthoringOutcome(actor, operations, { proposalOutcome: 'created' });
    return publicChangeSetProposal(proposal);
  }

  async confirmWorkspaceChange(input: ConfirmWorkspaceChangeInput): Promise<ManagementApplyResult> {
    const actor = await this.requireLiveActor(input.context);
    const changeSet = await this.stores.management.getChangeSetProposal(input.proposalId);
    if (changeSet) {
      try {
        const result = await this.confirmChangeSetProposal(actor, changeSet);
        emitAgentAuthoringOutcome(actor, changeSet.operations, {
          proposalOutcome: authoringProposalOutcome(result),
        });
        return result;
      } catch (error) {
        emitAgentAuthoringOutcome(actor, changeSet.operations, authoringProposalFailure(error));
        throw error;
      }
    }
    const existing = await this.stores.management.getProposal(input.proposalId);
    if (existing) this.assertProposalBinding(actor, existing);
    if (existing?.status === 'completed' && existing.result) {
      return emitOperationOutcomes(actor.origin.kind, existing.result);
    }
    if (existing?.status === 'pending') {
      await this.assertProposalStillAllowed(actor, existing);
    }
    if (existing?.status === 'applying') {
      await this.assertProposalStillAllowed(actor, existing);
      const reconciled = await this.reconcileConfirmed(actor, existing);
      if (reconciled) {
        const resumed = await this.resumeConfirmedRequest(actor, input.context, existing, reconciled);
        await this.stores.management.completeProposal(
          existing.proposalId,
          withoutSetupCapabilities(resumed),
          this.now(),
        );
        return emitOperationOutcomes(actor.origin.kind, resumed);
      }
      throw new ManagementError('operation_in_progress', 'The confirmation is already applying.');
    }
    const proposal = await this.stores.management.claimProposal({
      proposalId: input.proposalId,
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      originKey: managementActorOriginKey(actor),
      at: this.now(),
    });
    if (proposal.status === 'completed' && proposal.result) {
      return emitOperationOutcomes(actor.origin.kind, proposal.result);
    }
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
      const resumed = await this.resumeConfirmedRequest(actor, input.context, proposal, result);
      await this.stores.management.completeProposal(
        proposal.proposalId,
        withoutSetupCapabilities(resumed),
        this.now(),
      );
      return emitOperationOutcomes(actor.origin.kind, resumed);
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
        ...(mutation.handoffUrl ? { handoffUrl: mutation.handoffUrl } : {}),
      }],
    );
    const resumed = await this.resumeConfirmedRequest(actor, input.context, proposal, result);
    await this.stores.management.completeProposal(
      proposal.proposalId,
      withoutSetupCapabilities(resumed),
      this.now(),
    );
    return emitOperationOutcomes(actor.origin.kind, resumed);
  }

  private async confirmChangeSetProposal(
    actor: LiveManagementActor,
    existing: ManagementChangeSetProposalRecord,
  ): Promise<ManagementApplyResult> {
    this.assertProposalBinding(actor, existing);
    if (existing.status === 'completed' && existing.result) {
      return emitOperationOutcomes(actor.origin.kind, existing.result);
    }
    if (managementOperationDigest(existing.operations) !== existing.digest) {
      await this.stores.management.markChangeSetProposalStale(existing.proposalId, this.now());
      throw new ManagementError('proposal_stale', 'The reviewed change set no longer matches its digest.');
    }
    let proposal = existing;
    let recovered = false;
    if (proposal.status === 'applying') {
      if (this.now() - proposal.updatedAt < CHANGE_SET_APPLY_LEASE_MS) {
        throw new ManagementError('operation_in_progress', 'The confirmation is already applying.');
      }
      proposal = await this.stores.management.reclaimChangeSetProposal({
        proposalId: proposal.proposalId,
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        originKey: managementActorOriginKey(actor),
        expectedUpdatedAt: proposal.updatedAt,
        at: this.now(),
      });
      recovered = true;
    } else {
      try {
        for (const operation of proposal.operations) {
          const handoff = await this.actingAgentOperationHandoff(actor, operation);
          if (handoff) throw new ChickpeaHandoffRequired(handoff);
          const policy = classifyManagementOperation(await this.policyFacts(actor, operation));
          if (!policy.allowed) {
            throw new ManagementError('forbidden', 'Current workspace authority no longer permits this confirmation.');
          }
          await this.preflightProposalItem(actor, operation, proposal.proposalId);
        }
        await this.assertRevisionMap(proposal.targetRevisions);
      } catch (error) {
        if (invalidatesChangeSetProposal(error)) {
          await this.stores.management.markChangeSetProposalStale(proposal.proposalId, this.now());
        }
        throw error;
      }
      proposal = await this.stores.management.claimChangeSetProposal({
        proposalId: proposal.proposalId,
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        originKey: managementActorOriginKey(actor),
        at: this.now(),
      });
      if (proposal.status === 'completed' && proposal.result) {
        return emitOperationOutcomes(actor.origin.kind, proposal.result);
      }
    }

    const outcomes: ManagementItemOutcome[] = [...proposal.result?.outcomes ?? []];
    if (!outcomes.every((outcome, index) =>
      outcome.itemId === proposal.operations[index]?.itemId)) {
      await this.stores.management.markChangeSetProposalStale(proposal.proposalId, this.now());
      throw new ManagementError('proposal_stale', 'The saved confirmation progress is invalid.');
    }
    const progressEffectiveRevision = proposal.result?.effectiveRevision ?? await this.effectiveRevision();
    for (let index = outcomes.length; index < proposal.operations.length; index += 1) {
      const operation = proposal.operations[index]!;
      const dependencyFailed = (operation.dependsOn ?? []).some((itemId) =>
        outcomes.find((outcome) => outcome.itemId === itemId)?.disposition !== 'applied');
      if (dependencyFailed) {
        outcomes.push({
          itemId: operation.itemId,
          operationKind: operation.kind,
          disposition: 'skipped',
          code: 'dependency_not_applied',
        });
      } else {
        let mutation = recovered
          ? await this.reconcileChangeSetOperation(actor, proposal, operation)
          : undefined;
        let recoveryDenied = false;
        if (recovered && !mutation) {
          try {
            await this.assertChangeSetResumeAuthority(actor, operation);
          } catch (error) {
            if (outcomes.length === 0) {
              if (invalidatesChangeSetProposal(error)) {
                await this.stores.management.markChangeSetProposalStale(
                  proposal.proposalId,
                  this.now(),
                );
              }
              throw error;
            }
            outcomes.push({
              itemId: operation.itemId,
              operationKind: operation.kind,
              disposition: 'failed',
              code: isExpectedMutationError(error) ? mutationErrorCode(error) : 'operation_failed',
            });
            recoveryDenied = true;
          }
        }
        if (!recoveryDenied) {
          try {
            mutation ??= await this.executeChangeSetOperation(actor, proposal, operation);
            outcomes.push({
              itemId: operation.itemId,
              operationKind: operation.kind,
              disposition: 'applied',
              changed: mutation.changed,
              ...(mutation.handoffUrl ? { handoffUrl: mutation.handoffUrl } : {}),
            });
          } catch (error) {
            const reconciled = await this.reconcileChangeSetOperation(
              actor,
              proposal,
              operation,
            ).catch(() => undefined);
            outcomes.push(reconciled
              ? {
                  itemId: operation.itemId,
                  operationKind: operation.kind,
                  disposition: 'applied',
                  changed: reconciled.changed,
                  ...(reconciled.handoffUrl ? { handoffUrl: reconciled.handoffUrl } : {}),
                }
              : {
                  itemId: operation.itemId,
                  operationKind: operation.kind,
                  disposition: 'failed',
                  code: isExpectedMutationError(error) ? mutationErrorCode(error) : 'operation_failed',
                });
          }
        }
      }
      const progress = await this.resultFor(
        proposal.proposalId,
        `confirmation:${proposal.proposalId}`,
        outcomes,
        progressEffectiveRevision,
      );
      proposal = await this.stores.management.saveChangeSetProposalProgress(
        proposal.proposalId,
        withoutSetupCapabilities(progress),
        proposal.updatedAt,
        this.now(),
      );
    }
    const result = await this.resultFor(
      proposal.proposalId,
      `confirmation:${proposal.proposalId}`,
      outcomes,
    );
    await this.stores.management.completeChangeSetProposal(
      proposal.proposalId,
      withoutSetupCapabilities(result),
      this.now(),
      proposal.updatedAt,
    );
    return emitOperationOutcomes(actor.origin.kind, result);
  }

  private async executeChangeSetOperation(
    actor: LiveManagementActor,
    proposal: ManagementChangeSetProposalRecord,
    operation: ManagementOperation,
  ): Promise<ImmediateMutation> {
    const reconciled = await this.reconcileChangeSetOperation(actor, proposal, operation);
    if (reconciled) return reconciled;
    const prepared = changeSetPreparedItem(proposal, operation);
    if (canExecuteImmediately(operation)) {
      return this.executeImmediate(actor, proposal.proposalId, operation, prepared);
    }
    return this.executeConfirmed(actor, operation, proposal.proposalId);
  }

  private async reconcileChangeSetOperation(
    actor: LiveManagementActor,
    proposal: ManagementChangeSetProposalRecord,
    operation: ManagementOperation,
  ): Promise<ImmediateMutation | undefined> {
    const prepared = changeSetPreparedItem(proposal, operation);
    const preparedResult = await this.reconcilePrepared(actor, prepared);
    if (preparedResult) return preparedResult;
    const changed = await this.reconcileChangeSetConfirmedOperation(actor, operation);
    if (!changed) return undefined;
    return {
      changed,
      resultingRevisions: Object.fromEntries(changed.map((ref) =>
        [objectRevisionKey(ref), ref.revision ?? 0])),
    };
  }

  private async reconcileChangeSetConfirmedOperation(
    actor: LiveManagementActor,
    operation: ManagementOperation,
  ): Promise<ManagementObjectRef[] | undefined> {
    if (operation.kind === 'delete_agent') {
      return await optionalAgent(this.stores.config, operation.agentId)
        ? undefined
        : [{ kind: 'agent', id: operation.agentId }];
    }
    if (operation.kind === 'archive_agent') {
      const current = await optionalAgent(this.stores.config, operation.agentId);
      return current?.lifecycle === 'archived'
        ? [{ kind: 'agent', id: current.id, revision: current.revision }]
        : undefined;
    }
    if (operation.kind === 'restore_agent') {
      const current = await optionalAgent(this.stores.config, operation.agentId);
      const presenceSettled = current?.slackPresence?.desiredState === 'active' &&
        (current.slackPresence.health === 'healthy' || current.slackPresence.health === 'unpublished');
      return current && current.lifecycle !== 'archived' && presenceSettled
        ? [{ kind: 'agent', id: current.id, revision: current.revision }]
        : undefined;
    }
    if (operation.kind === 'grant_agent_channel') {
      const current = (await this.stores.config.listAgentChannelGrants(
        operation.workspaceId,
        operation.channelId,
      )).find((grant) => grant.agentId === operation.agentId);
      return current?.status === 'active' && current.createdByMembershipId === actor.membershipId
        ? mutationForGrant(current).changed
        : undefined;
    }
    if (operation.kind === 'revoke_agent_channel') {
      const current = (await this.stores.config.listAgentChannelGrants(
        operation.workspaceId,
        operation.channelId,
      )).find((grant) => grant.agentId === operation.agentId);
      return current ? undefined : [{
        kind: 'channel_grant',
        id: grantKey(operation.workspaceId, operation.channelId, operation.agentId),
        revision: 0,
      }];
    }
    if (operation.kind === 'update_member') {
      const membership = await this.stores.identity.getMembership(operation.membershipId);
      return membership && (!operation.role || membership.role === operation.role) &&
        (!operation.status || membership.status === operation.status)
        ? [{ kind: 'membership', id: membership.id, revision: membershipRevision(membership) }]
        : undefined;
    }
    if (operation.kind === 'remove_provider_credential') {
      const source = await this.stores.providerCredentialSource?.(operation.providerId) ?? 'missing';
      return source === 'missing'
        ? [{ kind: 'provider', id: operation.providerId, revision: providerRevision(source) }]
        : undefined;
    }
    if (operation.kind === 'delete_routine') {
      const routine = await this.stores.routines?.getRoutine(operation.routineId);
      return routine && routine.deletedAt !== null
        ? [{ kind: 'routine', id: routine.id, revision: routine.version }]
        : undefined;
    }
    return undefined;
  }

  private async assertChangeSetResumeAuthority(
    actor: LiveManagementActor,
    operation: ManagementOperation,
  ): Promise<void> {
    const handoff = await this.actingAgentOperationHandoff(actor, operation);
    if (handoff) throw new ChickpeaHandoffRequired(handoff);
    if (operation.kind === 'update_member') {
      if (actor.role !== 'owner') {
        throw new ManagementError('forbidden', 'Current workspace authority no longer permits this confirmation.');
      }
      return;
    }
    if (operation.kind === 'remove_provider_credential' ||
        (operation.kind === 'put_channel' && operation.channel.lifecycle === 'archived')) {
      if (actor.role === 'member') {
        throw new ManagementError('forbidden', 'Current workspace authority no longer permits this confirmation.');
      }
      return;
    }
    let agentId: string | undefined;
    if (operation.kind === 'update_agent' || operation.kind === 'delete_agent' ||
        operation.kind === 'archive_agent' || operation.kind === 'restore_agent' ||
        operation.kind === 'update_agent_memory') {
      agentId = operation.agentId;
    } else if (operation.kind === 'grant_agent_channel' ||
        operation.kind === 'revoke_agent_channel' || operation.kind === 'save_routine') {
      agentId = operation.agentId;
    } else if (operation.kind === 'control_routine' || operation.kind === 'delete_routine') {
      agentId = (await this.stores.config.getAgentScheduleReference(operation.routineId))?.agentId;
    }
    if (!agentId) return;
    const agent = await optionalAgent(this.stores.config, agentId);
    if (!agent || !this.actorCanEditAgent(actor, agent)) {
      throw new ManagementError('forbidden', 'Current workspace authority no longer permits this confirmation.');
    }
  }

  private async resumeConfirmedRequest(
    actor: LiveManagementActor,
    context: ApplyWorkspaceChangesInput['context'],
    proposal: ManagementProposalRecord,
    confirmed: ManagementApplyResult,
  ): Promise<ManagementApplyResult> {
    if (!proposal.requestOperationId) return confirmed;
    const request = await this.stores.management.getRequest(proposal.requestOperationId);
    if (!request || request.organizationId !== actor.organizationId ||
        request.actorUserId !== actor.userId || request.actorMembershipId !== actor.membershipId ||
        request.originKey !== managementActorOriginKey(actor)) {
      throw new ManagementError('proposal_binding_mismatch', 'The parent request is unavailable.');
    }
    if (request.status === 'completed' && request.result) return request.result;
    const confirmedOutcome = confirmed.outcomes.find(({ itemId }) =>
      itemId === proposal.operation.itemId);
    if (!confirmedOutcome) {
      throw new ManagementError('proposal_stale', 'The confirmed operation result is unavailable.');
    }
    const outcomes = request.progress.outcomes.map((outcome) =>
      outcome.itemId === proposal.operation.itemId ? confirmedOutcome : outcome);
    if (!outcomes.some(({ itemId, disposition }) =>
      itemId === proposal.operation.itemId && disposition === 'applied') &&
        confirmedOutcome.disposition !== 'setup_required') {
      throw new ManagementError('proposal_stale', 'The parent request cannot resume.');
    }
    const resumedProgress = { ...request.progress, outcomes };
    await this.stores.management.saveRequestProgress(
      request.operationId,
      withoutSetupCapabilitiesFromProgress(resumedProgress),
      this.now(),
    );
    if (resumedProgress.nextIndex >= request.operations.length) {
      const resumed = await this.resultFor(
        request.operationId,
        publicManagementIdempotencyKey(actor, request.idempotencyKey),
        outcomes,
      );
      await this.stores.management.completeRequest(
        request.operationId,
        withoutSetupCapabilities(resumed),
        this.now(),
      );
      return {
        ...resumed,
        outcomes: resumed.outcomes.map((outcome) =>
          outcome.itemId === confirmedOutcome.itemId ? confirmedOutcome : outcome),
      };
    }
    const resumed = await this.applyWorkspaceChanges({
      context,
      idempotencyKey: publicManagementIdempotencyKey(actor, request.idempotencyKey),
      operations: request.operations,
    });
    // Setup capabilities are response-only bearer secrets. Restore the one
    // produced by this confirmation only in the immediate response after the
    // parent request has durably saved its redacted progress/result.
    return {
      ...resumed,
      outcomes: resumed.outcomes.map((outcome) =>
        outcome.itemId === confirmedOutcome.itemId ? confirmedOutcome : outcome),
    };
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
      if (request.organizationId !== actor.organizationId || request.actorUserId !== actor.userId ||
          request.actorMembershipId !== actor.membershipId ||
          request.originKey !== managementActorOriginKey(actor)) {
        throw new ManagementError('operation_not_found', 'The management operation was not found.');
      }
      return request.result;
    }
    const proposal = await this.stores.management.getProposal(operationId);
    if (proposal) {
      if (proposal.organizationId !== actor.organizationId || proposal.actorUserId !== actor.userId ||
          proposal.actorMembershipId !== actor.membershipId ||
          proposal.originKey !== managementActorOriginKey(actor)) {
        throw new ManagementError('operation_not_found', 'The management operation was not found.');
      }
      return proposal.result;
    }
    const changeSet = await this.stores.management.getChangeSetProposal(operationId);
    if (changeSet) {
      if (changeSet.organizationId !== actor.organizationId ||
          changeSet.actorUserId !== actor.userId ||
          changeSet.actorMembershipId !== actor.membershipId ||
          changeSet.originKey !== managementActorOriginKey(actor)) {
        throw new ManagementError('operation_not_found', 'The management operation was not found.');
      }
      return changeSet.result;
    }
    const setup = await this.stores.management.getSetup(operationId, this.now());
    if (!setup || setup.organizationId !== actor.organizationId || setup.actorUserId !== actor.userId ||
        setup.actorMembershipId !== actor.membershipId ||
        managementOriginKey(setup.origin) !== managementOriginKey(actor.origin) ||
        (actor.actingAgentId &&
          (setup.origin.kind !== 'slack' || setup.origin.agentId !== actor.actingAgentId))) {
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
        existing.actorUserId !== actor.userId ||
        existing.actorMembershipId !== actor.membershipId ||
        managementOriginKey(existing.origin) !== managementOriginKey(actor.origin)) {
      throw new ManagementError('setup_not_found', 'The setup operation was not found.');
    }
    this.assertActingAgentScope(actor, existing.target.agentId
      ? {
          scope: 'agent',
          agentId: existing.target.agentId,
          requestedAction: 'revoke_setup_link',
          target: { kind: 'setup', id: setupOperationId },
        }
      : {
          scope: 'authority',
          requestedAction: 'revoke_setup_link',
          target: { kind: 'setup', id: setupOperationId },
        });
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

  private async agentEditorUrl(agentId: string): Promise<string | undefined> {
    if (!this.stores.setupBaseUrl) return undefined;
    const baseUrl = await this.resolveSetupBaseUrl();
    return new URL(`/admin/agents/${encodeURIComponent(agentId)}`, baseUrl).href;
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
          expectedRevision: await this.providerRevision(request.providerId),
          replacement: source === 'stored',
          formFields: ['apiKey'],
        },
        scopes: [`models:${request.providerId}`],
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
    options: { cleanupRetention?: boolean } = {},
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
    if (options.cleanupRetention !== false) {
      await this.stores.management.cleanupRetention(this.now(), 100).catch(() => 0);
    }
    if (context.origin.kind !== 'slack') {
      if (context.actingAgentId) {
        throw new ManagementError('forbidden', 'The acting Agent route is unavailable.');
      }
      return { ...context, role: membership.role };
    }
    const installation = await this.stores.config.getWorkspaceInstallation(
      context.origin.workspaceId,
    );
    if (installation?.runtimeContract !== 'chickpea-v1') {
      const { actingAgentId: _legacyActingAgentId, ...legacyContext } = context;
      return {
        ...legacyContext,
        origin: context.origin,
        role: membership.role,
      };
    }
    const routedAgentId = context.origin.agentId;
    const actingAgentId = context.actingAgentId ?? routedAgentId;
    if (!actingAgentId || !isAgentId(actingAgentId) ||
        (routedAgentId && routedAgentId !== actingAgentId)) {
      throw new ManagementError('forbidden', 'The acting Agent route is unavailable.');
    }
    const actingAgent = await optionalAgent(this.stores.config, actingAgentId);
    if (!actingAgent ||
        (actingAgentId === CHICKPEA_AGENT_ID && actingAgent.kind !== 'system') ||
        (actingAgentId !== CHICKPEA_AGENT_ID &&
          (actingAgent.kind !== 'user' || !actingAgent.enabled || actingAgent.lifecycle === 'archived'))) {
      throw new ManagementError('forbidden', 'The acting Agent route is unavailable.');
    }
    return {
      ...context,
      actingAgentId,
      origin: { ...context.origin, agentId: actingAgentId },
      role: membership.role,
    };
  }

  private assertActingAgentScope(
    actor: LiveManagementActor,
    target: ActingAgentScopeTarget,
  ): void {
    const handoff = this.actingAgentScopeHandoff(actor, target);
    if (handoff) throw new ChickpeaHandoffRequired(handoff);
  }

  private actingAgentScopeHandoff(
    actor: LiveManagementActor,
    target: ActingAgentScopeTarget,
  ): ChickpeaManagementHandoff | undefined {
    if (!isUserAgentScoped(actor) ||
        (target.scope === 'agent' && target.agentId === actor.actingAgentId)) {
      return undefined;
    }
    return chickpeaHandoff(actor, target.requestedAction, target.target);
  }

  private async actingAgentOperationHandoff(
    actor: LiveManagementActor,
    operation: ManagementOperation,
  ): Promise<ChickpeaManagementHandoff | undefined> {
    if (!isUserAgentScoped(actor)) return undefined;
    if ((operation.kind === 'save_routine' || operation.kind === 'control_routine' ||
        operation.kind === 'delete_routine') && operation.routineId && this.stores.routines) {
      const routine = await this.stores.routines.getRoutine(operation.routineId);
      if (routine?.destination.kind === 'direct_thread') {
        const reference = await this.stores.config.getAgentScheduleReference(routine.id);
        if (!this.directRoutineIsVisible(actor, routine, reference)) return undefined;
      }
    }
    const target = await this.managementOperationScopeTarget(operation);
    return this.actingAgentScopeHandoff(actor, target);
  }

  private async managementOperationScopeTarget(
    operation: ManagementOperation,
  ): Promise<ActingAgentScopeTarget> {
    if (operation.kind === 'update_agent' || operation.kind === 'delete_agent' ||
        operation.kind === 'archive_agent' || operation.kind === 'restore_agent' ||
        operation.kind === 'update_agent_memory') {
      return operationAgentScopeTarget(operation.kind, operation.agentId);
    }
    if (operation.kind === 'grant_agent_channel' || operation.kind === 'revoke_agent_channel') {
      return operation.agentId
        ? operationAgentScopeTarget(operation.kind, operation.agentId, {
            kind: 'channel',
            id: channelKey(operation.workspaceId, operation.channelId),
          })
        : operationAuthorityScopeTarget(operation);
    }
    if (operation.kind === 'save_routine') {
      return operationAgentScopeTarget(operation.kind, operation.agentId, {
        kind: 'routine',
        id: operation.routineId ?? channelKey(
          operation.workspaceId,
          operation.channelId ?? 'current_dm_thread',
        ),
      });
    }
    if (operation.kind === 'reassign_routine_agent') {
      return operationAuthorityScopeTarget(operation);
    }
    if (operation.kind === 'control_routine' || operation.kind === 'delete_routine') {
      const reference = operation.routineId
        ? await this.stores.config.getAgentScheduleReference(operation.routineId)
        : undefined;
      return reference
        ? operationAgentScopeTarget(operation.kind, reference.agentId, {
            kind: 'routine', id: operation.routineId,
          })
        : operationAuthorityScopeTarget(operation);
    }
    if (operation.kind === 'request_setup' && operation.target.kind !== 'provider_credential' &&
        operation.target.agentId) {
      return operationAgentScopeTarget(operation.kind, operation.target.agentId);
    }
    return operationAuthorityScopeTarget(operation);
  }

  private actorCanEditAgent(actor: LiveManagementActor, agent: CustomAgentConfig): boolean {
    return canEditAgent(actorPrincipal(actor), agent);
  }

  private async requireEditableAgent(
    actor: LiveManagementActor,
    agentId: string,
  ): Promise<CustomAgentConfig> {
    const agent = await optionalAgent(this.stores.config, agentId);
    if (!agent || !this.actorCanEditAgent(actor, agent)) {
      throw new ManagementError('forbidden', 'The Agent is not available to this member.');
    }
    return agent;
  }

  private async editableAgents(actor: LiveManagementActor): Promise<CustomAgentConfig[]> {
    const agents = await this.stores.config.listUserAgents();
    const editable = actor.role === 'member'
      ? agents.filter((agent) => this.actorCanEditAgent(actor, agent))
      : agents;
    return actor.actingAgentId && actor.actingAgentId !== CHICKPEA_AGENT_ID
      ? editable.filter(({ id }) => id === actor.actingAgentId)
      : editable;
  }

  private assertProposalBinding(
    actor: LiveManagementActor,
    proposal: Pick<
      ManagementProposalRecord | ManagementChangeSetProposalRecord,
      'organizationId' | 'actorUserId' | 'actorMembershipId' | 'originKey'
    >,
  ): void {
    if (proposal.organizationId !== actor.organizationId ||
        proposal.actorUserId !== actor.userId ||
        proposal.actorMembershipId !== actor.membershipId ||
        proposal.originKey !== managementActorOriginKey(actor)) {
      throw new ManagementError(
        'proposal_binding_mismatch',
        'The confirmation does not match its initiating user and origin.',
      );
    }
  }

  private async assertProposalStillAllowed(
    actor: LiveManagementActor,
    proposal: ManagementProposalRecord,
  ): Promise<void> {
    const handoff = await this.actingAgentOperationHandoff(actor, proposal.operation);
    if (handoff) throw new ChickpeaHandoffRequired(handoff);
    const facts = await this.policyFacts(
      actor,
      proposal.operation,
    );
    const policy = classifyManagementOperation(facts);
    if (!policy.allowed) {
      throw new ManagementError('forbidden', 'Current workspace authority no longer permits this confirmation.');
    }
  }

  private async snapshot(actor: LiveManagementActor): Promise<ManagementWorkspaceSnapshot> {
    const userAgentScoped = isUserAgentScoped(actor);
    const [allAgents, channels, allGrants, organization, providerSources] = await Promise.all([
      this.stores.config.listUserAgents(),
      this.stores.config.listChannels(),
      this.stores.config.listAgentChannelGrants(),
      this.stores.identity.getOrganization(),
      actor.role === 'member' || userAgentScoped
        ? Promise.resolve([] as Array<readonly [ManagedProviderId, ManagedProviderSource]>)
        : Promise.all(MANAGED_PROVIDER_IDS.map(async (id) => [
            id,
            await this.stores.providerCredentialSource?.(id) ?? 'missing',
          ] as const)),
    ]);
    const providerImpacts = await resolveProviderRuntimeImpacts(
      this.stores.config,
      providerSources.map(([id]) => id),
    );
    const editable = actor.role === 'member'
      ? allAgents.filter((agent) => this.actorCanEditAgent(actor, agent))
      : allAgents;
    const agents = userAgentScoped
      ? editable.filter(({ id }) => id === actor.actingAgentId)
      : editable;
    const workspaceIds = actor.origin.kind === 'slack'
      ? [actor.origin.workspaceId]
      : organization?.id === actor.organizationId && organization.slackTeamId
        ? [organization.slackTeamId]
        : [];
    const [allConnectionAccounts, agentBindingEntries] = await Promise.all([
      Promise.all(workspaceIds.map((workspaceId) =>
        this.stores.config.listConnectionAccounts(workspaceId))).then((groups) => groups.flat()),
      Promise.all(agents.map(async (agent) => [
        agent.id,
        await this.stores.config.listAgentConnectionBindings(agent.id),
      ] as const)),
    ]);
    const visibleConnectionAccounts = new Map(allConnectionAccounts
      .filter((account): account is ConnectionAccount & {
        lifecycle: Exclude<ConnectionAccount['lifecycle'], 'revoked'>;
      } => account.lifecycle !== 'revoked' && (
        account.ownerKind === 'team' || account.ownerMembershipId === actor.membershipId
      ))
      .map((account) => [account.id, account]));
    const connectionsByAgent = new Map(agentBindingEntries.map(([agentId, bindings]) => {
      const recoverable = projectRecoverableConnectionAccounts(
        allConnectionAccounts,
        bindings,
        actor.membershipId,
      );
      const projectedBindingIds = new Set(recoverable.map(({ binding }) =>
        binding.connectionAccountId));
      const projected = new Map(recoverable.flatMap(({ account, binding, policy }) =>
        account.lifecycle === 'revoked' ? [] : [[
          account.id,
          managementConnectionProjection(account, binding, policy),
        ] as const]));
      for (const binding of bindings) {
        if (projectedBindingIds.has(binding.connectionAccountId)) continue;
        const account = visibleConnectionAccounts.get(binding.connectionAccountId);
        if (!account || account.providerId !== binding.providerId ||
            binding.enabled && account.lifecycle !== 'pending') continue;
        projected.set(account.id, managementConnectionProjection(
          account,
          binding,
          applyConnectionCapabilityCeiling(account.policy, binding),
        ));
      }
      return [agentId, [...projected.values()].sort((left, right) =>
        left.id.localeCompare(right.id))] as const;
    }));
    const visibleAgentIds = new Set(agents.map(({ id }) => id));
    const grants = allGrants.filter((grant) => visibleAgentIds.has(grant.agentId));
    const grantsByChannel = new Map<string, Array<{
      agentId: string;
      status: typeof grants[number]['status'];
      revision: number;
    }>>();
    for (const grant of grants) {
      const key = channelKey(grant.workspaceId, grant.channelId);
      const entries = grantsByChannel.get(key) ?? [];
      entries.push({
        agentId: grant.agentId,
        status: grant.status,
        revision: grant.revision,
      });
      grantsByChannel.set(key, entries);
    }
    // Active Agent grants are the durable reach authority. Older workspaces
    // can legitimately contain a grant without the optional Channel metadata
    // row, and routine execution already honors that shape. Surface a minimal
    // Channel projection so inspection and authoring agree with routing.
    const projectedChannels = [...channels];
    const projectedChannelKeys = new Set(channels.map((channel) =>
      channelKey(channel.workspaceId, channel.channelId)));
    for (const grant of grants) {
      const key = channelKey(grant.workspaceId, grant.channelId);
      if (projectedChannelKeys.has(key)) continue;
      projectedChannels.push({
        workspaceId: grant.workspaceId,
        channelId: grant.channelId,
        revision: 0,
        ...(grant.channelLabel ? { label: grant.channelLabel } : {}),
        lifecycle: 'active',
      });
      projectedChannelKeys.add(key);
    }
    const visibleChannels = userAgentScoped || actor.role === 'member'
      ? projectedChannels.filter((channel) => grantsByChannel.has(channelKey(
          channel.workspaceId,
          channel.channelId,
        )))
      : projectedChannels;
    const refs: ManagementObjectRef[] = [
      ...agents.map((agent) => ({ kind: 'agent' as const, id: agent.id, revision: agent.revision })),
      ...visibleChannels.map((channel) => ({
        kind: 'channel' as const,
        id: channelKey(channel.workspaceId, channel.channelId),
        revision: channel.revision ?? 1,
      })),
      ...grants.map((grant) => ({
        kind: 'channel_grant' as const,
        id: grantKey(grant.workspaceId, grant.channelId, grant.agentId),
        revision: grant.revision,
      })),
      ...[...connectionsByAgent.entries()].flatMap(([agentId, connections]) =>
        connections.flatMap((connection) => [{
          kind: 'connection' as const,
          id: `${agentId}:${connection.id}:account`,
          revision: connection.accountRevision,
        }, {
          kind: 'connection' as const,
          id: `${agentId}:${connection.bindingAccountId}:binding`,
          revision: connection.bindingRevision,
        }])),
    ];
    const team = actor.role === 'owner' && !userAgentScoped
      ? await this.teamSnapshot(actor.organizationId)
      : undefined;
    const [listedModels, routineSchedulingAvailable, workspaceDefault] = userAgentScoped
      ? await Promise.all([
          this.stores.listAvailableModels?.().catch(() => []) ?? [],
          this.isRoutineSchedulingAvailable(),
          actor.origin.kind === 'slack'
            ? this.stores.config.getWorkspaceModelDefault(actor.origin.workspaceId)
            : Promise.resolve(undefined),
        ])
      : [[], false, undefined] as const;
    const availableModels = uniqueModelChoices([
      ...listedModels,
      ...agents.flatMap(({ model }) => model ? [{ id: model }] : []),
      ...(workspaceDefault?.modelId ? [{ id: workspaceDefault.modelId }] : []),
    ]);
    const selfAgent = userAgentScoped ? agents[0] : undefined;
    return {
      organizationId: actor.organizationId,
      ...(actor.origin.kind === 'slack' && actor.origin.agentId
        ? { currentAgentId: actor.origin.agentId }
        : {}),
      connectors: REUSABLE_CONNECTOR_PRESETS.map(({ id, name, description }) => ({
        id,
        name,
        description,
      })),
      agents: agents.map(({
        id,
        revision,
        name,
        description,
        instructions,
        enabled,
        lifecycle,
        creatorMembershipId,
        editPolicy,
        configurationGeneration,
        slackPresence,
        model,
        skills,
        mcpServers,
        apiConnections,
        repositories,
      }) => ({
        id,
        revision,
        name,
        ...(description ? { description } : {}),
        instructions,
        enabled,
        ...(lifecycle ? { lifecycle } : {}),
        ...(creatorMembershipId ? { creatorMembershipId } : {}),
        ...(editPolicy ? { editPolicy } : {}),
        ...(configurationGeneration !== undefined ? { configurationGeneration } : {}),
        ...(slackPresence
          ? {
              slackPresence: {
                requestedHandle: slackPresence.requestedHandle,
                normalizedHandle: slackPresence.normalizedHandle,
                desiredState: slackPresence.desiredState,
                health: slackPresence.health,
                ...(slackPresence.errorCode ? { errorCode: slackPresence.errorCode } : {}),
                avatar: { ...slackPresence.avatar },
              },
            }
          : {}),
        ...(model ? { model } : {}),
        skills,
        mcpServers,
        apiConnections,
        ...((connectionsByAgent.get(id)?.length ?? 0) > 0
          ? { connections: connectionsByAgent.get(id)!.map(({
              accountRevision: _accountRevision,
              bindingAccountId: _bindingAccountId,
              bindingRevision: _bindingRevision,
              ...connection
            }) => connection) }
          : {}),
        repositories,
      })),
      channels: visibleChannels.map((channel) => ({
        workspaceId: channel.workspaceId,
        channelId: channel.channelId,
        revision: channel.revision ?? 1,
        ...(channel.label ? { label: channel.label } : {}),
        lifecycle: channel.lifecycle,
        grants: (grantsByChannel.get(channelKey(channel.workspaceId, channel.channelId)) ?? [])
          .sort((left, right) => left.agentId.localeCompare(right.agentId)),
      })),
      providers: providerSources.map(([id, source]) => {
        const impact = providerImpacts.get(id)!;
        return {
          id,
          source,
          mutable: source !== 'env',
          workspaceDefaultAffected: impact.workspaceDefaultAffected,
          inheritingAgentCount: impact.activeInheritingAgentCount,
          affectedAgents: [...impact.pinnedAgents, ...impact.inheritingAgents]
            .filter((agent) => visibleAgentIds.has(agent.id))
            .map(({ id: agentId, name }) => ({ id: agentId, name })),
        };
      }),
      ...(userAgentScoped && selfAgent
        ? {
            selfManagement: {
              availableModels,
              routineSchedulingAvailable,
              capabilityHealth: selfCapabilityHealth(
                selfAgent,
                grants,
                connectionsByAgent.get(selfAgent.id) ?? [],
              ),
            },
          }
        : {}),
      ...(team ? { team } : {}),
      effectiveRevision: effectiveConfigurationRevision(refs),
    };
  }

  private async teamSnapshot(
    organizationId: string,
  ): Promise<NonNullable<ManagementWorkspaceSnapshot['team']>> {
    const [memberships, bindings] = await Promise.all([
      this.stores.identity.listMemberships(),
      this.stores.identity.listExternalIdentities(),
    ]);
    const scopedMemberships = memberships.filter((membership) =>
      membership.organizationId === organizationId);
    const users = await Promise.all(scopedMemberships.map(({ userId }) =>
      this.stores.identity.getUser(userId)));
    const usersById = new Map(users.filter(Boolean).map((user) => [user!.id, user!]));
    const bindingsByMembership = new Map(bindings
      .filter((binding) => binding.organizationId === organizationId)
      .map((binding) => [binding.membershipId, binding]));
    return {
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
    };
  }

  private async requireAgentMemory(agentId: string): Promise<AgentMemory> {
    if (!this.stores.memory) {
      throw new ManagementError('invalid_request', 'Memory management is unavailable.');
    }
    const agent = await optionalAgent(this.stores.config, agentId);
    if (!agent) throw new ManagementError('invalid_request', 'The Agent was not found.');
    return this.stores.memory.getAgentMemory(agentId);
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
      kind: 'save_routine' | 'control_routine' | 'delete_routine' | 'reassign_routine_agent';
    }>,
  ): Promise<void> {
    if (!this.stores.routines) {
      throw new ManagementError('invalid_request', 'Routine management is unavailable.');
    }
    await this.requireWorkspaceScope(actor, operation.workspaceId);
    const channelId = this.routineMutationChannelId(actor, operation);
    const directRequest = operation.kind === 'save_routine' &&
      operation.destination?.kind === 'current_dm_thread';
    const existingRoutine = operation.routineId
      ? await this.stores.routines.getRoutine(operation.routineId)
      : undefined;
    const directRoutine = directRequest || existingRoutine?.destination.kind === 'direct_thread';
    if (!directRoutine) {
      const channel = await this.stores.config.getChannel(operation.workspaceId, channelId);
      if (channel?.lifecycle === 'archived') {
        throw new ManagementError('invalid_request', 'The routine Channel was not found.');
      }
    }
    if (operation.kind === 'save_routine') {
      const available = await this.isRoutineSchedulingAvailable();
      if (!available) {
        throw new ManagementError('invalid_request', 'Routine scheduling is unavailable on this deployment.');
      }
      const agent = await optionalAgent(this.stores.config, operation.agentId);
      if (directRoutine) {
        if (!operation.routineId && !(await this.isDirectRoutineSchedulingAvailable())) {
          throw new ManagementError(
            'invalid_request',
            'Private DM scheduling is not enabled on this deployment.',
          );
        }
        if (!agent || agent.kind !== 'user' || !agent.enabled ||
            agent.lifecycle === 'draft' || agent.lifecycle === 'archived') {
          throw new ManagementError('invalid_request', 'The schedule Agent is not available.');
        }
        if (isUserAgentScoped(actor) && operation.agentId !== actor.actingAgentId) {
          throw new ChickpeaHandoffRequired(chickpeaHandoff(actor, operation.kind, {
            kind: 'agent', id: operation.agentId,
          }));
        }
      } else {
        const grants = await this.stores.config.listAgentChannelGrants(
          operation.workspaceId,
          channelId,
        );
        if (!agent || !agent.enabled || agent.lifecycle === 'archived' ||
            !grants.some((grant) => grant.agentId === agent.id && grant.status === 'active')) {
          throw new ManagementError(
            'invalid_request',
            'The schedule Agent is not active in this Channel.',
          );
        }
        if (!this.actorCanEditAgent(actor, agent)) {
          throw new ManagementError('forbidden', 'The schedule Agent is not available to this member.');
        }
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
        routine.channelId !== channelId || routine.version !== operation.expectedVersion) {
      throw new ManagementError('revision_conflict', 'The routine changed.');
    }
    const reference = await this.stores.config.getAgentScheduleReference(routineId);
    if (!reference) {
      throw new ManagementError('invalid_request', 'The schedule Agent binding was not found.');
    }
    if (routine.destination.kind === 'direct_thread') {
      if ('channelId' in operation && operation.channelId !== undefined) {
        throw new ManagementError('invalid_request', 'The private DM destination is unavailable.');
      }
      if (!this.directRoutineIsVisible(actor, routine, reference)) {
        throw new ManagementError('invalid_request', 'The routine was not found.');
      }
      if (operation.kind === 'save_routine' && operation.agentId !== reference.agentId) {
        throw new ManagementError(
          'invalid_request',
          'Use Chickpea Agent reassignment instead of changing schedule ownership during an edit.',
        );
      }
      if (operation.kind === 'reassign_routine_agent' &&
          (actor.actingAgentId !== CHICKPEA_AGENT_ID || actor.origin.kind !== 'slack')) {
        throw new ManagementError('forbidden', 'Mention Chickpea in the private DM to reassign this schedule.');
      }
      return;
    }
    await this.requireEditableAgent(actor, reference.agentId);
  }

  private async isRoutineSchedulingAvailable(): Promise<boolean> {
    return typeof this.stores.routineSchedulingAvailable === 'function'
      ? this.stores.routineSchedulingAvailable()
      : this.stores.routineSchedulingAvailable ?? true;
  }

  private async isDirectRoutineSchedulingAvailable(): Promise<boolean> {
    return typeof this.stores.directRoutineSchedulingAvailable === 'function'
      ? this.stores.directRoutineSchedulingAvailable()
      : this.stores.directRoutineSchedulingAvailable ?? false;
  }

  private routineMutationChannelId(
    actor: LiveManagementActor,
    operation: Extract<ManagementOperation, {
      kind: 'save_routine' | 'control_routine' | 'delete_routine' | 'reassign_routine_agent';
    }>,
  ): string {
    const directOrigin = slackDirectOrigin(actor);
    if (operation.kind === 'save_routine' && operation.destination) {
      if (!directOrigin || operation.workspaceId !== directOrigin.workspaceId ||
          operation.channelId !== undefined) {
        throw new ManagementError('invalid_request', 'The private DM destination is unavailable.');
      }
      return directOrigin.channelId;
    }
    if ('channelId' in operation && operation.channelId) return operation.channelId;
    if (directOrigin && operation.workspaceId === directOrigin.workspaceId) {
      return directOrigin.channelId;
    }
    throw new ManagementError('invalid_request', 'The routine destination is required.');
  }

  private directRoutineIsVisible(
    actor: LiveManagementActor,
    routine: RoutineDefinition,
    reference: AgentScheduleReference | undefined,
  ): boolean {
    const origin = slackDirectOrigin(actor);
    return Boolean(
      origin && reference &&
      routine.destination.kind === 'direct_thread' &&
      reference.destinationKind === 'direct_thread' &&
      routine.workspaceId === origin.workspaceId &&
      routine.destination.conversationId === origin.channelId &&
      routine.destination.ownerMembershipId === actor.membershipId &&
      reference.createdByMembershipId === actor.membershipId &&
      (!isUserAgentScoped(actor) || reference.agentId === actor.actingAgentId)
    );
  }

  private async resultFor(
    operationId: string,
    idempotencyKey: string,
    outcomes: ManagementItemOutcome[],
    knownEffectiveRevision?: string,
  ): Promise<ManagementApplyResult> {
    const effectiveRevision = knownEffectiveRevision ?? await this.effectiveRevision();
    const hasConfirmation = outcomes.some(({ disposition }) => disposition === 'confirmation_required');
    const hasFailure = outcomes.some(({ disposition }) =>
      disposition === 'failed' || disposition === 'skipped' || disposition === 'chickpea_handoff');
    return {
      operationId,
      idempotencyKey,
      status: hasFailure ? 'partial' : hasConfirmation ? 'confirmation_required' : 'completed',
      outcomes,
      effectiveRevision,
      activation: 'next_turn',
    };
  }

  private async effectiveRevision(): Promise<string> {
    const [agents, channels, grants] = await Promise.all([
      this.stores.config.listUserAgents(),
      this.stores.config.listChannels(),
      this.stores.config.listAgentChannelGrants(),
    ]);
    return effectiveConfigurationRevision([
      ...agents.map(({ id, revision }) => ({ kind: 'agent' as const, id, revision })),
      ...channels.map(({ workspaceId, channelId, revision }) => ({
        kind: 'channel' as const,
        id: channelKey(workspaceId, channelId),
        revision: revision ?? 1,
      })),
      ...grants.map(({ workspaceId, channelId, agentId, revision }) => ({
        kind: 'channel_grant' as const,
        id: grantKey(workspaceId, channelId, agentId),
        revision,
      })),
    ]);
  }

  private async policyFacts(
    actor: LiveManagementActor,
    operation: ManagementOperation,
  ) {
    if (operation.kind === 'update_member') return { actor, operation, adminRequired: true };
    if (operation.kind === 'update_agent_memory') {
      const agent = await this.requireEditableAgent(actor, operation.agentId);
      const memory = await this.requireAgentMemory(operation.agentId);
      if (memory.revision !== operation.expectedRevision) {
        throw new ManagementError('revision_conflict', 'The Agent memory changed.');
      }
      return { actor, operation, currentAgent: agent, agentEditable: true };
    }
    if (operation.kind === 'save_routine' || operation.kind === 'control_routine' ||
        operation.kind === 'delete_routine' || operation.kind === 'reassign_routine_agent') {
      await this.requireRoutineMutation(actor, operation);
      return { actor, operation, agentEditable: true };
    }
    if (operation.kind === 'remove_provider_credential') {
      if (actor.role === 'member') return { actor, operation, adminRequired: true };
      const source = await this.stores.providerCredentialSource?.(operation.providerId) ?? 'missing';
      if (source === 'env') {
        throw new ManagementError('invalid_request', 'Deployment-provided credentials are read-only.');
      }
      if (source !== 'stored') {
        throw new ManagementError('invalid_request', 'No stored provider credential is available to remove.');
      }
      return { actor, operation, adminRequired: true };
    }
    if (operation.kind === 'request_setup') {
      if (operation.target.kind === 'provider_credential' && actor.role === 'member') {
        return { actor, operation, adminRequired: true };
      }
      if (operation.target.kind !== 'provider_credential') {
        if (!operation.target.agentId) {
          throw new ManagementError('invalid_request', 'The setup Agent could not be resolved.');
        }
        await this.requireEditableAgent(actor, operation.target.agentId);
      }
      const setup = await this.resolveSetupTarget(operation.target);
      return {
        actor,
        operation,
        credentialReplacement: setup.target.replacement,
        ...(operation.target.kind === 'provider_credential'
          ? { adminRequired: true }
          : { agentEditable: true }),
      };
    }
    if (operation.kind === 'update_agent') {
      const currentAgent = await this.requireEditableAgent(actor, operation.agentId);
      const agentReferences = await this.stores.config.getAgentReferences(operation.agentId);
      return {
        actor,
        operation,
        currentAgent,
        agentReferences,
        capabilityScopeExpanded: capabilityScopeExpanded(currentAgent, operation.patch),
        agentEditable: true,
      };
    }
    if (operation.kind === 'delete_agent' || operation.kind === 'archive_agent' ||
        operation.kind === 'restore_agent') {
      return {
        actor,
        operation,
        currentAgent: await this.requireEditableAgent(actor, operation.agentId),
        agentReferences: await this.stores.config.getAgentReferences(operation.agentId),
        agentEditable: true,
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
        ...(operation.channel.lifecycle === 'archived' ? { adminRequired: true } : {}),
        ...(currentChannelLifecycle ? { currentChannelLifecycle } : {}),
      };
    }
    if (operation.kind === 'grant_agent_channel' || operation.kind === 'revoke_agent_channel') {
      await this.requireEditableAgent(actor, operation.agentId!);
      return { actor, operation, agentEditable: true };
    }
    return { actor, operation };
  }

  private async createProposal(
    actor: LiveManagementActor,
    operation: ManagementOperation,
    reason: string,
    requestOperationId?: string,
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
      originKey: managementActorOriginKey(actor),
      operation,
      summary,
      targetRevisions,
      ...(requestOperationId ? { requestOperationId } : {}),
      expiresAt: at + PROPOSAL_TTL_MS,
      at,
    });
  }

  private async providerRemovalSummary(
    providerId: ManagedProviderId,
    reason: string,
  ): Promise<string> {
    const impact = await resolveProviderRuntimeImpact(this.stores.config, providerId);
    const affected = [...impact.pinnedAgents, ...impact.inheritingAgents]
      .map(({ id, name }) => `${name} (${id})`);
    return `${reason}:remove_provider_credential:provider:${providerId}:workspace_default=${
      impact.workspaceDefaultAffected ? 'affected' : 'unaffected'
    }:affected=${
      affected.length ? affected.join(', ') : 'none'
    }`;
  }

  private async executeMemoryMutation(
    operation: Extract<ManagementOperation, { kind: 'update_agent_memory' }>,
  ): Promise<ImmediateMutation> {
    try {
      await this.requireAgentMemory(operation.agentId);
      const memory = await this.stores.memory!.putAgentMemory({
        agentId: operation.agentId,
        expectedRevision: operation.expectedRevision,
        body: operation.body,
      });
      return memoryMutation(memory);
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      throw new ManagementError('revision_conflict', 'The Agent memory changed.');
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
      const channelId = this.routineMutationChannelId(actor, operation);
      const existing = operation.routineId
        ? await this.stores.routines!.getRoutine(operation.routineId)
        : undefined;
      const directOrigin = slackDirectOrigin(actor);
      const direct = operation.destination?.kind === 'current_dm_thread' ||
        existing?.destination.kind === 'direct_thread';
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
        authorityMode: direct ? 'live_direct_member_v1' as const : 'live_channel_v1' as const,
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
      const routine = await service.save({
        ...request,
        actorId: actor.userId,
        actorClass: 'operator',
        workspaceId: operation.workspaceId,
        channelId,
        ...(!existing && direct && directOrigin
          ? {
              destination: {
                kind: 'direct_thread' as const,
                conversationId: channelId,
                threadTs: directOrigin.threadTs,
                ownerMembershipId: actor.membershipId,
              },
            }
          : {}),
        nextRunAt: projection.nextRunAt,
        projectedDailyStarts: projection.projectedDailyStarts,
        reservations: projection.reservations,
        sourceVisibility: direct ? 'private' : 'unknown',
      }, `management:routine:save:${mutationId}:${operation.itemId}`);
      const agent = await this.stores.config.getAgent(operation.agentId);
      const assignment: ResolvedAssignment = {
        workspaceId: operation.workspaceId,
        channelId,
        agentId: agent.id,
        agent,
      };
      try {
        const reference = await bindRoutineAgentAuthority({
          routine,
          assignment,
          actorMembershipId: actor.membershipId,
          env: undefined,
        }, {
          config: this.stores.config as ConfigStore,
          identity: this.stores.identity as IdentityStore,
        });
        if (!existing && routine.destination.kind === 'direct_thread') {
          const digest = routineDestinationBindingDigest(
            routine.id,
            routine.workspaceId,
            routine.destination,
          );
          const activated = await this.stores.routines!.activateDirectRoutine({
            routineId: routine.id,
            expectedVersion: routine.version,
            expectedReferenceRevision: reference.revision,
            destinationBindingDigest: digest,
          });
          return routineMutation(activated);
        }
      } catch {
        if (routine.destination.kind === 'channel') {
          await service.control({
            routineId: routine.id,
            expectedVersion: routine.version,
            action: 'pause',
            actorId: actor.userId,
            actorClass: 'operator',
            reasonCode: 'schedule_authority_missing',
            idempotencyKey: `management:routine:authority-failed:${mutationId}:${operation.itemId}`,
          }).catch(() => undefined);
        }
        throw new ManagementError(
          'invalid_request',
          'The schedule was saved paused because its Agent authority could not be bound.',
        );
      }
      return routineMutation(routine);
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
      : await this.prepareItem(actor, operation);
    if (!progress.prepared) {
      await this.stores.management.saveRequestProgress(
        requestId,
        withoutSetupCapabilitiesFromProgress({ ...progress, prepared }),
        this.now(),
      );
    }
    const reconciled = await this.reconcilePrepared(actor, prepared);
    return reconciled ?? await this.executeImmediate(actor, requestId, operation, prepared);
  }

  private async prepareItem(
    actor: LiveManagementActor,
    operation: ManagementOperation,
    creationNonce?: string,
  ): Promise<ManagementPreparedItem> {
    switch (operation.kind) {
      case 'create_agent': {
        const existingGeneratedSeeds = (await this.stores.config.listUserAgents()).flatMap((agent) => {
          const avatar = agent.slackPresence?.avatar;
          return avatar?.kind === 'generated' ? [avatar.seed ?? agent.id] : [];
        });
        const intendedAfter = {
          ...materializeManagedAgent(
            actor,
            operation.agent,
            nextDefaultAgentAvatarSeed(existingGeneratedSeeds, creationNonce ?? randomUUID()),
          ),
          revision: 1,
        } satisfies CustomAgentConfig;
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
        const patch = projectManagementAgentPatch(before, operation.patch);
        return {
          itemId: operation.itemId,
          operation,
          before,
          intendedAfter: applyAgentPatch(before, patch),
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
      case 'grant_agent_channel': {
        const [beforeChannel, grants] = await Promise.all([
          this.stores.config.getChannel(operation.workspaceId, operation.channelId),
          this.stores.config.listAgentChannelGrants(operation.workspaceId, operation.channelId),
        ]);
        // The production Slack publisher resolves the live Channel, verifies
        // requester membership, and imports reach-only Channel inventory as
        // part of the confirmed grant. Store-only adapters cannot establish
        // those facts, so they must continue to require a persisted Channel.
        if (!beforeChannel && !this.stores.publishAgentChannel) {
          throw new ManagementError('revision_conflict', 'The Channel does not exist.');
        }
        const current = grants.find((grant) => grant.agentId === operation.agentId);
        requireExpectedRevision(operation.expectedRevision, current?.revision ?? 0);
        const intendedAfter = {
          workspaceId: operation.workspaceId,
          channelId: operation.channelId,
          agentId: operation.agentId!,
          revision: (current?.revision ?? 0) + 1,
          status: 'active' as const,
        };
        return {
          itemId: operation.itemId,
          operation,
          ...(current ? { before: current } : {}),
          intendedAfter,
          inverse: {
            itemId: `undo_${operation.itemId}`,
            kind: current ? 'grant_agent_channel' : 'revoke_agent_channel',
            workspaceId: operation.workspaceId,
            channelId: operation.channelId,
            agentId: operation.agentId!,
            expectedRevision: intendedAfter.revision,
          } satisfies ManagementOperation,
        };
      }
      case 'revoke_agent_channel': {
        const current = (await this.stores.config.listAgentChannelGrants(
          operation.workspaceId,
          operation.channelId,
        )).find((grant) => grant.agentId === operation.agentId);
        if (!current) throw new ManagementError('revision_conflict', 'The Channel grant does not exist.');
        requireExpectedRevision(operation.expectedRevision, current.revision);
        return {
          itemId: operation.itemId,
          operation,
          before: current,
          intendedAfter: null,
          inverse: {
            itemId: `undo_${operation.itemId}`,
            kind: 'grant_agent_channel',
            workspaceId: operation.workspaceId,
            channelId: operation.channelId,
            agentId: operation.agentId,
            expectedRevision: 0,
          },
        };
      }
      case 'update_agent_memory': {
        const before = await this.requireAgentMemory(operation.agentId);
        requireExpectedRevision(operation.expectedRevision, before.revision);
        const intendedAfter = {
          agentId: operation.agentId,
          body: operation.body,
          revision: before.revision + 1,
        };
        return {
          itemId: operation.itemId,
          operation,
          before,
          intendedAfter,
          inverse: {
            itemId: `undo_${operation.itemId}`,
            kind: 'update_agent_memory',
            agentId: operation.agentId,
            expectedRevision: intendedAfter.revision,
            body: before.body,
          },
        };
      }
      default:
        return { itemId: operation.itemId, operation };
    }
  }

  private async preflightProposalItem(
    actor: LiveManagementActor,
    operation: ManagementOperation,
    proposalId: string,
  ): Promise<ManagementPreparedItem> {
    const prepared = await this.prepareItem(actor, operation, proposalId);
    if (operation.kind === 'delete_agent') {
      const agent = await this.stores.config.getAgent(operation.agentId);
      const references = await this.stores.config.getAgentReferences(operation.agentId);
      if (references.channelGrants.length > 0 || agent.slackPresence?.userGroupId) {
        throw new ManagementError(
          'invalid_request',
          'Archive the Agent and remove its Slack reach before deleting it.',
        );
      }
    }
    if ((operation.kind === 'put_channel' && operation.channel.lifecycle === 'active') ||
        operation.kind === 'grant_agent_channel' || operation.kind === 'revoke_agent_channel') {
      const workspaceId = operation.kind === 'put_channel'
        ? operation.channel.workspaceId
        : operation.workspaceId;
      const channelId = operation.kind === 'put_channel'
        ? operation.channel.channelId
        : operation.channelId;
      await this.stores.assertAgentChannelMembership?.({ actor, workspaceId, channelId });
    }
    return prepared;
  }

  private async executeImmediate(
    actor: LiveManagementActor,
    mutationId: string,
    operation: ManagementOperation,
    prepared: ManagementPreparedItem,
  ): Promise<ImmediateMutation> {
    switch (operation.kind) {
      case 'create_agent': {
        const intended = prepared.intendedAfter as CustomAgentConfig;
        const { revision: _revision, ...createInput } = intended;
        const agent = await this.stores.config.createAgent(createInput);
        return mutationForAgent(agent, prepared.inverse, await this.agentEditorUrl(agent.id));
      }
      case 'update_agent': {
        const current = await this.stores.config.getAgent(operation.agentId);
        const agent = await this.updateAgent(
          actor,
          operation.agentId,
          projectManagementAgentPatch(current, operation.patch),
          operation.expectedRevision,
        );
        return mutationForAgent(agent, prepared.inverse);
      }
      case 'put_channel': {
        if (operation.channel.lifecycle === 'active') {
          await this.stores.assertAgentChannelMembership?.({
            actor,
            workspaceId: operation.channel.workspaceId,
            channelId: operation.channel.channelId,
          });
        }
        const channel = await this.stores.config.putChannel(
          operation.channel,
          operation.expectedRevision,
        );
        return mutationForChannel(channel, prepared.inverse);
      }
      case 'grant_agent_channel': {
        await this.stores.assertAgentChannelMembership?.({
          actor,
          workspaceId: operation.workspaceId,
          channelId: operation.channelId,
        });
        const current = (await this.stores.config.listAgentChannelGrants(
          operation.workspaceId,
          operation.channelId,
        )).find((grant) => grant.agentId === operation.agentId);
        const resumablePending = current?.status === 'pending' &&
          current.createdByMembershipId === actor.membershipId &&
          operation.expectedRevision === 0;
        if (!resumablePending) {
          requireExpectedRevision(operation.expectedRevision, current?.revision ?? 0);
        }
        if (this.stores.publishAgentChannel) {
          const published = await this.stores.publishAgentChannel({
            actor,
            workspaceId: operation.workspaceId,
            channelId: operation.channelId,
            agentId: operation.agentId!,
          });
          return mutationForGrant(
            published.grant,
            grantInverseAtRevision(prepared.inverse, published.grant.revision),
          );
        }
        const channel = await this.stores.config.getChannel(operation.workspaceId, operation.channelId);
        if (!channel) throw new ManagementError('revision_conflict', 'The Channel does not exist.');
        const grant = await this.stores.config.putAgentChannelGrant({
          workspaceId: operation.workspaceId,
          channelId: operation.channelId,
          agentId: operation.agentId!,
          status: 'active',
          createdByMembershipId: actor.membershipId,
          ...(channel.label ? { channelLabel: channel.label } : {}),
        }, operation.expectedRevision);
        return mutationForGrant(grant, prepared.inverse);
      }
      case 'revoke_agent_channel': {
        const current = (await this.stores.config.listAgentChannelGrants(
          operation.workspaceId,
          operation.channelId,
        )).find((grant) => grant.agentId === operation.agentId);
        if (!current || current.revision !== operation.expectedRevision) {
          throw new ManagementError('revision_conflict', 'The Channel grant changed.');
        }
        await this.stores.assertAgentChannelMembership?.({
          actor,
          workspaceId: operation.workspaceId,
          channelId: operation.channelId,
        });
        await this.stores.config.deleteAgentChannelGrant(
          operation.workspaceId,
          operation.channelId,
          operation.agentId,
        );
        return mutationForGrant(current, prepared.inverse, true);
      }
      case 'update_agent_memory':
        return this.executeMemoryMutation(operation);
      case 'save_routine':
      case 'control_routine':
        return this.executeRoutineMutation(actor, mutationId, operation);
      default:
        throw new ManagementError('invalid_request', 'This operation cannot apply immediately.');
    }
  }

  private async reconcilePrepared(
    actor: LiveManagementActor,
    prepared: ManagementPreparedItem,
  ): Promise<ImmediateMutation | undefined> {
    const operation = prepared.operation;
    if (!prepared.intendedAfter) return undefined;
    if (operation.kind === 'update_agent') {
      const current = await optionalAgent(this.stores.config, operation.agentId);
      if (current && current.revision >= operation.expectedRevision + 1 &&
          agentPatchMatches(current, operation.patch)) {
        return mutationForAgent(current, prepared.inverse);
      }
      return undefined;
    }
    if (operation.kind === 'create_agent') {
      const agentId = operation.agent.id;
      const current = await optionalAgent(this.stores.config, agentId);
      if (current && canonicalJson(current) === canonicalJson(prepared.intendedAfter)) {
        return mutationForAgent(
          current,
          prepared.inverse,
          await this.agentEditorUrl(current.id),
        );
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
    if (operation.kind === 'update_agent_memory') {
      const current = await this.requireAgentMemory(operation.agentId);
      if (canonicalJson(current) === canonicalJson(prepared.intendedAfter)) {
        return memoryMutation(current, prepared.inverse);
      }
      return undefined;
    }
    if (operation.kind === 'grant_agent_channel') {
      const grant = (await this.stores.config.listAgentChannelGrants(
        operation.workspaceId,
        operation.channelId,
      )).find((candidate) => candidate.agentId === operation.agentId);
      const intended = prepared.intendedAfter as Pick<AgentChannelGrant, 'revision' | 'status'>;
      if (grant && grant.status === intended.status &&
          grant.revision >= intended.revision &&
          grant.createdByMembershipId === actor.membershipId) {
        return mutationForGrant(
          grant,
          grantInverseAtRevision(prepared.inverse, grant.revision),
        );
      }
    }
    if (operation.kind === 'revoke_agent_channel') {
      const grant = (await this.stores.config.listAgentChannelGrants(
        operation.workspaceId,
        operation.channelId,
      )).find((candidate) => candidate.agentId === operation.agentId);
      if (!grant) {
        return mutationForGrant(prepared.before as AgentChannelGrant, prepared.inverse, true);
      }
    }
    return undefined;
  }

  private async executeConfirmed(
    actor: LiveManagementActor,
    operation: ManagementOperation,
    proposalId: string,
  ): Promise<ImmediateMutation> {
    if (operation.kind === 'archive_agent' || operation.kind === 'restore_agent') {
      const current = await this.stores.config.getAgent(operation.agentId);
      let agent: CustomAgentConfig;
      if (operation.kind === 'archive_agent') {
        if (this.stores.archiveAgent) {
          agent = await this.stores.archiveAgent({
            actor,
            agentId: operation.agentId,
            expectedRevision: operation.expectedRevision,
            ...(operation.replacementDefaultAgentId
              ? { replacementDefaultAgentId: operation.replacementDefaultAgentId }
              : {}),
          });
        } else {
          requireExpectedRevision(operation.expectedRevision, current.revision);
          agent = await this.stores.config.archiveAgent(operation.agentId, {
            expectedRevision: operation.expectedRevision,
            ...(operation.replacementDefaultAgentId
              ? { replacementDefaultAgentId: operation.replacementDefaultAgentId }
              : {}),
          });
        }
      } else if (this.stores.restoreAgent) {
        agent = await this.stores.restoreAgent({
          actor,
          agentId: operation.agentId,
          expectedRevision: operation.expectedRevision,
        });
      } else {
        requireExpectedRevision(operation.expectedRevision, current.revision);
        agent = await this.stores.config.restoreAgent(operation.agentId, operation.expectedRevision);
      }
      return mutationForAgent(agent);
    }
    if (operation.kind === 'delete_agent') {
      const agent = await this.stores.config.getAgent(operation.agentId);
      const references = await this.stores.config.getAgentReferences(operation.agentId);
      if (references.channelGrants.length > 0 || agent.slackPresence?.userGroupId) {
        throw new ManagementError(
          'invalid_request',
          'Archive the Agent and remove its Slack reach before deleting it.',
        );
      }
      const changed: ManagementObjectRef[] = [];
      for (const grant of references.channelGrants) {
        await this.stores.config.deleteAgentChannelGrant(
          grant.workspaceId,
          grant.channelId,
          operation.agentId,
        );
        changed.push({
          kind: 'channel_grant',
          id: grantKey(grant.workspaceId, grant.channelId, operation.agentId),
          revision: 0,
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
    if (operation.kind === 'delete_routine') {
      await this.requireRoutineMutation(actor, operation);
      const channelId = this.routineMutationChannelId(actor, operation);
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
          channelId,
        });
        return routineMutation(await service.confirm({
          token: confirmation.token,
          actorId: actor.userId,
          workspaceId: operation.workspaceId,
          channelId,
          previewHash: confirmation.previewHash,
          idempotencyKey: `management:routine:delete:${proposalId}:${operation.itemId}`,
        }));
      } catch (error) {
        if (error instanceof ManagementError) throw error;
        throw new ManagementError('revision_conflict', 'The routine changed.');
      }
    }
    if (operation.kind === 'reassign_routine_agent') {
      await this.requireRoutineMutation(actor, operation);
      const routine = await this.stores.routines!.getRoutine(operation.routineId);
      if (!routine || routine.version !== operation.expectedVersion ||
          routine.destination.kind !== 'direct_thread') {
        throw new ManagementError('revision_conflict', 'The routine changed.');
      }
      try {
        await reassignDirectRoutineAgent({
          scheduleId: routine.id,
          agentId: operation.agentId,
          ownerMembershipId: actor.membershipId,
          receiptId: `schedule_authority_${createHash('sha256')
            .update(`${proposalId}:${operation.itemId}:${operation.agentId}`)
            .digest('hex')
            .slice(0, 32)}`,
          config: this.stores.config as ConfigStore,
          identity: this.stores.identity as IdentityStore,
        });
        return routineMutation(routine);
      } catch {
        throw new ManagementError('invalid_request', 'The schedule Agent could not be reassigned.');
      }
    }
    if (operation.kind === 'update_agent' && operation.patch.enabled === false) {
      const references = await this.stores.config.getAgentReferences(operation.agentId);
      const changed: ManagementObjectRef[] = [];
      for (const grant of references.channelGrants) {
        await this.stores.config.deleteAgentChannelGrant(
          grant.workspaceId,
          grant.channelId,
          operation.agentId,
        );
        changed.push({
          kind: 'channel_grant',
          id: grantKey(grant.workspaceId, grant.channelId, operation.agentId),
          revision: 0,
        });
      }
      const agent = await this.updateAgent(
        actor,
        operation.agentId,
        projectManagementAgentPatch(
          await this.stores.config.getAgent(operation.agentId),
          operation.patch,
        ),
        operation.expectedRevision,
      );
      changed.push({ kind: 'agent', id: agent.id, revision: agent.revision });
      return {
        changed,
        resultingRevisions: Object.fromEntries(changed.map((ref) =>
          [objectRevisionKey(ref), ref.revision ?? 0])),
      };
    }
    const prepared = await this.prepareItem(actor, operation, proposalId);
    return this.executeImmediate(actor, proposalId, operation, prepared);
  }

  private async targetRevisions(operation: ManagementOperation): Promise<Record<string, number>> {
    if (operation.kind === 'create_agent') {
      return { [`agent:${operation.agent.id}`]: 0 };
    }
    if (operation.kind === 'update_agent_memory') {
      const memory = await this.stores.memory?.getAgentMemory(operation.agentId);
      return { [`memory:${operation.agentId}`]: memory?.revision ?? 0 };
    }
    if (operation.kind === 'save_routine' && !operation.routineId) return {};
    if (operation.kind === 'save_routine' || operation.kind === 'control_routine' ||
        operation.kind === 'delete_routine' || operation.kind === 'reassign_routine_agent') {
      const routineId = operation.routineId!;
      const routine = await this.stores.routines?.getRoutine(routineId);
      return { [`routine:${routineId}`]: routine?.version ?? 0 };
    }
    if (operation.kind === 'remove_provider_credential') {
      return { [`provider:${operation.providerId}`]: await this.providerRevision(operation.providerId) };
    }
    if (operation.kind === 'request_setup') {
      const setup = await this.resolveSetupTarget(operation.target);
      return setup.target.kind === 'provider_credential'
        ? { [setup.target.targetId]: setup.target.expectedRevision }
        : { [`agent:${setup.target.agentId}`]: setup.target.expectedRevision };
    }
    if (operation.kind === 'update_agent' || operation.kind === 'delete_agent' ||
        operation.kind === 'archive_agent' || operation.kind === 'restore_agent') {
      const target: Record<string, number> = { [`agent:${operation.agentId}`]: operation.expectedRevision };
      if (operation.kind === 'delete_agent' || operation.kind === 'archive_agent' ||
          (operation.kind === 'update_agent' && operation.patch.enabled === false)) {
        const references = await this.stores.config.getAgentReferences(operation.agentId);
        for (const grant of references.channelGrants) {
          const current = (await this.stores.config.listAgentChannelGrants(
            grant.workspaceId,
            grant.channelId,
          )).find((candidate) => candidate.agentId === operation.agentId);
          target[`channel_grant:${grantKey(grant.workspaceId, grant.channelId, operation.agentId)}`] =
            current?.revision ?? 0;
        }
      }
      return target;
    }
    if (operation.kind === 'put_channel') {
      return { [`channel:${channelKey(operation.channel.workspaceId, operation.channel.channelId)}`]: operation.expectedRevision };
    }
    if (operation.kind === 'grant_agent_channel' || operation.kind === 'revoke_agent_channel') {
      return {
        [`channel_grant:${grantKey(
          operation.workspaceId,
          operation.channelId,
          operation.agentId!,
        )}`]: operation.expectedRevision,
      };
    }
    if (operation.kind !== 'update_member') {
      throw new ManagementError('invalid_request', 'Unknown management revision target.');
    }
    const membership = await this.stores.identity.getMembership(operation.membershipId);
    return {
      [`membership:${operation.membershipId}`]: membership ? membershipRevision(membership) : 0,
    };
  }

  private async assertTargetRevisions(proposal: ManagementProposalRecord): Promise<void> {
    await this.assertRevisionMap(proposal.targetRevisions);
    if (proposal.operation.kind === 'delete_agent' || proposal.operation.kind === 'archive_agent' ||
        (proposal.operation.kind === 'update_agent' && proposal.operation.patch.enabled === false)) {
      const agentId = proposal.operation.agentId;
      const references = await this.stores.config.getAgentReferences(agentId);
      const expectedChannelKeys = Object.keys(proposal.targetRevisions)
        .filter((key) => key.startsWith('channel_grant:')).sort();
      const actualChannelKeys = references.channelGrants
        .map((grant) => `channel_grant:${grantKey(
          grant.workspaceId,
          grant.channelId,
          agentId,
        )}`)
        .sort();
      if (canonicalJson(expectedChannelKeys) !== canonicalJson(actualChannelKeys)) {
        throw new ManagementError('proposal_stale', 'The Agent Channel grants changed.');
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
    if (key.startsWith('channel_grant:')) {
      const [workspaceId, channelId, agentId] = parseGrantKey(key.slice('channel_grant:'.length));
      return (await this.stores.config.listAgentChannelGrants(workspaceId, channelId))
        .find((grant) => grant.agentId === agentId)?.revision ?? 0;
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
      return this.providerRevision(providerId as ManagedProviderId);
    }
    if (key.startsWith('memory:')) {
      return (await this.stores.memory?.getAgentMemory(key.slice('memory:'.length)))?.revision ?? 0;
    }
    if (key.startsWith('routine:')) {
      return (await this.stores.routines?.getRoutine(key.slice('routine:'.length)))?.version ?? 0;
    }
    throw new ManagementError('invalid_request', 'Unknown revision target.');
  }

  private async providerRevision(providerId: ManagedProviderId): Promise<number> {
    if (this.stores.providerCredentialRevision) {
      return this.stores.providerCredentialRevision(providerId);
    }
    const source = await this.stores.providerCredentialSource?.(providerId) ?? 'missing';
    return providerRevision(source);
  }

  private async updateAgent(
    actor: LiveManagementActor,
    agentId: string,
    patch: ConfigAgentPatch,
    expectedRevision: number,
  ): Promise<CustomAgentConfig> {
    const current = await this.stores.config.getAgent(agentId);
    if (current.revision !== expectedRevision) {
      throw new AgentRevisionConflictError(agentId, expectedRevision, current.revision);
    }
    await this.stores.prepareAgentUpdate?.(current, patch);
    const agent = await this.stores.config.updateAgent(agentId, patch, expectedRevision);
    return this.stores.reconcileAgentUpdate?.({ actor, previous: current, agent, patch }) ?? agent;
  }

  private async reconcileConfirmed(
    actor: LiveManagementActor,
    proposal: ManagementProposalRecord,
  ): Promise<ManagementApplyResult | undefined> {
    const operation = proposal.operation;
    let changed: ManagementObjectRef[] | undefined;
    if (operation.kind === 'delete_agent') {
      const current = await optionalAgent(this.stores.config, operation.agentId);
      if (!current) changed = [{ kind: 'agent', id: operation.agentId }];
    } else if (operation.kind === 'archive_agent') {
      const current = await optionalAgent(this.stores.config, operation.agentId);
      if (current?.lifecycle === 'archived') {
        changed = [{ kind: 'agent', id: current.id, revision: current.revision }];
      } else if (current) {
        changed = (await this.executeConfirmed(actor, operation, proposal.proposalId)).changed;
      }
    } else if (operation.kind === 'restore_agent') {
      const current = await optionalAgent(this.stores.config, operation.agentId);
      const presenceSettled = current?.slackPresence?.desiredState === 'active' &&
        (current.slackPresence.health === 'healthy' || current.slackPresence.health === 'unpublished');
      if (current && current.lifecycle !== 'archived' && presenceSettled) {
        changed = [{ kind: 'agent', id: current.id, revision: current.revision }];
      } else if (current) {
        changed = (await this.executeConfirmed(actor, operation, proposal.proposalId)).changed;
      }
    } else if (operation.kind === 'grant_agent_channel') {
      const current = (await this.stores.config.listAgentChannelGrants(
        operation.workspaceId,
        operation.channelId,
      )).find((grant) => grant.agentId === operation.agentId);
      if (current?.status === 'active' && current.createdByMembershipId === actor.membershipId) {
        changed = mutationForGrant(current).changed;
      } else {
        changed = (await this.executeImmediate(actor, proposal.proposalId, operation, {
          itemId: operation.itemId,
          operation,
        })).changed;
      }
    } else if (operation.kind === 'revoke_agent_channel') {
      const current = (await this.stores.config.listAgentChannelGrants(
        operation.workspaceId,
        operation.channelId,
      )).find((grant) => grant.agentId === operation.agentId);
      if (!current) {
        changed = [{
          kind: 'channel_grant',
          id: grantKey(operation.workspaceId, operation.channelId, operation.agentId),
          revision: 0,
        }];
      } else {
        changed = (await this.executeImmediate(actor, proposal.proposalId, operation, {
          itemId: operation.itemId,
          operation,
        })).changed;
      }
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

function actorPrincipal(actor: LiveManagementActor): AuthPrincipal {
  return {
    userId: actor.userId,
    membershipId: actor.membershipId,
    organizationId: actor.organizationId,
    role: actor.role,
    authenticatorKind: actor.origin.kind,
    credentialId: `management:${actor.membershipId}`,
    correlationId: managementActorOriginKey(actor),
    machine: false,
  };
}

function managementActorOriginKey(actor: LiveManagementActor): string {
  const origin = managementOriginKey(actor.origin);
  return actor.actingAgentId ? `${origin}:agent:${actor.actingAgentId}` : origin;
}

function managementStorageIdempotencyKey(actor: LiveManagementActor, publicKey: string): string {
  return actor.actingAgentId ? `agent.${actor.actingAgentId}.${publicKey}` : publicKey;
}

function publicManagementIdempotencyKey(actor: LiveManagementActor, storageKey: string): string {
  if (!actor.actingAgentId) return storageKey;
  const prefix = `agent.${actor.actingAgentId}.`;
  if (!storageKey.startsWith(prefix)) {
    throw new ManagementError('idempotency_conflict', 'The management request Agent changed.');
  }
  return storageKey.slice(prefix.length);
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

function emitAgentAuthoringOutcome(
  actor: LiveManagementActor,
  operations: readonly ManagementOperation[],
  fields: Readonly<Record<string, ManagementMetricValue>>,
): void {
  emitManagementMetric('agent_authoring.outcome', {
    surface: actor.origin.kind,
    guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
    posture: 'commit',
    artifactClass: agentAuthoringArtifactClass(operations),
    operationCount: operations.length,
    ...fields,
  });
}

function authoringProposalOutcome(
  result: ManagementApplyResult,
): 'applied' | 'partial' | 'setup_required' | 'failed' {
  if (result.outcomes.some(({ disposition }) => disposition === 'setup_required')) {
    return 'setup_required';
  }
  if (result.status === 'partial') return 'partial';
  if (result.outcomes.some(({ disposition }) => disposition === 'failed')) return 'failed';
  return 'applied';
}

function authoringProposalFailure(
  error: unknown,
): Readonly<Record<string, ManagementMetricValue>> {
  if (error instanceof ChickpeaHandoffRequired) {
    return {
      proposalOutcome: 'denied',
      handoffClass: error.handoff.target.kind === 'agent' ? 'cross_agent' : 'workspace_authority',
    };
  }
  if (!(error instanceof ManagementError)) return { proposalOutcome: 'failed' };
  if (error.code === 'proposal_binding_mismatch') {
    return { proposalOutcome: 'stale', staleReason: 'binding' };
  }
  if (error.code === 'proposal_expired') {
    return { proposalOutcome: 'stale', staleReason: 'expired' };
  }
  if (error.code === 'revision_conflict') {
    return { proposalOutcome: 'stale', staleReason: 'target_revision' };
  }
  if (error.code === 'proposal_stale') {
    return { proposalOutcome: 'stale', staleReason: 'unknown' };
  }
  if (error.code === 'forbidden') {
    return { proposalOutcome: 'denied', staleReason: 'permission_changed' };
  }
  return { proposalOutcome: 'failed' };
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
  if (operation.kind === 'grant_agent_channel' && operation.agentClientRef) {
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
  } as CustomAgentConfig & { model?: string | null };
  if (patch.model === null) delete next.model;
  return next as CustomAgentConfig;
}

function materializeManagedAgent(
  actor: LiveManagementActor,
  input: ManagementAgentCreateInput,
  avatarSeed: string,
): AgentCreateInput & { kind: 'user' } {
  const { requestedHandle, ...agent } = input;
  const handle = requestedHandle ?? input.name;
  const normalizedHandle = normalizeAgentHandle(handle);
  return {
    ...agent,
    kind: 'user',
    lifecycle: 'active',
    enabled: true,
    mcpServers: [],
    apiConnections: [],
    repositories: [],
    creatorMembershipId: actor.membershipId,
    editPolicy: input.editPolicy ?? 'creator_and_admins',
    configurationGeneration: 1,
    slackPresence: {
      requestedHandle: handle,
      normalizedHandle,
      desiredState: 'unpublished',
      health: 'unpublished',
      avatar: {
        kind: 'generated',
        revision: 1,
        seed: avatarSeed,
      },
    },
  };
}

function projectManagementAgentPatch(
  agent: CustomAgentConfig,
  patch: ManagementAgentPatch,
): ConfigAgentPatch {
  const { requestedHandle, ...configPatch } = patch;
  if (requestedHandle === undefined) return configPatch;
  const presence = agent.slackPresence ?? {
    requestedHandle: normalizeAgentHandle(agent.name || agent.id),
    normalizedHandle: normalizeAgentHandle(agent.name || agent.id),
    desiredState: 'unpublished' as const,
    health: 'unpublished' as const,
    avatar: { kind: 'generated' as const, revision: 1, seed: agent.id },
  };
  return {
    ...configPatch,
    slackPresence: {
      ...presence,
      requestedHandle,
      normalizedHandle: normalizeAgentHandle(requestedHandle),
      health: presence.desiredState === 'active' ? 'pending' : presence.health,
    },
  };
}

function fullAgentPatch(agent: CustomAgentConfig): ConfigAgentPatch {
  return {
    name: agent.name,
    ...(agent.description !== undefined ? { description: agent.description } : {}),
    instructions: agent.instructions,
    enabled: agent.enabled,
    ...(agent.lifecycle ? { lifecycle: agent.lifecycle } : {}),
    ...(agent.creatorMembershipId ? { creatorMembershipId: agent.creatorMembershipId } : {}),
    ...(agent.editPolicy ? { editPolicy: agent.editPolicy } : {}),
    ...(agent.configurationGeneration !== undefined
      ? { configurationGeneration: agent.configurationGeneration }
      : {}),
    ...(agent.slackPresence ? { slackPresence: { ...agent.slackPresence } } : {}),
    ...(agent.archivedAt !== undefined ? { archivedAt: agent.archivedAt } : {}),
    model: agent.model ?? null,
    skills: agent.skills,
    mcpServers: agent.mcpServers,
    apiConnections: agent.apiConnections,
    repositories: agent.repositories,
  };
}

function mutationForAgent(
  agent: CustomAgentConfig,
  inverse?: ManagementOperation,
  handoffUrl?: string,
): ImmediateMutation {
  const changed = [{ kind: 'agent' as const, id: agent.id, revision: agent.revision }];
  return {
    changed,
    ...(inverse ? { inverse } : {}),
    ...(handoffUrl ? { handoffUrl } : {}),
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

function mutationForGrant(
  grant: AgentChannelGrant,
  inverse?: ManagementOperation,
  deleted = false,
): ImmediateMutation {
  const id = grantKey(grant.workspaceId, grant.channelId, grant.agentId);
  const revision = deleted ? 0 : grant.revision;
  return {
    changed: [{ kind: 'channel_grant', id, revision }],
    ...(inverse ? { inverse } : {}),
    resultingRevisions: { [`channel_grant:${id}`]: revision },
  };
}

function grantInverseAtRevision(
  inverse: ManagementOperation | undefined,
  revision: number,
): ManagementOperation | undefined {
  if (!inverse ||
      (inverse.kind !== 'grant_agent_channel' && inverse.kind !== 'revoke_agent_channel')) {
    return inverse;
  }
  return { ...inverse, expectedRevision: revision };
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

function capabilityScopeExpanded(agent: CustomAgentConfig, patch: ManagementAgentPatch): boolean {
  if (patch.repositories && containsExpandedRepositories(agent.repositories, patch.repositories)) return true;
  if (patch.mcpServers && containsExpandedMcp(agent.mcpServers, patch.mcpServers)) return true;
  if (patch.apiConnections && containsExpandedApi(agent.apiConnections, patch.apiConnections)) return true;
  return false;
}

function uniqueModelChoices(
  choices: Array<{ id: string; name?: string }>,
): Array<{ id: string; name?: string }> {
  const byId = new Map<string, { id: string; name?: string }>();
  for (const choice of choices) {
    if (!choice.id || byId.has(choice.id)) continue;
    byId.set(choice.id, choice);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function selfCapabilityHealth(
  agent: CustomAgentConfig,
  grants: AgentChannelGrant[],
  reusableConnections: NonNullable<ManagementWorkspaceSnapshot['agents'][number]['connections']>,
): NonNullable<ManagementWorkspaceSnapshot['selfManagement']>['capabilityHealth'] {
  const mcpConnections = { ready: 0, pending: 0, failed: 0 };
  for (const connection of agent.mcpServers) mcpConnections[connection.lifecycleStatus] += 1;
  const apiConnections = { ready: 0, pending: 0, failed: 0 };
  for (const connection of agent.apiConnections) {
    apiConnections[connection.lifecycleStatus ?? 'ready'] += 1;
  }
  return {
    mcpConnections,
    apiConnections,
    reusableConnections: {
      ready: reusableConnections.filter(({ enabled, lifecycle }) =>
        enabled && lifecycle === 'ready').length,
      pending: reusableConnections.filter(({ enabled, lifecycle }) =>
        enabled && lifecycle === 'pending').length,
      needsAttention: reusableConnections.filter(({ enabled, lifecycle }) =>
        enabled && lifecycle === 'needs_attention').length,
      disabled: reusableConnections.filter(({ enabled }) => !enabled).length,
    },
    repositories: {
      enabled: agent.repositories.filter(({ enabled }) => enabled).length,
      setupRequired: agent.repositories.filter(({ enabled, installationId }) =>
        enabled && installationId === null).length,
    },
    channelGrants: {
      active: grants.filter(({ status }) => status === 'active').length,
      pending: grants.filter(({ status }) => status === 'pending').length,
      needsAttention: grants.filter(({ status }) => status === 'needs_attention').length,
    },
  };
}

function managementConnectionProjection(
  account: ConnectionAccount,
  binding: AgentConnectionBinding,
  policy: ConnectionAccountPolicy,
): NonNullable<ManagementWorkspaceSnapshot['agents'][number]['connections']>[number] & {
  accountRevision: number;
  bindingAccountId: string;
  bindingRevision: number;
} {
  if (account.lifecycle === 'revoked') {
    throw new Error('Revoked connections cannot enter a management snapshot.');
  }
  const allowedCapabilities = policy.kind === 'managed'
    ? policy.allowedCapabilities
    : policy.kind === 'mcp'
      ? policy.allowedTools
      : policy.authMode === 'oauth'
        ? policy.oauthScopes ?? []
        : policy.allowedMethods;
  return {
    id: account.id,
    providerId: account.providerId,
    label: account.label,
    ...(account.purpose ? { purpose: account.purpose } : {}),
    ownerKind: account.ownerKind,
    lifecycle: account.lifecycle,
    enabled: binding.enabled,
    allowedCapabilities,
    accountRevision: account.revision,
    bindingAccountId: binding.connectionAccountId,
    bindingRevision: Number.parseInt(createHash('sha256')
      .update(canonicalJson({
        providerId: binding.providerId,
        allowedCapabilities: [...binding.allowedCapabilities].sort(),
        resourceConstraints: binding.resourceConstraints,
        enabled: binding.enabled,
      }))
      .digest('hex')
      .slice(0, 12), 16),
  };
}

function isUserAgentScoped(actor: LiveManagementActor): actor is LiveManagementActor & {
  actingAgentId: string;
} {
  return Boolean(actor.actingAgentId && actor.actingAgentId !== CHICKPEA_AGENT_ID);
}

function slackDirectOrigin(
  actor: LiveManagementActor,
): Extract<ManagementOrigin, { kind: 'slack' }> | undefined {
  return actor.origin.kind === 'slack' && actor.origin.conversationKind === 'im'
    ? actor.origin
    : undefined;
}

function operationAgentScopeTarget(
  requestedAction: ChickpeaManagementHandoff['requestedAction'],
  agentId: string,
  target: ChickpeaManagementHandoff['target'] = { kind: 'agent', id: agentId },
): ActingAgentScopeTarget {
  return { scope: 'agent', agentId, requestedAction, target };
}

function operationAuthorityScopeTarget(
  operation: ManagementOperation,
): ActingAgentScopeTarget {
  return {
    scope: 'authority',
    requestedAction: operation.kind,
    target: handoffTargetForOperation(operation),
  };
}

function handoffTargetForOperation(
  operation: ManagementOperation,
): ChickpeaManagementHandoff['target'] {
  if (operation.kind === 'create_agent') {
    return { kind: 'agent', id: operation.agent.id };
  }
  if (operation.kind === 'update_agent' || operation.kind === 'delete_agent' ||
      operation.kind === 'archive_agent' || operation.kind === 'restore_agent' ||
      operation.kind === 'update_agent_memory') {
    return { kind: 'agent', id: operation.agentId };
  }
  if (operation.kind === 'put_channel') {
    return {
      kind: 'channel',
      id: channelKey(operation.channel.workspaceId, operation.channel.channelId),
    };
  }
  if (operation.kind === 'grant_agent_channel' || operation.kind === 'revoke_agent_channel') {
    return {
      kind: 'channel',
      id: channelKey(operation.workspaceId, operation.channelId),
    };
  }
  if (operation.kind === 'update_member') {
    return {
      kind: 'membership',
      id: operation.membershipId,
    };
  }
  if (operation.kind === 'remove_provider_credential') {
    return {
      kind: 'provider',
      id: operation.providerId,
    };
  }
  if (operation.kind === 'save_routine' || operation.kind === 'control_routine' ||
      operation.kind === 'delete_routine' || operation.kind === 'reassign_routine_agent') {
    return {
      kind: 'routine',
      id: operation.routineId ?? channelKey(
        operation.workspaceId,
        'channelId' in operation ? operation.channelId ?? 'current_dm_thread' : 'current_dm_thread',
      ),
    };
  }
  if (operation.target.kind === 'provider_credential') {
    return {
      kind: 'provider',
      id: operation.target.providerId,
    };
  }
  return {
    kind: 'agent',
    id: operation.target.agentId ?? operation.target.agentClientRef ?? 'unresolved_agent',
  };
}

function chickpeaHandoff(
  actor: LiveManagementActor,
  requestedAction: ChickpeaManagementHandoff['requestedAction'],
  target: ChickpeaManagementHandoff['target'],
): ChickpeaManagementHandoff {
  if (!actor.actingAgentId || actor.actingAgentId === CHICKPEA_AGENT_ID) {
    throw new ManagementError('forbidden', 'The acting Agent handoff is unavailable.');
  }
  return {
    kind: 'chickpea_handoff',
    chickpeaAgentId: CHICKPEA_AGENT_ID,
    actingAgentId: actor.actingAgentId,
    requestedAction,
    target,
    instruction: 'Mention @Chickpea in this thread to continue.',
  };
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
    return !prior?.enabled || mcpSecurityBoundaryChanged(prior, connection) ||
      !isSubset(connection.allowedTools, prior.allowedTools) ||
      !isSubset(scopeTokens(connection.oauthScope), scopeTokens(prior.oauthScope));
  });
}

function mcpSecurityBoundaryChanged(
  before: CustomAgentConfig['mcpServers'][number],
  after: CustomAgentConfig['mcpServers'][number],
): boolean {
  return before.url !== after.url ||
    before.transport !== after.transport ||
    before.authMode !== after.authMode ||
    canonicalJson([...before.headerNames].sort()) !== canonicalJson([...after.headerNames].sort());
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

function agentPatchMatches(agent: CustomAgentConfig, patch: ManagementAgentPatch): boolean {
  const before = { ...agent, revision: agent.revision - 1 };
  const expected = applyAgentPatch(before, projectManagementAgentPatch(before, patch));
  return canonicalJson(agent) === canonicalJson(expected);
}

function proposalSummary(operation: ManagementOperation, reason: string): string {
  const target = operation.kind === 'update_member'
    ? operation.membershipId
    : operation.kind === 'remove_provider_credential'
      ? `provider:${operation.providerId}`
    : operation.kind === 'update_agent_memory'
      ? `memory:${operation.agentId}`
    : operation.kind === 'save_routine' || operation.kind === 'control_routine' ||
        operation.kind === 'delete_routine' || operation.kind === 'reassign_routine_agent'
      ? `routine:${operation.routineId ?? ('channelId' in operation ? operation.channelId : undefined)}`
    : operation.kind === 'put_channel'
      ? channelKey(operation.channel.workspaceId, operation.channel.channelId)
      : operation.kind === 'grant_agent_channel' || operation.kind === 'revoke_agent_channel'
        ? grantKey(operation.workspaceId, operation.channelId, operation.agentId!)
        : operation.kind === 'create_agent'
          ? operation.agent.id
          : operation.kind === 'request_setup'
            ? operation.target.kind === 'provider_credential'
              ? `provider:${operation.target.providerId}`
              : operation.target.agentId ?? operation.target.agentClientRef ?? 'agent'
            : operation.agentId;
  return `${reason}:${operation.kind}:${target}`;
}

function assertBaseAgentCreationContract(operations: readonly ManagementOperation[]): void {
  for (const operation of operations) {
    const skills = operation.kind === 'create_agent'
      ? operation.agent.skills
      : operation.kind === 'update_agent'
        ? operation.patch.skills
        : undefined;
    if (skills?.some(({ name }) => name === 'agent-authoring')) {
      throw new ManagementError(
        'invalid_request',
        'The agent-authoring skill name is reserved by Chickpea.',
      );
    }
    if (operation.kind !== 'create_agent') continue;
    if (operation.agent.mcpServers.length || operation.agent.apiConnections.length ||
        operation.agent.repositories.length) {
      throw new ManagementError(
        'base_agent_capabilities_require_setup',
        'Create the base Agent without connections or repositories, then add approved access separately.',
      );
    }
  }
}

function managementPreviewTarget(operation: ManagementOperation): string {
  if (operation.kind === 'create_agent') return `agent:${operation.agent.id}`;
  if (operation.kind === 'update_agent' || operation.kind === 'delete_agent' ||
      operation.kind === 'archive_agent' || operation.kind === 'restore_agent' ||
      operation.kind === 'update_agent_memory') return `agent:${operation.agentId}`;
  if (operation.kind === 'put_channel') {
    return `channel:${channelKey(operation.channel.workspaceId, operation.channel.channelId)}`;
  }
  if (operation.kind === 'grant_agent_channel' || operation.kind === 'revoke_agent_channel') {
    const agentId = operation.kind === 'grant_agent_channel'
      ? operation.agentId ?? operation.agentClientRef ?? 'unresolved'
      : operation.agentId;
    return `channel_grant:${grantKey(
      operation.workspaceId,
      operation.channelId,
      agentId,
    )}`;
  }
  if (operation.kind === 'update_member') return `membership:${operation.membershipId}`;
  if (operation.kind === 'remove_provider_credential') return `provider:${operation.providerId}`;
  if (operation.kind === 'save_routine' || operation.kind === 'control_routine' ||
      operation.kind === 'delete_routine' || operation.kind === 'reassign_routine_agent') {
    return `routine:${operation.routineId ?? `${operation.workspaceId}:${'channelId' in operation ? operation.channelId : 'current_dm_thread'}`}`;
  }
  return operation.target.kind === 'provider_credential'
    ? `provider:${operation.target.providerId}`
    : `agent:${operation.target.agentId ?? operation.target.agentClientRef ?? 'unresolved'}`;
}

function boundedChangeSetPreview(preview: ManagementChangeSetPreview): ManagementChangeSetPreview {
  if (Buffer.byteLength(JSON.stringify(preview), 'utf8') > 128 * 1024) {
    throw new ManagementError(
      'invalid_request',
      'The reviewed change diff is too large. Split it into smaller proposals.',
    );
  }
  return preview;
}

function changeSetPreparedItem(
  proposal: ManagementChangeSetProposalRecord,
  operation: ManagementOperation,
): ManagementPreparedItem {
  const change = proposal.preview.changes.find(({ itemId }) => itemId === operation.itemId);
  if (!change || change.operationKind !== operation.kind) {
    throw new ManagementError('proposal_stale', 'The reviewed change preview is unavailable.');
  }
  return {
    itemId: operation.itemId,
    operation,
    ...('before' in change ? { before: change.before } : {}),
    ...('after' in change ? { intendedAfter: change.after } : {}),
  };
}

function canExecuteImmediately(operation: ManagementOperation): boolean {
  return operation.kind === 'create_agent' ||
    (operation.kind === 'update_agent' && operation.patch.enabled !== false) ||
    operation.kind === 'put_channel' || operation.kind === 'grant_agent_channel' ||
    operation.kind === 'revoke_agent_channel' || operation.kind === 'update_agent_memory' ||
    operation.kind === 'save_routine' || operation.kind === 'control_routine';
}

function invalidatesChangeSetProposal(error: unknown): boolean {
  return error instanceof ChickpeaHandoffRequired || error instanceof ManagementError;
}

function publicChangeSetProposal(
  proposal: ManagementChangeSetProposalRecord,
): ProposeWorkspaceChangesResult {
  return {
    proposalId: proposal.proposalId,
    status: 'pending',
    digest: proposal.digest,
    guide: {
      version: AGENT_AUTHORING_GUIDE_VERSION,
      uri: AGENT_AUTHORING_GUIDE_URI,
      digest: AGENT_AUTHORING_GUIDE_DIGEST,
    },
    preview: proposal.preview,
    expiresAt: proposal.expiresAt,
    confirmationTool: 'confirm_workspace_change',
  };
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

function memoryMutation(memory: AgentMemory, inverse?: ManagementOperation): ImmediateMutation {
  return {
    changed: [{ kind: 'memory', id: memory.agentId, revision: memory.revision }],
    ...(inverse ? { inverse } : {}),
    resultingRevisions: { [`memory:${memory.agentId}`]: memory.revision },
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

function withoutSetupCapabilities(result: ManagementApplyResult): ManagementApplyResult {
  return {
    ...result,
    outcomes: result.outcomes.map(({
      setupUrl: _setupUrl,
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
      ...outcome
    }) => outcome),
  };
}

function channelKey(workspaceId: string, channelId: string): string {
  return `${workspaceId}/${channelId}`;
}

function grantKey(workspaceId: string, channelId: string, agentId: string): string {
  return `${workspaceId}/${channelId}/${agentId}`;
}

function parseGrantKey(key: string): [string, string, string] {
  const parts = key.split('/');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new ManagementError('invalid_request', 'Invalid Channel grant revision target.');
  }
  return parts as [string, string, string];
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
    error instanceof AgentPresenceError ||
    error instanceof UnknownAgentError ||
    error instanceof AgentExistsError ||
    error instanceof AgentRevisionConflictError ||
    error instanceof ChannelRevisionConflictError ||
    error instanceof AgentStillReferencedError;
}

function mutationErrorCode(error: unknown): string {
  if (error instanceof ManagementError) return error.code;
  if (error instanceof AgentPresenceError) return error.code;
  if (error instanceof AgentRevisionConflictError || error instanceof ChannelRevisionConflictError) {
    return 'revision_conflict';
  }
  if (error instanceof UnknownAgentError) return 'not_found';
  if (error instanceof AgentExistsError) return 'already_exists';
  if (error instanceof AgentStillReferencedError) return 'still_referenced';
  return 'mutation_failed';
}
