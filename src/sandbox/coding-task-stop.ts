import { CHICKPEA_CODING_WORKER_AGENT_NAME } from '../agents/names.ts';
import type { TurnProgress, TurnPullRequestProgress } from '../config/state-rpc.ts';
import {
  AgentObjectBindingUnavailableError,
  agentObjectBindingName,
  observeAgentSettlementBounded,
  type AgentObjectNamespace,
  type AgentUpdatesRoute,
} from '../slack/bounded-agent-observation.ts';
import type { SandboxTurnReader } from '../slack/turn-executor.ts';
import {
  parseCodingTaskRecord,
  type CodingTaskRecordV1,
  type SandboxCodingTaskStub,
} from './coding-task-record.ts';

/**
 * The runner's stop cascade for coding jobs (KTD4). After the host run's own
 * Flue `abort()`, the runner stops every coding worker the host turn's
 * active-task records name (./coding-task-record.ts) and confirms it, because
 * Flue discards the aborted `workspace_task` call's result. The stop note
 * reports each job confirmed or not (R23), and the coding active-work marker
 * clears only when every job is.
 */

/** How the stop reaches coding workers from outside their coordinator. */
export interface CodingWorkerStopClient {
  /**
   * One durable abort request for the instance's work. True when the
   * instance still had unsettled work (now marked for abort), false when it
   * reported nothing unsettled.
   */
  abort(instanceId: string): Promise<boolean>;
  /** The submission's settlement outcome; rejects once `signal` fires first. */
  awaitSettlement(instanceId: string, submissionId: string, signal: AbortSignal): Promise<string>;
}

export interface CodingTaskStopPorts {
  /** The host turn's active-task records. */
  listTasks(): Promise<CodingTaskRecordV1[]>;
  /** Drop a record the stop settled or reconciled. */
  settleTask(taskKey: string): Promise<void>;
  workers: CodingWorkerStopClient;
  /** The pull request egress recorded in a job's workspace for the host turn, for the stop note. */
  recordedPullRequest?(workspaceId: string): Promise<TurnPullRequestProgress | undefined>;
}

