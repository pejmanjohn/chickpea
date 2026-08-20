import type { AuthPrincipal } from '../auth/types.ts';
import { canEditAgent, requirePermission, AuthorizationError } from '../auth/permissions.ts';
import {
  saveConnectionAccountSecret,
  tombstoneConnectionAccountSecret,
} from '../config/connector-secrets.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import type { ConfigStore } from '../config/store.ts';
import type {
  AgentConnectionBinding,
  ConnectionAccount,
  ConnectionAccountPolicy,
  McpConnectionIdentity,
} from '../config/types.ts';
import type { ConnectionAccountView } from './types.ts';

export interface ConnectionAccountServiceDependencies {
  config: ConfigStore;
  settings: SettingsStore;
  randomId?: () => string;
}

export class ConnectionAccountService {
  constructor(private readonly dependencies: ConnectionAccountServiceDependencies) {}

  async create(input: {
    principal: AuthPrincipal;
    workspaceId: string;
    ownerKind: 'team' | 'member';
    providerId: string;
    label: string;
    purpose?: string;
    identity?: McpConnectionIdentity;
    policy: ConnectionAccountPolicy;
    credential?: string;
  }): Promise<ConnectionAccount> {
    requirePermission(
      input.principal,
      input.ownerKind === 'team' ? 'connection.create_team' : 'connection.create_personal',
    );
    const id = `connection_${this.id()}`;
    const secretRefId = `secret_${this.id()}`;
    const account = await this.dependencies.config.putConnectionAccount({
      id,
      workspaceId: input.workspaceId,
      ownerKind: input.ownerKind,
      ...(input.ownerKind === 'member'
        ? { ownerMembershipId: input.principal.membershipId }
        : {}),
      createdByMembershipId: input.principal.membershipId,
      providerId: input.providerId,
      label: input.label,
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(input.identity ? { identity: input.identity } : {}),
      policy: input.policy,
      secretRefId,
      lifecycle: input.credential || input.policy.kind === 'mcp' && input.policy.authMode === 'none'
        ? 'pending'
        : 'needs_attention',
    }, 0);
    if (!input.credential && !(input.policy.kind === 'mcp' && input.policy.authMode === 'none')) {
      return account;
    }
    if (input.credential) {
      await saveConnectionAccountSecret(secretRefId, input.credential, undefined, this.dependencies.settings);
    }
    return this.dependencies.config.putConnectionAccount(
      { ...account, lifecycle: 'ready' },
      account.revision,
    );
  }

  async listViews(workspaceId: string): Promise<ConnectionAccountView[]> {
    const accounts = await this.dependencies.config.listConnectionAccounts(workspaceId);
    return Promise.all(accounts.map(async ({ secretRefId: _secretRefId, ...account }) => ({
      ...account,
      credentialConfigured: account.lifecycle === 'ready',
    })));
  }

  /** Return an account only after proving the caller owns its management lane. */
  async getForManagement(
    principal: AuthPrincipal,
    connectionAccountId: string,
  ): Promise<ConnectionAccount> {
    const account = await this.findAccount(connectionAccountId);
    this.requireManage(principal, account);
    return account;
  }

  async attach(input: {
    principal: AuthPrincipal;
    agentId: string;
    connectionAccountId: string;
    allowedCapabilities?: string[];
  }): Promise<AgentConnectionBinding> {
    const agent = await this.dependencies.config.getAgent(input.agentId);
    if (!canEditAgent(input.principal, agent)) throw new AuthorizationError();
    const account = await this.findAccount(input.connectionAccountId);
    if (
      account.ownerKind === 'member' &&
      account.ownerMembershipId !== input.principal.membershipId
    ) {
      throw new AuthorizationError();
    }
    if (account.lifecycle === 'revoked') throw new Error('Revoked connection accounts cannot be attached');
    return this.dependencies.config.putAgentConnectionBinding({
      agentId: input.agentId,
      connectionAccountId: account.id,
      providerId: account.providerId,
      allowedCapabilities: input.allowedCapabilities ?? [],
      enabled: true,
    });
  }

  async detach(input: {
    principal: AuthPrincipal;
    agentId: string;
    connectionAccountId: string;
  }): Promise<AgentConnectionBinding> {
    const agent = await this.dependencies.config.getAgent(input.agentId);
    if (!canEditAgent(input.principal, agent)) throw new AuthorizationError();
    const current = (await this.dependencies.config.listAgentConnectionBindings(input.agentId))
      .find((binding) => binding.connectionAccountId === input.connectionAccountId);
    if (!current) throw new Error('Connection binding does not exist');
    return this.dependencies.config.putAgentConnectionBinding({ ...current, enabled: false });
  }

  async revoke(input: {
    principal: AuthPrincipal;
    connectionAccountId: string;
  }): Promise<ConnectionAccount> {
    const account = await this.findAccount(input.connectionAccountId);
    this.requireManage(input.principal, account);
    if (account.lifecycle === 'revoked') return account;

    // Pause dependents before making the account unavailable. If secret
    // deletion fails, needs_attention remains a fail-closed intermediate state.
    const needsAttention = await this.dependencies.config.putConnectionAccount(
      { ...account, lifecycle: 'needs_attention' },
      account.revision,
    );
    await this.pauseDependentSchedules(account.id);
    await tombstoneConnectionAccountSecret(
      account.secretRefId,
      undefined,
      this.dependencies.settings,
    );
    return this.dependencies.config.putConnectionAccount(
      { ...needsAttention, lifecycle: 'revoked' },
      needsAttention.revision,
    );
  }

  private async pauseDependentSchedules(connectionAccountId: string): Promise<void> {
    const agents = await this.dependencies.config.listAgents();
    for (const agent of agents) {
      const binding = (await this.dependencies.config.listAgentConnectionBindings(agent.id))
        .find((candidate) => candidate.connectionAccountId === connectionAccountId && candidate.enabled);
      if (!binding) continue;
      for (const schedule of await this.dependencies.config.listAgentScheduleReferences(agent.id)) {
        if (
          schedule.state === 'active' &&
          schedule.requiredConnectionAccountIds.includes(connectionAccountId)
        ) {
          await this.dependencies.config.putAgentScheduleReference(
            { ...schedule, state: 'needs_attention' },
            schedule.revision,
          );
        }
      }
    }
  }

  private async findAccount(id: string): Promise<ConnectionAccount> {
    const installations = await this.dependencies.config.listWorkspaceInstallations();
    for (const installation of installations) {
      const account = (await this.dependencies.config.listConnectionAccounts(installation.workspaceId))
        .find((candidate) => candidate.id === id);
      if (account) return account;
    }
    throw new Error(`Unknown connection account ${id}`);
  }

  private requireManage(principal: AuthPrincipal, account: ConnectionAccount): void {
    if (principal.role === 'owner' || principal.role === 'admin') return;
    if (account.ownerKind === 'member' && account.ownerMembershipId === principal.membershipId) return;
    if (account.ownerKind === 'team' && account.createdByMembershipId === principal.membershipId) return;
    throw new AuthorizationError();
  }

  private id(): string {
    return (this.dependencies.randomId ?? (() => crypto.randomUUID().replace(/-/g, '')))();
  }
}
