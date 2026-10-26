import { createHash } from 'node:crypto';
import { z } from 'zod';

import { GITHUB_OWNER_PATTERN } from '../config/github-app.ts';
import { MODEL_EFFORTS } from '../config/model-effort.ts';
import { PLATFORM_NOT_OFFERED_TEXT, type ModelReadiness } from '../config/model-readiness.ts';
import type { ConfigStore } from '../config/store.ts';
import type { CustomAgentConfig, RepositoryGrant, SkillConfig } from '../config/types.ts';
import {
  hasCredentialLikeContent,
  hasDisallowedControlCharacter,
  isRecord,
} from '../security/content-validation.ts';
import { apiConnectionsAfterWrite, mcpConnectionsAfterWrite } from './agent-connections.ts';
import { canonicalJson } from './contracts.ts';
import { zSkillImportSource, zSkillName } from './schemas.ts';
import {
  ManagementError,
  type ManagementAgentCreateInput,
  type ManagementAgentPatch,
  type ManagementOperation,
} from './types.ts';

const WORKSPACE_RECIPE_SCHEMA_VERSION = 2 as const;

const recipeText = (max: number) => z.string().min(1).max(max);
const recipeOptionalText = (max: number) => z.string().max(max);
const recipeId = recipeText(128);
const recipeSkillSchema = z.strictObject({
  name: zSkillName,
  description: recipeOptionalText(2_000),
  instructions: recipeOptionalText(100_000),
  enabled: z.boolean(),
  suggestedSkillId: zSkillName.exactOptional(),
  importSource: zSkillImportSource.exactOptional(),
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
  oauthScope: recipeOptionalText(2_000).exactOptional(),
  presetId: recipeId.exactOptional(),
});
const recipeApiRequirementSchema = z.strictObject({
  id: recipeId,
  displayName: recipeText(240),
  allowedHosts: z.array(recipeText(253)).max(100),
  pathPrefixes: z.array(recipeText(2_000)).max(100),
  headerName: recipeText(120),
  headerValuePrefix: recipeOptionalText(120).exactOptional(),
  allowedMethods: z.array(recipeText(20)).max(20),
  enabled: z.boolean(),
  authMode: z.enum(['credential', 'oauth']).exactOptional(),
  oauthProvider: z.literal('google').exactOptional(),
  oauthScopes: z.array(recipeText(500)).max(100).exactOptional(),
  oauthAppType: z.enum(['workspace-internal', 'external']).exactOptional(),
  presetId: recipeId.exactOptional(),
});
const recipeRepositoryRequirementSchema = z.union([
  z.strictObject({
    id: recipeId,
    fullName: recipeText(500).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    enabled: z.boolean(),
  }),
  // Every repository of one GitHub account; a recipe never carries the installation.
  z.strictObject({
    id: recipeId,
    owner: z.string().regex(GITHUB_OWNER_PATTERN),
    allRepos: z.literal(true),
    enabled: z.boolean(),
  }),
]);
const workspaceRecipeSchema = z.strictObject({
  // Version 2 added description, editPolicy, modelEffort, skill provenance, and
  // all-repositories grants. A version 1 recipe is a valid version 2 recipe.
  schemaVersion: z.literal([1, WORKSPACE_RECIPE_SCHEMA_VERSION]),
  name: recipeText(240),
  agents: z.array(z.strictObject({
    symbol: recipeId.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
    name: recipeText(240),
    description: recipeOptionalText(500).exactOptional(),
    editPolicy: z.enum(['creator_and_admins', 'all_workspace_members']).exactOptional(),
    instructions: recipeOptionalText(100_000),
    enabled: z.boolean(),
    model: recipeText(500).exactOptional(),
    modelEffort: z.enum(MODEL_EFFORTS).exactOptional(),
    skills: z.array(recipeSkillSchema).max(100),
    mcpRequirements: z.array(recipeMcpRequirementSchema).max(50),
    apiRequirements: z.array(recipeApiRequirementSchema).max(50),
    repositoryRequirements: z.array(recipeRepositoryRequirementSchema).max(100),
  })).min(1).max(100),
});

export type WorkspaceRecipe = z.infer<typeof workspaceRecipeSchema>;
type WorkspaceRecipeAgent = WorkspaceRecipe['agents'][number];
type RepositoryRequirement = WorkspaceRecipeAgent['repositoryRequirements'][number];

