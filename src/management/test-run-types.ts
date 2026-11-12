/**
 * A practice run's shapes (management/test-runs.ts): the row, what admission
 * and settlement take, and what its caller and the state store's RPC see.
 * Internally a practice run is still a test run: one engine, one table.
 */
import type { PlatformFundingRefusal } from '../config/platform-funding.ts';
import type { AdmitUsageOperationInput, RecordUsageTerminalInput } from '../usage/types.ts';

export type TestRunStatus = 'admitted' | 'running' | 'answered' | 'failed';

/**
 * Why a run failed. `not_dispatched`: no submission 30 s after admission.
 * `deadline`: Flue's timeout, a direct message's, or the store's deadline 30 s after it. `out_of_usage` and
 * `daily_limit`: the plan's funding refused it, as it would a direct
 * message. `cancelled`: an operator's cancellation pass while the workspace
 * was suspended.
 */
export type TestRunFailure = 'not_dispatched' | 'deadline' | 'out_of_usage' | 'daily_limit' | 'cancelled' | 'failed';

/**
 * One tool call or skill load of a run, as its caller sees it: never an
 * internal ID. `why` is Chickpea's own sentence; what the service said is
 * only in `result`.
 */
export interface PracticeStep {
  kind: 'tool' | 'skill';
  /** The service's name, as an Admin gave it. */
  service?: string;
  /** The tool's own name (an MCP server's, or Chickpea's), or the skill's. */
  tool: string;
  /** Its arguments, on one line, at most 200 characters. */
  input?: string;
  outcome: 'ok' | 'refused' | 'failed';
  why?: string;
  /** What the tool handed the Agent's model, as text, cut to the run's bound. */
  result?: { data: string; size: number; truncated: boolean };
  /** A connection request's method, for a follow-up's Read line; no result shows it. */
  method?: string;
}

/**
 * More of a listed step's cut result than its excerpt: the result as the
 * Agent read it, after the step's exclusions and redaction, whole or up to
 * the run's total. `step` counts the listed steps from 1. The store keeps it
 * beside the run, for the run's hour, and never in the run's result.
 */
export interface PracticeKeptResult {
  step: number;
  data: string;
}

/** What a run ran: the version handle get_agent returns, never a revision or an internal ID. */
interface PracticeRan {
  agentVersion: string;
  model: string;
  effort?: string;
  /** Whether the Agent's memory was in its prompt. */
  memory: boolean;
  place: 'dm';
}

/** A way to fix what a run could not use, in the 5.0 tools' fix shape. */
export type PracticeFix =
  | { label: string; url: string }
  | { label: string; tool: string; arguments: Record<string, unknown> };

/** A connection a run left out, since nothing in it is marked as a read, by its name, with its fix when it has one. */
export interface PracticeLeftOut {
  service: string;
  fix?: PracticeFix;
}

/**
 * What a run keeps for its caller. Admission writes what it ran, what a
 * Slack message could use that it could not, and what it could; settlement
 * adds the reply and steps, or why it failed.
 */
export interface TestRunResult {
  ran?: PracticeRan;
  /** A connection with no reads was left out, so an answer that needs it can't be judged. */
  partial?: true;
  /** A follow-up's oldest answered turns that its message left out for length: the Agent never saw them. */
  droppedTurns?: number;
  off?: string[];
  /** Each connection left out, as its own field: `off` says the same in a sentence a result's fit can cut. */
  leftOut?: PracticeLeftOut[];
  available?: Array<{ service: string; tools: string[] }>;
  fixes?: PracticeFix[];
  reply?: string;
  replyTruncated?: true;
  read?: string[];
  steps?: PracticeStep[];
  /** The calls past the listed steps. */
  moreSteps?: number;
  /** The skills it loaded, over every call; a row from before practice runs has none. */
  skills?: string[];
  /** The plan's refusal, which a direct message would get in the same words. */
  funding?: PlatformFundingRefusal;
  /** A failure Chickpea credited back, as a direct message's is. */
  creditedBack?: true;
}

export interface TestRunRow {
  testRunId: string;
  runToken: string;
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
  erasedAt: number | null;
  /** The practice conversation; null on a row from before practice runs. */
  practiceId: string | null;
  turn: number | null;
  /** The question, for its hour; then null. */
  question: string | null;
  questionDigest: string | null;
  planDigest: string | null;
  settledAt: number | null;
}

/**
 * What makes two asks the same request: a key, a run going or a repeat
 * matches on these. `practiceId`: the conversation the ask continues, or
 * null for a first question.
 */
export interface PracticeAsk {
  agentId: string;
  practiceId: string | null;
  questionDigest: string;
}

export interface TestRunAdmissionRequest extends PracticeAsk {
  testRunId: string;
  runToken: string;
  organizationId: string;
  actorMembershipId: string;
  idempotencyKey: string;
  instanceId: string;
  /** The compiled plan, as the dispatch's creation data carries it. */
  planJson: string;
  usage: AdmitUsageOperationInput;
  /** A first question's conversation, minted for it; a follow-up's turn is the store's to number. */
  newPracticeId: string;
  question: string;
  /** The compiled plan's digest without what each compile makes anew. */
  planDigest: string;
  /** What admission knows of the run, kept beside its outcome. */
  admitted: Pick<TestRunResult, 'ran' | 'partial' | 'off' | 'leftOut' | 'available' | 'fixes'>;
}

