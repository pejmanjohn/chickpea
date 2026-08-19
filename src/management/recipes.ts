import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { ConfigStore } from '../config/store.ts';
import type {
  ApiConnectionConfig,
  CustomAgentConfig,
  McpConnectionConfig,
  RepositoryGrant,
  SkillConfig,
} from '../config/types.ts';
import {
  hasCredentialLikeContent,
  hasDisallowedControlCharacter,
} from '../security/content-validation.ts';
import { canonicalJson } from './contracts.ts';
import { ManagementError, type ManagementOperation } from './types.ts';

export const WORKSPACE_RECIPE_SCHEMA_VERSION = 1 as const;

const recipeText = (max: number) => z.string().min(1).max(max);
const recipeOptionalText = (max: number) => z.string().max(max);
const recipeId = recipeText(128);
const recipeSkillSchema = z.strictObject({
  name: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: recipeOptionalText(2_000),
  instructions: recipeOptionalText(100_000),
  enabled: z.boolean(),
});
const recipeMcpRequirementSchema = z.strictObject({
  id: recipeId,
  displayName: recipeText(240),
  url: z.url().max(2_000),
  transport: z.enum(['streamable-http', 'sse']),
  authMode: z.enum(['none', 'bearer', 'oauth']),
  headerNames: z.array(recipeText(120)).max(32),
  enabled: z.boolean(),
  allowedTools: z.array(recipeText(120)).max(500),
  oauthScope: recipeOptionalText(2_000).optional(),
  presetId: recipeId.optional(),
});
const recipeApiRequirementSchema = z.strictObject({
  id: recipeId,
  displayName: recipeText(240),
  allowedHosts: z.array(recipeText(253)).max(100),
  pathPrefixes: z.array(recipeText(2_000)).max(100),
  headerName: recipeText(120),
  headerValuePrefix: recipeOptionalText(120).optional(),
  allowedMethods: z.array(recipeText(20)).max(20),
  enabled: z.boolean(),
  authMode: z.enum(['credential', 'oauth']).optional(),
  oauthProvider: z.literal('google').optional(),
  oauthScopes: z.array(recipeText(500)).max(100).optional(),
  oauthAppType: z.enum(['workspace-internal', 'external']).optional(),
  presetId: recipeId.optional(),
});
const recipeRepositoryRequirementSchema = z.strictObject({
  id: recipeId,
  fullName: recipeText(500).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  enabled: z.boolean(),
});
const workspaceRecipeSchema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_RECIPE_SCHEMA_VERSION),
  name: recipeText(240),
  agents: z.array(z.strictObject({
    symbol: recipeId.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
    name: recipeText(240),
    instructions: recipeOptionalText(100_000),
    enabled: z.boolean(),
    model: recipeText(500).optional(),
    skills: z.array(recipeSkillSchema).max(100),
    mcpRequirements: z.array(recipeMcpRequirementSchema).max(50),
    apiRequirements: z.array(recipeApiRequirementSchema).max(50),
    repositoryRequirements: z.array(recipeRepositoryRequirementSchema).max(100),
  })).min(1).max(100),
  channels: z.array(z.strictObject({
    symbol: recipeId.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
    label: recipeOptionalText(240).optional(),
    additionalInstructions: recipeOptionalText(100_000).optional(),
    participationMode: z.enum(['ambient', 'mention_only']),
    agentSymbol: recipeId.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
  })).max(100),
});

export interface WorkspaceRecipe {
  schemaVersion: 1;
  name: string;
  agents: WorkspaceRecipeAgent[];
  channels: WorkspaceRecipeChannel[];
}

export interface WorkspaceRecipeAgent {
  symbol: string;
  name: string;
  instructions: string;
  enabled: boolean;
  model?: string;
  skills: SkillConfig[];
  mcpRequirements: Array<Omit<
    McpConnectionConfig,
    'lifecycleStatus' | 'statusText' | 'discoveredTools' | 'lastCheckedAt' | 'identity'
  >>;
  apiRequirements: Array<Omit<
    ApiConnectionConfig,
    'lifecycleStatus' | 'statusText' | 'identity'
  >>;
  repositoryRequirements: Array<Pick<RepositoryGrant, 'id' | 'fullName' | 'enabled'>>;
}

