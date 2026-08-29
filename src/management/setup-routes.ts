import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import { BetterAuthDirectory, BetterAuthSessionAuthenticator } from '../auth/better-auth-principal.ts';
import { resolveBetterAuthEnvironment } from '../auth/better-auth-environment.ts';
import { setCookieValues } from '../auth/cookies.ts';
import { AuthorizationError, requireAgentEdit } from '../auth/permissions.ts';
import { validateBrowserMutationProvenance } from '../auth/request-provenance.ts';
import { AuthService } from '../auth/service.ts';
import type { AuthPrincipal } from '../auth/types.ts';

import {
  completeApiOAuthAuthorization,
  saveApiOAuthClient,
  startApiOAuthAuthorization,
  type ApiOAuthDependencies,
} from '../config/api-oauth.ts';
import { isValidApiOAuthConnectionPolicy } from '../config/api-oauth-policy.ts';
import {
  clearConnectorCredential,
  saveConnectorCredential,
} from '../config/connector-secrets.ts';
import {
  exchangeGithubAppManifest,
  getGithubConnection,
  getRepositoryInstallation,
  GITHUB_OWNER_PATTERN,
  GITHUB_SETTING_KEYS,
  normalizePrivateKeyPem,
} from '../config/github-app.ts';
import {
  buildMcpRequestHeaders,
  deleteMcpSecrets,
  saveMcpSecrets,
} from '../config/mcp-secrets.ts';
import {
  completeMcpOAuthAuthorization,
  resolveMcpOAuthAccessToken,
  startMcpOAuthAuthorization,
  type McpOAuthDependencies,
} from '../config/mcp-oauth.ts';
import { validateMcpUrl } from '../config/mcp-url.ts';
import { discoverMcpConnectionIdentity } from '../config/mcp-identity.ts';
import { discoverMcpTools } from '../config/mcp-test.ts';
import { saveOpenAiAuthMethod } from '../config/openai-auth.ts';
import { validateProviderApiKey } from '../config/provider-models.ts';
import {
  describeProviderKeySources,
  saveProviderApiKey,
  type ProviderKeyId,
} from '../config/provider-keys.ts';
import { storedCredentialMetadata } from '../config/model-credential-refs.ts';
import {
  getConfigStore,
  getIdentityStore,
  getManagementStore,
  getSettingsStore,
  getSlackStateStore,
  getUsageStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  type ConnectionAccount,
  type CustomAgentConfig,
  type McpConnectionConfig,
} from '../config/types.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { UsageStore } from '../usage/types.ts';
import { MANAGED_CONNECTOR_CATALOG, type ManagedConnectorCatalog } from '../connections/catalog/index.ts';
import {
  ManagedConnectionLaneExistsError,
  cancelManagedAuthorizationFlow,
  pollManagedAuthorizationFlow,
  startManagedAuthorizationFlow,
  type ManagedAuthorizationFlowDependencies,
} from '../connections/managed-authorization-flow.ts';
import { ManagedAuthorizationError } from '../connections/managed-authorization.ts';
import { ManagedProviderRequestError } from '../connections/managed-errors.ts';
import {
  managedProviderAvailability,
  type ManagedConnectionProviderRegistry,
} from '../connections/managed.ts';
import { resolveManagedAuthorizationProviderContext } from '../connections/managed-provider-context.ts';
import { ManagedConnectionProviderUnavailableError } from '../connections/store.ts';
import {
  agentAvatarUrl,
  agentAvatarUrlForPresentation,
} from '../slack/agent-presence/avatar-assets.ts';
import { resolveSlackInstallationExecutionContext } from '../slack/installation-execution.ts';
import { slackPresentationStatePort } from '../slack/presentation-state-port.ts';
import {
  completeAgentWelcomeDelivery,
  completeManagementSetupReceipt,
  deliverManagementReceiptToSlack,
  drainManagementReceiptOutbox,
  failAgentWelcomeDelivery,
} from './receipts.ts';
import type { ManagementStore } from './store.ts';
import {
  ManagementError,
  type ManagementSetupRecord,
} from './types.ts';
import { emitManagementMetric } from './telemetry.ts';
import {
  renderManagedConnectionDeparturePage,
  renderManagedConnectionSetupPage,
  renderManagedConnectionSuccessPage,
  renderManagedConnectionUnavailablePage,
  renderManagedConnectionWaitingPage,
} from './connector-landing-page.ts';

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SETUP_ID_PATTERN = /^setup_[A-Za-z0-9_-]{1,128}$/;
const MAX_FORM_BYTES = 16 * 1024;
const SESSION_COOKIE = '__Secure-chickpea-setup';

export interface ManagementSetupRoutesOptions {
  management?: ManagementStore;
  config?: ConfigStore;
  settings?: SettingsStore;
  identity?: Pick<IdentityStore, 'getUser' | 'listExternalIdentities'>;
  usage?: UsageStore;
  platformEnv?: PlatformEnv;
  now?: () => number;
  randomCapability?: () => string;
  validateProviderKey?: typeof validateProviderApiKey;
  deliverReceipt?: typeof deliverManagementReceiptToSlack;
  managedConnectionProviders?: ManagedConnectionProviderRegistry;
  managedConnectorCatalog?: ManagedConnectorCatalog;
  /** Test seam; production resolves the current Better Auth browser session. */
  authenticatePrincipal?: (request: Request) => Promise<AuthPrincipal | undefined>;
}

