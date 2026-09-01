import { createHash, randomUUID } from 'node:crypto';

import type { MutationClass } from '../schema.ts';
import {
  appendRunJournal,
  readRunJournal,
  type RunJournalHeaderInput,
} from '../safety/journal.ts';

export interface OperatorChallengeBinding {
  runId: string;
  caseId: string;
  stepId: string;
  attempt: number;
  expectedRevision: string;
  mutation: MutationClass;
  targetAlias: string;
  actorAlias: string;
  expectedRole: 'owner' | 'admin' | 'member';
  browserProfileAlias: string;
  semanticAction: string;
  completionSignal: string;
  expiresAt: number;
}

export interface OperatorActionView extends OperatorChallengeBinding {
  challengeId: string;
}

export type OperatorDurableChallenge = Omit<
  OperatorActionView,
  'semanticAction' | 'completionSignal'
>;

export interface OperatorCompletionInput {
  challengeId: string;
  runId: string;
  caseId: string;
  stepId: string;
  attempt: number;
  expectedRevision: string;
  mutation: MutationClass;
  actorAlias: string;
  expectedRole: 'owner' | 'admin' | 'member';
  browserProfileAlias: string;
  receiptId: string;
}

export interface OperatorCompletionReceipt extends OperatorCompletionInput {
  targetAlias: string;
}

export type OperatorChallengeConsumeResult =
  | { status: 'active'; challenge: OperatorDurableChallenge }
  | { status: 'consumed' }
  | { status: 'missing' };

/** Storage boundary for the issue-to-completion one-use transition. */
export interface OperatorChallengeLedger {
  issue(challenge: OperatorActionView): void;
  consume(challengeId: string): OperatorChallengeConsumeResult;
  recordCompletion(challengeId: string, receiptId: string): void;
}

export type OperatorChallengeErrorCode =
  | 'INVALID_CHALLENGE'
  | 'CHALLENGE_EXPIRED'
  | 'CHALLENGE_MISMATCH'
  | 'CHALLENGE_REPLAYED';

export class OperatorChallengeError extends Error {
  readonly code: OperatorChallengeErrorCode;

  constructor(code: OperatorChallengeErrorCode) {
    super(code);
    this.name = 'OperatorChallengeError';
    this.code = code;
  }
}

/** Explicit transient ledger for tests; U4 may back the same interface by the journal. */
export class InMemoryOperatorChallengeLedger implements OperatorChallengeLedger {
  private readonly active = new Map<string, OperatorDurableChallenge>();
  private readonly consumed = new Set<string>();
  private readonly completed = new Set<string>();

  issue(challenge: OperatorActionView): void {
    if (this.active.has(challenge.challengeId) || this.consumed.has(challenge.challengeId)) {
      fail('INVALID_CHALLENGE');
    }
    const { semanticAction: _semanticAction, completionSignal: _completionSignal, ...durable } = challenge;
    this.active.set(challenge.challengeId, durable);
  }

  consume(challengeId: string): OperatorChallengeConsumeResult {
    if (this.consumed.has(challengeId)) return { status: 'consumed' };
    const challenge = this.active.get(challengeId);
    if (challenge === undefined) return { status: 'missing' };
    this.active.delete(challengeId);
    this.consumed.add(challengeId);
    return { status: 'active', challenge };
  }

  recordCompletion(challengeId: string, _receiptId: string): void {
    if (!this.consumed.has(challengeId) || this.completed.has(challengeId)) fail('INVALID_CHALLENGE');
    this.completed.add(challengeId);
  }
}

/**
 * Durable one-use ledger backed by the run's existing append-only journal.
 * Only a nonce digest and content-free binding fields are persisted.
 */
export class JournalOperatorChallengeLedger implements OperatorChallengeLedger {
  private readonly identity: Pick<RunJournalHeaderInput, 'runId' | 'manifestDigest'>;

  constructor(
    private readonly journalPath: string,
    identity: Pick<RunJournalHeaderInput, 'runId' | 'manifestDigest'>,
  ) {
    this.identity = { runId: identity.runId, manifestDigest: identity.manifestDigest };
  }

  issue(challenge: OperatorActionView): void {
    if (challenge.runId !== this.identity.runId) fail('INVALID_CHALLENGE');
    const challengeDigest = operatorChallengeDigest(challenge.challengeId);
    const journal = readRunJournal(this.journalPath, this.identity);
    if (journal.events.some(({ event }) =>
      (event.type === 'operator_challenge_issued' || event.type === 'operator_challenge_consumed')
        && event.challengeDigest === challengeDigest
    )) fail('INVALID_CHALLENGE');
    appendRunJournal(this.journalPath, {
      type: 'operator_challenge_issued',
      challengeDigest,
      caseId: challenge.caseId,
      stepId: challenge.stepId,
      attempt: challenge.attempt,
      expectedRevision: challenge.expectedRevision,
      mutation: challenge.mutation,
      targetAlias: challenge.targetAlias,
      actorAlias: challenge.actorAlias,
      expectedRole: challenge.expectedRole,
      browserProfileAlias: challenge.browserProfileAlias,
      expiresAt: challenge.expiresAt,
    }, this.identity);
  }

