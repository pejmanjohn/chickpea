import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { diagnoseLiveTarget, parseDoctorSnapshot, type DoctorSnapshot } from './doctor.ts';
import { JournalOperatorChallengeLedger, OperatorDriver, operatorChallengeDigest,
  operatorReceiptDigest, type OperatorActionView } from './drivers/operator.ts';
import { LIVE_MANIFEST, LIVE_MANIFEST_DIGEST } from './manifest.ts';
import { validateTargetOverlay, type LiveTargetOverlay } from './privacy.ts';
import { advanceLiveRun, type AdvanceLiveRunRequest } from './runner.ts';
import { PHASE_ONE_SMOKE_VARIANTS, PHASE_ONE_TARGET_ALIASES,
  type ObserverId, type AssertionToken, type LiveAction } from './schema.ts';
import { beginCleanup, deriveCleanupPlan, exactResourceBindingDigest, recordAssertionTokens,
  recordBaselineFact, recordCleanupReceipt, recordCleanupReadback, recordMutationReceipt, verifyPostflight,
  projectProductLedger,
  validatePendingMutationReceipt,
  type BaselineFactInput, type CleanupTarget, type MutationReceiptInput, type PostflightInput,
  type PostflightProof } from './safety/cleanup.ts';
import { appendRunJournal, createRunJournal, readRunJournal } from './safety/journal.ts';
import { assertPrivateEvidencePath } from './safety/evidence.ts';
import { acquireTargetLock, readTargetLock, recoverTargetLock, releaseOwnedTargetLock, targetLockPath,
  type TargetLockOwner } from './safety/lock.ts';
import { HostUiMutex, type UiWindowLease } from './safety/ui-mutex.ts';
import type { ActionRequiredRecord, AssertionRecord, RunnerRecord, TerminalRecord, WaitingRecord } from './state.ts';

export interface WindowCapture<Value> {
  transport: 'computer_use';
  observationScope: 'window';
  windowId: string;
  captureDigest: string;
  observedAt: string;
  value: Value;
}

export interface UiWindow {
  /** The private driver calls this only with the actual Computer Use window result. */
  capture<Value>(capture: WindowCapture<Value>): WindowCapture<Value>;
  pause(): void;
  resume(): Promise<void>;
}

export interface PreparedAction {
  expectedRevision: string;
  baselines: BaselineFactInput[];
}

export type ResourceEffect = Pick<MutationReceiptInput,
  'immutableId' | 'resourceKind' | 'beforeRevision' | 'revision' | 'beforeStateDigest' | 'stateDigest'
  | 'expectedResidueStateDigest'>;

export interface ActionReadback {
  outcome: 'completed' | 'denied' | 'cancelled' | 'expired' | 'wrong_session' | 'provider_error' | 'ambiguous';
  resource?: ResourceEffect;
  generatedEffects?: ResourceEffect[];
}

export interface InterruptedActionReadback {
  outcome: 'applied' | 'absent' | 'ambiguous';
  resource?: ResourceEffect;
  generatedEffects?: ResourceEffect[];
}

export interface CleanupReadback {
  immutableId: string;
  priorRevision: string;
  resultingRevision: string;
  resultingStateDigest: string;
  outcome: 'absent' | 'restored' | 'retained' | 'ambiguous';
}

export interface VisibleAssertion {
  observerId: ObserverId;
  observedTokens: AssertionToken[];
  /** True only when visible UI still shows an unfinished observation. */
  pending?: boolean;
}

/** Implementation stays private. No CLI accepts action, assertion, or cleanup verdicts. */
export interface ComputerUseDriver {
  transport: 'computer_use';
  browserAlias: string;
  actorAlias: string;
  prepare(action: ActionRequiredRecord, ui: UiWindow): Promise<WindowCapture<PreparedAction>>;
  act(action: ActionRequiredRecord, challenge: OperatorActionView, ui: UiWindow): Promise<WindowCapture<ActionReadback>>;
  /** Observe only. This method is never permitted to replay the interrupted action. */
  readbackAction(action: ActionRequiredRecord, ui: UiWindow): Promise<WindowCapture<InterruptedActionReadback>>;
  observe(assertion: AssertionRecord, ui: UiWindow): Promise<WindowCapture<VisibleAssertion[]>>;
  inspectCleanup(target: CleanupTarget, ui: UiWindow): Promise<WindowCapture<{ revision: string }>>;
  cleanup(target: CleanupTarget, challenge: OperatorActionView, ui: UiWindow): Promise<WindowCapture<CleanupReadback>>;
  /** Observe only against an already durable cleanup intent. */
  readbackCleanup(target: CleanupTarget, ui: UiWindow): Promise<WindowCapture<CleanupReadback>>;
  inventory(variantId: string, ui: UiWindow): Promise<WindowCapture<PostflightInput>>;
}

