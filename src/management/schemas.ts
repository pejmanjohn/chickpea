import * as v from 'valibot';
import { z } from 'zod';

import { AGENT_ID_PATTERN } from '../config/agent-id.ts';
import {
  AGENT_AUTHORING_GUIDE_VERSION,
  AGENT_AUTHORING_REASONS,
} from './agent-authoring/index.ts';

export const MANAGEMENT_OPERATION_KINDS = [
  'create_agent',
  'update_agent',
  'delete_agent',
  'archive_agent',
  'restore_agent',
  'put_channel',
  'grant_agent_channel',
  'revoke_agent_channel',
  'update_member',
  'remove_provider_credential',
  'update_agent_memory',
  'save_routine',
  'control_routine',
  'run_routine',
  'delete_routine',
  'reassign_routine_agent',
  'request_setup',
] as const;

const zText = (max: number) => z.string().min(1).max(max);
const zOptionalText = (max: number) => z.string().max(max);
const zId = zText(128);
const zAgentId = z.string().regex(AGENT_ID_PATTERN);
const zRevision = z.number().int().nonnegative();
const zModelSpecifier = z.string().min(1).max(500).regex(/^[^/]+\/.+$/);

const zSkill = z.strictObject({
  name: zText(64),
  description: zOptionalText(2_000),
  instructions: zOptionalText(100_000),
  enabled: z.boolean(),
});
const zMcpTool = z.strictObject({
  name: zText(120),
  title: zOptionalText(160).optional(),
  description: zOptionalText(400).optional(),
});
const zConnectionIdentity = z.strictObject({
  workspaceName: zOptionalText(240).optional(),
  accountName: zOptionalText(240).optional(),
});
const zMcpConnection = z.strictObject({
  id: zId,
  displayName: zText(240),
  url: z.url().max(2_000),
  transport: z.enum(['streamable-http', 'sse']),
  authMode: z.enum(['none', 'bearer', 'oauth']),
  headerNames: z.array(zText(120)).max(32),
  enabled: z.boolean(),
  lifecycleStatus: z.enum(['pending', 'ready', 'failed']),
  statusText: zOptionalText(1_000),
  discoveredTools: z.array(zMcpTool).max(500),
  allowedTools: z.array(zText(120)).max(500),
  oauthScope: zOptionalText(2_000).optional(),
  lastCheckedAt: z.number().int().nonnegative().optional(),
  identity: zConnectionIdentity.optional(),
  presetId: zId.optional(),
});
const zApiConnection = z.strictObject({
  id: zId,
  displayName: zText(240),
  allowedHosts: z.array(zText(253)).max(100),
  pathPrefixes: z.array(zText(2_000)).max(100),
  headerName: zText(120),
  headerValuePrefix: zOptionalText(120).optional(),
  allowedMethods: z.array(zText(20)).max(20),
  enabled: z.boolean(),
  authMode: z.enum(['credential', 'oauth']).optional(),
  oauthProvider: z.literal('google').optional(),
  oauthScopes: z.array(zText(500)).max(100).optional(),
  oauthAppType: z.enum(['workspace-internal', 'external']).optional(),
  lifecycleStatus: z.enum(['pending', 'ready', 'failed']).optional(),
  statusText: zOptionalText(1_000).optional(),
  identity: zConnectionIdentity.optional(),
  presetId: zId.optional(),
});
const zRepository = z.strictObject({
  id: zId,
  installationId: z.number().int().positive().nullable(),
  accountLogin: zText(240),
  fullName: zText(500),
  allRepos: z.boolean().optional(),
  enabled: z.boolean(),
});
const zAgentFields = {
  name: zText(240),
  description: zOptionalText(500).optional(),
  requestedHandle: zText(120).optional(),
  editPolicy: z.enum(['creator_and_admins', 'all_workspace_members']).optional(),
  instructions: zOptionalText(100_000),
  enabled: z.boolean(),
  model: zModelSpecifier.optional(),
  skills: z.array(zSkill).max(100),
  mcpServers: z.array(zMcpConnection).max(50),
  apiConnections: z.array(zApiConnection).max(50),
  repositories: z.array(zRepository).max(100),
};
const zAgent = z.strictObject({ id: zAgentId, ...zAgentFields });
const zAgentPatch = z.strictObject({
  name: zAgentFields.name.optional(),
  description: zAgentFields.description,
  requestedHandle: zAgentFields.requestedHandle,
  editPolicy: zAgentFields.editPolicy,
  instructions: zAgentFields.instructions.optional(),
  enabled: zAgentFields.enabled.optional(),
  model: zModelSpecifier.nullable().optional(),
  skills: zAgentFields.skills.optional(),
  mcpServers: zAgentFields.mcpServers.optional(),
  apiConnections: zAgentFields.apiConnections.optional(),
  repositories: zAgentFields.repositories.optional(),
});
const zChannel = z.strictObject({
  workspaceId: zId,
  channelId: zId,
  revision: zRevision.optional(),
  label: zOptionalText(240).optional(),
  lifecycle: z.enum(['active', 'archived']),
});
const zOperationBase = {
  itemId: zId,
  dependsOn: z.array(zId).max(25).optional(),
};
const zRoutineSchedule = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cron'), expression: zText(200) }),
  z.strictObject({ kind: z.literal('once'), localDateTime: zText(64) }),
  z.strictObject({
    kind: z.literal('in'),
    minutes: z.number().int().min(1).max(532_800),
  }),
]);
const zSetupAgentTargetBase = {
  agentId: zAgentId.optional(),
  agentClientRef: zId.optional(),
};
const zSetupTarget = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('api_connection'),
    ...zSetupAgentTargetBase,
    connectionId: zId,
  }),
  z.strictObject({
    kind: z.literal('mcp_connection'),
    ...zSetupAgentTargetBase,
    connectionId: zId,
  }),
  z.strictObject({
    kind: z.literal('repository_access'),
    ...zSetupAgentTargetBase,
    repositoryId: zId,
  }),
  z.strictObject({
    kind: z.literal('provider_credential'),
    providerId: z.enum(['anthropic', 'openai', 'openrouter']),
  }),
]);

