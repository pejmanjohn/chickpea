import { randomUUID } from 'node:crypto';
import type { z } from 'zod';

import { matchingConnectorCatalogPresets } from '../../config/presets.ts';
import {
  DEFAULT_AGENT_AVATAR_FILES,
  DEFAULT_AGENT_AVATAR_NAMES,
  nextDefaultAgentAvatarFile,
} from '../../slack/agent-presence/default-avatar-pool.ts';
import { normalizeAgentHandle } from '../../slack/agent-presence/handles.ts';
import { adminOrigin } from '../admin-links.ts';
import { summarizeTextChange } from '../text-changes.ts';
import {
  ManagementError,
  type ManagementActorContext,
  type ManagementAgentPatch,
  type ManagementWorkspaceSnapshot,
} from '../types.ts';
import { fail } from './conventions.ts';
import { agentAvatar, agentVersion, readWorkspace, requireAgent, slackDirectory, type FiveZeroDeps } from './reads.ts';
import {
  createAgentInputSchema,
  updateAgentInputSchema,
  type proposeAgentChangeInput,
  type proposeAgentChangeOutput,
  type proposeAgentInput,
  type proposeAgentOutput,
} from './schemas.ts';

type Out<T extends z.ZodType> = z.infer<T>;

/**
 * A proposed new teammate, saving nothing. `create.arguments` are exactly what
 * `create_agent` takes, so a card's Create button sends them unchanged. A
 * service is connected after creation, so it is listed, never sent.
 */
export async function proposeAgent(
  deps: FiveZeroDeps,
  input: Out<typeof proposeAgentInput>,
): Promise<Out<typeof proposeAgentOutput>> {
  const { context, snapshot } = await readWorkspace(deps);
  const issues: string[] = [];

  const typedHandle = input.handle.trim().replace(/^@/, '');
  const handle = normalizeAgentHandle(typedHandle);
  if (handle !== typedHandle.toLowerCase()) {
    issues.push(`Slack handles use lowercase letters, digits, "-" and "_", so the handle becomes @${handle}.`);
  }
  const takenBy = [
    ...snapshot.agents.map((agent) => ({ name: agent.name, handle: agent.slackPresence?.normalizedHandle })),
    ...(snapshot.usableAgents ?? []),
  ].find((agent) => agent.handle === handle);
  if (takenBy) issues.push(`@${handle} already belongs to ${takenBy.name}. Choose another handle.`);
  const sameName = snapshot.agents.find(({ name }) => name.trim().toLowerCase() === input.name.trim().toLowerCase());
  if (sameName) issues.push(`An Agent named ${sameName.name} already exists. Choose another name, or change that one.`);
  if (!input.instructions.trim()) issues.push('The instructions are empty, so the Agent would not know its job.');

  const needs: Out<typeof proposeAgentOutput>['proposal']['needs'] = [];
  for (const asked of input.services ?? []) {
    const matches = matchingConnectorCatalogPresets(asked);
    const [match] = matches;
    if (matches.length === 1 && match) {
      if (!needs.some(({ service }) => service === match.id)) {
        needs.push({ service: match.id, name: match.name, connected: false });
      }
    } else if (matches.length > 1) {
      issues.push(`"${asked}" matches several services (${matches.map(({ name }) => name).join(', ')}). Name one.`);
    } else {
      issues.push(`"${asked}" is not a service Chickpea connects yet.`);
    }
  }

  const { found: answersIn, missing } = await resolveChannels(deps, context, snapshot, input.channels ?? []);
  for (const asked of missing) issues.push(`No Slack Channel you are in is called ${asked}.`);

  const modelOk = input.model === undefined || snapshot.modelCatalog.chat.some(({ id }) => id === input.model);
  if (!modelOk) issues.push('That model isn\'t one this workspace can use, so the Agent uses the workspace default.');

  const idempotencyKey = randomUUID();
  // Chosen as creation would choose it, and sent with Create, so Slack shows the picture this proposal does.
  const avatar = nextDefaultAgentAvatarFile(await deps.service.agentAvatarSeeds(context), idempotencyKey);
  const origin = adminOrigin(deps.baseUrl);
  const create = createAgentInputSchema.parse({
    name: input.name.trim(),
    handle,
    description: input.job,
    instructions: input.instructions,
    ...(input.model && modelOk ? { model: input.model } : {}),
    firstAsk: input.sampleAsk,
    ...(answersIn.length ? { channels: answersIn.map(({ channelId }) => channelId) } : {}),
    avatar: DEFAULT_AGENT_AVATAR_NAMES[DEFAULT_AGENT_AVATAR_FILES.indexOf(avatar)],
    idempotencyKey,
  });
  return {
    proposal: {
      name: create.name,
      handle,
      handleAvailable: !takenBy,
      job: input.job,
      sampleExchange: { ask: input.sampleAsk, answer: input.promisedAnswer },
      needs,
      answersIn,
      ...(create.model ? { model: create.model } : {}),
      ...(snapshot.slackTeamName ? { workspaceName: snapshot.slackTeamName } : {}),
      ...(origin ? { avatarUrl: `${origin}/chickpea-avatars/agent-defaults/${avatar}` } : {}),
    },
    create: { tool: 'create_agent', arguments: create },
    issues,
  };
}

