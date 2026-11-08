/**
 * The parts of an Agent's run plan that no message decides, for an Agent in a
 * place acting for a member, resolved with no Slack event. Slack turns and
 * routines both resolve through here, so a view built on it shows what a real
 * run gets: the model's route, the image role, the browser and website logins,
 * web search, the coding workspace and model, and the connections. The place
 * enters only through the assignment and the workspace.
 *
 * The caller adds what a message or the conversation decides: the thread,
 * continuity key and surface; the connections a request selects; the front
 * desk; the memory epoch; the instructions; and persisting the plan.
 * `compileAgentRunPlan` joins the two.
 */
import {
  compileRuntimePlanV2,
  frozenModelCredential,
  type CompileRuntimePlanV2Input,
  type RuntimePlanBrowserCapabilityV1,
  type RuntimePlanCodingModelV1,
  type RuntimePlanImageCapabilityV3,
  type RuntimePlanV2,
  type RuntimePlanWebsiteLoginV1,
} from './runtime-plan.ts';
import { browserCapabilityForTurn, websiteLoginsForTurn } from '../browser/capability.ts';
import { getGithubConnection } from '../config/github-app.ts';
import { deploymentServesManyInstallations } from '../config/installation-scope.ts';
import { resolveModelCredentialAttribution } from '../config/model-credential-refs.ts';
import {
  codingOnAgentModel,
  imageCapabilityForResolution,
  resolveAgentModelRoleFromStore,
  resolveCodingModelForPlan,
  type CodingModelAgentRoute,
  type ModelRoleReader,
} from '../config/model-policy.ts';
import {
  freezeRuntimeModelRoute,
  resolveRuntimeModel,
  type FrozenRuntimeModelRoute,
  type ResolvedRuntimeModel,
} from '../config/runtime-model.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { resolveSandboxSettings } from '../config/sandbox-settings.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import { getSettingsStore, type PlatformEnv } from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { ModelCredentialAttribution, ResolvedAssignment } from '../config/types.ts';
import { resolveConnectionAccountContext } from '../connections/runtime.ts';
import type {
  ConnectionRequestResolution,
  EffectiveConnectionAccount,
  PersonalConnectionAuthorizationOption,
  TeamConnectionNeedingReconnect,
} from '../connections/types.ts';
import {
  resolveCodingWorkspaceCapability,
  sandboxBindingInstalled,
  type CodingWorkspaceCapabilityDecision,
} from '../sandbox/select.ts';
import { webSearchConfigured } from '../web/exa.ts';

export interface AgentRunPlanRequest {
  /** The Agent as assigned to the place, with its effort and model credential. */
  assignment: Pick<ResolvedAssignment, 'agentId' | 'agent' | 'effort' | 'modelCredential'>;
  /** The canonical model the run uses. */
  model: string;
  workspaceId: string;
  /** Whose connections the run may use; none without (a requester with no membership). */
  connections?:
    | { actorMembershipId: string; config: Pick<ConfigStore, 'listConnectionAccounts' | 'listAgentConnectionBindings'> }
    /** Exactly those a routine's schedule admitted. */
    | { admitted: readonly EffectiveConnectionAccount[] };
  /** Resolved already, by a caller that needs it first (a routine). */
  resolvedModel?: { runtimeModel: string; runtimeModelRoute?: FrozenRuntimeModelRoute };
  env: PlatformEnv | undefined;
  settings: SettingsStore;
  roles: ModelRoleReader;
  resolveModel?: typeof resolveRuntimeModel;
  /** By default, the workspace's settings and this deployment's sandbox decide. */
  decideCodingWorkspace?: () => Promise<CodingWorkspaceCapabilityDecision>;
}

export interface AgentRunPlanParts {
  runtimeModel: string;
  runtimeModelRoute?: FrozenRuntimeModelRoute;
  /** Mounts `generate_image`; an unresolved role is unfilled. */
  imageCapability: RuntimePlanImageCapabilityV3;
  /** Present when the coding workspace mounts this run. */
  codingWorkspace?: { codingModel: RuntimePlanCodingModelV1 };
  /** The coding workspace is configured, but this deployment has no sandbox. */
  sandboxUnavailableFallback: boolean;
  browserCapability?: RuntimePlanBrowserCapabilityV1;
  /** Metadata only; a plan freezes them only with a browser. */
  websiteLogins: readonly RuntimePlanWebsiteLoginV1[];
  /** A search key exists; web_search reads it at call time. */
  webSearch: boolean;
  /** All the run may use; a Slack turn narrows them to its request. */
  connections: readonly EffectiveConnectionAccount[];
  /** For an actor only: personal connections to authorize, team ones to reconnect. */
  connectionAuthorizations?: readonly PersonalConnectionAuthorizationOption[];
  teamReconnects?: readonly TeamConnectionNeedingReconnect[];
}

