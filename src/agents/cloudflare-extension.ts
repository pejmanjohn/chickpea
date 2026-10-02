import { objectInstallationEnv, type ObjectContext } from '../config/installation-scope.ts';
import {
  objectHostFunctions,
  type HostObjectStorage,
  type InstallationObjectHostRpc,
  type ObjectExportRequest,
  type ObjectHostRequest,
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

/** What the host functions read from the Durable Object an agent instance is. */
interface AgentObjectState {
  readonly ctx: { readonly storage: HostObjectStorage };
  readonly env: Record<string, unknown> | undefined;
}

/**
 * An agent object serves the installation its instance ID names, so its
 * tools, interceptors and `getCloudflareContext().env` see that
 * installation's env (see installation-scope.ts). Standalone: unchanged.
 *
 * It also answers a host serving many installations (an operator job, see
 * state/installation-objects.ts): export its storage or erase it. Each
 * refuses on standalone and for any installation but the one the instance ID
 * scopes.
 */
export function installationAgentObject(Base: AgentObjectClass): AgentObjectClass {
  const Agent = Base as new (ctx: ObjectContext, env: unknown) => object;
  return class InstallationAgentObject extends Agent {
    constructor(ctx: ObjectContext, env: unknown) {
      super(ctx, objectInstallationEnv(ctx, env));
    }

    /** Host RPC: one page of this instance's storage (its transcript and Flue's own records). */
    async chickpeaHostExportPage(request: ObjectExportRequest) {
      return agentHost(this).chickpeaHostExportPage(request);
    }

    /** Host RPC: delete every table, key-value entry and the alarm of this instance. */
    async chickpeaHostErase(request: ObjectHostRequest) {
      return agentHost(this).chickpeaHostErase(request);
    }
  };
}

function agentHost(agent: object): InstallationObjectHostRpc {
  const self = agent as AgentObjectState;
  return objectHostFunctions({ env: self.env, storage: self.ctx.storage });
}

/** The `cloudflare` export of an agent with no other object extension. */
export const installationAgentExtension = {
  base: installationAgentObject,
  [FLUE_CLOUDFLARE_EXTENSION_BRAND]: true as const,
};