export const managementOperationZodSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...zOperationBase, kind: z.literal('create_agent'), clientRef: zId.optional(), agent: zAgent }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('update_agent'),
    agentId: zAgentId,
    expectedRevision: zRevision,
    confirmationReason: z.literal('recipe_overwrite').optional(),
    patch: zAgentPatch,
  }),
  z.strictObject({ ...zOperationBase, kind: z.literal('delete_agent'), agentId: zAgentId, expectedRevision: zRevision }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('archive_agent'),
    agentId: zAgentId,
    expectedRevision: zRevision,
    replacementDefaultAgentId: zAgentId.optional(),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('restore_agent'),
    agentId: zAgentId,
    expectedRevision: zRevision,
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('put_channel'),
    channel: zChannel,
    expectedRevision: zRevision,
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('grant_agent_channel'),
    workspaceId: zId,
    channelId: zId,
    expectedRevision: zRevision,
    agentId: zAgentId.optional(),
    agentClientRef: zId.optional(),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('revoke_agent_channel'),
    workspaceId: zId,
    channelId: zId,
    agentId: zAgentId,
    expectedRevision: zRevision,
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('update_member'),
    membershipId: zId,
    role: z.enum(['owner', 'admin', 'member']).optional(),
    status: z.enum(['active', 'suspended', 'removed']).optional(),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('remove_provider_credential'),
    providerId: z.enum(['anthropic', 'openai', 'openrouter']),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('update_agent_memory'),
    agentId: zAgentId,
    expectedRevision: zRevision,
    body: z.string().max(65_536),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('save_routine'),
    agentId: zAgentId,
    workspaceId: zId,
    channelId: zId.optional(),
    destination: z.strictObject({ kind: z.literal('current_dm_thread') }).optional(),
    routineId: zId.optional(),
    expectedVersion: z.number().int().positive().optional(),
    name: zText(200),
    description: z.string().max(2_000),
    taskText: zText(20_000),
    schedule: zRoutineSchedule,
    timezone: zText(100),
    outputPolicy: z.enum(['post', 'post_on_change']),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('control_routine'),
    workspaceId: zId,
    channelId: zId.optional(),
    routineId: zId,
    expectedVersion: z.number().int().positive(),
    action: z.enum(['pause', 'resume', 'disable']),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('run_routine'),
    workspaceId: zId,
    channelId: zId.optional(),
    routineId: zId,
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('delete_routine'),
    workspaceId: zId,
    channelId: zId.optional(),
    routineId: zId,
    expectedVersion: z.number().int().positive(),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('reassign_routine_agent'),
    workspaceId: zId,
    routineId: zId,
    expectedVersion: z.number().int().positive(),
    agentId: zAgentId,
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('request_setup'),
    target: zSetupTarget,
  }),
]);

