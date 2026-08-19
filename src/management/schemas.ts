import * as v from 'valibot';
import { z } from 'zod';

export const MANAGEMENT_OPERATION_KINDS = [
  'create_agent',
  'update_agent',
  'delete_agent',
  'put_channel',
  'place_agent',
  'update_member',
  'remove_provider_credential',
  'create_slack_identity',
  'set_slack_identity_dms',
  'retire_slack_identity',
  'cancel_slack_identity_setup',
  'invite_member',
  'revoke_invitation',
  'create_memory_entry',
  'update_memory_entry',
  'forget_memory_entry',
  'save_routine',
  'control_routine',
  'delete_routine',
  'request_setup',
] as const;

const zText = (max: number) => z.string().min(1).max(max);
const zOptionalText = (max: number) => z.string().max(max);
const zId = zText(128);
const zRevision = z.number().int().nonnegative();
const zSlackIdentityId = z.string().regex(/^slack_identity_[a-z0-9_-]{1,96}$/);

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
  instructions: zOptionalText(100_000),
  enabled: z.boolean(),
  model: zText(500).optional(),
  skills: z.array(zSkill).max(100),
  mcpServers: z.array(zMcpConnection).max(50),
  apiConnections: z.array(zApiConnection).max(50),
  repositories: z.array(zRepository).max(100),
  slackIdentityId: zId.optional(),
};
const zAgent = z.strictObject({ id: zId, ...zAgentFields });
const zAgentPatch = z.strictObject({
  name: zAgentFields.name.optional(),
  instructions: zAgentFields.instructions.optional(),
  enabled: zAgentFields.enabled.optional(),
  model: zText(500).nullable().optional(),
  skills: zAgentFields.skills.optional(),
  mcpServers: zAgentFields.mcpServers.optional(),
  apiConnections: zAgentFields.apiConnections.optional(),
  repositories: zAgentFields.repositories.optional(),
  slackIdentityId: zId.nullable().optional(),
});
const zChannel = z.strictObject({
  workspaceId: zId,
  channelId: zId,
  revision: z.number().int().positive().optional(),
  label: zOptionalText(240).optional(),
  additionalInstructions: zOptionalText(100_000).optional(),
  participationMode: z.enum(['ambient', 'mention_only']),
  lifecycle: z.enum(['active', 'archived']),
});
const zOperationBase = {
  itemId: zId,
  dependsOn: z.array(zId).max(25).optional(),
};
const zMemoryOwner = z.strictObject({
  workspaceId: zId,
  ownerKind: z.enum(['agent', 'channel']),
  ownerId: zId,
});
const zMemoryType = z.enum(['fact', 'decision', 'project', 'feedback', 'preference']);
const zRoutineSchedule = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cron'), expression: zText(200) }),
  z.strictObject({ kind: z.literal('once'), localDateTime: zText(64) }),
]);
const zSetupAgentTargetBase = {
  agentId: zId.optional(),
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
  z.strictObject({
    kind: z.literal('slack_identity'),
    identityId: zSlackIdentityId,
  }),
]);

