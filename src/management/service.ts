import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { canEditAgent } from '../auth/permissions.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import { CHICKPEA_AGENT_ID, isAgentId } from '../config/agent-id.ts';
import {
  CONNECTION_CATALOG_PRESETS,
  resolveConnectorCatalogPreset,
  type ConnectorCatalogPreset,
  type ConnectorPreset,
} from '../config/presets.ts';
import { MANAGED_CONNECTOR_CATALOG } from '../connections/catalog/index.ts';
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
  type SkillConfig,
} from '../config/types.ts';
import {
  parseSkillSource,
  resolveSkillSource,
  SkillImportError,
  type ParsedSkillSource,
  type SkillResolution,
} from '../config/skill-import.ts';
import { isValidRepositoryFullName } from '../config/github-app.ts';
import {
  applyConnectionCapabilityCeiling,
  projectRecoverableConnectionAccounts,
} from '../connections/runtime.ts';
import type { IdentityStore, Membership } from '../identity/types.ts';
import type {
  AgentMemory,
  MemoryStateStore,
} from '../memory/types.ts';
import { RoutineService } from '../routines/service.ts';
import { requestsChannelThreadDelivery } from '../routines/provenance.ts';
import { reassignDirectRoutineAgent } from '../routines/agent-authority.ts';
import {
  executeSlackScheduleCommand,
  SlackScheduleCommandError,
  type SlackScheduleCommand,
} from '../routines/slack-command.ts';
import { RoutineStateError, type RoutineDefinition, type RoutineStore } from '../routines/types.ts';
import type { WorkStore } from '../work/types.ts';
import { normalizeAgentHandle } from '../slack/agent-presence/handles.ts';
import { AgentPresenceError } from '../slack/agent-presence/errors.ts';
import { nextDefaultAgentAvatarSeed } from '../slack/agent-presence/default-avatar-pool.ts';
import { stripLeadingUserMentions } from '../slack/command-address.ts';
import { escapeSlackControlCharacters } from '../slack/message-format.ts';
import { agentAvatarUrlForPresentation } from '../slack/agent-presence/avatar-assets.ts';
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import {
  AGENT_AUTHORING_GUIDE_DIGEST,
  AGENT_AUTHORING_GUIDE_URI,
  AGENT_AUTHORING_GUIDE_VERSION,
} from './agent-authoring/index.ts';
import {
  canonicalJson,
  effectiveConfigurationRevision,
  managementApprovalScopeKey,
  managementActorOriginKey,
  managementOperationDigest,
  managementOriginKey,
  managementStorageIdempotencyKey,
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
  formatSlackChangeSetProposal,
  formatSlackSkillImportProposal,
} from './slack-presentation.ts';
import {
  agentAuthoringArtifactClass,
  emitManagementMetric,
  type ManagementMetricValue,
} from './telemetry.ts';
import { selectAgentCreationConnectors } from './agent-creation-welcome.ts';
import {
  ChickpeaHandoffRequired,
  ManagementError,
  type ApplyWorkspaceChangesResult,
  type ApplyWorkspaceChangesInput,
  type ConfirmWorkspaceChangeInput,
  type LiveManagementActor,
  type ManagementApplyResult,
  type ManagementChangeSetPreview,
  type ManagementChangeSetProposalRecord,
  type ChickpeaManagementHandoff,
  type ManagementDuplicateIdentityResult,
  type ManagementItemOutcome,
  type ImportSkillInput,
  type ImportSkillResult,
  type ManageAgentSkillInput,
  type ManageAgentSkillResult,
  type SkillActionReceiptMetadata,
  type ManagementMemorySnapshot,
  type ManagementAgentCreateInput,
  type ManagementAgentPatch,
  type ManagementObjectRef,
  type ManagementOperation,
  type ManagementOrigin,
  type ManagementOperationResult,
  type ManagementPreparedItem,
  type ManagementProposalRecord,
  type ManagementRequestRecord,
  type ManagementRequestProgress,
  type ManagementRoutineInspectionInput,
  type ManagementRoutineSnapshot,
  type ManagementSetupPublicStatus,
  type ManagementSetupRecord,
  type ManagementSetupTarget,
  type ManagementWorkspaceSnapshot,
  type PrepareConnectorSetupInput,
  type PrepareConnectorSetupResult,
  type FinalizeSlackAgentCreationWelcomeInput,
  type FinalizeSlackAgentCreationWelcomeResult,
  type ManagementAgentCreatedWelcome,
  type ManagementReceiptOutboxRecord,
  type ProposeSkillImportInput,
  type ProposeSkillImportResult,
  type ProposeWorkspaceChangesInput,
  type ProposeWorkspaceChangesResult,
  type UndoWorkspaceChangeInput,
} from './types.ts';

const MANAGEMENT_CHANGE_SET_APPLY_LEASE_MS = 30_000;
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
    | 'listAgentScheduleReferences'
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
  managedConnectorAvailable?: (input: {
    toolkit: string;
    accessLane: 'read' | 'write';
  }) => Promise<boolean>;
  listAvailableModels?: () => Promise<Array<{ id: string; name?: string }>>;
  /** Test seam for the public, bounded GitHub skill resolver. */
  resolveSkillImport?: (source: ParsedSkillSource) => Promise<SkillResolution>;
  publishAgentPresence?: (input: {
    actor: LiveManagementActor;
    agentId: string;
    inferredHandle: boolean;
  }) => Promise<{ agent: CustomAgentConfig; warning?: string }>;
  publishAgentChannel?: (input: {
    actor: LiveManagementActor;
    workspaceId: string;
    channelId: string;
    agentId: string;
  }) => Promise<{ agent: CustomAgentConfig; grant: AgentChannelGrant }>;
  publishGeneratedAgentAvatar?: (input: {
    workspaceId: string;
    agentId: string;
    revision: number;
    seed: string;
  }) => Promise<{ url: string; revision: number } | undefined>;
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
  deleteAgent?: (input: {
    actor: LiveManagementActor;
    agentId: string;
    expectedRevision: number;
  }) => Promise<boolean>;
  now?: () => number;
  randomId?: () => string;
  randomCapability?: () => string;
  productTelemetry?: ProductTelemetryCapture;
}

interface ImmediateMutation {
  changed: ManagementObjectRef[];
  inverse?: ManagementOperation;
  resultingRevisions: Record<string, number>;
  handoffUrl?: string;
  warning?: string;
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

  private async captureAgentCreated(actor: LiveManagementActor, agentId: string): Promise<void> {
    if (!this.stores.productTelemetry) return;
    try {
      const workspaceId = actor.origin.kind === 'slack'
        ? actor.origin.workspaceId
        : (await this.stores.identity.getUser(actor.userId))?.slackTeamId;
      if (!workspaceId) return;
      this.stores.productTelemetry.capture({
        event: 'agent_created',
        workspaceId,
        agentId,
        surface: actor.origin.kind,
      });
    } catch {
      // Advisory telemetry never changes a committed management mutation.
    }
  }

  async inspectWorkspace(
    context: ApplyWorkspaceChangesInput['context'],
  ): Promise<ManagementWorkspaceSnapshot> {
    const actor = await this.requireLiveActor(context);
    return this.snapshot(actor);
  }

  async proposeSkillImport(
    input: ProposeSkillImportInput,
  ): Promise<ProposeSkillImportResult> {
    const resolved = await this.resolveSkillImportCandidate(input, 'propose_skill_import');
    if ('status' in resolved) return resolved;
    const { agent, agentId, skill, skills, existingIndex } = resolved;
    const proposal = await this.proposeWorkspaceChanges({
      context: input.context,
      idempotencyKey: input.idempotencyKey,
      guideVersion: input.guideVersion,
      authoringReason: 'skill_creation',
      operations: [{
        itemId: 'skill-import',
        kind: 'update_agent',
        agentId,
        expectedRevision: agent.revision,
        patch: { skills },
      }],
    });
    const { preview: _privatePreview, ...publicProposal } = proposal;
    return {
      ...publicProposal,
      presentation: {
        slack: formatSlackSkillImportProposal(proposal.preview, skill.sourceUrl),
      },
      import: skillImportMetadata(skill, existingIndex >= 0),
    };
  }

  async importSkill(input: ImportSkillInput): Promise<ImportSkillResult> {
    const actor = await this.requireLiveActor(input.context);
    assertExplicitSkillImportRequest(actor, input);
    const replayOperationId = skillImportOperationId(actor, input);
    const replay = await this.stores.management.getRequest(replayOperationId);
    if (replay) return await this.replaySkillImport(actor, replay);

    const resolved = await this.resolveSkillImportCandidate(input, 'import_skill');
    if ('status' in resolved) return resolved;
    const { agent, agentId, skill, importedSkill, skills, existingIndex } = resolved;
    const metadata = skillImportMetadata(skill, existingIndex >= 0);
    const existing = existingIndex >= 0 ? agent.skills[existingIndex] : undefined;
    if (existing && canonicalJson(existing) === canonicalJson(importedSkill)) {
      return {
        status: 'already_installed',
        presentation: {
          slack: `Skill \`${escapeSlackControlCharacters(skill.name)}\` is already installed on ${
            escapeSlackControlCharacters(agent.name)
          }. No changes were made.`,
        },
        import: { ...metadata, replacedExisting: false },
      };
    }
    if (existing && input.replaceExisting !== true) {
      return {
        status: 'replacement_confirmation_required',
        instruction: `Skill ${skill.name} already exists with different content. Ask the requester to reply exactly \`replace ${skill.name} from ${skill.sourceUrl}\`. On that new message, call import_skill with that immutable source, replaceExisting true, and a new idempotencyKey. Do not ask for a separate approval after that clarification.`,
        import: { ...metadata, replacedExisting: true },
      };
    }
    if (existing && !explicitSkillReplacementRequest(actor, skill)) {
      throw new ManagementError(
        'invalid_request',
        `Replacement needs a new requester message that says \`replace ${skill.name} from ${skill.sourceUrl}\`. No change was made.`,
      );
    }
    const operationId = 'skill-import';
    const applied = requireManagementApplyResult(await this.applyWorkspaceChanges({
      context: input.context,
      idempotencyKey: input.idempotencyKey,
      operationId: replayOperationId,
      operations: [{
        itemId: operationId,
        kind: 'update_agent',
        agentId,
        expectedRevision: agent.revision,
        patch: { skills },
      }],
      approvalBasis: 'explicit_requester_command',
      trustedReversibleOperationIds: [operationId],
      acknowledgementOwner: 'caller',
      receiptMetadata: { skillImport: metadata },
    }));
    const outcome = applied.outcomes.find(({ itemId }) => itemId === operationId);
    if (applied.status !== 'completed' || outcome?.disposition !== 'applied') {
      throw new ManagementError(
        'invalid_state',
        `The bounded skill import did not complete (operation ${applied.operationId}). Inspect the Agent, then retry with a new idempotency key.`,
      );
    }
    const undoAvailable = outcome.undoAvailable === true;
    const verb = existing ? 'Replaced' : 'Installed';
    return {
      status: 'installed',
      operationId: applied.operationId,
      activation: applied.activation,
      undoAvailable,
      presentation: {
        slack: `${verb} skill \`${escapeSlackControlCharacters(skill.name)}\` on ${
          escapeSlackControlCharacters(agent.name)
        }. It’s active from the next message.${undoAvailable ? ' You can undo this change.' : ''}`,
      },
      import: metadata,
    };
  }

