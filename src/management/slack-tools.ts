import {
  type DeliveredMessage,
  useDelivery,
  useTool,
} from '@flue/runtime';

import type { RuntimePlanV2 } from '../agents/runtime-plan.ts';
import {
  getConfigStore,
  getIdentityStore,
  getManagementStore,
  getMemoryStateStore,
  getRoutineStore,
  getSettingsStore,
  getUsageStore,
  getWorkStore,
  isCloudflareTarget,
  type PlatformEnv,
} from '../config/state-backend.ts';
import {
  deleteProviderApiKey,
  describeProviderKeySources,
} from '../config/provider-keys.ts';
import type { IdentityStore } from '../identity/types.ts';
import {
  applyWorkspaceChangesValibotSchema,
  confirmWorkspaceChangeValibotSchema,
  getOperationValibotSchema,
  inspectWorkspaceValibotSchema,
  inspectMemoryValibotSchema,
  inspectRoutinesValibotSchema,
  revokeSetupLinkValibotSchema,
  undoWorkspaceChangeValibotSchema,
} from './schemas.ts';
import { WorkspaceManagementService } from './service.ts';
import { resolveEligibleSlackInvitee } from './slack-directory.ts';
import {
  invokeWorkspaceManagementTool,
  workspaceManagementToolDescription,
  type WorkspaceManagementToolArguments,
  type WorkspaceManagementToolName,
  type WorkspaceManagementToolResult,
} from './tool-adapter.ts';
import {
  ManagementError,
  type ManagementActorContext,
  type ManagementOperation,
} from './types.ts';
import { resolveSlackPublicUrl } from '../slack/credentials.ts';

const SIGNAL_ATTRIBUTE_KEYS = [
  'workspaceId',
  'channelId',
  'threadTs',
  'slackUserId',
  'eventId',
  'messageTs',
  'turnJobId',
] as const;

export interface SlackManagementSignal {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  slackUserId: string;
  eventId: string;
  messageTs: string;
  turnJobId: string;
}

export type PlatformEnvResolver = () => Promise<PlatformEnv | undefined>;

/** Mount requester-bound management tools only for a verified Slack signal. */
export function useWorkspaceManagementSlackTools(
  plan: RuntimePlanV2,
  resolvePlatformEnv: PlatformEnvResolver,
): void {
  const signal = parseSlackManagementSignal(useDelivery(), plan);
  if (!signal) return;

  useTool({
    name: 'inspect_workspace',
    description: workspaceManagementToolDescription('inspect_workspace'),
    input: inspectWorkspaceValibotSchema,
    async run({ data }) {
      return slackToolOutput(await invokeLiveSlackTool(
        signal, resolvePlatformEnv, 'inspect_workspace', data,
      ));
    },
  });
  useTool({
    name: 'inspect_memory',
    description: workspaceManagementToolDescription('inspect_memory'),
    input: inspectMemoryValibotSchema,
    async run({ data }) {
      return slackToolOutput(await invokeLiveSlackTool(
        signal, resolvePlatformEnv, 'inspect_memory', data,
      ));
    },
  });
  useTool({
    name: 'inspect_routines',
    description: workspaceManagementToolDescription('inspect_routines'),
    input: inspectRoutinesValibotSchema,
    async run({ data }) {
      return slackToolOutput(await invokeLiveSlackTool(
        signal, resolvePlatformEnv, 'inspect_routines', data,
      ));
    },
  });
  useTool({
    name: 'revoke_setup_link',
    description: workspaceManagementToolDescription('revoke_setup_link'),
    input: revokeSetupLinkValibotSchema,
    async run({ data }) {
      return slackToolOutput(await invokeLiveSlackTool(
        signal, resolvePlatformEnv, 'revoke_setup_link', data,
      ));
    },
  });
  useTool({
    name: 'apply_workspace_changes',
    description: workspaceManagementToolDescription('apply_workspace_changes'),
    input: applyWorkspaceChangesValibotSchema,
    async run({ data }) {
      return slackToolOutput(await invokeLiveSlackTool(
        signal,
        resolvePlatformEnv,
        'apply_workspace_changes',
        { ...data, operations: data.operations as ManagementOperation[] },
      ));
    },
  });
  useTool({
    name: 'confirm_workspace_change',
    description: workspaceManagementToolDescription('confirm_workspace_change'),
    input: confirmWorkspaceChangeValibotSchema,
    async run({ data }) {
      return slackToolOutput(await invokeLiveSlackTool(
        signal, resolvePlatformEnv, 'confirm_workspace_change', data,
      ));
    },
  });
  useTool({
    name: 'undo_workspace_change',
    description: workspaceManagementToolDescription('undo_workspace_change'),
    input: undoWorkspaceChangeValibotSchema,
    async run({ data }) {
      return slackToolOutput(await invokeLiveSlackTool(
        signal, resolvePlatformEnv, 'undo_workspace_change', data,
      ));
    },
  });
  useTool({
    name: 'get_operation',
    description: workspaceManagementToolDescription('get_operation'),
    input: getOperationValibotSchema,
    async run({ data }) {
      return slackToolOutput(await invokeLiveSlackTool(
        signal, resolvePlatformEnv, 'get_operation', data,
      ));
    },
  });
}

