import { createHash, randomUUID } from 'node:crypto';

import type { AuthorizedMemoryScope, EnabledMemoryScope } from './scope.ts';
import { slugifyMemoryName } from './slug.ts';
import {
  MemoryStateError,
  type MemoryActorClass,
  type MemoryEntry,
  type MemoryEntryType,
  type MemoryStateStore,
  type OwnerMemoryEntry,
} from './types.ts';
import { validateMemoryContent } from './validation.ts';

const FORGET_CHALLENGE_MS = 5 * 60 * 1_000;
const READABLE_STATUSES = ['active', 'stale'] as const;

interface MemoryServiceDependencies {
  now?: () => number;
  id?: (prefix: string) => string;
  token?: () => string;
}

interface MemoryMutationContext {
  scope: MemoryServiceScope;
  actorId: string;
  eventId: string;
  threadTs?: string;
  messageTs?: string;
  idempotencyKey: string;
  actorClass?: MemoryActorClass;
}

export type MemoryServiceScope = AuthorizedMemoryScope | EnabledMemoryScope;

export interface RememberMemoryInput extends MemoryMutationContext {
  workspaceId: string;
  name: string;
  description: string;
  type: MemoryEntryType;
  body: string;
  expiresAt?: number;
}

export interface UpdateMemoryInput extends MemoryMutationContext {
  target: string;
  expectedVersion: number;
  description: string;
  type: MemoryEntryType;
  body: string;
  expiresAt?: number | null;
}

export interface ForgetMemoryInput extends MemoryMutationContext {
  target: string;
  expectedVersion: number;
  confirmationToken: string;
  reasonCode?: string;
}

export interface MergeMemoryInput extends MemoryMutationContext {
  workspaceId: string;
  targets: Array<{ target: string; expectedVersion?: number }>;
  name: string;
  description: string;
  type: MemoryEntryType;
  body: string;
  expiresAt?: number;
}

export interface MemoryMutationResult {
  entry: MemoryEntry | OwnerMemoryEntry;
}

export class MemoryService {
  private readonly now: () => number;
  private readonly id: (prefix: string) => string;
  private readonly token: () => string;

  constructor(
    private readonly state: MemoryStateStore,
    dependencies: MemoryServiceDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? ((prefix) => `${prefix}_${randomUUID()}`);
    this.token = dependencies.token ?? (() => randomUUID());
  }

  async remember(input: RememberMemoryInput & { scope: EnabledMemoryScope }): Promise<{ entry: MemoryEntry }>;
  async remember(input: RememberMemoryInput & { scope: AuthorizedMemoryScope }): Promise<{ entry: OwnerMemoryEntry }>;
  async remember(input: RememberMemoryInput): Promise<MemoryMutationResult> {
    const content = validateMemoryContent(input);
    const entryId = this.id('mem');
    const baseSlug = slugifyMemoryName(input.name, stableSlugSeed(input.idempotencyKey));
    if (isOwnerScope(input.scope)) {
      const owner = requireWriteOwner(input.scope);
      const slug = await this.availableOwnerSlug(owner, baseSlug);
      const entry = await this.state.createOwnerEntry({
        entryId, storeId: owner.storeId, workspaceId: owner.workspaceId, slug,
        slugSeed: baseSlug, ...content, actorId: input.actorId,
        actorClass: input.actorClass ?? 'member', writeOrigin: writeOrigin(input.scope),
        sourceEventId: input.eventId,
        ...(input.threadTs ? { sourceThreadTs: input.threadTs } : {}),
        ...(input.messageTs ? { sourceMessageTs: input.messageTs } : {}),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        idempotencyKey: input.idempotencyKey,
      });
      return { entry: await this.replayOwnerBoundEntry(entry, input.idempotencyKey, {
        storeId: owner.storeId, description: content.description, type: content.type,
        body: content.body, slugSeed: baseSlug,
      }) };
    }
    const slug = await this.availableSlug(
      input.scope.writeStoreId,
      input.scope.sourceChannelId,
      baseSlug,
    );
    const entry = await this.state.createEntry({
      entryId,
      storeId: input.scope.writeStoreId,
      workspaceId: input.workspaceId,
      sourceChannelId: input.scope.sourceChannelId,
      slug,
      slugSeed: baseSlug,
      ...content,
      actorId: input.actorId,
      actorClass: input.actorClass ?? 'member',
      sourceEventId: input.eventId,
      ...(input.threadTs ? { sourceThreadTs: input.threadTs } : {}),
      ...(input.messageTs ? { sourceMessageTs: input.messageTs } : {}),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      idempotencyKey: input.idempotencyKey,
    });
    return { entry: await this.replayBoundEntry(entry, input.idempotencyKey, {
      storeId: input.scope.writeStoreId,
      sourceChannelId: input.scope.sourceChannelId,
      description: content.description,
      type: content.type,
      body: content.body,
      slugSeed: baseSlug,
    }) };
  }