export class CoordinatorError extends Error {
  constructor(readonly code: 'COMPUTER_USE_REQUIRED' | 'WINDOW_CAPTURE_REQUIRED' | 'TARGET_DRIFT'
    | 'DOCTOR_BLOCKED' | 'EXACT_READBACK_REQUIRED' | 'CLEANUP_READBACK_REQUIRED' | 'OBSERVATION_WAIT'
    | 'UNSUPPORTED_VARIANT' | 'CAPTURE_REPLAYED') {
    super(code);
    this.name = 'CoordinatorError';
  }
}

/** Drives the existing runner and ledger, not a second outcome state machine. */
export class AttendedLiveCoordinator {
  private readonly target: LiveTargetOverlay;
  private readonly identity;
  private owner: TargetLockOwner;
  private readonly lockPath: string;
  private readonly operator: OperatorDriver;
  private readonly uiMutex: HostUiMutex;
  private readonly usedCaptures = new Set<string>();
  private readonly cleanupProofs = new Map<string, PostflightProof>();
  private started = false;
  private busy = false;

  constructor(private readonly request: Omit<AdvanceLiveRunRequest, 'signal' | 'now'>,
    private readonly dependencies: {
      driver: ComputerUseDriver;
      uiMutexRoot: string;
      attest(): Promise<DoctorSnapshot>;
      now?: () => number;
      observationTimeoutMs?: number;
      observationPollMs?: number;
      wait?: (milliseconds: number) => Promise<void>;
      onProgress?: (record: RunnerRecord) => void;
    }) {
    if (dependencies.driver.transport !== 'computer_use') throw new CoordinatorError('COMPUTER_USE_REQUIRED');
    for (const value of [dependencies.observationTimeoutMs ?? 60_000, dependencies.observationPollMs ?? 1_000]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 45 * 60_000) throw new CoordinatorError('OBSERVATION_WAIT');
    }
    this.target = validateTargetOverlay(LIVE_MANIFEST, request.overlay);
    const selected = request.variantIds ?? LIVE_MANIFEST.requiredVariants[request.suite];
    if (request.suite === 'deep' || !(PHASE_ONE_TARGET_ALIASES as readonly string[]).includes(this.target.targetAlias)
      || selected.some((id) => !(PHASE_ONE_SMOKE_VARIANTS as readonly string[]).includes(id))) {
      throw new CoordinatorError('UNSUPPORTED_VARIANT');
    }
    for (const id of selected) {
      const variant = this.variant(id);
      for (const fixture of variant.fixtures.filter(({ kind }) => kind === 'actor')) {
        const alias = this.target.bindings[id]?.fixtures[fixture.slot];
        if (!alias || this.target.fixtures[alias]?.resourceAlias !== dependencies.driver.actorAlias) {
          throw new CoordinatorError('DOCTOR_BLOCKED');
        }
      }
    }
    this.identity = { runId: request.runId, manifestDigest: LIVE_MANIFEST_DIGEST };
    // The environment resolution derives <root>/runs/<runId>.jsonl.
    this.lockPath = targetLockPath(dirname(dirname(request.journalPath)));
    if (request.journalPath !== join(dirname(this.lockPath), 'runs', `${request.runId}.jsonl`)) {
      throw new CoordinatorError('TARGET_DRIFT');
    }
    assertPrivateEvidencePath(request.journalPath, dirname(this.lockPath));
    this.owner = { runId: request.runId, pid: process.pid, host: hostname(), startedAt: this.at() };
    this.operator = new OperatorDriver(new JournalOperatorChallengeLedger(request.journalPath, this.identity), { now: () => this.now() });
    this.uiMutex = new HostUiMutex(dependencies.uiMutexRoot);
  }

  async run(): Promise<TerminalRecord> {
    if (this.busy) throw new CoordinatorError('TARGET_DRIFT');
    this.busy = true;
    try { return await this.start(); } finally { this.busy = false; }
  }

  /** Explicit continuation of the original journal; never an implicit lock takeover. */
  async resume(): Promise<TerminalRecord> {
    if (this.busy) throw new CoordinatorError('TARGET_DRIFT');
    this.busy = true;
    try {
      const journal = readRunJournal(this.request.journalPath, { ...this.identity, incompleteFinal: 'preserve' });
      const selected = this.request.variantIds ?? LIVE_MANIFEST.requiredVariants[this.request.suite];
      if (journal.incompleteFinalRecord !== undefined || journal.header.suite !== this.request.suite
        || JSON.stringify(journal.header.variantIds) !== JSON.stringify(selected)
        || Object.entries(this.request.identity).some(([key, value]) => journal.header[key as keyof typeof journal.header] !== value)) {
        throw new CoordinatorError('TARGET_DRIFT');
      }
      const snapshot = await this.snapshot(false);
      const current = readTargetLock(this.lockPath);
      if (!current || current.runId !== this.request.runId || current.host !== hostname()
        || (snapshot.lock.status !== 'clear' && snapshot.lock.ownerRunId !== current.runId)) {
        throw new CoordinatorError('TARGET_DRIFT');
      }
      const doctor = diagnoseLiveTarget({ overlay: this.target,
        source: { read: () => ({ ...snapshot, lock: { status: 'clear' as const } }) }, variantIds: selected });
      if (!doctor.ready) throw new CoordinatorError('DOCTOR_BLOCKED');
      if (!this.started || JSON.stringify(current) !== JSON.stringify(this.owner)) {
        recoverTargetLock(this.lockPath, this.owner, { journalPath: this.request.journalPath,
          expected: { ...this.identity, ...this.request.identity } });
      }
      this.started = true;
      for (const { event } of journal.events) {
        if (event.type === 'computer_use_window') this.usedCaptures.add(event.captureDigest);
      }
      await this.snapshot(true);
      let record = await this.advance();
      // An exposed action from an existing intent may already have been clicked.
      // A durable receipt is adopted by the runner; an unresolved one gets readback.
      if (record.kind === 'action_required') {
        const actionRef = record.actionRef;
        if (journal.events.some(({ event }) => event.type === 'intent' && event.actionRef === actionRef)) {
          record = await this.advance({ type: 'action_receipt', actionRef, outcome: 'ambiguous' });
        }
      }
      return await this.drive(record);
    } finally { this.busy = false; }
  }

  private async start(): Promise<TerminalRecord> {
    const initial = await this.snapshot(false);
    const doctor = diagnoseLiveTarget({ overlay: this.target, source: { read: () => initial },
      variantIds: this.request.variantIds ?? LIVE_MANIFEST.requiredVariants[this.request.suite] });
    if (!doctor.ready) throw new CoordinatorError('DOCTOR_BLOCKED');
    // A header is durable before the lock exists, so a crash cannot leave an
    // orphan lock with no recovery journal. No intent/UI work precedes the lock.
    if (readTargetLock(this.lockPath)) acquireTargetLock(this.lockPath, this.owner);
    createRunJournal(this.request.journalPath, { ...this.identity, ...this.request.identity,
      suite: this.request.suite,
      variantIds: [...(this.request.variantIds ?? LIVE_MANIFEST.requiredVariants[this.request.suite])],
      createdAt: this.at() });
    acquireTargetLock(this.lockPath, this.owner);
    this.started = true;
    // Exceptions deliberately preserve the target lock and journal for exact readback.
    let record: RunnerRecord;
    try {
      record = await this.advance();
    } catch (error) {
      try { releaseOwnedTargetLock(this.lockPath, this.owner, this.request.journalPath); }
      catch { /* Any persisted intent or changed owner keeps its recovery lock. */ }
      throw error;
    }
    return this.drive(record);
  }

  private async drive(record: RunnerRecord): Promise<TerminalRecord> {
    while (record.kind !== 'terminal') {
      this.dependencies.onProgress?.(record);
      if (record.kind === 'action_required') {
        const action = this.actionFor(record);
        const prepared = await this.window(record.variantId, `${record.actionRef}:before`,
          (ui) => this.dependencies.driver.prepare(record as ActionRequiredRecord, ui));
        for (const baseline of prepared.baselines) {
          if (baseline.targetAlias !== this.target.targetAlias || baseline.caseId !== record.variantId) {
            throw new CoordinatorError('TARGET_DRIFT');
          }
          recordBaselineFact(this.request.journalPath, baseline, this.identity);
        }
        await this.snapshot(true);
        const challenge = this.challenge(record.variantId, record.actionRef, prepared.expectedRevision,
          action.mutation, record.semanticAction);
        let readback: ActionReadback;
        try {
          readback = await this.window(record.variantId, record.actionRef,
            (ui) => this.dependencies.driver.act(record as ActionRequiredRecord, challenge, ui));
          if (readback.outcome === 'completed') {
            if (!readback.resource || readback.resource.beforeRevision !== prepared.expectedRevision) {
              throw new CoordinatorError('EXACT_READBACK_REQUIRED');
            }
            const expectedKind = ({ 'agent.create': 'agent', 'agent.update': 'agent',
              'connection.authorize': 'connection', 'routine.create': 'routine' } as const)[action.id as
                'agent.create' | 'agent.update' | 'connection.authorize' | 'routine.create'];
            if (!expectedKind || readback.resource.resourceKind !== expectedKind
              || (action.mutation === 'create' && prepared.expectedRevision !== 'absent')) {
              throw new CoordinatorError('EXACT_READBACK_REQUIRED');
            }
            this.effect(challenge, readback.resource, action.cleanup);
            const generated = readback.generatedEffects ?? [];
            const variant = this.variant(record.variantId);
            if (generated.length !== variant.generatedEffects.length) throw new CoordinatorError('EXACT_READBACK_REQUIRED');
            for (const [index, resource] of generated.entries()) {
              const definition = variant.generatedEffects[index]!;
              const observed = this.challenge(record.variantId, `${record.actionRef}:generated:${index}`,
                resource.beforeRevision, 'create', 'Observe the declared product-generated effect without sending a message.');
              this.effect(observed, resource, definition.cleanup);
            }
          } else {
            // Consume the one-use action even when a gate ends without a mutation.
            this.complete(challenge, `sha256:${'0'.repeat(64)}`);
          }
        } catch (error) {
          // Readback validation can fail after the UI mutation too. Always park
          // that intent in recovery; never leave it as a replayable action.
          try {
            await this.advance({ type: 'action_receipt', actionRef: record.actionRef, outcome: 'ambiguous' });
          } catch { /* Target drift or an unreadable journal still retains the lock and original intent. */ }
          throw error;
        }
        record = await this.advance({ type: 'action_receipt', actionRef: record.actionRef, outcome: readback.outcome });
      } else if (record.kind === 'assertion') {
        record = await this.observe(record);
      } else if (record.waitingFor === 'cleanup') {
        await this.cleanup(record.variantId);
        record = await this.advance();
      } else if (record.waitingFor === 'observation_window') {
        const notBefore = Date.parse(record.notBefore ?? '');
        if (!Number.isFinite(notBefore)) throw new CoordinatorError('OBSERVATION_WAIT');
        await this.wait(Math.max(1, Math.min(notBefore - this.now(), 1_000)));
        record = await this.advance();
      } else if (record.waitingFor === 'authoritative_readback') {
        record = await this.readback(record);
      } else {
        throw new CoordinatorError('EXACT_READBACK_REQUIRED');
      }
    }
    this.dependencies.onProgress?.(record);
    if (record.report.cleanupCounts.failed === 0) {
      releaseOwnedTargetLock(this.lockPath, this.owner, this.request.journalPath);
    }
    return record;
  }

  private async readback(record: WaitingRecord): Promise<RunnerRecord> {
    const journal = readRunJournal(this.request.journalPath, this.identity);
    const intent = journal.events.map(({ event }) => event).findLast((event) => event.type === 'intent'
      && event.actionRef === record.actionRef && event.variantId === record.variantId);
    if (intent?.type !== 'intent') throw new CoordinatorError('EXACT_READBACK_REQUIRED');
    const variant = this.variant(record.variantId);
    const action = variant.actions.find(({ id }) => id === intent.actionId);
    if (!action) throw new CoordinatorError('UNSUPPORTED_VARIANT');
    const actionRecord: ActionRequiredRecord = { kind: 'action_required', runId: this.request.runId,
      suite: this.request.suite, variantId: record.variantId, actionRef: intent.actionRef, actionId: action.id,
      mutation: action.mutation, humanGate: action.humanGate,
      fixtureAliases: action.fixtureSlots.map((slot) => this.target.bindings[record.variantId]!.fixtures[slot]!),
      semanticAction: 'Read back the interrupted action only; do not repeat it.' };
    const result = await this.window(record.variantId, `${intent.actionRef}:readback`,
      (ui) => this.dependencies.driver.readbackAction(actionRecord, ui));
    const mutations = projectProductLedger(journal).mutations.filter((mutation) =>
      mutation.caseId === record.variantId && (mutation.stepId === intent.actionRef || mutation.stepId.startsWith(`${intent.actionRef}:`)));
    if (!['applied', 'absent', 'ambiguous'].includes(result.outcome) || result.outcome === 'ambiguous'
      || (result.outcome === 'absent' && (mutations.length || result.resource || result.generatedEffects?.length))) {
      throw new CoordinatorError('EXACT_READBACK_REQUIRED');
    }
    const consumed = new Set(journal.events.flatMap(({ event }) =>
      event.type === 'operator_challenge_consumed' ? [event.challengeDigest] : []));
    for (const { event } of journal.events) {
      if (event.type === 'operator_challenge_issued' && event.stepId === intent.actionRef
        && !consumed.has(event.challengeDigest)) {
        // Invalidate the old nonce after readback; do not invent its completion.
        appendRunJournal(this.request.journalPath, { type: 'operator_challenge_consumed',
          challengeDigest: event.challengeDigest }, this.identity);
      }
    }
    if (result.outcome === 'applied') {
      const expectedKind = ({ 'agent.create': 'agent', 'agent.update': 'agent',
        'connection.authorize': 'connection', 'routine.create': 'routine' } as const)[action.id as
          'agent.create' | 'agent.update' | 'connection.authorize' | 'routine.create'];
      if (!result.resource || result.resource.resourceKind !== expectedKind
        || (result.generatedEffects ?? []).length !== variant.generatedEffects.length) {
        throw new CoordinatorError('EXACT_READBACK_REQUIRED');
      }
      const issued = journal.events.map(({ event }) => event).findLast((event) =>
        event.type === 'operator_challenge_issued' && event.stepId === intent.actionRef);
      const expectedRevision = issued?.type === 'operator_challenge_issued' ? issued.expectedRevision
        : action.id === 'agent.update' ? projectProductLedger(journal).baselines.find((baseline) =>
          baseline.resourceKind === 'agent' && baseline.immutableId === result.resource!.immutableId)?.revision : 'absent';
      if (!expectedRevision || result.resource.beforeRevision !== expectedRevision
        || (action.id !== 'agent.update' && expectedRevision !== 'absent')) {
        throw new CoordinatorError('EXACT_READBACK_REQUIRED');
      }
      const resources = [{ effect: result.resource, cleanup: action.cleanup, stepId: `${intent.actionRef}:readback`, generated: false },
        ...(result.generatedEffects ?? []).map((effect, index) => ({ effect, cleanup: variant.generatedEffects[index]!.cleanup,
          stepId: `${intent.actionRef}:generated:${index}:readback`, generated: true }))];
      for (const { effect, cleanup, stepId, generated } of resources) {
        if (generated && effect.resourceKind !== 'attributed_residue') throw new CoordinatorError('EXACT_READBACK_REQUIRED');
        const existing = mutations.find((mutation) => mutation.immutableId === effect.immutableId
          && mutation.resourceKind === effect.resourceKind);
        if (existing) {
          if (Object.entries(effect).some(([key, value]) => existing[key as keyof typeof existing] !== value)) {
            throw new CoordinatorError('EXACT_READBACK_REQUIRED');
          }
          continue;
        }
        const challenge = this.challenge(record.variantId, stepId, effect.beforeRevision,
          generated ? 'create' : action.mutation, 'Record exact visible recovery evidence; no product mutation is authorized.');
        this.effect(challenge, effect, cleanup, true);
      }
    }
    return this.advance({ type: 'readback_result', intentId: intent.intentId, outcome: result.outcome });
  }

  private async observe(assertion: AssertionRecord): Promise<RunnerRecord> {
    const events = readRunJournal(this.request.journalPath, this.identity).events;
    const started = events.findLast(({ event }) => event.type === 'transition'
      && event.variantId === assertion.variantId && event.to === 'assertion')?.at;
    const startTime = started === undefined ? this.now() : Date.parse(started);
    const previous = events.filter(({ event }) => event.type === 'assertion_tokens'
      && event.caseId === assertion.variantId);
    if (previous.some(({ event }) => event.type === 'assertion_tokens' && event.pending !== true
      && event.expectedTokens.some((token) => !event.observedTokens.includes(token)))) {
      return this.advance({ type: 'assertion_result', variantId: assertion.variantId, result: 'fail' });
    }
    let attempt = Math.max(0, ...previous.map(({ event }) => event.type === 'assertion_tokens' ? event.pollAttempt : 0));
    const expectedObservers = [...new Set(assertion.tokens.map(({ observerId }) => observerId))];
    for (;;) {
      attempt += 1;
      const observations = await this.window(assertion.variantId, 'assertions',
        (ui) => this.dependencies.driver.observe(assertion, ui));
      if (observations.length !== expectedObservers.length
        || new Set(observations.map(({ observerId }) => observerId)).size !== observations.length
        || observations.some(({ observerId }) => !expectedObservers.includes(observerId))) {
        throw new CoordinatorError('WINDOW_CAPTURE_REQUIRED');
      }
      let pass = true;
      let settledFailure = false;
      for (const observation of observations) {
        const expectedTokens = assertion.tokens.filter(({ observerId }) => observerId === observation.observerId)
          .map(({ token }) => token);
        if (observation.observedTokens.some((token) => !expectedTokens.includes(token))
          || (observation.pending !== undefined && typeof observation.pending !== 'boolean')) {
          throw new CoordinatorError('WINDOW_CAPTURE_REQUIRED');
        }
        const matches = expectedTokens.every((token) => observation.observedTokens.includes(token));
        pass &&= matches && observation.pending !== true;
        settledFailure ||= !matches && observation.pending !== true;
        recordAssertionTokens(this.request.journalPath, { caseId: assertion.variantId, stepId: 'assertions',
          observerId: observation.observerId, expectedTokens, observedTokens: observation.observedTokens,
          pollAttempt: attempt, pollElapsedMs: Math.max(0, this.now() - startTime),
          pending: observation.pending === true }, this.identity);
      }
      const remaining = (this.dependencies.observationTimeoutMs ?? 60_000) - (this.now() - startTime);
      if (pass || settledFailure || remaining <= 0) return this.advance({ type: 'assertion_result', variantId: assertion.variantId,
        result: pass ? 'pass' : 'fail' });
      await this.wait(Math.min(remaining, this.dependencies.observationPollMs ?? 1_000));
    }
  }

  private async wait(milliseconds: number): Promise<void> {
    // A visible window has ended. Keep only the per-target claim while waiting.
    await (this.dependencies.wait ?? delay)(milliseconds);
    await this.snapshot(true);
  }

  private async cleanup(variantId: string): Promise<void> {
    appendRunJournal(this.request.journalPath, { type: 'postflight_required', caseId: variantId }, this.identity);
    for (const target of deriveCleanupPlan(this.request.journalPath, this.identity)
      .filter(({ caseId }) => caseId === variantId)) {
      if (target.resolution === 'authoritative_readback') {
        const ledger = projectProductLedger(readRunJournal(this.request.journalPath, this.identity));
        const intent = ledger.cleanupIntents.find(({ mutationReceiptId }) => mutationReceiptId === target.mutationReceiptId);
        if (!intent) throw new CoordinatorError('CLEANUP_READBACK_REQUIRED');
        const receipt = ledger.cleanupReceipts.find(({ cleanupIntentId }) => cleanupIntentId === intent.cleanupIntentId);
        const result = await this.window(variantId, `${target.stepId}:cleanup-readback`,
          (ui) => this.dependencies.driver.readbackCleanup(target, ui));
        if (result.immutableId !== target.immutableId || result.priorRevision !== target.expectedRevision) {
          throw new CoordinatorError('EXACT_READBACK_REQUIRED');
        }
        const observerId = ({ agent: 'agent.read', connection: 'connection.read', routine: 'routine.read',
          attributed_residue: 'slack.messages.read' } as const)[target.resourceKind as
            'agent' | 'connection' | 'routine' | 'attributed_residue'];
        if (!observerId) throw new CoordinatorError('CLEANUP_READBACK_REQUIRED');
        recordCleanupReadback(this.request.journalPath, { cleanupIntentId: intent.cleanupIntentId,
          ...(receipt ? { cleanupReceiptId: receipt.receiptId } : {}), readbackId: randomUUID(), observerId,
          immutableId: result.immutableId, observedRevision: result.resultingRevision,
          observedStateDigest: result.resultingStateDigest, outcome: result.outcome }, this.identity);
        if (result.outcome === 'ambiguous') throw new CoordinatorError('CLEANUP_READBACK_REQUIRED');
        continue;
      }
      const before = await this.window(variantId, `${target.stepId}:cleanup-before`,
        (ui) => this.dependencies.driver.inspectCleanup(target, ui));
      await this.snapshot(true);
      const challenge = this.challenge(variantId, `${target.stepId}:cleanup`, target.expectedRevision,
        target.mutation, `Clean the exact declared ${target.resourceKind} using ${target.operation}.`);
      const intent = beginCleanup(this.request.journalPath, target,
        { currentRevision: before.revision, actionChallengeDigest: operatorChallengeDigest(challenge.challengeId) }, this.identity);
      const result = await this.window(variantId, `${target.stepId}:cleanup`,
        (ui) => this.dependencies.driver.cleanup(target, challenge, ui));
      if (result.immutableId !== target.immutableId || result.priorRevision !== target.expectedRevision) {
        throw new CoordinatorError('EXACT_READBACK_REQUIRED');
      }
      const receiptId = this.complete(challenge, exactResourceBindingDigest({ ...target, beforeRevision: target.expectedRevision }));
      recordCleanupReceipt(this.request.journalPath, { ...result, cleanupIntentId: intent.cleanupIntentId,
        receiptId, actionChallengeDigest: operatorChallengeDigest(challenge.challengeId),
        operatorReceiptDigest: operatorReceiptDigest(receiptId) }, this.identity);
      if (result.outcome === 'ambiguous') throw new CoordinatorError('CLEANUP_READBACK_REQUIRED');
    }
    const inventory = await this.window(variantId, 'postflight', (ui) => this.dependencies.driver.inventory(variantId, ui));
    const proof = verifyPostflight(this.request.journalPath, inventory, this.identity);
    appendRunJournal(this.request.journalPath, { type: 'postflight_receipt', caseId: variantId,
      result: proof.status, targetIdentityMatches: proof.targetIdentityMatches,
      missingCount: proof.missingAliases.length, unexpectedCount: proof.unexpectedAliases.length,
      unresolvedCount: proof.unresolvedAliases.length }, this.identity);
    this.cleanupProofs.set(variantId, proof);
  }

  private effect(challenge: OperatorActionView, effect: ResourceEffect, cleanup: LiveAction['cleanup'], recoveryReadback = false): void {
    const binding = { targetAlias: this.target.targetAlias, ...effect, fixtureClass: cleanup.fixtureClass };
    const receiptId = randomUUID();
    const input: MutationReceiptInput = { ...effect,
      receiptId, caseId: challenge.caseId, stepId: challenge.stepId, attempt: challenge.attempt,
      targetAlias: challenge.targetAlias, actionChallengeDigest: operatorChallengeDigest(challenge.challengeId),
      operatorReceiptDigest: operatorReceiptDigest(receiptId), mutation: challenge.mutation,
      fixtureClass: cleanup.fixtureClass, cleanupStrategy: cleanup.strategy, direction: 'forward',
      ...(recoveryReadback ? { recoveryReadback: true as const } : {}),
      ...(cleanup.reversalActionId ? { reversalActionId: cleanup.reversalActionId } : {}),
    };
    validatePendingMutationReceipt(this.request.journalPath, input, this.identity);
    this.complete(challenge, exactResourceBindingDigest(binding), receiptId);
    recordMutationReceipt(this.request.journalPath, input, this.identity);
  }

  private complete(challenge: OperatorActionView, resourceBindingDigest: string, receiptId = randomUUID()): string {
    this.operator.complete({ ...challenge, receiptId, resourceBindingDigest });
    return receiptId;
  }

  private challenge(caseId: string, stepId: string, expectedRevision: string,
    mutation: LiveAction['mutation'], semanticAction: string): OperatorActionView {
    const actor = this.variant(caseId).fixtures.find(({ kind }) => kind === 'actor');
    if (!actor || !['owner', 'admin', 'member'].includes(actor.slot)) throw new CoordinatorError('DOCTOR_BLOCKED');
    const attempt = Number(stepId.split(':')[2]);
    if (!Number.isSafeInteger(attempt) || attempt < 1) throw new CoordinatorError('EXACT_READBACK_REQUIRED');
    return this.operator.issue({ runId: this.request.runId, caseId, stepId, attempt,
      expectedRevision, mutation, targetAlias: this.target.targetAlias,
      actorAlias: this.dependencies.driver.actorAlias, expectedRole: actor.slot as 'owner' | 'admin' | 'member',
      browserProfileAlias: this.dependencies.driver.browserAlias, semanticAction,
      completionSignal: 'Fresh visible readback identifies the exact resulting resource and revision.',
      expiresAt: this.now() + 20 * 60_000 });
  }

  private async window<Value>(caseId: string, stepId: string,
    operation: (ui: UiWindow) => Promise<WindowCapture<Value>>): Promise<Value> {
    await this.snapshot(true);
    let lease: UiWindowLease = this.uiMutex.acquire(this.request.runId, this.dependencies.driver.browserAlias);
    const certified = new WeakMap<object, WindowCapture<unknown>>();
    const ui: UiWindow = {
      pause: () => lease.pause(),
      resume: async () => {
        await this.snapshot(true);
        lease = this.uiMutex.acquire(this.request.runId, this.dependencies.driver.browserAlias);
      },
      capture: <Result>(capture: WindowCapture<Result>) => {
        lease.assertOwned();
        if (capture.transport !== 'computer_use' || capture.observationScope !== 'window'
          || !capture.windowId || !/^sha256:[a-f0-9]{64}$/u.test(capture.captureDigest)
          || !Number.isFinite(Date.parse(capture.observedAt))
          || Date.parse(capture.observedAt) > this.now() + 1_000
          || this.now() - Date.parse(capture.observedAt) > 60_000) throw new CoordinatorError('WINDOW_CAPTURE_REQUIRED');
        if (this.usedCaptures.has(capture.captureDigest)) throw new CoordinatorError('CAPTURE_REPLAYED');
        this.usedCaptures.add(capture.captureDigest);
        const sealed = Object.freeze({ ...capture, value: structuredClone(capture.value) });
        certified.set(sealed, structuredClone(sealed));
        return sealed;
      },
    };
    try {
      const returned = await operation(ui);
      lease.assertOwned();
      const capture = certified.get(returned);
      if (!capture) throw new CoordinatorError('WINDOW_CAPTURE_REQUIRED');
      await this.snapshot(true);
      lease.assertOwned();
      if (this.now() - Date.parse(capture.observedAt) > 60_000) {
        throw new CoordinatorError('WINDOW_CAPTURE_REQUIRED');
      }
      appendRunJournal(this.request.journalPath, { type: 'computer_use_window', caseId, stepId,
        targetAlias: this.target.targetAlias, captureDigest: capture.captureDigest,
        windowDigest: `sha256:${createHash('sha256').update(capture.windowId).digest('hex')}`,
        observedAt: capture.observedAt }, this.identity);
      lease.finishReservation();
      return capture.value as Value;
    } finally { lease.release(); }
  }

  private async snapshot(owned: boolean): Promise<DoctorSnapshot> {
    assertPrivateEvidencePath(this.request.journalPath, dirname(this.lockPath));
    assertPrivateEvidencePath(this.lockPath, dirname(this.lockPath));
    const snapshot = parseDoctorSnapshot(await this.dependencies.attest());
    if (snapshot.targetAlias !== this.target.targetAlias
      || snapshot.targetFingerprint !== this.request.identity.targetFingerprint
      || snapshot.repositoryRevision !== this.request.identity.repositoryRevision
      || snapshot.servingVersion !== this.request.identity.servingVersion) throw new CoordinatorError('TARGET_DRIFT');
    if (owned) {
      const current = readTargetLock(this.lockPath);
      if (!current || JSON.stringify(current) !== JSON.stringify(this.owner)) throw new CoordinatorError('TARGET_DRIFT');
      // A matching coordinator already owns this lock; every foreign lock stays blocked.
      if (snapshot.lock.status !== 'clear' && snapshot.lock.ownerRunId !== this.owner.runId) throw new CoordinatorError('TARGET_DRIFT');
      const ownedSnapshot: DoctorSnapshot = { ...snapshot, lock: { status: 'clear' } };
      const doctor = diagnoseLiveTarget({ overlay: this.target, source: { read: () => ownedSnapshot },
        variantIds: this.request.variantIds ?? LIVE_MANIFEST.requiredVariants[this.request.suite] });
      if (!doctor.ready) throw new CoordinatorError('DOCTOR_BLOCKED');
      return ownedSnapshot;
    }
    return snapshot;
  }

  private async advance(signal?: AdvanceLiveRunRequest['signal']): Promise<RunnerRecord> {
    return advanceLiveRun({ ...this.request, doctorSnapshot: await this.snapshot(true),
      ...(signal ? { signal } : {}), now: this.at() }, {
      progressCleanup: ({ variantId }) => {
        const proof = this.cleanupProofs.get(variantId);
        return proof ? { status: 'complete', postflight: proof } : { status: 'waiting' };
      },
    });
  }

  private actionFor(record: ActionRequiredRecord): LiveAction {
    const action = this.variant(record.variantId).actions.find(({ id }) => id === record.actionId);
    if (!action) throw new CoordinatorError('UNSUPPORTED_VARIANT');
    return action;
  }

  private variant(id: string) {
    const variant = LIVE_MANIFEST.contracts.flatMap(({ variants }) => variants).find((variant) => variant.id === id);
    if (!variant) throw new CoordinatorError('UNSUPPORTED_VARIANT');
    return variant;
  }

  private now(): number { return this.dependencies.now?.() ?? Date.now(); }
  private at(): string { return new Date(this.now()).toISOString(); }
}
