import type { z } from 'zod';

import { defaultAgentAvatarFileNamed } from '../../slack/agent-presence/default-avatar-pool.ts';
import { AGENT_AUTHORING_GUIDE_VERSION } from '../agent-authoring/index.ts';
import {
  ManagementError,
  type ApplyWorkspaceChangesResult,
  type ManageAgentSkillAction,
  type ManagementActorContext,
  type ManagementAgentPatch,
  type ManagementApplyResult,
  type ManagementOperation,
  type ManagementRoutineSnapshot,
  type ManagementWorkspaceSnapshot,
} from '../types.ts';
import {
  agentSummary,
  applyChange,
  callOperationId,
  changeResult,
  CONFIRMATION_LIFETIME_MS,
  confirmedSummary,
  EXPIRED_NEXT_STEP,
  priorResult,
  requireVersion,
  STALE_CONFIRMATION,
  STALE_NEXT_STEP,
  type ChangeResult,
} from './changes.ts';
import { fail, mcpToolError, versionToken } from './conventions.ts';
import { agentPatch, resolveChannels } from './proposals.ts';
import { forManagedAgent, type FiveZeroDeps } from './reads.ts';
import type * as schemas from './schemas.ts';

type In<T extends z.ZodType> = z.output<T>;
type Out<T extends z.ZodType> = z.infer<T>;
type Operation<K extends ManagementOperation['kind']> = Extract<ManagementOperation, { kind: K }>;

/**
 * The 5.0 writes. Each sends one operation, or a fixed pair, through the
 * service's apply pipeline, so policy.ts decides what waits for the person's
 * confirmation exactly as it does for Admin's "Are you sure?" (U2 note §3).
 */

/** The Agent the caller may edit, checked against the version they read. */
export async function editableAgent(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  agentId: string,
  version?: string,
) {
  const { agent } = await forManagedAgent(deps.service.agentReader(context, agentId));
  if (version !== undefined) {
    requireVersion(versionToken('agent', agent.id, agent.revision, context.organizationId), version, agent.name, 'get_agent');
  }
  return agent;
}

/** An Agent change on its own: the Agent is read again for the result. */
async function agentChange(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  tool: string,
  input: { agentId: string; idempotencyKey: string },
  operation: (agent: Awaited<ReturnType<typeof editableAgent>>) => ManagementOperation,
  version?: string,
): Promise<ChangeResult> {
  const result = await applyChange(deps, context, {
    tool,
    args: input,
    operations: async () => [operation(await editableAgent(deps, context, input.agentId, version))],
  });
  return changeResult(deps, context, result, { agentId: input.agentId });
}

/** The Slack workspace's team ID, which every Channel and schedule operation names. */
export function slackTeamId(snapshot: ManagementWorkspaceSnapshot): string {
  if (!snapshot.slackTeamId) {
    fail('invalid_input', 'Chickpea is not connected to a Slack workspace yet.', {
      nextStep: 'Tell the person to finish connecting Slack in Chickpea Admin.',
    });
  }
  return snapshot.slackTeamId;
}

/** The name's first free ID, passing over `skip` free-looking ones that Agents hidden from the caller hold. */
function agentIdFrom(name: string, taken: ReadonlySet<string>, skip: number): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  const base = `agent_${slug || 'new'}`;
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? base : `${base}_${n}`;
    if (!taken.has(id) && skip-- === 0) return id;
  }
}

/** A derived agentId is tried this many times before the collision is the answer. */
const DERIVED_ID_TRIES = 3;

async function creationChannels(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  snapshot: ManagementWorkspaceSnapshot,
  asked: readonly string[],
): Promise<string[]> {
  const { found, missing } = await resolveChannels(deps, context, snapshot, asked);
  if (missing.length) {
    fail('invalid_input', `No Slack Channel you are in is called ${missing.join(', ')}, so nothing was created.`, {
      nextStep: 'Call list_slack_channels and send channelIds from it.',
    });
  }
  return found.map(({ channelId }) => channelId);
}

export function grantRevision(snapshot: ManagementWorkspaceSnapshot, channelId: string, agentId: string): number {
  return snapshot.channels.find((channel) => channel.channelId === channelId)
    ?.grants.find((grant) => grant.agentId === agentId)?.revision ?? 0;
}

/**
 * Creates the Agent, then adds it to its Channels: a fixed pair in one tool
 * call. The service keeps a creation's call free of Channel reach, so the
 * grants are their own call, keyed off this one. The Agent's hello in Slack
 * and its first ask go out as for any creation over MCP.
 */