/** What a conversation adds; `request` is what a request selected from the connections. */
export type AgentRunConversation =
  Pick<CompileRuntimePlanV2Input, 'turn' | 'assignment' | 'installation' | 'instructions' | 'memoryEpoch' |
    'frontDesk' | 'artifactThreadTs'> & { request?: ConnectionRequestResolution };

export async function resolveAgentRunPlan(input: AgentRunPlanRequest): Promise<AgentRunPlanParts> {
  const { assignment, env, settings } = input;
  const resolveModel = input.resolveModel ?? resolveRuntimeModel;
  const connections = input.connections;
  // Independent reads, in one round to the state store.
  const [workspaceDecision, connectionContext, model, imageRole, browserCapability, websiteLogins] =
    await Promise.all([
      input.decideCodingWorkspace?.() ?? resolveCodingWorkspaceDecision(assignment, env, settings),
      connections && 'actorMembershipId' in connections
        ? resolveConnectionAccountContext({
            config: connections.config,
            workspaceId: input.workspaceId,
            agentId: assignment.agentId,
            actorMembershipId: connections.actorMembershipId,
          })
        : undefined,
      input.resolvedModel ?? resolveModel(assignment.agentId, input.model, { settings, ...(env ? { env } : {}) }),
      resolveAgentModelRoleFromStore({
        role: 'image',
        workspaceId: input.workspaceId,
        agent: { id: assignment.agent.id, kind: assignment.agent.kind },
        reader: input.roles,
        ...(env ? { env } : {}),
        settings,
      }),
      // A connected hosted browser mounts the browser tools. The key stays in
      // settings and is read again at call time; only the capability is frozen.
      browserCapabilityForTurn(settings, env),
      // Login metadata only; passwords are decrypted at call time.
      websiteLoginsForTurn(settings, assignment.agent.websiteLogins),
    ]);
  // The route is frozen once every read is in, from the active catalog as it then stands.
  const runtimeModel = 'runtimeModel' in model ? model : withFrozenRoute(input.model, model, env);
  const codingModel = workspaceDecision.capability === 'available'
    ? await freezeCodingModelForTurn({
        workspaceId: input.workspaceId,
        agent: assignment.agent,
        reader: input.roles,
        agentRoute: {
          model: input.model,
          ...runtimeModel,
          ...(assignment.effort ? { effort: assignment.effort } : {}),
        },
        settings,
        ...(env ? { env } : {}),
        resolveModel,
        agentCredential: assignment.modelCredential ?? null,
      })
    : undefined;
  return {
    ...runtimeModel,
    imageCapability: imageCapabilityForResolution(imageRole),
    ...(codingModel ? { codingWorkspace: { codingModel } } : {}),
    sandboxUnavailableFallback: workspaceDecision.unavailableFallback,
    ...(browserCapability ? { browserCapability } : {}),
    websiteLogins,
    webSearch: webSearchConfigured(env),
    connections: connections && 'admitted' in connections ? connections.admitted : connectionContext?.effective ?? [],
    ...(connectionContext
      ? { connectionAuthorizations: connectionContext.authorizations, teamReconnects: connectionContext.teamReconnects }
      : {}),
  };
}

function withFrozenRoute(
  canonicalModel: string,
  resolved: ResolvedRuntimeModel,
  env: PlatformEnv | undefined,
): Pick<AgentRunPlanParts, 'runtimeModel' | 'runtimeModelRoute'> {
  const runtimeModelRoute = freezeRuntimeModelRoute(canonicalModel, resolved.providerAuthRoute, env);
  return { runtimeModel: resolved.model, ...(runtimeModelRoute ? { runtimeModelRoute } : {}) };
}

/** Without a request, the run uses all of its connections. */
export function compileAgentRunPlan(parts: AgentRunPlanParts, conversation: AgentRunConversation): RuntimePlanV2 {
  const { request, ...rest } = conversation;
  return compileRuntimePlanV2({
    ...rest,
    runtimeModel: parts.runtimeModel,
    ...(parts.runtimeModelRoute ? { runtimeModelRoute: parts.runtimeModelRoute } : {}),
    imageCapability: parts.imageCapability,
    ...(parts.codingWorkspace ? { codingWorkspace: true, codingModel: parts.codingWorkspace.codingModel } : {}),
    ...(parts.browserCapability
      ? { browserCapability: parts.browserCapability, websiteLogins: parts.websiteLogins }
      : {}),
    webSearch: parts.webSearch,
    ...(request
      ? {
          effectiveConnections: request.selected,
          connectionChoices: request.ambiguous,
          connectionSelections: request.selections,
        }
      : { effectiveConnections: parts.connections }),
    ...(parts.connectionAuthorizations ? { connectionAuthorizations: parts.connectionAuthorizations } : {}),
    ...(parts.teamReconnects ? { teamReconnects: parts.teamReconnects } : {}),
  });
}