export interface WorkspaceRecipeChannel {
  symbol: string;
  label?: string;
  additionalInstructions?: string;
  participationMode: 'ambient' | 'mention_only';
  agentSymbol: string;
}

export interface RecipeChannelTarget {
  symbol: string;
  workspaceId: string;
  channelId: string;
  expectedRevision: number;
  expectedAgentId: string | null;
}

export interface PreviewWorkspaceRecipeInput {
  recipe: unknown;
  agentStrategy?: 'clone' | 'update' | 'skip' | undefined;
  channelTargets?: RecipeChannelTarget[] | undefined;
}

export interface WorkspaceRecipePreview {
  recipeDigest: string;
  agents: Array<{
    symbol: string;
    status: 'create' | 'conflict' | 'ambiguous' | 'clone' | 'update' | 'skip';
    existingAgentId?: string;
    proposedAgentId?: string;
    choices?: Array<'clone' | 'update' | 'skip'>;
    setupRequired: string[];
    unavailable: string[];
  }>;
  channels: Array<{
    symbol: string;
    status: 'target_required' | 'ready';
    target?: RecipeChannelTarget;
  }>;
  operations: ManagementOperation[];
}

export async function exportWorkspaceRecipe(
  config: Pick<ConfigStore, 'listAgents' | 'listChannels' | 'listAssignments'>,
  input: { agentIds?: string[] | undefined },
): Promise<WorkspaceRecipe> {
  const [allAgents, channels, assignments] = await Promise.all([
    config.listAgents(),
    config.listChannels(),
    config.listAssignments(),
  ]);
  const selected = input.agentIds?.length
    ? allAgents.filter(({ id }) => input.agentIds!.includes(id))
    : allAgents;
  if (input.agentIds?.some((id) => !selected.some((agent) => agent.id === id))) {
    throw new ManagementError('invalid_request', 'One or more recipe Agents were not found.');
  }
  const symbols = new Map(selected.map((agent, index) => [agent.id, `agent_${index + 1}`]));
  const assignmentsByChannel = new Map(assignments.map((assignment) => [
    `${assignment.workspaceId}:${assignment.channelId}`,
    assignment,
  ]));
  const recipe: WorkspaceRecipe = {
    schemaVersion: WORKSPACE_RECIPE_SCHEMA_VERSION,
    name: selected.length === 1 ? selected[0]!.name : 'Chickpea workspace recipe',
    agents: selected.map((agent, index) => exportAgent(agent, `agent_${index + 1}`)),
    channels: channels.flatMap((channel, index) => {
      const assignment = assignmentsByChannel.get(`${channel.workspaceId}:${channel.channelId}`);
      const agentSymbol = assignment ? symbols.get(assignment.agentId) : undefined;
      if (!agentSymbol) return [];
      return [{
        symbol: `channel_${index + 1}`,
        ...(channel.label ? { label: channel.label } : {}),
        ...(channel.additionalInstructions
          ? { additionalInstructions: channel.additionalInstructions }
          : {}),
        participationMode: channel.participationMode,
        agentSymbol,
      }];
    }),
  };
  assertRecipeSafe(recipe);
  return recipe;
}

