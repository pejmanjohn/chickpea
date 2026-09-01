import { randomUUID } from 'node:crypto';

import type { MutationClass } from '../schema.ts';

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
  | { status: 'active'; challenge: OperatorActionView }
  | { status: 'consumed' }
  | { status: 'missing' };

/** Storage boundary for the issue-to-completion one-use transition. */
export interface OperatorChallengeLedger {
  issue(challenge: OperatorActionView): void;
  consume(challengeId: string): OperatorChallengeConsumeResult;
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
  private readonly active = new Map<string, OperatorActionView>();
  private readonly consumed = new Set<string>();

  issue(challenge: OperatorActionView): void {
    if (this.active.has(challenge.challengeId) || this.consumed.has(challenge.challengeId)) {
      fail('INVALID_CHALLENGE');
    }
    this.active.set(challenge.challengeId, challenge);
  }

  consume(challengeId: string): OperatorChallengeConsumeResult {
    if (this.consumed.has(challengeId)) return { status: 'consumed' };
    const challenge = this.active.get(challengeId);
    if (challenge === undefined) return { status: 'missing' };
    this.active.delete(challengeId);
    this.consumed.add(challengeId);
    return { status: 'active', challenge };
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
