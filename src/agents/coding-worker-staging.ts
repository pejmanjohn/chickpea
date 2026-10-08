import { isCloudflareTarget } from '../config/runtime-target.ts';
import {
  codingWorkerInstanceId,
  parseCodingWorkerBinding,
  type CodingWorkerBinding,
} from '../sandbox/coding-worker-binding.ts';
import { sha256Hex } from '../security/digest.ts';
import { isStorableRequestText } from '../usage/validation.ts';
import { FLUE_CLOUDFLARE_EXTENSION_BRAND, installationAgentObject } from './cloudflare-extension.ts';
import { CHICKPEA_CODING_WORKER_AGENT_NAME } from './names.ts';
import type { TurnInputSql } from './turn-input.ts';

/**
 * What the coordinator stages in the coding worker's own object before it
 * dispatches a task, so the trusted model-access lookup can bind the
 * worker's attempt before the agent renders (Flue keeps `initialData` to
 * itself until then).
 *
 * The binding, per instance: the attempt binds its frozen credential. Only a
 * binding of an installation of a deployment serving many is staged:
 * standalone workers read the installation's current keys. The instance ID
 * is a digest of the binding, so a staged binding that hashes to the
 * instance reading it is the one the coordinator dispatched; the first write
 * stays, as Flue keeps the first `initialData`.
 *
 * The parent run, per submission: the run the coordinator's own requests are
 * recorded under, staged for every worker. One worker instance serves every
 * task its binding names, across runs, so the run is keyed by the task's
 * submission, which the coordinator derives from the task key before
 * dispatching it (`codingWorkerSubmissionId`). The lookup reads the row for
 * its attempt's own submission and names that run on the attempt and its
 * grant, so the worker's requests are recorded under the run that delegated.
 * The first write stays, as the derived submission is the same on a retry.
 */

const STAGED_BINDING_TABLE = 'chickpea_coding_worker_binding';

function ensureStagedBindingTable(sql: TurnInputSql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${STAGED_BINDING_TABLE} (
      instance_id TEXT PRIMARY KEY,
      binding_json TEXT NOT NULL,
      staged_at INTEGER NOT NULL
    )`,
  );
}

/** Worker-object side: keep the first binding staged for this instance. */
export function writeStagedCodingWorkerBinding(sql: TurnInputSql, json: string, now: number): void {
  const binding = parseCodingWorkerBinding(JSON.parse(json));
  ensureStagedBindingTable(sql);
  sql.exec(
    `INSERT INTO ${STAGED_BINDING_TABLE} (instance_id, binding_json, staged_at) VALUES (?, ?, ?)
     ON CONFLICT(instance_id) DO NOTHING`,
    codingWorkerInstanceId(binding), json, now,
  );
}

/** The binding staged for `instanceId`, verified against it; undefined when none was staged. */
export function readStagedCodingWorkerBindingFrom(
  sql: TurnInputSql,
  instanceId: string,
): CodingWorkerBinding | undefined {
  ensureStagedBindingTable(sql);
  const row = sql.exec(
    `SELECT binding_json FROM ${STAGED_BINDING_TABLE} WHERE instance_id = ?`,
    instanceId,
  ).toArray()[0];
  if (typeof row?.binding_json !== 'string') return undefined;
  const binding = parseCodingWorkerBinding(JSON.parse(row.binding_json));
  if (codingWorkerInstanceId(binding) !== instanceId) {
    throw new Error('The staged coding worker binding belongs to another instance.');
  }
  return binding;
}

const STAGED_RUN_TABLE = 'chickpea_coding_worker_run';

function ensureStagedRunTable(sql: TurnInputSql): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS ${STAGED_RUN_TABLE} (
      submission_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      staged_at INTEGER NOT NULL
    )`,
  );
}

/** Worker-object side: keep the first parent run staged for this submission. */
export function writeStagedCodingWorkerRun(sql: TurnInputSql, submissionId: unknown, runId: unknown, now: number): void {
  // A run the request records would refuse would fail every one of the worker's records.
  if (!isStorableRequestText(submissionId) || !isStorableRequestText(runId)) {
    throw new Error('A staged coding worker run needs a submission ID and a run ID of at most 256 bytes.');
  }
  ensureStagedRunTable(sql);
  sql.exec(
    `INSERT INTO ${STAGED_RUN_TABLE} (submission_id, run_id, staged_at) VALUES (?, ?, ?)
     ON CONFLICT(submission_id) DO NOTHING`,
    submissionId, runId, now,
  );
}

/** The parent run staged for `submissionId`; undefined when none was staged. */
export function readStagedCodingWorkerRunFrom(sql: TurnInputSql, submissionId: string): string | undefined {
  ensureStagedRunTable(sql);
  const row = sql.exec(
    `SELECT run_id FROM ${STAGED_RUN_TABLE} WHERE submission_id = ?`,
    submissionId,
  ).toArray()[0];
  return typeof row?.run_id === 'string' ? row.run_id : undefined;
}

