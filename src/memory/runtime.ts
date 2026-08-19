import type { WebClient } from '@slack/web-api';
import { randomBytes, randomUUID } from 'node:crypto';

import { isCloudflareTarget } from '../config/runtime-target.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { getConfigStore, getIdentityStore, getMemoryStateStore } from '../config/state-backend.ts';
import type { ResolvedAssignment } from '../config/types.ts';
import { currentHumanIdentityDirectory } from '../identity/current-directory.ts';
import type { Membership, MembershipAccessOverlay, SlackIdentityBinding } from '../identity/types.ts';
import { resolveSlackCredentials } from '../slack/credentials.ts';
import { effectiveSlackIdentityId } from '../slack/identity-admission.ts';
import { escapeSlackControlCharacters } from '../slack/message-format.ts';
import type { WebClientPresenter } from '../slack/web-client-presenter.ts';
import { memoryEpochThreadKey, memoryQuarantineThreadKey, slackThreadKey } from '../slack/thread-key.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';
import { parseMemoryCommand, type MemoryCommand } from './commands.ts';
import { fitMemorySelectionToPrompt, serializeMemoryPrompt } from './prompt.ts';
import { sha256Hex } from './markdown.ts';
import {
  createMemoryScopeSlack,
  authorizedMemoryScopeFingerprint,
  bindAuthorizedMemoryScope,
  resolveMemoryScope,
  validateMemoryScopeLease,
  verifyMemoryMutationMembership,
  type EnabledMemoryScope,
  type AuthorizedMemoryScope,
  type MemoryScopeSlack,
} from './scope.ts';
import { selectMemoryEntries, type MemorySelection } from './selector.ts';
import { MemoryService } from './service.ts';
import { emitMemoryMetric } from './telemetry.ts';
import {
  MemoryStateError,
  type MemoryEntry,
  type MemoryStateStore,
  type OwnerMemoryEntry,
} from './types.ts';

const MEMORY_CONTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const MEMORY_RETENTION_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const NODE_RECEIPT_RETRY_DELAYS_MS = [100, 500] as const;
const DM_OWNER_WRITE_CONFIRMATION_TTL_MS = 5 * 60 * 1_000;

let lastMemoryRetentionCleanupAt = Number.NEGATIVE_INFINITY;

export interface PreparedMemoryTurn {
  conversationKey: string;
  /** Stable transcript epoch compiled into RuntimePlanV2 before dispatch. */
  memoryEpoch: number;
  promptBlock?: string;
  selection?: MemorySelection<MemoryEntry | OwnerMemoryEntry>;
  footerItems: string[];
  visibilityBarrierAt: number | null;
  /** True when trusted Agent/Channel owners were bound for this interactive turn. */
  ownerBound: boolean;
  validateLease(): Promise<boolean>;
  confirmInjection(): Promise<boolean>;
}

interface MemoryRuntime {
  state: MemoryStateStore;
  slack: MemoryScopeSlack;
  scope: EnabledMemoryScope;
  service: MemoryService;
  botUserId: string;
}

interface OwnerMemoryRuntime {
  state: MemoryStateStore;
  slack: MemoryScopeSlack | null;
  scope: AuthorizedMemoryScope;
  service: MemoryService;
  botUserId: string | null;
  assignment: ResolvedAssignment;
  platformEnv: PlatformEnv | undefined;
}

export interface DmAuthorizedActor {
  binding: SlackIdentityBinding;
  membership: Membership & { role: 'owner' | 'admin' };
  overlay: MembershipAccessOverlay | undefined;
}

export async function handleMemoryCommand(input: {
  turn: NormalizedSlackTurn;
  platformEnv: PlatformEnv | undefined;
  client: WebClient;
  presenter: WebClientPresenter;
  botToken?: string;
  botUserId?: string;
  assignment?: ResolvedAssignment;
}): Promise<boolean> {
  const leadingMention = hasLeadingSlackMention(input.turn.text);
  const resolvedBotUserId = leadingMention
    ? await resolveCommandBotUserId(
        input.platformEnv,
        input.client,
        input.botToken,
        input.botUserId,
      )
    : undefined;
  if (leadingMention && !resolvedBotUserId) return false;
  const command = parseMemoryCommand(input.turn.text, resolvedBotUserId);
  if (!command || command.kind === 'candidate') return false;
  let responseText: string;
  let responseFormat: 'markdown' | 'plain_text' = 'markdown';
  let committedReceipt = false;
  try {
    const state = getMemoryStateStore(input.platformEnv);
    if (input.assignment) {
      const runtime = await resolveOwnerRuntime(
        input.turn, input.assignment, input.platformEnv, input.client, state,
        resolvedBotUserId, input.botToken, input.botUserId,
      );
      responseText = await executeOwnerMemoryCommand(command, input.turn, runtime);
    } else {
      const runtime = await resolveRuntime(
        input.turn, input.platformEnv, input.client, state, resolvedBotUserId,
        input.botToken, input.botUserId,
      );
      responseText = await executeMemoryCommand(command, input.turn, runtime);
    }
    committedReceipt = isReceiptBearingCommand(command);
    emitMemoryMetric('command', { action: command.kind, outcome: 'success' });
  } catch (error) {
    responseText = memoryErrorText(error);
    responseFormat = 'plain_text';
    emitMemoryMetric('command', {
      action: command.kind,
      outcome: 'failure',
      reason: memoryErrorCode(error),
    });
  }
  // Keep delivery outside the domain-error catch. On Node the Events API was
  // already acknowledged before this detached turn ran, so Slack cannot be
  // relied on to resend it. Retry the already-computed receipt in-process;
  // never rerun the committed mutation. Cloudflare's durable turn job retains
  // its existing alarm retry path.
  await deliverMemoryResponse(
    input.presenter,
    responseText,
    responseFormat,
    committedReceipt,
  );
  return true;
}