/** An earlier answered turn of a practice conversation, as the store quotes it to the next. */
export interface PracticeTurn {
  turn: number;
  question: string;
  reply: string;
  steps: readonly PracticeStep[];
  /** Its calls past the listed steps. */
  moreSteps?: number;
}

export type TestRunAdmission =
  /**
   * `earlier`: the conversation's answered turns still kept, oldest first;
   * none for a first question. `expired`: its oldest turns past their hour,
   * whose text is gone, so nothing quotes them.
   */
  | { kind: 'admitted'; row: TestRunRow; earlier: PracticeTurn[]; expired: number }
  /** The same caller's key for the same ask: the stored run, before any check. */
  | { kind: 'replayed'; row: TestRunRow }
  /** The same ask, going now: that run. */
  | { kind: 'running'; row: TestRunRow }
  /** The same ask on the same plan, answered moments ago: that run. */
  | { kind: 'repeat'; row: TestRunRow }
  /**
   * The conversation's last turn is still going, with its token; or, with
   * none, an older Worker version's one-run lock holds the installation.
   */
  | { kind: 'in_progress'; runToken?: string }
  /**
   * The conversation a follow-up names is not the caller's open one with
   * this Agent: unknown, another person's or another Agent's, an hour past
   * its latest answer, or at its last turn.
   */
  | { kind: 'ended' };

/** What the model-access lookup's binding answers for a run: undefined when it refuses the submission. */
export interface TestRunModelAccessBinding {
  /** The run's plan, only while the run is live. */
  runtimePlan?: unknown;
  /** The submission landed after the run's instance was erased, so the run is unerased again. */
  reopened?: true;
}

export type TestRunSettlement =
  | { status: 'answered'; result: TestRunResult; results?: PracticeKeptResult[]; terminal: RecordUsageTerminalInput }
  | { status: 'failed'; failure: TestRunFailure; result?: TestRunResult; terminal: RecordUsageTerminalInput };

/** What a run's caller learns of it: never its instance, submission, plan or IDs. */
export interface TestRunView {
  runToken: string;
  agentId: string;
  status: TestRunStatus;
  failure: TestRunFailure | null;
  result: TestRunResult | null;
  createdAt: number;
  settledAt: number | null;
  practiceId: string | null;
  turn: number | null;
  question: string | null;
  /** The run from moments ago, returned again rather than run twice. */
  repeat?: true;
  /**
   * An answered first question only: the caller's latest earlier answered run
   * of the same question to the same Agent, while it can be read, that ran
   * an earlier version of the Agent.
   */
  before?: { runToken: string; agentVersion: string };
}

/**
 * Admission and dispatch, as the caller asks the state store for them. The
 * store derives the row's plan and instance from `initialData.runtimePlan`,
 * so the plan model access reads and the plan the tools mount from are one.
 * It writes the message itself, from the question and its own rows of the
 * conversation, so no caller supplies an earlier turn.
 */
export interface TestRunStartRequest {
  /** `coordinateToken`: the plan's, which names the run's Channel stand-in. */
  run: Omit<TestRunAdmissionRequest, 'instanceId' | 'planJson'> & { coordinateToken: string };
  /** The test agent's creation data (agents/test-turn.ts), but for what only the store sets. */
  initialData: { runtimePlan: unknown } & Record<string, unknown>;
}

export type TestRunStartResult =
  | { kind: 'admitted' | 'replayed' | 'running' | 'repeat'; run: TestRunView }
  | { kind: 'in_progress'; runToken?: string }
  | { kind: 'ended' };

export interface TestRunQuery {
  organizationId: string;
  actorMembershipId: string;
  runToken: string;
}

/** One listed step of the caller's run, read from `offset`: get_practice_run with `step`. */
export interface TestRunStepQuery extends TestRunQuery {
  /** From 1, as the run's steps are listed. */
  step: number;
  offset: number;
}

/**
 * What the store kept of a step's result beyond its excerpt: at most
 * `PRACTICE_STEP_READ_CHARS` from the offset, and how long all it kept is.
 */
export interface TestRunStepResult {
  data: string;
  kept: number;
}

/** A key names a run only for the same ask: any other reads as no run. */
export interface TestRunReplayQuery extends PracticeAsk {
  organizationId: string;
  actorMembershipId: string;
  idempotencyKey: string;
}

/** Whose runs of which Agent a listing reads: only the caller's own. */
export interface PracticeRunsQuery {
  organizationId: string;
  actorMembershipId: string;
  agentId: string;
}

/** One run in a listing: never its reply, steps or results, which get_practice_run returns. */
export interface PracticeRunListing {
  runToken: string;
  practiceId: string;
  turn: number;
  status: TestRunStatus;
  question: string;
  createdAt: number;
  agentVersion?: string;
}

/** The state store's test runs, served only on a deployment serving many installations. */
export interface TestRunStore {
  start(request: TestRunStartRequest): Promise<TestRunStartResult>;
  /** The caller's run under an idempotency key, settled a step further if one is due. */
  replay(query: TestRunReplayQuery): Promise<TestRunView | undefined>;
  /** The caller's run, settled a step further if one is due; another's, or one past its hour, is none. */
  observe(query: TestRunQuery): Promise<TestRunView | undefined>;
  /** The caller's practice runs of one Agent they can still read, newest first, as they stand. */
  list(query: PracticeRunsQuery): Promise<PracticeRunListing[]>;
  /** What the store kept of one step's cut result, while the caller can read the run; none past its excerpt is undefined. */
  stepResult(query: TestRunStepQuery): Promise<TestRunStepResult | undefined>;
}