export interface PreviewWorkspaceRecipeInput {
  recipe: unknown;
  agentStrategy?: 'clone' | 'update' | 'skip' | undefined;
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
  operations: ManagementOperation[];
}

/** Where one recipe Agent lands: a new Agent, or a choice about the one Agent with its name. */
type RecipePlacement =
  | { kind: 'create' | 'ambiguous' }
  | { kind: 'conflict' | 'clone' | 'update' | 'skip'; match: CustomAgentConfig };

type SetupTarget =
  | { kind: 'mcp_connection'; connectionId: string }
  | { kind: 'api_connection'; connectionId: string }
  | { kind: 'repository_access'; repositoryId: string };

/** What one recipe Agent becomes in this workspace, before it is placed as create, clone, or update. */
interface CompiledRecipeAgent {
  capabilities: Required<Pick<ManagementAgentPatch, 'mcpServers' | 'apiConnections' | 'repositories'>>;
  setups: SetupTarget[];
  setupRequired: string[];
  unavailable: string[];
}

export async function exportWorkspaceRecipe(
  config: Pick<ConfigStore, 'listUserAgents'>,
  input: { agentIds?: string[] | undefined },
): Promise<WorkspaceRecipe> {
  const allAgents = await config.listUserAgents();
  const selected = input.agentIds?.length
    ? allAgents.filter(({ id }) => input.agentIds!.includes(id))
    : allAgents;
  if (input.agentIds?.some((id) => !selected.some((agent) => agent.id === id))) {
    throw new ManagementError('invalid_request', 'One or more recipe Agents were not found.');
  }
  return parseWorkspaceRecipe({
    schemaVersion: WORKSPACE_RECIPE_SCHEMA_VERSION,
    name: selected.length === 1 ? selected[0]!.name : 'Chickpea workspace recipe',
    agents: selected.map((agent, index) => exportAgent(agent, `agent_${index + 1}`)),
  } satisfies WorkspaceRecipe);
}

export async function previewWorkspaceRecipe(
  config: Pick<ConfigStore, 'listUserAgents'>,
  readiness: ModelReadiness,
  input: PreviewWorkspaceRecipeInput,
): Promise<WorkspaceRecipePreview> {
  const recipe = parseWorkspaceRecipe(input.recipe);
  const digest = createHash('sha256').update(canonicalJson(recipe)).digest('hex');
  const currentAgents = await config.listUserAgents();
  const strategy = input.agentStrategy;
  const operations: ManagementOperation[] = [];
  const allocatedAgentIds = new Set(currentAgents.map(({ id }) => id));
  const agentPreviews: WorkspaceRecipePreview['agents'] = [];

  for (const recipeAgent of recipe.agents) {
    const matches = currentAgents.filter(({ name }) => name === recipeAgent.name);
    const placement: RecipePlacement = matches.length > 1
      ? { kind: 'ambiguous' }
      : matches[0] ? { kind: strategy ?? 'conflict', match: matches[0] } : { kind: 'create' };
    const compiled = await compileRecipeAgent(
      recipeAgent,
      placement.kind === 'update' ? placement.match : undefined,
      readiness,
    );
    const preview = {
      symbol: recipeAgent.symbol,
      ...('match' in placement ? { existingAgentId: placement.match.id } : {}),
      setupRequired: compiled.setupRequired,
      unavailable: compiled.unavailable,
    };
    switch (placement.kind) {
      case 'ambiguous':
        agentPreviews.push({
          ...preview,
          status: 'ambiguous',
          unavailable: [...preview.unavailable, 'Multiple Agents have this name.'],
        });
        break;
      case 'conflict':
        agentPreviews.push({ ...preview, status: 'conflict', choices: ['clone', 'update', 'skip'] });
        break;
      case 'skip':
        agentPreviews.push({ ...preview, status: 'skip' });
        break;
      case 'create':
      case 'clone': {
        const proposedAgentId = allocatePortableAgentId(
          recipeAgent,
          placement.kind === 'create' ? digest : `${digest}:clone`,
          allocatedAgentIds,
        );
        appendCreation(
          operations,
          recipeAgent,
          compiled,
          placement.kind,
          proposedAgentId,
          placement.kind === 'create' ? recipeAgent.name : `${recipeAgent.name} copy`,
        );
        appendProviderSetupOperation(operations, recipeAgent, compiled);
        agentPreviews.push({ ...preview, status: placement.kind, proposedAgentId });
        break;
      }
      case 'update': {
        const itemId = `update_${recipeAgent.symbol}`;
        operations.push({
          itemId,
          kind: 'update_agent',
          agentId: placement.match.id,
          expectedRevision: placement.match.revision,
          confirmationReason: 'recipe_overwrite',
          patch: { ...recipeDefinition(recipeAgent), ...compiled.capabilities },
        });
        appendSetupOperations(operations, recipeAgent.symbol, placement.match.id, compiled.setups, itemId);
        appendProviderSetupOperation(operations, recipeAgent, compiled);
        agentPreviews.push({ ...preview, status: 'update' });
        break;
      }
    }
  }

  if (operations.length > 25) {
    throw new ManagementError(
      'invalid_request',
      'The recipe compiles to more than 25 operations. Split it into smaller recipes.',
    );
  }
  return { recipeDigest: digest, agents: agentPreviews, operations };
}