  consume(challengeId: string): OperatorChallengeConsumeResult {
    const challengeDigest = operatorChallengeDigest(challengeId);
    const journal = readRunJournal(this.journalPath, this.identity);
    const consumed = journal.events.some(({ event }) =>
      event.type === 'operator_challenge_consumed' && event.challengeDigest === challengeDigest
    );
    if (consumed) return { status: 'consumed' };
    const issued = journal.events.map(({ event }) => event).findLast((event) =>
      event.type === 'operator_challenge_issued' && event.challengeDigest === challengeDigest
    );
    if (issued?.type !== 'operator_challenge_issued') return { status: 'missing' };
    // Consumption is flushed before the caller validates the completion. A
    // wrong or crashing response can never turn into a replayed browser action.
    appendRunJournal(this.journalPath, {
      type: 'operator_challenge_consumed',
      challengeDigest,
    }, this.identity);
    return {
      status: 'active',
      challenge: {
        challengeId,
        runId: this.identity.runId,
        caseId: issued.caseId,
        stepId: issued.stepId,
        attempt: issued.attempt,
        expectedRevision: issued.expectedRevision,
        mutation: issued.mutation,
        targetAlias: issued.targetAlias,
        actorAlias: issued.actorAlias,
        expectedRole: issued.expectedRole,
        browserProfileAlias: issued.browserProfileAlias,
        expiresAt: issued.expiresAt,
      },
    };
  }

  recordCompletion(challengeId: string, receiptId: string): void {
    const challengeDigest = operatorChallengeDigest(challengeId);
    const receiptDigest = operatorReceiptDigest(receiptId);
    const journal = readRunJournal(this.journalPath, this.identity);
    const consumed = journal.events.some(({ event }) =>
      event.type === 'operator_challenge_consumed' && event.challengeDigest === challengeDigest
    );
    const existing = journal.events.map(({ event }) => event).findLast((event) =>
      event.type === 'operator_challenge_completed' && event.challengeDigest === challengeDigest
    );
    if (!consumed || existing !== undefined) fail('INVALID_CHALLENGE');
    appendRunJournal(this.journalPath, {
      type: 'operator_challenge_completed',
      challengeDigest,
      operatorReceiptDigest: receiptDigest,
    }, this.identity);
  }
}

/** One-use operator fence whose lifetime is owned by its injected ledger. */
export class OperatorDriver {
  private readonly now: () => number;

  constructor(
    private readonly ledger: OperatorChallengeLedger,
    options: { now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  issue(binding: OperatorChallengeBinding): OperatorActionView {
    validateBinding(binding);
    const challengeId = randomUUID();
    const action = Object.freeze({ challengeId, ...binding });
    this.ledger.issue(action);
    return action;
  }

  complete(input: OperatorCompletionInput): OperatorCompletionReceipt {
    // The ledger consumes atomically before validation. A stale or wrong
    // response cannot be corrected into a replay after an external action.
    const result = this.ledger.consume(input.challengeId);
    if (result.status === 'consumed') fail('CHALLENGE_REPLAYED');
    if (result.status === 'missing') fail('INVALID_CHALLENGE');
    const action = result.challenge;
    if (this.now() >= action.expiresAt) fail('CHALLENGE_EXPIRED');
    if (!bounded(input.receiptId)
      || input.runId !== action.runId
      || input.caseId !== action.caseId
      || input.stepId !== action.stepId
      || input.attempt !== action.attempt
      || input.expectedRevision !== action.expectedRevision
      || input.mutation !== action.mutation
      || input.actorAlias !== action.actorAlias
      || input.expectedRole !== action.expectedRole
      || input.browserProfileAlias !== action.browserProfileAlias) {
      fail('CHALLENGE_MISMATCH');
    }
    this.ledger.recordCompletion(action.challengeId, input.receiptId);
    return Object.freeze({
      challengeId: input.challengeId,
      runId: action.runId,
      caseId: action.caseId,
      stepId: action.stepId,
      attempt: action.attempt,
      expectedRevision: action.expectedRevision,
      mutation: action.mutation,
      targetAlias: action.targetAlias,
      actorAlias: action.actorAlias,
      expectedRole: action.expectedRole,
      browserProfileAlias: action.browserProfileAlias,
      receiptId: input.receiptId,
    });
  }
}

function validateBinding(input: OperatorChallengeBinding): void {
  if (!bounded(input.runId)
    || !bounded(input.caseId)
    || !bounded(input.stepId)
    || !Number.isSafeInteger(input.attempt)
    || input.attempt < 1
    || !bounded(input.expectedRevision)
    || !bounded(input.targetAlias)
    || !bounded(input.actorAlias)
    || !['owner', 'admin', 'member'].includes(input.expectedRole)
    || !bounded(input.browserProfileAlias)
    || !bounded(input.semanticAction, 500)
    || !bounded(input.completionSignal, 500)
    || !Number.isSafeInteger(input.expiresAt)) {
    fail('INVALID_CHALLENGE');
  }
}

function bounded(input: unknown, max = 128): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= max;
}

function fail(code: OperatorChallengeErrorCode): never {
  throw new OperatorChallengeError(code);
}

export function operatorChallengeDigest(challengeId: string): string {
  return `sha256:${createHash('sha256').update(challengeId, 'utf8').digest('hex')}`;
}

export function operatorReceiptDigest(receiptId: string): string {
  return `sha256:${createHash('sha256').update(`operator-receipt:${receiptId}`, 'utf8').digest('hex')}`;
}