export function createManagementSetupRoutes(
  options: ManagementSetupRoutesOptions = {},
): Hono {
  const app = new Hono();
  const now = options.now ?? Date.now;

  app.use('/setup/*', async (c, next) => {
    setupResponseHeaders(c);
    await next();
  });
  app.use('/setup/*', bodyLimit({
    maxSize: MAX_FORM_BYTES,
    onError: (c) => c.json({ error: 'request_too_large' }, 413),
  }));

  app.get('/setup/:setupOperationId', async (c) => {
    const dependencies = setupDependencies(c, options);
    const setupId = setupIdFromContext(c);
    if (!setupId) return unavailablePage(c);
    const setup = await dependencies.management.getSetup(setupId, now());
    const principal = await authenticateSetupPrincipal(c, options);
    const session = setupSession(c, setupId);

    if (setup?.action === 'managed_connection') {
      if (setup.status === 'revoked' || setup.status === 'expired') {
        return managedUnavailablePage(c);
      }
      const authorized = await principalCanEditManagedSetup(
        principal,
        setup,
        dependencies.config,
      );
      if (setup.status === 'completed') {
        if (!authorized) return managedUnavailablePage(c);
        const page = await managedConnectionPageInput(c, setup, dependencies, options);
        return page
          ? c.html(c.req.query('poll') === '1' && session && CAPABILITY_PATTERN.test(session)
              ? renderManagedConnectionWaitingPage(page)
              : renderManagedConnectionSuccessPage(page))
          : managedUnavailablePage(c);
      }
      if (principal && !authorized) return managedUnavailablePage(c);
      if (!principal || !session || !managedSetupSessionMatches(setup, session)) {
        return c.html(renderClaimPage(setupId, true));
      }
      if (setup.status !== 'pending') return managedUnavailablePage(c);
      const page = await managedConnectionPageInput(c, setup, dependencies, options);
      if (!page) return managedUnavailablePage(c);
      return c.html(c.req.query('poll') === '1'
        ? renderManagedConnectionWaitingPage(page)
        : renderManagedConnectionSetupPage(page));
    }

    const browserMatches = setup && principal && session
      ? principalMatchesSetup(principal, setup) && sessionMatches(setup, session)
      : false;
    if (setup?.status === 'completed' && principalMatchesSetup(principal, setup)) {
      return terminalPage(c, setup);
    }
    if (setup && principal && !principalMatchesSetup(principal, setup)) {
      return unavailablePage(c);
    }
    if (!setup || !principal || !session || !browserMatches) {
      return c.html(renderClaimPage(setupId));
    }
    if (!['claimed', 'failed', 'authorizing'].includes(setup.status)) {
      return terminalPage(c, setup);
    }
    return c.html(await renderSetupSummary(setup));
  });

  app.post('/setup/:setupOperationId/exchange', async (c) => {
    const dependencies = setupDependencies(c, options);
    const setupId = setupIdFromContext(c);
    if (!setupId || !sameOriginMutation(c)) return genericDenied(c);
    const setup = await dependencies.management.getSetup(setupId, now());
    const principal = await authenticateSetupPrincipal(c, options);
    if (!principal) return authenticationRequired(c);
    if (!setup) return genericDenied(c);
    const body = await readJsonBody(c);
    const capability = isRecord(body) && typeof body.capability === 'string'
      ? body.capability
      : '';
    if (!CAPABILITY_PATTERN.test(capability)) return genericDenied(c);

    let rawSession = capability;
    try {
      if (setup.action === 'managed_connection') {
        if (setup.status !== 'pending' || !setup.tokenDigest ||
            setup.tokenDigest !== digest(capability) ||
            principal.organizationId !== setup.organizationId) {
          throw new AuthorizationError();
        }
        requireAgentEdit(principal, await currentManagedAgent(setup, dependencies.config));
      } else {
        if (!principalMatchesSetup(principal, setup)) return genericDenied(c);
        rawSession = (options.randomCapability ?? randomCapability)();
        if (!CAPABILITY_PATTERN.test(rawSession)) return genericDenied(c);
        await dependencies.management.exchangeSetup({
          setupOperationId: setupId,
          tokenDigest: digest(capability),
          browserSessionDigest: digest(rawSession),
          at: now(),
        });
      }
      emitManagementMetric('setup.lifecycle', {
        action: 'exchange',
        outcome: 'success',
      });
    } catch {
      emitManagementMetric('setup.lifecycle', {
        action: 'exchange',
        outcome: 'denied',
      });
      return genericDenied(c);
    }
    const cookieMaxAge = Math.max(1, Math.ceil((setup.expiresAt - now()) / 1_000));
    c.header('Set-Cookie', setupCookie(setupId, rawSession, cookieMaxAge));
    return c.json({ ok: true });
  });

  app.post('/setup/:setupOperationId/complete', async (c) => {
    const dependencies = setupDependencies(c, options);
    const setupId = setupIdFromContext(c);
    if (!setupId || !sameOriginFormMutation(c)) return genericDenied(c);
    const principal = await authenticateSetupPrincipal(c, options);
    if (!principal) return authenticationRequired(c);
    const setup = await requireBrowserSetup(
      c, dependencies.management, setupId, principal, now(),
    );
    if (!setup) return genericDenied(c);
    const fields = await readFormFields(c);
    if (!fields) return formFailure(c, setup, 'invalid_form');
    try {
      await dependencies.management.authorizeSetup({
        setupOperationId: setupId,
        browserSessionDigest: digest(setupSession(c, setupId)!),
        at: now(),
      });
      const result = await completeFormAction(setup, fields, dependencies, options, now());
      await finishSetup(c, setup, result, dependencies, options, now());
      clearSetupCookie(c, setupId);
      return c.redirect(`/setup/${encodeURIComponent(setupId)}`, 303);
    } catch (error) {
      await markSetupFailure(setup, c, dependencies.management, safeFailureCode(error), now());
      return formFailure(c, setup, safeFailureCode(error));
    }
  });

  app.post('/setup/:setupOperationId/authorize', async (c) => {
    const dependencies = setupDependencies(c, options);
    const setupId = setupIdFromContext(c);
    if (!setupId || !sameOriginFormMutation(c)) return genericDenied(c);
    const principal = await authenticateSetupPrincipal(c, options);
    if (!principal) return authenticationRequired(c);
    const setup = await requireBrowserSetup(
      c, dependencies.management, setupId, principal, now(),
    );
    if (!setup) return genericDenied(c);
    const fields = await readFormFields(c);
    if (!fields) return formFailure(c, setup, 'invalid_form');

    let activeSetup = setup;
    try {
      if (setup.action === 'managed_connection') {
        const agent = await currentManagedAgent(setup, dependencies.config);
        requireAgentEdit(principal, agent);
        if (setup.status === 'completed') {
          if (authorizationJsonRequest(c)) {
            return c.json({
              error: 'managed_authorization_superseded',
              message: `${setup.target.targetLabel} is already connected to ${agent.name}.`,
            }, 409);
          }
          return c.redirect(`/setup/${encodeURIComponent(setupId)}`, 303);
        }
        if (setup.status !== 'pending') return genericDenied(c);
        const selection = managedSetupSelection(setup, fields, dependencies.catalog);
        if (setup.origin.kind !== 'slack' || !selection) {
          throw new ManagedAuthorizationError('invalid');
        }
        const browserSession = setupSession(c, setupId);
        if (!browserSession) throw new ManagedAuthorizationError('invalid');
        const browserSecret = managedBrowserSecret(browserSession);
        const started = await startManagedAuthorizationFlow(
          await managedFlowDependencies(dependencies, options),
          {
            principal,
            agent,
            workspaceId: setup.origin.workspaceId,
            ownerKind: selection.ownerKind,
            toolkit: setup.target.provider,
            access: selection.accessLane,
            capabilities: selection.scopes,
            existingBrowserSecret: browserSecret,
            attemptScopeId: setupId,
            returnUrl: `${requestOrigin(c)}/setup/${encodeURIComponent(setupId)}?poll=1`,
            randomSecret: () => browserSecret,
          },
        );
        const authorizationUrl = managedAuthorizationUrl(started.authorizationUrl);
        if (authorizationJsonRequest(c)) return c.json({ authorizationUrl });
        const page = await managedConnectionPageInput(c, setup, dependencies, options);
        return page
          ? c.html(renderManagedConnectionDeparturePage(page, authorizationUrl))
          : managedUnavailablePage(c);
      }

      activeSetup = await dependencies.management.authorizeSetup({
        setupOperationId: setupId,
        browserSessionDigest: digest(setupSession(c, setupId)!),
        at: now(),
      });
      await assertExactTarget(activeSetup, dependencies);
      if (activeSetup.action === 'api_oauth') {
        const clientId = requiredField(fields, 'clientId', 512);
        const clientSecret = requiredField(fields, 'clientSecret', 2_048);
        const ref = setupConnectionRef(activeSetup);
        await saveApiOAuthClient(ref, { provider: 'google', clientId, clientSecret }, dependencies.settings);
        const started = await startApiOAuthAuthorization({
          ref,
          provider: 'google',
          callbackUrl: `${requestOrigin(c)}/setup/${encodeURIComponent(setupId)}/oauth/api/callback`,
          scopes: activeSetup.scopes,
        }, apiOAuthDependencies(dependencies));
        return c.redirect(started.authorizationUrl.href, 303);
      }
      if (activeSetup.action === 'mcp_oauth') {
        const { agent, connection } = await currentMcpConnection(activeSetup, dependencies.config);
        const started = await startMcpOAuthAuthorization({
          ref: { agentId: agent.id, connectionId: connection.id },
          serverUrl: connection.url,
          callbackUrl: `${requestOrigin(c)}/setup/${encodeURIComponent(setupId)}/oauth/mcp/callback`,
          ...(connection.oauthScope ? { scope: connection.oauthScope } : {}),
        }, mcpOAuthDependencies(dependencies));
        return c.redirect(started.authorizationUrl.href, 303);
      }
      if (activeSetup.action === 'repository_access') {
        return beginRepositorySetup(c, activeSetup, fields, dependencies);
      }
      throw new Error('wrong_action');
    } catch (error) {
      await markSetupFailure(activeSetup, c, dependencies.management, safeFailureCode(error), now());
      if (activeSetup.action === 'managed_connection') {
        const message = managedStartFailureMessage(error);
        if (authorizationJsonRequest(c)) {
          return c.json({ error: safeFailureCode(error), message }, 422);
        }
        const page = await managedConnectionPageInput(c, activeSetup, dependencies, options);
        return page
          ? c.html(renderManagedConnectionSetupPage({ ...page, failureMessage: message }), 422)
          : managedUnavailablePage(c);
      }
      return formFailure(c, activeSetup, safeFailureCode(error));
    }
  });

  app.post('/setup/:setupOperationId/managed/poll', async (c) => {
    const dependencies = setupDependencies(c, options);
    const setupId = setupIdFromContext(c);
    if (!setupId || !sameOriginMutation(c)) return genericDenied(c);
    const body = await readJsonBody(c);
    if (!isRecord(body) || Object.keys(body).length > 0) return genericDenied(c);
    const principal = await authenticateSetupPrincipal(c, options);
    if (!principal) return authenticationRequired(c);
    const setup = await requireBrowserSetup(
      c, dependencies.management, setupId, principal, now(),
    );
    if (!setup || setup.action !== 'managed_connection' || setup.origin.kind !== 'slack') {
      return genericDenied(c);
    }

    try {
      const agent = await currentManagedAgent(setup, dependencies.config);
      requireAgentEdit(principal, agent);
      if (setup.status === 'completed') {
        const cleanup = await cancelManagedAuthorizationFlow(
          await managedFlowDependencies(dependencies, options),
          {
            principal,
            browserSecret: managedBrowserSecret(setupSession(c, setupId)!),
            attemptScopeId: setupId,
          },
        );
        if (cleanup === 'discarded') {
          return c.json({
            error: 'managed_authorization_superseded',
            message: `Someone else already connected ${setup.target.targetLabel} to ${agent.name}. Your sign-in was discarded.`,
          }, 409);
        }
        return c.json({ status: 'connected' });
      }
      if (setup.status !== 'pending') return genericDenied(c);
      const result = await pollManagedAuthorizationFlow(
        await managedFlowDependencies(dependencies, options),
        {
          principal,
          agent,
          workspaceId: setup.origin.workspaceId,
          browserSecret: managedBrowserSecret(setupSession(c, setupId)!),
          attemptScopeId: setupId,
          commit: async (account) => {
            try {
              await finishSetup(
                c,
                setup,
                {
                  connector: setup.target.targetLabel,
                  connectionAccountId: account.id,
                  completedByUserId: principal.userId,
                  completedByMembershipId: principal.membershipId,
                  ownerKind: account.ownerKind,
                  accessLane: managedAccountAccessLane(
                    account,
                    setup.target.provider,
                    dependencies.catalog,
                  ),
                },
                dependencies,
                options,
                now(),
              );
              return true;
            } catch (error) {
              if (error instanceof ManagementError && error.code === 'setup_unavailable') {
                return false;
              }
              throw error;
            }
          },
        },
      );
      if (result.status === 'pending') return c.json({ status: 'pending' }, 202);
      if (result.status === 'lost') {
        return c.json({
          error: 'managed_authorization_superseded',
          message: `Someone else already connected ${setup.target.targetLabel} to ${agent.name}. Your sign-in was discarded.`,
        }, 409);
      }
      if (result.status === 'terminal') {
        await markSetupFailure(
          setup,
          c,
          dependencies.management,
          `managed_authorization_${result.reason}`,
          now(),
        );
        return c.json({
          error: 'managed_authorization_terminal',
          message: 'This connection did not finish. Start over and try again.',
          reason: result.reason,
        }, 409);
      }
      return c.json({ status: 'connected' });
    } catch (error) {
      if (error instanceof AuthorizationError) {
        return c.json({
          error: 'managed_authorization_forbidden',
          message: 'You no longer have permission to connect this Agent.',
        }, 409);
      }
      if (error instanceof ManagedAuthorizationError && error.code === 'stale_provider') {
        return c.json({
          error: 'managed_authorization_stale_provider',
          message: 'The connector configuration changed. Ask the Agent for a new link.',
        }, 409);
      }
      if (error instanceof ManagedAuthorizationError) {
        if (error.code === 'expired') {
          return c.json({
            error: 'managed_authorization_expired',
            message: 'Provider sign-in expired. Start over and try again.',
          }, 409);
        }
        return c.json({
          error: 'managed_authorization_invalid',
          message: 'This sign-in did not finish. Start over and try again.',
        }, 409);
      }
      if (error instanceof ManagedConnectionProviderUnavailableError ||
          error instanceof ManagedProviderRequestError) {
        return c.json({
          error: 'managed_authorization_poll_unavailable',
          message: 'Managed sign-in could not be checked yet. Chickpea will keep trying.',
        }, 503);
      }
      return c.json({ error: 'managed_authorization_poll_unavailable' }, 503);
    }
  });

  app.post('/setup/:setupOperationId/cancel', async (c) => {
    const dependencies = setupDependencies(c, options);
    const setupId = setupIdFromContext(c);
    if (!setupId || !sameOriginFormMutation(c)) return genericDenied(c);
    const principal = await authenticateSetupPrincipal(c, options);
    if (!principal) return authenticationRequired(c);
    const setup = await requireBrowserSetup(
      c, dependencies.management, setupId, principal, now(),
    );
    if (!setup || setup.action !== 'managed_connection') return genericDenied(c);
    try {
      const agent = await currentManagedAgent(setup, dependencies.config);
      requireAgentEdit(principal, agent);
      await cancelManagedAuthorizationFlow(
        await managedFlowDependencies(dependencies, options),
        {
          principal,
          browserSecret: managedBrowserSecret(setupSession(c, setupId)!),
          attemptScopeId: setupId,
        },
      );
      return c.redirect(`/setup/${encodeURIComponent(setupId)}`, 303);
    } catch {
      return genericDenied(c);
    }
  });

  app.get('/setup/:setupOperationId/oauth/api/callback', async (c) => {
    const dependencies = setupDependencies(c, options);
    const setupId = setupIdFromContext(c);
    const principal = await authenticateSetupPrincipal(c, options);
    const setup = setupId && principal
      ? await requireBrowserSetup(c, dependencies.management, setupId, principal, now())
      : undefined;
    const state = c.req.query('state') ?? '';
    const code = c.req.query('code') ?? '';
    if (!setup || setup.action !== 'api_oauth' || !state || !code) return genericDenied(c);
    try {
      await assertExactTarget(setup, dependencies);
      const completed = await completeApiOAuthAuthorization(
        { code, state },
        apiOAuthDependencies(dependencies),
      );
      const agent = await dependencies.config.getAgent(completed.ref.agentId);
      await setApiConnectionReady(
        dependencies.config,
        agent,
        completed.ref.connectionId,
        completed.identity?.accountName,
      );
      await finishSetup(
        c,
        setup,
        {
          connector: setup.target.targetLabel,
          ...(completed.identity?.accountName
            ? { accountLabel: completed.identity.accountName }
            : {}),
        },
        dependencies,
        options,
        now(),
      );
      clearSetupCookie(c, setupId!);
      return c.redirect(`/setup/${encodeURIComponent(setupId!)}`, 303);
    } catch (error) {
      await markSetupFailure(setup, c, dependencies.management, safeFailureCode(error), now());
      return c.redirect(`/setup/${encodeURIComponent(setupId!)}?status=failed`, 303);
    }
  });

  app.get('/setup/:setupOperationId/oauth/mcp/callback', async (c) => {
    const dependencies = setupDependencies(c, options);
    const setupId = setupIdFromContext(c);
    const principal = await authenticateSetupPrincipal(c, options);
    const setup = setupId && principal
      ? await requireBrowserSetup(c, dependencies.management, setupId, principal, now())
      : undefined;
    const state = c.req.query('state') ?? '';
    const code = c.req.query('code') ?? '';
    if (!setup || setup.action !== 'mcp_oauth' || !state || !code) return genericDenied(c);
    try {
      await assertExactTarget(setup, dependencies);
      const completed = await completeMcpOAuthAuthorization(
        { code, state },
        mcpOAuthDependencies(dependencies),
      );
      const result = await verifyMcpConnection(
        setup,
        dependencies,
        completed.ref,
        true,
      );
      await finishSetup(c, setup, result, dependencies, options, now());
      clearSetupCookie(c, setupId!);
      return c.redirect(`/setup/${encodeURIComponent(setupId!)}`, 303);
    } catch (error) {
      await markSetupFailure(setup, c, dependencies.management, safeFailureCode(error), now());
      return c.redirect(`/setup/${encodeURIComponent(setupId!)}?status=failed`, 303);
    }
  });

  app.get('/setup/:setupOperationId/github/callback', async (c) => {
    const dependencies = setupDependencies(c, options);
    const setupId = setupIdFromContext(c);
    const principal = await authenticateSetupPrincipal(c, options);
    const setup = setupId && principal
      ? await requireBrowserSetup(c, dependencies.management, setupId, principal, now())
      : undefined;
    const code = c.req.query('code') ?? '';
    const state = c.req.query('state') ?? '';
    if (!setup || setup.action !== 'repository_access' || !code || !state) {
      return genericDenied(c);
    }
    try {
      const stateKey = githubSetupStateKey(setup.setupOperationId);
      const expected = await dependencies.settings.getSetting(stateKey);
      if (!expected || expected !== digest(state)) throw new Error('invalid_state');
      await dependencies.settings.deleteSetting(stateKey);
      await assertExactTarget(setup, dependencies);
      const conversion = await exchangeGithubAppManifest(code);
      await dependencies.settings.applySettingsPatch({
        set: [
          { key: GITHUB_SETTING_KEYS.appId, value: String(conversion.id) },
          { key: GITHUB_SETTING_KEYS.appSlug, value: conversion.slug },
          { key: GITHUB_SETTING_KEYS.privateKey, value: normalizePrivateKeyPem(conversion.privateKeyPem) },
          ...(conversion.webhookSecret
            ? [{ key: GITHUB_SETTING_KEYS.webhookSecret, value: conversion.webhookSecret }]
            : []),
        ],
        ...(conversion.webhookSecret ? {} : { delete: [GITHUB_SETTING_KEYS.webhookSecret] }),
      });
      return c.redirect(
        `https://github.com/apps/${encodeURIComponent(conversion.slug)}/installations/new`,
        302,
      );
    } catch (error) {
      await markSetupFailure(setup, c, dependencies.management, safeFailureCode(error), now());
      return c.redirect(`/setup/${encodeURIComponent(setupId!)}?status=failed`, 303);
    }
  });

  app.get('/setup/:setupOperationId/repository/finish', async (c) => {
    const dependencies = setupDependencies(c, options);
    const setupId = setupIdFromContext(c);
    const principal = await authenticateSetupPrincipal(c, options);
    const setup = setupId && principal
      ? await requireBrowserSetup(c, dependencies.management, setupId, principal, now())
      : undefined;
    if (!setup || setup.action !== 'repository_access') return genericDenied(c);
    try {
      await assertExactTarget(setup, dependencies);
      const agent = await dependencies.config.getAgent(setup.target.agentId!);
      const repositoryIndex = agent.repositories.findIndex(({ id }) => id === setup.target.repositoryId);
      if (repositoryIndex < 0) throw new Error('target_changed');
      const repository = agent.repositories[repositoryIndex]!;
      const github = await getGithubConnection(dependencies.settings);
      if (github.mode !== 'app') throw new Error('github_not_connected');
      const installation = await getRepositoryInstallation(github, repository.fullName);
      if (!installation) throw new Error('repository_unavailable');
      const repositories = agent.repositories.slice();
      repositories[repositoryIndex] = {
        ...repository,
        installationId: installation.id,
        accountLogin: installation.accountLogin,
        enabled: true,
      };
      await dependencies.config.updateAgent(agent.id, { repositories }, agent.revision);
      await finishSetup(
        c,
        setup,
        { connector: 'GitHub', accountLabel: installation.accountLogin },
        dependencies,
        options,
        now(),
      );
      clearSetupCookie(c, setupId!);
      return c.redirect(`/setup/${encodeURIComponent(setupId!)}`, 303);
    } catch (error) {
      await markSetupFailure(setup, c, dependencies.management, safeFailureCode(error), now());
      return c.redirect(`/setup/${encodeURIComponent(setupId!)}?status=failed`, 303);
    }
  });

  return app;
}

