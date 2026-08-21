import { DurableObject, type DurableObjectState } from 'cloudflare:workers';

import { getSettingsStore, type PlatformEnv } from '../../config/state-backend.ts';
import {
  processGatewayAgentSelection,
  processGatewaySlackEnvelope,
} from '../../channels/slack.ts';
import { GATEWAY_BINDING_SETTING } from './client.ts';
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

  constructor(ctx: DurableObjectState, rawEnv: unknown) {
    super(ctx, rawEnv);
  }

  async wake(): Promise<void> {
    if (this.runner) return;
    const platformEnv = this.env as PlatformEnv;
    const binding = await getSettingsStore(platformEnv).getSetting(GATEWAY_BINDING_SETTING);
    if (!binding) return;
    const client = createGatewayDeploymentClient(platformEnv);
    const runner = new GatewaySessionRunner({
      client,
      onEvent: (delivery) => delivery.kind === 'event.deliver'
        ? processGatewaySlackEnvelope(delivery.envelope, platformEnv, client)
        : processGatewayAgentSelection(delivery, platformEnv, client),
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