export async function prepareMemoryTurn(input: {
  turn: NormalizedSlackTurn;
  platformEnv: PlatformEnv | undefined;
  client: WebClient;
  botToken?: string;
  botUserId?: string;
  /** Trusted admission result. Interactive callers must supply it; omitted only by U5 compatibility seams. */
  assignment?: ResolvedAssignment;
}): Promise<PreparedMemoryTurn> {
  const baseKey = slackThreadKey(input.turn);
  try {
    const state = getMemoryStateStore(input.platformEnv);
    if (input.assignment) {
      return await prepareOwnerMemoryTurn({ ...input, assignment: input.assignment }, state, baseKey);
    }
    if (input.turn.source === 'dm_message') return memoryFree(baseKey);
    const runtime = await resolveRuntime(
      input.turn,
      input.platformEnv,
      input.client,
      state,
      undefined,
      input.botToken,
      input.botUserId,
    );
    const entries = await runtime.service.list({ scope: runtime.scope });
    const selection = fitMemorySelectionToPrompt(runtime.scope, selectMemoryEntries({
      entries,
      query: input.turn.text,
      sourceChannelId: runtime.scope.sourceChannelId,
      now: Date.now(),
    }));
    const scopeSignature = memoryScopeSignature(runtime.scope);
    const context = await state.resolveConversationContext({
      baseConversationKey: baseKey,
      scopeSignature,
      selectionFingerprint: selection.fingerprint,
      selected: selection.entries.map(({ entry }) => ({
        entryId: entry.entryId,
        version: entry.version,
      })),
      visibilityBarrierAt: runtime.scope.visibilityBarrierAt,
      expiresAt: Date.now() + MEMORY_CONTEXT_TTL_MS,
    });
    const footerItems = await memoryFooterItems(state, runtime.scope, selection);
    const promptBlock = context.inject
      ? serializeMemoryPrompt(runtime.scope, selection)
      : undefined;
    emitMemoryMetric('selection', {
      candidateCount: entries.length,
      selectedCount: selection.entries.length,
      serializedBytes: promptBlock ? new TextEncoder().encode(promptBlock).byteLength : 0,
      truncated: selection.truncated,
      crossChannelCount: selection.entries.filter(
        ({ entry }) => entry.sourceChannelId !== runtime.scope.sourceChannelId,
      ).length,
      inject: context.inject,
    });
    return {
      conversationKey: memoryEpochThreadKey(baseKey, context.epoch),
      memoryEpoch: context.epoch,
      ...(promptBlock ? { promptBlock } : {}),
      selection,
      footerItems,
      visibilityBarrierAt: runtime.scope.visibilityBarrierAt,
      ownerBound: false,
      confirmInjection: context.inject
        ? () => state.confirmConversationContext({
            baseConversationKey: baseKey,
            epoch: context.epoch,
            selectionFingerprint: context.selectionFingerprint,
          })
        : async () => true,
      validateLease: selection.entries.length === 0
        ? async () => true
        : async () => {
            const valid = await validateMemoryLease(
              input.turn,
              runtime,
              selection,
              scopeSignature,
            );
            emitMemoryMetric('delivery_lease', { outcome: valid ? 'valid' : 'rejected' });
            return valid;
          },
    };
  } catch (error) {
    emitMemoryMetric('quarantine', { reason: memoryErrorCode(error) });
    // Once admission supplied a trusted Agent assignment, owner resolution is
    // an authorization boundary rather than an optional enhancement. Keep the
    // transcript quarantined and make the pre-provider lease fail closed.
    if (input.assignment) {
      const quarantinedKey = memoryQuarantineThreadKey(baseKey, input.turn.eventId);
      return {
        ...memoryFree(quarantinedKey, Number.MAX_SAFE_INTEGER),
        conversationKey: quarantinedKey,
        memoryEpoch: Number.MAX_SAFE_INTEGER,
        ownerBound: true,
        validateLease: async () => false,
      };
    }
    return {
      ...memoryFree(
        memoryQuarantineThreadKey(baseKey, input.turn.eventId),
        Number.MAX_SAFE_INTEGER,
      ),
      conversationKey: memoryQuarantineThreadKey(baseKey, input.turn.eventId),
      memoryEpoch: Number.MAX_SAFE_INTEGER,
    };
  }
}

async function prepareOwnerMemoryTurn(
  input: {
    turn: NormalizedSlackTurn;
    assignment: ResolvedAssignment;
    platformEnv: PlatformEnv | undefined;
    client: WebClient;
    botToken?: string;
    botUserId?: string;
  },
  state: MemoryStateStore,
  baseKey: string,
): Promise<PreparedMemoryTurn> {
  const runtime = await resolveOwnerRuntime(
    input.turn, input.assignment, input.platformEnv, input.client, state,
    undefined, input.botToken, input.botUserId,
  );
  const entries = await runtime.service.list({ scope: runtime.scope });
  const selection = fitMemorySelectionToPrompt(
    runtime.scope,
    selectMemoryEntries({ entries, query: input.turn.text, now: Date.now() }),
  );
  const scopeSignature = authorizedMemoryScopeFingerprint(runtime.scope);
  const context = await state.resolveConversationContext({
    baseConversationKey: baseKey,
    scopeSignature,
    selectionFingerprint: selection.fingerprint,
    selected: selection.entries.map(({ entry }) => ({ entryId: entry.entryId, version: entry.version })),
    visibilityBarrierAt: null,
    expiresAt: Date.now() + MEMORY_CONTEXT_TTL_MS,
  });
  const promptBlock = context.inject ? serializeMemoryPrompt(runtime.scope, selection) : undefined;
  emitMemoryMetric('selection', {
    candidateCount: entries.length,
    selectedCount: selection.entries.length,
    serializedBytes: promptBlock ? new TextEncoder().encode(promptBlock).byteLength : 0,
    truncated: selection.truncated,
    agentCount: selection.entries.filter(({ entry }) => entry.ownerKind === 'agent').length,
    channelCount: selection.entries.filter(({ entry }) => entry.ownerKind === 'channel').length,
    inject: context.inject,
  });
  return {
    conversationKey: memoryEpochThreadKey(baseKey, context.epoch),
    memoryEpoch: context.epoch,
    ...(promptBlock ? { promptBlock } : {}),
    selection,
    footerItems: ownerMemoryFooterItems(selection),
    visibilityBarrierAt: null,
    ownerBound: true,
    confirmInjection: context.inject
      ? () => state.confirmConversationContext({
          baseConversationKey: baseKey,
          epoch: context.epoch,
          selectionFingerprint: context.selectionFingerprint,
        })
      : async () => true,
    validateLease: async () => {
      const valid = await validateOwnerMemoryLease(input.turn, runtime, selection, scopeSignature);
      emitMemoryMetric('delivery_lease', { outcome: valid ? 'valid' : 'rejected' });
      return valid;
    },
  };
}

async function resolveOwnerRuntime(
  turn: NormalizedSlackTurn,
  assignment: ResolvedAssignment,
  platformEnv: PlatformEnv | undefined,
  client: WebClient,
  state: MemoryStateStore,
  resolvedBotUserId?: string,
  resolvedBotToken?: string,
  identityBotUserId?: string,
): Promise<OwnerMemoryRuntime> {
  if (
    assignment.workspaceId !== turn.workspaceId ||
    assignment.channelId !== turn.channelId ||
    assignment.agentId !== assignment.agent.id ||
    !assignment.agent.enabled
  ) {
    throw new MemoryStateError('memory_owner_invalid', 'The admitted Agent assignment is unavailable.');
  }
  const liveConfig = getConfigStore(platformEnv);
  const liveFrozenAgent = await liveConfig.getAgent(assignment.agentId);
  if (!liveFrozenAgent.enabled) {
    throw new MemoryStateError('memory_owner_unavailable', 'The admitted Agent is disabled.');
  }
  if (turn.source !== 'dm_message') {
    const [channel, liveAssignment] = await Promise.all([
      liveConfig.getChannel(turn.workspaceId, turn.channelId),
      liveConfig.getAssignment(turn.workspaceId, turn.channelId),
    ]);
    if (!channel || channel.lifecycle !== 'active' || !liveAssignment) {
      throw new MemoryStateError('memory_owner_unavailable', 'The Channel placement is unavailable.');
    }
  }
  await runMemoryRetentionHousekeeping(state);
  const agentOwner = await state.ensureOwner({
    workspaceId: turn.workspaceId,
    ownerKind: 'agent',
    ownerId: assignment.agentId,
  });
  if (turn.source === 'dm_message') {
    return {
      state,
      slack: null,
      scope: bindAuthorizedMemoryScope({ surface: 'dm', workspaceId: turn.workspaceId, agentOwner }),
      service: new MemoryService(state),
      botUserId: identityBotUserId ?? null,
      assignment,
      platformEnv,
    };
  }
  const credentials = resolvedBotToken
    ? { botToken: resolvedBotToken, botUserId: identityBotUserId }
    : await resolveSlackCredentials(platformEnv);
  if (!credentials.botToken) {
    throw new MemoryStateError('memory_slack_unavailable', 'Slack memory is unavailable.');
  }
  let botUserId = resolvedBotUserId ?? credentials.botUserId;
  if (!botUserId) {
    const auth = await client.auth.test();
    botUserId = typeof auth.user_id === 'string' ? auth.user_id : undefined;
  }
  if (!botUserId) {
    throw new MemoryStateError('memory_slack_unavailable', 'Slack memory is unavailable.');
  }
  const channelOwner = await state.ensureOwner({
    workspaceId: turn.workspaceId,
    ownerKind: 'channel',
    ownerId: turn.channelId,
  });
  return {
    state,
    slack: createMemoryScopeSlack(credentials.botToken, turn.workspaceId),
    scope: bindAuthorizedMemoryScope({
      surface: 'channel',
      workspaceId: turn.workspaceId,
      agentOwner,
      channelOwner,
      writeOwner: channelOwner,
    }),
    service: new MemoryService(state),
    botUserId,
    assignment,
    platformEnv,
  };
}