/**
 * Whether this run's Agent may use a coding workspace. It never changes the
 * Agent's own environment; it only decides whether the workspace tools mount.
 */
export async function resolveCodingWorkspaceDecision(
  assignment: Pick<ResolvedAssignment, 'agent'>,
  env: PlatformEnv | undefined,
  store?: SettingsStore,
): Promise<CodingWorkspaceCapabilityDecision> {
  if (!isCloudflareTarget()) return { capability: 'unavailable', unavailableFallback: false };
  const repositories = assignment.agent.repositories ?? [];
  if (repositories.length === 0) {
    return { capability: 'unavailable', unavailableFallback: false };
  }

  try {
    const settingsStore = store ?? getSettingsStore(env);
    const [settings, connection] = await Promise.all([
      resolveSandboxSettings(settingsStore, env),
      getGithubConnection(settingsStore, env),
    ]);
    return resolveCodingWorkspaceCapability({
      target: 'cloudflare',
      installed: sandboxBindingInstalled(env),
      enabled: settings.enabled,
      appConnected: connection.mode === 'app',
      repositoryGrants: repositories,
    });
  } catch {
    // Without its policy the workspace is simply not offered this turn.
    return { capability: 'unavailable', unavailableFallback: false };
  }
}

/** Freeze the coding model for a run that has a coding workspace. */
export async function freezeCodingModelForTurn(input: {
  workspaceId: string;
  agent: { id: string; kind: ResolvedAssignment['agent']['kind'] };
  reader: ModelRoleReader;
  agentRoute: CodingModelAgentRoute;
  settings: SettingsStore;
  env?: PlatformEnv;
  resolveModel?: typeof resolveRuntimeModel;
  /** The credential frozen for the Agent's own model with this turn. */
  agentCredential?: Pick<ModelCredentialAttribution, 'credentialRefId' | 'version' | 'providerId'> | null;
  resolveCredential?: typeof resolveModelCredentialAttribution;
}): Promise<RuntimePlanCodingModelV1> {
  const coding = await resolveCodingModelRoute(input);
  return deploymentServesManyInstallations(input.env) ? withHostedCodingCredential(coding, input) : coding;
}

/**
 * An installation of a deployment serving many runs its coding worker on a
 * frozen credential, as its Agent runs on one: the coding model's own, else
 * the Agent's model and the Agent's credential, as a role whose provider
 * has no key falls back today.
 */
async function withHostedCodingCredential(
  coding: RuntimePlanCodingModelV1,
  input: Parameters<typeof freezeCodingModelForTurn>[0],
): Promise<RuntimePlanCodingModelV1> {
  const agentCredential = input.agentCredential ? frozenModelCredential(input.agentCredential) : undefined;
  if (coding.model === input.agentRoute.model) {
    return agentCredential ? { ...coding, modelCredential: agentCredential } : coding;
  }
  // No key falls back; a store that cannot be read fails the turn, as the
  // Agent's own credential read does.
  const credential = await (input.resolveCredential ?? resolveModelCredentialAttribution)(
    coding.model,
    input.env,
    input.settings,
    undefined,
    { registerUsage: false },
  );
  if (credential) return { ...coding, modelCredential: frozenModelCredential(credential) };
  return {
    ...codingOnAgentModel(input.agentRoute, true),
    ...(agentCredential ? { modelCredential: agentCredential } : {}),
  };
}

async function resolveCodingModelRoute(input: Parameters<typeof freezeCodingModelForTurn>[0]) {
  return resolveCodingModelForPlan({
    workspaceId: input.workspaceId,
    agent: { id: input.agent.id, kind: input.agent.kind },
    reader: {
      getWorkspaceModelRole: (workspaceId, role) =>
        input.reader.getWorkspaceModelRole(workspaceId, role),
      getAgentModelRole: (agentId, role) => input.reader.getAgentModelRole(agentId, role),
    },
    agentRoute: input.agentRoute,
    resolveRoute: async (canonicalModel) => {
      const resolved = await (input.resolveModel ?? resolveRuntimeModel)(
        input.agent.id,
        canonicalModel,
        { settings: input.settings, ...(input.env ? { env: input.env } : {}) },
      );
      const runtimeModelRoute = freezeRuntimeModelRoute(
        canonicalModel,
        resolved.providerAuthRoute,
        input.env,
      );
      return {
        runtimeModel: resolved.model,
        ...(runtimeModelRoute ? { runtimeModelRoute } : {}),
      };
    },
  });
}