export function parseSlackManagementSignal(
  delivery: DeliveredMessage,
  plan: RuntimePlanV2,
): SlackManagementSignal | undefined {
  if (delivery.kind !== 'signal' || delivery.type !== 'slack.message' ||
      delivery.tagName !== 'slack_message' || !delivery.attributes) return undefined;
  if (Object.keys(delivery.attributes).some((key) =>
    !SIGNAL_ATTRIBUTE_KEYS.includes(key as typeof SIGNAL_ATTRIBUTE_KEYS[number]))) return undefined;
  const values = Object.fromEntries(SIGNAL_ATTRIBUTE_KEYS.map((key) => [
    key,
    boundedAttribute(delivery.attributes?.[key], key, key.endsWith('Ts') ? 80 : 256),
  ])) as unknown as SlackManagementSignal;
  if (Object.values(values).some((value) => !value)) return undefined;
  if (
    values.workspaceId !== plan.conversation.workspaceId ||
    values.channelId !== plan.conversation.channelId ||
    values.threadTs !== plan.conversation.threadTs
  ) return undefined;
  return values;
}

export async function resolveSlackManagementActor(
  signal: SlackManagementSignal,
  identity: Pick<IdentityStore, 'resolveSlackIdentity'>,
): Promise<ManagementActorContext> {
  const resolution = await identity.resolveSlackIdentity(signal.workspaceId, signal.slackUserId);
  if (!resolution || resolution.membership.status !== 'active' ||
      resolution.binding.slackTeamId !== signal.workspaceId ||
      resolution.binding.slackUserId !== signal.slackUserId) {
    throw new ManagementError(
      'forbidden',
      'The Slack requester does not have active Chickpea access.',
    );
  }
  return {
    userId: resolution.user.id,
    membershipId: resolution.membership.id,
    organizationId: resolution.membership.organizationId,
    origin: {
      kind: 'slack',
      workspaceId: signal.workspaceId,
      channelId: signal.channelId,
      threadTs: signal.threadTs,
    },
  };
}

export async function invokeSlackWorkspaceManagementTool<
  TName extends WorkspaceManagementToolName,
>(input: {
  signal: SlackManagementSignal;
  identity: Pick<IdentityStore, 'resolveSlackIdentity'>;
  service: WorkspaceManagementService;
  name: TName;
  args: WorkspaceManagementToolArguments[TName];
}): Promise<WorkspaceManagementToolResult> {
  return invokeWorkspaceManagementTool({
    service: input.service,
    resolveContext: () => resolveSlackManagementActor(input.signal, input.identity),
  }, input.name, input.args);
}

async function invokeLiveSlackTool<TName extends WorkspaceManagementToolName>(
  signal: SlackManagementSignal,
  resolvePlatformEnv: PlatformEnvResolver,
  name: TName,
  args: WorkspaceManagementToolArguments[TName],
): Promise<WorkspaceManagementToolResult> {
  const env = await resolvePlatformEnv();
  const identity = getIdentityStore(env);
  const settings = getSettingsStore(env);
  const service = new WorkspaceManagementService({
    identity,
    config: getConfigStore(env),
    management: getManagementStore(env),
    memory: getMemoryStateStore(env),
    routines: getRoutineStore(env),
    work: getWorkStore(env),
    routineSchedulingAvailable: isCloudflareTarget(),
    setupBaseUrl: () => resolveSlackPublicUrl(env, settings),
    providerCredentialSource: async (providerId) =>
      (await describeProviderKeySources(env, settings))[providerId],
    removeProviderCredential: async (providerId) =>
      (await deleteProviderApiKey(providerId, env, settings, getUsageStore(env))).source,
    resolveSlackInvitee: (slackUserId) =>
      resolveEligibleSlackInvitee(slackUserId, env, identity),
  });
  return invokeSlackWorkspaceManagementTool({ signal, identity, service, name, args });
}

function boundedAttribute(value: string | undefined, _name: string, max: number): string {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : '';
}

function slackToolOutput(result: WorkspaceManagementToolResult): string {
  return JSON.stringify(result);
}