export const managementOperationZodSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...zOperationBase, kind: z.literal('create_agent'), clientRef: zId.optional(), agent: zAgent }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('update_agent'),
    agentId: zId,
    expectedRevision: zRevision,
    confirmationReason: z.literal('recipe_overwrite').optional(),
    patch: zAgentPatch,
  }),
  z.strictObject({ ...zOperationBase, kind: z.literal('delete_agent'), agentId: zId, expectedRevision: zRevision }),
  z.strictObject({ ...zOperationBase, kind: z.literal('put_channel'), channel: zChannel, expectedRevision: zRevision }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('place_agent'),
    workspaceId: zId,
    channelId: zId,
    expectedRevision: zRevision,
    expectedAgentId: zId.nullable(),
    agentId: zId.nullable().optional(),
    agentClientRef: zId.optional(),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('update_member'),
    membershipId: zId,
    role: z.enum(['owner', 'admin']).optional(),
    status: z.enum(['active', 'suspended', 'removed']).optional(),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('remove_provider_credential'),
    providerId: z.enum(['anthropic', 'openai', 'openrouter']),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('create_slack_identity'),
    identityId: zSlackIdentityId,
    initialDmAgentId: zId,
    appName: zText(35),
    displayName: zText(80),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('set_slack_identity_dms'),
    identityId: zSlackIdentityId,
    expectedRevision: zRevision,
    dmState: z.enum(['on', 'off']),
    dmAgentId: zId.optional(),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('retire_slack_identity'),
    identityId: zSlackIdentityId,
    expectedRevision: zRevision,
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('cancel_slack_identity_setup'),
    identityId: zSlackIdentityId,
    expectedRevision: zRevision,
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('invite_member'),
    slackUserId: z.string().regex(/^[A-Z][A-Z0-9]{1,63}$/),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('revoke_invitation'),
    invitationId: zId,
    expectedRevision: zRevision,
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('create_memory_entry'),
    owner: zMemoryOwner,
    entry: z.strictObject({
      slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
      description: z.string().max(2_000),
      type: zMemoryType,
      body: z.string().max(100_000),
    }),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('update_memory_entry'),
    owner: zMemoryOwner,
    entryId: zId,
    expectedVersion: z.number().int().positive(),
    description: z.string().max(2_000),
    type: zMemoryType,
    body: z.string().max(100_000),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('forget_memory_entry'),
    owner: zMemoryOwner,
    entryId: zId,
    expectedVersion: z.number().int().positive(),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('save_routine'),
    workspaceId: zId,
    channelId: zId,
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
    channelId: zId,
    routineId: zId,
    expectedVersion: z.number().int().positive(),
    action: z.enum(['pause', 'resume', 'disable']),
  }),
  z.strictObject({
    ...zOperationBase,
    kind: z.literal('delete_routine'),
    workspaceId: zId,
    channelId: zId,
    routineId: zId,
    expectedVersion: z.number().int().positive(),
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
export const discoverSlackChannelsZodSchema = z.strictObject({
  refresh: z.boolean().optional(),
});
export const inspectSlackMemberDirectoryZodSchema = z.strictObject({
  cursor: z.string().max(512).optional(),
});
export const testMcpConnectionZodSchema = z.strictObject({
  agentId: zId,
  connectionId: zId,
});
export const inspectMemoryZodSchema = zMemoryOwner;
export const inspectRoutinesZodSchema = z.strictObject({
  workspaceId: zId,
  channelId: zId.optional(),
  routineId: zId.optional(),
});
export const exportRecipeZodSchema = z.strictObject({
  agentIds: z.array(zId).max(100).optional(),
});
export const previewRecipeZodSchema = z.strictObject({
  recipe: z.unknown(),
  agentStrategy: z.enum(['clone', 'update', 'skip']).optional(),
  channelTargets: z.array(z.strictObject({
    symbol: zId,
    workspaceId: zId,
    channelId: zId,
    expectedRevision: zRevision,
    expectedAgentId: zId.nullable(),
  })).max(100).optional(),
});

const vt = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max));
const vot = (max: number) => v.pipe(v.string(), v.maxLength(max));
const vid = vt(128);
const vr = v.pipe(v.number(), v.integer(), v.minValue(0));
const vSlackIdentityId = v.pipe(v.string(), v.regex(/^slack_identity_[a-z0-9_-]{1,96}$/));
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
  instructions: vot(100_000),
  enabled: v.boolean(),
  model: v.optional(vt(500)),
  skills: va(vSkill, 100),
  mcpServers: va(vMcpConnection, 50),
  apiConnections: va(vApiConnection, 50),
  repositories: va(vRepository, 100),
  slackIdentityId: v.optional(vid),
};
const vAgent = v.strictObject({ id: vid, ...vAgentFields });
const vAgentPatch = v.strictObject({
  name: v.optional(vAgentFields.name),
  instructions: v.optional(vAgentFields.instructions),
  enabled: v.optional(vAgentFields.enabled),
  model: v.optional(v.nullable(vt(500))),
  skills: v.optional(vAgentFields.skills),
  mcpServers: v.optional(vAgentFields.mcpServers),
  apiConnections: v.optional(vAgentFields.apiConnections),
  repositories: v.optional(vAgentFields.repositories),
  slackIdentityId: v.optional(v.nullable(vid)),
});
const vChannel = v.strictObject({
  workspaceId: vid,
  channelId: vid,
  revision: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  label: v.optional(vot(240)),
  additionalInstructions: v.optional(vot(100_000)),
  participationMode: v.picklist(['ambient', 'mention_only']),
  lifecycle: v.picklist(['active', 'archived']),
});
const vOperationBase = { itemId: vid, dependsOn: v.optional(va(vid, 25)) };
const vMemoryOwner = v.strictObject({
  workspaceId: vid,
  ownerKind: v.picklist(['agent', 'channel']),
  ownerId: vid,
});
const vMemoryType = v.picklist(['fact', 'decision', 'project', 'feedback', 'preference']);
const vRoutineSchedule = v.variant('kind', [
  v.strictObject({ kind: v.literal('cron'), expression: vt(200) }),
  v.strictObject({ kind: v.literal('once'), localDateTime: vt(64) }),
]);
const vSetupAgentTargetBase = {
  agentId: v.optional(vid),
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
  v.strictObject({
    kind: v.literal('slack_identity'),
    identityId: vSlackIdentityId,
  }),
]);