export async function previewWorkspaceRecipe(
  config: Pick<ConfigStore, 'listAgents'>,
  providerSource: (providerId: 'anthropic' | 'openai' | 'openrouter') => Promise<'env' | 'stored' | 'missing'>,
  input: PreviewWorkspaceRecipeInput,
): Promise<WorkspaceRecipePreview> {
  const recipe = parseWorkspaceRecipe(input.recipe);
  const digest = createHash('sha256').update(canonicalJson(recipe)).digest('hex');
  const currentAgents = await config.listAgents();
  const targetEntries = input.channelTargets ?? [];
  const targets = new Map(targetEntries.map((target) => [target.symbol, target]));
  if (targets.size !== targetEntries.length) {
    throw new ManagementError('invalid_request', 'Channel targets must use unique symbols.');
  }
  const strategy = input.agentStrategy;
  const operations: ManagementOperation[] = [];
  const allocatedAgentIds = new Set(currentAgents.map(({ id }) => id));
  const resolvedAgents = new Map<string, {
    agentId?: string;
    clientRef?: string;
    dependencyItemId?: string;
  }>();
  const agentPreviews: WorkspaceRecipePreview['agents'] = [];

  for (const recipeAgent of recipe.agents) {
    const matches = currentAgents.filter(({ name }) => name === recipeAgent.name);
    const availability = await recipeAvailability(recipeAgent, currentAgents, providerSource);
    if (matches.length === 0) {
      const proposedAgentId = allocatePortableAgentId(recipeAgent, digest, allocatedAgentIds);
      const clientRef = `recipe_${recipeAgent.symbol}`;
      operations.push({
        itemId: `create_${recipeAgent.symbol}`,
        kind: 'create_agent',
        clientRef,
        agent: materializeAgent(recipeAgent, proposedAgentId),
      });
      appendSetupOperations(operations, recipeAgent, { agentClientRef: clientRef });
      appendProviderSetupOperation(operations, recipeAgent, availability);
      resolvedAgents.set(recipeAgent.symbol, {
        clientRef,
        dependencyItemId: `create_${recipeAgent.symbol}`,
      });
      agentPreviews.push({
        symbol: recipeAgent.symbol,
        status: 'create',
        proposedAgentId,
        ...availability,
      });
      continue;
    }
    const existing = matches[0]!;
    if (matches.length > 1) {
      agentPreviews.push({
        symbol: recipeAgent.symbol,
        status: 'ambiguous',
        setupRequired: availability.setupRequired,
        unavailable: [...availability.unavailable, 'Multiple Agents have this name.'],
      });
      continue;
    }
    if (!strategy) {
      agentPreviews.push({
        symbol: recipeAgent.symbol,
        status: 'conflict',
        existingAgentId: existing.id,
        choices: ['clone', 'update', 'skip'],
        ...availability,
      });
      continue;
    }
    if (strategy === 'skip') {
      resolvedAgents.set(recipeAgent.symbol, { agentId: existing.id });
      agentPreviews.push({
        symbol: recipeAgent.symbol,
        status: 'skip',
        existingAgentId: existing.id,
        ...availability,
      });
      continue;
    }
    if (strategy === 'clone') {
      const proposedAgentId = allocatePortableAgentId(
        recipeAgent,
        `${digest}:clone`,
        allocatedAgentIds,
      );
      const clientRef = `recipe_${recipeAgent.symbol}`;
      operations.push({
        itemId: `clone_${recipeAgent.symbol}`,
        kind: 'create_agent',
        clientRef,
        agent: materializeAgent(recipeAgent, proposedAgentId, `${recipeAgent.name} copy`),
      });
      appendSetupOperations(operations, recipeAgent, { agentClientRef: clientRef });
      appendProviderSetupOperation(operations, recipeAgent, availability);
      resolvedAgents.set(recipeAgent.symbol, {
        clientRef,
        dependencyItemId: `clone_${recipeAgent.symbol}`,
      });
      agentPreviews.push({
        symbol: recipeAgent.symbol,
        status: 'clone',
        existingAgentId: existing.id,
        proposedAgentId,
        ...availability,
      });
      continue;
    }
    operations.push({
      itemId: `update_${recipeAgent.symbol}`,
      kind: 'update_agent',
      agentId: existing.id,
      expectedRevision: existing.revision,
      confirmationReason: 'recipe_overwrite',
      patch: materializeAgentPatch(recipeAgent),
    });
    appendSetupOperations(operations, recipeAgent, { agentId: existing.id });
    appendProviderSetupOperation(operations, recipeAgent, availability);
    resolvedAgents.set(recipeAgent.symbol, {
      agentId: existing.id,
      dependencyItemId: `update_${recipeAgent.symbol}`,
    });
    agentPreviews.push({
      symbol: recipeAgent.symbol,
      status: 'update',
      existingAgentId: existing.id,
      ...availability,
    });
  }

  const channelPreviews = recipe.channels.map((channel) => {
    const target = targets.get(channel.symbol);
    const agent = resolvedAgents.get(channel.agentSymbol);
    if (!target || !agent) return { symbol: channel.symbol, status: 'target_required' as const };
    const putItemId = `channel_${channel.symbol}`;
    operations.push({
      itemId: putItemId,
      kind: 'put_channel',
      channel: {
        workspaceId: target.workspaceId,
        channelId: target.channelId,
        ...(channel.label ? { label: channel.label } : {}),
        ...(channel.additionalInstructions
          ? { additionalInstructions: channel.additionalInstructions }
          : {}),
        participationMode: channel.participationMode,
        lifecycle: 'active',
      },
      expectedRevision: target.expectedRevision,
    });
    operations.push({
      itemId: `place_${channel.symbol}`,
      dependsOn: [putItemId, ...(agent.dependencyItemId ? [agent.dependencyItemId] : [])],
      kind: 'place_agent',
      workspaceId: target.workspaceId,
      channelId: target.channelId,
      expectedRevision: target.expectedRevision + 1,
      expectedAgentId: target.expectedAgentId,
      ...(agent.clientRef ? { agentClientRef: agent.clientRef } : { agentId: agent.agentId! }),
    });
    return { symbol: channel.symbol, status: 'ready' as const, target };
  });

  if (operations.length > 25) {
    throw new ManagementError(
      'invalid_request',
      'The recipe compiles to more than 25 operations. Split it into smaller recipes.',
    );
  }
  return { recipeDigest: digest, agents: agentPreviews, channels: channelPreviews, operations };
}