export interface CodingTaskStopOptions {
  /** abort() requests per worker (and reads of the records) before giving up. */
  abortAttempts?: number;
  /** Pause between those requests. */
  abortRetryDelayMs?: number;
  /** How long to wait for a job's own settlement once its worker reports nothing unsettled. */
  settlementWaitMs?: number;
  /** Test seam; production sleeps with a real timer. */
  sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_ABORT_ATTEMPTS = 5;
const DEFAULT_ABORT_RETRY_DELAY_MS = 1_000;
const DEFAULT_SETTLEMENT_WAIT_MS = 10_000;

/**
 * `stopped`: the stop ended the job. `finished`: the job had already settled
 * on its own before the stop took effect. `not_dispatched`: a record written
 * before a dispatch that never reached the worker. `unconfirmed`: the worker
 * did not confirm within the bound, so it may still be winding down.
 */
export type CodingTaskStopOutcome = 'stopped' | 'finished' | 'not_dispatched' | 'unconfirmed';

export interface CodingTaskStopResult {
  taskKey: string;
  toolCallId: string;
  workspace: string;
  workspaceId: string;
  instanceId: string;
  submissionId?: string;
  /** Whether the job is confirmed no longer running. */
  confirmed: boolean;
  outcome: CodingTaskStopOutcome;
  /** The pull request the job's workspace recorded for the host turn, if any. */
  pullRequest?: TurnPullRequestProgress;
}

export interface CodingTaskStopReport {
  /** False when the records could not be read: nothing about coding work is confirmed. */
  recordsRead: boolean;
  /** Every job settled or reconciled; only then may the coding active-work marker clear. */
  allSettled: boolean;
  tasks: CodingTaskStopResult[];
}

/**
 * Abort every coding worker the host turn's records name and confirm each
 * job. A worker's `abort()` is repeated within the bound until it reports
 * nothing unsettled (a failed request counts as one try), so work queued
 * behind the job is stopped too; the job's own settlement is then checked for
 * a bounded time. A record whose dispatch never landed is reconciled. A
 * confirmed record is dropped; an unconfirmed one is kept.
 */
export async function stopCodingTasks(
  ports: CodingTaskStopPorts,
  options: CodingTaskStopOptions = {},
): Promise<CodingTaskStopReport> {
  const attempts = Math.max(1, options.abortAttempts ?? DEFAULT_ABORT_ATTEMPTS);
  const retryDelayMs = options.abortRetryDelayMs ?? DEFAULT_ABORT_RETRY_DELAY_MS;
  const settlementWaitMs = options.settlementWaitMs ?? DEFAULT_SETTLEMENT_WAIT_MS;
  const sleep = options.sleep ?? defaultSleep;

  let records: CodingTaskRecordV1[] | undefined;
  for (let attempt = 1; attempt <= attempts && !records; attempt += 1) {
    try {
      records = await ports.listTasks();
    } catch {
      if (attempt < attempts) await sleep(retryDelayMs);
    }
  }
  if (!records) {
    console.warn('[chickpea] coding task records unreadable at stop');
    return { recordsRead: false, allSettled: false, tasks: [] };
  }

  // abort() is instance-wide, so each worker is stopped once for all its jobs.
  const instances = new Map<string, Promise<WorkerAbort>>();
  for (const record of records) {
    if (instances.has(record.instanceId)) continue;
    instances.set(record.instanceId, abortUntilClear(ports.workers, record.instanceId, attempts, retryDelayMs, sleep));
  }

  const tasks = await Promise.all(records.map(async (record): Promise<CodingTaskStopResult> => {
    const worker = await instances.get(record.instanceId)!;
    const outcome = await confirmTask(ports.workers, record, worker, settlementWaitMs);
    const confirmed = outcome !== 'unconfirmed';
    if (confirmed) {
      // The job is confirmed either way; a record left behind is dropped by
      // the next stop or pruned with its turn.
      await ports.settleTask(record.taskKey).catch(() => {
        console.warn('[chickpea] coding task record settle failed at stop');
      });
    }
    const pullRequest = await ports.recordedPullRequest?.(record.workspaceId).catch(() => undefined);
    return {
      taskKey: record.taskKey,
      toolCallId: record.toolCallId,
      workspace: record.workspace,
      workspaceId: record.workspaceId,
      instanceId: record.instanceId,
      ...(record.state === 'accepted' ? { submissionId: record.submissionId } : {}),
      confirmed,
      outcome,
      ...(pullRequest ? { pullRequest } : {}),
    };
  }));
  return { recordsRead: true, allSettled: tasks.every((task) => task.confirmed), tasks };
}

interface WorkerAbort {
  /** The instance reported nothing unsettled within the bound. */
  clear: boolean;
  /** Some abort() found unsettled work on the instance. */
  foundWork: boolean;
}

async function abortUntilClear(
  workers: CodingWorkerStopClient,
  instanceId: string,
  attempts: number,
  retryDelayMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<WorkerAbort> {
  let foundWork = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (!(await workers.abort(instanceId))) return { clear: true, foundWork };
      // Marked for abort; its settlement lands asynchronously, and a
      // response woken behind it needs its own abort.
      foundWork = true;
    } catch {
      // A failed request is tried again like a busy instance.
    }
    if (attempt < attempts) await sleep(retryDelayMs);
  }
  return { clear: false, foundWork };
}

async function confirmTask(
  workers: CodingWorkerStopClient,
  record: CodingTaskRecordV1,
  worker: WorkerAbort,
  settlementWaitMs: number,
): Promise<CodingTaskStopOutcome> {
  if (!worker.clear) return 'unconfirmed';
  // No receipt was recorded, so the dispatch never landed or its job has
  // just been stopped with everything else on the instance.
  if (record.state === 'dispatch_pending') return worker.foundWork ? 'stopped' : 'not_dispatched';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Coding task settlement wait ended.')), settlementWaitMs);
  try {
    const outcome = await workers.awaitSettlement(record.instanceId, record.submissionId, controller.signal);
    return outcome === 'aborted' ? 'stopped' : 'finished';
  } catch {
    return 'unconfirmed';
  } finally {
    clearTimeout(timer);
  }
}

/** A Sandbox Durable Object as the stop reads it. */
type ThreadSandbox = Pick<SandboxCodingTaskStub, 'readCodingTasks' | 'settleCodingTask'> &
  SandboxTurnReader;