async function validateOwnerMemoryLease(
  turn: NormalizedSlackTurn,
  runtime: OwnerMemoryRuntime,
  selection: MemorySelection<OwnerMemoryEntry>,
  expectedScopeSignature: string,
): Promise<boolean> {
  try {
    if (authorizedMemoryScopeFingerprint(runtime.scope) !== expectedScopeSignature) return false;
    const config = getConfigStore(runtime.platformEnv);
    const frozenAgent = await config.getAgent(runtime.assignment.agentId);
    if (!frozenAgent.enabled) return false;
    const identity = await config.getSlackIdentity(effectiveSlackIdentityId(runtime.assignment));
    if (
      (identity.lifecycle !== 'connected' && identity.lifecycle !== 'degraded') ||
      (identity.teamId !== undefined && identity.teamId !== turn.workspaceId) ||
      (runtime.botUserId !== null && identity.botUserId !== undefined && identity.botUserId !== runtime.botUserId)
    ) return false;
    if (turn.source === 'dm_message') {
      if (identity.dmState !== 'on' || identity.dmAgentId !== runtime.assignment.agentId) return false;
    } else {
      const [channel, liveAssignment] = await Promise.all([
        config.getChannel(turn.workspaceId, turn.channelId),
        config.getAssignment(turn.workspaceId, turn.channelId),
      ]);
      if (!channel || channel.lifecycle !== 'active' || !liveAssignment) return false;
      const liveAgent = await config.getAgent(liveAssignment.agentId);
      if (!liveAgent.enabled || !runtime.slack || !runtime.botUserId) return false;
      if (!(await validateOwnerSlackLease(turn, runtime.slack, runtime.botUserId))) return false;
    }
    const currentOwners = await Promise.all(
      runtime.scope.readOwners.map((owner) => runtime.state.getOwner(owner.storeId)),
    );
    if (currentOwners.some((owner, index) => {
      const expected = runtime.scope.readOwners[index]!;
      return !owner || owner.lifecycle !== 'active' || owner.resetEpoch !== expected.resetEpoch ||
        owner.ownerKind !== expected.ownerKind || owner.ownerId !== expected.ownerId;
    })) return false;
    const current = await Promise.all(selection.entries.map(({ entry }) => runtime.state.getOwnerEntry(entry.entryId)));
    const allowedStores = new Set(runtime.scope.readOwners.map(({ storeId }) => storeId));
    const now = Date.now();
    return current.every((entry, index) => {
      const selected = selection.entries[index]!.entry;
      return Boolean(entry && entry.version === selected.version && entry.contentHash === selected.contentHash &&
        entry.ownerKind === selected.ownerKind && entry.ownerId === selected.ownerId &&
        (entry.status === 'active' || entry.status === 'stale') &&
        (entry.expiresAt === null || entry.expiresAt > now) && allowedStores.has(entry.storeId));
    });
  } catch {
    return false;
  }
}

async function validateOwnerSlackLease(
  turn: NormalizedSlackTurn,
  slack: MemoryScopeSlack,
  botUserId: string,
): Promise<boolean> {
  const [conversation, actor, members] = await Promise.all([
    slack.conversation(turn.channelId),
    slack.user(turn.userId),
    slack.members(turn.channelId),
  ]);
  const facts = conversation.facts;
  return Boolean(
    conversation.ok && facts && facts.id === turn.channelId &&
    (!facts.teamId || facts.teamId === turn.workspaceId) && !facts.archived && !facts.frozen &&
    !facts.shared && !facts.externallyShared && !facts.organizationShared && !facts.pendingShared &&
    !facts.im && !facts.mpim && facts.member && actor.ok && actor.user &&
    members.ok && members.ids.includes(turn.userId) && members.ids.includes(botUserId),
  );
}

function ownerMemoryFooterItems(selection: MemorySelection<OwnerMemoryEntry>): string[] {
  return selection.entries.map(({ entry }) =>
    `Memory supplied: ${entry.slug} (${entry.ownerKind === 'agent' ? 'Agent' : 'Channel'} ${escapeSlackControlCharacters(entry.ownerId)})`
  );
}

async function resolveRuntime(
  turn: NormalizedSlackTurn,
  platformEnv: PlatformEnv | undefined,
  client: WebClient,
  state: MemoryStateStore,
  resolvedBotUserId?: string,
  resolvedBotToken?: string,
  identityBotUserId?: string,
): Promise<MemoryRuntime> {
  await runMemoryRetentionHousekeeping(state);
  const credentials = resolvedBotToken
    ? { botToken: resolvedBotToken, botUserId: identityBotUserId }
    : await resolveSlackCredentials(platformEnv);
  if (!credentials.botToken) {
    throw new MemoryStateError('memory_slack_unavailable', 'Slack memory is unavailable.');
  }
  let botUserId = resolvedBotUserId ?? credentials.botUserId;
  if (!botUserId) {
    const auth = await client.auth.test();
    botUserId = typeof auth.user_id === 'string' ? auth.user_id : undefined;
  }
  if (!botUserId) {
    throw new MemoryStateError('memory_slack_unavailable', 'Slack memory is unavailable.');
  }
  const slack = createMemoryScopeSlack(credentials.botToken, turn.workspaceId);
  const scope = await resolveMemoryScope(
    {
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      actorId: turn.userId,
      botUserId,
      observedAt: Date.now(),
    },
    { slack, state },
  );
  if (!scope.enabled) {
    throw new MemoryStateError(`memory_${scope.reason}`, 'Memory is unavailable in this channel.');
  }
  return { state, slack, scope, service: new MemoryService(state), botUserId };
}

