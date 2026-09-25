import {
  getNodeGatewayInboxStore,
  getSettingsStore,
  resolveStores,
  type AppStores,
  type PlatformEnv,
} from '../../config/state-backend.ts';
import { isCloudflareTarget } from '../../config/runtime-target.ts';
import {
  processGatewayAgentSelection,
  processGatewayPrivateChannelSetup,
  processGatewaySlackEnvelope,
} from '../../channels/slack.ts';
import { createGatewayDeploymentClient } from './runtime.ts';
import { GATEWAY_BINDING_SETTING, type GatewayDeploymentClient } from './client.ts';
import { GATEWAY_INBOX_MAX_DRAIN_BATCH, gatewayDeliveryRetryDelayMs } from './inbox.ts';
import {
  GATEWAY_DURABLE_ADMISSION_CAPABILITY,
  type GatewayInboundDelivery,
} from './protocol.ts';
import {
  GatewaySessionRunner,
  reconcileGatewaySessionStatus,
  type GatewaySessionRunnerHealthSnapshot,
  type GatewaySessionStatusSnapshot,
} from './session-runner.ts';

type NodeGatewayRunner = Pick<GatewaySessionRunner, 'start' | 'stop'> &
  Partial<Pick<GatewaySessionRunner, 'healthSnapshot'>>;

interface NodeGatewayInboxPort {
  admit(
    delivery: GatewayInboundDelivery,
    expectedBinding?: string,
  ): 'accepted' | 'duplicate' | 'rejected';
  deliveryIsCurrent(delivery: GatewayInboundDelivery): boolean;
  claimPending(limit?: number): Array<{
    id: string;
    delivery: GatewayInboundDelivery;
    attempts: number;
  }>;
  complete(id: string): boolean;
  retryOrRecover(
    id: string,
    reason: string,
    retryDelayMs?: number,
  ): 'pending' | 'recovery_required';
  markRecoveryRequired(id: string, reason: string): boolean;
  hasPending(): boolean;
}

interface NodeGatewayInboxWorkerOptions {
  getStore: () => NodeGatewayInboxPort;
  processDelivery: (delivery: GatewayInboundDelivery) => Promise<'accepted' | 'rejected'>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  onError?: (error: unknown) => void;
  retryMs?: number;
}

interface NodeGatewayDeliveryDependencies {
  getStore?: () => NodeGatewayInboxPort;
  createClient?: (env?: PlatformEnv) => GatewayDeploymentClient;
  resolveStores?: (env?: PlatformEnv) => AppStores;
  processSlackEnvelope?: typeof processGatewaySlackEnvelope;
  processAgentSelection?: typeof processGatewayAgentSelection;
  processPrivateChannelSetup?: typeof processGatewayPrivateChannelSetup;
}

const NODE_GATEWAY_RETRY_MS = 5_000;
const NODE_GATEWAY_DRAIN_RETRY_MS = 2_000;

