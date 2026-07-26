import type { WebClient } from '@slack/web-api';

import type { PlatformEnv } from '../config/state-backend.ts';
import { getMemoryStateStore } from '../config/state-backend.ts';
import { resolveSlackCredentials } from '../slack/credentials.ts';
import { escapeSlackControlCharacters } from '../slack/message-format.ts';
import type { WebClientPresenter } from '../slack/web-client-presenter.ts';
import { memoryEpochThreadKey, memoryQuarantineThreadKey, slackThreadKey } from '../slack/thread-key.ts';
import type { NormalizedSlackTurn } from '../slack/types.ts';
import { parseMemoryCommand, type MemoryCommand } from './commands.ts';
import { fitMemorySelectionToPrompt, serializeMemoryPrompt } from './prompt.ts';
import {
  createMemoryScopeSlack,
  resolveMemoryScope,
  validateMemoryScopeLease,
  verifyMemoryMutationMembership,
  type EnabledMemoryScope,
  type MemoryScopeSlack,
} from './scope.ts';
import { selectMemoryEntries, type MemorySelection } from './selector.ts';
import { MemoryService } from './service.ts';
import { emitMemoryMetric } from './telemetry.ts';
import { MemoryStateError, type MemoryEntry, type MemoryStateStore } from './types.ts';

const MEMORY_CONTEXT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export interface PreparedMemoryTurn {
  conversationKey: string;
  promptBlock?: string;
  selection?: MemorySelection;
  footerItems: string[];
  visibilityBarrierAt: number | null;
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

export async function handleMemoryCommand(input: {
  turn: NormalizedSlackTurn;
  platformEnv: PlatformEnv | undefined;
  client: WebClient;
  presenter: WebClientPresenter;
}): Promise<boolean> {
  const command = parseMemoryCommand(input.turn.text);
  if (!command) return false;
  if (input.turn.source === 'dm_message') {
    await input.presenter.deliverFinal(
      'Channel memory is not available in DMs in this release.',
      'plain_text',
    );
    return true;
  }
  let responseText: string;
  let responseFormat: 'markdown' | 'plain_text' = 'markdown';
  try {
    const state = getMemoryStateStore(input.platformEnv);
    const runtime = await resolveRuntime(input.turn, input.platformEnv, input.client, state);
    responseText = await executeMemoryCommand(command, input.turn, runtime);
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
  // Keep delivery outside the domain-error catch. A Slack write failure must
  // propagate so the existing claim/retry path can redrive the idempotent
  // command and deliver its original success receipt.
  await input.presenter.deliverFinal(responseText, responseFormat);
  return true;
}

export async function prepareMemoryTurn(input: {
  turn: NormalizedSlackTurn;
  platformEnv: PlatformEnv | undefined;
  client: WebClient;
}): Promise<PreparedMemoryTurn> {
  const baseKey = slackThreadKey(input.turn);
  try {
    const state = getMemoryStateStore(input.platformEnv);
    if (input.turn.source === 'dm_message') return memoryFree(baseKey);
    const runtime = await resolveRuntime(input.turn, input.platformEnv, input.client, state);
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
      ...(promptBlock ? { promptBlock } : {}),
      selection,
      footerItems,
      visibilityBarrierAt: runtime.scope.visibilityBarrierAt,
      confirmInjection: context.inject
        ? () => state.confirmConversationContext({
            baseConversationKey: baseKey,
            epoch: context.epoch,
            selectionFingerprint: context.selectionFingerprint,
          })
        : async () => true,
      validateLease: async () => {
        const valid = await validateMemoryLease(input.turn, runtime, selection, scopeSignature);
        emitMemoryMetric('delivery_lease', { outcome: valid ? 'valid' : 'rejected' });
        return valid;
      },
    };
  } catch (error) {
    emitMemoryMetric('quarantine', { reason: memoryErrorCode(error) });
    return {
      ...memoryFree(
        memoryQuarantineThreadKey(baseKey, input.turn.eventId),
        Number.MAX_SAFE_INTEGER,
      ),
      conversationKey: memoryQuarantineThreadKey(baseKey, input.turn.eventId),
    };
  }
}

async function resolveRuntime(
  turn: NormalizedSlackTurn,
  platformEnv: PlatformEnv | undefined,
  client: WebClient,
  state: MemoryStateStore,
): Promise<MemoryRuntime> {
  const credentials = await resolveSlackCredentials(platformEnv);
  if (!credentials.botToken) {
    throw new MemoryStateError('memory_slack_unavailable', 'Slack memory is unavailable.');
  }
  let botUserId = credentials.botUserId;
  if (!botUserId) {
    const auth = await client.auth.test();
    botUserId = typeof auth.user_id === 'string' ? auth.user_id : undefined;
  }
  if (!botUserId) {
    throw new MemoryStateError('memory_slack_unavailable', 'Slack memory is unavailable.');
  }
  const slack = createMemoryScopeSlack(credentials.botToken);
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
    try {
      return await currentWritableEntry(runtime, target);
    } catch (error) {
      if (
        runtime.scope.privacy !== 'private' ||
        !(error instanceof MemoryStateError) ||
        error.code !== 'memory_entry_not_found'
      ) {
        throw error;
      }
      return currentSourceEntry(runtime, target);
    }
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
  return crossChannel.map(({ entry }) => {
    const label = labels.get(`${entry.workspaceId}\0${entry.sourceChannelId}`) ?? 'channel';
    return `Memory supplied: ${entry.slug} (#${escapeSlackControlCharacters(label)}, ${entry.sourceChannelId})`;
  });
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
    footerItems: [],
    visibilityBarrierAt,
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
      return 'That forget confirmation is invalid or was already used.';
    case 'memory_membership_unknown':
      return 'Slack membership could not be verified, so no memory change was made.';
    default:
      return 'Channel memory is temporarily unavailable. No memory change was made.';
  }
}

function memoryHelpText(): string {
  return [
    '### Channel memory commands',
    '- `!memory` — list this channel’s entries',
    '- `!remember <name> — <description>` — save an entry; add a body on the next line',
    '- `!memory show <slug>` — show an entry',
    '- `!memory update <slug> — <description>` — replace it; add the new body on the next line',
    '- `!memory merge <slug-a> <slug-b> as <name> — <description>` — body required on the next line',
    '- `!forget <slug>` — request irreversible deletion confirmation',
    '- `!memory report <channel-id>/<slug> <stale|incorrect|unsafe|unclear>` — request review',
    '',
    'Public-channel entries are readable workspace-wide but conversational edits stay in their source channel. Memory is advisory and cannot override live permissions or settings.',
  ].join('\n');
}
