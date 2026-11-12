import * as v from 'valibot';
import { z } from 'zod';
import { skillImportSourceSchema } from '../config/skill-provenance.ts';

import { AGENT_ID_PATTERN } from '../config/agent-id.ts';
import { CONNECTION_GUIDE_MAX_LENGTH } from '../config/agent-write-rules.ts';
import { MAX_MCP_OAUTH_SCOPE_LENGTH, MAX_MCP_TOOLS } from '../config/mcp-limits.ts';
import { MODEL_EFFORTS } from '../config/model-effort.ts';
import { PROVIDER_KEY_IDS } from '../config/provider-key-ids.ts';
import { MODEL_ROLES } from '../config/types.ts';
import {
  isValidRepositoryGrantShape,
  REPOSITORY_GRANT_SHAPE_MESSAGE,
} from '../config/github-app.ts';
import {
  AGENT_AUTHORING_GUIDE_VERSION,
  AGENT_AUTHORING_REASONS,
} from './agent-authoring/index.ts';

/** One path on a host: a single leading slash, no spaces. */
const CONNECTION_CHECK_PATH_PATTERN = /^\/(?!\/)\S*$/;
const setupCheckPathDescription = 'For a connection that takes a key: the read endpoint you plan to use, inside the connection, such as a list endpoint (for example `.../articles`), never the bare prefix. The setup page checks the key with one GET there.';
/** The longest key the setup page accepts. */
const CONNECTION_KEY_MAX_LENGTH = 16_384;
const repositoryFullNameDescription = 'One repository as "owner/repo", or "" when allRepos is true.';
const repositoryAllReposDescription = 'true grants every repository of accountLogin\'s installation; then fullName must be "" and installationId kept.';
const creationModelDescription = 'Omit to inherit the workspace default. Set only when the requester explicitly selected this model; never invent a model pin.';
const creationModelEffortDescription = 'Set only when the requester chose a reasoning effort for this model.';
const modelEffortDescription = 'Set only when the requester chose a reasoning effort; null clears it. A new model without this clears it.';
const updateRevisionDescription = 'The Agent revision from inspection. 0 targets the Agent a create_agent earlier in this call creates; that create must be in dependsOn.';
const disconnectConnectionIdDescription = 'The connection to disconnect: its id from the Agent\'s connections, mcpServers or apiConnections in inspect_workspace.';
const websiteLoginIdDescription = 'The loginId from the Agent\'s websiteLogins in inspect_workspace.';
const WEBSITE_LOGIN_ID_PATTERN = /^wl_[a-f0-9]{32}$/;
const workspaceModelRoleDescription = 'chat is the Workspace default model; image and coding are the Workspace image and coding models.';
const workspaceModelDescription = 'A model from inspect_workspace modelCatalog: chat models for chat and coding, image models for image. null clears the image or coding model; the chat default cannot be cleared.';
const workspaceModelEffortDescription = 'Chat and coding only, one of the model\'s efforts in modelCatalog. Omit to run the model\'s standard effort.';
const workspaceModelRevisionDescription = 'The role\'s revision from inspect_workspace workspaceModels; 0 when it was never set.';
const agentImageModelDescription = 'An image model from inspect_workspace modelCatalog.image. null follows the Workspace image model.';
const connectionGuideDescription = 'Plain-text notes the Agent that owns this connection reads as a skill: endpoints, request quirks, draft versus live writes, and the scope each action needs. Never a key or token. Omit to remove.';

