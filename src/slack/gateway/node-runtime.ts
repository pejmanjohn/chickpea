import { getSettingsStore, type PlatformEnv } from '../../config/state-backend.ts';
import { isCloudflareTarget } from '../../config/runtime-target.ts';
import {
  processGatewayAgentSelection,
  processGatewaySlackEnvelope,
} from '../../channels/slack.ts';
import { createGatewayDeploymentClient } from './runtime.ts';
import { GATEWAY_BINDING_SETTING } from './client.ts';
import { GatewaySessionRunner } from './session-runner.ts';

let runner: GatewaySessionRunner | undefined;

/** Start opportunistically: an unbound direct-app deployment remains inert. */
export function startNodeGatewaySession(env?: PlatformEnv): void {
  if (isCloudflareTarget() || runner) return;
  void getSettingsStore(env).getSetting(GATEWAY_BINDING_SETTING).then((binding) => {
    if (!binding || runner) return;
    const client = createGatewayDeploymentClient(env);
    runner = new GatewaySessionRunner({
      client,
      onEvent: (delivery) => delivery.kind === 'event.deliver'
        ? processGatewaySlackEnvelope(delivery.envelope, env, client)
        : processGatewayAgentSelection(delivery, env, client),
    });
    return runner.start().then((started) => {
      if (!started) runner = undefined;
    });
  }).catch((error) => {
    runner = undefined;
    console.error(
      '[chickpea] Slack gateway session failed to start:',
      error instanceof Error ? error.message : String(error),
    );
  });
}

export function stopNodeGatewaySession(): void {
  runner?.stop();
  runner = undefined;
}
