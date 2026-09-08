import { GATEWAY_HTTP_SETTING, parseHttpDeliveryState } from './http-delivery.ts';
import { resolveSlackPublicUrl } from '../credentials.ts';
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
 * socket. A durable alarm restores it after eviction, independently of Worker
 * maintenance; while live, the runner rotates the outbound WebSocket.
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
    console.info({ component: 'slack_gateway', event: 'session_object_started',
      versionId: cloudflareWorkerVersionId(this.env) ?? null });
  }

  async wake(): Promise<void> {
    // Arm recovery before any remote read or connection attempt. In-memory
    // retry timers disappear with the object and cannot recover an eviction.
    // Do not postpone a pending alarm when Admin or maintenance also wakes us.
    if (await this.state.storage.getAlarm() === null) {
      await this.state.storage.setAlarm(Date.now() + 30_000);
    }
    const platformEnv = this.env as PlatformEnv;
    const binding = await getSettingsStore(platformEnv).getSetting(GATEWAY_BINDING_SETTING);
    if (!binding) {
      this.supervisor?.stop();
      this.supervisor = undefined;
      await this.state.storage.deleteAlarm();
      return;
    }
    const publicOrigin = await resolveSlackPublicUrl(platformEnv);
    try {
      if (publicOrigin && await createGatewayDeploymentClient(platformEnv).ensureHttpDelivery(publicOrigin)) {
        this.supervisor?.stop();
        this.supervisor = undefined;
        await this.state.storage.deleteAlarm();
        return;
      }
    } catch {
      console.warn({component:'slack_gateway',event:'http_registration_pending',versionId:cloudflareWorkerVersionId(this.env) ?? null});
      const delivery = parseHttpDeliveryState(await getSettingsStore(platformEnv).getSetting(GATEWAY_HTTP_SETTING));
      if (delivery?.mode === 'http') {
        this.supervisor?.stop();
        this.supervisor = undefined;
        throw new Error('HTTP delivery registration is pending.');
      }
      // Preserve service while preparing HTTP. The gateway remains the final
      // fence and refuses this socket if HTTP became active remotely.
    }
    if (!this.supervisor) {
      // The cross-object settings read can admit another wake. Keep its
      // supervisor so concurrent callers cannot leave orphan delivery sockets.
      this.supervisor ??= new GatewaySessionRunnerSupervisor(() => new GatewaySessionRunner({
        // A failed Durable Object RPC stub rejects subsequent calls too.
        // Reconnects must rebuild the stores captured by this client.
        client: () => createGatewayDeploymentClient(platformEnv),
        capabilities: [GATEWAY_DURABLE_ADMISSION_CAPABILITY],
        waitUntil: (promise) => this.state.waitUntil(promise),
        onDiagnostic: (diagnostic) => console.warn({ component: 'slack_gateway',
          event: 'session_connection_failure', ...diagnostic }),
        onEvent: async (delivery) => {
          const result = await tagStateStub(platformEnv).admitGatewayDelivery(delivery);
          return result.ok ? result.value : 'rejected';
        },
      }));
    }
    await this.supervisor.ensureHealthy();
  }

  async alarm(): Promise<void> {
    // getAlarm() is null while the alarm is executing. wake() persists the
    // next attempt before doing I/O, even if this attempt subsequently fails.
    await this.wake();
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
    const delivery = parseHttpDeliveryState(await getSettingsStore(this.env as PlatformEnv).getSetting(GATEWAY_HTTP_SETTING));
    if (delivery?.mode === 'http' && delivery.active) {
      return {healthy:true,phase:'healthy',detail:null,generation:null,versionId:cloudflareWorkerVersionId(this.env) ?? null};
    }
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