async function executeMemoryCommand(
  command: MemoryCommand,
  turn: NormalizedSlackTurn,
  runtime: MemoryRuntime,
): Promise<string> {
  if (command.kind === 'invalid') return command.hint;
  if (command.kind === 'help') return memoryHelpText();
  if (command.kind === 'list') {
    const entries = (await runtime.service.list({ scope: runtime.scope })).filter(
      (entry) => entry.sourceChannelId === runtime.scope.sourceChannelId,
    );
    if (entries.length === 0) {
      return `No ${scopeLabel(runtime.scope)} entries are saved for #${escapeSlackControlCharacters(runtime.scope.displayName)}.`;
    }
    return [
      `Saved ${scopeLabel(runtime.scope)} entries for #${escapeSlackControlCharacters(runtime.scope.displayName)}:`,
      ...entries.map(
        (entry) =>
          `- \`${entry.slug}\` (v${entry.version}, ${entry.type}) — ${escapeSlackControlCharacters(entry.description)}`,
      ),
    ].join('\n');
  }
  if (command.kind === 'show') {
    const entry = await currentSourceEntry(runtime, command.target);
    return [
      `### ${entry.slug}`,
      `Type: ${entry.type} · Version: ${entry.version} · ${scopeLabel(runtime.scope)}`,
      '',
      escapeSlackControlCharacters(entry.description),
      '',
      escapeSlackControlCharacters(entry.body),
    ].join('\n');
  }

  await requireFreshMembership(turn, runtime);
  const idempotencyKey = `memory:slack:${turn.workspaceId}:${turn.eventId}:0`;
  if (command.kind === 'remember') {
    const created = await runtime.service.remember({
      scope: runtime.scope,
      workspaceId: turn.workspaceId,
      actorId: turn.userId,
      eventId: turn.eventId,
      threadTs: turn.threadTs,
      messageTs: turn.messageTs,
      name: command.name,
      description: command.description,
      type: 'fact',
      body: command.body,
      idempotencyKey,
    });
    return `Saved ${scopeLabel(runtime.scope)} \`${created.entry.slug}\` (v${created.entry.version}).`;
  }
  if (command.kind === 'update') {
    const current = await currentWritableEntry(runtime, command.target);
    const updated = await runtime.service.update({
      scope: runtime.scope,
      actorId: turn.userId,
      eventId: turn.eventId,
      threadTs: turn.threadTs,
      messageTs: turn.messageTs,
      target: current.entryId,
      expectedVersion: current.version,
      description: command.description,
      type: current.type,
      body: command.body,
      idempotencyKey,
    });
    return `Updated ${scopeLabel(runtime.scope)} \`${updated.entry.slug}\` to v${updated.entry.version}.`;
  }
  if (command.kind === 'merge') {
    const merged = await runtime.service.merge({
      scope: runtime.scope,
      workspaceId: turn.workspaceId,
      actorId: turn.userId,
      eventId: turn.eventId,
      threadTs: turn.threadTs,
      messageTs: turn.messageTs,
      targets: command.targets.map((target) => ({ target })),
      name: command.name,
      description: command.description,
      type: 'fact',
      body: command.body,
      idempotencyKey,
    });
    return `Merged ${command.targets.length} entries into \`${merged.entry.slug}\` (v1).`;
  }
  if (command.kind === 'forget_request') {
    const challenge = await runtime.service.requestForget({
      scope: runtime.scope,
      actorId: turn.userId,
      target: command.target,
      expectedVersion: (await forgetTarget(runtime, command.target)).version,
    });
    return [
      `This permanently removes \`${challenge.entry.slug}\` and its recoverable revision content.`,
      `Confirm within five minutes with: \`!forget confirm ${challenge.token}\``,
      'There is no recovery window; export first if you may need the content later.',
    ].join('\n');
  }
  if (command.kind === 'forget_confirm') {
    const forgotten = await runtime.service.confirmForget({
      scope: runtime.scope,
      actorId: turn.userId,
      eventId: turn.eventId,
      confirmationToken: command.token,
      idempotencyKey,
    });
    return `Forgot \`${forgotten.entry.slug}\`. Its canonical body and revision content were removed.`;
  }
  if (command.kind === 'report') {
    const entry = await qualifiedEntry(runtime, command.target);
    await runtime.service.reportReview({
      scope: runtime.scope,
      qualifiedTarget: command.target,
      expectedVersion: entry.version,
      reason: command.reason,
      actorId: turn.userId,
      idempotencyKey,
    });
    return `Reported \`${command.target}\` as ${command.reason} for admin review.`;
  }
  return memoryHelpText();
}