  async update(input: UpdateMemoryInput & { scope: EnabledMemoryScope }): Promise<{ entry: MemoryEntry }>;
  async update(input: UpdateMemoryInput & { scope: AuthorizedMemoryScope }): Promise<{ entry: OwnerMemoryEntry }>;
  async update(input: UpdateMemoryInput): Promise<MemoryMutationResult> {
    if (isOwnerScope(input.scope)) {
      const current = await this.resolveOwnerWritableTarget(input.scope, input.target);
      const content = validateMemoryContent(input);
      const entry = await this.state.updateOwnerEntry({
        entryId: current.entryId, expectedVersion: input.expectedVersion, ...content,
        actorId: input.actorId, actorClass: input.actorClass ?? 'member',
        sourceEventId: input.eventId,
        ...(input.threadTs ? { sourceThreadTs: input.threadTs } : {}),
        ...(input.messageTs ? { sourceMessageTs: input.messageTs } : {}),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        idempotencyKey: input.idempotencyKey,
      });
      return { entry: await this.replayOwnerBoundEntry(entry, input.idempotencyKey, {
        storeId: current.storeId, description: content.description, type: content.type,
        body: content.body,
      }) };
    }
    const current = await this.resolveWritableTarget(input.scope, input.target);
    const content = validateMemoryContent(input);
    const entry = await this.state.updateEntry({
      entryId: current.entryId,
      expectedVersion: input.expectedVersion,
      ...content,
      actorId: input.actorId,
      actorClass: input.actorClass ?? 'member',
      sourceEventId: input.eventId,
      ...(input.threadTs ? { sourceThreadTs: input.threadTs } : {}),
      ...(input.messageTs ? { sourceMessageTs: input.messageTs } : {}),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      idempotencyKey: input.idempotencyKey,
    });
    return { entry: await this.replayBoundEntry(entry, input.idempotencyKey, {
      storeId: current.storeId,
      sourceChannelId: current.sourceChannelId,
      description: content.description,
      type: content.type,
      body: content.body,
    }) };
  }

  async show(input: { scope: EnabledMemoryScope; target: string }): Promise<MemoryEntry>;
  async show(input: { scope: AuthorizedMemoryScope; target: string }): Promise<OwnerMemoryEntry>;
  async show(input: { scope: MemoryServiceScope; target: string }): Promise<MemoryEntry | OwnerMemoryEntry> {
    if (isOwnerScope(input.scope)) return resolveOwnerTarget(await this.list({ scope: input.scope }), input.target);
    return resolveTarget(await this.list({ scope: input.scope }), input.target);
  }

  async list(input: { scope: EnabledMemoryScope }): Promise<MemoryEntry[]>;
  async list(input: { scope: AuthorizedMemoryScope }): Promise<OwnerMemoryEntry[]>;
  async list(input: { scope: MemoryServiceScope }): Promise<Array<MemoryEntry | OwnerMemoryEntry>> {
    if (isOwnerScope(input.scope)) {
      const entries = await Promise.all(input.scope.readOwners.map((owner) => this.state.listOwnerEntries(owner)));
      return entries.flat().filter((entry) => readableOwnerEntry(entry, this.now())).sort(compareOwnerMemoryEntry);
    }
    const entries = await Promise.all(
      input.scope.reads.map((read) =>
        this.state.listEntries({
          storeId: read.storeId,
          ...(read.sourceChannelId ? { sourceChannelId: read.sourceChannelId } : {}),
          statuses: READABLE_STATUSES,
          limit: 1_000,
        }),
      ),
    );
    const unique = new Map<string, MemoryEntry>();
    for (const entry of entries.flat()) unique.set(entry.entryId, entry);
    return [...unique.values()].sort(compareMemoryEntry);
  }

