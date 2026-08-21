import { getSettingsStore, type PlatformEnv } from '../../config/state-backend.ts';
import { isCloudflareTarget } from '../../config/runtime-target.ts';
import {
  processGatewayAgentSelection,
  processGatewaySlackEnvelope,
} from '../../channels/slack.ts';
import { createGatewayDeploymentClient } from './runtime.ts';
import { GATEWAY_BINDING_SETTING } from './client.ts';
import { GatewaySessionRunner } from './session-runner.ts';

let runner: Pick<GatewaySessionRunner, 'start' | 'stop'> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let clearRetryTimer: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout;
const NODE_GATEWAY_RETRY_MS = 5_000;

export interface NodeGatewayRuntimeDependencies {
  isCloudflare?: () => boolean;
  readBinding?: (env?: PlatformEnv) => Promise<string | undefined>;
  createRunner?: (env?: PlatformEnv) => Pick<GatewaySessionRunner, 'start' | 'stop'>;
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

/** Start opportunistically: an unbound direct-app deployment remains inert. */
export function startNodeGatewaySession(
  env?: PlatformEnv,
  dependencies: NodeGatewayRuntimeDependencies = {},
): void {
  if ((dependencies.isCloudflare ?? isCloudflareTarget)() || runner) return;
  const readBinding = dependencies.readBinding ?? (
    (runtimeEnv?: PlatformEnv) => getSettingsStore(runtimeEnv).getSetting(GATEWAY_BINDING_SETTING)
  );
  void readBinding(env).then((binding) => {
    if (!binding || runner) return;
    runner = (dependencies.createRunner ?? ((runtimeEnv?: PlatformEnv) => {
      const client = createGatewayDeploymentClient(runtimeEnv);
      return new GatewaySessionRunner({
        client,
        onEvent: (delivery) => delivery.kind === 'event.deliver'
          ? processGatewaySlackEnvelope(delivery.envelope, runtimeEnv, client)
          : processGatewayAgentSelection(delivery, runtimeEnv, client),
      });
    }))(env);
    return runner.start().then((started) => {
      if (!started) runner = undefined;
      if (!started) scheduleNodeGatewayRetry(env, dependencies);
    }).catch((error) => {
      runner = undefined;
      reportNodeGatewayError(error, dependencies);
      scheduleNodeGatewayRetry(env, dependencies);
    });
  }).catch((error) => {
    runner = undefined;
    reportNodeGatewayError(error, dependencies);
    scheduleNodeGatewayRetry(env, dependencies);
  });
}

export function stopNodeGatewaySession(): void {
  if (retryTimer) clearRetryTimer(retryTimer);
  retryTimer = undefined;
  runner?.stop();
  runner = undefined;
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
    error instanceof Error ? error.message : String(error),
  );
}