  async manageAgentSkill(input: ManageAgentSkillInput): Promise<ManageAgentSkillResult> {
    const actor = await this.requireLiveActor(input.context);
    const agentId = input.agentId ??
      (actor.origin.kind === 'slack' ? actor.origin.agentId : undefined);
    if (!agentId || !isAgentId(agentId)) {
      throw new ManagementError('invalid_request', 'Choose a valid Agent for the skill change.');
    }
    this.assertActingAgentScope(actor, {
      scope: 'agent',
      agentId,
      requestedAction: 'update_agent',
      target: { kind: 'agent', id: agentId },
    });
    const agent = await this.requireEditableAgent(actor, agentId);
    if (actor.origin.kind === 'slack' && !await this.requesterAuthorizedSkillChange(actor, {
      kind: input.action,
      name: input.skillName,
    }, agent)) {
      throw new ManagementError(
        'invalid_request',
        `The current requester message must explicitly ${input.action} the ${input.skillName} skill. No change was made.`,
      );
    }

    const operationId = skillActionOperationId(actor, input, agentId);
    const replay = await this.stores.management.getRequest(operationId);
    if (replay?.status === 'completed' || replay?.status === 'failed') {
      return await this.replayManagedAgentSkill(replay);
    }
    if (replay) {
      const operation = replay.operations[0];
      if (operation?.kind !== 'update_agent' || replay.operations.length !== 1) {
        throw new ManagementError(
          'invalid_state',
          `The skill change cannot resume (operation ${operationId}). Inspect the Agent before retrying.`,
        );
      }
      const unchangedReason = operation.itemId === `skill-${input.action}-missing`
        ? 'missing'
        : operation.itemId === `skill-${input.action}-already-set`
        ? 'already_set'
        : undefined;
      if (unchangedReason) {
        if (replay.status !== 'reserved') {
          throw new ManagementError(
            'invalid_state',
            `The unchanged skill receipt is invalid (operation ${operationId}). Inspect the Agent before retrying.`,
          );
        }
        return this.completeReservedUnchangedManagedAgentSkill(
          input,
          agent.name,
          replay,
          unchangedReason,
        );
      }
      return this.applyManagedAgentSkill(input, operationId, operation, {
        action: input.action,
        name: input.skillName,
        agentName: agent.name,
        outcome: 'updated',
      });
    }

    const skillIndex = agent.skills.findIndex(({ name }) => name === input.skillName);
    if (skillIndex < 0) {
      return this.persistUnchangedManagedAgentSkill(
        actor,
        input,
        agent,
        operationId,
        'missing',
      );
    }
    const currentSkill = agent.skills[skillIndex]!;
    if (input.action !== 'remove' && currentSkill.enabled === (input.action === 'enable')) {
      return this.persistUnchangedManagedAgentSkill(
        actor,
        input,
        agent,
        operationId,
        'already_set',
      );
    }

    const skills = input.action === 'remove'
      ? agent.skills.filter((_, index) => index !== skillIndex)
      : agent.skills.map((skill, index) => index === skillIndex
        ? { ...skill, enabled: input.action === 'enable' }
        : skill);
    const metadata = {
      action: input.action,
      name: input.skillName,
      agentName: agent.name,
      outcome: 'updated',
    } as const;
    return this.applyManagedAgentSkill(input, operationId, {
      itemId: `skill-${input.action}`,
      kind: 'update_agent',
      agentId,
      expectedRevision: agent.revision,
      patch: { skills },
    }, metadata);
  }

  private async applyManagedAgentSkill(
    input: ManageAgentSkillInput,
    operationId: string,
    operation: Extract<ManagementOperation, { kind: 'update_agent' }>,
    metadata: SkillActionReceiptMetadata,
  ): Promise<ManageAgentSkillResult> {
    const applied = requireManagementApplyResult(await this.applyWorkspaceChanges({
      context: input.context,
      idempotencyKey: input.idempotencyKey,
      operationId,
      operations: [operation],
      approvalBasis: 'explicit_requester_command',
      trustedReversibleOperationIds: [operation.itemId],
      acknowledgementOwner: 'caller',
      receiptMetadata: { skillAction: metadata },
    }));
    const outcome = applied.outcomes.find(({ itemId }) => itemId === operation.itemId);
    if (applied.status !== 'completed' || outcome?.disposition !== 'applied') {
      throw new ManagementError(
        'invalid_state',
        `The skill ${input.action} did not complete (operation ${applied.operationId}). Inspect the Agent, then retry with a new idempotency key.`,
      );
    }
    return managedSkillActionResult(
      applied.operationId,
      metadata,
      outcome.undoAvailable === true,
    );
  }

  private async replayManagedAgentSkill(
    request: ManagementRequestRecord,
  ): Promise<ManageAgentSkillResult> {
    const result = request.result;
    const metadata = result?.receiptMetadata?.skillAction;
    const operation = request.operations[0];
    const outcome = result?.outcomes.find(({ itemId }) => itemId === operation?.itemId);
    if (request.status !== 'completed' || result?.status !== 'completed' ||
        operation?.kind !== 'update_agent' || !metadata) {
      throw new ManagementError(
        'invalid_state',
        `The skill change did not complete (operation ${request.operationId}). Inspect the Agent, then retry with a new idempotency key.`,
      );
    }
    if (metadata.outcome !== 'updated') {
      if (outcome?.disposition !== 'skipped') {
        throw new ManagementError(
          'invalid_state',
          `The skill change receipt is invalid (operation ${request.operationId}). Inspect the Agent before retrying.`,
        );
      }
      return unchangedSkillActionResult(
        metadata.action,
        metadata.name,
        metadata.agentName,
        metadata.outcome,
      );
    }
    if (outcome?.disposition !== 'applied') {
      throw new ManagementError(
        'invalid_state',
        `The skill ${metadata.action} did not complete (operation ${request.operationId}). Inspect the Agent, then retry with a new idempotency key.`,
      );
    }
    const undo = await this.stores.management.getUndo(request.operationId);
    return managedSkillActionResult(
      result.operationId,
      metadata,
      outcome.undoAvailable === true && undo?.status === 'available',
    );
  }

  private async persistUnchangedManagedAgentSkill(
    actor: LiveManagementActor,
    input: ManageAgentSkillInput,
    agent: CustomAgentConfig,
    operationId: string,
    reason: 'missing' | 'already_set',
  ): Promise<ManageAgentSkillResult> {
    const itemId = `skill-${input.action}-${reason.replace('_', '-')}`;
    const operation: ManagementOperation = {
      itemId,
      kind: 'update_agent',
      agentId: agent.id,
      expectedRevision: agent.revision,
      patch: { skills: agent.skills },
    };
    const at = this.now();
    const reservation = await this.stores.management.reserveRequest({
      operationId,
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      originKey: managementActorOriginKey(actor),
      idempotencyKey: managementStorageIdempotencyKey(actor, input.idempotencyKey),
      digest: managementOperationDigest([operation]),
      operations: [operation],
      at,
    });
    if (reservation.request.status === 'completed') {
      return await this.replayManagedAgentSkill(reservation.request);
    }
    if (reservation.request.status !== 'reserved') {
      throw new ManagementError(
        'operation_in_progress',
        `The prior skill change has not completed (operation ${operationId}).`,
      );
    }
    return this.completeReservedUnchangedManagedAgentSkill(
      input,
      agent.name,
      reservation.request,
      reason,
    );
  }

  private async completeReservedUnchangedManagedAgentSkill(
    input: ManageAgentSkillInput,
    agentName: string,
    request: ManagementRequestRecord,
    reason: 'missing' | 'already_set',
  ): Promise<ManageAgentSkillResult> {
    const operation = request.operations[0];
    if (request.status !== 'reserved' || operation?.kind !== 'update_agent' ||
        request.operations.length !== 1) {
      throw new ManagementError(
        'invalid_state',
        `The unchanged skill receipt is invalid (operation ${request.operationId}). Inspect the Agent before retrying.`,
      );
    }
    const result: ManagementApplyResult = {
      operationId: request.operationId,
      idempotencyKey: input.idempotencyKey,
      status: 'completed',
      outcomes: [{
        itemId: operation.itemId,
        operationKind: 'update_agent',
        disposition: 'skipped',
        code: reason === 'missing' ? 'skill_missing' : 'skill_already_set',
      }],
      effectiveRevision: await this.effectiveRevision(),
      activation: 'next_turn',
      receiptMetadata: {
        skillAction: {
          action: input.action,
          name: input.skillName,
          agentName,
          outcome: reason,
        },
      },
    };
    return await this.replayManagedAgentSkill(
      await this.stores.management.completeRequest(request.operationId, result, this.now()),
    );
  }

  private async replaySkillImport(
    actor: LiveManagementActor,
    request: ManagementRequestRecord,
  ): Promise<ImportSkillResult> {
    const result = request.result;
    const operation = request.operations[0];
    const outcome = result?.outcomes.find(({ itemId }) => itemId === 'skill-import');
    if (request.status !== 'completed' || result?.status !== 'completed' ||
        outcome?.disposition !== 'applied' || operation?.kind !== 'update_agent' ||
        !operation.patch.skills) {
      throw new ManagementError(
        'invalid_state',
        `The bounded skill import did not complete (operation ${request.operationId}). Inspect the Agent, then retry with a new idempotency key.`,
      );
    }
    const undo = await this.stores.management.getUndo(request.operationId);
    const beforeSkills = undo?.inverse.kind === 'update_agent' && undo.inverse.patch.skills
      ? undo.inverse.patch.skills
      : undefined;
    const changedSkill = beforeSkills
      ? singleChangedSkill(beforeSkills, operation.patch.skills)
      : undefined;
    if (!beforeSkills || !changedSkill) {
      throw new ManagementError(
        'invalid_state',
        `The skill import receipt is unavailable (operation ${request.operationId}). Inspect the Agent before retrying.`,
      );
    }
    const agent = await this.requireEditableAgent(actor, operation.agentId);
    const replacedExisting = beforeSkills.some(({ name }) => name === changedSkill.name);
    const metadata = result.receiptMetadata?.skillImport;
    if (!metadata || metadata.name !== changedSkill.name ||
        metadata.replacedExisting !== replacedExisting) {
      throw new ManagementError(
        'invalid_state',
        `The skill import receipt is unavailable (operation ${request.operationId}). Inspect the Agent before retrying.`,
      );
    }
    const undoAvailable = outcome.undoAvailable === true && undo?.status === 'available';
    const verb = replacedExisting ? 'Replaced' : 'Installed';
    return {
      status: 'installed',
      operationId: result.operationId,
      activation: result.activation,
      undoAvailable,
      presentation: {
        slack: `${verb} skill \`${escapeSlackControlCharacters(changedSkill.name)}\` on ${
          escapeSlackControlCharacters(agent.name)
        }. It’s active from the next message.${undoAvailable ? ' You can undo this change.' : ''}`,
      },
      import: metadata,
    };
  }

