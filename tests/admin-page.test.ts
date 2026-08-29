import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';

import { renderAdminPage } from '../src/admin/page.ts';
import { connectorSkillsForConnections } from '../src/config/connector-skills.ts';
import {
  CONNECTION_CATALOG_PRESETS,
} from '../src/config/presets.ts';
import { seededAgents } from '../src/config/seed.ts';

test('connection removal retries a schedule cleanup race once', () => {
  const page = renderAdminPage();
  assert.match(
    page,
    /disconnectWithCleanupRetry[^]*connection_schedule_changed[^]*api\(path, \{ method: "DELETE" \}\)/,
  );
  assert.match(
    page,
    /allowRetry[^]*connection_schedule_changed[^]*postJson\(revokePath, "POST", \{\}\)/,
  );
});

test('admin navigation omits the unimplemented account destination', () => {
  const html = renderAdminPage();
  assert.doesNotMatch(html, /href="\/admin\/account"|>Account<\/a>/);
});

test('the dedicated onboarding frame remains document-scrollable on desktop', () => {
  const html = renderAdminPage();
  assert.match(
    html,
    /\.frame\.onboarding-frame\s*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s,
  );
});

test('Destinations uses the shared Admin scale instead of prototype-sized chrome', () => {
  const html = renderAdminPage();
  assert.match(html, /\.destination-page\s*\{[^}]*max-width:\s*760px;/s);
  assert.match(html, /\.destination-hero-logo\s*\{[^}]*height:\s*48px;[^}]*width:\s*48px;/s);
  assert.match(html, /\.destination-hero \.page-title\s*\{[^}]*line-height:\s*1\.1;/s);
  assert.doesNotMatch(html, /\.destination-hero \.page-title\s*\{[^}]*font-size:/s);
  assert.match(html, /\.destination-overview-card\s*\{[^}]*min-height:\s*96px;[^}]*padding:\s*16px 18px;/s);
  assert.match(html, /\.destination-summary-icon\s*\{[^}]*height:\s*42px;[^}]*width:\s*42px;/s);
  assert.match(html, /\.destination-rail-logo\s*\{[^}]*height:\s*34px;[^}]*width:\s*34px;/s);
  assert.match(html, /\.destination-rail-name\s*\{[^}]*font-size:\s*\.8125rem;/s);
});

interface FakeResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

interface FakeElement {
  innerHTML: string;
  className?: string;
}

interface FakeRegion {
  inert: boolean;
  attributes: Record<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

interface FakeTarget {
  closest(selector: string): FakeTarget | null;
  getAttribute(name: string): string | null;
}

interface FakeDetailsElement extends FakeTarget {
  open: boolean;
  removeAttribute(name: string): void;
  querySelector(selector: string): { focus(): void } | null;
}

interface FakeSubmitTarget extends FakeTarget {
  __formData: Record<string, string>;
}

type Listener = (event: { target: FakeTarget; key?: string; shiftKey?: boolean; preventDefault?(): void }) => void;
type AssignmentFixture = {
  workspaceId: string;
  channelId: string;
  channelLabel?: string;
  agentId: string;
  enabled: boolean;
};
type SlackConnectionFixture = {
  connected: boolean;
  credentials: { botToken: string; signingSecret: string; botUserId: string };
  health?: 'pending' | 'healthy' | 'needs_attention' | 'revoked' | 'degraded';
  healthDetail?: string | null;
  transportMode?: 'direct' | 'gateway';
  teamId?: string | null;
  teamName?: string | null;
  requestUrl: string;
  manifestUrl: string;
};
type SlackChannelFixture = { id: string; name: string; isPrivate?: boolean; isMember?: boolean };
type SlackChannelsFixture = {
  channels: SlackChannelFixture[];
  teamId: string;
  teamName: string;
  truncated?: boolean;
};
type OnboardingFixture = {
  stage: 'connect_slack' | 'choose_provider' | 'choose_model' | 'try' | 'complete';
  revision: string;
  workspace: { id: string; name: string | null } | null;
  channel: { id: string; name: string } | null;
  providerId?: 'cloudflare' | 'anthropic' | 'openai' | 'openrouter' | null;
  modelId?: string | null;
  slackAppId?: string | null;
  tryStartedAt: number | null;
  completedAt: number | null;
  agentId?: string;
  redirectTo?: string;
};
type GithubStatusFixture = {
  mode: 'none' | 'app';
  appSlug?: string;
  installations?: Array<{
    id: number;
    accountLogin: string;
    accountType: 'User' | 'Organization';
    repoCount: number | null;
  }>;
  referencingProfiles?: Array<{ id: string; name: string }>;
};
type GithubRepoPageFixture = {
  repos: Array<{ fullName: string; private: boolean; defaultBranch: string }>;
  totalCount: number;
  truncated: boolean;
};

const releaseAgent = {
  id: 'agent_release',
  revision: 1,
  name: 'Release Profile',
  description: 'Release readiness profile',
  instructions: 'Answer with release context.',
  enabled: true,
  model: 'local-stub/release',
};

const opsAgent = {
  id: 'agent_ops',
  revision: 1,
  name: 'Ops Profile',
  description: 'Operations profile',
  instructions: 'Answer with operations context.',
  enabled: true,
  model: 'local-stub/ops',
};

function inlineScript(usageAdminUi = false): string {
  const script = renderAdminPage({ usageAdminUi }).match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'admin page should include one inline script');
  return script;
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

function actionTarget(attributes: Record<string, string>): FakeTarget {
  return {
    closest(selector: string) {
      return selector === '[data-action]' ? this : null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

function actionClassTarget(attributes: Record<string, string>, className: string): FakeTarget {
  return {
    closest(selector: string) {
      if (selector === '[data-action]' || selector === `.${className}`) return this;
      return null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

function valueTarget(
  attributes: Record<string, string>,
  value: string,
  checked = false,
): FakeTarget & { value: string; checked: boolean } {
  return {
    value,
    checked,
    closest() {
      return null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

function submitTarget(attributes: Record<string, string>, formData: Record<string, string>): FakeSubmitTarget {
  return {
    __formData: formData,
    closest(selector: string) {
      return selector === '[data-action]' ? this : null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

function effectiveConfig(agent: typeof releaseAgent, channelId: string): unknown {
  return {
    config: {
      workspaceId: 'T_DESIGN',
      channelId,
      agentId: agent.id,
      profile: agent,
      model: agent.model,
      provider: 'local-stub',
      instructions: `${agent.name} resolved instructions.`,
      instructionLayers: [{ source: 'profile', label: 'Profile', text: agent.instructions }],
      snapshotHash: `sha256-${channelId}`,
    },
  };
}

function defaultAssignments(): AssignmentFixture[] {
  return [
    {
      workspaceId: 'T_DESIGN',
      channelId: 'C0EXR3L9T',
      channelLabel: 'eng-releases',
      agentId: releaseAgent.id,
      enabled: true,
    },
    {
      workspaceId: 'T_DESIGN',
      channelId: 'C_OPS',
      agentId: opsAgent.id,
      enabled: true,
    },
  ];
}

type OpenAiSubscriptionStatusFixture = {
  state: 'disconnected' | 'authorizing' | 'connected' | 'account_change_confirmation_required' | 'reconnect_required' | 'error';
  updatedAt: number;
  accountFingerprint?: string;
  connectedAt?: number;
  failureCode?: string;
};
type ProviderSummaryFixture = {
  id: string;
  status: 'env' | 'stored' | 'missing';
  modelCount: number | null;
  enabled?: boolean;
  activeAuthMethod?: 'api_key' | 'subscription';
  subscription?: OpenAiSubscriptionStatusFixture;
};
type ModelProviderFixture = {
  id: string;
  configured: boolean;
  source: string;
  suggestions: string[];
  authMethods?: {
    activeMethod?: 'api_key' | 'subscription';
    apiKeyConfigured: boolean;
    subscription: OpenAiSubscriptionStatusFixture;
  };
};
type EgressPolicyFixture = {
  mode: 'allowlist' | 'open' | 'off';
  domains: string[];
};
type SandboxStatusFixture = {
  installRequested: boolean;
  installed: boolean;
  storedEnabled: boolean;
  enabled: boolean;
  instanceType: string;
  allowedHosts: string[];
  monthlySessionCap: number;
  monthlySessionCapConfigured: boolean;
  target: 'cloudflare' | 'node';
  githubConnected: boolean;
  repositoryGrantReady: boolean;
  unmetPrerequisites: string[];
  workersPaidNote: string | null;
};
type ModelCatalogStatusFixture = {
  mode: 'bundled' | 'hosted';
  source: 'bundled' | 'hosted';
  revision: number;
  generatedAt: string | null;
  checkedAt: number | null;
  nextRefreshAt: number | null;
  lkgAvailable: boolean;
};
type WorkspaceDefaultFixture = {
  workspaceId: string;
  modelId: string | null;
  revision: number;
  provenance: 'installation_bootstrap' | 'migrated_agent' | 'migrated_environment' | 'migration_pending' | 'admin_selected';
  runtimeContract: 'legacy' | 'chickpea-v1';
  live: boolean;
  inheritingAgentCount: number;
  health: {
    status: 'ready' | 'selection_required' | 'repair_required';
    providerId: string | null;
    code?: string;
    repairPath?: string;
  };
};
type ScheduledWorkFixture = {
  routine: Record<string, unknown>;
  runs: Array<Record<string, unknown>>;
  revisions: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  capability: {
    target: 'cloudflare' | 'node';
    available: boolean;
    enabled: boolean;
    reason: 'enabled' | 'unsupported_target';
  };
  limits: Record<string, number>;
};
function runAdminPageHarness(
  options: {
    assignments?: AssignmentFixture[];
    slackConnection?: SlackConnectionFixture | null;
    slackTestError?: { status: number; error: string; detail?: string };
    slackDisconnectError?: { status: number; error: string };
    initialPath?: string;
    slackChannels?: SlackChannelsFixture;
    slackChannelsFetch?: (path: string) => Promise<FakeResponse>;
    channelIndex?: Array<Record<string, unknown>>;
    channelIndexError?: { status: number; error: string; message?: string };
    onboarding?: OnboardingFixture | null;
    onboardingProviderError?: { status: number; error: string; message?: string };
    onboardingTryError?: { status: number; error: string; message?: string; workspaceDefault?: WorkspaceDefaultFixture };
    slackChannelFailures?: number;
    putIsMember?: boolean;
    putAssignmentError?: { status: number; error: string; message?: string };
    cloudflare?: boolean;
    agents?: unknown[];
    agentsGetError?: { status: number; error: string };
    agentsListOmitsPrivateUseAudience?: boolean;
    providers?: ProviderSummaryFixture[];
    openrouterFavorites?: string[];
    openrouterModels?: Array<{ id: string; context_length?: number; pricing?: Record<string, string> }>;
    workersAiFavorites?: string[];
    workersAiModels?: Array<{ id: string }>;
    workersAiEnabledError?: { status: number; error: string; message?: string };
    anthropicModels?: Array<{ id: string }>;
    openaiModels?: Array<{ id: string }>;
    openAiModelsAfterMethodSwitch?: Array<{ id: string }>;
    providerKeyReject?: { status: number; detail: string };
    providerSettingsError?: { status: number; error: string };
    openAiSubscriptionPollResult?: Record<string, unknown>;
    egressPolicy?: EgressPolicyFixture;
    sandboxStatus?: SandboxStatusFixture;
    sandboxMutationError?: { status: number; error: string; message?: string };
    clipboard?: 'available' | 'defer' | 'missing' | 'reject' | 'throw';
    modelCatalogStatus?: ModelCatalogStatusFixture;
    deferModelCatalogStatus?: boolean;
    modelCatalogRefreshError?: { status: number; error: string; message?: string };
    modelProviders?: ModelProviderFixture[];
    workspaceDefault?: WorkspaceDefaultFixture | null;
    workspaceDefaultPutError?: { status: number; error: string; current?: WorkspaceDefaultFixture };
    attachSelectionValue?: string;
    swapSelectionValue?: string;
    effectiveError?: { status: number; error: string; message?: string };
    agentWriteError?: {
      status: number;
      error: string;
      message?: string;
    };
    agentArchiveConflicts?: number;
    slackGatewayRefreshResult?: { authorizationUrl: string };
    mcpSecretPutFailures?: number;
    mcpSecretDeleteFailures?: number;
    apiConnectionSecretPutFailures?: number;
    apiConnectionSecretDeleteFailures?: number;
    skillResolution?: Record<string, unknown>;
    skillResolveError?: { status: number; error: string; message?: string };
    skillResolveFetch?: (source: string) => Promise<FakeResponse>;
    githubStatus?: GithubStatusFixture;
    settingsLoadFetch?: (path: string, method: string) => Promise<FakeResponse> | undefined;
    githubRepoPages?: Record<string, GithubRepoPageFixture>;
    githubRepoError?: { status: number; error: string; message?: string };
    githubRepoFetch?: (path: string) => Promise<FakeResponse>;
    skillBrowseDom?: boolean;
    mcpTestResult?: { ok: true; tools: Array<{ name: string; title?: string; description?: string }> } | { ok: false; code: string; message: string };
    memorySaveError?: { status: number; error: string; currentVersion?: number };
    agentSchedules?: Array<Record<string, unknown>>;
    agentSchedulesFetch?: (agentId: string, call: number) => Promise<FakeResponse>;
    agentScheduleControlFetch?: (
      agentId: string,
      scheduleId: string,
      body: Record<string, unknown>,
    ) => Promise<FakeResponse>;
    agentScheduleControlError?: { status: number; error: string; message?: string };
    agentDetailFetch?: (agentId: string, call: number) => Promise<FakeResponse>;
    memoryGetFetch?: (agentId: string, call: number) => Promise<FakeResponse>;
    scheduledWork?: ScheduledWorkFixture;
    scheduledPrivateHealth?: Array<Record<string, unknown>>;
    redactScheduledName?: boolean;
    scheduledControlError?: { status: number; error: string; message?: string };
    oauthStartResult?: { authorizationUrl: string };
    oauthStartError?: { status: number; error: string; message?: string };
    apiOAuthStartResult?: { authorizationUrl: string };
    apiOAuthStartError?: { status: number; error: string; message?: string };
    connectionAccounts?: {
      attached: Array<Record<string, unknown>>;
      managedConnectors?: {
        composio: boolean;
        canConfigure?: boolean;
        configurationReadOnly?: boolean;
        catalog?: Array<Record<string, unknown>>;
      };
    };
    composioSettings?: Record<string, unknown>;
    composioSettingsError?: {
      status: number;
      error: string;
      message?: string;
      recovery?: Record<string, unknown>;
    };
    composioSetupError?: { status: number; error: string; message?: string };
    composioRetryError?: { status: number; error: string; message?: string };
    managedPollResult?: Record<string, unknown>;
    managedPollError?: { status: number; error: string; message?: string };
    managedResourcePages?: Record<string, {
      resources: Array<{ handle: string; label: string }>;
      nextCursor?: string;
    }>;
    deferAgentPatch?: boolean;
    initialSearch?: string;
    usageAdminUi?: boolean;
    usageApiError?: boolean;
    usageCoverage?: { pricedOperationCount: number; meteredOperationCount: number };
    usageAgentLabel?: string | null;
    usageClassifierOnly?: boolean;
    usageNextCursor?: string | null;
    resetDocumentScrollOnRender?: boolean;
    modelFocusScrollTop?: number;
    initialSessionStorage?: Record<string, string>;
    providerActionMenuCount?: number;
  } = {},
): {
  app: FakeElement;
  renderHistory: string[];
  modalRoot: FakeElement;
  favContainers: Record<string, FakeElement>;
  listeners: Record<string, Listener>;
  putAssignments: unknown[];
  agentChannelPosts: Array<{ agentId: string; body: Record<string, unknown> }>;
  agentChannelDeletes: Array<{ agentId: string; workspaceId: string; channelId: string }>;
  onboardingProviderPosts: Array<Record<string, unknown>>;
  onboardingTryPosts: Array<Record<string, unknown>>;
  onboardingCompletePosts: Array<Record<string, unknown>>;
  slackBehaviorPuts: Array<Record<string, boolean>>;
  slackBehaviorGets(): number;
  slackTestCalls(): number;
  slackDisconnectCalls(): number;
  topbarRegion: FakeRegion;
  bodyRegion: FakeRegion;
  providerActionMenus: FakeDetailsElement[];
  focusedAction(): string | null;
  locationPath(): string;
  popstate(path: string): void;
  beforeunload(): { prevented: boolean; returnValue: unknown };
  historyPushes: string[];
  historyReplaces: string[];
  usageApiCalls: string[];
  scheduledApiCalls: string[];
  channelListCalls: string[];
  providerKeyPosts: Array<{ id: string; key: string }>;
  providerKeyDeletes: string[];
  openAiSubscriptionPosts: Array<{ action: string; body: Record<string, unknown> }>;
  openAiAuthMethodPuts: Array<'api_key' | 'subscription'>;
  openAiSubscriptionDisconnects(): number;
  favoritesPuts: Array<{ id: string; favorites: string[] }>;
  workersAiEnabledPuts: boolean[];
  workspaceDefaultPuts: Array<{ modelId: string; expectedRevision: number }>;
  egressPuts: EgressPolicyFixture[];
  sandboxPuts: Array<{
    enabled: boolean;
    readinessConfirmed?: boolean;
    allowedHosts: string[];
    monthlySessionCap: number;
  }>;
  sandboxAdvancedPatches: Array<{
    allowedHosts: string[];
    monthlySessionCap: number;
  }>;
  sandboxInstallCalls: Array<'POST' | 'DELETE'>;
  sandboxBuildVariableSelectedAttached(): boolean;
  modelCatalogRefreshCalls(): number;
  resolveModelCatalogStatus(result: ModelCatalogStatusFixture): void;
  agentPatchBodies: Array<{ id: string; body: Record<string, unknown> }>;
  agentPostBodies: Array<Record<string, unknown>>;
  agentArchivePosts: Array<{ id: string; body: Record<string, unknown> }>;
  skillResolvePosts: Array<{ source: string }>;
  githubRepoCalls: string[];
  settingsGetCalls: string[];
  skillBrowseFocusCalls(): number;
  skillBrowseHostUpdates(): number;
  skillBrowseHtml(): string;
  skillBrowseScrollTop(): number;
    mcpTestPosts: Array<Record<string, unknown>>;
  connectionAccountPosts: Array<{ agentId: string; body: Record<string, unknown> }>;
  managedAuthorizationPosts: Array<{ agentId: string; body: Record<string, unknown> }>;
  composioSetupPosts: Array<Record<string, unknown>>;
  composioRetryCalls(): number;
  managedPollCalls(): number;
  managedCancelCalls(): number;
  managedResourcePosts: Array<{
    agentId: string;
    connectionId: string;
    body: Record<string, unknown>;
  }>;
  oauthStartPosts: Array<{ agentId: string; connectionId: string; body: Record<string, unknown> }>;
  apiOAuthStartPosts: Array<{ agentId: string; connectionId: string; body: Record<string, unknown> }>;
  apiOAuthClientPuts: Array<{ agentId: string; connectionId: string; body: Record<string, unknown> }>;
  assignedUrls: string[];
  openedUrls: string[];
  mcpSecretPuts: Array<{ agentId: string; id: string; body: Record<string, unknown> }>;
  mcpSecretDeletes: Array<{ agentId: string; id: string; body: Record<string, unknown> }>;
  apiConnectionSecretPuts: Array<{ agentId: string; id: string; body: Record<string, unknown> }>;
  apiConnectionSecretDeletes: Array<{ agentId: string; id: string; body: Record<string, unknown> }>;
  memoryPuts: Array<Record<string, unknown>>;
  ownerMemoryGetCaches: Array<string | undefined>;
  agentScheduleGets(): number;
  agentDetailGets(): number;
  agentConnectionGets(): number;
  slackStatusGets(): number;
  setAgentSchedules(schedules: Array<Record<string, unknown>>): void;
  agentScheduleControlPosts: Array<{
    agentId: string;
    scheduleId: string;
    body: Record<string, unknown>;
    idempotencyKey: string;
  }>;
  setMemoryEntry(body: string, version: number): void;
  focusWindow(): void;
  setVisibility(state: 'hidden' | 'visible'): void;
  scheduledControlPosts: Array<{ routineId: string; body: Record<string, unknown>; idempotencyKey: string }>;
  clipboardWrites: string[];
  resolveClipboardWrite(): void;
  gallerySearchFocusCalls(): number;
  gallerySearchSelections: Array<[number, number]>;
  resolveOpsEffective(): void;
  resolveAgentPatch(): void;
  mainScrollTop(): number;
  setMainScrollTop(value: number): void;
  documentScrollTop(): number;
  setDocumentScrollTop(value: number): void;
  focusModelInput(caret?: number): void;
  modelSelectionRanges: Array<[number, number]>;
  sessionStorageValue(key: string): string | null;
} {
  const makeRegion = (): FakeRegion => ({
    inert: false,
    attributes: {},
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    },
    hasAttribute(name: string) {
      return Object.hasOwn(this.attributes, name);
    },
  });
  const resetRegion = (region: FakeRegion) => {
    region.inert = false;
    region.attributes = {};
  };
  const topbarRegion = makeRegion();
  const bodyRegion = makeRegion();
  let mainRegion = { scrollTop: 0, scrollLeft: 0 };
  let appHtml = '';
  const renderHistory: string[] = [];
  let renderGeneration = 0;
  let sandboxBuildVariableSelectedAttached = false;
  let focusedAction: string | null = null;
  let activeElement: {
    id?: string;
    selectionStart?: number;
    focus(): void;
    setSelectionRange?(start: number, end: number): void;
  } | null = null;
  const focusElements: Record<string, { id: string; focus(): void }> = {};
  const focusElement = (name: string) => {
    if (!focusElements[name]) {
      const element = {
        id: name,
        focus() {
          focusedAction = name;
          activeElement = element;
        },
      };
      focusElements[name] = element;
    }
    return focusElements[name];
  };
  const providerActionMenus: FakeDetailsElement[] = Array.from(
    { length: options.providerActionMenuCount ?? 0 },
    (_, index) => ({
      open: false,
      closest(selector: string) {
        return selector === '.provider-action-menu' ? this : null;
      },
      getAttribute() {
        return null;
      },
      removeAttribute(name: string) {
        if (name === 'open') this.open = false;
      },
      querySelector(selector: string) {
        return selector === 'summary' ? focusElement(`provider-action-menu-${index}-summary`) : null;
      },
    }),
  );
  let modelInputGeneration = -1;
  let modelDomEnabled = false;
  let modelSelectionStart = 0;
  const modelSelectionRanges: Array<[number, number]> = [];
  let modelInputElement: {
    id: string;
    selectionStart: number;
    focus(): void;
    setSelectionRange(start: number, end: number): void;
  } | null = null;
  const currentModelInput = () => {
    if (modelInputGeneration !== renderGeneration || !modelInputElement) {
      modelInputGeneration = renderGeneration;
      const element = {
        id: 'p-model',
        selectionStart: modelSelectionStart,
        focus() {
          focusedAction = 'p-model';
          activeElement = element;
          if (options.modelFocusScrollTop !== undefined) {
            documentScrollTop = options.modelFocusScrollTop;
          }
        },
        setSelectionRange(start: number, end: number) {
          modelSelectionStart = start;
          element.selectionStart = start;
          modelSelectionRanges.push([start, end]);
        },
      };
      modelInputElement = element;
    }
    return modelInputElement;
  };
  const app: FakeElement = {
    get innerHTML() {
      return appHtml;
    },
    set innerHTML(value: string) {
      appHtml = value;
      renderHistory.push(value);
      renderGeneration += 1;
      focusedAction = null;
      activeElement = null;
      resetRegion(topbarRegion);
      resetRegion(bodyRegion);
      // Replacing #app also replaces the real .main scrolling element.
      // A fresh element begins at the top unless production restores it.
      mainRegion = { scrollTop: 0, scrollLeft: 0 };
      // Browsers normally retain document position when only #app is replaced.
      // A targeted test may inject a pre-restore reset to model layout
      // clamping. Model-input focus can separately inject post-restore movement.
      if (options.resetDocumentScrollOnRender) {
        documentScrollLeft = 0;
        documentScrollTop = 0;
      }
    },
  };
  const modalRoot: FakeElement = { innerHTML: '' };
  const favContainers: Record<string, FakeElement> = {};
  const listeners: Record<string, Listener> = {};
  const putAssignments: unknown[] = [];
  const agentChannelPosts: Array<{ agentId: string; body: Record<string, unknown> }> = [];
  const agentChannelDeletes: Array<{ agentId: string; workspaceId: string; channelId: string }> = [];
  const onboardingProviderPosts: Array<Record<string, unknown>> = [];
  const onboardingTryPosts: Array<Record<string, unknown>> = [];
  const onboardingCompletePosts: Array<Record<string, unknown>> = [];
  const slackBehaviorPuts: Array<Record<string, boolean>> = [];
  let slackBehaviorGets = 0;
  let slackTestCalls = 0;
  let slackStatusGets = 0;
  let slackDisconnectCalls = 0;
  const slackGatewayRefreshResult = options.slackGatewayRefreshResult;
  const channelListCalls: string[] = [];
  const usageApiCalls: string[] = [];
  const scheduledApiCalls: string[] = [];
  const providerKeyPosts: Array<{ id: string; key: string }> = [];
  const providerKeyDeletes: string[] = [];
  const openAiSubscriptionPosts: Array<{ action: string; body: Record<string, unknown> }> = [];
  const openAiAuthMethodPuts: Array<'api_key' | 'subscription'> = [];
  let openAiSubscriptionDisconnects = 0;
  const favoritesPuts: Array<{ id: string; favorites: string[] }> = [];
  const workersAiEnabledPuts: boolean[] = [];
  const workspaceDefaultPuts: Array<{ modelId: string; expectedRevision: number }> = [];
  const egressPuts: EgressPolicyFixture[] = [];
  const sandboxPuts: Array<{
    enabled: boolean;
    readinessConfirmed?: boolean;
    allowedHosts: string[];
    monthlySessionCap: number;
  }> = [];
  const sandboxAdvancedPatches: Array<{
    allowedHosts: string[];
    monthlySessionCap: number;
  }> = [];
  const sandboxInstallCalls: Array<'POST' | 'DELETE'> = [];
  let modelCatalogRefreshCalls = 0;
  let modelCatalogStatusResolver: ((response: FakeResponse) => void) | undefined;
  let deferModelCatalogStatus = options.deferModelCatalogStatus ?? false;
  const agentPatchBodies: Array<{ id: string; body: Record<string, unknown> }> = [];
  const agentPostBodies: Array<Record<string, unknown>> = [];
  const agentArchivePosts: Array<{ id: string; body: Record<string, unknown> }> = [];
  const skillResolvePosts: Array<{ source: string }> = [];
  const githubRepoCalls: string[] = [];
  const settingsGetCalls: string[] = [];
  const mcpTestPosts: Array<Record<string, unknown>> = [];
  const connectionAccountPosts: Array<{ agentId: string; body: Record<string, unknown> }> = [];
  const managedAuthorizationPosts: Array<{ agentId: string; body: Record<string, unknown> }> = [];
  const composioSetupPosts: Array<Record<string, unknown>> = [];
  let composioRetryCalls = 0;
  let managedPollCalls = 0;
  let managedCancelCalls = 0;
  const managedResourcePosts: Array<{
    agentId: string;
    connectionId: string;
    body: Record<string, unknown>;
  }> = [];
  const oauthStartPosts: Array<{
    agentId: string;
    connectionId: string;
    body: Record<string, unknown>;
  }> = [];
  const apiOAuthStartPosts: Array<{
    agentId: string;
    connectionId: string;
    body: Record<string, unknown>;
  }> = [];
  const apiOAuthClientPuts: Array<{
    agentId: string;
    connectionId: string;
    body: Record<string, unknown>;
  }> = [];
  const assignedUrls: string[] = [];
  const openedUrls: string[] = [];
  const mcpSecretPuts: Array<{ agentId: string; id: string; body: Record<string, unknown> }> = [];
  const mcpSecretDeletes: Array<{ agentId: string; id: string; body: Record<string, unknown> }> = [];
  const apiConnectionSecretPuts: Array<{ agentId: string; id: string; body: Record<string, unknown> }> = [];
  const apiConnectionSecretDeletes: Array<{ agentId: string; id: string; body: Record<string, unknown> }> = [];
  const memoryPuts: Array<Record<string, unknown>> = [];
  const ownerMemoryGetCaches: Array<string | undefined> = [];
  let agentScheduleGets = 0;
  const agentScheduleControlPosts: Array<{
    agentId: string;
    scheduleId: string;
    body: Record<string, unknown>;
    idempotencyKey: string;
  }> = [];
  let agentDetailGets = 0;
  let agentConnectionGets = 0;
  let memoryGetCalls = 0;
  const scheduledControlPosts: Array<{ routineId: string; body: Record<string, unknown>; idempotencyKey: string }> = [];
  const clipboardWrites: string[] = [];
  let clipboardWriteResolver: (() => void) | null = null;
  let gallerySearchFocusCalls = 0;
  let skillBrowseFocusCalls = 0;
  let skillBrowseHostUpdates = 0;
  let skillBrowseList = { scrollTop: 137 };
  let skillBrowseHtml = '';
  const skillBrowseHost = {
    get innerHTML() {
      return skillBrowseHtml;
    },
    set innerHTML(value: string) {
      skillBrowseHtml = value;
      // Real innerHTML replacement destroys the old subtree. The new list
      // starts at zero so production must explicitly restore its scroll.
      skillBrowseList = { scrollTop: 0 };
    },
    querySelector(selector: string) {
      return selector === '.repo-picker-list' ? skillBrowseList : null;
    },
  };
  const gallerySearchSelections: Array<[number, number]> = [];
  const mcpTestResult = options.mcpTestResult;
  let assignments = options.assignments ?? defaultAssignments();
  const slackConnection = options.slackConnection === undefined ? connectedSlackFixture() : options.slackConnection;
  const slackChannels = options.slackChannels;
  const slackChannelsFetch = options.slackChannelsFetch;
  let onboarding = options.onboarding ?? null;
  const onboardingProviderError = options.onboardingProviderError;
  const onboardingTryError = options.onboardingTryError;
  const putIsMember = options.putIsMember;
  const putAssignmentError = options.putAssignmentError;
  let slackChannelFailures = options.slackChannelFailures ?? 0;
  // Captured out here because the fetch parameter below is also named `options`
  // (the request init) and would otherwise shadow these harness fixtures.
  const agentsFixture = options.agents;
  const providerKeyReject = options.providerKeyReject;
  const providerSettingsError = options.providerSettingsError;
  const slackTestError = options.slackTestError;
  const slackDisconnectError = options.slackDisconnectError;
  const modelProviders = options.modelProviders;
  const openAiModelsAfterMethodSwitch = options.openAiModelsAfterMethodSwitch;
  const effectiveError = options.effectiveError;
  const agentWriteError = options.agentWriteError;
  let agentArchiveConflicts = options.agentArchiveConflicts ?? 0;
  let mcpSecretPutFailures = options.mcpSecretPutFailures ?? 0;
  let mcpSecretDeleteFailures = options.mcpSecretDeleteFailures ?? 0;
  let apiConnectionSecretPutFailures = options.apiConnectionSecretPutFailures ?? 0;
  let apiConnectionSecretDeleteFailures = options.apiConnectionSecretDeleteFailures ?? 0;
  const skillResolveError = options.skillResolveError;
  const skillResolveFetch = options.skillResolveFetch;
  const skillResolution = options.skillResolution;
  const oauthStartResult = options.oauthStartResult;
  const oauthStartError = options.oauthStartError;
  const apiOAuthStartResult = options.apiOAuthStartResult;
  const apiOAuthStartError = options.apiOAuthStartError;
  const deferAgentPatch = options.deferAgentPatch === true;
  const githubStatus = options.githubStatus;
  const settingsLoadFetch = options.settingsLoadFetch;
  const githubRepoPages = options.githubRepoPages;
  const githubRepoError = options.githubRepoError;
  const githubRepoFetch = options.githubRepoFetch;
  let resolveOpsEffective: (() => void) | undefined;
  let memoryEntry = {
    body: 'Run <script>alert(1)</script> before release.',
    version: 1, modifiedAt: 1753444800000,
  };
  let agentSchedules = (options.agentSchedules ?? []).map((schedule) => ({ ...schedule }));
  const scheduledFixture: ScheduledWorkFixture = options.scheduledWork ?? {
    routine: {
      id: 'routine_release_digest', workspaceId: 'T_DESIGN', channelId: 'C0EXR3L9T',
      creatorUserId: 'U_CREATOR', name: 'Release readiness check', description: 'Check launch readiness every weekday.',
      state: 'active', version: 2, triggerKind: 'schedule', scheduleInput: 'weekdays at 9:00 AM',
      scheduleJson: '{"kind":"cron","expression":"0 9 * * 1-5"}', timezone: 'America/Los_Angeles',
      outputPolicy: 'post', authorityMode: 'live_channel_v1', taskText: 'Review open launch blockers and resolve anything safe to change.',
      nextRunAt: 1785168000000, lastScheduledAt: 1785081600000, lastFinishedAt: 1785081660000,
      consecutiveFailures: 0, projectedDailyStarts: 1, createdAt: 1784908800000, updatedAt: 1785081660000,
      pausedAt: null, pausedReason: null, disabledAt: null, disabledReason: null, deletedAt: null,
    },
    runs: [{
      id: 'rrun_release_digest_1', routineId: 'routine_release_digest', routineVersion: 2,
      scheduledFor: 1785081600000, triggerSource: 'scheduled', requestedBy: null, status: 'succeeded',
      failureClass: null, publicError: null, queuedAt: 1785081600000, admittedAt: 1785081601000,
      startedAt: 1785081602000, finishedAt: 1785081660000, resolvedAccessHash: 'access_hash_123',
      resolvedAgentId: 'agent_release', model: 'anthropic/claude-sonnet-4', inputTokens: 1200,
      outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costEstimate: 0.009,
      costUnit: 'USD', toolCallCount: 3, deliveryStatus: 'delivered', deliveryChannelId: 'C0EXR3L9T',
      deliveryMessageTs: '1785081660.000100', suppressedAsNoOp: false, missedSlotCount: 0,
      skipReason: null, flueRunId: 'flue_run_release_1', traceId: 'trace_release_1',
    }],
    revisions: [{
      routineId: 'routine_release_digest', version: 2,
      definition: { name: 'Release readiness check' }, definitionHash: 'definition_hash_2',
      actorId: 'U_CREATOR', actorClass: 'member', createdAt: 1785000000000,
      provenance: {
        sourceKind: 'slack_request',
        requestText: 'Every weekday, review launch blockers and resolve anything safe to change.',
        requestHash: 'source_request_hash_2', eventId: 'Ev_release_routine',
        messageTs: '1785000000.000100', threadTs: '1785000000.000100',
        sourceRoutineId: 'routine_release_source', sourceRoutineVersion: 1,
        authoritySource: 'current_request', definitionHash: 'definition_hash_2',
      },
    }],
    events: [{
      eventId: 'audit_routine_update', eventType: 'routine_updated', outcome: 'succeeded',
      actorClass: 'member', actorId: 'U_CREATOR', workspaceId: 'T_DESIGN', channelId: 'C0EXR3L9T',
      subjectId: 'routine_release_digest', subjectVersion: 2, createdAt: 1785000000000,
    }],
    capability: { target: 'cloudflare', available: true, enabled: true, reason: 'enabled' },
    limits: {
      activeDeployment: 100, activeChannel: 20, concurrentDeploymentRuns: 4,
      scheduledStartsPerRoutinePerDay: 300, scheduledStartsPerDay: 600,
      runNowStartsPerDay: 10, totalStartsRollingDay: 610,
      minimumIntervalMinutes: 5, occurrenceDeadlineMinutes: 15, retentionDays: 365,
    },
  };
  let resolveAgentPatch: (() => void) | undefined;
  const location = {
    pathname: options.initialPath ?? '/admin/channels',
    search: options.initialSearch ?? '',
    assign(url: string) {
      assignedUrls.push(String(url));
    },
  };
  const historyPushes: string[] = [];
  const historyReplaces: string[] = [];
  const applyHistoryPath = (path: string) => {
    const next = new URL(String(path), 'http://admin.test');
    location.pathname = next.pathname;
    location.search = next.search;
  };
  const history = {
    pushState(_state: unknown, _title: string, path: string) {
      applyHistoryPath(path);
      historyPushes.push(String(path));
    },
    replaceState(_state: unknown, _title: string, path: string) {
      applyHistoryPath(path);
      historyReplaces.push(String(path));
    },
  };
  const windowListeners: Record<string, (event: Record<string, unknown>) => void> = {};
  let documentVisibilityState: 'hidden' | 'visible' = 'visible';
  let documentScrollLeft = 0;
  let documentScrollTop = 0;
  const window = {
    get scrollX() { return documentScrollLeft; },
    get scrollY() { return documentScrollTop; },
    get pageXOffset() { return documentScrollLeft; },
    get pageYOffset() { return documentScrollTop; },
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      windowListeners[type] = listener;
    },
    scrollTo(left: number, top: number) {
      documentScrollLeft = Number(left) || 0;
      documentScrollTop = Number(top) || 0;
    },
    setTimeout() { return 1; },
    confirm() { return true; },
    open(url?: string) {
      if (url && url !== 'about:blank') {
        openedUrls.push(String(url));
      }
      return {
        opener: null,
        closed: false,
        location: {
          assign(url: string) {
            openedUrls.push(String(url));
            assignedUrls.push(String(url));
          },
        },
        close() {},
      };
    },
  };
  const sessionValues = new Map<string, string>(
    Object.entries(options.initialSessionStorage ?? {}),
  );
  const sessionStorage = {
    getItem(key: string) { return sessionValues.get(key) ?? null; },
    setItem(key: string, value: string) { sessionValues.set(key, value); },
    removeItem(key: string) { sessionValues.delete(key); },
  };

  // Mutable provider state so a POST/DELETE key flips the /admin/api/providers
  // status the next loadSettings() reads (mirrors the real endpoint).
  const providerState: ProviderSummaryFixture[] =
    options.providers ?? [
      { id: 'anthropic', status: 'stored', modelCount: 10 },
      { id: 'openai', status: 'missing', modelCount: null, activeAuthMethod: 'api_key', subscription: { state: 'disconnected', updatedAt: 0 } },
      { id: 'openrouter', status: 'env', modelCount: null },
      {
        id: 'workers-ai',
        status: options.cloudflare ? 'env' : 'missing',
        modelCount: null,
        enabled: true,
      },
    ];
  let egressPolicy: EgressPolicyFixture = options.egressPolicy ?? {
    mode: 'allowlist',
    domains: [],
  };
  let sandboxStatus: SandboxStatusFixture = options.sandboxStatus ?? {
    installRequested: false,
    installed: false,
    storedEnabled: false,
    enabled: false,
    instanceType: 'standard-1',
    allowedHosts: ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'],
    monthlySessionCap: 0,
    monthlySessionCapConfigured: false,
    target: options.cloudflare ? 'cloudflare' : 'node',
    githubConnected: false,
    repositoryGrantReady: false,
    unmetPrerequisites: options.cloudflare
      ? ['sandbox_binding', 'github_app', 'repository_grant']
      : ['cloudflare_target', 'sandbox_binding', 'github_app', 'repository_grant'],
    workersPaidNote: options.cloudflare
      ? 'Requires Workers Paid. Real containers run on your Cloudflare account; a typical session costs about 1 cent.'
      : null,
  };
  const sandboxMutationError = options.sandboxMutationError;
  let modelCatalogStatus: ModelCatalogStatusFixture = options.modelCatalogStatus ?? {
    mode: 'hosted',
    source: 'bundled',
    revision: 0,
    generatedAt: null,
    checkedAt: null,
    nextRefreshAt: null,
    lkgAvailable: false,
  };
  let workspaceDefault: WorkspaceDefaultFixture | null = options.workspaceDefault === undefined
    ? {
        workspaceId: 'T_DESIGN',
        modelId: releaseAgent.model,
        revision: 2,
        provenance: 'admin_selected',
        runtimeContract: 'chickpea-v1',
        live: true,
        inheritingAgentCount: 1,
        health: { status: 'ready', providerId: 'local-stub' },
      }
    : options.workspaceDefault;
  const favoritesState: Record<string, string[]> = {
    openrouter: options.openrouterFavorites ?? ['anthropic/claude-sonnet-4', 'openai/gpt-4.1'],
    'workers-ai': options.workersAiFavorites ?? ['@cf/zai-org/glm-5.2', '@cf/moonshotai/kimi-k2.6'],
  };
  const modelsState: Record<string, unknown[]> = {
    openrouter:
      options.openrouterModels ??
      [
        { id: 'anthropic/claude-sonnet-4', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } },
        { id: 'openai/gpt-4.1', context_length: 1047576, pricing: { prompt: '0.000002', completion: '0.000008' } },
        { id: 'meta-llama/llama-3.3-70b-instruct', context_length: 131072, pricing: { prompt: '0.00000013', completion: '0.0000004' } },
      ],
    'workers-ai': options.workersAiModels ?? [{ id: '@cf/zai-org/glm-5.2' }, { id: '@cf/moonshotai/kimi-k2.7-code' }],
    ...(options.anthropicModels ? { anthropic: options.anthropicModels } : {}),
    ...(options.openaiModels ? { openai: options.openaiModels } : {}),
  };

  const document = {
    get visibilityState() {
      return documentVisibilityState;
    },
    get activeElement() {
      return activeElement;
    },
    getElementById(id: string) {
      if (id === 'app') return app;
      if (id === 'modal-root') return modalRoot;
      if (modelDomEnabled && id === 'p-model' && appHtml.includes('id="p-model"')) return currentModelInput();
      if ((id === 'slack-permission-heading' || id === 'onboarding-connected-heading' || id === 'onboarding-channel-heading') && appHtml.includes(`id="${id}"`)) {
        return focusElement(id);
      }
      if ((id.startsWith('ptab-') || id.startsWith('dtab-')) && appHtml.includes(`id="${id}"`)) {
        return focusElement(id);
      }
      if (id.startsWith('agent-schedule-') && appHtml.includes(`id="${id}"`)) {
        return focusElement(id);
      }
      // The favorites search re-renders only its own results container; hand it a
      // tracked fake element so a keystroke's filtered output is observable.
      if (id.startsWith('fav-results-')) {
        return (favContainers[id] ??= { innerHTML: '' });
      }
      if (id === 'conn-gallery-search-input') {
        return {
          focus() {
            gallerySearchFocusCalls += 1;
          },
          setSelectionRange(start: number, end: number) {
            gallerySearchSelections.push([start, end]);
          },
        };
      }
      if (id === 'skill-import-browse-search' && options.skillBrowseDom) {
        return {
          value: '',
          focus() {
            skillBrowseFocusCalls += 1;
          },
          setSelectionRange() {},
        };
      }
      if (id === 'sandbox-build-variable' && appHtml.includes('id="sandbox-build-variable"')) {
        var attachedGeneration = renderGeneration;
        return {
          focus() {},
          select() {
            sandboxBuildVariableSelectedAttached = attachedGeneration === renderGeneration;
          },
        };
      }
      return null;
    },
    querySelector(selector: string) {
      if (selector === '.main-inner') return app;
      if (selector === '.topbar') return topbarRegion;
      if (selector === '.body') return bodyRegion;
      if (selector === '.main') return mainRegion;
      if (selector === '.provider-action-menu[open]') {
        return providerActionMenus.find((menu) => menu.open) ?? null;
      }
      if (selector === '.import-browse-host' && options.skillBrowseDom && appHtml.includes('import-browse-host')) {
        return {
          get innerHTML() {
            return skillBrowseHost.innerHTML;
          },
          set innerHTML(value: string) {
            skillBrowseHost.innerHTML = value;
            skillBrowseHostUpdates += 1;
          },
          querySelector: skillBrowseHost.querySelector.bind(skillBrowseHost),
        };
      }
      const slackFocusRole = selector.match(/^\[data-role="(slack-(?:disconnect-dialog|connection-error|disconnect-error))"\]$/)?.[1];
      if (slackFocusRole && appHtml.includes(`data-role="${slackFocusRole}"`)) {
        return focusElement(slackFocusRole);
      }
      const slackFocusAction = selector.match(/^\[data-action="(slack-disconnect-(?:cancel|open|confirm))"\]$/)?.[1];
      if (slackFocusAction && appHtml.includes(`data-action="${slackFocusAction}"`)) {
        return focusElement(slackFocusAction);
      }
      const onboardingSlackAction = selector.match(/^\[data-action="(slack-permissions-(?:open|check))"\]$/)?.[1];
      if (onboardingSlackAction && appHtml.includes(`data-action="${onboardingSlackAction}"`)) {
        return focusElement(onboardingSlackAction);
      }
      if (selector === '[data-action="mobile-agents-close"]' && appHtml.includes('data-action="mobile-agents-close"')) {
        return focusElement('mobile-agents-close');
      }
      const agentOverflowAction = selector.match(/^\[data-action="(agent-lifecycle-(?:enable|disable)|delete-profile|archive-profile|restore-profile)"\]$/)?.[1];
      if (agentOverflowAction && appHtml.includes(`data-action="${agentOverflowAction}"`)) {
        return focusElement(agentOverflowAction);
      }
      if (selector === '[data-action="agent-overflow-toggle"]' && appHtml.includes('data-action="agent-overflow-toggle"')) {
        return focusElement('agent-overflow-toggle');
      }
      const modelPolicyAction = selector.match(/^\[data-action="(workspace-default-model|profile-model)"\]$/)?.[1];
      if (modelPolicyAction && appHtml.includes(`data-action="${modelPolicyAction}"`)) {
        return focusElement(modelPolicyAction);
      }
      const agentScheduleAction = selector.match(/^\[data-action="(agent-schedule-delete-(?:cancel|confirm))"\]$/)?.[1];
      if (agentScheduleAction && appHtml.includes(`data-action="${agentScheduleAction}"`)) {
        return focusElement(agentScheduleAction);
      }
      if (selector === '.topbar-menu > summary' && appHtml.includes('data-role="mobile-menu-trigger"')) {
        return focusElement('mobile-menu-trigger');
      }
      if (selector === '[data-role="attach-channel"]' && options.attachSelectionValue !== undefined) {
        return { value: options.attachSelectionValue };
      }
      if (selector === '[data-role="swap-profile"]' && options.swapSelectionValue !== undefined) {
        return { value: options.swapSelectionValue };
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === '.provider-action-menu[open]') {
        return providerActionMenus.filter((menu) => menu.open);
      }
      return [];
    },
    addEventListener(type: string, listener: Listener) {
      listeners[type] = listener;
    },
  };

  // Mutable so a PATCH write is reflected by the follow-up GET (saveProfile
  // re-fetches and re-clones the editor from it), mirroring the real store.
  const agentsList: Record<string, unknown>[] = (agentsFixture ?? [releaseAgent, opsAgent]).map(
    (agent) => {
      const projected = { ...(agent as Record<string, unknown>) };
      if (projected.isWorkspaceDefault === undefined) {
        projected.isWorkspaceDefault = false;
      }
      if (projected.modelPolicy === undefined) {
        projected.modelPolicy = {
          source: projected.model ? 'pinned' : 'workspace_default',
          effectiveModel: projected.model || workspaceDefault?.modelId || null,
          live: workspaceDefault?.live === true,
          ...(workspaceDefault ? { workspaceDefaultRevision: workspaceDefault.revision } : {}),
        };
      }
      if (!projected.whereItWorks) {
        projected.whereItWorks = {
          channels: assignments.filter((assignment) =>
            assignment.agentId === projected.id && assignment.workspaceId !== '*' && assignment.channelId !== '*'
          ).map((assignment) => ({
            workspaceId: assignment.workspaceId,
            channelId: assignment.channelId,
            channelName: assignment.channelLabel ?? assignment.channelId,
            status: 'active',
          })),
        };
      }
      const whereItWorks = projected.whereItWorks as Record<string, unknown>;
      if (options.agentsListOmitsPrivateUseAudience) {
        delete whereItWorks.privateUseAudience;
      } else if (whereItWorks.privateUseAudience === undefined) {
        whereItWorks.privateUseAudience = Array.isArray(whereItWorks.channels) &&
            whereItWorks.channels.length > 0
          ? 'workspace_members'
          : 'creator_only';
      }
      return projected;
    },
  );
  const harnessOptions = options;
  const usageNow = Date.now();
  const usageTotals = {
    operationCount: 3,
    completedOperationCount: 2,
    failedOperationCount: 1,
    incompleteOperationCount: 0,
    meteredOperationCount: options.usageCoverage?.meteredOperationCount ?? 2,
    pricedOperationCount: options.usageCoverage?.pricedOperationCount ?? 1,
    completedPricedOperationCount: 1,
    unknownUsageOperationCount: 1,
    unknownPriceOperationCount: 2,
    inputTokens: 1200,
    outputTokens: 300,
    cacheReadTokens: 400,
    cacheWriteTokens: 100,
    totalTokens: 2000,
    estimateAmountMicros: 12500,
  };
  const usageOperation = {
    operation: {
      operationId: 'op_usage_fixture', operationKind: 'interactive_turn', sourceId: 'source_usage', status: 'completed',
      startedAt: usageNow - 60_000, finishedAt: usageNow - 55_000, installationId: 'chickpea', workspaceId: 'T_DESIGN',
      agentId: 'agent_release', agentLabel: options.usageAgentLabel === undefined
        ? 'Release <script>alert(1)</script>'
        : options.usageAgentLabel,
      channelId: 'D_PRIVATE', channelLabel: null,
      conversationKind: 'direct_message', routineId: null, routineLabel: null, routineRunId: null,
      requestedProvider: 'openai', requestedModel: 'gpt-4.1-mini', credentialRefId: 'cred_openai_environment', credentialVersion: 1,
      coverage: 'aggregate_only', telemetrySchemaVersion: 1, createdAt: usageNow - 60_000, updatedAt: usageNow - 55_000,
    },
    measurements: [{
      executionId: 'exec_usage_fixture', operationId: 'op_usage_fixture', operationStatus: 'completed', observedAt: usageNow - 55_000,
      providerRoute: 'openai', requestedProvider: 'openai', requestedModel: 'gpt-4.1-mini', returnedProvider: 'openai', returnedModel: 'gpt-4.1-mini',
      credentialRefId: 'cred_openai_environment', credentialVersion: 1, usageCompleteness: 'complete', inputTokens: 1000, outputTokens: 250,
      cacheReadTokens: 500, cacheWriteTokens: 0, totalTokens: 1750, usageUnknownReason: null, estimateCompleteness: 'complete', estimateAmountMicros: 12500, estimateCurrency: 'USD',
      priceVersionId: 'openai_2026-07-28', priceUnknownReason: null, recordedAt: usageNow - 55_000,
    }],
  };
  const fetch = (path: string, options?: { method?: string; body?: string; headers?: Record<string, string>; cache?: string }): Promise<FakeResponse> => {
    const method = options?.method ?? 'GET';
    if (
      method === 'GET' &&
      ['/admin/api/github/status', '/admin/api/egress', '/admin/api/sandbox/status'].includes(path)
    ) {
      settingsGetCalls.push(path);
    }
    const settingsLoadResponse = settingsLoadFetch?.(path, method);
    if (settingsLoadResponse) return settingsLoadResponse;
    if (path.startsWith('/admin/api/usage/')) {
      usageApiCalls.push(path);
      if (harnessOptions.usageApiError) return Promise.resolve(jsonResponse({ error: 'usage_unavailable' }, 503));
      if (path.startsWith('/admin/api/usage/overview')) {
        return Promise.resolve(jsonResponse({
          current: { from: usageNow - 30 * 86400000, to: usageNow, groupBy: 'channel', currency: 'USD', mixedCurrency: false, availableCurrencies: ['USD'], totals: usageTotals, groups: [{ key: 'direct_message', label: null, ...usageTotals }, { key: 'C0EXR3L9T', label: null, ...usageTotals }] },
          previous: { from: usageNow - 60 * 86400000, to: usageNow - 30 * 86400000, groupBy: 'channel', currency: 'USD', mixedCurrency: false, availableCurrencies: ['USD'], totals: { ...usageTotals, operationCount: 2, estimateAmountMicros: 10000 }, groups: [] },
        }));
      }
      if (path.startsWith('/admin/api/usage/operations')) {
        const classifierOperation = {
          ...usageOperation,
          operation: {
            ...usageOperation.operation,
            operationId: 'op_classification_fixture',
            operationKind: 'interaction_classification',
            status: 'failed',
          },
          measurements: [],
        };
        return Promise.resolve(jsonResponse({
          items: harnessOptions.usageClassifierOnly
            ? [classifierOperation]
            : [usageOperation, classifierOperation],
          nextCursor: harnessOptions.usageNextCursor ?? null,
        }));
      }
      if (path === '/admin/api/usage/metadata') {
        return Promise.resolve(jsonResponse({
          generatedAt: usageNow,
          contract: { usageSource: 'model_response_aggregate', monetarySource: 'chickpea_list_price_estimate', providerBillingIncluded: false, limitsManagedByChickpea: false },
          guidance: [{ providerId: 'openai', displayName: 'OpenAI', authModes: ['API key'], runtimeCoverage: 'metered', priceCoverage: 'release_pinned', scopeGuidance: 'Use a dedicated project key.', accountBoundary: 'Provider totals can include work outside Chickpea.', limitsUrl: 'https://platform.openai.com/docs/guides/production-best-practices/managing-billing-limits', pricingUrl: 'https://developers.openai.com/api/docs/pricing', reviewedAt: usageNow }],
          catalogs: [{ id: 'openai_2026-07-28', providerId: 'openai', sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-4.1-mini', reviewedAt: usageNow, staleAfter: usageNow + 86400000, currency: 'USD', models: ['gpt-4.1-mini'] }],
          credentials: [{ credentialRefId: 'cred_openai_environment', version: 1, providerId: 'openai', sourceKind: 'environment', label: 'OpenAI environment key', scopeLabel: null, unknownRotation: true, activeFrom: usageNow - 86400000, retiredAt: null }],
          retention: { rawRetentionDays: 90, aggregateRetentionMonths: 13, lastRunAt: usageNow, rawRetainedFrom: usageNow - 90 * 86400000, aggregateRetainedFrom: usageNow - 395 * 86400000 },
          lifecycleEvents: [{ eventId: 'usage:catalog:test', domain: 'usage', eventType: 'usage.catalog_installed', outcome: 'success', actorClass: 'system', actorId: null, workspaceId: null, channelId: null, storeId: null, subjectId: 'openai_2026-07-28', subjectVersion: 1, createdAt: usageNow, reasonCode: null, beforeHash: null, afterHash: null, metadataJson: '{}', idempotencyKey: 'usage:catalog:test' }],
        }));
      }
    }
    if (path.startsWith('/admin/api/audit/scheduled_work/routines') && method === 'GET') {
      scheduledApiCalls.push(path);
      const detailMatch = path.match(/^\/admin\/api\/audit\/scheduled_work\/routines\/([^/?]+)$/);
      if (detailMatch) {
        const routineId = decodeURIComponent(detailMatch[1] as string);
        if (routineId !== scheduledFixture.routine.id) return Promise.resolve(jsonResponse({ error: 'routine_not_found' }, 404));
        return Promise.resolve(jsonResponse({
          routine: { ...scheduledFixture.routine, ...(harnessOptions.redactScheduledName ? { name: null, description: null } : {}) },
          runs: scheduledFixture.runs.map((run) => ({ ...run })),
          revisions: scheduledFixture.revisions.map((revision) => ({ ...revision })),
          events: scheduledFixture.events.map((event) => ({ ...event })),
          capability: { ...scheduledFixture.capability },
          limits: { ...scheduledFixture.limits },
        }));
      }
      const url = new URL(path, 'http://admin.test');
      const stateFilter = url.searchParams.get('state');
      const channelFilter = url.searchParams.get('channelId');
      const workspaceFilter = url.searchParams.get('workspaceId');
      const routine = scheduledFixture.routine;
      const stateMatches = !stateFilter ||
        (stateFilter === 'current' && ['active', 'paused'].includes(String(routine.state))) ||
        (stateFilter === 'all' && routine.state !== 'deleted') ||
        routine.state === stateFilter;
      const included = stateMatches &&
        (!channelFilter || routine.channelId === channelFilter) &&
        (!workspaceFilter || routine.workspaceId === workspaceFilter);
      const summary = { ...routine };
      delete summary.taskText;
      if (harnessOptions.redactScheduledName) {
        summary.name = null;
        summary.description = null;
      }
      return Promise.resolve(jsonResponse({
        routines: included ? [summary] : [],
        privateScheduleHealth: channelFilter
          ? []
          : (harnessOptions.scheduledPrivateHealth ?? []).map((entry) => ({ ...entry })),
        nextCursor: null,
        capability: { ...scheduledFixture.capability },
        limits: { ...scheduledFixture.limits },
      }));
    }
    const scheduledControlMatch = path.match(/^\/admin\/api\/audit\/scheduled_work\/routines\/([^/]+)\/control$/);
    if (scheduledControlMatch && method === 'POST') {
      const routineId = decodeURIComponent(scheduledControlMatch[1] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      scheduledControlPosts.push({
        routineId,
        body,
        idempotencyKey: options?.headers?.['idempotency-key'] ?? '',
      });
      if (harnessOptions.scheduledControlError) {
        return Promise.resolve(jsonResponse(harnessOptions.scheduledControlError, harnessOptions.scheduledControlError.status));
      }
      const action = String(body.action || '');
      scheduledFixture.routine = {
        ...scheduledFixture.routine,
        state: action === 'delete' ? 'deleted' : action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'disabled',
        version: Number(scheduledFixture.routine.version || 0) + 1,
        ...(action === 'delete' ? { taskText: null, deletedAt: 1785081700000 } : {}),
      };
      return Promise.resolve(jsonResponse({ routine: { ...scheduledFixture.routine }, ...(action === 'delete' ? { irreversible: true } : {}) }));
    }
    const agentMemoryMatch = path.match(/^\/admin\/api\/agents\/([^/]+)\/memory$/);
    if (agentMemoryMatch && method === 'GET') {
      ownerMemoryGetCaches.push(options?.cache);
      memoryGetCalls += 1;
      if (harnessOptions.memoryGetFetch) {
        return harnessOptions.memoryGetFetch(
          decodeURIComponent(agentMemoryMatch[1] as string),
          memoryGetCalls,
        );
      }
      return Promise.resolve(jsonResponse({
        memory: {
          agentId: decodeURIComponent(agentMemoryMatch[1] as string),
          body: memoryEntry.body,
          revision: memoryEntry.version,
        },
      }));
    }
    if (agentMemoryMatch && method === 'PUT') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      memoryPuts.push(body);
      if (harnessOptions.memorySaveError) {
        return Promise.resolve(jsonResponse(
          harnessOptions.memorySaveError,
          harnessOptions.memorySaveError.status,
        ));
      }
      memoryEntry = {
        ...memoryEntry,
        body: String(body.body ?? ''),
        version: memoryEntry.version + 1,
        modifiedAt: memoryEntry.modifiedAt + 1000,
      };
      return Promise.resolve(jsonResponse({
        memory: {
          agentId: decodeURIComponent(agentMemoryMatch[1] as string),
          body: memoryEntry.body,
          revision: memoryEntry.version,
        },
      }));
    }
    if (path === '/admin/api/connections?workspaceId=T_DESIGN' && method === 'GET') {
      return Promise.resolve(jsonResponse({
        accounts: [
          {
            account: {
              id: 'connection_zendesk', workspaceId: 'T_DESIGN', ownerKind: 'team',
              providerId: 'zendesk', label: 'Support Zendesk', purpose: 'Customer support',
              lifecycle: 'ready', credentialConfigured: true,
            },
            agents: [{ id: 'agent_release', name: 'Release Profile' }],
          },
          {
            account: {
              id: 'connection_youtube', workspaceId: 'T_DESIGN', ownerKind: 'member',
              providerId: 'google', label: 'YouTube · Personal', lifecycle: 'needs_attention',
              credentialConfigured: false,
              policy: {
                kind: 'managed', adapterId: 'composio', toolkit: 'youtube',
                allowedCapabilities: ['YOUTUBE_SEARCH_YOU_TUBE'],
              },
            },
            agents: [],
            reconnectAgentId: 'agent_release',
          },
        ],
      }));
    }
    if (path === '/admin/api/settings/connectors/composio' && method === 'GET') {
      if (harnessOptions.composioSettingsError) {
        return Promise.resolve(jsonResponse(
          harnessOptions.composioSettingsError,
          harnessOptions.composioSettingsError.status,
        ));
      }
      return Promise.resolve(jsonResponse(harnessOptions.composioSettings ?? {
        provider: {
          source: 'missing', configured: false, readOnly: false,
          desiredState: 'enabled', generation: 0, reconciliationPending: false,
          connectors: [],
        },
        canConfigure: true,
        impact: { accounts: 0, schedules: 0 },
        catalog: managedSettingsCatalogFixture(),
      }));
    }
    if (path === '/admin/api/settings/connectors/composio/setup' && method === 'POST') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      composioSetupPosts.push(body);
      if (harnessOptions.composioSetupError) {
        return Promise.resolve(jsonResponse(
          harnessOptions.composioSetupError,
          harnessOptions.composioSetupError.status,
        ));
      }
      const readyCatalog = managedSettingsCatalogFixture();
      const provider = {
        source: 'stored', configured: true, readOnly: false,
        desiredState: 'enabled', generation: 1, reconciliationPending: false,
        connectors: readyCatalog.map((entry) => ({ toolkit: entry.toolkit, status: 'ready' })),
      };
      harnessOptions.composioSettings = {
        provider,
        canConfigure: true,
        impact: { accounts: 0, schedules: 0 },
        catalog: readyCatalog,
      };
      if (harnessOptions.connectionAccounts?.managedConnectors) {
        harnessOptions.connectionAccounts.managedConnectors.composio = true;
        harnessOptions.connectionAccounts.managedConnectors.canConfigure = true;
        harnessOptions.connectionAccounts.managedConnectors.catalog = readyCatalog;
      }
      return Promise.resolve(jsonResponse({
        provider,
        ...('continuation' in body ? { continuation: { ...(body.continuation as object), action: 'authorize' } } : {}),
      }));
    }
    if (path === '/admin/api/settings/connectors/composio/retry' && method === 'POST') {
      composioRetryCalls += 1;
      if (harnessOptions.composioRetryError) {
        return Promise.resolve(jsonResponse(
          harnessOptions.composioRetryError,
          harnessOptions.composioRetryError.status,
        ));
      }
      return Promise.resolve(jsonResponse({ provider: harnessOptions.composioSettings?.provider ?? null }));
    }
    if (path === '/admin/api/settings/connectors/composio/disable' && method === 'POST') {
      return Promise.resolve(jsonResponse({ provider: {
        source: 'missing', configured: false, readOnly: false,
        desiredState: 'disabled', generation: 2, reconciliationPending: false, connectors: [],
      } }));
    }
    const managedAuthorizationMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/connections\/managed\/start$/,
    );
    if (managedAuthorizationMatch && method === 'POST') {
      const agentId = decodeURIComponent(managedAuthorizationMatch[1] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      managedAuthorizationPosts.push({ agentId, body });
      return Promise.resolve(jsonResponse({
        authorizationUrl: 'https://connect.composio.dev/link/lk_test',
        pollUrl: `/admin/api/agents/${encodeURIComponent(agentId)}/connections/managed/poll`,
      }));
    }
    const managedPollMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/connections\/managed\/(poll|cancel)$/,
    );
    if (managedPollMatch && method === 'POST') {
      if (managedPollMatch[2] === 'cancel') {
        managedCancelCalls += 1;
        return Promise.resolve(jsonResponse({ cancelled: true }));
      }
      managedPollCalls += 1;
      if (harnessOptions.managedPollError) {
        return Promise.resolve(jsonResponse(
          harnessOptions.managedPollError,
          harnessOptions.managedPollError.status,
        ));
      }
      return Promise.resolve(jsonResponse(harnessOptions.managedPollResult ?? { status: 'pending' }, 202));
    }
    const managedResourcesMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/connections\/([^/]+)\/managed\/resources(?:\?(.+))?$/,
    );
    if (managedResourcesMatch && method === 'GET') {
      const query = new URLSearchParams(managedResourcesMatch[3] ?? '');
      const resourceKey = query.get('resourceKey') ?? '';
      const cursor = query.get('cursor') ?? '';
      const pageKey = `${resourceKey}:${cursor}`;
      return Promise.resolve(jsonResponse(
        harnessOptions.managedResourcePages?.[pageKey] ?? { resources: [] },
      ));
    }
    if (managedResourcesMatch && method === 'POST') {
      managedResourcePosts.push({
        agentId: decodeURIComponent(managedResourcesMatch[1] as string),
        connectionId: decodeURIComponent(managedResourcesMatch[2] as string),
        body: JSON.parse(options?.body ?? '{}') as Record<string, unknown>,
      });
      return Promise.resolve(jsonResponse({ account: { lifecycle: 'ready' }, binding: {} }));
    }
    const agentConnectionDeleteMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/connections\/([^/]+)$/,
    );
    if (agentConnectionDeleteMatch && method === 'DELETE') {
      const accountId = decodeURIComponent(agentConnectionDeleteMatch[2] as string);
      const accounts = harnessOptions.connectionAccounts;
      const entry = accounts?.attached.find(({ account }) =>
        (account as Record<string, unknown>).id === accountId);
      if (accounts) accounts.attached = accounts.attached.filter(({ account }) =>
        (account as Record<string, unknown>).id !== accountId);
      return Promise.resolve(jsonResponse({ account: {
        ...((entry?.account as Record<string, unknown> | undefined) ?? {}),
        lifecycle: 'revoked',
      } }));
    }
    const agentConnectionsMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/connections(?:\?workspaceId=([^&]+))?$/,
    );
    if (agentConnectionsMatch && method === 'GET') {
      agentConnectionGets += 1;
      if (harnessOptions.connectionAccounts) {
        return Promise.resolve(jsonResponse(harnessOptions.connectionAccounts));
      }
    }
    if (agentConnectionsMatch && method === 'POST') {
      const agentId = decodeURIComponent(agentConnectionsMatch[1] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      connectionAccountPosts.push({ agentId, body });
      return Promise.resolve(jsonResponse({
        account: {
          id: 'connection_created',
          workspaceId: body.workspaceId,
          ownerKind: body.ownerKind,
          providerId: body.providerId,
          label: body.label,
          purpose: body.purpose,
          policy: body.api ?? body.mcp,
          lifecycle: body.credential ? 'ready' : 'needs_attention',
          credentialConfigured: Boolean(body.credential),
        },
        binding: {
          agentId,
          connectionAccountId: 'connection_created',
          providerId: body.providerId,
          allowedCapabilities: body.allowedCapabilities ?? [],
          enabled: true,
        },
      }, 201));
    }
    const agentSchedulesMatch = path.match(/^\/admin\/api\/agents\/([^/]+)\/schedules$/);
    if (agentSchedulesMatch && method === 'GET') {
      agentScheduleGets += 1;
      if (harnessOptions.agentSchedulesFetch) {
        return harnessOptions.agentSchedulesFetch(
          decodeURIComponent(agentSchedulesMatch[1] as string),
          agentScheduleGets,
        );
      }
      return Promise.resolve(jsonResponse({
        schedules: agentSchedules.map((schedule) => ({ ...schedule })),
      }));
    }
    const agentScheduleControlMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/schedules\/([^/]+)\/control$/,
    );
    if (agentScheduleControlMatch && method === 'POST') {
      const agentId = decodeURIComponent(agentScheduleControlMatch[1] as string);
      const scheduleId = decodeURIComponent(agentScheduleControlMatch[2] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      agentScheduleControlPosts.push({
        agentId,
        scheduleId,
        body,
        idempotencyKey: options?.headers?.['idempotency-key'] ?? '',
      });
      if (harnessOptions.agentScheduleControlFetch) {
        return harnessOptions.agentScheduleControlFetch(agentId, scheduleId, body);
      }
      if (harnessOptions.agentScheduleControlError) {
        return Promise.resolve(jsonResponse(
          harnessOptions.agentScheduleControlError,
          harnessOptions.agentScheduleControlError.status,
        ));
      }
      const action = String(body.action || '');
      agentSchedules = agentSchedules.flatMap((schedule) => {
        if (schedule.id !== scheduleId) return [schedule];
        if (action === 'delete') return [];
        const status = action === 'pause' ? 'paused' : 'active';
        return [{
          ...schedule,
          status,
          version: Number(schedule.version || 0) + 1,
          actions: {
            ...(schedule.actions as Record<string, unknown> | undefined),
            pause: action === 'resume',
            resume: action === 'pause',
          },
        }];
      });
      const updated = agentSchedules.find((schedule) => schedule.id === scheduleId);
      return Promise.resolve(jsonResponse({
        schedule: updated ?? {
          id: scheduleId,
          status: 'deleted',
          version: Number(body.expectedVersion || 0) + 1,
        },
        ...(action === 'delete' ? { irreversible: true } : {}),
      }));
    }
    if (path === '/admin/api/agents' && method === 'GET') {
      if (harnessOptions.agentsGetError) {
        return Promise.resolve(jsonResponse(
          harnessOptions.agentsGetError,
          harnessOptions.agentsGetError.status,
        ));
      }
      return Promise.resolve(jsonResponse({ agents: agentsList }));
    }
    const agentGetMatch = path.match(/^\/admin\/api\/agents\/([^/]+)$/);
    if (agentGetMatch && method === 'GET') {
      const id = decodeURIComponent(agentGetMatch[1] as string);
      agentDetailGets += 1;
      if (harnessOptions.agentDetailFetch) {
        return harnessOptions.agentDetailFetch(id, agentDetailGets);
      }
      const agent = agentsList.find((candidate) => candidate.id === id);
      return Promise.resolve(agent ? jsonResponse({ agent }) : jsonResponse({ error: 'not_found' }, 404));
    }
    if (path === '/admin/api/channels' && method === 'GET') {
      if (harnessOptions.channelIndexError) {
        return Promise.resolve(jsonResponse(
          harnessOptions.channelIndexError,
          harnessOptions.channelIndexError.status,
        ));
      }
      const rawProjectedChannels: Array<Record<string, unknown>> = harnessOptions.channelIndex ?? assignments.map((assignment) => {
        const projectedAgent = agentsList.find((candidate) => candidate.id === assignment.agentId);
        return {
          workspaceId: assignment.workspaceId,
          channelId: assignment.channelId,
          channelName: assignment.channelLabel ?? assignment.channelId,
          source: 'granted',
          grants: [{
            agentId: assignment.agentId,
            agentName: projectedAgent?.name ?? assignment.agentId,
            agentEnabled: projectedAgent?.enabled !== false,
            status: 'active',
          }],
          readiness: { ready: projectedAgent?.enabled !== false, code: projectedAgent?.enabled === false ? 'agent_unavailable' : 'ready', reasons: [] },
        };
      });
      const projectedChannels = rawProjectedChannels.map((channel) => {
        if (Array.isArray(channel.grants)) return channel;
        const assignment = channel.assignment as Record<string, unknown> | null | undefined;
        return {
          ...channel,
          grants: assignment ? [{ ...assignment, status: 'active' }] : [],
        };
      });
      return Promise.resolve(jsonResponse({ channels: projectedChannels }));
    }
    if (path === '/admin/api/agents' && method === 'POST') {
      if (agentWriteError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: agentWriteError.error,
              ...(agentWriteError.message ? { message: agentWriteError.message } : {}),
            },
            agentWriteError.status,
          ),
        );
      }
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      agentPostBodies.push(body);
      agentsList.push({ ...body });
      return Promise.resolve(jsonResponse({ agent: body }, 201));
    }
    const agentArchiveMatch = path.match(/^\/admin\/api\/agents\/([^/]+)\/archive$/);
    if (agentArchiveMatch && method === 'POST') {
      const id = decodeURIComponent(agentArchiveMatch[1] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      agentArchivePosts.push({ id, body });
      const existing = agentsList.find((agent) => agent.id === id);
      if (!existing) return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
      if (agentArchiveConflicts > 0) {
        agentArchiveConflicts -= 1;
        existing.revision = Number(existing.revision ?? 1) + 1;
        return Promise.resolve(jsonResponse({ error: 'agent_revision_conflict' }, 409));
      }
      const replacementId = String(body.replacementDefaultAgentId || '');
      if (existing.isWorkspaceDefault && !replacementId) {
        return Promise.resolve(jsonResponse({ error: 'replacement_default_agent_required' }, 409));
      }
      agentsList.forEach((agent) => {
        agent.isWorkspaceDefault = agent.id === replacementId;
      });
      Object.assign(existing, {
        lifecycle: 'archived',
        enabled: false,
        revision: Number(existing.revision ?? 1) + 1,
        isWorkspaceDefault: false,
        whereItWorks: { channels: [] },
      });
      return Promise.resolve(jsonResponse({ agent: existing }));
    }
    if (path === '/admin/api/skills/resolve' && method === 'POST') {
      const body = JSON.parse(options?.body ?? '{}') as { source: string };
      skillResolvePosts.push({ source: body.source });
      if (skillResolveFetch) return skillResolveFetch(body.source);
      if (skillResolveError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: skillResolveError.error,
              ...(skillResolveError.message ? { message: skillResolveError.message } : {}),
            },
            skillResolveError.status,
          ),
        );
      }
      const resolution =
        skillResolution ?? {
          owner: 'acme',
          repo: 'skills',
          ref: 'main',
          source: { visibility: 'public', access: 'anonymous' },
          total: 2,
          capped: false,
          skipped: 0,
          skills: [
            {
              name: 'release-notes',
              description: 'Turns merged PRs into a changelog.',
              instructions: '# Release notes\nWrite in launch voice.',
              hasScripts: false,
              path: 'release-notes',
              sourceUrl: 'https://github.com/acme/skills/tree/main/release-notes',
            },
            {
              name: 'incident-scribe',
              description: 'Builds an incident timeline.',
              instructions: '# Incident scribe\nAssemble the timeline.',
              hasScripts: true,
              path: 'incident-scribe',
              sourceUrl: 'https://github.com/acme/skills/tree/main/incident-scribe',
            },
          ],
        };
      return Promise.resolve(jsonResponse({ resolution }));
    }
    if (path === '/admin/api/github/status' && method === 'GET' && githubStatus) {
      return Promise.resolve(jsonResponse(githubStatus));
    }
    if (path.startsWith('/admin/api/github/installations/') && path.includes('/repos?') && method === 'GET') {
      githubRepoCalls.push(path);
      if (githubRepoFetch) return githubRepoFetch(path);
      if (githubRepoError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: githubRepoError.error,
              ...(githubRepoError.message ? { message: githubRepoError.message } : {}),
            },
            githubRepoError.status,
          ),
        );
      }
      const installationId = path.match(/^\/admin\/api\/github\/installations\/([^/]+)\/repos/)?.[1] ?? '';
      return Promise.resolve(
        jsonResponse(
          githubRepoPages?.[decodeURIComponent(installationId)] ?? {
            repos: [],
            totalCount: 0,
            truncated: false,
          },
        ),
      );
    }
    const mcpTestMatch = path.match(/^\/admin\/api\/agents\/([^/]+)\/mcp\/test$/);
    if (mcpTestMatch && method === 'POST') {
      const agentId = decodeURIComponent(mcpTestMatch[1] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      mcpTestPosts.push({ agentId, ...body });
      const result =
        mcpTestResult ??
        {
          ok: true,
          tools: [
            { name: 'search_issues', description: 'Search issues.' },
            { name: 'create_issue', description: 'Create an issue (write).' },
          ],
        };
      // The test endpoint always answers HTTP 200 — failures ride in the body.
      return Promise.resolve(jsonResponse(result));
    }
    const oauthStartMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/mcp\/oauth\/([^/]+)\/start$/,
    );
    if (oauthStartMatch && method === 'POST') {
      const agentId = decodeURIComponent(oauthStartMatch[1] as string);
      const connectionId = decodeURIComponent(oauthStartMatch[2] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      oauthStartPosts.push({ agentId, connectionId, body });
      if (oauthStartError) {
        return Promise.resolve(jsonResponse(oauthStartError, oauthStartError.status));
      }
      return Promise.resolve(
        jsonResponse(
          oauthStartResult ?? {
            authorizationUrl: 'https://auth.notion.example/authorize?state=opaque',
          },
        ),
      );
    }
    const apiOAuthClientMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/api-connections\/oauth\/([^/]+)\/client$/,
    );
    if (apiOAuthClientMatch && method === 'PUT') {
      const agentId = decodeURIComponent(apiOAuthClientMatch[1] as string);
      const connectionId = decodeURIComponent(apiOAuthClientMatch[2] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      apiOAuthClientPuts.push({ agentId, connectionId, body });
      return Promise.resolve(jsonResponse({ source: 'stored' }));
    }
    const apiOAuthStartMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/api-connections\/oauth\/([^/]+)\/start$/,
    );
    if (apiOAuthStartMatch && method === 'POST') {
      const agentId = decodeURIComponent(apiOAuthStartMatch[1] as string);
      const connectionId = decodeURIComponent(apiOAuthStartMatch[2] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      apiOAuthStartPosts.push({ agentId, connectionId, body });
      if (apiOAuthStartError) {
        return Promise.resolve(jsonResponse(apiOAuthStartError, apiOAuthStartError.status));
      }
      return Promise.resolve(
        jsonResponse(
          apiOAuthStartResult ?? {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque',
          },
        ),
      );
    }
    const accountMcpOAuthStartMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/connections\/([^/]+)\/oauth\/mcp\/start$/,
    );
    if (accountMcpOAuthStartMatch && method === 'POST') {
      const agentId = decodeURIComponent(accountMcpOAuthStartMatch[1] as string);
      const connectionId = decodeURIComponent(accountMcpOAuthStartMatch[2] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      oauthStartPosts.push({ agentId, connectionId, body });
      return Promise.resolve(jsonResponse(
        oauthStartResult ?? { authorizationUrl: 'https://auth.linear.example/authorize?state=opaque' },
      ));
    }
    const accountApiOAuthClientMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/connections\/([^/]+)\/oauth\/api\/client$/,
    );
    if (accountApiOAuthClientMatch && method === 'PUT') {
      const agentId = decodeURIComponent(accountApiOAuthClientMatch[1] as string);
      const connectionId = decodeURIComponent(accountApiOAuthClientMatch[2] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      apiOAuthClientPuts.push({ agentId, connectionId, body });
      return Promise.resolve(jsonResponse({ source: 'stored' }));
    }
    const accountApiOAuthStartMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/connections\/([^/]+)\/oauth\/api\/start$/,
    );
    if (accountApiOAuthStartMatch && method === 'POST') {
      const agentId = decodeURIComponent(accountApiOAuthStartMatch[1] as string);
      const connectionId = decodeURIComponent(accountApiOAuthStartMatch[2] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      apiOAuthStartPosts.push({ agentId, connectionId, body });
      return Promise.resolve(jsonResponse(
        apiOAuthStartResult ?? { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque' },
      ));
    }
    const mcpSecretsMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/mcp\/secrets\/([^/]+)$/,
    );
    if (mcpSecretsMatch) {
      const agentId = decodeURIComponent(mcpSecretsMatch[1] as string);
      const id = decodeURIComponent(mcpSecretsMatch[2] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      if (method === 'PUT') {
        mcpSecretPuts.push({ agentId, id, body });
        if (mcpSecretPutFailures > 0) {
          mcpSecretPutFailures -= 1;
          return Promise.resolve(jsonResponse({ error: 'secret_store_unavailable' }, 503));
        }
        const headerNames = (body.headerNames as string[]) ?? [];
        const headers: Record<string, string> = {};
        headerNames.forEach((name) => {
          headers[name] = 'stored';
        });
        // Source-only response — the value is never echoed back.
        return Promise.resolve(jsonResponse({ bearer: body.bearerToken !== undefined ? 'stored' : 'missing', headers }));
      }
      if (method === 'DELETE') {
        mcpSecretDeletes.push({ agentId, id, body });
        if (mcpSecretDeleteFailures > 0) {
          mcpSecretDeleteFailures -= 1;
          return Promise.resolve(jsonResponse({ error: 'secret_store_unavailable' }, 503));
        }
        return Promise.resolve(jsonResponse({ ok: true }));
      }
    }
    const apiConnectionSecretsMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/api-connections\/secrets\/([^/]+)$/,
    );
    if (apiConnectionSecretsMatch) {
      const agentId = decodeURIComponent(apiConnectionSecretsMatch[1] as string);
      const id = decodeURIComponent(apiConnectionSecretsMatch[2] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      if (method === 'PUT') {
        apiConnectionSecretPuts.push({ agentId, id, body });
        if (apiConnectionSecretPutFailures > 0) {
          apiConnectionSecretPutFailures -= 1;
          return Promise.resolve(jsonResponse({ error: 'secret_store_unavailable' }, 503));
        }
        return Promise.resolve(jsonResponse({ source: 'stored' }));
      }
      if (method === 'DELETE') {
        apiConnectionSecretDeletes.push({ agentId, id, body });
        if (apiConnectionSecretDeleteFailures > 0) {
          apiConnectionSecretDeleteFailures -= 1;
          return Promise.resolve(jsonResponse({ error: 'secret_store_unavailable' }, 503));
        }
        return Promise.resolve(jsonResponse({ source: 'missing' }));
      }
    }
    const agentPatchMatch = path.match(/^\/admin\/api\/agents\/([^/]+)$/);
    const agentChannelMatch = path.match(/^\/admin\/api\/agents\/([^/]+)\/channels$/);
    const agentChannelDeleteMatch = path.match(
      /^\/admin\/api\/agents\/([^/]+)\/channels\/([^/]+)\/([^/]+)$/,
    );
    if (agentChannelDeleteMatch && method === 'DELETE') {
      const agentId = decodeURIComponent(agentChannelDeleteMatch[1] as string);
      const workspaceId = decodeURIComponent(agentChannelDeleteMatch[2] as string);
      const channelId = decodeURIComponent(agentChannelDeleteMatch[3] as string);
      agentChannelDeletes.push({ agentId, workspaceId, channelId });
      assignments = assignments.filter((assignment) => !(
        assignment.agentId === agentId
        && assignment.workspaceId === workspaceId
        && assignment.channelId === channelId
      ));
      const existing = agentsList.find((agent) => agent.id === agentId) as Record<string, any> | undefined;
      if (existing?.whereItWorks && Array.isArray(existing.whereItWorks.channels)) {
        existing.whereItWorks.channels = existing.whereItWorks.channels.filter((grant: Record<string, unknown>) => !(
          grant.workspaceId === workspaceId && grant.channelId === channelId
        ));
        existing.whereItWorks.privateUseAudience = existing.whereItWorks.channels.length > 0
          ? 'workspace_members'
          : 'creator_only';
      }
      return Promise.resolve(jsonResponse({ removed: true }));
    }
    if (agentChannelMatch && method === 'POST') {
      const agentId = decodeURIComponent(agentChannelMatch[1] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      agentChannelPosts.push({ agentId, body });
      if (putAssignmentError) {
        return Promise.resolve(jsonResponse({
          error: putAssignmentError.error,
          ...(putAssignmentError.message ? { message: putAssignmentError.message } : {}),
        }, putAssignmentError.status));
      }
      const existing = agentsList.find((agent) => agent.id === agentId) as Record<string, any> | undefined;
      const channel = slackChannels?.channels.find((candidate) => candidate.id === body.channelId);
      const grant = {
        workspaceId: body.workspaceId,
        channelId: body.channelId,
        channelName: channel?.name ?? body.channelId,
        status: 'active',
      };
      assignments = assignments.filter((assignment) => !(
        assignment.agentId === agentId
        && assignment.workspaceId === body.workspaceId
        && assignment.channelId === body.channelId
      ));
      assignments.push({
        workspaceId: String(body.workspaceId),
        channelId: String(body.channelId),
        channelLabel: String(channel?.name ?? body.channelId),
        agentId,
        enabled: true,
      });
      if (existing) {
        const projected = existing.whereItWorks && Array.isArray(existing.whereItWorks.channels)
          ? existing.whereItWorks.channels
          : [];
        const current = projected.length ? projected : assignments.filter(function (assignment) {
          return assignment.agentId === agentId && assignment.workspaceId !== '*' && assignment.channelId !== '*';
        }).map(function (assignment) {
          return {
            workspaceId: assignment.workspaceId,
            channelId: assignment.channelId,
            channelName: assignment.channelLabel || assignment.channelId,
            status: 'active',
          };
        });
        existing.whereItWorks = {
          ...(existing.whereItWorks || {}),
          privateUseAudience: channel?.isPrivate
            ? 'private_channel_members'
            : 'workspace_members',
          channels: current.concat(grant),
        };
      }
      return Promise.resolve(jsonResponse({ grant, agent: existing }));
    }
    if (agentPatchMatch && method === 'PATCH') {
      const id = decodeURIComponent(agentPatchMatch[1] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      agentPatchBodies.push({ id, body });
      if (agentWriteError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: agentWriteError.error,
              ...(agentWriteError.message ? { message: agentWriteError.message } : {}),
            },
            agentWriteError.status,
          ),
        );
      }
      const existing = agentsList.find((agent) => agent.id === id);
      const completePatch = () => {
        const { expectedRevision: _expectedRevision, ...patch } = body;
        const revision = Number(existing?.revision ?? 1) + 1;
        if (existing) Object.assign(existing, patch, { id, revision });
        return jsonResponse({ agent: { id, ...patch, revision } });
      };
      if (deferAgentPatch) {
        return new Promise((resolve) => {
          resolveAgentPatch = () => {
            resolveAgentPatch = undefined;
            resolve(completePatch());
          };
        });
      }
      return Promise.resolve(completePatch());
    }
    if (agentPatchMatch && method === 'DELETE') {
      const id = decodeURIComponent(agentPatchMatch[1] as string);
      if (agentWriteError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: agentWriteError.error,
              ...(agentWriteError.message ? { message: agentWriteError.message } : {}),
            },
            agentWriteError.status,
          ),
        );
      }
      const index = agentsList.findIndex((agent) => agent.id === id);
      if (index >= 0) agentsList.splice(index, 1);
      return Promise.resolve(jsonResponse(null, 204));
    }
    if (path === '/admin/api/onboarding' && method === 'GET') {
      return Promise.resolve(
        onboarding
          ? jsonResponse(onboarding)
          : jsonResponse({ error: 'onboarding_not_found' }, 404),
      );
    }
    if (path === '/admin/api/onboarding/provider' && method === 'POST') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      onboardingProviderPosts.push(body);
      if (onboardingProviderError) {
        return Promise.resolve(jsonResponse({
          error: onboardingProviderError.error,
          ...(onboardingProviderError.message ? { message: onboardingProviderError.message } : {}),
        }, onboardingProviderError.status));
      }
      onboarding = {
        ...(onboarding ?? {
          workspace: { id: 'T_DESIGN', name: 'Acme Inc' },
          channel: null,
          slackAppId: 'A_CHICKPEA',
        }),
        stage: 'choose_model',
        revision: JSON.stringify({ ...body, selectedProviderAt: 1_800_000_000_100 }),
        providerId: String(body.providerId) as NonNullable<OnboardingFixture['providerId']>,
        modelId: null,
        tryStartedAt: null,
        completedAt: null,
      };
      return Promise.resolve(jsonResponse(onboarding));
    }
    if (path === '/admin/api/onboarding/try' && method === 'POST') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      onboardingTryPosts.push(body);
      if (onboardingTryError) {
        return Promise.resolve(jsonResponse({
          error: onboardingTryError.error,
          ...(onboardingTryError.message ? { message: onboardingTryError.message } : {}),
          ...(onboardingTryError.workspaceDefault ? { workspaceDefault: onboardingTryError.workspaceDefault } : {}),
        }, onboardingTryError.status));
      }
      onboarding = {
        ...(onboarding ?? {}),
        stage: 'try',
        revision: JSON.stringify({ ...body, tryStartedAt: 1_800_000_000_000 }),
        workspace: onboarding?.workspace ?? { id: 'T_DESIGN', name: 'Acme Inc' },
        channel: null,
        slackAppId: onboarding?.slackAppId ?? 'A_CHICKPEA',
        providerId: onboarding?.providerId ?? null,
        modelId: String(body.modelId),
        agentId: 'agent_chickpea',
        tryStartedAt: 1_800_000_000_000,
        completedAt: null,
      };
      return Promise.resolve(jsonResponse(onboarding));
    }
    if (path === '/admin/api/onboarding/complete' && method === 'POST') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      onboardingCompletePosts.push(body);
      onboarding = {
        ...(onboarding ?? {
          workspace: { id: 'T_DESIGN', name: 'Acme Inc' },
          channel: null,
          slackAppId: 'A_CHICKPEA',
          tryStartedAt: 1_800_000_000_000,
        }),
        stage: 'complete',
        revision: JSON.stringify({ state: 'complete', completedAt: 1_800_000_005_000 }),
        completedAt: 1_800_000_005_000,
        agentId: 'agent_chickpea',
        redirectTo: '/admin/agents',
      };
      return Promise.resolve(jsonResponse(onboarding));
    }
    if (path === '/admin/api/assignments' && method === 'PUT') {
      const body = JSON.parse(options?.body ?? '{}') as AssignmentFixture;
      putAssignments.push(body);
      if (putAssignmentError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: putAssignmentError.error,
              ...(putAssignmentError.message ? { message: putAssignmentError.message } : {}),
            },
            putAssignmentError.status,
          ),
        );
      }
      assignments = [
        ...assignments.filter(
          (assignment) => assignment.workspaceId !== body.workspaceId || assignment.channelId !== body.channelId,
        ),
        body,
      ];
      return Promise.resolve(
        jsonResponse({
          // The real assignment DTO carries only the placement key + Agent.
          // Channel metadata is returned separately from the persisted Channel.
          assignment: {
            workspaceId: body.workspaceId,
            channelId: body.channelId,
            agentId: body.agentId,
          },
          channel: {
            workspaceId: body.workspaceId,
            channelId: body.channelId,
            label: body.channelLabel,
          },
          ...(putIsMember !== undefined ? { isMember: putIsMember } : {}),
        }),
      );
    }
    if (path === '/admin/api/slack-channels' || path.startsWith('/admin/api/slack-channels?')) {
      channelListCalls.push(path);
      if (slackChannelsFetch) return slackChannelsFetch(path);
      if (slackChannelFailures > 0) {
        slackChannelFailures -= 1;
        return Promise.resolve(jsonResponse({ error: 'slack_list_failed', detail: 'missing_scope' }, 502));
      }
      if (!slackChannels) {
        return Promise.resolve(jsonResponse({ error: 'slack_not_configured' }, 409));
      }
      return Promise.resolve(
        jsonResponse({
          channels: slackChannels.channels.map((channel) => ({
            id: channel.id,
            name: channel.name,
            isPrivate: channel.isPrivate ?? false,
            isMember: channel.isMember ?? true,
          })),
          teamId: slackChannels.teamId,
          teamName: slackChannels.teamName,
          truncated: slackChannels.truncated ?? false,
        }),
      );
    }
    if (path === '/admin/api/assignments') {
      return Promise.resolve(
        jsonResponse({
          assignments,
        }),
      );
    }
    if (path === '/admin/api/models') {
      const workersAiEnabled = providerState.find((provider) => provider.id === 'workers-ai')?.enabled !== false;
      return Promise.resolve(jsonResponse({
        providers: (modelProviders ?? []).filter(
          (provider) => workersAiEnabled || provider.id !== 'cloudflare',
        ).map((provider) => {
          const summaryId = provider.id === 'cloudflare' ? 'workers-ai' : provider.id;
          const summary = providerState.find((candidate) => candidate.id === summaryId);
          return {
            ...provider,
            configured: provider.configured || summary?.status === 'stored' || summary?.status === 'env',
          };
        }),
      }));
    }
    if (path === '/admin/api/workspace-model-default') {
      if (method === 'PUT') {
        const body = JSON.parse(options?.body ?? '{}') as { modelId: string; expectedRevision: number };
        workspaceDefaultPuts.push(body);
        if (harnessOptions.workspaceDefaultPutError) {
          const current = harnessOptions.workspaceDefaultPutError.current ?? workspaceDefault;
          return Promise.resolve(jsonResponse({
            error: harnessOptions.workspaceDefaultPutError.error,
            ...(current ? { workspaceDefault: current } : {}),
          }, harnessOptions.workspaceDefaultPutError.status));
        }
        if (!workspaceDefault) {
          return Promise.resolve(jsonResponse({ error: 'workspace_installation_required' }, 409));
        }
        workspaceDefault = {
          ...workspaceDefault,
          modelId: body.modelId,
          revision: workspaceDefault.revision + 1,
          provenance: 'admin_selected',
          health: {
            status: 'ready',
            providerId: body.modelId.slice(0, body.modelId.indexOf('/')),
          },
        };
      }
      return Promise.resolve(workspaceDefault
        ? jsonResponse({ workspaceDefault: { ...workspaceDefault } })
        : jsonResponse({ error: 'workspace_installation_required' }, 409));
    }
    if (path === '/admin/api/model-catalog') {
      if (deferModelCatalogStatus) {
        deferModelCatalogStatus = false;
        return new Promise<FakeResponse>((resolve) => {
          modelCatalogStatusResolver = resolve;
        });
      }
      return Promise.resolve(jsonResponse({ ...modelCatalogStatus }));
    }
    if (path === '/admin/api/model-catalog/refresh' && method === 'POST') {
      modelCatalogRefreshCalls += 1;
      if (harnessOptions.modelCatalogRefreshError) {
        return Promise.resolve(jsonResponse(
          {
            error: harnessOptions.modelCatalogRefreshError.error,
            ...(harnessOptions.modelCatalogRefreshError.message
              ? { message: harnessOptions.modelCatalogRefreshError.message }
              : {}),
          },
          harnessOptions.modelCatalogRefreshError.status,
        ));
      }
      modelCatalogStatus = {
        ...modelCatalogStatus,
        source: modelCatalogStatus.mode === 'hosted' ? 'hosted' : 'bundled',
        revision: modelCatalogStatus.mode === 'hosted'
          ? Math.max(1, modelCatalogStatus.revision)
          : 0,
      };
      return Promise.resolve(jsonResponse({
        refresh: { status: 'activated', revision: modelCatalogStatus.revision },
        catalog: { ...modelCatalogStatus },
      }));
    }
    if (path === '/admin/api/providers') {
      if (providerSettingsError) {
        return Promise.resolve(
          jsonResponse({ error: providerSettingsError.error }, providerSettingsError.status),
        );
      }
      return Promise.resolve(jsonResponse({ providers: providerState.map((p) => ({ ...p })) }));
    }
    if (path === '/admin/api/providers/workers-ai/enabled' && method === 'PUT') {
      const body = JSON.parse(options?.body ?? '{}') as { enabled?: boolean };
      const enabled = body.enabled === true;
      workersAiEnabledPuts.push(enabled);
      if (harnessOptions.workersAiEnabledError) {
        return Promise.resolve(jsonResponse(
          {
            error: harnessOptions.workersAiEnabledError.error,
            message: harnessOptions.workersAiEnabledError.message,
          },
          harnessOptions.workersAiEnabledError.status,
        ));
      }
      const workersAi = providerState.find((provider) => provider.id === 'workers-ai');
      if (workersAi) workersAi.enabled = enabled;
      return Promise.resolve(jsonResponse({ provider: 'workers-ai', enabled }));
    }
    if (path === '/admin/api/egress') {
      if (method === 'PUT') {
        const body = JSON.parse(options?.body ?? '{}') as EgressPolicyFixture;
        egressPuts.push({ mode: body.mode, domains: [...body.domains] });
        egressPolicy = { mode: body.mode, domains: [...body.domains] };
      }
      return Promise.resolve(
        jsonResponse({ policy: { mode: egressPolicy.mode, domains: [...egressPolicy.domains] } }),
      );
    }
    if (path === '/admin/api/sandbox/status') {
      if (method === 'PUT') {
        if (sandboxMutationError) {
          return Promise.resolve(jsonResponse(sandboxMutationError, sandboxMutationError.status));
        }
        const body = JSON.parse(options?.body ?? '{}') as {
          enabled: boolean;
          readinessConfirmed?: boolean;
          allowedHosts: string[];
          monthlySessionCap: number;
        };
        sandboxPuts.push({
          enabled: body.enabled,
          ...(body.readinessConfirmed !== undefined
            ? { readinessConfirmed: body.readinessConfirmed }
            : {}),
          allowedHosts: [...body.allowedHosts],
          monthlySessionCap: body.monthlySessionCap,
        });
        sandboxStatus = {
          ...sandboxStatus,
          storedEnabled: body.enabled,
          enabled: body.enabled,
          allowedHosts: [...body.allowedHosts],
          monthlySessionCap: body.monthlySessionCap,
          monthlySessionCapConfigured: true,
        };
      }
      if (method === 'PATCH') {
        const body = JSON.parse(options?.body ?? '{}') as {
          allowedHosts: string[];
          monthlySessionCap: number;
        };
        sandboxAdvancedPatches.push({
          allowedHosts: [...body.allowedHosts],
          monthlySessionCap: body.monthlySessionCap,
        });
        sandboxStatus = {
          ...sandboxStatus,
          allowedHosts: [...body.allowedHosts],
          monthlySessionCap: body.monthlySessionCap,
          monthlySessionCapConfigured: true,
        };
      }
      return Promise.resolve(
        jsonResponse({
          ...sandboxStatus,
          allowedHosts: [...sandboxStatus.allowedHosts],
        }),
      );
    }
    if (path === '/admin/api/sandbox/install' && (method === 'POST' || method === 'DELETE')) {
      if (sandboxMutationError) {
        return Promise.resolve(jsonResponse(sandboxMutationError, sandboxMutationError.status));
      }
      sandboxInstallCalls.push(method);
      sandboxStatus = method === 'POST'
        ? { ...sandboxStatus, installRequested: true }
        : { ...sandboxStatus, installRequested: false, storedEnabled: false, enabled: false };
      return Promise.resolve(jsonResponse({
        ...sandboxStatus,
        allowedHosts: [...sandboxStatus.allowedHosts],
      }));
    }
    const favMatch = path.match(/^\/admin\/api\/providers\/([^/]+)\/favorites$/);
    if (favMatch) {
      const id = favMatch[1] as string;
      if (method === 'PUT') {
        const body = JSON.parse(options?.body ?? '{}') as { favorites: string[] };
        favoritesPuts.push({ id, favorites: body.favorites });
        favoritesState[id] = body.favorites;
        return Promise.resolve(jsonResponse({ provider: id, favorites: body.favorites }));
      }
      return Promise.resolve(jsonResponse({ provider: id, favorites: favoritesState[id] ?? [] }));
    }
    const modelsMatch = path.match(/^\/admin\/api\/providers\/([^/]+)\/models$/);
    if (modelsMatch) {
      const id = modelsMatch[1] as string;
      return Promise.resolve(jsonResponse({ provider: id, models: modelsState[id] ?? [], cached: false }));
    }
    if (path === '/admin/api/providers/openai/auth-method' && method === 'PUT') {
      const body = JSON.parse(options?.body ?? '{}') as { method: 'api_key' | 'subscription' };
      openAiAuthMethodPuts.push(body.method);
      const openAi = providerState.find((provider) => provider.id === 'openai');
      if (openAi) openAi.activeAuthMethod = body.method;
      if (openAiModelsAfterMethodSwitch) {
        modelsState.openai = openAiModelsAfterMethodSwitch;
      }
      return Promise.resolve(jsonResponse({ activeAuthMethod: body.method }));
    }
    const subscriptionMatch = path.match(/^\/admin\/api\/providers\/openai\/subscription(?:\/(start|poll|cancel|confirm-account))?$/);
    if (subscriptionMatch) {
      const action = subscriptionMatch[1] ?? 'connection';
      const openAi = providerState.find((provider) => provider.id === 'openai');
      if (method === 'DELETE') {
        openAiSubscriptionDisconnects += 1;
        if (openAi) {
          openAi.subscription = { state: 'disconnected', updatedAt: 1_800_000_020_000 };
          if (openAi.status === 'stored' || openAi.status === 'env') {
            openAi.activeAuthMethod = 'api_key';
          }
        }
        return Promise.resolve(jsonResponse({ status: openAi?.subscription }));
      }
      if (method === 'GET') {
        return Promise.resolve(jsonResponse({ status: openAi?.subscription ?? { state: 'disconnected', updatedAt: 0 } }));
      }
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      openAiSubscriptionPosts.push({ action, body });
      if (action === 'start') {
        if (openAi) openAi.subscription = { state: 'authorizing', updatedAt: 1_800_000_000_000 };
        return Promise.resolve(jsonResponse({
          state: 'authorizing',
          verificationUri: 'https://auth.openai.com/codex/device',
          userCode: 'CHICK-PEA',
          expiresAt: 1_800_000_060_000,
          nextPollAt: 1_800_000_005_000,
          attemptCapability: 'browser-attempt-capability-1234567890',
        }));
      }
      if (action === 'poll') {
        const result = harnessOptions.openAiSubscriptionPollResult ?? {
          state: 'connected',
          updatedAt: 1_800_000_005_000,
          accountFingerprint: 'oas_safe_fixture',
          connectedAt: 1_800_000_005_000,
        };
        if (openAi && result.state !== 'pending') {
          openAi.subscription = result as OpenAiSubscriptionStatusFixture;
          if (result.state === 'connected') openAi.activeAuthMethod = 'subscription';
        }
        return Promise.resolve(jsonResponse(result));
      }
      if (action === 'confirm-account') {
        const connected = {
          state: 'connected' as const,
          updatedAt: 1_800_000_010_000,
          accountFingerprint: 'oas_replacement_fixture',
          connectedAt: 1_800_000_010_000,
        };
        if (openAi) {
          openAi.subscription = connected;
          openAi.activeAuthMethod = 'subscription';
        }
        return Promise.resolve(jsonResponse(connected));
      }
      const restored = { state: 'disconnected' as const, updatedAt: 1_800_000_010_000 };
      if (openAi) openAi.subscription = restored;
      return Promise.resolve(jsonResponse(restored));
    }
    const keyMatch = path.match(/^\/admin\/api\/providers\/([^/]+)\/key$/);
    if (keyMatch) {
      const id = keyMatch[1] as string;
      const entry = providerState.find((p) => p.id === id);
      if (method === 'DELETE') {
        providerKeyDeletes.push(id);
        if (entry) {
          entry.status = 'missing';
          entry.modelCount = null;
          if (
            id === 'openai' &&
            (entry.subscription?.state === 'connected' || entry.subscription?.state === 'account_change_confirmation_required')
          ) {
            entry.activeAuthMethod = 'subscription';
          }
        }
        return Promise.resolve(
          jsonResponse({ ok: true, provider: { id, status: 'missing', modelCount: null }, pinnedProfileCount: 0 }),
        );
      }
      const body = JSON.parse(options?.body ?? '{}') as { key?: string };
      providerKeyPosts.push({ id, key: body.key ?? '' });
      if (providerKeyReject) {
        return Promise.resolve(
          jsonResponse(
            {
              error: 'provider_key_rejected',
              provider: id,
              status: providerKeyReject.status,
              detail: providerKeyReject.detail,
            },
            422,
          ),
        );
      }
      const wasMissing = entry?.status !== 'stored' && entry?.status !== 'env';
      if (entry) {
        entry.status = 'stored';
        entry.modelCount = 2;
        if (id === 'openai' && wasMissing) entry.activeAuthMethod = 'api_key';
      }
      return Promise.resolve(
        jsonResponse({ ok: true, provider: { id, status: 'stored', modelCount: 2 }, models: [{ id: 'm1' }, { id: 'm2' }] }),
      );
    }
    if (path === '/admin/api/slack-behavior' && method === 'PUT') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, boolean>;
      slackBehaviorPuts.push(body);
      return Promise.resolve(jsonResponse({}));
    }
    if (path === '/admin/api/slack-behavior') {
      slackBehaviorGets += 1;
      return Promise.resolve(jsonResponse({}));
    }
    if (path === '/admin/api/slack-connection/test' && method === 'POST') {
      slackTestCalls += 1;
      if (slackTestError) {
        return Promise.resolve(jsonResponse(slackTestError, slackTestError.status));
      }
      return Promise.resolve(
        jsonResponse({ ok: true, teamId: 'T_DESIGN', teamName: 'Acme Inc', botName: 'tag', botUserId: 'UBOT' }),
      );
    }
    if (path === '/admin/slack-gateway/refresh' && method === 'POST') {
      return Promise.resolve(jsonResponse(slackGatewayRefreshResult ?? {
        authorizationUrl: 'https://gateway.example/install/claim_refresh',
      }));
    }
    if (path === '/admin/api/slack-connection' && method === 'DELETE') {
      slackDisconnectCalls += 1;
      if (slackDisconnectError) {
        return Promise.resolve(jsonResponse(slackDisconnectError, slackDisconnectError.status));
      }
      if (slackConnection) {
        slackConnection.connected = false;
        slackConnection.credentials = { botToken: 'missing', signingSecret: 'missing', botUserId: 'missing' };
      }
      return Promise.resolve(
        jsonResponse({ ok: true, connected: false, slackAppUninstalled: false, configurationPreserved: true }),
      );
    }
    if (path === '/admin/api/slack-connection') {
      slackStatusGets += 1;
      // Without a fixture, mirror an endpoint failure: the page must render
      // everything else and simply omit the card (resilience contract).
      return slackConnection
        ? Promise.resolve(jsonResponse(slackConnection))
        : Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
    }
    if (path.startsWith('/admin/api/effective-config?')) {
      if (effectiveError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: effectiveError.error,
              ...(effectiveError.message ? { message: effectiveError.message } : {}),
            },
            effectiveError.status,
          ),
        );
      }
      const params = new URLSearchParams(path.slice(path.indexOf('?') + 1));
      const channelId = params.get('channelId');
      if (channelId === 'C_OPS') {
        return new Promise<FakeResponse>((resolve) => {
          resolveOpsEffective = () => {
            resolve(jsonResponse(effectiveConfig(opsAgent, 'C_OPS')));
          };
        });
      }
      return Promise.resolve(jsonResponse(effectiveConfig(releaseAgent, 'C0EXR3L9T')));
    }
    return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
  };

  vm.runInNewContext(
    inlineScriptFor(
      options.cloudflare ?? false,
      options.usageAdminUi ?? false,
    ),
    {
      document,
      fetch,
      console,
      FormData: class {
        private readonly fields: Record<string, string>;

        constructor(form: FakeSubmitTarget) {
          this.fields = form.__formData;
        }

        get(name: string) {
          return this.fields[name] ?? null;
        }
      },
      URL,
      URLSearchParams,
      navigator: options.clipboard === 'missing'
        ? {}
        : {
          clipboard: {
            writeText(text: string) {
              clipboardWrites.push(text);
              if (options.clipboard === 'throw') throw new Error('clipboard blocked');
              if (options.clipboard === 'reject') return Promise.reject(new Error('clipboard blocked'));
              if (options.clipboard === 'defer') {
                return new Promise<void>((resolve) => { clipboardWriteResolver = resolve; });
              }
              return Promise.resolve();
            },
          },
        },
      window,
      sessionStorage,
      history,
      location,
    },
    { filename: 'admin-page-inline.js' },
  );

  return {
    app,
    renderHistory,
    modalRoot,
    favContainers,
    listeners,
    putAssignments,
    agentChannelPosts,
    agentChannelDeletes,
    onboardingProviderPosts,
    onboardingTryPosts,
    onboardingCompletePosts,
    slackBehaviorPuts,
    slackBehaviorGets: () => slackBehaviorGets,
    slackTestCalls: () => slackTestCalls,
    slackDisconnectCalls: () => slackDisconnectCalls,
    topbarRegion,
    bodyRegion,
    providerActionMenus,
    focusedAction: () => focusedAction,
    locationPath: () => location.pathname,
    popstate(path: string) {
      applyHistoryPath(path);
      windowListeners.popstate?.({});
    },
    beforeunload() {
      let prevented = false;
      const event: Record<string, unknown> = {
        preventDefault() {
          prevented = true;
        },
      };
      windowListeners.beforeunload?.(event);
      return { prevented, returnValue: event.returnValue };
    },
    historyPushes,
    historyReplaces,
    usageApiCalls,
    scheduledApiCalls,
    channelListCalls,
    providerKeyPosts,
    providerKeyDeletes,
    openAiSubscriptionPosts,
    openAiAuthMethodPuts,
    openAiSubscriptionDisconnects: () => openAiSubscriptionDisconnects,
    favoritesPuts,
    workersAiEnabledPuts,
    workspaceDefaultPuts,
    egressPuts,
    sandboxPuts,
    sandboxAdvancedPatches,
    sandboxInstallCalls,
    sandboxBuildVariableSelectedAttached: () => sandboxBuildVariableSelectedAttached,
    modelCatalogRefreshCalls: () => modelCatalogRefreshCalls,
    resolveModelCatalogStatus(result) {
      const resolve = modelCatalogStatusResolver;
      assert.ok(resolve, 'model catalog status request is not pending');
      modelCatalogStatusResolver = undefined;
      resolve(jsonResponse({ ...result }));
    },
    agentPatchBodies,
    agentPostBodies,
    agentArchivePosts,
    skillResolvePosts,
    githubRepoCalls,
    settingsGetCalls,
    skillBrowseFocusCalls: () => skillBrowseFocusCalls,
    skillBrowseHostUpdates: () => skillBrowseHostUpdates,
    skillBrowseHtml: () => skillBrowseHost.innerHTML,
    skillBrowseScrollTop: () => skillBrowseList.scrollTop,
    mcpTestPosts,
    connectionAccountPosts,
    managedAuthorizationPosts,
    composioSetupPosts,
    composioRetryCalls: () => composioRetryCalls,
    managedPollCalls: () => managedPollCalls,
    managedCancelCalls: () => managedCancelCalls,
    managedResourcePosts,
    oauthStartPosts,
    apiOAuthStartPosts,
    apiOAuthClientPuts,
    assignedUrls,
    openedUrls,
    mcpSecretPuts,
    mcpSecretDeletes,
    apiConnectionSecretPuts,
    apiConnectionSecretDeletes,
    memoryPuts,
    ownerMemoryGetCaches,
    agentScheduleGets: () => agentScheduleGets,
    agentDetailGets: () => agentDetailGets,
    agentConnectionGets: () => agentConnectionGets,
    slackStatusGets: () => slackStatusGets,
    setAgentSchedules(schedules) {
      agentSchedules = schedules.map((schedule) => ({ ...schedule }));
    },
    agentScheduleControlPosts,
    setMemoryEntry(body, version) {
      memoryEntry = { ...memoryEntry, body, version };
    },
    focusWindow() {
      windowListeners.focus?.({});
    },
    setVisibility(nextState) {
      documentVisibilityState = nextState;
      listeners.visibilitychange?.({ target: actionTarget({}) });
    },
    scheduledControlPosts,
    clipboardWrites,
    resolveClipboardWrite() {
      assert.ok(clipboardWriteResolver, 'expected a clipboard write to be pending');
      const resolve = clipboardWriteResolver;
      clipboardWriteResolver = null;
      resolve();
    },
    gallerySearchFocusCalls: () => gallerySearchFocusCalls,
    gallerySearchSelections,
    resolveOpsEffective() {
      assert.ok(resolveOpsEffective, 'expected C_OPS effective-config request to be pending');
      resolveOpsEffective();
    },
    resolveAgentPatch() {
      assert.ok(resolveAgentPatch, 'expected agent PATCH request to be pending');
      resolveAgentPatch();
    },
    mainScrollTop: () => mainRegion.scrollTop,
    setMainScrollTop(value: number) {
      mainRegion.scrollTop = value;
    },
    documentScrollTop: () => documentScrollTop,
    setDocumentScrollTop(value: number) {
      documentScrollTop = value;
    },
    focusModelInput(caret = 0) {
      modelDomEnabled = true;
      modelSelectionStart = caret;
      const input = currentModelInput();
      input.selectionStart = caret;
      input.focus();
    },
    modelSelectionRanges,
    sessionStorageValue(key: string) {
      return sessionStorage.getItem(key);
    },
  };
}

async function openReleaseAttachPicker(
  harness: ReturnType<typeof runAdminPageHarness>,
): Promise<Listener> {
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'attach-open' }) });
  await flushAsync();
  return click;
}

// IS_CLOUDFLARE is baked into the inline script at render time from
// isCloudflareTarget() (globalThis.navigator.userAgent). The Workers AI row is
// binding-only, so a Cloudflare-target harness renders it by masquerading the
// navigator just for the renderAdminPage() call, then restoring it.
function inlineScriptFor(
  cloudflare: boolean,
  usageAdminUi = false,
): string {
  if (!cloudflare) return inlineScript(usageAdminUi);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Cloudflare-Workers' },
    configurable: true,
  });
  try {
    return inlineScript(usageAdminUi);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
}

function disconnectedSlackFixture(): SlackConnectionFixture {
  return {
    connected: false,
    credentials: { botToken: 'missing', signingSecret: 'env', botUserId: 'missing' },
    teamId: null,
    teamName: null,
    requestUrl: 'https://tag.example.dev/channels/slack/events',
    manifestUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%22a%22%3A1%7D',
  };
}

function connectedSlackFixture(): SlackConnectionFixture {
  return {
    connected: true,
    health: 'healthy',
    transportMode: 'direct',
    credentials: { botToken: 'stored', signingSecret: 'stored', botUserId: 'stored' },
    teamId: 'T_DESIGN',
    teamName: 'Acme Inc',
    requestUrl: 'https://tag.example.dev/channels/slack/events',
    manifestUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%22a%22%3A1%7D',
  };
}

function channelsFixture(
  channels: SlackChannelFixture[] = [
    { id: 'C_NEW', name: 'new-channel', isPrivate: false, isMember: true },
    { id: 'C_PRIVATE', name: 'secret-room', isPrivate: true, isMember: false },
  ],
  truncated = false,
): SlackChannelsFixture {
  return {
    teamId: 'T_DESIGN',
    teamName: 'Acme Inc',
    truncated,
    channels,
  };
}

test('Destinations lands directly on the Slack overview and its tabs stay inside one page', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/destinations/slack' });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.equal(harness.locationPath(), '/admin/destinations/slack');
  assert.match(html, /<nav class="rail primary-shell-sidebar destination-shell-sidebar" aria-label="Destinations">/);
  assert.match(html, /class="destination-rail-item active"[\s\S]*?class="destination-rail-name">Slack<[\s\S]*?Acme Inc · 2 channels/);
  assert.doesNotMatch(html, /agent-workspace-row|agent-roster|select-channel/);
  assert.match(html, /class="destination-tab active"[^>]*data-tab="overview">Overview<\/button>/);
  assert.match(html, /id="dtab-overview" role="tab" aria-selected="true" aria-controls="dtab-panel-overview" tabindex="0"/);
  assert.match(html, /id="dtab-connection" role="tab" aria-selected="false" aria-controls="dtab-panel-connection" tabindex="-1"/);
  assert.match(html, /id="dtab-panel-overview" role="tabpanel" aria-labelledby="dtab-overview"/);
  assert.match(html, /id="dtab-panel-connection" role="tabpanel" aria-labelledby="dtab-connection" hidden/);
  assert.match(html, /class="destination-hero-logo slack-logo-image" aria-hidden="true"/);
  assert.match(html, /<h2>Workspace connection<\/h2>[\s\S]*?Acme Inc[\s\S]*?Connected workspace[\s\S]*?Connected/);
  assert.match(html, /<h2>Channels summary<\/h2>[\s\S]*?2 channels[\s\S]*?active Agents[\s\S]*?Using Slack/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'destination-tab', 'data-tab': 'connection' }) });
  assert.equal(harness.locationPath(), '/admin/destinations/slack/connection');
  assert.match(harness.app.innerHTML, /class="destination-tab active"[^>]*data-tab="connection">Connection<\/button>/);
  assert.match(harness.app.innerHTML, /Connected workspace/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'destination-tab', 'data-tab': 'channels' }) });
  assert.equal(harness.locationPath(), '/admin/destinations/slack/channels');
  assert.match(harness.app.innerHTML, /class="destination-tab active"[^>]*data-tab="channels">Channels<\/button>/);
  assert.match(harness.app.innerHTML, /role="table" aria-label="Channel grants"/);

  harness.listeners.keydown?.({
    target: actionClassTarget({ 'data-action': 'destination-tab', 'data-tab': 'channels' }, 'destination-tab'),
    key: 'Home',
    preventDefault() {},
  });
  assert.equal(harness.locationPath(), '/admin/destinations/slack');
  assert.match(harness.app.innerHTML, /id="dtab-overview"[^>]*aria-selected="true"[^>]*tabindex="0"/);
  assert.equal(harness.focusedAction(), 'dtab-overview');
});

test('Destinations uses a flat Slack rail while Channel routes keep stable lower navigation', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.equal(harness.locationPath(), '/admin/destinations/slack/channels');
  assert.deepEqual(harness.historyReplaces, ['/admin/destinations/slack/channels']);
  assert.equal(harness.app.className, 'frame primary-admin-shell admin-surface admin-surface-channels-index');
  assert.match(html, /<nav class="rail primary-shell-sidebar destination-shell-sidebar" aria-label="Destinations">/);
  assert.match(html, /class="primary-shell-brand"[\s\S]*?data-action="go-home"[\s\S]*?Chickpea/);
  assert.match(html, /class="destination-rail-name">Slack<[\s\S]*?class="destination-rail-meta">Acme Inc · 2 channels/);
  assert.doesNotMatch(html, /cloudflare · workers|local · node/);
  assert.doesNotMatch(html, /<nav class="agent-roster" aria-label="Agents">/);
  assert.match(html, /class="section-nav-item active" data-action="open-destinations"[^>]*aria-current="page">Destinations<\/button>/);
  assert.equal((html.match(/aria-label="Admin navigation"/g) ?? []).length, 1);
  assert.match(html, /<div class="rail-head"><span class="section-eyebrow">Destinations<\/span><\/div>/);
  assert.match(html, /<h1 class="page-title">Slack<\/h1>/);
  assert.match(html, /class="destination-tab active"[^>]*data-tab="channels">Channels<\/button>/);
  assert.match(html, /Channel grants/);
  assert.doesNotMatch(html, /Add Channel|Behavior|Channel instructions/);

  const click = harness.listeners.click;
  assert.ok(click);
  click({
    target: actionTarget({
      'data-action': 'select-channel',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C0EXR3L9T',
    }),
  });
  await flushAsync();
  assert.equal(harness.locationPath(), '/admin/channels/T_DESIGN/C0EXR3L9T');
  assert.match(harness.app.innerHTML, /<h1 class="page-title mono-title">#eng-releases<\/h1>/);
  assert.match(harness.app.innerHTML, /class="destination-rail-item active"/);
  assert.match(harness.app.innerHTML, /class="section-nav-item active" data-action="open-destinations"[^>]*aria-current="page">Destinations<\/button>/);
  assert.match(harness.app.innerHTML, /data-action="channel-back">&larr; Channels<\/button>/);
  const channelHeader = harness.app.innerHTML.match(/<div class="main-head">[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
  assert.doesNotMatch(channelHeader, /data-action="open-channel-memory"/);
  assert.match(harness.app.innerHTML, /Agents available here/);
  assert.match(harness.app.innerHTML, /Agent grant/);
  assert.match(harness.app.innerHTML, /Release Profile/);
  assert.doesNotMatch(harness.app.innerHTML, /Access summary/);
  assert.doesNotMatch(harness.app.innerHTML, /Resolved configuration/);
  assert.doesNotMatch(harness.app.innerHTML, /When it speaks/);
  assert.match(harness.app.innerHTML, /Try it in Slack/);
  assert.doesNotMatch(harness.app.innerHTML, /Additional instructions|Channel memory/);

  click({ target: actionTarget({ 'data-action': 'open-profiles', 'data-agent': 'agent_release' }) });
  assert.equal(harness.locationPath(), '/admin/agents/agent_release');
  assert.match(harness.app.innerHTML, /class="agent-roster-item active" data-action="edit-profile" data-agent="agent_release"/);

  click({ target: actionTarget({ 'data-action': 'open-channels' }) });
  assert.equal(harness.locationPath(), '/admin/destinations/slack/channels');
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Slack<\/h1>/);
  assert.match(harness.app.innerHTML, /class="destination-tab active"[^>]*data-tab="channels">Channels<\/button>/);
});

test('Channels deep links and popstate keep the route and selected screen in sync', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T',
  });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/channels/T_DESIGN/C0EXR3L9T');
  assert.match(harness.app.innerHTML, /<h1 class="page-title mono-title">#eng-releases<\/h1>/);
  assert.doesNotMatch(harness.app.innerHTML, /class="agent-roster-item active"/);

  harness.popstate('/admin/channels');
  assert.equal(harness.locationPath(), '/admin/destinations/slack/channels');
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Slack<\/h1>/);
  assert.match(harness.app.innerHTML, /data-tab="channels">Channels<\/button>/);

  harness.popstate('/admin/agents/agent_ops');
  assert.equal(harness.locationPath(), '/admin/agents/agent_ops');
  assert.match(harness.app.innerHTML, /class="agent-roster-item active" data-action="edit-profile" data-agent="agent_ops"/);
});

test('Slack settings omit workspace behavior switches and their client requests', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/settings/slack/identities' });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  assert.doesNotMatch(harness.app.innerHTML, /Slack behavior/);
  assert.doesNotMatch(harness.app.innerHTML, /Show native task plans/);
  assert.doesNotMatch(harness.app.innerHTML, /Stream safe answer text/);
  assert.equal(harness.slackBehaviorGets(), 0);
  assert.deepEqual(harness.slackBehaviorPuts, []);

  click({ target: actionTarget({ 'data-action': 'slack-test' }) });
  await flushAsync();
  assert.equal(harness.slackTestCalls(), 1);
  assert.match(harness.app.innerHTML, /Connection healthy · Acme Inc/);

  assert.doesNotMatch(harness.app.innerHTML, /Update Slack credentials|name="botToken"/);

  click({ target: actionTarget({ 'data-action': 'slack-disconnect-open' }) });
  assert.match(harness.app.innerHTML, /Disconnect Acme Inc\?/);
  assert.match(harness.app.innerHTML, /does not uninstall the Slack app/i);
  click({ target: actionTarget({ 'data-action': 'slack-disconnect-confirm' }) });
  await flushAsync();
  assert.equal(harness.slackDisconnectCalls(), 1);
  assert.match(harness.app.innerHTML, /Slack setup incomplete/);
});

test('Slack connection test explains that required permissions are not applied yet', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities',
    slackTestError: { status: 422, error: 'slack_missing_scopes' },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'slack-test' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /missing required permissions/);
  assert.match(harness.app.innerHTML, /scoped recovery flow/);
});

test('a stale shared-app binding changes every Slack status to Reconnect required', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack',
    slackConnection: {
      ...connectedSlackFixture(),
      transportMode: 'gateway',
      credentials: { botToken: 'missing', signingSecret: 'missing', botUserId: 'missing' },
    },
    slackTestError: {
      status: 502,
      error: 'slack_gateway_unreachable',
      detail: 'gateway_not_connected',
    },
  });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Connected workspace/);
  assert.match(harness.app.innerHTML, />Connected</);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-test' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /This deployment is no longer linked to the shared Slack app/);
  assert.match(harness.app.innerHTML, /badge badge-off[^>]*>[\s\S]*?Reconnect required/);
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  await flushAsync();
  const sidebar = harness.app.innerHTML.match(/<aside class="rail primary-shell-sidebar agent-shell-sidebar">[\s\S]*?<\/aside>/)?.[0] ?? '';
  assert.match(sidebar, /<span class="section-eyebrow">Agents<\/span><\/div><nav class="agent-roster"/);
  assert.doesNotMatch(sidebar, /Reconnect required|Connected|agent-slack-status/);
});

test('an offline inbound Slack session renders a specific retryable status', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities',
    slackConnection: {
      ...connectedSlackFixture(),
      transportMode: 'gateway',
      credentials: { botToken: 'missing', signingSecret: 'missing', botUserId: 'missing' },
    },
    slackTestError: {
      status: 502,
      error: 'slack_gateway_unreachable',
      detail: 'gateway_session_offline',
    },
  });
  await flushAsync();

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-test' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /inbound event session is offline/i);
  assert.match(harness.app.innerHTML, /badge badge-off[^>]*>[\s\S]*?Needs attention/);
});

test('a successful Slack re-test clears an earlier inbound-session warning', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities',
    slackConnection: {
      ...connectedSlackFixture(),
      health: 'needs_attention',
      healthDetail: 'gateway_session_offline',
      transportMode: 'gateway',
    },
  });
  await flushAsync();
  assert.match(harness.app.innerHTML, /badge badge-off[^>]*>[\s\S]*?Needs attention/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-test' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Connection healthy · Acme Inc/);
  assert.match(harness.app.innerHTML, /badge badge-on[^>]*>[\s\S]*?Connected/);
});

test('Slack connection failures stay visible and the disconnect dialog gates background actions', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities',
    slackTestError: { status: 422, error: 'slack_auth_failed', detail: 'invalid_auth' },
    slackDisconnectError: { status: 500, error: 'internal_error' },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const keydown = harness.listeners.keydown;
  assert.ok(click && keydown);

  click({ target: actionTarget({ 'data-action': 'slack-test' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /role="status" aria-live="polite"/);
  assert.match(harness.app.innerHTML, /Slack rejected the installed bot credential/);

  click({ target: actionTarget({ 'data-action': 'slack-disconnect-open' }) });
  assert.match(harness.app.innerHTML, /Disconnect Acme Inc\?/);
  assert.equal(harness.topbarRegion.inert, true);
  assert.equal(harness.bodyRegion.inert, true);
  assert.equal(harness.topbarRegion.getAttribute('aria-hidden'), 'true');
  assert.equal(harness.bodyRegion.getAttribute('aria-hidden'), 'true');
  assert.equal(harness.focusedAction(), 'slack-disconnect-cancel');
  let tabPrevented = false;
  keydown({
    key: 'Tab',
    shiftKey: true,
    target: actionTarget({}),
    preventDefault() { tabPrevented = true; },
  });
  assert.equal(tabPrevented, true);
  assert.equal(harness.focusedAction(), 'slack-disconnect-confirm');
  tabPrevented = false;
  keydown({
    key: 'Tab',
    target: actionTarget({}),
    preventDefault() { tabPrevented = true; },
  });
  assert.equal(tabPrevented, true);
  assert.equal(harness.focusedAction(), 'slack-disconnect-cancel');
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  assert.match(harness.app.innerHTML, /Disconnect Acme Inc\?/);
  assert.doesNotMatch(harness.app.innerHTML, /<h1 class="page-title">Profiles<\/h1>/);

  let prevented = false;
  keydown({
    key: 'Escape',
    target: actionTarget({}),
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.doesNotMatch(harness.app.innerHTML, /Disconnect Acme Inc\?/);
  assert.equal(harness.topbarRegion.inert, false);
  assert.equal(harness.bodyRegion.inert, false);
  assert.equal(harness.focusedAction(), 'slack-disconnect-open');

  click({ target: actionTarget({ 'data-action': 'slack-disconnect-open' }) });
  harness.popstate('/admin/agents');
  assert.doesNotMatch(harness.app.innerHTML, /Disconnect Acme Inc\?/);
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Agents<\/h1>/);
  assert.equal(harness.topbarRegion.inert, false);
  assert.equal(harness.focusedAction(), null);

  click({ target: actionTarget({ 'data-action': 'open-channels' }) });
  click({ target: actionTarget({ 'data-action': 'slack-disconnect-open' }) });
  click({ target: actionTarget({ 'data-action': 'slack-disconnect-confirm' }) });
  assert.match(harness.app.innerHTML, /Disconnecting&hellip;/);
  assert.match(harness.app.innerHTML, /data-action="slack-disconnect-cancel" disabled/);
  assert.equal(harness.focusedAction(), 'slack-disconnect-dialog');
  tabPrevented = false;
  keydown({
    key: 'Tab',
    target: actionTarget({}),
    preventDefault() { tabPrevented = true; },
  });
  assert.equal(tabPrevented, true);
  assert.equal(harness.focusedAction(), 'slack-disconnect-dialog');
  harness.popstate('/admin/agents');
  assert.equal(harness.locationPath(), '/admin/destinations/slack/channels');
  assert.match(harness.app.innerHTML, /Disconnect Acme Inc\?/);
  click({ target: actionTarget({ 'data-action': 'slack-disconnect-cancel' }) });
  assert.match(harness.app.innerHTML, /Disconnect Acme Inc\?/);
  prevented = false;
  keydown({
    key: 'Escape',
    target: actionTarget({}),
    preventDefault() { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.match(harness.app.innerHTML, /Disconnect Acme Inc\?/);
  assert.equal(harness.focusedAction(), 'slack-disconnect-dialog');
  await flushAsync();
  assert.match(harness.app.innerHTML, /Disconnect Acme Inc\?/);
  assert.match(harness.app.innerHTML, /internal_error/);
  assert.match(harness.app.innerHTML, /role="alert" aria-live="assertive"[^>]*data-role="slack-disconnect-error"/);
  assert.equal(harness.focusedAction(), 'slack-disconnect-error');
});

test('admin page renders channel labels, profile secondary text, and singular channel counts', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({
    target: actionTarget({
      'data-action': 'select-channel',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C0EXR3L9T',
    }),
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /class="destination-rail-item active"/);
  assert.doesNotMatch(harness.app.innerHTML, /Direct messages|\+ DMs|DM default/);
  assert.match(harness.app.innerHTML, /<h1 class="page-title mono-title">#eng-releases<\/h1>/);
  // Agents is now a main-panel destination (the modal was retired): opening it
  // swaps the main panel to the overview, and each card carries its usage meta.
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Agents<\/h1>/);
  assert.match(harness.app.innerHTML, /<span class="pcard-name">Release Profile<\/span>/);
  assert.match(harness.app.innerHTML, /used in 1 channel/);

  // Drilling into an Agent opens the full-page editor whose Slack destination
  // links directly to the Channel detail.
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  assert.match(harness.app.innerHTML, /class="agent-destinations-section"[\s\S]*?<h2>Destinations<\/h2>[\s\S]*?<h3>Slack channels<\/h3>/);
  assert.match(harness.app.innerHTML, /data-action="open-channel-from-profile"[^>]*>[\s\S]*?class="where-channel-name">eng-releases/);
});

test('Where it works can remove an Agent Channel grant', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /data-action="detach-channel"/);
  assert.match(harness.app.innerHTML, /aria-label="Remove this Agent from #eng-releases"/);
  click({
    target: actionTarget({
      'data-action': 'detach-channel',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C0EXR3L9T',
      'data-label': 'eng-releases',
    }),
  });
  await flushAsync();

  assert.deepEqual(harness.agentChannelDeletes, [{
    agentId: 'agent_release',
    workspaceId: 'T_DESIGN',
    channelId: 'C0EXR3L9T',
  }]);
  assert.match(harness.app.innerHTML, /Agent removed from #eng-releases/);
  assert.match(harness.app.innerHTML, /Make Release Profile mentionable/);
  assert.match(harness.app.innerHTML, /Only the creator can DM this Agent/);
});

test('the profile editor presents reversible archive semantics for an assigned Agent', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });

  // Lifecycle actions live in one accessible header overflow. Archive is
  // reversible and explicitly describes its Channel and schedule effects.
  click({ target: actionTarget({ 'data-action': 'agent-overflow-toggle' }) });
  assert.match(harness.app.innerHTML, /role="menu" aria-label="Agent lifecycle actions"/);
  assert.match(harness.app.innerHTML, /data-action="archive-profile">Archive Agent<\/button>/);
  assert.match(harness.app.innerHTML, /disables the Slack handle, removes Channel access, and pauses schedules/);
  assert.doesNotMatch(harness.app.innerHTML, /Delete Agent|Disable Agent/);
  assert.equal(harness.focusedAction(), 'archive-profile');
});

test('Agent deletion explains how to replace a workspace Default Agent', async () => {
  const dmAgent = {
    ...releaseAgent,
    id: 'agent_dm_copy',
    name: 'DM Copy Profile',
  };
  const harness = runAdminPageHarness({
    agents: [dmAgent],
    agentWriteError: {
      status: 409,
      error: 'agent_still_referenced',
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  click({
    target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': dmAgent.id }),
  });

  click({ target: actionTarget({ 'data-action': 'agent-overflow-toggle' }) });
  click({ target: actionTarget({ 'data-action': 'agent-lifecycle-disable' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  click({ target: actionTarget({ 'data-action': 'delete-profile' }) });
  await flushAsync();
  assert.match(
    harness.app.innerHTML,
    /Remove every reference before deleting it\./,
  );
});

test('New profile opens a blank create screen and validation gates save', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  // A previous editor tab must not leak into the create flow.
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'profiles-back' }) });
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });

  // The create screen is a full page (not a modal): back link, global details,
  // every configuration tab, a ghost-example instructions placeholder, and Create/Cancel.
  assert.match(harness.app.innerHTML, /<h1 class="page-title">New Agent<\/h1>/);
  assert.match(harness.app.innerHTML, /<h2 class="section-title">Details<\/h2>[\s\S]*?for="p-name">Name[\s\S]*?for="p-description">Description[\s\S]*?class="agent-destinations-section"/);
  assert.doesNotMatch(harness.app.innerHTML, /<h3>Appearance<\/h3>[\s\S]*?for="p-description">Description/);
  assert.match(harness.app.innerHTML, /data-action="profile-tab" data-tab="instructions"/);
  assert.match(harness.app.innerHTML, /data-action="profile-tab" data-tab="skills"/);
  assert.match(harness.app.innerHTML, /data-action="profile-tab" data-tab="connections"/);
  assert.doesNotMatch(harness.app.innerHTML, /id="ptab-panel-instructions"[^>]* hidden/);
  assert.match(harness.app.innerHTML, /id="ptab-panel-connections"[^>]* hidden/);
  assert.match(harness.app.innerHTML, /Answer teammates/);
  assert.match(harness.app.innerHTML, /data-action="cancel-create"/);
  assert.match(harness.app.innerHTML, /data-action="save-profile"/);

  // A blank name is rejected inline with the verbatim server-side string; no
  // agents request is issued.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  assert.match(harness.app.innerHTML, /Name is required\./);
});

test('Agent header owns its editable avatar while Slack owns handle, channels, and edit policy', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': releaseAgent.id }) });
  const header = harness.app.innerHTML.match(/<header class="agent-profile-header">[\s\S]*?<\/header>/)?.[0] ?? '';
  assert.match(header, /class="[^"]*agent-profile-avatar-upload[^"]*"[\s\S]*?<span class="agent-avatar-hover" aria-hidden="true">Change<\/span>[\s\S]*?data-action="profile-avatar-upload"/);
  assert.match(header, /class="agent-profile-identity"[\s\S]*?class="[^"]*agent-profile-avatar-upload[^"]*"[\s\S]*?<h1 class="page-title">Release Profile<\/h1>[\s\S]*?class="agent-profile-intro"/);
  assert.match(harness.app.innerHTML, /class="agent-destinations-section"[\s\S]*?<h2>Destinations<\/h2>[\s\S]*?class="agent-destination-card" open[\s\S]*?<strong>Slack<\/strong>[\s\S]*?@release-profile[\s\S]*?1 Slack channel/);
  assert.match(harness.app.innerHTML, /class="agent-card-icon agent-slack-card-icon" aria-hidden="true"/);
  const slackBody = harness.app.innerHTML.match(/<div class="agent-destination-body">[\s\S]*?<\/div><\/details>/)?.[0] ?? '';
  assert.match(slackBody, /for="p-handle">Handle<\/label>[\s\S]*?<h3>Slack channels<\/h3>/);
  assert.doesNotMatch(slackBody, /<h3>Appearance<\/h3>|>Avatar<|profile-avatar-upload|Upload image|PNG, JPEG, or WebP/);
  assert.ok(
    slackBody.indexOf('data-action="attach-open"') < slackBody.indexOf('class="agent-placement-body"') &&
      slackBody.indexOf('class="agent-placement-body"') < slackBody.indexOf('class="hint agent-private-use-audience"'),
    'Connected channels must appear after Add to channels and before the DM notice',
  );
  assert.doesNotMatch(slackBody, /agent-slack-channel-count|agent-placement-count|>1 channel</);
  assert.match(harness.app.innerHTML, /<label class="field-label" for="p-handle">Handle<\/label>/);
  assert.match(harness.app.innerHTML, /class="agent-handle-control"><span class="agent-handle-prefix" aria-hidden="true">@<\/span><input class="input mono" id="p-handle"/);
  assert.doesNotMatch(harness.app.innerHTML, /Members mention this user-group handle/);
  assert.match(harness.app.innerHTML, /class="advanced agent-advanced-card"[\s\S]*?data-action="profile-edit-policy"/);
  assert.ok(
    harness.app.innerHTML.indexOf('class="advanced agent-advanced-card"') < harness.app.innerHTML.indexOf('data-action="profile-edit-policy"'),
    'Edit policy must live inside Advanced',
  );
  assert.doesNotMatch(harness.app.innerHTML, /@Finance|profile-slack-identity|Slack identity/);
  input({ target: inputTarget({ 'data-action': 'profile-handle' }, 'release-help') });
  change({ target: valueTarget({ 'data-action': 'profile-edit-policy' }, 'all_workspace_members') });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies[0]?.body.handle, 'release-help');
  assert.equal(harness.agentPatchBodies[0]?.body.editPolicy, 'all_workspace_members');
});

test('Agent Slack destination explains every derived DM audience without controls or rosters', async () => {
  const cases = [
    ['workspace_members', 'All workspace members can DM this Agent'],
    ['private_channel_members', 'Members of its private channels can DM this Agent'],
    ['creator_only', 'Only the creator can DM this Agent'],
    ['unavailable', 'DM access unavailable'],
  ] as const;
  for (const [audience, label] of cases) {
    const harness = runAdminPageHarness({
      initialPath: '/admin/agents/agent_release',
      agents: [{
        ...releaseAgent,
        whereItWorks: {
          privateUseAudience: audience,
          channels: audience === 'creator_only' ? [] : [{
            workspaceId: 'T_DESIGN', channelId: 'C0EXR3L9T',
            channelName: 'eng-releases', status: 'active',
          }],
        },
      }],
    });
    await flushAsync();
    const audienceHtml = harness.app.innerHTML.match(/<p class="hint agent-private-use-audience" role="note">[^<]+<\/p>/)?.[0] ?? '';
    assert.match(audienceHtml, new RegExp(label + '\\.'));
    assert.doesNotMatch(audienceHtml, /<strong|<svg|<button|<select|memberCount|member roster|workspace member can use|Slack Connect/i);
    const audienceStart = harness.app.innerHTML.indexOf('class="hint agent-private-use-audience"');
    const channelsEnd = audience === 'creator_only'
      ? harness.app.innerHTML.indexOf('class="agent-channel-empty"')
      : harness.app.innerHTML.indexOf('class="agent-placement-body"');
    assert.ok(channelsEnd !== -1 && channelsEnd < audienceStart, 'The DM notice must follow the channel content');
  }
});

test('saving an Agent reloads its detail-scoped DM audience after the roster refresh', async () => {
  const detailedAgent = {
    ...releaseAgent,
    whereItWorks: {
      privateUseAudience: 'workspace_members',
      channels: [{
        workspaceId: 'T_DESIGN', channelId: 'C0EXR3L9T',
        channelName: 'eng-releases', status: 'active',
      }],
    },
  };
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agents: [detailedAgent],
    agentsListOmitsPrivateUseAudience: true,
    agentDetailFetch() {
      return Promise.resolve(jsonResponse({
        agent: {
          ...detailedAgent,
          whereItWorks: {
            ...detailedAgent.whereItWorks,
            privateUseAudience: 'workspace_members',
          },
        },
      }));
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /All workspace members can DM this Agent/);
  const detailGetsBeforeSave = harness.agentDetailGets();
  harness.listeners.input?.({
    target: inputTarget({ 'data-action': 'profile-description' }, 'Updated description'),
  });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.agentDetailGets(), detailGetsBeforeSave + 1);
  assert.match(harness.app.innerHTML, /All workspace members can DM this Agent/);
  assert.doesNotMatch(harness.app.innerHTML, /DM access unavailable/);
});

test('Agent roster uses each Agent Slack avatar when one is available', async () => {
  const avatarUrl = 'https://secure.gravatar.com/avatar/agent-release?s=192&d=identicon';
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agents: [{
      ...releaseAgent,
      slackPresence: {
        requestedHandle: 'release',
        normalizedHandle: 'release',
        desiredState: 'active',
        health: 'healthy',
        avatar: { kind: 'uploaded', revision: 2, url: avatarUrl },
      },
    }],
  });
  await flushAsync();

  const rosterHtml = harness.app.innerHTML.slice(
    harness.app.innerHTML.indexOf('<nav class="agent-roster"'),
    harness.app.innerHTML.indexOf('</nav>', harness.app.innerHTML.indexOf('<nav class="agent-roster"')),
  );
  assert.match(rosterHtml, /class="agent-roster-icon has-avatar"[^>]*><img src="https:\/\/secure\.gravatar\.com\/avatar\/agent-release\?s=192&amp;d=identicon"/);
  assert.doesNotMatch(rosterHtml, /class="agent-roster-icon variant-[012]"/);
});

test('Agent editing no longer exposes a separate Slack identity control', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': releaseAgent.id }) });
  assert.match(harness.app.innerHTML, /class="agent-profile-identity"[\s\S]*?class="[^"]*agent-profile-avatar-upload[^"]*"[\s\S]*?class="agent-profile-copy"/);
  assert.match(harness.app.innerHTML, /class="[^"]*agent-handle-subsection[^"]*"[\s\S]*?for="p-handle">Handle/);
  assert.doesNotMatch(harness.app.innerHTML, /profile-slack-identity|Manage @Chickpea|Manage @Finance/);
});

test('Agent-owned presence removes wildcard identity preflight from profile saves', async () => {
  const harness = runAdminPageHarness({
    assignments: [
      ...defaultAssignments(),
      {
        workspaceId: 'T_DESIGN',
        channelId: '*',
        channelLabel: 'all channels',
        agentId: releaseAgent.id,
        enabled: true,
      },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': releaseAgent.id }) });
  input({ target: inputTarget({ 'data-action': 'profile-handle' }, 'release-help') });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 1);
  assert.equal(harness.agentPatchBodies[0]?.body.handle, 'release-help');
  assert.doesNotMatch(harness.app.innerHTML, /wildcard channel warning|cannot enumerate every destination/i);
});

test('Channel Advanced keeps resolved identity details out of the customer-facing page', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({
    target: actionTarget({
      'data-action': 'select-channel',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C0EXR3L9T',
    }),
  });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /Access summary/);
  assert.doesNotMatch(harness.app.innerHTML, /Resolved configuration|<dt>Replies as<\/dt>/);
});

test('Add to channels loads the Slack catalog and can attach an unassigned workspace channel', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture([
      { id: 'C0EXR3L9T', name: 'eng-releases' },
      { id: 'C_OPS', name: 'bot-test' },
      { id: 'C_NEW', name: 'new-channel' },
    ]),
    attachSelectionValue: 'C_NEW',
  });
  const click = await openReleaseAttachPicker(harness);

  assert.equal(harness.channelListCalls.length, 1);
  const picker = harness.app.innerHTML.match(/<select class="input" data-role="attach-channel"[\s\S]*?<\/select>/)?.[0] ?? '';
  assert.match(picker, /#bot-test/);
  assert.match(picker, /#new-channel/);
  assert.doesNotMatch(picker, /#eng-releases/);

  click({ target: actionTarget({ 'data-action': 'attach-channel-confirm' }) });
  await flushAsync();
  assert.deepEqual(harness.agentChannelPosts, [{
    agentId: 'agent_release',
    body: { workspaceId: 'T_DESIGN', channelId: 'C_NEW' },
  }]);
  assert.doesNotMatch(harness.app.innerHTML, /data-role="attach-channel"/);
  assert.match(harness.app.innerHTML, /2 Slack channels/);
  assert.match(harness.app.innerHTML, /All workspace members can DM this Agent/);
});

test('Add to channels grants another Agent without replacing the existing Agent', async () => {
  const harness = runAdminPageHarness({
    assignments: [
      defaultAssignments()[0] as AssignmentFixture,
      {
        workspaceId: 'T_DESIGN',
        channelId: 'C_OPS',
        channelLabel: 'ops-room',
        agentId: 'agent_ops',
        enabled: false,
      },
    ],
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture([
      { id: 'C0EXR3L9T', name: 'eng-releases' },
      { id: 'C_OPS', name: 'ops-room' },
    ]),
    attachSelectionValue: 'C_OPS',
  });
  const click = await openReleaseAttachPicker(harness);
  click({ target: actionTarget({ 'data-action': 'attach-channel-confirm' }) });
  await flushAsync();

  assert.deepEqual(harness.agentChannelPosts, [{
    agentId: 'agent_release',
    body: { workspaceId: 'T_DESIGN', channelId: 'C_OPS' },
  }]);
  assert.equal((harness.putAssignments[0] as AssignmentFixture | undefined), undefined);
});

test('Add to channels keeps a non-first selection across profile re-renders', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture([
      { id: 'C_OPS', name: 'bot-test' },
      { id: 'C_NEW', name: 'new-channel' },
    ]),
    // If the state-backed choice is lost, confirmation falls back to this
    // rebuilt DOM select value and targets the wrong (first) channel.
    attachSelectionValue: 'C_OPS',
  });
  const click = await openReleaseAttachPicker(harness);
  const change = harness.listeners.change;
  assert.ok(change);
  change({ target: inputTarget({ 'data-action': 'attach-channel-option' }, 'C_NEW') });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });

  assert.match(harness.app.innerHTML, /<option value="C_NEW" selected>/);
  click({ target: actionTarget({ 'data-action': 'attach-channel-confirm' }) });
  await flushAsync();
  assert.equal(harness.agentChannelPosts[0]?.body.channelId, 'C_NEW');
});

test('Add to channels surfaces assignment failures beside the open picker', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture([{ id: 'C_NEW', name: 'new-channel' }]),
    attachSelectionValue: 'C_NEW',
    putAssignmentError: {
      status: 502,
      error: 'assignment_write_failed',
      message: 'Could not save the channel assignment.',
    },
  });
  const click = await openReleaseAttachPicker(harness);
  click({ target: actionTarget({ 'data-action': 'attach-channel-confirm' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Could not save the channel assignment\./);
  assert.match(harness.app.innerHTML, /data-role="attach-channel"/);
});

test('Add to channels lets publication reconcile public app membership', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture([{ id: 'C_NEW', name: 'new-channel' }]),
    attachSelectionValue: 'C_NEW',
    putIsMember: false,
  });
  const click = await openReleaseAttachPicker(harness);
  click({ target: actionTarget({ 'data-action': 'attach-channel-confirm' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Agent added to #new-channel/);
  assert.doesNotMatch(harness.app.innerHTML, /Invite it to #new-channel in Slack/);
});

test('Add to channels defers app-membership truth to the publication endpoint', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture([{ id: 'C_NEW', name: 'new-channel', isMember: false }]),
    attachSelectionValue: 'C_NEW',
    // No putIsMember fixture: this mirrors the assignment route's graceful
    // conversations.info failure, where the save succeeds without that field.
  });
  const click = await openReleaseAttachPicker(harness);
  click({ target: actionTarget({ 'data-action': 'attach-channel-confirm' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Agent added to #new-channel/);
});

test('Add to channels keeps the Agent editor stable when Slack authorization is stale', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture([{ id: 'C_NEW', name: 'new-channel' }]),
    slackChannelFailures: 2,
  });
  await openReleaseAttachPicker(harness);

  assert.equal(harness.channelListCalls.length, 2);
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Release Profile<\/h1>/);
});

test('Add to channels can refresh an already-loaded workspace catalog', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture([{ id: 'C_NEW', name: 'new-channel' }]),
    attachSelectionValue: 'C_NEW',
  });
  const click = await openReleaseAttachPicker(harness);
  const change = harness.listeners.change;
  assert.ok(change);

  assert.match(harness.app.innerHTML, /data-action="refresh-channels"[^>]*>[^<]*<svg[\s\S]*?Refresh<\/button>/);
  // Simulate a previously selected channel disappearing from the refreshed
  // catalog; confirmation must fall back to the browser's current option.
  change({ target: inputTarget({ 'data-action': 'attach-channel-option' }, 'C_GONE') });
  click({ target: actionTarget({ 'data-action': 'refresh-channels' }) });
  await flushAsync();
  assert.deepEqual(harness.channelListCalls, ['/admin/api/slack-channels', '/admin/api/slack-channels?refresh=1']);
  click({ target: actionTarget({ 'data-action': 'attach-channel-confirm' }) });
  await flushAsync();
  assert.equal(harness.agentChannelPosts[0]?.body.channelId, 'C_NEW');
});

test('Add to channels explains the disconnected state without requesting a catalog', async () => {
  const harness = runAdminPageHarness({ slackConnection: disconnectedSlackFixture() });
  await openReleaseAttachPicker(harness);

  assert.match(harness.app.innerHTML, /Connect @Chickpea first to list workspace channels\./);
  assert.deepEqual(harness.channelListCalls, []);
});

test('Add to channels reports when every available channel already uses the profile', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture([{ id: 'C0EXR3L9T', name: 'eng-releases' }]),
  });
  await openReleaseAttachPicker(harness);

  assert.match(harness.app.innerHTML, /All available Slack Channels already use this Agent\./);
  assert.match(harness.app.innerHTML, /Add a new Channel with this Agent/);
});

test('Add to channels preserves the Agent panel scroll when no candidates remain', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture([{ id: 'C0EXR3L9T', name: 'eng-releases' }]),
    resetDocumentScrollOnRender: true,
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  await flushAsync();

  harness.setMainScrollTop(486);
  harness.setDocumentScrollTop(486);
  click({ target: actionTarget({ 'data-action': 'attach-open' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /All available Slack Channels already use this Agent\./);
  assert.equal(harness.mainScrollTop(), 486);
  assert.equal(harness.documentScrollTop(), 486);
});

test('Add to channels preserves scroll when a catalog request finishes after the picker closes', async () => {
  let resolveSlackChannels: ((response: FakeResponse) => void) | undefined;
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    slackConnection: connectedSlackFixture(),
    slackChannelsFetch: () => new Promise((resolve) => { resolveSlackChannels = resolve; }),
    resetDocumentScrollOnRender: true,
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  await flushAsync();

  harness.setMainScrollTop(486);
  harness.setDocumentScrollTop(486);
  click({ target: actionTarget({ 'data-action': 'attach-open' }) });
  click({ target: actionTarget({ 'data-action': 'attach-cancel' }) });
  assert.equal(harness.mainScrollTop(), 486);
  assert.equal(harness.documentScrollTop(), 486);

  assert.ok(resolveSlackChannels);
  resolveSlackChannels(jsonResponse({
    channels: [{ id: 'C_NEW', name: 'new-channel', isPrivate: false, isMember: true }],
    teamId: 'T_DESIGN',
    teamName: 'Acme Inc',
    truncated: false,
  }));
  await flushAsync();

  assert.equal(harness.mainScrollTop(), 486);
  assert.equal(harness.documentScrollTop(), 486);
});

test('Add to channels preserves scroll across a catalog error and retry', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture([{ id: 'C_NEW', name: 'new-channel' }]),
    slackChannelFailures: 1,
    resetDocumentScrollOnRender: true,
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  await flushAsync();

  harness.setMainScrollTop(486);
  harness.setDocumentScrollTop(486);
  click({ target: actionTarget({ 'data-action': 'attach-open' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Slack permissions are out of date/);
  assert.equal(harness.mainScrollTop(), 486);
  assert.equal(harness.documentScrollTop(), 486);

  click({ target: actionTarget({ 'data-action': 'refresh-channels' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /new-channel/);
  assert.equal(harness.mainScrollTop(), 486);
  assert.equal(harness.documentScrollTop(), 486);
});

test('Add to channels escapes catalog values and offers the truncated-list fallback', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture(
      [{ id: 'C_NEW"><script>', name: '<img src=x onerror=alert(1)>' }],
      true,
    ),
  });
  await openReleaseAttachPicker(harness);

  assert.ok(harness.app.innerHTML.includes('value="C_NEW&quot;&gt;&lt;script&gt;"'));
  assert.ok(harness.app.innerHTML.includes('#&lt;img src=x onerror=alert(1)&gt;'));
  assert.doesNotMatch(harness.app.innerHTML, /<img src=x/);
  assert.match(harness.app.innerHTML, /data-action="attach-new-channel"[^>]*>Add a new channel/);
});

test('the truncated-list fallback carries the edited profile into Add channel', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture([{ id: 'C_NEW', name: 'new-channel' }], true),
  });
  const click = await openReleaseAttachPicker(harness);
  const submit = harness.listeners.submit;
  assert.ok(submit);
  click({ target: actionTarget({ 'data-action': 'attach-new-channel', 'data-agent': 'agent_release' }) });

  assert.match(harness.app.innerHTML, /Publish Release Profile/);
  submit({
    target: submitTarget({ 'data-action': 'add-channel-form' }, { channelSelect: 'C_NEW' }),
    preventDefault() {},
  });
  await flushAsync();
  assert.deepEqual(harness.agentChannelPosts, [{
    agentId: 'agent_release',
    body: { workspaceId: 'T_DESIGN', channelId: 'C_NEW' },
  }]);
});

test('profile capability tabs switch the visible panel on click', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });

  // Instructions is the default tab: its panel is visible, the others [hidden].
  assert.match(harness.app.innerHTML, /id="ptab-instructions" class="ptab on" role="tab" aria-selected="true" tabindex="0" aria-controls="ptab-panel-instructions"/);
  assert.match(harness.app.innerHTML, /id="ptab-skills" class="ptab" role="tab" aria-selected="false" tabindex="-1" aria-controls="ptab-panel-skills"/);
  assert.match(harness.app.innerHTML, /id="ptab-panel-skills"[^>]* hidden/);
  assert.doesNotMatch(harness.app.innerHTML, /id="ptab-panel-instructions"[^>]* hidden/);
  assert.match(harness.app.innerHTML, /<h3[^>]*>Instructions<\/h3>/);
  assert.match(harness.app.innerHTML, /The role, priorities, and boundaries this Agent follows everywhere it works/);
  assert.match(harness.app.innerHTML, /aria-label="Agent instructions"/);

  // Clicking the Skills tab swaps the visible panel and the active pill.
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });
  assert.match(harness.app.innerHTML, /id="ptab-skills" class="ptab on"/);
  assert.match(harness.app.innerHTML, /id="ptab-panel-instructions"[^>]* hidden/);
  assert.doesNotMatch(harness.app.innerHTML, /id="ptab-panel-skills"[^>]* hidden/);

  // And back to Connections.
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  assert.match(harness.app.innerHTML, /id="ptab-connections" class="ptab on"/);
  assert.doesNotMatch(harness.app.innerHTML, /id="ptab-panel-connections"[^>]* hidden/);

  // Roving keyboard navigation activates and focuses the next tab.
  harness.listeners.keydown?.({
    target: actionClassTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }, 'ptab'),
    key: 'ArrowRight',
    preventDefault() {},
  });
  assert.match(harness.app.innerHTML, /id="ptab-repositories" class="ptab on" role="tab" aria-selected="true" tabindex="0"/);
  assert.equal(harness.focusedAction(), 'ptab-repositories');

  // Mid-typed whitespace survives a tab round-trip: the keystroke mirror (not
  // a trimming collectProfileDraft) carries the draft across the re-render.
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'instructions' }) });
  input({ target: inputTarget({ 'data-action': 'profile-instructions' }, 'Answer carefully.\n\n- next bullet ') });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'instructions' }) });
  assert.match(harness.app.innerHTML, /Answer carefully\.\n\n- next bullet </);
  assert.equal((harness.app.innerHTML.match(/class="save-bar-sticky/g) ?? []).length, 1);
});

test('Agent configuration tabs preserve the Slack destination disclosure state', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/agents/agent_release' });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  assert.match(harness.app.innerHTML, /<details class="agent-destination-card" open>/);

  click({ target: actionTarget({ 'data-action': 'agent-destination-toggle' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });
  assert.match(harness.app.innerHTML, /<details class="agent-destination-card">/);
  assert.doesNotMatch(harness.app.innerHTML, /<details class="agent-destination-card" open>/);

  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'instructions' }) });
  assert.match(harness.app.innerHTML, /<details class="agent-destination-card">/);

  click({ target: actionTarget({ 'data-action': 'agent-destination-toggle' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });
  assert.match(harness.app.innerHTML, /<details class="agent-destination-card" open>/);
});

test('opening Schedules revalidates work created after the Agent editor opened', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agentSchedules: [],
  });
  await flushAsync();
  assert.equal(harness.agentScheduleGets(), 0);

  harness.setAgentSchedules([{
    id: 'routine_added_after_open',
    name: 'Fresh schedule from Slack',
    contentAccess: 'readable',
    status: 'active',
    version: 1,
    cadence: { triggerKind: 'schedule', scheduleInput: '0 9 * * 1-5', timezone: 'America/Los_Angeles' },
    channelLabel: 'eng-releases',
    nextRunAt: 1_785_168_000_000,
    lastFinishedAt: null,
    actions: { pause: true, resume: false, delete: true },
  }]);
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'schedules' }) });
  await flushAsync();

  assert.equal(harness.agentScheduleGets(), 1);
  assert.match(harness.app.innerHTML, /Fresh schedule from Slack/);
});

test('Agent Schedules explains that private DM schedules stay in Slack even when no Channel schedules exist', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agentSchedules: [],
  });
  await flushAsync();

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'schedules' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /No scheduled work/);
  assert.match(harness.app.innerHTML, /Private DM schedules are not shown here\. Manage them in the Chickpea DM where they were created\./);
  assert.doesNotMatch(harness.app.innerHTML, /id="ptab-schedules"[^>]*>Schedules<span class="ptab-count">/);
});

test('Agent Schedules is a compact controllable flat list with authoritative refreshes', async () => {
  const schedule = (
    id: string,
    name: string,
    status: string,
    actions: { pause: boolean; resume: boolean; delete: boolean },
    overrides: Record<string, unknown> = {},
  ) => ({
    id,
    name,
    contentAccess: 'readable',
    status,
    version: 4,
    cadence: {
      triggerKind: 'schedule',
      scheduleInput: '0 9 * * 1-5',
      timezone: 'America/Los_Angeles',
    },
    channelLabel: 'eng-releases',
    nextRunAt: 1_785_168_000_000,
    lastFinishedAt: 1_785_081_600_000,
    actions,
    ...overrides,
  });
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agentSchedules: [
      schedule(
        'routine_active',
        'Daily launch readiness digest with a deliberately long but still scannable name',
        'active',
        { pause: true, resume: false, delete: true },
        {
          prompt: 'SECRET_PROMPT_MUST_NOT_RENDER',
          description: 'SECRET_DESCRIPTION_MUST_NOT_RENDER',
          runsAs: 'SECRET_RUNS_AS_MUST_NOT_RENDER',
          connectionCount: 9,
          channelId: 'C_RAW_MUST_NOT_RENDER',
          pausedReason: 'member_pause',
          runs: ['SECRET_HISTORY_MUST_NOT_RENDER'],
        },
      ),
      schedule('routine_paused', 'Weekly customer summary', 'paused', {
        pause: false, resume: true, delete: true,
      }),
      schedule('routine_attention', 'Dependency follow-up', 'needs_attention', {
        pause: false, resume: false, delete: true,
      }),
      schedule('routine_completed', 'One-time migration reminder', 'completed', {
        pause: false, resume: false, delete: true,
      }, {
        cadence: { triggerKind: 'once', scheduleInput: '2026-07-27T11:00', timezone: 'UTC' },
        nextRunAt: null,
      }),
    ],
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'schedules' }) });
  await flushAsync();

  const initial = harness.app.innerHTML;
  assert.match(initial, /class="agent-schedule-list"/);
  assert.match(initial, /class="agent-schedule-name"[^>]*>Daily launch readiness digest/);
  assert.match(initial, />Active<\/span>/);
  assert.match(initial, />Paused<\/span>/);
  assert.match(initial, />Needs attention<\/span>/);
  assert.match(initial, />Completed<\/span>/);
  assert.match(initial, /Weekdays at 9:00 AM Pacific/);
  assert.match(initial, /#eng-releases/);
  assert.match(initial, /Next run/);
  assert.match(initial, /Last run/);
  assert.match(initial, /aria-label="Pause Daily launch readiness digest/);
  assert.match(initial, /aria-label="Resume Weekly customer summary"/);
  assert.match(initial, /aria-label="Delete One-time migration reminder"/);
  assert.match(initial, /Private DM schedules are not shown here\. Manage them in the Chickpea DM where they were created\./);
  assert.match(initial, /id="ptab-schedules"[^>]*>Schedules<span class="ptab-count">4<\/span>/);
  assert.doesNotMatch(initial, /SECRET_PROMPT_MUST_NOT_RENDER|SECRET_DESCRIPTION_MUST_NOT_RENDER|SECRET_RUNS_AS_MUST_NOT_RENDER|SECRET_HISTORY_MUST_NOT_RENDER|C_RAW_MUST_NOT_RENDER|member_pause/);
  assert.doesNotMatch(initial, /Runs as:|Connections:|Create schedule|Edit timing|data-action="agent-schedule-reassign"/);

  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'agent-schedule-control',
      'data-control': 'pause',
      'data-schedule-id': 'routine_active',
    }),
  });
  await flushAsync();
  assert.equal(harness.agentScheduleGets(), 2);
  assert.deepEqual(harness.agentScheduleControlPosts[0]?.body, {
    action: 'pause', expectedVersion: 4,
  });
  assert.ok(harness.agentScheduleControlPosts[0]?.idempotencyKey);
  assert.match(harness.app.innerHTML, /aria-label="Resume Daily launch readiness digest/);
  assert.match(harness.app.innerHTML, /Schedule paused\./);

  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'agent-schedule-control',
      'data-control': 'resume',
      'data-schedule-id': 'routine_paused',
    }),
  });
  await flushAsync();
  assert.equal(harness.agentScheduleGets(), 3);
  assert.deepEqual(harness.agentScheduleControlPosts[1]?.body, {
    action: 'resume', expectedVersion: 4,
  });
  assert.match(harness.app.innerHTML, /aria-label="Pause Weekly customer summary"/);
  assert.match(harness.app.innerHTML, /Schedule resumed\./);

  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'agent-schedule-delete-open',
      'data-schedule-id': 'routine_active',
    }),
  });
  assert.match(harness.app.innerHTML, /role="dialog" aria-modal="true" aria-labelledby="agent-schedule-delete-title"/);
  assert.equal(harness.focusedAction(), 'agent-schedule-delete-cancel');
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'agent-schedule-delete-cancel' }) });
  assert.equal(harness.focusedAction(), 'agent-schedule-delete-routine_active');

  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'agent-schedule-delete-open',
      'data-schedule-id': 'routine_active',
    }),
  });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'agent-schedule-delete-confirm' }) });
  await flushAsync();
  assert.deepEqual(harness.agentScheduleControlPosts[2]?.body, {
    action: 'delete', expectedVersion: 5, acknowledgeIrreversible: true,
  });
  assert.equal(harness.agentScheduleGets(), 4);
  assert.doesNotMatch(harness.app.innerHTML, /Daily launch readiness digest/);
  assert.match(harness.app.innerHTML, /id="ptab-schedules"[^>]*>Schedules<span class="ptab-count">3<\/span>/);
  assert.match(harness.app.innerHTML, /Schedule deleted\./);
});

test('failed Agent schedule control reloads the latest row and reports a safe error', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agentSchedules: [{
      id: 'routine_conflict', name: 'Conflict canary', contentAccess: 'readable', status: 'active', version: 7,
      cadence: { triggerKind: 'schedule', scheduleInput: '*/5 * * * *', timezone: 'UTC' },
      channelLabel: 'schedule-lab', nextRunAt: 1_785_168_000_000, lastFinishedAt: null,
      actions: { pause: true, resume: false, delete: true },
    }],
    agentScheduleControlError: {
      status: 409,
      error: 'routine_version_conflict',
      message: 'SECRET_SERVER_DETAIL_MUST_NOT_RENDER',
    },
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'schedules' }) });
  await flushAsync();
  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'agent-schedule-control',
      'data-control': 'pause',
      'data-schedule-id': 'routine_conflict',
    }),
  });
  await flushAsync();

  assert.equal(harness.agentScheduleGets(), 2);
  assert.match(harness.app.innerHTML, /Conflict canary/);
  assert.match(harness.app.innerHTML, /This schedule changed elsewhere\. Review the latest state before trying again\./);
  assert.doesNotMatch(harness.app.innerHTML, /SECRET_SERVER_DETAIL_MUST_NOT_RENDER/);
});

test('schedule revalidation preserves an in-flight control and completion cannot reload a stale Agent', async () => {
  let resolveControl!: (response: FakeResponse) => void;
  let resolveOpsSchedules!: (response: FakeResponse) => void;
  const controlResponse = new Promise<FakeResponse>((resolve) => {
    resolveControl = resolve;
  });
  const pendingSchedule = {
    id: 'routine_pending', name: 'Pending control canary', contentAccess: 'readable', status: 'active', version: 1,
    cadence: { triggerKind: 'schedule', scheduleInput: '*/5 * * * *', timezone: 'UTC' },
    channelLabel: 'schedule-lab', nextRunAt: 1_785_168_000_000, lastFinishedAt: null,
    actions: { pause: true, resume: false, delete: true },
  };
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agentSchedulesFetch(agentId) {
      if (agentId === 'agent_ops') {
        return new Promise((resolve) => { resolveOpsSchedules = resolve; });
      }
      return Promise.resolve(jsonResponse({ schedules: [pendingSchedule] }));
    },
    agentScheduleControlFetch: () => controlResponse,
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'schedules' }) });
  await flushAsync();
  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'agent-schedule-control',
      'data-control': 'pause',
      'data-schedule-id': 'routine_pending',
    }),
  });
  assert.match(harness.app.innerHTML, /Pausing&hellip;/);

  harness.focusWindow();
  await flushAsync();
  assert.equal(harness.agentScheduleGets(), 2);
  assert.match(harness.app.innerHTML, /Pausing&hellip;/);
  assert.match(harness.app.innerHTML, /aria-label="Pause Pending control canary" disabled/);

  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_ops' }),
  });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'schedules' }) });
  assert.match(harness.app.innerHTML, /class="page-title">Ops Profile<\/h1>/);
  assert.match(harness.app.innerHTML, /Loading Agent schedules/);
  resolveControl(jsonResponse({ schedule: { id: 'routine_pending', status: 'paused', version: 2 } }));
  await flushAsync();
  assert.equal(harness.agentScheduleGets(), 3);
  resolveOpsSchedules(jsonResponse({ schedules: [{
    ...pendingSchedule,
    id: 'routine_ops',
    name: 'Ops schedule from current response',
  }] }));
  await flushAsync();
  assert.match(harness.app.innerHTML, /class="page-title">Ops Profile<\/h1>/);
  assert.match(harness.app.innerHTML, /Ops schedule from current response/);
  assert.doesNotMatch(harness.app.innerHTML, /Loading Agent schedules/);
});

test('schedule refresh closes a delete confirmation whose row disappeared', async () => {
  const schedule = {
    id: 'routine_disappears', name: 'Disappearing schedule', contentAccess: 'readable', status: 'active', version: 1,
    cadence: { triggerKind: 'schedule', scheduleInput: '*/5 * * * *', timezone: 'UTC' },
    channelLabel: 'schedule-lab', nextRunAt: 1_785_168_000_000, lastFinishedAt: null,
    actions: { pause: true, resume: false, delete: true },
  };
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agentSchedulesFetch(_agentId, call) {
      return Promise.resolve(jsonResponse({ schedules: call === 1 ? [schedule] : [] }));
    },
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'schedules' }) });
  await flushAsync();
  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'agent-schedule-delete-open',
      'data-schedule-id': schedule.id,
    }),
  });
  assert.match(harness.app.innerHTML, /Delete Disappearing schedule/);

  harness.focusWindow();
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /agent-schedule-delete-title/);
  assert.match(harness.app.innerHTML, /No scheduled work/);
  assert.equal(harness.focusedAction(), 'ptab-schedules');
});

test('opening an editable Agent view revalidates its visible detail without loading hidden tabs', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agentDetailFetch() {
      return Promise.resolve(jsonResponse({
        agent: { ...releaseAgent, name: 'Release Profile from server' },
      }));
    },
  });
  await flushAsync();

  assert.equal(harness.agentDetailGets(), 1);
  assert.match(harness.app.innerHTML, /Release Profile from server/);
  assert.equal(harness.agentConnectionGets(), 0);
  assert.equal(harness.agentScheduleGets(), 0);
  assert.deepEqual(harness.ownerMemoryGetCaches, []);
});

test('focus revalidates only the current Agent surface and active data tab', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/agents/agent_release' });
  await flushAsync();
  const initialSlackGets = harness.slackStatusGets();
  const initialDetailGets = harness.agentDetailGets();

  harness.focusWindow();
  await flushAsync();

  assert.equal(harness.agentDetailGets(), initialDetailGets + 1);
  assert.equal(harness.slackStatusGets(), initialSlackGets + 1);
  assert.equal(harness.agentConnectionGets(), 0);
  assert.equal(harness.agentScheduleGets(), 0);
  assert.deepEqual(harness.ownerMemoryGetCaches, []);
});

test('focus and visibility coalesce while the active schedule request is loading', async () => {
  let resolveSchedules: ((response: FakeResponse) => void) | undefined;
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agentSchedulesFetch() {
      return new Promise((resolve) => { resolveSchedules = resolve; });
    },
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'schedules' }) });
  assert.equal(harness.agentScheduleGets(), 1);

  harness.focusWindow();
  harness.setVisibility('visible');
  await flushAsync();
  assert.equal(harness.agentScheduleGets(), 1);

  assert.ok(resolveSchedules);
  resolveSchedules(jsonResponse({ schedules: [] }));
  await flushAsync();
  assert.match(harness.app.innerHTML, /No scheduled work/);
});

test('a stale schedule response cannot overwrite a newer owner generation', async () => {
  let resolveFirstRelease: ((response: FakeResponse) => void) | undefined;
  const compactSchedule = (id: string, name: string) => ({
    id,
    name,
    contentAccess: 'readable',
    status: 'active',
    version: 1,
    cadence: { triggerKind: 'schedule', scheduleInput: '0 9 * * *', timezone: 'UTC' },
    channelLabel: 'eng-releases',
    nextRunAt: 1_785_168_000_000,
    lastFinishedAt: null,
    actions: { pause: true, resume: false, delete: true },
  });
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agentSchedulesFetch(agentId, call) {
      if (agentId === 'agent_release' && call === 1) {
        return new Promise((resolve) => { resolveFirstRelease = resolve; });
      }
      return Promise.resolve(jsonResponse({
        schedules: [compactSchedule(
          agentId === 'agent_release' ? 'routine_release_new' : 'routine_ops',
          agentId === 'agent_release' ? 'Newest release schedule' : 'Ops schedule',
        )],
      }));
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'schedules' }) });
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_ops' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'schedules' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'schedules' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Newest release schedule/);

  assert.ok(resolveFirstRelease);
  resolveFirstRelease(jsonResponse({ schedules: [compactSchedule('routine_release_old', 'Stale release schedule')] }));
  await flushAsync();
  assert.match(harness.app.innerHTML, /Newest release schedule/);
  assert.doesNotMatch(harness.app.innerHTML, /Stale release schedule/);
});

test('read-only Agent tabs do not start edit-only resource loads', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agents: [{ ...releaseAgent, canEdit: false }],
  });
  await flushAsync();
  for (const tab of ['connections', 'repositories', 'memory', 'schedules']) {
    harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': tab }) });
  }
  await flushAsync();
  harness.focusWindow();
  await flushAsync();

  assert.equal(harness.agentDetailGets(), 0);
  assert.equal(harness.agentConnectionGets(), 0);
  assert.equal(harness.agentScheduleGets(), 0);
  assert.deepEqual(harness.ownerMemoryGetCaches, []);
});

test('a connection mutation refreshes Connections without loading hidden Agent resources', async () => {
  const account = {
    id: 'connection_linear', workspaceId: 'T_DESIGN', ownerKind: 'team',
    providerId: 'linear', label: 'Linear', lifecycle: 'ready', credentialConfigured: true,
    policy: { kind: 'api', allowedCapabilities: ['issues.read'] },
  };
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    connectionAccounts: { attached: [ownedConnection(account, 'agent_release')] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  assert.equal(harness.agentConnectionGets(), 1);

  click({
    target: actionTarget({
      'data-action': 'connection-account-disconnect',
      'data-connection-id': 'connection_linear',
    }),
  });
  await flushAsync();

  assert.equal(harness.agentConnectionGets(), 2);
  assert.equal(harness.agentScheduleGets(), 0);
  assert.deepEqual(harness.ownerMemoryGetCaches, []);
  assert.match(harness.app.innerHTML, /No connections in this Agent yet/);
});

test('a repository draft mutation revalidates only Repositories on focus', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agents: [{
      ...releaseAgent,
      repositories: [{
        id: 'repo_acme_release', installationId: 77, accountLogin: 'acme',
        fullName: 'acme/release', enabled: true,
      }],
    }],
    githubStatus: {
      mode: 'app',
      installations: [{ id: 77, accountLogin: 'acme', accountType: 'Organization', repoCount: 1 }],
      referencingProfiles: [],
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'repositories' }) });
  await flushAsync();
  assert.equal(harness.settingsGetCalls.filter((path) => path === '/admin/api/github/status').length, 1);

  click({ target: actionTarget({ 'data-action': 'repo-remove', 'data-repository-id': 'repo_acme_release' }) });
  harness.focusWindow();
  await flushAsync();

  assert.equal(harness.settingsGetCalls.filter((path) => path === '/admin/api/github/status').length, 2);
  assert.equal(harness.agentConnectionGets(), 0);
  assert.equal(harness.agentScheduleGets(), 0);
  assert.deepEqual(harness.ownerMemoryGetCaches, []);
  assert.doesNotMatch(harness.app.innerHTML, /acme\/release/);
});

test('Agent description lives under the title and is edited with its pencil', async () => {
  const richHarness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_intro',
    agents: [{
      ...releaseAgent,
      id: 'agent_intro',
      name: 'Introduction Agent',
      description: 'Explains release readiness for the team.',
      instructions: '**Answer** [release questions](https://example.com/release) with `care` and _clarity_.\n\nKeep this second paragraph out.',
    }],
  });
  await flushAsync();

  assert.match(
    richHarness.app.innerHTML,
    /class="agent-profile-intro"[^>]*aria-label="Explains release readiness for the team\."[^>]*>Explains release readiness for the team\.<\/p>/,
  );
  assert.match(richHarness.app.innerHTML, /data-action="profile-description-edit" aria-label="Edit Agent description"/);
  assert.doesNotMatch(richHarness.app.innerHTML, /Mention as/);
  assert.match(richHarness.app.innerHTML, /Keep this second paragraph out/);
  richHarness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-description-edit' }) });
  assert.match(richHarness.app.innerHTML, /id="p-description"[^>]*value="Explains release readiness for the team\."[^>]*data-action="profile-description"/);
  richHarness.listeners.input?.({
    target: inputTarget({ 'data-action': 'profile-description' }, 'Edited description.'),
  });
  richHarness.listeners.keydown?.({
    target: inputTarget({ 'data-action': 'profile-description' }, 'Edited description.'),
    key: 'Enter',
    preventDefault() {},
  });
  assert.match(richHarness.app.innerHTML, /class="agent-profile-intro"[^>]*>Edited description\.<\/p>/);
  richHarness.listeners.click?.({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(richHarness.agentPatchBodies[0]?.body.description, 'Edited description.');
  assert.equal(Object.hasOwn(richHarness.agentPatchBodies[0]?.body ?? {}, 'introduction'), false);

  const emptyHarness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_empty_intro',
    agents: [{ ...releaseAgent, id: 'agent_empty_intro', description: '' }],
  });
  await flushAsync();
  assert.match(emptyHarness.app.innerHTML, /class="agent-description-row is-empty"[\s\S]*?Add a description/);
  assert.doesNotMatch(emptyHarness.app.innerHTML, /class="agent-description-row empty"/);
});

test('the pencil glyph reads as a pencil and stays balanced in both square treatments', () => {
  const page = renderAdminPage();
  const pencil = /\bpencil: "([^"]+)"/.exec(page)?.[1];
  assert.ok(pencil, 'the shared icon set must still define a pencil');

  // A tapered barrel plus a detached ferrule/eraser cap. A single subpath is the
  // regression to guard: it renders as a diagonal wedge, not a recognisable pencil.
  assert.equal((pencil.match(/Z/g) ?? []).length, 2, 'the pencil needs a barrel and a separate ferrule');

  const points: Array<[number, number]> = [];
  for (const segment of pencil.matchAll(/([MLA])([^A-Za-z]*)/g)) {
    const args = (segment[2]?.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    // Arc segments carry rx ry rotation large-arc sweep before their endpoint.
    const stride = segment[1] === 'A' ? 7 : 2;
    for (let index = 0; index + stride <= args.length; index += stride) {
      points.push([args[index + stride - 2] ?? NaN, args[index + stride - 1] ?? NaN]);
    }
  }
  assert.ok(points.length >= 12, 'the pencil outline should expose every corner as an explicit point');

  // The pencil lies on the square's anti-diagonal, so every point must have a
  // partner mirrored across it. That is what keeps the glyph from leaning to one
  // flank once it is centred in the 26px button and the 34px semantic tile.
  const key = ([x, y]: [number, number]) => `${x.toFixed(3)},${y.toFixed(3)}`;
  const seen = new Set(points.map(key));
  for (const [x, y] of points) {
    assert.ok(seen.has(key([16 - y, 16 - x])), `pencil point ${key([x, y])} has no mirrored partner`);
  }

  // Optical size: the ink keeps a margin on every side of the 16-unit viewBox.
  for (const value of points.flat()) {
    assert.ok(value >= 2 && value <= 14, `pencil coordinate ${value} escapes the icon's optical margin`);
  }

  // Both square treatments pin the glyph size, so the narrow-viewport `.ic` bump
  // cannot swell a 16px pencil inside a 26px button.
  assert.match(page, /\.rename-btn \.ic\s*\{[^}]*height:\s*16px;[^}]*width:\s*16px;/s);
  assert.match(page, /\.agent-tab-icon \.ic, \.agent-card-icon \.ic\s*\{[^}]*height:\s*18px;[^}]*width:\s*18px;/s);
});

test('Agent lifecycle overflow is the sole truthful control and restores keyboard focus', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin' });
  await flushAsync();

  assert.match(harness.app.innerHTML, /class="agent-status-chip enabled"[^>]*>[^<]*<span[^>]*><\/span>Active<\/span>/);
  assert.match(harness.app.innerHTML, /data-action="agent-overflow-toggle"[^>]*aria-label="Actions for Release Profile"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="profile-enable-toggle"|class="profile-foot"/);

  harness.listeners.keydown?.({
    target: actionClassTarget({ 'data-action': 'agent-overflow-toggle' }, 'agent-overflow-trigger'),
    key: 'Enter',
    preventDefault() {},
  });
  assert.match(harness.app.innerHTML, /data-action="agent-overflow-toggle"[^>]*aria-expanded="true"/);
  assert.match(harness.app.innerHTML, /role="menu" aria-label="Agent lifecycle actions"/);
  assert.match(harness.app.innerHTML, /role="menuitem" data-action="archive-profile">Archive Agent<\/button>/);
  assert.equal(harness.focusedAction(), 'archive-profile');

  harness.listeners.keydown?.({
    target: actionClassTarget({ 'data-action': 'archive-profile' }, 'agent-overflow-menuitem'),
    key: 'Escape',
    preventDefault() {},
  });
  assert.doesNotMatch(harness.app.innerHTML, /role="menu" aria-label="Agent lifecycle actions"/);
  assert.equal(harness.focusedAction(), 'agent-overflow-toggle');
});

test('a discoverable Agent can be duplicated without copying authority', async () => {
  const source = {
    ...releaseAgent,
    skills: [{ name: 'release-notes', description: 'Summarize releases', instructions: 'Read the changelog.', enabled: true }],
    mcpServers: [{ id: 'zendesk', name: 'Zendesk', url: 'https://example.zendesk.com/mcp', enabled: true }],
    apiConnections: [{ id: 'status-api', name: 'Status API', baseUrl: 'https://status.example.com', enabled: true }],
    repositories: [{ repositoryId: 42, fullName: 'acme/private', enabled: true }],
  };
  const harness = runAdminPageHarness({ initialPath: '/admin/agents/agent_release', agents: [source, opsAgent] });
  await flushAsync();

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'agent-overflow-toggle' }) });
  assert.match(harness.app.innerHTML, /data-action="duplicate-profile"[^>]*>Duplicate Agent<\/button>/);
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'duplicate-profile', 'data-agent': source.id }) });

  assert.match(harness.app.innerHTML, /<h1 class="page-title">New Agent<\/h1>/);
  assert.match(harness.app.innerHTML, /Copied from Release Profile/);
  assert.match(harness.app.innerHTML, /value="Release Profile copy"/);
  assert.match(harness.app.innerHTML, /value="release-profile-copy"/);
  assert.match(harness.app.innerHTML, /Channel access, connections, repositories, memory, and schedules stay separate/);
  assert.doesNotMatch(harness.app.innerHTML, /example\.zendesk\.com|status\.example\.com|acme\/private/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPostBodies.length, 1);
  assert.deepEqual(harness.agentPostBodies[0]?.mcpServers, []);
  assert.deepEqual(harness.agentPostBodies[0]?.apiConnections, []);
  assert.deepEqual(harness.agentPostBodies[0]?.repositories, []);
  assert.deepEqual(harness.agentPostBodies[0]?.skills, source.skills);
});

test('a discoverable non-editor sees a truthful read-only Agent instead of a failing editor', async () => {
  const source = {
    ...releaseAgent,
    canEdit: false,
    handle: 'release',
    editPolicy: 'creator_and_admins',
  };
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agents: [source, opsAgent],
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Read-only Agent/);
  assert.match(harness.app.innerHTML, /class="agent-profile-avatar agent-profile-avatar-static"/);
  assert.doesNotMatch(harness.app.innerHTML, /agent-profile-avatar-upload|agent-avatar-hover|profile-avatar-upload/);
  assert.match(harness.app.innerHTML, /data-action="profile-handle" readonly/);
  assert.match(harness.app.innerHTML, /data-action="profile-edit-policy" disabled/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="profile-rename"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="profile-description-edit"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="save-profile"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="attach-open"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="detach-channel"/);
  assert.deepEqual(harness.ownerMemoryGetCaches, []);
  assert.deepEqual(harness.scheduledApiCalls, []);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'agent-overflow-toggle' }) });
  assert.match(harness.app.innerHTML, /data-action="duplicate-profile"[^>]*>Duplicate Agent<\/button>/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="archive-profile"|data-action="restore-profile"/);
});

test('archiving the workspace Default Agent transfers private routing explicitly', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin',
    agents: [{ ...releaseAgent, isWorkspaceDefault: true }, opsAgent],
    workspaceDefault: {
      workspaceId: 'T_DESIGN',
      modelId: releaseAgent.model,
      revision: 1,
      provenance: 'migration_pending',
      runtimeContract: 'legacy',
      live: false,
      inheritingAgentCount: 0,
      health: { status: 'ready', providerId: 'local-stub' },
    },
  });
  await flushAsync();

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'agent-overflow-toggle' }) });
  assert.match(harness.app.innerHTML, /Legacy default Agent after archive/);
  assert.match(
    harness.app.innerHTML,
    /data-action="replacement-default-agent">[\s\S]*?<option value="agent_ops" selected>Ops Profile<\/option>/,
  );

  harness.listeners.change?.({
    target: valueTarget({ 'data-action': 'replacement-default-agent' }, 'agent_ops'),
  });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'archive-profile' }) });
  await flushAsync();

  assert.deepEqual(harness.agentArchivePosts, [{
    id: 'agent_release',
    body: { expectedRevision: 1, replacementDefaultAgentId: 'agent_ops' },
  }]);
  assert.match(harness.app.innerHTML, /agent-status-chip disabled[\s\S]*?Archived/);
  assert.doesNotMatch(harness.app.innerHTML, /Legacy default Agent after archive/);
  assert.match(harness.app.innerHTML, /Release Profile is archived/);
  assert.match(harness.app.innerHTML, /Restore this Agent before adding it to Channels\./);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="attach-open"/);
  assert.doesNotMatch(harness.app.innerHTML, /#eng-releases/);
});

test('Agent archive refreshes and retries once after background presence advances its revision', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_ops',
    agentArchiveConflicts: 1,
  });
  await flushAsync();

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'agent-overflow-toggle' }) });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'archive-profile' }) });
  await flushAsync();

  assert.deepEqual(harness.agentArchivePosts, [
    { id: 'agent_ops', body: { expectedRevision: 1 } },
    { id: 'agent_ops', body: { expectedRevision: 2 } },
  ]);
  assert.match(harness.app.innerHTML, /agent-status-chip disabled[\s\S]*?Archived/);
  assert.doesNotMatch(harness.app.innerHTML, /agent_revision_conflict/);
});

test('agent-first Admin lands on the Default Agent with Destinations in lower navigation', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin' });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/agents/agent_release');
  assert.equal(harness.app.className, 'frame primary-admin-shell admin-surface admin-surface-agent-detail');
  assert.match(harness.app.innerHTML, /<aside class="rail primary-shell-sidebar agent-shell-sidebar">/);
  assert.match(harness.app.innerHTML, /<nav class="agent-roster" aria-label="Agents">/);
  assert.match(harness.app.innerHTML, /<span class="section-eyebrow">Agents<\/span>/);
  const sidebar = harness.app.innerHTML.match(/<aside class="rail primary-shell-sidebar agent-shell-sidebar">[\s\S]*?<\/aside>/)?.[0] ?? '';
  assert.match(sidebar, /<span class="section-eyebrow">Agents<\/span><\/div><nav class="agent-roster"/);
  assert.doesNotMatch(sidebar, /agent-slack-context|agent-slack-row|agent-workspace-row/);
  assert.match(harness.app.innerHTML, /class="agent-roster-item active" data-action="edit-profile" data-agent="agent_release"[^>]*aria-current="page"/);
  assert.match(harness.app.innerHTML, /data-action="open-destinations"[^>]*>Destinations<\/button>/);
  assert.doesNotMatch(harness.app.innerHTML, />Profiles<\/button>|aria-label="Profiles"|>New profile</);
});

test('Agent detail follows the approved compact hierarchy and capability vocabulary', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin' });
  await flushAsync();

  assert.match(harness.app.innerHTML, /class="agent-profile-page"/);
  assert.match(harness.app.innerHTML, /<header class="agent-profile-header">[\s\S]*?<span class="agent-kicker">Agent<\/span>[\s\S]*?<h1 class="page-title">Release Profile<\/h1>/);
  assert.match(harness.app.innerHTML, /class="agent-profile-intro"[^>]*>Release readiness profile<\/p>/);
  assert.match(harness.app.innerHTML, /data-action="profile-description-edit"/);
  assert.doesNotMatch(harness.app.innerHTML, /Mention as|agent-replies-as/);
  assert.match(harness.app.innerHTML, /aria-label="Agent setup"/);
  for (const tab of ['Instructions', 'Skills', 'Connections', 'Repositories', 'Memory', 'Schedules', 'Model']) {
    assert.match(harness.app.innerHTML, new RegExp(`role="tab"[^>]*>${tab}`));
  }
  assert.match(harness.app.innerHTML, /aria-label="Agent instructions"/);
  assert.match(harness.app.innerHTML, /class="agent-tabs-card agent-configuration-card"[\s\S]*?<h2>Agent configuration<\/h2>[\s\S]*?Behavior and capabilities that follow this Agent everywhere\./);
  for (const [tab, tone] of [
    ['instructions', 'instructions'],
    ['skills', 'skill'],
    ['connections', 'connector'],
    ['repositories', 'repository'],
    ['memory', 'memory'],
  ]) {
    assert.match(
      harness.app.innerHTML,
      new RegExp(`id="ptab-panel-${tab}"[\\s\\S]*?class="agent-tab-icon semantic-icon tone-${tone}"`),
    );
  }
  assert.match(harness.app.innerHTML, /class="agent-destinations-section"[\s\S]*?class="agent-card-icon semantic-icon tone-channel"[\s\S]*?<h2>Destinations<\/h2>/);
  assert.match(harness.app.innerHTML, /class="agent-destination-summary"[\s\S]*?<strong>Slack<\/strong>[\s\S]*?1 Slack channel/);
  assert.match(harness.app.innerHTML, /<h3>Slack channels<\/h3>[\s\S]*?class="agent-placement-body">[\s\S]*?class="where-list"/);
  assert.doesNotMatch(harness.app.innerHTML, /agent-slack-channel-count|agent-placement-count/);
  assert.match(harness.app.innerHTML, /class="where-channel-row"[\s\S]*?#<\/span>[\s\S]*?eng-releases/);
  assert.doesNotMatch(harness.app.innerHTML, /<h3[^>]*>Direct messages<\/h3>|workspace Default Agent for private messages/);
  assert.match(harness.app.innerHTML, /data-action="attach-open">Add to channels/);
  assert.match(harness.app.innerHTML, /id="ptab-panel-model"[\s\S]*?class="agent-tab-icon semantic-icon tone-model"[\s\S]*?<h3>Model<\/h3>[\s\S]*?id="p-model"/);
  assert.match(harness.app.innerHTML, /class="[^"]*agent-profile-avatar-upload[^"]*"[\s\S]*?class="advanced agent-advanced-card"[\s\S]*?Who can edit[\s\S]*?Coding sandbox/);
  assert.match(harness.app.innerHTML, /class="agent-advanced-row agent-advanced-policy-row"[\s\S]*?class="agent-advanced-copy"[\s\S]*?class="select-wrap agent-advanced-select"[\s\S]*?<select[^>]*id="p-edit-policy"[\s\S]*?class="ic select-caret"/);
  assert.match(harness.app.innerHTML, /class="agent-advanced-row agent-advanced-sandbox-row"[\s\S]*?class="agent-advanced-actions"[\s\S]*?class="badge agent-advanced-status badge-off"[\s\S]*?Needs repository[\s\S]*?>Settings<\/button>/);
  assert.doesNotMatch(harness.app.innerHTML, /<strong>Slack identity<\/strong>/);
  assert.ok(
    harness.app.innerHTML.indexOf('id="ptab-panel-model"') < harness.app.innerHTML.indexOf('class="advanced agent-advanced-card"'),
    'Model must live inside Agent configuration before Agent Advanced',
  );

  const page = renderAdminPage();
  assert.match(page, /\.admin-surface \.agent-profile-page\s*\{[^}]*font-family:\s*"Avenir Next"/s);
  assert.match(page, /\.agent-profile-identity\s*\{[^}]*align-items:\s*center;[^}]*display:\s*flex;[^}]*gap:\s*18px;/s);
  assert.match(page, /\.agent-profile-avatar\s*\{[^}]*height:\s*96px;[^}]*width:\s*96px;/s);
  assert.match(page, /\.agent-profile-avatar-upload\s*\{[^}]*cursor:\s*pointer;[^}]*position:\s*relative;/s);
  assert.match(page, /\.agent-avatar-hover\s*\{[^}]*opacity:\s*0;[^}]*position:\s*absolute;/s);
  assert.match(page, /\.agent-profile-avatar-upload:hover \.agent-avatar-hover[^\{]*\{[^}]*opacity:\s*1;/s);
  assert.match(page, /\.agent-profile-header-actions\s*\{[^}]*align-self:\s*flex-start;[^}]*margin-top:\s*8px;/s);
  assert.match(page, /@container \(max-width:\s*750px\)\s*\{[\s\S]*?\.agent-profile-identity\s*\{[^}]*width:\s*100%;/s);
  assert.match(page, /@container \(max-width:\s*750px\)\s*\{[\s\S]*?\.agent-profile-header-actions\s*\{[^}]*margin-top:\s*0;[^}]*width:\s*100%;/s);
  assert.match(page, /\.agent-profile-intro\s*\{[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis;/s);
  assert.match(page, /\.agent-tabs-card\s*\{[^}]*border-radius:\s*16px;[^}]*overflow:\s*visible;/s);
  assert.match(page, /\.agent-tabs-card \.ptab-panel\s*\{[^}]*border-radius:\s*0 0 15px 15px;/s);
  assert.match(page, /\.agent-model-row\.agent-model-tab-row\s*\{[^}]*background:\s*transparent;[^}]*display:\s*block;[^}]*padding:\s*0;/s);
  assert.match(page, /\.agent-model-row > div, \.agent-advanced-copy, \.channel-agent-hero > div\s*\{[^}]*flex:\s*1;[^}]*flex-direction:\s*column;/s);
  assert.match(page, /\.agent-advanced-select select\.input\s*\{[^}]*padding-right:\s*48px;/s);
  assert.match(page, /\.agent-advanced-select \.select-caret\s*\{[^}]*margin-right:\s*16px;/s);
  assert.match(page, /\.agent-advanced-row\s*\{[^}]*border-radius:\s*16px;[^}]*min-height:\s*100px;/s);
  assert.match(page, /\.agent-advanced-copy\s*\{[^}]*flex:\s*0 1 400px;[^}]*max-width:\s*400px;/s);
  assert.match(page, /\.agent-advanced-actions\s*\{[^}]*align-items:\s*center;[^}]*display:\s*flex;[^}]*gap:\s*18px;/s);
  assert.match(page, /\.agent-advanced-status\s*\{[^}]*min-height:\s*32px;[^}]*padding:\s*6px 14px;/s);
  assert.match(page, /@container \(max-width:\s*750px\)[\s\S]*?\.agent-advanced-policy-row, \.agent-advanced-sandbox-row\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(page, /@container \(max-width:\s*750px\)[\s\S]*?\.agent-advanced-copy\s*\{[^}]*max-width:\s*none;[^}]*width:\s*100%;/s);
  assert.match(page, /\.agent-destinations-section\s*\{[^}]*border-radius:\s*16px;[^}]*display:\s*flex;/s);
  assert.match(page, /\.agent-destination-subsection\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*18px;/s);
  assert.doesNotMatch(page, /\.agent-placement-label\.agent-slack-channel-count\s*\{/);
  assert.match(
    page,
    /--semantic-instructions-fg:\s*#b96c06;[\s\S]*?--semantic-instructions-bg:\s*#fbefe0;[\s\S]*?--semantic-channel-fg:\s*#4b863d;[\s\S]*?--semantic-channel-bg:\s*#ebf0e2;[\s\S]*?--semantic-model-fg:\s*#7554ca;[\s\S]*?--semantic-model-bg:\s*#eee5f6;/s,
  );
  assert.match(page, /\.semantic-icon\.tone-instructions\s*\{[^}]*background:\s*var\(--semantic-instructions-bg\);[^}]*color:\s*var\(--semantic-instructions-fg\);/s);
  assert.match(page, /\.semantic-icon\.tone-connector\s*\{[^}]*background:\s*var\(--semantic-connector-bg\);[^}]*color:\s*var\(--semantic-connector-fg\);/s);
  assert.match(page, /\.semantic-icon\.tone-model\s*\{[^}]*background:\s*var\(--semantic-model-bg\);[^}]*color:\s*var\(--semantic-model-fg\);/s);
  assert.match(page, /\.semantic-icon\.tone-slack\s*\{[^}]*background:\s*var\(--semantic-slack-bg\);[^}]*border-color:\s*var\(--semantic-slack-line\);/s);
  assert.match(page, /\.channel-hash\s*\{[^}]*background:\s*var\(--semantic-channel-bg\);[^}]*color:\s*var\(--semantic-channel-fg\);/s);
  assert.match(page, /@container \(max-width: 750px\)[\s\S]*?\.agent-profile-header[^{]*\{[^}]*align-items:\s*flex-start;[^}]*flex-direction:\s*column;/s);
  assert.match(page, /@media \(max-width: 740px\)[\s\S]*?\.agent-profile-page \.ptabs\s*\{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);[^}]*overflow:\s*visible;/s);
  assert.match(page, /@media \(max-width: 480px\)[\s\S]*?\.agent-profile-page \.ptabs\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
});

test('Where it works uses full-width Channel rows and guided first-Channel activation', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /data-action="open-channel-from-profile"[^>]*>[\s\S]*?class="where-channel-name">eng-releases/);
  assert.match(harness.app.innerHTML, /data-action="attach-open">Add to channels/);

  assert.match(harness.app.innerHTML, /class="where-list"[\s\S]*?class="where-entry"[\s\S]*?eng-releases/);
  assert.doesNotMatch(harness.app.innerHTML, /agent-slack-channel-count|agent-placement-count/);
  assert.doesNotMatch(harness.app.innerHTML, /<h3[^>]*>Direct messages<\/h3>|Workspace default for @Chickpea DMs and App Home/);

  const noChannelsHarness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    assignments: [],
    agents: [{
      ...releaseAgent,
      isWorkspaceDefault: false,
      whereItWorks: { channels: [], directMessages: false },
    }, opsAgent],
  });
  await flushAsync();

  assert.match(noChannelsHarness.app.innerHTML, /Make Release Profile mentionable/);
  assert.match(noChannelsHarness.app.innerHTML, /Choose its first Slack Channel\./);
  assert.match(noChannelsHarness.app.innerHTML, /data-action="attach-open">Choose first channel/);
  assert.doesNotMatch(noChannelsHarness.app.innerHTML, />Add to channels<\/button>/);
  assert.doesNotMatch(noChannelsHarness.app.innerHTML, /<h3[^>]*>Direct messages<\/h3>|Private messages use the workspace Default Agent\./);
  assert.doesNotMatch(noChannelsHarness.app.innerHTML, /Slack identity|@Launch|@Finance/);
});

test('Agent placements prefer the projected Slack Channel name over a raw Channel ID', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    agents: [{
      ...releaseAgent,
      whereItWorks: {
        channels: [{
          workspaceId: 'T_DESIGN', channelId: 'C0EXR3L9T', channelName: 'eng-releases', status: 'active',
        }],
      },
    }, opsAgent],
    assignments: [{
      workspaceId: 'T_DESIGN',
      channelId: 'C0EXR3L9T',
      agentId: 'agent_release',
      enabled: true,
    }],
    channelIndex: [{
      workspaceId: 'T_DESIGN',
      channelId: 'C0EXR3L9T',
      channelName: 'eng-releases',
      assignment: { agentId: 'agent_release', agentName: 'Release Profile', agentEnabled: true },
      readiness: { ready: true, code: 'ready', reasons: [] },
    }],
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /data-action="open-channel-from-profile"[^>]*>[\s\S]*?class="where-channel-name">eng-releases/);
  assert.doesNotMatch(harness.app.innerHTML, /class="where-channel-name">C0EXR3L9T/);
});

test('Channel detail prefers the projected Slack Channel name over a raw Channel ID', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T',
    assignments: [{
      workspaceId: 'T_DESIGN',
      channelId: 'C0EXR3L9T',
      agentId: 'agent_release',
      enabled: true,
    }],
    channelIndex: [{
      workspaceId: 'T_DESIGN',
      channelId: 'C0EXR3L9T',
      channelName: 'eng-releases',
      assignment: { agentId: 'agent_release', agentName: 'Release Profile', agentEnabled: true },
      readiness: { ready: true, code: 'ready', reasons: [] },
    }],
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<h1 class="page-title mono-title">#eng-releases<\/h1>/);
  assert.match(harness.app.innerHTML, />Open #eng-releases<\/a>/);
  assert.doesNotMatch(harness.app.innerHTML, /#C0EXR3L9T/);
});

test('Channel detail is a read-only inventory of additive Agent grants', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /class="channel-detail-page"/);
  assert.match(html, /<header class="channel-detail-header">[\s\S]*?<h1 class="page-title mono-title">#eng-releases<\/h1>[\s\S]*?class="channel-detail-status ready"[^>]*>Ready/);
  assert.match(html, /<h2 class="section-title">Agents available here<\/h2>/);
  assert.match(html, /class="channel-agent-hero"[\s\S]*?agent-roster-icon[\s\S]*?<h2>Release Profile<\/h2>[\s\S]*?>View Agent<\/button>/);
  assert.doesNotMatch(html, /channel-enabled-control|Change Agent|Inherited capabilities/);
  assert.match(html, /class="channel-try-card"[\s\S]*?Try it in Slack[\s\S]*?data-action="copy-channel-prompt"[\s\S]*?Open #eng-releases/);
  assert.doesNotMatch(html, /channel-participation-card|channel-advanced-card|Channel memory|Additional instructions/);
  assert.doesNotMatch(html, /Resolved configuration|Channel ID|Workspace ID/);
  assert.doesNotMatch(html, /Access summary/);

  const order = [
    'channel-detail-header',
    'channel-agent-section',
    'channel-try-card',
  ].map((marker) => html.indexOf(marker));
  assert.ok(order.every((position) => position >= 0), `missing hierarchy marker: ${order.join(', ')}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);

  const page = renderAdminPage();
  assert.match(page, /@container \(max-width: 750px\)[\s\S]*?\.channel-detail-header\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(page, /@container \(max-width: 750px\)[\s\S]*?\.channel-try-card\s*\{[^}]*grid-template-columns:\s*1fr;/s);
});

test('Channel header keeps grant readiness and empty states truthful', async () => {
  const attention = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C_ATTENTION',
    assignments: [{
      workspaceId: 'T_DESIGN', channelId: 'C_ATTENTION', channelLabel: 'attention',
      agentId: 'agent_release', enabled: true,
    }],
    channelIndex: [{
      workspaceId: 'T_DESIGN', channelId: 'C_ATTENTION', channelName: 'attention',
      assignment: { agentId: 'agent_release', agentName: 'Release Profile', agentEnabled: true },
      readiness: { ready: false, code: 'grant_needs_attention', reasons: ['Agent handle needs attention'] },
    }],
  });
  await flushAsync();
  assert.match(attention.app.innerHTML, /class="channel-detail-status needs-attention" title="Agent handle needs attention"[^>]*>Needs attention/);

  const disabled = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C_DISABLED',
    agents: [{ ...releaseAgent, enabled: false }, opsAgent],
    assignments: [{
      workspaceId: 'T_DESIGN', channelId: 'C_DISABLED', channelLabel: 'disabled',
      agentId: 'agent_release', enabled: true,
    }],
    channelIndex: [{
      workspaceId: 'T_DESIGN', channelId: 'C_DISABLED', channelName: 'disabled',
      assignment: { agentId: 'agent_release', agentName: 'Release Profile', agentEnabled: false },
      readiness: { ready: false, code: 'agent_disabled', reasons: ['Enable the assigned Agent'] },
    }],
  });
  await flushAsync();
  assert.match(disabled.app.innerHTML, /class="channel-detail-status needs-attention" title="Enable the assigned Agent"[^>]*>Needs attention/);

  const unassigned = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C_UNASSIGNED',
    channelIndex: [{
      workspaceId: 'T_DESIGN', channelId: 'C_UNASSIGNED', channelName: 'planning',
      assignment: null,
      readiness: { ready: false, code: 'unassigned', reasons: ['Choose an Agent'] },
    }],
  });
  await flushAsync();
  assert.match(unassigned.app.innerHTML, /class="channel-detail-status unassigned"[^>]*>No Agents/);
  assert.match(unassigned.app.innerHTML, /No Agents published here/);
  assert.match(unassigned.app.innerHTML, /Open an Agent and add this Channel from its Channels tab/);
  assert.doesNotMatch(unassigned.app.innerHTML, /Choose Agent|Change Agent/);

  const loading = runAdminPageHarness();
  await flushAsync();
  loading.listeners.click?.({ target: actionTarget({
    'data-action': 'select-channel', 'data-workspace': 'T_DESIGN', 'data-channel': 'C_OPS',
  }) });
  assert.doesNotMatch(loading.app.innerHTML, /channel-detail-status resolving/);
  assert.doesNotMatch(loading.app.innerHTML, /channel-detail-status resolving/);

  const failed = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T',
    effectiveError: { status: 422, error: 'model_not_resolvable', message: 'Choose a model on Release Profile.' },
  });
  await flushAsync();
  assert.doesNotMatch(failed.app.innerHTML, /Choose a model on Release Profile|Resolved configuration|Configuration issue/);
});

test('Channel detail links to the owning Agent instead of duplicating capabilities', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T',
    agents: [{
      ...releaseAgent,
      capabilityPreviews: {
        skills: ['one', 'two', 'three', 'four', 'five'].map((name) => ({ name, enabled: true })),
        connectors: [{ id: 'linear', name: 'Linear', presetId: 'linear', enabled: true }],
        repositories: [],
      },
    }, opsAgent],
  });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /<h2>Release Profile<\/h2>/);
  assert.match(html, /data-action="open-profiles" data-agent="agent_release">View Agent<\/button>/);
  assert.doesNotMatch(html, /channel-capability-group|Inherited capabilities|Skills, Connectors, and Repositories/);
});

test('Channel detail has no behavior, instructions, or memory draft', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();
  assert.match(harness.app.innerHTML, /inventory of reach/);
  assert.doesNotMatch(harness.app.innerHTML, /<h2 class="section-title">Additional instructions<\/h2>|<h2 class="section-title">Channel memory<\/h2>/);
});

test('Channel Slack proof copies the exact prompt and reports clipboard failure visibly', async () => {
  const available = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T', clipboard: 'available',
  });
  await flushAsync();
  available.listeners.click?.({ target: actionTarget({ 'data-action': 'copy-channel-prompt' }) });
  await flushAsync();
  assert.deepEqual(available.clipboardWrites, ['@Chickpea Give me three useful ways you can help this channel, each with an example prompt I could try next.']);
  assert.match(available.app.innerHTML, /class="channel-try-status" role="status">Prompt copied\.<\/span>/);
  assert.match(available.app.innerHTML, /href="https:\/\/app\.slack\.com\/client\/T_DESIGN\/C0EXR3L9T" target="_blank" rel="noopener noreferrer"/);

  const stale = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T', clipboard: 'defer',
  });
  await flushAsync();
  stale.listeners.click?.({ target: actionTarget({ 'data-action': 'copy-channel-prompt' }) });
  stale.listeners.click?.({ target: actionTarget({
    'data-action': 'select-channel', 'data-workspace': 'T_DESIGN', 'data-channel': 'C_OPS',
  }) });
  await flushAsync();
  stale.resolveClipboardWrite();
  await flushAsync();
  assert.equal(stale.locationPath(), '/admin/channels/T_DESIGN/C_OPS');
  assert.doesNotMatch(stale.app.innerHTML, /Prompt copied\./);

  for (const clipboard of ['missing', 'reject', 'throw'] as const) {
    const failed = runAdminPageHarness({
      initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T', clipboard,
    });
    await flushAsync();
    failed.listeners.click?.({ target: actionTarget({ 'data-action': 'copy-channel-prompt' }) });
    await flushAsync();
    assert.match(failed.app.innerHTML, /Copy failed\. Select the prompt and copy it manually\./, clipboard);
  }
});

test('Channels stay secondary and link each reach grant back to its Agent', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin' });
  await flushAsync();

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'open-channels' }) });
  await flushAsync();
  assert.equal(harness.locationPath(), '/admin/destinations/slack/channels');
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Slack<\/h1>/);
  assert.match(harness.app.innerHTML, /class="destination-tab active"[^>]*data-tab="channels">Channels<\/button>/);
  assert.match(harness.app.innerHTML, /Open Agent: Release Profile/);
  assert.match(harness.app.innerHTML, /placeholder="Find a Channel or Agent"/);
  assert.match(harness.app.innerHTML, /Multiple Agents can work in the same Channel/);
  assert.doesNotMatch(harness.app.innerHTML, /Assigned Agent|Additional instructions|Channel memory|Behavior/);
  harness.listeners.click?.({ target: actionTarget({
    'data-action': 'open-profiles', 'data-agent': 'agent_release',
  }) });
  assert.equal(harness.locationPath(), '/admin/agents/agent_release');
});

test('Channels index presents a many-Agent grant inventory without Channel behavior', async () => {
  const disabledOps = { ...opsAgent, enabled: false };
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels',
    agents: [releaseAgent, disabledOps],
    channelIndex: [
      {
        workspaceId: 'T_DESIGN', channelId: 'C_READY', channelName: 'eng-releases',
        grants: [
          { agentId: 'agent_release', agentName: 'Release Profile', agentEnabled: true, status: 'active' },
          { agentId: 'agent_ops', agentName: 'Ops Profile', agentEnabled: false, status: 'needs_attention' },
        ],
        readiness: { ready: true, code: 'ready', reasons: [] },
      },
      {
        workspaceId: 'T_DESIGN', channelId: 'C_DISABLED', channelName: 'incident-response',
        grants: [{ agentId: 'agent_ops', agentName: 'Ops Profile', agentEnabled: false, status: 'needs_attention' }],
        readiness: { ready: false, code: 'agent_disabled', reasons: ['Enable the assigned Agent'] },
      },
      {
        workspaceId: 'T_DESIGN', channelId: 'C_UNASSIGNED', channelName: 'planning',
        grants: [],
        readiness: { ready: false, code: 'no_agents', reasons: ['No Agents are active'] },
      },
    ],
    slackChannels: channelsFixture([
      { id: 'C_READY', name: 'eng-releases' },
      { id: 'C_DISABLED', name: 'incident-response' },
      { id: 'C_UNASSIGNED', name: 'planning' },
      { id: 'C_DISCOVERED', name: 'customer-voice' },
    ]),
  });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /<h1 class="page-title">Slack<\/h1>/);
  assert.match(html, /<h2>Slack channels<\/h2>/);
  assert.doesNotMatch(html, /Add Channel/);
  assert.match(html, /<dt>Configured Channels<\/dt><dd>2<\/dd>/);
  assert.match(html, /<dt>Active Agent grants<\/dt><dd>1<\/dd>/);
  assert.match(html, /class="channels-slack-state connected"[^>]*>[\s\S]*?Slack connected/);
  assert.match(html, /role="table" aria-label="Channel grants"/);
  for (const heading of ['Channel', 'Agents', 'Status']) {
    assert.match(html, new RegExp(`role="columnheader"[^>]*>${heading}<`));
  }
  assert.match(html, /data-channel-state="ready"[\s\S]*?#eng-releases[\s\S]*?Release Profile[\s\S]*?Ops Profile[\s\S]*?Ready/);
  assert.match(html, /data-channel-state="needs-attention"[\s\S]*?#incident-response[\s\S]*?Ops Profile[\s\S]*?Needs attention/);
  assert.match(html, /data-channel-state="discovered"[\s\S]*?#planning[\s\S]*?No Agents/);
  assert.match(html, /data-channel-state="discovered"[\s\S]*?#customer-voice[\s\S]*?No Agents/);
  assert.doesNotMatch(html, /Behavior|Mentions only|useful moments|Channel instructions/);
  assert.doesNotMatch(html, /class="channels-index-open"|>Open Agent<|&rsaquo;/);
});

test('Channels summary reports healthy, degraded, and disconnected Slack truth', async () => {
  const healthy = runAdminPageHarness({ initialPath: '/admin/channels' });
  await flushAsync();
  assert.match(healthy.app.innerHTML, /channels-slack-state connected[\s\S]*?Slack connected/);

  const degraded = runAdminPageHarness({
    initialPath: '/admin/channels',
    slackConnection: {
      ...connectedSlackFixture(),
      health: 'needs_attention',
      healthDetail: 'gateway_session_offline',
      transportMode: 'gateway',
    },
  });
  await flushAsync();
  assert.match(degraded.app.innerHTML, /channels-slack-state degraded[\s\S]*?Slack needs attention/);

  const disconnected = runAdminPageHarness({
    initialPath: '/admin/channels',
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();
  assert.match(disconnected.app.innerHTML, /channels-slack-state disconnected[\s\S]*?Slack disconnected/);
  assert.match(disconnected.app.innerHTML, /Slack setup incomplete/);
});

test('Channels search preserves its query and filters Channel and Agent names', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels',
    channelIndex: [
      {
        workspaceId: 'T_DESIGN', channelId: 'C_RELEASE', channelName: 'eng-releases',
        grants: [{ agentId: 'agent_release', agentName: 'Release Profile', agentEnabled: true, status: 'active' }], readiness: { ready: true },
      },
      {
        workspaceId: 'T_DESIGN', channelId: 'C_OPS', channelName: 'incident-room',
        grants: [{ agentId: 'agent_ops', agentName: 'Ops Profile', agentEnabled: true, status: 'active' }], readiness: { ready: true },
      },
    ],
  });
  await flushAsync();

  harness.listeners.input?.({ target: inputTarget({ 'data-action': 'channels-index-query' }, 'Ops Profile') });
  assert.match(harness.app.innerHTML, /id="channels-index-query"[^>]*value="Ops Profile"/);
  assert.match(harness.app.innerHTML, /#incident-room/);
  assert.doesNotMatch(harness.app.innerHTML, /#eng-releases/);

  harness.listeners.input?.({ target: inputTarget({ 'data-action': 'channels-index-query' }, 'missing') });
  assert.match(harness.app.innerHTML, /No Channels or Agents match/);
  assert.match(harness.app.innerHTML, /Try a different Channel or Agent name\./);
});

test('Channels table keeps Agent grants and ungranted discovered destinations separate', async () => {
  const fixtures = {
    initialPath: '/admin/channels',
    channelIndex: [{
      workspaceId: 'T_DESIGN', channelId: 'C_READY', channelName: 'eng-releases',
      grants: [{ agentId: 'agent_release', agentName: 'Release Profile', agentEnabled: true, status: 'active' }], readiness: { ready: true },
    }, {
      workspaceId: 'T_DESIGN', channelId: 'C_DISCOVERED', channelName: 'customer-voice',
      grants: [], readiness: null,
      source: 'discovered',
    }],
    slackChannels: channelsFixture([
      { id: 'C_READY', name: 'eng-releases' },
      { id: 'C_DISCOVERED', name: 'customer-voice' },
    ]),
  };

  const agentHarness = runAdminPageHarness(fixtures);
  await flushAsync();
  agentHarness.listeners.click?.({ target: actionTarget({
    'data-action': 'open-profiles', 'data-agent': 'agent_release',
  }) });
  assert.equal(agentHarness.locationPath(), '/admin/agents/agent_release');

  const discoveredHarness = runAdminPageHarness(fixtures);
  await flushAsync();
  assert.match(discoveredHarness.app.innerHTML, /#customer-voice[\s\S]*?No Agents/);
  assert.doesNotMatch(discoveredHarness.app.innerHTML, /channel-index-add|Add a channel/);
});

test('Channels projection fallback keeps saved Agent grants, counts, and recovery copy', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels',
    channelIndexError: { status: 503, error: 'projection_unavailable', message: 'Try again later' },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /The Channel index could not refresh\. Showing saved Agent grants/);
  assert.match(harness.app.innerHTML, /<dt>Configured Channels<\/dt><dd>2<\/dd>/);
  assert.match(harness.app.innerHTML, /data-channel-state="saved"[\s\S]*?#eng-releases[\s\S]*?Granted/);
  assert.match(harness.app.innerHTML, /data-action="open-profiles" data-agent="agent_release"/);
});

test('Channels columns truncate long visible values while retaining complete accessible text', () => {
  const page = renderAdminPage();
  assert.match(page, /\.channels-index-name, \.channels-index-agent-name, \.channels-index-behavior strong\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  assert.match(page, /\.channels-index-table-head, \.channels-index-row\s*\{[^}]*grid-template-columns:\s*minmax\(200px, 1fr\) minmax\(280px, 1\.6fr\) 130px;/s);
  assert.match(page, /@container \(max-width: 750px\)[\s\S]*?\.channels-index-table-head\s*\{[^}]*display:\s*none;[\s\S]*?\.channels-index-row\s*\{[^}]*grid-template-columns:\s*1fr;/s);
  assert.match(page, /\.channels-index-cell::before\s*\{[^}]*content:\s*attr\(data-label\);/s);
});

test('Channel detail navigation never mutates or replaces Agent grants', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T',
  });
  await flushAsync();

  assert.doesNotMatch(harness.app.innerHTML, /toggle-swap|attach-selected-profile|Change Agent/);
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'open-profiles', 'data-agent': 'agent_release' }) });
  assert.equal(harness.locationPath(), '/admin/agents/agent_release');
  assert.equal(harness.putAssignments.length, 0);
});

test('configured unassigned Channels keep their detail and point back to Agents', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C_UNASSIGNED',
    channelIndex: [{
      workspaceId: 'T_DESIGN',
      channelId: 'C_UNASSIGNED',
      channelName: 'planning',
      source: 'configured',
      assignment: null,
      readiness: { ready: false, code: 'unassigned', reasons: ['Choose an Agent'] },
      links: { channel: '/admin/channels/T_DESIGN/C_UNASSIGNED', agent: null },
    }],
  });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/channels/T_DESIGN/C_UNASSIGNED');
  assert.match(harness.app.innerHTML, /#planning/);
  assert.match(harness.app.innerHTML, /No Agents published here/);
  assert.match(harness.app.innerHTML, /Open an Agent and add this Channel from its Channels tab/);
  assert.doesNotMatch(harness.app.innerHTML, /Choose Agent|Change Agent/);
  assert.doesNotMatch(harness.app.innerHTML, /No channels yet/);
  assert.doesNotMatch(harness.app.innerHTML, /class="agent-roster-item active"/);
  assert.match(harness.app.innerHTML, /data-action="channel-back"[^>]*>&larr; Channels<\/button>/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'channel-back' }) });
  assert.equal(harness.locationPath(), '/admin/destinations/slack/channels');
});

test('disconnected Channel route shows the Slack recovery stepper', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T',
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<nav class="rail primary-shell-sidebar destination-shell-sidebar" aria-label="Destinations">/);
  assert.match(harness.app.innerHTML, /class="destination-rail-name">Slack<\/span>/);
  assert.match(harness.app.innerHTML, /Slack setup incomplete/);
  assert.doesNotMatch(harness.app.innerHTML, /Agents available here|channel-agent-hero/);
});

test('Agent roster keeps long names accessible and centered while truncating visually', async () => {
  const escapedName = 'Customer Research &amp; Escalations Agent With A Deliberately Long Name';
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_long',
    agents: [{
      ...releaseAgent,
      id: 'agent_long',
      name: 'Customer Research & Escalations Agent With A Deliberately Long Name',
    }],
    assignments: [{
      workspaceId: 'T_DESIGN',
      channelId: 'C_LONG',
      channelLabel: 'customer-escalations',
      agentId: 'agent_long',
      enabled: true,
    }],
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, new RegExp(`aria-label="Open Agent ${escapedName}"`));
  assert.match(harness.app.innerHTML, new RegExp(`class="agent-roster-name" title="${escapedName}"`));
  assert.doesNotMatch(harness.app.innerHTML, /class="agent-roster-meta"/);
  const page = renderAdminPage();
  assert.match(page, /\.agent-roster-copy\s*\{[^}]*align-items:\s*center;/s);
  assert.match(page, /\.agent-roster-name\s*\{[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  assert.match(page, /\.mobile-agent-roster\s*\{[^}]*width:\s*min\(340px,\s*calc\(100vw - 40px\)\);/s);
});

test('Agent owner memory exposes one directly editable current body without file or history concepts', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin' });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'memory' }) });
  await flushAsync();
  assert.deepEqual(harness.ownerMemoryGetCaches, ['no-store']);
  assert.match(harness.app.innerHTML, /One shared memory follows Release Profile everywhere it works/);
  assert.match(harness.app.innerHTML, /<label class="field-label" for="owner-memory-body">Memory<\/label>/);
  assert.match(harness.app.innerHTML, /Run &lt;script&gt;alert\(1\)&lt;\/script&gt; before release\./);
  assert.doesNotMatch(harness.app.innerHTML, /Filename|Version history|Review requested|Add file|Forget file|MEMORY\.md/);

  harness.listeners.input?.({ target: valueTarget({ 'data-action': 'owner-memory-body' }, 'Use the updated checklist.') });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'owner-memory-save' }) });
  await flushAsync();
  assert.deepEqual(harness.memoryPuts.at(-1), {
    expectedRevision: 1,
    body: 'Use the updated checklist.',
  });
  assert.match(harness.app.innerHTML, /Memory saved\./);
});

test('shared Agent memory stays a simple responsive editor', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/agents/agent_release' });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'memory' }) });
  await flushAsync();

  const page = renderAdminPage();
  assert.match(harness.app.innerHTML, /class="owner-memory-editor"/);
  assert.match(page, /\.owner-memory-editor\s*\{[^}]*min-width:\s*0;[^}]*padding:\s*22px 24px 24px;/s);
  assert.match(page, /\.owner-memory-editor textarea\s*\{[^}]*min-height:\s*300px;/s);
  assert.match(page, /@container \(max-width: 750px\)[\s\S]*?\.owner-memory-editor\s*\{[^}]*padding:\s*20px;/s);
});

test('a clean Memory tab adopts the newest server body when reopened', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/agents/agent_release' });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'memory' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Run &lt;script&gt;alert\(1\)&lt;\/script&gt; before release\./);

  harness.setMemoryEntry('Use the server-side launch checklist.', 2);
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'instructions' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'memory' }) });
  await flushAsync();

  assert.deepEqual(harness.ownerMemoryGetCaches, ['no-store', 'no-store']);
  assert.match(harness.app.innerHTML, /Use the server-side launch checklist\./);
});

test('a dirty Memory draft survives tab changes, focus, and visibility restoration', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/agents/agent_release' });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'memory' }) });
  await flushAsync();
  harness.listeners.input?.({
    target: valueTarget({ 'data-action': 'owner-memory-body' }, 'Keep this unsaved local memory draft.'),
  });
  harness.setMemoryEntry('Newer server memory must not replace the draft.', 2);

  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'instructions' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'memory' }) });
  harness.focusWindow();
  harness.setVisibility('hidden');
  harness.setVisibility('visible');
  await flushAsync();

  assert.deepEqual(harness.ownerMemoryGetCaches, ['no-store']);
  assert.match(harness.app.innerHTML, /Keep this unsaved local memory draft\./);
  assert.doesNotMatch(harness.app.innerHTML, /Newer server memory must not replace the draft/);
  assert.match(harness.app.innerHTML, /Unsaved memory changes/);
});

test('typing during a Memory revalidation retires the in-flight server response', async () => {
  let resolveRevalidation: ((response: FakeResponse) => void) | undefined;
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    memoryGetFetch(agentId, call) {
      if (call === 1) {
        return Promise.resolve(jsonResponse({ memory: { agentId, body: 'Initial memory.', revision: 1 } }));
      }
      return new Promise((resolve) => { resolveRevalidation = resolve; });
    },
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'memory' }) });
  await flushAsync();
  harness.focusWindow();
  await flushAsync();
  assert.ok(resolveRevalidation);

  harness.listeners.input?.({
    target: valueTarget({ 'data-action': 'owner-memory-body' }, 'Draft typed while refresh was pending.'),
  });
  resolveRevalidation(jsonResponse({
    memory: { agentId: 'agent_release', body: 'Late server memory.', revision: 2 },
  }));
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'instructions' }) });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'memory' }) });

  assert.match(harness.app.innerHTML, /Draft typed while refresh was pending\./);
  assert.doesNotMatch(harness.app.innerHTML, /Late server memory/);
  assert.match(harness.app.innerHTML, /data-action="owner-memory-save"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="owner-memory-save" disabled/);
});

test('a dirty profile draft blocks focus refresh and keeps focus, caret, and scroll', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    resetDocumentScrollOnRender: true,
  });
  await flushAsync();
  harness.listeners.input?.({
    target: inputTarget({ 'data-action': 'profile-instructions' }, 'Unsaved profile instructions.'),
  });
  harness.focusModelInput(5);
  harness.setMainScrollTop(486);
  harness.setDocumentScrollTop(486);
  const detailGetsBeforeFocus = harness.agentDetailGets();

  harness.focusWindow();
  harness.setVisibility('visible');
  await flushAsync();

  assert.equal(harness.agentDetailGets(), detailGetsBeforeFocus);
  assert.match(harness.app.innerHTML, /Unsaved profile instructions\./);
  assert.equal(harness.focusedAction(), 'p-model');
  assert.deepEqual(harness.modelSelectionRanges.at(-1), [5, 5]);
  assert.equal(harness.mainScrollTop(), 486);
  assert.equal(harness.documentScrollTop(), 486);
  assert.match(harness.app.innerHTML, /data-action="save-profile">Save changes<\/button>/);
});

test('saving Agent memory writes the one canonical body', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin' });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'memory' }) });
  await flushAsync();
  harness.listeners.input?.({ target: valueTarget({ 'data-action': 'owner-memory-body' }, '# Launch context\nShip safely.') });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'owner-memory-save' }) });
  await flushAsync();

  assert.deepEqual(harness.memoryPuts[0], {
    expectedRevision: 1,
    body: '# Launch context\nShip safely.',
  });
  assert.match(harness.app.innerHTML, /# Launch context\nShip safely\./);
  assert.doesNotMatch(harness.app.innerHTML, /agent-memory\.md|memory files/i);

  harness.focusWindow();
  await flushAsync();
  assert.deepEqual(harness.ownerMemoryGetCaches, ['no-store', 'no-store']);
  assert.equal(harness.agentConnectionGets(), 0);
  assert.equal(harness.agentScheduleGets(), 0);
});

test('Agent saves use the projected revision and preserve a draft on concurrent edit conflict', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin',
    agentWriteError: { status: 409, error: 'agent_revision_conflict' },
  });
  await flushAsync();
  harness.listeners.input?.({ target: valueTarget({ 'data-action': 'profile-instructions' }, 'Locally edited instructions.') });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies[0]?.body.expectedRevision, 1);
  assert.match(harness.app.innerHTML, /This Agent changed in another session\. Your draft is preserved/);
  assert.match(harness.app.innerHTML, /data-action="reload-profile">Reload latest Agent/);
  assert.match(harness.app.innerHTML, /Locally edited instructions/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'reload-profile' }) });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /Locally edited instructions|Reload latest Agent/);
  assert.match(harness.app.innerHTML, /Answer with release context/);
});

test('Agent archiving remains available while projected live Slack thread roots exist', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_threaded',
    agents: [{
      ...releaseAgent,
      id: 'agent_threaded',
      name: 'Threaded Agent',
      deletion: { blocked: true, references: [], liveSnapshotRoots: [{ workspaceId: 'T_DESIGN', channelId: 'C1', threadTs: '1.0' }] },
    }],
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'agent-overflow-toggle' }) });
  assert.match(harness.app.innerHTML, /data-action="archive-profile">Archive Agent<\/button>/);
  assert.match(harness.app.innerHTML, /removes Channel access, and pauses schedules/);
  assert.doesNotMatch(harness.app.innerHTML, /delete-profile|Delete Agent/);
});

test('Channel detail never exposes a second memory owner', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /Channel Memory|owner-memory|Exact-Channel/);
  assert.equal(harness.memoryPuts.length, 0);
});

// A checkbox change target that also exposes `checked` (the skill enable toggle
// and profile-enable toggle both read target.checked).
function checkboxTarget(attributes: Record<string, string>, checked: boolean): FakeTarget & { checked: boolean } {
  return {
    checked,
    closest() {
      return null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

test('the Skills tab browses the compact suggested catalog by category', async () => {
  const harness = runAdminPageHarness({
    agents: [{
      id: 'agent_suggestions',
      name: 'Suggestions Profile',
      description: 'Suggested skill profile',
      instructions: 'Help the team.',
      enabled: true,
      model: 'local-stub/suggestions',
      skills: [],
    }],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_suggestions' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });

  const featured = harness.app.innerHTML;
  assert.match(featured, /Build your own/);
  assert.match(featured, /Suggested skills/);
  assert.match(featured, /data-action="suggested-skill-category" data-category="featured"[^>]*aria-selected="true"[^>]*>Featured<span[^>]*>8<\/span>/);
  assert.match(featured, /data-action="suggested-skill-category" data-category="marketing"[^>]*>Marketing<span[^>]*>7<\/span>/);
  assert.match(featured, /Paid ads/);
  assert.match(featured, /Unslop/);
  assert.doesNotMatch(featured, /Page CRO/);
  assert.doesNotMatch(featured, /No custom skills yet/);

  click({ target: actionTarget({ 'data-action': 'suggested-skill-category', 'data-category': 'research' }) });
  const research = harness.app.innerHTML;
  assert.match(research, /data-category="research"[^>]*aria-selected="true"/);
  assert.match(research, /Customer research/);
  assert.match(research, /Grill me/);
  assert.match(research, /\/grill-me/);
  assert.match(research, /Questionnaire/);
  assert.doesNotMatch(research, /Paid ads/);
});

test('a suggested skill toggle copies a normal snapshot, persists it, and removes it when turned off', async () => {
  const harness = runAdminPageHarness({
    agents: [{
      id: 'agent_suggestions',
      name: 'Suggestions Profile',
      description: 'Suggested skill profile',
      instructions: 'Help the team.',
      enabled: true,
      model: 'local-stub/suggestions',
      skills: [],
    }],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_suggestions' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });
  change({
    target: checkboxTarget({ 'data-action': 'suggested-skill-toggle', 'data-skill-id': 'paid-ads' }, true),
  });

  assert.match(harness.app.innerHTML, /data-skill-id="paid-ads" checked/);
  assert.match(harness.app.innerHTML, /1 skill on/);
  assert.doesNotMatch(harness.app.innerHTML, /class="badge-src">custom[\s\S]*paid-ads/);

  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  const firstSkill = (harness.agentPatchBodies[0]?.body.skills as Array<Record<string, unknown>>)[0];
  assert.equal(firstSkill?.name, 'paid-ads');
  assert.equal(firstSkill?.enabled, true);
  assert.equal(firstSkill?.suggestedSkillId, 'paid-ads');
  assert.match(String(firstSkill?.instructions), /campaign/i);

  change({
    target: checkboxTarget({ 'data-action': 'suggested-skill-toggle', 'data-skill-id': 'paid-ads' }, false),
  });
  assert.doesNotMatch(harness.app.innerHTML, /data-skill-id="paid-ads" checked/);
  assert.doesNotMatch(harness.app.innerHTML, /Name in use/);
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  const removed = harness.agentPatchBodies[1]?.body.skills as Array<Record<string, unknown>>;
  assert.deepEqual(removed, []);

  // Removing the snapshot releases its runtime name, so the suggestion can be
  // copied again without leaving a duplicate or disabled record behind.
  change({
    target: checkboxTarget({ 'data-action': 'suggested-skill-toggle', 'data-skill-id': 'paid-ads' }, true),
  });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  const restored = harness.agentPatchBodies[2]?.body.skills as Array<Record<string, unknown>>;
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.name, 'paid-ads');
  assert.equal(restored[0]?.suggestedSkillId, 'paid-ads');
});

test('a custom skill keeps ownership of a suggested runtime name', async () => {
  const customSkill = {
    name: 'paid-ads',
    description: 'Our internal paid acquisition playbook.',
    instructions: 'Use the internal campaign review process and preserve its approval gates.',
    enabled: true,
  };
  const harness = runAdminPageHarness({
    agents: [{
      id: 'agent_custom_collision',
      name: 'Custom Collision Profile',
      description: 'Custom skill profile',
      instructions: 'Help the team.',
      enabled: true,
      model: 'local-stub/custom-collision',
      skills: [customSkill],
    }],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_custom_collision' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });

  assert.match(harness.app.innerHTML, /class="sk-name">paid-ads<span class="badge-src">custom/);
  assert.match(harness.app.innerHTML, /Our internal paid acquisition playbook/);
  assert.match(harness.app.innerHTML, /Name in use/);
  assert.match(harness.app.innerHTML, /data-skill-id="paid-ads"[^>]* disabled/);

  // Defensively reject the collision even if a synthetic change event reaches
  // the disabled control.
  change({
    target: checkboxTarget({ 'data-action': 'suggested-skill-toggle', 'data-skill-id': 'paid-ads' }, true),
  });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  const saved = harness.agentPatchBodies[0]?.body.skills as Array<Record<string, unknown>>;
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], customSkill);
  assert.match(harness.app.innerHTML, /class="sk-name">paid-ads<span class="badge-src">custom/);
  assert.match(harness.app.innerHTML, /Name in use/);
});

test('the profile editor manages custom skills end to end and carries them in the save body', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_release',
        name: 'Release Profile',
        description: 'Release readiness profile',
        instructions: 'Answer with release context.',
        enabled: true,
        model: 'local-stub/release',
        skills: [],
      },
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });

  // The Skills capability tab renders the creation card and suggestions first.
  assert.match(harness.app.innerHTML, /data-action="profile-tab" data-tab="skills"/);
  assert.match(harness.app.innerHTML, /Build your own/);
  assert.match(harness.app.innerHTML, /Suggested skills/);

  // Open a blank editor; the inline form appears with the three fields.
  click({ target: actionTarget({ 'data-action': 'skill-new' }) });
  assert.match(harness.app.innerHTML, /data-action="skill-field-name"/);
  assert.match(harness.app.innerHTML, /data-action="skill-field-instructions"/);

  // An invalid name is rejected inline with the client mirror of the server rule.
  input({ target: inputTarget({ 'data-action': 'skill-field-name' }, 'Bad Name!') });
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'x') });
  input({ target: inputTarget({ 'data-action': 'skill-field-instructions' }, 'y') });
  click({ target: actionTarget({ 'data-action': 'skill-save-row' }) });
  assert.match(harness.app.innerHTML, /lowercase letters/);

  // Fix it and save; the row lists with the custom badge and defaults enabled.
  input({ target: inputTarget({ 'data-action': 'skill-field-name' }, 'release-notes') });
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'Turns PRs into a changelog.') });
  input({ target: inputTarget({ 'data-action': 'skill-field-instructions' }, 'Write the notes in launch voice.') });
  click({ target: actionTarget({ 'data-action': 'skill-save-row' }) });
  assert.match(harness.app.innerHTML, /release-notes/);
  assert.match(harness.app.innerHTML, /class="badge-src">custom/);
  assert.match(harness.app.innerHTML, /data-action="skill-toggle" data-index="0" checked/);

  // A duplicate name is rejected.
  click({ target: actionTarget({ 'data-action': 'skill-new' }) });
  input({ target: inputTarget({ 'data-action': 'skill-field-name' }, 'release-notes') });
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'dupe') });
  input({ target: inputTarget({ 'data-action': 'skill-field-instructions' }, 'dupe') });
  click({ target: actionTarget({ 'data-action': 'skill-save-row' }) });
  assert.match(harness.app.innerHTML, /Another skill already uses that name/);
  click({ target: actionTarget({ 'data-action': 'skill-cancel' }) });

  // Toggle the skill off — the toggle re-renders unchecked.
  change({ target: checkboxTarget({ 'data-action': 'skill-toggle', 'data-index': '0' }, false) });
  assert.doesNotMatch(harness.app.innerHTML, /data-action="skill-toggle" data-index="0" checked/);

  // Edit the skill; the form is seeded and the edit preserves the disabled state.
  click({ target: actionTarget({ 'data-action': 'skill-edit', 'data-index': '0' }) });
  assert.match(harness.app.innerHTML, /value="release-notes"/);
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'Edited changelog copy.') });
  click({ target: actionTarget({ 'data-action': 'skill-save-row' }) });
  assert.match(harness.app.innerHTML, /Edited changelog copy\./);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="skill-toggle" data-index="0" checked/);

  // Save the profile — the PATCH body carries the skills array with the edits.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 1);
  const patched = harness.agentPatchBodies[0];
  assert.equal(patched?.id, 'agent_release');
  assert.deepEqual(patched?.body.skills, [
    { name: 'release-notes', description: 'Edited changelog copy.', instructions: 'Write the notes in launch voice.', enabled: false },
  ]);

  // After save the editor re-clones from the (echoed) agent, so the row persists
  // and the save bar re-disables.
  assert.match(harness.app.innerHTML, /release-notes/);

  // Remove the skill and save again; the array is now empty in the PATCH body.
  click({ target: actionTarget({ 'data-action': 'skill-remove', 'data-index': '0' }) });
  assert.doesNotMatch(harness.app.innerHTML, /release-notes/);
  assert.match(harness.app.innerHTML, /Build your own/);
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 2);
  assert.deepEqual(harness.agentPatchBodies[1]?.body.skills, []);
});

test('importing skills from a URL resolves a picker, adds the selected skill, and carries it in the save body', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_import',
        name: 'Import Profile',
        description: 'Import readiness profile',
        instructions: 'Answer with import context.',
        enabled: true,
        model: 'local-stub/import',
        skills: [],
      },
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_import' }) });

  // The Skills section offers an "Import from URL" affordance next to New skill.
  assert.match(harness.app.innerHTML, /data-action="import-skills"/);

  // Open the import panel — the source input appears; the picker is not shown yet.
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  assert.match(harness.app.innerHTML, /data-action="import-source"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="import-add"/);

  // Type a source and Find skills — the endpoint gets the raw string.
  input({ target: inputTarget({ 'data-action': 'import-source' }, 'acme/skills') });
  click({ target: actionTarget({ 'data-action': 'import-find' }) });
  await flushAsync();
  assert.equal(harness.skillResolvePosts.length, 1);
  assert.equal(harness.skillResolvePosts[0]?.source, 'acme/skills');

  // The picker renders both skills, the summary line, and the has-scripts badge.
  assert.match(harness.app.innerHTML, /Found 2 skills in acme\/skills/);
  assert.match(harness.app.innerHTML, /Public repository/);
  assert.match(harness.app.innerHTML, /release-notes/);
  assert.match(harness.app.innerHTML, /incident-scribe/);
  assert.match(harness.app.innerHTML, /won&rsquo;t run yet/);
  assert.match(harness.app.innerHTML, /data-action="import-add"/);

  // Both rows start selected; deselect the scripts one so only release-notes adds.
  change({ target: checkboxTarget({ 'data-action': 'import-row-toggle', 'data-index': '1' }, false) });
  assert.doesNotMatch(harness.app.innerHTML, /data-action="import-row-toggle" data-index="1" checked/);

  // Add selected — the panel closes and the imported skill shows as a normal row.
  click({ target: actionTarget({ 'data-action': 'import-add' }) });
  assert.doesNotMatch(harness.app.innerHTML, /data-action="import-source"/);
  assert.match(harness.app.innerHTML, /release-notes/);
  assert.match(harness.app.innerHTML, /class="badge-src">custom/);
  // Only the selected skill was imported.
  assert.doesNotMatch(harness.app.innerHTML, /incident-scribe/);

  // Save — the PATCH body carries the imported skill in the client shape.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(harness.agentPatchBodies[0]?.body.skills, [
    {
      name: 'release-notes',
      description: 'Turns merged PRs into a changelog.',
      instructions: '# Release notes\nWrite in launch voice.',
      enabled: true,
    },
  ]);
});

test('an import error is surfaced in the panel and dedupes a same-named skill on add', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_dupe',
        name: 'Dupe Profile',
        description: 'Dedupe profile',
        instructions: 'Answer with context.',
        enabled: true,
        model: 'local-stub/dupe',
        skills: [{ name: 'release-notes', description: 'Old copy.', instructions: 'Old body.', enabled: false }],
      },
    ],
    skillResolveError: {
      status: 502,
      error: 'public_only',
      message:
        'Only public repositories can be imported; the GitHub App integration governs private repository access',
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_dupe' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });

  // A server error surfaces its message inline and keeps the panel open.
  input({ target: inputTarget({ 'data-action': 'import-source' }, 'acme/skills') });
  click({ target: actionTarget({ 'data-action': 'import-find' }) });
  await flushAsync();
  assert.match(
    harness.app.innerHTML,
    /Only public repositories can be imported; the GitHub App integration governs private repository access/,
  );
  assert.match(harness.app.innerHTML, /data-action="import-source"/);
});

test('importing a same-named skill replaces the existing one rather than duplicating it', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_replace',
        name: 'Replace Profile',
        description: 'Replace profile',
        instructions: 'Answer with context.',
        enabled: true,
        model: 'local-stub/replace',
        skills: [{ name: 'release-notes', description: 'Old copy.', instructions: 'Old body.', enabled: false }],
      },
    ],
    skillResolution: {
      owner: 'acme',
      repo: 'skills',
      ref: 'main',
      total: 1,
      capped: false,
      skipped: 0,
      skills: [
        {
          name: 'release-notes',
          description: 'Fresh copy.',
          instructions: 'Fresh body.',
          hasScripts: false,
          path: 'release-notes',
          sourceUrl: 'https://github.com/acme/skills/tree/main/release-notes',
        },
      ],
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_replace' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  input({ target: inputTarget({ 'data-action': 'import-source' }, 'acme/skills@release-notes') });
  click({ target: actionTarget({ 'data-action': 'import-find' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'import-add' }) });

  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 1);
  // Exactly one release-notes skill, replaced with the imported copy (no duplicate).
  assert.deepEqual(harness.agentPatchBodies[0]?.body.skills, [
    { name: 'release-notes', description: 'Fresh copy.', instructions: 'Fresh body.', enabled: true },
  ]);
});

test('the import panel keeps public paste open while connected GitHub adds private repository discovery', async () => {
  const originalRepositories = [
    {
      id: 'repo_9_existing',
      installationId: 9,
      accountLogin: 'acme',
      fullName: 'acme/runtime-repo',
      enabled: true,
    },
  ];
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_private_import',
        name: 'Private Import Profile',
        description: 'Private import profile',
        instructions: 'Answer with context.',
        enabled: true,
        model: 'local-stub/private-import',
        skills: [],
        repositories: originalRepositories,
      },
    ],
    githubStatus: {
      mode: 'app',
      appSlug: 'chickpea-test',
      installations: [
        { id: 9, accountLogin: 'acme', accountType: 'Organization', repoCount: 80 },
      ],
      referencingProfiles: [],
    },
    githubRepoPages: {
      '9': {
        repos: [
          { fullName: 'acme/private-skills', private: true, defaultBranch: 'main' },
          { fullName: 'acme/<img src=x onerror=alert(1)>', private: false, defaultBranch: 'main' },
        ],
        totalCount: 80,
        truncated: true,
      },
    },
    skillBrowseDom: true,
    skillResolution: {
      owner: 'acme',
      repo: 'private-skills',
      ref: 'main',
      source: { visibility: 'private', access: 'github_app' },
      total: 1,
      capped: false,
      skipped: 0,
      skills: [
        {
          name: 'private-release',
          description: 'Prepare a private release.',
          instructions: 'Use the private release checklist.',
          hasScripts: true,
          path: 'private-release',
          sourceUrl: 'https://github.com/acme/private-skills/tree/main/private-release',
        },
      ],
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_private_import' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  await flushAsync();

  // Browse is a helper beside the same free-form source field; public paste remains supported.
  assert.match(harness.app.innerHTML, /owner\/repo, a GitHub URL, or a skills\.sh link/);
  assert.match(harness.app.innerHTML, /data-action="import-browse-open"[^>]*>Browse GitHub/);
  input({ target: inputTarget({ 'data-action': 'import-source' }, 'https://github.com/someone/public-skills') });
  click({ target: actionTarget({ 'data-action': 'import-browse-open' }) });
  await flushAsync();

  assert.deepEqual(harness.githubRepoCalls, [
    '/admin/api/github/installations/9/repos?q=&page=1',
  ]);
  const browseHtml = harness.skillBrowseHtml();
  assert.match(browseHtml, /acme\/private-skills/);
  assert.match(browseHtml, />Private<\/span>/);
  assert.match(browseHtml, /Not every repository is shown/);
  assert.match(browseHtml, /acme\/&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(browseHtml, /<img src=x onerror=alert\(1\)>/);

  // Choosing a repo only fills the editable source field; the normal Find action remains authoritative.
  click({
    target: actionTarget({
      'data-action': 'import-browse-select',
      'data-repo': 'acme/private-skills',
    }),
  });
  assert.match(harness.app.innerHTML, /value="acme\/private-skills"[^>]*data-action="import-source"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="import-browse-select"/);
  click({ target: actionTarget({ 'data-action': 'import-find' }) });
  await flushAsync();

  assert.deepEqual(harness.skillResolvePosts, [{ source: 'acme/private-skills' }]);
  assert.match(harness.app.innerHTML, /Private repository/);
  assert.match(harness.app.innerHTML, /Read through the connected GitHub App/);
  assert.match(harness.app.innerHTML, /copied into this Agent as a snapshot/);
  assert.match(harness.app.innerHTML, /does not grant the Agent access to the repository/);
  assert.match(harness.app.innerHTML, /won&rsquo;t run yet/);

  click({ target: actionTarget({ 'data-action': 'import-add' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.deepEqual(harness.agentPatchBodies[0]?.body.repositories, originalRepositories);
});

test('a repository picked from GitHub remains editable before Find skills', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_edit_source',
        revision: 1,
        name: 'Editable Source Profile',
        instructions: 'Answer.',
        enabled: true,
        model: 'local-stub/edit-source',
        skills: [],
      },
    ],
    githubStatus: {
      mode: 'app',
      installations: [
        { id: 17, accountLogin: 'acme', accountType: 'Organization', repoCount: 1 },
      ],
      referencingProfiles: [],
    },
    githubRepoPages: {
      '17': {
        repos: [{ fullName: 'acme/private-skills', private: true, defaultBranch: 'main' }],
        totalCount: 1,
        truncated: false,
      },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_edit_source' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'import-browse-open' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'import-browse-select', 'data-repo': 'acme/private-skills' }) });
  input({ target: inputTarget({ 'data-action': 'import-source' }, 'someone/public-skills@review') });
  click({ target: actionTarget({ 'data-action': 'import-find' }) });
  await flushAsync();

  assert.deepEqual(harness.skillResolvePosts, [{ source: 'someone/public-skills@review' }]);
});

test('GitHub import browsing chooses an installation locally and cancel preserves the pasted source', async () => {
  const harness = runAdminPageHarness({
    githubStatus: {
      mode: 'app',
      installations: [
        { id: 21, accountLogin: 'alice', accountType: 'User', repoCount: 2 },
        { id: 22, accountLogin: 'org<script>', accountType: 'Organization', repoCount: null },
      ],
      referencingProfiles: [],
    },
    githubRepoPages: {
      '22': {
        repos: [{ fullName: 'org/private-skill', private: true, defaultBranch: 'main' }],
        totalCount: 1,
        truncated: false,
      },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  await flushAsync();
  input({ target: inputTarget({ 'data-action': 'import-source' }, 'someone/public-skills') });
  click({ target: actionTarget({ 'data-action': 'import-browse-open' }) });

  assert.match(harness.app.innerHTML, /Choose an account or organization/);
  assert.match(harness.app.innerHTML, /org&lt;script&gt;/);
  assert.doesNotMatch(harness.app.innerHTML, /org<script>/);
  assert.equal(harness.githubRepoCalls.length, 0);
  click({
    target: actionTarget({
      'data-action': 'import-browse-account',
      'data-installation': '22',
      'data-account': 'org<script>',
    }),
  });
  await flushAsync();
  assert.deepEqual(harness.githubRepoCalls, ['/admin/api/github/installations/22/repos?q=&page=1']);

  click({ target: actionTarget({ 'data-action': 'import-browse-cancel' }) });
  assert.match(harness.app.innerHTML, /value="someone\/public-skills"[^>]*data-action="import-source"/);
  assert.match(harness.app.innerHTML, /data-action="import-find"/);
});

test('without a GitHub connection private discovery points to Settings but paste still works', async () => {
  const harness = runAdminPageHarness({
    githubStatus: { mode: 'none', referencingProfiles: [] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /data-action="import-source"/);
  assert.match(harness.app.innerHTML, /Paste any public GitHub repository/);
  assert.match(harness.app.innerHTML, /Connect GitHub in Settings to browse or import private repositories/);
  assert.match(harness.app.innerHTML, /data-action="open-settings" data-section="github-settings"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="import-browse-open"/);
});

test('GitHub import search ignores stale responses and keeps failures local to browsing', async () => {
  const pending: Array<(response: FakeResponse) => void> = [];
  const harness = runAdminPageHarness({
    githubStatus: {
      mode: 'app',
      installations: [
        { id: 31, accountLogin: 'acme', accountType: 'Organization', repoCount: 3 },
      ],
      referencingProfiles: [],
    },
    githubRepoFetch: () =>
      new Promise<FakeResponse>((resolve) => {
        pending.push(resolve);
      }),
    skillBrowseDom: true,
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  await flushAsync();
  input({ target: inputTarget({ 'data-action': 'import-source' }, 'someone/public-skills') });
  click({ target: actionTarget({ 'data-action': 'import-browse-open' }) });
  assert.equal(pending.length, 1);
  pending[0]?.(jsonResponse({ repos: [], totalCount: 3, truncated: false }));
  await flushAsync();

  input({ target: inputTarget({ 'data-action': 'import-browse-search' }, 'old') });
  input({ target: inputTarget({ 'data-action': 'import-browse-search' }, 'new') });
  assert.equal(pending.length, 3);
  assert.deepEqual(harness.githubRepoCalls.slice(1), [
    '/admin/api/github/installations/31/repos?q=old&page=1',
    '/admin/api/github/installations/31/repos?q=new&page=1',
  ]);
  pending[2]?.(
    jsonResponse({
      repos: [{ fullName: 'acme/new-result', private: true, defaultBranch: 'main' }],
      totalCount: 3,
      truncated: false,
    }),
  );
  await flushAsync();
  pending[1]?.(
    jsonResponse({
      repos: [{ fullName: 'acme/old-result', private: true, defaultBranch: 'main' }],
      totalCount: 3,
      truncated: false,
    }),
  );
  await flushAsync();

  assert.match(harness.skillBrowseHtml(), /acme\/new-result/);
  assert.doesNotMatch(harness.skillBrowseHtml(), /acme\/old-result/);
  click({ target: actionTarget({ 'data-action': 'import-browse-cancel' }) });
  assert.match(harness.app.innerHTML, /value="someone\/public-skills"/);
});

test('a GitHub discovery failure preserves the source field and offers a local retry', async () => {
  const harness = runAdminPageHarness({
    githubStatus: {
      mode: 'app',
      installations: [
        { id: 41, accountLogin: 'acme', accountType: 'Organization', repoCount: null },
      ],
      referencingProfiles: [],
    },
    githubRepoError: {
      status: 502,
      error: 'github_unavailable',
      message: 'Repository catalog unavailable. Paste an exact source or retry.',
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  await flushAsync();
  input({ target: inputTarget({ 'data-action': 'import-source' }, 'someone/public-skills') });
  click({ target: actionTarget({ 'data-action': 'import-browse-open' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Repository catalog unavailable\. Paste an exact source or retry\./);
  assert.match(harness.app.innerHTML, /data-action="import-browse-retry"/);
  assert.match(harness.app.innerHTML, /value="someone\/public-skills"[^>]*data-action="import-source"/);
  click({ target: actionTarget({ 'data-action': 'import-browse-cancel' }) });
  assert.match(harness.app.innerHTML, /data-action="import-find"/);
  click({ target: actionTarget({ 'data-action': 'import-find' }) });
  await flushAsync();
  assert.deepEqual(harness.skillResolvePosts, [{ source: 'someone/public-skills' }]);
});

test('GitHub import search updates its local browser while retaining focus and list scroll', async () => {
  const harness = runAdminPageHarness({
    skillBrowseDom: true,
    githubStatus: {
      mode: 'app',
      installations: [
        { id: 51, accountLogin: 'acme', accountType: 'Organization', repoCount: 1 },
      ],
      referencingProfiles: [],
    },
    githubRepoPages: {
      '51': {
        repos: [{ fullName: 'acme/private-skills', private: true, defaultBranch: 'main' }],
        totalCount: 1,
        truncated: false,
      },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'import-browse-open' }) });
  await flushAsync();

  assert.ok(harness.skillBrowseHostUpdates() >= 1);
  assert.ok(harness.skillBrowseFocusCalls() >= 2);
  assert.equal(harness.skillBrowseScrollTop(), 137);
});

test('a pending skill resolution cannot repaint a reopened import panel', async () => {
  const pending = new Map<string, (response: FakeResponse) => void>();
  const resolution = (name: string) => jsonResponse({
    resolution: {
      owner: 'acme',
      repo: name,
      ref: 'main',
      source: { visibility: 'public', access: 'anonymous' },
      total: 1,
      capped: false,
      skipped: 0,
      skills: [{
        name,
        description: `${name} description`,
        instructions: `${name} instructions`,
        hasScripts: false,
        path: name,
        sourceUrl: `https://github.com/acme/${name}`,
      }],
    },
  });
  const harness = runAdminPageHarness({
    githubStatus: { mode: 'none', referencingProfiles: [] },
    skillResolveFetch: (source) => new Promise<FakeResponse>((resolve) => {
      pending.set(source, resolve);
    }),
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  input({ target: inputTarget({ 'data-action': 'import-source' }, 'acme/old-source') });
  click({ target: actionTarget({ 'data-action': 'import-find' }) });
  click({ target: actionTarget({ 'data-action': 'import-cancel' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  input({ target: inputTarget({ 'data-action': 'import-source' }, 'acme/new-source') });
  click({ target: actionTarget({ 'data-action': 'import-find' }) });

  pending.get('acme/new-source')?.(resolution('new-source'));
  await flushAsync();
  assert.match(harness.app.innerHTML, /new-source description/);
  pending.get('acme/old-source')?.(resolution('old-source'));
  await flushAsync();
  assert.match(harness.app.innerHTML, /new-source description/);
  assert.doesNotMatch(harness.app.innerHTML, /old-source description/);
});

test('leaving the Skills tab closes only the nested import browser state', async () => {
  const harness = runAdminPageHarness({
    githubStatus: {
      mode: 'app',
      installations: [
        { id: 61, accountLogin: 'acme', accountType: 'Organization', repoCount: 1 },
      ],
      referencingProfiles: [],
    },
    githubRepoPages: {
      '61': {
        repos: [{ fullName: 'acme/private-skills', private: true, defaultBranch: 'main' }],
        totalCount: 1,
        truncated: false,
      },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });
  click({ target: actionTarget({ 'data-action': 'import-skills' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'import-browse-open' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /import-browse-host/);

  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'repositories' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });
  assert.doesNotMatch(harness.app.innerHTML, /import-browse-host/);
  assert.match(harness.app.innerHTML, /data-action="import-find"/);
});

test('saving a profile with a filled-but-not-added skill editor commits the skill, not drops it', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_trap',
        name: 'Trap Profile',
        description: 'Repro for the lost-skill bug',
        instructions: 'Answer.',
        enabled: true,
        model: 'local-stub/trap',
        skills: [],
      },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_trap' }) });

  // Open the editor and fill it — but do NOT click "Add skill" (skill-save-row).
  click({ target: actionTarget({ 'data-action': 'skill-new' }) });
  input({ target: inputTarget({ 'data-action': 'skill-field-name' }, 'incident-scribe') });
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'Build a timeline.') });
  input({ target: inputTarget({ 'data-action': 'skill-field-instructions' }, '# Incident Scribe') });

  // Click Save changes directly. The filled editor must be committed, not dropped.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(harness.agentPatchBodies[0]?.body.skills, [
    { name: 'incident-scribe', description: 'Build a timeline.', instructions: '# Incident Scribe', enabled: true },
  ]);
});

// ---- Connections (remote MCP servers) --------------------------------------

function chooseConnectionOwner(
  harness: { listeners: Record<string, Listener> },
  ownerKind: 'member' | 'team' = 'team',
): void {
  const change = harness.listeners.change;
  assert.ok(change);
  change({
    target: inputTarget({ 'data-action': 'connection-account-owner' }, ownerKind),
  });
}

test('Agent connections expose Agent-owned Team and personal accounts with managed Google OAuth', () => {
  const page = renderAdminPage();
  assert.match(page, />Personal</);
  assert.match(page, />Team</);
  assert.match(page, /Who uses this connection\?/);
  assert.match(page, /Each person signs in with their own account/);
  assert.match(page, /One shared account for everyone who can use/);
  assert.match(page, /connections\/managed\/start/);
  assert.match(page, /Sign-in opens in a secure/);
  assert.match(page, /Chickpea keeps a reference to the connected account/);
  assert.match(page, /Team and personal accounts this Agent can use/);
  assert.match(page, /This Agent will lose access and dependent schedules will pause/);
  assert.match(page, /provider may still list the authorization/);
  assert.match(page, /remove it from the provider.s account settings/);
  assert.doesNotMatch(page, /ask Composio to revoke Google access/);
  assert.match(page, /\/connections\?workspaceId=/);
  assert.match(page, /\/oauth\/api\/start/);
});

test('connection accounts use the compact prototype states without provider implementation details', async () => {
  const gmailAccount = {
    id: 'connection_managed_gmail',
    workspaceId: 'T_DESIGN',
    ownerKind: 'team',
    providerId: 'google',
    label: 'Gmail · Team',
    lifecycle: 'ready',
    credentialConfigured: true,
    identity: { accountName: 'team@acme.test' },
    policy: {
      kind: 'managed',
      adapterId: 'composio',
      toolkit: 'gmail',
      principalRef: 'chickpea:organization:T_DESIGN',
      accountRef: 'ca_test_gmail',
      allowedCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
    },
  };
  const calendarAccount = {
    id: 'connection_managed_calendar',
    workspaceId: 'T_DESIGN',
    ownerKind: 'member',
    providerId: 'google',
    label: 'Google Calendar · Personal',
    lifecycle: 'ready',
    credentialConfigured: true,
    identity: { accountName: 'person@acme.test' },
    policy: {
      kind: 'managed',
      adapterId: 'composio',
      toolkit: 'googlecalendar',
      principalRef: 'chickpea:member:membership_design',
      accountRef: 'ca_test_calendar',
      allowedCapabilities: ['calendar.calendars.list', 'calendar.events.list'],
    },
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [
        ownedConnection(gmailAccount, 'agent_conn', ['gmail.profile.read']),
        ownedConnection(calendarAccount),
      ],
      managedConnectors: {
        composio: true,
        catalog: [
          managedCatalogFixture('gmail', 'gmail', 'Gmail'),
          managedCatalogFixture('google-calendar', 'googlecalendar', 'Google Calendar'),
          managedCatalogFixture('hubspot-managed', 'hubspot', 'HubSpot'),
        ],
      },
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  const rows = html.match(/<div class="connection-state-stack">[\s\S]*?<\/section><\/div>/)?.[0] ?? '';
  assert.match(html, /<h4>In this Agent<\/h4>[\s\S]*?<span class="connection-section-count">2<\/span>/);
  assert.match(html, /<h4>Connect a new account<\/h4>/);
  assert.match(html, /connection-account-row connection-account-row-attached[\s\S]*?Gmail[\s\S]*?team@acme\.test &middot; Team/);
  assert.match(html, /connection-account-row connection-account-row-attached[\s\S]*?Google Calendar[\s\S]*?person@acme\.test &middot; Personal/);
  assert.match(html, /Google Calendar[\s\S]*?2 capabilities/);
  assert.doesNotMatch(html, /Google Calendar[\s\S]*?>Add<\/button>/);
  assert.match(html, /HubSpot[\s\S]*?No account[\s\S]*?>Connect<\/button>/);
  assert.match(html, /Gmail capabilities[\s\S]*?Read the email address and mailbox totals/);
  assert.match(html, /Gmail capabilities[\s\S]*?What this Agent can do with this account\./);
  assert.match(html, /Gmail[\s\S]*?<summary aria-label="Show 1 Gmail capability">1 capability<\/summary>/);
  assert.match(html, /class="conn-logo conn-logo-img"/);
  assert.doesNotMatch(rows, /Gmail · Team|Google Calendar · Personal|Personal · Personal|Team · Team/);
  assert.doesNotMatch(rows, /Managed ·|google \/ gmail|Managed OAuth|Composio|>In Agent</);
});

test('managed authorization polling backs off and stops for a manual check', () => {
  const page = renderAdminPage();
  assert.match(page, /current\.pollAttempts < 20 \? 1500 : current\.pollAttempts < 38 \? 5000 : 15000/);
  assert.match(page, /Date\.now\(\) - current\.startedAt >= 5 \* 60 \* 1000/);
  assert.match(page, /Still waiting for approval\. Finish sign-in, then check again\./);
});

test('Agent schedule controls use the scoped optimistic API without Runs as reassignment UI', () => {
  const page = renderAdminPage();
  assert.match(page, /\/agents\/" \+ encodeURIComponent\(agentId\) \+ "\/schedules\/" \+ encodeURIComponent\(scheduleId\) \+ "\/control"/);
  assert.match(page, /expectedVersion: expectedVersion/);
  assert.match(page, /acknowledgeIrreversible: true/);
  assert.match(page, /invalidateAgentSchedules\(agentId\);/);
  assert.doesNotMatch(page, /data-action="agent-schedule-reassign"/);
});

test('compact connection rows disclose only trusted capability effects and support hover, focus, and click disclosure', async () => {
  const unknownManaged = {
    id: 'connection_unknown_managed', workspaceId: 'T_DESIGN', ownerKind: 'team',
    providerId: 'google', label: 'Unknown managed', lifecycle: 'ready',
    policy: {
      kind: 'managed', adapterId: 'composio', toolkit: 'catalog_lag',
      accountRef: 'ca_unknown', principalRef: 'chickpea:organization:T_DESIGN',
      allowedCapabilities: ['gmail.messages.send'],
    },
  };
  const mcp = {
    id: 'connection_mcp', workspaceId: 'T_DESIGN', ownerKind: 'team',
    providerId: 'custom', label: 'Issue server', lifecycle: 'ready',
    policy: {
      kind: 'mcp', url: 'https://mcp.example.test', allowedTools: ['delete_issue'],
      discoveredTools: [{ name: 'delete_issue', description: 'Delete an issue.' }],
    },
  };
  const api = {
    id: 'connection_api', workspaceId: 'T_DESIGN', ownerKind: 'team',
    providerId: 'custom', label: 'Issue API', lifecycle: 'ready',
    policy: { kind: 'api', allowedHosts: ['api.example.test'], allowedMethods: ['GET', 'DELETE'] },
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [
      ownedConnection(unknownManaged),
      ownedConnection(mcp),
      ownedConnection(api),
    ] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /Unknown managed capabilities[\s\S]*?Messages send<\/span><\/li>/);
  assert.match(html, /Issue server capabilities[\s\S]*?Delete an issue\.<\/span><\/li>/);
  assert.doesNotMatch(html, /connection-capability-effect-unknown|>unknown<\/span>/);
  assert.match(html, /GET requests to approved paths<\/span><span class="connection-capability-effect">Read<\/span>/);
  assert.match(html, /DELETE requests to approved paths<\/span><span class="connection-capability-effect connection-capability-effect-write">Write<\/span>/);

  const page = renderAdminPage();
  assert.match(page, /\.connection-capabilities:not\(\[open\]\):hover > \.connection-capabilities-popover/);
  assert.match(page, /\.connection-capabilities:not\(\[open\]\):focus-within > \.connection-capabilities-popover/);
  assert.match(page, /querySelectorAll\("\.connection-state-stack details\[open\]"\)/);
  assert.match(page, /details !== clickedConnectionDetails/);
  assert.match(page, /\.connection-state-stack \.connection-row-menu-panel \{[\s\S]*?right: 34px;/);
  assert.match(page, /grid-template-columns: 38px minmax\(0, 1fr\) auto auto 28px/);
  assert.match(page, /\.connection-state-stack \.connection-account-state \{ grid-column: 2 \/ 5; grid-row: 2; \}/);
  assert.match(page, /\.connection-state-stack \.connection-capabilities \{ grid-column: 2; grid-row: 3; justify-self: start; \}/);
  assert.match(page, /\.connection-state-stack \.connection-row-action \{ grid-column: 4; grid-row: 3; \}/);
  assert.doesNotMatch(page, /connection-account-row-available \.connection-capabilities \{ display: none; \}/);
  assert.match(html, /<details class="connection-capabilities"><summary aria-label="Show /);
});

test('custom connection labels cannot spoof connector branding and keep their endpoint visible', async () => {
  const account = {
    id: 'connection_spoofed_drive', workspaceId: 'T_DESIGN', ownerKind: 'team',
    providerId: 'google-drive', label: 'Google Drive', lifecycle: 'ready',
    policy: {
      kind: 'mcp', url: 'https://mcp.attacker.example/connector', allowedTools: ['search_files'],
      presetId: 'google-drive',
      discoveredTools: [{ name: 'search_files', description: 'Search files.' }],
    },
    identity: { accountName: 'drive.google.com' },
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()], connectionAccounts: { attached: [ownedConnection(account)] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  const row = harness.app.innerHTML.match(/<div class="connection-account-row connection-account-row-attached">[\s\S]*?data-connection-id="connection_spoofed_drive"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.match(row, /conn-logo conn-logo-mono/);
  assert.doesNotMatch(row, /conn-logo conn-logo-img/);
  assert.match(row, /Google Drive<\/span><span class="connection-account-identity">mcp\.attacker\.example &middot; Team/);
});

test('Agent-owned rows suppress duplicate catalog entries and expose truthful search results', async () => {
  const gmail = {
    id: 'connection_gmail', workspaceId: 'T_DESIGN', ownerKind: 'team', providerId: 'google',
    label: 'Work email', lifecycle: 'ready', policy: {
      kind: 'managed', adapterId: 'composio', toolkit: 'gmail', accountRef: 'ca_gmail',
      principalRef: 'chickpea:organization:T_DESIGN', allowedCapabilities: ['gmail.profile.read'],
    },
  };
  const drive = {
    id: 'connection_drive', workspaceId: 'T_DESIGN', ownerKind: 'team', providerId: 'google',
    label: 'Drive', lifecycle: 'ready', policy: {
      kind: 'managed', adapterId: 'composio', toolkit: 'googledrive', accountRef: 'ca_drive',
      principalRef: 'chickpea:organization:T_DESIGN', allowedCapabilities: ['drive.files.search'],
    },
  };
  const calendar = {
    id: 'connection_calendar', workspaceId: 'T_DESIGN', ownerKind: 'team', providerId: 'google',
    label: 'Calendar account', lifecycle: 'ready', policy: {
      kind: 'managed', adapterId: 'composio', toolkit: 'googlecalendar', accountRef: 'ca_calendar',
      principalRef: 'chickpea:organization:T_DESIGN', allowedCapabilities: ['calendar.events.list'],
    },
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [
        ownedConnection(gmail),
        ownedConnection(drive),
        ownedConnection(calendar),
      ],
      managedConnectors: { composio: true, catalog: [
        managedCatalogFixture('gmail', 'gmail', 'Gmail'),
        managedCatalogFixture('google-drive', 'googledrive', 'Google Drive'),
        managedCatalogFixture('google-calendar', 'googlecalendar', 'Google Calendar'),
      ] },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  let html = harness.app.innerHTML;
  assert.match(html, /Work email[\s\S]*?Disconnect account/);
  assert.match(html, /Calendar account[\s\S]*?Disconnect account/);
  assert.doesNotMatch(html, /Remove from this Agent|connection-account-attach|connection-account-detach/);
  assert.doesNotMatch(html, /data-action="connection-account-preset" data-preset="(?:gmail|google-drive|google-calendar)">Connect<\/button>/);
  assert.doesNotMatch(html, /Connect (?:personal|Team) account/);
  assert.doesNotMatch(html, /Revoked Gmail|data-connection-id="connection_revoked"/);

  input({ target: inputTarget({ 'data-action': 'conn-gallery-search' }, 'gmail') });
  html = harness.app.innerHTML;
  assert.match(html, /Work email/);
  assert.doesNotMatch(html, /data-action="connection-account-preset" data-preset="gmail">Connect<\/button>/);

  input({ target: inputTarget({ 'data-action': 'conn-gallery-search' }, 'not-a-real-connector') });
  html = harness.app.innerHTML;
  assert.match(html, /No connectors match/);
  assert.doesNotMatch(html, /Custom connection/);
  assert.match(html, /<h4>Connect a new account<\/h4><span class="connection-section-count">0<\/span>/);

  input({ target: inputTarget({ 'data-action': 'conn-gallery-search' }, 'another') });
  html = harness.app.innerHTML;
  assert.match(html, /Custom connection/);
  assert.equal(html.match(/<h4>Connect a new account<\/h4><span class="connection-section-count">(\d+)<\/span>/)?.[1], '1');
});

test('Agent-owned rows remain visible while a connection form is open', async () => {
  const account = {
    id: 'connection_recovery', workspaceId: 'T_DESIGN', ownerKind: 'team', providerId: 'google',
    label: 'Recovery Gmail', lifecycle: 'needs_attention', policy: {
      kind: 'managed', adapterId: 'composio', toolkit: 'gmail', accountRef: 'ca_recovery',
      principalRef: 'chickpea:organization:T_DESIGN', allowedCapabilities: ['gmail.profile.read'],
    },
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()], connectionAccounts: { attached: [ownedConnection(account)] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  input({ target: inputTarget({ 'data-action': 'conn-gallery-search' }, 'mcp') });
  assert.match(harness.app.innerHTML, /Recovery Gmail/);
  click({ target: actionTarget({ 'data-action': 'connection-account-new' }) });
  const html = harness.app.innerHTML;
  assert.match(html, /Recovery Gmail[\s\S]*?data-action="connection-account-managed-reconnect"/);
  assert.match(html, /Recovery Gmail[\s\S]*?Needs attention/);
  assert.doesNotMatch(html, />needs attention</);
  assert.doesNotMatch(html, /id="conn-gallery-search-input"/);
  assert.doesNotMatch(html, /No connectors match/);
});

test('managed Notion renders only safe provider grant summaries', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [ownedConnection({
        id: 'connection_managed_notion',
        workspaceId: 'T_DESIGN',
        ownerKind: 'team',
        providerId: 'notion',
        label: 'Managed Notion',
        lifecycle: 'ready',
        credentialConfigured: true,
        policy: {
          kind: 'managed',
          adapterId: 'composio',
          toolkit: 'notion',
          principalRef: 'chickpea:organization:T_DESIGN',
          accountRef: 'ca_test_notion',
          allowedCapabilities: ['notion.content.search'],
          grantSummary: {
            items: [
              { type: 'page', label: 'Launch <script>alert(1)</script>' },
              { type: 'database', label: 'Customer pipeline' },
            ],
            truncated: true,
          },
        },
      })],
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  assert.match(
    harness.app.innerHTML,
    /Provider grant: Launch &lt;script&gt;alert\(1\)&lt;\/script&gt;, Customer pipeline and more/,
  );
  assert.doesNotMatch(harness.app.innerHTML, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(harness.app.innerHTML, /ca_test_notion/);
});

test('managed Google accounts that need attention reconnect in place', async () => {
  const account = {
    id: 'connection_managed_gmail',
    workspaceId: 'T_DESIGN',
    ownerKind: 'team',
    providerId: 'google',
    label: 'Managed Gmail',
    lifecycle: 'needs_attention',
    credentialConfigured: false,
    policy: {
      kind: 'managed',
      adapterId: 'composio',
      toolkit: 'gmail',
      principalRef: 'chickpea:organization:T_DESIGN',
      accountRef: 'ca_expired_gmail',
      allowedCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
    },
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [{
        account,
        binding: {
          agentId: 'agent_conn',
          connectionAccountId: account.id,
          providerId: 'google',
          allowedCapabilities: ['gmail.profile.read', 'gmail.messages.search'],
          enabled: true,
        },
      }],
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /data-action="connection-account-managed-reconnect"/);
  click({
    target: actionTarget({
      'data-action': 'connection-account-managed-reconnect',
      'data-connection-id': account.id,
    }),
  });
  await flushAsync();

  assert.deepEqual(harness.managedAuthorizationPosts, [{
    agentId: 'agent_conn',
    body: { workspaceId: 'T_DESIGN', connectionAccountId: account.id },
  }]);
  assert.deepEqual(harness.openedUrls, ['https://connect.composio.dev/link/lk_test']);
  assert.match(harness.app.innerHTML, /Finish sign-in in the new tab/);
  assert.equal(harness.managedPollCalls(), 1);

  click({ target: actionTarget({ 'data-action': 'managed-auth-cancel' }) });
  await flushAsync();
  assert.equal(harness.managedCancelCalls(), 1);
  assert.doesNotMatch(harness.app.innerHTML, /Finish sign-in in the new tab/);
});

test('managed sign-in polling retries a transient outage without rendering a raw error code', async () => {
  const account = {
    id: 'connection_managed_gmail_safe_error', workspaceId: 'T_DESIGN', ownerKind: 'team',
    providerId: 'google', label: 'Managed Gmail', lifecycle: 'needs_attention',
    credentialConfigured: false,
    policy: {
      kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
      principalRef: 'chickpea:organization:T_DESIGN', accountRef: 'ca_safe_error',
      allowedCapabilities: ['gmail.profile.read'],
    },
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    managedPollError: { status: 503, error: 'managed_provider_unavailable' },
    connectionAccounts: {
      attached: [{
        account,
        binding: {
          agentId: 'agent_conn', connectionAccountId: account.id, providerId: 'google',
          allowedCapabilities: ['gmail.profile.read'], enabled: true,
        },
      }],
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({
    target: actionTarget({
      'data-action': 'connection-account-managed-reconnect',
      'data-connection-id': account.id,
    }),
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Sign-in check is temporarily unavailable\. Chickpea will keep trying\./);
  assert.match(harness.app.innerHTML, /Finish sign-in in the new tab/);
  assert.doesNotMatch(harness.app.innerHTML, /managed_provider_unavailable/);
});

test('hostless polling completion refreshes the Agent and preserves its success notice', async () => {
  const storageKey = 'chickpea.managed-authorization.v1:agent_conn';
  const account = {
    id: 'connection_managed_gmail_poll_complete', workspaceId: 'T_DESIGN', ownerKind: 'team',
    providerId: 'google', label: 'Managed Gmail', lifecycle: 'ready',
    credentialConfigured: true,
    policy: {
      kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
      principalRef: 'chickpea:organization:T_DESIGN', accountRef: 'ca_poll_complete',
      allowedCapabilities: ['gmail.profile.read'],
    },
  };
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_conn',
    initialSessionStorage: {
      [storageKey]: JSON.stringify({
        agentId: 'agent_conn', toolkit: 'gmail', label: 'Gmail · Team',
        authorizationUrl: 'https://connect.composio.dev/link/lk_complete',
        pollUrl: '/admin/api/agents/agent_conn/connections/managed/poll',
        expiresAt: Date.now() + 20 * 60_000, startedAt: Date.now(),
        returnToSettings: false, popupBlocked: false,
      }),
    },
    managedPollResult: { status: 'connected', account: { id: account.id } },
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [{
        account,
        binding: {
          agentId: 'agent_conn', connectionAccountId: account.id, providerId: 'google',
          allowedCapabilities: ['gmail.profile.read'], enabled: true,
        },
      }],
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  assert.equal(harness.managedPollCalls(), 1);
  assert.equal(harness.sessionStorageValue(storageKey), null);
  assert.match(harness.app.innerHTML, /Gmail · Team is connected and ready for this Agent\./);
});

test('a stale managed provider clears the saved sign-in and asks the user to restart', async () => {
  const account = {
    id: 'connection_managed_gmail_stale_provider', workspaceId: 'T_DESIGN', ownerKind: 'team',
    providerId: 'google', label: 'Managed Gmail', lifecycle: 'needs_attention',
    credentialConfigured: false,
    policy: {
      kind: 'managed', adapterId: 'composio', toolkit: 'gmail',
      principalRef: 'chickpea:organization:T_DESIGN', accountRef: 'ca_stale_provider',
      allowedCapabilities: ['gmail.profile.read'],
    },
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    managedPollError: { status: 409, error: 'managed_authorization_stale_provider' },
    connectionAccounts: {
      attached: [{
        account,
        binding: {
          agentId: 'agent_conn', connectionAccountId: account.id, providerId: 'google',
          allowedCapabilities: ['gmail.profile.read'], enabled: true,
        },
      }],
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({
    target: actionTarget({
      'data-action': 'connection-account-managed-reconnect',
      'data-connection-id': account.id,
    }),
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /connector configuration changed\. Start the connection again\./);
  assert.doesNotMatch(harness.app.innerHTML, /managed_authorization_stale_provider/);
  assert.doesNotMatch(harness.app.innerHTML, /Finish sign-in in the new tab/);
});

test('resource-scoped managed accounts stay pending until Admin selects an allowed property', async () => {
  const account = {
    id: 'connection_analytics',
    revision: 3,
    workspaceId: 'T_DESIGN',
    ownerKind: 'team',
    providerId: 'google',
    label: 'Growth Analytics',
    lifecycle: 'pending',
    credentialConfigured: false,
    policy: {
      kind: 'managed',
      adapterId: 'composio',
      toolkit: 'google_analytics',
      allowedCapabilities: ['analytics.reports.run'],
      resourceConstraints: {
        propertyIds: [{ handle: 'property_primary', label: 'Website — Acme' }],
      },
    },
  };
  const descriptor = {
    ...managedCatalogFixture('google-analytics', 'google_analytics', 'Google Analytics', false),
    resources: [{
      key: 'propertyIds', label: 'GA4 properties', required: true, multiple: true,
    }],
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [{
        account,
        binding: {
          agentId: 'agent_conn', connectionAccountId: account.id, providerId: 'google',
          allowedCapabilities: ['analytics.reports.run'], resourceConstraints: {}, enabled: true,
        },
      }],
      managedConnectors: { composio: true, catalog: [descriptor] },
    },
    managedResourcePages: {
      'propertyIds:': {
        resources: [
          { handle: 'property_primary', label: 'Website — Acme' },
          { handle: 'property_secondary', label: 'Mobile — Acme' },
        ],
      },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /data-action="connection-account-resource-open"[^>]*>Choose<\/button>/);
  assert.doesNotMatch(harness.app.innerHTML, /Growth Analytics[\s\S]*?Reconnect/);
  click({ target: actionTarget({
    'data-action': 'connection-account-resource-open',
    'data-connection-id': account.id,
  }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Website — Acme/);
  assert.match(harness.app.innerHTML, /Mobile — Acme/);
  assert.doesNotMatch(harness.app.innerHTML, /properties\/123|ca_analytics/);

  click({ target: ({
    ...actionTarget({
      'data-action': 'connection-account-resource-toggle',
      'data-resource-key': 'propertyIds',
      'data-resource-handle': 'property_primary',
    }),
    checked: true,
  } as FakeTarget & { checked: boolean }) });
  click({ target: actionTarget({ 'data-action': 'connection-account-resource-save' }) });
  await flushAsync();

  assert.deepEqual(harness.managedResourcePosts, [{
    agentId: 'agent_conn',
    connectionId: account.id,
    body: {
      workspaceId: 'T_DESIGN',
      expectedRevision: 3,
      resourceConstraints: { propertyIds: ['property_primary'] },
    },
  }]);
});

test('resource-scoped managed accounts that need attention offer reconnect and resource recovery', async () => {
  const account = {
    id: 'connection_analytics_expired', revision: 4, workspaceId: 'T_DESIGN',
    ownerKind: 'team', providerId: 'google', label: 'Expired Analytics',
    lifecycle: 'needs_attention', credentialConfigured: false,
    policy: {
      kind: 'managed', adapterId: 'composio', toolkit: 'google_analytics',
      allowedCapabilities: ['analytics.reports.run'],
      resourceConstraints: {
        propertyIds: [{ handle: 'property_primary', label: 'Website — Acme' }],
      },
    },
  };
  const descriptor = {
    ...managedCatalogFixture('google-analytics', 'google_analytics', 'Google Analytics', false),
    resources: [{
      key: 'propertyIds', label: 'GA4 properties', required: true, multiple: true,
    }],
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [{
        account,
        binding: {
          agentId: 'agent_conn', connectionAccountId: account.id, providerId: 'google',
          allowedCapabilities: ['analytics.reports.run'], resourceConstraints: {}, enabled: true,
        },
      }],
      managedConnectors: { composio: true, catalog: [descriptor] },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /data-action="connection-account-managed-reconnect"/);
  assert.match(harness.app.innerHTML, /Choose GA4 properties/);
});

test('managed resource picker removes stale handles and warns when discovery is capped', async () => {
  const account = {
    id: 'connection_analytics_stale', revision: 5, workspaceId: 'T_DESIGN',
    ownerKind: 'team', providerId: 'google', label: 'Growth Analytics', lifecycle: 'ready',
    credentialConfigured: true,
    policy: {
      kind: 'managed', adapterId: 'composio', toolkit: 'google_analytics',
      allowedCapabilities: ['analytics.reports.run'],
      resourceConstraints: {
        propertyIds: [{ handle: 'property_stale', label: 'Deleted property' }],
      },
    },
  };
  const descriptor = {
    ...managedCatalogFixture('google-analytics', 'google_analytics', 'Google Analytics', false),
    resources: [{ key: 'propertyIds', label: 'GA4 properties', required: true, multiple: true }],
  };
  const managedResourcePages = Object.fromEntries(Array.from({ length: 20 }, (_, index) => {
    const cursor = index === 0 ? '' : `cursor_${index}`;
    return [`propertyIds:${cursor}`, {
      resources: [{ handle: `property_${index}`, label: `Property ${index}` }],
      nextCursor: `cursor_${index + 1}`,
    }];
  }));
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [{
        account,
        binding: {
          agentId: 'agent_conn', connectionAccountId: account.id, providerId: 'google',
          allowedCapabilities: ['analytics.reports.run'],
          resourceConstraints: { propertyIds: ['property_stale'] }, enabled: true,
        },
      }],
      managedConnectors: { composio: true, catalog: [descriptor] },
    },
    managedResourcePages,
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({ target: actionTarget({
    'data-action': 'connection-account-resource-open',
    'data-connection-id': account.id,
  }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /1 previously selected resource is no longer available/);
  assert.match(harness.app.innerHTML, /Only the first 20 pages or 2,000 resources are shown/);
  assert.doesNotMatch(harness.app.innerHTML, /data-resource-handle="property_stale"/);
  assert.match(
    harness.app.innerHTML,
    /data-action="connection-account-resource-save" disabled/,
  );

  click({ target: ({
    ...actionTarget({
      'data-action': 'connection-account-resource-toggle',
      'data-resource-key': 'propertyIds',
      'data-resource-handle': 'property_0',
    }),
    checked: true,
  } as FakeTarget & { checked: boolean }) });
  click({ target: actionTarget({ 'data-action': 'connection-account-resource-save' }) });
  await flushAsync();
  assert.deepEqual(harness.managedResourcePosts[0]?.body.resourceConstraints, {
    propertyIds: ['property_0'],
  });
});

test('an Agent-owned pending managed account offers reconnect instead of stranding the row', async () => {
  const account = {
    id: 'connection_pending_gmail',
    workspaceId: 'T_DESIGN',
    ownerKind: 'team',
    providerId: 'google',
    label: 'Pending Gmail',
    lifecycle: 'pending',
    credentialConfigured: false,
    policy: {
      kind: 'managed',
      adapterId: 'composio',
      toolkit: 'gmail',
      principalRef: 'chickpea:organization:T_DESIGN',
      accountRef: 'ca_pending_gmail',
      allowedCapabilities: ['gmail.profile.read'],
    },
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [ownedConnection(account)] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  assert.match(
    harness.app.innerHTML,
    /Pending Gmail[\s\S]*?data-action="connection-account-managed-reconnect"/,
  );
  assert.doesNotMatch(
    harness.app.innerHTML,
    /Pending Gmail[\s\S]*?data-action="connection-account-attach"/,
  );
});

test('Agent connection setup retains the complete preset catalog', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [] },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  const panel = harness.app.innerHTML;
  assert.match(panel, /Search connectors/);
  assert.match(panel, /data-action="connection-account-preset" data-preset="linear"/);
  assert.match(panel, /data-action="connection-account-preset" data-preset="zendesk"/);
  assert.match(panel, /data-action="connection-account-preset" data-preset="gmail"/);
  assert.match(panel, /data-action="connection-account-preset" data-preset="google-calendar"/);
  assert.match(panel, /data-action="connection-account-preset" data-preset="google-drive"/);
  assert.equal(
    (panel.match(/data-action="connection-account-preset"/g) ?? []).length,
    35,
  );
});

test('unconfigured managed connectors stay discoverable and continue after owner setup', async () => {
  const missingCatalog: Array<Record<string, unknown>> = managedSettingsCatalogFixture().map((descriptor) => ({
    ...descriptor,
    access: {
      read: { status: 'missing_configuration', missingConfiguration: ['api_key'] },
      write: { status: 'missing_configuration', missingConfiguration: ['api_key'] },
    },
  }));
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [],
      managedConnectors: {
        composio: false,
        canConfigure: true,
        catalog: missingCatalog,
      },
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  for (const descriptor of missingCatalog) {
    assert.match(harness.app.innerHTML, new RegExp(`data-preset="${descriptor.id}"`));
  }
  assert.match(harness.app.innerHTML, /YouTube[\s\S]*?Setup required[\s\S]*?>Set up<\/button>/);

  click({
    target: actionTarget({
      'data-action': 'connection-account-preset',
      'data-preset': 'youtube-managed',
      'data-owner-kind': 'member',
    }),
  });
  assert.match(harness.app.innerHTML, /role="dialog"[\s\S]*?Set up YouTube/);
  assert.match(harness.app.innerHTML, /type="password"/);
  assert.match(harness.app.innerHTML, /Settings &rarr; Project Settings &rarr; API Keys/);
  assert.match(
    harness.app.innerHTML,
    /leave OAuth user verification set to <strong>Not configured<\/strong>/,
  );
  assert.match(
    harness.app.innerHTML,
    /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="composio-setup-title"[\s\S]{0,1200}class="conn-logo conn-logo-img"/,
  );
  assert.doesNotMatch(
    harness.app.innerHTML,
    /role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="composio-setup-title"[\s\S]{0,1200}conn-logo-mono/,
  );

  const secret = 'ak_setup_secret_never_echo';
  input({ target: inputTarget({ 'data-action': 'composio-setup-key' }, secret) });
  click({ target: actionTarget({ 'data-action': 'composio-setup-save' }) });
  await flushAsync();

  assert.deepEqual(harness.composioSetupPosts, [{
    projectKey: secret,
    continuation: { agentId: 'agent_conn', toolkit: 'youtube' },
  }]);
  assert.doesNotMatch(harness.app.innerHTML, new RegExp(secret));
  assert.match(harness.app.innerHTML, /<strong>YouTube<\/strong>/);
  assert.match(harness.app.innerHTML, /value="member" data-action="connection-account-owner" checked/);
  assert.match(harness.app.innerHTML, /data-action="connection-account-managed-access"/);
});

test('members can discover managed connectors without seeing the project-key field', async () => {
  const descriptor = {
    ...managedCatalogFixture('youtube-managed', 'youtube', 'YouTube'),
    access: {
      read: { status: 'missing_configuration', missingConfiguration: ['api_key'] },
      write: { status: 'missing_configuration', missingConfiguration: ['api_key'] },
    },
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [],
      managedConnectors: { composio: false, canConfigure: false, catalog: [descriptor] },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({
    target: actionTarget({
      'data-action': 'connection-account-preset',
      'data-preset': 'youtube-managed',
    }),
  });

  assert.match(harness.app.innerHTML, /managed connectors must first be enabled by a Chickpea owner or admin/);
  assert.match(harness.app.innerHTML, /Ask an owner or admin to open Settings &rarr; Connectors/);
  assert.doesNotMatch(harness.app.innerHTML, /id="composio-project-key"/);
  const modalCopy = harness.app.innerHTML
    .slice(harness.app.innerHTML.lastIndexOf('Set up YouTube'))
    .replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(modalCopy, /composio/i);
});

test('deployment-managed connector setup sends owners to preparation without asking for the key', async () => {
  const descriptor = {
    ...managedCatalogFixture('youtube-managed', 'youtube', 'YouTube'),
    access: {
      read: { status: 'missing_configuration', missingConfiguration: ['auth_config_missing'] },
      write: { status: 'missing_configuration', missingConfiguration: ['auth_config_missing'] },
    },
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [],
      managedConnectors: {
        composio: false,
        canConfigure: true,
        configurationReadOnly: true,
        catalog: [descriptor],
      },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /YouTube[\s\S]*?Preparation required/);
  click({
    target: actionTarget({
      'data-action': 'connection-account-preset',
      'data-preset': 'youtube-managed',
    }),
  });

  assert.match(harness.app.innerHTML, /already supplies its project key through deployment configuration/);
  assert.match(harness.app.innerHTML, /prepare the standard connector defaults/);
  assert.doesNotMatch(harness.app.innerHTML, /id="composio-project-key"/);
});

test('provider policy blocks explain the operator fix instead of sending owners to preparation', async () => {
  const descriptor = {
    ...managedCatalogFixture('google-ads', 'googleads', 'Google Ads'),
    access: {
      read: {
        status: 'missing_configuration',
        missingConfiguration: ['provider_prerequisite_missing'],
      },
      write: {
        status: 'missing_configuration',
        missingConfiguration: ['provider_prerequisite_missing'],
      },
    },
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [],
      managedConnectors: {
        composio: true,
        canConfigure: true,
        configurationReadOnly: true,
        catalog: [descriptor],
      },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Google Ads[\s\S]*?Blocked by deployment policy/);
  click({
    target: actionTarget({
      'data-action': 'connection-account-preset',
      'data-preset': 'google-ads',
    }),
  });

  assert.match(harness.app.innerHTML, /sign-in is blocked by this installation&rsquo;s Google Ads policy/);
  assert.match(harness.app.innerHTML, /allow Composio managed OAuth or configure an eligible Google Ads API access tier/);
  assert.doesNotMatch(harness.app.innerHTML, /prepare the standard connector defaults/i);
});

test('connector handoff deep link opens the requested Agent-owned account form', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_conn/connections/new/gmail/member',
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [], managedConnectors: { composio: false },
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<strong>Gmail<\/strong>/);
  assert.match(harness.app.innerHTML, /value="member" data-action="connection-account-owner" checked/);
  assert.match(harness.app.innerHTML, /data-action="connection-account-google-access"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="connection-account-managed-access"/);
  assert.ok(
    harness.historyReplaces.some((path) => path === '/admin/agents/agent_conn'),
    'one-shot connector path should be canonicalized after opening the form',
  );
});

test('connector handoff waits for Composio before opening managed Google setup', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_conn/connections/new/gmail/member',
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [],
      managedConnectors: {
        composio: true,
        catalog: [managedCatalogFixture('gmail', 'gmail', 'Gmail')],
      },
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /data-action="connection-account-managed-access"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="connection-account-google-access"/);
  assert.ok(harness.historyReplaces.includes('/admin/agents/agent_conn'));
});

test('connector handoff opens a managed-only preset after the catalog loads', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_conn/connections/new/notion-managed/team',
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [],
      managedConnectors: {
        composio: true,
        catalog: [managedCatalogFixture('notion-managed', 'notion', 'Notion')],
      },
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<strong>Notion<\/strong>/);
  assert.match(harness.app.innerHTML, /data-action="connection-account-managed-access"/);
  assert.ok(harness.historyReplaces.includes('/admin/agents/agent_conn'));
});

test('connector handoff rejects an unknown account owner instead of widening it to Team', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_conn/connections/new/gmail/everyone',
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [] },
  });
  await flushAsync();

  assert.doesNotMatch(harness.app.innerHTML, /<strong>Gmail<\/strong>/);
  assert.doesNotMatch(harness.app.innerHTML, /Who uses this connection\?/);
});

test('connector handoff survives a transient initial Agent load failure', async () => {
  const handoffPath = '/admin/agents/agent_conn/connections/new/gmail/member';
  const harness = runAdminPageHarness({
    initialPath: handoffPath,
    agentsGetError: { status: 503, error: 'temporarily_unavailable' },
  });
  await flushAsync();

  assert.equal(harness.locationPath(), handoffPath);
  assert.equal(harness.historyReplaces.length, 0);
});

test('legacy Google access does not hide fresh Google connection presets', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent({
      apiConnections: [{
        id: 'google-workspace',
        displayName: 'Google Workspace',
        allowedHosts: ['www.googleapis.com'],
        pathPrefixes: ['/drive/v3'],
        headerName: 'Authorization',
        headerValuePrefix: 'Bearer ',
        allowedMethods: ['GET', 'HEAD'],
        enabled: true,
        authMode: 'oauth',
        oauthProvider: 'google',
        oauthScopes: ['https://www.googleapis.com/auth/drive.readonly'],
        lifecycleStatus: 'ready',
        statusText: 'Connected',
        presetId: 'google-workspace',
      }],
    })],
    connectionAccounts: { attached: [] },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  const panel = harness.app.innerHTML;
  assert.match(panel, /data-action="connection-account-preset" data-preset="gmail"/);
  assert.match(panel, /data-action="connection-account-preset" data-preset="google-calendar"/);
  assert.match(panel, /data-action="connection-account-preset" data-preset="google-drive"/);
  assert.equal((panel.match(/data-action="connection-account-preset"/g) ?? []).length, 35);
});

test('every catalog connector opens an Agent-owned setup flow', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [],
      managedConnectors: {
        composio: true,
        catalog: [
          managedCatalogFixture('google-sheets', 'googlesheets', 'Google Sheets'),
          managedCatalogFixture('google-docs', 'googledocs', 'Google Docs'),
          managedCatalogFixture('google-slides', 'googleslides', 'Google Slides'),
          managedCatalogFixture('google-search-console', 'google_search_console', 'Google Search Console'),
          managedCatalogFixture('google-analytics', 'google_analytics', 'Google Analytics'),
          managedCatalogFixture('notion-managed', 'notion', 'Notion'),
          managedCatalogFixture('hubspot-managed', 'hubspot', 'HubSpot'),
          managedCatalogFixture('gong-managed', 'gong', 'Gong'),
          managedCatalogFixture('google-ads', 'googleads', 'Google Ads'),
          managedCatalogFixture('youtube-managed', 'youtube', 'YouTube'),
        ],
      },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  const presetIds = CONNECTION_CATALOG_PRESETS.map(({ id }) => id);
  for (const presetId of presetIds) {
    click({ target: actionTarget({
      'data-action': 'connection-account-preset', 'data-preset': presetId,
    }) });
    assert.match(
      harness.app.innerHTML,
      /data-action="connection-account-create"/,
      `${presetId} should open an Agent-owned connection form`,
    );
    click({ target: actionTarget({ 'data-action': 'connection-account-cancel' }) });
  }
  assert.equal(presetIds.length, 35);
});

test('Agent-owned Sentry accounts use OAuth and preserve an organization/project-scoped resource', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'connection-account-preset', 'data-preset': 'sentry' }) });
  assert.match(harness.app.innerHTML, /data-action="connection-account-sentry-organization"/);
  assert.match(harness.app.innerHTML, /data-action="connection-account-sentry-project"/);
  assert.match(harness.app.innerHTML, /scope every request to one project/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="connection-account-credential"/);
  input({
    target: inputTarget({ 'data-action': 'connection-account-sentry-organization' }, 'acme'),
  });
  input({
    target: inputTarget({ 'data-action': 'connection-account-sentry-project' }, 'web-app'),
  });
  chooseConnectionOwner(harness);
  click({ target: actionTarget({ 'data-action': 'connection-account-create' }) });
  await flushAsync();

  const created = harness.connectionAccountPosts[0]?.body;
  assert.equal(created?.providerId, 'sentry');
  assert.equal(created?.credential, undefined);
  assert.deepEqual(created?.allowedCapabilities, []);
  assert.deepEqual(created?.mcp, {
    id: 'sentry',
    displayName: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp/acme/web-app',
    transport: 'streamable-http',
    authMode: 'oauth',
    headerNames: [],
    enabled: true,
    lifecycleStatus: 'pending',
    statusText: '',
    discoveredTools: [],
    allowedTools: [],
    presetId: 'sentry',
  });
  assert.deepEqual(harness.oauthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'connection_created', body: {} },
  ]);
  assert.deepEqual(harness.assignedUrls, ['https://auth.linear.example/authorize?state=opaque']);
});

test('Agent-owned Sentry rejects a project scope without an organization before saving or OAuth', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'connection-account-preset', 'data-preset': 'sentry' }) });
  input({
    target: inputTarget({ 'data-action': 'connection-account-sentry-project' }, 'web-app'),
  });
  chooseConnectionOwner(harness);
  click({ target: actionTarget({ 'data-action': 'connection-account-create' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Enter a Sentry organization before a project/);
  assert.deepEqual(harness.connectionAccountPosts, []);
  assert.deepEqual(harness.oauthStartPosts, []);
});

test('Agent-owned Intercom uses OAuth and warns before connecting a non-US workspace', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'connection-account-preset', 'data-preset': 'intercom' }) });

  assert.match(harness.app.innerHTML, /only for US-hosted workspaces/);
  assert.match(harness.app.innerHTML, /EU and Australian workspaces cannot use this preset yet/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="connection-account-credential"/);
  chooseConnectionOwner(harness);
  click({ target: actionTarget({ 'data-action': 'connection-account-create' }) });
  await flushAsync();

  const created = harness.connectionAccountPosts[0]?.body;
  assert.equal(created?.credential, undefined);
  assert.deepEqual(created?.mcp, {
    id: 'intercom',
    displayName: 'Intercom',
    url: 'https://mcp.intercom.com/mcp',
    transport: 'streamable-http',
    authMode: 'oauth',
    headerNames: [],
    enabled: true,
    lifecycleStatus: 'pending',
    statusText: '',
    discoveredTools: [],
    allowedTools: [],
    presetId: 'intercom',
  });
  assert.deepEqual(harness.oauthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'connection_created', body: {} },
  ]);
});

test('Sentry OAuth migration stays additive beside an existing token account', async () => {
  const legacy = {
    id: 'connection_sentry_token',
    workspaceId: 'T_DESIGN',
    ownerKind: 'team',
    providerId: 'sentry',
    label: 'Legacy Sentry token',
    lifecycle: 'ready',
    credentialConfigured: true,
    policy: {
      kind: 'mcp',
      url: 'https://mcp.sentry.dev/mcp',
      transport: 'streamable-http',
      authMode: 'none',
      headerNames: ['Authorization'],
      credentialHeaderName: 'Authorization',
      credentialValuePrefix: 'Sentry-Bearer ',
      discoveredTools: [{ name: 'search_issues' }],
      allowedTools: ['search_issues'],
      presetId: 'sentry',
    },
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [{
        account: legacy,
        binding: {
          agentId: 'agent_conn', connectionAccountId: legacy.id,
          providerId: 'sentry', allowedCapabilities: ['search_issues'], enabled: true,
        },
      }],
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Legacy Sentry token/);
  click({ target: actionTarget({ 'data-action': 'connection-account-preset', 'data-preset': 'sentry' }) });
  assert.match(harness.app.innerHTML, /adds OAuth beside the existing token connection/);
  assert.match(harness.app.innerHTML, /explicitly disconnect the token account/);
});

test('Agent-owned Linear accounts create policy before starting account-scoped MCP OAuth', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'connection-account-preset', 'data-preset': 'linear' }) });
  chooseConnectionOwner(harness);
  click({ target: actionTarget({ 'data-action': 'connection-account-create' }) });
  await flushAsync();

  const created = harness.connectionAccountPosts[0]?.body;
  assert.equal((created?.mcp as Record<string, unknown>)?.authMode, 'oauth');
  assert.equal((created?.mcp as Record<string, unknown>)?.oauthScope, 'read write');
  assert.equal((created?.mcp as Record<string, unknown>)?.presetId, 'linear');
  assert.deepEqual(harness.oauthStartPosts[0], {
    agentId: 'agent_conn', connectionId: 'connection_created', body: {},
  });
  assert.deepEqual(harness.assignedUrls, ['https://auth.linear.example/authorize?state=opaque']);
});

test('Agent-owned Google Drive accounts start a Drive-only Composio Connect Link', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'connection-account-preset', 'data-preset': 'google-drive' }) });
  const managedForm = harness.app.innerHTML.match(
    /<div class="skill-form">[\s\S]*?Continue to Google Drive[\s\S]*?<\/div>/,
  )?.[0] ?? '';
  assert.match(managedForm, /Sign-in opens in a secure Google Drive tab/);
  assert.match(managedForm, /class="connection-account-owner-options"/);
  assert.match(managedForm, /connection-account-owner-icon-personal/);
  assert.match(managedForm, /connection-account-owner-icon-team/);
  assert.doesNotMatch(managedForm, /<select[^>]+data-action="connection-account-owner"/);
  assert.doesNotMatch(managedForm, /<label[^>]*>Google OAuth client (ID|secret)<\/label>/);
  chooseConnectionOwner(harness);
  click({ target: actionTarget({ 'data-action': 'connection-account-create' }) });
  await flushAsync();

  assert.deepEqual(harness.managedAuthorizationPosts, [{
    agentId: 'agent_conn',
    body: {
      workspaceId: 'T_DESIGN', ownerKind: 'team', toolkit: 'googledrive', access: 'read',
    },
  }]);
  assert.deepEqual(harness.connectionAccountPosts, []);
  assert.deepEqual(harness.apiOAuthClientPuts, []);
  assert.deepEqual(harness.apiOAuthStartPosts, []);
  assert.deepEqual(harness.openedUrls, ['https://connect.composio.dev/link/lk_test']);
  assert.match(harness.app.innerHTML, /Finish sign-in in the new tab/);
});

test('Agent-owned Google Drive accounts can request a read-write Composio capability ceiling', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'connection-account-preset', 'data-preset': 'google-drive' }) });
  click({ target: actionTarget({ 'data-action': 'connection-account-managed-access', 'data-access': 'write' }) });
  chooseConnectionOwner(harness);
  click({ target: actionTarget({ 'data-action': 'connection-account-create' }) });
  await flushAsync();

  assert.equal(harness.managedAuthorizationPosts[0]?.body.access, 'write');
});

test('managed productivity cards expose only configured read lanes and disable missing writes', async () => {
  const unavailable = {
    status: 'missing_configuration', missingConfiguration: ['auth_config_missing'],
  };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [],
      managedConnectors: {
        composio: true,
        catalog: [
          managedCatalogFixture('google-sheets', 'googlesheets', 'Google Sheets', false),
          managedCatalogFixture('google-docs', 'googledocs', 'Google Docs'),
          {
            ...managedCatalogFixture('google-slides', 'googleslides', 'Google Slides'),
            access: { read: unavailable, write: unavailable },
          },
        ],
      },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /data-preset="google-sheets"/);
  assert.match(harness.app.innerHTML, /data-preset="google-docs"/);
  assert.match(harness.app.innerHTML, /data-preset="google-slides"[\s\S]*?Set up/);

  click({
    target: actionTarget({
      'data-action': 'connection-account-preset', 'data-preset': 'google-sheets',
    }),
  });
  assert.match(
    harness.app.innerHTML,
    /data-action="connection-account-managed-access" data-access="write" disabled aria-disabled="true"/,
  );
  assert.match(harness.app.innerHTML, /Write access is not configured for this connector/);
  chooseConnectionOwner(harness);
  click({ target: actionTarget({ 'data-action': 'connection-account-create' }) });
  await flushAsync();

  assert.deepEqual(harness.managedAuthorizationPosts, [{
    agentId: 'agent_conn',
    body: {
      workspaceId: 'T_DESIGN', ownerKind: 'team', toolkit: 'googlesheets', access: 'read',
    },
  }]);
});

test('custom Agent-owned API setup directs Google OAuth to the managed connectors', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'connection-account-new' }) });
  const form = harness.app.innerHTML;
  assert.match(form, /Use a managed Google connector for Google OAuth/);
  assert.doesNotMatch(form, /<option value="google_oauth"/);
  assert.match(form, /class="connection-account-owner-options"/);
  assert.doesNotMatch(form, /<select[^>]+data-action="connection-account-owner"/);
  assert.doesNotMatch(form, /data-action="connection-account-owner"[^>]+checked/);
  assert.match(form, /data-action="connection-account-create" disabled/);
  assert.match(form, /data-action="connection-account-kind"[\s\S]*?class="[^"]*select-caret/);
  assert.match(form, /data-action="connection-account-auth"[\s\S]*?class="[^"]*select-caret/);
});

test('self-hosted Agent-owned Google connectors fall back to native OAuth setup without Composio', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [], managedConnectors: { composio: false },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  assert.doesNotMatch(harness.app.innerHTML, /Managed OAuth/);
  assert.match(harness.app.innerHTML, /Google Drive[\s\S]{0,900}>Connect<\/button>/);
  assert.doesNotMatch(harness.app.innerHTML, /Google Drive[\s\S]{0,500}gallery-lane/);

  click({
    target: actionTarget({
      'data-action': 'connection-account-preset', 'data-preset': 'google-drive',
    }),
  });
  assert.match(harness.app.innerHTML, /Google OAuth client ID/);
  assert.match(harness.app.innerHTML, /Google OAuth client secret/);
  assert.match(harness.app.innerHTML, /Google Drive access/);
  assert.doesNotMatch(harness.app.innerHTML, /Google sign-in opens through Composio/);
  click({ target: actionTarget({ 'data-action': 'connection-account-cancel' }) });

  click({ target: actionTarget({ 'data-action': 'connection-account-new' }) });
  assert.match(harness.app.innerHTML, /<option value="google_oauth"/);
  assert.match(harness.app.innerHTML, /This deployment uses its own Google OAuth client credentials/);
});

test('Agent-owned Exa accounts support anonymous limits without an API key', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [] },
    mcpTestResult: { ok: true, tools: [{ name: 'web_search_exa' }] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'connection-account-preset', 'data-preset': 'exa' }) });
  assert.match(harness.app.innerHTML, /Credential<span class="hint">\(optional\)<\/span>|Credential <span class="hint">\(optional\)<\/span>/);
  assert.match(harness.app.innerHTML, /Leave blank to use the provider.s anonymous limits/);
  chooseConnectionOwner(harness);
  click({ target: actionTarget({ 'data-action': 'connection-account-create' }) });
  await flushAsync();

  assert.equal(harness.connectionAccountPosts.length, 1);
  assert.equal(harness.connectionAccountPosts[0]?.body.credential, undefined);
  assert.deepEqual(harness.connectionAccountPosts[0]?.body.allowedCapabilities, ['web_search_exa']);
  assert.equal(
    (harness.connectionAccountPosts[0]?.body.mcp as Record<string, unknown>).credentialOptional,
    true,
  );
  const testedHeaders = harness.mcpTestPosts[0]?.headers as Record<string, string> | undefined;
  assert.equal(testedHeaders?.['x-api-key'], undefined);
});

test('Agent-owned Zendesk accounts validate and persist the workspace subdomain', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'connection-account-preset', 'data-preset': 'zendesk' }) });
  assert.match(harness.app.innerHTML, /Workspace subdomain/);

  chooseConnectionOwner(harness);
  input({ target: inputTarget({ 'data-action': 'connection-account-credential' }, 'zendesk-token') });
  click({ target: actionTarget({ 'data-action': 'connection-account-create' }) });
  assert.equal(harness.connectionAccountPosts.length, 0);
  assert.match(harness.app.innerHTML, /Enter the workspace subdomain from your service URL/);

  input({ target: inputTarget({ 'data-action': 'connection-account-subdomain' }, 'acme-support') });
  click({ target: actionTarget({ 'data-action': 'connection-account-create' }) });
  await flushAsync();

  const created = harness.connectionAccountPosts[0]?.body;
  assert.equal(created?.credential, 'zendesk-token');
  assert.deepEqual((created?.api as Record<string, unknown>).allowedHosts, ['acme-support.zendesk.com']);
  assert.deepEqual((created?.api as Record<string, unknown>).pathPrefixes, ['/api/v2']);
});

test('Agent-owned Supabase accounts scope OAuth to one project and default to read-only', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: { attached: [] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'connection-account-preset', 'data-preset': 'supabase' }) });
  assert.match(harness.app.innerHTML, /Database access/);
  assert.match(harness.app.innerHTML, /data-access="read-only"/);
  assert.match(harness.app.innerHTML, /data-access="read-write"/);

  chooseConnectionOwner(harness);
  click({ target: actionTarget({ 'data-action': 'connection-account-create' }) });
  assert.equal(harness.connectionAccountPosts.length, 0);
  assert.match(harness.app.innerHTML, /Enter a valid Supabase project reference/);

  input({ target: inputTarget({ 'data-action': 'connection-account-supabase-ref' }, 'abcdefghijklmnopqrst') });
  click({ target: actionTarget({ 'data-action': 'connection-account-create' }) });
  await flushAsync();

  const mcp = harness.connectionAccountPosts[0]?.body.mcp as Record<string, unknown>;
  assert.match(String(mcp.url), /project_ref=abcdefghijklmnopqrst/);
  assert.match(String(mcp.url), /read_only=true/);
  assert.deepEqual(harness.oauthStartPosts[0], {
    agentId: 'agent_conn', connectionId: 'connection_created', body: {},
  });
});

function connectionsAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'agent_conn',
    name: 'Conn Profile',
    description: 'Connections profile',
    instructions: 'Answer with connection context.',
    enabled: true,
    model: 'local-stub/conn',
    skills: [],
    mcpServers: [],
    apiConnections: [],
    ...overrides,
  };
}

function ownedConnection(
  account: Record<string, unknown>,
  agentId = 'agent_conn',
  allowedCapabilities?: string[],
): Record<string, unknown> {
  const policy = account.policy as { allowedCapabilities?: string[] } | undefined;
  return {
    account,
    binding: {
      agentId,
      connectionAccountId: account.id,
      providerId: account.providerId,
      allowedCapabilities: allowedCapabilities ?? policy?.allowedCapabilities ?? [],
      enabled: true,
    },
  };
}

function managedCatalogFixture(
  id: string,
  toolkit: string,
  label: string,
  writeReady = true,
): Record<string, unknown> {
  const ready = { status: 'ready', missingConfiguration: [] };
  return {
    id,
    toolkit,
    providerId: 'google',
    label,
    description: `${label} managed connector`,
    securityDescription: 'Google sign-in opens through Composio.',
    capabilities: id === 'gmail'
      ? [
          { id: 'gmail.profile.read', accessLane: 'read', description: 'Read the email address and mailbox totals.' },
          { id: 'gmail.messages.search', accessLane: 'read', description: 'Search messages with Gmail query syntax.' },
        ]
      : id === 'google-calendar'
        ? [
            { id: 'calendar.calendars.list', accessLane: 'read', description: 'List accessible calendars.' },
            { id: 'calendar.events.list', accessLane: 'read', description: 'List or search calendar events.' },
          ]
        : [],
    access: {
      read: ready,
      write: writeReady
        ? ready
        : { status: 'missing_configuration', missingConfiguration: ['auth_config_missing'] },
    },
  };
}

function managedSettingsCatalogFixture(): Array<Record<string, unknown>> {
  const connectors: Array<[string, string, string]> = [
    ['gmail', 'gmail', 'Gmail'],
    ['google-calendar', 'googlecalendar', 'Google Calendar'],
    ['google-drive', 'googledrive', 'Google Drive'],
    ['google-sheets', 'googlesheets', 'Google Sheets'],
    ['google-docs', 'googledocs', 'Google Docs'],
    ['google-slides', 'googleslides', 'Google Slides'],
    ['google-search-console', 'google_search_console', 'Google Search Console'],
    ['google-analytics', 'google_analytics', 'Google Analytics'],
    ['notion-managed', 'notion', 'Notion'],
    ['hubspot-managed', 'hubspot', 'HubSpot'],
    ['gong-managed', 'gong', 'Gong'],
    ['google-ads', 'googleads', 'Google Ads'],
    ['youtube-managed', 'youtube', 'YouTube'],
  ];
  return connectors.map(([id, toolkit, label]) => managedCatalogFixture(id, toolkit, label));
}

function apiConnectionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'issue-api',
    displayName: 'Issue API',
    allowedHosts: ['api.example.com'],
    pathPrefixes: ['/v1'],
    headerName: 'Authorization',
    headerValuePrefix: 'Bearer ',
    allowedMethods: ['GET', 'POST'],
    enabled: true,
    // The agent GET resolves the real write-only credential source; a saved
    // connection with a stored secret reports "stored".
    credentialSource: 'stored',
    ...overrides,
  };
}

function mcpConnectionFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'linear',
    displayName: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    transport: 'streamable-http',
    authMode: 'bearer',
    headerNames: [],
    enabled: true,
    allowedTools: ['list_issues'],
    discoveredTools: [{ name: 'list_issues' }],
    lifecycleStatus: 'ready',
    statusText: '',
    lastCheckedAt: null,
    presetId: 'linear',
    ...overrides,
  };
}

test('Custom connection opens the MCP lane by default', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });

  const editor = harness.app.innerHTML;
  assert.match(editor, /class="on" data-action="custom-lane" data-lane="mcp">MCP<\/button>/);
  assert.match(editor, /class="" data-action="custom-lane" data-lane="api">API<\/button>/);
  assert.match(editor, /<label class="field-label" for="conn-url">Server URL<\/label>/);
  assert.match(editor, /<label class="field-label">Transport<\/label>/);
  assert.doesNotMatch(editor, /data-action="apiconn-host-input"/);
  assert.doesNotMatch(editor, /data-action="apiconn-method-toggle"/);
});

test('the Custom connection lane tab switches between MCP and API forms', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });

  click({ target: actionTarget({ 'data-action': 'custom-lane', 'data-lane': 'api' }) });
  assert.match(harness.app.innerHTML, /class="on" data-action="custom-lane" data-lane="api">API<\/button>/);
  assert.match(harness.app.innerHTML, /data-action="apiconn-host-input"/);
  assert.match(harness.app.innerHTML, /data-action="apiconn-method-toggle"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-field-url"/);

  click({ target: actionTarget({ 'data-action': 'custom-lane', 'data-lane': 'mcp' }) });
  assert.match(harness.app.innerHTML, /class="on" data-action="custom-lane" data-lane="mcp">MCP<\/button>/);
  assert.match(harness.app.innerHTML, /data-action="conn-field-url"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="apiconn-host-input"/);
});

test('the Custom connection lane tab preserves MCP input while visiting API', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });

  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Preserved MCP') });
  click({ target: actionTarget({ 'data-action': 'custom-lane', 'data-lane': 'api' }) });
  click({ target: actionTarget({ 'data-action': 'custom-lane', 'data-lane': 'mcp' }) });

  assert.match(harness.app.innerHTML, /value="Preserved MCP"[^>]*data-action="conn-field-name"/);
});

test('the Connections panel has one custom create entry point and no separate API section', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });

  const panel = harness.app.innerHTML;
  assert.equal((panel.match(/data-action="conn-custom"/g) ?? []).length, 1);
  assert.match(panel, /<span class="gallery-row-name">Custom connection<\/span>/);
  assert.doesNotMatch(panel, /data-action="apiconn-new"/);
  assert.doesNotMatch(panel, />API connections<\/h3>/);
  assert.doesNotMatch(panel, />Add API connection<\/button>/);
});

test('a connected preset drops out of the Available gallery until it is removed', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [mcpConnectionFixture()],
        apiConnections: [
          apiConnectionFixture({ id: 'asana', presetId: 'asana', displayName: 'Asana', allowedHosts: ['app.asana.com'] }),
        ],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });

  const panel = harness.app.innerHTML;
  // Linear and Asana are already connected, so the gallery no longer offers them...
  assert.doesNotMatch(panel, /data-action="conn-preset" data-preset="linear"/);
  assert.doesNotMatch(panel, /data-action="conn-preset" data-preset="asana"/);
  // ...other presets remain, and the Available count drops from 25 to 23.
  assert.match(panel, /data-action="conn-preset" data-preset="airtable"/);
  assert.match(panel, /<span class="gallery-head-count">23<\/span>/);
});

test('OAuth rows surface a persisted reconnect requirement instead of stale connected copy', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [mcpConnectionFixture({
          id: 'notion',
          displayName: 'Notion',
          url: 'https://mcp.notion.com/mcp',
          authMode: 'oauth',
          lifecycleStatus: 'pending',
          statusText: 'Reconnect required',
          presetId: 'notion',
        })],
        apiConnections: [apiConnectionFixture({
          id: 'google-workspace',
          displayName: 'Google Workspace',
          authMode: 'oauth',
          oauthProvider: 'google',
          lifecycleStatus: 'pending',
          statusText: 'Reconnect required',
          presetId: 'google-workspace',
        })],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });

  const panel = harness.app.innerHTML;
  assert.equal((panel.match(/Reconnect required/g) ?? []).length, 2);
  assert.doesNotMatch(panel, /Connected &middot;/);

  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });
  assert.match(harness.app.innerHTML, /<span>Sign into Native Notion<\/span>/);
});

test('saved MCP and API connections share one lane-badged list with matching inline editors', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [mcpConnectionFixture({ presetId: undefined })],
        apiConnections: [apiConnectionFixture()],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });

  const panel = harness.app.innerHTML;
  assert.equal((panel.match(/<div class="skill-list">/g) ?? []).length, 1);
  const mcpEditIndex = panel.indexOf('data-action="conn-edit" data-index="0"');
  const apiEditIndex = panel.indexOf('data-action="apiconn-edit" data-index="0"');
  const mcpRowStart = panel.lastIndexOf('<div class="skill-row conn-row">', mcpEditIndex);
  const apiRowStart = panel.lastIndexOf('<div class="skill-row conn-row">', apiEditIndex);
  assert.ok(mcpRowStart >= 0 && mcpRowStart < apiRowStart && apiRowStart < apiEditIndex);
  const mcpRow = panel.slice(mcpRowStart, apiRowStart);
  const apiRow = panel.slice(apiRowStart, panel.indexOf('data-action="conn-gallery-search"', apiRowStart));
  assert.match(mcpRow, /<span class="gallery-lane">MCP<\/span>/);
  assert.match(apiRow, /<span class="gallery-lane">API<\/span>/);
  assert.ok(mcpEditIndex < apiEditIndex);

  click({ target: actionTarget({ 'data-action': 'apiconn-edit', 'data-index': '0' }) });
  assert.match(harness.app.innerHTML, /value="Issue API"[^>]*data-action="apiconn-field-name"/);
  assert.match(harness.app.innerHTML, /value="api\.example\.com"[^>]*data-action="apiconn-host-input"/);
  click({ target: actionTarget({ 'data-action': 'apiconn-cancel' }) });

  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });
  assert.match(harness.app.innerHTML, /value="Linear"[^>]*data-action="conn-field-name"/);
  assert.match(harness.app.innerHTML, /value="https:\/\/mcp\.linear\.app\/mcp"[^>]*data-action="conn-field-url"/);
});

test('a saved bearer Linear connection stays Advanced after the catalog upgrades to OAuth', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent({ mcpServers: [mcpConnectionFixture()] })],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });

  const editor = harness.app.innerHTML;
  assert.match(editor, /value="https:\/\/mcp\.linear\.app\/mcp"[^>]*data-action="conn-field-url"/);
  assert.match(editor, /<option value="bearer" selected>Bearer token<\/option>/);
  assert.match(editor, /placeholder="•••• stored"[^>]*data-action="conn-field-bearer"/);
  assert.doesNotMatch(editor, /data-action="conn-oauth-start"/);
  assert.doesNotMatch(editor, /data-action="conn-view"/);

  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  const saved = (harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>)[0];
  assert.equal(saved?.url, 'https://mcp.linear.app/mcp');
  assert.equal(saved?.authMode, 'bearer');
  assert.equal(saved?.presetId, 'linear');
  assert.deepEqual(harness.mcpSecretPuts, []);
});

test('a saved PAT Airtable connection stays Advanced after the catalog upgrades to OAuth', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          mcpConnectionFixture({
            id: 'airtable',
            displayName: 'Airtable',
            url: 'https://mcp.airtable.com/mcp',
            presetId: 'airtable',
          }),
        ],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });

  const editor = harness.app.innerHTML;
  assert.match(editor, /value="https:\/\/mcp\.airtable\.com\/mcp"[^>]*data-action="conn-field-url"/);
  assert.match(editor, /<option value="bearer" selected>Bearer token<\/option>/);
  assert.match(editor, /placeholder="•••• stored"[^>]*data-action="conn-field-bearer"/);
  assert.doesNotMatch(editor, /data-action="conn-oauth-start"/);
  assert.doesNotMatch(editor, /data-action="conn-view"/);
});

test('a saved API-key PostHog connection stays Advanced after the catalog upgrades to OAuth', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          mcpConnectionFixture({
            id: 'posthog',
            displayName: 'PostHog',
            url: 'https://mcp.posthog.com/mcp',
            presetId: 'posthog',
          }),
        ],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });

  const editor = harness.app.innerHTML;
  assert.match(editor, /value="https:\/\/mcp\.posthog\.com\/mcp"[^>]*data-action="conn-field-url"/);
  assert.match(editor, /<option value="bearer" selected>Bearer token<\/option>/);
  assert.match(editor, /placeholder="•••• stored"[^>]*data-action="conn-field-bearer"/);
  assert.doesNotMatch(editor, /data-action="conn-oauth-start"/);
  assert.doesNotMatch(editor, /data-action="conn-view"/);
});

test('a saved access-token Supabase connection stays Advanced after the catalog upgrades to OAuth', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          mcpConnectionFixture({
            id: 'supabase',
            displayName: 'Supabase',
            url: 'https://mcp.supabase.com/mcp',
            presetId: 'supabase',
          }),
        ],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });

  const editor = harness.app.innerHTML;
  assert.match(editor, /value="https:\/\/mcp\.supabase\.com\/mcp"[^>]*data-action="conn-field-url"/);
  assert.match(editor, /<option value="bearer" selected>Bearer token<\/option>/);
  assert.match(editor, /placeholder="•••• stored"[^>]*data-action="conn-field-bearer"/);
  assert.doesNotMatch(editor, /data-action="conn-oauth-start"/);
  assert.doesNotMatch(editor, /data-action="conn-view"/);
});

test('a saved read-only Linear OAuth connection stays Advanced after the catalog URL gains write access', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          mcpConnectionFixture({
            url: 'https://mcp.linear.app/mcp/readonly',
            authMode: 'oauth',
            lifecycleStatus: 'pending',
            discoveredTools: [],
            allowedTools: [],
          }),
        ],
      }),
    ],
    deferAgentPatch: true,
    oauthStartResult: {
      authorizationUrl: 'https://linear.example/authorize?state=legacy-readonly',
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });

  const editor = harness.app.innerHTML;
  assert.match(
    editor,
    /value="https:\/\/mcp\.linear\.app\/mcp\/readonly"[^>]*data-action="conn-field-url"/,
  );
  assert.match(editor, /<option value="oauth" selected>OAuth<\/option>/);
  assert.match(editor, /data-action="conn-field-oauth-scope"/);
  assert.match(editor, /data-action="conn-oauth-start"[^>]*>[\s\S]*?<span>Sign into Linear<\/span>/);
  assert.doesNotMatch(editor, /data-action="conn-view"/);
  assert.doesNotMatch(editor, /read and write access/);

  // Exercise the mocked OAuth action directly to prove this legacy row does
  // not borrow the replacement catalog preset's broader scope.
  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(harness.oauthStartPosts, []);

  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.equal(servers[0]?.url, 'https://mcp.linear.app/mcp/readonly');
  assert.equal(servers[0]?.authMode, 'oauth');
  assert.equal(servers[0]?.presetId, 'linear');

  harness.resolveAgentPatch();
  await flushAsync();

  assert.deepEqual(harness.oauthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'linear', body: {} },
  ]);
  assert.deepEqual(harness.assignedUrls, [
    'https://linear.example/authorize?state=legacy-readonly',
  ]);
});

test('a URL-customized OAuth connection keeps lifecycle controls and its saved scope', async () => {
  const scope =
    'organizations:read projects:read projects:write database:write database:read analytics:read secrets:read edge_functions:read edge_functions:write environment:read environment:write storage:read';
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          mcpConnectionFixture({
            id: 'supabase',
            displayName: 'Supabase',
            url: 'https://mcp.supabase.com/mcp?project_ref=test-project&read_only=true',
            authMode: 'oauth',
            oauthScope: scope,
            lifecycleStatus: 'ready',
            statusText: 'Connected · 2 tools',
            presetId: 'supabase',
          }),
        ],
      }),
    ],
    deferAgentPatch: true,
    oauthStartResult: {
      authorizationUrl: 'https://api.supabase.com/v1/oauth/authorize?state=customized',
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });

  const editor = harness.app.innerHTML;
  assert.match(editor, /data-action="conn-view" data-view="recommended"/);
  assert.match(editor, /value="test-project"[^>]*data-action="conn-supabase-project-ref"/);
  assert.match(editor, /class="on" data-action="conn-supabase-access" data-access="read-only"/);
  assert.match(editor, /class="oauth-account-name">test-project<\/span>/);
  assert.match(editor, /data-action="conn-oauth-start">Reconnect<\/button>/);
  assert.match(editor, /data-action="conn-oauth-disconnect">Disconnect<\/button>/);

  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();
  assert.deepEqual(harness.oauthStartPosts, []);
  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.equal(servers[0]?.oauthScope, scope);

  harness.resolveAgentPatch();
  await flushAsync();
  assert.deepEqual(harness.oauthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'supabase', body: { scope } },
  ]);
});

test('canceling the custom API form clears custom mode and restores the gallery', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });
  click({ target: actionTarget({ 'data-action': 'custom-lane', 'data-lane': 'api' }) });
  click({ target: actionTarget({ 'data-action': 'apiconn-cancel' }) });

  assert.match(harness.app.innerHTML, /data-action="conn-gallery-search"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="custom-lane"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-field-url"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="apiconn-host-input"/);
});

test('preset Connect keeps a fixed lane and the Recommended and Advanced setup toggle', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'asana' }) });

  assert.doesNotMatch(harness.app.innerHTML, /data-action="custom-lane"/);
  assert.match(harness.app.innerHTML, /data-action="apiconn-view" data-view="recommended"/);
  assert.match(harness.app.innerHTML, /data-action="apiconn-view" data-view="advanced"/);
  click({ target: actionTarget({ 'data-action': 'apiconn-view', 'data-view': 'advanced' }) });
  assert.match(harness.app.innerHTML, /data-action="apiconn-field-name"/);
  assert.match(harness.app.innerHTML, /data-action="apiconn-host-input"/);
});

test('the Connections tab adds an API connection policy and stores its credential separately', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });

  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });
  click({ target: actionTarget({ 'data-action': 'custom-lane', 'data-lane': 'api' }) });
  const editor = harness.app.innerHTML;
  assert.doesNotMatch(editor, /data-action="apiconn-view"/);
  assert.match(editor, /data-action="apiconn-field-name"/);
  assert.match(editor, /placeholder="api\.example\.com"[^>]*data-action="apiconn-host-input"/);
  assert.match(editor, /placeholder="\/v1"[^>]*data-action="apiconn-path-input"/);
  assert.match(editor, /placeholder="Authorization"[^>]*data-action="apiconn-field-header-name"/);
  assert.match(editor, /data-action="apiconn-method-toggle" data-index="0" checked/);
  assert.match(editor, /data-action="apiconn-method-toggle" data-index="2" checked/);
  assert.match(editor, /type="password"[^>]*data-action="apiconn-field-credential"/);

  input({ target: inputTarget({ 'data-action': 'apiconn-field-name' }, 'Issue API') });
  input({ target: inputTarget({ 'data-action': 'apiconn-host-input', 'data-index': '0' }, 'api.example.com') });
  input({ target: inputTarget({ 'data-action': 'apiconn-field-header-name' }, 'Authorization') });
  input({ target: inputTarget({ 'data-action': 'apiconn-field-header-prefix' }, 'Bearer ') });
  input({ target: inputTarget({ 'data-action': 'apiconn-field-credential' }, 'rest-secret-token') });
  change({ target: checkboxTarget({ 'data-action': 'apiconn-method-toggle', 'data-index': '2' }, false) });

  click({ target: actionTarget({ 'data-action': 'apiconn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(harness.agentPatchBodies[0]?.body.apiConnections, [
    {
      id: 'issue-api',
      displayName: 'Issue API',
      allowedHosts: ['api.example.com'],
      pathPrefixes: [],
      headerName: 'Authorization',
      headerValuePrefix: 'Bearer ',
      allowedMethods: ['GET'],
      enabled: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(harness.agentPatchBodies[0]?.body), /rest-secret-token/);
  assert.deepEqual(harness.apiConnectionSecretPuts, [
    {
      agentId: 'agent_conn',
      id: 'issue-api',
      body: { credential: 'rest-secret-token' },
    },
  ]);
  assert.doesNotMatch(harness.app.innerHTML, /Agent saved, but a credential could not be/);

  // A successful flush clears the pending value, so another profile save does
  // not write the credential again.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.apiConnectionSecretPuts.length, 1);
});

test('a failed API credential PUT stays pending, surfaces an error, and retries on Save', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    apiConnectionSecretPutFailures: 1,
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });
  click({ target: actionTarget({ 'data-action': 'custom-lane', 'data-lane': 'api' }) });
  input({ target: inputTarget({ 'data-action': 'apiconn-field-name' }, 'Issue API') });
  input({ target: inputTarget({ 'data-action': 'apiconn-host-input', 'data-index': '0' }, 'api.example.com') });
  input({ target: inputTarget({ 'data-action': 'apiconn-field-header-name' }, 'Authorization') });
  input({ target: inputTarget({ 'data-action': 'apiconn-field-credential' }, 'retry-rest-secret') });
  click({ target: actionTarget({ 'data-action': 'apiconn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.apiConnectionSecretPuts.length, 1);
  assert.match(
    harness.app.innerHTML,
    /Agent saved, but a credential could not be stored — open the connector and Save again\./,
  );

  // The persisted policy must not make the failed write look stored.
  click({ target: actionTarget({ 'data-action': 'apiconn-edit', 'data-index': '0' }) });
  assert.doesNotMatch(harness.app.innerHTML, /placeholder="•••• stored"[^>]*data-action="apiconn-field-credential"/);
  click({ target: actionTarget({ 'data-action': 'apiconn-cancel' }) });

  // The next Save retries the retained write. This attempt succeeds and clears
  // it, so a third Save is silent and does not issue another PUT.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.apiConnectionSecretPuts.length, 2);
  assert.doesNotMatch(harness.app.innerHTML, /Agent saved, but a credential could not be/);
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.apiConnectionSecretPuts.length, 2);
});

test('editing a saved API connection shows a stored write-only credential placeholder', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        apiConnections: [
          apiConnectionFixture({
            id: 'asana',
            displayName: 'Asana',
            allowedHosts: ['app.asana.com'],
            pathPrefixes: ['/api/1.0'],
            allowedMethods: ['GET', 'POST', 'PUT'],
            presetId: 'asana',
          }),
        ],
      }),
      connectionsAgent({ id: 'agent_other', name: 'Other Profile' }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'apiconn-edit', 'data-index': '0' }) });

  assert.match(harness.app.innerHTML, /class="on" data-action="apiconn-view" data-view="recommended"/);
  assert.match(harness.app.innerHTML, /<span class="conn-url-chip mono"[^>]*>app\.asana\.com<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="apiconn-host-input"/);
  assert.match(
    harness.app.innerHTML,
    /placeholder="•••• stored"[^>]*data-action="apiconn-field-credential"/,
  );
});

test('managed Notion is the only catalog option and explains the provider page boundary', async () => {
  const ready = { status: 'ready', missingConfiguration: [] };
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    connectionAccounts: {
      attached: [],
      managedConnectors: {
        composio: true,
        catalog: [{
          id: 'notion-managed',
          toolkit: 'notion',
          providerId: 'notion',
          label: 'Notion',
          description: 'Notion managed connector',
          securityDescription: 'Choose only the pages and databases Chickpea may use. The Notion grant includes descendants made available by Notion.',
          access: { read: ready, write: ready },
        }],
      },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /data-preset="notion-managed"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-preset="notion"/);
  click({
    target: actionTarget({
      'data-action': 'connection-account-preset', 'data-preset': 'notion-managed',
    }),
  });
  assert.match(harness.app.innerHTML, /Choose only the pages and databases Chickpea may use/);
  assert.match(harness.app.innerHTML, /grant includes descendants made available by Notion/);
  assert.doesNotMatch(harness.app.innerHTML, /Native Notion/);
  click({
    target: actionTarget({
      'data-action': 'connection-account-managed-access', 'data-access': 'write',
    }),
  });
  chooseConnectionOwner(harness);
  click({ target: actionTarget({ 'data-action': 'connection-account-create' }) });
  await flushAsync();

  assert.deepEqual(harness.managedAuthorizationPosts, [{
    agentId: 'agent_conn',
    body: {
      workspaceId: 'T_DESIGN', ownerKind: 'team', toolkit: 'notion', access: 'write',
    },
  }]);
  assert.deepEqual(harness.connectionAccountPosts, []);
});

test('editing a saved API connection with no stored credential does not claim "stored"', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        // A persisted connection whose credential is absent (deleted, or created
        // via the API without one) — the server reports "missing".
        apiConnections: [apiConnectionFixture({ credentialSource: 'missing' })],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'apiconn-edit', 'data-index': '0' }) });

  // The editor prompts to paste a credential rather than showing the stored
  // placeholder, so the missing-credential state is not hidden.
  assert.doesNotMatch(harness.app.innerHTML, /placeholder="•••• stored"/);
  assert.match(harness.app.innerHTML, /placeholder="Paste credential/);
});

test('the API connection editor enforces its required policy fields', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });
  click({ target: actionTarget({ 'data-action': 'custom-lane', 'data-lane': 'api' }) });

  click({ target: actionTarget({ 'data-action': 'apiconn-save-row' }) });
  assert.match(harness.app.innerHTML, /Name is required\./);

  input({ target: inputTarget({ 'data-action': 'apiconn-field-name' }, 'Issue API') });
  click({ target: actionTarget({ 'data-action': 'apiconn-save-row' }) });
  assert.match(harness.app.innerHTML, /Add at least one allowed host\./);

  input({ target: inputTarget({ 'data-action': 'apiconn-host-input', 'data-index': '0' }, 'api.example.com') });
  input({ target: inputTarget({ 'data-action': 'apiconn-field-header-name' }, 'Bad header') });
  click({ target: actionTarget({ 'data-action': 'apiconn-save-row' }) });
  assert.match(harness.app.innerHTML, /Header name may contain only letters, digits, and hyphens\./);

  input({ target: inputTarget({ 'data-action': 'apiconn-field-header-name' }, 'Authorization') });
  change({ target: checkboxTarget({ 'data-action': 'apiconn-method-toggle', 'data-index': '0' }, false) });
  change({ target: checkboxTarget({ 'data-action': 'apiconn-method-toggle', 'data-index': '2' }, false) });
  click({ target: actionTarget({ 'data-action': 'apiconn-save-row' }) });
  assert.match(harness.app.innerHTML, /Select at least one method\./);
});

test('removing an API connection confirms and deletes its credential after the policy save', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent({ apiConnections: [apiConnectionFixture()] })],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'apiconn-remove', 'data-index': '0' }) });

  assert.match(harness.app.innerHTML, /Remove Issue API\?/);
  assert.match(harness.app.innerHTML, /data-action="apiconn-remove-confirm"/);

  click({ target: actionTarget({ 'data-action': 'apiconn-remove-confirm' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.deepEqual(harness.agentPatchBodies[0]?.body.apiConnections, []);
  assert.deepEqual(harness.apiConnectionSecretDeletes, [
    { agentId: 'agent_conn', id: 'issue-api', body: {} },
  ]);
});

test('a failed API credential DELETE stays pending, surfaces an error, and retries on Save', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent({ apiConnections: [apiConnectionFixture()] })],
    apiConnectionSecretDeleteFailures: 1,
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'apiconn-remove', 'data-index': '0' }) });
  click({ target: actionTarget({ 'data-action': 'apiconn-remove-confirm' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.apiConnectionSecretDeletes.length, 1);
  assert.match(harness.app.innerHTML, /Agent saved, but a credential could not be removed — Save again to retry\./);

  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.apiConnectionSecretDeletes.length, 2);
  assert.doesNotMatch(harness.app.innerHTML, /Agent saved, but a credential could not be/);
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.apiConnectionSecretDeletes.length, 2);
});

test('the inline script embeds the connector preset catalog and brand logos', () => {
  const script = inlineScript();

  assert.match(script, /CONNECTOR_PRESETS/);
  assert.match(script, /CONNECTOR_LOGOS/);
  assert.match(script, /mcp\.linear\.app/);
  assert.match(script, /mcp\.notion\.com/);
  assert.match(script, /M2\.886 4\.18/);
});

test('the searchable Connections gallery is immediate, renders brand logos, and opens the Recommended editor', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });

  const gallery = harness.app.innerHTML;
  assert.match(gallery, /data-action="conn-gallery-search"/);
  assert.equal(
    (gallery.match(/data-action="conn-preset" data-preset="[^"]+">Connect<\/button>/g) ?? []).length,
    25,
  );
  assert.match(gallery, /<span>Available<\/span><span class="gallery-head-count">25<\/span>/);
  assert.doesNotMatch(gallery, /data-preset="google-workspace"/);
  assert.doesNotMatch(gallery, /data-preset="github"/);
  assert.doesNotMatch(gallery, /data-preset="context7"/);
  assert.doesNotMatch(gallery, /data-preset="deepwiki"/);
  assert.doesNotMatch(gallery, /data-action="conn-new"/);
  assert.doesNotMatch(gallery, /data-action="conn-gallery-cancel"/);

  const ahrefsIndex = gallery.indexOf('data-preset="ahrefs"');
  const airtableIndex = gallery.indexOf('data-preset="airtable"');
  const cloudflareApiIndex = gallery.indexOf('data-preset="cloudflare-api"');
  const stripeIndex = gallery.indexOf('data-preset="stripe"');
  assert.ok(
    ahrefsIndex >= 0 &&
      ahrefsIndex < airtableIndex &&
      airtableIndex < cloudflareApiIndex &&
      cloudflareApiIndex < stripeIndex,
  );

  const ahrefsRow = gallery.match(
    /<div class="gallery-row gallery-row-described"><span class="conn-logo conn-logo-img conn-logo-full"><svg(?:(?!<\/div>)[\s\S])*?data-preset="ahrefs">Connect<\/button><\/div>/,
  )?.[0];
  assert.ok(ahrefsRow);
  assert.match(ahrefsRow, /conn-logo-full"><svg/);
  assert.match(ahrefsRow, /Research keywords, backlinks, competitors, and search performance\./);

  const incidentIoRow = gallery.match(
    /<div class="gallery-row gallery-row-described"><span class="conn-logo conn-logo-raster"><img src="data:image\/png;base64,[^"]+" alt=""><\/span>(?:(?!<\/div>)[\s\S])*?data-preset="incident-io">Connect<\/button><\/div>/,
  )?.[0];
  assert.ok(incidentIoRow);
  assert.match(incidentIoRow, /conn-logo-raster"><img src="data:image\/png;base64,/);

  const linearRow = gallery.match(
    /<div class="gallery-row gallery-row-described"><span class="conn-logo conn-logo-img"><svg[\s\S]*?data-preset="linear">Connect<\/button><\/div>/,
  )?.[0];
  assert.ok(linearRow);
  assert.match(
    linearRow,
    /<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="color:#5E6AD2"><path/,
  );
  assert.match(linearRow, /<span class="gallery-row-name">Linear<\/span>/);
  assert.match(linearRow, /Find, create, and update issues, projects, and workspace plans\./);
  assert.match(linearRow, /<span class="gallery-lane">MCP<\/span>/);

  const airtableRow = gallery.match(
    /<div class="gallery-row gallery-row-described"><span class="conn-logo conn-logo-img conn-logo-full"><svg(?:(?!<\/div>)[\s\S])*?data-preset="airtable">Connect<\/button><\/div>/,
  )?.[0];
  assert.ok(airtableRow);
  assert.match(airtableRow, /fill="#FCB400"/);
  assert.match(airtableRow, /fill="#18BFFF"/);
  assert.match(airtableRow, /fill="#F82B60"/);
  assert.doesNotMatch(airtableRow, /currentColor/);

  const atlassianRow = gallery.match(
    /<div class="gallery-row gallery-row-described"><span class="conn-logo conn-logo-img"><svg[\s\S]*?data-preset="atlassian">Connect<\/button><\/div>/,
  )?.[0];
  assert.ok(atlassianRow);
  assert.match(atlassianRow, /style="color:#0052CC"><path/);
  assert.match(atlassianRow, /<span class="gallery-row-name">Atlassian<\/span>/);

  assert.doesNotMatch(gallery, /data-preset="notion"/);

  const gmailRow = gallery.match(
    /<div class="gallery-row gallery-row-described">(?:(?!<\/div>)[\s\S])*?data-preset="gmail">Connect<\/button><\/div>/,
  )?.[0];
  assert.ok(gmailRow);
  assert.match(gmailRow, /<span class="gallery-row-name">Gmail<\/span>/);
  assert.match(gmailRow, /Search mail, summarize threads, and draft or organize messages\./);
  assert.match(gmailRow, /fill="#fc413d"/);

  const calendarRow = gallery.match(
    /<div class="gallery-row gallery-row-described">(?:(?!<\/div>)[\s\S])*?data-preset="google-calendar">Connect<\/button><\/div>/,
  )?.[0];
  assert.ok(calendarRow);
  assert.match(calendarRow, /<span class="gallery-row-name">Google Calendar<\/span>/);
  assert.match(calendarRow, /Review availability and create or update events\./);
  assert.match(calendarRow, /fill="#3c90ff"/);

  const driveRow = gallery.match(
    /<div class="gallery-row gallery-row-described">(?:(?!<\/div>)[\s\S])*?data-preset="google-drive">Connect<\/button><\/div>/,
  )?.[0];
  assert.ok(driveRow);
  assert.match(driveRow, /<span class="gallery-row-name">Google Drive<\/span>/);
  assert.match(driveRow, /Find, read, create, and organize files\./);
  assert.match(driveRow, /fill="url\(#google-drive-yellow\)"/);

  const granolaRow = gallery.match(
    /<div class="gallery-row gallery-row-described"><span class="conn-logo conn-logo-raster"><img src="data:image\/png;base64,[^"]+" alt=""><\/span>(?:(?!<\/div>)[\s\S])*?data-preset="granola">Connect<\/button><\/div>/,
  )?.[0];
  assert.ok(granolaRow);
  assert.match(granolaRow, /<span class="gallery-row-name">Granola<\/span>/);
  assert.match(
    granolaRow,
    /Search meeting notes and transcripts, browse folders, and extract decisions and action items\./,
  );
  assert.match(granolaRow, /<span class="gallery-lane">MCP<\/span>/);

  for (const id of ['asana', 'zendesk']) {
    const apiRow = gallery.match(
      new RegExp('<div class="gallery-row gallery-row-described">(?:(?!<\\/div>)[\\s\\S])*?data-preset="' + id + '">Connect<\\/button><\\/div>'),
    )?.[0];
    assert.ok(apiRow, `${id} row should render`);
    assert.match(apiRow, /<span class="conn-logo conn-logo-img"><svg/);
    assert.doesNotMatch(apiRow, /conn-logo-mono/);
    assert.match(apiRow, /<span class="gallery-lane">API<\/span>/);
  }

  const mondayRow = gallery.match(
    /<div class="gallery-row gallery-row-described"><span class="conn-logo conn-logo-img conn-logo-full"><svg[\s\S]*?data-preset="monday">Connect<\/button><\/div>/,
  )?.[0];
  assert.ok(mondayRow);
  assert.match(mondayRow, /<svg viewBox="0 0 64 64"/);
  assert.match(mondayRow, /fill="#ff3d57"/);

  const exaRow = gallery.match(
    /<div class="gallery-row gallery-row-described"><span class="conn-logo conn-logo-raster"><img src="data:image\/png;base64,[^"]+" alt=""><\/span>[\s\S]*?data-preset="exa">Connect<\/button><\/div>/,
  )?.[0];
  assert.ok(exaRow);
  assert.match(exaRow, /<img src="data:image\/png;base64,[^"]+" alt="">/);
  assert.doesNotMatch(exaRow, /conn-logo-mono/);
  assert.match(
    gallery,
    /<span class="gallery-row-name">Custom connection<\/span>[\s\S]*?data-action="conn-custom">Connect<\/button>/,
  );

  input({
    target: Object.assign(inputTarget({ 'data-action': 'conn-gallery-search' }, 'asana'), {
      selectionStart: 5,
    }),
  });
  const filteredGallery = harness.app.innerHTML;
  assert.equal((filteredGallery.match(/data-action="conn-preset"/g) ?? []).length, 1);
  assert.match(filteredGallery, /data-preset="asana">Connect<\/button>/);
  assert.match(filteredGallery, /<span class="gallery-row-name">Asana<\/span>/);
  assert.match(filteredGallery, /<span class="gallery-lane">API<\/span>/);
  assert.doesNotMatch(filteredGallery, /data-preset="linear"/);
  assert.match(filteredGallery, /<span>Available<\/span><span class="gallery-head-count">1<\/span>/);
  assert.equal(harness.gallerySearchFocusCalls(), 1);
  assert.deepEqual(harness.gallerySearchSelections, [[5, 5]]);

  input({ target: inputTarget({ 'data-action': 'conn-gallery-search' }, '') });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'linear' }) });
  const recommended = harness.app.innerHTML;
  assert.match(recommended, /<div class="conn-recommended-head"><span class="conn-logo conn-logo-img"><svg/);
  assert.match(recommended, /data-action="conn-view" data-view="recommended"/);
  assert.match(recommended, /data-action="conn-view" data-view="advanced"/);
  assert.match(recommended, /<span class="conn-url-chip mono">mcp\.linear\.app<\/span>/);
  assert.match(recommended, /Sign in to Linear and choose the workspace Chickpea should access\.<\/p>/);
  assert.match(recommended, /data-action="conn-oauth-start"[^>]*>[\s\S]*?<span>Sign into Linear<\/span>/);
  assert.doesNotMatch(recommended, /data-action="conn-field-bearer"/);
  assert.doesNotMatch(recommended, /data-action="conn-field-url"/);
  assert.doesNotMatch(recommended, /Where do I find this\?/);
  assert.doesNotMatch(recommended, /href="https:\/\/linear\.app\/docs\/mcp"/);

  click({ target: actionTarget({ 'data-action': 'conn-view', 'data-view': 'advanced' }) });
  assert.match(
    harness.app.innerHTML,
    /id="conn-url"[^>]*value="https:\/\/mcp\.linear\.app\/mcp"[^>]*data-action="conn-field-url"/,
  );
  assert.match(harness.app.innerHTML, /id="conn-name"[^>]*data-action="conn-field-name"/);
});

test('saved GitHub connections keep their controls and link to the Repositories tab', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        apiConnections: [
          apiConnectionFixture({
            id: 'github',
            displayName: 'GitHub',
            allowedHosts: ['api.github.com'],
            pathPrefixes: [],
            presetId: 'github',
          }),
        ],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });

  assert.match(
    harness.app.innerHTML,
    /GitHub now lives in the <button[^>]*data-action="profile-tab" data-tab="repositories">Repositories tab<\/button>/,
  );
  assert.match(harness.app.innerHTML, /data-action="apiconn-toggle" data-index="0"/);
  assert.match(harness.app.innerHTML, /data-action="apiconn-edit" data-index="0"/);
  assert.match(harness.app.innerHTML, /data-action="apiconn-remove" data-index="0"/);

  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'repositories' }) });
  assert.match(harness.app.innerHTML, /id="ptab-repositories" class="ptab on"/);
  assert.doesNotMatch(harness.app.innerHTML, /id="ptab-panel-repositories"[^>]* hidden/);
});

test('the Asana gallery preset opens a compact Recommended API editor', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'asana' }) });

  const recommended = harness.app.innerHTML;
  assert.doesNotMatch(recommended, /data-action="conn-field-url"/);
  assert.match(recommended, /data-action="apiconn-view" data-view="recommended"/);
  assert.match(recommended, /data-action="apiconn-view" data-view="advanced"/);
  assert.match(recommended, /<div class="conn-recommended-head"><span class="conn-logo conn-logo-img"><svg/);
  assert.match(recommended, /<span class="field-label">Asana<\/span>/);
  assert.match(recommended, /<span class="conn-url-chip mono"[^>]*>app\.asana\.com<\/span>/);
  assert.equal((recommended.match(/data-action="apiconn-field-credential"/g) ?? []).length, 1);
  assert.match(recommended, /<label class="field-label">API key<\/label>/);
  assert.match(recommended, /placeholder="Asana personal access token"[^>]*data-action="apiconn-field-credential"/);
  assert.match(recommended, /Asana → Settings → Apps → Developer apps → Personal access tokens/);
  assert.match(recommended, /href="https:\/\/app\.asana\.com\/0\/my-apps"[^>]*>Where do I find this\?<\/a>/);
  assert.doesNotMatch(recommended, /data-action="apiconn-field-name"/);
  assert.doesNotMatch(recommended, /data-action="apiconn-host-input"/);
  assert.doesNotMatch(recommended, /data-action="apiconn-path-input"/);
  assert.doesNotMatch(recommended, /data-action="apiconn-field-header-name"/);
  assert.doesNotMatch(recommended, /data-action="apiconn-method-toggle"/);
});

test('the Gmail catalog entry saves one shared Google connection and its BYO OAuth client separately', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    deferAgentPatch: true,
    apiOAuthStartResult: {
      authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=opaque-state',
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'gmail' }) });

  assert.match(harness.app.innerHTML, /Use a dedicated Google account for Chickpea when possible/);
  assert.match(harness.app.innerHTML, /Authorized redirect URI/);
  assert.match(harness.app.innerHTML, /http:\/\/localhost\/oauth\/api\/callback/);
  assert.match(harness.app.innerHTML, />Workspace internal<\/button>/);
  assert.doesNotMatch(harness.app.innerHTML, /Where do I find this\?/);

  input({ target: inputTarget({ 'data-action': 'apiconn-google-client-id' }, 'google-client-id') });
  input({ target: inputTarget({ 'data-action': 'apiconn-google-client-secret' }, 'google-client-secret') });
  click({ target: actionTarget({ 'data-action': 'apiconn-google-access', 'data-service': 'drive', 'data-access': 'read' }) });
  click({ target: actionTarget({ 'data-action': 'apiconn-google-access', 'data-service': 'gmail', 'data-access': 'write' }) });
  click({ target: actionTarget({ 'data-action': 'apiconn-oauth-start' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(harness.apiOAuthClientPuts, []);
  assert.deepEqual(harness.apiOAuthStartPosts, []);
  harness.resolveAgentPatch();
  await flushAsync();

  const connections = harness.agentPatchBodies[0]?.body.apiConnections as Array<Record<string, unknown>>;
  assert.deepEqual(connections, [
    {
      id: 'google-workspace',
      displayName: 'Google Workspace',
      allowedHosts: ['gmail.googleapis.com', 'www.googleapis.com'],
      pathPrefixes: ['/gmail/v1/users/me', '/drive/v3'],
      headerName: 'Authorization',
      allowedMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      enabled: true,
      headerValuePrefix: 'Bearer ',
      presetId: 'google-workspace',
      authMode: 'oauth',
      oauthProvider: 'google',
      oauthScopes: [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/drive.readonly',
      ],
      oauthAppType: 'workspace-internal',
      lifecycleStatus: 'pending',
      statusText: 'Not connected',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(harness.agentPatchBodies[0]?.body), /google-client-(id|secret)/);
  assert.deepEqual(harness.apiOAuthClientPuts, [
    {
      agentId: 'agent_conn',
      connectionId: 'google-workspace',
      body: { provider: 'google', clientId: 'google-client-id', clientSecret: 'google-client-secret' },
    },
  ]);
  assert.deepEqual(harness.apiOAuthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'google-workspace', body: {} },
  ]);
  assert.deepEqual(harness.assignedUrls, [
    'https://accounts.google.com/o/oauth2/v2/auth?state=opaque-state',
  ]);
});

test('enabling Drive reuses the connected Gmail OAuth client and preserves Gmail access', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        apiConnections: [
          apiConnectionFixture({
            id: 'google-workspace',
            displayName: 'Google Workspace',
            presetId: 'google-workspace',
            authMode: 'oauth',
            oauthProvider: 'google',
            oauthScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            oauthAppType: 'external',
            allowedHosts: ['gmail.googleapis.com'],
            pathPrefixes: ['/gmail/v1/users/me'],
            allowedMethods: ['GET', 'HEAD'],
            lifecycleStatus: 'ready',
            statusText: 'Connected',
            identity: { accountName: 'person@gmail.com' },
            oauthClientSource: 'stored',
            oauthTokenSource: 'stored',
            credentialSource: 'missing',
          }),
        ],
      }),
    ],
    deferAgentPatch: true,
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });

  const gallery = harness.app.innerHTML;
  assert.doesNotMatch(gallery, /data-preset="gmail"/);
  assert.match(gallery, /data-preset="google-calendar">Enable<\/button>/);
  assert.match(gallery, /data-preset="google-drive">Enable<\/button>/);
  assert.match(gallery, /google-service-summary[\s\S]*Gmail[\s\S]*Read-only/);

  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'google-drive' }) });
  assert.match(harness.app.innerHTML, /aria-label="Gmail access"[\s\S]*class="on" data-action="apiconn-google-access" data-service="gmail" data-access="read"/);
  assert.match(harness.app.innerHTML, /aria-label="Drive access"[\s\S]*class="on" data-action="apiconn-google-access" data-service="drive" data-access="read"/);
  click({ target: actionTarget({ 'data-action': 'apiconn-oauth-start' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  const connections = harness.agentPatchBodies[0]?.body.apiConnections as Array<Record<string, unknown>>;
  assert.equal(connections[0]?.id, 'google-workspace');
  assert.deepEqual(connections[0]?.oauthScopes, [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/drive.readonly',
  ]);
  assert.deepEqual(harness.apiOAuthClientPuts, []);

  harness.resolveAgentPatch();
  await flushAsync();
  assert.deepEqual(harness.apiOAuthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'google-workspace', body: {} },
  ]);
});

test('a Google OAuth callback return opens a connected account state without MCP tool copy', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_conn',
    initialSearch: '?oauth=connected&connection=google-workspace&lane=api',
    agents: [
      connectionsAgent({
        apiConnections: [
          apiConnectionFixture({
            id: 'google-workspace',
            displayName: 'Google Workspace',
            presetId: 'google-workspace',
            authMode: 'oauth',
            oauthProvider: 'google',
            oauthScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
            oauthAppType: 'workspace-internal',
            allowedHosts: ['gmail.googleapis.com'],
            pathPrefixes: ['/gmail/v1/users/me'],
            allowedMethods: ['GET', 'HEAD'],
            lifecycleStatus: 'ready',
            statusText: 'Connected',
            identity: { accountName: 'operator@example.com' },
            oauthClientSource: 'stored',
            oauthTokenSource: 'stored',
            credentialSource: 'missing',
          }),
        ],
      }),
    ],
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Connected to operator@example\.com\. The selected Google services are ready to use\./);
  assert.match(harness.app.innerHTML, /<span class="oauth-account-name">operator@example\.com<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /tools enabled/);
  assert.equal(harness.historyReplaces.at(-1), '/admin/agents/agent_conn');

  const click = harness.listeners.click;
  assert.ok(click);
  click({
    target: actionTarget({
      'data-action': 'apiconn-google-access',
      'data-service': 'drive',
      'data-access': 'read',
    }),
  });
  assert.match(harness.app.innerHTML, /<span>Sign into Google<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /<span class="oauth-account-status">Connected<\/span>/);
});

test('the Asana API editor keeps its credential and seeded policy in Advanced before saving', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'asana' }) });

  input({ target: inputTarget({ 'data-action': 'apiconn-field-credential' }, 'asana-secret') });
  click({ target: actionTarget({ 'data-action': 'apiconn-view', 'data-view': 'advanced' }) });
  const advanced = harness.app.innerHTML;
  assert.match(advanced, /value="Asana"[^>]*data-action="apiconn-field-name"/);
  assert.match(advanced, /value="app\.asana\.com"[^>]*data-action="apiconn-host-input"/);
  assert.match(advanced, /value="\/api\/1\.0"[^>]*data-action="apiconn-path-input"/);
  assert.match(advanced, /value="Authorization"[^>]*data-action="apiconn-field-header-name"/);
  assert.match(advanced, /value="Bearer "[^>]*data-action="apiconn-field-header-prefix"/);
  assert.match(advanced, /data-index="0" checked aria-label="Allow GET"/);
  assert.match(advanced, /data-index="1"  aria-label="Allow HEAD"/);
  assert.match(advanced, /data-index="2" checked aria-label="Allow POST"/);
  assert.match(advanced, /data-index="3" checked aria-label="Allow PUT"/);
  assert.match(advanced, /data-index="4"  aria-label="Allow PATCH"/);
  assert.match(advanced, /data-index="5"  aria-label="Allow DELETE"/);
  assert.match(advanced, /value="asana-secret"[^>]*data-action="apiconn-field-credential"/);

  click({ target: actionTarget({ 'data-action': 'apiconn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  const apiConnections = harness.agentPatchBodies[0]?.body.apiConnections as Parameters<
    typeof connectorSkillsForConnections
  >[0];
  assert.deepEqual(apiConnections, [
    {
      id: 'asana',
      displayName: 'Asana',
      allowedHosts: ['app.asana.com'],
      pathPrefixes: ['/api/1.0'],
      headerName: 'Authorization',
      headerValuePrefix: 'Bearer ',
      allowedMethods: ['GET', 'POST', 'PUT'],
      enabled: true,
      presetId: 'asana',
    },
  ]);
  assert.deepEqual(
    connectorSkillsForConnections(apiConnections).map((skill) => skill.name),
    ['asana-api'],
  );
});

test('the Zendesk Recommended editor keeps the template guard when its subdomain is blank', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'zendesk' }) });

  const recommended = harness.app.innerHTML;
  assert.match(recommended, /<span class="conn-url-chip mono"[^>]*>your-subdomain\.zendesk\.com<\/span>/);
  assert.match(recommended, /<label class="field-label" for="apiconn-subdomain">Zendesk subdomain<\/label>/);
  assert.match(
    recommended,
    /id="apiconn-subdomain"[^>]*value=""[^>]*placeholder="your-subdomain"[^>]*data-action="apiconn-field-subdomain"/,
  );
  assert.doesNotMatch(recommended, /data-action="apiconn-host-input"/);
  assert.match(recommended, /placeholder="base64 of email\/token:api_token"/);

  click({ target: actionTarget({ 'data-action': 'apiconn-save-row' }) });
  assert.match(
    harness.app.innerHTML,
    /<p class="field-error">Replace &quot;your-subdomain&quot; with your Zendesk subdomain before saving\.<\/p>/,
  );
});

test('the Zendesk Recommended subdomain resolves into the Advanced host and back to the host chip', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'zendesk' }) });

  input({
    target: inputTarget({ 'data-action': 'apiconn-field-subdomain' }, 'acme'),
  });
  click({ target: actionTarget({ 'data-action': 'apiconn-view', 'data-view': 'advanced' }) });
  const advanced = harness.app.innerHTML;
  assert.match(advanced, /value="acme\.zendesk\.com"[^>]*data-action="apiconn-host-input"/);
  assert.match(advanced, /value="Basic "[^>]*data-action="apiconn-field-header-prefix"/);

  click({ target: actionTarget({ 'data-action': 'apiconn-view', 'data-view': 'recommended' }) });
  assert.match(harness.app.innerHTML, /<span class="conn-url-chip mono"[^>]*>acme\.zendesk\.com<\/span>/);
});

test('the Sentry preset uses OAuth and saves its narrowed resource before authorization', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'sentry' }) });
  const recommended = harness.app.innerHTML;
  assert.match(recommended, /data-action="conn-sentry-organization"/);
  assert.match(recommended, /data-action="conn-sentry-project"/);
  assert.match(recommended, /Sign into Sentry/);
  assert.doesNotMatch(recommended, /data-action="conn-header-value"|User Auth Token/);
  input({
    target: inputTarget({ 'data-action': 'conn-sentry-organization' }, 'acme'),
  });
  input({ target: inputTarget({ 'data-action': 'conn-sentry-project' }, 'web-app') });
  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();

  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.equal(servers[0]?.url, 'https://mcp.sentry.dev/mcp/acme/web-app');
  assert.equal(servers[0]?.authMode, 'oauth');
  assert.deepEqual(servers[0]?.headerNames, []);
  assert.deepEqual(harness.oauthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'sentry', body: {} },
  ]);
  assert.deepEqual(harness.mcpSecretPuts, []);
});

test('a preset connection carries presetId in the profile save body', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'stripe' }) });
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.equal(servers[0]?.presetId, 'stripe');
});

test('the Linear preset saves read-write OAuth policy and requests read and write scopes', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    deferAgentPatch: true,
    oauthStartResult: {
      authorizationUrl: 'https://linear.example/authorize?state=opaque-state',
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'linear' }) });
  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(harness.oauthStartPosts, []);
  assert.deepEqual(harness.assignedUrls, []);

  harness.resolveAgentPatch();
  await flushAsync();

  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.deepEqual(servers, [
    {
      id: 'linear',
      displayName: 'Linear',
      url: 'https://mcp.linear.app/mcp',
      transport: 'streamable-http',
      authMode: 'oauth',
      headerNames: [],
      enabled: true,
      lifecycleStatus: 'pending',
      statusText: '',
      discoveredTools: [],
      allowedTools: [],
      oauthScope: 'read write',
      presetId: 'linear',
    },
  ]);
  assert.deepEqual(harness.oauthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'linear', body: { scope: 'read write' } },
  ]);
  assert.deepEqual(harness.assignedUrls, [
    'https://linear.example/authorize?state=opaque-state',
  ]);
});

test('the Granola preset saves OAuth policy before requesting its MCP resource scope', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    deferAgentPatch: true,
    oauthStartResult: {
      authorizationUrl: 'https://mcp-auth.granola.ai/oauth2/authorize?state=opaque-state',
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'granola' }) });

  assert.match(harness.app.innerHTML, /Sign into Granola/);
  assert.match(
    harness.app.innerHTML,
    /Anyone who can use this Agent may query meetings available to the connected account/,
  );
  assert.doesNotMatch(harness.app.innerHTML, /Where do I find this\?/);

  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(harness.oauthStartPosts, []);
  harness.resolveAgentPatch();
  await flushAsync();

  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.deepEqual(servers, [
    {
      id: 'granola',
      displayName: 'Granola',
      url: 'https://mcp.granola.ai/mcp',
      transport: 'streamable-http',
      authMode: 'oauth',
      headerNames: [],
      enabled: true,
      lifecycleStatus: 'pending',
      statusText: '',
      discoveredTools: [],
      allowedTools: [],
      oauthScope: 'mcp',
      presetId: 'granola',
    },
  ]);
  assert.deepEqual(harness.oauthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'granola', body: { scope: 'mcp' } },
  ]);
  assert.deepEqual(harness.assignedUrls, [
    'https://mcp-auth.granola.ai/oauth2/authorize?state=opaque-state',
  ]);
});

test('the Airtable preset saves OAuth policy before requesting its documented scopes', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    deferAgentPatch: true,
    oauthStartResult: {
      authorizationUrl: 'https://airtable.example/authorize?state=opaque-state',
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'airtable' }) });

  const editor = harness.app.innerHTML;
  assert.match(
    editor,
    /Sign in to Airtable and choose the workspaces and bases Chickpea should access\.<\/p>/,
  );
  assert.match(
    editor,
    /data-action="conn-oauth-start"[^>]*><span class="conn-logo conn-logo-img conn-logo-full"><svg[\s\S]*?<span>Sign into Airtable<\/span>/,
  );
  assert.doesNotMatch(editor, /data-action="conn-field-bearer"/);
  assert.doesNotMatch(editor, /Where do I find this\?/);
  assert.doesNotMatch(editor, /href="https:\/\/support\.airtable\.com\/using-the-airtable-mcp-server"/);

  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(harness.oauthStartPosts, []);
  assert.deepEqual(harness.assignedUrls, []);

  harness.resolveAgentPatch();
  await flushAsync();

  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.deepEqual(servers, [
    {
      id: 'airtable',
      displayName: 'Airtable',
      url: 'https://mcp.airtable.com/mcp',
      transport: 'streamable-http',
      authMode: 'oauth',
      headerNames: [],
      enabled: true,
      lifecycleStatus: 'pending',
      statusText: '',
      discoveredTools: [],
      allowedTools: [],
      oauthScope:
        'data.records:read data.records:write schema.bases:read schema.bases:write data.recordComments:read data.recordComments:write workspacesAndBases:read',
      presetId: 'airtable',
    },
  ]);
  assert.deepEqual(harness.oauthStartPosts, [
    {
      agentId: 'agent_conn',
      connectionId: 'airtable',
      body: {
        scope:
          'data.records:read data.records:write schema.bases:read schema.bases:write data.recordComments:read data.recordComments:write workspacesAndBases:read',
      },
    },
  ]);
  assert.deepEqual(harness.assignedUrls, [
    'https://airtable.example/authorize?state=opaque-state',
  ]);
});

test('the PostHog preset saves OAuth policy before starting provider-managed authorization', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    deferAgentPatch: true,
    oauthStartResult: {
      authorizationUrl: 'https://oauth.posthog.com/oauth/authorize/?state=opaque-state',
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'posthog' }) });

  const editor = harness.app.innerHTML;
  assert.match(
    editor,
    /Sign in to PostHog and choose the organization and project Chickpea should access\.<\/p>/,
  );
  assert.match(editor, /data-action="conn-oauth-start"[^>]*>[\s\S]*?<span>Sign into PostHog<\/span>/);
  assert.doesNotMatch(editor, /data-action="conn-field-bearer"/);
  assert.doesNotMatch(editor, /Where do I find this\?/);

  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(harness.oauthStartPosts, []);
  assert.deepEqual(harness.assignedUrls, []);

  harness.resolveAgentPatch();
  await flushAsync();

  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.deepEqual(servers, [
    {
      id: 'posthog',
      displayName: 'PostHog',
      url: 'https://mcp.posthog.com/mcp',
      transport: 'streamable-http',
      authMode: 'oauth',
      headerNames: [],
      enabled: true,
      lifecycleStatus: 'pending',
      statusText: '',
      discoveredTools: [],
      allowedTools: [],
      presetId: 'posthog',
    },
  ]);
  assert.deepEqual(harness.oauthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'posthog', body: {} },
  ]);
  assert.deepEqual(harness.assignedUrls, [
    'https://oauth.posthog.com/oauth/authorize/?state=opaque-state',
  ]);
});

test('the Supabase preset saves OAuth policy before requesting every required scope', async () => {
  const scope =
    'organizations:read projects:read projects:write database:write database:read analytics:read secrets:read edge_functions:read edge_functions:write environment:read environment:write storage:read';
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    deferAgentPatch: true,
    oauthStartResult: {
      authorizationUrl: 'https://api.supabase.com/v1/oauth/authorize?state=opaque-state',
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'supabase' }) });

  const editor = harness.app.innerHTML;
  assert.match(
    editor,
    /Sign in to Supabase and choose the organization and projects Chickpea should access\.<\/p>/,
  );
  assert.match(editor, /data-action="conn-oauth-start"[^>]*>[\s\S]*?<span>Sign into Supabase<\/span>/);
  assert.match(editor, /Use a development or test project; do not connect production data\./);
  assert.match(editor, /Project reference/);
  assert.match(editor, /data-action="conn-supabase-project-ref"/);
  assert.match(editor, /class="on" data-action="conn-supabase-access" data-access="read-only"/);
  assert.match(editor, /data-action="conn-supabase-access" data-access="read-write"/);
  assert.match(editor, /Sign into Supabase[^>]* disabled|data-action="conn-oauth-start" disabled/);
  assert.doesNotMatch(editor, /data-action="conn-field-bearer"/);
  assert.doesNotMatch(editor, /Where do I find this\?/);

  input({ target: inputTarget({ 'data-action': 'conn-supabase-project-ref' }, 'abcdefghijklmnopqrst') });
  click({ target: actionTarget({ 'data-action': 'conn-supabase-access', 'data-access': 'read-write' }) });
  assert.match(harness.app.innerHTML, /class="on" data-action="conn-supabase-access" data-access="read-write"/);
  click({ target: actionTarget({ 'data-action': 'conn-supabase-access', 'data-access': 'read-only' }) });
  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();
  assert.deepEqual(harness.oauthStartPosts, []);

  harness.resolveAgentPatch();
  await flushAsync();

  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.deepEqual(servers, [
    {
      id: 'supabase',
      displayName: 'Supabase',
      url: 'https://mcp.supabase.com/mcp?project_ref=abcdefghijklmnopqrst&read_only=true',
      transport: 'streamable-http',
      authMode: 'oauth',
      headerNames: [],
      enabled: true,
      lifecycleStatus: 'pending',
      statusText: '',
      discoveredTools: [],
      allowedTools: [],
      oauthScope: scope,
      presetId: 'supabase',
    },
  ]);
  assert.deepEqual(harness.oauthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'supabase', body: { scope } },
  ]);
  assert.deepEqual(harness.assignedUrls, [
    'https://api.supabase.com/v1/oauth/authorize?state=opaque-state',
  ]);
});

test('the Atlassian preset saves OAuth policy before requesting its advertised read-write scopes', async () => {
  const scope =
    'read:me read:account offline_access email read:jira-work write:jira-work search:confluence read:confluence-user read:page:confluence write:page:confluence read:comment:confluence write:comment:confluence read:space:confluence read:hierarchical-content:confluence write:component:compass read:component:compass read:scorecard:compass write:scorecard:compass read:event:compass read:metric:compass read:all:twg write:all:twg';
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    deferAgentPatch: true,
    oauthStartResult: {
      authorizationUrl: 'https://auth.atlassian.com/authorize?state=opaque-state',
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'atlassian' }) });

  const editor = harness.app.innerHTML;
  assert.match(
    editor,
    /Sign in to Atlassian and choose the sites and products Chickpea should access\.<\/p>/,
  );
  assert.match(editor, /data-action="conn-oauth-start"[^>]*>[\s\S]*?<span>Sign into Atlassian<\/span>/);
  assert.doesNotMatch(editor, /data-action="conn-field-bearer"/);
  assert.doesNotMatch(editor, /Where do I find this\?/);

  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();
  assert.deepEqual(harness.oauthStartPosts, []);

  harness.resolveAgentPatch();
  await flushAsync();

  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.deepEqual(servers, [
    {
      id: 'atlassian',
      displayName: 'Atlassian',
      url: 'https://mcp.atlassian.com/v1/mcp/authv2',
      transport: 'streamable-http',
      authMode: 'oauth',
      headerNames: [],
      enabled: true,
      lifecycleStatus: 'pending',
      statusText: '',
      discoveredTools: [],
      allowedTools: [],
      oauthScope: scope,
      presetId: 'atlassian',
    },
  ]);
  assert.deepEqual(harness.oauthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'atlassian', body: { scope } },
  ]);
  assert.deepEqual(harness.assignedUrls, [
    'https://auth.atlassian.com/authorize?state=opaque-state',
  ]);
});

test('the Cloudflare API preset replaces the narrow catalog rows with the full OAuth server', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  assert.match(harness.app.innerHTML, /data-preset="cloudflare-api"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-preset="cloudflare-(docs|bindings|observability)"/);
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'cloudflare-api' }) });

  assert.match(harness.app.innerHTML, /Sign into Cloudflare/);
  assert.match(harness.app.innerHTML, /entire API through three token-efficient tools: docs, search, and execute/);
});

test('the Notion preset saves OAuth policy before starting authorization and never puts credentials in client state', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    oauthStartResult: {
      authorizationUrl: 'https://auth.notion.example/authorize?state=opaque-state',
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'notion' }) });

  assert.match(harness.app.innerHTML, /mcp\.notion\.com/);
  assert.match(harness.app.innerHTML, /Sign in to Notion and choose the workspace access Chickpea should receive\.<\/p>/);
  assert.match(
    harness.app.innerHTML,
    /<button[^>]*class="btn btn-primary btn-sm oauth-signin"[^>]*data-action="conn-oauth-start"[^>]*><span class="conn-logo conn-logo-img conn-logo-full"><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><\/span><span>Sign into Native Notion<\/span><\/button>/,
  );
  assert.doesNotMatch(harness.app.innerHTML, /When you continue|Save and connect Notion/);
  assert.doesNotMatch(harness.app.innerHTML, />Add connection<\/button>/);
  assert.equal((harness.app.innerHTML.match(/Sign in to Notion and choose the workspace access Chickpea should receive\./g) ?? []).length, 1);
  assert.doesNotMatch(harness.app.innerHTML, /Where do I find this\?/);
  assert.doesNotMatch(harness.app.innerHTML, /href="https:\/\/developers\.notion\.com\/guides\/mcp\/build-mcp-client"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-field-bearer"/);
  assert.match(harness.app.innerHTML, /data-action="conn-test" disabled/);

  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  const serializedPatch = JSON.stringify(harness.agentPatchBodies[0]?.body);
  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.deepEqual(servers, [
    {
      id: 'notion',
      displayName: 'Native Notion',
      url: 'https://mcp.notion.com/mcp',
      transport: 'streamable-http',
      authMode: 'oauth',
      headerNames: [],
      enabled: true,
      lifecycleStatus: 'pending',
      statusText: '',
      discoveredTools: [],
      allowedTools: [],
      presetId: 'notion',
    },
  ]);
  assert.doesNotMatch(serializedPatch, /opaque-state|access_token|refresh_token|client_secret/);
  assert.deepEqual(harness.oauthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'notion', body: {} },
  ]);
  assert.deepEqual(harness.assignedUrls, [
    'https://auth.notion.example/authorize?state=opaque-state',
  ]);
});

test('a Notion OAuth start failure keeps the saved connection recoverable in place', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    oauthStartError: { status: 502, error: 'oauth_unavailable' },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'notion' }) });
  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.equal(harness.oauthStartPosts.length, 1);
  assert.deepEqual(harness.assignedUrls, []);
  assert.match(harness.app.innerHTML, /Sign into Native Notion/);
  assert.match(
    harness.app.innerHTML,
    /Native Notion OAuth could not be prepared\. Check that this install has a reachable callback URL, then try again\./,
  );
});

test('a blocked profile save re-enables OAuth start after returning to Connections', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click);
  assert.ok(input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });
  click({ target: actionTarget({ 'data-action': 'skill-new' }) });
  input({ target: inputTarget({ 'data-action': 'skill-field-name' }, 'Bad Name!') });
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'x') });
  input({ target: inputTarget({ 'data-action': 'skill-field-instructions' }, 'y') });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'notion' }) });
  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();

  assert.deepEqual(harness.agentPatchBodies, []);
  assert.deepEqual(harness.oauthStartPosts, []);
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  assert.match(harness.app.innerHTML, /data-action="conn-oauth-start"[^>]*>[\s\S]*?<span>Sign into Native Notion<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /Opening Native Notion/);
});

test('an OAuth callback return opens the profile Connections tab with a status-only notice', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          mcpConnectionFixture({
            id: 'notion',
            displayName: 'Notion',
            url: 'https://mcp.notion.com/mcp',
            authMode: 'oauth',
            presetId: 'notion',
            lifecycleStatus: 'ready',
            statusText: 'Connected · 2 tools',
            discoveredTools: [
              { name: 'notion-search', description: 'Search Notion.' },
              { name: 'notion-fetch', description: 'Fetch from Notion.' },
            ],
            allowedTools: ['notion-search', 'notion-fetch'],
            identity: {
              workspaceName: "Pejman Pour-Moezzi's Notion",
              accountName: 'Pejman Pour-Moezzi',
            },
          }),
        ],
      }),
    ],
    initialPath: '/admin/agents/agent_conn',
    initialSearch: '?oauth=connected&connection=notion',
  });
  await flushAsync();

  assert.match(
    harness.app.innerHTML,
    /Connected to Pejman Pour-Moezzi&#39;s Notion/,
  );
  assert.match(harness.app.innerHTML, /Pejman Pour-Moezzi/);
  assert.match(harness.app.innerHTML, /2 tools enabled/);
  assert.equal((harness.app.innerHTML.match(/data-action="conn-tool-toggle"[^>]*checked/g) ?? []).length, 2);
  assert.match(harness.app.innerHTML, /Tool access is already saved/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-save-row"/);
  assert.match(harness.app.innerHTML, /save-bar-sticky[^\"]*is-clean/);
  assert.doesNotMatch(harness.app.innerHTML, /Test the connection to discover tools/);
  assert.match(
    harness.app.innerHTML,
    /data-action="profile-tab" data-tab="connections"[^>]*>Connections<span class="ptab-count">1<\/span>/,
  );
  assert.match(harness.app.innerHTML, /id="ptab-panel-connections" role="tabpanel" aria-labelledby="ptab-connections">/);
  assert.ok(harness.historyReplaces.includes('/admin/agents/agent_conn'));

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'profiles-back' }) });
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_other' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  assert.doesNotMatch(harness.app.innerHTML, /Connected to Pejman/);
});

test('changing connected OAuth tool access saves immediately without dirtying the profile', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          mcpConnectionFixture({
            id: 'notion',
            displayName: 'Notion',
            url: 'https://mcp.notion.com/mcp',
            authMode: 'oauth',
            presetId: 'notion',
            discoveredTools: [
              { name: 'notion-search', description: 'Search Notion.' },
              { name: 'notion-fetch', description: 'Fetch from Notion.' },
            ],
            allowedTools: ['notion-search', 'notion-fetch'],
          }),
        ],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });

  assert.match(harness.app.innerHTML, /Tool access is already saved/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-save-row"/);
  assert.match(harness.app.innerHTML, /save-bar-sticky[^\"]*is-clean/);

  change({ target: checkboxTarget({ 'data-action': 'conn-tool-toggle', 'data-index': '1' }, false) });
  assert.match(harness.app.innerHTML, /data-action="conn-save-row"[^>]*>Save tool access<\/button>/);
  assert.match(harness.app.innerHTML, /save-bar-sticky[^\"]*is-clean/);

  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(Object.keys(harness.agentPatchBodies[0]?.body ?? {}), ['mcpServers']);
  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.deepEqual(servers[0]?.allowedTools, ['notion-search']);
  assert.match(harness.app.innerHTML, /Tool access is already saved/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-save-row"/);
  assert.match(harness.app.innerHTML, /save-bar-sticky[^\"]*is-clean/);

  click({ target: actionTarget({ 'data-action': 'conn-cancel' }) });
  assert.match(harness.app.innerHTML, /Connected &middot; 1 tool/);
});

test('saving OAuth tool access preserves an unrelated unsaved profile change', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        skills: [{ name: 'existing-skill', description: 'Existing.', instructions: 'Keep it.', enabled: true }],
        mcpServers: [
          mcpConnectionFixture({
            id: 'notion',
            displayName: 'Notion',
            url: 'https://mcp.notion.com/mcp',
            authMode: 'oauth',
            presetId: 'notion',
            discoveredTools: [{ name: 'notion-search' }, { name: 'notion-fetch' }],
            allowedTools: ['notion-search', 'notion-fetch'],
          }),
        ],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });
  change({ target: checkboxTarget({ 'data-action': 'skill-toggle', 'data-index': '0' }, false) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });
  change({ target: checkboxTarget({ 'data-action': 'conn-tool-toggle', 'data-index': '1' }, false) });
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(Object.keys(harness.agentPatchBodies[0]?.body ?? {}), ['mcpServers']);
  assert.doesNotMatch(harness.app.innerHTML, /save-bar-sticky[^\"]*is-clean/);

  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 2);
  assert.equal((harness.agentPatchBodies[1]?.body.skills as Array<Record<string, unknown>>)[0]?.enabled, false);
  assert.deepEqual(
    (harness.agentPatchBodies[1]?.body.mcpServers as Array<Record<string, unknown>>)[0]?.allowedTools,
    ['notion-search'],
  );
});

test('disconnecting an OAuth connection clears its one-shot connected notice', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          mcpConnectionFixture({
            id: 'notion',
            displayName: 'Notion',
            url: 'https://mcp.notion.com/mcp',
            authMode: 'oauth',
            presetId: 'notion',
            lifecycleStatus: 'ready',
            statusText: 'Connected · 2 tools',
            discoveredTools: [
              { name: 'notion-search', description: 'Search Notion.' },
              { name: 'notion-fetch', description: 'Fetch from Notion.' },
            ],
            allowedTools: ['notion-search', 'notion-fetch'],
          }),
        ],
      }),
    ],
    initialPath: '/admin/agents/agent_conn',
    initialSearch: '?oauth=connected&connection=notion',
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Connected to Notion\. 2 tools enabled\./);

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'conn-oauth-disconnect' }) });
  click({ target: actionTarget({ 'data-action': 'conn-remove-confirm' }) });

  assert.doesNotMatch(harness.app.innerHTML, /Connected to Notion/);
  assert.doesNotMatch(harness.app.innerHTML, /0 tools enabled/);
});

test('a connected OAuth account offers confirmed disconnect and clears its stored OAuth state on save', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          mcpConnectionFixture({
            id: 'notion',
            displayName: 'Notion',
            url: 'https://mcp.notion.com/mcp',
            authMode: 'oauth',
            presetId: 'notion',
            lifecycleStatus: 'ready',
            statusText: 'Connected · 2 tools',
            discoveredTools: [
              { name: 'notion-search', description: 'Search Notion.' },
              { name: 'notion-fetch', description: 'Fetch from Notion.' },
            ],
            allowedTools: ['notion-search', 'notion-fetch'],
            identity: {
              workspaceName: 'Example workspace',
              accountName: 'Example admin',
            },
          }),
        ],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });

  assert.match(harness.app.innerHTML, /data-action="conn-oauth-start">Reconnect<\/button>/);
  assert.match(harness.app.innerHTML, /data-action="conn-oauth-disconnect">Disconnect<\/button>/);
  assert.doesNotMatch(harness.app.innerHTML, /Where do I find this\?/);
  assert.doesNotMatch(harness.app.innerHTML, /href="https:\/\/developers\.notion\.com\/guides\/mcp\/build-mcp-client"/);

  click({ target: actionTarget({ 'data-action': 'conn-oauth-disconnect' }) });
  assert.match(harness.app.innerHTML, /Disconnect Notion\?/);
  assert.match(
    harness.app.innerHTML,
    /stored OAuth tokens and client registration are deleted when you save/,
  );
  assert.match(harness.app.innerHTML, /data-action="conn-remove-confirm">Disconnect and remove<\/button>/);

  click({ target: actionTarget({ 'data-action': 'conn-remove-confirm' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.deepEqual(harness.agentPatchBodies[0]?.body.mcpServers, []);
  assert.deepEqual(harness.mcpSecretDeletes, [
    { agentId: 'agent_conn', id: 'notion', body: { headerNames: [] } },
  ]);
  assert.doesNotMatch(JSON.stringify(harness.agentPatchBodies), /access_token|refresh_token|client_secret/);
});

test('an OAuth verification failure is explicit and offers verification retry without repeating consent', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          mcpConnectionFixture({
            id: 'notion',
            displayName: 'Notion',
            url: 'https://mcp.notion.com/mcp',
            authMode: 'oauth',
            presetId: 'notion',
            lifecycleStatus: 'failed',
            statusText: 'The connection timed out before it was ready.',
            discoveredTools: [],
            allowedTools: [],
          }),
        ],
      }),
    ],
    initialPath: '/admin/agents/agent_conn',
    initialSearch: '?oauth=verification_failed&connection=notion',
  });
  await flushAsync();

  assert.match(
    harness.app.innerHTML,
    /Notion was authorized, but Chickpea could not verify the connection\./,
  );
  assert.match(harness.app.innerHTML, /role="alert"/);
  assert.match(harness.app.innerHTML, /data-action="conn-test"[^>]*>Retry verification<\/button>/);
  assert.doesNotMatch(harness.app.innerHTML, />Reconnect Notion<\/button>/);
});

test('custom MCP OAuth saves an explicit scope before starting generic authorization', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    deferAgentPatch: true,
    oauthStartResult: {
      authorizationUrl: 'https://sql-dash.onrender.com/authorize?state=opaque-state',
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });

  assert.match(harness.app.innerHTML, /<option value="oauth">OAuth<\/option>/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-field-oauth-scope"/);
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'SQL Dash') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://sql-dash.onrender.com/mcp') });
  change({
    target: {
      value: 'oauth',
      closest: () => null,
      getAttribute: (name: string) => (name === 'data-action' ? 'conn-auth' : null),
    } as unknown as FakeTarget,
  });

  const oauthEditor = harness.app.innerHTML;
  assert.match(oauthEditor, /<option value="oauth" selected>OAuth<\/option>/);
  assert.match(oauthEditor, /<details class="advanced conn-oauth-advanced"><summary>Advanced<\/summary>/);
  assert.match(oauthEditor, /<label class="field-label" for="conn-oauth-scope">Scope \(optional\)<\/label>/);
  assert.match(oauthEditor, /data-action="conn-field-oauth-scope"/);
  assert.match(oauthEditor, /Leave blank to use the default access requested by the provider\./);
  assert.match(oauthEditor, /data-action="conn-oauth-start"/);

  input({ target: inputTarget({ 'data-action': 'conn-field-oauth-scope' }, 'sqldash') });
  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();

  assert.equal(harness.agentPatchBodies.length, 1);
  assert.deepEqual(harness.oauthStartPosts, []);
  assert.deepEqual(harness.assignedUrls, []);

  harness.resolveAgentPatch();
  await flushAsync();

  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.deepEqual(servers, [
    {
      id: 'sql-dash',
      displayName: 'SQL Dash',
      url: 'https://sql-dash.onrender.com/mcp',
      transport: 'streamable-http',
      authMode: 'oauth',
      headerNames: [],
      enabled: true,
      lifecycleStatus: 'pending',
      statusText: '',
      discoveredTools: [],
      allowedTools: [],
      oauthScope: 'sqldash',
    },
  ]);
  assert.deepEqual(harness.oauthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'sql-dash', body: { scope: 'sqldash' } },
  ]);
  assert.deepEqual(harness.assignedUrls, [
    'https://sql-dash.onrender.com/authorize?state=opaque-state',
  ]);
  assert.deepEqual(harness.openedUrls, [
    'https://sql-dash.onrender.com/authorize?state=opaque-state',
  ]);
});

test('custom MCP OAuth leaves provider scope selection implicit when scope is blank', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    deferAgentPatch: true,
    oauthStartResult: {
      authorizationUrl: 'https://accounts.example.com/authorize?state=opaque-state',
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Provider Default') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://mcp.example.com/mcp') });
  change({
    target: {
      value: 'oauth',
      closest: () => null,
      getAttribute: (name: string) => (name === 'data-action' ? 'conn-auth' : null),
    } as unknown as FakeTarget,
  });
  click({ target: actionTarget({ 'data-action': 'conn-oauth-start' }) });
  await flushAsync();

  assert.deepEqual(harness.oauthStartPosts, []);
  harness.resolveAgentPatch();
  await flushAsync();

  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.equal(Object.hasOwn(servers[0] ?? {}, 'oauthScope'), false);
  assert.deepEqual(harness.oauthStartPosts, [
    { agentId: 'agent_conn', connectionId: 'provider-default', body: {} },
  ]);
  assert.deepEqual(harness.assignedUrls, [
    'https://accounts.example.com/authorize?state=opaque-state',
  ]);
  assert.deepEqual(harness.openedUrls, [
    'https://accounts.example.com/authorize?state=opaque-state',
  ]);
});

test('an existing OAuth connection remains editable and stages token cleanup when disabled', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          mcpConnectionFixture({
            id: 'private-mcp',
            displayName: 'Private MCP',
            url: 'https://mcp.example.com/mcp',
            authMode: 'oauth',
            oauthScope: 'read',
            presetId: undefined,
          }),
        ],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });

  assert.match(
    harness.app.innerHTML,
    /<option value="oauth" selected>OAuth<\/option>/,
  );
  assert.match(harness.app.innerHTML, /value="read"[^>]*data-action="conn-field-oauth-scope"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-field-bearer"/);

  change({
    target: {
      value: 'none',
      closest: () => null,
      getAttribute: (name: string) => (name === 'data-action' ? 'conn-auth' : null),
    } as unknown as FakeTarget,
  });
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.equal(servers[0]?.authMode, 'none');
  assert.equal(harness.mcpSecretPuts[0]?.body.clearOAuth, true);
});

test('the Connections section renders its gallery, with the STDIO-greyed form, exact security copy, and trust-gated Test', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });

  // The Connections capability tab renders its gallery with the
  // tokens-by-reference note.
  assert.match(harness.app.innerHTML, /data-action="profile-tab" data-tab="connections"/);
  assert.match(harness.app.innerHTML, /data-action="conn-gallery-search"/);
  assert.doesNotMatch(harness.app.innerHTML, /No connections yet/);
  assert.match(
    harness.app.innerHTML,
    /Your Agent stores connection policy and tool approvals only &mdash; tokens live in the settings store and are never returned by the API\./,
  );

  // Open the add form — Name + URL + transport control appear.
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });
  assert.match(harness.app.innerHTML, /data-action="conn-field-name"/);
  assert.match(harness.app.innerHTML, /data-action="conn-field-url"/);

  // STDIO is present but disabled with the Cloudflare-unsupported title.
  assert.match(harness.app.innerHTML, /disabled title="Not supported on Cloudflare Workers">STDIO<\/button>/);
  // Streamable HTTP and SSE are live segmented options.
  assert.match(harness.app.innerHTML, /data-action="conn-transport" data-transport="streamable-http"/);
  assert.match(harness.app.innerHTML, /data-action="conn-transport" data-transport="sse"/);

  // Test is disabled until the url is filled. The input handler doesn't
  // re-render, so trigger one via the transport segment.
  assert.match(harness.app.innerHTML, /data-action="conn-test" disabled/);
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Linear') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://mcp.example.com/mcp') });
  click({ target: actionTarget({ 'data-action': 'conn-transport', 'data-transport': 'streamable-http' }) });
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-test" disabled/);
});

test('testing a connection renders discovered-tool checkboxes all checked and carries policy (not the token) into the save body', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });

  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Linear') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://mcp.example.com/mcp') });
  // Switch to bearer auth and paste a token — the token is a TRANSIENT secret.
  change({
    target: {
      value: 'bearer',
      closest: () => null,
      getAttribute: (name: string) => (name === 'data-action' ? 'conn-auth' : null),
    } as unknown as FakeTarget,
  });
  input({ target: inputTarget({ 'data-action': 'conn-field-bearer' }, 'sk-secret-token') });

  // Test the connection — the endpoint gets the id/url/transport/authMode + token.
  click({ target: actionTarget({ 'data-action': 'conn-test' }) });
  await flushAsync();
  assert.equal(harness.mcpTestPosts.length, 1);
  const testBody = harness.mcpTestPosts[0] as Record<string, unknown>;
  assert.equal(testBody.agentId, 'agent_conn');
  assert.equal(testBody.id, 'linear');
  assert.equal(testBody.url, 'https://mcp.example.com/mcp');
  assert.equal(testBody.authMode, 'bearer');
  assert.equal(testBody.bearerToken, 'sk-secret-token');

  // Both discovered tools render as checkboxes, all checked by default.
  assert.match(harness.app.innerHTML, /Connected &middot; 2 tools/);
  assert.match(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="0" checked/);
  assert.match(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="1" checked/);
  assert.match(harness.app.innerHTML, /search_issues/);
  assert.match(harness.app.innerHTML, /create_issue/);

  // Uncheck the write tool so only search_issues is approved.
  change({ target: checkboxTarget({ 'data-action': 'conn-tool-toggle', 'data-index': '1' }, false) });
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="1" checked/);

  // Add the connection (explicit button) and save the profile.
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  // The PATCH body carries the connection POLICY: allowedTools is the checked
  // subset, discoveredTools is the full list, lifecycleStatus is ready.
  assert.equal(harness.agentPatchBodies.length, 1);
  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.equal(servers.length, 1);
  const conn = servers[0] as Record<string, unknown>;
  assert.equal(conn.id, 'linear');
  assert.equal(conn.displayName, 'Linear');
  assert.equal(conn.authMode, 'bearer');
  assert.equal(conn.lifecycleStatus, 'ready');
  assert.deepEqual(conn.allowedTools, ['search_issues']);
  assert.deepEqual(
    (conn.discoveredTools as Array<Record<string, unknown>>).map((t) => t.name),
    ['search_issues', 'create_issue'],
  );

  // CRITICAL: the token value is NEVER in the profile PATCH body anywhere.
  assert.doesNotMatch(JSON.stringify(harness.agentPatchBodies[0]?.body), /sk-secret-token/);
  // But it WAS PUT to the settings store by reference.
  assert.equal(harness.mcpSecretPuts.length, 1);
  assert.equal(harness.mcpSecretPuts[0]?.agentId, 'agent_conn');
  assert.equal(harness.mcpSecretPuts[0]?.id, 'linear');
  assert.equal((harness.mcpSecretPuts[0]?.body as Record<string, unknown>).bearerToken, 'sk-secret-token');
  assert.doesNotMatch(harness.app.innerHTML, /Agent saved, but a credential could not be/);

  // Successful secret writes are removed from the retry queue.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.mcpSecretPuts.length, 1);
});

test('a failed MCP credential PUT stays pending, surfaces an error, and retries on Save', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    mcpSecretPutFailures: 1,
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Linear') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://mcp.example.com/mcp') });
  change({
    target: {
      value: 'bearer',
      closest: () => null,
      getAttribute: (name: string) => (name === 'data-action' ? 'conn-auth' : null),
    } as unknown as FakeTarget,
  });
  input({ target: inputTarget({ 'data-action': 'conn-field-bearer' }, 'retry-mcp-secret') });
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.mcpSecretPuts.length, 1);
  assert.match(
    harness.app.innerHTML,
    /Agent saved, but a credential could not be stored — open the connector and Save again\./,
  );

  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });
  assert.doesNotMatch(harness.app.innerHTML, /placeholder="•••• stored"[^>]*data-action="conn-field-bearer"/);
  click({ target: actionTarget({ 'data-action': 'conn-cancel' }) });

  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.mcpSecretPuts.length, 2);
  assert.doesNotMatch(harness.app.innerHTML, /Agent saved, but a credential could not be/);
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.mcpSecretPuts.length, 2);
});

test('creating a profile writes connection secrets under the generated profile id', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  input({ target: inputTarget({ 'data-action': 'profile-name' }, 'Support Profile') });
  input({ target: inputTarget({ 'data-action': 'profile-instructions' }, 'Help teammates.') });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Linear') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://mcp.example.com/mcp') });
  change({
    target: {
      value: 'bearer',
      closest: () => null,
      getAttribute: (name: string) => (name === 'data-action' ? 'conn-auth' : null),
    } as unknown as FakeTarget,
  });
  input({ target: inputTarget({ 'data-action': 'conn-field-bearer' }, 'new-profile-token') });
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.agentPostBodies[0]?.id, 'agent_support_profile');
  const createdServers = harness.agentPostBodies[0]?.mcpServers as Array<Record<string, unknown>>;
  assert.equal(createdServers.length, 1);
  assert.equal(createdServers[0]?.id, 'linear');
  assert.equal(createdServers[0]?.displayName, 'Linear');
  assert.equal(createdServers[0]?.url, 'https://mcp.example.com/mcp');
  assert.equal(createdServers[0]?.authMode, 'bearer');
  assert.doesNotMatch(JSON.stringify(harness.agentPostBodies[0]), /new-profile-token/);
  assert.equal(harness.mcpSecretPuts[0]?.agentId, 'agent_support_profile');
  assert.equal(harness.mcpSecretPuts[0]?.id, 'linear');
  assert.equal(harness.mcpSecretPuts[0]?.body.bearerToken, 'new-profile-token');
});

test('re-testing a connection refreshes discovered tools; a vanished tool drops and a new one defaults checked', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          {
            id: 'linear',
            displayName: 'Linear',
            url: 'https://mcp.example.com/mcp',
            transport: 'streamable-http',
            authMode: 'none',
            headerNames: [],
            enabled: true,
            lifecycleStatus: 'ready',
            statusText: '',
            discoveredTools: [
              { name: 'old_tool_a' },
              { name: 'old_tool_b' },
            ],
            allowedTools: ['old_tool_a'],
            lastCheckedAt: 1000,
          },
        ],
      }),
    ],
    // The re-test discovers a DIFFERENT tool set — old_tool_b is gone, a new one appears.
    mcpTestResult: {
      ok: true,
      tools: [
        { name: 'old_tool_a', description: 'kept' },
        { name: 'brand_new_tool', description: 'new' },
      ],
    },
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });

  // The card shows the connected pill for the persisted (1-approved) connection.
  assert.match(harness.app.innerHTML, /Connected &middot; 1 tool/);

  // Open the editor and re-test.
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });
  click({ target: actionTarget({ 'data-action': 'conn-test' }) });
  await flushAsync();

  // The vanished old_tool_b is gone; the kept tool retains its approval and the
  // brand-new tool defaults checked.
  assert.match(harness.app.innerHTML, /brand_new_tool/);
  assert.doesNotMatch(harness.app.innerHTML, /old_tool_b/);
  assert.match(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="0" checked/);
  assert.match(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="1" checked/);

  // Save — allowedTools now reflects ONLY the fresh discovery, not the stale approval.
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.deepEqual(servers[0]?.allowedTools, ['old_tool_a', 'brand_new_tool']);
  assert.deepEqual(
    (servers[0]?.discoveredTools as Array<Record<string, unknown>>).map((t) => t.name),
    ['old_tool_a', 'brand_new_tool'],
  );
});

test('re-testing preserves a deliberately-unchecked tool that still exists (no silent re-approval)', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          {
            id: 'linear',
            displayName: 'Linear',
            url: 'https://mcp.example.com/mcp',
            transport: 'streamable-http',
            authMode: 'none',
            headerNames: [],
            enabled: true,
            lifecycleStatus: 'ready',
            statusText: '',
            discoveredTools: [{ name: 'read_tool' }, { name: 'write_tool' }],
            // Operator approved only the read tool; write_tool was left unchecked.
            allowedTools: ['read_tool'],
            lastCheckedAt: 1000,
          },
        ],
      }),
    ],
    // Re-test rediscovers the SAME two tools — write_tool still exists.
    mcpTestResult: {
      ok: true,
      tools: [{ name: 'read_tool', description: 'r' }, { name: 'write_tool', description: 'w' }],
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'conn-edit', 'data-index': '0' }) });
  click({ target: actionTarget({ 'data-action': 'conn-test' }) });
  await flushAsync();

  // read_tool stays checked; write_tool must remain UNCHECKED across the re-test.
  assert.match(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="0" checked/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-tool-toggle" data-index="1" checked/);

  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.deepEqual(servers[0]?.allowedTools, ['read_tool']);
});

test('a failed test marks the connection failed with the safe status text and no tool checkboxes', async () => {
  const harness = runAdminPageHarness({
    agents: [connectionsAgent()],
    mcpTestResult: { ok: false, code: 'unauthorized', message: 'The MCP server rejected the connection. Check the token or headers.' },
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Linear') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://mcp.example.com/mcp') });
  click({ target: actionTarget({ 'data-action': 'conn-test' }) });
  await flushAsync();

  // The safe failure text surfaces inline; no discovered-tool checkboxes render.
  assert.match(harness.app.innerHTML, /The MCP server rejected the connection\. Check the token or headers\./);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="conn-tool-toggle"/);

  // Save — the connection persists as failed with the classified statusText.
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.equal(servers[0]?.lifecycleStatus, 'failed');
  assert.equal(servers[0]?.statusText, 'The MCP server rejected the connection. Check the token or headers.');
  assert.deepEqual(servers[0]?.allowedTools, []);
});

test('removing a connection confirms in a modal and DELETEs its secrets on save', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          {
            id: 'linear',
            displayName: 'Linear',
            url: 'https://mcp.example.com/mcp',
            transport: 'streamable-http',
            authMode: 'bearer',
            headerNames: ['X-Api-Key'],
            enabled: true,
            lifecycleStatus: 'ready',
            statusText: '',
            discoveredTools: [{ name: 'search_issues' }],
            allowedTools: ['search_issues'],
            lastCheckedAt: 1000,
          },
        ],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  assert.match(harness.app.innerHTML, /Linear/);

  // Remove opens a confirm modal rather than dropping the row immediately.
  click({ target: actionTarget({ 'data-action': 'conn-remove', 'data-index': '0' }) });
  assert.match(harness.app.innerHTML, /Remove Linear\?/);
  assert.match(harness.app.innerHTML, /data-action="conn-remove-confirm"/);
  assert.match(harness.app.innerHTML, /data-action="conn-remove-cancel"/);

  // Confirm — the row is gone and the gallery remains available.
  click({ target: actionTarget({ 'data-action': 'conn-remove-confirm' }) });
  assert.match(harness.app.innerHTML, /data-action="conn-gallery-search"/);
  assert.doesNotMatch(harness.app.innerHTML, /No connections yet/);

  // Save — the PATCH body has an empty mcpServers AND the secrets DELETE fires
  // with the connection's header names.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.deepEqual(harness.agentPatchBodies[0]?.body.mcpServers, []);
  assert.equal(harness.mcpSecretDeletes.length, 1);
  assert.equal(harness.mcpSecretDeletes[0]?.agentId, 'agent_conn');
  assert.equal(harness.mcpSecretDeletes[0]?.id, 'linear');
  assert.deepEqual((harness.mcpSecretDeletes[0]?.body as Record<string, unknown>).headerNames, ['X-Api-Key']);
});

test('a failed MCP credential DELETE stays pending, surfaces an error, and retries on Save', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          {
            id: 'linear',
            displayName: 'Linear',
            url: 'https://mcp.example.com/mcp',
            transport: 'streamable-http',
            authMode: 'bearer',
            headerNames: ['X-Api-Key'],
            enabled: true,
            lifecycleStatus: 'ready',
            statusText: '',
            discoveredTools: [],
            allowedTools: [],
          },
        ],
      }),
    ],
    mcpSecretDeleteFailures: 1,
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'conn-remove', 'data-index': '0' }) });
  click({ target: actionTarget({ 'data-action': 'conn-remove-confirm' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.mcpSecretDeletes.length, 1);
  assert.match(harness.app.innerHTML, /Agent saved, but a credential could not be removed — Save again to retry\./);

  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.mcpSecretDeletes.length, 2);
  assert.doesNotMatch(harness.app.innerHTML, /Agent saved, but a credential could not be/);
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.mcpSecretDeletes.length, 2);
});

test('saving with a filled-but-not-added connection editor commits it, not drops it', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });

  // Open the editor and fill it — but do NOT click "Add connection".
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Deepwiki') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://mcp.deepwiki.com/mcp') });

  // Save changes directly — the filled editor must be committed.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  const servers = harness.agentPatchBodies[0]?.body.mcpServers as Array<Record<string, unknown>>;
  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.id, 'deepwiki');
  assert.equal(servers[0]?.displayName, 'Deepwiki');
});

test('a duplicate connection name and a non-https URL are rejected inline before save', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          {
            id: 'linear',
            displayName: 'Linear',
            url: 'https://mcp.example.com/mcp',
            transport: 'streamable-http',
            authMode: 'none',
            headerNames: [],
            enabled: true,
            lifecycleStatus: 'pending',
            statusText: '',
            discoveredTools: [],
            allowedTools: [],
          },
        ],
      }),
    ],
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'conn-custom' }) });

  // A non-https URL is rejected inline.
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Other') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'http://insecure.example.com/mcp') });
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  assert.match(harness.app.innerHTML, /MCP server URLs must use https\./);

  // A name that slugs to the existing id is rejected as a duplicate.
  input({ target: inputTarget({ 'data-action': 'conn-field-name' }, 'Linear') });
  input({ target: inputTarget({ 'data-action': 'conn-field-url' }, 'https://other.example.com/mcp') });
  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  assert.match(harness.app.innerHTML, /Another connection already uses that name\./);
});

test('saving a profile with an invalid open skill editor blocks the save and shows the error', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_badedit',
        name: 'Bad Edit Profile',
        description: 'Repro',
        instructions: 'Answer.',
        enabled: true,
        model: 'local-stub/be',
        skills: [],
      },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;

  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_badedit' }) });
  click({ target: actionTarget({ 'data-action': 'skill-new' }) });
  input({ target: inputTarget({ 'data-action': 'skill-field-name' }, 'Bad Name!') });
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'x') });
  input({ target: inputTarget({ 'data-action': 'skill-field-instructions' }, 'y') });

  // Save must NOT silently proceed — it surfaces the validation error and blocks.
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 0);
  assert.match(harness.app.innerHTML, /lowercase letters/);
});

test('creating a blank profile round-trips with an empty skills array', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  // A new profile starts on the Instructions tab and defaults skills to []; the
  // POST body must still carry the field when no custom skills are added.
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  assert.match(harness.app.innerHTML, /id="ptab-instructions" class="ptab on"/);
  input({ target: inputTarget({ 'data-action': 'profile-name' }, 'Fresh Profile') });
  input({ target: inputTarget({ 'data-action': 'profile-instructions' }, 'Answer freshly.') });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  // The create POST carries an empty skills array — the backend contract requires
  // the field, and a blank profile has no custom skills yet.
  assert.equal(harness.agentPostBodies.length, 1);
  assert.equal(harness.agentPostBodies[0]?.name, 'Fresh Profile');
  assert.deepEqual(harness.agentPostBodies[0]?.skills, []);
  assert.deepEqual(harness.agentPostBodies[0]?.mcpServers, []);
  assert.equal(Object.hasOwn(harness.agentPostBodies[0] ?? {}, 'defaultModels'), false);
});

test('creating a profile persists a custom skill configured from the Skills tab', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  input({ target: inputTarget({ 'data-action': 'profile-name' }, 'Research Profile') });
  input({ target: inputTarget({ 'data-action': 'profile-instructions' }, 'Research carefully.') });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'skills' }) });
  click({ target: actionTarget({ 'data-action': 'skill-new' }) });
  input({ target: inputTarget({ 'data-action': 'skill-field-name' }, 'source-check') });
  input({ target: inputTarget({ 'data-action': 'skill-field-description' }, 'Verify primary sources.') });
  input({ target: inputTarget({ 'data-action': 'skill-field-instructions' }, 'Prefer first-party documentation.') });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.deepEqual(harness.agentPostBodies[0]?.skills, [
    {
      name: 'source-check',
      description: 'Verify primary sources.',
      instructions: 'Prefer first-party documentation.',
      enabled: true,
    },
  ]);
});

test('the profile editor save bar is sticky, hidden when clean, and revealed when dirty', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_bar',
        name: 'Bar Profile',
        description: 'Save-bar fixture',
        instructions: 'Answer.',
        enabled: true,
        model: 'local-stub/bar',
        skills: [{ name: 'a-skill', description: 'desc', instructions: '# body', enabled: true }],
      },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_bar' }) });

  // The sticky bar exists but is marked clean (hidden) with no pending edits.
  assert.match(harness.app.innerHTML, /save-bar-sticky/);
  assert.match(harness.app.innerHTML, /save-bar-sticky[^"]*is-clean/);

  // A render-causing edit (toggle the skill off) marks the profile dirty; the
  // re-render drops is-clean and shows the "Unsaved changes" label + Save.
  change({ target: checkboxTarget({ 'data-action': 'skill-toggle', 'data-index': '0' }, false) });
  assert.doesNotMatch(harness.app.innerHTML, /save-bar-sticky[^"]*is-clean/);
  assert.match(harness.app.innerHTML, /Unsaved changes/);
  assert.match(harness.app.innerHTML, /data-action="save-profile"/);
});

test('leaving a dirty profile editor prompts, and honors keep/discard/save', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_guard',
        name: 'Guard Profile',
        description: 'd',
        instructions: 'Answer.',
        enabled: true,
        model: 'local-stub/guard',
        skills: [{ name: 'a-skill', description: 'desc', instructions: '# body', enabled: true }],
      },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);

  const openEditor = () =>
    click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_guard' }) });
  // A render-causing edit that marks the profile dirty.
  const dirtyIt = () =>
    change({ target: checkboxTarget({ 'data-action': 'skill-toggle', 'data-index': '0' }, false) });

  // Clean editor → clicking Profiles navigates immediately, no modal.
  openEditor();
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  assert.doesNotMatch(harness.app.innerHTML, /modal-backdrop/);
  assert.match(harness.app.innerHTML, /Your Agents/);

  // Dirty editor → clicking Profiles opens the guard modal and does NOT leave.
  openEditor();
  dirtyIt();
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  assert.match(harness.app.innerHTML, /modal-backdrop/);
  assert.match(harness.app.innerHTML, /Unsaved changes/);
  assert.match(harness.app.innerHTML, /data-action="profile-tab" data-tab="skills"/);

  // Keep editing → modal closes, still on the editor.
  click({ target: actionTarget({ 'data-action': 'leave-cancel' }) });
  assert.doesNotMatch(harness.app.innerHTML, /modal-backdrop/);
  assert.match(harness.app.innerHTML, /data-action="profile-tab" data-tab="skills"/);

  // Discard & leave → navigate to the list, and NO save was sent.
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  click({ target: actionTarget({ 'data-action': 'leave-discard' }) });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /modal-backdrop/);
  assert.match(harness.app.innerHTML, /Your Agents/);
  assert.equal(harness.agentPatchBodies.length, 0);

  // Save changes from the modal → PATCH is sent, then it navigates to the list.
  openEditor();
  dirtyIt();
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  click({ target: actionTarget({ 'data-action': 'leave-save' }) });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /modal-backdrop/);
  assert.match(harness.app.innerHTML, /Your Agents/);
  assert.equal(harness.agentPatchBodies.length, 1);
  assert.equal(harness.agentPatchBodies[0]?.id, 'agent_guard');
});

test('Home opens the canonical Agent and keeps Agent and owner-memory draft guards authoritative', async () => {
  const cleanHarness = runAdminPageHarness({ initialPath: '/admin/channels' });
  await flushAsync();
  cleanHarness.listeners.click?.({ target: actionTarget({ 'data-action': 'go-home' }) });
  assert.equal(cleanHarness.locationPath(), '/admin/agents/agent_release');

  const agentHarness = runAdminPageHarness({ initialPath: '/admin/agents/agent_ops' });
  await flushAsync();
  agentHarness.listeners.input?.({
    target: inputTarget({ 'data-action': 'profile-instructions' }, 'Unsaved Agent instructions.'),
  });
  agentHarness.listeners.click?.({ target: actionTarget({ 'data-action': 'go-home' }) });
  assert.match(agentHarness.app.innerHTML, /This Agent has changes you haven&rsquo;t saved/);
  assert.equal(agentHarness.locationPath(), '/admin/agents/agent_ops');
  agentHarness.listeners.click?.({ target: actionTarget({ 'data-action': 'leave-discard' }) });
  assert.equal(agentHarness.locationPath(), '/admin/agents/agent_release');

  const memoryHarness = runAdminPageHarness({ initialPath: '/admin/agents/agent_release' });
  await flushAsync();
  memoryHarness.listeners.click?.({
    target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'memory' }),
  });
  await flushAsync();
  memoryHarness.listeners.input?.({
    target: inputTarget({ 'data-action': 'owner-memory-body' }, 'Unsaved Agent memory.'),
  });
  memoryHarness.listeners.click?.({ target: actionTarget({ 'data-action': 'go-home' }) });
  assert.equal(memoryHarness.locationPath(), '/admin/agents/agent_release');
  assert.match(memoryHarness.app.innerHTML, /Save or discard this memory draft before navigating away/);
  assert.doesNotMatch(memoryHarness.app.innerHTML, /role="dialog" aria-modal="true" aria-label="Unsaved changes"/);
});

test('Channel navigation has no local behavior or memory draft to guard', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();
  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_ops' }),
  });
  assert.equal(harness.locationPath(), '/admin/agents/agent_ops');
  assert.deepEqual(harness.beforeunload(), { prevented: false, returnValue: undefined });
  assert.equal(harness.memoryPuts.length, 0);
});

test('the narrow Destination shell keeps global navigation without reopening the Agent roster', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();

  const page = renderAdminPage();
  assert.match(page, /@media \(max-width: 740px\)[\s\S]*?\.primary-admin-shell > \.topbar\s*\{[^}]*display:\s*flex;/s);
  assert.match(page, /@media \(max-width: 740px\)[\s\S]*?\.primary-admin-shell \.primary-shell-sidebar\s*\{[^}]*display:\s*none;/s);
  assert.doesNotMatch(harness.app.innerHTML, /class="mobile-agent-roster"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="mobile-agents-open"/);
  assert.match(harness.app.innerHTML, /data-action="open-destinations"[^>]*>Destinations<\/button>/);
});

test('profile save renders server model-resolution messages', async () => {
  const serverMessage = 'No model pinned for agent agent_no_model. Pin a model in /admin (Agents -> Model).';
  const harness = runAdminPageHarness({
    agentWriteError: { status: 422, error: 'model_not_resolvable', message: serverMessage },
  });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  input({ target: inputTarget({ 'data-action': 'profile-name' }, 'No Model') });
  input({ target: inputTarget({ 'data-action': 'profile-instructions' }, 'Answer from the fixture.') });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /No model pinned for agent agent_no_model/);
  assert.doesNotMatch(harness.app.innerHTML, /model_not_resolvable/);
});

test('selecting a channel renders its grant inventory without effective configuration', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({
    target: actionTarget({
      'data-action': 'select-channel',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C_OPS',
    }),
  });

  assert.match(harness.app.innerHTML, /#C_OPS/);
  assert.match(harness.app.innerHTML, /Agents available here/);
  assert.doesNotMatch(harness.app.innerHTML, /local-stub\/ops|Resolved configuration/);
  assert.doesNotMatch(harness.app.innerHTML, /channel-detail-status resolving/);
});

test('the attached Agent roster lists Agents without placement summaries or Channel rows', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    slackConnection: null,
    assignments: [
      ...defaultAssignments(),
      {
        workspaceId: 'TDEMO',
        channelId: 'C_DEMO',
        channelLabel: 'demo-channel',
        agentId: releaseAgent.id,
        enabled: true,
      },
      {
        workspaceId: '*',
        channelId: '*',
        agentId: releaseAgent.id,
        enabled: true,
      },
    ],
  });
  await flushAsync();

  const roster = harness.app.innerHTML.match(/<nav class="agent-roster" aria-label="Agents">[\s\S]*?<\/nav>/)?.[0] ?? '';
  assert.match(roster, /data-agent="agent_release"/);
  assert.match(roster, /data-agent="agent_ops"/);
  assert.doesNotMatch(roster, /agent-roster-meta|\b\d+ places?\b/);
  assert.doesNotMatch(roster, /Direct messages|\+ DMs|DM default/);
  assert.doesNotMatch(roster, /data-action="select-channel"|#eng-releases|#demo-channel/);
});

test('Channels inventory has no placement editor; Agents own the publication picker', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture(),
  });
  await flushAsync();

  assert.doesNotMatch(harness.app.innerHTML, /toggle-add-channel|id="add-channel-select"|Enter ID manually/);
  const click = await openReleaseAttachPicker(harness);
  assert.match(harness.app.innerHTML, /data-role="attach-channel"/);
  assert.match(harness.app.innerHTML, /#new-channel/);
  assert.match(harness.app.innerHTML, /#secret-room/);
  assert.ok(click);
  assert.equal(harness.channelListCalls.length, 1);
});

test('add-channel missing_scope links reinstall and directs encrypted recovery without credential paste-back', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannelFailures: 2,
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'toggle-add-channel' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Slack permissions are out of date/);
  assert.match(harness.app.innerHTML, /href="https:\/\/api\.slack\.com\/apps"[^>]*>Reinstall in Slack/);
  assert.match(harness.app.innerHTML, /scoped recovery flow/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="slack-update-open"|name="botToken"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="refresh-channels"[^>]*>[^<]*<svg[\s\S]*?Refresh<\/button>/);
});

test('Agent publication sends the connected workspace and surfaces private-Channel recovery', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture(),
    attachSelectionValue: 'C_PRIVATE',
    putAssignmentError: {
      status: 409,
      error: 'private_channel_invite_required',
      message: 'Invite Chickpea to #secret-room, then retry.',
    },
  });
  const click = await openReleaseAttachPicker(harness);
  click({ target: actionTarget({ 'data-action': 'attach-channel-confirm' }) });
  await flushAsync();

  assert.deepEqual(harness.agentChannelPosts, [{
    agentId: releaseAgent.id,
    body: { workspaceId: 'T_DESIGN', channelId: 'C_PRIVATE' },
  }]);
  assert.match(harness.app.innerHTML, /Invite Chickpea to #secret-room, then retry\./);
});

test('the Destination shell stays available while Slack setup is incomplete', async () => {
  const harness = runAdminPageHarness({
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  // Disconnected: setup stays focused while the flat destination rail and
  // stable section switcher remain available.
  assert.match(harness.app.innerHTML, /Slack setup incomplete/);
  assert.match(harness.app.innerHTML, /<nav class="rail primary-shell-sidebar destination-shell-sidebar" aria-label="Destinations">/);
  assert.match(harness.app.innerHTML, /class="destination-rail-name">Slack<\/span>/);
  assert.match(harness.app.innerHTML, /class="section-nav-item" data-action="open-profiles"[^>]*>Agents<\/button>/);
  assert.match(harness.app.innerHTML, /class="section-nav-item" data-action="open-settings"[^>]*>Settings<\/button>/);
  assert.equal(harness.channelListCalls.length, 0);
});

test('Channel publication never asks an operator to hand-type a Channel ID', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture(),
  });
  await flushAsync();

  await openReleaseAttachPicker(harness);
  assert.doesNotMatch(harness.app.innerHTML, /manualChannelId|toggle-manual-channel|Enter ID manually/);
  assert.match(harness.app.innerHTML, /data-role="attach-channel"/);
});

test('onboarding never paints normal Admin navigation before its first routed render', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    slackConnection: disconnectedSlackFixture(),
    onboarding: {
      stage: 'connect_slack',
      revision: '{"version":1}',
      workspace: null,
      channel: null,
      tryStartedAt: null,
      completedAt: null,
    },
  });

  assert.equal(harness.renderHistory.length, 1, 'the onboarding shell should render synchronously');
  assert.match(harness.renderHistory[0] ?? '', /class="onboarding-shell"/);
  assert.doesNotMatch(harness.renderHistory[0] ?? '', /aria-label="Admin navigation"/);
  await flushAsync();

  assert.ok(harness.renderHistory.length > 0);
  assert.ok(
    harness.renderHistory.every((html) => !html.includes('aria-label="Admin navigation"')),
    'the onboarding route must not flash the post-setup Admin shell',
  );
});

test('onboarding skips channel publication, validates a provider, requires a model, and opens a Chickpea DM', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    agents: [seededAgents[0]],
    providers: [
      { id: 'anthropic', status: 'missing', modelCount: null },
      { id: 'openai', status: 'missing', modelCount: null, activeAuthMethod: 'api_key', subscription: { state: 'disconnected', updatedAt: 0 } },
      { id: 'openrouter', status: 'missing', modelCount: null },
      { id: 'workers-ai', status: 'env', modelCount: null, enabled: true },
    ],
    modelProviders: [
      { id: 'anthropic', configured: false, source: 'missing', suggestions: ['anthropic/claude-sonnet-5', 'anthropic/claude-opus-5'] },
      { id: 'openai', configured: false, source: 'missing', suggestions: ['openai/gpt-5.6-terra'] },
      { id: 'openrouter', configured: false, source: 'missing', suggestions: ['openrouter/anthropic/claude-sonnet-5'] },
      { id: 'cloudflare', configured: true, source: 'Workers AI binding', suggestions: ['cloudflare/@cf/zai-org/glm-5.2'] },
    ],
    onboarding: {
      stage: 'choose_provider',
      revision: '{"version":1,"state":"active"}',
      workspace: { id: 'T_DESIGN', name: 'Acme Inc' },
      channel: null,
      slackAppId: 'A_CHICKPEA',
      tryStartedAt: null,
      completedAt: null,
    },
  });
  await flushAsync();

  assert.doesNotMatch(harness.app.innerHTML, /Choose where Chickpea should start|Choose a channel/);
  assert.equal(harness.agentChannelPosts.length, 0);
  assert.equal(harness.onboardingTryPosts.length, 0);
  assert.match(harness.app.innerHTML, /Choose your model provider/);
  assert.match(harness.app.innerHTML, /Cloudflare Workers AI/);
  assert.match(harness.app.innerHTML, /Anthropic/);
  assert.match(harness.app.innerHTML, /OpenAI/);
  assert.match(harness.app.innerHTML, /OpenRouter/);
  assert.equal((harness.app.innerHTML.match(/class="onboarding-provider-logo"/g) ?? []).length, 4);

  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'onboarding-provider-select', 'data-provider': 'anthropic' }),
  });
  harness.listeners.input?.({
    target: inputTarget({ 'data-action': 'onboarding-provider-key', 'data-provider': 'anthropic' }, 'sk-ant-onboarding'),
  });
  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'onboarding-provider-continue' }),
  });
  await flushAsync();

  assert.deepEqual(harness.providerKeyPosts.at(-1), { id: 'anthropic', key: 'sk-ant-onboarding' });
  assert.equal(harness.onboardingProviderPosts.at(-1)?.providerId, 'anthropic');
  assert.match(harness.app.innerHTML, /Choose your model/);
  assert.match(harness.app.innerHTML, /Choose a model/);
  assert.match(harness.app.innerHTML, /class="onboarding-model-select-wrap"/);
  assert.match(harness.app.innerHTML, /class="ic onboarding-model-select-icon"/);
  assert.doesNotMatch(harness.app.innerHTML, /Recommended|default for Anthropic/);
  assert.match(harness.app.innerHTML, /data-action="onboarding-model-continue" disabled>Select Model<\/button>/);

  harness.listeners.change?.({
    target: inputTarget({ 'data-action': 'onboarding-model-select' }, 'anthropic/claude-sonnet-5'),
  });
  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'onboarding-model-continue' }),
  });
  await flushAsync();

  assert.equal(harness.onboardingTryPosts.at(-1)?.modelId, 'anthropic/claude-sonnet-5');
  assert.equal(harness.onboardingTryPosts.at(-1)?.expectedDefaultRevision, 2);
  assert.match(harness.app.innerHTML, /Try Chickpea/);
  assert.match(harness.app.innerHTML, /https:\/\/slack\.com\/app_redirect\?app=A_CHICKPEA&amp;team=T_DESIGN/);
  assert.match(harness.app.innerHTML, /Waiting for Chickpea to reply…/);
  assert.doesNotMatch(harness.app.innerHTML, /Waiting for Chickpea to reply&amp;hellip;/);
  assert.match(
    harness.app.innerHTML,
    /Give me three useful ways you can help me, each with an example prompt I could try next\./,
  );
  assert.match(harness.app.innerHTML, /data-action="onboarding-proceed-dashboard"[^>]*>Proceed to Dashboard<\/button>/);
  assert.match(harness.app.innerHTML, /Step 4 of 4/);
});

test('onboarding translates provider and model conflicts into recovery copy', async () => {
  const rejectedKey = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    providerKeyReject: { status: 401, detail: 'authentication_error: invalid x-api-key' },
    providers: [
      { id: 'anthropic', status: 'missing', modelCount: null },
      { id: 'openai', status: 'missing', modelCount: null, activeAuthMethod: 'api_key', subscription: { state: 'disconnected', updatedAt: 0 } },
      { id: 'openrouter', status: 'missing', modelCount: null },
      { id: 'workers-ai', status: 'env', modelCount: null, enabled: true },
    ],
    modelProviders: [
      { id: 'anthropic', configured: false, source: 'missing', suggestions: ['anthropic/claude-sonnet-5'] },
      { id: 'cloudflare', configured: true, source: 'Workers AI binding', suggestions: ['cloudflare/@cf/zai-org/glm-5.2'] },
    ],
    onboarding: {
      stage: 'choose_provider',
      revision: '{"version":2,"state":"active"}',
      workspace: { id: 'T_DESIGN', name: 'Acme Inc' },
      channel: null,
      slackAppId: 'A_CHICKPEA',
      tryStartedAt: null,
      completedAt: null,
    },
  });
  await flushAsync();

  rejectedKey.listeners.click?.({
    target: actionTarget({ 'data-action': 'onboarding-provider-select', 'data-provider': 'anthropic' }),
  });
  rejectedKey.listeners.input?.({
    target: inputTarget({ 'data-action': 'onboarding-provider-key', 'data-provider': 'anthropic' }, 'sk-ant-invalid'),
  });
  rejectedKey.listeners.click?.({
    target: actionTarget({ 'data-action': 'onboarding-provider-continue' }),
  });
  await flushAsync();

  assert.match(rejectedKey.app.innerHTML, /Anthropic rejected the key/);
  assert.doesNotMatch(rejectedKey.app.innerHTML, /provider_key_rejected/);

  const currentDefault: WorkspaceDefaultFixture = {
    workspaceId: 'T_DESIGN',
    modelId: 'openai/gpt-5.6',
    revision: 3,
    provenance: 'admin_selected',
    runtimeContract: 'chickpea-v1',
    live: true,
    inheritingAgentCount: 1,
    health: { status: 'ready', providerId: 'openai' },
  };
  const modelConflict = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    onboardingTryError: {
      status: 409,
      error: 'workspace_model_default_revision_conflict',
      workspaceDefault: { ...currentDefault, revision: currentDefault.revision + 1 },
    },
    modelProviders: [
      { id: 'anthropic', configured: true, source: 'stored', suggestions: ['anthropic/claude-sonnet-5'] },
    ],
    onboarding: {
      stage: 'choose_model',
      revision: '{"version":3,"state":"active"}',
      workspace: { id: 'T_DESIGN', name: 'Acme Inc' },
      channel: null,
      slackAppId: 'A_CHICKPEA',
      providerId: 'anthropic',
      modelId: null,
      tryStartedAt: null,
      completedAt: null,
    },
  });
  await flushAsync();

  modelConflict.listeners.change?.({
    target: inputTarget({ 'data-action': 'onboarding-model-select' }, 'anthropic/claude-sonnet-5'),
  });
  modelConflict.listeners.click?.({
    target: actionTarget({ 'data-action': 'onboarding-model-continue' }),
  });
  await flushAsync();

  assert.match(modelConflict.app.innerHTML, /workspace model changed in another window/i);
  assert.doesNotMatch(modelConflict.app.innerHTML, /workspace_model_default_revision_conflict/);
});

test('onboarding can finish from Try Chickpea without waiting for a Slack reply', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    agents: [seededAgents[0]],
    onboarding: {
      stage: 'try',
      revision: '{"version":2,"state":"active","tryStartedAt":1800000000000}',
      workspace: { id: 'T_DESIGN', name: 'Acme Inc' },
      channel: null,
      slackAppId: 'A_CHICKPEA',
      tryStartedAt: 1_800_000_000_000,
      completedAt: null,
      agentId: 'agent_chickpea',
    },
  });
  await flushAsync();

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'onboarding-proceed-dashboard' }) });
  await flushAsync();

  assert.deepEqual(harness.onboardingCompletePosts, [{
    expectedRevision: '{"version":2,"state":"active","tryStartedAt":1800000000000}',
  }]);
  assert.equal(harness.locationPath(), '/admin/agents');
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Agents<\/h1>/);
});

test('completed onboarding confirms the DM and hands off to the dashboard', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    onboarding: {
      stage: 'complete',
      revision: '{"version":1,"state":"complete"}',
      workspace: { id: 'T_DESIGN', name: 'Acme Inc' },
      channel: null,
      slackAppId: 'A_CHICKPEA',
      tryStartedAt: 1_800_000_000_000,
      completedAt: 1_800_000_005_000,
      agentId: 'agent_chickpea',
      redirectTo: '/admin/agents',
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Reply confirmed in Slack/);
  assert.match(harness.app.innerHTML, /<h1 class="onboarding-title">Chickpea is ready<\/h1>/);
  assert.doesNotMatch(harness.app.innerHTML, /aria-label="Admin navigation"/);
  assert.match(harness.app.innerHTML, /data-action="onboarding-open-dashboard"[^>]*>Open dashboard<\/button>/);
  assert.match(harness.app.innerHTML, /href="https:\/\/slack\.com\/app_redirect\?app=A_CHICKPEA&amp;team=T_DESIGN"/);
  assert.doesNotMatch(harness.app.innerHTML, /readonly value=|Copy message/);
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'onboarding-open-dashboard' }) });
  assert.match(harness.app.innerHTML, /aria-label="Admin navigation"/);
  assert.equal(harness.locationPath(), '/admin/agents');
});

test('admin page renders a credential-free recovery boundary when Slack is missing', async () => {
  const harness = runAdminPageHarness({
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Slack setup incomplete/);
  assert.match(harness.app.innerHTML, /private deployment setup link/);
  assert.match(harness.app.innerHTML, /Bot tokens are never pasted into Admin/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"|slack-connect-form|xoxb-/);
});

test('connected + zero channels shows the Slack destination with explicit workspace management', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    channelIndex: [],
    slackConnection: {
      connected: true,
      credentials: { botToken: 'env', signingSecret: 'env', botUserId: 'stored' },
      requestUrl: 'https://tag.example.dev/channels/slack/events',
      manifestUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%22a%22%3A1%7D',
    },
  });
  await flushAsync();

  // The legacy Channels URL opens the Channels tab; workspace controls are a
  // sibling tab within the same Slack destination.
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Slack<\/h1>/);
  assert.match(harness.app.innerHTML, /class="destination-tab active"[^>]*data-tab="channels">Channels<\/button>/);
  assert.match(harness.app.innerHTML, /No Channels yet/);
  assert.match(harness.app.innerHTML, /Publish an Agent to a Slack Channel/);
  assert.doesNotMatch(harness.app.innerHTML, /Add Channel/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);
  assert.doesNotMatch(harness.app.innerHTML, /Connect Slack/);
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'destination-tab', 'data-tab': 'connection' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Connected workspace/);
  assert.match(harness.app.innerHTML, /0 configured channels/);
  assert.match(harness.app.innerHTML, /Credentials managed by environment/);
});

test('admin page omits the connection card when the endpoint fails (resilience)', async () => {
  const harness = runAdminPageHarness({ assignments: [], slackConnection: null });
  await flushAsync();

  // Everything else still renders...
  assert.match(harness.app.innerHTML, /Slack settings are unavailable/);
  // ...but no wizard card is painted from a failed connection fetch: neither the
  // paste form nor either connection-card heading appears.
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);
  assert.doesNotMatch(harness.app.innerHTML, /Slack connection/);
});

// ---- Settings: model providers --------------------------------------------

function inputTarget(attributes: Record<string, string>, value: string): FakeTarget & { value: string } {
  return {
    value,
    closest(selector: string) {
      return selector === '[data-action]' ? this : null;
    },
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
  };
}

test('the persistent section switcher opens Settings on the model-providers page', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  assert.match(harness.app.innerHTML, /class="section-nav-item" data-action="open-settings"[^>]*>Settings<\/button>/);

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<h1 class="page-title">Settings<\/h1>/);
  assert.match(harness.app.innerHTML, /<h2 class="section-title">Model providers<\/h2>/);
  assert.equal(harness.locationPath(), '/admin/settings/providers');
  assert.match(harness.app.innerHTML, /class="section-nav-item active" data-action="open-settings"[^>]*aria-current="page">Settings<\/button>/);
  assert.match(harness.app.innerHTML, /data-settings-panel="providers"><section/);
  assert.match(harness.app.innerHTML, /data-settings-panel="github" hidden>/);
});

test('Settings places the live Workspace default before provider configuration', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/settings/providers' });
  await flushAsync();

  const html = harness.app.innerHTML;
  const defaultHeading = html.indexOf('id="workspace-default-heading">Default model</h2>');
  const providerHeading = html.indexOf('<h2 class="section-title">Model providers</h2>');
  assert.ok(defaultHeading >= 0 && providerHeading > defaultHeading);
  assert.match(html, /The shared model for Chickpea and every Agent that is not pinned/);
  assert.match(html, /Chickpea and 1 active Agent use this model/);
  assert.match(html, /<span class="badge-src">Live<\/span>/);
  assert.match(html, /Changes apply to the next admitted message, including replies in existing threads/);
  assert.match(html, /class="workspace-default-card workspace-default-shelf"/);
  assert.doesNotMatch(html, /Direct messages|\+ DMs|DM default/);
});

test('Settings saves the Workspace default optimistically and restores selector focus', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/providers',
    modelProviders: [{
      id: 'anthropic',
      configured: true,
      source: 'registered in src/app.ts',
      suggestions: ['anthropic/claude-sonnet-5'],
    }],
  });
  await flushAsync();
  const change = harness.listeners.change;
  const click = harness.listeners.click;
  assert.ok(change && click);

  change({
    target: valueTarget({ 'data-action': 'workspace-default-model' }, 'anthropic/claude-sonnet-5'),
  });
  click({ target: actionTarget({ 'data-action': 'workspace-default-save' }) });
  await flushAsync();

  assert.deepEqual(harness.workspaceDefaultPuts, [{
    modelId: 'anthropic/claude-sonnet-5',
    expectedRevision: 2,
  }]);
  assert.match(harness.app.innerHTML, /Workspace default saved\. New messages use it when their turn is admitted/);
  assert.match(harness.app.innerHTML, /<option value="anthropic\/claude-sonnet-5" selected>/);
  assert.equal(harness.focusedAction(), 'workspace-default-model');
});

test('a Workspace default conflict preserves the selected model and current revision', async () => {
  const current: WorkspaceDefaultFixture = {
    workspaceId: 'T_DESIGN',
    modelId: 'openai/gpt-5.6',
    revision: 3,
    provenance: 'admin_selected',
    runtimeContract: 'chickpea-v1',
    live: true,
    inheritingAgentCount: 2,
    health: { status: 'ready', providerId: 'openai' },
  };
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/providers',
    modelProviders: [{
      id: 'anthropic',
      configured: true,
      source: 'registered in src/app.ts',
      suggestions: ['anthropic/claude-sonnet-5'],
    }],
    workspaceDefaultPutError: {
      status: 409,
      error: 'workspace_model_default_revision_conflict',
      current,
    },
  });
  await flushAsync();
  const change = harness.listeners.change;
  const click = harness.listeners.click;
  assert.ok(change && click);

  change({
    target: valueTarget({ 'data-action': 'workspace-default-model' }, 'anthropic/claude-sonnet-5'),
  });
  click({ target: actionTarget({ 'data-action': 'workspace-default-save' }) });
  await flushAsync();

  assert.deepEqual(harness.workspaceDefaultPuts, [{
    modelId: 'anthropic/claude-sonnet-5',
    expectedRevision: 2,
  }]);
  assert.match(harness.app.innerHTML, /changed in another session\. Your selection is preserved/);
  assert.match(harness.app.innerHTML, /<option value="anthropic\/claude-sonnet-5" selected>/);
  assert.equal(harness.focusedAction(), 'workspace-default-model');

  click({ target: actionTarget({ 'data-action': 'workspace-default-save' }) });
  await flushAsync();
  assert.deepEqual(harness.workspaceDefaultPuts[1], {
    modelId: 'anthropic/claude-sonnet-5',
    expectedRevision: 3,
  });
});

test('Settings distinguishes pending activation and static provider repair', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/providers',
    workspaceDefault: {
      workspaceId: 'T_DESIGN',
      modelId: 'anthropic/claude-sonnet-5',
      revision: 1,
      provenance: 'migration_pending',
      runtimeContract: 'legacy',
      live: false,
      inheritingAgentCount: 0,
      health: {
        status: 'repair_required',
        providerId: 'anthropic',
        code: 'provider_unavailable',
        repairPath: '/admin/settings/providers',
      },
    },
  });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /<span class="badge-src">Pending activation<\/span>/);
  assert.match(html, /Slack keeps its legacy model routing until this workspace is activated/);
  assert.match(html, /Repair required/);
  assert.match(html, /href="\/admin\/settings\/providers">Review anthropic provider settings<\/a>/);
});

test('the left rail keeps one coherent section switcher and section-specific navigation', async () => {
  const harness = runAdminPageHarness({ usageAdminUi: true });
  await flushAsync();

  const initialSwitcher = harness.app.innerHTML.match(/<nav class="section-switcher" aria-label="Admin navigation">[\s\S]*?<\/nav>/)?.[0] ?? '';
  assert.doesNotMatch(initialSwitcher, />Sections</);
  assert.doesNotMatch(initialSwitcher, /Sessions|open-sessions/);
  assert.ok(initialSwitcher.indexOf('>Agents</button>') < initialSwitcher.indexOf('>Destinations</button>'));
  assert.ok(initialSwitcher.indexOf('>Destinations</button>') < initialSwitcher.indexOf('>Usage</button>'));
  assert.ok(initialSwitcher.indexOf('>Usage</button>') < initialSwitcher.indexOf('>Settings</button>'));

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-profiles', 'data-section-switcher': 'true' }) });
  assert.equal(harness.locationPath(), '/admin/agents/agent_release');
  assert.match(harness.app.innerHTML, /<aside class="rail primary-shell-sidebar agent-shell-sidebar">/);
  assert.match(harness.app.innerHTML, /class="agent-roster-item active" data-action="edit-profile" data-agent="agent_release"/);
  assert.match(harness.app.innerHTML, /class="section-nav-item active" data-action="open-profiles"/);

  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  assert.equal(harness.locationPath(), '/admin/agents/new');
  assert.equal(harness.app.className, 'frame primary-admin-shell admin-surface');
  assert.match(harness.app.innerHTML, /<aside class="rail primary-shell-sidebar agent-shell-sidebar">/);
  assert.match(harness.app.innerHTML, /data-action="new-profile"[^>]*>[^<]*<svg[\s\S]*?New Agent<\/button>/);

  click({ target: actionTarget({ 'data-action': 'open-team', 'data-section-switcher': 'true' }) });
  await flushAsync();
  assert.equal(harness.locationPath(), '/admin/team');
  assert.equal(harness.app.className, 'frame primary-admin-shell');
  assert.match(harness.app.innerHTML, /<nav class="rail primary-shell-sidebar" aria-label="Team">/);
  assert.match(harness.app.innerHTML, /class="primary-shell-brand[^"]*"[\s\S]*?Chickpea/);
  assert.match(harness.app.innerHTML, /<span class="chan-name">Members<\/span>/);
  assert.equal((harness.app.innerHTML.match(/aria-label="Admin navigation"/g) ?? []).length, 1);
  assert.doesNotMatch(harness.app.innerHTML, /cloudflare · workers|local · node/);

  click({ target: actionTarget({ 'data-action': 'open-usage', 'data-section-switcher': 'true' }) });
  await flushAsync();
  assert.equal(harness.locationPath(), '/admin/usage');
  assert.equal(harness.app.className, 'frame primary-admin-shell');
  assert.match(harness.app.innerHTML, /<nav class="rail primary-shell-sidebar" aria-label="Usage">/);
  assert.match(harness.app.innerHTML, /<span class="chan-name">Overview<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /<span class="chan-name">Model settings<\/span>/);

  click({ target: actionTarget({ 'data-action': 'open-settings', 'data-section-switcher': 'true' }) });
  await flushAsync();
  assert.equal(harness.locationPath(), '/admin/settings/providers');
  assert.equal(harness.app.className, 'frame primary-admin-shell');
  assert.match(harness.app.innerHTML, /<nav class="rail primary-shell-sidebar" aria-label="Settings">/);
  assert.match(harness.app.innerHTML, /class="chan-item active" data-action="settings-section" data-section="providers"/);

  click({ target: actionTarget({ 'data-action': 'settings-section', 'data-section': 'github' }) });
  assert.equal(harness.locationPath(), '/admin/settings/github');
  assert.match(harness.app.innerHTML, /class="chan-item active" data-action="settings-section" data-section="github"/);
  assert.match(harness.app.innerHTML, /data-settings-panel="providers" hidden>/);
  assert.match(harness.app.innerHTML, /data-settings-panel="github"><section/);
});

test('Settings Connectors configures managed integrations and manages connected accounts', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/settings/connections' });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/settings/connectors');
  assert.match(harness.app.innerHTML, /class="chan-item active" data-action="settings-section" data-section="connectors"/);
  assert.match(harness.app.innerHTML, /Some Chickpea connectors are managed by Composio/);
  assert.match(harness.app.innerHTML, /Settings &rarr; Project Settings &rarr; API Keys/);
  assert.match(
    harness.app.innerHTML,
    /leave OAuth user verification set to <strong>Not configured<\/strong>/,
  );
  assert.match(harness.app.innerHTML, /Google Sheets/);
  assert.match(harness.app.innerHTML, /YouTube/);
  assert.equal((harness.app.innerHTML.match(/class="managed-settings-row"/g) ?? []).length, 13);
  assert.match(harness.app.innerHTML, /Connected accounts/);
  assert.match(harness.app.innerHTML, /Support Zendesk/);
  assert.match(harness.app.innerHTML, /Customer support/);
  assert.match(harness.app.innerHTML, /data-action="edit-profile" data-agent="agent_release">Release Profile<\/button>/);
  assert.match(harness.app.innerHTML, /Reconnect or disconnect accounts here/);
  assert.match(harness.app.innerHTML, /<strong>YouTube<\/strong>[\s\S]*?Personal[\s\S]*?Needs attention/);
  assert.doesNotMatch(harness.app.innerHTML, /<strong>YouTube · Personal<\/strong>|<p class="hint">google<\/p>/);
  assert.match(harness.app.innerHTML, /data-action="connection-inventory-provider-setup"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="connection-inventory-reconnect"/);
  assert.equal((harness.app.innerHTML.match(/data-action="connection-account-revoke"/g) ?? []).length, 2);
  assert.doesNotMatch(harness.app.innerHTML, /Connect and add|connection-account-create/);

  const input = harness.listeners.input;
  const click = harness.listeners.click;
  assert.ok(input && click);
  const secret = 'ak_settings_secret_never_echo';
  input({ target: inputTarget({ 'data-action': 'connector-settings-key' }, secret) });
  click({ target: actionTarget({ 'data-action': 'connector-settings-save' }) });
  await flushAsync();

  assert.deepEqual(harness.composioSetupPosts, [{ projectKey: secret }]);
  assert.doesNotMatch(harness.app.innerHTML, new RegExp(secret));
  assert.match(harness.app.innerHTML, /Connected[\s\S]*?Replace project key[\s\S]*?Disable in Chickpea/);
  assert.match(harness.app.innerHTML, /data-action="connection-inventory-reconnect"/);

  click({
    target: actionTarget({
      'data-action': 'connection-inventory-reconnect',
      'data-connection-id': 'connection_youtube',
      'data-agent-id': 'agent_release',
    }),
  });
  await flushAsync();
  assert.deepEqual(harness.managedAuthorizationPosts.at(-1), {
    agentId: 'agent_release',
    body: { workspaceId: 'T_DESIGN', connectionAccountId: 'connection_youtube' },
  });
  assert.match(harness.app.innerHTML, /Connect YouTube · Personal/);

  const storageKey = 'chickpea.managed-authorization.v1:agent_release';
  const persisted = harness.sessionStorageValue(storageKey);
  assert.ok(persisted);
  assert.deepEqual(
    (({ returnToSettings, popupBlocked }) => ({ returnToSettings, popupBlocked }))(
      JSON.parse(persisted) as Record<string, unknown>,
    ),
    { returnToSettings: true, popupBlocked: false },
  );

  const refreshed = runAdminPageHarness({
    initialPath: '/admin/settings/connectors',
    initialSessionStorage: { [storageKey]: persisted },
    managedPollResult: { status: 'connected' },
  });
  await flushAsync();
  assert.equal(refreshed.locationPath(), '/admin/settings/connectors');
  assert.equal(refreshed.managedPollCalls(), 1);
  assert.match(refreshed.app.innerHTML, /YouTube · Personal is connected again\./);
  assert.equal(refreshed.sessionStorageValue(storageKey), null);
});

test('Settings Connectors keeps provider implementation details out of member-visible copy', async () => {
  const catalog = managedSettingsCatalogFixture();
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/connectors',
    composioSettings: {
      provider: {
        source: 'stored', configured: false, readOnly: false,
        desiredState: 'enabled', generation: 1, reconciliationPending: true,
        connectors: catalog.map((entry) => ({
          toolkit: entry.toolkit,
          status: 'setup_required' as const,
        })),
      },
      canConfigure: false,
      catalog,
    },
  });
  await flushAsync();

  const visibleText = harness.app.innerHTML.replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(visibleText, /composio/i);
  assert.match(visibleText, /owner or admin can enable managed connectors/i);
  assert.match(visibleText, /finishing connector reconciliation/i);
  assert.match(harness.app.innerHTML, /aria-label="Managed connectors"/);
  assert.doesNotMatch(harness.app.innerHTML, /aria-label="Composio-managed connectors"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="connector-settings-retry"/);
});

test('Settings Connectors lets an owner retry pending connector reconciliation', async () => {
  const catalog = managedSettingsCatalogFixture();
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/connectors',
    composioSettings: {
      provider: {
        source: 'stored', configured: true, readOnly: false,
        desiredState: 'enabled', generation: 2, reconciliationPending: true,
        connectors: catalog.map((entry) => ({
          toolkit: entry.toolkit,
          status: 'setup_required' as const,
        })),
      },
      canConfigure: true,
      impact: { accounts: 2, schedules: 1 },
      catalog,
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /finishing connector reconciliation/i);
  assert.match(harness.app.innerHTML, /data-action="connector-settings-retry"/);
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'connector-settings-retry' }) });
  await flushAsync();
  assert.equal(harness.composioRetryCalls(), 1);
});

test('managed sign-in actions persist their refreshed timeout and popup state', async () => {
  const storageKey = 'chickpea.managed-authorization.v1:agent_release';
  const originalStartedAt = Date.now() - 4 * 60_000;
  const saved = JSON.stringify({
    agentId: 'agent_release',
    toolkit: 'youtube',
    label: 'YouTube · Personal',
    authorizationUrl: 'https://connect.composio.dev/link/lk_resume',
    pollUrl: '/admin/api/agents/agent_release/connections/managed/poll',
    expiresAt: Date.now() + 20 * 60_000,
    startedAt: originalStartedAt,
    returnToSettings: true,
    popupBlocked: true,
  });
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/connectors',
    initialSessionStorage: { [storageKey]: saved },
  });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Your browser did not open the hosted sign-in tab/);

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'managed-auth-open' }) });
  click({ target: actionTarget({ 'data-action': 'managed-auth-retry' }) });
  await flushAsync();

  const updated = harness.sessionStorageValue(storageKey);
  assert.ok(updated);
  const parsed = JSON.parse(updated) as Record<string, unknown>;
  assert.equal(parsed.popupBlocked, false);
  assert.ok(Number(parsed.startedAt) > originalStartedAt);

  const refreshed = runAdminPageHarness({
    initialPath: '/admin/settings/connectors',
    initialSessionStorage: { [storageKey]: updated },
  });
  await flushAsync();
  assert.doesNotMatch(refreshed.app.innerHTML, /Your browser did not open the hosted sign-in tab/);
  assert.doesNotMatch(refreshed.app.innerHTML, /Sign-in needs attention/);
  assert.equal(refreshed.managedPollCalls(), 1);
});

test('Settings Connectors can repair an unavailable stored configuration', async () => {
  const catalog = managedSettingsCatalogFixture().map(({ access: _access, ...entry }) => entry);
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/connectors',
    composioSettingsError: {
      status: 503,
      error: 'composio_configuration_unavailable',
      message: 'The managed connector configuration needs attention.',
      recovery: { canConfigure: true, catalog },
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Configuration needs attention/);
  assert.match(harness.app.innerHTML, /type="password"/);
  assert.match(harness.app.innerHTML, /Validate and repair/);
  assert.match(harness.app.innerHTML, /Disable in Chickpea/);
  assert.equal((harness.app.innerHTML.match(/class="managed-settings-row"/g) ?? []).length, 13);

  const input = harness.listeners.input;
  const click = harness.listeners.click;
  assert.ok(input && click);
  const secret = 'ak_repair_secret_never_echo';
  input({ target: inputTarget({ 'data-action': 'connector-settings-key' }, secret) });
  click({ target: actionTarget({ 'data-action': 'connector-settings-save' }) });
  await flushAsync();
  assert.deepEqual(harness.composioSetupPosts, [{ projectKey: secret }]);
  assert.doesNotMatch(harness.app.innerHTML, new RegExp(secret));
});

test('Settings Connectors clears a stale provider card when a reload needs recovery', async () => {
  const catalog = managedSettingsCatalogFixture();
  const options: Parameters<typeof runAdminPageHarness>[0] = {
    initialPath: '/admin/settings/connectors',
    composioSettings: {
      provider: {
        source: 'stored', configured: true, readOnly: false,
        desiredState: 'enabled', generation: 2, reconciliationPending: false,
        connectors: catalog.map((entry) => ({ toolkit: entry.toolkit, status: 'ready' })),
      },
      canConfigure: true,
      impact: { accounts: 1, schedules: 0 },
      catalog,
    },
  };
  const harness = runAdminPageHarness(options);
  await flushAsync();
  assert.match(harness.app.innerHTML, /Connected/);

  options.composioSettingsError = {
    status: 503,
    error: 'composio_configuration_unavailable',
    message: 'The managed connector configuration needs attention.',
    recovery: {
      canConfigure: true,
      catalog: catalog.map(({ access: _access, ...entry }) => entry),
    },
  };
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'settings-section', 'data-section': 'github' }) });
  click({ target: actionTarget({ 'data-action': 'settings-section', 'data-section': 'connectors' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Configuration needs attention/);
  assert.match(harness.app.innerHTML, /Validate and repair/);
  assert.doesNotMatch(harness.app.innerHTML, /Replace project key/);
});

test('Settings Connectors keeps a neutral reload retry beside stale provider status', async () => {
  const catalog = managedSettingsCatalogFixture();
  const options: Parameters<typeof runAdminPageHarness>[0] = {
    initialPath: '/admin/settings/connectors',
    composioSettings: {
      provider: {
        source: 'stored', configured: true, readOnly: false,
        desiredState: 'enabled', generation: 2, reconciliationPending: false,
        connectors: catalog.map((entry) => ({ toolkit: entry.toolkit, status: 'ready' })),
      },
      canConfigure: true,
      impact: { accounts: 1, schedules: 0 },
      catalog,
    },
  };
  const harness = runAdminPageHarness(options);
  await flushAsync();
  assert.match(harness.app.innerHTML, /Connected/);

  options.composioSettingsError = {
    status: 500,
    error: 'temporary_settings_failure',
    message: 'Managed connector status is temporarily unavailable.',
  };
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'settings-section', 'data-section': 'github' }) });
  click({ target: actionTarget({ 'data-action': 'settings-section', 'data-section': 'connectors' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Connected/);
  assert.match(harness.app.innerHTML, /Managed connector status is temporarily unavailable/);
  assert.match(harness.app.innerHTML, /data-action="connector-settings-retry-load"/);
  assert.doesNotMatch(harness.app.innerHTML, /Configuration needs attention/);
});

test('Settings Connectors never renders a raw configuration error code', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/connectors',
    composioSettingsError: {
      status: 409,
      error: 'internal_provider_configuration_code',
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Could not load managed connector settings\./);
  assert.doesNotMatch(harness.app.innerHTML, /internal_provider_configuration_code/);
  assert.doesNotMatch(harness.app.innerHTML, /Configuration needs attention|Replace the stored project key|owner or admin can repair/i);
  assert.match(harness.app.innerHTML, /data-action="connector-settings-retry-load"/);
});

test('deployment-managed connector settings are visible but immutable in Admin', async () => {
  const deploymentCatalog = managedSettingsCatalogFixture().map((entry, index) => index === 0
    ? {
        ...entry,
        access: {
          read: { status: 'missing_configuration', missingConfiguration: ['auth_config_missing'] },
          write: { status: 'missing_configuration', missingConfiguration: ['auth_config_missing'] },
        },
      }
    : entry);
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/connectors',
    composioSettings: {
      provider: {
        source: 'deployment', configured: true, readOnly: true,
        desiredState: 'enabled', generation: 1, reconciliationPending: false,
        connectors: deploymentCatalog.map((entry, index) => ({
          toolkit: entry.toolkit,
          status: index === 0 ? 'setup_required' : 'ready',
        })),
      },
      canConfigure: true,
      impact: { accounts: 2, schedules: 1 },
      catalog: deploymentCatalog,
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Configured by deployment/);
  assert.match(harness.app.innerHTML, /cannot be replaced or disabled in Admin/);
  assert.match(harness.app.innerHTML, /Prepare connector defaults/);
  assert.doesNotMatch(harness.app.innerHTML, /id="connector-settings-key"|Replace project key|Disable in Chickpea/);
  assert.equal((harness.app.innerHTML.match(/class="managed-settings-row"/g) ?? []).length, 13);
});

test('deployment policy blocks do not offer connector preparation as a false fix', async () => {
  const catalog = managedSettingsCatalogFixture().map((entry) => entry.toolkit === 'googleads'
    ? {
        ...entry,
        access: {
          read: {
            status: 'missing_configuration',
            missingConfiguration: ['auth_config_missing', 'provider_prerequisite_missing'],
          },
          write: {
            status: 'missing_configuration',
            missingConfiguration: ['auth_config_missing', 'provider_prerequisite_missing'],
          },
        },
      }
    : entry);
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/connectors',
    composioSettings: {
      provider: {
        source: 'deployment', configured: true, readOnly: true,
        desiredState: 'enabled', generation: 1, reconciliationPending: false,
        connectors: catalog.map((entry) => ({
          toolkit: entry.toolkit,
          status: entry.toolkit === 'googleads' ? 'setup_required' : 'ready',
        })),
      },
      canConfigure: true,
      impact: { accounts: 0, schedules: 0 },
      catalog,
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Google Ads[\s\S]*?Blocked by deployment policy/);
  assert.doesNotMatch(harness.app.innerHTML, /Prepare connector defaults/);
});

test('invalid project keys stay masked and return an inline correction', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/connectors',
    composioSetupError: { status: 400, error: 'invalid_composio_project_key' },
  });
  await flushAsync();
  const input = harness.listeners.input;
  const click = harness.listeners.click;
  assert.ok(input && click);
  input({ target: inputTarget({ 'data-action': 'connector-settings-key' }, 'ak_invalid_test') });
  click({ target: actionTarget({ 'data-action': 'connector-settings-save' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /type="password"/);
  assert.match(harness.app.innerHTML, /That project key was not accepted/);
  assert.match(harness.app.innerHTML, /role="alert"/);
});

test('managed connector retry failures stay visible beside configured controls', async () => {
  const catalog = managedSettingsCatalogFixture();
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/connectors',
    composioSettings: {
      provider: {
        source: 'stored', configured: true, readOnly: false,
        desiredState: 'enabled', generation: 2, reconciliationPending: false,
        lastSetupResult: {
          status: 'partial', completedAt: 1_800_000_000_000,
          issueCodes: ['temporary_provider_failure'],
        },
        connectors: catalog.map((entry) => ({ toolkit: entry.toolkit, status: 'setup_required' })),
      },
      canConfigure: true,
      impact: { accounts: 1, schedules: 1 },
      catalog,
    },
    composioRetryError: {
      status: 503,
      error: 'composio_reconciliation_incomplete',
      message: 'Composio is temporarily unavailable. Try again.',
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  assert.match(harness.app.innerHTML, /Retry setup/);

  click({ target: actionTarget({ 'data-action': 'connector-settings-retry' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /role="alert"[\s\S]*?Composio is temporarily unavailable\. Try again\./);
  assert.match(harness.app.innerHTML, /Replace project key/);
  assert.match(harness.app.innerHTML, /Disable in Chickpea/);
});

test('shared Slack settings expose a direct authorization recovery without reopening setup', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack',
    slackConnection: {
      ...connectedSlackFixture(),
      transportMode: 'gateway',
      credentials: { botToken: 'gateway', signingSecret: 'gateway', botUserId: 'gateway' },
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Reconnect the shared Slack app/);
  assert.match(harness.app.innerHTML, /data-action="slack-gateway-refresh"/);
  assert.doesNotMatch(harness.app.innerHTML, /method="post" action="\/admin\/slack-gateway\/refresh"/);
  assert.doesNotMatch(harness.app.innerHTML, /href="\/admin\/slack-gateway\/reconnect"/);
  assert.match(harness.app.innerHTML, /Reconnect with Slack/);
  assert.match(harness.app.innerHTML, /without changing Agents, Channel grants, or saved settings/);
  assert.match(harness.app.innerHTML, /encrypted access only for managing Agent user groups/);
  assert.match(harness.app.innerHTML, /reconnect as another current Owner or Admin/);

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'slack-gateway-refresh' }) });
  await flushAsync();
  assert.deepEqual(harness.assignedUrls, ['https://gateway.example/install/claim_refresh']);
});

test('leaving Slack settings starts the GitHub, sandbox, and outbound settings loads', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack',
    githubStatus: { mode: 'none', referencingProfiles: [] },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'settings-section', 'data-section': 'github' }) });
  await flushAsync();
  const initializedSettingsGets = [...harness.settingsGetCalls];
  assert.doesNotMatch(harness.app.innerHTML, /Loading GitHub settings/);
  assert.match(harness.app.innerHTML, /data-action="github-manifest-open"/);

  click({ target: actionTarget({ 'data-action': 'settings-section', 'data-section': 'sandbox' }) });
  assert.doesNotMatch(harness.app.innerHTML, /Loading sandbox settings/);
  assert.match(harness.app.innerHTML, /Not installed|Unsupported on Node/);

  click({ target: actionTarget({ 'data-action': 'settings-section', 'data-section': 'outbound' }) });
  assert.doesNotMatch(harness.app.innerHTML, /Loading outbound policy/);
  assert.match(harness.app.innerHTML, /data-action="egress-save"/);
  assert.deepEqual(harness.settingsGetCalls, initializedSettingsGets);
});

test('leaving Settings while its shared loads are pending ignores their stale completions', async () => {
  const pending = new Map<string, (response: FakeResponse) => void>();
  const deferredPaths = new Set([
    '/admin/api/providers',
    '/admin/api/github/status',
    '/admin/api/egress',
    '/admin/api/sandbox/status',
  ]);
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack',
    settingsLoadFetch(path, method) {
      if (method !== 'GET' || !deferredPaths.has(path)) return undefined;
      return new Promise<FakeResponse>((resolve) => pending.set(path, resolve));
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'settings-section', 'data-section': 'github' }) });
  assert.equal(pending.size, deferredPaths.size);
  click({ target: actionTarget({ 'data-action': 'settings-section', 'data-section': 'slack' }) });
  await flushAsync();
  const renderCountAfterLeaving = harness.renderHistory.length;

  pending.get('/admin/api/providers')?.(jsonResponse({ providers: [] }));
  pending.get('/admin/api/github/status')?.(jsonResponse({ mode: 'none', referencingProfiles: [] }));
  pending.get('/admin/api/egress')?.(jsonResponse({ policy: { mode: 'allowlist', domains: [] } }));
  pending.get('/admin/api/sandbox/status')?.(jsonResponse({
    installRequested: false,
    installed: false,
    storedEnabled: false,
    enabled: false,
    instanceType: 'standard-1',
    allowedHosts: [],
    monthlySessionCap: 0,
    monthlySessionCapConfigured: false,
    target: 'node',
    githubConnected: false,
    repositoryGrantReady: false,
    unmetPrerequisites: ['cloudflare_target'],
    workersPaidNote: null,
  }));
  await flushAsync();

  assert.equal(harness.renderHistory.length, renderCountAfterLeaving);
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Slack<\/h1>/);
  assert.match(harness.app.innerHTML, /class="destination-rail-item active" data-action="open-destinations"/);
});

test('the unified primary shell lets its white paper grow with content and collapses on mobile', () => {
  const page = renderAdminPage();
  assert.match(page, /\.primary-admin-shell\s*\{[^}]*background:\s*var\(--admin-visual-canvas\);[^}]*height:\s*auto;[^}]*min-height:\s*100dvh;[^}]*overflow:\s*visible;[^}]*max-width:\s*none;/s);
  assert.match(page, /\.primary-admin-shell > \.topbar\s*\{[^}]*display:\s*none;/s);
  assert.match(page, /\.primary-admin-shell \.body\s*\{[^}]*align-items:\s*flex-start;[^}]*gap:\s*24px;[^}]*overflow:\s*visible;[^}]*padding:\s*0 24px 0 0;/s);
  assert.match(page, /\.primary-admin-shell \.primary-shell-sidebar\s*\{[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;[^}]*height:\s*100dvh;[^}]*max-height:\s*100dvh;[^}]*overflow:\s*hidden;[^}]*position:\s*sticky;[^}]*width:\s*292px;/s);
  assert.match(page, /\.primary-admin-shell \.main\s*\{[^}]*background:\s*var\(--admin-visual-paper\);[^}]*height:\s*auto;[^}]*margin:\s*22px auto;[^}]*max-height:\s*none;[^}]*min-height:\s*calc\(100dvh - 44px\);[^}]*overflow:\s*visible;[^}]*max-width:\s*1440px;[^}]*width:\s*100%;/s);
  assert.match(page, /\.team-main\s*\{[^}]*max-width:\s*760px;/s);
  assert.match(page, /\.usage-main\s*\{[^}]*max-width:\s*1100px;/s);
  assert.match(page, /@media \(max-width: 1000px\)[\s\S]*?\.primary-admin-shell \.body\s*\{[^}]*gap:\s*15px;[^}]*padding-right:\s*15px;[^}]*\}[\s\S]*?\.primary-admin-shell \.primary-shell-sidebar\s*\{[^}]*width:\s*228px;/s);
  assert.match(page, /@media \(max-width: 740px\)[\s\S]*?\.primary-admin-shell > \.topbar\s*\{[^}]*display:\s*flex;[^}]*\}[\s\S]*?\.primary-admin-shell \.body\s*\{[^}]*gap:\s*0;[^}]*padding-right:\s*0;[^}]*\}[\s\S]*?\.primary-admin-shell \.primary-shell-sidebar\s*\{[^}]*display:\s*none;/s);
});

test('primary-shell navigation starts each destination at the top of the document', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/agents/agent_release' });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  harness.setDocumentScrollTop(1600);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  assert.equal(harness.locationPath(), '/admin/settings/providers');
  assert.equal(harness.documentScrollTop(), 0);
});

test('initial deep-link routing leaves browser-restored document position intact', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/agents/agent_release' });
  harness.setDocumentScrollTop(900);

  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/agents/agent_release');
  assert.equal(harness.documentScrollTop(), 900);
});

test('an Agent schedules deep link opens the schedules tab and keeps tab navigation canonical', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    initialSearch: '?tab=schedules',
  });
  await flushAsync();

  assert.match(
    harness.app.innerHTML,
    /id="ptab-schedules" class="ptab on" role="tab" aria-selected="true"/,
  );
  assert.match(harness.app.innerHTML, /<h3>Schedules<\/h3>/);

  const click = harness.listeners.click;
  assert.ok(click);
  click({
    target: actionTarget({
      'data-action': 'profile-tab',
      'data-tab': 'memory',
    }),
  });
  assert.equal(harness.historyReplaces.at(-1), '/admin/agents/agent_release?tab=memory');
});

test('deep-linked Scheduled Work summaries preserve the underlying list position', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/audit-logs/scheduled-work' });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  harness.setDocumentScrollTop(900);
  click({
    target: actionTarget({
      'data-action': 'select-scheduled-routine',
      'data-routine': 'routine_release_digest',
    }),
  });
  await flushAsync();
  assert.equal(harness.locationPath(), '/admin/audit-logs/scheduled-work/routine_release_digest');
  assert.equal(harness.documentScrollTop(), 900);

  click({ target: actionTarget({ 'data-action': 'scheduled-summary-close' }) });
  assert.equal(harness.locationPath(), '/admin/audit-logs/scheduled-work');
  assert.equal(harness.documentScrollTop(), 900);
});

test('the server first paint uses the modern attached shell while Admin data loads', () => {
  const firstPaint = renderAdminPage().split('<script>')[0] ?? '';

  assert.match(firstPaint, /<div id="app" class="frame primary-admin-shell" aria-busy="true">/);
  assert.match(firstPaint, /<nav class="rail primary-shell-sidebar" aria-label="Loading Chickpea">/);
  assert.match(firstPaint, /<details class="topbar-menu"><summary aria-label="Menu"/);
  assert.match(firstPaint, /<div class="actions actions-list">[\s\S]*?Loading workspace/);
  assert.match(firstPaint, /<main class="main"><div class="main-inner"><div class="empty" role="status">/);
  assert.doesNotMatch(firstPaint, /<div id="app" class="frame">\s*<header class="topbar">/s);
  assert.doesNotMatch(firstPaint, /<button type="button" class="btn btn-soft" disabled>Agents<\/button>/);
});

test('model controls omit the long Workers AI compaction warning', async () => {
  const workersAiAgent = { ...releaseAgent, model: 'cloudflare/@cf/zai-org/glm-5.2' };
  const harness = runAdminPageHarness({ cloudflare: true, agents: [workersAiAgent] });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': releaseAgent.id }) });
  assert.match(harness.app.innerHTML, /cloudflare\/@cf\/zai-org\/glm-5\.2/);
  assert.doesNotMatch(harness.app.innerHTML, /declares no context window|auto-compaction is off|long threads grow unbounded|Pin a catalog model/);

  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  assert.doesNotMatch(harness.app.innerHTML, /declares no context window|auto-compaction is off|long threads grow unbounded|Pin a catalog model/);
});

test('the selected Agent roster pill uses only its soft background for emphasis', () => {
  const page = renderAdminPage();
  assert.match(page, /\.agent-roster-item\.active\s*\{\s*background:\s*#f4e8cc;\s*\}/s);
  assert.doesNotMatch(page, /\.agent-roster-item\.active\s*\{[^}]*box-shadow:/s);
});

test('legacy Sessions page URLs return to the default Agent without loading Run data', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/sessions/run_session_fixture' });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/agents/agent_release');
  assert.match(harness.app.innerHTML, /<aside class="rail primary-shell-sidebar agent-shell-sidebar">/);
  assert.doesNotMatch(harness.app.innerHTML, /Sessions|open-sessions|Run inspector/);
});

test('Settings labels the revision as compatibility rules and refreshes it on demand', async () => {
  const harness = runAdminPageHarness({
    modelCatalogStatus: {
      mode: 'hosted',
      source: 'hosted',
      revision: 12,
      generatedAt: '2026-07-29T20:00:00Z',
      checkedAt: 1_785_355_200_000,
      nextRefreshAt: 1_785_376_800_000,
      lkgAvailable: true,
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /<span class="model-catalog-copy">Compatibility rules up to date/);
  assert.match(html, /Compatibility rules up to date &middot; revision 12/);
  assert.match(html, /data-action="model-catalog-refresh"[^>]*>[\s\S]*Refresh<\/button>/);
  assert.doesNotMatch(html, /experimental|I understand|risk warning/i);

  click({ target: actionTarget({ 'data-action': 'model-catalog-refresh' }) });
  await flushAsync();
  await flushAsync();
  assert.equal(harness.modelCatalogRefreshCalls(), 1);
  assert.match(harness.app.innerHTML, /Compatibility rules up to date &middot; revision 12/);
});

test('a stale model-list status response cannot overwrite a completed refresh', async () => {
  const currentStatus: ModelCatalogStatusFixture = {
    mode: 'hosted',
    source: 'hosted',
    revision: 12,
    generatedAt: '2026-07-29T20:00:00Z',
    checkedAt: 1_785_355_200_000,
    nextRefreshAt: 1_785_376_800_000,
    lkgAvailable: true,
  };
  const harness = runAdminPageHarness({
    modelCatalogStatus: currentStatus,
    deferModelCatalogStatus: true,
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'model-catalog-refresh' }) });
  await flushAsync();
  await flushAsync();
  assert.match(harness.app.innerHTML, /Compatibility rules up to date &middot; revision 12/);

  harness.resolveModelCatalogStatus({
    ...currentStatus,
    revision: 3,
    generatedAt: '2026-07-01T20:00:00Z',
  });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Compatibility rules up to date &middot; revision 12/);
  assert.doesNotMatch(harness.app.innerHTML, /revision 3/);
});

test('Settings renders Coding sandbox as unsupported on Node with no misleading install or enable control', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /<h2 class="section-title">Coding sandbox<\/h2>/);
  assert.match(html, /Unsupported on Node/);
  assert.match(html, /standard in-memory bash sandbox/);
  assert.doesNotMatch(html, /data-action="sandbox-install-open"/);
  assert.doesNotMatch(html, /data-action="sandbox-enable-open"/);
  assert.doesNotMatch(html, /data-action="sandbox-enabled"/);
});

test('Settings requests a paid Sandbox install, hands off one Cloudflare variable, and supports check or cancel', async () => {
  const harness = runAdminPageHarness({ cloudflare: true });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Not installed in this deployment/);
  assert.match(harness.app.innerHTML, /Container application or image from an earlier install may still remain/);
  assert.match(harness.app.innerHTML, /data-action="sandbox-install-open"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="sandbox-enable-open"/);

  click({ target: actionTarget({ 'data-action': 'sandbox-install-open' }) });
  assert.match(harness.app.innerHTML, /Install coding sandbox\?/);
  assert.match(harness.app.innerHTML, /role="dialog" aria-modal="true" aria-label="Install coding sandbox"/);
  assert.equal(harness.topbarRegion.inert, true);
  assert.equal(harness.bodyRegion.inert, true);
  assert.match(harness.app.innerHTML, /Requires Cloudflare Workers Paid/);
  assert.match(harness.app.innerHTML, /first image build can take several minutes/);
  assert.match(harness.app.innerHTML, /Disabling later does not remove the Container application or image/);
  click({ target: actionTarget({ 'data-action': 'sandbox-install-confirm' }) });
  assert.match(harness.app.innerHTML, /Requesting&hellip;/);
  assert.match(harness.app.innerHTML, /role="status" aria-live="polite">Requesting installation\./);
  await flushAsync();

  assert.deepEqual(harness.sandboxInstallCalls, ['POST']);
  assert.match(harness.app.innerHTML, /Redeploy required/);
  assert.match(harness.app.innerHTML, /Workers &amp; Pages.*your Worker.*Settings.*Builds.*Variables/);
  assert.match(harness.app.innerHTML, /CHICKPEA_DEPLOY_PROFILE/);
  assert.match(harness.app.innerHTML, /sandbox/);
  assert.match(harness.app.innerHTML, /Retry deployment/);
  assert.match(harness.app.innerHTML, /start a fresh dashboard build/);
  assert.match(harness.app.innerHTML, /npm run deploy:sandbox/);
  assert.match(harness.app.innerHTML, /Chickpea cannot redeploy itself/);
  assert.match(harness.app.innerHTML, /data-action="sandbox-check-again"/);
  assert.match(harness.app.innerHTML, /data-action="sandbox-cancel-install"/);

  click({ target: actionTarget({ 'data-action': 'sandbox-copy-profile' }) });
  await flushAsync();
  assert.deepEqual(harness.clipboardWrites, ['CHICKPEA_DEPLOY_PROFILE=sandbox']);
  assert.match(harness.app.innerHTML, /Sandbox build variable copied/);

  click({ target: actionTarget({ 'data-action': 'sandbox-check-again' }) });
  assert.match(harness.app.innerHTML, /role="status" aria-live="polite">Checking the live deployment\./);
  await flushAsync();
  assert.match(harness.app.innerHTML, /role="status" aria-live="polite">No Sandbox binding yet/);

  click({ target: actionTarget({ 'data-action': 'sandbox-cancel-install' }) });
  await flushAsync();
  assert.deepEqual(harness.sandboxInstallCalls, ['POST', 'DELETE']);
  assert.match(harness.app.innerHTML, /Installation request canceled/);
  assert.match(harness.app.innerHTML, /Not installed in this deployment/);
});

test('installed Sandbox gates enablement on GitHub and grants, then requires a readiness attestation', async () => {
  const installedBase: SandboxStatusFixture = {
    installRequested: true,
    installed: true,
    storedEnabled: false,
    enabled: false,
    instanceType: 'standard-1',
    allowedHosts: ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'],
    monthlySessionCap: 200,
    monthlySessionCapConfigured: true,
    target: 'cloudflare',
    githubConnected: false,
    repositoryGrantReady: false,
    unmetPrerequisites: ['github_app', 'repository_grant'],
    workersPaidNote: 'server copy <must be escaped>',
  };
  const missingGithub = runAdminPageHarness({ cloudflare: true, sandboxStatus: installedBase });
  await flushAsync();
  missingGithub.listeners.click?.({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();
  assert.match(missingGithub.app.innerHTML, /Installed but off/);
  assert.match(missingGithub.app.innerHTML, /data-action="open-settings" data-section="github-settings">Connect GitHub/);
  assert.doesNotMatch(missingGithub.app.innerHTML, /data-action="sandbox-enable-open"/);
  assert.match(missingGithub.app.innerHTML, /server copy &lt;must be escaped&gt;/);

  const missingGrant = runAdminPageHarness({
    cloudflare: true,
    sandboxStatus: {
      ...installedBase,
      githubConnected: true,
      unmetPrerequisites: ['repository_grant'],
    },
  });
  await flushAsync();
  missingGrant.listeners.click?.({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();
  assert.match(missingGrant.app.innerHTML, /data-action="open-profiles">Manage repository access/);
  assert.doesNotMatch(missingGrant.app.innerHTML, /data-action="sandbox-enable-open"/);

  const ready = runAdminPageHarness({
    cloudflare: true,
    sandboxStatus: {
      ...installedBase,
      githubConnected: true,
      repositoryGrantReady: true,
      unmetPrerequisites: [],
    },
  });
  await flushAsync();
  const click = ready.listeners.click;
  const change = ready.listeners.change;
  assert.ok(click && change);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();
  assert.match(ready.app.innerHTML, /data-action="sandbox-enable-open"/);
  assert.match(ready.app.innerHTML, /<details class="advanced"><summary>Advanced<\/summary>/);

  click({ target: actionTarget({ 'data-action': 'sandbox-enable-open' }) });
  assert.match(ready.app.innerHTML, /Enable coding sandbox\?/);
  assert.match(ready.app.innerHTML, /Cloudflare dashboard.*Containers.*Container applications/);
  assert.match(ready.app.innerHTML, /data-action="sandbox-ready-attestation"/);
  assert.match(ready.app.innerHTML, /data-action="sandbox-enable-confirm" disabled/);
  change({ target: valueTarget({ 'data-action': 'sandbox-ready-attestation' }, '', true) });
  assert.doesNotMatch(ready.app.innerHTML, /data-action="sandbox-enable-confirm" disabled/);
  click({ target: actionTarget({ 'data-action': 'sandbox-enable-confirm' }) });
  assert.match(ready.app.innerHTML, /Enabling&hellip;/);
  await flushAsync();
  assert.deepEqual(ready.sandboxPuts, [{
    enabled: true,
    readinessConfirmed: true,
    allowedHosts: ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org'],
    monthlySessionCap: 200,
  }]);
  assert.match(ready.app.innerHTML, />On</);
});

test('On/setup-required is truthful, keeps prerequisite as the primary action, and disables immediately', async () => {
  const harness = runAdminPageHarness({
    cloudflare: true,
    sandboxStatus: {
      installRequested: true,
      installed: true,
      storedEnabled: true,
      enabled: true,
      instanceType: 'standard-1',
      allowedHosts: ['registry.npmjs.org'],
      monthlySessionCap: 200,
      monthlySessionCapConfigured: true,
      target: 'cloudflare',
      githubConnected: false,
      repositoryGrantReady: false,
      unmetPrerequisites: ['github_app', 'repository_grant'],
      workersPaidNote: 'Requires Workers Paid.',
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /On, setup required/);
  assert.match(harness.app.innerHTML, /data-action="open-settings" data-section="github-settings">Connect GitHub/);
  assert.match(harness.app.innerHTML, /data-action="sandbox-disable"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="sandbox-enable-open"/);

  click({ target: actionTarget({ 'data-action': 'sandbox-disable' }) });
  assert.match(harness.app.innerHTML, /Disabling&hellip;/);
  await flushAsync();
  assert.deepEqual(harness.sandboxPuts, [{
    enabled: false,
    allowedHosts: ['registry.npmjs.org'],
    monthlySessionCap: 200,
  }]);
  assert.match(harness.app.innerHTML, /Installed but off/);
  assert.match(harness.app.innerHTML, /Container application and image remain/);
});

test('Saving Sandbox advanced settings never replays cached runtime enablement', async () => {
  const harness = runAdminPageHarness({
    cloudflare: true,
    sandboxStatus: {
      installRequested: true,
      installed: true,
      storedEnabled: true,
      enabled: true,
      instanceType: 'standard-1',
      allowedHosts: ['registry.npmjs.org'],
      monthlySessionCap: 200,
      monthlySessionCapConfigured: true,
      target: 'cloudflare',
      githubConnected: true,
      repositoryGrantReady: true,
      unmetPrerequisites: [],
      workersPaidNote: 'Requires Workers Paid.',
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  // A second tab can disable the runtime after this tab loaded its cached
  // storedEnabled=true status. Saving this tab's advanced draft must not write
  // either runtime field back.
  change({ target: valueTarget({ 'data-action': 'sandbox-host', 'data-host': 'pypi.org' }, '', true) });
  click({ target: actionTarget({ 'data-action': 'sandbox-save' }) });
  await flushAsync();

  assert.deepEqual(harness.sandboxPuts, []);
  assert.deepEqual(harness.sandboxAdvancedPatches, [{
    allowedHosts: ['registry.npmjs.org', 'pypi.org'],
    monthlySessionCap: 200,
  }]);
});

test('a stale saved On state after core rollback is visible and must be cleared before reinstalling', async () => {
  const harness = runAdminPageHarness({
    cloudflare: true,
    sandboxStatus: {
      installRequested: false,
      installed: false,
      storedEnabled: true,
      enabled: false,
      instanceType: 'standard-1',
      allowedHosts: ['registry.npmjs.org'],
      monthlySessionCap: 200,
      monthlySessionCapConfigured: true,
      target: 'cloudflare',
      githubConnected: true,
      repositoryGrantReady: true,
      unmetPrerequisites: ['sandbox_binding'],
      workersPaidNote: 'Requires Workers Paid.',
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Not installed; saved On state/);
  assert.match(harness.app.innerHTML, /Clear saved state/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="sandbox-install-open"/);

  click({ target: actionTarget({ 'data-action': 'sandbox-cancel-install' }) });
  await flushAsync();

  assert.deepEqual(harness.sandboxInstallCalls, ['DELETE']);
  assert.match(harness.app.innerHTML, /Saved Sandbox state cleared/);
  assert.match(harness.app.innerHTML, /data-action="sandbox-install-open"/);
});

for (const clipboard of ['missing', 'reject', 'throw'] as const) {
  test(`Sandbox build-variable copy selects the attached input when clipboard is ${clipboard}`, async () => {
    const harness = runAdminPageHarness({ cloudflare: true, clipboard });
    await flushAsync();
    const click = harness.listeners.click;
    assert.ok(click);
    click({ target: actionTarget({ 'data-action': 'open-settings' }) });
    await flushAsync();
    click({ target: actionTarget({ 'data-action': 'sandbox-install-open' }) });
    click({ target: actionTarget({ 'data-action': 'sandbox-install-confirm' }) });
    await flushAsync();

    click({ target: actionTarget({ 'data-action': 'sandbox-copy-profile' }) });
    await flushAsync();

    assert.match(harness.app.innerHTML, /Clipboard access was unavailable/);
    assert.equal(harness.sandboxBuildVariableSelectedAttached(), true);
  });
}

test('Sandbox mutation errors are accessible, escaped, and leave the last confirmed state visible', async () => {
  const harness = runAdminPageHarness({
    cloudflare: true,
    sandboxMutationError: {
      status: 503,
      error: 'sandbox_unavailable',
      message: 'Retry <script>alert(1)</script>',
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'sandbox-install-open' }) });
  click({ target: actionTarget({ 'data-action': 'sandbox-install-confirm' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /role="alert" aria-live="assertive"/);
  assert.match(harness.app.innerHTML, /Retry &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(harness.app.innerHTML, /Retry <script>/);
  assert.match(harness.app.innerHTML, /Not installed in this deployment/);
});

test('Settings omits the redundant always-on channel memory status block', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  assert.doesNotMatch(harness.app.innerHTML, /<h2 class="section-title">Channel memory<\/h2>/);
  assert.doesNotMatch(harness.app.innerHTML, /Explicit channel memory is available wherever the live Slack scope is eligible/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="memory-enabled"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="memory-save"/);
  assert.doesNotMatch(harness.app.innerHTML, /SLACK_TAG_MEMORY_ENABLED/);
});

test('legacy Channel-memory deep links land on Scheduled Work', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/mem_release',
  });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/audit-logs/scheduled-work');
  assert.match(harness.app.innerHTML, /Audit logs/);
  assert.match(harness.app.innerHTML, /Scheduled work/);
  assert.match(harness.app.innerHTML, /Network events/);
  assert.match(harness.app.innerHTML, /data-action="audit-tab-scheduled">Scheduled work/);
  assert.match(harness.app.innerHTML, /role="tab" disabled aria-disabled="true" title="Coming later">Network events/);
  assert.doesNotMatch(harness.app.innerHTML, /Memory|release-guidance\.md|Review requested/);
});

test('Audit navigation no longer exposes Channel-memory scopes', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/MEMORY.md',
  });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/audit-logs/scheduled-work');
  assert.doesNotMatch(harness.app.innerHTML, /audit-channel-marker|memory-private-acceptance|release-guidance/);
});

test('Scheduled Work matches the compact audit inventory before loading routine-specific detail', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/scheduled-work',
  });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/audit-logs/scheduled-work');
  assert.match(harness.app.innerHTML, /View scheduled routines and keep track of all scheduled work/);
  assert.match(harness.app.innerHTML, /<th>Name<\/th><th>Scope<\/th><th>Schedule<\/th><th>Status<\/th><th>Last run<\/th><th>Next run<\/th>/);
  assert.match(harness.app.innerHTML, /data-action="scheduled-filter-scope"/);
  assert.match(harness.app.innerHTML, /data-action="scheduled-filter-state"/);
  assert.match(harness.app.innerHTML, /<option value="current" selected>Current<\/option>/);
  assert.match(harness.app.innerHTML, /<span class="chan-name">Current routines<\/span>/);
  assert.ok(harness.scheduledApiCalls.some((path) => path.includes('state=current')));
  assert.doesNotMatch(harness.app.innerHTML, /data-action="scheduled-filter-workspace"/);
  assert.match(harness.app.innerHTML, /Release readiness check/);
  assert.match(harness.app.innerHTML, /Channel: #eng-releases/);
  assert.match(harness.app.innerHTML, /weekdays at 9:00 AM/);
  assert.match(harness.app.innerHTML, /View details/);
  assert.match(harness.app.innerHTML, /data-action="scheduled-list-control" data-control="pause"/);
  assert.match(harness.app.innerHTML, /Showing 1&ndash;1 of 1/);
  assert.doesNotMatch(harness.app.innerHTML, /Deployment-wide scheduling/);
  assert.doesNotMatch(harness.app.innerHTML, /Occurrences/);
  assert.doesNotMatch(harness.app.innerHTML, /Revision history/);
  assert.doesNotMatch(harness.app.innerHTML, /Audit trail/);

  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'select-scheduled-routine',
      'data-routine': 'routine_release_digest',
    }),
  });
  await flushAsync();

  assert.equal(
    harness.locationPath(),
    '/admin/audit-logs/scheduled-work/routine_release_digest',
  );
  assert.match(harness.app.innerHTML, /role="dialog" aria-modal="true" aria-labelledby="scheduled-summary-title"/);
  assert.match(harness.app.innerHTML, /<span class="field-label">Prompt<\/span>/);
  assert.match(harness.app.innerHTML, /<span class="field-label">Schedule<\/span>/);
  assert.match(harness.app.innerHTML, /<span class="field-label">Status<\/span>/);
  assert.match(harness.app.innerHTML, /<span class="field-label">Last run<\/span>/);
  assert.match(harness.app.innerHTML, /<span class="field-label">Next run<\/span>/);
  assert.match(harness.app.innerHTML, /<span class="field-label">Created<\/span>/);
  assert.match(harness.app.innerHTML, /View run history and activity/);
  assert.doesNotMatch(harness.app.innerHTML, /Source Slack request/);
  assert.doesNotMatch(harness.app.innerHTML, /One independent Flue Workflow run per trigger/);
});

test('Scheduled Work ignores private DM health even if an obsolete server includes it', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/scheduled-work',
    scheduledPrivateHealth: [{
      owner: { agentId: 'agent_private_owner', displayName: 'Private Work Agent' },
      state: 'paused',
      nextRunAt: 1_785_168_000_000,
      lastFinishedAt: 1_785_081_600_000,
      lastRun: {
        scheduledFor: 1_785_081_540_000,
        startedAt: 1_785_081_550_000,
        finishedAt: 1_785_081_600_000,
        status: 'failed',
        deliveryStatus: 'rejected',
        failureClass: 'delivery_thread_rejected',
      },
      routineId: 'PRIVATE_ROUTINE_ID_MUST_NOT_RENDER',
      runId: 'PRIVATE_RUN_ID_MUST_NOT_RENDER',
      taskText: 'PRIVATE_TASK_MUST_NOT_RENDER',
      name: 'PRIVATE_NAME_MUST_NOT_RENDER',
      channelId: 'PRIVATE_DM_MUST_NOT_RENDER',
      threadTs: 'PRIVATE_THREAD_MUST_NOT_RENDER',
    }],
  });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.doesNotMatch(html, /Private DM schedule health|Operational status only|Private Work Agent|agent_private_owner|delivery thread rejected/);
  assert.doesNotMatch(html, /PRIVATE_ROUTINE_ID_MUST_NOT_RENDER|PRIVATE_RUN_ID_MUST_NOT_RENDER|PRIVATE_TASK_MUST_NOT_RENDER|PRIVATE_NAME_MUST_NOT_RENDER|PRIVATE_DM_MUST_NOT_RENDER|PRIVATE_THREAD_MUST_NOT_RENDER/);
});

test('Scheduled Work status filter defaults to Current and reloads explicit states', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/scheduled-work',
  });
  await flushAsync();

  harness.listeners.change?.({
    target: inputTarget({ 'data-action': 'scheduled-filter-state' }, 'paused'),
  });
  await flushAsync();

  assert.ok(harness.scheduledApiCalls.at(-1)?.includes('state=paused'));
  assert.match(harness.app.innerHTML, /<option value="paused" selected>Paused<\/option>/);
  assert.match(harness.app.innerHTML, /<span class="chan-name">Paused routines<\/span>/);
  assert.match(harness.app.innerHTML, /No scheduled work yet/);

  harness.listeners.change?.({
    target: inputTarget({ 'data-action': 'scheduled-filter-state' }, 'all'),
  });
  await flushAsync();

  assert.ok(harness.scheduledApiCalls.at(-1)?.includes('state=all'));
  assert.match(harness.app.innerHTML, /<option value="all" selected>All<\/option>/);
  assert.match(harness.app.innerHTML, /Release readiness check/);
});

test('Scheduled Work explains legacy names that cannot be safely projected', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/scheduled-work',
    redactScheduledName: true,
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, />Name unavailable<\/button>/);
  assert.match(harness.app.innerHTML, /The name is unavailable for this legacy routine/);

  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'select-scheduled-routine',
      'data-routine': 'routine_release_digest',
    }),
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /id="scheduled-summary-title">Name unavailable<\/h2>/);
});

test('Scheduled Work detail separates overview, routine runs, and routine activity', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/scheduled-work/routine_release_digest',
  });
  await flushAsync();

  assert.equal(
    harness.locationPath(),
    '/admin/audit-logs/scheduled-work/routine_release_digest',
  );
  assert.match(harness.app.innerHTML, /class="audit-tab active" role="tab" aria-selected="true" data-action="audit-tab-scheduled">Scheduled work/);
  assert.match(harness.app.innerHTML, /Release readiness check/);
  assert.match(harness.app.innerHTML, /weekdays at 9:00 AM/);
  assert.match(harness.app.innerHTML, /Review open launch blockers and resolve anything safe to change/);
  assert.match(harness.app.innerHTML, /View run history and activity/);
  assert.doesNotMatch(harness.app.innerHTML, /America\/Los_Angeles/);
  assert.doesNotMatch(harness.app.innerHTML, /Source Slack request/);
  assert.doesNotMatch(harness.app.innerHTML, /same authority as a live @mention/);
  assert.doesNotMatch(harness.app.innerHTML, /scheduled-detail-tabs/);
  assert.doesNotMatch(harness.app.innerHTML, /flue_run_release_1/);
  assert.doesNotMatch(harness.app.innerHTML, /Revision history/);
  assert.doesNotMatch(harness.app.innerHTML, /100 active per deployment/);

  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'scheduled-open-inspector' }),
  });

  assert.match(harness.app.innerHTML, /Back to routine summary/);
  assert.match(harness.app.innerHTML, /America\/Los_Angeles/);
  assert.match(harness.app.innerHTML, /Source Slack request/);
  assert.match(harness.app.innerHTML, /Every weekday, review launch blockers and resolve anything safe to change/);
  assert.match(harness.app.innerHTML, /same authority as a live @mention/);
  assert.match(harness.app.innerHTML, /Overview/);
  assert.match(harness.app.innerHTML, /class="scheduled-card scheduled-definition"/);
  assert.match(harness.app.innerHTML, /class="scheduled-definition-grid"/);
  assert.match(harness.app.innerHTML, /<summary>Access and technical details<\/summary>/);
  assert.match(harness.app.innerHTML, /Cloned from/);
  assert.match(harness.app.innerHTML, /routine_release_source/);

  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'scheduled-detail-tab', 'data-tab': 'runs' }),
  });
  assert.match(harness.app.innerHTML, /Run history for this routine/);
  assert.match(harness.app.innerHTML, /flue_run_release_1/);
  assert.match(harness.app.innerHTML, /access_hash_123/);
  assert.match(harness.app.innerHTML, /1500 input \+ output tokens/);
  assert.match(harness.app.innerHTML, /Open message/);
  assert.doesNotMatch(harness.app.innerHTML, /Source Slack request/);

  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'scheduled-detail-tab', 'data-tab': 'activity' }),
  });
  assert.match(harness.app.innerHTML, /History for this routine/);
  assert.match(harness.app.innerHTML, /Revision history/);
  assert.match(harness.app.innerHTML, /Audit trail/);
  assert.doesNotMatch(harness.app.innerHTML, /One independent Flue Workflow run per trigger/);

  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'scheduled-detail-tab', 'data-tab': 'overview' }),
  });

  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'scheduled-control', 'data-control': 'pause' }),
  });
  await flushAsync();

  assert.equal(harness.scheduledControlPosts.length, 1);
  assert.deepEqual(harness.scheduledControlPosts[0]?.body, {
    action: 'pause',
    expectedVersion: 2,
  });
  assert.match(harness.scheduledControlPosts[0]?.idempotencyKey ?? '', /^admin-ui:routine:pause:/);
  assert.match(harness.app.innerHTML, /data-control="resume">Resume/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'scheduled-delete-open' }) });
  assert.match(harness.app.innerHTML, /permanently removes the saved task/);
  assert.match(harness.app.innerHTML, /Flue transcripts may still retain prior content/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'scheduled-delete-confirm' }) });
  await flushAsync();

  assert.deepEqual(harness.scheduledControlPosts[1]?.body, {
    action: 'delete',
    expectedVersion: 3,
    acknowledgeIrreversible: true,
  });
  assert.equal(harness.locationPath(), '/admin/audit-logs/scheduled-work');
  assert.match(harness.app.innerHTML, /Routine deleted\. The saved task was irreversibly removed\./);
  assert.match(harness.app.innerHTML, /No scheduled work yet/);
  assert.doesNotMatch(harness.app.innerHTML, /<span class="scheduled-table-state deleted">deleted<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /Review open launch blockers and resolve anything safe to change/);
});

test('Channel detail keeps behavior and memory on the Agent', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'select-channel',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C0EXR3L9T',
    }),
  });
  await flushAsync();
  assert.match(harness.app.innerHTML, /inventory of reach/);
  assert.doesNotMatch(harness.app.innerHTML, /channel-advanced-toggle|Additional instructions|Channel memory|Exact-Channel/);
});

test('Channel detail cannot open a Channel memory editor', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /channel-advanced|owner-memory-create-open|owner-memory-create-confirm/);
});

test('Channel detail does not own scheduled-work controls', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /open-channel-scheduled|Review scheduled work/);
  assert.match(harness.app.innerHTML, /Every Agent keeps its own behavior, memory, connections, and schedules/);
});

test('legacy Channel-memory editor routes remain unavailable', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/mem_release',
  });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/audit-logs/scheduled-work');
  assert.doesNotMatch(harness.app.innerHTML, /memory-save|memory-delete|memory-resolve-review|release-guidance/);
  assert.equal(harness.memoryPuts.length, 0);
});

test('Repositories tab explains grants-implied sandbox availability without a profile toggle', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({
    target: actionTarget({
      'data-action': 'edit-profile',
      'data-agent': 'agent_release',
    }),
  });
  click({
    target: actionTarget({
      'data-action': 'profile-tab',
      'data-tab': 'repositories',
    }),
  });
  await flushAsync();

  assert.match(
    harness.app.innerHTML,
    /Coding runs in a sandbox when this Agent has enabled repository grants and the install-wide tier is on\./,
  );
  assert.doesNotMatch(harness.app.innerHTML, /data-action="profile-sandbox"/);
});

test('GitHub settings exposes only the required GitHub App authentication path', () => {
  const html = renderAdminPage();

  assert.match(
    html,
    /Required for repository access and the coding sandbox/,
  );
  assert.match(html, /Create GitHub App/);
  assert.doesNotMatch(
    html,
    /Use a personal access token|github-pat|GITHUB_PAT|patSource|\/admin\/api\/github\/pat/,
  );
});

test('Usage navigation is feature-gated off by default', async () => {
  const html = renderAdminPage();
  const harness = runAdminPageHarness();
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /data-action="open-usage"/);
  assert.match(html, /var USAGE_ADMIN_UI = false/);
});

test('Usage shows concise spend, expanded token columns, and non-interactive activity rows', async () => {
  const harness = runAdminPageHarness({ usageAdminUi: true, initialPath: '/admin/usage' });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /Estimated spend/);
  assert.match(html, /\$0\.01/);
  assert.match(html, /Some activity is missing usage data\./);
  assert.match(html, /Cost estimates include 1 of 3 activities; token totals include 2 of 3\./);
  assert.match(html, /Set spending limits with each model provider/);
  assert.match(html, /<option value="channel" selected>Channel<\/option>/);
  assert.match(html, /Spend by channel/);
  assert.match(html, /data-value="direct_message" data-label="Direct message">Direct message<\/button>/);
  assert.match(html, /data-value="C0EXR3L9T" data-label="#eng-releases">#eng-releases<\/button>/);
  assert.doesNotMatch(html, />#C0EXR3L9T<\/button>/);
  assert.doesNotMatch(html, /#direct_message/);
  assert.doesNotMatch(html, />#null<\/button>/);
  assert.match(html, /Recent <span class="usage-term-help"[^>]*>activity<\/span>/);
  assert.match(html, /data-tooltip="Activity includes each Slack message Chickpea responds to and each scheduled routine run\."/);
  assert.match(html, />Input tokens<\/th><th class="number">Cached input<\/th><th class="number">Output tokens<\/th><th class="number">Total tokens<\/th>/);
  assert.match(html, /<td class="number">1,200<\/td><td class="number">500<\/td><td class="number">300<\/td><td class="number">2,000<\/td>/);
  assert.match(html, /class="usage-token-total" tabindex="0" data-tooltip="1,000 input · 500 cached input · 250 output"[^>]*>1,750<\/span>/);
  assert.match(html, /Direct message/);
  assert.doesNotMatch(html, /Interaction classification|op_classification_fixture/);
  assert.doesNotMatch(html, /data-action="usage-select-operation"|Activity details|data-operation="op_usage_fixture"/);
  assert.doesNotMatch(html, /Provider setup|Provider limits|Known estimate|Work instance|Retention and lifecycle/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /Release &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /authorization: Bearer|apiKey|clientSecret/i);
});

test('Usage resolves a redacted private operation to the local Agent name', async () => {
  const harness = runAdminPageHarness({
    usageAdminUi: true,
    initialPath: '/admin/usage',
    usageAgentLabel: null,
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, />Release Profile<\/td>/);
  assert.doesNotMatch(harness.app.innerHTML, />agent_release<\/td>/);
});

test('Usage preserves pagination when a page contains only hidden classifier work', async () => {
  const harness = runAdminPageHarness({
    usageAdminUi: true,
    initialPath: '/admin/usage',
    usageClassifierOnly: true,
    usageNextCursor: 'cursor_after_internal_work',
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /No customer activity on this page/);
  assert.match(harness.app.innerHTML, /data-action="usage-load-more"[^>]*>Load more<\/button>/);
  assert.doesNotMatch(harness.app.innerHTML, /Interaction classification|op_classification_fixture/);
});

test('Usage combines matching coverage gaps and hides the note when coverage is complete', async () => {
  const partial = runAdminPageHarness({
    usageAdminUi: true,
    initialPath: '/admin/usage',
    usageCoverage: { pricedOperationCount: 2, meteredOperationCount: 2 },
  });
  await flushAsync();
  assert.match(partial.app.innerHTML, /Totals include 2 of 3 activities\./);
  assert.match(partial.app.innerHTML, /One activity did not report token usage and could not be priced\./);

  const complete = runAdminPageHarness({
    usageAdminUi: true,
    initialPath: '/admin/usage',
    usageCoverage: { pricedOperationCount: 3, meteredOperationCount: 3 },
  });
  await flushAsync();
  assert.doesNotMatch(complete.app.innerHTML, /class="usage-data-note"/);
  assert.doesNotMatch(complete.app.innerHTML, /missing usage data|did not report token usage/);
});

test('Admin dividers use solid rules', () => {
  assert.doesNotMatch(renderAdminPage(), /\b(?:dashed|dotted)\b/);
});

test('Usage tooltips render on hover and keyboard focus without relying on native title text', () => {
  const html = renderAdminPage();
  assert.match(html, /\.usage-term-help:hover::after, \.usage-term-help:focus-visible::after/);
  assert.match(html, /content: attr\(data-tooltip\)/);
  assert.doesNotMatch(html, /class="usage-term-help"[^>]*\stitle=/);
});

test('Usage renders an explicit query error and retry action', async () => {
  const harness = runAdminPageHarness({ usageAdminUi: true, initialPath: '/admin/usage', usageApiError: true });
  await flushAsync();
  assert.match(harness.app.innerHTML, /usage_unavailable/);
  assert.match(harness.app.innerHTML, /data-action="usage-retry"/);
});

test('Usage restores its bounded period and single breakdown from the URL', async () => {
  const harness = runAdminPageHarness({
    usageAdminUi: true,
    initialPath: '/admin/usage',
    initialSearch: '?days=90&groupBy=channel',
  });
  await flushAsync();
  assert.match(harness.app.innerHTML, /<option value="last_90_days" selected>Last 90 days<\/option>/);
  assert.match(harness.app.innerHTML, /<option value="channel" selected>Channel<\/option>/);
  assert.match(harness.app.innerHTML, /<th>channel<\/th>/);
});

test('Usage offers rolling and calendar periods in a clear order', async () => {
  const harness = runAdminPageHarness({ usageAdminUi: true, initialPath: '/admin/usage' });
  await flushAsync();

  const periodSelect = harness.app.innerHTML.match(/<select class="input" name="usage-period"[\s\S]*?<\/select>/)?.[0] ?? '';
  const labels = ['Last 7 days', 'Last 30 days', 'Last 90 days', 'This month', 'Last month', 'This week', 'Last week', 'Custom'];
  labels.forEach((label) => assert.match(periodSelect, new RegExp(`>${label}<`)));
  labels.slice(1).forEach((label, index) => {
    assert.ok(periodSelect.indexOf(labels[index] as string) < periodSelect.indexOf(label));
  });
});

test('Usage restores an inclusive custom range and sends its calendar boundaries to reporting APIs', async () => {
  const harness = runAdminPageHarness({
    usageAdminUi: true,
    initialPath: '/admin/usage',
    initialSearch: '?period=custom&from=2026-07-01&to=2026-07-05&groupBy=agent',
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<option value="custom" selected>Custom<\/option>/);
  assert.match(harness.app.innerHTML, /id="usage-custom-from"[^>]*value="2026-07-01"/);
  assert.match(harness.app.innerHTML, /id="usage-custom-to"[^>]*value="2026-07-05"/);
  assert.match(harness.app.innerHTML, /<option value="agent" selected>Agent<\/option>/);

  const overviewPath = harness.usageApiCalls.filter((path) => path.startsWith('/admin/api/usage/overview')).at(-1);
  assert.ok(overviewPath);
  const overviewUrl = new URL(overviewPath, 'http://admin.test');
  assert.equal(overviewUrl.searchParams.get('from'), String(new Date(2026, 6, 1).getTime()));
  assert.equal(overviewUrl.searchParams.get('to'), String(new Date(2026, 6, 6).getTime()));
  assert.equal(overviewUrl.searchParams.get('groupBy'), 'agent');
});

test('Usage reveals and applies custom dates without querying half-edited values', async () => {
  const harness = runAdminPageHarness({ usageAdminUi: true, initialPath: '/admin/usage' });
  await flushAsync();
  const change = harness.listeners.change;
  const click = harness.listeners.click;
  assert.ok(change);
  assert.ok(click);

  change({ target: inputTarget({ 'data-action': 'usage-range' }, 'custom') });
  await flushAsync();
  assert.match(harness.app.innerHTML, /id="usage-custom-from"/);
  assert.match(harness.app.innerHTML, /id="usage-custom-to"/);
  assert.match(harness.app.innerHTML, /data-action="usage-custom-apply">Apply dates<\/button>/);
  assert.match(harness.app.innerHTML, /class="usage-control-row has-custom"/);
  assert.doesNotMatch(harness.app.innerHTML, /class="usage-custom-range"/);

  const callsAfterOpening = harness.usageApiCalls.length;
  change({ target: inputTarget({ 'data-action': 'usage-custom-from' }, '2026-07-01') });
  change({ target: inputTarget({ 'data-action': 'usage-custom-to' }, '2026-07-05') });
  assert.equal(harness.usageApiCalls.length, callsAfterOpening);

  click({ target: actionTarget({ 'data-action': 'usage-custom-apply' }) });
  await flushAsync();
  assert.ok(harness.historyReplaces.includes('/admin/usage?period=custom&from=2026-07-01&to=2026-07-05&groupBy=channel'));
  const overviewPath = harness.usageApiCalls.filter((path) => path.startsWith('/admin/api/usage/overview')).at(-1);
  assert.ok(overviewPath);
  const overviewUrl = new URL(overviewPath, 'http://admin.test');
  assert.equal(overviewUrl.searchParams.get('from'), String(new Date(2026, 6, 1).getTime()));
  assert.equal(overviewUrl.searchParams.get('to'), String(new Date(2026, 6, 6).getTime()));
});

test('Usage keeps an invalid custom range in place and explains what to fix', async () => {
  const harness = runAdminPageHarness({
    usageAdminUi: true,
    initialPath: '/admin/usage',
    initialSearch: '?period=custom&from=2026-07-01&to=2026-07-05&groupBy=channel',
  });
  await flushAsync();
  const callsBeforeEdit = harness.usageApiCalls.length;

  harness.listeners.change?.({ target: inputTarget({ 'data-action': 'usage-custom-from' }, '2026-07-10') });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'usage-custom-apply' }) });
  await flushAsync();

  assert.equal(harness.usageApiCalls.length, callsBeforeEdit);
  assert.match(harness.app.innerHTML, /role="alert">Start date must be on or before end date\.<\/p>/);
  assert.match(harness.app.innerHTML, /id="usage-custom-from"[^>]*value="2026-07-10"/);
});

test('Settings renders all four providers in the Shelf grid on every target', async () => {
  const page = renderAdminPage();
  assert.match(page, /\.settings-providers-page\[hidden\] \{ display: none; \}/);
  assert.match(page, /@container provider-settings \(max-width: 480px\)[\s\S]*?\.provider-card \.prov-sub \{ grid-column: 2 \/ 4; grid-row: 2; \}/);
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /class="provider-grid"/);
  assert.equal((html.match(/class="prov-row provider-card/g) ?? []).length, 4);
  assert.equal((html.match(/class="provider-card-logo"/g) ?? []).length, 4);
  assert.match(html, /data-provider-card="anthropic"/);
  assert.match(html, /data-provider-card="openai"/);
  assert.match(html, /data-provider-card="openrouter"/);
  assert.match(html, /data-provider-card="workers-ai"/);
  // Anthropic (stored) shows the Stored chip + model count; OpenAI exposes only API-key billing.
  assert.match(html, /<span class="prov-name">Anthropic<\/span>/);
  assert.match(html, /data-provider-card="anthropic"[\s\S]*?<span class="dot"><\/span>Connected<\/span>/);
  assert.match(html, /10 models available\./);
  assert.match(html, /<span class="prov-name">OpenAI<\/span>/);
  assert.doesNotMatch(html, /of 1 connected/);
  assert.match(html, /Connect the API credentials Chickpea can use/);
  assert.match(html, /<span class="openai-auth-title">API key<\/span>/);
  assert.match(html, /data-provider-card="openai"[\s\S]*?<span class="dot"><\/span>Key needed<\/span>/);
  assert.doesNotMatch(html, /ChatGPT subscription|Connect subscription|openai-subscription|Use for OpenAI calls|Selected:/);
  assert.match(html, /data-action="prov-add-key" data-provider="openai"/);
  // OpenRouter (env) is read-only and starts in the compact selected-model summary.
  assert.match(html, /data-provider-card="openrouter"[\s\S]*?<span class="dot"><\/span>Connected<\/span>/);
  assert.match(html, /<span class="fav-summary-title">Models<\/span><span class="fav-summary-count">2 selected<\/span>/);
  assert.match(html, /class="fav-selected provider-model-chips"/);
  assert.match(html, /<span class="provider-model-chip" title="anthropic\/claude-sonnet-4"><button type="button" class="provider-model-unstar" data-action="fav-star"[^>]*aria-label="Remove anthropic\/claude-sonnet-4 from the model picker">/);
  assert.doesNotMatch(html, /<button[^>]*class="provider-model-chip"[^>]*data-action="fav-star"/);
  assert.match(html, /data-action="fav-manager-toggle" data-provider="openrouter"[^>]*>Manage models<\/button>/);
  assert.doesNotMatch(html, /Models in your picker|OpenRouter serves|Star adds a model|data-action="fav-search" data-provider="openrouter"/);
  assert.doesNotMatch(html, /data-action="prov-remove" data-provider="openrouter"/);
  // Cloudflare remains visible on Node so the provider set is stable and easy
  // to scan. Its controls explain that the binding is deployment-specific.
  assert.match(html, /<span class="prov-name">Cloudflare Workers AI<\/span>/);
});

test('Settings hides legacy OpenAI subscription state and exposes only API-key billing', async () => {
  const harness = runAdminPageHarness({
    providers: [
      { id: 'anthropic', status: 'missing', modelCount: null },
      {
        id: 'openai',
        status: 'stored',
        modelCount: 2,
        activeAuthMethod: 'api_key',
        subscription: {
          state: 'connected',
          updatedAt: 1_800_000_005_000,
          accountFingerprint: 'oas_safe_fixture',
          connectedAt: 1_800_000_005_000,
        },
      },
      { id: 'openrouter', status: 'missing', modelCount: null },
      { id: 'workers-ai', status: 'missing', modelCount: null },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  assert.doesNotMatch(harness.app.innerHTML, /of 1 connected/);
  assert.match(harness.app.innerHTML, /<span class="openai-auth-title">API key<\/span>/);
  assert.match(harness.app.innerHTML, /Saved in Chickpea/);
  assert.match(harness.app.innerHTML, /<details class="provider-action-menu">/);
  assert.match(harness.app.innerHTML, /<summary[^>]*aria-label="Manage OpenAI API key"/);
  assert.doesNotMatch(harness.app.innerHTML, /ChatGPT subscription|openai-subscription|Use for OpenAI calls|>Selected</);
});

test('Settings provider action menus dismiss on sibling, outside click, and Escape', async () => {
  const harness = runAdminPageHarness({ providerActionMenuCount: 2 });
  await flushAsync();
  const click = harness.listeners.click;
  const keydown = harness.listeners.keydown;
  assert.ok(click && keydown);

  const [firstMenu, secondMenu] = harness.providerActionMenus;
  assert.ok(firstMenu && secondMenu);
  firstMenu.open = true;
  secondMenu.open = true;

  click({ target: secondMenu });
  assert.equal(firstMenu.open, false);
  assert.equal(secondMenu.open, true);

  click({ target: actionTarget({}) });
  assert.equal(secondMenu.open, false);

  firstMenu.open = true;
  let prevented = false;
  keydown({
    target: actionTarget({}),
    key: 'Escape',
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
  assert.equal(firstMenu.open, false);
  assert.equal(harness.focusedAction(), 'provider-action-menu-0-summary');
});

test('Settings renders the outbound-access mode control and allowlist domain input', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /<h2 class="section-title">Outbound access<\/h2>/);
  assert.match(html, /class="seg"/);
  assert.match(html, /data-action="egress-mode" data-mode="allowlist"/);
  assert.match(html, /data-action="egress-mode" data-mode="open"/);
  assert.match(html, /data-action="egress-mode" data-mode="off"/);
  assert.match(html, /placeholder="api\.example\.com"[^>]*data-action="egress-domain-input"/);
});

test('Settings keeps outbound access available when model providers fail to load', async () => {
  const harness = runAdminPageHarness({
    providerSettingsError: { status: 500, error: 'provider_settings_failed' },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /provider_settings_failed/);
  assert.match(harness.app.innerHTML, /<h2 class="section-title">Outbound access<\/h2>/);
  assert.match(harness.app.innerHTML, /data-action="egress-save"/);
});

test('Settings adds an outbound domain and saves the expected egress policy', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);

  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'egress-domain-add' }) });
  input({
    target: inputTarget(
      { 'data-action': 'egress-domain-input', 'data-index': '1' },
      ' api.github.com ',
    ),
  });
  click({ target: actionTarget({ 'data-action': 'egress-save' }) });
  assert.match(harness.app.innerHTML, /data-action="egress-save" disabled>Saving&hellip;<\/button>/);
  assert.match(harness.app.innerHTML, /data-action="egress-mode" data-mode="allowlist" disabled/);
  assert.match(harness.app.innerHTML, /data-action="egress-domain-input" data-index="0" disabled/);
  await flushAsync();

  assert.deepEqual(harness.egressPuts, [
    { mode: 'allowlist', domains: ['api.github.com'] },
  ]);
});

test('Settings validates a pasted key and collapses the row to a stored status', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  click({ target: actionTarget({ 'data-action': 'prov-add-key', 'data-provider': 'openai' }) });
  assert.match(harness.app.innerHTML, /data-action="prov-validate" data-provider="openai"/);
  input({ target: inputTarget({ 'data-action': 'prov-key-input', 'data-provider': 'openai' }, 'sk-live-openai') });
  click({ target: actionTarget({ 'data-action': 'prov-validate', 'data-provider': 'openai' }) });
  await flushAsync();

  assert.deepEqual(harness.providerKeyPosts, [{ id: 'openai', key: 'sk-live-openai' }]);
  // The API-key connection is the only OpenAI provider option.
  assert.match(harness.app.innerHTML, /<span class="prov-name">OpenAI<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /of 1 connected/);
  assert.match(harness.app.innerHTML, /Saved in Chickpea/);
  assert.doesNotMatch(harness.app.innerHTML, /ChatGPT subscription|openai-subscription|Use for OpenAI calls/);
});

test('Settings does not count a legacy Subscription as an available OpenAI connection', async () => {
  const harness = runAdminPageHarness({
    providers: [
      { id: 'anthropic', status: 'missing', modelCount: null },
      {
        id: 'openai',
        status: 'missing',
        modelCount: null,
        activeAuthMethod: 'subscription',
        subscription: {
          state: 'connected',
          updatedAt: 1_800_000_005_000,
          accountFingerprint: 'oas_safe_fixture',
          connectedAt: 1_800_000_005_000,
        },
      },
      { id: 'openrouter', status: 'missing', modelCount: null },
      { id: 'workers-ai', status: 'missing', modelCount: null },
    ],
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  assert.doesNotMatch(harness.app.innerHTML, /of 1 connected/);
  assert.match(harness.app.innerHTML, /Platform billing/);
  assert.doesNotMatch(harness.app.innerHTML, /ChatGPT subscription|openai-subscription|Use for OpenAI calls|>Selected|oas_safe_fixture/);
});

test('OpenAI profiles contain only the model choice and do not carry an auth-method selector', async () => {
  const harness = runAdminPageHarness({
    assignments: [
      { workspaceId: 'T_DESIGN', channelId: 'C_OPENAI', agentId: 'agent_openai', enabled: true },
    ],
    agents: [
      {
        id: 'agent_openai',
        name: 'OpenAI profile',
        description: '',
        instructions: 'Use OpenAI.',
        enabled: true,
        model: 'openai/gpt-5.4',
      },
    ],
    modelProviders: [
      {
        id: 'openai',
        configured: true,
        source: 'subscription or API key',
        suggestions: ['openai/gpt-5.4'],
        authMethods: {
          activeMethod: 'subscription',
          apiKeyConfigured: true,
          subscription: {
            state: 'connected',
            updatedAt: 1_800_000_005_000,
            accountFingerprint: 'oas_safe_fixture',
            connectedAt: 1_800_000_005_000,
          },
        },
      },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_openai' }) });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /This profile uses|profile-openai-auth/);
  assert.match(harness.app.innerHTML, /id="p-model"/);
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.agentPatchBodies.length, 1);
  assert.equal(harness.agentPatchBodies[0]?.body.openaiAuthMethod, undefined);
});

test('Settings surfaces a rejected key verbatim in the raw-error block and stores nothing', async () => {
  const harness = runAdminPageHarness({
    providers: [
      { id: 'anthropic', status: 'missing', modelCount: null },
      { id: 'openai', status: 'missing', modelCount: null },
      { id: 'openrouter', status: 'env', modelCount: null },
      { id: 'workers-ai', status: 'missing', modelCount: null },
    ],
    providerKeyReject: { status: 401, detail: 'authentication_error: invalid x-api-key' },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  click({ target: actionTarget({ 'data-action': 'prov-add-key', 'data-provider': 'anthropic' }) });
  input({ target: inputTarget({ 'data-action': 'prov-key-input', 'data-provider': 'anthropic' }, 'sk-ant-bad') });
  click({ target: actionTarget({ 'data-action': 'prov-validate', 'data-provider': 'anthropic' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /Anthropic rejected the key\. Nothing was stored/);
  assert.match(html, /<div class="raw-error">GET \/v1\/models → 401 authentication_error: invalid x-api-key<\/div>/);
  // Provider still needs a key (nothing stored) and the paste field is still open.
  assert.match(html, /Key needed<\/span>/);
});

test('Settings remove-key confirmation names the pinned profiles and the honest consequence', async () => {
  const harness = runAdminPageHarness({
    agents: [
      { id: 'agent_a', name: 'Support Triage', description: '', instructions: 'x', enabled: true, model: 'anthropic/claude-sonnet-4-6' },
      { id: 'agent_b', name: 'Release Scribe', description: '', instructions: 'x', enabled: true, model: 'anthropic/claude-haiku-4-5' },
      { id: 'agent_c', name: 'Ops', description: '', instructions: 'x', enabled: true, model: 'openai/gpt-4.1' },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  click({ target: actionTarget({ 'data-action': 'prov-remove', 'data-provider': 'anthropic' }) });
  const html = harness.app.innerHTML;
  assert.match(html, /Remove the stored Anthropic key\?/);
  assert.match(html, /<b[^>]*>2 Agents<\/b> are pinned to an Anthropic model/);
  assert.match(html, /Support Triage/);
  assert.match(html, /Release Scribe/);
  assert.match(html, /Provider failures stay sanitized in Slack/);
  assert.match(html, /ANTHROPIC_API_KEY<\/span> in the environment, if set, still applies/);
  assert.doesNotMatch(html, /Ops/); // the OpenAI-pinned profile is not implicated

  // Confirming removes the stored key.
  click({ target: actionTarget({ 'data-action': 'prov-remove-confirm', 'data-provider': 'anthropic' }) });
  await flushAsync();
  assert.deepEqual(harness.providerKeyDeletes, ['anthropic']);
});

test('Settings provider removal names Chickpea and live-inheriting Agents when it is the Workspace default', async () => {
  const harness = runAdminPageHarness({
    agents: [
      {
        id: 'agent_support', name: 'Support', description: '', instructions: 'x',
        enabled: true, lifecycle: 'active',
      },
    ],
    workspaceDefault: {
      workspaceId: 'T_DESIGN',
      modelId: 'anthropic/claude-sonnet-4-6',
      revision: 3,
      provenance: 'admin_selected',
      runtimeContract: 'chickpea-v1',
      live: true,
      inheritingAgentCount: 1,
      health: { status: 'ready', providerId: 'anthropic' },
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  click({ target: actionTarget({ 'data-action': 'prov-remove', 'data-provider': 'anthropic' }) });
  const html = harness.app.innerHTML;
  assert.match(html, /Workspace default<[\/]b> uses an Anthropic model/);
  assert.match(html, /Chickpea and <b[^>]*>1 active Agent<[\/]b> inheriting it will stop answering/);
  assert.doesNotMatch(html, /nothing stops answering|No Agent pin or Workspace default currently depends/);
});

test('Settings OpenRouter favorites manager searches, stars, and persists to the picker', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  // Two selected models are visible without the search controls or explanatory prose.
  let html = harness.app.innerHTML;
  assert.match(html, /<span class="fav-summary-title">Models<\/span><span class="fav-summary-count">2 selected<\/span>/);
  assert.match(html, /<span class="fav-model">anthropic\/claude-sonnet-4<\/span>/);
  assert.match(html, /<span class="fav-model">openai\/gpt-4\.1<\/span>/);
  assert.doesNotMatch(html, /data-action="fav-search" data-provider="openrouter"|OpenRouter serves|Star adds a model/);

  // Manage models reveals the search interaction; its result rows retain useful selection metadata.
  click({ target: actionTarget({ 'data-action': 'fav-manager-toggle', 'data-provider': 'openrouter' }) });
  html = harness.app.innerHTML;
  assert.match(html, /data-action="fav-search" data-provider="openrouter"/);

  // Typing filters the live list into the results container (unstarred matches only).
  input({ target: inputTarget({ 'data-action': 'fav-search', 'data-provider': 'openrouter' }, 'llama') });
  const results = harness.favContainers['fav-results-openrouter'];
  assert.ok(results);
  assert.match(results.innerHTML, /Results for &ldquo;llama&rdquo;/);
  assert.match(results.innerHTML, /meta-llama\/llama-3\.3-70b-instruct/);
  assert.match(results.innerHTML, /131K ctx/);

  // Starring the match persists the whole array and grows the picker group.
  click({ target: actionTarget({ 'data-action': 'fav-star', 'data-provider': 'openrouter', 'data-model': 'meta-llama/llama-3.3-70b-instruct' }) });
  await flushAsync();
  assert.equal(harness.favoritesPuts.length, 1);
  assert.deepEqual(harness.favoritesPuts[0], {
    id: 'openrouter',
    favorites: ['anthropic/claude-sonnet-4', 'openai/gpt-4.1', 'meta-llama/llama-3.3-70b-instruct'],
  });
  assert.match(harness.app.innerHTML, /<span class="fav-summary-count">3 selected<\/span>/);
});

test('Settings shows the Cloudflare provider card on the Cloudflare target with no per-row metas', async () => {
  const harness = runAdminPageHarness({
    cloudflare: true,
    modelProviders: [{
      id: 'cloudflare',
      configured: true,
      source: 'Workers AI binding',
      suggestions: ['cloudflare/@cf/zai-org/glm-5.2'],
    }],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  let html = harness.app.innerHTML;
  assert.match(html, /<span class="prov-name">Cloudflare Workers AI<\/span>/);
  assert.match(html, /data-provider-card="workers-ai"/);
  assert.match(html, /class="fav-selected provider-model-chips"/);
  assert.match(html, /<span class="provider-toggle-label">On<\/span>/);
  assert.match(html, /data-action="workers-ai-enabled" checked aria-label="Use Workers AI in Agent model pickers"/);
  assert.match(html, /<span class="fav-summary-title">Models<\/span><span class="fav-summary-count">2 selected<\/span>/);
  assert.match(html, /data-action="fav-manager-toggle" data-provider="workers-ai"[^>]*>Manage models<\/button>/);
  assert.match(html, /Runs Cloudflare-hosted models\. No API key needed\./);
  assert.doesNotMatch(html, /billed in Neurons|No key to manage|binding lists|Star adds a model|data-action="fav-search" data-provider="workers-ai"/);
  assert.doesNotMatch(html, /data-action="prov-add-key" data-provider="workers-ai"/);
  assert.doesNotMatch(html, /declares no context window|auto-compaction stays off/);
  // Seed default renders as a starred favorite, provider-native, with NO meta.
  assert.match(html, /<span class="fav-model">@cf\/zai-org\/glm-5\.2<\/span><\/span>/);

  change({
    target: Object.assign(
      actionTarget({ 'data-action': 'workers-ai-enabled' }),
      { checked: false },
    ),
  });
  await flushAsync();

  assert.deepEqual(harness.workersAiEnabledPuts, [false]);
  html = harness.app.innerHTML;
  assert.match(html, /<span class="provider-toggle-label">Off<\/span>/);
  assert.match(html, /data-action="workers-ai-enabled" aria-label="Use Workers AI in Agent model pickers"/);
  assert.doesNotMatch(html, /data-action="workers-ai-enabled" checked/);

  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /<div class="combo-group">workers-ai/);
});

test('Workers AI toggle restores its confirmed state when saving fails', async () => {
  const harness = runAdminPageHarness({
    cloudflare: true,
    workersAiEnabledError: {
      status: 500,
      error: 'internal_error',
      message: 'Preference storage unavailable.',
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  change({
    target: Object.assign(
      actionTarget({ 'data-action': 'workers-ai-enabled' }),
      { checked: false },
    ),
  });
  await flushAsync();

  assert.deepEqual(harness.workersAiEnabledPuts, [false]);
  assert.match(harness.app.innerHTML, /data-action="workers-ai-enabled" checked aria-label="Use Workers AI in Agent model pickers"/);
  assert.match(harness.app.innerHTML, /Preference storage unavailable\./);
});

test('Workers AI renders Off on a fresh load and recovers a failed model refresh after enabling', async () => {
  let modelCalls = 0;
  const harness = runAdminPageHarness({
    cloudflare: true,
    providers: [
      { id: 'anthropic', status: 'stored', modelCount: 10 },
      { id: 'openai', status: 'missing', modelCount: null, activeAuthMethod: 'api_key' },
      { id: 'openrouter', status: 'env', modelCount: null },
      { id: 'workers-ai', status: 'env', modelCount: null, enabled: false },
    ],
    modelProviders: [{
      id: 'cloudflare',
      configured: true,
      source: 'Workers AI binding',
      suggestions: ['cloudflare/@cf/zai-org/glm-5.2'],
    }],
    settingsLoadFetch(path, method) {
      if (path !== '/admin/api/models' || method !== 'GET') return undefined;
      modelCalls += 1;
      return modelCalls === 2
        ? Promise.resolve(jsonResponse({ error: 'models_unavailable' }, 503))
        : undefined;
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<span class="provider-toggle-label">Off<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="workers-ai-enabled" checked/);

  change({
    target: Object.assign(
      actionTarget({ 'data-action': 'workers-ai-enabled' }),
      { checked: true },
    ),
  });
  await flushAsync();

  assert.deepEqual(harness.workersAiEnabledPuts, [true]);
  assert.match(harness.app.innerHTML, /data-action="workers-ai-enabled" checked aria-label="Use Workers AI in Agent model pickers"/);
  assert.match(harness.app.innerHTML, /Workers AI is on, but its model suggestions could not be refreshed\./);
  assert.match(harness.app.innerHTML, /data-action="workers-ai-refresh"[^>]*>Try again<\/button>/);

  click({ target: actionTarget({ 'data-action': 'workers-ai-refresh' }) });
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /data-action="workers-ai-refresh"/);
  assert.doesNotMatch(harness.app.innerHTML, /model suggestions could not be refreshed/);

  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /<div class="combo-group">workers-ai/);
});

test('Workers AI toggle ignores an older providers response that resolves after the PUT', async () => {
  let providerCalls = 0;
  let resolveStaleProviders: ((response: FakeResponse) => void) | undefined;
  const harness = runAdminPageHarness({
    cloudflare: true,
    settingsLoadFetch(path, method) {
      if (path !== '/admin/api/providers' || method !== 'GET') return undefined;
      providerCalls += 1;
      if (providerCalls !== 2) return undefined;
      return new Promise<FakeResponse>((resolve) => { resolveStaleProviders = resolve; });
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'settings-section', 'data-section': 'slack' }) });
  click({ target: actionTarget({ 'data-action': 'settings-section', 'data-section': 'providers' }) });
  await flushAsync();
  assert.ok(resolveStaleProviders, 'expected the returning providers request to remain pending');

  change({
    target: Object.assign(
      actionTarget({ 'data-action': 'workers-ai-enabled' }),
      { checked: false },
    ),
  });
  await flushAsync();
  assert.match(harness.app.innerHTML, /data-action="workers-ai-enabled" aria-label="Use Workers AI in Agent model pickers"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="workers-ai-enabled" checked/);

  resolveStaleProviders(jsonResponse({
    providers: [{ id: 'workers-ai', status: 'env', modelCount: null, enabled: true }],
  }));
  await flushAsync();

  assert.match(harness.app.innerHTML, /<span class="provider-toggle-label">Off<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="workers-ai-enabled" checked/);
});

test('an unpinned Agent visibly follows the live Workspace default', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  // A blank Agent has no pin. Its empty field names the live Workspace default,
  // while the open picker still explains that no provider choices are available.
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  const html = harness.app.innerHTML;

  assert.match(html, /<span class="badge-src">Workspace default<\/span><span class="mono hint">local-stub\/release<\/span>/);
  assert.match(html, /placeholder="Workspace default — local-stub\/release"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<div class="combo-group">no providers configured<\/div>/);
  assert.match(html, /This Agent follows live Workspace default changes/);
  assert.doesNotMatch(html, /SLACK_TAG_MODEL|none pinned|offline\/dev fallback/);
});

test('a pinned Agent can explicitly return to live Workspace inheritance', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    workspaceDefault: {
      workspaceId: 'T_DESIGN',
      modelId: 'anthropic/claude-sonnet-5',
      revision: 4,
      provenance: 'admin_selected',
      runtimeContract: 'chickpea-v1',
      live: true,
      inheritingAgentCount: 1,
      health: { status: 'ready', providerId: 'anthropic' },
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<span class="badge-src">Pinned<\/span><span class="mono hint">local-stub\/release<\/span>/);
  assert.match(harness.app.innerHTML, /data-action="profile-model-reset">use the Workspace default<\/button>/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-model-reset' }) });

  assert.match(harness.app.innerHTML, /<span class="badge-src">Workspace default<\/span><span class="mono hint">anthropic\/claude-sonnet-5<\/span>/);
  assert.match(harness.app.innerHTML, /placeholder="Workspace default — anthropic\/claude-sonnet-5"/);
  assert.match(harness.app.innerHTML, /This Agent follows live Workspace default changes/);
  assert.match(harness.app.innerHTML, /data-action="save-profile">Save changes<\/button>/);
  assert.equal(harness.focusedAction(), 'profile-model');
});

test('the profile Model picker preserves the Agent page position across open, load, filter, and close renders', async () => {
  const harness = runAdminPageHarness({
    modelProviders: [
      {
        id: 'anthropic',
        configured: true,
        source: 'registered in src/app.ts',
        suggestions: ['anthropic/claude-sonnet-5'],
      },
    ],
    anthropicModels: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }],
    resetDocumentScrollOnRender: true,
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const keydown = harness.listeners.keydown;
  assert.ok(click && input && keydown);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  await flushAsync();

  harness.setMainScrollTop(486);
  harness.setDocumentScrollTop(486);
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  assert.equal(harness.mainScrollTop(), 486);
  assert.equal(harness.documentScrollTop(), 486);

  input({ target: inputTarget({ 'data-action': 'profile-model' }, 'opus') });
  await flushAsync();
  assert.equal(harness.mainScrollTop(), 486);
  assert.equal(harness.documentScrollTop(), 486);

  keydown({
    key: 'Escape',
    target: actionTarget({ 'data-action': 'profile-model' }),
    preventDefault() {},
  });
  assert.equal(harness.mainScrollTop(), 486);
  assert.equal(harness.documentScrollTop(), 486);
});

test('a failed async Model load preserves page position, focus, and caret', async () => {
  let resolveModels: ((response: FakeResponse) => void) | undefined;
  const harness = runAdminPageHarness({
    modelProviders: [{
      id: 'anthropic',
      configured: true,
      source: 'registered in src/app.ts',
      suggestions: ['anthropic/claude-sonnet-5'],
    }],
    resetDocumentScrollOnRender: true,
    modelFocusScrollTop: 120,
    settingsLoadFetch(path, method) {
      if (path !== '/admin/api/providers/anthropic/models' || method !== 'GET') return undefined;
      return new Promise<FakeResponse>((resolve) => { resolveModels = resolve; });
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  await flushAsync();

  harness.focusModelInput(5);
  harness.setMainScrollTop(486);
  harness.setDocumentScrollTop(486);
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  input({
    target: Object.assign(inputTarget({ 'data-action': 'profile-model' }, 'opus'), {
      selectionStart: 5,
    }),
  });
  assert.equal(harness.focusedAction(), 'p-model');

  assert.ok(resolveModels);
  resolveModels(jsonResponse({ error: 'provider_models_unavailable' }, 502));
  await flushAsync();

  assert.equal(harness.mainScrollTop(), 486);
  assert.equal(harness.documentScrollTop(), 486);
  assert.equal(harness.focusedAction(), 'p-model');
  assert.deepEqual(harness.modelSelectionRanges.at(-1), [5, 5]);
});

test('the profile Model picker labels Cloudflare binding suggestions as workers-ai', async () => {
  const harness = runAdminPageHarness({
    modelProviders: [
      {
        id: 'cloudflare',
        configured: true,
        source: 'Workers AI binding',
        suggestions: ['cloudflare/@cf/zai-org/glm-5.2'],
      },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  // Opening the picker lazily loads the workers-ai favorites that drive the
  // binding group's options.
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<div class="combo-group">workers-ai<span class="src">· Workers AI binding<\/span><\/div>/);
  assert.doesNotMatch(harness.app.innerHTML, /<div class="combo-group">cloudflare<span/);
  // The binding group's options carry the cloudflare/ specifier prefix, built
  // from the starred favorites (not the leaked src path or a raw @cf id).
  assert.match(harness.app.innerHTML, /data-model="cloudflare\/@cf\/zai-org\/glm-5\.2"/);
  assert.doesNotMatch(
    harness.app.innerHTML,
    /Anthropic and OpenAI list their live models/,
  );
});

test('the profile Model picker renders the FULL live Anthropic list with a user-facing source', async () => {
  const harness = runAdminPageHarness({
    // A stored Anthropic key: the runtime reports its source as the internal
    // "registered in src/app.ts" path, which must never leak to the UI.
    modelProviders: [
      {
        id: 'anthropic',
        configured: true,
        source: 'registered in src/app.ts',
        suggestions: [
          'anthropic/claude-fable-5',
          'anthropic/claude-opus-5',
          'anthropic/claude-sonnet-5',
          'anthropic/claude-haiku-4-5',
        ],
      },
    ],
    // The live /models list remains authoritative for the connected account.
    anthropicModels: [
      { id: 'claude-fable-5' },
      { id: 'claude-opus-5' },
      { id: 'claude-sonnet-5' },
      { id: 'claude-haiku-4-5' },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  // Opening the picker lazily loads the full Anthropic model list.
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  // The group is labeled by provider id with a user-facing phrase — never the
  // leaked src path.
  assert.match(html, /<div class="combo-group">anthropic<span class="src">· via your key<\/span><\/div>/);
  assert.doesNotMatch(html, /registered in src\/app\.ts/);
  // Every live model renders as an anthropic/ specifier.
  assert.match(html, /data-model="anthropic\/claude-fable-5"/);
  assert.match(html, /data-model="anthropic\/claude-opus-5"/);
  assert.match(html, /data-model="anthropic\/claude-sonnet-5"/);
  assert.match(html, /data-model="anthropic\/claude-haiku-4-5"/);
});

test('the profile Model picker filters options by the typed specifier', async () => {
  const harness = runAdminPageHarness({
    modelProviders: [
      {
        id: 'anthropic',
        configured: true,
        source: 'registered in src/app.ts',
        suggestions: ['anthropic/claude-sonnet-5'],
      },
    ],
    anthropicModels: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }, { id: 'claude-haiku-4-5' }],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click);
  assert.ok(input);
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();

  // Typing "opus" narrows the open picker to matching specifiers only.
  input({ target: inputTarget({ 'data-action': 'profile-model' }, 'opus') });
  await flushAsync();
  const html = harness.app.innerHTML;
  assert.match(html, /data-model="anthropic\/claude-opus-5"/);
  assert.doesNotMatch(html, /data-model="anthropic\/claude-sonnet-5"/);
  assert.doesNotMatch(html, /data-model="anthropic\/claude-haiku-4-5"/);
});

test('the profile Model picker suppresses configured provider groups with no favorites', async () => {
  const harness = runAdminPageHarness({
    modelProviders: [
      {
        id: 'openrouter',
        configured: true,
        source: 'via OPENROUTER_API_KEY',
        suggestions: [],
      },
    ],
    // OpenRouter renders from starred favorites; with none starred its group is
    // suppressed even though the provider is configured.
    openrouterFavorites: [],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();

  assert.doesNotMatch(harness.app.innerHTML, /<div class="combo-group">openrouter/);
  assert.doesNotMatch(harness.app.innerHTML, /no providers configured/);
  assert.match(harness.app.innerHTML, /Star models in Settings to add picker shortcuts/);
});

test('node-target Sprout seed is unpinned and inherits the Workspace default', async () => {
  const defaultProfile = seededAgents.find((agent) => agent.id === 'agent_default');
  assert.ok(defaultProfile);
  assert.equal(defaultProfile.model, undefined);

  const harness = runAdminPageHarness({
    agents: seededAgents,
    assignments: [],
    providers: [
      { id: 'anthropic', status: 'missing', modelCount: null },
      { id: 'openai', status: 'missing', modelCount: null },
      { id: 'openrouter', status: 'missing', modelCount: null },
      { id: 'workers-ai', status: 'missing', modelCount: null },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_default' }) });
  // The seed's editor opens with an empty pin and names the effective default.
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  const html = harness.app.innerHTML;

  assert.match(html, /<h1 class="page-title">Sprout<\/h1>/);
  assert.match(html, /value="" autocomplete="off" role="combobox" aria-expanded="true" aria-haspopup="listbox" placeholder="Workspace default — local-stub\/release"/);
  assert.match(html, /<div class="combo-group">no providers configured<\/div>/);
  assert.match(html, /This Agent follows live Workspace default changes/);
  assert.doesNotMatch(html, /SLACK_TAG_MODEL|none pinned|offline\/dev fallback/);
});

// The Repositories picker and the Skills import browser share one repo-search
// controller. The import lane is covered above; these two pin the picker lane's
// half of that contract -- request identity across a debounced search, a
// failure that stays inside the picker, and Apply writing the grants.
test('the Repositories picker discards a stale search response and applies the current one', async () => {
  const pending: Array<(response: FakeResponse) => void> = [];
  const harness = runAdminPageHarness({
    githubStatus: {
      mode: 'app',
      installations: [
        { id: 77, accountLogin: 'acme', accountType: 'Organization', repoCount: 4 },
      ],
      referencingProfiles: [],
    },
    githubRepoFetch: () =>
      new Promise<FakeResponse>((resolve) => {
        pending.push(resolve);
      }),
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  assert.ok(click && input && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'repositories' }) });
  await flushAsync();

  click({ target: actionTarget({ 'data-action': 'repo-add' }) });
  assert.deepEqual(harness.githubRepoCalls, [
    '/admin/api/github/installations/77/repos?q=&page=1',
  ]);
  assert.match(harness.app.innerHTML, /Loading repositories/);
  pending[0]?.(jsonResponse({
    repos: [{ fullName: 'acme/first', private: false, defaultBranch: 'main' }],
    totalCount: 4,
    truncated: false,
  }));
  await flushAsync();
  assert.match(harness.app.innerHTML, /acme\/first/);

  input({ target: inputTarget({ 'data-action': 'repo-search' }, 'old') });
  input({ target: inputTarget({ 'data-action': 'repo-search' }, 'new') });
  assert.deepEqual(harness.githubRepoCalls.slice(1), [
    '/admin/api/github/installations/77/repos?q=old&page=1',
    '/admin/api/github/installations/77/repos?q=new&page=1',
  ]);
  pending[2]?.(jsonResponse({
    repos: [{ fullName: 'acme/new-result', private: true, defaultBranch: 'main' }],
    totalCount: 4,
    truncated: false,
  }));
  await flushAsync();
  pending[1]?.(jsonResponse({
    repos: [{ fullName: 'acme/old-result', private: true, defaultBranch: 'main' }],
    totalCount: 4,
    truncated: false,
  }));
  await flushAsync();

  assert.match(harness.app.innerHTML, /acme\/new-result/);
  assert.doesNotMatch(harness.app.innerHTML, /acme\/old-result/);

  change({
    target: valueTarget({ 'data-action': 'repo-select', 'data-repo': 'acme/new-result' }, '', true),
  });
  assert.match(harness.app.innerHTML, /1 repo selected/);
  click({ target: actionTarget({ 'data-action': 'repo-picker-apply' }) });

  assert.doesNotMatch(harness.app.innerHTML, /data-action="repo-picker-apply"/);
  assert.match(harness.app.innerHTML, /<span class="repo-name mono">acme\/new-result<\/span>/);
});

test('a Repositories picker failure stays inside the picker and offers a local retry', async () => {
  const harness = runAdminPageHarness({
    githubStatus: {
      mode: 'app',
      installations: [
        { id: 78, accountLogin: 'acme', accountType: 'Organization', repoCount: null },
      ],
      referencingProfiles: [],
    },
    githubRepoError: {
      status: 502,
      error: 'github_unavailable',
      message: 'Repository catalog unavailable. Paste an exact source or retry.',
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'repositories' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'repo-add' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Repository catalog unavailable\. Paste an exact source or retry\./);
  assert.match(harness.app.innerHTML, /data-action="repo-picker-retry"/);
  assert.equal(harness.githubRepoCalls.length, 1);

  click({ target: actionTarget({ 'data-action': 'repo-picker-retry' }) });
  await flushAsync();
  assert.deepEqual(harness.githubRepoCalls, [
    '/admin/api/github/installations/78/repos?q=&page=1',
    '/admin/api/github/installations/78/repos?q=&page=1',
  ]);

  click({ target: actionTarget({ 'data-action': 'repo-picker-cancel' }) });
  assert.doesNotMatch(harness.app.innerHTML, /data-action="repo-picker-retry"/);
  assert.match(harness.app.innerHTML, /data-action="repo-add"/);
});