  async requestForget(input: {
    scope: EnabledMemoryScope; actorId: string; target: string; expectedVersion: number;
  }): Promise<{ entry: MemoryEntry; token: string; expiresAt: number }>;
  async requestForget(input: {
    scope: AuthorizedMemoryScope; actorId: string; target: string; expectedVersion: number;
  }): Promise<{ entry: OwnerMemoryEntry; token: string; expiresAt: number }>;
  async requestForget(input: {
    scope: MemoryServiceScope;
    actorId: string;
    target: string;
    expectedVersion: number;
  }): Promise<{ entry: MemoryEntry | OwnerMemoryEntry; token: string; expiresAt: number }> {
    if (isOwnerScope(input.scope)) {
      const entry = await this.resolveOwnerWritableTarget(input.scope, input.target);
      if (entry.version !== input.expectedVersion) {
        throw new MemoryStateError('memory_version_conflict', 'Memory entry changed before this confirmation.',
          { entryId: entry.entryId, currentVersion: String(entry.version) });
      }
      const token = this.token();
      const expiresAt = this.now() + FORGET_CHALLENGE_MS;
      await this.state.createOwnerForgetChallenge({
        challengeId: this.id('memory_forget'), tokenHash: tokenHash(token), actorId: input.actorId,
        storeId: entry.storeId, entryId: entry.entryId, expectedVersion: entry.version, expiresAt,
      });
      return { entry, token, expiresAt };
    }
    const entry = await this.resolveForgetTarget(input.scope, input.target);
    if (entry.version !== input.expectedVersion) {
      throw new MemoryStateError(
        'memory_version_conflict',
        'Memory entry changed before this confirmation.',
        { entryId: entry.entryId, currentVersion: String(entry.version) },
      );
    }
    const token = this.token();
    const expiresAt = this.now() + FORGET_CHALLENGE_MS;
    await this.state.createForgetChallenge({
      challengeId: this.id('memory_forget'),
      tokenHash: tokenHash(token),
      actorId: input.actorId,
      storeId: entry.storeId,
      entryId: entry.entryId,
      expectedVersion: input.expectedVersion,
      expiresAt,
    });
    return { entry, token, expiresAt };
  }

  async forget(input: ForgetMemoryInput & { scope: EnabledMemoryScope }): Promise<{ entry: MemoryEntry }>;
  async forget(input: ForgetMemoryInput & { scope: AuthorizedMemoryScope }): Promise<{ entry: OwnerMemoryEntry }>;
  async forget(input: ForgetMemoryInput): Promise<MemoryMutationResult> {
    if (isOwnerScope(input.scope)) {
      const current = await this.resolveOwnerWritableTarget(input.scope, input.target);
      return { entry: await this.state.forgetOwnerEntry({
        entryId: current.entryId, expectedVersion: input.expectedVersion,
        actorId: input.actorId, actorClass: input.actorClass ?? 'member', sourceEventId: input.eventId,
        reasonCode: input.reasonCode ?? 'explicit_forget', idempotencyKey: input.idempotencyKey,
        confirmationTokenHash: tokenHash(input.confirmationToken),
      }) };
    }
    const current = await this.resolveForgetTarget(input.scope, input.target);
    const entry = await this.state.forgetEntry({
      entryId: current.entryId,
      expectedVersion: input.expectedVersion,
      actorId: input.actorId,
      actorClass: input.actorClass ?? 'member',
      sourceEventId: input.eventId,
      reasonCode: input.reasonCode ?? 'explicit_forget',
      idempotencyKey: input.idempotencyKey,
      confirmationTokenHash: tokenHash(input.confirmationToken),
    });
    return { entry };
  }

