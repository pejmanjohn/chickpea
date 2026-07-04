import { Hono } from 'hono';
import * as v from 'valibot';

import { resolveAgentModel, type ModelResolvableAgent } from '../config/model-policy.ts';
import { knownProviderIds } from '../config/providers.ts';
import { getConfigStore, type SqliteConfigStore } from '../config/store.ts';
import type { ChannelAssignment, CustomAgentConfig } from '../config/types.ts';
import { constantTimeEquals } from '../slack/internal-auth.ts';

interface AdminRoutesOptions {
  store?: SqliteConfigStore | undefined;
  adminToken?: string | undefined;
  knownProviders?: ReadonlySet<string> | undefined;
}

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const modelSpecifier = v.pipe(v.string(), v.regex(/^[^/]+\/.+$/));

const defaultModelsSchema = v.object({
  claude: nonEmptyString,
  'workers-ai': nonEmptyString,
});

const agentSchema = v.object({
  id: nonEmptyString,
  name: nonEmptyString,
  description: v.string(),
  instructions: nonEmptyString,
  enabled: v.boolean(),
  model: v.optional(modelSpecifier),
  defaultModels: defaultModelsSchema,
  allowedTools: v.array(v.string()),
});

const agentPatchSchema = v.partial(
  v.object({
    name: nonEmptyString,
    description: v.string(),
    instructions: nonEmptyString,
    enabled: v.boolean(),
    model: v.nullable(modelSpecifier),
    defaultModels: defaultModelsSchema,
    allowedTools: v.array(v.string()),
  }),
);

const assignmentSchema = v.object({
  workspaceId: nonEmptyString,
  channelId: nonEmptyString,
  agentId: nonEmptyString,
  enabled: v.boolean(),
  channelPromptAddendum: v.optional(v.string()),
});

export function createAdminRoutes(options: AdminRoutesOptions = {}): Hono {
  const app = new Hono();
  const tokenFromOptions = Object.hasOwn(options, 'adminToken');
  const store = () => options.store ?? getConfigStore();
  const adminToken = () =>
    tokenFromOptions ? options.adminToken : process.env.FLUE_ADMIN_TOKEN;
  const providers = () => options.knownProviders ?? knownProviderIds();

  app.use('/admin/*', async (c, next) => {
    const expected = adminToken();
    if (!expected) {
      return c.notFound();
    }
    const candidate = bearerToken(c.req.header('authorization'));
    if (!constantTimeEquals(candidate, expected)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  });

  app.get('/admin/api/agents', (c) => c.json({ agents: store().listAgents() }));

  app.post('/admin/api/agents', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(agentSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    const agent = toAgentConfig(parsed.output);
    const badProvider = unknownProvider(agent.model, providers());
    if (badProvider) {
      return unknownProviderResponse(c, badProvider, providers());
    }
    if (!isModelResolvable(agent)) {
      return c.json({ error: 'model_not_resolvable' }, 422);
    }
    try {
      const configStore = store();
      return c.json({ agent: configStore.createAgent(agent) }, 201);
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return c.json({ error: 'agent_exists' }, 409);
      }
      return internalError(c, err);
    }
  });

  app.get('/admin/api/agents/:id', (c) => {
    try {
      return c.json({ agent: store().getAgent(c.req.param('id')) });
    } catch (err) {
      if (isUnknownAgentError(err)) {
        return c.json({ error: 'not_found' }, 404);
      }
      return internalError(c, err);
    }
  });

  app.patch('/admin/api/agents/:id', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(agentPatchSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    try {
      const configStore = store();
      const agentId = c.req.param('id');
      const current = configStore.getAgent(agentId);
      const patch = toAgentPatch(parsed.output);
      const next: ModelResolvableAgent = {
        ...current,
        ...patch,
        id: agentId,
        defaultModels: patch.defaultModels ?? current.defaultModels,
      };
      const badProvider = unknownProvider(next.model, providers());
      if (badProvider) {
        return unknownProviderResponse(c, badProvider, providers());
      }
      if (!isModelResolvable(next)) {
        return c.json({ error: 'model_not_resolvable' }, 422);
      }
      return c.json({ agent: configStore.updateAgent(agentId, patch) });
    } catch (err) {
      if (isUnknownAgentError(err)) {
        return c.json({ error: 'not_found' }, 404);
      }
      return internalError(c, err);
    }
  });

  app.delete('/admin/api/agents/:id', (c) => {
    const configStore = store();
    const agentId = c.req.param('id');
    const references = configStore.listAssignmentsForAgent(agentId);
    if (references.length > 0) {
      return c.json(
        {
          error: 'agent_still_assigned',
          assignments: references.map(({ workspaceId, channelId }) => ({ workspaceId, channelId })),
        },
        409,
      );
    }
    try {
      const deleted = configStore.deleteAgent(agentId);
      return deleted ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
    } catch (err) {
      if (isStillAssignedError(err)) {
        return c.json({ error: 'agent_still_assigned' }, 409);
      }
      return internalError(c, err);
    }
  });

  app.get('/admin/api/assignments', (c) => {
    const key = assignmentKey(c);
    if (!key) {
      return invalidRequest(c);
    }
    const assignment = store().getAssignment(key.workspaceId, key.channelId);
    return assignment ? c.json({ assignment }) : c.json({ error: 'not_found' }, 404);
  });

  app.put('/admin/api/assignments', async (c) => {
    const body = await readJson(c.req);
    const parsed = v.safeParse(assignmentSchema, body);
    if (!parsed.success) {
      return invalidRequest(c);
    }
    try {
      return c.json({ assignment: store().putAssignment(toAssignment(parsed.output)) });
    } catch (err) {
      if (isUnknownAgentError(err)) {
        return c.json({ error: 'unknown_agent' }, 404);
      }
      return internalError(c, err);
    }
  });

  app.delete('/admin/api/assignments', (c) => {
    const key = assignmentKey(c);
    if (!key) {
      return invalidRequest(c);
    }
    const deleted = store().deleteAssignment(key.workspaceId, key.channelId);
    return deleted ? c.body(null, 204) : c.json({ error: 'not_found' }, 404);
  });

  return app;
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer (.+)$/);
  return match?.[1];
}

