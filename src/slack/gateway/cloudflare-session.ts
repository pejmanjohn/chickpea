import { DurableObject, type DurableObjectState } from 'cloudflare:workers';

import { getSettingsStore, type PlatformEnv } from '../../config/state-backend.ts';
import { tagStateStub } from '../../config/state-rpc.ts';
import { GATEWAY_BINDING_SETTING } from './client.ts';
import { GATEWAY_DURABLE_ADMISSION_CAPABILITY } from './protocol.ts';
import { createGatewayDeploymentClient } from './runtime.ts';
import { GatewaySessionRunner } from './session-runner.ts';

export interface SlackGatewaySessionRpc {
  wake(): Promise<void>;
  restart(): Promise<void>;
}

/**
 * One Cloudflare Durable Object owns the deployment's outbound delivery
 * socket. The minutely Worker heartbeat wakes it after eviction; while live,
 * the session runner rotates before Cloudflare's outbound-WebSocket ceiling.
 */
export class SlackGatewaySession extends DurableObject implements SlackGatewaySessionRpc {
  private runner: GatewaySessionRunner | undefined;
  private readonly state: DurableObjectState & {
    waitUntil(promise: Promise<unknown>): void;
  };

  constructor(ctx: DurableObjectState, rawEnv: unknown) {
    super(ctx, rawEnv);
    // The Cloudflare runtime exposes waitUntil on DurableObjectState; the
    // module-scoped cloudflare:workers declaration currently omits it while
    // @cloudflare/workers-types includes the runtime method.
    this.state = ctx as typeof this.state;
  }

  async wake(): Promise<void> {
    if (this.runner) return;
    const platformEnv = this.env as PlatformEnv;
    const binding = await getSettingsStore(platformEnv).getSetting(GATEWAY_BINDING_SETTING);
    if (!binding) return;
    const client = createGatewayDeploymentClient(platformEnv);
    const runner = new GatewaySessionRunner({
      client,
      capabilities: [GATEWAY_DURABLE_ADMISSION_CAPABILITY],
      waitUntil: (promise) => this.state.waitUntil(promise),
      onEvent: async (delivery) => {
        const result = await tagStateStub(platformEnv).admitGatewayDelivery(delivery);
        return result.ok ? result.value : 'rejected';
      },
    });
    this.runner = runner;
    try {
      if (!(await runner.start())) this.runner = undefined;
    } catch (error) {
      runner.stop();
      this.runner = undefined;
      throw error;
    }
  }

  async restart(): Promise<void> {
    this.runner?.stop();
    this.runner = undefined;
    await this.wake();
  }
}

interface SlackGatewaySessionNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): SlackGatewaySessionRpc;
}

export async function wakeCloudflareGatewaySession(
  rawEnv: Record<string, unknown>,
): Promise<void> {
  const namespace = rawEnv.SLACK_GATEWAY_SESSION as SlackGatewaySessionNamespace | undefined;
  // Custom Worker environments created before the shared-app lane may not
  // expose this binding yet. Maintenance must remain safe while the gateway
  // is unused; an actual shared-app setup still fails closed in the client.
  if (!namespace) return;
  await namespace.get(namespace.idFromName('deployment')).wake();
}