  async confirmForget(input: {
    scope: EnabledMemoryScope; actorId: string; actorClass?: MemoryActorClass; eventId: string;
    confirmationToken: string; idempotencyKey: string;
  }): Promise<{ entry: MemoryEntry }>;
  async confirmForget(input: {
    scope: AuthorizedMemoryScope; actorId: string; actorClass?: MemoryActorClass; eventId: string;
    confirmationToken: string; idempotencyKey: string;
  }): Promise<{ entry: OwnerMemoryEntry }>;
  async confirmForget(input: {
    scope: MemoryServiceScope;
    actorId: string;
    actorClass?: MemoryActorClass;
    eventId: string;
    confirmationToken: string;
    idempotencyKey: string;
  }): Promise<MemoryMutationResult> {
    if (isOwnerScope(input.scope)) {
      const confirmationTokenHash = tokenHash(input.confirmationToken);
      const challenge = await this.state.getForgetChallenge(confirmationTokenHash, input.actorId);
      if (!challenge || challenge.expiresAt < this.now()) {
        throw new MemoryStateError(challenge ? 'memory_confirmation_expired' : 'memory_confirmation_invalid',
          challenge ? 'Forget confirmation expired.' : 'Forget confirmation is invalid.');
      }
      const entry = await this.state.getOwnerEntry(challenge.entryId);
      if (!entry || entry.storeId !== challenge.storeId || !input.scope.writeOwner ||
          entry.storeId !== input.scope.writeOwner.storeId) {
        throw new MemoryStateError('memory_confirmation_invalid', 'Forget confirmation is invalid.');
      }
      return { entry: await this.state.forgetOwnerEntry({
        entryId: entry.entryId, expectedVersion: challenge.expectedVersion,
        actorId: input.actorId, actorClass: input.actorClass ?? 'member', sourceEventId: input.eventId,
        reasonCode: 'explicit_forget', idempotencyKey: input.idempotencyKey, confirmationTokenHash,
      }) };
    }
    const legacyScope = input.scope;
    const replay = await this.replayedMutation(
      legacyScope,
      input.actorId,
      input.idempotencyKey,
      'memory.forgotten',
    );
    if (replay) return { entry: replay };
    const confirmationTokenHash = tokenHash(input.confirmationToken);
    const challenge = await this.state.getForgetChallenge(
      confirmationTokenHash,
      input.actorId,
    );
    if (!challenge) {
      throw new MemoryStateError('memory_confirmation_invalid', 'Forget confirmation is invalid.');
    }
    if (challenge.expiresAt < this.now()) {
      throw new MemoryStateError('memory_confirmation_expired', 'Forget confirmation expired.');
    }
    const entry = await this.state.getEntry(challenge.entryId);
    const allowedStores = new Set([
      input.scope.writeStoreId,
      ...input.scope.reads.map((read) => read.storeId),
    ]);
    if (
      !entry ||
      !allowedStores.has(challenge.storeId) ||
      entry.storeId !== challenge.storeId ||
      entry.sourceChannelId !== input.scope.sourceChannelId
    ) {
      throw new MemoryStateError('memory_confirmation_invalid', 'Forget confirmation is invalid.');
    }
    const forgotten = await this.state.forgetEntry({
      entryId: challenge.entryId,
      expectedVersion: challenge.expectedVersion,
      actorId: input.actorId,
      actorClass: input.actorClass ?? 'member',
      sourceEventId: input.eventId,
      reasonCode: 'explicit_forget',
      idempotencyKey: input.idempotencyKey,
      confirmationTokenHash,
    });
    return { entry: forgotten };
  }

  async merge(input: MergeMemoryInput & { scope: EnabledMemoryScope }): Promise<{ entry: MemoryEntry }>;
  async merge(input: MergeMemoryInput & { scope: AuthorizedMemoryScope }): Promise<{ entry: OwnerMemoryEntry }>;
  async merge(input: MergeMemoryInput): Promise<MemoryMutationResult> {
    if (input.targets.length < 2) {
      throw new MemoryStateError(
        'memory_invalid_merge',
        'Choose at least two memories to merge.',
      );
    }
    const content = validateMemoryContent(input);
    const baseSlug = slugifyMemoryName(input.name, stableSlugSeed(input.idempotencyKey));
    if (isOwnerScope(input.scope)) {
      const scope = input.scope;
      const owner = requireWriteOwner(scope);
      const sources = await Promise.all(input.targets.map(async (target) => {
        const entry = await this.resolveOwnerWritableTarget(scope, target.target);
        return { entryId: entry.entryId, expectedVersion: target.expectedVersion ?? entry.version };
      }));
      const slug = await this.availableOwnerSlug(owner, baseSlug);
      const entry = await this.state.mergeOwnerEntries({
        replacement: {
          entryId: this.id('mem'), storeId: owner.storeId, workspaceId: owner.workspaceId,
          slug, slugSeed: baseSlug, ...content, actorId: input.actorId,
          actorClass: input.actorClass ?? 'member', writeOrigin: writeOrigin(scope),
          sourceEventId: input.eventId,
          ...(input.threadTs ? { sourceThreadTs: input.threadTs } : {}),
          ...(input.messageTs ? { sourceMessageTs: input.messageTs } : {}),
          ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
          idempotencyKey: input.idempotencyKey,
        }, sources,
      });
      return { entry: await this.replayOwnerBoundEntry(entry, input.idempotencyKey, {
        storeId: owner.storeId, description: content.description, type: content.type,
        body: content.body, slugSeed: baseSlug,
      }) };
    }
    const legacyScope = input.scope;
    const replay = await this.replayedMutation(
      legacyScope,
      input.actorId,
      input.idempotencyKey,
      'memory.merged',
    );
    if (replay) {
      return {
        entry: await this.replayBoundEntry(replay, input.idempotencyKey, {
          storeId: legacyScope.writeStoreId,
          sourceChannelId: legacyScope.sourceChannelId,
          description: content.description,
          type: content.type,
          body: content.body,
          slugSeed: baseSlug,
        }),
      };
    }
    const sources = await Promise.all(
      input.targets.map(async (target) => {
        const entry = await this.resolveWritableTarget(legacyScope, target.target);
        return {
          entryId: entry.entryId,
          expectedVersion: target.expectedVersion ?? entry.version,
        };
      }),
    );
    const entryId = this.id('mem');
    const slug = await this.availableSlug(
      legacyScope.writeStoreId,
      legacyScope.sourceChannelId,
      baseSlug,
    );
    const entry = await this.state.mergeEntries({
      replacement: {
        entryId,
        storeId: legacyScope.writeStoreId,
        workspaceId: input.workspaceId,
        sourceChannelId: legacyScope.sourceChannelId,
        slug,
        slugSeed: baseSlug,
        ...content,
        actorId: input.actorId,
        actorClass: input.actorClass ?? 'member',
        sourceEventId: input.eventId,
        ...(input.threadTs ? { sourceThreadTs: input.threadTs } : {}),
        ...(input.messageTs ? { sourceMessageTs: input.messageTs } : {}),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        idempotencyKey: input.idempotencyKey,
      },
      sources,
    });
    return { entry };
  }