/**
 * A base creation carries no connection or repository, so each later item
 * passes its own policy: the capabilities and the disabled state arrive in one
 * update of the new Agent, then one setup per missing credential.
 */
function appendCreation(
  operations: ManagementOperation[],
  recipe: WorkspaceRecipeAgent,
  compiled: CompiledRecipeAgent,
  status: 'create' | 'clone',
  agentId: string,
  name: string,
): void {
  const creationItemId = `${status}_${recipe.symbol}`;
  operations.push({
    itemId: creationItemId,
    kind: 'create_agent',
    agent: {
      id: agentId,
      name,
      ...recipeDefinition(recipe),
      enabled: true,
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    },
  });
  const { mcpServers, apiConnections, repositories } = compiled.capabilities;
  const configuration: ManagementAgentPatch = {
    ...(recipe.enabled ? {} : { enabled: false }),
    ...(mcpServers.length ? { mcpServers } : {}),
    ...(apiConnections.length ? { apiConnections } : {}),
    ...(repositories.length ? { repositories } : {}),
  };
  let lastItemId = creationItemId;
  if (Object.keys(configuration).length > 0) {
    lastItemId = `configure_${recipe.symbol}`;
    operations.push({
      itemId: lastItemId,
      dependsOn: [creationItemId],
      kind: 'update_agent',
      agentId,
      expectedRevision: 0,
      patch: configuration,
    });
  }
  appendSetupOperations(operations, recipe.symbol, agentId, compiled.setups, lastItemId);
}

const SETUP_ITEM_LANE: Record<SetupTarget['kind'], string> = {
  mcp_connection: 'mcp',
  api_connection: 'api',
  repository_access: 'repo',
};