interface SetupDependencies {
  management: ManagementStore;
  config: ConfigStore;
  settings: SettingsStore;
  identity: Pick<IdentityStore, 'getUser' | 'listExternalIdentities'>;
  usage: UsageStore;
  catalog: ManagedConnectorCatalog;
  platformEnv?: PlatformEnv;
}

function setupDependencies(c: Context, options: ManagementSetupRoutesOptions): SetupDependencies {
  const platformEnv = options.platformEnv ?? c.env as PlatformEnv | undefined;
  return {
    management: options.management ?? getManagementStore(platformEnv),
    config: options.config ?? getConfigStore(platformEnv),
    settings: options.settings ?? getSettingsStore(platformEnv),
    identity: options.identity ?? getIdentityStore(platformEnv),
    usage: options.usage ?? getUsageStore(platformEnv),
    catalog: options.managedConnectorCatalog ?? MANAGED_CONNECTOR_CATALOG,
    ...(platformEnv ? { platformEnv } : {}),
  };
}

async function managedFlowDependencies(
  dependencies: SetupDependencies,
  options: ManagementSetupRoutesOptions,
): Promise<ManagedAuthorizationFlowDependencies> {
  return {
    config: dependencies.config,
    settings: dependencies.settings,
    catalog: dependencies.catalog,
    providerContext: await resolveManagedAuthorizationProviderContext({
      settings: dependencies.settings,
      ...(dependencies.platformEnv ? { platformEnv: dependencies.platformEnv } : {}),
      ...(options.managedConnectionProviders
        ? { providers: options.managedConnectionProviders }
        : {}),
    }),
  };
}