  async expire(input: Omit<MemoryMutationContext, 'messageTs' | 'threadTs' | 'scope'> & { scope: EnabledMemoryScope;
    target: string; expectedVersion: number; reasonCode?: string;
  }): Promise<{ entry: MemoryEntry }>;
  async expire(input: Omit<MemoryMutationContext, 'messageTs' | 'threadTs' | 'scope'> & { scope: AuthorizedMemoryScope;
    target: string; expectedVersion: number; reasonCode?: string;
  }): Promise<{ entry: OwnerMemoryEntry }>;
  async expire(input: Omit<MemoryMutationContext, 'messageTs' | 'threadTs'> & {
    target: string;
    expectedVersion: number;
    reasonCode?: string;
  }): Promise<MemoryMutationResult> {
    return this.transition(input, 'expire');
  }

  async restore(input: Omit<MemoryMutationContext, 'messageTs' | 'threadTs' | 'scope'> & { scope: EnabledMemoryScope;
    target: string; expectedVersion: number; reasonCode?: string;
  }): Promise<{ entry: MemoryEntry }>;
  async restore(input: Omit<MemoryMutationContext, 'messageTs' | 'threadTs' | 'scope'> & { scope: AuthorizedMemoryScope;
    target: string; expectedVersion: number; reasonCode?: string;
  }): Promise<{ entry: OwnerMemoryEntry }>;
  async restore(input: Omit<MemoryMutationContext, 'messageTs' | 'threadTs'> & {
    target: string;
    expectedVersion: number;
    reasonCode?: string;
  }): Promise<MemoryMutationResult> {
    return this.transition(input, 'restore');
  }

  async requestReview(input: {
    scope: MemoryServiceScope;
    target: string;
    expectedVersion: number;
    actorId: string;
    actorClass?: MemoryActorClass;
    idempotencyKey: string;
  }): Promise<void> {
    if (isOwnerScope(input.scope)) {
      const entry = await this.resolveOwnerWritableTarget(input.scope, input.target);
      await this.state.recordOwnerReview({ ...input, entryId: entry.entryId,
        actorClass: input.actorClass ?? 'member', action: 'requested' });
      return;
    }
    const entry = await this.resolveWritableTarget(input.scope, input.target);
    await this.state.recordReview({
      entryId: entry.entryId,
      expectedVersion: input.expectedVersion,
      action: 'requested',
      actorId: input.actorId,
      actorClass: input.actorClass ?? 'member',
      idempotencyKey: input.idempotencyKey,
    });
  }

  async resolveReview(input: {
    scope: MemoryServiceScope;
    target: string;
    expectedVersion: number;
    resolution: 'confirmed' | 'corrected' | 'expired';
    actorId: string;
    actorClass?: MemoryActorClass;
    idempotencyKey: string;
  }): Promise<void> {
    if (isOwnerScope(input.scope)) {
      const entry = await this.resolveOwnerWritableTarget(input.scope, input.target);
      await this.state.recordOwnerReview({ ...input, entryId: entry.entryId,
        actorClass: input.actorClass ?? 'member', action: 'resolved' });
      return;
    }
    const entry = await this.resolveWritableTarget(input.scope, input.target);
    await this.state.recordReview({
      entryId: entry.entryId,
      expectedVersion: input.expectedVersion,
      action: 'resolved',
      resolution: input.resolution,
      actorId: input.actorId,
      actorClass: input.actorClass ?? 'member',
      idempotencyKey: input.idempotencyKey,
    });
  }