interface WorkerObjectInstance {
  ctx: { id: { name?: string }; storage: { sql: TurnInputSql } };
}

type AgentObjectClass = new (...args: never[]) => object;

/** The coding worker's `cloudflare` export: an installation's agent object that accepts a staged binding. */
export const codingWorkerCloudflareExtension = {
  base: (Base: AgentObjectClass): AgentObjectClass =>
    class ChickpeaCodingWorkerObject extends (
      installationAgentObject(Base) as new (...args: never[]) => WorkerObjectInstance
    ) {
      /** Host RPC: stage this instance's binding before its first dispatch. */
      chickpeaStageCodingWorkerBinding(json: string): void {
        if (typeof json !== 'string') throw new Error('Coding worker binding must be serialized.');
        const name = this.ctx.id.name;
        if (name !== undefined && codingWorkerInstanceId(parseCodingWorkerBinding(JSON.parse(json))) !== name) {
          throw new Error('The coding worker binding belongs to another instance.');
        }
        writeStagedCodingWorkerBinding(this.ctx.storage.sql, json, Date.now());
      }

      /** Host RPC: stage the parent run of one of this instance's submissions before its dispatch. */
      chickpeaStageCodingWorkerRun(submissionId: string, runId: string): void {
        writeStagedCodingWorkerRun(this.ctx.storage.sql, submissionId, runId, Date.now());
      }
    },
  [FLUE_CLOUDFLARE_EXTENSION_BRAND]: true as const,
};

interface WorkerObjectStub {
  setName?(name: string): Promise<void>;
  chickpeaStageCodingWorkerBinding(json: string): Promise<void>;
  chickpeaStageCodingWorkerRun(submissionId: string, runId: string): Promise<void>;
}

interface WorkerObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): WorkerObjectStub;
}

/** Host side on Cloudflare: the worker's object, addressed the way Flue's dispatch does (by instance name). */
async function workerObject(
  env: Record<string, unknown> | undefined,
  bindingName: string,
  instanceId: string,
): Promise<WorkerObjectStub> {
  const namespace = env?.[bindingName] as WorkerObjectNamespace | undefined;
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw new Error(`Agent object binding ${bindingName} is unavailable.`);
  }
  const stub = namespace.get(namespace.idFromName(instanceId));
  // A staging call is the worker's first contact; Flue's addressing names the object first.
  await stub.setName?.(instanceId);
  return stub;
}

/** Host side: stage the worker's binding in its object. */
export async function stageCodingWorkerBinding(
  env: Record<string, unknown> | undefined,
  bindingName: string,
  instanceId: string,
  binding: CodingWorkerBinding,
): Promise<void> {
  if (codingWorkerInstanceId(binding) !== instanceId) {
    throw new Error('The coding worker binding belongs to another instance.');
  }
  await (await workerObject(env, bindingName, instanceId)).chickpeaStageCodingWorkerBinding(JSON.stringify(binding));
}

/** Host side: stage, in the worker's object, the run its submission `submissionId` works for. */
export async function stageCodingWorkerRun(
  env: Record<string, unknown> | undefined,
  bindingName: string,
  instanceId: string,
  submissionId: string,
  runId: string,
): Promise<void> {
  await (await workerObject(env, bindingName, instanceId)).chickpeaStageCodingWorkerRun(submissionId, runId);
}

/** The binding staged in this worker's own object (Cloudflare only). */
export async function readStagedCodingWorkerBinding(instanceId: string): Promise<CodingWorkerBinding | undefined> {
  if (!isCloudflareTarget()) return undefined;
  const { getCloudflareContext } = await import('@flue/runtime/cloudflare');
  return readStagedCodingWorkerBindingFrom(getCloudflareContext().storage.sql, instanceId);
}

/** The parent run staged for this worker's own `submissionId` (Cloudflare only). */
export async function readStagedCodingWorkerRun(submissionId: string): Promise<string | undefined> {
  if (!isCloudflareTarget()) return undefined;
  const { getCloudflareContext } = await import('@flue/runtime/cloudflare');
  return readStagedCodingWorkerRunFrom(getCloudflareContext().storage.sql, submissionId);
}

/**
 * The submission ID Flue gives a dispatch that carries an idempotency key.
 * Flue documents this derivation as a frozen wire format; the coordinator
 * computes it to name the worker's submission before dispatching it.
 */
async function keyedSubmissionId(agentName: string, instanceId: string, idempotencyKey: string): Promise<string> {
  const digest = await sha256Hex(`flue-submission-key\n${agentName}\n${instanceId}\n${idempotencyKey}`);
  return `sub_ik_${digest.slice(0, 32)}`;
}

/** The submission a coding task dispatched to `instanceId` under `taskKey` runs as. */
export function codingWorkerSubmissionId(instanceId: string, taskKey: string): Promise<string> {
  return keyedSubmissionId(CHICKPEA_CODING_WORKER_AGENT_NAME, instanceId, taskKey);
}