/** Channels by channelId or #name, among those the caller is in or Chickpea knows. */
export async function resolveChannels(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  snapshot: ManagementWorkspaceSnapshot,
  asked: readonly string[],
): Promise<{ found: Array<{ channelId: string; name?: string }>; missing: string[] }> {
  const found: Array<{ channelId: string; name?: string }> = [];
  const missing: string[] = [];
  if (asked.length === 0) return { found, missing };
  const directory = await slackDirectory(deps, context);
  const known = [
    ...(directory?.channels ?? []).map(({ id, name }) => ({ channelId: id, name })),
    ...snapshot.channels.map(({ channelId, label }) => ({ channelId, name: label })),
  ];
  for (const name of asked) {
    const wanted = name.trim().replace(/^#/, '');
    const match = known.find(({ channelId }) => channelId === wanted) ??
      known.find((channel) => channel.name?.replace(/^#/, '').toLowerCase() === wanted.toLowerCase());
    if (!match) missing.push(name);
    else if (!found.some(({ channelId }) => channelId === match.channelId)) {
      found.push({ channelId: match.channelId, ...(match.name ? { name: match.name } : {}) });
    }
  }
  return { found, missing };
}

type Change = Out<typeof proposeAgentChangeOutput>['changes'][number];
type AgentChange = Out<typeof proposeAgentChangeInput>['change'];

/**
 * What an edit to one Agent would change, saving nothing: each field before
 * and after, quotes from a long text, and whether saving waits for the
 * person's confirmation. Covers `update_agent` fields only; connections and
 * schedules preview in their own tools.
 */
export async function proposeAgentChange(
  deps: FiveZeroDeps,
  input: Out<typeof proposeAgentChangeInput>,
): Promise<Out<typeof proposeAgentChangeOutput>> {
  const { context, snapshot } = await readWorkspace(deps);
  const agent = requireAgent(snapshot, input.agentId);
  if (agentVersion(snapshot, agent) !== input.version) {
    fail('changed_since_read', `${agent.name} changed since you read it.`, {
      nextStep: 'Call get_agent again and propose the change from what it returns now.',
    });
  }
  const { change } = input;
  const handle = agent.slackPresence?.normalizedHandle || undefined;
  const changes: Change[] = [];
  const compare = (field: Change['field'], before: string | boolean | null, after: string | boolean | null | undefined) => {
    if (after === undefined || after === before) return;
    changes.push({ field, before, after, quotes: [] });
  };
  compare('name', agent.name, change.name);
  compare('description', agent.description ?? null, change.description);
  compare('handle', handle ?? null, change.handle === undefined ? undefined : normalizeAgentHandle(change.handle.replace(/^@/, '')));
  if (change.instructions !== undefined && change.instructions !== agent.instructions) {
    changes.push({ field: 'instructions', quotes: summarizeTextChange(agent.instructions, change.instructions) });
  }
  compare('on', agent.enabled, change.on);
  compare('model', agent.model ?? null, change.model);
  compare('effort', agent.modelEffort ?? null, change.effort);
  compare('imageModel', agent.imageModel ?? null, change.imageModel);
  compare('whoCanEdit', agent.editPolicy ?? 'creator_and_admins', change.whoCanEdit);

  const save = updateAgentInputSchema.parse({
    agentId: agent.id,
    version: input.version,
    ...change,
    idempotencyKey: randomUUID(),
  });
  // The card offers "Try it again" after the save only for an Agent practice_agent can ask with no question.
  const [needsConfirmation, firstAsk] = await Promise.all([
    deps.service.agentPatchNeedsConfirmation(context, agent.id, agentPatch(change)),
    deps.service.agentReader(context, agent.id).then(
      ({ stores }) => stores.config.getAgentFirstAsk?.(agent.id),
      (error: unknown) => {
        if (error instanceof ManagementError) return undefined;
        throw error;
      },
    ),
  ]);
  return {
    agent: { name: agent.name, ...(handle ? { handle } : {}), ...agentAvatar(deps, agent), ...(firstAsk ? { hasFirstAsk: true } : {}) },
    changes,
    save: { tool: 'update_agent', arguments: save },
    needsConfirmation,
  };
}

/** The `update_agent` operation patch these fields become; the image model is its own operation. */
export function agentPatch(change: Omit<AgentChange, 'imageModel'>): ManagementAgentPatch {
  return {
    ...(change.name !== undefined ? { name: change.name } : {}),
    ...(change.description !== undefined ? { description: change.description } : {}),
    ...(change.handle !== undefined ? { requestedHandle: change.handle } : {}),
    ...(change.instructions !== undefined ? { instructions: change.instructions } : {}),
    ...(change.on !== undefined ? { enabled: change.on } : {}),
    ...(change.model !== undefined ? { model: change.model } : {}),
    ...(change.effort !== undefined ? { modelEffort: change.effort } : {}),
    ...(change.whoCanEdit !== undefined ? { editPolicy: change.whoCanEdit } : {}),
  };
}