export const applyWorkspaceChangesZodSchema = z.strictObject({
  idempotencyKey: zText(256),
  operations: z.array(managementOperationZodSchema).min(1).max(25),
});
export const proposeWorkspaceChangesZodSchema = z.strictObject({
  idempotencyKey: zText(256),
  guideVersion: z.literal(AGENT_AUTHORING_GUIDE_VERSION),
  authoringReason: z.enum(AGENT_AUTHORING_REASONS),
  operations: z.array(managementOperationZodSchema).min(1).max(25),
});
export const proposeSkillImportZodSchema = z.strictObject({
  agentId: zAgentId,
  source: zText(2_000),
  skillName: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64).optional(),
  idempotencyKey: zText(256),
  guideVersion: z.literal(AGENT_AUTHORING_GUIDE_VERSION),
});
export const importSkillZodSchema = proposeSkillImportZodSchema.extend({
  replaceExisting: z.boolean().optional(),
});
export const confirmWorkspaceChangeZodSchema = z.strictObject({ proposalId: zId });
export const undoWorkspaceChangeZodSchema = z.strictObject({
  operationId: zId,
  idempotencyKey: zText(256),
});
export const getOperationZodSchema = z.strictObject({ operationId: zId });
export const revokeSetupLinkZodSchema = z.strictObject({
  setupOperationId: zId,
  reissue: z.boolean().optional(),
});
export const inspectWorkspaceZodSchema = z.strictObject({});
export const prepareConnectorSetupZodSchema = z.strictObject({
  // External MCP clients have no trusted Slack route from which to infer the
  // target Agent. The Slack adapter uses the Valibot schema below and may omit
  // this field only because routing supplies the Agent ID out of band.
  agentId: zAgentId,
  connector: zText(128),
  ownerKind: z.enum(['team', 'member']),
});
export const discoverSlackChannelsZodSchema = z.strictObject({
  refresh: z.boolean().optional(),
});
export const testMcpConnectionZodSchema = z.strictObject({
  agentId: zAgentId,
  connectionId: zId,
});
export const inspectMemoryZodSchema = z.strictObject({ agentId: zAgentId });
export const inspectRoutinesZodSchema = z.strictObject({
  workspaceId: zId,
  channelId: zId.optional(),
  routineId: zId.optional(),
});
export const exportRecipeZodSchema = z.strictObject({
  agentIds: z.array(zAgentId).max(100).optional(),
});
export const previewRecipeZodSchema = z.strictObject({
  recipe: z.unknown(),
  agentStrategy: z.enum(['clone', 'update', 'skip']).optional(),
});

const vt = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max));
const vot = (max: number) => v.pipe(v.string(), v.maxLength(max));
const vid = vt(128);
const vAgentId = v.pipe(v.string(), v.regex(AGENT_ID_PATTERN));
const vr = v.pipe(v.number(), v.integer(), v.minValue(0));
const vModelSpecifier = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(500),
  v.regex(/^[^/]+\/.+$/),
);
const va = <TItem extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  item: TItem,
  max: number,
) => v.pipe(v.array(item), v.maxLength(max));

