// A test run's lifecycle on real workerd, at installation tenancy: the state
// store's real lifecycle, store logic and Cloudflare instance port over DO
// SQLite, and a probe agent registered as chickpea-test-turn-v1 on a faux
// model, wired as Flue's generated Cloudflare entry wires an agent.
import { env } from 'cloudflare:workers';
import { DurableObject, type DurableObjectState } from 'cloudflare:workers';

import { defineTool, useModel, useTool } from '@flue/runtime';
import {
  configureFlueRuntime,
  createCloudflareAgentRuntime,
  createFlueContext,
  registerFlueAgents,
  resolveModel,
  setProvider,
} from '@flue/runtime/internal';
import {
  createCloudflareWorkerConfig,
  createFlueAgentClass,
  runWithCloudflareContext,
} from '@flue/runtime/cloudflare/internal';
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from '@earendil-works/pi-ai';
import { Agent, getAgentByName } from 'agents';
import * as v from 'valibot';

import { installationAgentExtension } from '../../../src/agents/cloudflare-extension.ts';
import { CHICKPEA_SUBMISSION_DURABILITY } from '../../../src/agents/submission-durability.ts';
import { objectInstallationEnv } from '../../../src/config/installation-scope.ts';
import type { PlatformEnv } from '../../../src/config/state-backend.ts';
import type { TestRunQuery, TestRunStartRequest } from '../../../src/management/test-run-types.ts';
import { installTestRunSchema, TestRunStoreLogic } from '../../../src/management/test-runs.ts';
import { DoSqlStateDb } from '../../../src/state/do-state-db.ts';
import { quiesceStateStoreForRestore } from '../../../src/state/state-store-host.ts';
import { cloudflareTestRunInstancePort } from '../../../src/state/test-run-instance.ts';
import { TestRunLifecycle, type TestRunStepMode } from '../../../src/state/test-run-lifecycle.ts';
import { UsageStoreLogic } from '../../../src/usage/store.ts';

const AGENT_NAME = 'chickpea-test-turn-v1';
const CLASS_NAME = 'FlueChickpeaTestTurnV1Agent';
const BINDING = 'FLUE_CHICKPEA_TEST_TURN_V1_AGENT';

/** An ask with "slow" in it calls a tool that never returns, so its submission never settles by itself. */
const faux = fauxProvider({ models: [{ id: 'test-run-probe' }] });
faux.setResponses(Array.from({ length: 64 }, () => (context: Context) => {
  const last = context.messages.at(-1) as { role: string; content: unknown } | undefined;
  const text = JSON.stringify(last?.content ?? '');
  if (last?.role === 'user' && text.includes('slow')) {
    return fauxAssistantMessage([fauxToolCall('wait_forever', {})], { stopReason: 'toolUse' });
  }
  return fauxAssistantMessage('Order 42 shipped on Monday.');
}));
setProvider(faux.provider);

export function TestRunProbe() {
  useModel('faux/test-run-probe');
  useTool(defineTool({
    name: 'wait_forever',
    description: 'Waits for something that never comes.',
    input: v.object({}),
    output: v.string(),
    async run() {
      return await new Promise<never>(() => undefined);
    },
  }));
  return 'Answer the question.';
}
TestRunProbe.agentName = AGENT_NAME;
TestRunProbe.durability = CHICKPEA_SUBMISSION_DURABILITY;
TestRunProbe.initialData = v.custom<unknown>(() => true);

registerFlueAgents([{ identity: AGENT_NAME, agent: TestRunProbe }]);
const agentIdentities = { [AGENT_NAME]: { bindingName: BINDING, className: CLASS_NAME } };

type AgentInstance = { name: string; env: Record<string, unknown>; ctx: { storage: unknown; id: { toString(): string } } };

const cloudflareAgents = createCloudflareAgentRuntime({
  agents: [{ name: AGENT_NAME, agent: TestRunProbe as never }],
  createContext: ({ instance, agentName, request, submissionId }: {
    instance: AgentInstance; agentName: string; request: Request; submissionId?: string;
  }) => createFlueContext({
    id: instance.name,
    agentName,
    env: instance.env ?? {},
    req: request,
    ...(submissionId ? { submissionId } : {}),
    agentConfig: { resolveModel },
  } as never),
  runWithInstanceContext: <T>(instance: AgentInstance, _agentName: string, fn: () => T) => runWithCloudflareContext({
    env: instance.env,
    storage: instance.ctx.storage,
    durableObjectIdentity: { bindingName: BINDING, className: CLASS_NAME, name: instance.name, id: instance.ctx.id.toString() },
  } as never, fn),
} as never);

export const FlueChickpeaTestTurnV1Agent = createFlueAgentClass({
  AgentBase: Agent,
  runtime: cloudflareAgents,
  className: CLASS_NAME,
  agentName: AGENT_NAME,
  extension: installationAgentExtension,
});

configureFlueRuntime({
  target: 'cloudflare',
  devMode: false,
  ...createCloudflareWorkerConfig({
    env,
    agentIdentities,
    fetchAgent: async (binding, instanceId, request) => (await getAgentByName(binding as never, instanceId)).fetch(request),
  }),
} as never);

/** The installation's state store, reduced to what a test run uses. */
export class TestRunStateStore extends DurableObject {
  private readonly scopedEnv: PlatformEnv;
  private readonly testRuns: TestRunStoreLogic;
  private readonly usage: UsageStoreLogic;
  private readonly lifecycle: TestRunLifecycle;
  /** The lifecycle's clock runs this far ahead of the platform's, to reach its bounds. */
  private offset = 0;