async function executeOwnerMemoryCommand(
  command: MemoryCommand,
  turn: NormalizedSlackTurn,
  runtime: OwnerMemoryRuntime,
): Promise<string> {
  if (command.kind === 'invalid') return command.hint;
  if (command.kind === 'help') return ownerMemoryHelpText(runtime.scope.surface);
  const readableEntries = await runtime.service.list({ scope: runtime.scope });
  if (command.kind === 'list') {
    if (readableEntries.length === 0) {
      return runtime.scope.surface === 'dm'
        ? 'No Agent memory files are saved for this Agent.'
        : 'No memory files are saved here.';
    }
    const label = runtime.scope.surface === 'dm' ? 'Agent' : 'available';
    return [
      `Saved ${label} memory files:`,
      ...readableEntries.map((entry) =>
        `- \`${entry.slug}\` (v${entry.version}, ${entry.type}, ${entry.ownerKind}) — ${escapeSlackControlCharacters(entry.description)}`),
    ].join('\n');
  }
  if (command.kind === 'show') {
    const entry = resolveOwnerCommandEntry(readableEntries, command.target);
    return [
      `### ${entry.slug}`,
      `Type: ${entry.type} · Version: ${entry.version} · ${entry.ownerKind === 'agent' ? 'Agent' : 'Channel'} memory`,
      '', escapeSlackControlCharacters(entry.description), '', escapeSlackControlCharacters(entry.body),
    ].join('\n');
  }
  if (runtime.scope.surface === 'dm') {
    return command.kind === 'owner_write_confirm'
      ? confirmDmOwnerMemoryWrite(command.token, turn, runtime)
      : requestDmOwnerMemoryWrite(command, turn, runtime);
  }
  if (command.kind === 'owner_write_confirm') return ownerMemoryHelpText(runtime.scope.surface);
  const writeOwner = runtime.scope.writeOwner;
  if (!writeOwner || writeOwner.ownerKind !== 'channel' || writeOwner.ownerId !== turn.channelId) {
    throw new MemoryStateError('memory_owner_invalid', 'Channel memory write ownership is unavailable.');
  }
  const entries = readableEntries.filter(
    (entry) => entry.storeId === writeOwner.storeId,
  );
  if (!runtime.slack || !(await verifyMemoryMutationMembership(turn.channelId, turn.userId, runtime.slack))) {
    throw new MemoryStateError('memory_membership_unknown', 'Slack membership could not be verified; no memory change was made.');
  }
  const idempotencyKey = `memory:slack:${turn.workspaceId}:${turn.eventId}:0`;
  if (command.kind === 'remember') {
    const created = await runtime.service.remember({
      scope: runtime.scope, workspaceId: turn.workspaceId, actorId: turn.userId,
      eventId: turn.eventId, threadTs: turn.threadTs, messageTs: turn.messageTs,
      name: command.name, description: command.description, type: 'fact', body: command.body,
      idempotencyKey,
    });
    return `Saved Channel memory \`${created.entry.slug}\` (v${created.entry.version}).`;
  }
  if (command.kind === 'update') {
    const current = resolveOwnerCommandEntry(entries, command.target);
    const updated = await runtime.service.update({
      scope: runtime.scope, actorId: turn.userId, eventId: turn.eventId,
      threadTs: turn.threadTs, messageTs: turn.messageTs, target: current.entryId,
      expectedVersion: current.version, description: command.description, type: current.type,
      body: command.body, idempotencyKey,
    });
    return `Updated Channel memory \`${updated.entry.slug}\` to v${updated.entry.version}.`;
  }
  if (command.kind === 'merge') {
    const merged = await runtime.service.merge({
      scope: runtime.scope, workspaceId: turn.workspaceId, actorId: turn.userId,
      eventId: turn.eventId, threadTs: turn.threadTs, messageTs: turn.messageTs,
      targets: command.targets.map((target) => ({ target })), name: command.name,
      description: command.description, type: 'fact', body: command.body, idempotencyKey,
    });
    return `Merged ${command.targets.length} files into \`${merged.entry.slug}\` (v1).`;
  }
  if (command.kind === 'forget_request') {
    const current = resolveOwnerCommandEntry(entries, command.target);
    const challenge = await runtime.service.requestForget({
      scope: runtime.scope, actorId: turn.userId, target: current.entryId,
      expectedVersion: current.version,
    });
    return [
      `This permanently removes \`${challenge.entry.slug}\` and its recoverable revision content.`,
      `Confirm within five minutes with: \`!forget confirm ${challenge.token}\``,
      'There is no recovery window; export first if you may need the content later.',
    ].join('\n');
  }
  if (command.kind === 'forget_confirm') {
    const forgotten = await runtime.service.confirmForget({
      scope: runtime.scope, actorId: turn.userId, eventId: turn.eventId,
      confirmationToken: command.token, idempotencyKey,
    });
    return `Forgot \`${forgotten.entry.slug}\`. Its canonical body and revision content were removed.`;
  }
  if (command.kind === 'report') {
    const target = command.target.includes('/') ? command.target : `${writeOwner.ownerId}/${command.target}`;
    const [, slug] = target.split('/');
    const entry = resolveOwnerCommandEntry(entries, slug ?? '');
    await runtime.service.reportReview({
      scope: runtime.scope, qualifiedTarget: `${writeOwner.ownerId}/${entry.slug}`,
      expectedVersion: entry.version, reason: command.reason, actorId: turn.userId, idempotencyKey,
    });
    return `Reported \`${entry.slug}\` as ${command.reason} for admin review.`;
  }
  return ownerMemoryHelpText(runtime.scope.surface);
}

async function requestDmOwnerMemoryWrite(
  command: MemoryCommand,
  turn: NormalizedSlackTurn,
  runtime: OwnerMemoryRuntime,
): Promise<string> {
  const actor = await resolveAuthorizedAgentMemoryActor(turn, runtime.platformEnv);
  if (!actor) return 'This Slack account is not an active Chickpea Owner or Admin.';
  const identityId = effectiveSlackIdentityId(runtime.assignment);
  const config = getConfigStore(runtime.platformEnv);
  const slackIdentity = await config.getSlackIdentity(identityId);
  const agentOwner = runtime.scope.readOwners[0];
  if (!agentOwner || agentOwner.ownerKind !== 'agent' || agentOwner.ownerId !== runtime.assignment.agentId) {
    throw new MemoryStateError('memory_owner_invalid', 'DM Agent memory ownership is unavailable.');
  }
  const commandJson = canonicalDmMutation(command);
  const mutationDigest = sha256(commandJson);
  const token = randomBytes(24).toString('base64url');
  const now = Date.now();
  await runtime.state.createOwnerWriteChallenge({
    challengeId: `owner_write_${randomUUID()}`,
    tokenHash: sha256(token),
    workspaceId: turn.workspaceId,
    slackUserId: turn.userId,
    slackIdentityId: identityId,
    slackIdentityRevision: slackIdentity.connectionRevision,
    actorBindingId: actor.binding.id,
    actorBindingRevision: actor.binding.revision,
    userId: actor.binding.userId,
    organizationId: actor.membership.organizationId,
    membershipId: actor.membership.id,
    membershipRole: actor.membership.role,
    membershipUpdatedAt: actor.membership.updatedAt,
    membershipAccessVersion: actor.overlay?.membershipVersion ?? 0,
    agentId: runtime.assignment.agentId,
    agentName: runtime.assignment.agent.name,
    storeId: agentOwner.storeId,
    ownerResetEpoch: agentOwner.resetEpoch,
    commandJson,
    mutationDigest,
    expiresAt: now + DM_OWNER_WRITE_CONFIRMATION_TTL_MS,
    consumedAt: null,
  });
  return [
    `This will save to Agent ${escapeSlackControlCharacters(runtime.assignment.agent.name)}; every channel where it works may use it.`,
    `Confirm within five minutes with: \`!memory confirm ${token}\``,
  ].join('\n');
}

async function confirmDmOwnerMemoryWrite(
  token: string,
  turn: NormalizedSlackTurn,
  runtime: OwnerMemoryRuntime,
): Promise<string> {
  const tokenHash = sha256(token);
  let challenge = await runtime.state.getOwnerWriteChallenge(tokenHash, turn.userId);
  if (!challenge || !(await validateDmOwnerWriteChallenge(challenge, turn, runtime))) {
    throw new MemoryStateError('memory_confirmation_invalid', 'Agent memory confirmation is unavailable or expired.');
  }
  challenge = await runtime.state.consumeOwnerWriteChallenge(tokenHash, turn.userId, Date.now());
  if (!challenge || !(await validateDmOwnerWriteChallenge(challenge, turn, runtime))) {
    throw new MemoryStateError('memory_confirmation_invalid', 'Agent memory confirmation is unavailable or expired.');
  }
  const command = parseCanonicalDmMutation(challenge.commandJson, challenge.mutationDigest);
  const owner = runtime.scope.readOwners[0]!;
  const confirmedScope = bindAuthorizedMemoryScope({
    surface: 'dm', workspaceId: turn.workspaceId, agentOwner: owner, writeOwner: owner,
  });
  return executeConfirmedDmOwnerMutation(
    command,
    turn,
    { ...runtime, scope: confirmedScope },
    `memory:slack-dm-owner:${challenge.challengeId}`,
  );
}