/**
 * The progress a turn's Sandbox Durable Object recorded for it, from
 * whichever of its identities holds that turn (`sandboxes` opens the object
 * once per identity); undefined when none does.
 */
export async function readSandboxTurnProgress(
  sandboxes: Array<() => SandboxTurnReader>,
  turnId: string,
): Promise<TurnProgress | undefined> {
  for (const open of sandboxes) {
    try {
      const sandbox = open();
      if ((await sandbox.getTurnId()) !== turnId) continue;
      return await sandbox.getTurnProgress();
    } catch {
      // One identity can be unavailable during a rolling deploy.
    }
  }
  return undefined;
}

/**
 * The stop ports for one host turn on Cloudflare. `sandboxes` opens a Sandbox
 * Durable Object once per identity it may run under (the runner's
 * `sandboxTurnReaders`); `turnSandboxKey` is the turn's Sandbox
 * (slackTurnSandboxKey: the thread's, or a guest's own), the Durable Object
 * the coordinator writes the records to.
 */
export function threadCodingTaskStopPorts(input: {
  sandboxes: (sandboxKey: string) => Array<() => object>;
  turnSandboxKey: string;
  hostTurnId: string;
  workers: CodingWorkerStopClient;
}): CodingTaskStopPorts {
  // The coordinator writes through the primary Sandbox identity
  // (CLOUDFLARE_SANDBOX_OPTIONS), which cloudflareSandboxOptionVariants
  // lists first; a compatibility identity never holds records.
  const thread = (): ThreadSandbox => {
    const open = input.sandboxes(input.turnSandboxKey)[0];
    if (!open) throw new Error('No Sandbox binding');
    return open() as ThreadSandbox;
  };
  return {
    listTasks: async () => {
      const stored: unknown = await thread().readCodingTasks(input.hostTurnId);
      return (Array.isArray(stored) ? stored : []).flatMap((entry) => {
        const record = parseCodingTaskRecord(entry);
        return record ? [record] : [];
      });
    },
    settleTask: (taskKey) => thread().settleCodingTask(input.hostTurnId, taskKey),
    workers: input.workers,
    recordedPullRequest: async (workspaceId) => (await readSandboxTurnProgress(
      input.sandboxes(workspaceId) as Array<() => ThreadSandbox>,
      input.hostTurnId,
    ))?.pullRequest,
  };
}

/**
 * Coding workers reached through their Durable Object namespace, as the
 * bounded reader reaches them to observe a task. The abort request is the one
 * Flue's `abort()` sends; that handle drops the instance's answer, which is
 * what says whether anything was still unsettled. The binding is resolved on
 * first use, so a deployment without coding workers (and so without records)
 * never needs it.
 */
export function cloudflareCodingWorkerStopClient(
  env: Record<string, unknown> | undefined,
  options: { pollIntervalMs?: number } = {},
): CodingWorkerStopClient {
  const agentName = CHICKPEA_CODING_WORKER_AGENT_NAME;
  const bindingName = agentObjectBindingName(agentName);
  const route = (instanceId: string): AgentUpdatesRoute => {
    const binding = env?.[bindingName] as AgentObjectNamespace | undefined;
    if (!binding || typeof binding.idFromName !== 'function' || typeof binding.get !== 'function') {
      throw new AgentObjectBindingUnavailableError(bindingName);
    }
    const stub = binding.get(binding.idFromName(instanceId));
    return (request) => stub.fetch(request);
  };
  return {
    async abort(instanceId) {
      const url = `https://flue.invalid/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}/abort`;
      const response = await route(instanceId)(new Request(url, { method: 'POST' }));
      if (!response.ok) throw new Error(`Coding worker abort failed with status ${response.status}.`);
      const body = await response.json().catch(() => undefined) as { aborted?: unknown } | undefined;
      if (typeof body?.aborted !== 'boolean') throw new Error('Coding worker abort returned no result.');
      return body.aborted;
    },
    async awaitSettlement(instanceId, submissionId, signal) {
      const settlement = await observeAgentSettlementBounded(route(instanceId), {
        agentName,
        instanceId,
        submissionId,
        signal,
      }, options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs });
      return settlement.outcome;
    },
  };
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