/** Single-process, single-flight drain for Node's durable gateway inbox. */
export class NodeGatewayInboxWorker {
  readonly #getStore: () => NodeGatewayInboxPort;
  readonly #processDelivery: NodeGatewayInboxWorkerOptions['processDelivery'];
  readonly #setTimer: typeof setTimeout;
  readonly #clearTimer: typeof clearTimeout;
  readonly #onError: (error: unknown) => void;
  readonly #retryMs: number;
  #active = false;
  #queued = false;
  #running: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: NodeGatewayInboxWorkerOptions) {
    this.#getStore = options.getStore;
    this.#processDelivery = options.processDelivery;
    this.#setTimer = options.setTimer ?? setTimeout;
    this.#clearTimer = options.clearTimer ?? clearTimeout;
    this.#onError = options.onError ?? ((error) => {
      console.error('[chickpea] Slack gateway inbox drain failed:', boundedGatewayError(error));
    });
    this.#retryMs = options.retryMs ?? NODE_GATEWAY_DRAIN_RETRY_MS;
  }

  start(): void {
    if (this.#active) return;
    this.#active = true;
    this.wake();
  }

  wake(): void {
    this.#queued = true;
    if (!this.#active || this.#running) return;
    if (this.#timer) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    const running = this.#drain();
    this.#running = running;
    void running.finally(() => {
      if (this.#running === running) this.#running = undefined;
      if (this.#active && this.#queued) this.wake();
    }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.#active = false;
    this.#queued = false;
    if (this.#timer) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  async #drain(): Promise<void> {
    this.#queued = false;
    let processed = 0;
    try {
      while (this.#active && processed < GATEWAY_INBOX_MAX_DRAIN_BATCH) {
        const store = this.#getStore();
        const item = store.claimPending(1)[0];
        if (!item) {
          if (store.hasPending()) this.#scheduleRetry();
          return;
        }
        processed += 1;
        if (!store.deliveryIsCurrent(item.delivery)) {
          store.markRecoveryRequired(item.id, 'binding_revalidation_rejected');
          continue;
        }
        try {
          const outcome = await this.#processDelivery(item.delivery);
          if (outcome === 'accepted') {
            if (!store.complete(item.id)) {
              throw new Error('Gateway inbox completion lost its in-flight row.');
            }
          } else {
            store.markRecoveryRequired(item.id, 'binding_revalidation_rejected');
          }
        } catch (error) {
          this.#onError(error);
          const retry = store.retryOrRecover(
            item.id,
            'delivery_processing_failed',
            gatewayDeliveryRetryDelayMs(item.attempts, error),
          );
          if (retry === 'pending') this.#scheduleRetry();
          return;
        }
      }
      if (this.#active && this.#getStore().hasPending()) this.#scheduleRetry();
    } catch (error) {
      this.#onError(error);
      if (this.#active) this.#scheduleRetry();
    }
  }

  #scheduleRetry(): void {
    if (!this.#active || this.#timer) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = undefined;
      this.wake();
    }, this.#retryMs);
    this.#timer.unref?.();
  }
}

let runner: NodeGatewayRunner | undefined;
let runnerStarting = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let clearRetryTimer: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout;
let lifecycleGeneration = 0;
let inboxWorker: NodeGatewayInboxWorker | undefined;
let runtimeStopPromise: Promise<void> | undefined;
let runtimeQuiescing = false;

interface NodeGatewayRuntimeDependencies {
  isCloudflare?: () => boolean;
  readBinding?: (env?: PlatformEnv) => Promise<string | undefined>;
  createRunner?: (
    env: PlatformEnv | undefined,
    input: {
      capabilities: readonly [typeof GATEWAY_DURABLE_ADMISSION_CAPABILITY];
      onEvent(delivery: GatewayInboundDelivery): Promise<'accepted' | 'duplicate' | 'rejected'>;
    },
  ) => NodeGatewayRunner;
  createInboxWorker?: (env?: PlatformEnv) => NodeGatewayInboxWorker;
  getInbox?: () => NodeGatewayInboxPort;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  onError?: (error: unknown) => void;
}

function scheduleNodeGatewayRetry(
  env: PlatformEnv | undefined,
  dependencies: NodeGatewayRuntimeDependencies,
): void {
  if (retryTimer || (dependencies.isCloudflare ?? isCloudflareTarget)()) return;
  const setTimer = dependencies.setTimer ?? setTimeout;
  clearRetryTimer = dependencies.clearTimer ?? clearTimeout;
  retryTimer = setTimer(() => {
    retryTimer = undefined;
    startNodeGatewaySession(env, dependencies);
  }, NODE_GATEWAY_RETRY_MS);
  retryTimer.unref?.();
}

/** Start inbox recovery opportunistically; an unbound deployment skips only the socket. */
export function startNodeGatewaySession(
  env?: PlatformEnv,
  dependencies: NodeGatewayRuntimeDependencies = {},
): void {
  if ((dependencies.isCloudflare ?? isCloudflareTarget)() || runtimeQuiescing ||
      runtimeStopPromise || runner || runnerStarting) return;
  const generation = lifecycleGeneration;
  runnerStarting = true;
  const getInbox = dependencies.getInbox ?? getNodeGatewayInboxStore;
  try {
    getInbox();
    inboxWorker ??= dependencies.createInboxWorker?.(env) ?? createNodeGatewayInboxWorker(env);
    inboxWorker.start();
  } catch (error) {
    runnerStarting = false;
    reportNodeGatewayError(error, dependencies);
    scheduleNodeGatewayRetry(env, dependencies);
    return;
  }
  const readBinding = dependencies.readBinding ?? (
    (runtimeEnv?: PlatformEnv) => getSettingsStore(runtimeEnv).getSetting(GATEWAY_BINDING_SETTING)
  );
  void readBinding(env).then(async (binding) => {
    if (generation !== lifecycleGeneration || !binding || runner) return;
    const capabilities = [GATEWAY_DURABLE_ADMISSION_CAPABILITY] as const;
    const onEvent = async (delivery: GatewayInboundDelivery) => {
      if (runtimeQuiescing || generation !== lifecycleGeneration) return 'rejected';
      const outcome = getInbox().admit(delivery, binding);
      if (outcome !== 'rejected') inboxWorker?.wake();
      return outcome;
    };
    const candidate = dependencies.createRunner
      ? dependencies.createRunner(env, { capabilities, onEvent })
      : ((runtimeEnv?: PlatformEnv) => {
      const client = createGatewayDeploymentClient(runtimeEnv);
      return new GatewaySessionRunner({
        client,
        capabilities,
        onEvent,
      });
    })(env);
    if (generation !== lifecycleGeneration) {
      candidate.stop();
      return;
    }
    runner = candidate;
    const started = await candidate.start();
    if (generation !== lifecycleGeneration) {
      candidate.stop();
      if (runner === candidate) runner = undefined;
      return;
    }
    if (!started && runner === candidate) runner = undefined;
    if (!started) scheduleNodeGatewayRetry(env, dependencies);
  }).catch((error) => {
    if (generation !== lifecycleGeneration) return;
    runner = undefined;
    reportNodeGatewayError(error, dependencies);
    scheduleNodeGatewayRetry(env, dependencies);
  }).finally(() => {
    if (generation === lifecycleGeneration) runnerStarting = false;
  });
}

/** Deliberate lifecycle start, including after a completed production stop. */
export async function startNodeGatewayRuntime(
  env?: PlatformEnv,
  dependencies: NodeGatewayRuntimeDependencies = {},
): Promise<void> {
  if (runtimeStopPromise) await runtimeStopPromise;
  runtimeQuiescing = false;
  startNodeGatewaySession(env, dependencies);
}

/** Replace a live Node socket after a successful binding-incarnation change. */
export function refreshNodeGatewaySession(
  env?: PlatformEnv,
  dependencies: NodeGatewayRuntimeDependencies = {},
): void {
  if ((dependencies.isCloudflare ?? isCloudflareTarget)() || runtimeQuiescing ||
      runtimeStopPromise) return;
  stopNodeGatewaySession();
  startNodeGatewaySession(env, dependencies);
}

/** Stop socket admission immediately; persisted work remains owned by the worker. */
export function stopNodeGatewaySession(): void {
  lifecycleGeneration += 1;
  runnerStarting = false;
  if (retryTimer) clearRetryTimer(retryTimer);
  retryTimer = undefined;
  runner?.stop();
  runner = undefined;
}

/** Quiesce admission and the active inbox item before the owner closes shared stores. */
export async function stopNodeGatewayRuntime(): Promise<void> {
  if (runtimeStopPromise) return runtimeStopPromise;
  runtimeQuiescing = true;
  runtimeStopPromise = (async () => {
    stopNodeGatewaySession();
    const worker = inboxWorker;
    inboxWorker = undefined;
    await worker?.stop();
  })().finally(() => {
    runtimeStopPromise = undefined;
  });
  return runtimeStopPromise;
}

export function nodeGatewaySessionStatus(): GatewaySessionStatusSnapshot | undefined {
  const snapshot = runner?.healthSnapshot?.() as GatewaySessionRunnerHealthSnapshot | undefined;
  return snapshot ? reconcileGatewaySessionStatus(snapshot, undefined) : undefined;
}

export function createNodeGatewayInboxWorker(
  env?: PlatformEnv,
  dependencies: NodeGatewayDeliveryDependencies = {},
): NodeGatewayInboxWorker {
  const stores = dependencies.resolveStores ?? resolveStores;
  const createClient = dependencies.createClient ?? createGatewayDeploymentClient;
  const processSlackEnvelope = dependencies.processSlackEnvelope ?? processGatewaySlackEnvelope;
  const processAgentSelection = dependencies.processAgentSelection ?? processGatewayAgentSelection;
  const processPrivateChannelSetup =
    dependencies.processPrivateChannelSetup ?? processGatewayPrivateChannelSetup;
  return new NodeGatewayInboxWorker({
    getStore: dependencies.getStore ?? getNodeGatewayInboxStore,
    processDelivery: async (delivery) => {
      const client = createClient(env);
      const appStores = stores(env);
      return delivery.kind === 'event.deliver'
        ? processSlackEnvelope(delivery.envelope, env, client, {
            stores: appStores,
            durableIngress: true,
          })
        : delivery.kind === 'interaction.agent_selected'
        ? processAgentSelection(delivery, env, client, appStores)
        : processPrivateChannelSetup(delivery, env, client, appStores);
    },
  });
}

function reportNodeGatewayError(
  error: unknown,
  dependencies: NodeGatewayRuntimeDependencies,
): void {
  if (dependencies.onError) {
    dependencies.onError(error);
    return;
  }
  console.error(
    '[chickpea] Slack gateway session failed to start:',
    boundedGatewayError(error),
  );
}

function boundedGatewayError(error: unknown): string {
  const name = error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(error.name)
    ? error.name
    : 'Error';
  return `gateway_runtime_failure:${name}`;
}