async function validateDmOwnerWriteChallenge(
  challenge: import('./types.ts').OwnerMemoryWriteChallenge,
  turn: NormalizedSlackTurn,
  runtime: OwnerMemoryRuntime,
): Promise<boolean> {
  if (challenge.workspaceId !== turn.workspaceId || challenge.slackUserId !== turn.userId ||
      challenge.agentId !== runtime.assignment.agentId || challenge.expiresAt < Date.now()) return false;
  const owner = runtime.scope.readOwners[0];
  if (!owner || owner.ownerKind !== 'agent' || owner.ownerId !== challenge.agentId ||
      owner.storeId !== challenge.storeId || owner.resetEpoch !== challenge.ownerResetEpoch ||
      owner.lifecycle !== 'active') return false;
  const config = getConfigStore(runtime.platformEnv);
  const [agent, slackIdentity] = await Promise.all([
    config.getAgent(challenge.agentId), config.getSlackIdentity(challenge.slackIdentityId),
  ]);
  if (!agent.enabled || effectiveSlackIdentityId(runtime.assignment) !== challenge.slackIdentityId ||
      slackIdentity.connectionRevision !== challenge.slackIdentityRevision ||
      slackIdentity.teamId !== turn.workspaceId || slackIdentity.dmState !== 'on' ||
      slackIdentity.dmAgentId !== challenge.agentId ||
      (slackIdentity.lifecycle !== 'connected' && slackIdentity.lifecycle !== 'degraded')) return false;
  const actor = await resolveAuthorizedAgentMemoryActor(turn, runtime.platformEnv);
  return !!actor && actor.binding.id === challenge.actorBindingId &&
    actor.binding.revision === challenge.actorBindingRevision &&
    actor.binding.userId === challenge.userId && actor.membership.organizationId === challenge.organizationId &&
    actor.membership.id === challenge.membershipId && actor.membership.role === challenge.membershipRole &&
    actor.membership.updatedAt === challenge.membershipUpdatedAt &&
    (actor.overlay?.membershipVersion ?? 0) === challenge.membershipAccessVersion &&
    sha256(challenge.commandJson) === challenge.mutationDigest;
}

export async function resolveAuthorizedAgentMemoryActor(
  turn: Pick<NormalizedSlackTurn, 'workspaceId' | 'userId'>,
  platformEnv: PlatformEnv | undefined,
): Promise<DmAuthorizedActor | undefined> {
  const identity = getIdentityStore(platformEnv);
  const resolution = await identity.resolveSlackIdentity(turn.workspaceId, turn.userId);
  const binding = resolution?.binding;
  if (!binding) return undefined;
  const directory = await currentHumanIdentityDirectory(identity, platformEnv);
  if (!directory) throw new MemoryStateError('memory_actor_unavailable', 'Admin identity is unavailable.');
  const [organization, membership] = await Promise.all([
    directory.getOrganization(), directory.getMembership(binding.membershipId),
  ]);
  const overlay = await identity.getMembershipAccessOverlay(binding.membershipId);
  if (!organization || organization.id !== binding.organizationId || !membership || membership.userId !== binding.userId ||
      membership.organizationId !== binding.organizationId || membership.status !== 'active' ||
      (membership.role !== 'owner' && membership.role !== 'admin') ||
      (overlay && (overlay.organizationId !== membership.organizationId || overlay.accessStatus !== 'active'))) {
    throw new MemoryStateError('memory_actor_forbidden', 'Only an active Owner or Admin can change Agent memory from Slack.');
  }
  return { binding, membership: membership as Membership & { role: 'owner' | 'admin' }, overlay };
}

async function executeConfirmedDmOwnerMutation(
  command: MemoryCommand,
  turn: NormalizedSlackTurn,
  runtime: OwnerMemoryRuntime,
  idempotencyKey: string,
): Promise<string> {
  const writeOwner = runtime.scope.writeOwner!;
  const entries = (await runtime.service.list({ scope: runtime.scope })).filter((entry) => entry.storeId === writeOwner.storeId);
  if (command.kind === 'remember') {
    const created = await runtime.service.remember({
      scope: runtime.scope, workspaceId: turn.workspaceId, actorId: turn.userId,
      eventId: turn.eventId, threadTs: turn.threadTs, messageTs: turn.messageTs,
      name: command.name, description: command.description, type: 'fact', body: command.body,
      idempotencyKey,
    });
    return `Saved Agent memory \`${created.entry.slug}\` (v${created.entry.version}).`;
  }
  if (command.kind === 'update') {
    const current = resolveOwnerCommandEntry(entries, command.target);
    const updated = await runtime.service.update({
      scope: runtime.scope, actorId: turn.userId, eventId: turn.eventId,
      threadTs: turn.threadTs, messageTs: turn.messageTs, target: current.entryId,
      expectedVersion: current.version, description: command.description, type: current.type,
      body: command.body, idempotencyKey,
    });
    return `Updated Agent memory \`${updated.entry.slug}\` to v${updated.entry.version}.`;
  }
  if (command.kind === 'merge') {
    const merged = await runtime.service.merge({
      scope: runtime.scope, workspaceId: turn.workspaceId, actorId: turn.userId,
      eventId: turn.eventId, threadTs: turn.threadTs, messageTs: turn.messageTs,
      targets: command.targets.map((target) => ({ target })), name: command.name,
      description: command.description, type: 'fact', body: command.body, idempotencyKey,
    });
    return `Merged ${command.targets.length} Agent memory files into \`${merged.entry.slug}\` (v1).`;
  }
  if (command.kind === 'forget_request') {
    const current = resolveOwnerCommandEntry(entries, command.target);
    const challenge = await runtime.service.requestForget({ scope: runtime.scope, actorId: turn.userId, target: current.entryId, expectedVersion: current.version });
    return [`This permanently removes Agent memory \`${challenge.entry.slug}\` and its recoverable revision content.`, `Confirm within five minutes with: \`!forget confirm ${challenge.token}\``].join('\n');
  }
  if (command.kind === 'forget_confirm') {
    const forgotten = await runtime.service.confirmForget({ scope: runtime.scope, actorId: turn.userId, eventId: turn.eventId, confirmationToken: command.token, idempotencyKey });
    return `Forgot Agent memory \`${forgotten.entry.slug}\`.`;
  }
  if (command.kind === 'report') {
    const current = resolveOwnerCommandEntry(entries, command.target);
    await runtime.service.reportReview({ scope: runtime.scope, qualifiedTarget: `${writeOwner.ownerId}/${current.slug}`, expectedVersion: current.version, reason: command.reason, actorId: turn.userId, idempotencyKey });
    return `Reported Agent memory \`${current.slug}\` as ${command.reason} for admin review.`;
  }
  throw new MemoryStateError('memory_confirmation_invalid', 'Agent memory confirmation is invalid.');
}

function canonicalDmMutation(command: MemoryCommand): string {
  if (command.kind === 'remember' && allStrings(command.name, command.description, command.body)) {
    return JSON.stringify({
      kind: command.kind,
      name: command.name,
      description: command.description,
      body: command.body,
    });
  }
  if (command.kind === 'update' && allStrings(command.target, command.description, command.body)) {
    return JSON.stringify({
      kind: command.kind,
      target: command.target,
      description: command.description,
      body: command.body,
    });
  }
  if (command.kind === 'merge' && Array.isArray(command.targets) && command.targets.length >= 2 &&
      command.targets.every((target) => typeof target === 'string') &&
      allStrings(command.name, command.description, command.body)) {
    return JSON.stringify({
      kind: command.kind,
      targets: [...command.targets],
      name: command.name,
      description: command.description,
      body: command.body,
    });
  }
  if (command.kind === 'forget_request' && allStrings(command.target)) {
    return JSON.stringify({ kind: command.kind, target: command.target });
  }
  if (command.kind === 'forget_confirm' && allStrings(command.token)) {
    return JSON.stringify({ kind: command.kind, token: command.token });
  }
  if (command.kind === 'report' && allStrings(command.target) &&
      ['stale', 'incorrect', 'unsafe', 'unclear'].includes(command.reason)) {
    return JSON.stringify({ kind: command.kind, target: command.target, reason: command.reason });
  }
  throw new MemoryStateError('memory_confirmation_invalid', 'Agent memory confirmation is invalid.');
}