  private async resolveSkillImportCandidate(
    input: ProposeSkillImportInput,
    continuationTool: 'propose_skill_import' | 'import_skill',
  ): Promise<
    | Extract<ProposeSkillImportResult, { status: 'selection_required' }>
    | {
        agent: CustomAgentConfig;
        agentId: string;
        skill: SkillResolution['skills'][number];
        importedSkill: SkillConfig;
        skills: SkillConfig[];
        existingIndex: number;
      }
  > {
    const actor = await this.requireLiveActor(input.context);
    if (input.guideVersion !== AGENT_AUTHORING_GUIDE_VERSION) {
      throw new ManagementError(
        'invalid_request',
        `Read ${AGENT_AUTHORING_GUIDE_URI} and use guide version ${AGENT_AUTHORING_GUIDE_VERSION}.`,
      );
    }
    const agentId = input.agentId ??
      (actor.origin.kind === 'slack' ? actor.origin.agentId : undefined);
    if (!agentId || !isAgentId(agentId)) {
      throw new ManagementError('invalid_request', 'Choose a valid Agent for the skill import.');
    }
    this.assertActingAgentScope(actor, {
      scope: 'agent',
      agentId,
      requestedAction: 'update_agent',
      target: { kind: 'agent', id: agentId },
    });
    const agent = await this.requireEditableAgent(actor, agentId);

    const parsed = parseSkillSource(input.source);
    if (!parsed) {
      throw new ManagementError(
        'invalid_request',
        'Use a public GitHub repository, GitHub tree URL, skills.sh link, or owner/repo reference.',
      );
    }
    if (!isValidRepositoryFullName(`${parsed.owner}/${parsed.repo}`)) {
      throw new ManagementError('invalid_request', 'Use a valid GitHub owner/repository source.');
    }
    let resolution: SkillResolution;
    try {
      resolution = this.stores.resolveSkillImport
        ? await this.stores.resolveSkillImport(parsed)
        : await resolveSkillSource(parsed, fetch);
    } catch (error) {
      if (!(error instanceof SkillImportError)) throw error;
      const message = error.code === 'access_candidate' || error.code === 'repository_inaccessible'
        ? 'Slack skill import currently supports public GitHub repositories. Use Admin for a private repository connected through the GitHub App.'
        : error.message;
      throw new ManagementError('invalid_request', message);
    }

    const matchingSkills = input.skillName
      ? resolution.skills.filter(({ name }) => name === input.skillName)
      : resolution.skills;
    if (matchingSkills.length === 0) {
      const cappedDetail = resolution.capped
        ? ' The repository scan was capped; use a direct GitHub skill-directory URL.'
        : '';
      throw new ManagementError(
        'invalid_request',
        `No importable SKILL.md matched that source or skill name.${cappedDetail}`,
      );
    }
    const immutableResolution = /^[0-9a-f]{40,64}$/i.test(resolution.ref);
    if (matchingSkills.length > 1) {
      return {
        status: 'selection_required',
        source: {
          owner: resolution.owner,
          repo: resolution.repo,
          ref: resolution.ref,
        },
        candidates: matchingSkills.map(({
          name, description, path, sourceUrl, hasScripts,
        }) => ({ name, description, path, sourceUrl, hasScripts })),
        instruction: `Ask the requester to choose one candidate, then call ${continuationTool} again with that candidate’s sourceUrl as source. Do not create a proposal yet.`,
      };
    }

    const skill = matchingSkills[0]!;
    if (skill.hasScripts) {
      throw new ManagementError(
        'invalid_request',
        `Skill ${skill.name} includes executable scripts, which Chickpea Agent skills do not package. No change was made.`,
      );
    }
    if (!immutableResolution) {
      return {
        status: 'selection_required',
        source: {
          owner: resolution.owner,
          repo: resolution.repo,
          ref: resolution.ref,
        },
        candidates: [{
          name: skill.name,
          description: skill.description,
          path: skill.path,
          sourceUrl: skill.sourceUrl,
          hasScripts: skill.hasScripts,
        }],
        instruction: `Ask the requester to post this candidate’s sourceUrl in a new message, then call ${continuationTool} again with that exact source. The service will pin the inspected commit before any write.`,
      };
    }
    const importedSkill: SkillConfig = {
      name: skill.name,
      description: skill.description,
      instructions: skill.instructions,
      enabled: true,
    };
    const existingIndex = agent.skills.findIndex(({ name }) => name === skill.name);
    const skills = existingIndex >= 0
      ? agent.skills.map((existing, index) => index === existingIndex ? importedSkill : existing)
      : [...agent.skills, importedSkill];
    return {
      agent,
      agentId,
      skill,
      importedSkill,
      skills,
      existingIndex,
    };
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
    const connector = resolveConnectorCatalogPreset(input.connector);
    if (!connector) {
      throw new ManagementError(
        'invalid_request',
        `Unknown connector. Choose one of: ${CONNECTION_CATALOG_PRESETS.map(({ name }) => name).join(', ')}.`,
      );
    }
    const baseUrl = await this.resolveSetupBaseUrl();
    if (actor.origin.kind === 'slack' && 'managedToolkit' in connector) {
      const scopes = MANAGED_CONNECTOR_CATALOG.capabilities(
        connector.managedToolkit,
        // Freeze the complete connector ceiling. The browser uses the full set
        // when configured, otherwise only the available read tools.
        'write',
      ).map(({ id }) => id);
      if (scopes.length === 0) {
        throw new ManagementError(
          'invalid_request',
          `${connector.name} is not available for managed connection setup.`,
        );
      }
      if (this.stores.managedConnectorAvailable &&
          !(await this.stores.managedConnectorAvailable({
            toolkit: connector.managedToolkit,
            accessLane: 'read',
          }))) {
        throw new ManagementError(
          'setup_unavailable',
          `${connector.name} sign-in is not configured for this Chickpea deployment yet.`,
        );
      }
      const issued = await this.issueSetupRecord(actor, {
        action: 'managed_connection',
        target: {
          kind: 'managed_connection',
          provider: connector.managedToolkit,
          targetId: `agent:${agent.id}:managed:${connector.managedToolkit}:${input.ownerKind}`,
          targetLabel: connector.name,
          expectedRevision: agent.revision,
          agentId: agent.id,
          agentName: agent.name,
          replacement: false,
          ownerKind: input.ownerKind,
          accessLane: 'read',
          presetId: connector.id,
        },
        scopes,
      });
      return {
        agent: { id: agent.id, name: agent.name },
        connector: { id: connector.id, name: connector.name },
        ownerKind: input.ownerKind,
        handoffUrl: issued.url,
        setupOperationId: issued.record.setupOperationId,
      };
    }
    if (actor.origin.kind === 'slack' && !('managedToolkit' in connector) &&
        (await this.agentCreationConnectorEligible(connector, baseUrl))) {
      const issued = await this.issueSetupRecord(actor, {
        action: 'catalog_connection',
        target: this.catalogConnectionSetupTarget(agent, connector, input.ownerKind),
        scopes: catalogConnectionScopes(connector),
      });
      return {
        agent: { id: agent.id, name: agent.name },
        connector: { id: connector.id, name: connector.name },
        ownerKind: input.ownerKind,
        handoffUrl: issued.url,
        setupOperationId: issued.record.setupOperationId,
      };
    }
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

  async finalizeSlackAgentCreationWelcome(
    input: FinalizeSlackAgentCreationWelcomeInput,
  ): Promise<FinalizeSlackAgentCreationWelcomeResult> {
    const actor = await this.requireLiveActor(input.context, { cleanupRetention: false });
    if (actor.origin.kind !== 'slack') {
      throw new ManagementError('invalid_request', 'Agent welcomes require a Slack origin.');
    }
    const request = await this.stores.management.getRequest(input.operationId);
    if (!request || request.organizationId !== actor.organizationId ||
        request.actorUserId !== actor.userId ||
        request.actorMembershipId !== actor.membershipId ||
        request.originKey !== managementActorOriginKey(actor) ||
        request.status !== 'completed' || !request.result) {
      throw new ManagementError('operation_not_found', 'The creation operation was not found.');
    }
    const existing = await this.stores.management.getOutboxForOperation(input.operationId);
    if (existing) {
      if (!('kind' in existing.receipt) || existing.receipt.kind !== 'agent_created_welcome') {
        throw new ManagementError('invalid_state', 'The creation operation has another receipt.');
      }
      if (existing.receipt.turnJobId !== input.turnJobId) {
        throw new ManagementError('invalid_state', 'The Agent welcome belongs to another Slack turn.');
      }
      return { outbox: existing, created: false };
    }
    const creation = request.result.outcomes.find((outcome) =>
      outcome.itemId === input.creationItemId &&
      outcome.operationKind === 'create_agent' &&
      outcome.disposition === 'applied' &&
      outcome.changed?.some(({ kind, id }) => kind === 'agent' && id === input.agentId)
    );
    if (!creation) {
      throw new ManagementError('invalid_state', 'The creation operation did not create this Agent.');
    }
    let agent = await this.requireEditableAgent(actor, input.agentId);
    const generatedAvatar = agent.slackPresence?.avatar;
    if (generatedAvatar?.kind === 'generated' && !generatedAvatar.url &&
        this.stores.publishGeneratedAgentAvatar) {
      try {
        const published = await this.stores.publishGeneratedAgentAvatar({
          workspaceId: actor.origin.workspaceId,
          agentId: agent.id,
          revision: generatedAvatar.revision,
          seed: generatedAvatar.seed ?? agent.id,
        });
        if (published) {
          agent = await this.stores.config.updateAgent(agent.id, {
            slackPresence: {
              ...agent.slackPresence!,
              avatar: {
                ...generatedAvatar,
                revision: published.revision,
                url: published.url,
              },
            },
          }, agent.revision);
        }
      } catch {
        console.warn('[chickpea] generated Agent avatar publication deferred');
      }
    }
    const incomplete: Array<'slack_presence' | 'source_channel'> = [];
    if (creation.warning || agent.slackPresence?.health !== 'healthy' ||
        !agent.slackPresence.userGroupId) {
      incomplete.push('slack_presence');
    }
    if (actor.origin.conversationKind === 'channel') {
      const sourceGrant = request.result.outcomes.find((outcome) =>
        outcome.operationKind === 'grant_agent_channel' &&
        outcome.disposition === 'applied'
      );
      if (!sourceGrant) incomplete.push('source_channel');
    }

    const baseUrl = await this.resolveSetupBaseUrl().catch(() => undefined);
    const attachedPresetIds = new Set([
      ...agent.mcpServers.flatMap(({ presetId }) => presetId ? [presetId] : []),
      ...agent.apiConnections.flatMap(({ presetId }) => presetId ? [presetId] : []),
    ]);
    const connectorPlan = await selectAgentCreationConnectors({
      requestText: actor.origin.requestText ?? '',
      explicitMentions: input.connectorMentions,
      agentCorpus: [agent.name, agent.description ?? '', agent.instructions].join(' '),
      attachedPresetIds,
      isEligible: (preset) => this.agentCreationConnectorEligible(preset, baseUrl),
    });
    const setups: Array<{ record: ManagementSetupRecord }> = [];
    const connectorActions: NonNullable<ManagementAgentCreatedWelcome['connectorActions']> = [];
    const connectorNotices = [...connectorPlan.notices];
    for (const candidate of connectorPlan.candidates) {
      const preset = CONNECTION_CATALOG_PRESETS.find(({ id }) => id === candidate.presetId);
      if (!preset || !baseUrl) continue;
      try {
        const prepared = this.freezeAgentCreationConnectorSetup(
          actor,
          agent,
          input.operationId,
          preset,
          baseUrl,
        );
        setups.push({ record: prepared.record });
        connectorActions.push({
          presetId: preset.id,
          label: preset.name,
          setupOperationId: prepared.record.setupOperationId,
          setupUrl: prepared.url,
        });
      } catch {
        connectorNotices.push({
          kind: 'unavailable',
          label: preset.name,
          text: `${preset.name} isn’t available to connect right now.`,
        });
      }
    }
    const handle = agent.slackPresence?.normalizedHandle ?? agent.slackPresence?.requestedHandle;
    const avatarUrl = baseUrl ? agentAvatarUrlForPresentation(agent, baseUrl) : undefined;
    const viewAgentUrl = creation.handoffUrl ?? (baseUrl
      ? new URL(`/admin/agents/${encodeURIComponent(agent.id)}`, baseUrl).href
      : undefined);
    const at = this.now();
    const receipt: ManagementAgentCreatedWelcome = {
      kind: 'agent_created_welcome',
      creationOperationId: input.operationId,
      ...(input.presentationRunId ? { presentationRunId: input.presentationRunId } : {}),
      turnJobId: input.turnJobId,
      agentId: agent.id,
      agentName: agent.name,
      ...(handle ? { agentHandle: handle } : {}),
      ...(agent.description ? { agentDescription: agent.description } : {}),
      requesterMembershipId: actor.membershipId,
      surface: actor.origin.conversationKind === 'channel' ? 'channel' : 'direct',
      persona: {
        name: agent.name,
        ...(avatarUrl ? { avatarUrl } : {}),
      },
      publication: {
        status: incomplete.length === 0 ? 'complete' : 'partial',
        incomplete,
      },
      connectorActions,
      connectorNotices,
      followOnNotices: input.followOnNotices,
      ...(viewAgentUrl ? { viewAgentUrl } : {}),
    };
    const outbox: ManagementReceiptOutboxRecord = {
      outboxId: `agent_welcome_${input.operationId}`,
      operationId: input.operationId,
      destination: {
        kind: 'thread',
        workspaceId: actor.origin.workspaceId,
        channelId: actor.origin.channelId,
        threadTs: actor.origin.threadTs,
      },
      receipt,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
    };
    const claimed = await this.stores.management.claimAgentCreationWelcome({
      operationId: input.operationId,
      setups,
      outbox,
    });
    emitManagementMetric('agent_creation.welcome_claim', {
      surface: 'slack',
      outcome: claimed.created ? 'created' : 'replayed',
      connectorActionCount: connectorActions.length,
      connectorNoticeCount: connectorNotices.length,
      publicationStatus: receipt.publication?.status ?? 'partial',
    });
    return claimed;
  }

  private async agentCreationConnectorEligible(
    preset: ConnectorCatalogPreset,
    baseUrl: string | undefined,
  ): Promise<boolean> {
    if (!baseUrl) return false;
    if (!('managedToolkit' in preset)) {
      if (['sentry', 'supabase'].includes(preset.id)) return false;
      return 'url' in preset || 'api' in preset && !preset.api.oauth;
    }
    if (MANAGED_CONNECTOR_CATALOG.capabilities(preset.managedToolkit, 'write').length === 0) {
      return false;
    }
    if (!this.stores.managedConnectorAvailable) return true;
    try {
      return await this.stores.managedConnectorAvailable({
        toolkit: preset.managedToolkit,
        accessLane: 'read',
      });
    } catch {
      return false;
    }
  }

  private freezeAgentCreationConnectorSetup(
    actor: LiveManagementActor,
    agent: CustomAgentConfig,
    operationId: string,
    preset: ConnectorCatalogPreset,
    baseUrl: string,
  ): { record: ManagementSetupRecord; url: string } {
    const rawCapability = this.randomCapability();
    if (!/^[A-Za-z0-9_-]{43}$/.test(rawCapability)) {
      throw new ManagementError('invalid_request', 'Setup capability generation failed.');
    }
    const at = this.now();
    const setupOperationId = `setup_welcome_${createHash('sha256')
      .update(`${operationId}:${preset.id}`)
      .digest('hex').slice(0, 32)}`;
    if (!('managedToolkit' in preset)) {
      const record: ManagementSetupRecord = {
        setupOperationId,
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        origin: actor.origin,
        action: 'catalog_connection',
        target: {
          ...this.catalogConnectionSetupTarget(agent, preset, 'member'),
          connectionId: `connection_${setupOperationId.slice('setup_welcome_'.length)}`,
        },
        scopes: catalogConnectionScopes(preset),
        tokenDigest: capabilityDigest(rawCapability),
        status: 'pending',
        expiresAt: at + SETUP_TTL_MS,
        createdAt: at,
        updatedAt: at,
      };
      const url = new URL(`/setup/${encodeURIComponent(setupOperationId)}`, baseUrl);
      url.hash = `setup=${rawCapability}`;
      return { record, url: url.href };
    }
    const record: ManagementSetupRecord = {
      setupOperationId,
      organizationId: actor.organizationId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      origin: actor.origin,
      action: 'managed_connection',
      target: {
        kind: 'managed_connection',
        provider: preset.managedToolkit,
        targetId: `agent:${agent.id}:managed:${preset.managedToolkit}:welcome`,
        targetLabel: preset.name,
        expectedRevision: agent.revision,
        agentId: agent.id,
        agentName: agent.name,
        replacement: false,
        ownerKind: 'member',
        accessLane: 'read',
        presetId: preset.id,
      },
      scopes: MANAGED_CONNECTOR_CATALOG.capabilities(preset.managedToolkit, 'write')
        .map(({ id }) => id),
      tokenDigest: capabilityDigest(rawCapability),
      status: 'pending',
      expiresAt: at + SETUP_TTL_MS,
      createdAt: at,
      updatedAt: at,
    };
    const url = new URL(`/setup/${encodeURIComponent(setupOperationId)}`, baseUrl);
    url.hash = `setup=${rawCapability}`;
    return { record, url: url.href };
  }

  private catalogConnectionSetupTarget(
    agent: CustomAgentConfig,
    preset: ConnectorPreset,
    ownerKind: 'member' | 'team',
  ): ManagementSetupTarget {
    return {
      kind: 'catalog_connection',
      provider: preset.id,
      targetId: `agent:${agent.id}:catalog:${preset.id}`,
      targetLabel: preset.name,
      expectedRevision: agent.revision,
      agentId: agent.id,
      agentName: agent.name,
      replacement: false,
      ownerKind,
      presetId: preset.id,
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

  async applyWorkspaceChanges(
    input: ApplyWorkspaceChangesInput,
  ): Promise<ApplyWorkspaceChangesResult> {
    const actor = await this.requireLiveActor(input.context);
    const requestedOperations = validateManagementOperations(input.operations);
    assertBaseAgentCreationContract(requestedOperations);
    assertStandaloneBaseAgentCreation(requestedOperations);
    const duplicateIdentity = await this.duplicateAgentIdentityResult(
      actor,
      requestedOperations,
    );
    if (duplicateIdentity) {
      emitManagementMetric('agent_creation.outcome', {
        surface: actor.origin.kind,
        outcome: 'clarification',
      });
      return duplicateIdentity;
    }
    const operations = validateManagementOperations(
      withTrustedSlackOriginGrant(actor, requestedOperations),
    );
    const storageIdempotencyKey = managementStorageIdempotencyKey(actor, input.idempotencyKey);
    const at = this.now();
    const reservation = await this.stores.management.reserveRequest({
      operationId: input.operationId ?? `management_${this.randomId()}`,
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
      if (input.acknowledgementOwner !== 'caller') {
        await queueAppliedPrivateDmRoutineAcknowledgement(
          this.stores.management,
          actor,
          operations,
          reservation.request.result,
          this.now(),
        );
      }
      emitAgentCreationApplyOutcome(
        actor.origin.kind,
        requestedOperations,
        reservation.request.result,
      );
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
        const facts = await this.policyFacts(actor, operation, {
          ...(operation.kind === 'save_routine' &&
              progress.prepared?.itemId === operation.itemId
            ? { allowIdempotentRoutineSaveReplay: true }
            : {}),
          ...(input.approvalBasis ? { approvalBasis: input.approvalBasis } : {}),
          ...(input.trustedReversibleOperationIds?.includes(operation.itemId)
            ? { trustedReversibleOperation: true }
            : {}),
          trustedSlackOriginGrant: isTrustedSlackOriginGrant(
            actor,
            request.operations,
            storedOperation,
          ),
          operationCount: request.operations.length,
        });
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
            ...(mutation.warning ? { warning: mutation.warning } : {}),
          });
          if (request.operations.length === 1 &&
              operation.kind !== 'create_agent' && mutation.inverse) {
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
          ...(error instanceof ManagementError && error.code === 'model_provider_unavailable'
            ? { warning: error.message }
            : {}),
          ...(error instanceof ManagementError && error.changed
            ? { changed: error.changed }
            : {}),
        });
        request = await this.stores.management.saveRequestProgress(
          request.operationId,
          withoutSetupCapabilitiesFromProgress(progress),
          this.now(),
        );
      }
    }

    const baseResult = await this.resultFor(
      request.operationId,
      input.idempotencyKey,
      progress.outcomes,
    );
    const result = input.receiptMetadata
      ? { ...baseResult, receiptMetadata: input.receiptMetadata }
      : baseResult;
    if (progress.outcomes.some(({ disposition }) => disposition === 'confirmation_required')) {
      return emitOperationOutcomes(actor.origin.kind, result);
    }
    await this.stores.management.completeRequest(
      request.operationId,
      withoutSetupCapabilities(result),
      this.now(),
    );
    if (input.acknowledgementOwner !== 'caller') {
      await queueAppliedPrivateDmRoutineAcknowledgement(
        this.stores.management,
        actor,
        request.operations,
        result,
        this.now(),
      );
    }
    emitAgentCreationApplyOutcome(actor.origin.kind, requestedOperations, result);
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
    const requestedOperations = validateManagementOperations(input.operations);
    assertBaseAgentCreationContract(requestedOperations);
    if (requestedOperations.some(({ kind }) => kind === 'create_agent')) {
      throw new ManagementError(
        'invalid_request',
        'Create a standalone base Agent with apply_workspace_changes. Agent creation does not require confirmation.',
      );
    }
    if (requestedOperations.some(({ kind }) => kind === 'request_setup')) {
      throw new ManagementError(
        'invalid_request',
        'Prepare connector or repository setup separately after the reviewed Agent change.',
      );
    }
    const operations = requestedOperations;

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
      if (operations.length === 1 && operation.kind === 'update_agent') {
        const currentAgent = await this.requireEditableAgent(actor, operation.agentId);
        const directSkillChange = reversibleLocalSkillChange(currentAgent, operation.patch);
        if (directSkillChange && await this.requesterAuthorizedSkillChange(
          actor,
          directSkillChange,
          currentAgent,
        )) {
          const actionNoun = directSkillChange.kind === 'remove'
            ? 'removal'
            : directSkillChange.kind === 'enable'
            ? 'enablement'
            : 'disablement';
          throw new ManagementError(
            'invalid_request',
            `Use manage_agent_skill for this explicit reversible skill ${actionNoun}. No proposal was created.`,
          );
        }
      }
      const policy = classifyManagementOperation(
        await this.policyFacts(actor, operation),
      );
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
      approvalScopeKey: managementApprovalScopeKey(actor),
      idempotencyKey: input.idempotencyKey,
      guideVersion: input.guideVersion,
      authoringReason: input.authoringReason,
      operations,
      digest: managementOperationDigest(operations),
      preview,
      targetRevisions,
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
        ...(mutation.warning ? { warning: mutation.warning } : {}),
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
      if (this.now() - proposal.updatedAt < MANAGEMENT_CHANGE_SET_APPLY_LEASE_MS) {
        throw new ManagementError('operation_in_progress', 'The confirmation is already applying.');
      }
      proposal = await this.stores.management.reclaimChangeSetProposal({
        proposalId: proposal.proposalId,
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        originKey: managementActorOriginKey(actor),
        approvalScopeKey: managementApprovalScopeKey(actor),
        expectedUpdatedAt: proposal.updatedAt,
        at: this.now(),
      });
      recovered = true;
    } else {
      try {
        const proposalAgentIds = new Set(proposal.operations.flatMap((operation) =>
          operation.kind === 'create_agent' ? [operation.agent.id] : []
        ));
        for (const operation of proposal.operations) {
          const handoff = await this.actingAgentOperationHandoff(actor, operation);
          if (handoff) throw new ChickpeaHandoffRequired(handoff);
          const policy = classifyManagementOperation(
            await this.policyFacts(actor, operation, {
              agentCreatedInProposal: operation.kind === 'grant_agent_channel' &&
                proposalAgentIds.has(operation.agentId!),
            }),
          );
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
        approvalScopeKey: managementApprovalScopeKey(actor),
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
              ...(mutation.warning ? { warning: mutation.warning } : {}),
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
                  ...(reconciled.warning ? { warning: reconciled.warning } : {}),
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
    const preparedResult = await this.reconcilePrepared(actor, prepared, proposal.proposalId);
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
    } else if (operation.kind === 'control_routine' || operation.kind === 'run_routine' ||
        operation.kind === 'delete_routine') {
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
    const resumed = requireManagementApplyResult(await this.applyWorkspaceChanges({
      context,
      idempotencyKey: publicManagementIdempotencyKey(actor, request.idempotencyKey),
      operations: request.operations,
    }));
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
    const explicitSlackUndo = actor.origin.kind === 'slack' &&
      requesterExplicitlyRequestsUndo(actor.origin.requestText);
    const originalRequest = actor.origin.kind === 'mcp'
      ? await this.stores.management.getRequest(input.operationId)
      : undefined;
    const trustedConnectorSkillUndo = actor.origin.kind === 'mcp' &&
      originalRequest?.organizationId === actor.organizationId &&
      originalRequest.actorUserId === actor.userId &&
      originalRequest.actorMembershipId === actor.membershipId &&
      originalRequest.result?.receiptMetadata?.skillAction?.outcome === 'updated';
    const result = requireManagementApplyResult(await this.applyWorkspaceChanges({
      context: input.context,
      idempotencyKey: input.idempotencyKey,
      operations: [undo.inverse],
      ...(explicitSlackUndo || trustedConnectorSkillUndo
        ? {
            approvalBasis: 'explicit_requester_command' as const,
            trustedReversibleOperationIds: [undo.inverse.itemId],
          }
        : {}),
    }));
    if (result.status === 'completed') {
      await this.stores.management.consumeUndo(input.operationId, this.now());
    }
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
          changeSet.approvalScopeKey !== managementApprovalScopeKey(actor)) {
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
    const setupOperationId = `setup_${this.randomId()}`;
    const target = input.action === 'catalog_connection'
      ? {
          ...input.target,
          connectionId: `connection_${createHash('sha256')
            .update(setupOperationId)
            .digest('hex').slice(0, 32)}`,
        }
      : input.target;
    const record = await this.stores.management.putSetup({
      record: {
        setupOperationId,
        organizationId: actor.organizationId,
        actorUserId: actor.userId,
        actorMembershipId: actor.membershipId,
        origin: actor.origin,
        action: input.action,
        target,
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
        operation.kind === 'run_routine' ||
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
    if (operation.kind === 'control_routine' || operation.kind === 'run_routine' ||
        operation.kind === 'delete_routine') {
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
    return canEditAgent(managementActorPrincipal(actor), agent);
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

  private async duplicateAgentIdentityResult(
    actor: LiveManagementActor,
    operations: readonly ManagementOperation[],
  ): Promise<ManagementDuplicateIdentityResult | undefined> {
    const operation = operations[0];
    if (operations.length !== 1 || operation?.kind !== 'create_agent') return undefined;
    const candidates = (await this.editableAgents(actor))
      .filter(({ id }) => id !== operation.agent.id)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        normalizedName: normalizeAgentIdentityName(agent.name),
        handle: agent.slackPresence?.normalizedHandle ?? normalizeAgentHandle(agent.name),
      }));
    const requestedName = operation.agent.name.trim();
    const normalizedName = normalizeAgentIdentityName(requestedName);
    const requestedHandle = normalizeAgentHandle(
      operation.agent.requestedHandle ?? requestedName,
    );
    const handleMatches = candidates.filter(({ handle }) => handle === requestedHandle);
    if (operation.duplicateResolution === 'create_distinct') {
      if (handleMatches.length > 0) {
        throw new ManagementError(
          'invalid_request',
          'Choose a unique Slack handle for the distinct Agent.',
        );
      }
      return undefined;
    }
    const matches = candidates.filter(({ normalizedName: candidateName, handle }) =>
      candidateName === normalizedName || handle === requestedHandle);
    if (matches.length === 0) return undefined;
    const projected = [...matches]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ id, name, handle }) => ({ id, name, handle }));
    return {
      status: 'clarification_required',
      clarification: {
        kind: 'duplicate_agent_identity',
        requested: { name: requestedName, handle: requestedHandle },
        matches: projected,
        options: ['use_existing', 'create_distinct'],
      },
      presentation: {
        slack: projected.length === 1
          ? `An editable Agent already matches this identity: ${
            escapeSlackControlCharacters(projected[0]!.name)
          } (@${projected[0]!.handle}). Ask whether to use it or create a distinct Agent.`
          : `${projected.length} editable Agents already match this identity. Ask which existing Agent to use or whether to create a distinct Agent.`,
      },
    };
  }

  private async requesterAuthorizedSkillChange(
    actor: LiveManagementActor,
    change: ReversibleSkillChange,
    targetAgent: CustomAgentConfig,
  ): Promise<boolean> {
    const editableAgentNames = actor.origin.kind === 'slack' &&
        actor.origin.agentId === CHICKPEA_AGENT_ID
      ? (await this.editableAgents(actor)).map(({ name }) => name)
      : [targetAgent.name];
    if (actor.origin.kind === 'slack' && actor.origin.agentId === CHICKPEA_AGENT_ID &&
        editableAgentNames.filter((name) =>
          name.trim().toLowerCase() === targetAgent.name.trim().toLowerCase()).length !== 1) {
      return false;
    }
    return explicitRequesterSkillChange(actor, change, {
      targetAgentName: targetAgent.name,
      installedSkillNames: targetAgent.skills.map(({ name }) => name),
      editableAgentNames,
    });
  }

  private assertProposalBinding(
    actor: LiveManagementActor,
    proposal:
      | Pick<
          ManagementProposalRecord,
          'organizationId' | 'actorUserId' | 'actorMembershipId' | 'originKey'
        >
      | Pick<
          ManagementChangeSetProposalRecord,
          'organizationId' | 'actorUserId' | 'actorMembershipId' | 'originKey' | 'approvalScopeKey'
        >,
  ): void {
    if (proposal.organizationId !== actor.organizationId ||
        proposal.actorUserId !== actor.userId ||
        proposal.actorMembershipId !== actor.membershipId ||
        ('approvalScopeKey' in proposal
          ? proposal.approvalScopeKey !== managementApprovalScopeKey(actor)
          : proposal.originKey !== managementActorOriginKey(actor))) {
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
      connectors: CONNECTION_CATALOG_PRESETS.map(({ id, name, description }) => ({
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
      kind: 'save_routine' | 'control_routine' | 'run_routine' | 'delete_routine' |
        'reassign_routine_agent';
    }>,
    options: { allowIdempotentSaveReplay?: boolean } = {},
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
    if (operation.kind === 'save_routine' || operation.kind === 'run_routine') {
      const available = await this.isRoutineSchedulingAvailable();
      if (!available) {
        throw new ManagementError(
          'routines_unavailable_on_target',
          'Routine scheduling is unavailable on this deployment.',
        );
      }
    }
    if (operation.kind === 'save_routine') {
      const agent = await optionalAgent(this.stores.config, operation.agentId);
      if (directRoutine) {
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
    const routine = existingRoutine;
    const versionChanged = 'expectedVersion' in operation &&
      routine?.version !== operation.expectedVersion;
    if (!routine || routine.deletedAt !== null || routine.workspaceId !== operation.workspaceId ||
        routine.channelId !== channelId ||
        (versionChanged && !options.allowIdempotentSaveReplay)) {
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

  private routineMutationChannelId(
    actor: LiveManagementActor,
    operation: Extract<ManagementOperation, {
      kind: 'save_routine' | 'control_routine' | 'run_routine' | 'delete_routine' |
        'reassign_routine_agent';
    }>,
  ): string {
    const directOrigin = slackDirectOrigin(actor);
    if (operation.kind === 'save_routine' && operation.destination?.kind === 'current_channel_thread') {
      const origin = actor.origin;
      if (origin.kind !== 'slack' || origin.conversationKind !== 'channel' ||
          operation.workspaceId !== origin.workspaceId || operation.channelId !== origin.channelId ||
          !requestsChannelThreadDelivery(origin.requestText ?? '')) {
        throw new ManagementError('invalid_request', 'Thread delivery must be explicitly requested in the current Channel.');
      }
      return origin.channelId;
    }
    if (operation.kind === 'save_routine' && operation.destination?.kind === 'current_dm_thread') {
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
    options: {
      allowIdempotentRoutineSaveReplay?: boolean;
      approvalBasis?: 'explicit_requester_command';
      trustedReversibleOperation?: boolean;
      trustedSlackOriginGrant?: boolean;
      agentCreatedInProposal?: boolean;
      operationCount?: number;
    } = {},
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
        operation.kind === 'run_routine' ||
        operation.kind === 'delete_routine' || operation.kind === 'reassign_routine_agent') {
      await this.requireRoutineMutation(actor, operation, {
        ...(operation.kind === 'save_routine' &&
            options.allowIdempotentRoutineSaveReplay
          ? { allowIdempotentSaveReplay: true }
          : {}),
      });
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
      const agentReferences = 'enabled' in operation.patch
        ? await this.stores.config.getAgentReferences(operation.agentId)
        : undefined;
      const reversibleSkillChange = reversibleLocalSkillChange(currentAgent, operation.patch);
      const requesterAuthorized = options.operationCount === 1 && reversibleSkillChange &&
        await this.requesterAuthorizedSkillChange(actor, reversibleSkillChange, currentAgent);
      return {
        actor,
        operation,
        currentAgent,
        ...(agentReferences ? { agentReferences } : {}),
        capabilityScopeExpanded: capabilityScopeExpanded(currentAgent, operation.patch),
        agentEditable: true,
        ...(options.approvalBasis || requesterAuthorized
          ? { approvalBasis: 'explicit_requester_command' as const }
          : {}),
        ...(options.trustedReversibleOperation || reversibleSkillChange
          ? { reversibleLocalChange: true }
          : {}),
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
      if (!options.agentCreatedInProposal) {
        await this.requireEditableAgent(actor, operation.agentId!);
      }
      return {
        actor,
        operation,
        agentEditable: true,
        ...(operation.kind === 'grant_agent_channel' && options.trustedSlackOriginGrant
          ? { trustedSlackOriginGrant: true }
          : {}),
      };
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
      kind: 'save_routine' | 'control_routine' | 'run_routine';
    }>,
  ): Promise<ImmediateMutation> {
    // A durable action retry can arrive after the save committed but before
    // authority compensation settled. The store's save idempotency record is
    // the proof that permits replay past the caller's now-stale version; an
    // unrelated stale edit still fails inside RoutineStore.save.
    await this.requireRoutineMutation(actor, operation, {
      allowIdempotentSaveReplay: operation.kind === 'save_routine',
    });
    try {
      const command = this.scheduleCommand(actor, mutationId, operation);
      const result = await executeSlackScheduleCommand(command, {
        routines: this.stores.routines!,
        config: this.stores.config as ConfigStore,
        identity: this.stores.identity as IdentityStore,
        schedulingAvailable: () => this.isRoutineSchedulingAvailable(),
        now: this.now,
      });
      if (operation.kind === 'save_routine' && result.effect === 'saved' && result.created) {
        this.stores.productTelemetry?.capture({
          event: 'schedule_created',
          workspaceId: result.routine.workspaceId,
          agentId: operation.agentId,
          cadenceKind: result.routine.triggerKind === 'schedule' ? 'recurring' : 'one_time',
          destinationKind: result.routine.destination.kind,
        });
      }
      return routineMutation(result.routine);
    } catch (error) {
      if (error instanceof ManagementError) throw error;
      if (error instanceof SlackScheduleCommandError) {
        if (error.code === 'schedule_command_failed' || error.code === 'schedule_safety_pending') {
          throw error;
        }
        throw new ManagementError(
          error.code,
          error.message,
          error.safeRoutine
            ? [{
                kind: 'routine',
                id: error.safeRoutine.id,
                revision: error.safeRoutine.version,
              }]
            : undefined,
        );
      }
      if (error instanceof RoutineStateError) {
        throw new ManagementError(
          error.code === 'routine_version_conflict' ? 'revision_conflict' : 'invalid_request',
          error.message,
        );
      }
      console.warn('[chickpea:management] routine mutation failed', JSON.stringify({
        errorName: error instanceof Error ? error.name : 'unknown',
      }));
      throw new ManagementError('invalid_request', 'The routine mutation could not be applied.');
    }
  }

  private scheduleCommand(
    actor: LiveManagementActor,
    mutationId: string,
    operation: Extract<ManagementOperation, {
      kind: 'save_routine' | 'control_routine' | 'run_routine';
    }>,
  ): SlackScheduleCommand {
    if (operation.kind === 'control_routine') {
      return {
        kind: 'control',
        actionKey: mutationId,
        itemId: operation.itemId,
        actorUserId: actor.userId,
        routineId: operation.routineId,
        expectedVersion: operation.expectedVersion,
        action: operation.action,
      };
    }
    if (operation.kind === 'run_routine') {
      return {
        kind: 'run',
        actionKey: mutationId,
        itemId: operation.itemId,
        actorUserId: actor.userId,
        routineId: operation.routineId,
      };
    }
    const channelId = this.routineMutationChannelId(actor, operation);
    const directOrigin = slackDirectOrigin(actor);
    return {
      kind: 'save',
      actionKey: mutationId,
      itemId: operation.itemId,
      actorUserId: actor.userId,
      actorMembershipId: actor.membershipId,
      workspaceId: operation.workspaceId,
      channelId,
      agentId: operation.agentId,
      ...(operation.destination?.kind === 'current_channel_thread' && actor.origin.kind === 'slack'
        ? { channelThreadTs: actor.origin.threadTs }
        : {}),
      ...(operation.destination?.kind === 'current_dm_thread' && directOrigin
        ? {
            directDestination: {
              conversationId: channelId,
              threadTs: directOrigin.threadTs,
              ownerMembershipId: actor.membershipId,
            },
          }
        : {}),
      ...(operation.routineId ? { routineId: operation.routineId } : {}),
      ...(operation.expectedVersion !== undefined
        ? { expectedVersion: operation.expectedVersion }
        : {}),
      name: operation.name,
      description: operation.description,
      taskText: operation.taskText,
      schedule: operation.schedule,
      timezone: operation.timezone,
      outputPolicy: operation.outputPolicy,
    };
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
    const reconciled = await this.reconcilePrepared(actor, prepared, requestId);
    return reconciled ?? await this.executeImmediate(actor, requestId, operation, prepared);
  }

  private async assertCreationModelProvider(model: string | undefined): Promise<void> {
    // Production adapters supply the same credential-source reader used by
    // provider settings. Alternate runtimes may own their provider bindings.
    const source = this.stores.providerCredentialSource;
    if (!source || !model) return;
    const provider = model.split('/')[0];
    if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'openrouter') return;
    if (await source(provider) !== 'missing') return;
    throw new ManagementError(
      'model_provider_unavailable',
      `Cannot create an Agent pinned to ${model}: provider ${provider} is not configured. ` +
        'If the requester did not select a model, omit the model field to inherit the workspace default. ' +
        'If they explicitly selected this model, explain the required provider setup; do not substitute another model.',
    );
  }

  private async prepareItem(
    actor: LiveManagementActor,
    operation: ManagementOperation,
    creationNonce?: string,
  ): Promise<ManagementPreparedItem> {
    switch (operation.kind) {
      case 'create_agent': {
        await this.assertCreationModelProvider(operation.agent.model);
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
            patch: Object.keys(operation.patch).length === 1 && operation.patch.skills
              ? { skills: before.skills }
              : fullAgentPatch(before),
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
      case 'save_routine': {
        const before = operation.routineId
          ? await this.stores.routines?.getRoutine(operation.routineId)
          : undefined;
        const agent = await optionalAgent(this.stores.config, operation.agentId);
        return {
          itemId: operation.itemId,
          operation,
          ...(before ? { before: routinePreview(before, agent?.name) } : {}),
          intendedAfter: routineOperationPreview(operation, agent?.name, before),
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
        const created = await this.stores.config.createAgent(createInput);
        await this.captureAgentCreated(actor, created.id);
        const published = await this.publishCreatedAgent(actor, created, {
          inferredHandle: operation.agent.requestedHandle === undefined,
          requestId: mutationId,
          prepared,
        });
        return mutationForAgent(
          published.agent,
          prepared.inverse,
          await this.agentEditorUrl(published.agent.id),
          published.warning,
        );
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
      case 'run_routine':
        return this.executeRoutineMutation(actor, mutationId, operation);
      default:
        throw new ManagementError('invalid_request', 'This operation cannot apply immediately.');
    }
  }

  private async reconcilePrepared(
    actor: LiveManagementActor,
    prepared: ManagementPreparedItem,
    requestId?: string,
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
      const intended = prepared.intendedAfter as CustomAgentConfig;
      if (current && agentCreationMatches(current, intended)) {
        const published = await this.publishCreatedAgent(actor, current, {
          inferredHandle: operation.agent.requestedHandle === undefined,
          ...(requestId ? { requestId } : {}),
          prepared,
        });
        return mutationForAgent(
          published.agent,
          prepared.inverse,
          await this.agentEditorUrl(published.agent.id),
          published.warning,
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

  private async publishCreatedAgent(
    actor: LiveManagementActor,
    agent: CustomAgentConfig,
    options: {
      inferredHandle: boolean;
      requestId?: string;
      prepared: ManagementPreparedItem;
    },
  ): Promise<{ agent: CustomAgentConfig; warning?: string }> {
    if (!this.stores.publishAgentPresence ||
        (agent.slackPresence?.desiredState === 'active' &&
          agent.slackPresence.health === 'healthy' && agent.slackPresence.userGroupId)) {
      return { agent };
    }
    try {
      return await this.stores.publishAgentPresence({
        actor,
        agentId: agent.id,
        inferredHandle: options.inferredHandle,
      });
    } catch (error) {
      let publicationError = error;
      if (options.inferredHandle && error instanceof AgentPresenceError &&
          error.code === 'handle_collision' && error.suggestions[0]) {
        const recovered = await this.selectInferredAgentHandle(
          options.requestId,
          options.prepared,
          agent.id,
          error.suggestions[0],
        );
        try {
          return await this.stores.publishAgentPresence({
            actor,
            agentId: recovered.id,
            inferredHandle: false,
          });
        } catch (retryError) {
          publicationError = retryError;
        }
      }
      const current = await this.stores.config.getAgent(agent.id);
      const detail = publicationError instanceof AgentPresenceError
        ? publicationError.message
        : 'Slack handle publication did not complete. Retry it from the Agent settings.';
      return {
        agent: current,
        warning: `The Agent was created, but its Slack handle needs attention: ${detail}`,
      };
    }
  }

  private async selectInferredAgentHandle(
    requestId: string | undefined,
    prepared: ManagementPreparedItem,
    agentId: string,
    suggestion: string,
  ): Promise<CustomAgentConfig> {
    const current = await this.stores.config.getAgent(agentId);
    const presence = current.slackPresence;
    if (!presence) {
      throw new ManagementError('invalid_state', 'The Agent Slack identity is unavailable.');
    }
    const selected = normalizeAgentHandle(suggestion);
    const updated = await this.stores.config.updateAgent(agentId, {
      slackPresence: {
        ...presence,
        requestedHandle: selected,
        normalizedHandle: selected,
        health: 'pending',
      },
    }, current.revision);
    const intended = prepared.intendedAfter as CustomAgentConfig;
    prepared.intendedAfter = {
      ...intended,
      slackPresence: {
        ...intended.slackPresence!,
        requestedHandle: selected,
        normalizedHandle: selected,
      },
    };
    if (requestId) {
      const request = await this.stores.management.getRequest(requestId);
      if (request?.status === 'applying') {
        await this.stores.management.saveRequestProgress(requestId, {
          ...request.progress,
          prepared,
        }, this.now());
      }
    }
    return updated;
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
      if (this.stores.deleteAgent) {
        await this.stores.deleteAgent({
          actor,
          agentId: operation.agentId,
          expectedRevision: operation.expectedRevision,
        });
      } else {
        await this.stores.config.deleteAgent(operation.agentId, operation.expectedRevision);
      }
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
        operation.kind === 'run_routine' ||
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

export function managementActorPrincipal(actor: LiveManagementActor): AuthPrincipal {
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

function publicManagementIdempotencyKey(actor: LiveManagementActor, storageKey: string): string {
  if (!actor.actingAgentId) return storageKey;
  const prefix = `agent.${actor.actingAgentId}.`;
  if (!storageKey.startsWith(prefix)) {
    throw new ManagementError('idempotency_conflict', 'The management request Agent changed.');
  }
  return storageKey.slice(prefix.length);
}

function requireManagementApplyResult(
  result: ApplyWorkspaceChangesResult,
): ManagementApplyResult {
  if (result.status === 'clarification_required') {
    throw new ManagementError(
      'invalid_state',
      'A non-creation management operation returned Agent identity clarification.',
    );
  }
  return result;
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

function emitAgentCreationApplyOutcome(
  surface: LiveManagementActor['origin']['kind'],
  requestedOperations: readonly ManagementOperation[],
  result: ManagementApplyResult,
): void {
  const requestedCreation = requestedOperations.length === 1 &&
      requestedOperations[0]?.kind === 'create_agent'
    ? requestedOperations[0]
    : undefined;
  const creation = requestedCreation
    ? result.outcomes.find(({ itemId }) => itemId === requestedCreation.itemId)
    : undefined;
  if (!creation) return;
  emitManagementMetric('agent_creation.outcome', {
    surface,
    outcome: creation.disposition === 'applied' ? 'applied' : 'failed',
  });
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
  warning?: string,
): ImmediateMutation {
  const changed = [{ kind: 'agent' as const, id: agent.id, revision: agent.revision }];
  return {
    changed,
    ...(inverse ? { inverse } : {}),
    ...(handoffUrl ? { handoffUrl } : {}),
    ...(warning ? { warning } : {}),
    resultingRevisions: { [`agent:${agent.id}`]: agent.revision },
  };
}

function agentCreationMatches(
  agent: CustomAgentConfig,
  intended: CustomAgentConfig,
): boolean {
  return canonicalJson(agentCreationFingerprint(agent)) ===
    canonicalJson(agentCreationFingerprint(intended));
}

function agentCreationFingerprint(agent: CustomAgentConfig): unknown {
  const {
    revision: _revision,
    configurationGeneration: _configurationGeneration,
    slackPresence,
    ...configuration
  } = agent;
  return {
    ...configuration,
    ...(slackPresence
      ? {
          slackPresence: {
            requestedHandle: slackPresence.requestedHandle,
            normalizedHandle: slackPresence.normalizedHandle,
            avatar: {
              kind: slackPresence.avatar.kind,
              ...(slackPresence.avatar.seed ? { seed: slackPresence.avatar.seed } : {}),
            },
          },
        }
      : {}),
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
  agentConnections: NonNullable<ManagementWorkspaceSnapshot['agents'][number]['connections']>,
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
    // Serialized for compatibility; these counts now describe only the
    // connections permanently owned by this Agent.
    reusableConnections: {
      ready: agentConnections.filter(({ enabled, lifecycle }) =>
        enabled && lifecycle === 'ready').length,
      pending: agentConnections.filter(({ enabled, lifecycle }) =>
        enabled && lifecycle === 'pending').length,
      needsAttention: agentConnections.filter(({ enabled, lifecycle }) =>
        enabled && lifecycle === 'needs_attention').length,
      disabled: agentConnections.filter(({ enabled }) => !enabled).length,
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
      operation.kind === 'run_routine' ||
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

function catalogConnectionScopes(preset: ConnectorCatalogPreset): string[] {
  if ('url' in preset && typeof preset.url === 'string' &&
      preset.auth?.kind === 'oauth') {
    return scopeTokens(preset.auth.scope);
  }
  if ('api' in preset) return [...preset.api.methods];
  return [];
}

function normalizeAgentIdentityName(name: string): string {
  return name.trim().toLowerCase();
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
        operation.kind === 'run_routine' ||
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

function assertStandaloneBaseAgentCreation(
  operations: readonly ManagementOperation[],
): void {
  if (!operations.some(({ kind }) => kind === 'create_agent') || operations.length === 1) return;
  throw new ManagementError(
    'base_agent_capabilities_require_setup',
    'Create the base Agent in its own request. Add reach, connections, repositories, and schedules afterward.',
  );
}

function withTrustedSlackOriginGrant(
  actor: LiveManagementActor,
  operations: readonly ManagementOperation[],
): ManagementOperation[] {
  const creation = operations.length === 1 && operations[0]?.kind === 'create_agent'
    ? operations[0]
    : undefined;
  if (!creation || actor.origin.kind !== 'slack' ||
      actor.origin.conversationKind !== 'channel') {
    return [...operations];
  }
  const preferredItemId = `${creation.itemId}_origin_channel_grant`;
  const itemId = preferredItemId.length <= 128 && preferredItemId !== creation.itemId
    ? preferredItemId
    : 'origin_channel_grant';
  return [
    creation,
    {
      itemId,
      dependsOn: [creation.itemId],
      kind: 'grant_agent_channel',
      workspaceId: actor.origin.workspaceId,
      channelId: actor.origin.channelId,
      agentId: creation.agent.id,
      expectedRevision: 0,
    },
  ];
}

function isTrustedSlackOriginGrant(
  actor: LiveManagementActor,
  operations: readonly ManagementOperation[],
  operation: ManagementOperation,
): boolean {
  const creation = operations[0];
  const grant = operations[1];
  if (operations.length !== 2 || creation?.kind !== 'create_agent' ||
      grant?.kind !== 'grant_agent_channel' || operation.itemId !== grant.itemId) {
    return false;
  }
  const expected = withTrustedSlackOriginGrant(actor, [creation])[1];
  return expected?.kind === 'grant_agent_channel' &&
    canonicalJson(grant) === canonicalJson(expected);
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
      operation.kind === 'run_routine' ||
      operation.kind === 'delete_routine' || operation.kind === 'reassign_routine_agent') {
    return `routine:${operation.routineId ?? `${operation.workspaceId}:${'channelId' in operation ? operation.channelId : 'current_dm_thread'}`}`;
  }
  return operation.target.kind === 'provider_credential'
    ? `provider:${operation.target.providerId}`
    : `agent:${operation.target.agentId ?? operation.target.agentClientRef ?? 'unresolved'}`;
}

function routinePreview(
  routine: RoutineDefinition,
  agentName?: string,
): Record<string, unknown> {
  return {
    name: routine.name,
    ...(agentName ? { ownerAgent: agentName } : {}),
    description: routine.description,
    taskText: routine.taskText,
    schedule: routine.triggerKind === 'once'
      ? `Once at ${routine.scheduleInput}`
      : routine.scheduleInput,
    timezone: routine.timezone,
    destination: routine.destination.kind === 'direct_thread'
      ? 'Current DM thread'
      : `${routine.destination.threadTs ? 'Saved thread in' : 'New messages in'} Slack Channel ${routine.destination.channelId}`,
    delivery: routine.outputPolicy === 'post_on_change' ? 'Only when results change' : 'Always post',
  };
}

function routineOperationPreview(
  operation: Extract<ManagementOperation, { kind: 'save_routine' }>,
  agentName: string | undefined,
  existing: RoutineDefinition | undefined,
): Record<string, unknown> {
  const direct = operation.destination?.kind === 'current_dm_thread' ||
    existing?.destination.kind === 'direct_thread';
  return {
    name: operation.name,
    ...(agentName ? { ownerAgent: agentName } : {}),
    description: operation.description,
    taskText: operation.taskText,
    schedule: operation.schedule.kind === 'once'
      ? `Once at ${operation.schedule.localDateTime}`
      : operation.schedule.kind === 'in'
        ? `Once, ${operation.schedule.minutes} minute${operation.schedule.minutes === 1 ? '' : 's'} from now`
        : operation.schedule.expression,
    timezone: operation.timezone,
    destination: direct
      ? 'Current DM thread'
      : `${operation.destination?.kind === 'current_channel_thread' || existing?.destination.threadTs ? 'Saved thread in' : 'New messages in'} Slack Channel ${operation.channelId ?? existing?.channelId ?? 'unavailable'}`,
    delivery: operation.outputPolicy === 'post_on_change' ? 'Only when results change' : 'Always post',
  };
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
    operation.kind === 'save_routine' || operation.kind === 'control_routine' ||
    operation.kind === 'run_routine';
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
    presentation: {
      slack: formatSlackChangeSetProposal(proposal.preview),
    },
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

async function queueAppliedPrivateDmRoutineAcknowledgement(
  management: ManagementStore,
  actor: LiveManagementActor,
  operations: ManagementOperation[],
  result: ManagementApplyResult,
  at: number,
): Promise<void> {
  const origin = actor.origin;
  if (origin.kind !== 'slack' || origin.conversationKind !== 'im') return;
  const appliedRoutineItems = new Set(result.outcomes
    .filter(({ operationKind, disposition }) =>
      operationKind === 'save_routine' && disposition === 'applied')
    .map(({ itemId }) => itemId));
  if (!operations.some(({ kind, itemId }) =>
    kind === 'save_routine' && appliedRoutineItems.has(itemId))) return;
  if (!origin.messageTs) {
    console.warn(
      '[chickpea:management] private schedule acknowledgement skipped: origin message coordinate missing',
    );
    return;
  }

  const coordinateDigest = createHash('sha256')
    .update(`${result.operationId}\0${origin.workspaceId}\0${origin.channelId}\0${origin.messageTs}`)
    .digest('hex')
    .slice(0, 32);
  try {
    await management.putOutbox({
      outboxId: `routine_ack_${coordinateDigest}`,
      operationId: result.operationId,
      destination: {
        kind: 'reaction',
        workspaceId: origin.workspaceId,
        channelId: origin.channelId,
        messageTs: origin.messageTs,
      },
      receipt: { kind: 'routine_saved_reaction', emojiName: 'white_check_mark' },
      status: 'pending',
      attempts: 0,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
    });
  } catch {
    // The schedule is already durably saved. Keep that result truthful while
    // leaving a safe operational signal for the acknowledgement failure.
    console.error('[chickpea] Failed to queue private schedule acknowledgement');
  }
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

function skillImportMetadata(
  skill: SkillResolution['skills'][number],
  replacedExisting: boolean,
) {
  return {
    sourceUrl: skill.sourceUrl,
    path: skill.path,
    name: skill.name,
    description: skill.description,
    replacedExisting,
  };
}

interface ReversibleSkillChange {
  kind: 'enable' | 'disable' | 'remove';
  name: string;
}

function reversibleLocalSkillChange(
  current: CustomAgentConfig,
  patch: ManagementAgentPatch,
): ReversibleSkillChange | undefined {
  const fields = Object.keys(patch);
  if (fields.length !== 1 || fields[0] !== 'skills' || !patch.skills) return undefined;
  const before = current.skills;
  const after = patch.skills;

  if (before.length === after.length) {
    const changedIndexes = before.flatMap((skill, index) =>
      canonicalJson(skill) === canonicalJson(after[index]) ? [] : [index]);
    if (changedIndexes.length !== 1) return undefined;
    const index = changedIndexes[0]!;
    const previous = before[index]!;
    const next = after[index]!;
    if (previous.enabled === next.enabled ||
        canonicalJson({ ...previous, enabled: next.enabled }) !== canonicalJson(next)) {
      return undefined;
    }
    return { kind: next.enabled ? 'enable' : 'disable', name: next.name };
  }

  if (before.length !== after.length + 1) return undefined;
  for (let removedIndex = 0; removedIndex < before.length; removedIndex += 1) {
    const retained = before.filter((_, index) => index !== removedIndex);
    if (canonicalJson(retained) === canonicalJson(after)) {
      return { kind: 'remove', name: before[removedIndex]!.name };
    }
  }
  return undefined;
}

function explicitRequesterSkillChange(
  actor: LiveManagementActor,
  change: ReversibleSkillChange,
  context: {
    targetAgentName: string;
    installedSkillNames: readonly string[];
    editableAgentNames: readonly string[];
  },
): boolean {
  if (actor.origin.kind !== 'slack' || !actor.origin.requestText) return false;
  const systemSlackRoute = actor.origin.agentId === CHICKPEA_AGENT_ID;
  const request = normalizedRequesterText(actor.origin.requestText.replace(/\r?\n/g, ';'));
  const actionText = maskExactWord(
    maskExactWord(request, change.name),
    context.targetAgentName,
  );
  const mutations = actionText.match(
    /\b(?:enable|disable|remove|delete|uninstall|turn on|turn off)\b/g,
  ) ?? [];
  if (mutations.length !== 1 ||
      /\b(?:actually\s+no|i\s+disagree|changed my mind|never mind|nevermind)\b/.test(request)) {
    return false;
  }
  const clauses = [...request.matchAll(/([^.!?;,\n]+)([.!?;,\n]+|$)/g)]
    .map((match) => ({ text: match[1]!.trim(), terminator: match[2] ?? '' }))
    .filter(({ text }) => Boolean(text));
  const commandClauses = clauses.filter(({ text }) =>
    !/^(?:hi|hello|hey|please|thanks|thank you|ty|cheers|appreciate it|much appreciated|that(?:'s| is) all)$/.test(text));
  if (commandClauses.length !== 1) return false;
  const action = change.kind === 'enable'
    ? /\b(?:enable|turn on)\b/
    : change.kind === 'disable'
    ? /\b(?:disable|turn off)\b/
    : /\b(?:remove|delete|uninstall)\b/;
  return commandClauses.some(({ text: clause, terminator }) => {
    const match = action.exec(clause);
    if (!match) return false;
    const skill = wordMatch(clause, change.name);
    if (!skill || skill.index <= match.index || !uniquelyNamesValue(
      clause,
      change.name,
      context.installedSkillNames,
    )) return false;
    const prefix = clause.slice(0, match.index).trim();
    const between = clause.slice(match.index + match[0].length, skill.index).trim();
    const suffix = clause.slice(skill.index + skill[0].length).trim();
    const politeRequest = /^(?:(?:please|kindly)\s+)?(?:can|could|would|will)\s+you(?:\s+please)?(?:\s+just)?$/.test(prefix);
    const politeImperative = /^(?:please|kindly)(?:\s+just)?$/.test(prefix);
    const explicitCommand = /^(?:|just)$/.test(prefix) || politeImperative ||
      politeRequest ||
      /^(?:i\s+(?:want|need)\s+you\s+to|i(?:'d|\s+would)\s+like\s+you\s+to)$/.test(prefix) ||
      /^(?:(?:please|kindly)\s+)?go\s+ahead\s+and$/.test(prefix);
    const targetNamed = systemSlackRoute
      ? uniquelyNamesValue(
          clause,
          context.targetAgentName,
          context.editableAgentNames,
        )
      : true;
    return explicitCommand && (!terminator.includes('?') || politeRequest || politeImperative) &&
      targetNamed && /^(?:|the|my)$/.test(between) &&
      exactSkillChangeSuffix(suffix, context.targetAgentName, systemSlackRoute);
  });
}

function exactSkillChangeSuffix(
  suffix: string,
  targetAgentName: string,
  targetRequired: boolean,
): boolean {
  const escapedTarget = targetAgentName.toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const courtesyTail = '(?:\\s+(?:please|now|right now|for me))*';
  const spacedSuffix = suffix ? ` ${suffix}` : '';
  if (targetRequired) {
    return new RegExp(
      `^(?:\\s+skill)?\\s+(?:from|on|for)\\s+${escapedTarget}${courtesyTail}$`,
    ).test(spacedSuffix);
  }
  return new RegExp(
    `^(?:\\s+skill)?(?:\\s+(?:from|on|for)\\s+${escapedTarget})?${courtesyTail}$`,
  ).test(spacedSuffix);
}

function requesterExplicitlyRequestsUndo(requestText: string | undefined): boolean {
  if (!requestText) return false;
  return normalizedRequesterText(requestText)
    .split(/(?:[.!?;,\n]|\b(?:and|then|but)\b)+/)
    .some((clause) => /^(?:please )?undo\b/.test(clause.trim()));
}

function assertExplicitSkillImportRequest(
  actor: LiveManagementActor,
  input: ImportSkillInput,
): void {
  if (actor.origin.kind !== 'slack' || !actor.origin.requestText ||
      !requesterTextContainsExactSource(actor.origin.requestText, input.source)) {
    throw new ManagementError(
      'invalid_request',
      'Immediate skill import requires the exact GitHub source in the current requester message. No change was made.',
    );
  }
}

function explicitSkillReplacementRequest(
  actor: LiveManagementActor,
  skill: SkillResolution['skills'][number],
): boolean {
  if (actor.origin.kind !== 'slack' || !actor.origin.requestText) return false;
  const expected = normalizedRequesterText(`replace ${skill.name} from ${skill.sourceUrl}`);
  return normalizedRequesterText(actor.origin.requestText).includes(expected);
}

function normalizedRequesterText(value: string): string {
  return stripLeadingUserMentions(value)
    .replace(/<((?:https?:\/\/)[^>|]+)(?:\|[^>]*)?>/gi, '$1')
    .replace(/&amp;/gi, '&')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function requesterTextContainsExactSource(requestText: string, source: string): boolean {
  const text = normalizedRequesterText(requestText);
  const expected = normalizedRequesterText(source);
  if (!expected) return false;
  for (let offset = text.indexOf(expected); offset >= 0;
    offset = text.indexOf(expected, offset + 1)) {
    const before = offset === 0 ? '' : text[offset - 1]!;
    const afterOffset = offset + expected.length;
    const after = afterOffset === text.length ? '' : text[afterOffset]!;
    const beforeBoundary = before === '' || /[\s([{'"`]/.test(before);
    const afterBoundary = after === '' || /[\s)\]},'"`.!;:]/.test(after);
    if (beforeBoundary && afterBoundary) return true;
  }
  return false;
}

function wordMatch(text: string, value: string): RegExpExecArray | undefined {
  const escaped = value.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9-])${escaped}(?:$|[^a-z0-9-])`).exec(text) ?? undefined;
}

function uniquelyNamesValue(
  text: string,
  target: string,
  candidates: readonly string[],
): boolean {
  const matches = [...new Set([...candidates, target].map((value) => value.toLowerCase()))]
    .flatMap((value) => exactWordRanges(text, value).map((range) => ({ value, ...range })));
  const maximal = matches.filter((candidate) => !matches.some((other) =>
    other.value !== candidate.value &&
    other.start <= candidate.start &&
    other.end >= candidate.end &&
    (other.start < candidate.start || other.end > candidate.end)));
  return maximal.length === 1 && maximal[0]!.value === target.toLowerCase();
}

function exactWordRanges(text: string, value: string): Array<{ start: number; end: number }> {
  const escaped = value.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches: Array<{ start: number; end: number }> = [];
  const pattern = new RegExp(`(^|[^a-z0-9-])(${escaped})(?=$|[^a-z0-9-])`, 'g');
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[1]!.length;
    matches.push({ start, end: start + match[2]!.length });
  }
  return matches;
}

function maskExactWord(text: string, value: string | undefined): string {
  if (!value) return text;
  const escaped = value.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(
    new RegExp(`(^|[^a-z0-9-])${escaped}(?=$|[^a-z0-9-])`, 'g'),
    '$1<target>',
  );
}

function skillImportOperationId(
  actor: LiveManagementActor,
  input: ImportSkillInput,
): string {
  const digest = createHash('sha256').update(canonicalJson({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    originKey: managementActorOriginKey(actor),
    agentId: input.agentId ?? actor.actingAgentId ?? null,
    idempotencyKey: input.idempotencyKey,
    source: input.source,
    skillName: input.skillName ?? null,
    replaceExisting: input.replaceExisting === true,
  })).digest('hex').slice(0, 32);
  return `management_skill_import_${digest}`;
}

function skillActionOperationId(
  actor: LiveManagementActor,
  input: ManageAgentSkillInput,
  agentId: string,
): string {
  const digest = createHash('sha256').update(canonicalJson({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    originKey: managementActorOriginKey(actor),
    agentId,
    idempotencyKey: input.idempotencyKey,
    action: input.action,
    skillName: input.skillName,
  })).digest('hex').slice(0, 32);
  return `management_skill_action_${digest}`;
}

function managedSkillActionResult(
  operationId: string,
  metadata: NonNullable<ManagementApplyResult['receiptMetadata']>['skillAction'],
  undoAvailable: boolean,
): ManageAgentSkillResult {
  if (!metadata) {
    throw new ManagementError('invalid_state', 'The skill change receipt is unavailable.');
  }
  const verb = metadata.action === 'enable'
    ? 'Enabled'
    : metadata.action === 'disable'
    ? 'Disabled'
    : 'Removed';
  const preposition = metadata.action === 'remove' ? 'from' : 'on';
  return {
    status: 'updated',
    action: metadata.action,
    skillName: metadata.name,
    operationId,
    activation: 'next_turn',
    undoAvailable,
    presentation: {
      slack: `${verb} skill \`${escapeSlackControlCharacters(metadata.name)}\` ${preposition} ${
        escapeSlackControlCharacters(metadata.agentName)
      }. The change takes effect from the next message.${
        undoAvailable ? ' You can undo this change.' : ''
      }`,
    },
  };
}

function unchangedSkillActionResult(
  action: ManageAgentSkillInput['action'],
  skillName: string,
  agentName: string,
  reason: 'missing' | 'already_set',
): ManageAgentSkillResult {
  const escapedSkill = escapeSlackControlCharacters(skillName);
  const escapedAgent = escapeSlackControlCharacters(agentName);
  const state = action === 'enable' ? 'enabled' : 'disabled';
  const slack = reason === 'missing'
    ? `Skill \`${escapedSkill}\` is not installed on ${escapedAgent}. No changes were made.`
    : `Skill \`${escapedSkill}\` is already ${state} on ${escapedAgent}. No changes were made.`;
  return {
    status: 'unchanged',
    action,
    skillName,
    undoAvailable: false,
    presentation: { slack },
  };
}

function singleChangedSkill(
  before: readonly SkillConfig[],
  after: readonly SkillConfig[],
): SkillConfig | undefined {
  const previous = new Map(before.map((skill) => [skill.name, skill]));
  const changed = after.filter((skill) =>
    canonicalJson(previous.get(skill.name)) !== canonicalJson(skill));
  const removed = before.filter((skill) => !after.some(({ name }) => name === skill.name));
  return changed.length === 1 && removed.length === 0 ? changed[0] : undefined;
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