async function currentManagedAgent(
  setup: ManagementSetupRecord,
  config: ConfigStore,
): Promise<CustomAgentConfig> {
  if (setup.action !== 'managed_connection' || !setup.target.agentId) {
    throw new ManagedAuthorizationError('invalid');
  }
  const agent = await config.getAgent(setup.target.agentId);
  if (agent.lifecycle === 'archived') throw new AuthorizationError();
  return agent;
}

async function principalCanEditManagedSetup(
  principal: AuthPrincipal | undefined,
  setup: ManagementSetupRecord,
  config: ConfigStore,
): Promise<boolean> {
  if (!principal || principal.machine || principal.organizationId !== setup.organizationId) {
    return false;
  }
  try {
    requireAgentEdit(principal, await currentManagedAgent(setup, config));
    return true;
  } catch {
    return false;
  }
}

async function managedConnectionPageInput(
  c: Context,
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
  options: ManagementSetupRoutesOptions,
) {
  try {
    const agent = await currentManagedAgent(setup, dependencies.config);
    const avatarUrl = connectorPageAvatarUrl(agent, requestOrigin(c));
    const writeCapabilities = new Set(dependencies.catalog
      .capabilities(setup.target.provider, 'write')
      .filter(({ accessLane }) => accessLane === 'write')
      .map(({ id }) => id));
    const providerContext = (await managedFlowDependencies(dependencies, options)).providerContext;
    const provider = providerContext.providers.get('composio');
    const writeReady = Boolean(provider?.authorize) && managedProviderAvailability(provider, {
      toolkit: setup.target.provider,
      accessLane: 'write',
    }).status === 'ready';
    return {
      setup,
      agent,
      writeAvailable: writeReady && setup.scopes.some((scope) => writeCapabilities.has(scope)),
      ...(avatarUrl ? { avatarUrl } : {}),
    };
  } catch {
    return undefined;
  }
}

