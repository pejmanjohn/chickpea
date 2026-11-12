import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import ts from 'typescript';

import { wakeSlackAgentObject } from '../../src/agents/turn-input.ts';
import { processDirectSlackEvent } from '../../src/channels/slack.ts';
import { deploymentTenancy, installationOwnershipOf } from '../../src/config/installation-scope.ts';
import type { PlatformEnv } from '../../src/config/state-backend.ts';
import type { StateRpcResult } from '../../src/config/state-rpc.ts';
import { emitRuntimeLatency, StateRpcSummary } from '../../src/observability/runtime-latency.ts';
import { admissionStatusPresentation, showAdmissionStatus } from '../../src/slack/admission-activity.ts';
import { admissionAgentInstance } from '../../src/slack/admission-agent-wake.ts';
import { withAgentAppExecution } from '../../src/slack/agent-apps/live.ts';
import { CHICKPEA_SLACK_AGENT_BINDING } from '../../src/slack/bounded-agent-observation.ts';
import type { SlackDirectDelivery, SlackDirectDeliveryResult } from '../../src/slack/claim-store.ts';
import { recordFirstHostedSlackDelivery } from '../../src/slack/hosted-installation.ts';
import { slackInstallationCredentialId } from '../../src/slack/hosted-slack-app.ts';
import { resolveSlackInstallationCredentials, SlackCredentialRecoveryOnlyError } from '../../src/slack/installation-credentials.ts';
import {
  cacheSlackInstallationExecutionContexts,
  carriedGatewayIdentity,
  effectiveTurnSlackInstallationId,
  resolveSlackInstallationExecutionContext,
} from '../../src/slack/installation-execution.ts';
import { localSlackPresentationStatePort } from '../../src/slack/presentation-state-port.ts';
import { receiptRunnerWake } from '../../src/slack/receipt-runner-wake.ts';
import { slackAgentThreadKey } from '../../src/slack/thread-key.ts';
import type { ThreadRunnerJob } from '../../src/slack/thread-runner-jobs.ts';
import { threadRunnerStub } from '../../src/slack/thread-runner-rpc.ts';
import { slackTurnExecutor } from '../../src/slack/turn-executor-flag.ts';
import { ConversationOrder } from '../../src/state/conversation-order.ts';
import { ResidencyHold, residencyHoldMs } from '../../src/state/residency-hold.ts';
import { localGatewayAppStores, type TagStateStores } from '../../src/state/tag-state-stores.ts';
import { ScriptedTimers } from './residency-hold.ts';

/**
 * TagStateStore's production admitSlackDelivery and every method it calls
 * (src/cloudflare.ts, transpiled, not copied), over a store's own stores and
 * env, without workerd. The thread runners in `env` decide the hand-offs.
 */

