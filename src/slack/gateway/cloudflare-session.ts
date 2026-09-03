import { DurableObject, type DurableObjectState } from 'cloudflare:workers';

import { getSettingsStore, type PlatformEnv } from '../../config/state-backend.ts';
import { tagStateStub } from '../../config/state-rpc.ts';
import { cloudflareWorkerVersionId } from '../../config/cloudflare-version.ts';
import { GATEWAY_BINDING_SETTING } from './client.ts';
import { GATEWAY_DURABLE_ADMISSION_CAPABILITY } from './protocol.ts';
import { createGatewayDeploymentClient } from './runtime.ts';
import {
  GatewaySessionRunner,
  GatewaySessionRunnerSupervisor,
  reconcileGatewaySessionStatus,
  type GatewaySessionStatusSnapshot,
} from './session-runner.ts';

interface SlackGatewaySessionRpc {
  wake(): Promise<void>;
  restart(): Promise<void>;
  status(): Promise<GatewaySessionStatusSnapshot>;
}

/**
 * One Cloudflare Durable Object owns the deployment's outbound delivery
 * socket. The minutely Worker heartbeat wakes it after eviction; while live,
 * the session runner rotates before Cloudflare's outbound-WebSocket ceiling.
 */
export class SlackGatewaySession extends DurableObject implements SlackGatewaySessionRpc {
  private supervisor: GatewaySessionRunnerSupervisor | undefined;
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
    const platformEnv = this.env as PlatformEnv;
    if (!this.supervisor) {
      const binding = await getSettingsStore(platformEnv).getSetting(GATEWAY_BINDING_SETTING);
      if (!binding) return;
      // The cross-object settings read can admit another wake. Keep its
      // supervisor so concurrent callers cannot leave orphan delivery sockets.
      this.supervisor ??= new GatewaySessionRunnerSupervisor(() => new GatewaySessionRunner({
        // A failed Durable Object RPC stub rejects subsequent calls too.
        // Reconnects must rebuild the stores captured by this client.
        client: () => createGatewayDeploymentClient(platformEnv),
        capabilities: [GATEWAY_DURABLE_ADMISSION_CAPABILITY],
        waitUntil: (promise) => this.state.waitUntil(promise),
        onEvent: async (delivery) => {
          const result = await tagStateStub(platformEnv).admitGatewayDelivery(delivery);
          return result.ok ? result.value : 'rejected';
        },
      }));
    }
    await this.supervisor.ensureHealthy();
  }

  async restart(): Promise<void> {
    if (!this.supervisor) {
      await this.wake();
      return;
    }
    await this.supervisor.restart();
  }

  async status(): Promise<GatewaySessionStatusSnapshot> {
    await this.wake();
    const live = this.supervisor?.snapshot();
    if (live) {
      return {
        ...reconcileGatewaySessionStatus(live, undefined),
        versionId: cloudflareWorkerVersionId(this.env) ?? null,
      };
    }
    const persisted = await createGatewayDeploymentClient(this.env as PlatformEnv)
      .loadSessionCheckpoint();
    return {
      ...reconcileGatewaySessionStatus(undefined, persisted),
      versionId: cloudflareWorkerVersionId(this.env) ?? null,
    };
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