function appendProviderSetupOperation(
  operations: ManagementOperation[],
  recipe: WorkspaceRecipeAgent,
  availability: { setupRequired: string[] },
): void {
  const provider = recipe.model?.split('/', 1)[0];
  if (!provider || !['anthropic', 'openai', 'openrouter'].includes(provider) ||
      !availability.setupRequired.includes(`${provider} model provider`)) return;
  operations.push({
    itemId: `setup_${recipe.symbol}_provider_${provider}`,
    kind: 'request_setup',
    target: {
      kind: 'provider_credential',
      providerId: provider as 'anthropic' | 'openai' | 'openrouter',
    },
  });
}

function exportAgent(agent: CustomAgentConfig, symbol: string): WorkspaceRecipeAgent {
  return {
    symbol,
    name: agent.name,
    instructions: agent.instructions,
    enabled: agent.enabled,
    ...(agent.model ? { model: agent.model } : {}),
    skills: agent.skills.map((skill) => ({ ...skill })),
    mcpRequirements: agent.mcpServers.map((connection) => ({
      id: connection.id,
      displayName: connection.displayName,
      url: connection.url,
      transport: connection.transport,
      authMode: connection.authMode,
      headerNames: [...connection.headerNames],
      enabled: connection.enabled,
      allowedTools: [...connection.allowedTools],
      ...(connection.oauthScope ? { oauthScope: connection.oauthScope } : {}),
      ...(connection.presetId ? { presetId: connection.presetId } : {}),
    })),
    apiRequirements: agent.apiConnections.map((connection) => ({
      id: connection.id,
      displayName: connection.displayName,
      allowedHosts: [...connection.allowedHosts],
      pathPrefixes: [...connection.pathPrefixes],
      headerName: connection.headerName,
      ...(connection.headerValuePrefix
        ? { headerValuePrefix: connection.headerValuePrefix }
        : {}),
      allowedMethods: [...connection.allowedMethods],
      enabled: connection.enabled,
      ...(connection.authMode ? { authMode: connection.authMode } : {}),
      ...(connection.oauthProvider ? { oauthProvider: connection.oauthProvider } : {}),
      ...(connection.oauthScopes ? { oauthScopes: [...connection.oauthScopes] } : {}),
      ...(connection.oauthAppType ? { oauthAppType: connection.oauthAppType } : {}),
      ...(connection.presetId ? { presetId: connection.presetId } : {}),
    })),
    repositoryRequirements: agent.repositories.map(({ id, fullName, enabled }) => ({
      id,
      fullName,
      enabled,
    })),
  };
}