export async function createAgent(
  deps: FiveZeroDeps,
  input: In<typeof schemas.createAgentInputSchema>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const create = (attempt: number) => applyChange(deps, context, {
    tool: 'create_agent',
    args: attempt === 0 ? input : { ...input, idempotencyKey: `${input.idempotencyKey}#${attempt + 1}` },
    operations: async () => {
      const snapshot = await deps.service.inspectWorkspace(context);
      if (input.channels?.length) await creationChannels(deps, context, snapshot, input.channels);
      // The snapshot leaves out Agents the caller cannot see, so a derived ID can still be taken.
      const taken = new Set([...snapshot.agents, ...snapshot.usableAgents ?? []].map(({ id }) => id));
      return [createOperation(input, input.agentId ?? agentIdFrom(input.name, taken, attempt))];
    },
  });
  let created = await create(0);
  for (let attempt = 1; attempt < DERIVED_ID_TRIES && !input.agentId && idTaken(created); attempt += 1) {
    created = await create(attempt);
  }
  const agentId = created.status === 'completed'
    ? created.outcomes[0]?.changed?.find(({ kind }) => kind === 'agent')?.id
    : undefined;
  if (!agentId || !input.channels?.length) return changeResult(deps, context, created, agentId ? { agentId } : {});

  // The Agent exists now, so a grant that fails is a warning, never the result.
  const granted = await applyChange(deps, context, {
    tool: 'create_agent:channels',
    args: { ...input, idempotencyKey: `${input.idempotencyKey}#channels` },
    operations: async () => {
      const snapshot = await deps.service.inspectWorkspace(context);
      const workspaceId = slackTeamId(snapshot);
      return (await creationChannels(deps, context, snapshot, input.channels!)).map((channelId, index) => ({
        itemId: `channel_${index + 1}`,
        kind: 'grant_agent_channel',
        workspaceId,
        channelId,
        agentId,
        expectedRevision: grantRevision(snapshot, channelId, agentId),
      }) satisfies Operation<'grant_agent_channel'>);
    },
  }).catch((error: unknown) => mcpToolError(error));
  const result = await changeResult(deps, context, created, { agentId });
  // Joining a Channel moves the Agent's Slack presence on, so its version is read after the grants.
  const { version } = await agentSummary(deps, context, agentId);
  const outcomes = 'outcomes' in granted ? granted.outcomes : [];
  const added = outcomes.filter(({ disposition }) => disposition === 'applied').length;
  const notAdded = 'code' in granted
    ? [`It could not be added to its Channels: ${granted.message}`]
    : outcomes.filter(({ disposition }) => disposition !== 'applied')
      .map((outcome) => `It could not be added to one of its Channels: ${outcome.instruction ?? 'the grant did not apply.'}`);
  return {
    ...result,
    ...(version ? { version } : {}),
    summary: `${result.summary} It joins ${added} Channel${added === 1 ? '' : 's'}.`,
    nextStep: 'get_creation_status follows its arrival in Slack.',
    ...(notAdded.length ? { warnings: [...result.warnings ?? [], ...notAdded] } : {}),
  };
}

function idTaken(result: ApplyWorkspaceChangesResult): boolean {
  return 'outcomes' in result && result.outcomes[0]?.code === 'already_exists';
}

function createOperation(input: In<typeof schemas.createAgentInputSchema>, id: string): Operation<'create_agent'> {
  return {
    itemId: 'create_agent',
    kind: 'create_agent',
    ...(input.firstAsk ? { firstAsk: input.firstAsk } : {}),
    ...(input.createEvenIfSimilar ? { duplicateResolution: 'create_distinct' as const } : {}),
    ...(input.avatar ? { defaultAvatar: defaultAgentAvatarFileNamed(input.avatar)! } : {}),
    agent: {
      id,
      name: input.name.trim(),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.handle ? { requestedHandle: input.handle.trim().replace(/^@/, '') } : {}),
      ...(input.whoCanEdit ? { editPolicy: input.whoCanEdit } : {}),
      instructions: input.instructions,
      enabled: true,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { modelEffort: input.effort } : {}),
      skills: (input.skills ?? []).map((skill) => ({ ...skill, enabled: true })),
      mcpServers: [],
      apiConnections: [],
      repositories: [],
    },
  };
}

/**
 * Agent fields, then the image model: a fixed pair when both change. The
 * image pin lives outside the Agent row, so it is its own operation, sent
 * after the fields at the revision they left.
 */
