/** The service over an installation's live stores, main bot and public URL. */
import type { EncryptedCredentialStore } from '../../config/settings-store.ts';
import type { PlatformEnv } from '../../config/state-backend.ts';
import { resolveStores } from '../../config/state-backend.ts';
import { resolveSlackPublicUrl } from '../credentials.ts';
import { slackInstallationCredentialId } from '../hosted-slack-app.ts';
import { resolveSlackInstallationCredentials } from '../installation-credentials.ts';
import { createDirectSlackTransport } from '../transport/direct.ts';
import type { AgentSlackAppsHost } from './host.ts';
import { AgentSlackApps } from './service.ts';

export async function liveAgentSlackApps(env: PlatformEnv | undefined, host: AgentSlackAppsHost): Promise<AgentSlackApps> {
  const stores = resolveStores(env);
  const settings = stores.settings;
  if (!('getEncryptedCredentialRevision' in settings)) throw new Error('The settings store has no encrypted realm.');
  const credentials = await resolveSlackInstallationCredentials(slackInstallationCredentialId(env), env);
  return new AgentSlackApps({
    env,
    stores: { config: stores.config, settings: settings as typeof settings & EncryptedCredentialStore },
    host,
    transport: createDirectSlackTransport(credentials.botToken ?? '', credentials.userGroupToken),
    publicOrigin: () => resolveSlackPublicUrl(env, stores.settings, stores.identity),
  });
}