function materializeAgent(
  recipe: WorkspaceRecipeAgent,
  id: string,
  name = recipe.name,
) {
  return { id, name, ...materializeAgentPatch(recipe) };
}

function materializeAgentPatch(recipe: WorkspaceRecipeAgent) {
  return {
    instructions: recipe.instructions,
    enabled: recipe.enabled,
    ...(recipe.model ? { model: recipe.model } : {}),
    skills: recipe.skills.map((skill) => ({ ...skill })),
    mcpServers: recipe.mcpRequirements.map((connection) => ({
      ...connection,
      lifecycleStatus: connection.authMode === 'none' ? 'ready' as const : 'pending' as const,
      statusText: connection.authMode === 'none' ? 'Ready' : 'Setup required',
      discoveredTools: connection.allowedTools.map((name) => ({ name })),
    })),
    apiConnections: recipe.apiRequirements.map((connection) => ({
      ...connection,
      lifecycleStatus: 'pending' as const,
      statusText: 'Setup required',
    })),
    repositories: recipe.repositoryRequirements.map((repository) => ({
      ...repository,
      installationId: null,
      accountLogin: 'unconnected',
    })),
  };
}

function appendSetupOperations(
  operations: ManagementOperation[],
  recipe: WorkspaceRecipeAgent,
  agent: { agentId?: string; agentClientRef?: string },
): void {
  const dependency = operations[operations.length - 1]?.itemId;
  for (const connection of recipe.mcpRequirements) {
    if (connection.authMode === 'none') continue;
    operations.push({
      itemId: `setup_${recipe.symbol}_mcp_${connection.id}`,
      ...(dependency ? { dependsOn: [dependency] } : {}),
      kind: 'request_setup',
      target: { kind: 'mcp_connection', ...agent, connectionId: connection.id },
    });
  }
  for (const connection of recipe.apiRequirements) {
    operations.push({
      itemId: `setup_${recipe.symbol}_api_${connection.id}`,
      ...(dependency ? { dependsOn: [dependency] } : {}),
      kind: 'request_setup',
      target: { kind: 'api_connection', ...agent, connectionId: connection.id },
    });
  }
  for (const repository of recipe.repositoryRequirements) {
    operations.push({
      itemId: `setup_${recipe.symbol}_repo_${repository.id}`,
      ...(dependency ? { dependsOn: [dependency] } : {}),
      kind: 'request_setup',
      target: { kind: 'repository_access', ...agent, repositoryId: repository.id },
    });
  }
}

async function recipeAvailability(
  recipe: WorkspaceRecipeAgent,
  current: CustomAgentConfig[],
  providerSource: (providerId: 'anthropic' | 'openai' | 'openrouter') => Promise<'env' | 'stored' | 'missing'>,
): Promise<{ setupRequired: string[]; unavailable: string[] }> {
  const setupRequired = [
    ...recipe.mcpRequirements.filter(({ authMode }) => authMode !== 'none')
      .map(({ displayName }) => displayName),
    ...recipe.apiRequirements.map(({ displayName }) => displayName),
    ...recipe.repositoryRequirements.map(({ fullName }) => fullName),
  ];
  const unavailable: string[] = [];
  const provider = recipe.model?.split('/', 1)[0];
  if (provider && ['anthropic', 'openai', 'openrouter'].includes(provider) &&
      await providerSource(provider as 'anthropic' | 'openai' | 'openrouter') === 'missing') {
    setupRequired.push(`${provider} model provider`);
  }
  for (const repository of recipe.repositoryRequirements) {
    if (current.some((agent) => agent.repositories.some((candidate) =>
      candidate.fullName === repository.fullName && candidate.installationId && candidate.enabled))) {
      const index = setupRequired.indexOf(repository.fullName);
      if (index >= 0) setupRequired.splice(index, 1);
    }
  }
  return { setupRequired: [...new Set(setupRequired)], unavailable };
}