function managedSetupSelection(
  setup: ManagementSetupRecord,
  fields: Record<string, string>,
  catalog: ManagedConnectorCatalog,
): { ownerKind: 'member' | 'team'; accessLane: 'read' | 'write'; scopes: string[] } {
  const ownerKind = fields.ownerKind?.trim();
  const accessLane = fields.access?.trim();
  if ((ownerKind !== 'member' && ownerKind !== 'team') ||
      (accessLane !== 'read' && accessLane !== 'write')) {
    throw new ManagedAuthorizationError('invalid');
  }
  const definitions = catalog.capabilities(setup.target.provider, accessLane);
  if (definitions.length === 0 ||
      (accessLane === 'write' && !definitions.some(({ accessLane: lane }) => lane === 'write'))) {
    throw new ManagedAuthorizationError('invalid');
  }
  const ceiling = new Set(setup.scopes);
  const scopes = definitions.map(({ id }) => id);
  if (scopes.some((scope) => !ceiling.has(scope))) {
    throw new ManagedAuthorizationError('invalid');
  }
  return { ownerKind, accessLane, scopes };
}

function managedAccountAccessLane(
  account: ConnectionAccount,
  toolkit: string,
  catalog: ManagedConnectorCatalog,
): 'read' | 'write' {
  if (account.policy.kind !== 'managed') return 'read';
  const writeCapabilities = new Set(catalog.capabilities(toolkit, 'write')
    .filter(({ accessLane }) => accessLane === 'write')
    .map(({ id }) => id));
  return account.policy.allowedCapabilities.some((capability) =>
    writeCapabilities.has(capability)) ? 'write' : 'read';
}

function authorizationJsonRequest(c: Context): boolean {
  return c.req.header('x-requested-with') === 'chickpea-setup' &&
    (c.req.header('accept') ?? '').split(',').some((value) =>
      value.trim().toLowerCase().startsWith('application/json'));
}

function managedAuthorizationUrl(url: URL): string {
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new ManagedAuthorizationError('invalid');
  }
  return url.href;
}

function connectorPageAvatarUrl(
  agent: CustomAgentConfig,
  publicOrigin: string,
): string | undefined {
  const presentationUrl = agentAvatarUrlForPresentation(agent, publicOrigin);
  if (!presentationUrl || !agent.slackPresence) return presentationUrl;
  try {
    if (new URL(presentationUrl).origin === new URL(publicOrigin).origin) {
      return presentationUrl;
    }
  } catch {
    return undefined;
  }
  // Gateway-published avatars are cross-origin. The immutable Chickpea avatar
  // route serves the same stored revision without widening this page's CSP.
  return agentAvatarUrl(publicOrigin, agent.id, agent.slackPresence.avatar.revision);
}

function managedStartFailureMessage(error: unknown): string {
  if (error instanceof ManagedConnectionLaneExistsError) {
    return `This Agent already has a ${error.ownerKind === 'team' ? 'team' : 'personal'} ${error.connectorLabel} connection.`;
  }
  if (error instanceof ManagedConnectionProviderUnavailableError) {
    return 'Managed sign-in is not configured for this deployment yet.';
  }
  if (error instanceof ManagedAuthorizationError && error.code === 'in_progress') {
    return 'A sign-in is already in progress in another tab. Finish it there before trying again.';
  }
  if (error instanceof ManagedAuthorizationError && error.code === 'recovery_required') {
    return 'This sign-in needs administrator cleanup before another connection can start.';
  }
  if (error instanceof AuthorizationError) return 'You no longer have permission to connect this Agent.';
  return 'Managed sign-in could not start. Try again.';
}

async function authenticateSetupPrincipal(
  c: Context,
  options: ManagementSetupRoutesOptions,
): Promise<AuthPrincipal | undefined> {
  if (options.authenticatePrincipal) {
    return options.authenticatePrincipal(c.req.raw);
  }
  const platformEnv = options.platformEnv ?? c.env as PlatformEnv | undefined;
  const identity = getIdentityStore(platformEnv);
  const control = await identity.getAuthControl();
  if (control?.authMode !== 'slack_active' || control.healthGate !== 'normal' ||
      !control.betterAuthOrganizationId || !control.canonicalAdminOrigin) return undefined;
  const environment = await resolveBetterAuthEnvironment({ control, platformEnv });
  if (!environment || environment.baseURL !== control.canonicalAdminOrigin) return undefined;
  const directory = new BetterAuthDirectory({
    backend: environment.backend,
    access: identity,
    organizationId: control.betterAuthOrganizationId,
    canonicalAdminOrigin: control.canonicalAdminOrigin,
  });
  const auth = new AuthService({
    identity,
    sessionAuthenticator: new BetterAuthSessionAuthenticator({
      ...environment,
      directory,
      organizationId: control.betterAuthOrganizationId,
    }),
  });
  try {
    const principal = await auth.authenticateRequest(c.req.raw);
    const headers = auth.takeResponseHeaders(c.req.raw);
    if (headers) {
      for (const cookie of setCookieValues(headers)) {
        c.header('Set-Cookie', cookie, { append: true });
      }
    }
    return principal.machine ? undefined : principal;
  } catch {
    return undefined;
  }
}

function principalMatchesSetup(
  principal: AuthPrincipal | undefined,
  setup: ManagementSetupRecord,
): principal is AuthPrincipal {
  return Boolean(principal && !principal.machine &&
    principal.userId === setup.actorUserId &&
    principal.membershipId === setup.actorMembershipId &&
    principal.organizationId === setup.organizationId);
}

async function completeFormAction(
  setup: ManagementSetupRecord,
  fields: Record<string, string>,
  dependencies: SetupDependencies,
  options: ManagementSetupRoutesOptions,
  at: number,
): Promise<{ connector?: string; accountLabel?: string }> {
  await assertExactTarget(setup, dependencies);
  if (setup.action === 'provider_credential') {
    const providerId = setup.target.provider as ProviderKeyId;
    const current = (await describeProviderKeySources(
      dependencies.platformEnv,
      dependencies.settings,
    ))[providerId];
    if ((setup.target.replacement ? current !== 'stored' : current !== 'missing') || current === 'env') {
      throw new Error('target_changed');
    }
    const apiKey = requiredField(fields, 'apiKey', 8_192);
    await (options.validateProviderKey ?? validateProviderApiKey)(providerId, apiKey);
    await saveProviderApiKey(
      providerId,
      apiKey,
      dependencies.platformEnv,
      dependencies.settings,
      dependencies.usage,
      setup.target.expectedRevision,
    );
    if (providerId === 'openai' && current === 'missing') {
      await saveOpenAiAuthMethod(dependencies.settings, 'api_key');
    }
    return { connector: providerDisplayName(providerId) };
  }
  if (setup.action === 'api_credential') {
    const ref = setupConnectionRef(setup);
    const credential = requiredField(fields, 'credential', 16_384);
    await saveConnectorCredential(
      ref.agentId,
      ref.connectionId,
      credential,
      dependencies.platformEnv,
      dependencies.settings,
    );
    try {
      const agent = await dependencies.config.getAgent(ref.agentId);
      await setApiConnectionReady(dependencies.config, agent, ref.connectionId);
    } catch (error) {
      await clearConnectorCredential(
        ref.agentId,
        ref.connectionId,
        dependencies.platformEnv,
        dependencies.settings,
      );
      throw error;
    }
    return { connector: setup.target.targetLabel };
  }
  if (setup.action === 'mcp_credentials') {
    const { agent, connection } = await currentMcpConnection(setup, dependencies.config);
    const bearerToken = fields.bearerToken?.trim();
    const headers = Object.fromEntries(connection.headerNames.map((name) => [
      name,
      requiredField(fields, `header:${name}`, 16_384),
    ]));
    const validated = validateMcpUrl(connection.url);
    if (!validated.ok) throw new Error('blocked_url');
    const requestHeaders = buildMcpRequestHeaders(connection.authMode, {
      ...(bearerToken ? { bearer: bearerToken } : {}),
      headers,
    });
    const discovery = await discoverMcpTools({
      id: connection.id,
      url: validated.url,
      transport: connection.transport,
      headers: requestHeaders,
    });
    const identity = await discoverMcpConnectionIdentity({
      id: connection.id,
      url: validated.url,
      transport: connection.transport,
      headers: requestHeaders,
      ...(connection.presetId ? { presetId: connection.presetId } : {}),
    }).catch(() => undefined);
    await saveMcpSecrets(
      { agentId: agent.id, connectionId: connection.id },
      { ...(bearerToken ? { bearerToken } : {}), headers },
      dependencies.platformEnv,
      dependencies.settings,
    );
    try {
      await setMcpConnectionReady(dependencies.config, agent, connection, discovery.tools, identity);
    } catch (error) {
      await deleteMcpSecrets(
        { agentId: agent.id, connectionId: connection.id },
        connection.headerNames,
        dependencies.platformEnv,
        dependencies.settings,
      );
      throw error;
    }
    const accountLabel = identity?.accountName ?? identity?.workspaceName;
    return {
      connector: setup.target.targetLabel,
      ...(accountLabel ? { accountLabel } : {}),
    };
  }
  throw new Error(`wrong_action:${setup.action}:${at}`);
}