export async function updateAgent(
  deps: FiveZeroDeps,
  input: In<typeof schemas.updateAgentInputSchema>,
): Promise<ChangeResult> {
  const { agentId, version, imageModel } = input;
  const patch = agentPatch(input);
  const fieldsChange = Object.keys(patch).length > 0;
  if (!fieldsChange && imageModel === undefined) fail('invalid_input', 'Name at least one field to change.');
  if (fieldsChange && imageModel !== undefined && input.on === false) {
    fail('invalid_input', 'Turn the Agent off and change its image model in separate calls.', {
      nextStep: 'Turning an Agent off can need the person\'s confirmation, so send imageModel in its own update_agent call.',
    });
  }
  const context = await deps.context();
  const results: ManagementApplyResult[] = [];
  if (fieldsChange) {
    const result = await applyChange(deps, context, {
      tool: 'update_agent',
      args: input,
      operations: async () => {
        const agent = await editableAgent(deps, context, agentId, version);
        return [{ itemId: 'update_agent', kind: 'update_agent', agentId, expectedRevision: agent.revision, patch }];
      },
    });
    if (result.status !== 'completed') return changeResult(deps, context, result, { agentId });
    results.push(result);
  }
  if (imageModel !== undefined) {
    const result = await applyChange(deps, context, {
      tool: 'update_agent:image',
      args: { ...input, idempotencyKey: `${input.idempotencyKey}#image` },
      operations: async () => {
        const after = results[0]?.outcomes[0]?.changed?.find(({ kind }) => kind === 'agent')?.revision;
        const expectedRevision = after ?? (await editableAgent(deps, context, agentId, version)).revision;
        return [{ itemId: 'set_agent_image_model', kind: 'set_agent_image_model', agentId, expectedRevision, model: imageModel }];
      },
    });
    if (results.length && (result.status !== 'completed' || !('outcomes' in result))) {
      const saved = await changeResult(deps, context, results[0]!, { agentId });
      return { ...saved, warnings: [...saved.warnings ?? [], 'The image model did not change. Read the Agent again and send it on its own.'] };
    }
    if (result.status === 'clarification_required') return changeResult(deps, context, result, { agentId });
    results.push(result);
  }
  const saved = results.length > 1 ? 'Saved the Agent and its image model.' : fieldsChange ? savedWords(patch) : undefined;
  const last = await changeResult(deps, context, results.at(-1)!, { agentId, ...(saved ? { summary: saved } : {}) });
  // A pair is two receipts, so neither alone undoes the change.
  if (results.length > 1) delete last.undoToken;
  return last;
}

/** A save of one of these fields says what it did; any other save is "Saved {name}." */
function savedWords(patch: ManagementAgentPatch): ((name: string) => string) | undefined {
  const fields = Object.keys(patch);
  if (fields.length !== 1) return undefined;
  if (patch.enabled !== undefined) return (name) => `Turned ${patch.enabled ? 'on' : 'off'} ${name}.`;
  if (patch.model !== undefined) return (name) => `Changed ${name}'s model.`;
  if (patch.editPolicy !== undefined) return (name) => `Changed who can edit ${name}.`;
  return undefined;
}

export async function updateAgentMemory(
  deps: FiveZeroDeps,
  input: In<typeof schemas.updateAgentMemoryInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const result = await applyChange(deps, context, {
    tool: 'update_agent_memory',
    args: input,
    operations: async () => {
      const memory = await forManagedAgent(deps.service.inspectMemory(context, input.agentId));
      requireVersion(
        versionToken('memory', input.agentId, memory.revision, context.organizationId),
        input.version,
        'The memory',
        'get_agent_memory',
      );
      return [{
        itemId: 'update_agent_memory',
        kind: 'update_agent_memory',
        agentId: input.agentId,
        expectedRevision: memory.revision,
        body: input.body,
      }];
    },
  });
  return changeResult(deps, context, result, { agentId: input.agentId });
}

export async function archiveAgent(deps: FiveZeroDeps, input: In<typeof schemas.archiveAgentInput>): Promise<ChangeResult> {
  return agentChange(deps, await deps.context(), 'archive_agent', input, (agent) => ({
    itemId: 'archive_agent',
    kind: 'archive_agent',
    agentId: agent.id,
    expectedRevision: agent.revision,
    ...(input.newDefaultAgentId ? { replacementDefaultAgentId: input.newDefaultAgentId } : {}),
  }), input.version);
}