const vSkill = v.strictObject({
  name: vt(64), description: vot(2_000), instructions: vot(100_000), enabled: v.boolean(),
});
const vMcpTool = v.strictObject({
  name: vt(120), title: v.optional(vot(160)), description: v.optional(vot(400)),
});
const vConnectionIdentity = v.strictObject({
  workspaceName: v.optional(vot(240)), accountName: v.optional(vot(240)),
});
const vMcpConnection = v.strictObject({
  id: vid,
  displayName: vt(240),
  url: v.pipe(v.string(), v.url(), v.maxLength(2_000)),
  transport: v.picklist(['streamable-http', 'sse']),
  authMode: v.picklist(['none', 'bearer', 'oauth']),
  headerNames: va(vt(120), 32),
  enabled: v.boolean(),
  lifecycleStatus: v.picklist(['pending', 'ready', 'failed']),
  statusText: vot(1_000),
  discoveredTools: va(vMcpTool, 500),
  allowedTools: va(vt(120), 500),
  oauthScope: v.optional(vot(2_000)),
  lastCheckedAt: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  identity: v.optional(vConnectionIdentity),
  presetId: v.optional(vid),
});
const vApiConnection = v.strictObject({
  id: vid,
  displayName: vt(240),
  allowedHosts: va(vt(253), 100),
  pathPrefixes: va(vt(2_000), 100),
  headerName: vt(120),
  headerValuePrefix: v.optional(vot(120)),
  allowedMethods: va(vt(20), 20),
  enabled: v.boolean(),
  authMode: v.optional(v.picklist(['credential', 'oauth'])),
  oauthProvider: v.optional(v.literal('google')),
  oauthScopes: v.optional(va(vt(500), 100)),
  oauthAppType: v.optional(v.picklist(['workspace-internal', 'external'])),
  lifecycleStatus: v.optional(v.picklist(['pending', 'ready', 'failed'])),
  statusText: v.optional(vot(1_000)),
  identity: v.optional(vConnectionIdentity),
  presetId: v.optional(vid),
});
const vRepository = v.strictObject({
  id: vid,
  installationId: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
  accountLogin: vt(240),
  fullName: vt(500),
  allRepos: v.optional(v.boolean()),
  enabled: v.boolean(),
});
const vAgentFields = {
  name: vt(240),
  description: v.optional(vot(500)),
  requestedHandle: v.optional(vt(120)),
  editPolicy: v.optional(v.picklist(['creator_and_admins', 'all_workspace_members'])),
  instructions: vot(100_000),
  enabled: v.boolean(),
  model: v.optional(vModelSpecifier),
  skills: va(vSkill, 100),
  mcpServers: va(vMcpConnection, 50),
  apiConnections: va(vApiConnection, 50),
  repositories: va(vRepository, 100),
};
const vAgent = v.strictObject({ id: vAgentId, ...vAgentFields });
const vAgentPatch = v.strictObject({
  name: v.optional(vAgentFields.name),
  description: vAgentFields.description,
  requestedHandle: vAgentFields.requestedHandle,
  editPolicy: vAgentFields.editPolicy,
  instructions: v.optional(vAgentFields.instructions),
  enabled: v.optional(vAgentFields.enabled),
  model: v.optional(v.nullable(vModelSpecifier)),
  skills: v.optional(vAgentFields.skills),
  mcpServers: v.optional(vAgentFields.mcpServers),
  apiConnections: v.optional(vAgentFields.apiConnections),
  repositories: v.optional(vAgentFields.repositories),
});
const vChannel = v.strictObject({
  workspaceId: vid,
  channelId: vid,
  revision: v.optional(vr),
  label: v.optional(vot(240)),
  lifecycle: v.picklist(['active', 'archived']),
});
const vOperationBase = { itemId: vid, dependsOn: v.optional(va(vid, 25)) };
const vRoutineSchedule = v.variant('kind', [
  v.strictObject({ kind: v.literal('cron'), expression: vt(200) }),
  v.strictObject({ kind: v.literal('once'), localDateTime: vt(64) }),
  v.strictObject({
    kind: v.literal('in'),
    minutes: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(532_800)),
  }),
]);
const vSetupAgentTargetBase = {
  agentId: v.optional(vAgentId),
  agentClientRef: v.optional(vid),
};
const vSetupTarget = v.variant('kind', [
  v.strictObject({
    kind: v.literal('api_connection'),
    ...vSetupAgentTargetBase,
    connectionId: vid,
  }),
  v.strictObject({
    kind: v.literal('mcp_connection'),
    ...vSetupAgentTargetBase,
    connectionId: vid,
  }),
  v.strictObject({
    kind: v.literal('repository_access'),
    ...vSetupAgentTargetBase,
    repositoryId: vid,
  }),
  v.strictObject({
    kind: v.literal('provider_credential'),
    providerId: v.picklist(['anthropic', 'openai', 'openrouter']),
  }),
]);