async function finishSetup(
  c: Context,
  setup: ManagementSetupRecord,
  result: {
    connector?: string;
    accountLabel?: string;
    connectionAccountId?: string;
    completedByUserId?: string;
    completedByMembershipId?: string;
    ownerKind?: 'member' | 'team';
    accessLane?: 'read' | 'write';
  },
  dependencies: SetupDependencies,
  options: ManagementSetupRoutesOptions,
  at: number,
): Promise<void> {
  const browserSessionDigest = digest(setupSession(c, setup.setupOperationId)!);
  const managedReceipt = setup.action === 'managed_connection' && setup.target.agentId
    ? await dependencies.config.getAgent(setup.target.agentId).then((agent) => {
        const avatarUrl = agentAvatarUrlForPresentation(agent, requestOrigin(c));
        return {
          receiptKind: 'connector_connected' as const,
          agentId: agent.id,
          agentName: agent.name,
          ownerKind: result.ownerKind ?? setup.target.ownerKind ?? 'member',
          accessLane: result.accessLane ?? setup.target.accessLane ?? 'read',
          toolkit: setup.target.provider,
          ...(avatarUrl ? { avatarUrl } : {}),
        };
      })
    : undefined;
  const initiator = managedReceipt
    ? setup.actorUserId
    : (await dependencies.identity.getUser(setup.actorUserId))?.displayName ?? setup.actorUserId;
  await completeManagementSetupReceipt(dependencies.management, {
    setup,
    browserSessionDigest,
    ...(result.completedByUserId
      ? { completedByUserId: result.completedByUserId }
      : {}),
    ...(result.completedByMembershipId
      ? { completedByMembershipId: result.completedByMembershipId }
      : {}),
    ...(result.connectionAccountId
      ? { connectionAccountId: result.connectionAccountId }
      : {}),
    ...(result.connector ? { connector: result.connector } : {}),
    ...(result.accountLabel ? { accountLabel: result.accountLabel } : {}),
    initiator,
    at,
    ...(managedReceipt ?? {}),
  });
  emitManagementMetric('setup.lifecycle', {
    action: setup.action,
    outcome: 'completed',
  });
  const presentationState = slackPresentationStatePort(
    getSlackStateStore(dependencies.platformEnv),
  );
  const presentation = presentationState
    ? {
        state: presentationState,
        resolveClient: async (workspaceId: string) =>
          (await resolveSlackInstallationExecutionContext(
            workspaceId,
            dependencies.platformEnv,
          )).client,
      }
    : undefined;
  await drainManagementReceiptOutbox({
    management: dependencies.management,
    onTerminalFailure: (record) => failAgentWelcomeDelivery(record, presentation),
    deliver: (record) => (options.deliverReceipt ?? deliverManagementReceiptToSlack)(record, {
      identity: dependencies.identity,
      ...(dependencies.platformEnv ? { env: dependencies.platformEnv } : {}),
      onDelivered: (deliveredRecord, delivery) => completeAgentWelcomeDelivery(
        deliveredRecord,
        delivery,
        dependencies.config,
        presentation,
      ),
    }),
    now: () => at,
  }).catch(() => undefined);
}

async function verifyMcpConnection(
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
  ref: { agentId: string; connectionId: string },
  oauth: boolean,
): Promise<{ connector: string; accountLabel?: string }> {
  const { agent, connection } = await currentMcpConnection(setup, dependencies.config);
  const validated = validateMcpUrl(connection.url);
  if (!validated.ok) throw new Error('blocked_url');
  const bearer = oauth
    ? await resolveMcpOAuthAccessToken(
        { ref, serverUrl: validated.url },
        mcpOAuthDependencies(dependencies),
      )
    : undefined;
  const headers = buildMcpRequestHeaders(connection.authMode, {
    ...(bearer ? { bearer } : {}),
    headers: {},
  });
  const discovery = await discoverMcpTools({
    id: connection.id,
    url: validated.url,
    transport: connection.transport,
    headers,
  });
  const identity = await discoverMcpConnectionIdentity({
    id: connection.id,
    url: validated.url,
    transport: connection.transport,
    headers,
    ...(connection.presetId ? { presetId: connection.presetId } : {}),
  }).catch(() => undefined);
  await setMcpConnectionReady(dependencies.config, agent, connection, discovery.tools, identity);
  return {
    connector: setup.target.targetLabel,
    ...(identity?.accountName || identity?.workspaceName
      ? { accountLabel: identity.accountName ?? identity.workspaceName }
      : {}),
  };
}

async function assertExactTarget(
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
): Promise<void> {
  if (setup.target.kind === 'provider_credential') {
    const providerId = setup.target.provider as ProviderKeyId;
    const source = (await describeProviderKeySources(
      dependencies.platformEnv,
      dependencies.settings,
    ))[providerId];
    const revision = (await storedCredentialMetadata(providerId, dependencies.settings))?.version ?? 0;
    if (source === 'env' || revision !== setup.target.expectedRevision ||
        (setup.target.replacement ? source !== 'stored' : source !== 'missing')) {
      throw new Error('target_changed');
    }
    return;
  }
  if (!setup.target.agentId) throw new Error('target_changed');
  const agent = await dependencies.config.getAgent(setup.target.agentId);
  if (agent.revision !== setup.target.expectedRevision) throw new Error('target_changed');
  if (setup.target.kind === 'api_connection') {
    const connection = agent.apiConnections.find(({ id }) => id === setup.target.connectionId);
    if (!connection || connection.displayName !== setup.target.targetLabel) throw new Error('target_changed');
  } else if (setup.target.kind === 'mcp_connection') {
    const connection = agent.mcpServers.find(({ id }) => id === setup.target.connectionId);
    if (!connection || connection.displayName !== setup.target.targetLabel) throw new Error('target_changed');
  } else {
    const repository = agent.repositories.find(({ id }) => id === setup.target.repositoryId);
    if (!repository || repository.fullName !== setup.target.targetLabel) throw new Error('target_changed');
  }
}

async function currentMcpConnection(
  setup: ManagementSetupRecord,
  config: ConfigStore,
): Promise<{ agent: CustomAgentConfig; connection: McpConnectionConfig }> {
  const agent = await config.getAgent(setup.target.agentId!);
  const connection = agent.mcpServers.find(({ id }) => id === setup.target.connectionId);
  if (!connection) throw new Error('target_changed');
  return { agent, connection };
}

async function setApiConnectionReady(
  config: ConfigStore,
  agent: CustomAgentConfig,
  connectionId: string,
  accountName?: string,
): Promise<void> {
  const index = agent.apiConnections.findIndex(({ id }) => id === connectionId);
  if (index < 0) throw new Error('target_changed');
  const connection = agent.apiConnections[index]!;
  if (connection.authMode === 'oauth' && !isValidApiOAuthConnectionPolicy(connection)) {
    throw new Error('target_changed');
  }
  const apiConnections = agent.apiConnections.slice();
  apiConnections[index] = {
    ...connection,
    lifecycleStatus: 'ready',
    statusText: 'Connected',
    ...(accountName ? { identity: { accountName } } : {}),
  };
  await config.updateAgent(agent.id, { apiConnections }, agent.revision);
}

