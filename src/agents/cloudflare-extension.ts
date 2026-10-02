import { objectInstallationEnv } from '../config/installation-scope.ts';

/**
 * The branded descriptor Flue's generated Cloudflare entry reads from an
 * agent module's `cloudflare` export. Built here without importing
 * `@flue/runtime/cloudflare`, whose graph needs `cloudflare:workers` and so
 * cannot load where these shared modules also run (Node). The brand is Flue's
 * global-registry symbol; a mismatch fails the Cloudflare build loudly.
 */
export const FLUE_CLOUDFLARE_EXTENSION_BRAND = Symbol.for('@flue/runtime/cloudflare-extension');

type AgentObjectClass = new (...args: never[]) => object;
type AgentObjectContext = { id: { name?: string } };

/**
 * An agent object serves the installation its instance ID names, so its
 * tools, interceptors and `getCloudflareContext().env` see that
 * installation's env (see installation-scope.ts). Standalone: unchanged.
 */
export function installationAgentObject(Base: AgentObjectClass): AgentObjectClass {
  const Agent = Base as new (ctx: AgentObjectContext, env: unknown) => object;
  return class InstallationAgentObject extends Agent {
    constructor(ctx: AgentObjectContext, env: unknown) {
      super(ctx, objectInstallationEnv(ctx, env));
    }
  };
}

/** The `cloudflare` export of an agent with no other object extension. */
export const installationAgentExtension = {
  base: installationAgentObject,
  [FLUE_CLOUDFLARE_EXTENSION_BRAND]: true as const,
};
