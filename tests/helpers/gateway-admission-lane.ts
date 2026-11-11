import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import ts from 'typescript';

import { processGatewaySlackEnvelope } from '../../src/channels/slack.ts';
import {
  carriedGatewayIdentity,
  effectiveTurnSlackInstallationId,
} from '../../src/slack/installation-execution.ts';
import { installationOwnershipOf, scopeInstallationEnv } from '../../src/config/installation-scope.ts';
import { closeNodeStateStores, resolveStores, type AppStores, type PlatformEnv } from '../../src/config/state-backend.ts';
import { ConfigStoreLogic } from '../../src/config/store.ts';
import type { CustomAgentConfig } from '../../src/config/types.ts';
import { agentRoutineDeletion } from '../../src/routines/store.ts';
import type { SlackCanonicalAdmissionInput } from '../../src/slack/claim-store.ts';
import type { GatewayDeploymentClient } from '../../src/slack/gateway/client.ts';
import { GATEWAY_HTTP_SETTING, parseHttpDeliveryState } from '../../src/slack/gateway/http-delivery.ts';
import type { GatewayInboundDelivery } from '../../src/slack/gateway/protocol.ts';
import { gatewayUiReceiptNow } from '../../src/slack/gateway/ui-receipt.ts';
import { receiptRunnerWake } from '../../src/slack/receipt-runner-wake.ts';
import { admissionAgentInstance } from '../../src/slack/admission-agent-wake.ts';
import { wakeSlackAgentObject } from '../../src/agents/turn-input.ts';
import { CHICKPEA_SLACK_AGENT_BINDING } from '../../src/slack/bounded-agent-observation.ts';
import type { ThreadRunnerJob } from '../../src/slack/thread-runner-jobs.ts';
import type { PendingTurnJob } from '../../src/slack/turn-jobs.ts';
import type { InstallationObjectRecorder } from '../../src/state/object-inventory.ts';
import { slackAgentThreadKey } from '../../src/slack/thread-key.ts';
import { threadRunnerStub } from '../../src/slack/thread-runner-rpc.ts';
import { slackTurnExecutor } from '../../src/slack/turn-executor-flag.ts';
import type { TurnJob } from '../../src/slack/turn-job-types.ts';
import type { SlackEvent } from '../../src/slack/types.ts';
import { promisify } from '../../src/state/async-facade.ts';
import { openStateDb } from '../../src/state/node-state-db.ts';
import { createSlackOwner } from './slack-owner.ts';

/**
 * A gateway installation's admission path for tests: the state store's
 * receipt and its inbox drain (TagStateStore's production methods and
 * drainGatewayInbox, transpiled), which admits each delivery through
 * processGatewaySlackEnvelope.
 */

