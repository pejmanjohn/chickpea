import { isCloudflareTarget } from '../config/runtime-target.ts';
import {
  codingWorkerInstanceId,
  parseCodingWorkerBinding,
  type CodingWorkerBinding,
} from '../sandbox/coding-worker-binding.ts';
import { FLUE_CLOUDFLARE_EXTENSION_BRAND, installationAgentObject } from './cloudflare-extension.ts';
import type { TurnInputSql } from './turn-input.ts';

/**
 * The coding worker's binding, staged beside its instance by the coordinator
 * before the worker is dispatched, so the trusted model-access lookup can
 * bind the attempt to the binding's frozen credential before the agent
 * renders (Flue keeps `initialData` to itself until then). Only a binding of
 * an installation of a deployment serving many is staged: standalone workers
 * read the installation's current keys.
 *
 * The instance ID is a digest of the binding, so a staged binding that hashes
 * to the instance reading it is the one the coordinator dispatched; the first
 * write stays, as Flue keeps the first `initialData`.
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
    },
  [FLUE_CLOUDFLARE_EXTENSION_BRAND]: true as const,
};

interface WorkerObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): {
    setName?(name: string): Promise<void>;
    chickpeaStageCodingWorkerBinding(json: string): Promise<void>;
  };
}

/**
 * Host side on Cloudflare: address the worker's object the way Flue's
 * dispatch does (by instance name) and stage its binding there.
 */
export async function stageCodingWorkerBinding(
  env: Record<string, unknown> | undefined,
  bindingName: string,
  instanceId: string,
  binding: CodingWorkerBinding,
): Promise<void> {
  if (codingWorkerInstanceId(binding) !== instanceId) {
    throw new Error('The coding worker binding belongs to another instance.');
  }
  const namespace = env?.[bindingName] as WorkerObjectNamespace | undefined;
  if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
    throw new Error(`Agent object binding ${bindingName} is unavailable.`);
  }
  const stub = namespace.get(namespace.idFromName(instanceId));
  // A staging call is the worker's first contact; Flue's addressing names the object first.
  await stub.setName?.(instanceId);
  await stub.chickpeaStageCodingWorkerBinding(JSON.stringify(binding));
}

type CloudflareContextReader = () => { storage: { sql: TurnInputSql } };
let cloudflareContext: CloudflareContextReader | undefined;

/** The binding staged in this worker's own object (Cloudflare only). */
export async function readStagedCodingWorkerBinding(instanceId: string): Promise<CodingWorkerBinding | undefined> {
  if (!isCloudflareTarget()) return undefined;
  cloudflareContext ??= (await import('@flue/runtime/cloudflare')).getCloudflareContext as unknown as CloudflareContextReader;
  return readStagedCodingWorkerBindingFrom(cloudflareContext().storage.sql, instanceId);
}