export const managementOperationValibotSchema = v.variant('kind', [
  v.strictObject({ ...vOperationBase, kind: v.literal('create_agent'), clientRef: v.optional(vid), agent: vAgent }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('update_agent'),
    agentId: vAgentId,
    expectedRevision: vr,
    confirmationReason: v.optional(v.literal('recipe_overwrite')),
    patch: vAgentPatch,
  }),
  v.strictObject({ ...vOperationBase, kind: v.literal('delete_agent'), agentId: vAgentId, expectedRevision: vr }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('archive_agent'),
    agentId: vAgentId,
    expectedRevision: vr,
    replacementDefaultAgentId: v.optional(vAgentId),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('restore_agent'),
    agentId: vAgentId,
    expectedRevision: vr,
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('put_channel'),
    channel: vChannel,
    expectedRevision: vr,
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('grant_agent_channel'),
    workspaceId: vid,
    channelId: vid,
    expectedRevision: vr,
    agentId: v.optional(vAgentId),
    agentClientRef: v.optional(vid),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('revoke_agent_channel'),
    workspaceId: vid,
    channelId: vid,
    agentId: vAgentId,
    expectedRevision: vr,
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('update_member'),
    membershipId: vid,
    role: v.optional(v.picklist(['owner', 'admin', 'member'])),
    status: v.optional(v.picklist(['active', 'suspended', 'removed'])),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('remove_provider_credential'),
    providerId: v.picklist(['anthropic', 'openai', 'openrouter']),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('update_agent_memory'),
    agentId: vAgentId,
    expectedRevision: vr,
    body: vot(65_536),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('save_routine'),
    agentId: vAgentId,
    workspaceId: vid,
    channelId: v.optional(vid),
    destination: v.optional(v.strictObject({ kind: v.literal('current_dm_thread') })),
    routineId: v.optional(vid),
    expectedVersion: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    name: vt(200),
    description: vot(2_000),
    taskText: vt(20_000),
    schedule: vRoutineSchedule,
    timezone: vt(100),
    outputPolicy: v.picklist(['post', 'post_on_change']),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('control_routine'),
    workspaceId: vid,
    channelId: v.optional(vid),
    routineId: vid,
    expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
    action: v.picklist(['pause', 'resume', 'disable']),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('run_routine'),
    workspaceId: vid,
    channelId: v.optional(vid),
    routineId: vid,
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('delete_routine'),
    workspaceId: vid,
    channelId: v.optional(vid),
    routineId: vid,
    expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('reassign_routine_agent'),
    workspaceId: vid,
    routineId: vid,
    expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
    agentId: vAgentId,
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('request_setup'),
    target: vSetupTarget,
  }),
]);

export const applyWorkspaceChangesValibotSchema = v.strictObject({
  idempotencyKey: vt(256),
  operations: v.pipe(v.array(managementOperationValibotSchema), v.minLength(1), v.maxLength(25)),
});
export const proposeWorkspaceChangesValibotSchema = v.strictObject({
  idempotencyKey: vt(256),
  guideVersion: v.literal(AGENT_AUTHORING_GUIDE_VERSION),
  authoringReason: v.picklist(AGENT_AUTHORING_REASONS),
  operations: v.pipe(v.array(managementOperationValibotSchema), v.minLength(1), v.maxLength(25)),
});
export const proposeSkillImportValibotSchema = v.strictObject({
  agentId: v.optional(vAgentId),
  source: vt(2_000),
  skillName: v.optional(v.pipe(
    v.string(),
    v.maxLength(64),
    v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  )),
  idempotencyKey: vt(256),
  guideVersion: v.literal(AGENT_AUTHORING_GUIDE_VERSION),
});
export const importSkillValibotSchema = v.strictObject({
  agentId: v.optional(vAgentId),
  source: vt(2_000),
  skillName: v.optional(v.pipe(
    v.string(),
    v.maxLength(64),
    v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  )),
  replaceExisting: v.optional(v.boolean()),
  idempotencyKey: vt(256),
  guideVersion: v.literal(AGENT_AUTHORING_GUIDE_VERSION),
});
export const confirmWorkspaceChangeValibotSchema = v.strictObject({ proposalId: vid });
export const undoWorkspaceChangeValibotSchema = v.strictObject({
  operationId: vid,
  idempotencyKey: vt(256),
});
export const getOperationValibotSchema = v.strictObject({ operationId: vid });
export const revokeSetupLinkValibotSchema = v.strictObject({
  setupOperationId: vid,
  reissue: v.optional(v.boolean()),
});
export const inspectWorkspaceValibotSchema = v.strictObject({});
export const prepareConnectorSetupValibotSchema = v.strictObject({
  agentId: v.optional(vAgentId),
  connector: vt(128),
  ownerKind: v.picklist(['team', 'member']),
});
export const discoverSlackChannelsValibotSchema = v.strictObject({
  refresh: v.optional(v.boolean()),
});
export const testMcpConnectionValibotSchema = v.strictObject({
  agentId: vAgentId,
  connectionId: vid,
});
export const inspectMemoryValibotSchema = v.strictObject({ agentId: vAgentId });
export const inspectRoutinesValibotSchema = v.strictObject({
  workspaceId: vid,
  channelId: v.optional(vid),
  routineId: v.optional(vid),
});
export const exportRecipeValibotSchema = v.strictObject({
  agentIds: v.optional(va(vAgentId, 100)),
});
export const previewRecipeValibotSchema = v.strictObject({
  recipe: v.unknown(),
  agentStrategy: v.optional(v.picklist(['clone', 'update', 'skip'])),
});