function appendSetupOperations(
  operations: ManagementOperation[],
  symbol: string,
  agentId: string,
  setups: readonly SetupTarget[],
  dependency: string,
): void {
  for (const target of setups) {
    const id = target.kind === 'repository_access' ? target.repositoryId : target.connectionId;
    operations.push({
      itemId: `setup_${symbol}_${SETUP_ITEM_LANE[target.kind]}_${id}`,
      dependsOn: [dependency],
      kind: 'request_setup',
      target: { ...target, agentId },
    });
  }
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

/** The Agent fields a recipe sets, apart from its connections and repositories. */
function recipeDefinition(
  recipe: WorkspaceRecipeAgent,
): Omit<ManagementAgentCreateInput, 'id' | 'name' | 'mcpServers' | 'apiConnections' | 'repositories'> {
  return {
    ...(recipe.description !== undefined ? { description: recipe.description } : {}),
    ...(recipe.editPolicy ? { editPolicy: recipe.editPolicy } : {}),
    instructions: recipe.instructions,
    enabled: recipe.enabled,
    ...(recipe.model ? { model: recipe.model } : {}),
    ...(recipe.modelEffort ? { modelEffort: recipe.modelEffort } : {}),
    skills: recipe.skills.map(copySkill),
  };
}

/**
 * Decides setup with the same server-owned rules the write will apply, so a
 * connection the existing Agent already has working needs no new link.
 */
async function compileRecipeAgent(
  recipe: WorkspaceRecipeAgent,
  existing: CustomAgentConfig | undefined,
  readiness: ModelReadiness,
): Promise<CompiledRecipeAgent> {
  const setups: SetupTarget[] = [];
  const setupRequired: string[] = [];
  const unavailable: string[] = [];
  for (const connection of mcpConnectionsAfterWrite(existing?.mcpServers ?? [], recipe.mcpRequirements)) {
    if (connection.lifecycleStatus === 'ready') continue;
    // Management has no setup link for a header credential without bearer or OAuth auth.
    if (connection.authMode === 'none') {
      setupRequired.push(connection.credentialHeaderName && !connection.credentialOptional
        ? `${connection.displayName} (set its credential in Admin)`
        : connection.displayName);
      continue;
    }
    setups.push({ kind: 'mcp_connection', connectionId: connection.id });
    setupRequired.push(connection.displayName);
  }
  for (const connection of apiConnectionsAfterWrite(existing?.apiConnections ?? [], recipe.apiRequirements)) {
    if ((connection.lifecycleStatus ?? 'ready') === 'ready') continue;
    setups.push({ kind: 'api_connection', connectionId: connection.id });
    setupRequired.push(connection.displayName);
  }
  const repositories: RepositoryGrant[] = [];
  for (const requirement of recipe.repositoryRequirements) {
    const grant = existing?.repositories.find((stored) => grantMeetsRequirement(stored, requirement)) ??
      unboundGrant(requirement);
    if (grant) {
      repositories.push(grant);
      if (grant.installationId !== null) continue;
      setups.push({ kind: 'repository_access', repositoryId: grant.id });
    }
    setupRequired.push('owner' in requirement
      ? `All repositories of ${requirement.owner} (grant in Admin)`
      : requirement.fullName);
  }
  const provider = recipe.model?.split('/', 1)[0];
  const answer = recipe.model ? await readiness(recipe.model) : undefined;
  if (answer?.unavailable === 'credential_missing' && provider &&
      ['anthropic', 'openai', 'openrouter'].includes(provider)) {
    setupRequired.push(`${provider} model provider`);
  } else if (answer?.unavailable === 'funding_not_offered') {
    unavailable.push(PLATFORM_NOT_OFFERED_TEXT);
  } else if (answer?.unavailable === 'model_unsupported') {
    unavailable.push(answer.message);
  }
  return {
    capabilities: { mcpServers: recipe.mcpRequirements, apiConnections: recipe.apiRequirements, repositories },
    setups,
    setupRequired: [...new Set(setupRequired)],
    unavailable,
  };
}

/**
 * A recipe never binds a GitHub installation. A named repository waits for its
 * setup link; an account-wide grant names an installation, which only Admin
 * chooses, so it gets no grant at all.
 */
function unboundGrant(requirement: RepositoryRequirement): RepositoryGrant | undefined {
  return 'owner' in requirement
    ? undefined
    : {
        id: requirement.id,
        installationId: null,
        accountLogin: 'unconnected',
        fullName: requirement.fullName,
        enabled: requirement.enabled,
      };
}

/** An overwrite keeps, exactly as stored, the grant the Agent already holds for the same requirement. */
function grantMeetsRequirement(grant: RepositoryGrant, requirement: RepositoryRequirement): boolean {
  if (grant.id !== requirement.id) return false;
  return 'owner' in requirement
    ? grant.allRepos === true && grant.accountLogin.toLowerCase() === requirement.owner.toLowerCase()
    : grant.allRepos !== true && grant.fullName === requirement.fullName;
}

function exportAgent(agent: CustomAgentConfig, symbol: string): WorkspaceRecipeAgent {
  return {
    symbol,
    name: agent.name,
    ...(agent.description ? { description: agent.description } : {}),
    ...(agent.editPolicy ? { editPolicy: agent.editPolicy } : {}),
    instructions: agent.instructions,
    enabled: agent.enabled,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.modelEffort ? { modelEffort: agent.modelEffort } : {}),
    skills: agent.skills.map(copySkill),
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
    repositoryRequirements: agent.repositories.map((repository) => repository.allRepos
      ? { id: repository.id, owner: repository.accountLogin, allRepos: true as const, enabled: repository.enabled }
      : { id: repository.id, fullName: repository.fullName, enabled: repository.enabled }),
  };
}

function copySkill(skill: SkillConfig): SkillConfig {
  return {
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    enabled: skill.enabled,
    ...(skill.suggestedSkillId ? { suggestedSkillId: skill.suggestedSkillId } : {}),
    ...(skill.importSource ? { importSource: { ...skill.importSource } } : {}),
  };
}

function parseWorkspaceRecipe(value: unknown): WorkspaceRecipe {
  const parsed = workspaceRecipeSchema.safeParse(value);
  if (!parsed.success) {
    throw new ManagementError('invalid_request', 'The workspace recipe is invalid.');
  }
  const recipe = parsed.data;
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