  async reportReview(input: {
    scope: MemoryServiceScope;
    qualifiedTarget: string;
    expectedVersion: number;
    reason: 'stale' | 'incorrect' | 'unsafe' | 'unclear';
    actorId: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (isOwnerScope(input.scope)) {
      const [ownerId, slug, extra] = input.qualifiedTarget.split('/');
      const entry = (await this.list({ scope: input.scope })).find((candidate) =>
        'ownerId' in candidate && candidate.ownerId === ownerId && candidate.slug === slug);
      if (!ownerId || !slug || extra || !entry || !('ownerKind' in entry)) {
        throw new MemoryStateError('memory_entry_not_found', 'Memory entry was not found.');
      }
      await this.state.recordOwnerReview({
        entryId: entry.entryId, expectedVersion: input.expectedVersion, action: 'requested',
        reasonCode: input.reason, actorId: input.actorId, actorClass: 'member',
        idempotencyKey: input.idempotencyKey,
      });
      return;
    }
    const [sourceChannelId, slug, extra] = input.qualifiedTarget.split('/');
    if (!sourceChannelId || !slug || extra) {
      throw new MemoryStateError(
        'memory_target_invalid',
        'Review reports require <source-channel-id>/<slug>.',
      );
    }
    const legacyScope = input.scope;
    const entry = (await this.list({ scope: legacyScope })).find(
      (candidate) =>
        candidate.sourceChannelId.toLowerCase() === sourceChannelId.toLowerCase() &&
        candidate.slug === slug,
    );
    if (!entry) {
      throw new MemoryStateError('memory_entry_not_found', 'Memory entry was not found.');
    }
    await this.state.recordReview({
      entryId: entry.entryId,
      expectedVersion: input.expectedVersion,
      action: 'requested',
      reasonCode: input.reason,
      actorId: input.actorId,
      actorClass: 'member',
      idempotencyKey: input.idempotencyKey,
    });
  }

  private async transition(
    input: Omit<MemoryMutationContext, 'messageTs' | 'threadTs'> & {
      target: string;
      expectedVersion: number;
      reasonCode?: string;
    },
    transition: 'expire' | 'restore',
  ): Promise<MemoryMutationResult> {
    if (isOwnerScope(input.scope)) {
      const current = await this.resolveOwnerTransitionTarget(input.scope, input.target, transition);
      return { entry: await this.state.transitionOwnerEntry({
        entryId: current.entryId, expectedVersion: input.expectedVersion, transition,
        actorId: input.actorId, actorClass: input.actorClass ?? 'member', sourceEventId: input.eventId,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}), idempotencyKey: input.idempotencyKey,
      }) };
    }
    const current = await this.resolveTransitionTarget(input.scope, input.target, transition);
    const entry = await this.state.transitionEntry({
      entryId: current.entryId,
      expectedVersion: input.expectedVersion,
      transition,
      actorId: input.actorId,
      actorClass: input.actorClass ?? 'member',
      sourceEventId: input.eventId,
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      idempotencyKey: input.idempotencyKey,
    });
    return { entry };
  }

  private async resolveWritableTarget(
    scope: EnabledMemoryScope,
    target: string,
  ): Promise<MemoryEntry> {
    const candidates = await this.state.listEntries({
      storeId: scope.writeStoreId,
      sourceChannelId: scope.sourceChannelId,
      statuses: READABLE_STATUSES,
    });
    return resolveTarget(candidates, target);
  }

  private async resolveForgetTarget(
    scope: EnabledMemoryScope,
    target: string,
  ): Promise<MemoryEntry> {
    if (target.startsWith('public/')) {
      if (scope.privacy !== 'private') {
        throw new MemoryStateError(
          'memory_target_invalid',
          'The public/ qualifier is available only after a channel becomes private.',
        );
      }
      const slug = target.slice('public/'.length);
      const entries = await Promise.all(
        scope.reads
          .filter((read) => read.storeId !== scope.writeStoreId)
          .map((read) =>
            this.state.listEntries({
              storeId: read.storeId,
              sourceChannelId: scope.sourceChannelId,
              statuses: READABLE_STATUSES,
            }),
          ),
      );
      return resolveTarget(entries.flat(), slug);
    }
    return this.resolveWritableTarget(scope, target);
  }

  private async resolveTransitionTarget(
    scope: EnabledMemoryScope,
    target: string,
    transition: 'expire' | 'restore',
  ): Promise<MemoryEntry> {
    const candidates = await this.state.listEntries({
      storeId: scope.writeStoreId,
      sourceChannelId: scope.sourceChannelId,
      statuses: transition === 'restore' ? ['expired'] : READABLE_STATUSES,
    });
    return resolveTarget(candidates, target);
  }

  private async availableSlug(
    storeId: string,
    sourceChannelId: string,
    base: string,
  ): Promise<string> {
    const reserved = new Set(
      (await this.state.listEntries({ storeId, sourceChannelId, limit: 1_000 })).map(
        (entry) => entry.slug,
      ),
    );
    if (!reserved.has(base)) return base;
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const suffixText = `-${suffix}`;
      const candidate = `${base.slice(0, 64 - suffixText.length).replace(/-+$/g, '')}${suffixText}`;
      if (!reserved.has(candidate)) return candidate;
    }
    throw new MemoryStateError('memory_slug_exhausted', 'Memory name cannot be disambiguated.');
  }

  private async availableOwnerSlug(
    owner: AuthorizedMemoryScope['readOwners'][number], base: string,
  ): Promise<string> {
    const reserved = new Set((await this.state.listOwnerEntries(owner)).map(({ slug }) => slug));
    if (!reserved.has(base)) return base;
    for (let suffix = 2; suffix < 10_000; suffix += 1) {
      const suffixText = `-${suffix}`;
      const candidate = `${base.slice(0, 64 - suffixText.length).replace(/-+$/g, '')}${suffixText}`;
      if (!reserved.has(candidate)) return candidate;
    }
    throw new MemoryStateError('memory_slug_exhausted', 'Memory name cannot be disambiguated.');
  }

  private async resolveOwnerWritableTarget(scope: AuthorizedMemoryScope, target: string): Promise<OwnerMemoryEntry> {
    const owner = requireWriteOwner(scope);
    return resolveOwnerTarget((await this.state.listOwnerEntries(owner)).filter((entry) =>
      readableOwnerEntry(entry, this.now())), target);
  }

  private async resolveOwnerTransitionTarget(
    scope: AuthorizedMemoryScope, target: string, transition: 'expire' | 'restore',
  ): Promise<OwnerMemoryEntry> {
    const owner = requireWriteOwner(scope);
    return resolveOwnerTarget((await this.state.listOwnerEntries(owner)).filter((entry) =>
      transition === 'restore' ? entry.status === 'expired' : readableOwnerEntry(entry, this.now())), target);
  }

  private async replayBoundEntry(
    entry: MemoryEntry,
    idempotencyKey: string,
    expected: Pick<MemoryEntry, 'storeId' | 'sourceChannelId' | 'description' | 'type' | 'body'> & {
      slugSeed?: string;
    },
  ): Promise<MemoryEntry> {
    const receipt = (await this.state.listRevisions(entry.entryId)).find(
      (revision) => revision.idempotencyKey === idempotencyKey,
    );
    if (
      !receipt ||
      entry.storeId !== expected.storeId ||
      entry.sourceChannelId !== expected.sourceChannelId ||
      receipt.description !== expected.description ||
      receipt.type !== expected.type ||
      receipt.body !== expected.body ||
      (expected.slugSeed !== undefined && receipt.reasonCode !== `slug_seed:${expected.slugSeed}`)
    ) {
      throw new MemoryStateError(
        'memory_idempotency_mismatch',
        'Idempotency key was already used for different memory content.',
      );
    }
    return {
      ...entry,
      description: receipt.description,
      type: receipt.type,
      body: receipt.body,
      version: receipt.version,
      lastEditorActorId: receipt.actorId,
      actorClass: receipt.actorClass,
      sourceEventId: receipt.sourceEventId,
      sourceThreadTs: receipt.sourceThreadTs,
      sourceMessageTs: receipt.sourceMessageTs,
      modifiedAt: receipt.createdAt,
      contentHash: receipt.afterHash,
      status: receipt.operation === 'create' || receipt.operation === 'update' ? 'active' : entry.status,
    };
  }

  private async replayOwnerBoundEntry(
    entry: OwnerMemoryEntry,
    idempotencyKey: string,
    expected: Pick<OwnerMemoryEntry, 'storeId' | 'description' | 'type' | 'body'> & { slugSeed?: string },
  ): Promise<OwnerMemoryEntry> {
    const receipt = (await this.state.listOwnerRevisions(entry.entryId)).find(
      (revision) => revision.idempotencyKey === idempotencyKey,
    );
    if (!receipt || entry.storeId !== expected.storeId ||
        receipt.description !== expected.description || receipt.type !== expected.type ||
        receipt.body !== expected.body ||
        (expected.slugSeed !== undefined && receipt.reasonCode !== `slug_seed:${expected.slugSeed}`)) {
      throw new MemoryStateError('memory_idempotency_mismatch',
        'Idempotency key was already used for different memory content.');
    }
    return {
      ...entry, description: receipt.description, type: receipt.type, body: receipt.body,
      version: receipt.version, lastEditorActorId: receipt.actorId, actorClass: receipt.actorClass,
      sourceEventId: receipt.sourceEventId, sourceThreadTs: receipt.sourceThreadTs,
      sourceMessageTs: receipt.sourceMessageTs, modifiedAt: receipt.createdAt,
      contentHash: receipt.afterHash,
      status: receipt.operation === 'create' || receipt.operation === 'update' ? 'active' : entry.status,
    };
  }

  private async replayedMutation(
    scope: EnabledMemoryScope,
    actorId: string,
    idempotencyKey: string,
    eventType: 'memory.forgotten' | 'memory.merged',
  ): Promise<MemoryEntry | undefined> {
    const [receipt] = await this.state.listAuditEvents({
      domain: 'memory',
      eventType,
      idempotencyKey,
      limit: 1,
    });
    if (!receipt) return undefined;
    const allowedStores = new Set([scope.writeStoreId, ...scope.reads.map((read) => read.storeId)]);
    const entry = receipt.subjectId ? await this.state.getEntry(receipt.subjectId) : undefined;
    if (
      receipt.actorId !== actorId ||
      !receipt.storeId ||
      !allowedStores.has(receipt.storeId) ||
      receipt.channelId !== scope.sourceChannelId ||
      !entry ||
      entry.storeId !== receipt.storeId ||
      entry.sourceChannelId !== scope.sourceChannelId
    ) {
      throw new MemoryStateError(
        'memory_idempotency_mismatch',
        'Idempotency key was already used for a different memory action.',
      );
    }
    return entry;
  }
}

