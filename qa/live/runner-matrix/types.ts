/**
 * Shared shapes for the runner-matrix driver. Everything here is public and
 * coordinate-free: channel, workspace, Worker and bot identifiers only ever
 * appear in a private plan written to the operator's record directory.
 */

export const MATRIX_CASES = ['parity', 'first-status', 'long-turns', 'redeploy-mid-turn', 'rate-limit'] as const;
export type MatrixCaseId = typeof MATRIX_CASES[number];

export type AgentRef = 'a' | 'b';
export type Where = 'channel' | 'dm';

export interface MatrixSpec {
  schema: 'chickpea-runner-matrix-spec/v1';
  description: string;
  defaults: {
    /** Bot replies closer together than this form one final (first message + continuations). */
    continuationGapMs: number;
    /** Extra observation time after the latest expected final. */
    collectGraceMs: number;
    /** Minimum time between arming the harness and the first send. */
    minLeadMs: number;
  };
  bounds: {
    firstStatus: { p95Ms: number; maxMs: number };
    redeployProbe: { maxMs: number };
    longTurn: { minDurationMs: number; minChars: number; continuationThresholdChars: number };
  };
  prompts: Record<'parityChannel' | 'parityDm' | 'parityFollowup' | 'short' | 'long' | 'burst', string>;
  cases: {
    parity: { atMs: number; dmAtMs: number; followupDelayMs: number };
    'first-status': {
      anchorAtMs: number;
      warmupAtMs: number | null;
      sidesAtMs: number;
      spacingMs: number;
      /** Pattern of side threads, cycled when a larger count is requested. */
      sides: Array<{ agent: AgentRef; where: Where }>;
      count: number;
    };
    'long-turns': {
      atMs: number;
      spacingMs: number;
      count: number;
      /** Offset of the interruption hook from the first long turn; null disables it. */
      interruptAfterMs: number | null;
      requireInterruption: boolean;
    };
    'redeploy-mid-turn': {
      atMs: number;
      /** Start-to-start gap between sequential redeploy rounds. */
      roundGapMs: number;
      count: number;
      deployAfterMs: number;
      probeAfterMs: number;
    };
    'rate-limit': { atMs: number; spacingMs: number; count: number };
  };
  /** Expected upper bound for a turn's final, used to size the observation window. */
  expectedTurnMs: { short: number; long: number; redeploy: number };
}

export interface MatrixParams {
  lane: string;
  tag: string;
  workspaceId: string;
  worker: string;
  botUserId: string;
  channel: string;
  /** Explicit DM channel; otherwise the harness opens the DM with the bot user. */
  dm?: string | undefined;
  agents: Record<AgentRef, string>;
  cases: MatrixCaseId[];
  counts?: Partial<Record<'first-status' | 'long-turns' | 'redeploy-mid-turn' | 'rate-limit', number>>;
  /** Offline dry runs compress the schedule; live plans always use 1. */
  timeScale?: number;
}

export type ItemRole = 'root' | 'followup' | 'anchor' | 'warmup' | 'side' | 'long' | 'redeploy-a' | 'redeploy-b' | 'burst';

export interface PlanItem {
  label: string;
  caseId: MatrixCaseId;
  role: ItemRole;
  round?: number;
  agent: AgentRef | null;
  where: Where;
  /** Offset from T0; absent for items that wait for another thread's final. */
  atMs?: number;
  after?: { label: string; delayMs: number };
  /** Message text with a `{mention}` placeholder; always carries the run marker. */
  text: string;
  marker: string;
  long: boolean;
}

export interface PlanHook {
  id: string;
  kind: 'redeploy';
  caseId: MatrixCaseId;
  round?: number;
  atMs: number;
}

export interface MatrixPlan {
  schema: 'chickpea-runner-matrix-plan/v1';
  createdAt: string;
  tag: string;
  lane: string;
  workspaceId: string;
  worker: string;
  botUserId: string;
  channel: string;
  dm: string | null;
  agents: Record<AgentRef, string>;
  cases: MatrixCaseId[];
  timeScale: number;
  items: PlanItem[];
  hooks: PlanHook[];
  /** Offset from T0 after which every planned final should have landed. */
  endMs: number;
  minLeadMs: number;
  continuationGapMs: number;
  requireInterruption: boolean;
  bounds: MatrixSpec['bounds'];
  failureSignatures: Array<{ key: string; prefix: string }>;
}

/** One compact websocket observation recorded by the in-page harness. */
export interface FrameEvent {
  t: number;
  kind: string;
  channel: string;
  thread: string;
  ts?: string;
  status?: string;
  statusType?: string;
  who?: string;
  len?: number;
}

export interface SentRecord {
  label: string;
  caseId: MatrixCaseId;
  channel: string;
  t0: number;
  tAck: number;
  ok: boolean;
  ts?: string;
  thread?: string;
  error?: string;
  retries?: number;
}

export interface MessageSummary {
  ts: string;
  bot: boolean;
  who: string;
  textLen: number;
  blockTextLen: number;
  blockTypes: string[];
  footer: boolean;
  failure: string | null;
  marker: boolean;
  tail: string;
}

export interface BrowserExport {
  schema: 'chickpea-runner-matrix-export/v1';
  tag: string;
  armedT0: number | null;
  exportedAt: number;
  sent: SentRecord[];
  frames: FrameEvent[];
  /** Readback per `channel:thread_ts`, oldest first. */
  threads: Record<string, MessageSummary[]>;
  resolved: { dm: string | null; agents: Partial<Record<AgentRef, string>> };
  errors: string[];
}

export interface HookRecord {
  id: string;
  kind: 'redeploy';
  caseId: MatrixCaseId;
  round?: number;
  plannedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  exitCode: number | null;
  skipped: string | null;
  log: string | null;
}

export interface TailSegment { start: number; end: number | null; ready: number | null; exit: number | null; reason?: string }

export interface RunRecord {
  schema: 'chickpea-runner-matrix-run/v1';
  t0: number;
  startedAt: number;
  endedAt: number | null;
  hooks: HookRecord[];
  tail: { file: string | null; segments: TailSegment[]; skipped: string | null };
  attempts: Record<string, string>;
  interrupted: boolean;
}
