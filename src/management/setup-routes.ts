import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { Hono, type Context } from 'hono';

import { escapeHtml } from '../security/html-escape.ts';
import { isRecord } from '../security/content-validation.ts';
import { sha256HexNode } from '../security/digest.ts';
import { BetterAuthDirectory, BetterAuthSessionAuthenticator } from '../auth/better-auth-principal.ts';
import { hostedLoginFence } from '../auth/hosted-login.ts';
import { resolveBetterAuthEnvironment } from '../auth/better-auth-environment.ts';
import { setCookieValues } from '../auth/cookies.ts';
import {
  AuthorizationError,
  canManageOwnedResource,
  requireAgentEdit,
  requirePermission,
} from '../auth/permissions.ts';
import { validateBrowserMutationProvenance } from '../auth/request-provenance.ts';
import { AuthService } from '../auth/service.ts';
import type { AuthPrincipal } from '../auth/types.ts';
import { actualBodyLimit } from '../security/request-body-limit.ts';
import { AgentConnectionCredentialConflictError, ManagedSignInGroupConflictError } from '../config/errors.ts';

import {
  ApiOAuthError,
  completeApiOAuthAuthorization,
  apiOAuthClientBindingMatches,
  connectionAccountIdFromOAuthRef,
  connectionAccountOAuthRef,
  replaceApiOAuthClient,
  startApiOAuthAuthorization,
  type ApiOAuthDependencies,
} from '../config/api-oauth.ts';
import { isValidApiOAuthConnectionPolicy } from '../config/api-oauth-policy.ts';
import {
  connectionAccountSecretSettingKey,
  saveConnectionAccountSecret,
  tombstoneConnectionAccountSecret,
} from '../config/connector-secrets.ts';
import {
  exchangeGithubAppManifest,
  getGithubConnection,
  getRepositoryInstallation,
  GITHUB_OWNER_PATTERN,
  GITHUB_SETTING_KEYS,
  normalizePrivateKeyPem,
} from '../config/github-app.ts';
import { buildMcpRequestHeaders } from '../config/mcp-secrets.ts';
import { resolveConnectionAccountMcpSecrets } from '../config/profile-mcp.ts';
import {
  cancelMcpOAuthAuthorization,
  completeMcpOAuthAuthorization,
  invalidateMcpOAuthAuthorization,
  McpOAuthError,
  mcpOAuthReturnRefFromState,
  readMcpOAuthSetupContinuation,
  resolveMcpOAuthAccessToken,
  startMcpOAuthAuthorization,
  type McpOAuthDependencies,
} from '../config/mcp-oauth.ts';
import {
  configuredMcpOAuthCallbackUrl,
  configuredMcpOAuthClientDescriptor,
  getConfiguredMcpOAuthClient,
  META_ADS_OAUTH_MANAGEMENT_SCOPE,
  resolveConfiguredMcpOAuthScope,
} from '../config/mcp-oauth-clients.ts';
import {
  allowedToolsAfterMcpDiscovery,
  isMcpToolReviewRequired,
} from '../config/mcp-access.ts';
import {
  compileMetaAdsToolAccess,
  isMetaAdsMcpConnection,
  metaAdsToolEffect,
  MetaAdsAccessPolicyError,
  normalizeMetaAdsAccountIds,
} from '../config/meta-ads-policy.ts';
import { BugsnagAccessPolicyError, compileBugsnagToolAccess, isBugsnagMcpConnection } from '../config/bugsnag-policy.ts';
import { deploymentServesManyInstallations } from '../config/installation-scope.ts';
import { sameMcpServerUrl, validateMcpUrl } from '../config/mcp-url.ts';
import type { OAuthAuthorizationAuthority } from '../config/oauth-authorization.ts';
import { discoverMcpConnectionIdentity } from '../config/mcp-identity.ts';
import { discoverMcpTools } from '../config/mcp-test.ts';
import {
  resolveConnectorCatalogPreset,
  type ConnectorPreset,
} from '../config/presets.ts';
import { saveOpenAiAuthMethod } from '../config/openai-auth.ts';
import {
  initializeWorkspaceImageDefaultBestEffort,
  OPENAI_API_IMAGE_DEFAULT_MODEL_ID,
} from '../config/initial-image-default.ts';
import { validateProviderApiKey } from '../config/provider-models.ts';
import {
  describeProviderKeySources,
  saveProviderApiKey,
  type ProviderKeyId,
} from '../config/provider-keys.ts';
import { installationModelCredentialVersion } from '../config/model-credential-refs.ts';
import {
  getConfigStore,
  getIdentityStore,
  getManagementStore,
  getSettingsStore,
  getSlackStateStore,
  getUsageStore,
  getWorkStore,
  type PlatformEnv,
} from '../config/state-backend.ts';
import type { ConfigStore } from '../config/store.ts';
import type { SettingsStore } from '../config/settings-store.ts';
import {
  type AgentConnectionBinding,
  type ConnectionAccount,
  type ConnectionAccountPolicy,
  type CustomAgentConfig,
  type McpConnectionConfig,
} from '../config/types.ts';
import type { IdentityStore } from '../identity/types.ts';
import type { UsageStore } from '../usage/types.ts';
import { MANAGED_CONNECTOR_CATALOG, type ManagedConnectorCatalog } from '../connections/catalog/index.ts';
import {
  checkConnection,
  connectionUrlPrefixes,
  type ApiConnectionCheck,
  type ApiConnectionScope,
  type ConnectionCheckOptions,
} from '../connections/connection-check.ts';
import {
  ManagedConnectionLaneExistsError,
  cancelManagedAuthorizationFlow,
  pollManagedAuthorizationFlow,
  startManagedAuthorizationFlow,
  type ManagedAuthorizationFlowDependencies,
} from '../connections/managed-authorization-flow.ts';
import { ManagedAuthorizationError } from '../connections/managed-authorization.ts';
import { ManagedSignInOtherKindError } from '../connections/sign-in-mix.ts';
import { mcpOAuthLifecycleDependencies } from '../connections/mcp-oauth-lifecycle.ts';
import { ManagedProviderRequestError } from '../connections/managed-errors.ts';
import {
  managedProviderAvailability,
  type ManagedConnectionProviderRegistry,
} from '../connections/managed.ts';
import { resolveManagedAuthorizationProviderContext } from '../connections/managed-provider-context.ts';
import { projectEffectiveMcpConnections } from '../connections/runtime.ts';
import {
  ConnectionAccountService,
  ManagedConnectionConflictError,
  ManagedConnectionProviderUnavailableError,
  ManagedResourceSelectionError,
  markCancelledMcpOAuthAccount,
  markConnectionAccountNeedsAttention,
} from '../connections/store.ts';
import { signInGroupKey } from '../config/sign-in-group.ts';
import {
  agentAvatarInstallation,
  agentAvatarUrl,
  agentAvatarUrlForPresentation,
} from '../slack/agent-presence/avatar-assets.ts';
import { resolveSlackInstallationExecutionContext } from '../slack/installation-execution.ts';
import { slackPresentationStatePort } from '../slack/presentation-state-port.ts';
import {
  agentConnections,
  connectionSetupBinding,
  mcpCredentialField,
  type AgentConnectionEntry,
} from './agent-connections.ts';
import {
  completeAgentWelcomeDelivery,
  completeSettledAgentWelcomeHandoff,
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
import type { ProductTelemetryCapture } from '../telemetry/client.ts';
import {
  type ConnectorLandingPageInput,
  renderManagedConnectionDeparturePage,
  renderCatalogConnectionAccessReviewPage,
  renderCatalogConnectionSetupPage,
  renderManagedConnectionSetupPage,
  renderManagedConnectionSuccessPage,
  renderManagedConnectionUnavailablePage,
  renderManagedConnectionWaitingPage,
  renderSetupClaimPage,
  renderSetupPanelPage,
} from './connector-landing-page.ts';

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SETUP_ID_PATTERN = /^setup_[A-Za-z0-9_-]{1,128}$/;
const MAX_FORM_BYTES = 16 * 1024;
const SESSION_COOKIE = '__Secure-chickpea-setup';

interface ManagementSetupRoutesOptions {
  management?: ManagementStore;
  config?: ConfigStore;
  settings?: SettingsStore;
  identity?: Pick<
    IdentityStore,
    'getUser' | 'listExternalIdentities' | 'getOrganization' | 'getAuthControl' | 'getMembership' |
      'getMembershipAccessOverlay'
  >;
  usage?: UsageStore;
  platformEnv?: PlatformEnv;
  productTelemetry?: ((c: Context) => ProductTelemetryCapture) | undefined;
  now?: () => number;
  randomCapability?: () => string;
  validateProviderKey?: typeof validateProviderApiKey;
  deliverReceipt?: typeof deliverManagementReceiptToSlack;
  managedConnectionProviders?: ManagedConnectionProviderRegistry;
  managedConnectorCatalog?: ManagedConnectorCatalog;
  /** Test seams for native connector setup without live provider traffic. */
  startMcpOAuth?: typeof startMcpOAuthAuthorization;
  completeMcpOAuth?: typeof completeMcpOAuthAuthorization;
  resolveMcpOAuthToken?: typeof resolveMcpOAuthAccessToken;
  discoverMcp?: typeof discoverMcpTools;
  identifyMcp?: typeof discoverMcpConnectionIdentity;
  /** Test seam; production checks a key on the running target with the default timeout. */
  connectionCheck?: ConnectionCheckOptions;
  /** Test seam; production resolves the current Better Auth browser session. */
  authenticatePrincipal?: (request: Request) => Promise<AuthPrincipal | undefined>;
}

export function createManagementSetupRoutes(
  options: ManagementSetupRoutesOptions = {},
): Hono {
  const app = new Hono();
  const now = options.now ?? Date.now;

  // Configured public clients use the one callback registered for the
  // installation. This router is mounted before Admin, so inspect the stored
  // state without consuming it and handle only management continuations.
  app.get('/oauth/callback', async (c, next) => {
    const state = c.req.query('state');
    if (!state || state.length > 2_048) return next();
    const dependencies = setupDependencies(c, options);
    let setupId: string | undefined;
    try {
      setupId = await readMcpOAuthSetupContinuation(state, {
        settings: dependencies.settings,
        now,
      });
    } catch {
      return next();
    }
    if (!setupId || !SETUP_ID_PATTERN.test(setupId)) return next();
    setupResponseHeaders(c);
    return completeManagementMcpOAuthCallback(c, setupId, options, now());
  });

  app.use('/setup/*', async (c, next) => {
    setupResponseHeaders(c);
    await next();
  });
  app.use('/setup/*', actualBodyLimit({
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
        return c.html(renderSetupClaimPage({ setupId, reusable: true }));
      }
      if (setup.status !== 'pending') return managedUnavailablePage(c);
      // The waiting page offers nothing to reuse, so it skips the page listings.
      const polling = c.req.query('poll') === '1';
      const page = await managedConnectionPageInput(c, setup, dependencies, options, polling ? undefined : principal);
      if (!page) return managedUnavailablePage(c);
      return c.html(polling
        ? renderManagedConnectionWaitingPage(page)
        : renderManagedConnectionSetupPage(page));
    }

    if (setup?.action === 'catalog_connection') {
      const authorized = await principalCanEditCatalogSetup(
        principal,
        setup,
        dependencies.config,
      );
      if (setup.status === 'completed') {
        if (!authorized) return unavailablePage(c);
        const page = await catalogConnectionPageInput(c, setup, dependencies);
        return page ? c.html(renderManagedConnectionSuccessPage(page)) : unavailablePage(c);
      }
      if (principal && !authorized) return unavailablePage(c);
      const browserMatches = Boolean(
        principal && session && sessionMatches(setup, session),
      );
      if (!principal || !session || !browserMatches) {
        return c.html(renderSetupClaimPage({ setupId, reusable: false }));
      }
      if (!['claimed', 'failed', 'authorizing'].includes(setup.status)) {
        return terminalPage(c, setup);
      }
      const page = await catalogConnectionPageInput(c, setup, dependencies, principal);
      return page
        ? c.html(page.accessReview
            ? renderCatalogConnectionAccessReviewPage(page)
            : renderCatalogConnectionSetupPage({
                ...page,
                ...(setup.status === 'failed'
                  ? { failureMessage: 'Connection setup did not complete. Try again.' }
                  : {}),
              }))
        : unavailablePage(c);
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
      return c.html(renderSetupClaimPage({ setupId, reusable: false }));
    }
    if (!['claimed', 'failed', 'authorizing'].includes(setup.status)) {
      return terminalPage(c, setup);
    }
    return c.html(await renderSetupSummary(setup, { destination: await setupDestination(setup, dependencies) }));
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
        if (setup.action === 'catalog_connection') {
          if (principal.organizationId !== setup.organizationId) {
            throw new AuthorizationError();
          }
          requireAgentEdit(principal, await currentCatalogAgent(setup, dependencies.config));
        } else {
          if (!principalMatchesSetup(principal, setup)) return genericDenied(c);
          await requireCurrentLegacySetupAuthority(principal, setup, dependencies);
        }
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
    if (!fields) return formFailure(c, setup, dependencies);
    try {
      if (setup.action === 'catalog_connection') {
        if (principal.organizationId !== setup.organizationId) throw new AuthorizationError();
        requireAgentEdit(principal, await currentCatalogAgent(setup, dependencies.config));
      } else if (isLegacySetupAction(setup.action)) {
        await requireCurrentLegacySetupAuthority(principal, setup, dependencies);
      }
      await dependencies.management.authorizeSetup({
        setupOperationId: setupId,
        browserSessionDigest: digest(setupSession(c, setupId)!),
        at: now(),
      });
      const result = await completeFormAction(setup, fields, dependencies, options, now());
      await finishSetup(c, setup, result, dependencies, options, now());
      clearSetupCookie(c, setupId);
      const check = result.check && result.check !== 'ok' ? `?check=${result.check}` : '';
      return c.redirect(`/setup/${encodeURIComponent(setupId)}${check}`, 303);
    } catch (error) {
      if (error instanceof AuthorizationError) return genericDenied(c);
      await markSetupFailure(setup, c, dependencies.management, safeFailureCode(error), now());
      return formFailure(
        c, setup, dependencies, error instanceof SetupKeyRejectedError ? error.message : undefined,
      );
    }
  });

  app.post('/setup/:setupOperationId/mcp/access', async (c) => {
    const dependencies = setupDependencies(c, options);
    const setupId = setupIdFromContext(c);
    if (!setupId || !sameOriginFormMutation(c)) return genericDenied(c);
    const principal = await authenticateSetupPrincipal(c, options);
    if (!principal) return authenticationRequired(c);
    const setup = await requireBrowserSetup(
      c, dependencies.management, setupId, principal, now(),
    );
    if (!setup || setup.action !== 'catalog_connection' || setup.status !== 'authorizing') {
      return genericDenied(c);
    }
    const fields = await readFormFields(c);
    if (!fields) return genericDenied(c);
    try {
      requireAgentEdit(principal, await currentCatalogAgent(setup, dependencies.config));
      const { account, binding } = await currentCatalogReviewAccount(
        setup, principal, dependencies.config,
      );
      if (account.policy.kind !== 'mcp') throw new AuthorizationError();
      const metaAds = isMetaAdsMcpConnection(account.policy);
      const discovered = new Set(account.policy.kind === 'mcp'
        ? account.policy.discoveredTools.map(({ name }) => name)
        : []);
      const requestedTools = Object.entries(fields)
        .filter(([key, value]) => key.startsWith('tool:') && value === 'on')
        .map(([key]) => key.slice('tool:'.length));
      if (requestedTools.length === 0 || requestedTools.some((tool) => !discovered.has(tool))) {
        throw metaAds
          ? new MetaAdsAccessPolicyError('Choose at least one tool that can be limited to the approved ad accounts.')
          : new BugsnagAccessPolicyError('Choose at least one available tool.');
      }
      if (metaAds && (account.policy.authMode !== 'oauth' ||
          account.policy.oauthScope !== META_ADS_OAUTH_MANAGEMENT_SCOPE) &&
          requestedTools.some((tool) => metaAdsToolEffect(tool) === 'write')) {
        throw new MetaAdsAccessPolicyError(
          'Reconnect with Reporting and editing access before selecting tools that may change ads.',
        );
      }
      const approvedAccountIds = metaAds ? normalizeMetaAdsAccountIds(
        (fields.adAccountIds ?? '')
          .split(/[\s,]+/)
          .map((value) => value.trim())
          .filter(Boolean),
      ) : [];
      const compiled = metaAds ? compileMetaAdsToolAccess({
        discoveredTools: account.policy.kind === 'mcp' ? account.policy.discoveredTools : [],
        requestedTools,
        approvedAccountIds,
      }) : compileBugsnagToolAccess({ discoveredTools: account.policy.discoveredTools, requestedTools });
      const updated = await dependencies.config.putConnectionAccount({
        ...account,
        policy: {
          ...account.policy,
          allowedTools: compiled.allowedTools,
          toolPolicies: compiled.toolPolicies,
        },
      }, account.revision);
      dependencies.productTelemetry?.capture({
        event: 'connection_ready',
        workspaceId: updated.workspaceId,
        agentId: binding.agentId,
        connectionKind: 'mcp',
        ownerKind: updated.ownerKind,
        surface: 'slack',
      });
      await finishSetup(c, setup, catalogSetupResult(updated, principal, setup),
        dependencies, options, now());
      clearSetupCookie(c, setupId);
      return c.redirect(`/setup/${encodeURIComponent(setupId)}`, 303);
    } catch (error) {
      if (error instanceof AuthorizationError) return genericDenied(c);
      const page = await catalogConnectionPageInput(
        c, setup, dependencies, principal,
        error instanceof MetaAdsAccessPolicyError || error instanceof BugsnagAccessPolicyError
          ? error.message
          : 'Tool access could not be saved. Reload this page and try again.',
      );
      return page
        ? c.html(renderCatalogConnectionAccessReviewPage(page), 422)
        : genericDenied(c);
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
    if (!fields) return formFailure(c, setup, dependencies);

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
        if (setup.target.replacement && setup.target.connectionId) {
          // A reconnect keeps its account's owner and access, so the page locks both.
          const reconnecting = await reconnectAccount(setup, dependencies.config);
          if (!reconnecting || selection.ownerKind !== reconnecting.ownerKind ||
              selection.accessLane !== managedAccountAccessLane(
                reconnecting,
                setup.target.provider,
                dependencies.catalog,
              )) {
            throw new ManagedAuthorizationError('invalid');
          }
        }
        if (fields.reuseSignInId) {
          if (setup.target.replacement) throw new ManagedAuthorizationError('invalid');
          return await reuseSetupSignIn(c, setup, agent, principal, selection, fields, dependencies, options);
        }
        const browserSession = setupSession(c, setupId);
        if (!browserSession) throw new ManagedAuthorizationError('invalid');
        const browserSecret = sha256HexNode(browserSession);
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
            ...(setup.target.replacement && setup.target.connectionId
              ? { connectionAccountId: setup.target.connectionId }
              : {}),
            ...(fields.differentAccount === '1' ? { differentAccount: true } : {}),
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

      if (setup.action === 'catalog_connection') {
        requireAgentEdit(principal, await currentCatalogAgent(setup, dependencies.config));
        const requestedOwnerKind = fields.ownerKind?.trim();
        if (requestedOwnerKind === 'member' || requestedOwnerKind === 'team') {
          requireCatalogOwnerLanePermission(principal, requestedOwnerKind);
        }
      } else if (isLegacySetupAction(setup.action)) {
        try {
          await requireCurrentLegacySetupAuthority(principal, setup, dependencies);
          if (setup.action === 'repository_access') {
            const github = await getGithubConnection(dependencies.settings, dependencies.platformEnv);
            if (github.mode !== 'app') requirePermission(principal, 'admin.configure');
          }
        } catch {
          return genericDenied(c);
        }
      }
      activeSetup = await dependencies.management.authorizeSetup({
        setupOperationId: setupId,
        browserSessionDigest: digest(setupSession(c, setupId)!),
        at: now(),
      });
      await assertExactTarget(activeSetup, dependencies);
      if (activeSetup.action === 'catalog_connection') {
        const started = await beginCatalogConnectionSetup(
          c,
          activeSetup,
          fields,
          principal,
          dependencies,
          options,
        );
        if (started.authorizationUrl) {
          if (authorizationJsonRequest(c)) {
            return c.json({ authorizationUrl: started.authorizationUrl });
          }
          return c.redirect(started.authorizationUrl, 303);
        }
        await finishSetup(c, activeSetup, started.result, dependencies, options, now());
        clearSetupCookie(c, setupId);
        if (authorizationJsonRequest(c)) return c.json({ completed: true });
        return c.redirect(`/setup/${encodeURIComponent(setupId)}`, 303);
      }
      if (activeSetup.action === 'api_oauth') {
        const clientId = requiredField(fields, 'clientId', 512);
        const clientSecret = requiredField(fields, 'clientSecret', 2_048);
        const { account } = await currentSetupConnection(activeSetup, dependencies);
        if (account.lifecycle === 'ready') throw new Error('target_changed');
        const ref = connectionAccountOAuthRef(account.id);
        await replaceApiOAuthClient(
          ref,
          { provider: 'google', clientId, clientSecret },
          dependencies.settings,
        );
        const started = await startApiOAuthAuthorization({
          ref,
          provider: 'google',
          callbackUrl: `${requestOrigin(c)}/setup/${encodeURIComponent(setupId)}/oauth/api/callback`,
          scopes: activeSetup.scopes,
          accountRevision: account.revision,
        }, apiOAuthDependencies(dependencies));
        return c.redirect(started.authorizationUrl.href, 303);
      }
      if (activeSetup.action === 'mcp_oauth') {
        const { agent, account } = await currentSetupConnection(activeSetup, dependencies);
        if (account.policy.kind !== 'mcp' || account.policy.authMode !== 'oauth') {
          throw new Error('target_changed');
        }
        if (configuredMcpOAuthClientDescriptor(account.policy.url)) {
          await markSetupFailure(
            activeSetup,
            c,
            dependencies.management,
            'catalog_setup_required',
            now(),
          );
          return c.html(renderSetupPanelPage({
            title: 'Connect Meta Ads from Admin',
            surface: 'setup-meta-ads-admin',
            content: `<h1>Use the Meta Ads connector setup</h1>
            <p>Meta Ads needs an ad account and tool access review before this Agent can use it.</p>
            <p><a href="/admin/agents/${encodeURIComponent(agent.id)}">Return to ${escapeHtml(agent.name)} in Admin</a> and add Meta Ads from the connection catalog.</p>`,
          }), 422);
        }
        const oauthAttemptId = randomUUID();
        const { identity: _identity, ...withoutIdentity } = account;
        const pending = await dependencies.config.putConnectionAccount({
          ...withoutIdentity,
          lifecycle: 'pending',
          policy: { ...account.policy, oauthAttemptId },
        }, account.revision);
        const started = await (options.startMcpOAuth ?? startMcpOAuthAuthorization)({
          ref: connectionAccountOAuthRef(pending.id),
          serverUrl: account.policy.url,
          callbackUrl: `${requestOrigin(c)}/setup/${encodeURIComponent(setupId)}/oauth/mcp/callback`,
          ...(account.policy.oauthScope ? { scope: account.policy.oauthScope } : {}),
          returnAgentId: agent.id,
          accountRevision: pending.revision,
          oauthAttemptId,
          authorizationAuthority: {
            organizationId: principal.organizationId,
            workspaceId: pending.workspaceId,
            membershipId: principal.membershipId,
            agentId: agent.id,
            ownerKind: pending.ownerKind,
          },
        }, mcpOAuthDependencies(dependencies, true));
        return c.redirect(started.authorizationUrl.href, 303);
      }
      if (activeSetup.action === 'repository_access') {
        return beginRepositorySetup(c, activeSetup, fields, principal, dependencies);
      }
      throw new Error('wrong_action');
    } catch (error) {
      if (error instanceof AuthorizationError) return genericDenied(c);
      if (error instanceof ManagedSignInOtherKindError) {
        if (authorizationJsonRequest(c)) {
          return c.json({ error: 'managed_sign_in_other_kind', message: error.message }, 409);
        }
        const page = await managedConnectionPageInput(c, activeSetup, dependencies, options, principal);
        const signInNotice = {
          ownerKind: fields.ownerKind === 'team' ? 'team' as const : 'member' as const,
          message: error.message,
        };
        return page
          ? c.html(renderManagedConnectionSetupPage({ ...page, signInNotice }), 409)
          : managedUnavailablePage(c);
      }
      await markSetupFailure(activeSetup, c, dependencies.management, safeFailureCode(error), now());
      if (activeSetup.action === 'managed_connection') {
        const message = managedStartFailureMessage(error);
        if (authorizationJsonRequest(c)) {
          return c.json({ error: safeFailureCode(error), message }, 422);
        }
        const page = await managedConnectionPageInput(c, activeSetup, dependencies, options, principal);
        return page
          ? c.html(renderManagedConnectionSetupPage({ ...page, failureMessage: message }), 422)
          : managedUnavailablePage(c);
      }
      if (activeSetup.action === 'catalog_connection') {
        const message = error instanceof McpOAuthError &&
            error.code === 'oauth_configuration_required'
          ? 'Meta Ads must be configured in Chickpea Admin before you can sign in.'
          : 'Chickpea could not prepare this connection. Check the details and try again.';
        if (authorizationJsonRequest(c)) {
          return c.json({ error: safeFailureCode(error), message }, 422);
        }
        const page = await catalogConnectionPageInput(c, activeSetup, dependencies);
        return page
          ? c.html(renderCatalogConnectionSetupPage({ ...page, failureMessage: message }), 422)
          : unavailablePage(c);
      }
      return formFailure(c, activeSetup, dependencies);
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
            browserSecret: sha256HexNode(setupSession(c, setupId)!),
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
          browserSecret: sha256HexNode(setupSession(c, setupId)!),
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
      if (result.status === 'refused') {
        await markSetupFailure(setup, c, dependencies.management, 'managed_sign_in_mix_refused', now());
        return c.json({ error: 'managed_sign_in_mix_refused', message: result.message }, 409);
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
          browserSecret: sha256HexNode(setupSession(c, setupId)!),
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
    if (!setup || !principal || setup.action !== 'api_oauth' || !state || !code) {
      return genericDenied(c);
    }
    try {
      await requireCurrentLegacySetupAuthority(principal, setup, dependencies);
    } catch {
      return genericDenied(c);
    }
    try {
      await assertExactTarget(setup, dependencies);
      const completed = await completeApiOAuthAuthorization(
        { code, state },
        apiOAuthDependencies(dependencies),
      );
      if (!await apiOAuthClientBindingMatches(
        completed.ref,
        completed.clientBinding,
        dependencies.settings,
      )) throw new Error('target_changed');
      const entry = await currentSetupConnection(setup, dependencies);
      if (connectionAccountIdFromOAuthRef(completed.ref) !== entry.account.id ||
          completed.accountRevision !== entry.account.revision) {
        throw new Error('target_changed');
      }
      const accountName = completed.identity?.accountName;
      const ready = await markSetupAccountReady(
        setup,
        dependencies,
        entry,
        accountName ? { identity: { accountName } } : {},
      );
      if (!await apiOAuthClientBindingMatches(
        completed.ref,
        completed.clientBinding,
        dependencies.settings,
      )) {
        await markConnectionAccountNeedsAttention(dependencies.config, ready);
        throw new Error('target_changed');
      }
      await finishSetup(
        c,
        setup,
        {
          connector: setup.target.targetLabel,
          ...(accountName ? { accountLabel: accountName } : {}),
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
    const setupId = setupIdFromContext(c);
    return setupId
      ? completeManagementMcpOAuthCallback(c, setupId, options, now())
      : genericDenied(c);
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
    if (!setup || !principal || setup.action !== 'repository_access' || !code || !state) {
      return genericDenied(c);
    }
    // The host owns the platform GitHub App; no installation stores its own.
    if (deploymentServesManyInstallations(dependencies.platformEnv)) return genericDenied(c);
    try {
      await requireCurrentLegacySetupAuthority(principal, setup, dependencies);
      requirePermission(principal, 'admin.configure');
    } catch {
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
    if (!setup || !principal || setup.action !== 'repository_access') return genericDenied(c);
    try {
      await requireCurrentLegacySetupAuthority(principal, setup, dependencies);
    } catch {
      return genericDenied(c);
    }
    try {
      await assertExactTarget(setup, dependencies);
      const agent = await dependencies.config.getAgent(setup.target.agentId!);
      const repositoryIndex = agent.repositories.findIndex(({ id }) => id === setup.target.repositoryId);
      if (repositoryIndex < 0) throw new Error('target_changed');
      const repository = agent.repositories[repositoryIndex]!;
      const github = await getGithubConnection(dependencies.settings, dependencies.platformEnv);
      if (github.mode !== 'app') throw new Error('github_not_connected');
      // Serving many installations, only the installation's own binding for the repository's owner resolves.
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

async function completeManagementMcpOAuthCallback(
  c: Context,
  setupId: string,
  options: ManagementSetupRoutesOptions,
  at: number,
): Promise<Response> {
  const dependencies = setupDependencies(c, options);
  const principal = await authenticateSetupPrincipal(c, options);
  const setup = principal
    ? await requireBrowserSetup(c, dependencies.management, setupId, principal, at)
    : undefined;
  const state = c.req.query('state') ?? '';
  const code = c.req.query('code') ?? '';
  const providerError = c.req.query('error') ?? '';
  if (!setup || !principal || !['mcp_oauth', 'catalog_connection'].includes(setup.action) ||
      !state || state.length > 2_048 || code.length > 16_384 || providerError.length > 512 ||
      Boolean(code) === Boolean(providerError)) return genericDenied(c);
  if (setup.action === 'mcp_oauth') {
    try {
      await requireCurrentLegacySetupAuthority(principal, setup, dependencies);
    } catch {
      return genericDenied(c);
    }
  }
  let completedMcpOAuthRef: { agentId: string; connectionId: string } | undefined;
  try {
    if (setup.action === 'catalog_connection') {
      requireAgentEdit(principal, await currentCatalogAgent(setup, dependencies.config));
    }
    await requireSetupOAuthCallbackAuthority(setup, principal, state, dependencies);
    await assertExactTarget(setup, dependencies);
    if (providerError) {
      await cancelMcpOAuthAuthorization(state, mcpOAuthDependencies(dependencies, true));
      await markSetupFailure(setup, c, dependencies.management, 'authorization_cancelled', at);
      return c.redirect(`/setup/${encodeURIComponent(setupId)}?status=cancelled`, 303);
    }
    const completed = await (options.completeMcpOAuth ?? completeMcpOAuthAuthorization)(
      { code, state },
      mcpOAuthDependencies(dependencies, true),
    );
    completedMcpOAuthRef = completed.ref;
    const result = await verifyMcpConnection(
      setup,
      dependencies,
      completed.ref,
      principal,
      options,
      completed.accountRevision,
      completed.oauthAttemptId,
      completed.authorizationAuthority,
    );
    if (result.requiresToolReview) {
      if (setup.action === 'catalog_connection') {
        return c.redirect(`/setup/${encodeURIComponent(setupId)}?review=1`, 303);
      }
      await markSetupFailure(setup, c, dependencies.management, 'tool_access_review_required', at);
      return c.redirect(
        `/admin/agents/${encodeURIComponent(setup.target.agentId!)}?oauth=connected&connection=${encodeURIComponent(result.connectionAccountId)}&lane=mcp`,
        303,
      );
    }
    await finishSetup(c, setup, setup.action === 'catalog_connection'
      ? {
          ...result,
          completedByUserId: principal.userId,
          completedByMembershipId: principal.membershipId,
        }
      : result, dependencies, options, at);
    clearSetupCookie(c, setupId);
    return c.redirect(`/setup/${encodeURIComponent(setupId)}`, 303);
  } catch (error) {
    if (error instanceof McpOAuthError && error.code === 'oauth_attempt_superseded') {
      return c.redirect(`/setup/${encodeURIComponent(setupId)}?status=superseded`, 303);
    }
    if (error instanceof McpOAuthError && error.code === 'authorization_expired') {
      if (completedMcpOAuthRef) {
        await invalidateMcpOAuthAuthorization(
          completedMcpOAuthRef,
          dependencies.settings,
        ).catch(() => undefined);
      }
      return genericDenied(c);
    }
    if (error instanceof AuthorizationError) {
      if (completedMcpOAuthRef) {
        await invalidateMcpOAuthAuthorization(
          completedMcpOAuthRef,
          dependencies.settings,
        ).catch(() => undefined);
      }
      return genericDenied(c);
    }
    await markSetupFailure(setup, c, dependencies.management, safeFailureCode(error), at);
    return c.redirect(`/setup/${encodeURIComponent(setupId)}?status=failed`, 303);
  }
}

interface SetupDependencies {
  management: ManagementStore;
  config: ConfigStore;
  settings: SettingsStore;
  identity: Pick<
    IdentityStore,
    'getUser' | 'listExternalIdentities' | 'getOrganization' | 'getAuthControl' | 'getMembership' |
      'getMembershipAccessOverlay'
  >;
  usage: UsageStore;
  catalog: ManagedConnectorCatalog;
  platformEnv?: PlatformEnv;
  productTelemetry?: ProductTelemetryCapture;
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
    ...(options.productTelemetry ? { productTelemetry: options.productTelemetry(c) } : {}),
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
    ...(dependencies.productTelemetry ? { productTelemetry: dependencies.productTelemetry } : {}),
    telemetrySurface: 'slack',
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

async function currentCatalogAgent(
  setup: ManagementSetupRecord,
  config: ConfigStore,
): Promise<CustomAgentConfig> {
  if (setup.action !== 'catalog_connection' || !setup.target.agentId) {
    throw new AuthorizationError();
  }
  const agent = await config.getAgent(setup.target.agentId);
  if (agent.lifecycle === 'archived') throw new AuthorizationError();
  return agent;
}

async function currentCatalogReviewAccount(
  setup: ManagementSetupRecord,
  principal: AuthPrincipal,
  config: ConfigStore,
): Promise<{ account: ConnectionAccount; binding: AgentConnectionBinding }> {
  if (setup.action !== 'catalog_connection' || setup.origin.kind !== 'slack' ||
      !setup.target.connectionId || !setup.target.agentId || !setup.target.presetId ||
      principal.machine || principal.organizationId !== setup.organizationId) {
    throw new AuthorizationError();
  }
  requireAgentEdit(principal, await currentCatalogAgent(setup, config));
  const candidateIds = new Set([
    setup.target.connectionId,
    catalogSetupConnectionId(setup, 'member', principal.membershipId),
    catalogSetupConnectionId(setup, 'team', principal.membershipId),
  ]);
  const candidates: Array<{ account: ConnectionAccount; binding: AgentConnectionBinding }> = [];
  for (const account of await config.listConnectionAccounts(setup.origin.workspaceId)) {
    if (!candidateIds.has(account.id) || account.lifecycle !== 'ready' ||
        account.providerId !== setup.target.presetId || account.policy.kind !== 'mcp' ||
        !isMcpToolReviewRequired(account.policy)) continue;
    const binding = await config.getAgentConnectionBindingForAccount(account.id);
    if (!binding?.enabled || binding.agentId !== setup.target.agentId) continue;
    try {
      requireCatalogOwnerLanePermission(principal, account.ownerKind);
      if (account.ownerKind === 'member' &&
          account.ownerMembershipId !== principal.membershipId) continue;
    } catch {
      continue;
    }
    candidates.push({ account, binding });
  }
  if (candidates.length !== 1) throw new AuthorizationError();
  return candidates[0]!;
}

async function principalCanEditCatalogSetup(
  principal: AuthPrincipal | undefined,
  setup: ManagementSetupRecord,
  config: ConfigStore,
): Promise<boolean> {
  if (!principal || principal.machine || principal.organizationId !== setup.organizationId) {
    return false;
  }
  try {
    requireAgentEdit(principal, await currentCatalogAgent(setup, config));
    return true;
  } catch {
    return false;
  }
}

type LegacySetupAction = Exclude<
  ManagementSetupRecord['action'],
  'catalog_connection' | 'managed_connection'
>;

function isLegacySetupAction(
  action: ManagementSetupRecord['action'],
): action is LegacySetupAction {
  return action !== 'catalog_connection' && action !== 'managed_connection';
}

/** Recheck live authority before a delegated legacy setup can mutate or call a provider. */
async function requireCurrentLegacySetupAuthority(
  principal: AuthPrincipal,
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
): Promise<void> {
  if (!isLegacySetupAction(setup.action) || principal.machine ||
      principal.organizationId !== setup.organizationId) {
    throw new AuthorizationError();
  }
  if (setup.action === 'provider_credential') {
    requirePermission(principal, 'admin.configure');
    return;
  }
  if (!setup.target.agentId) throw new AuthorizationError();
  let agent: CustomAgentConfig;
  try {
    agent = await dependencies.config.getAgent(setup.target.agentId);
  } catch {
    throw new AuthorizationError();
  }
  if (agent.lifecycle === 'archived') throw new AuthorizationError();
  requireAgentEdit(principal, agent);
  if (setup.target.kind === 'api_connection' || setup.target.kind === 'mcp_connection') {
    // A missing account fails the exact-target check instead.
    const entry = await setupConnectionEntry(setup, dependencies);
    if (entry && !canManageOwnedResource(principal, entry.account)) throw new AuthorizationError();
  }
}

async function managedConnectionPageInput(
  c: Context,
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
  options: ManagementSetupRoutesOptions,
  /** Whoever opened a pending link; their reusable sign-ins are offered. */
  principal?: AuthPrincipal,
) {
  try {
    const agent = await currentManagedAgent(setup, dependencies.config);
    const avatarUrl = connectorPageAvatarUrl(
      agent, requestOrigin(c), agentAvatarInstallation(c.env as PlatformEnv | undefined),
    );
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
    const reconnecting = await reconnectAccount(setup, dependencies.config);
    const changingSelection = reconnecting?.lifecycle === 'ready'
      ? dependencies.catalog.connector(setup.target.provider)?.providerSelection?.label
      : undefined;
    const writeAvailable = writeReady && setup.scopes.some((scope) => writeCapabilities.has(scope));
    const reconnectGroupKey = reconnecting && signInGroupKey(reconnecting);
    const sharedSignIn = Boolean(reconnectGroupKey) && setup.origin.kind === 'slack' &&
      (await dependencies.config.listConnectionAccounts(setup.origin.workspaceId))
        .some((account) => account.id !== reconnecting!.id && signInGroupKey(account) === reconnectGroupKey);
    const reusable = principal && !reconnecting && setup.origin.kind === 'slack' &&
        dependencies.catalog.connector(setup.target.provider)?.sharedSignIn
      ? await reusableSetupSignIns(setup, agent, principal, writeAvailable ? 'write' : 'read', dependencies, providerContext.providers)
      : undefined;
    return {
      setup,
      agent,
      writeAvailable,
      ...(sharedSignIn ? { sharedSignIn } : {}),
      ...(reusable ? { reusable } : {}),
      ...(reconnecting
        ? {
            locked: {
              ownerKind: reconnecting.ownerKind,
              access: managedAccountAccessLane(reconnecting, setup.target.provider, dependencies.catalog),
            },
          }
        : {}),
      ...(changingSelection ? { changingSelection } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
    };
  } catch {
    return undefined;
  }
}

async function catalogConnectionPageInput(
  c: Context,
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
  principal?: AuthPrincipal,
  failureMessage?: string,
): Promise<ConnectorLandingPageInput | undefined> {
  try {
    if (setup.action !== 'catalog_connection' || !setup.target.agentId ||
        !setup.target.presetId) return undefined;
    const preset = resolveConnectorCatalogPreset(setup.target.presetId);
    if (!preset || 'managedToolkit' in preset) return undefined;
    const agent = await dependencies.config.getAgent(setup.target.agentId);
    if (agent.lifecycle === 'archived') return undefined;
    const avatarUrl = connectorPageAvatarUrl(
      agent, requestOrigin(c), agentAvatarInstallation(c.env as PlatformEnv | undefined),
    );
    if (setup.status === 'authorizing' && principal &&
        'toolAccessMode' in preset && preset.toolAccessMode === 'review') {
      let account: ConnectionAccount | undefined;
      try {
        account = (await currentCatalogReviewAccount(
          setup,
          principal,
          dependencies.config,
        )).account;
      } catch (error) {
        if (!(error instanceof AuthorizationError)) throw error;
      }
      if (account?.policy.kind === 'mcp' && isMcpToolReviewRequired(account.policy)) {
        const approvedAccountIds = new Set<string>();
        for (const policy of Object.values(account.policy.toolPolicies ?? {})) {
          for (const values of Object.values(policy.argumentConstraints ?? {})) {
            for (const value of values) approvedAccountIds.add(value);
          }
        }
        const allowed = new Set(account.policy.allowedTools);
        const tools = account.policy.discoveredTools.map((tool) => {
          if (account.policy.kind === 'mcp' && isBugsnagMcpConnection(account.policy)) {
            const readOnly = tool.readOnlyHint === true &&
              tool.name !== 'bugsnag_update_error' && tool.name !== 'bugsnag_set_network_endpoint_groupings';
            return {
              name: tool.name,
              ...(tool.title ? { title: tool.title } : {}),
              ...(tool.description ? { description: tool.description } : {}),
              available: true,
              selected: allowed.has(tool.name) || allowed.size === 0 && readOnly,
              effect: readOnly ? 'read' as const : 'write' as const,
            };
          }
          let schemaSupported = true;
          try {
            compileMetaAdsToolAccess({
              discoveredTools: account.policy.kind === 'mcp'
                ? account.policy.discoveredTools
                : [],
              requestedTools: [tool.name],
              approvedAccountIds: ['act_1'],
            });
          } catch (error) {
            if (!(error instanceof MetaAdsAccessPolicyError)) throw error;
            schemaSupported = false;
          }
          const effect = metaAdsToolEffect(tool.name);
          const requiresEditingAccess = schemaSupported && effect === 'write' &&
            account.policy.kind === 'mcp' &&
            (account.policy.authMode !== 'oauth' ||
              account.policy.oauthScope !== META_ADS_OAUTH_MANAGEMENT_SCOPE);
          const available = schemaSupported && !requiresEditingAccess;
          return {
            name: tool.name,
            ...(tool.title ? { title: tool.title } : {}),
            ...(tool.description ? { description: tool.description } : {}),
            available,
            selected: available && allowed.has(tool.name),
            ...(effect ? { effect } : {}),
            ...(requiresEditingAccess ? { requiresEditingAccess: true } : {}),
          };
        });
        return {
          setup,
          agent,
          ...(avatarUrl ? { avatarUrl } : {}),
          ...(failureMessage ? { failureMessage } : {}),
          accessReview: {
            tools,
            approvedAccountIds: [...approvedAccountIds],
          },
        };
      }
    }
    const reconnecting = await reconnectAccount(setup, dependencies.config);
    return {
      setup,
      agent,
      ...(reconnecting
        ? {
            locked: {
              ownerKind: reconnecting.ownerKind,
              ...(preset.id === 'meta-ads'
                ? {
                    access: catalogAccountAccessLane(reconnecting, setup.scopes) === 'write'
                      ? 'editing' as const
                      : 'reporting' as const,
                  }
                : {}),
            },
          }
        : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(failureMessage ? { failureMessage } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The account a reconnect link re-authorizes; the page and the flow keep its owner and access. */
function setupConnectionAccounts(
  dependencies: SetupDependencies,
  providers: ManagedConnectionProviderRegistry,
): ConnectionAccountService {
  return new ConnectionAccountService({
    config: dependencies.config,
    settings: dependencies.settings,
    managedProviders: providers,
    managedCatalog: dependencies.catalog,
    ...(dependencies.productTelemetry ? { productTelemetry: dependencies.productTelemetry } : {}),
    telemetrySurface: 'slack',
    ...(dependencies.platformEnv ? { platformEnv: dependencies.platformEnv } : {}),
  });
}

/**
 * The sign-ins this person may add the setup's Agent to, per owner kind. The
 * page is not Admin, so no other Agent is named; a list that cannot be read
 * leaves the page as it was.
 */
async function reusableSetupSignIns(
  setup: ManagementSetupRecord,
  agent: CustomAgentConfig,
  principal: AuthPrincipal,
  access: 'read' | 'write',
  dependencies: SetupDependencies,
  providers: ManagedConnectionProviderRegistry,
): Promise<NonNullable<ConnectorLandingPageInput['reusable']> | undefined> {
  if (setup.origin.kind !== 'slack') return undefined;
  const { workspaceId } = setup.origin;
  const service = setupConnectionAccounts(dependencies, providers);
  const signerName = async (membershipId: string) => {
    const membership = await dependencies.identity.getMembership(membershipId);
    const user = membership && await dependencies.identity.getUser(membership.userId);
    return user?.displayName || undefined;
  };
  const list = async (ownerKind: 'member' | 'team') => {
    try {
      return (await service.listReusableSignIns({
        principal, agentId: agent.id, workspaceId, toolkit: setup.target.provider, ownerKind, access, signerName,
      })).map(({ sourceConnectionId, signerName: label, signedByYou, pages, complete }) =>
        ({ sourceConnectionId, label: label ?? '', signedByYou, pages, complete }));
    } catch {
      return [];
    }
  };
  const [member, team] = await Promise.all([list('member'), list('team')]);
  return member.length || team.length ? { member, team } : undefined;
}

/** Add the setup's Agent to a sign-in it can reuse, chosen on the page, and finish the setup without the provider. */
async function reuseSetupSignIn(
  c: Context,
  setup: ManagementSetupRecord,
  agent: CustomAgentConfig,
  principal: AuthPrincipal,
  selection: NonNullable<ReturnType<typeof managedSetupSelection>>,
  fields: Record<string, string>,
  dependencies: SetupDependencies,
  options: ManagementSetupRoutesOptions,
): Promise<Response> {
  if (setup.origin.kind !== 'slack') throw new ManagedAuthorizationError('invalid');
  const service = setupConnectionAccounts(
    dependencies,
    (await managedFlowDependencies(dependencies, options)).providerContext.providers,
  );
  const pages = Object.entries(fields)
    .filter(([key, value]) => key.startsWith('page:') && value === 'on')
    .map(([key]) => key.slice('page:'.length));
  let account: ConnectionAccount;
  try {
    ({ account } = await service.reuseSignIn({
      principal,
      agentId: agent.id,
      workspaceId: setup.origin.workspaceId,
      sourceConnectionId: fields.reuseSignInId!,
      ownerKind: selection.ownerKind,
      access: selection.accessLane,
      capabilities: selection.scopes,
      choice: fields.pageMode === 'only' ? { mode: 'only', pages } : { mode: 'all' },
    }));
  } catch (error) {
    if (!(error instanceof ManagedConnectionConflictError) &&
        !(error instanceof ManagedSignInGroupConflictError) &&
        !(error instanceof ManagedResourceSelectionError)) throw error;
    const message = error instanceof ManagedResourceSelectionError
      ? `Chickpea could not add ${setup.target.targetLabel} with those pages. Reload this page and try again.`
      : `That ${setup.target.targetLabel} sign-in changed. Reload this page and try again.`;
    if (authorizationJsonRequest(c)) return c.json({ error: 'managed_connection_changed', message }, 409);
    const page = await managedConnectionPageInput(c, setup, dependencies, options, principal);
    return page
      ? c.html(renderManagedConnectionSetupPage({ ...page, failureMessage: message }), 409)
      : managedUnavailablePage(c);
  }
  try {
    await finishSetup(c, setup, {
      connector: setup.target.targetLabel,
      connectionAccountId: account.id,
      completedByUserId: principal.userId,
      completedByMembershipId: principal.membershipId,
      ownerKind: account.ownerKind,
      accessLane: selection.accessLane,
    }, dependencies, options, (options.now ?? Date.now)());
  } catch (error) {
    // The link finished elsewhere first; this Agent keeps no second Notion row from it.
    await service.revoke({ principal, connectionAccountId: account.id }).catch(() => undefined);
    throw error;
  }
  if (authorizationJsonRequest(c)) return c.json({ completed: true });
  return c.redirect(`/setup/${encodeURIComponent(setup.setupOperationId)}`, 303);
}

async function reconnectAccount(
  setup: ManagementSetupRecord,
  config: ConfigStore,
): Promise<ConnectionAccount | undefined> {
  if (!setup.target.replacement || !setup.target.connectionId || setup.origin.kind !== 'slack') {
    return undefined;
  }
  return (await config.listConnectionAccounts(setup.origin.workspaceId))
    .find(({ id }) => id === setup.target.connectionId);
}

interface CatalogSetupResult {
  connector: string;
  accountLabel?: string;
  connectionAccountId: string;
  ownerKind: 'member' | 'team';
  accessLane: 'read' | 'write';
  completedByUserId: string;
  completedByMembershipId: string;
}

function catalogSetupResult(
  account: ConnectionAccount,
  principal: AuthPrincipal,
  setup: ManagementSetupRecord,
): CatalogSetupResult {
  return {
    connector: setup.target.targetLabel,
    connectionAccountId: account.id,
    ownerKind: account.ownerKind,
    accessLane: catalogAccountAccessLane(account, setup.scopes),
    completedByUserId: principal.userId,
    completedByMembershipId: principal.membershipId,
    ...(account.identity?.accountName || account.identity?.workspaceName
      ? { accountLabel: account.identity.accountName ?? account.identity.workspaceName }
      : {}),
  };
}

async function beginCatalogConnectionSetup(
  c: Context,
  setup: ManagementSetupRecord,
  fields: Record<string, string>,
  principal: AuthPrincipal,
  dependencies: SetupDependencies,
  options: ManagementSetupRoutesOptions,
): Promise<{ authorizationUrl?: string; result: CatalogSetupResult }> {
  if (setup.action !== 'catalog_connection' || setup.origin.kind !== 'slack' ||
      !setup.target.agentId || !setup.target.presetId || !setup.target.connectionId) {
    throw new Error('target_changed');
  }
  const preset = resolveConnectorCatalogPreset(setup.target.presetId);
  if (!preset || 'managedToolkit' in preset) throw new Error('target_changed');
  requireAgentEdit(principal, await dependencies.config.getAgent(setup.target.agentId));
  const configuredOAuthCallback = typeof preset.url === 'string'
    ? await configuredManagementMcpOAuthCallback(preset.url, setup, dependencies)
    : undefined;
  const ownerKind = fields.ownerKind?.trim();
  if (ownerKind !== 'member' && ownerKind !== 'team') throw new Error('invalid_owner');
  // A reconnect keeps its account's owner. The other owner would disconnect this account for a new one.
  if (setup.target.replacement && ownerKind !== setup.target.ownerKind) throw new Error('target_changed');
  requireCatalogOwnerLanePermission(principal, ownerKind);
  const result = (account: ConnectionAccount): CatalogSetupResult => ({
    connector: preset.name,
    connectionAccountId: account.id,
    ownerKind: account.ownerKind,
    accessLane: catalogAccountAccessLane(account, setup.scopes),
    completedByUserId: principal.userId,
    completedByMembershipId: principal.membershipId,
    ...(account.identity?.accountName || account.identity?.workspaceName
      ? { accountLabel: account.identity.accountName ?? account.identity.workspaceName }
      : {}),
  });

  const prepared = await prepareCatalogConnection(preset, fields, options);
  const requestedConnectionId = catalogSetupConnectionId(setup, ownerKind, principal.membershipId);
  const accounts = await dependencies.config.listConnectionAccounts(setup.origin.workspaceId);
  const generatedIds = [
    requestedConnectionId.slice('connection_'.length),
    randomUUID().replaceAll('-', ''),
  ];
  const service = new ConnectionAccountService({
    config: dependencies.config,
    settings: dependencies.settings,
    randomId: () => generatedIds.shift() ?? randomUUID().replaceAll('-', ''),
    ...(dependencies.productTelemetry ? { productTelemetry: dependencies.productTelemetry } : {}),
    telemetrySurface: 'slack',
  });
  let account = accounts.find(({ id }) => id === requestedConnectionId) ??
    accounts.find(({ id, ownerKind: existingOwner }) =>
      id === setup.target.connectionId && existingOwner === ownerKind
    );
  if (account) {
    account = await service.getForManagement(principal, account.id);
  }
  const otherOwnerKind = ownerKind === 'member' ? 'team' : 'member';
  const supersededIds = new Set([
    setup.target.connectionId,
    catalogSetupConnectionId(setup, otherOwnerKind, principal.membershipId),
  ]);
  for (const superseded of accounts.filter(({ id, lifecycle }) =>
    id !== account?.id && supersededIds.has(id) && lifecycle !== 'revoked'
  )) {
    try {
      await service.getForManagement(principal, superseded.id);
    } catch (error) {
      if (error instanceof AuthorizationError) continue;
      throw error;
    }
    await service.revoke({
      principal,
      connectionAccountId: superseded.id,
    });
  }
  if (account) {
    const binding = await dependencies.config.getAgentConnectionBindingForAccount(account.id);
    if (account.workspaceId !== setup.origin.workspaceId || account.providerId !== preset.id ||
        !binding || binding.agentId !== setup.target.agentId || account.lifecycle === 'revoked' ||
        account.ownerKind !== ownerKind || account.ownerKind === 'member' &&
          account.ownerMembershipId !== principal.membershipId) {
      throw new Error('target_changed');
    }
    account = await replaceCatalogConnection({
      config: dependencies.config,
      settings: dependencies.settings,
      ...(dependencies.platformEnv ? { platformEnv: dependencies.platformEnv } : {}),
      account,
      binding,
      prepared,
    });
  } else {
    const accountIdSuffix = requestedConnectionId.slice('connection_'.length);
    if (!requestedConnectionId.startsWith('connection_') || !accountIdSuffix) {
      throw new Error('target_changed');
    }
    account = (await service.createForAgent({
      principal,
      agentId: setup.target.agentId,
      workspaceId: setup.origin.workspaceId,
      ownerKind,
      providerId: preset.id,
      label: preset.name,
      policy: prepared.policy,
      ...(prepared.credential ? { credential: prepared.credential } : {}),
      allowedCapabilities: prepared.allowedCapabilities,
      ...(prepared.identity ? { identity: prepared.identity } : {}),
    })).account;
  }

  if (account.policy.kind !== 'mcp' || account.policy.authMode !== 'oauth') {
    return { result: result(account) };
  }
  const { identity: _identity, ...withoutIdentity } = account;
  const pending = await dependencies.config.putConnectionAccount({
    ...withoutIdentity,
    lifecycle: 'pending',
    policy: { ...withoutIdentity.policy, oauthAttemptId: randomUUID() },
  }, account.revision);
  if (pending.policy.kind !== 'mcp' || pending.policy.authMode !== 'oauth') {
    throw new Error('target_changed');
  }
  const ref = connectionAccountOAuthRef(pending.id);
  const started = await (options.startMcpOAuth ?? startMcpOAuthAuthorization)({
    ref,
    serverUrl: pending.policy.url,
    callbackUrl: configuredOAuthCallback ??
      `${requestOrigin(c)}/setup/${encodeURIComponent(setup.setupOperationId)}/oauth/mcp/callback`,
    ...(pending.policy.oauthScope ? { scope: pending.policy.oauthScope } : {}),
    returnAgentId: setup.target.agentId,
    accountRevision: pending.revision,
    oauthAttemptId: pending.policy.oauthAttemptId!,
    ...(configuredOAuthCallback ? { setupOperationId: setup.setupOperationId } : {}),
    authorizationAuthority: {
      organizationId: principal.organizationId,
      workspaceId: setup.origin.workspaceId,
      membershipId: principal.membershipId,
      agentId: setup.target.agentId,
      ownerKind: pending.ownerKind,
    },
  }, mcpOAuthDependencies(dependencies, true));
  return {
    authorizationUrl: managedAuthorizationUrl(started.authorizationUrl),
    result: result(pending),
  };
}

async function configuredManagementMcpOAuthCallback(
  serverUrl: string,
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
): Promise<string | undefined> {
  if (!configuredMcpOAuthClientDescriptor(serverUrl)) return undefined;
  const [client, control] = await Promise.all([
    getConfiguredMcpOAuthClient(serverUrl, dependencies.settings),
    dependencies.identity.getAuthControl(),
  ]);
  if (!client || !control?.canonicalAdminOrigin || setup.origin.kind !== 'slack') {
    throw new McpOAuthError(
      'oauth_configuration_required',
      'Configure Meta Ads in Admin before signing in.',
    );
  }
  try {
    return configuredMcpOAuthCallbackUrl(control.canonicalAdminOrigin);
  } catch {
    throw new McpOAuthError(
      'oauth_configuration_required',
      'Configure the Admin address before signing in to Meta Ads.',
    );
  }
}

function requireCatalogOwnerLanePermission(
  principal: AuthPrincipal,
  ownerKind: 'member' | 'team',
): void {
  requirePermission(
    principal,
    ownerKind === 'team' ? 'connection.create_team' : 'connection.create_personal',
  );
}

async function requireSetupOAuthCallbackAuthority(
  setup: ManagementSetupRecord,
  principal: AuthPrincipal,
  state: string,
  dependencies: SetupDependencies,
): Promise<void> {
  let connectionAccountId: string | undefined;
  try {
    connectionAccountId = connectionAccountIdFromOAuthRef(
      mcpOAuthReturnRefFromState(state),
    );
  } catch {
    throw new AuthorizationError();
  }
  if (!connectionAccountId) throw new AuthorizationError();
  const account = await findConnectionAccount(
    dependencies.config,
    connectionAccountId,
    setup.origin.kind === 'slack' ? setup.origin.workspaceId : undefined,
  );
  const binding = account
    ? await dependencies.config.getAgentConnectionBindingForAccount(account.id)
    : undefined;
  if (!account) throw new AuthorizationError();
  requireSetupOAuthAccountPermission(setup, principal, account, binding);
}

function requireSetupOAuthAccountPermission(
  setup: ManagementSetupRecord,
  principal: AuthPrincipal,
  account: ConnectionAccount,
  binding: AgentConnectionBinding | undefined,
): void {
  if (principal.machine || principal.organizationId !== setup.organizationId ||
      account.lifecycle !== 'pending' || account.policy.kind !== 'mcp' ||
      account.policy.authMode !== 'oauth' || !binding?.enabled ||
      binding.agentId !== setup.target.agentId || !setupOAuthAccountMatches(setup, account)) {
    throw new AuthorizationError();
  }
  if (setup.action === 'mcp_oauth') {
    if (!canManageOwnedResource(principal, account)) throw new AuthorizationError();
    return;
  }
  requireCatalogOwnerLanePermission(principal, account.ownerKind);
  if (account.ownerKind === 'member' &&
      account.ownerMembershipId !== principal.membershipId) {
    throw new AuthorizationError();
  }
}

/** A catalog setup completes its preset's account in the member's lane; a management setup, the account it froze. */
function setupOAuthAccountMatches(setup: ManagementSetupRecord, account: ConnectionAccount): boolean {
  if (setup.action === 'mcp_oauth') return account.id === setup.target.connectionId;
  return setup.action === 'catalog_connection' && setup.origin.kind === 'slack' &&
    account.workspaceId === setup.origin.workspaceId && account.providerId === setup.target.presetId;
}

async function requireCurrentAccountOAuthAuthorization(
  dependencies: SetupDependencies,
  authority: OAuthAuthorizationAuthority | undefined,
  ref: { agentId: string; connectionId: string },
): Promise<void> {
  if (!authority || authority.ownerKind === 'legacy_agent') throw new AuthorizationError();
  const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
  if (!connectionAccountId) throw new AuthorizationError();
  const [organization, membership, overlay] = await Promise.all([
    dependencies.identity.getOrganization(),
    dependencies.identity.getMembership(authority.membershipId),
    dependencies.identity.getMembershipAccessOverlay(authority.membershipId),
  ]);
  if (!organization || organization.id !== authority.organizationId ||
      organization.slackTeamId !== authority.workspaceId || !membership ||
      membership.status !== 'active' || membership.organizationId !== authority.organizationId ||
      overlay && (overlay.organizationId !== authority.organizationId ||
        overlay.accessStatus !== 'active')) {
    throw new AuthorizationError();
  }
  const currentPrincipal: AuthPrincipal = {
    userId: membership.userId,
    membershipId: membership.id,
    organizationId: membership.organizationId,
    role: membership.role,
    authenticatorKind: 'oauth_callback_authority',
    credentialId: 'oauth_callback_authority',
    correlationId: 'oauth_callback_authority',
    machine: false,
  };
  requireCatalogOwnerLanePermission(currentPrincipal, authority.ownerKind);
  let agent: CustomAgentConfig;
  try {
    agent = await dependencies.config.getAgent(authority.agentId);
  } catch {
    throw new AuthorizationError();
  }
  if (agent.lifecycle === 'archived') throw new AuthorizationError();
  requireAgentEdit(currentPrincipal, agent);
  const account = await findConnectionAccount(
    dependencies.config,
    connectionAccountId,
    authority.workspaceId,
  );
  if (!account || account.lifecycle !== 'pending' ||
      account.workspaceId !== authority.workspaceId || account.ownerKind !== authority.ownerKind ||
      account.policy.kind !== 'mcp' || account.policy.authMode !== 'oauth') {
    throw new AuthorizationError();
  }
  const binding = await dependencies.config.getAgentConnectionBindingForAccount(account.id);
  if (!binding?.enabled || binding.agentId !== authority.agentId) {
    throw new AuthorizationError();
  }
  requireCatalogOwnerLanePermission(currentPrincipal, account.ownerKind);
  if (account.ownerKind === 'member' && account.ownerMembershipId !== membership.id) {
    throw new AuthorizationError();
  }
}

async function accountOAuthAuthorizationIsCurrent(
  dependencies: SetupDependencies,
  authority: OAuthAuthorizationAuthority | undefined,
  ref: { agentId: string; connectionId: string },
): Promise<boolean> {
  try {
    await requireCurrentAccountOAuthAuthorization(dependencies, authority, ref);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace a catalog connection's policy and credential in place, restoring the
 * previous account, binding, and stored credential if any step fails. Shared
 * by the Slack setup handoff and the QA-lane environment seed.
 */
export async function replaceCatalogConnection(input: {
  config: ConfigStore;
  settings: SettingsStore;
  platformEnv?: PlatformEnv;
  account: ConnectionAccount;
  binding: AgentConnectionBinding;
  prepared: Awaited<ReturnType<typeof prepareCatalogConnection>>;
}): Promise<ConnectionAccount> {
  const { account, binding, prepared } = input;
  const previousAccount = account;
  const previousBinding = binding;
  const credentialKey = connectionAccountSecretSettingKey(account.secretRefId);
  const previousCredential = prepared.credential
    ? await input.settings.getSetting(credentialKey)
    : undefined;
  let updatedAccount: ConnectionAccount | undefined;
  let updatedBinding: AgentConnectionBinding | undefined;
  try {
    const preserveReviewedAccess = account.policy.kind === 'mcp' &&
      prepared.policy.kind === 'mcp' && isMcpToolReviewRequired(prepared.policy);
    let nextPolicy: ConnectionAccountPolicy = prepared.policy;
    if (account.policy.kind === 'mcp' && prepared.policy.kind === 'mcp' &&
        preserveReviewedAccess) {
      const allowedTools = !isMetaAdsMcpConnection(prepared.policy) || prepared.policy.authMode === 'oauth' &&
        prepared.policy.oauthScope === META_ADS_OAUTH_MANAGEMENT_SCOPE
        ? account.policy.allowedTools
        : account.policy.allowedTools.filter((tool) => metaAdsToolEffect(tool) !== 'write');
      nextPolicy = {
        ...prepared.policy,
        discoveredTools: account.policy.discoveredTools,
        allowedTools,
        ...(account.policy.toolPolicies
          ? {
              toolPolicies: Object.fromEntries(
                Object.entries(account.policy.toolPolicies)
                  .filter(([tool]) => allowedTools.includes(tool)),
              ),
            }
          : {}),
      };
    }
    updatedAccount = await input.config.putConnectionAccount({
      ...account,
      policy: nextPolicy,
      ...(prepared.identity ? { identity: prepared.identity } : {}),
      lifecycle: prepared.credential ||
          prepared.policy.kind === 'mcp' && prepared.policy.authMode === 'none'
        ? 'ready'
        : account.lifecycle,
    }, account.revision);
    updatedBinding = await input.config.putAgentConnectionBinding({
      ...binding,
      allowedCapabilities: preserveReviewedAccess
        ? binding.allowedCapabilities
        : prepared.allowedCapabilities,
    });
    if (prepared.credential) {
      await saveConnectionAccountSecret(
        account.secretRefId,
        prepared.credential,
        input.platformEnv,
        input.settings,
      );
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (updatedAccount) {
      try {
        await input.config.putConnectionAccount(previousAccount, updatedAccount.revision);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (updatedBinding) {
      try {
        // Only the binding this replacement wrote is restored; a change made since then stays.
        if (!await input.config.putAgentConnectionBindingIfUnchanged(updatedBinding, previousBinding)) {
          throw new Error('Connection binding changed before it could be restored');
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (prepared.credential) {
      try {
        if (previousCredential === undefined) {
          await input.settings.deleteSetting(credentialKey);
        } else {
          await input.settings.setSetting(credentialKey, previousCredential);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Connection replacement failed and its previous state could not be fully restored',
      );
    }
    throw error;
  }
  return updatedAccount;
}

/** Expands a token catalog preset outside a setup link, for QA lane seeding. */
export function prepareSeededCatalogConnection(
  preset: ConnectorPreset,
  fields: Record<string, string>,
): ReturnType<typeof prepareCatalogConnection> {
  return prepareCatalogConnection(preset, fields, {});
}

async function prepareCatalogConnection(
  preset: ConnectorPreset,
  fields: Record<string, string>,
  options: ManagementSetupRoutesOptions,
): Promise<{
  policy: ConnectionAccountPolicy;
  credential?: string;
  allowedCapabilities: string[];
  identity?: ConnectionAccount['identity'];
}> {
  if (typeof preset.url === 'string' && preset.transport && preset.auth) {
    const validated = validateMcpUrl(preset.url);
    if (!validated.ok) throw new Error('blocked_url');
    const credential = fields.credential?.trim() ?? '';
    const auth = preset.auth;
    if ((auth.kind === 'bearer' || auth.kind === 'header' && !auth.optional) && !credential) {
      throw new Error('credential_required');
    }
    const authMode = auth.kind === 'oauth' ? 'oauth' as const
      : auth.kind === 'bearer' ? 'bearer' as const
        : 'none' as const;
    let discoveredTools: McpConnectionConfig['discoveredTools'] = [];
    let identity: ConnectionAccount['identity'];
    if (auth.kind !== 'oauth') {
      const customHeaders = auth.kind === 'header' && credential
        ? { [auth.headerName]: `${auth.valuePrefix ?? ''}${credential}` }
        : {};
      const headers = buildMcpRequestHeaders(authMode, {
        ...(auth.kind === 'bearer' && credential ? { bearer: credential } : {}),
        headers: customHeaders,
      });
      const discoveryInput = {
        id: preset.id,
        url: validated.url,
        transport: preset.transport,
        headers,
      };
      discoveredTools = (await (options.discoverMcp ?? discoverMcpTools)(discoveryInput)).tools;
      identity = await (options.identifyMcp ?? discoverMcpConnectionIdentity)({
        ...discoveryInput,
        presetId: preset.id,
      }).catch(() => undefined);
    }
    const requestedOAuthScope = auth.kind === 'oauth'
      ? resolveConfiguredMcpOAuthScope(
          validated.url,
          auth.writeScope && fields.access?.trim() === 'editing'
            ? auth.writeScope
            : auth.scope,
        )
      : undefined;
    if (auth.kind === 'oauth' && auth.writeScope && fields.access?.trim() &&
        fields.access.trim() !== 'reporting' && fields.access.trim() !== 'editing') {
      throw new Error('invalid_access');
    }
    const basePolicy: ConnectionAccountPolicy = {
      kind: 'mcp',
      url: validated.url,
      transport: preset.transport,
      authMode,
      headerNames: auth.kind === 'header' ? [auth.headerName] : [],
      ...(auth.kind === 'header'
        ? {
            credentialHeaderName: auth.headerName,
            ...(auth.valuePrefix ? { credentialValuePrefix: auth.valuePrefix } : {}),
            ...(auth.optional ? { credentialOptional: true } : {}),
          }
        : {}),
      discoveredTools: [],
      allowedTools: [],
      ...(preset.toolAccessMode ? { toolAccessMode: preset.toolAccessMode } : {}),
      ...(requestedOAuthScope ? { oauthScope: requestedOAuthScope } : {}),
      presetId: preset.id,
    };
    if (basePolicy.kind !== 'mcp') throw new Error('target_changed');
    const allowedTools = allowedToolsAfterMcpDiscovery(basePolicy, discoveredTools);
    return {
      policy: {
        ...basePolicy,
        discoveredTools,
        allowedTools,
      },
      ...(credential ? { credential } : {}),
      allowedCapabilities: allowedTools,
      ...(identity ? { identity } : {}),
    };
  }

  const credential = requiredField(fields, 'credential', 8_192);
  const hosts = preset.api.hostTemplate
    ? catalogTemplateHosts(preset.api.hosts, requiredField(fields, 'workspaceSubdomain', 63))
    : [...preset.api.hosts];
  return {
    policy: {
      kind: 'api',
      allowedHosts: hosts,
      pathPrefixes: [...(preset.api.pathPrefixes ?? [])],
      headerName: preset.api.headerName,
      ...(preset.api.valuePrefix ? { headerValuePrefix: preset.api.valuePrefix } : {}),
      allowedMethods: [...preset.api.methods],
      authMode: 'credential',
      presetId: preset.id,
    },
    credential,
    allowedCapabilities: [],
  };
}

function catalogTemplateHosts(templates: readonly string[], rawSubdomain: string): string[] {
  const subdomain = rawSubdomain.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
    throw new Error('invalid_subdomain');
  }
  return templates.map((template) => {
    const labels = template.split('.');
    if (labels.length < 2 || labels[0] !== 'your-subdomain') {
      throw new Error('invalid_host_template');
    }
    return [subdomain, ...labels.slice(1)].join('.');
  });
}

function catalogAccessLane(scopes: readonly string[]): 'read' | 'write' {
  return scopes.length === 0 || scopes.some((scope) =>
    /(?:^|[:_\s])write(?:$|[:_\s])/i.test(scope) ||
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(scope.toUpperCase())
  ) ? 'write' : 'read';
}

function catalogAccountAccessLane(
  account: ConnectionAccount,
  fallbackScopes: readonly string[],
): 'read' | 'write' {
  return account.policy.kind === 'mcp' && account.policy.authMode === 'oauth' &&
    account.policy.oauthScope === META_ADS_OAUTH_MANAGEMENT_SCOPE
    ? 'write'
    : account.policy.kind === 'mcp' && account.policy.presetId === 'meta-ads'
      ? 'read'
      : catalogAccessLane(fallbackScopes);
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
  installationId: string | undefined,
): string | undefined {
  const presentationUrl = agentAvatarUrlForPresentation(agent, publicOrigin, installationId);
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
  return agentAvatarUrl(publicOrigin, agent.id, agent.slackPresence.avatar.revision, installationId);
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
  const hostedLogin = hostedLoginFence(platformEnv);
  const directory = new BetterAuthDirectory({
    backend: environment.backend,
    access: identity,
    organizationId: control.betterAuthOrganizationId,
    canonicalAdminOrigin: control.canonicalAdminOrigin,
    hostedLogin,
  });
  const auth = new AuthService({
    identity,
    sessionAuthenticator: new BetterAuthSessionAuthenticator({
      ...environment,
      directory,
      organizationId: control.betterAuthOrganizationId,
      routedSession: hostedLogin?.routed?.session,
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
): Promise<{ connector?: string; accountLabel?: string; check?: ApiConnectionCheck['kind'] }> {
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
      await initializeWorkspaceImageDefaultBestEffort(async () => {
        const organization = await dependencies.identity.getOrganization();
        if (organization?.id !== setup.organizationId || !organization.slackTeamId) {
          return undefined;
        }
        return {
          config: dependencies.config,
          workspaceId: organization.slackTeamId,
          modelId: OPENAI_API_IMAGE_DEFAULT_MODEL_ID,
          membershipId: setup.actorMembershipId,
        };
      });
    }
    return { connector: providerDisplayName(providerId) };
  }
  if (setup.action === 'api_credential') {
    const entry = await currentSetupConnection(setup, dependencies);
    const { policy } = entry.account;
    if (policy.kind !== 'api' || policy.authMode !== 'credential') {
      throw new Error('target_changed');
    }
    const credential = requiredField(fields, 'credential', 16_384);
    const check = await checkConnection({
      kind: 'api',
      connection: policy,
      credential,
      authorize: async () => (await currentSetupConnection(setup, dependencies)
        .catch(() => undefined))?.account.revision === entry.account.revision,
    }, options.connectionCheck);
    if (check.kind === 'key_rejected') throw new SetupKeyRejectedError(policy.allowedHosts[0]!);
    await completeSetupCredential(setup, dependencies, entry, credential, {});
    return { connector: setup.target.targetLabel, check: check.kind };
  }
  if (setup.action === 'mcp_credentials') {
    const entry = await currentSetupConnection(setup, dependencies);
    const { account } = entry;
    if (account.policy.kind !== 'mcp' || account.policy.authMode === 'oauth') {
      throw new Error('target_changed');
    }
    const policy = account.policy;
    const credential = requiredField(fields, mcpCredentialField(policy), 16_384);
    const validated = validateMcpUrl(policy.url);
    if (!validated.ok) throw new Error('blocked_url');
    const [server] = projectEffectiveMcpConnections([{
      account,
      binding: entry.binding,
      policy,
      scope: account.ownerKind === 'team' ? 'team' : 'personal',
    }]);
    if (!server) throw new Error('target_changed');
    const headers = buildMcpRequestHeaders(
      policy.authMode,
      await resolveConnectionAccountMcpSecrets(server, async () => credential),
    );
    const authorizeRequest = async () => {
      if ((await currentSetupConnection(setup, dependencies)).account.revision !== account.revision) {
        throw new Error('target_changed');
      }
    };
    const discoveryInput = {
      id: account.id,
      url: validated.url,
      transport: policy.transport,
      headers,
      authorizeRequest,
    };
    const check = await checkConnection({ kind: 'mcp', server: discoveryInput }, {
      ...options.connectionCheck,
      ...(options.discoverMcp ? { discoverMcp: options.discoverMcp } : {}),
    });
    await authorizeRequest();
    if (check.kind === 'key_rejected') throw new SetupKeyRejectedError(new URL(validated.url).host);
    if (check.kind !== 'ok') throw new Error('mcp_check_failed');
    const identity = await (options.identifyMcp ?? discoverMcpConnectionIdentity)({
      ...discoveryInput,
      ...(policy.presetId ? { presetId: policy.presetId } : {}),
    }).catch(() => undefined);
    await completeSetupCredential(setup, dependencies, entry, credential, {
      policy: {
        ...policy,
        discoveredTools: check.tools,
        allowedTools: allowedToolsAfterMcpDiscovery(policy, check.tools),
      },
      ...(identity ? { identity } : {}),
    });
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
  const connectionReceipt = ['managed_connection', 'catalog_connection'].includes(setup.action) &&
      setup.target.agentId
    ? await dependencies.config.getAgent(setup.target.agentId).then((agent) => {
        const avatarUrl = agentAvatarUrlForPresentation(
          agent, requestOrigin(c), agentAvatarInstallation(c.env as PlatformEnv | undefined),
        );
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
  const initiator = connectionReceipt
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
    ...(connectionReceipt ?? {}),
  });
  emitManagementMetric('setup.lifecycle', {
    action: setup.action,
    outcome: 'completed',
  });
  const presentationState = slackPresentationStatePort(
    getSlackStateStore(dependencies.platformEnv),
    dependencies.platformEnv,
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
  const work = getWorkStore(dependencies.platformEnv);
  await drainManagementReceiptOutbox({
    management: dependencies.management,
    onDeliveredSettled: (record) => completeSettledAgentWelcomeHandoff(
      record,
      dependencies.config,
      dependencies.management,
    ),
    onTerminalFailure: (record) => failAgentWelcomeDelivery(record, presentation, work),
    deliver: (record) => (options.deliverReceipt ?? deliverManagementReceiptToSlack)(record, {
      identity: dependencies.identity,
      ...(dependencies.platformEnv ? { env: dependencies.platformEnv } : {}),
      onDelivered: (deliveredRecord, delivery) => completeAgentWelcomeDelivery(
        deliveredRecord,
        delivery,
        dependencies.config,
        presentation,
        work,
      ),
    }),
    now: () => at,
  }).catch(() => undefined);
}

async function verifyMcpConnection(
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
  ref: { agentId: string; connectionId: string; credentialRef?: string },
  principal: AuthPrincipal,
  options: ManagementSetupRoutesOptions,
  accountRevision?: number,
  oauthAttemptId?: string,
  authorizationAuthority?: OAuthAuthorizationAuthority,
): Promise<{
  connector: string;
  accountLabel?: string;
  connectionAccountId: string;
  ownerKind: 'member' | 'team';
  accessLane: 'read' | 'write';
  requiresToolReview?: boolean;
}> {
  const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
  if (!connectionAccountId) {
    throw new McpOAuthError('connection_missing', 'OAuth connection no longer exists');
  }
  const workspaceId = setup.origin.kind === 'slack' ? setup.origin.workspaceId : undefined;
  const account = await findConnectionAccount(dependencies.config, connectionAccountId, workspaceId);
  const binding = account
    ? await dependencies.config.getAgentConnectionBindingForAccount(account.id)
    : undefined;
  if (!account || account.lifecycle !== 'pending' || account.policy.kind !== 'mcp' ||
      account.policy.authMode !== 'oauth' ||
      accountRevision !== undefined && account.revision !== accountRevision ||
      oauthAttemptId !== undefined && account.policy.oauthAttemptId !== oauthAttemptId ||
      !binding || binding.agentId !== setup.target.agentId ||
      !setupOAuthAccountMatches(setup, account)) {
    throw new McpOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
  }
  requireSetupOAuthAccountPermission(setup, principal, account, binding);
  await requireCurrentAccountOAuthAuthorization(dependencies, authorizationAuthority, ref);
  const validated = validateMcpUrl(account.policy.url);
  if (!validated.ok) throw new Error('blocked_url');
  const authorizeRequest = async () => {
    const current = await findConnectionAccount(dependencies.config, connectionAccountId, workspaceId);
    const currentBinding = current
      ? await dependencies.config.getAgentConnectionBindingForAccount(current.id)
      : undefined;
    if (!current || current.lifecycle !== 'pending' || current.policy.kind !== 'mcp' ||
        current.policy.authMode !== 'oauth' ||
        !sameMcpServerUrl(current.policy.url, validated.url) ||
        (accountRevision !== undefined && current.revision !== accountRevision) ||
        (oauthAttemptId !== undefined && current.policy.oauthAttemptId !== oauthAttemptId) ||
        currentBinding?.agentId !== setup.target.agentId) {
      throw new McpOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
    }
    requireSetupOAuthAccountPermission(setup, principal, current, currentBinding);
    await requireCurrentAccountOAuthAuthorization(dependencies, authorizationAuthority, ref);
  };
  const bearer = await (options.resolveMcpOAuthToken ?? resolveMcpOAuthAccessToken)(
    { ref, serverUrl: validated.url },
    mcpOAuthDependencies(dependencies),
  );
  const headers = buildMcpRequestHeaders('oauth', { bearer, headers: {} });
  const discoveryInput = {
    id: account.id,
    url: validated.url,
    transport: account.policy.transport,
    headers,
    authorizeRequest,
  };
  await authorizeRequest();
  const discovery = await (options.discoverMcp ?? discoverMcpTools)(discoveryInput);
  await authorizeRequest();
  const identity = await (options.identifyMcp ?? discoverMcpConnectionIdentity)({
    ...discoveryInput,
    ...(account.policy.presetId ? { presetId: account.policy.presetId } : {}),
  }).catch(() => undefined);
  const allowedTools = allowedToolsAfterMcpDiscovery(account.policy, discovery.tools);
  const requiresToolReview = isMcpToolReviewRequired(account.policy);
  requireSetupOAuthAccountPermission(setup, principal, account, binding);
  await requireCurrentAccountOAuthAuthorization(dependencies, authorizationAuthority, ref);
  const ready = await markSetupAccountReady(setup, dependencies, { account, binding }, {
    policy: { ...account.policy, discoveredTools: discovery.tools, allowedTools },
    ...(identity ? { identity } : {}),
  });
  return {
    connector: setup.target.targetLabel,
    connectionAccountId: ready.id,
    ownerKind: ready.ownerKind,
    accessLane: catalogAccountAccessLane(ready, setup.scopes),
    ...(requiresToolReview ? { requiresToolReview: true } : {}),
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
    const revision = await installationModelCredentialVersion(providerId, dependencies.platformEnv, dependencies.settings);
    if (source === 'env' || revision !== setup.target.expectedRevision ||
        (setup.target.replacement ? source !== 'stored' : source !== 'missing')) {
      throw new Error('target_changed');
    }
    return;
  }
  if (setup.target.kind === 'api_connection' || setup.target.kind === 'mcp_connection') {
    await currentSetupConnection(setup, dependencies);
    return;
  }
  const agent = await currentSetupAgent(setup, dependencies.config);
  if (setup.target.kind === 'catalog_connection') {
    const preset = setup.target.presetId
      ? resolveConnectorCatalogPreset(setup.target.presetId)
      : undefined;
    if (!preset || 'managedToolkit' in preset || preset.name !== setup.target.targetLabel) {
      throw new Error('target_changed');
    }
  } else {
    const repository = agent.repositories.find(({ id }) => id === setup.target.repositoryId);
    if (!repository || repository.fullName !== setup.target.targetLabel) throw new Error('target_changed');
  }
}

async function currentSetupAgent(
  setup: ManagementSetupRecord,
  config: ConfigStore,
): Promise<CustomAgentConfig> {
  if (!setup.target.agentId) throw new Error('target_changed');
  const agent = await config.getAgent(setup.target.agentId);
  if (!setup.setupOperationId.startsWith('setup_welcome_') &&
      agent.revision !== setup.target.expectedRevision) throw new Error('target_changed');
  return agent;
}

/** The Agent and the connection account a management setup froze, both unchanged since. */
async function currentSetupConnection(
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
): Promise<AgentConnectionEntry & { agent: CustomAgentConfig }> {
  const agent = await currentSetupAgent(setup, dependencies.config);
  const entry = await setupConnectionEntry(setup, dependencies);
  if (!entry || entry.account.label !== setup.target.targetLabel ||
      connectionSetupBinding(entry) !== setup.target.credentialBinding) {
    throw new Error('target_changed');
  }
  return { agent, ...entry };
}

/** The setup's connection on its Agent as the requesting member manages it, if it is still there. */
async function setupConnectionEntry(
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
): Promise<AgentConnectionEntry | undefined> {
  const lane = setup.target.kind === 'mcp_connection' ? 'mcp' : 'api';
  const workspaceId = await setupWorkspaceId(setup, dependencies.identity);
  if (!workspaceId || !setup.target.agentId) return undefined;
  const [accounts, bindings] = await Promise.all([
    dependencies.config.listConnectionAccounts(workspaceId),
    dependencies.config.listAgentConnectionBindings(setup.target.agentId),
  ]);
  return [...agentConnections(accounts, bindings, setup.actorMembershipId)[lane].values()]
    .find(({ account }) => account.id === setup.target.connectionId);
}

async function setupWorkspaceId(
  setup: ManagementSetupRecord,
  identity: SetupDependencies['identity'],
): Promise<string | undefined> {
  if (setup.origin.kind === 'slack') return setup.origin.workspaceId;
  const organization = await identity.getOrganization();
  return organization?.id === setup.organizationId ? organization.slackTeamId ?? undefined : undefined;
}

async function completeSetupCredential(
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
  entry: AgentConnectionEntry,
  credential: string,
  changes: Partial<Pick<ConnectionAccount, 'policy' | 'identity'>>,
): Promise<void> {
  const { secretRefId } = entry.account;
  await saveConnectionAccountSecret(secretRefId, credential, dependencies.platformEnv, dependencies.settings);
  try {
    await markSetupAccountReady(setup, dependencies, entry, changes);
  } catch (error) {
    if (await setupCredentialWasRetired(setup, dependencies) === true) {
      await tombstoneConnectionAccountSecret(secretRefId, dependencies.platformEnv, dependencies.settings);
    }
    throw error;
  }
}

/**
 * Whether the account's secret slot stopped serving the setup's credential
 * policy. A rename keeps the slot, so a newer credential saved there survives.
 */
async function setupCredentialWasRetired(
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
): Promise<boolean | undefined> {
  try {
    const entry = await setupConnectionEntry(setup, dependencies);
    return !entry || connectionSetupBinding(entry) !== setup.target.credentialBinding;
  } catch {
    return undefined;
  }
}

/** Mark a setup's account ready, fenced on the revision the setup read. */
async function markSetupAccountReady(
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
  { account, binding }: { account: ConnectionAccount; binding: AgentConnectionBinding },
  changes: Partial<Pick<ConnectionAccount, 'policy' | 'identity'>>,
): Promise<ConnectionAccount> {
  const ready = await dependencies.config.putConnectionAccount(
    { ...account, ...changes, lifecycle: 'ready' },
    account.revision,
  );
  if (account.lifecycle !== 'ready' &&
      !(ready.policy.kind === 'mcp' && isMcpToolReviewRequired(ready.policy))) {
    dependencies.productTelemetry?.capture({
      event: 'connection_ready',
      workspaceId: ready.workspaceId,
      agentId: binding.agentId,
      connectionKind: ready.policy.kind,
      ownerKind: ready.ownerKind,
      surface: setup.origin.kind,
    });
  }
  return ready;
}

function catalogSetupConnectionId(
  setup: ManagementSetupRecord,
  ownerKind: 'member' | 'team',
  membershipId: string,
): string {
  const base = setup.target.connectionId;
  if (!base?.startsWith('connection_')) throw new Error('target_changed');
  const suffix = createHash('sha256')
    .update(`${base}:${ownerKind}:${ownerKind === 'member' ? membershipId : 'workspace'}`)
    .digest('hex')
    .slice(0, 32);
  return `connection_${suffix}`;
}

async function beginRepositorySetup(
  c: Context,
  setup: ManagementSetupRecord,
  fields: Record<string, string>,
  principal: AuthPrincipal,
  dependencies: SetupDependencies,
): Promise<Response> {
  const github = await getGithubConnection(dependencies.settings, dependencies.platformEnv);
  if (github.mode === 'app') {
    return c.redirect(
      `/setup/${encodeURIComponent(setup.setupOperationId)}/repository/finish`,
      303,
    );
  }
  // The host owns the platform GitHub App; an installation connects GitHub in Admin, never with its own App.
  if (deploymentServesManyInstallations(dependencies.platformEnv)) throw new Error('github_not_connected');
  requirePermission(principal, 'admin.configure');
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
    validateConnection: async (ref, provider, accountRevision) => {
      const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
      const account = connectionAccountId
        ? await findConnectionAccount(dependencies.config, connectionAccountId)
        : undefined;
      if (!account || account.lifecycle === 'revoked' || account.policy.kind !== 'api' ||
          account.policy.oauthProvider !== provider ||
          !isValidApiOAuthConnectionPolicy(account.policy)) return false;
      if (accountRevision !== undefined && account.revision !== accountRevision) {
        throw new ApiOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
      }
      return true;
    },
  };
}

function mcpOAuthDependencies(
  dependencies: SetupDependencies,
  validateAuthorization = false,
): McpOAuthDependencies {
  return {
    settings: dependencies.settings,
    ...mcpOAuthLifecycleDependencies(dependencies.config, dependencies.settings),
    refreshTelemetry: { trigger: 'admin' },
    ...(validateAuthorization
      ? {
          validateAuthorization: (
            authority: OAuthAuthorizationAuthority | undefined,
            ref: { agentId: string; connectionId: string },
          ) => accountOAuthAuthorizationIsCurrent(dependencies, authority, ref),
        }
      : {}),
    validateConnection: async (ref, serverUrl, accountRevision, oauthAttemptId) => {
      const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
      const account = connectionAccountId
        ? await findConnectionAccount(dependencies.config, connectionAccountId)
        : undefined;
      if (!account || account.lifecycle === 'revoked' || account.policy.kind !== 'mcp' ||
          account.policy.authMode !== 'oauth') return false;
      if (!sameMcpServerUrl(account.policy.url, serverUrl)) return false;
      if (accountRevision !== undefined && account.revision !== accountRevision) {
        throw new McpOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
      }
      if (oauthAttemptId !== undefined && account.policy.oauthAttemptId !== oauthAttemptId) {
        throw new McpOAuthError('oauth_attempt_superseded', 'OAuth attempt was superseded');
      }
      return true;
    },
    onAuthorizationCancelled: async (
      ref, serverUrl, accountRevision, oauthAttemptId,
    ) => {
      const connectionAccountId = connectionAccountIdFromOAuthRef(ref);
      if (!connectionAccountId) return;
      if (!await markCancelledMcpOAuthAccount(dependencies.config, {
        connectionAccountId, serverUrl,
        ...(accountRevision !== undefined ? { accountRevision } : {}),
        ...(oauthAttemptId ? { oauthAttemptId } : {}),
      })) {
        throw new McpOAuthError(
          'oauth_attempt_superseded', 'OAuth attempt was superseded',
        );
      }
    },
  };
}

async function findConnectionAccount(
  config: ConfigStore,
  connectionAccountId: string,
  workspaceId?: string,
): Promise<ConnectionAccount | undefined> {
  if (workspaceId) {
    return (await config.listConnectionAccounts(workspaceId)).find(
      ({ id }) => id === connectionAccountId,
    );
  }
  for (const installation of await config.listWorkspaceInstallations()) {
    const account = (await config.listConnectionAccounts(installation.workspaceId)).find(
      ({ id }) => id === connectionAccountId,
    );
    if (account) return account;
  }
  return undefined;
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
  if (setup.action === 'catalog_connection') {
    return !principal.machine && principal.organizationId === setup.organizationId &&
        sessionMatches(setup, session)
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

async function renderSetupSummary(
  setup: ManagementSetupRecord,
  input: { failure?: string | undefined; destination?: ApiConnectionScope | undefined } = {},
): Promise<string> {
  const failure = input.failure ?? (setup.status === 'failed' ? SETUP_FAILED_TEXT : undefined);
  const action = setup.action === 'api_oauth' || setup.action === 'mcp_oauth' ||
      setup.action === 'repository_access'
    ? 'authorize'
    : 'complete';
  const fields = setup.action === 'repository_access'
    ? '<label>GitHub organization (optional)<input name="organization" autocomplete="organization"></label>'
    : (setup.target.formFields ?? []).map((field) => setupField(field)).join('');
  return renderSetupPanelPage({
    title: `Connect ${setup.target.targetLabel}`,
    surface: 'setup-summary',
    content: `<p class="eyebrow">Chickpea delegated setup</p>
    <h1>Connect ${escapeHtml(setup.target.targetLabel)}</h1>
    <dl><div><dt>Provider</dt><dd>${escapeHtml(setup.target.provider)}</dd></div>
    <div><dt>Target</dt><dd>${escapeHtml(setup.target.agentName ?? setup.target.targetLabel)}</dd></div>
    <div><dt>Requested access</dt><dd>${escapeHtml(setup.scopes.join(', ') || 'Provider default')}</dd></div>
    ${input.destination ? destinationRows(input.destination) : ''}</dl>
    ${setup.target.replacement ? '<p class="warning">This will replace the currently connected credential.</p>' : ''}
    ${failure ? `<p class="error">${escapeHtml(failure)}</p>` : ''}
    <form method="post" action="/setup/${encodeURIComponent(setup.setupOperationId)}/${action}" autocomplete="off">
      ${fields}<button type="submit">Continue</button>
    </form>`,
  });
}

function terminalPage(c: Context, setup: ManagementSetupRecord): Response {
  if (setup.action === 'managed_connection') {
    return managedUnavailablePage(c);
  }
  if (setup.status === 'completed') {
    const saved = keySavedText(c.req.query('check'));
    return c.html(renderSetupPanelPage({
      title: 'Setup complete',
      surface: 'setup-complete',
      content: saved
        ? `<h1>Key saved</h1><p>${escapeHtml(saved)} You can close this window.</p>`
        : '<h1>Connected</h1><p>This setup is complete. You can close this window.</p>',
    }));
  }
  return unavailablePage(c);
}

function managedUnavailablePage(c: Context): Response {
  return c.html(renderManagedConnectionUnavailablePage(), 410);
}

function unavailablePage(c: Context): Response {
  return c.html(renderSetupPanelPage({
    title: 'Setup unavailable',
    surface: 'setup-unavailable',
    content: '<h1>Setup link unavailable</h1><p>Ask the person who created this link to issue a new one.</p>',
  }), 410);
}

async function formFailure(
  c: Context,
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
  failure = SETUP_FAILED_TEXT,
): Promise<Response> {
  return c.html(await renderSetupSummary(setup, {
    failure,
    destination: await setupDestination(setup, dependencies),
  }), 422);
}

const SETUP_FAILED_TEXT = 'Setup did not complete. Secret fields were cleared; follow the steps and try again.';

type KeySavedCheck = Exclude<ApiConnectionCheck['kind'], 'ok' | 'key_rejected'>;

/** What the completed page says when an API key was saved but its check did not show it working. */
const KEY_SAVED_TEXT: Record<KeySavedCheck, string> = {
  not_permitted: 'The API accepted your key but did not permit the request Chickpea tried, so some requests may be refused.',
  path_not_found: 'The API accepted your key but did not find the path Chickpea tried.',
  unreachable: 'Chickpea could not reach the API to confirm that your key works.',
  inconclusive: 'Chickpea could not confirm that your key works.',
};

function keySavedText(check: string | undefined): string | undefined {
  return check !== undefined && Object.hasOwn(KEY_SAVED_TEXT, check)
    ? KEY_SAVED_TEXT[check as KeySavedCheck]
    : undefined;
}

class SetupKeyRejectedError extends Error {
  constructor(host: string) {
    super(`${host} rejected this key. Check that you copied the whole key, then try again.`);
  }
}

/** The API connection an API setup's key is for, so the page can show where the key goes. */
async function setupDestination(
  setup: ManagementSetupRecord,
  dependencies: SetupDependencies,
): Promise<ApiConnectionScope | undefined> {
  if (setup.action !== 'api_credential') return undefined;
  const policy = (await setupConnectionEntry(setup, dependencies))?.account.policy;
  return policy?.kind === 'api' ? policy : undefined;
}

function destinationRows(connection: ApiConnectionScope): string {
  const methods = connection.allowedMethods.map((method) => method.toUpperCase());
  const access = methods.every((method) => method === 'GET' || method === 'HEAD') ? 'Read only' : 'Read and write';
  return `<div><dt>Key sent only to</dt><dd>${connectionUrlPrefixes(connection).map(escapeHtml).join('<br>')}</dd></div>
    <div><dt>Allowed requests</dt><dd>${escapeHtml(`${access} (${methods.join(', ')})`)}</dd></div>`;
}

function renderGithubManifestPost(target: string, manifest: unknown): string {
  return renderSetupPanelPage({
    title: 'Continue to GitHub',
    surface: 'setup-github',
    content: `<h1>Continue to GitHub</h1><p>GitHub will ask which account and repositories Chickpea may use.</p><form method="post" action="${escapeHtml(target)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button type="submit">Open GitHub</button></form>`,
  });
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
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; font-src 'self'; script-src 'nonce-setup'; connect-src 'self'; img-src 'self' data:; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'");
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

// Deliberately narrower than admin's requestOrigin: setup origins feed CSRF
// comparisons and externally registered OAuth/GitHub callback URLs, so only
// the pinned public URL or the request URL itself may define them — never
// forwarded headers.
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
  return `${SESSION_COOKIE}-${cookieSuffix(setupId)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
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

function safeFailureCode(error: unknown): string {
  if (error instanceof SetupKeyRejectedError) return 'key_rejected';
  if (error instanceof ManagementError) return error.code;
  if (error instanceof McpOAuthError) return error.code;
  if (error instanceof AgentConnectionCredentialConflictError) return 'target_changed';
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
