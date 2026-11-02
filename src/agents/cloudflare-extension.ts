import { objectInstallationEnv, type ObjectContext } from '../config/installation-scope.ts';
import { AgentBootMarks, type AgentBootMethod } from '../observability/runtime-latency.ts';
import {
  objectHostFunctions,
  type HostObjectStorage,
  type HostObjectRestoreContext,
  type InstallationObjectHostRpc,
  type ObjectExportRequest,
  type ObjectHostRequest,
  type ObjectRestoreBookmarksRequest,
  type ObjectRestoreRequest,
  type ObjectRestoreRestartRequest,
} from '../state/object-host.ts';

/**
 * The branded descriptor Flue's generated Cloudflare entry reads from an
 * agent module's `cloudflare` export. Built here without importing
 * `@flue/runtime/cloudflare`, whose graph needs `cloudflare:workers` and so
 * cannot load where these shared modules also run (Node). The brand is Flue's
 * global-registry symbol; a mismatch fails the Cloudflare build loudly.
 */
export const FLUE_CLOUDFLARE_EXTENSION_BRAND = Symbol.for('@flue/runtime/cloudflare-extension');

type AgentObjectClass = new (...args: never[]) => object;

/** The Durable Object entry points of Flue's agent base that an activation can serve first. */
interface AgentObjectEntries {
  fetch(request: Request): Promise<Response>;
  alarm(...args: unknown[]): unknown;
}

/** Each agent object's `agent_boot` marks, kept off the instance Flue and the Agents SDK own. */
const agentBoots = new WeakMap<object, AgentBootMarks>();

/** Report the agent object's call to its activation's `agent_boot` marks. */
export function reportAgentObjectCall(
  agent: object,
  method: AgentBootMethod,
  from?: { sentAt?: number | undefined; turnJobId?: string | undefined },
): void {
  agentBoots.get(agent)?.call(method, from);
}

/** What the host functions read from the Durable Object an agent instance is. */
interface AgentObjectState {
  readonly ctx: HostObjectRestoreContext & { readonly storage: HostObjectStorage };
  readonly env: Record<string, unknown> | undefined;
}

/**
 * An agent object serves the installation its instance ID names, so its
 * tools, interceptors and `getCloudflareContext().env` see that
 * installation's env (see installation-scope.ts). Standalone: unchanged.
 *
 * It also answers a host serving many installations (an operator job, see
 * state/installation-objects.ts): export or restore its storage, erase it, or clear its
 * alarm. Each refuses on standalone and for any installation but the one the
 * instance ID scopes.
 */
export function installationAgentObject(Base: AgentObjectClass): AgentObjectClass {
  const Agent = Base as new (ctx: ObjectContext, env: unknown) => AgentObjectEntries;
  return class InstallationAgentObject extends Agent {
    constructor(ctx: ObjectContext, env: unknown) {
      const boot = new AgentBootMarks(new.target.name);
      super(ctx, objectInstallationEnv(ctx, env));
      agentBoots.set(this, boot);
      boot.constructed();
    }

    fetch(request: Request): Promise<Response> {
      reportAgentObjectCall(this, 'fetch');
      return super.fetch(request);
    }

    alarm(...args: unknown[]): unknown {
      reportAgentObjectCall(this, 'alarm');
      return super.alarm(...args);
    }

    /** Host RPC: one page of this instance's storage (its transcript and Flue's own records). */
    async chickpeaHostExportPage(request: ObjectExportRequest) {
      reportAgentObjectCall(this, 'host');
      return agentHost(this).chickpeaHostExportPage(request);
    }

    async chickpeaHostRestoreBookmarks(request: ObjectRestoreBookmarksRequest) {
      reportAgentObjectCall(this, 'host');
      return agentHost(this).chickpeaHostRestoreBookmarks(request);
    }

    async chickpeaHostRestore(request: ObjectRestoreRequest) {
      reportAgentObjectCall(this, 'host');
      return agentHost(this).chickpeaHostRestore(request);
    }

    async chickpeaHostRestoreRestart(request: ObjectRestoreRestartRequest) {
      reportAgentObjectCall(this, 'host');
      return agentHost(this).chickpeaHostRestoreRestart(request);
    }

    /**
     * Host RPC: delete every table, key-value entry and the alarm of this
     * instance. It must be the instance's last contact: any later call
     * constructs it again, and Flue re-creates its storage, empty.
     */
    async chickpeaHostErase(request: ObjectHostRequest) {
      reportAgentObjectCall(this, 'host');
      return agentHost(this).chickpeaHostErase(request);
    }

    /**
     * Host RPC: clear the alarm that resumes this instance's submissions. The
     * state store aborts the submissions it cancels; one that still resumes is
     * refused by the installation's admission check while it is suspended.
     */
    async chickpeaHostCancelPendingWork(request: ObjectHostRequest) {
      reportAgentObjectCall(this, 'host');
      return agentHost(this).chickpeaHostCancelPendingWork(request);
    }
  };
}

function agentHost(agent: object): InstallationObjectHostRpc {
  const self = agent as AgentObjectState;
  return objectHostFunctions({ env: self.env, storage: self.ctx.storage, restoreContext: self.ctx });
}

/** The `cloudflare` export of an agent with no other object extension. */
export const installationAgentExtension = {
  base: installationAgentObject,
  [FLUE_CLOUDFLARE_EXTENSION_BRAND]: true as const,
};