export const managementOperationValibotSchema = v.variant('kind', [
  v.strictObject({ ...vOperationBase, kind: v.literal('create_agent'), clientRef: v.optional(vid), agent: vAgent }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('update_agent'),
    agentId: vid,
    expectedRevision: vr,
    confirmationReason: v.optional(v.literal('recipe_overwrite')),
    patch: vAgentPatch,
  }),
  v.strictObject({ ...vOperationBase, kind: v.literal('delete_agent'), agentId: vid, expectedRevision: vr }),
  v.strictObject({ ...vOperationBase, kind: v.literal('put_channel'), channel: vChannel, expectedRevision: vr }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('place_agent'),
    workspaceId: vid,
    channelId: vid,
    expectedRevision: vr,
    expectedAgentId: v.nullable(vid),
    agentId: v.optional(v.nullable(vid)),
    agentClientRef: v.optional(vid),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('update_member'),
    membershipId: vid,
    role: v.optional(v.picklist(['owner', 'admin'])),
    status: v.optional(v.picklist(['active', 'suspended', 'removed'])),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('remove_provider_credential'),
    providerId: v.picklist(['anthropic', 'openai', 'openrouter']),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('create_slack_identity'),
    identityId: vSlackIdentityId,
    initialDmAgentId: vid,
    appName: vt(35),
    displayName: vt(80),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('set_slack_identity_dms'),
    identityId: vSlackIdentityId,
    expectedRevision: vr,
    dmState: v.picklist(['on', 'off']),
    dmAgentId: v.optional(vid),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('retire_slack_identity'),
    identityId: vSlackIdentityId,
    expectedRevision: vr,
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('cancel_slack_identity_setup'),
    identityId: vSlackIdentityId,
    expectedRevision: vr,
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('invite_member'),
    slackUserId: v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9]{1,63}$/)),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('revoke_invitation'),
    invitationId: vid,
    expectedRevision: vr,
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('create_memory_entry'),
    owner: vMemoryOwner,
    entry: v.strictObject({
      slug: v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/)),
      description: vot(2_000),
      type: vMemoryType,
      body: vot(100_000),
    }),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('update_memory_entry'),
    owner: vMemoryOwner,
    entryId: vid,
    expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
    description: vot(2_000),
    type: vMemoryType,
    body: vot(100_000),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('forget_memory_entry'),
    owner: vMemoryOwner,
    entryId: vid,
    expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('save_routine'),
    workspaceId: vid,
    channelId: vid,
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
    channelId: vid,
    routineId: vid,
    expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
    action: v.picklist(['pause', 'resume', 'disable']),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('delete_routine'),
    workspaceId: vid,
    channelId: vid,
    routineId: vid,
    expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
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
export const discoverSlackChannelsValibotSchema = v.strictObject({
  refresh: v.optional(v.boolean()),
});
export const inspectSlackMemberDirectoryValibotSchema = v.strictObject({
  cursor: v.optional(v.pipe(v.string(), v.maxLength(512))),
});
export const testMcpConnectionValibotSchema = v.strictObject({
  agentId: vid,
  connectionId: vid,
});
export const inspectMemoryValibotSchema = vMemoryOwner;
export const inspectRoutinesValibotSchema = v.strictObject({
  workspaceId: vid,
  channelId: v.optional(vid),
  routineId: v.optional(vid),
});
export const exportRecipeValibotSchema = v.strictObject({
  agentIds: v.optional(va(vid, 100)),
});
export const previewRecipeValibotSchema = v.strictObject({
  recipe: v.unknown(),
  agentStrategy: v.optional(v.picklist(['clone', 'update', 'skip'])),
  channelTargets: v.optional(va(v.strictObject({
    symbol: vid,
    workspaceId: vid,
    channelId: vid,
    expectedRevision: vr,
    expectedAgentId: v.nullable(vid),
  }), 100)),
});