export async function restoreAgent(deps: FiveZeroDeps, input: In<typeof schemas.restoreAgentInput>): Promise<ChangeResult> {
  return agentChange(deps, await deps.context(), 'restore_agent', input, (agent) => ({
    itemId: 'restore_agent',
    kind: 'restore_agent',
    agentId: agent.id,
    expectedRevision: agent.revision,
  }), input.version);
}

/** The server reads the grant's revision: adding an Agent to a Channel is set, not edited. */
export async function addAgentToChannel(
  deps: FiveZeroDeps,
  input: In<typeof schemas.addAgentToChannelInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const result = await applyChange(deps, context, {
    tool: 'add_agent_to_channel',
    args: input,
    operations: async () => {
      const agent = await editableAgent(deps, context, input.agentId);
      const snapshot = await deps.service.inspectWorkspace(context);
      return [{
        itemId: 'add_agent_to_channel',
        kind: 'grant_agent_channel',
        workspaceId: slackTeamId(snapshot),
        channelId: input.channelId,
        agentId: agent.id,
        expectedRevision: grantRevision(snapshot, input.channelId, agent.id),
      }];
    },
  });
  return changeResult(deps, context, result, { agentId: input.agentId });
}

/** The server reads the Channel's revision: the preview is the whole new setting. */
export async function saveChannelSettings(
  deps: FiveZeroDeps,
  input: In<typeof schemas.saveChannelSettingsInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const result = await applyChange(deps, context, {
    tool: 'save_channel_settings',
    args: input,
    operations: async () => {
      const snapshot = await deps.service.inspectWorkspace(context);
      const channel = snapshot.channels.find(({ channelId }) => channelId === input.channelId);
      const label = input.label ?? channel?.label;
      return [{
        itemId: 'save_channel_settings',
        kind: 'put_channel',
        channel: {
          workspaceId: channel?.workspaceId ?? slackTeamId(snapshot),
          channelId: input.channelId,
          ...(label ? { label } : {}),
          lifecycle: input.on ? 'active' : 'archived',
        },
        expectedRevision: channel?.revision ?? 0,
      }];
    },
  });
  return changeResult(deps, context, result, {
    summary: input.on ? 'Chickpea is on in the Channel.' : 'Chickpea is off in the Channel.',
  });
}

type ImportOutput = Out<typeof schemas.importSkillFromGithubOutput>;