function resolveTarget(entries: readonly MemoryEntry[], target: string): MemoryEntry {
  const exactId = entries.find((entry) => entry.entryId === target);
  if (exactId) return exactId;
  const slugMatches = entries.filter((entry) => entry.slug === target);
  if (slugMatches.length === 1) return slugMatches[0]!;
  if (slugMatches.length > 1) {
    throw new MemoryStateError(
      'memory_target_ambiguous',
      'Memory name is ambiguous; qualify it by source channel.',
    );
  }
  throw new MemoryStateError('memory_entry_not_found', 'Memory entry was not found.');
}

function resolveOwnerTarget(entries: readonly OwnerMemoryEntry[], target: string): OwnerMemoryEntry {
  const exactId = entries.find((entry) => entry.entryId === target);
  if (exactId) return exactId;
  const slugMatches = entries.filter((entry) => entry.slug === target);
  if (slugMatches.length === 1) return slugMatches[0]!;
  if (slugMatches.length > 1) {
    throw new MemoryStateError('memory_target_ambiguous', 'Memory name is ambiguous.');
  }
  throw new MemoryStateError('memory_entry_not_found', 'Memory entry was not found.');
}

function compareMemoryEntry(left: MemoryEntry, right: MemoryEntry): number {
  return (
    left.sourceChannelId.localeCompare(right.sourceChannelId, 'en') ||
    left.slug.localeCompare(right.slug, 'en') ||
    left.entryId.localeCompare(right.entryId, 'en')
  );
}

