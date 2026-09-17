import { openStateDb, type NodeStateDb } from '../../state/node-state-db.ts';
import type { GatewayInboundDelivery, GatewayWorkspaceBinding } from './protocol.ts';
import {
  GatewayInboxStoreLogic,
  type GatewayInboxDrainCounts,
  type GatewayInboxValidatedAdmissionOutcome,
} from './inbox.ts';
import { GATEWAY_BINDING_SETTING } from './settings.ts';

export const NODE_GATEWAY_ADMISSION_AUTHORITY_FIELD = '__chickpeaNodeGatewayAuthority';

interface NodeGatewayAdmissionAuthority {
  version: 1;
  bindingId: string;
  deploymentId: string;
  workspaceId: string;
  appId: string;
  clientId: string;
  botUserId: string;
  installedAt: number;
}

/** Node's deployment-owned gateway inbox over the canonical state database. */
export class SqliteGatewayInboxStore {
  readonly #db: NodeStateDb;
  readonly #inbox: GatewayInboxStoreLogic;
  readonly #ownsDb: boolean;

  constructor(source: string | NodeStateDb) {
    this.#ownsDb = typeof source === 'string';
    this.#db = typeof source === 'string' ? openStateDb(source) : source;
    this.#inbox = new GatewayInboxStoreLogic(this.#db);
  }

  admit(
    delivery: GatewayInboundDelivery,
    expectedBinding?: string,
  ): GatewayInboxValidatedAdmissionOutcome {
    return this.#inbox.admitValidated(delivery, () => {
      const authority = this.#currentAuthority(delivery);
      if (!authority) return undefined;
      if (expectedBinding) {
        const expected = parseBinding(expectedBinding);
        if (!expected || !sameAuthority(authority, authorityFromBinding(expected))) {
          return undefined;
        }
      }
      return {
        ...delivery,
        [NODE_GATEWAY_ADMISSION_AUTHORITY_FIELD]: authority,
      } as unknown as GatewayInboundDelivery;
    });
  }

  deliveryIsCurrent(delivery: GatewayInboundDelivery): boolean {
    const stored = nodeAdmissionAuthority(delivery);
    const current = this.#currentAuthority(delivery);
    return Boolean(stored && current && sameAuthority(stored, current));
  }

  claimPending(limit?: number) {
    return this.#inbox.claimPending(limit);
  }

  complete(id: string): boolean {
    return this.#inbox.complete(id);
  }

  retryOrRecover(id: string, reason: string): 'pending' | 'recovery_required' {
    return this.#inbox.retryOrRecover(id, reason);
  }

  markRecoveryRequired(id: string, reason: string): boolean {
    return this.#inbox.markRecoveryRequired(id, reason);
  }

  hasPending(): boolean {
    return this.#inbox.hasPending();
  }

  runtimeDrainCounts(): GatewayInboxDrainCounts {
    return this.#inbox.runtimeDrainCounts();
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }

  #currentAuthority(
    delivery: GatewayInboundDelivery,
  ): NodeGatewayAdmissionAuthority | undefined {
    const rawBinding = this.#db.get(
      'SELECT value FROM app_settings WHERE key = ?',
      GATEWAY_BINDING_SETTING,
    )?.value;
    if (typeof rawBinding !== 'string') return undefined;
    const binding = parseBinding(rawBinding);
    if (!binding || binding.bindingId !== delivery.bindingId ||
        binding.workspaceId !== delivery.workspaceId) return undefined;
    const installation = this.#db.get(
      `SELECT workspace_id, transport_mode, team_id, app_id, bot_user_id,
              gateway_binding_id, health
       FROM config_workspace_installations WHERE workspace_id = ?`,
      delivery.workspaceId,
    );
    if (!(
      installation && installation.transport_mode === 'gateway' &&
      installation.health !== 'revoked' &&
      installation.gateway_binding_id === binding.bindingId &&
      installation.team_id === binding.workspaceId &&
      installation.app_id === binding.appId &&
      installation.bot_user_id === binding.botUserId
    )) return undefined;
    return {
      version: 1,
      bindingId: binding.bindingId,
      deploymentId: binding.deploymentId,
      workspaceId: binding.workspaceId,
      appId: binding.appId,
      clientId: binding.clientId,
      botUserId: binding.botUserId,
      installedAt: binding.installedAt,
    };
  }
}

function authorityFromBinding(binding: GatewayWorkspaceBinding): NodeGatewayAdmissionAuthority {
  return {
    version: 1,
    bindingId: binding.bindingId,
    deploymentId: binding.deploymentId,
    workspaceId: binding.workspaceId,
    appId: binding.appId,
    clientId: binding.clientId,
    botUserId: binding.botUserId,
    installedAt: binding.installedAt,
  };
}

function parseBinding(raw: string | undefined): GatewayWorkspaceBinding | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<GatewayWorkspaceBinding>;
    if (!value || typeof value !== 'object' ||
        typeof value.bindingId !== 'string' || !value.bindingId ||
        typeof value.deploymentId !== 'string' || !value.deploymentId ||
        typeof value.workspaceId !== 'string' || !value.workspaceId ||
        typeof value.appId !== 'string' || !value.appId ||
        typeof value.clientId !== 'string' || !value.clientId ||
        typeof value.botUserId !== 'string' || !value.botUserId ||
        !Number.isSafeInteger(value.installedAt) || Number(value.installedAt) < 0) return undefined;
    return value as GatewayWorkspaceBinding;
  } catch {
    return undefined;
  }
}

function nodeAdmissionAuthority(
  delivery: GatewayInboundDelivery,
): NodeGatewayAdmissionAuthority | undefined {
  const value = (delivery as unknown as Record<string, unknown>)[
    NODE_GATEWAY_ADMISSION_AUTHORITY_FIELD
  ];
  if (!value || typeof value !== 'object') return undefined;
  const authority = value as Partial<NodeGatewayAdmissionAuthority>;
  if (authority.version !== 1 ||
      typeof authority.bindingId !== 'string' ||
      typeof authority.deploymentId !== 'string' ||
      typeof authority.workspaceId !== 'string' ||
      typeof authority.appId !== 'string' ||
      typeof authority.clientId !== 'string' ||
      typeof authority.botUserId !== 'string' ||
      !Number.isSafeInteger(authority.installedAt)) return undefined;
  return authority as NodeGatewayAdmissionAuthority;
}

function sameAuthority(
  left: NodeGatewayAdmissionAuthority,
  right: NodeGatewayAdmissionAuthority,
): boolean {
  return left.version === right.version &&
    left.bindingId === right.bindingId &&
    left.deploymentId === right.deploymentId &&
    left.workspaceId === right.workspaceId &&
    left.appId === right.appId &&
    left.clientId === right.clientId &&
    left.botUserId === right.botUserId &&
    left.installedAt === right.installedAt;
}