function toAgentConfig(input: v.InferOutput<typeof agentSchema>): CustomAgentConfig {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    instructions: input.instructions,
    enabled: input.enabled,
    ...(input.model !== undefined ? { model: input.model } : {}),
    defaultModels: input.defaultModels,
    allowedTools: input.allowedTools,
  };
}

type AgentPatch = Partial<Omit<CustomAgentConfig, 'id' | 'model'>> & { model?: string | null };

function toAgentPatch(input: v.InferOutput<typeof agentPatchSchema>): AgentPatch {
  const patch: AgentPatch = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.instructions !== undefined) patch.instructions = input.instructions;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.model !== undefined) patch.model = input.model;
  if (input.defaultModels !== undefined) patch.defaultModels = input.defaultModels;
  if (input.allowedTools !== undefined) patch.allowedTools = input.allowedTools;
  return patch;
}

function toAssignment(input: v.InferOutput<typeof assignmentSchema>): ChannelAssignment {
  return {
    workspaceId: input.workspaceId,
    channelId: input.channelId,
    agentId: input.agentId,
    enabled: input.enabled,
    ...(input.channelPromptAddendum !== undefined
      ? { channelPromptAddendum: input.channelPromptAddendum }
      : {}),
  };
}

function isModelResolvable(agent: ModelResolvableAgent): boolean {
  try {
    resolveAgentModel(agent);
    return true;
  } catch {
    return false;
  }
}

async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

function assignmentKey(c: { req: { query(name: string): string | undefined } }):
  | { workspaceId: string; channelId: string }
  | undefined {
  const workspaceId = c.req.query('workspaceId');
  const channelId = c.req.query('channelId');
  if (!workspaceId || !channelId) {
    return undefined;
  }
  return { workspaceId, channelId };
}

function invalidRequest(c: { json(body: { error: string }, status: 400): Response }): Response {
  return c.json({ error: 'invalid_request' }, 400);
}

function isUnknownAgentError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Unknown agent ');
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed');
}

function isStillAssignedError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('is still assigned to');
}

// Never echo internal error text (raw SQLite messages) to API clients; log it
// server-side and return a stable retriable status instead.
function internalError(
  c: { json(body: { error: string }, status: 500): Response },
  err: unknown,
): Response {
  console.error('[slack-flue] admin API failure:', err instanceof Error ? err.message : String(err));
  return c.json({ error: 'internal_error' }, 500);
}

function unknownProvider(
  model: string | null | undefined,
  known: ReadonlySet<string>,
): string | undefined {
  // An empty registry means "unknown environment" (route module used without
  // src/app.ts registrations, e.g. unit tests) — skip validation rather than
  // rejecting every model.
  if (!model || known.size === 0) return undefined;
  const prefix = model.slice(0, model.indexOf('/'));
  return known.has(prefix) ? undefined : prefix;
}

function unknownProviderResponse(
  c: { json(body: object, status: 422): Response },
  provider: string,
  known: ReadonlySet<string>,
): Response {
  return c.json(
    { error: 'unknown_provider', provider, knownProviders: [...known].sort() },
    422,
  );
}