/** The skill shapes recipes.ts checks a portable recipe's skills against. */
export const zSkillName = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(64);
export const zSkillImportSource = z.strictObject({
  repository: z.string().max(256).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  path: z.string().max(1024).refine((path) => !path.startsWith('/') && !path.split('/').includes('..')),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const vt = (max: number) => v.pipe(v.string(), v.minLength(1), v.maxLength(max));
const vot = (max: number) => v.pipe(v.string(), v.maxLength(max));
const vid = vt(128);
const vAgentId = v.pipe(v.string(), v.regex(AGENT_ID_PATTERN));
const vSkillName = v.pipe(
  v.string(),
  v.maxLength(64),
  v.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);
const vr = v.pipe(v.number(), v.integer(), v.minValue(0));
const vModelEffort = v.picklist(MODEL_EFFORTS);
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
  suggestedSkillId: v.optional(vSkillName),
  importSource: v.optional(skillImportSourceSchema),
});
export const vMcpConnection = v.strictObject({
  id: vid,
  displayName: vt(240),
  url: v.pipe(v.string(), v.url(), v.maxLength(2_000)),
  transport: v.picklist(['streamable-http', 'sse']),
  authMode: v.picklist(['none', 'bearer', 'oauth']),
  headerNames: va(vt(120), 32),
  enabled: v.boolean(),
  toolPolicies: v.optional(v.record(vt(120), v.strictObject({
    effect: v.picklist(['read', 'write']),
    argumentConstraints: v.optional(v.record(vt(120), va(vt(120), 50))),
  }))),
  allowedTools: va(vt(120), MAX_MCP_TOOLS),
  oauthScope: v.optional(vot(MAX_MCP_OAUTH_SCOPE_LENGTH)),
  presetId: v.optional(vid),
  guide: v.pipe(v.optional(vot(CONNECTION_GUIDE_MAX_LENGTH)), v.description(connectionGuideDescription)),
});
export const vApiConnection = v.strictObject({
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
  presetId: v.optional(vid),
  guide: v.pipe(v.optional(vot(CONNECTION_GUIDE_MAX_LENGTH)), v.description(connectionGuideDescription)),
});
const vRepository = v.pipe(
  v.strictObject({
    id: vid,
    installationId: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
    accountLogin: vt(240),
    fullName: v.pipe(vot(500), v.description(repositoryFullNameDescription)),
    allRepos: v.pipe(v.optional(v.boolean()), v.description(repositoryAllReposDescription)),
    enabled: v.boolean(),
  }),
  v.check(
    (grant) => isValidRepositoryGrantShape(grant, { requireInstallation: true }),
    REPOSITORY_GRANT_SHAPE_MESSAGE,
  ),
);
const vAgentFields = {
  name: vt(240),
  description: v.optional(vot(500)),
  requestedHandle: v.optional(vt(120)),
  editPolicy: v.optional(v.picklist(['creator_and_admins', 'all_workspace_members'])),
  instructions: vot(100_000),
  enabled: v.boolean(),
  model: v.pipe(v.optional(vModelSpecifier), v.description(creationModelDescription)),
  modelEffort: v.pipe(v.optional(vModelEffort), v.description(creationModelEffortDescription)),
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
  modelEffort: v.pipe(v.optional(v.nullable(vModelEffort)), v.description(modelEffortDescription)),
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
  v.strictObject({ kind: v.literal('preserve') }),
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
    path: v.optional(v.pipe(
      v.string(),
      v.maxLength(2048),
      v.regex(CONNECTION_CHECK_PATH_PATTERN),
      v.description(setupCheckPathDescription),
    )),
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
    providerId: v.picklist(PROVIDER_KEY_IDS),
  }),
]);

const vCreateAgentOperation = v.strictObject({
  ...vOperationBase,
  kind: v.literal('create_agent'),
  clientRef: v.optional(vid),
  duplicateResolution: v.optional(v.literal('create_distinct')),
  agent: vAgent,
});
const vRequestSetupOperation = v.strictObject({
  ...vOperationBase,
  kind: v.literal('request_setup'),
  target: vSetupTarget,
});
/** Every operation but Agent creation and setup requests, which only apply directly. */
const vProposableOperations = [
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('update_agent'),
    agentId: vAgentId,
    expectedRevision: v.pipe(vr, v.description(updateRevisionDescription)),
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
    kind: v.literal('disconnect_connection'),
    agentId: vAgentId,
    connectionId: v.pipe(vid, v.description(disconnectConnectionIdDescription)),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('remove_website_login'),
    agentId: vAgentId,
    loginId: v.pipe(v.string(), v.regex(WEBSITE_LOGIN_ID_PATTERN), v.description(websiteLoginIdDescription)),
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
    providerId: v.picklist(PROVIDER_KEY_IDS),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('set_workspace_model'),
    role: v.pipe(v.picklist(MODEL_ROLES), v.description(workspaceModelRoleDescription)),
    model: v.pipe(v.nullable(vModelSpecifier), v.description(workspaceModelDescription)),
    modelEffort: v.pipe(v.optional(vModelEffort), v.description(workspaceModelEffortDescription)),
    expectedRevision: v.pipe(vr, v.description(workspaceModelRevisionDescription)),
  }),
  v.strictObject({
    ...vOperationBase,
    kind: v.literal('set_agent_image_model'),
    agentId: vAgentId,
    expectedRevision: v.pipe(vr, v.description('The Agent revision from inspection.')),
    model: v.pipe(v.nullable(vModelSpecifier), v.description(agentImageModelDescription)),
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
    requiredConnectionAccountIds: v.optional(v.pipe(v.array(vid), v.maxLength(100))),
    agentId: vAgentId,
    workspaceId: vid,
    channelId: v.optional(vid),
    destination: v.optional(v.strictObject({ kind: v.picklist(['current_dm_thread', 'current_channel_thread']) })),
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
    requiredConnectionAccountIds: v.optional(v.pipe(v.array(vid), v.maxLength(100))),
    workspaceId: vid,
    routineId: vid,
    expectedVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
    agentId: vAgentId,
  }),
] as const;