function parseCanonicalDmMutation(commandJson: string, expectedDigest: string): MemoryCommand {
  if (sha256(commandJson) !== expectedDigest) throw new MemoryStateError('memory_confirmation_invalid', 'Agent memory confirmation is invalid.');
  try {
    const command = JSON.parse(commandJson) as MemoryCommand;
    if (canonicalDmMutation(command) !== commandJson) throw new Error('not canonical');
    return command;
  } catch {
    throw new MemoryStateError('memory_confirmation_invalid', 'Agent memory confirmation is invalid.');
  }
}

function allStrings(...values: unknown[]): boolean {
  return values.every((value) => typeof value === 'string');
}

function sha256(value: string): string {
  return sha256Hex(value);
}

function resolveOwnerCommandEntry(entries: readonly OwnerMemoryEntry[], target: string): OwnerMemoryEntry {
  const matches = entries.filter((entry) => entry.entryId === target || entry.slug === target);
  if (matches.length !== 1) {
    throw new MemoryStateError(
      matches.length > 1 ? 'memory_target_ambiguous' : 'memory_entry_not_found',
      matches.length > 1 ? 'Memory name is ambiguous.' : 'Memory entry was not found.',
    );
  }
  return matches[0]!;
}

async function currentSourceEntry(runtime: MemoryRuntime, target: string): Promise<MemoryEntry> {
  const entries = (await runtime.service.list({ scope: runtime.scope })).filter(
    (entry) => entry.sourceChannelId === runtime.scope.sourceChannelId,
  );
  const matches = entries.filter((entry) => entry.entryId === target || entry.slug === target);
  if (matches.length !== 1) {
    throw new MemoryStateError(
      matches.length > 1 ? 'memory_target_ambiguous' : 'memory_entry_not_found',
      matches.length > 1 ? 'Memory name is ambiguous.' : 'Memory entry was not found.',
    );
  }
  return matches[0]!;
}

async function currentWritableEntry(runtime: MemoryRuntime, target: string): Promise<MemoryEntry> {
  const entries = (await runtime.service.list({ scope: runtime.scope })).filter(
    (entry) =>
      entry.sourceChannelId === runtime.scope.sourceChannelId &&
      entry.storeId === runtime.scope.writeStoreId,
  );
  const matches = entries.filter((entry) => entry.entryId === target || entry.slug === target);
  if (matches.length !== 1) {
    throw new MemoryStateError(
      matches.length > 1 ? 'memory_target_ambiguous' : 'memory_entry_not_found',
      matches.length > 1 ? 'Memory name is ambiguous.' : 'Memory entry was not found.',
    );
  }
  return matches[0]!;
}

async function qualifiedEntry(runtime: MemoryRuntime, target: string): Promise<MemoryEntry> {
  const [channelId, slug, extra] = target.split('/');
  if (!channelId || !slug || extra) {
    throw new MemoryStateError(
      'memory_target_invalid',
      'Use <source-channel-id>/<slug> for a cross-channel report.',
    );
  }
  const entry = (await runtime.service.list({ scope: runtime.scope })).find(
    (candidate) =>
      candidate.sourceChannelId.toLowerCase() === channelId.toLowerCase() &&
      candidate.slug === slug,
  );
  if (!entry) throw new MemoryStateError('memory_entry_not_found', 'Memory entry was not found.');
  return entry;
}

async function forgetTarget(runtime: MemoryRuntime, target: string): Promise<MemoryEntry> {
  if (!target.startsWith('public/')) {
    return currentWritableEntry(runtime, target);
  }
  const slug = target.slice('public/'.length);
  const entry = (await runtime.service.list({ scope: runtime.scope })).find(
    (candidate) =>
      candidate.sourceChannelId === runtime.scope.sourceChannelId &&
      candidate.storeId !== runtime.scope.writeStoreId &&
      candidate.slug === slug,
  );
  if (!entry) throw new MemoryStateError('memory_entry_not_found', 'Memory entry was not found.');
  return entry;
}

async function requireFreshMembership(turn: NormalizedSlackTurn, runtime: MemoryRuntime): Promise<void> {
  if (!(await verifyMemoryMutationMembership(turn.channelId, turn.userId, runtime.slack))) {
    throw new MemoryStateError(
      'memory_membership_unknown',
      'Slack membership could not be verified; no memory change was made.',
    );
  }
}

async function validateMemoryLease(
  turn: NormalizedSlackTurn,
  runtime: MemoryRuntime,
  selection: MemorySelection,
  expectedScopeSignature: string,
): Promise<boolean> {
  try {
    const requiresWorkspaceRead = selection.entries.some(
      ({ entry }) => entry.sourceChannelId !== runtime.scope.sourceChannelId,
    );
    if (!(await validateMemoryScopeLease(
      {
        workspaceId: turn.workspaceId,
        channelId: turn.channelId,
        actorId: turn.userId,
        botUserId: runtime.botUserId,
        observedAt: Date.now(),
      },
      runtime.scope,
      runtime.slack,
      requiresWorkspaceRead,
    ))) return false;
    const channelState = await runtime.state.getChannelScope(
      turn.workspaceId,
      turn.channelId,
    );
    if (
      !channelState ||
      channelState.transitionVersion !== runtime.scope.transitionVersion ||
      memoryScopeSignature(runtime.scope) !== expectedScopeSignature
    ) return false;
    const current = await Promise.all(
      selection.entries.map(({ entry }) => runtime.state.getEntry(entry.entryId)),
    );
    const allowedStores = new Set(runtime.scope.reads.map((read) => read.storeId));
    return current.every((entry, index) => {
      const selected = selection.entries[index]!.entry;
      return (
        entry !== undefined &&
        entry.version === selected.version &&
        (entry.status === 'active' || entry.status === 'stale') &&
        (entry.expiresAt === null || entry.expiresAt > Date.now()) &&
        allowedStores.has(entry.storeId)
      );
    });
  } catch {
    return false;
  }
}

async function memoryFooterItems(
  state: MemoryStateStore,
  scope: EnabledMemoryScope,
  selection: MemorySelection,
): Promise<string[]> {
  const crossChannel = selection.entries.filter(
    ({ entry }) => entry.sourceChannelId !== scope.sourceChannelId,
  );
  const sources = new Map(
    crossChannel.map(({ entry }) => [
      `${entry.workspaceId}\0${entry.sourceChannelId}`,
      entry,
    ]),
  );
  const labels = new Map(
    await Promise.all(
      [...sources].map(
        async ([key, entry]) => {
          const source = await state.getChannelScope(entry.workspaceId, entry.sourceChannelId);
          return [key, source?.lastPublicDisplayName ?? source?.currentDisplayName ?? 'channel'] as const;
        },
      ),
    ),
  );
  const supplied = crossChannel.map(({ entry }) => {
    const label = labels.get(`${entry.workspaceId}\0${entry.sourceChannelId}`) ?? 'channel';
    return `Memory supplied: ${entry.slug} (#${escapeSlackControlCharacters(label)}, ${entry.sourceChannelId})`;
  });
  if (supplied.length === 0) return supplied;
  return [
    ...supplied,
    'Review cross-channel memory: !memory report <source-channel-id>/<slug> <stale|incorrect|unsafe|unclear>',
  ];
}