const cloudflare = ts.createSourceFile(
  'cloudflare.ts',
  readFileSync(new URL('../../src/cloudflare.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const stateClass = cloudflare.statements.find((node): node is ts.ClassDeclaration =>
  ts.isClassDeclaration(node) && node.name?.text === 'TagStateStore');
assert.ok(stateClass);
const stateMethod = (name: string) => {
  const method = stateClass.members.find((member) =>
    ts.isMethodDeclaration(member) && member.name.getText(cloudflare) === name);
  assert.ok(method, `production method ${name} exists`);
  return method.getText(cloudflare);
};
const moduleStatement = (name: string) => {
  const statement = cloudflare.statements.find((node) =>
    (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      declaration.name.getText(cloudflare) === name)));
  assert.ok(statement, `production ${name} exists`);
  return statement.getText(cloudflare);
};

const StoreProbe = vm.runInNewContext(
  ts.transpileModule(
    `${['RELAY_BATCH_WINDOW_MS', 'KEEP_WARM_WINDOW_MS', 'KEEP_WARM_TICK_MS', 'RECEIPT_OUTBOX_WRITERS', 'localSlackPresentationState', 'slackEventConversationKey']
      .map(moduleStatement).join('\n')}
class StoreProbe { ${[
      'admitSlackDelivery', 'admitDirectDelivery', 'admittingSlackState', 'afterSlackAdmission', 'admitToRunner', 'armReceiptDrainAfter',
      'wakeRunnerAtReceipt', 'sendRunnerWake', 'createAlarmIdentityResolver', 'wakeAgentAtHandoff', 'showStatusAtHandoff',
      'armAlarmNoLaterThan', 'setAlarmNoLaterThan', 'admissionWakeAt', 'runnerMode', 'keepWarmTickAt', 'hold', 'offerCreatedStop',
    ].map(stateMethod).join('\n')} }\nStoreProbe`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText,
  {
    Date,
    Promise,
    Number,
    console,
    ConversationOrder,
    ResidencyHold,
    residencyHoldMs,
    StateRpcSummary,
    emitRuntimeLatency,
    deploymentTenancy,
    localGatewayAppStores,
    recordFirstHostedSlackDelivery,
    resolveSlackInstallationCredentials,
    slackInstallationCredentialId,
    SlackCredentialRecoveryOnlyError,
    processDirectSlackEvent,
    receiptRunnerWake,
    threadRunnerStub,
    slackTurnExecutor: (env: Record<string, unknown>) => slackTurnExecutor(env, {}),
    slackAgentThreadKey,
    installationOwnershipOf,
    effectiveTurnSlackInstallationId,
    carriedGatewayIdentity,
    admissionAgentInstance,
    wakeSlackAgentObject,
    CHICKPEA_SLACK_AGENT_BINDING,
    admissionStatusPresentation,
    showAdmissionStatus,
    localSlackPresentationStatePort,
    resolveSlackInstallationExecutionContext,
    withAgentAppExecution,
    cacheSlackInstallationExecutionContexts,
  },
) as new () => object;

export interface DirectStore {
  admitSlackDelivery(delivery: SlackDirectDelivery): Promise<StateRpcResult<SlackDirectDeliveryResult>>;
  /** What each hand-off sent a runner, in order, with the runner's name. */
  handed: Array<{ name: string; job: ThreadRunnerJob }>;
  /** Runner wakes sent at receipt. */
  wakes: string[];
  /** The work this store held with its waitUntil. */
  held: Array<Promise<unknown>>;
  /** Alarm times set, in order. */
  alarms: number[];
  /** Created stops this store offered its runners. */
  stopOffers: number;
  /** When the residency hold lets this store go, once a person's turn held it (scripted timers: nothing waits). */
  heldUntil(): number[];
}

/**
 * A state store over `stores` and `env`, whose runners record wakes and admit
 * every hand-off. `env` should carry the deployment's keyring.
 */
export function directStore(stores: TagStateStores, env: PlatformEnv): DirectStore {
  const handed: DirectStore['handed'] = [];
  const wakes: string[] = [];
  const held: Array<Promise<unknown>> = [];
  const alarms: number[] = [];
  let alarm: number | null = null;
  let stopOffers = 0;
  const runners = {
    getByName: (name: string) => ({
      wake: async () => { wakes.push(name); },
      admit: async (job: ThreadRunnerJob) => {
        handed.push({ name, job: JSON.parse(JSON.stringify(job)) as ThreadRunnerJob });
        return { admitted: true };
      },
    }),
  };
  const storeEnv = { SLACK_THREAD_RUNNER: runners, ...env };
  const timers = new ScriptedTimers(() => Date.now());
  const probe = Object.assign(new StoreProbe(), {
    env: storeEnv,
    stores,
    conversationHold: new ResidencyHold(residencyHoldMs(storeEnv), timers),
    directAdmissions: new ConversationOrder(),
    firstHandoffs: new Set<string>(),
    boot: { call() {} },
    ctx: {
      storage: {
        getAlarm: async () => alarm,
        setAlarm: async (at: number) => { alarm = at; alarms.push(at); },
      },
      waitUntil: (promise: Promise<unknown>) => { held.push(promise); },
    },
    call<T>(run: (value: TagStateStores) => T): StateRpcResult<T> {
      try {
        return { ok: true, value: run(stores) };
      } catch (error) {
        return { ok: false, error: { code: 'internal', message: (error as Error).message } };
      }
    },
    deliverStopNotices: async () => { stopOffers += 1; },
  }) as unknown as DirectStore;
  return {
    admitSlackDelivery: (delivery) => probe.admitSlackDelivery(delivery),
    handed,
    wakes,
    held,
    alarms,
    get stopOffers() { return stopOffers; },
    heldUntil: () => timers.pending(),
  };
}