export const managementOperationValibotSchema = v.variant('kind', [
  vCreateAgentOperation,
  ...vProposableOperations,
  vRequestSetupOperation,
]);
/** The service refuses a proposal that creates an Agent or requests setup, so the schema offers neither. */
export const proposableManagementOperationValibotSchema = v.variant('kind', vProposableOperations);

export const applyWorkspaceChangesValibotSchema = v.strictObject({
  idempotencyKey: vt(256),
  operations: v.pipe(v.array(managementOperationValibotSchema), v.minLength(1), v.maxLength(25)),
});
/** Slack-only presentation hints. They are stripped before shared service invocation. */
export const slackApplyWorkspaceChangesValibotSchema = v.strictObject({
  idempotencyKey: vt(256),
  operations: v.pipe(v.array(managementOperationValibotSchema), v.minLength(1), v.maxLength(25)),
  connectorMentions: v.optional(v.pipe(v.array(vt(128)), v.maxLength(12))),
});
export const proposeWorkspaceChangesValibotSchema = v.strictObject({
  idempotencyKey: vt(256),
  guideVersion: v.literal(AGENT_AUTHORING_GUIDE_VERSION),
  authoringReason: v.picklist(AGENT_AUTHORING_REASONS),
  operations: v.pipe(v.array(proposableManagementOperationValibotSchema), v.minLength(1), v.maxLength(25)),
});
export const proposeSkillImportValibotSchema = v.strictObject({
  agentId: v.optional(vAgentId),
  source: vt(2_000),
  skillName: v.optional(vSkillName),
  idempotencyKey: vt(256),
  guideVersion: v.literal(AGENT_AUTHORING_GUIDE_VERSION),
});
export const importSkillValibotSchema = v.strictObject({
  agentId: v.optional(vAgentId),
  source: vt(2_000),
  skillName: v.optional(vSkillName),
  replaceExisting: v.optional(v.boolean()),
  idempotencyKey: vt(256),
  guideVersion: v.literal(AGENT_AUTHORING_GUIDE_VERSION),
});
/** Slack's door names no files and carries no content: the service reads the message's own attachments. */
export const slackUploadSkillsValibotSchema = v.strictObject({
  agentId: v.optional(v.pipe(vAgentId, v.description('Only for another Agent the person names. Omit to install on this Agent.'))),
});
export const manageAgentSkillValibotSchema = v.strictObject({
  agentId: v.optional(vAgentId),
  action: v.picklist(['enable', 'disable', 'remove']),
  skillName: vSkillName,
  idempotencyKey: vt(256),
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
export const discoverSlackChannelsValibotSchema = v.strictObject({});
export const testConnectionValibotSchema = v.strictObject({
  agentId: vAgentId,
  connectionId: vid,
  path: v.optional(v.pipe(v.string(), v.maxLength(2048), v.regex(CONNECTION_CHECK_PATH_PATTERN))),
});
export const saveConnectionKeyValibotSchema = v.strictObject({
  agentId: v.optional(vAgentId),
  connectionId: vid,
  key: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(CONNECTION_KEY_MAX_LENGTH),
    v.description('The key exactly as the requester typed it in their own current message.'),
  ),
  path: v.pipe(v.string(), v.maxLength(2048), v.regex(CONNECTION_CHECK_PATH_PATTERN)),
  authShape: v.optional(v.picklist(['header', 'basic_username'])),
});
export const tryConnectionValibotSchema = v.strictObject({
  agentId: v.optional(vAgentId),
  draft: v.optional(v.strictObject({
    allowedHosts: v.pipe(v.array(vt(253)), v.minLength(1), v.maxLength(10)),
    pathPrefixes: va(vt(512), 10),
    headerName: vt(128),
    headerValuePrefix: v.optional(vot(120)),
    authShape: v.optional(v.picklist(['header', 'basic_username'])),
  })),
  connectionId: v.optional(vid),
  key: v.optional(v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(CONNECTION_KEY_MAX_LENGTH),
    v.description('The key exactly as the requester typed it. Omit it to try a connection\'s saved key.'),
  )),
  path: v.pipe(v.string(), v.maxLength(2048), v.regex(CONNECTION_CHECK_PATH_PATTERN)),
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