  constructor(ctx: DurableObjectState, workerEnv: unknown) {
    super(ctx, workerEnv);
    this.scopedEnv = objectInstallationEnv(ctx, workerEnv as PlatformEnv);
    const db = new DoSqlStateDb(ctx.storage as never);
    installTestRunSchema(db);
    this.usage = new UsageStoreLogic(db);
    this.testRuns = new TestRunStoreLogic(db, this.usage);
    this.lifecycle = new TestRunLifecycle({
      stores: () => ({ testRuns: this.testRuns, usage: this.usage }),
      port: async () => cloudflareTestRunInstancePort(this.scopedEnv, async () => TestRunProbe),
      armAlarm: async (at) => { await this.ctx.storage.setAlarm(at); },
      now: () => Date.now() + this.offset,
      platformEnv: this.scopedEnv,
    });
  }

  async start(request: TestRunStartRequest) {
    return this.lifecycle.start(request);
  }

  async observe(query: TestRunQuery) {
    return this.lifecycle.observe(query) ?? null;
  }

  async pass(mode: TestRunStepMode) {
    return this.lifecycle.pass(mode);
  }

  async advance(ms: number) {
    this.offset += ms;
  }

  async row(testRunId: string) {
    return this.testRuns.get(testRunId) ?? null;
  }

  /**
   * A restore to a moment inside a run brings its row and its usage back as
   * they were then, live; its instance, in no restore plan, stays erased.
   */
  async restoreRow(testRunId: string) {
    const row = this.testRuns.get(testRunId);
    if (!row) return;
    const sql = this.ctx.storage.sql;
    sql.exec(`UPDATE management_test_runs SET status = 'running', failure = NULL, result_json = NULL, erased_at = NULL
      WHERE test_run_id = ?`, testRunId);
    sql.exec('DELETE FROM usage_measurements WHERE operation_id = ?', row.usageOperationId);
    sql.exec(`UPDATE usage_operations SET status = 'admitted', finished_at = NULL WHERE operation_id = ?`, row.usageOperationId);
  }

  async usageOf(operationId: string) {
    const detail = this.usage.getOperation(operationId);
    return detail ? { status: detail.operation.status, billingRunId: detail.measurements.at(-1)?.billingRunId ?? null } : null;
  }

  /** Whether a restore may be prepared now, as the state store's restore quiesce decides. */
  async restoreRefusal() {
    try {
      quiesceStateStoreForRestore({
        turnJobs: { hasInterruptedAlarmDispatch: () => false, hasHandoffs: () => false },
        gatewayInbox: { hasInFlight: () => false },
        testRuns: this.testRuns,
      });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** As the state store's alarm: an hour-old run goes, every run takes a step, and the alarm looks again when one is due. */
  async wake() {
    this.testRuns.eraseExpired(Date.now() + this.offset);
    await this.lifecycle.pass();
    const due = this.lifecycle.nextDueAt();
    if (due !== undefined) await this.ctx.storage.setAlarm(due);
  }

  async alarmAt() {
    return await this.ctx.storage.getAlarm();
  }

  override async alarm() {
    await this.wake();
  }
}

/** The SQL tables an agent instance's own storage holds now, read through its host export. */
async function instanceTables(instanceId: string, installationId: string): Promise<string[]> {
  const namespace = (env as unknown as Record<string, { idFromName(name: string): unknown; get(id: unknown): unknown }>)[BINDING]!;
  const stub = namespace.get(namespace.idFromName(instanceId)) as {
    chickpeaHostExportPage(request: { installationId: string; mode: 'full'; cursor?: string | null }):
      Promise<{ lines: string; nextCursor: string | null }>;
  };
  const tables: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 100; pages += 1) {
    const page: { lines: string; nextCursor: string | null } = await stub.chickpeaHostExportPage({ installationId, mode: 'full', cursor });
    for (const line of page.lines.split('\n').filter(Boolean)) {
      const record = JSON.parse(line) as { t?: string; table?: string };
      if (record.t === 'table' && record.table && !record.table.startsWith('__miniflare')) tables.push(record.table);
    }
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return tables;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('ok');
    const name = url.searchParams.get('store');
    if (!name) return new Response('store is required', { status: 400 });
    const stores = (env as unknown as Record<string, { getByName(name: string): TestRunStateStore }>).STATE!;
    const store = stores.getByName(name);
    const body = request.method === 'POST' ? await request.json() as Record<string, unknown> : {};
    const json = (value: unknown) => Response.json(value ?? null);
    switch (url.pathname) {
      case '/start': return json(await store.start(body.request as TestRunStartRequest));
      case '/observe': return json(await store.observe(body.query as TestRunQuery));
      case '/pass': return json(await store.pass((body.mode as TestRunStepMode | undefined) ?? 'due'));
      case '/advance': return json(await store.advance(Number(body.ms)));
      case '/row': return json(await store.row(String(body.testRunId)));
      case '/restore-row': return json(await store.restoreRow(String(body.testRunId)));
      case '/usage': return json(await store.usageOf(String(body.operationId)));
      case '/restore-refusal': return json(await store.restoreRefusal());
      case '/wake': return json(await store.wake());
      case '/alarm-at': return json(await store.alarmAt());
      case '/instance-tables': return json(await instanceTables(String(body.instanceId), String(body.installationId)));
      default: return new Response('not found', { status: 404 });
    }
  },
};