function memoryScopeSignature(scope: EnabledMemoryScope): string {
  return JSON.stringify({
    privacy: scope.privacy,
    workspaceRead: scope.workspaceRead,
    reads: scope.reads,
    writeStoreId: scope.writeStoreId,
    sourceChannelId: scope.sourceChannelId,
    transitionVersion: scope.transitionVersion,
  });
}

function memoryFree(
  conversationKey: string,
  visibilityBarrierAt: number | null = null,
): PreparedMemoryTurn {
  return {
    conversationKey,
    memoryEpoch: 1,
    footerItems: [],
    visibilityBarrierAt,
    ownerBound: false,
    validateLease: async () => true,
    confirmInjection: async () => true,
  };
}

function scopeLabel(scope: EnabledMemoryScope): string {
  return scope.privacy === 'private' ? 'private channel memory' : 'workspace memory';
}

function memoryErrorCode(error: unknown): string {
  return error instanceof MemoryStateError ? error.code : 'memory_state_unavailable';
}

function memoryErrorText(error: unknown): string {
  const code = memoryErrorCode(error);
  switch (code) {
    case 'memory_entry_not_found':
      return 'That memory entry was not found in this channel scope.';
    case 'memory_target_ambiguous':
      return 'That memory name is ambiguous. Use the source channel ID and slug.';
    case 'memory_version_conflict':
      return 'That memory changed before this action completed. List it again and retry.';
    case 'memory_rate_limited':
      return 'Too many memory changes were requested. Please try again later.';
    case 'memory_source_quota':
    case 'memory_store_quota':
      return 'This memory scope is full. Remove or merge an entry before adding another.';
    case 'memory_credential_rejected':
      return 'Memory cannot contain credential-like content. Store secrets in typed settings instead.';
    case 'memory_confirmation_expired':
      return 'That forget confirmation expired. Start the forget action again.';
    case 'memory_confirmation_invalid':
      return 'That confirmation is unavailable, expired, or was already used. No memory change was made.';
    case 'memory_actor_forbidden':
      return 'Only an active Chickpea Owner or Admin can change shared Agent memory from Slack. No memory change was made.';
    case 'memory_actor_unavailable':
      return 'Chickpea could not verify an active Owner or Admin, so no Agent memory change was made.';
    case 'memory_membership_unknown':
      return 'Slack membership could not be verified, so no memory change was made.';
    default:
      return 'Channel memory is temporarily unavailable. No memory change was made.';
  }
}

function memoryHelpText(): string {
  return [
    '### Channel memory commands',
    '- `Please remember that <what matters>` — save a memory with an automatic name',
    '- `Please update the memory <slug> to say that <new guidance>` — update it naturally',
    '- `!memory` — list this channel’s entries',
    '- `!remember <name> — <description>` — save an entry; add a body on the next line',
    '- `!memory show <slug>` — show an entry',
    '- `!memory update <slug> — <description>` — replace it; add the new body on the next line',
    '- `!memory merge <slug-a> <slug-b> as <name> — <description>` — body required on the next line',
    '- `!forget <slug>` — request irreversible deletion confirmation',
    '- `!forget public/<slug>` — remove retained public memory after a channel becomes private',
    '- `!memory report <source-channel-id>/<slug> <stale|incorrect|unsafe|unclear>` — request cross-channel review',
    '',
    'Public-channel entries are readable workspace-wide but conversational edits stay in their source channel. Memory is advisory and cannot override live permissions or settings.',
  ].join('\n');
}

function ownerMemoryHelpText(surface: AuthorizedMemoryScope['surface']): string {
  if (surface === 'dm') {
    return [
      '### Agent memory in DMs',
      '- `!memory` — list this Agent’s memory files',
      '- `!memory show <slug>` — show a file',
      '',
      'Changing shared Agent memory from Slack requires Owner or Admin confirmation.',
    ].join('\n');
  }
  return [
    '### Channel memory commands',
    '- `Please remember that <what matters>` — save a Channel memory file',
    '- `Please update the memory <slug> to say that <new guidance>` — update it naturally',
    '- `!memory` — list this Channel’s memory files',
    '- `!memory show <slug>` — show a file',
    '- `!memory update <slug> — <description>` — replace it; add the new body on the next line',
    '- `!forget <slug>` — request irreversible deletion confirmation',
    '',
    'Slack writes are bound to this exact Channel. Memory is advisory and cannot grant tools or change live permissions.',
  ].join('\n');
}

export async function runMemoryRetentionHousekeeping(
  state: MemoryStateStore,
  now = Date.now(),
): Promise<void> {
  if (now - lastMemoryRetentionCleanupAt < MEMORY_RETENTION_CLEANUP_INTERVAL_MS) return;
  // Latch before awaiting so concurrent turns cannot start duplicate cleanup.
  // A failure remains best effort and will be eligible again after one hour.
  lastMemoryRetentionCleanupAt = now;
  try {
    await state.cleanupRetention();
  } catch {
    console.error('[chickpea] memory retention cleanup failed');
  }
}

async function resolveCommandBotUserId(
  platformEnv: PlatformEnv | undefined,
  client: WebClient,
  resolvedBotToken?: string,
  resolvedBotUserId?: string,
): Promise<string | undefined> {
  try {
    if (resolvedBotUserId) return resolvedBotUserId;
    const credentials = resolvedBotToken
      ? { botToken: resolvedBotToken, botUserId: undefined }
      : await resolveSlackCredentials(platformEnv);
    if (credentials.botUserId) return credentials.botUserId;
    if (!credentials.botToken) return undefined;
    const auth = await client.auth.test();
    return typeof auth.user_id === 'string' ? auth.user_id : undefined;
  } catch {
    return undefined;
  }
}

function hasLeadingSlackMention(text: string): boolean {
  return /^\s*<@[^>\s]+>/.test(text);
}

function isReceiptBearingCommand(command: MemoryCommand): boolean {
  return command.kind === 'remember' ||
    command.kind === 'update' ||
    command.kind === 'merge' ||
    command.kind === 'forget_request' ||
    command.kind === 'forget_confirm' ||
    command.kind === 'owner_write_confirm' ||
    command.kind === 'report';
}

async function deliverMemoryResponse(
  presenter: WebClientPresenter,
  text: string,
  format: 'markdown' | 'plain_text',
  retryCommittedReceipt: boolean,
): Promise<void> {
  const retryDelays = retryCommittedReceipt && !isCloudflareTarget()
    ? NODE_RECEIPT_RETRY_DELAYS_MS
    : [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await presenter.deliverFinal(text, format);
      return;
    } catch (error) {
      const delay = retryDelays[attempt];
      if (delay === undefined) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