// The production receipt and hand-off methods of TagStateStore, not copies.
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
const ReceiptProbe = vm.runInNewContext(
  ts.transpileModule(
    `class ReceiptProbe { ${['admitGatewayDelivery', 'wakeRunnerAtReceipt', 'sendRunnerWake', 'runnerMode', 'admitToRunner', 'wakeAgentAtHandoff']
      .map(stateMethod).join('\n')} }\nReceiptProbe`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText,
  {
    Date,
    Promise,
    console: { warn() {} },
    GATEWAY_HTTP_SETTING,
    parseHttpDeliveryState,
    gatewayUiReceiptNow,
    loadKeyFormFor: async () => undefined,
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
  },
) as new () => {
  admitGatewayDelivery(delivery: GatewayInboundDelivery): Promise<unknown>;
  admitToRunner(job: TurnJob | PendingTurnJob): Promise<boolean>;
};

export interface Wake { name: string; sentAt: number; turnJobId?: string }

/** The installation the receipt store's env is scoped to. */
export const RECEIPT_INSTALLATION_ID = 'inst_receipt_wake';

/**
 * A state store that receives deliveries into an inbox answering `outcome`,
 * over `config`, and hands turns to the runners its env's namespace names.
 */
export function receiptStore(config: ConfigStoreLogic, options: {
  env?: Record<string, unknown>;
  outcome?: 'accepted' | 'duplicate';
  wake?: () => Promise<void>;
  /** What the thread's Agent object answers a wake with. */
  agentWake?: () => Promise<void>;
  /** The installation's object inventory; by default one that records nothing. */
  inventory?: Pick<InstallationObjectRecorder, 'recordAgentInstance'>;
  /** A standalone deployment's state store, which names no installation. */
  standalone?: boolean;
} = {}) {
  const wakes: Wake[] = [];
  const agentWakes: Wake[] = [];
  const handoffs: string[] = [];
  /** What each hand-off sent its runner, in order. */
  const admitted: ThreadRunnerJob[] = [];
  /** Agent wakes and runner hand-offs, in the order they were sent. */
  const sent: string[] = [];
  const confirmed: string[] = [];
  let armed = 0;
  const namespace = {
    getByName: (name: string) => ({
      wake: (sentAt: number, turnJobId?: string) => {
        wakes.push({ name, sentAt, ...(turnJobId === undefined ? {} : { turnJobId }) });
        return options.wake ? options.wake() : Promise.resolve();
      },
      admit: async (job: ThreadRunnerJob) => {
        sent.push(`runner:${name}`);
        handoffs.push(name);
        admitted.push(job);
        return { admitted: true };
      },
    }),
  };
  const agents = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      chickpeaWake: (sentAt: number, turnJobId?: string) => {
        sent.push(`agent:${name}`);
        agentWakes.push({ name, sentAt, ...(turnJobId === undefined ? {} : { turnJobId }) });
        return options.agentWake ? options.agentWake() : Promise.resolve();
      },
    }),
  };
  const bindings = { SLACK_THREAD_RUNNER: namespace, [CHICKPEA_SLACK_AGENT_BINDING]: agents, ...options.env };
  const env = options.standalone
    ? bindings as PlatformEnv
    : scopeInstallationEnv(
      { CHICKPEA_TENANCY: 'installation', ...bindings } as PlatformEnv,
      { installationId: RECEIPT_INSTALLATION_ID },
    );
  const stores = {
    settings: { getSetting: () => undefined },
    uiSurfaces: { get: () => undefined },
    gatewayInbox: { admit: () => options.outcome ?? 'accepted' },
    config,
    presentations: { get: () => undefined },
    turnJobs: { confirmRunner: (id: string) => { confirmed.push(id); } },
    objectInventory: options.inventory ?? { recordAgentInstance() {} },
  };
  const probe = Object.assign(new ReceiptProbe(), {
    env,
    stores,
    call(fn: (value: typeof stores) => unknown) {
      try {
        return { ok: true, value: fn(stores) };
      } catch {
        return { ok: false, error: { code: 'internal', message: 'failed' } };
      }
    },
    admissionWakeAt: () => 0,
    armAlarmNoLaterThan: async () => {
      armed += 1;
    },
  });
  return { probe, env, wakes, agentWakes, handoffs, admitted, sent, confirmed, armed: () => armed };
}

export const HELP_GROUP = 'SHELP';

export interface Lane {
  stores: AppStores;
  config: ConfigStoreLogic;
  help: CustomAgentConfig;
  jobs: TurnJob[];
  /** Every Slack operation the gateway was asked for, in order. */
  calls: string[];
  /** The source visibility each admitted turn's Run was admitted with, by turn job id. */
  visibility: Map<string, string>;
  /** What Slack answers for Channel C1 (`conversations.info`); change it between admissions. */
  channel: Record<string, unknown>;
  /** What Slack answers for each person (`users.info`), over a full member's defaults; change it between admissions. */
  people: Map<string, Record<string, unknown>>;
  /** Admit a delivery as the state store's inbox drain does; fails unless the drain completed it. */
  admit(delivery: GatewayInboundDelivery): Promise<void>;
}