async function setMcpConnectionReady(
  config: ConfigStore,
  agent: CustomAgentConfig,
  original: McpConnectionConfig,
  discoveredTools: McpConnectionConfig['discoveredTools'],
  identity?: McpConnectionConfig['identity'],
): Promise<void> {
  const index = agent.mcpServers.findIndex(({ id, url }) => id === original.id && url === original.url);
  if (index < 0) throw new Error('target_changed');
  const current = agent.mcpServers[index]!;
  const previouslyAllowed = new Set(current.allowedTools);
  const allowedTools = current.discoveredTools.length === 0
    ? discoveredTools.map(({ name }) => name)
    : discoveredTools.map(({ name }) => name).filter((name) => previouslyAllowed.has(name));
  const mcpServers = agent.mcpServers.slice();
  mcpServers[index] = {
    ...current,
    lifecycleStatus: 'ready',
    statusText: `Connected · ${discoveredTools.length} tool${discoveredTools.length === 1 ? '' : 's'}`,
    discoveredTools,
    allowedTools,
    lastCheckedAt: Date.now(),
    ...(identity ? { identity } : {}),
  };
  await config.updateAgent(agent.id, { mcpServers }, agent.revision);
}

async function beginRepositorySetup(
  c: Context,
  setup: ManagementSetupRecord,
  fields: Record<string, string>,
  dependencies: SetupDependencies,
): Promise<Response> {
  const github = await getGithubConnection(dependencies.settings);
  if (github.mode === 'app') {
    return c.redirect(
      `/setup/${encodeURIComponent(setup.setupOperationId)}/repository/finish`,
      303,
    );
  }
  const org = fields.organization?.trim() ?? '';
  if (org && !GITHUB_OWNER_PATTERN.test(org)) throw new Error('invalid_organization');
  const state = randomCapability();
  await dependencies.settings.setSetting(githubSetupStateKey(setup.setupOperationId), digest(state));
  const suffix = randomUUID().replaceAll('-', '').slice(0, 6).toLowerCase();
  const origin = requestOrigin(c);
  const base = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
  const manifest = {
    name: `chickpea-${suffix}`,
    url: origin,
    redirect_url: `${origin}/setup/${encodeURIComponent(setup.setupOperationId)}/github/callback`,
    setup_url: `${origin}/setup/${encodeURIComponent(setup.setupOperationId)}/repository/finish`,
    public: false,
    default_permissions: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      metadata: 'read',
      actions: 'write',
    },
  };
  return c.html(renderGithubManifestPost(`${base}?state=${state}`, manifest));
}

function apiOAuthDependencies(dependencies: SetupDependencies): ApiOAuthDependencies {
  return {
    settings: dependencies.settings,
    validateConnection: async (ref, provider) => {
      try {
        const agent = await dependencies.config.getAgent(ref.agentId);
        const connection = agent.apiConnections.find(({ id }) => id === ref.connectionId);
        return !!connection && connection.authMode === 'oauth' &&
          connection.oauthProvider === provider && isValidApiOAuthConnectionPolicy(connection);
      } catch {
        return false;
      }
    },
  };
}

function mcpOAuthDependencies(dependencies: SetupDependencies): McpOAuthDependencies {
  return {
    settings: dependencies.settings,
    validateConnection: async (ref, serverUrl) => {
      try {
        const agent = await dependencies.config.getAgent(ref.agentId);
        const connection = agent.mcpServers.find(({ id }) => id === ref.connectionId);
        return !!connection && connection.authMode === 'oauth' && connection.url === serverUrl;
      } catch {
        return false;
      }
    },
  };
}

async function requireBrowserSetup(
  c: Context,
  management: ManagementStore,
  setupId: string,
  principal: AuthPrincipal,
  at: number,
): Promise<ManagementSetupRecord | undefined> {
  const session = setupSession(c, setupId);
  if (!session) return undefined;
  const setup = await management.getSetup(setupId, at);
  if (!setup) return undefined;
  if (setup.action === 'managed_connection') {
    const sessionAuthorized = setup.status === 'completed'
      ? CAPABILITY_PATTERN.test(session)
      : managedSetupSessionMatches(setup, session);
    return !principal.machine && principal.organizationId === setup.organizationId &&
        sessionAuthorized
      ? setup
      : undefined;
  }
  return principalMatchesSetup(principal, setup) && sessionMatches(setup, session)
    ? setup
    : undefined;
}

async function markSetupFailure(
  setup: ManagementSetupRecord,
  c: Context,
  management: ManagementStore,
  code: string,
  at: number,
): Promise<void> {
  const session = setupSession(c, setup.setupOperationId);
  if (!session) return;
  if (setup.action === 'managed_connection') {
    emitManagementMetric('setup.lifecycle', {
      action: setup.action,
      outcome: 'failed',
      reason: code,
    });
    return;
  }
  await management.failSetup(
    setup.setupOperationId,
    digest(session),
    code,
    at,
  ).catch(() => undefined);
  emitManagementMetric('setup.lifecycle', {
    action: setup.action,
    outcome: 'failed',
    reason: code,
  });
}

function renderClaimPage(setupId: string, reusable = false): string {
  const exchangePath = `/setup/${encodeURIComponent(setupId)}/exchange`;
  const storageKey = `chickpea.management-setup.${setupId}`;
  const signInPath = `/auth/slack/sign-in?destination=${encodeURIComponent(`/setup/${setupId}`)}`;
  return pageShell('Secure Chickpea setup', `
    <main><h1>Secure Chickpea setup</h1>
    <p id="status">Checking this ${reusable ? 'secure' : 'one-use'} setup link…</p></main>
    <script nonce="setup">(function(){"use strict";
      var token="";
      try{var f=new URLSearchParams(location.hash.slice(1));token=f.get("setup")||"";
      if(/^[A-Za-z0-9_-]{43}$/.test(token))sessionStorage.setItem(${JSON.stringify(storageKey)},token);
      if(location.hash)history.replaceState(null,"",location.pathname+location.search);
      if(!token)token=sessionStorage.getItem(${JSON.stringify(storageKey)})||"";}catch(_){}
      if(!/^[A-Za-z0-9_-]{43}$/.test(token)){document.getElementById("status").textContent="This setup link is unavailable. Ask the person who created it for a new link.";return;}
      fetch(${JSON.stringify(exchangePath)},{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify({capability:token})})
      .then(function(r){if(r.status===401){location.replace(${JSON.stringify(signInPath)});return null;}token="";if(!r.ok)throw new Error();return r.json();})
      .then(function(result){if(!result)return;try{sessionStorage.removeItem(${JSON.stringify(storageKey)});}catch(_){}location.replace(location.pathname);})
      .catch(function(){token="";document.getElementById("status").textContent="This setup link is unavailable. Ask the person who created it for a new link.";});
    })();</script>`);
}

async function renderSetupSummary(
  setup: ManagementSetupRecord,
  failureCode?: string,
): Promise<string> {
  const action = setup.action === 'api_oauth' || setup.action === 'mcp_oauth' ||
      setup.action === 'repository_access'
    ? 'authorize'
    : 'complete';
  const fields = setup.action === 'repository_access'
    ? '<label>GitHub organization (optional)<input name="organization" autocomplete="organization"></label>'
    : (setup.target.formFields ?? []).map((field) => setupField(field)).join('');
  return pageShell(`Connect ${setup.target.targetLabel}`, `
    <main><p class="eyebrow">Chickpea delegated setup</p>
    <h1>Connect ${escapeHtml(setup.target.targetLabel)}</h1>
    <dl><div><dt>Provider</dt><dd>${escapeHtml(setup.target.provider)}</dd></div>
    <div><dt>Target</dt><dd>${escapeHtml(setup.target.agentName ?? setup.target.targetLabel)}</dd></div>
    <div><dt>Requested access</dt><dd>${escapeHtml(setup.scopes.join(', ') || 'Provider default')}</dd></div></dl>
    ${setup.target.replacement ? '<p class="warning">This will replace the currently connected credential.</p>' : ''}
    ${failureCode || setup.status === 'failed' ? '<p class="error">Setup did not complete. Secret fields were cleared; follow the steps and try again.</p>' : ''}
    <form method="post" action="/setup/${encodeURIComponent(setup.setupOperationId)}/${action}" autocomplete="off">
      ${fields}<button type="submit">Continue</button>
    </form></main>`);
}

