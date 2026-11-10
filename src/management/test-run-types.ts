/**
 * A test run's shapes (management/test-runs.ts): the row, what admission and
 * settlement take, and what its caller and the state store's RPC see.
 */
import type { AdmitUsageOperationInput, RecordUsageTerminalInput } from '../usage/types.ts';

export type TestRunStatus = 'admitted' | 'running' | 'answered' | 'failed';

/**
 * Why a run failed. `not_dispatched`: no submission 30 s after admission.
 * `deadline`: Flue's 120 s or the store's 150 s. `daily_limit`: the host's
 * daily limit, with when it resumes. `cancelled`: an operator's cancellation
 * pass while the workspace was suspended.
 */
export type TestRunFailure = 'not_dispatched' | 'deadline' | 'out_of_usage' | 'daily_limit' | 'cancelled' | 'failed';

/** What a settled run keeps for its caller: the reply and the services it read, or when a limit resumes. */
export interface TestRunResult {
  reply?: string;
  read?: string[];
  resumesAt?: number;
}

export interface TestRunRow {
  testRunId: string;
  runToken: string;
  coordinateToken: string;
  organizationId: string;
  actorMembershipId: string;
  agentId: string;
  status: TestRunStatus;
  failure: TestRunFailure | null;
  idempotencyKey: string;
  instanceId: string;
  submissionId: string | null;
  planJson: string | null;
  result: TestRunResult | null;
  usageOperationId: string;
  createdAt: number;
  settledAt: number | null;
  erasedAt: number | null;
  expiresAt: number;
}

export interface TestRunAdmissionRequest {
  testRunId: string;
  runToken: string;
  coordinateToken: string;
  organizationId: string;
  actorMembershipId: string;
  agentId: string;
  idempotencyKey: string;
  instanceId: string;
  /** The compiled plan, as the dispatch's creation data carries it. */
  planJson: string;
  usage: AdmitUsageOperationInput;
}

export type TestRunAdmission =
  | { kind: 'admitted'; row: TestRunRow }
  /** The same caller's same idempotency key: the stored run, before any check. */
  | { kind: 'replayed'; row: TestRunRow }
  /** The key names a run of another Agent. */
  | { kind: 'key_reused' }
  | { kind: 'in_progress' }
  | { kind: 'daily_limit'; resumesAt: number };

export type TestRunSettlement =
  | { status: 'answered'; result: TestRunResult; terminal: RecordUsageTerminalInput }
  | { status: 'failed'; failure: TestRunFailure; result?: TestRunResult; terminal: RecordUsageTerminalInput };

/** What a run's caller learns of it: never its instance, submission, plan or IDs. */
export interface TestRunView {
  runToken: string;
  agentId: string;
  status: TestRunStatus;
  failure: TestRunFailure | null;
  result: TestRunResult | null;
  createdAt: number;
}

/**
 * Admission and dispatch, as the caller asks the state store for them. The
 * store derives the row's plan and instance from `initialData.runtimePlan`,
 * so the plan model access reads and the plan the tools mount from are one.
 */
export interface TestRunStartRequest {
  run: Omit<TestRunAdmissionRequest, 'instanceId' | 'planJson'>;
  /** The first ask, escaped as Slack user text is. */
  message: string;
  /** The test agent's creation data (agents/test-turn.ts). */
  initialData: { runtimePlan: unknown } & Record<string, unknown>;
}

export type TestRunStartResult =
  | { kind: 'admitted' | 'replayed'; run: TestRunView }
  | { kind: 'key_reused' }
  | { kind: 'in_progress' }
  | { kind: 'daily_limit'; resumesAt: number };

export interface TestRunQuery {
  organizationId: string;
  actorMembershipId: string;
  runToken: string;
}

export interface TestRunReplayQuery {
  organizationId: string;
  actorMembershipId: string;
  idempotencyKey: string;
}

/** The state store's test runs, served only on a deployment serving many installations. */
export interface TestRunStore {
  start(request: TestRunStartRequest): Promise<TestRunStartResult>;
  /** The caller's run under an idempotency key, settled a step further if one is due. */
  replay(query: TestRunReplayQuery): Promise<TestRunView | undefined>;
  /** The caller's run, settled a step further if one is due; another's, or one past its hour, is none. */
  observe(query: TestRunQuery): Promise<TestRunView | undefined>;
}