// The production inbox drain, which builds the execution each delivery is admitted with.
const inboxDrainCode = ts.transpileModule(
  `${cloudflare.statements.filter((node) =>
    (ts.isFunctionDeclaration(node) && ['drainGatewayInbox', 'gatewayConversationKey', 'slackEventConversationKey'].includes(node.name?.text ?? '')) ||
    (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      declaration.name.getText(cloudflare) === 'GATEWAY_INBOX_CONVERSATION_CONCURRENCY')))
    .map((node) => node.getText(cloudflare)).join('\n')}\ndrainGatewayInbox`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText;

/** drainGatewayInbox over one lane's stores, gateway and queue. */
function drainWith(collaborators: Record<string, unknown>) {
  return vm.runInNewContext(inboxDrainCode, {
    Promise, Map, Array, Math,
    GATEWAY_INBOX_MAX_DRAIN_BATCH: 8,
    processGatewaySlackEnvelope,
    createPlatformProductTelemetry: () => ({}),
    resolveSlackInstallationExecutionContext: async () => ({}),
    gatewayDeliveryRetryDelayMs: () => 0,
    recordGatewayDeliveryDeadLetter() {},
    ...collaborators,
  }) as (stores: unknown, env: unknown, onAdmitted?: () => void) => Promise<boolean>;
}

/**
 * Workspace T1 on the shared gateway with Channel C1, where the Agent @help
 * (group SHELP) is granted; U1 is its Owner. Admission reads the same config
 * the state store reads at receipt.
 */
export async function withLane(scenario: (lane: Lane) => Promise<void>): Promise<void> {
  const envKeys = ['TAG_DB_PATH', 'SLACK_STATE_DB_PATH', 'CHICKPEA_AUTH_DB_PATH'] as const;
  const previousEnv = envKeys.map((key) => process.env[key]);
  for (const key of envKeys) process.env[key] = ':memory:';
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  closeNodeStateStores();
  const db = openStateDb(':memory:');
  const config = new ConfigStoreLogic(db, agentRoutineDeletion);
  const base = resolveStores();
  const visibility = new Map<string, string>();
  const stores: AppStores = {
    ...base,
    config: promisify(config, { close: () => db.close() }) as unknown as AppStores['config'],
    // Records what each canonical admission says about its source.
    slackState: new Proxy(base.slackState, {
      get(target, property) {
        if (property === 'admitCanonical') {
          return (input: SlackCanonicalAdmissionInput) => {
            if (input.turnJob) visibility.set(input.turnJob.id, input.admission.binding.sourceVisibility);
            return target.admitCanonical!(input);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
  try {
    const owner = await createSlackOwner(stores.identity, { teamId: 'T1', userId: 'U1' });
    await stores.config.ensureWorkspaceInstallation({
      workspaceId: 'T1', transportMode: 'gateway', appId: 'A1', botUserId: 'UBOT',
      gatewayBindingId: 'binding1', runtimeContract: 'chickpea-v1',
    });
    await stores.config.materializeChickpeaAgent();
    await stores.config.putChannel({ workspaceId: 'T1', channelId: 'C1', label: 'team', lifecycle: 'active' }, 0);
    const help = await stores.config.createAgent({
      id: 'agent_help', name: 'Support', instructions: 'Help.', enabled: true, lifecycle: 'active',
      creatorMembershipId: owner.membership.id, editPolicy: 'creator_and_admins', model: 'local-stub/help',
      skills: [], mcpServers: [], apiConnections: [], repositories: [],
      slackPresence: {
        requestedHandle: 'help', normalizedHandle: 'help', desiredState: 'active', health: 'healthy',
        userGroupId: HELP_GROUP, avatar: { kind: 'generated', revision: 1, seed: 'help', url: 'https://example.com/help.svg' },
      },
    });
    await stores.config.putAgentChannelGrant({
      workspaceId: 'T1', channelId: 'C1', agentId: help.id, status: 'active',
      createdByMembershipId: owner.membership.id, channelLabel: 'team', channelIsPrivate: false,
    }, 0);
    const channel: Record<string, unknown> = {
      id: 'C1', name: 'team', is_channel: true, is_private: false, is_member: true, is_archived: false,
    };
    const people = new Map<string, Record<string, unknown>>();
    const groups = [{ id: HELP_GROUP, name: 'Support', handle: 'help', description: '', date_delete: 0, date_update: 1 }];
    const calls: string[] = [];
    const gateway = {
      workspaceId: 'T1',
      async loadBinding() { return { workspaceId: 'T1', appId: 'A1', botUserId: 'UBOT', bindingId: 'binding1' }; },
      async call(operation: string, args: Record<string, unknown>) {
        calls.push(operation);
        if (operation === 'users.info') {
          return { user: {
            id: args.user, team_id: 'T1', name: String(args.user), deleted: false, is_bot: false, is_app_user: false,
            is_restricted: false, is_ultra_restricted: false, is_stranger: false, ...people.get(String(args.user)),
          } };
        }
        if (operation === 'conversations.info') return { channel: { ...channel } };
        if (operation === 'conversations.members') return { members: ['U1', 'UBOT'] };
        if (operation === 'users.conversations') return { channels: [channel] };
        if (operation === 'usergroups.list') return { usergroups: groups };
        if (operation === 'chat.postMessage') return { ok: true, ts: '9000.000001', channel: args.channel };
        if (operation === 'reactions.add') return { ok: true };
        throw new Error(`Unexpected gateway operation: ${operation}`);
      },
    } as unknown as GatewayDeploymentClient;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Cloudflare-Workers' } });
    const jobs: TurnJob[] = [];
    const enqueueTurn = async (job: TurnJob) => {
      jobs.push(job);
      return { ok: true as const, value: null };
    };
    await scenario({
      stores,
      visibility,
      config,
      help,
      jobs,
      calls,
      channel,
      people,
      async admit(received) {
        const completed: string[] = [];
        const failures: unknown[] = [];
        await drainWith({
          localGatewayAppStores: () => stores,
          localGatewayDeploymentClient: () => gateway,
          localTurnEnqueue: () => enqueueTurn,
          gatewayDeliveryFailureReason: (error: unknown) => {
            failures.push(error);
            return 'failed';
          },
        })({
          config: { getWorkspaceInstallation: (id: string) => config.getWorkspaceInstallation(id) },
          turnJobs: { noteReceipt: () => () => undefined },
          gatewayInbox: {
            claimPending: () => [{ id: received.deliveryId, attempts: 0, acceptedAt: 1, delivery: received }],
            complete: (id: string) => completed.push(id),
            markRecoveryRequired: () => failures.push('rejected'),
            retryOrRecover: () => 'pending',
            hasPending: () => false,
          },
        }, undefined, () => undefined);
        assert.deepEqual(failures, [], 'the drain admitted the delivery');
        assert.deepEqual(completed, [received.deliveryId]);
      },
    });
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator);
    else Reflect.deleteProperty(globalThis, 'navigator');
    closeNodeStateStores();
    db.close();
    envKeys.forEach((key, index) => {
      if (previousEnv[index] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[index];
    });
  }
}

let deliveries = 0;

export function delivery(event: SlackEvent): GatewayInboundDelivery {
  deliveries += 1;
  return {
    protocolVersion: 1, kind: 'event.deliver', deliveryId: `delivery_${deliveries}`, bindingId: 'binding1',
    workspaceId: 'T1', envelope: { workspaceId: 'T1', eventId: `Ev${deliveries}`, eventTime: 1_000 + deliveries, event },
  };
}

export function message(fields: {
  ts: string; text: string; channel?: string; thread_ts?: string; bot_id?: string; subtype?: string; user?: string;
}): SlackEvent {
  const channel = fields.channel ?? 'C1';
  return {
    type: 'message', channel, channel_type: channel.startsWith('D') ? 'im' : 'channel', user: 'U1', ...fields,
  } as SlackEvent;
}

export const AGENT_MENTION = message({ ts: '5000.000100', text: `<!subteam^${HELP_GROUP}|@help> what changed?` });