function terminalPage(c: Context, setup: ManagementSetupRecord): Response {
  if (setup.action === 'managed_connection') {
    return managedUnavailablePage(c);
  }
  if (setup.status === 'completed') {
    return c.html(pageShell('Setup complete', '<main><h1>Connected</h1><p>This setup is complete. You can close this window.</p></main>'));
  }
  return unavailablePage(c);
}

function managedUnavailablePage(c: Context): Response {
  return c.html(renderManagedConnectionUnavailablePage(), 410);
}

function unavailablePage(c: Context): Response {
  return c.html(pageShell('Setup unavailable', '<main><h1>Setup link unavailable</h1><p>Ask the person who created this link to issue a new one.</p></main>'), 410);
}

async function formFailure(
  c: Context,
  setup: ManagementSetupRecord,
  code: string,
): Promise<Response> {
  return c.html(await renderSetupSummary(setup, code), 422);
}

function pageShell(title: string, content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 ui-sans-serif,system-ui;background:#f7f7f4;color:#172018;margin:0}main{max-width:680px;margin:10vh auto;padding:32px;background:#fff;border:1px solid #dfe4dc;border-radius:18px}h1{line-height:1.15}dl{display:grid;gap:12px}dl div{display:grid;grid-template-columns:140px 1fr;gap:12px}dt{color:#677064}dd{margin:0}form{display:grid;gap:16px;margin-top:28px}label{display:grid;gap:6px}input{font:inherit;padding:12px;border:1px solid #bbc5b8;border-radius:9px}button{font:inherit;padding:12px 18px;border:0;border-radius:9px;background:#315d3c;color:#fff;justify-self:start}.eyebrow{color:#50705a;font-size:13px;text-transform:uppercase;letter-spacing:.08em}.warning,.error{padding:12px;border-radius:9px;background:#fff4df}.error{background:#ffefec}</style></head><body>${content}</body></html>`;
}

function renderGithubManifestPost(target: string, manifest: unknown): string {
  return pageShell('Continue to GitHub', `<main><h1>Continue to GitHub</h1><p>GitHub will ask which account and repositories Chickpea may use.</p><form method="post" action="${escapeHtml(target)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button type="submit">Open GitHub</button></form></main>`);
}

function setupField(field: string): string {
  const name = field.startsWith('header:') ? field : field;
  const label = field === 'apiKey' ? 'API key'
    : field === 'clientId' ? 'OAuth client ID'
      : field === 'clientSecret' ? 'OAuth client secret'
        : field === 'credential' ? 'Credential'
          : field === 'bearerToken' ? 'Bearer token'
            : field === 'botToken' ? 'Slack bot token'
              : field === 'signingSecret' ? 'Slack signing secret'
            : field.slice('header:'.length);
  const type = field === 'clientId' ? 'text' : 'password';
  return `<label>${escapeHtml(label)}<input type="${type}" name="${escapeHtml(name)}" required autocomplete="off"></label>`;
}

function setupResponseHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store, max-age=0');
  c.header('Pragma', 'no-cache');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-setup'; connect-src 'self'; img-src 'self' data:; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'");
}

function sameOriginMutation(c: Context): boolean {
  const origin = c.req.header('origin');
  return !!origin && origin === requestOrigin(c);
}

function sameOriginFormMutation(c: Context): boolean {
  return validateBrowserMutationProvenance(c.req.raw, {
    canonicalOrigin: requestOrigin(c),
    maxBodyBytes: MAX_FORM_BYTES,
    requireJson: false,
    allowOpaqueOriginFormNavigation: true,
  }).ok;
}

function requestOrigin(c: Context): string {
  const pinned = process.env.SLACK_TAG_PUBLIC_URL?.trim();
  if (pinned) return new URL(pinned).origin;
  return new URL(c.req.url).origin;
}

function setupIdFromContext(c: Context): string | undefined {
  const value = c.req.param('setupOperationId');
  return value && SETUP_ID_PATTERN.test(value) ? value : undefined;
}

function setupSession(c: Context, setupId: string): string | undefined {
  const cookie = c.req.header('cookie') ?? '';
  const encodedName = `${SESSION_COOKIE}-${cookieSuffix(setupId)}`;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === encodedName) {
      const value = rest.join('=');
      return CAPABILITY_PATTERN.test(value) ? value : undefined;
    }
  }
  return undefined;
}

function setupCookie(setupId: string, value: string, maxAge: number): string {
  return `${SESSION_COOKIE}-${cookieSuffix(setupId)}=${value}; Path=/setup/${encodeURIComponent(setupId)}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearSetupCookie(c: Context, setupId: string): void {
  c.header('Set-Cookie', setupCookie(setupId, '', 0));
}

function cookieSuffix(setupId: string): string {
  return createHash('sha256').update(setupId).digest('hex').slice(0, 16);
}

function sessionMatches(setup: ManagementSetupRecord, session: string): boolean {
  return !!setup.browserSessionDigest && setup.browserSessionDigest === digest(session);
}

function managedSetupSessionMatches(setup: ManagementSetupRecord, session: string): boolean {
  return !!setup.tokenDigest && setup.tokenDigest === digest(session);
}

async function readJsonBody(c: Context): Promise<unknown> {
  if (!withinBodyLimit(c)) return undefined;
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return undefined;
  return c.req.json().catch(() => undefined);
}

async function readFormFields(c: Context): Promise<Record<string, string> | undefined> {
  if (!withinBodyLimit(c)) return undefined;
  if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return undefined;
  const params = new URLSearchParams(await c.req.text());
  const result: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key.length > 160 || value.length > 16_384 || key in result) return undefined;
    result[key] = value;
  }
  return result;
}

function withinBodyLimit(c: Context): boolean {
  const raw = c.req.header('content-length');
  if (!raw) return true;
  const length = Number(raw);
  return Number.isSafeInteger(length) && length >= 0 && length <= MAX_FORM_BYTES;
}

function requiredField(fields: Record<string, string>, name: string, max: number): string {
  const value = fields[name]?.trim() ?? '';
  if (!value || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('invalid_form');
  }
  return value;
}

function setupConnectionRef(setup: ManagementSetupRecord): { agentId: string; connectionId: string } {
  if (!setup.target.agentId || !setup.target.connectionId) throw new Error('target_changed');
  return { agentId: setup.target.agentId, connectionId: setup.target.connectionId };
}

function providerDisplayName(id: ProviderKeyId): string {
  if (id === 'openai') return 'OpenAI';
  if (id === 'openrouter') return 'OpenRouter';
  return 'Anthropic';
}

function githubSetupStateKey(setupId: string): string {
  return `management.${setupId}.github-state`;
}

function randomCapability(): string {
  return randomBytes(32).toString('base64url');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

function managedBrowserSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeFailureCode(error: unknown): string {
  if (error instanceof ManagementError) return error.code;
  if (error instanceof ManagedConnectionProviderUnavailableError) {
    return 'managed_provider_unavailable';
  }
  const message = error instanceof Error ? error.message : '';
  if (/target|revision|connection_missing/i.test(message)) return 'target_changed';
  if (/provider|key|credential|validation|invalid_form/i.test(message)) return 'validation_failed';
  if (/state/i.test(message)) return 'invalid_state';
  return 'setup_failed';
}

function genericDenied(c: Context): Response {
  return c.json({ error: 'setup_unavailable' }, 403);
}

function authenticationRequired(c: Context): Response {
  return c.json({ error: 'authentication_required' }, 401);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}
