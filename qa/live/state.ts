import type {
  ActionId,
  AssertionToken,
  CleanupResult,
  HumanGate,
  MutationClass,
  ObserverId,
  PrimaryResult,
  Suite,
  TypedReason,
} from './schema.ts';

export const RUN_PHASES = [
  'preflight',
  'action_required',
  'waiting',
  'recovery',
  'assertion',
  'cleanup',
  'complete',
] as const;

export type RunPhase = typeof RUN_PHASES[number];
export type RunnerOutputKind = 'action_required' | 'waiting' | 'assertion' | 'terminal';
export type ActionReceiptOutcome =
  | 'completed'
  | 'denied'
  | 'cancelled'
  | 'expired'
  | 'wrong_session'
  | 'provider_error'
  | 'ambiguous'
  | 'not_applied';

export interface PrimaryOutcome {
  result: PrimaryResult;
  reason?: TypedReason;
}

export interface CaseOutcome {
  variantId: string;
  primary: PrimaryOutcome;
  cleanup: CleanupResult;
}

export interface ActionRequiredRecord {
  kind: 'action_required';
  runId: string;
  suite: Suite;
  variantId: string;
  actionRef: string;
  actionId: ActionId;
  mutation: MutationClass;
  humanGate: HumanGate;
  fixtureAliases: string[];
  semanticAction: string;
}

export interface WaitingRecord {
  kind: 'waiting';
  runId: string;
  suite: Suite;
  variantId: string;
  waitingFor: 'authoritative_readback' | 'observation_window' | 'cleanup';
  actionRef?: string;
  notBefore?: string;
  reason?: TypedReason;
}

export interface AssertionRecord {
  kind: 'assertion';
  runId: string;
  suite: Suite;
  variantId: string;
  tokens: Array<{ token: AssertionToken; observerId: ObserverId }>;
}

export interface RunReport {
  schemaVersion: 'chickpea-live-report/v1';
  suite: Suite;
  manifestDigest: string;
  targetFingerprint: string;
  repositoryRevision: string;
  servingVersion: string;
  aggregate:
    | 'pass'
    | 'fail'
    | 'blocked'
    | 'ambiguous'
    | 'infrastructure_error'
    | 'cleanup_failed'
    | 'incomplete';
  inventory: {
    manifestDeclared: { count: number; variantIds: string[] };
    executed: { count: number; variantIds: string[] };
    blocked: { count: number; variantIds: string[] };
  };
  primaryCounts: Record<PrimaryResult, number>;
  cleanupCounts: Record<CleanupResult, number>;
  cases: CaseOutcome[];
}

export interface TerminalRecord {
  kind: 'terminal';
  runId: string;
  report: RunReport;
}

export type RunnerRecord = ActionRequiredRecord | WaitingRecord | AssertionRecord | TerminalRecord;

const ALLOWED_TRANSITIONS: Readonly<Record<RunPhase, readonly RunPhase[]>> = {
  preflight: ['action_required', 'recovery', 'complete'],
  action_required: ['action_required', 'waiting', 'assertion', 'cleanup', 'recovery'],
  waiting: ['waiting', 'assertion', 'cleanup', 'complete'],
  recovery: ['recovery', 'action_required', 'assertion', 'cleanup', 'complete'],
  assertion: ['cleanup', 'action_required', 'complete'],
  cleanup: ['cleanup', 'action_required', 'complete'],
  complete: [],
};

export class RunStateError extends Error {
  readonly code: 'INVALID_TRANSITION' | 'INVALID_SIGNAL' | 'ACTION_REPLAY';

  constructor(code: RunStateError['code'], detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'RunStateError';
    this.code = code;
  }
}

export function assertRunTransition(from: RunPhase, to: RunPhase): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new RunStateError('INVALID_TRANSITION', `${from} -> ${to}`);
  }
}

export function primaryForReceiptOutcome(outcome: ActionReceiptOutcome): PrimaryOutcome | undefined {
  switch (outcome) {
    case 'completed':
    case 'not_applied':
      return undefined;
    case 'denied':
      return { result: 'blocked', reason: 'human_gate_denied' };
    case 'cancelled':
      return { result: 'blocked', reason: 'human_gate_cancelled' };
    case 'expired':
      return { result: 'blocked', reason: 'human_gate_expired' };
    case 'wrong_session':
      return { result: 'blocked', reason: 'wrong_session' };
    case 'provider_error':
      return { result: 'infrastructure_error', reason: 'provider_error' };
    case 'ambiguous':
      return { result: 'ambiguous', reason: 'ambiguous_mutation' };
  }
}