function compareOwnerMemoryEntry(left: OwnerMemoryEntry, right: OwnerMemoryEntry): number {
  return left.ownerKind.localeCompare(right.ownerKind, 'en') ||
    left.ownerId.localeCompare(right.ownerId, 'en') ||
    left.slug.localeCompare(right.slug, 'en') || left.entryId.localeCompare(right.entryId, 'en');
}

function readableOwnerEntry(entry: OwnerMemoryEntry, now: number): boolean {
  return (entry.status === 'active' || entry.status === 'stale') &&
    (entry.expiresAt === null || entry.expiresAt > now);
}

function isOwnerScope(scope: MemoryServiceScope): scope is AuthorizedMemoryScope {
  return 'readOwners' in scope;
}

function requireWriteOwner(scope: AuthorizedMemoryScope): AuthorizedMemoryScope['readOwners'][number] {
  if (!scope.writeOwner) {
    throw new MemoryStateError('memory_write_not_authorized', 'Memory writes are not authorized here.');
  }
  return scope.writeOwner;
}

function writeOrigin(scope: AuthorizedMemoryScope) {
  if (scope.surface === 'channel' && scope.writeOwner?.ownerKind === 'channel') {
    return { kind: 'slack_channel' as const, channelId: scope.writeOwner.ownerId };
  }
  return scope.surface === 'dm'
    ? { kind: 'slack_dm' as const, channelId: 'dm' }
    : { kind: 'admin' as const };
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function stableSlugSeed(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex');
}