export async function importSkillFromGithub(
  deps: FiveZeroDeps,
  input: In<typeof schemas.importSkillFromGithubInput>,
): Promise<ImportOutput> {
  const context = await deps.context();
  const result = await forManagedAgent(deps.service.importSkill({
    context,
    agentId: input.agentId,
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    guideVersion: AGENT_AUTHORING_GUIDE_VERSION,
    ...(input.skillName ? { skillName: input.skillName } : {}),
    ...(input.replaceExisting !== undefined ? { replaceExisting: input.replaceExisting } : {}),
  }));
  if (result.status === 'pending') proposedInstead();
  if (result.status === 'selection_required') {
    return {
      status: 'needs_choice',
      summary: `${result.candidates.length} skills are in that source. Nothing was installed.`,
      nextStep: 'Ask the person which one, then call again with its sourceUrl as source and a new idempotencyKey.',
      choose: result.candidates.map(({ name, description, sourceUrl }) => ({ name, description, sourceUrl })),
    };
  }
  const { agent, version } = await agentSummary(deps, context, input.agentId);
  const skill = { name: result.import.name, description: result.import.description, sourceUrl: result.import.sourceUrl };
  if (result.status === 'replacement_confirmation_required') {
    return {
      status: 'needs_choice',
      summary: `The Agent already has a different skill named ${skill.name}. Nothing changed.`,
      nextStep: 'Ask the person whether to replace it; only if they do, call again with replaceExisting true and a new idempotencyKey.',
      ...(agent ? { agent } : {}),
      skill,
    };
  }
  if (result.status === 'already_installed') {
    return { status: 'unchanged', summary: `${skill.name} is already installed.`, ...(agent ? { agent } : {}), skill };
  }
  const warnings = [
    ...result.import.omittedPaths?.length ? [`Left out, because only instructions install: ${result.import.omittedPaths.join(', ')}.`] : [],
    ...result.import.warnings ?? [],
  ];
  return {
    status: 'done',
    summary: `${result.import.replacedExisting ? 'Replaced' : 'Installed'} the ${skill.name} skill.`,
    ...(agent ? { agent } : {}),
    ...(version ? { version } : {}),
    skill,
    ...(result.undoAvailable ? { undoToken: result.operationId } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}

/** The service proposes only for a Slack turn no person started, which MCP never is. */
function proposedInstead(): never {
  throw new Error('A 5.0 skill change returned a proposal.');
}

type UploadOutput = Out<typeof schemas.uploadSkillFilesOutput>;

export async function uploadSkillFiles(
  deps: FiveZeroDeps,
  input: In<typeof schemas.uploadSkillFilesInput>,
): Promise<UploadOutput> {
  const context = await deps.context();
  const result = await forManagedAgent(deps.service.uploadSkills({
    context,
    agentId: input.agentId,
    files: input.files,
    idempotencyKey: input.idempotencyKey,
    ...(input.replaceExisting !== undefined ? { replaceExisting: input.replaceExisting } : {}),
  }));
  const { agent, version } = await agentSummary(deps, context, input.agentId);
  const names = (skills: ReadonlyArray<{ name: string }>) => skills.map(({ name }) => name);
  const lists = {
    added: names(result.added),
    replaced: names(result.replaced),
    unchanged: names(result.unchanged),
    conflicts: names(result.conflicts),
    leftOut: result.issues.map(({ path, message }) => ({ file: path, why: message })),
  };
  const changed = result.status === 'updated';
  return {
    status: changed ? 'done' : result.conflicts.length ? 'needs_choice' : 'unchanged',
    summary: changed
      ? `Added ${lists.added.length} and replaced ${lists.replaced.length} skill${lists.added.length + lists.replaced.length === 1 ? '' : 's'}.`
      : 'No skill was added or replaced.',
    ...(result.conflicts.length
      ? { nextStep: 'Some skills have the same name and different content. Ask the person; only if they want them replaced, call again with replaceExisting true and a new idempotencyKey.' }
      : {}),
    ...(agent ? { agent } : {}),
    ...(changed && version ? { version } : {}),
    ...(changed && result.undoAvailable ? { undoToken: result.operationId } : {}),
    ...lists,
  };
}

const SKILL_ACTIONS: Record<In<typeof schemas.setAgentSkillInput>['action'], ManageAgentSkillAction> = {
  turn_on: 'enable',
  turn_off: 'disable',
  remove: 'remove',
};

const SKILL_DONE: Record<ManageAgentSkillAction, string> = {
  enable: 'Turned on',
  disable: 'Turned off',
  remove: 'Removed',
};

export async function setAgentSkill(
  deps: FiveZeroDeps,
  input: In<typeof schemas.setAgentSkillInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const action = SKILL_ACTIONS[input.action];
  const result = await forManagedAgent(deps.service.manageAgentSkill({
    context,
    agentId: input.agentId,
    action,
    skillName: input.skill,
    idempotencyKey: input.idempotencyKey,
  }));
  if (result.status === 'pending') proposedInstead();
  const { agent, version } = await agentSummary(deps, context, input.agentId);
  if (result.status === 'unchanged') {
    return { status: 'unchanged', summary: result.presentation.markdown, ...(agent ? { agent } : {}) };
  }
  return {
    status: 'done',
    summary: `${SKILL_DONE[action]} the ${input.skill} skill.`,
    ...(agent ? { agent } : {}),
    ...(version ? { version } : {}),
    ...(result.undoAvailable && result.operationId ? { undoToken: result.operationId } : {}),
  };
}

type Schedule = ManagementRoutineSnapshot['routines'][number];

/** One schedule the caller can see, checked against the version they read. */
export async function readSchedule(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  scheduleId: string,
  version?: string,
): Promise<{ snapshot: ManagementWorkspaceSnapshot; workspaceId: string; schedule: Schedule }> {
  const snapshot = await deps.service.inspectWorkspace(context);
  const workspaceId = slackTeamId(snapshot);
  const { routines } = await deps.service.inspectRoutines(context, { workspaceId, routineId: scheduleId });
  const schedule = routines.find(({ id }) => id === scheduleId);
  if (!schedule) {
    fail('not_found', 'That schedule is gone, or you can\'t see it.', {
      nextStep: 'Call list_schedules for the current scheduleIds.',
    });
  }
  if (version !== undefined) {
    requireVersion(
      versionToken('schedule', schedule.id, schedule.version, context.organizationId),
      version,
      `The schedule ${schedule.name ?? ''}`.trim(),
      'list_schedules',
    );
  }
  return { snapshot, workspaceId, schedule };
}

/** A schedule's place: its Channel, or none for a direct-message schedule. */
function scheduleChannel(schedule: Schedule): { channelId?: string } {
  return schedule.channelId ? { channelId: schedule.channelId } : {};
}

/** connectionIds from get_agent as the connection accounts a schedule's runs need. */
function connectionAccounts(
  snapshot: ManagementWorkspaceSnapshot,
  agentId: string,
  connectionIds: readonly string[] | undefined,
): { requiredConnectionAccountIds?: string[] } {
  if (!connectionIds) return {};
  const accounts = snapshot.agents.find(({ id }) => id === agentId)?.connections ?? [];
  return {
    requiredConnectionAccountIds: connectionIds.map((id) =>
      accounts.find((account) => account.id === id || account.providerId === id)?.id ?? id),
  };
}

export async function saveSchedule(
  deps: FiveZeroDeps,
  input: In<typeof schemas.saveScheduleInput>,
): Promise<ChangeResult> {
  if (input.channelId !== undefined && input.dm !== undefined) {
    fail('invalid_input', 'Send channelId or dm, not both: a schedule posts in one place.');
  }
  if (input.scheduleId === undefined && (input.when.keep || (input.channelId === undefined && input.dm === undefined))) {
    fail('invalid_input', 'A new schedule needs where it posts, a channelId or dm: "me", and a time: cron, once or inMinutes.');
  }
  if (input.scheduleId !== undefined && input.version === undefined) {
    fail('invalid_input', 'Send the version list_schedules returned with the scheduleId.');
  }
  const connectionsNeeded = 'Say which connections the task uses: requiredConnections with connectionIds from get_agent, or [] for none.';
  if (input.scheduleId === undefined && input.requiredConnections === undefined) fail('invalid_input', connectionsNeeded);
  const context = await deps.context();
  const result = await applyChange(deps, context, {
    tool: 'save_schedule',
    args: input,
    operations: async () => {
      const existing = input.scheduleId === undefined
        ? undefined
        : await readSchedule(deps, context, input.scheduleId, input.version);
      if (existing && existing.schedule.taskText !== input.task && input.requiredConnections === undefined) {
        fail('invalid_input', connectionsNeeded);
      }
      if (existing && movesSchedule(existing.schedule, input)) {
        fail('invalid_input', 'A schedule keeps where it posts, so nothing changed.', {
          nextStep: 'To post somewhere else, create a new schedule there and delete this one with delete_schedule.',
        });
      }
      const snapshot = existing?.snapshot ?? await deps.service.inspectWorkspace(context);
      const channelId = input.channelId ?? existing?.schedule.channelId ?? undefined;
      return [{
        itemId: 'save_schedule',
        kind: 'save_routine',
        agentId: input.agentId,
        workspaceId: existing?.workspaceId ?? slackTeamId(snapshot),
        ...(channelId ? { channelId } : {}),
        // Only the caller's own DM: the service finds it from who is signed in.
        ...(!existing && input.dm === 'me' ? { destination: { kind: 'initiator_dm' as const } } : {}),
        ...(existing ? { routineId: existing.schedule.id, expectedVersion: existing.schedule.version } : {}),
        name: input.name,
        description: input.description ?? '',
        taskText: input.task,
        schedule: input.when.keep ? { kind: 'preserve' }
          : input.when.cron !== undefined ? { kind: 'cron', expression: input.when.cron }
            : input.when.once !== undefined ? { kind: 'once', localDateTime: input.when.once }
              : { kind: 'in', minutes: input.when.inMinutes! },
        timezone: input.timezone,
        outputPolicy: input.post === 'always' ? 'post' : 'post_on_change',
        ...connectionAccounts(snapshot, input.agentId, input.requiredConnections),
      }];
    },
  });
  return changeResult(deps, context, result, {
    agentId: input.agentId,
    summary: input.scheduleId ? 'Saved the schedule.'
      : input.dm ? (name) => `Created the schedule. It posts each run in a new thread in your DM with ${name}.`
        : 'Created the schedule. The Agent posts on it from now on.',
  });
}

/** Whether a change names a place other than where the schedule posts now. */
function movesSchedule(schedule: Schedule, input: In<typeof schemas.saveScheduleInput>): boolean {
  if (schedule.destination.kind === 'direct_message') return input.channelId !== undefined;
  return input.dm !== undefined || (input.channelId !== undefined && input.channelId !== schedule.channelId);
}

/** A change to one schedule; its result names the schedule's new version, not its Agent. */
async function scheduleChange(
  deps: FiveZeroDeps,
  tool: string,
  input: { scheduleId: string; version?: string; idempotencyKey: string },
  operation: (found: Awaited<ReturnType<typeof readSchedule>>) => ManagementOperation,
  summary: string,
): Promise<ChangeResult> {
  const context = await deps.context();
  const result = await applyChange(deps, context, {
    tool,
    args: input,
    operations: async () => [operation(await readSchedule(deps, context, input.scheduleId, input.version))],
  });
  return changeResult(deps, context, result, { summary });
}

export async function pauseSchedule(deps: FiveZeroDeps, input: In<typeof schemas.pauseScheduleInput>): Promise<ChangeResult> {
  return scheduleChange(deps, 'pause_schedule', input, ({ workspaceId, schedule }) => ({
    itemId: 'pause_schedule',
    kind: 'control_routine',
    workspaceId,
    ...scheduleChannel(schedule),
    routineId: schedule.id,
    expectedVersion: schedule.version,
    action: input.turnOff ? 'disable' : 'pause',
  }), input.turnOff ? 'Turned the schedule off.' : 'Paused the schedule.');
}

export async function resumeSchedule(deps: FiveZeroDeps, input: In<typeof schemas.resumeScheduleInput>): Promise<ChangeResult> {
  return scheduleChange(deps, 'resume_schedule', input, ({ workspaceId, schedule }) => ({
    itemId: 'resume_schedule',
    kind: 'control_routine',
    workspaceId,
    ...scheduleChannel(schedule),
    routineId: schedule.id,
    expectedVersion: schedule.version,
    action: 'resume',
  }), 'Resumed the schedule. The Agent posts on it again.');
}

export async function runScheduleNow(deps: FiveZeroDeps, input: In<typeof schemas.runScheduleNowInput>): Promise<ChangeResult> {
  return scheduleChange(deps, 'run_schedule_now', input, ({ workspaceId, schedule }) => ({
    itemId: 'run_schedule_now',
    kind: 'run_routine',
    workspaceId,
    ...scheduleChannel(schedule),
    routineId: schedule.id,
  }), 'Started a run of the schedule. The Agent posts its result where the schedule posts.');
}

export async function takeOverSchedule(
  deps: FiveZeroDeps,
  input: In<typeof schemas.takeOverScheduleInput>,
): Promise<ChangeResult> {
  return scheduleChange(deps, 'take_over_schedule', input, ({ snapshot, workspaceId, schedule }) => ({
    itemId: 'take_over_schedule',
    kind: 'take_over_routine',
    workspaceId,
    ...scheduleChannel(schedule),
    routineId: schedule.id,
    expectedVersion: schedule.version,
    ...connectionAccounts(snapshot, schedule.owningAgentId, input.requiredConnections),
  }), 'The schedule now runs as you.');
}

export async function setWorkspaceModel(
  deps: FiveZeroDeps,
  input: In<typeof schemas.setWorkspaceModelInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const result = await applyChange(deps, context, {
    tool: 'set_workspace_model',
    args: input,
    operations: async () => {
      const { workspaceModels } = await deps.service.inspectWorkspace(context);
      if (!workspaceModels) {
        fail('not_allowed', 'Only an Owner or Admin can change the workspace models.', {
          nextStep: 'Tell the person an Owner or Admin can change them in Admin.',
        });
      }
      const current = workspaceModels[input.role];
      requireVersion(
        versionToken('workspace_model', input.role, current.revision, context.organizationId),
        input.version,
        `The workspace ${input.role} model`,
        'list_models',
      );
      return [{
        itemId: 'set_workspace_model',
        kind: 'set_workspace_model',
        role: input.role,
        model: input.model,
        ...(input.effort ? { modelEffort: input.effort } : {}),
        expectedRevision: current.revision,
      }];
    },
  });
  return changeResult(deps, context, result, { summary: `Saved the workspace ${input.role} model.` });
}

/** A setup link for a model provider key; the person types the key on Chickpea's page. */
export async function connectModelProvider(
  deps: FiveZeroDeps,
  input: In<typeof schemas.connectModelProviderInput>,
): Promise<ChangeResult> {
  const setup = await deps.service.prepareProviderSetup(await deps.context(), {
    providerId: input.provider,
    ...(input.replaceExisting !== undefined ? { replaceExisting: input.replaceExisting } : {}),
  });
  return {
    status: 'needs_setup',
    summary: `Open the link to ${setup.replacement ? 'replace' : 'add'} the ${setup.provider.name} key. Only you can use it.`,
    nextStep: 'Give the person the link. Never ask for the key itself.',
    setup: {
      url: setup.handoffUrl,
      setupToken: setup.setupOperationId,
      what: `${setup.provider.name} key`,
      expiresAt: new Date(setup.expiresAt).toISOString(),
    },
  };
}

/** The second call of a confirmation: applies exactly the change the person saw. */
export async function confirmChange(
  deps: FiveZeroDeps,
  input: In<typeof schemas.confirmChangeInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  try {
    // A confirmed undo reads like any other confirmed change: the preview said what it does.
    const confirmed = await deps.service.confirmWorkspaceChange({ context, proposalId: input.confirmToken });
    return await changeResult(deps, context, confirmed, { summary: confirmedSummary(confirmed.confirmed?.preview) });
  } catch (error) {
    if (!(error instanceof ManagementError)) throw error;
    // Another person's token reads as missing, as an unknown one does.
    if (error.code === 'proposal_not_found' || error.code === 'proposal_binding_mismatch') {
      fail('not_found', 'That confirmation isn\'t one of yours, so nothing changed.', {
        nextStep: 'Use the confirmToken from the needs_confirmation result in this conversation.',
      });
    }
    if (error.code === 'proposal_expired') {
      fail('confirmation_expired', 'This confirmation expired, so nothing changed.', { nextStep: EXPIRED_NEXT_STEP });
    }
    if (error.code === 'proposal_stale') fail('changed_since_read', STALE_CONFIRMATION, { nextStep: STALE_NEXT_STEP });
    // What the preview showed changed after it was made, so the person saw something else.
    if (error.code === 'revision_conflict') {
      fail('changed_since_read', 'It changed since the preview, so nothing changed.', {
        nextStep: 'Read it again, then call the tool that proposed the change again with a new idempotencyKey for a fresh preview and confirmToken.',
      });
    }
    throw error;
  }
}

/**
 * The card's way out of a confirmation: its token can never apply after
 * this. A change the token already made is returned as it is.
 */
export async function declineChange(
  deps: FiveZeroDeps,
  input: In<typeof schemas.declineChangeInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  try {
    const made = await deps.service.declineWorkspaceChange({ context, proposalId: input.confirmToken });
    return made
      ? await changeResult(deps, context, made, { summary: 'That change was already made.' })
      : { status: 'unchanged', summary: 'Kept as it is. Nothing changed.' };
  } catch (error) {
    if (error instanceof ManagementError && (error.code === 'proposal_not_found' || error.code === 'proposal_binding_mismatch')) {
      fail('not_found', 'That confirmation isn\'t one of yours, so nothing changed.');
    }
    throw error;
  }
}

/** For a confirmation card that mounts again: whether its buttons can still do anything. */
export async function getConfirmation(
  deps: FiveZeroDeps,
  input: In<typeof schemas.getConfirmationInput>,
): Promise<z.infer<typeof schemas.getConfirmationOutput>> {
  const context = await deps.context();
  try {
    return { status: await deps.service.workspaceChangeStanding({ context, proposalId: input.confirmToken }) };
  } catch (error) {
    if (error instanceof ManagementError && (error.code === 'proposal_not_found' || error.code === 'proposal_binding_mismatch')) {
      fail('not_found', 'That confirmation isn\'t one of yours.');
    }
    throw error;
  }
}

/** Undo is itself a change: it may wait for confirmation when the reverse is destructive. */
export async function undoChange(
  deps: FiveZeroDeps,
  input: In<typeof schemas.undoChangeInput>,
): Promise<ChangeResult> {
  const context = await deps.context();
  const operationId = callOperationId(context, 'undo_change', input);
  try {
    const result = await priorResult(deps, context, operationId) ?? await deps.service.undoWorkspaceChange({
      context,
      operationId: input.undoToken,
      idempotencyKey: input.idempotencyKey,
      undoOperationId: operationId,
      confirmationLifetimeMs: CONFIRMATION_LIFETIME_MS,
    });
    return await changeResult(deps, context, result, result.status === 'completed' ? { summary: 'Undid the change.' } : {});
  } catch (error) {
    if (error instanceof ManagementError && (error.code === 'proposal_stale' || error.code === 'revision_conflict')) {
      fail('changed_since_read', 'It changed again since then, so that change can no longer be undone.', {
        nextStep: 'Read it again and make the change you want directly.',
      });
    }
    if (error instanceof ManagementError && error.code === 'undo_unavailable') {
      fail('nothing_to_undo', 'That change can\'t be undone now.', {
        nextStep: 'Use the undoToken a change returned in this conversation. A creation has none, and each undoToken works once.',
      });
    }
    throw error;
  }
}
