import { openStateDb, type NodeStateDb } from '../../state/node-state-db.ts';
import type { GatewayInboundDelivery, GatewayWorkspaceBinding } from './protocol.ts';
import {
  GatewayInboxStoreLogic,
  type GatewayInboxDrainCounts,
  type GatewayInboxValidatedAdmissionOutcome,
} from './inbox.ts';
import { GATEWAY_BINDING_SETTING } from './settings.ts';

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

  admit(delivery: GatewayInboundDelivery): GatewayInboxValidatedAdmissionOutcome {
    return this.#inbox.admitValidated(delivery, () => this.deliveryIsCurrent(delivery));
  }

  deliveryIsCurrent(delivery: GatewayInboundDelivery): boolean {
    return this.#deliveryIsCurrent(delivery);
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

  #deliveryIsCurrent(delivery: GatewayInboundDelivery): boolean {
    const rawBinding = this.#db.get(
      'SELECT value FROM app_settings WHERE key = ?',
      GATEWAY_BINDING_SETTING,
    )?.value;
    if (typeof rawBinding !== 'string') return false;
    const binding = parseBinding(rawBinding);
    if (!binding || binding.bindingId !== delivery.bindingId ||
        binding.workspaceId !== delivery.workspaceId) return false;
    const installation = this.#db.get(
      `SELECT workspace_id, transport_mode, team_id, app_id, bot_user_id,
              gateway_binding_id, health
       FROM config_workspace_installations WHERE workspace_id = ?`,
      delivery.workspaceId,
    );
    return Boolean(
      installation && installation.transport_mode === 'gateway' &&
      installation.health !== 'revoked' &&
      installation.gateway_binding_id === binding.bindingId &&
      installation.team_id === binding.workspaceId &&
      installation.app_id === binding.appId &&
      installation.bot_user_id === binding.botUserId,
    );
  }
}

function parseBinding(raw: string | undefined): GatewayWorkspaceBinding | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<GatewayWorkspaceBinding>;
    if (!value || typeof value !== 'object' ||
        typeof value.bindingId !== 'string' || !value.bindingId ||
        typeof value.workspaceId !== 'string' || !value.workspaceId ||
        typeof value.appId !== 'string' || !value.appId ||
        typeof value.botUserId !== 'string' || !value.botUserId) return undefined;
    return value as GatewayWorkspaceBinding;
  } catch {
    return undefined;
  }
}