function parseWorkspaceRecipe(value: unknown): WorkspaceRecipe {
  const parsed = workspaceRecipeSchema.safeParse(value);
  if (!parsed.success) {
    throw new ManagementError('invalid_request', 'The workspace recipe is invalid.');
  }
  const recipe = parsed.data as WorkspaceRecipe;
  const agentSymbols = new Set<string>();
  for (const agent of recipe.agents) {
    if (agentSymbols.has(agent.symbol)) {
      throw new ManagementError('invalid_request', 'The workspace recipe Agent is invalid.');
    }
    if (agent.model && !/^(?:anthropic|openai|openrouter|cloudflare|cloudflare-workers-ai)\/.+/.test(agent.model)) {
      throw new ManagementError('invalid_request', 'The workspace recipe model is unsupported.');
    }
    agentSymbols.add(agent.symbol);
  }
  const channelSymbols = new Set<string>();
  for (const channel of recipe.channels) {
    if (channelSymbols.has(channel.symbol) || !agentSymbols.has(channel.agentSymbol)) {
      throw new ManagementError('invalid_request', 'The workspace recipe Channel is invalid.');
    }
    channelSymbols.add(channel.symbol);
  }
  assertRecipeSafe(recipe);
  return structuredClone(recipe);
}

function assertRecipeSafe(recipe: WorkspaceRecipe): void {
  const serialized = canonicalJson(recipe);
  if (Buffer.byteLength(serialized, 'utf8') > 512 * 1024 ||
      hasDisallowedControlCharacter(serialized) || hasCredentialLikeContent(serialized) ||
      /(?:accountName|botUserId|installationId|slackUserId|teamId|credentialProvenance)/i.test(serialized) ||
      containsForbiddenRecipeKey(recipe) || recipeContainsUnsafeUrl(recipe)) {
    throw new ManagementError('invalid_request', 'The recipe contains non-portable or sensitive data.');
  }
}

function recipeContainsUnsafeUrl(recipe: WorkspaceRecipe): boolean {
  return recipe.agents.some((agent) => agent.mcpRequirements.some(({ url }) => {
    try {
      const parsed = new URL(url);
      return parsed.username !== '' || parsed.password !== '' ||
        parsed.search !== '' || parsed.hash !== '';
    } catch {
      return true;
    }
  }));
}

function containsForbiddenRecipeKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenRecipeKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, member]) => {
    const normalized = key.replaceAll(/[^A-Za-z0-9]/g, '').toLowerCase();
    return [
      'apikey', 'authorization', 'bearertoken', 'clientsecret', 'credential',
      'oauthcode', 'password', 'privatekey', 'refreshtoken', 'secret', 'token',
    ].includes(normalized) || containsForbiddenRecipeKey(member);
  });
}

function portableAgentId(agent: WorkspaceRecipeAgent, seed: string): string {
  const slug = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'agent';
  return `agent_${slug}_${createHash('sha256').update(`${seed}:${agent.symbol}`).digest('hex').slice(0, 8)}`;
}

function allocatePortableAgentId(
  agent: WorkspaceRecipeAgent,
  seed: string,
  allocated: Set<string>,
): string {
  let attempt = 0;
  let candidate = portableAgentId(agent, seed);
  while (allocated.has(candidate)) {
    attempt += 1;
    candidate = portableAgentId(agent, `${seed}:${attempt}`);
  }
  allocated.add(candidate);
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
