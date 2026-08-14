import assert from 'node:assert/strict';
import vm from 'node:vm';
import { test } from 'node:test';

import { renderAdminPage } from '../src/admin/page.ts';
import { connectorSkillsForConnections } from '../src/config/connector-skills.ts';
import { seededAgents, seededAssignments } from '../src/config/seed.ts';

test('admin navigation exposes the signed-in account surface', () => {
  const html = renderAdminPage();
  assert.match(html, /href="\/admin\/account">Account<\/a>/);
});

test('the dedicated onboarding frame remains document-scrollable on desktop', () => {
  const html = renderAdminPage();
  assert.match(
    html,
    /\.frame\.onboarding-frame\s*\{[^}]*height:\s*auto;[^}]*overflow:\s*visible;/s,
  );
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
  channelPromptAddendum?: string;
};
type SlackConnectionFixture = {
  connected: boolean;
  credentials: { botToken: string; signingSecret: string; botUserId: string };
  teamId?: string | null;
  teamName?: string | null;
  requestUrl: string;
  manifestUrl: string;
};
type SlackIdentityFixture = {
  displayName: string;
  avatarUrl: string | null;
  botUserId: string;
  appId: string | null;
  consoleUrl: string;
};
type SlackIdentityErrorFixture = { status: number; error: string; message?: string };
type SlackIdentityResultFixture = SlackIdentityFixture | SlackIdentityErrorFixture;
type SlackPostResultFixture = {
  status?: number;
  error?: string;
  detail?: string;
  message?: string;
  missingScopes?: string[];
  consoleUrl?: string;
  eventsVerificationRequired?: boolean;
};
type SlackIdentityAdminFixture = {
  id: string;
  kind: 'workspace_default' | 'dedicated';
  lifecycle: 'setup_incomplete' | 'credentials_pending' | 'connected' | 'degraded' | 'retired';
  dmState: 'on' | 'off' | 'needs_setup';
  effectiveDmState: 'on' | 'off' | 'needs_setup';
  globalDmAllowed: boolean;
  dmAgentId: string | null;
  dmProfile: { id: string; name: string; enabled: boolean } | null;
  connectionRevision: number;
  displayName: string;
  avatarUrl: string | null;
  health: 'healthy' | 'degraded' | 'unknown' | 'disconnected' | 'uninstalled' | 'unauthorized';
  healthDetail?: string | null;
  appId?: string | null;
  consoleUrl?: string;
  observedAt?: number | null;
  credentialProvenance?: 'workspace_default' | 'stored' | 'none';
  pendingDeliveryCount?: number;
  setupSourceProfileId?: string | null;
  setupReconnecting?: boolean;
  profiles: Array<{ id: string; name: string; enabled: boolean }>;
};
type SlackIdentitiesFixture = {
  identities: SlackIdentityAdminFixture[];
  globalDmAllowed: boolean;
};
type SlackChannelFixture = { id: string; name: string; isPrivate?: boolean; isMember?: boolean };
type SlackChannelsFixture = {
  channels: SlackChannelFixture[];
  teamId: string;
  teamName: string;
  truncated?: boolean;
};
type OnboardingFixture = {
  stage: 'connect_slack' | 'choose_channel' | 'try' | 'complete';
  revision: string;
  workspace: { id: string; name: string | null } | null;
  channel: { id: string; name: string } | null;
  tryStartedAt: number | null;
  completedAt: number | null;
  agentId?: string;
  redirectTo?: string;
};
type SlackBehaviorEntry = { value: boolean; source: 'env' | 'stored' | 'default' };
type SlackBehaviorFixture = {
  allowDms: SlackBehaviorEntry;
  unassignedHint: SlackBehaviorEntry;
  welcomeOnJoin: SlackBehaviorEntry;
  ambientParticipation: SlackBehaviorEntry;
  progressiveStreaming: SlackBehaviorEntry;
  nativeTasks: SlackBehaviorEntry;
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
      channelPromptAddendum: 'Release channel addendum.',
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
type MemoryScopeFixture = {
  workspaceId: string;
  channelId: string;
  displayName: string;
  privacy: 'public' | 'private';
  lifecycle: string;
  storeId: string;
  generation: number | null;
  entryCount: number;
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
    slackBehavior?: SlackBehaviorFixture;
    slackBehaviorGetFailures?: number;
    slackBehaviorPutError?: { status: number; error: string; message?: string };
    slackIdentity?: SlackIdentityFixture;
    slackIdentityError?: SlackIdentityErrorFixture;
    slackIdentities?: SlackIdentitiesFixture;
    slackIdentityAttachError?: {
      status: number;
      error: string;
      message?: string;
      channels?: Array<{ workspaceId: string; channelId: string; label: string }>;
      unenumeratedRules?: Array<{ workspaceId: string; channelId: string }>;
    };
    deferSlackIdentity?: boolean;
    deferSlackIdentityConnect?: boolean;
    slackTestError?: { status: number; error: string; detail?: string };
    slackPostError?: SlackPostResultFixture & { status: number; error: string };
    slackPostResults?: SlackPostResultFixture[];
    deferSlackPost?: boolean;
    slackDisconnectError?: { status: number; error: string };
    initialPath?: string;
    slackChannels?: SlackChannelsFixture;
    channelIndex?: Array<Record<string, unknown>>;
    channelIndexError?: { status: number; error: string; message?: string };
    onboarding?: OnboardingFixture | null;
    slackChannelFailures?: number;
    putIsMember?: boolean;
    putAssignmentError?: { status: number; error: string; message?: string };
    cloudflare?: boolean;
    agents?: unknown[];
    providers?: ProviderSummaryFixture[];
    openrouterFavorites?: string[];
    openrouterModels?: Array<{ id: string; context_length?: number; pricing?: Record<string, string> }>;
    workersAiFavorites?: string[];
    workersAiModels?: Array<{ id: string }>;
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
    attachSelectionValue?: string;
    swapSelectionValue?: string;
    effectiveError?: { status: number; error: string; message?: string };
    effectiveSlackIdentityId?: string;
    agentWriteError?: {
      status: number;
      error: string;
      message?: string;
      profileId?: string;
      identityIds?: string[];
    };
    mcpSecretPutFailures?: number;
    mcpSecretDeleteFailures?: number;
    apiConnectionSecretPutFailures?: number;
    apiConnectionSecretDeleteFailures?: number;
    skillResolution?: Record<string, unknown>;
    skillResolveError?: { status: number; error: string; message?: string };
    skillResolveFetch?: (source: string) => Promise<FakeResponse>;
    githubStatus?: GithubStatusFixture;
    githubRepoPages?: Record<string, GithubRepoPageFixture>;
    githubRepoError?: { status: number; error: string; message?: string };
    githubRepoFetch?: (path: string) => Promise<FakeResponse>;
    skillBrowseDom?: boolean;
    mcpTestResult?: { ok: true; tools: Array<{ name: string; title?: string; description?: string }> } | { ok: false; code: string; message: string };
    memoryScopes?: MemoryScopeFixture[];
    memoryFiles?: Record<string, unknown[]>;
    ownerMemoryFiles?: unknown[];
    deferMemoryFiles?: boolean;
    memorySaveError?: { status: number; error: string; currentVersion?: number };
    memoryDeleteError?: { status: number; error: string };
    memoryReviewError?: { status: number; error: string };
    scheduledWork?: ScheduledWorkFixture;
    redactScheduledName?: boolean;
    scheduledControlError?: { status: number; error: string; message?: string };
    oauthStartResult?: { authorizationUrl: string };
    oauthStartError?: { status: number; error: string; message?: string };
    apiOAuthStartResult?: { authorizationUrl: string };
    apiOAuthStartError?: { status: number; error: string; message?: string };
    deferAgentPatch?: boolean;
    initialSearch?: string;
    usageAdminUi?: boolean;
    usageApiError?: boolean;
    usageCoverage?: { pricedOperationCount: number; meteredOperationCount: number };
  } = {},
): {
  app: FakeElement;
  renderHistory: string[];
  modalRoot: FakeElement;
  favContainers: Record<string, FakeElement>;
  listeners: Record<string, Listener>;
  putAssignments: unknown[];
  onboardingTryPosts: Array<Record<string, unknown>>;
  slackPosts: unknown[];
  resolveSlackPost(callIndex: number, result?: SlackPostResultFixture): void;
  onboardingCredentialValues(): { botToken: string; signingSecret: string };
  slackBehaviorPuts: Array<Record<string, boolean>>;
  slackBehaviorGets(): number;
  slackTestCalls(): number;
  slackIdentityCalls(): number;
  resolveSlackIdentity(callIndex: number, result?: SlackIdentityResultFixture): void;
  slackDisconnectCalls(): number;
  slackIdentityAttachPosts: Array<{
    identityId: string;
    agentId: string;
    body: Record<string, unknown>;
  }>;
  slackIdentityCreates: Array<Record<string, unknown>>;
  slackIdentityDmPatches: Array<{ identityId: string; body: Record<string, unknown> }>;
  slackIdentitySetupPatches: Array<{ identityId: string; body: Record<string, unknown> }>;
  slackIdentityConnectPosts: Array<{ identityId: string; body: Record<string, unknown> }>;
  resolveSlackIdentityConnect(): void;
  slackIdentityVerifyPosts: Array<{ identityId: string; body: Record<string, unknown> }>;
  slackIdentityCancelPosts: Array<{ identityId: string; body: Record<string, unknown> }>;
  slackIdentityRetirePosts: Array<{ identityId: string; body: Record<string, unknown> }>;
  topbarRegion: FakeRegion;
  bodyRegion: FakeRegion;
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
  skillResolvePosts: Array<{ source: string }>;
  githubRepoCalls: string[];
  skillBrowseFocusCalls(): number;
  skillBrowseHostUpdates(): number;
  skillBrowseHtml(): string;
  skillBrowseScrollTop(): number;
  mcpTestPosts: Array<Record<string, unknown>>;
  oauthStartPosts: Array<{ agentId: string; connectionId: string; body: Record<string, unknown> }>;
  apiOAuthStartPosts: Array<{ agentId: string; connectionId: string; body: Record<string, unknown> }>;
  apiOAuthClientPuts: Array<{ agentId: string; connectionId: string; body: Record<string, unknown> }>;
  assignedUrls: string[];
  mcpSecretPuts: Array<{ agentId: string; id: string; body: Record<string, unknown> }>;
  mcpSecretDeletes: Array<{ agentId: string; id: string; body: Record<string, unknown> }>;
  apiConnectionSecretPuts: Array<{ agentId: string; id: string; body: Record<string, unknown> }>;
  apiConnectionSecretDeletes: Array<{ agentId: string; id: string; body: Record<string, unknown> }>;
  memoryPuts: Array<Record<string, unknown>>;
  memoryCreates: Array<{ body: Record<string, unknown>; idempotencyKey: string }>;
  memoryDeletes: Array<Record<string, unknown>>;
  memoryReviewPosts: Array<Record<string, unknown>>;
  scheduledControlPosts: Array<{ routineId: string; body: Record<string, unknown>; idempotencyKey: string }>;
  clipboardWrites: string[];
  resolveClipboardWrite(): void;
  gallerySearchFocusCalls(): number;
  gallerySearchSelections: Array<[number, number]>;
  resolveOpsEffective(): void;
  resolveMemoryFiles(channelId: string): void;
  resolveAgentPatch(): void;
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
  let appHtml = '';
  const renderHistory: string[] = [];
  let renderGeneration = 0;
  let sandboxBuildVariableSelectedAttached = false;
  let focusedAction: string | null = null;
  let activeElement: { focus(): void } | null = null;
  const focusElements: Record<string, { focus(): void }> = {};
  const focusElement = (name: string) => {
    if (!focusElements[name]) {
      const element = {
        focus() {
          focusedAction = name;
          activeElement = element;
        },
      };
      focusElements[name] = element;
    }
    return focusElements[name];
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
      if (!value.includes('id="onboarding-bot-token"')) onboardingCredentialDom.botToken.value = '';
      if (!value.includes('id="onboarding-signing-secret"')) onboardingCredentialDom.signingSecret.value = '';
      resetRegion(topbarRegion);
      resetRegion(bodyRegion);
    },
  };
  const modalRoot: FakeElement = { innerHTML: '' };
  const favContainers: Record<string, FakeElement> = {};
  const listeners: Record<string, Listener> = {};
  const putAssignments: unknown[] = [];
  const onboardingTryPosts: Array<Record<string, unknown>> = [];
  const slackPosts: unknown[] = [];
  const slackPostResolvers: Array<((result: SlackPostResultFixture) => void) | undefined> = [];
  const onboardingCredentialDom = {
    botToken: { value: '', focus: () => { focusedAction = 'onboarding-bot-token'; } },
    signingSecret: { value: '', focus: () => { focusedAction = 'onboarding-signing-secret'; } },
  };
  const slackIdentityAttachPosts: Array<{
    identityId: string;
    agentId: string;
    body: Record<string, unknown>;
  }> = [];
  const slackIdentityCreates: Array<Record<string, unknown>> = [];
  const slackIdentityDmPatches: Array<{ identityId: string; body: Record<string, unknown> }> = [];
  const slackIdentitySetupPatches: Array<{ identityId: string; body: Record<string, unknown> }> = [];
  const slackIdentityConnectPosts: Array<{ identityId: string; body: Record<string, unknown> }> = [];
  const slackIdentityVerifyPosts: Array<{ identityId: string; body: Record<string, unknown> }> = [];
  const slackIdentityCancelPosts: Array<{ identityId: string; body: Record<string, unknown> }> = [];
  const slackIdentityRetirePosts: Array<{ identityId: string; body: Record<string, unknown> }> = [];
  const slackBehaviorPuts: Array<Record<string, boolean>> = [];
  let slackBehaviorGets = 0;
  let slackTestCalls = 0;
  let slackIdentityCalls = 0;
  const slackIdentityResolvers: Array<((response: FakeResponse) => void) | undefined> = [];
  let slackDisconnectCalls = 0;
  const channelListCalls: string[] = [];
  const usageApiCalls: string[] = [];
  const scheduledApiCalls: string[] = [];
  const providerKeyPosts: Array<{ id: string; key: string }> = [];
  const providerKeyDeletes: string[] = [];
  const openAiSubscriptionPosts: Array<{ action: string; body: Record<string, unknown> }> = [];
  const openAiAuthMethodPuts: Array<'api_key' | 'subscription'> = [];
  let openAiSubscriptionDisconnects = 0;
  const favoritesPuts: Array<{ id: string; favorites: string[] }> = [];
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
  const skillResolvePosts: Array<{ source: string }> = [];
  const githubRepoCalls: string[] = [];
  const mcpTestPosts: Array<Record<string, unknown>> = [];
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
  const mcpSecretPuts: Array<{ agentId: string; id: string; body: Record<string, unknown> }> = [];
  const mcpSecretDeletes: Array<{ agentId: string; id: string; body: Record<string, unknown> }> = [];
  const apiConnectionSecretPuts: Array<{ agentId: string; id: string; body: Record<string, unknown> }> = [];
  const apiConnectionSecretDeletes: Array<{ agentId: string; id: string; body: Record<string, unknown> }> = [];
  const memoryPuts: Array<Record<string, unknown>> = [];
  const memoryCreates: Array<{ body: Record<string, unknown>; idempotencyKey: string }> = [];
  const memoryDeletes: Array<Record<string, unknown>> = [];
  const memoryReviewPosts: Array<Record<string, unknown>> = [];
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
  let slackBehavior: SlackBehaviorFixture = options.slackBehavior ?? {
    allowDms: { value: true, source: 'default' },
    unassignedHint: { value: true, source: 'default' },
    welcomeOnJoin: { value: true, source: 'default' },
    ambientParticipation: { value: true, source: 'default' },
    progressiveStreaming: { value: false, source: 'default' },
    nativeTasks: { value: false, source: 'default' },
  };
  let slackBehaviorGetFailures = options.slackBehaviorGetFailures ?? 0;
  const slackBehaviorPutError = options.slackBehaviorPutError;
  const slackIdentity: SlackIdentityFixture = options.slackIdentity ?? {
    displayName: 'Chickpea',
    avatarUrl: 'https://avatars.slack-edge.com/2026-07-28/chickpea_512.png',
    botUserId: 'U_BOT',
    appId: 'A_CHICKPEA',
    consoleUrl: 'https://api.slack.com/apps/A_CHICKPEA/general',
  };
  const slackIdentityError = options.slackIdentityError;
  let slackIdentities: SlackIdentitiesFixture = options.slackIdentities ?? {
    identities: [
      {
        id: 'slack_identity_default',
        kind: 'workspace_default',
        lifecycle: 'connected',
        dmState: 'on',
        effectiveDmState: 'on',
        globalDmAllowed: true,
        dmAgentId: releaseAgent.id,
        dmProfile: { id: releaseAgent.id, name: releaseAgent.name, enabled: true },
        connectionRevision: 1,
        displayName: slackIdentity.displayName,
        avatarUrl: slackIdentity.avatarUrl,
        health: 'healthy',
        profiles: [
          { id: releaseAgent.id, name: releaseAgent.name, enabled: true },
          { id: opsAgent.id, name: opsAgent.name, enabled: true },
        ],
      },
    ],
    globalDmAllowed: true,
  };
  const slackIdentityAttachError = options.slackIdentityAttachError;
  const deferSlackIdentity = options.deferSlackIdentity === true;
  const deferSlackIdentityConnect = options.deferSlackIdentityConnect === true;
  const slackChannels = options.slackChannels;
  let onboarding = options.onboarding ?? null;
  const putIsMember = options.putIsMember;
  const putAssignmentError = options.putAssignmentError;
  let slackChannelFailures = options.slackChannelFailures ?? 0;
  // Captured out here because the fetch parameter below is also named `options`
  // (the request init) and would otherwise shadow these harness fixtures.
  const agentsFixture = options.agents;
  const providerKeyReject = options.providerKeyReject;
  const providerSettingsError = options.providerSettingsError;
  const slackTestError = options.slackTestError;
  const slackPostError = options.slackPostError;
  const slackDisconnectError = options.slackDisconnectError;
  const modelProviders = options.modelProviders;
  const openAiModelsAfterMethodSwitch = options.openAiModelsAfterMethodSwitch;
  const effectiveError = options.effectiveError;
  const agentWriteError = options.agentWriteError;
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
  const githubRepoPages = options.githubRepoPages;
  const githubRepoError = options.githubRepoError;
  const githubRepoFetch = options.githubRepoFetch;
  let resolveOpsEffective: (() => void) | undefined;
  let resolveSlackIdentityConnect: (() => void) | undefined;
  const memoryFileResolvers: Record<string, () => void> = {};
  let memoryEntry = {
    entryId: 'mem_release', storeId: 'store_public_T_DESIGN', workspaceId: 'T_DESIGN',
    sourceChannelId: 'C0EXR3L9T', slug: 'release-guidance', description: 'Use the checklist.',
    type: 'project', body: 'Run <script>alert(1)</script> before release.', status: 'active',
    version: 1, modifiedAt: 1753444800000,
  };
  let memoryReview: { eventId: string; reasonCode: string; createdAt: number } | null = {
    eventId: 'audit_review', reasonCode: 'stale', createdAt: 1753444800000,
  };
  const memoryHistory: Array<Record<string, unknown>> = [
    { entryId: 'mem_release', version: 1, operation: 'create', createdAt: 1753444800000 },
  ];
  let defaultMemoryFiles: unknown[] = options.ownerMemoryFiles ?? [
    { name: 'MEMORY.md', path: 'channel/C0EXR3L9T/MEMORY.md', generated: true, entryId: null, content: '# Channel Memory Index\n\n- [release-guidance](release-guidance.md) — Use the checklist.\n' },
    { name: 'release-guidance.md', path: 'channel/C0EXR3L9T/release-guidance.md', generated: false, entryId: 'mem_release', version: 1, status: 'active', description: 'Use the checklist.' },
  ];
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
  const window = {
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      windowListeners[type] = listener;
    },
  };

  // Mutable provider state so a POST/DELETE key flips the /admin/api/providers
  // status the next loadSettings() reads (mirrors the real endpoint).
  const providerState: ProviderSummaryFixture[] =
    options.providers ?? [
      { id: 'anthropic', status: 'stored', modelCount: 10 },
      { id: 'openai', status: 'missing', modelCount: null, activeAuthMethod: 'api_key', subscription: { state: 'disconnected', updatedAt: 0 } },
      { id: 'openrouter', status: 'env', modelCount: null },
      { id: 'workers-ai', status: options.cloudflare ? 'env' : 'missing', modelCount: null },
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
    get activeElement() {
      return activeElement;
    },
    getElementById(id: string) {
      if (id === 'app') return app;
      if (id === 'modal-root') return modalRoot;
      if (id === 'onboarding-bot-token' && appHtml.includes('id="onboarding-bot-token"')) {
        return onboardingCredentialDom.botToken;
      }
      if (id === 'onboarding-signing-secret' && appHtml.includes('id="onboarding-signing-secret"')) {
        return onboardingCredentialDom.signingSecret;
      }
      if ((id === 'slack-permission-heading' || id === 'onboarding-connected-heading' || id === 'onboarding-channel-heading') && appHtml.includes(`id="${id}"`)) {
        return focusElement(id);
      }
      if (id.startsWith('ptab-') && appHtml.includes(`id="${id}"`)) {
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
      if (selector === '.topbar') return topbarRegion;
      if (selector === '.body') return bodyRegion;
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
      const agentOverflowAction = selector.match(/^\[data-action="(agent-lifecycle-(?:enable|disable)|delete-profile)"\]$/)?.[1];
      if (agentOverflowAction && appHtml.includes(`data-action="${agentOverflowAction}"`)) {
        return focusElement(agentOverflowAction);
      }
      if (selector === '[data-action="agent-overflow-toggle"]' && appHtml.includes('data-action="agent-overflow-toggle"')) {
        return focusElement('agent-overflow-toggle');
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
    addEventListener(type: string, listener: Listener) {
      listeners[type] = listener;
    },
  };

  // Mutable so a PATCH write is reflected by the follow-up GET (saveProfile
  // re-fetches and re-clones the editor from it), mirroring the real store.
  const agentsList: Record<string, unknown>[] = (agentsFixture ?? [releaseAgent, opsAgent]).map(
    (agent) => ({ ...(agent as Record<string, unknown>) }),
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
    totalTokens: 1500,
    estimateAmountMicros: 12500,
  };
  const usageOperation = {
    operation: {
      operationId: 'op_usage_fixture', operationKind: 'interactive_turn', sourceId: 'source_usage', status: 'completed',
      startedAt: usageNow - 60_000, finishedAt: usageNow - 55_000, installationId: 'chickpea', workspaceId: 'T_DESIGN',
      agentId: 'agent_release', agentLabel: 'Release <script>alert(1)</script>', channelId: 'D_PRIVATE', channelLabel: null,
      conversationKind: 'direct_message', routineId: null, routineLabel: null, routineRunId: null,
      requestedProvider: 'openai', requestedModel: 'gpt-4.1-mini', credentialRefId: 'cred_openai_environment', credentialVersion: 1,
      coverage: 'aggregate_only', telemetrySchemaVersion: 1, createdAt: usageNow - 60_000, updatedAt: usageNow - 55_000,
    },
    measurements: [{
      executionId: 'exec_usage_fixture', operationId: 'op_usage_fixture', operationStatus: 'completed', observedAt: usageNow - 55_000,
      providerRoute: 'openai', requestedProvider: 'openai', requestedModel: 'gpt-4.1-mini', returnedProvider: 'openai', returnedModel: 'gpt-4.1-mini',
      credentialRefId: 'cred_openai_environment', credentialVersion: 1, usageCompleteness: 'complete', inputTokens: 1000, outputTokens: 250,
      totalTokens: 1250, usageUnknownReason: null, estimateCompleteness: 'complete', estimateAmountMicros: 12500, estimateCurrency: 'USD',
      priceVersionId: 'openai_2026-07-28', priceUnknownReason: null, recordedAt: usageNow - 55_000,
    }],
  };
  const slackIdentityResponse = (result: SlackIdentityResultFixture): FakeResponse => {
    if ('status' in result) {
      return jsonResponse(
        {
          error: result.error,
          ...(result.message ? { message: result.message } : {}),
        },
        result.status,
      );
    }
    return jsonResponse(result);
  };
  const slackPostResponse = (result: SlackPostResultFixture = {}): FakeResponse => {
    if (result.error) {
      return jsonResponse(result, result.status ?? 422);
    }
    if (result.eventsVerificationRequired) {
      return jsonResponse({
        ok: true,
        connected: false,
        eventsVerificationRequired: true,
        consoleUrl: result.consoleUrl,
        team: 'Acme Inc',
        botName: 'tag',
        botUserId: 'U_BOT',
      }, 202);
    }
    // A successful save flips the fixture to connected/stored, exactly like
    // the real endpoint's follow-up GET would report.
    if (slackConnection) {
      slackConnection.connected = true;
      slackConnection.credentials = {
        botToken: 'stored',
        signingSecret: 'stored',
        botUserId: 'stored',
      };
    }
    if (onboarding && onboarding.stage === 'connect_slack') {
      onboarding = {
        ...onboarding,
        stage: 'choose_channel',
        revision: '{"version":2,"state":"active"}',
        workspace: { id: 'T_DESIGN', name: 'Acme Inc' },
      };
    }
    return jsonResponse({
      ok: true,
      team: 'Acme Inc',
      botName: 'tag',
      botUserId: 'U_BOT',
      note: 'Signing secret saved; Slack proves it on the first signed event.',
    });
  };

  const fetch = (path: string, options?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<FakeResponse> => {
    const method = options?.method ?? 'GET';
    if (path.startsWith('/admin/api/usage/')) {
      usageApiCalls.push(path);
      if (harnessOptions.usageApiError) return Promise.resolve(jsonResponse({ error: 'usage_unavailable' }, 503));
      if (path.startsWith('/admin/api/usage/overview')) {
        return Promise.resolve(jsonResponse({
          current: { from: usageNow - 30 * 86400000, to: usageNow, groupBy: 'channel', currency: 'USD', mixedCurrency: false, availableCurrencies: ['USD'], totals: usageTotals, groups: [{ key: 'direct_message', label: null, ...usageTotals }] },
          previous: { from: usageNow - 60 * 86400000, to: usageNow - 30 * 86400000, groupBy: 'channel', currency: 'USD', mixedCurrency: false, availableCurrencies: ['USD'], totals: { ...usageTotals, operationCount: 2, estimateAmountMicros: 10000 }, groups: [] },
        }));
      }
      if (path.startsWith('/admin/api/usage/operations')) {
        return Promise.resolve(jsonResponse({ items: [usageOperation], nextCursor: null }));
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
    if (path === '/admin/api/audit/memory/scopes' && method === 'GET') {
      return Promise.resolve(jsonResponse({
        scopes: harnessOptions.memoryScopes ?? [{
          workspaceId: 'T_DESIGN', channelId: 'C0EXR3L9T', displayName: 'eng-releases',
          privacy: 'public', lifecycle: 'active', storeId: 'store_public_T_DESIGN',
          generation: null, entryCount: 1,
        }],
      }));
    }
    const ownerFilesMatch = path.match(/^\/admin\/api\/audit\/memory\/owners\/(agent|channel)\/([^/]+)\/([^/]+)\/files$/);
    if (ownerFilesMatch && method === 'GET') {
      return Promise.resolve(jsonResponse({
        owner: { ownerKind: ownerFilesMatch[1], workspaceId: ownerFilesMatch[2], ownerId: ownerFilesMatch[3] },
        files: defaultMemoryFiles,
      }));
    }
    const ownerCreateMatch = path.match(/^\/admin\/api\/audit\/memory\/owners\/(agent|channel)\/([^/]+)\/([^/]+)\/entries$/);
    if (ownerCreateMatch && method === 'POST') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      const idempotencyKey = options?.headers?.['idempotency-key'] ?? '';
      memoryCreates.push({ body, idempotencyKey });
      memoryEntry = {
        ...memoryEntry,
        entryId: 'mem_created',
        slug: String(body.slug),
        description: String(body.description),
        type: String(body.type),
        body: String(body.body),
        version: 1,
      };
      defaultMemoryFiles = [
        ...defaultMemoryFiles,
        { name: `${String(body.slug)}.md`, path: `${String(body.slug)}.md`, generated: false, entryId: 'mem_created', version: 1, status: 'active', description: body.description },
      ];
      return Promise.resolve(jsonResponse({
        owner: { ownerKind: ownerCreateMatch[1], workspaceId: ownerCreateMatch[2], ownerId: ownerCreateMatch[3] },
        entry: memoryEntry,
        projected: memoryEntry.body,
      }, 201));
    }
    const ownerEntryMatch = path.match(/^\/admin\/api\/audit\/memory\/owners\/(agent|channel)\/([^/]+)\/([^/]+)\/entries\/([^/]+)$/);
    if (ownerEntryMatch && method === 'GET') {
      return Promise.resolve(jsonResponse({
        owner: { ownerKind: ownerEntryMatch[1], workspaceId: ownerEntryMatch[2], ownerId: ownerEntryMatch[3] },
        entry: memoryEntry,
        projected: '---\nname: "release-guidance"\n---\n\n' + memoryEntry.body + '\n',
        unresolvedReview: memoryReview,
      }));
    }
    if (ownerEntryMatch && method === 'PUT') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      memoryPuts.push(body);
      memoryEntry = {
        ...memoryEntry,
        description: String(body.description ?? ''),
        type: String(body.type ?? 'fact'),
        body: String(body.body ?? ''),
        version: memoryEntry.version + 1,
        modifiedAt: memoryEntry.modifiedAt + 1000,
      };
      memoryHistory.push({ entryId: memoryEntry.entryId, version: memoryEntry.version, operation: 'update', createdAt: memoryEntry.modifiedAt });
      return Promise.resolve(jsonResponse({ entry: memoryEntry, projected: memoryEntry.body }));
    }
    if (ownerEntryMatch && method === 'DELETE') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      memoryDeletes.push(body);
      defaultMemoryFiles = defaultMemoryFiles.filter((file) => (file as Record<string, unknown>).entryId !== memoryEntry.entryId);
      return Promise.resolve(jsonResponse({ entry: { ...memoryEntry, status: 'forgotten' }, irreversible: true }));
    }
    if (path.match(/^\/admin\/api\/audit\/memory\/owners\/(agent|channel)\/[^/]+\/[^/]+\/entries\/[^/]+\/history$/) && method === 'GET') {
      return Promise.resolve(jsonResponse({ revisions: memoryHistory }));
    }
    if (path.startsWith('/admin/api/audit/memory/stores/') && path.includes('/files?sourceChannelId=') && method === 'GET') {
      const channelId = new URL(path, 'http://admin.test').searchParams.get('sourceChannelId') ?? '';
      const files = harnessOptions.memoryFiles?.[channelId] ?? (channelId === 'C0EXR3L9T' ? defaultMemoryFiles : []);
      if (!harnessOptions.deferMemoryFiles) return Promise.resolve(jsonResponse({ files }));
      return new Promise<FakeResponse>((resolve) => {
        memoryFileResolvers[channelId] = () => resolve(jsonResponse({ files }));
      });
    }
    if (path === '/admin/api/audit/memory/entries/mem_release/history' && method === 'GET') {
      return Promise.resolve(jsonResponse({ revisions: memoryHistory }));
    }
    if (path === '/admin/api/audit/memory/entries/mem_release' && method === 'PUT') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      memoryPuts.push(body);
      if (harnessOptions.memorySaveError) {
        if (harnessOptions.memorySaveError.error === 'memory_version_conflict') {
          memoryEntry = {
            ...memoryEntry,
            version: harnessOptions.memorySaveError.currentVersion ?? memoryEntry.version + 1,
            description: 'Latest saved guidance.',
            body: 'Latest saved body.',
            modifiedAt: memoryEntry.modifiedAt + 1000,
          };
        }
        return Promise.resolve(jsonResponse(harnessOptions.memorySaveError, harnessOptions.memorySaveError.status));
      }
      memoryEntry = {
        ...memoryEntry,
        description: String(body.description ?? ''),
        type: String(body.type ?? 'fact'),
        body: String(body.body ?? ''),
        version: memoryEntry.version + 1,
        modifiedAt: memoryEntry.modifiedAt + 1000,
      };
      memoryHistory.push({
        entryId: memoryEntry.entryId,
        version: memoryEntry.version,
        operation: 'update',
        createdAt: memoryEntry.modifiedAt,
      });
      defaultMemoryFiles = defaultMemoryFiles.map((file) => {
        const record = file as Record<string, unknown>;
        return record.entryId === memoryEntry.entryId
          ? { ...record, version: memoryEntry.version, description: memoryEntry.description }
          : record;
      });
      return Promise.resolve(jsonResponse({
        entry: memoryEntry,
        projected: '---\nname: "release-guidance"\n---\n\n' + memoryEntry.body + '\n',
      }));
    }
    if (path === '/admin/api/audit/memory/entries/mem_release' && method === 'DELETE') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      memoryDeletes.push(body);
      if (harnessOptions.memoryDeleteError) {
        return Promise.resolve(jsonResponse(harnessOptions.memoryDeleteError, harnessOptions.memoryDeleteError.status));
      }
      defaultMemoryFiles = defaultMemoryFiles.filter((file) =>
        (file as Record<string, unknown>).entryId !== memoryEntry.entryId
      ).map((file) => ({
        ...(file as Record<string, unknown>),
        ...((file as Record<string, unknown>).generated
          ? { content: '# Channel Memory Index\n\n' }
          : {}),
      }));
      return Promise.resolve(jsonResponse({ irreversible: true }));
    }
    if (path === '/admin/api/audit/memory/entries/mem_release/reviews/audit_review/resolve' && method === 'POST') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      memoryReviewPosts.push(body);
      if (harnessOptions.memoryReviewError) {
        return Promise.resolve(jsonResponse(harnessOptions.memoryReviewError, harnessOptions.memoryReviewError.status));
      }
      memoryReview = null;
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    if (path === '/admin/api/audit/memory/entries/mem_release' && method === 'GET') {
      return Promise.resolve(jsonResponse({
        entry: memoryEntry,
        projected: '---\nname: "release-guidance"\n---\n\n' + memoryEntry.body + '\n',
        unresolvedReview: memoryReview,
      }));
    }
    if (path === '/admin/api/agents' && method === 'GET') {
      return Promise.resolve(jsonResponse({ agents: agentsList }));
    }
    const agentGetMatch = path.match(/^\/admin\/api\/agents\/([^/]+)$/);
    if (agentGetMatch && method === 'GET') {
      const id = decodeURIComponent(agentGetMatch[1] as string);
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
      return Promise.resolve(jsonResponse({ channels: harnessOptions.channelIndex ?? [] }));
    }
    if (path === '/admin/api/agents' && method === 'POST') {
      if (agentWriteError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: agentWriteError.error,
              ...(agentWriteError.message ? { message: agentWriteError.message } : {}),
              ...(agentWriteError.profileId ? { profileId: agentWriteError.profileId } : {}),
              ...(agentWriteError.identityIds ? { identityIds: agentWriteError.identityIds } : {}),
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
              ...(agentWriteError.profileId ? { profileId: agentWriteError.profileId } : {}),
              ...(agentWriteError.identityIds ? { identityIds: agentWriteError.identityIds } : {}),
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
              ...(agentWriteError.profileId ? { profileId: agentWriteError.profileId } : {}),
              ...(agentWriteError.identityIds ? { identityIds: agentWriteError.identityIds } : {}),
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
    if (path === '/admin/api/onboarding/try' && method === 'POST') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      onboardingTryPosts.push(body);
      onboarding = {
        stage: 'try',
        revision: JSON.stringify({ ...body, tryStartedAt: 1_800_000_000_000 }),
        workspace: { id: String(body.workspaceId), name: 'Acme Inc' },
        channel: { id: String(body.channelId), name: String(body.channelName) },
        tryStartedAt: 1_800_000_000_000,
        completedAt: null,
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
      return Promise.resolve(jsonResponse({ providers: modelProviders ?? [] }));
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
      if (slackBehaviorPutError) {
        return Promise.resolve(
          jsonResponse(
            {
              error: slackBehaviorPutError.error,
              ...(slackBehaviorPutError.message ? { message: slackBehaviorPutError.message } : {}),
            },
            slackBehaviorPutError.status,
          ),
        );
      }
      slackBehavior = {
        ...slackBehavior,
        ...Object.fromEntries(
          Object.entries(body).map(([key, value]) => [key, { value, source: 'stored' as const }]),
        ),
      };
      return Promise.resolve(jsonResponse(slackBehavior));
    }
    if (path === '/admin/api/slack-behavior') {
      slackBehaviorGets += 1;
      if (slackBehaviorGetFailures > 0) {
        slackBehaviorGetFailures -= 1;
        return Promise.resolve(
          jsonResponse({ error: 'slack_behavior_unavailable', message: 'Behavior service unavailable.' }, 503),
        );
      }
      return Promise.resolve(jsonResponse(slackBehavior));
    }
    if (path === '/admin/api/slack-identities' && method === 'GET') {
      return Promise.resolve(jsonResponse(slackIdentities));
    }
    if (path === '/admin/api/slack-identities' && method === 'POST') {
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      slackIdentityCreates.push(body);
      const identity: SlackIdentityAdminFixture = {
        id: 'slack_identity_new_presence',
        kind: 'dedicated',
        lifecycle: 'setup_incomplete',
        dmState: 'on',
        effectiveDmState: 'on',
        globalDmAllowed: true,
        dmAgentId: String(body.initialDmAgentId || ''),
        dmProfile: {
          id: String(body.initialDmAgentId || ''),
          name: String(body.displayName || 'Profile'),
          enabled: true,
        },
        connectionRevision: 0,
        displayName: String(body.displayName || 'New identity'),
        avatarUrl: null,
        health: 'unknown',
        credentialProvenance: 'none',
        pendingDeliveryCount: 0,
        setupSourceProfileId: body.source === 'profile' ? String(body.initialDmAgentId || '') : null,
        profiles: [],
      };
      slackIdentities = {
        ...slackIdentities,
        identities: slackIdentities.identities.concat(identity),
      };
      return Promise.resolve(jsonResponse({
        identity,
        setupUrl: '/admin/settings/slack/identities/' + identity.id + '/setup',
        setup: {
          appName: String(body.appName || body.displayName || 'New identity'),
          botDisplayName: String(body.displayName || 'New identity'),
          manifestUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%22name%22%3A%22new%22%7D',
        },
      }, 201));
    }
    const slackIdentityResourceMatch = path.match(
      /^\/admin\/api\/slack-identities\/([^/]+)(?:\/(setup|connect|verify|refresh|cancel|retire))?$/,
    );
    if (slackIdentityResourceMatch) {
      const identityId = decodeURIComponent(slackIdentityResourceMatch[1] as string);
      const operation = slackIdentityResourceMatch[2] as string | undefined;
      const identity = slackIdentities.identities.find((item) => item.id === identityId);
      if (!identity) return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
      const setup = identity.lifecycle === 'setup_incomplete' || identity.lifecycle === 'credentials_pending'
        ? {
            appName: identity.displayName + ' App',
            botDisplayName: identity.displayName,
            manifestUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%22name%22%3A%22' + encodeURIComponent(identity.displayName) + '%22%7D',
          }
        : null;
      if (!operation && method === 'GET') {
        return Promise.resolve(jsonResponse({ identity, setup }));
      }
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      if (operation === 'setup' && method === 'PATCH') {
        slackIdentitySetupPatches.push({ identityId, body });
        identity.displayName = String(body.displayName || identity.displayName);
        identity.connectionRevision += 1;
        return Promise.resolve(jsonResponse({
          identity,
          setup: {
            appName: String(body.appName || ''),
            botDisplayName: identity.displayName,
            manifestUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%22name%22%3A%22saved%22%7D',
          },
        }));
      }
      if (operation === 'connect' && method === 'POST') {
        slackIdentityConnectPosts.push({ identityId, body });
        const completeConnect = () => {
          identity.setupReconnecting = identity.lifecycle === 'connected' || identity.lifecycle === 'degraded';
          identity.lifecycle = 'credentials_pending';
          identity.connectionRevision += 1;
          identity.credentialProvenance = 'stored';
          identity.appId = 'A_' + identityId.replace(/^slack_identity_/, '').toUpperCase();
          identity.consoleUrl = 'https://api.slack.com/apps/' + identity.appId + '/general';
          identity.avatarUrl = 'https://avatars.slack-edge.com/' + identity.appId + '.png';
          identity.observedAt = 1_800_000_000_000;
          return jsonResponse({ identity });
        };
        if (deferSlackIdentityConnect) {
          return new Promise((resolve) => {
            resolveSlackIdentityConnect = () => {
              resolveSlackIdentityConnect = undefined;
              resolve(completeConnect());
            };
          });
        }
        return Promise.resolve(completeConnect());
      }
      if (operation === 'verify' && method === 'POST') {
        slackIdentityVerifyPosts.push({ identityId, body });
        const reconnecting = identity.setupReconnecting === true;
        const setupSourceProfileId = identity.setupSourceProfileId ?? null;
        identity.lifecycle = 'connected';
        identity.health = 'healthy';
        identity.connectionRevision += 1;
        if (identity.setupSourceProfileId && !reconnecting) {
          const sourceProfile = agentsList.find((agent) => agent.id === identity.setupSourceProfileId);
          if (sourceProfile) {
            sourceProfile.slackIdentityId = identity.id;
            identity.profiles = [{ id: String(sourceProfile.id), name: String(sourceProfile.name), enabled: sourceProfile.enabled !== false }];
          }
        }
        identity.setupSourceProfileId = null;
        identity.setupReconnecting = false;
        return Promise.resolve(jsonResponse({
          identity,
          attachedProfileId: reconnecting ? null : setupSourceProfileId,
        }));
      }
      if (operation === 'refresh' && method === 'POST') {
        identity.health = 'healthy';
        identity.observedAt = 1_800_000_100_000;
        identity.connectionRevision += 1;
        return Promise.resolve(jsonResponse({ identity }));
      }
      if (operation === 'cancel' && method === 'POST') {
        slackIdentityCancelPosts.push({ identityId, body });
        slackIdentities = {
          ...slackIdentities,
          identities: slackIdentities.identities.filter((item) => item.id !== identityId),
        };
        return Promise.resolve(jsonResponse({ ok: true, deleted: true }));
      }
      if (operation === 'retire' && method === 'POST') {
        slackIdentityRetirePosts.push({ identityId, body });
        identity.lifecycle = 'retired';
        identity.health = 'disconnected';
        identity.credentialProvenance = 'none';
        identity.connectionRevision += 1;
        return Promise.resolve(jsonResponse({
          identity,
          slackAppUninstalled: false,
          slackAppRevoked: false,
          message: 'Retired this Slack identity locally. The Slack app was not uninstalled or revoked.',
        }));
      }
    }
    const slackIdentityProfileMatch = path.match(
      /^\/admin\/api\/slack-identities\/([^/]+)\/profiles\/([^/]+)$/,
    );
    if (slackIdentityProfileMatch && method === 'POST') {
      const identityId = decodeURIComponent(slackIdentityProfileMatch[1] as string);
      const agentId = decodeURIComponent(slackIdentityProfileMatch[2] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      slackIdentityAttachPosts.push({ identityId, agentId, body });
      if (slackIdentityAttachError) {
        return Promise.resolve(jsonResponse(slackIdentityAttachError, slackIdentityAttachError.status));
      }
      const identity = slackIdentities.identities.find((item) => item.id === identityId);
      const profile = agentsList.find((agent) => agent.id === agentId);
      if (!identity || !profile) return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
      if (body.preflightOnly !== true) {
        if (identityId === 'slack_identity_default') delete profile.slackIdentityId;
        else profile.slackIdentityId = identityId;
      }
      return Promise.resolve(jsonResponse({
        profile,
        identity,
        membership: { ready: true, checkedChannels: [], joinedChannels: [], unenumeratedRules: [] },
        newThreadsOnly: true,
      }));
    }
    const slackIdentityDmMatch = path.match(
      /^\/admin\/api\/slack-identities\/([^/]+)\/dms$/,
    );
    if (slackIdentityDmMatch && method === 'PATCH') {
      const identityId = decodeURIComponent(slackIdentityDmMatch[1] as string);
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      slackIdentityDmPatches.push({ identityId, body });
      const identity = slackIdentities.identities.find((item) => item.id === identityId);
      if (!identity) return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
      identity.dmAgentId = String(body.dmAgentId || '');
      const handler = agentsList.find((agent) => agent.id === identity.dmAgentId);
      identity.dmProfile = handler
        ? { id: String(handler.id), name: String(handler.name), enabled: handler.enabled !== false }
        : null;
      identity.dmState = body.dmState === 'off' ? 'off' : 'on';
      identity.effectiveDmState = identity.dmState;
      identity.connectionRevision += 1;
      return Promise.resolve(jsonResponse({ identity }));
    }
    if (path === '/admin/api/slack-identity') {
      slackIdentityCalls += 1;
      if (deferSlackIdentity) {
        return new Promise((resolve) => {
          slackIdentityResolvers[slackIdentityCalls - 1] = resolve;
        });
      }
      if (slackIdentityError) {
        return Promise.resolve(slackIdentityResponse(slackIdentityError));
      }
      return Promise.resolve(slackIdentityResponse(slackIdentity));
    }
    if (path === '/admin/api/slack-connection/test' && method === 'POST') {
      slackTestCalls += 1;
      if (slackTestError) {
        return Promise.resolve(jsonResponse(slackTestError, slackTestError.status));
      }
      return Promise.resolve(
        jsonResponse({ ok: true, teamId: 'T_DESIGN', teamName: 'Acme Inc', botName: 'tag', botUserId: 'U_BOT' }),
      );
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
    if (path === '/admin/api/slack-connection' && method === 'POST') {
      slackPosts.push(JSON.parse(options?.body ?? '{}'));
      const callIndex = slackPosts.length - 1;
      const configured = harnessOptions.slackPostResults?.[callIndex] ?? slackPostError ?? {};
      if (harnessOptions.deferSlackPost) {
        return new Promise((resolve) => {
          slackPostResolvers[callIndex] = (result) => resolve(slackPostResponse(result));
        });
      }
      return Promise.resolve(slackPostResponse(configured));
    }
    if (path === '/admin/api/slack-connection') {
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
      const effective = effectiveConfig(releaseAgent, 'C0EXR3L9T') as {
        config: Record<string, unknown>;
      };
      effective.config.slackIdentityId = harnessOptions.effectiveSlackIdentityId ??
        'slack_identity_default';
      return Promise.resolve(jsonResponse(effective));
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
    onboardingTryPosts,
    slackPosts,
    resolveSlackPost(callIndex: number, result: SlackPostResultFixture = {}) {
      const resolve = slackPostResolvers[callIndex];
      assert.ok(resolve, `expected Slack connection request ${callIndex} to be pending`);
      slackPostResolvers[callIndex] = undefined;
      resolve(result);
    },
    onboardingCredentialValues: () => ({
      botToken: onboardingCredentialDom.botToken.value,
      signingSecret: onboardingCredentialDom.signingSecret.value,
    }),
    slackBehaviorPuts,
    slackBehaviorGets: () => slackBehaviorGets,
    slackTestCalls: () => slackTestCalls,
    slackIdentityCalls: () => slackIdentityCalls,
    resolveSlackIdentity(callIndex: number, result: SlackIdentityResultFixture = slackIdentity) {
      const resolve = slackIdentityResolvers[callIndex];
      assert.ok(resolve, `expected Slack identity request ${callIndex} to be pending`);
      slackIdentityResolvers[callIndex] = undefined;
      resolve(slackIdentityResponse(result));
    },
    slackDisconnectCalls: () => slackDisconnectCalls,
    slackIdentityAttachPosts,
    slackIdentityCreates,
    slackIdentityDmPatches,
    slackIdentitySetupPatches,
    slackIdentityConnectPosts,
    slackIdentityVerifyPosts,
    slackIdentityCancelPosts,
    slackIdentityRetirePosts,
    resolveSlackIdentityConnect() {
      assert.ok(resolveSlackIdentityConnect, 'expected Slack identity connect request to be pending');
      resolveSlackIdentityConnect();
    },
    topbarRegion,
    bodyRegion,
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
    skillResolvePosts,
    githubRepoCalls,
    skillBrowseFocusCalls: () => skillBrowseFocusCalls,
    skillBrowseHostUpdates: () => skillBrowseHostUpdates,
    skillBrowseHtml: () => skillBrowseHost.innerHTML,
    skillBrowseScrollTop: () => skillBrowseList.scrollTop,
    mcpTestPosts,
    oauthStartPosts,
    apiOAuthStartPosts,
    apiOAuthClientPuts,
    assignedUrls,
    mcpSecretPuts,
    mcpSecretDeletes,
    apiConnectionSecretPuts,
    apiConnectionSecretDeletes,
    memoryPuts,
    memoryCreates,
    memoryDeletes,
    memoryReviewPosts,
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
    resolveMemoryFiles(channelId: string) {
      const resolve = memoryFileResolvers[channelId];
      assert.ok(resolve, `expected ${channelId} memory files request to be pending`);
      delete memoryFileResolvers[channelId];
      resolve();
    },
    resolveAgentPatch() {
      assert.ok(resolveAgentPatch, 'expected agent PATCH request to be pending');
      resolveAgentPatch();
    },
  };
}

async function openReleaseAttachPicker(
  harness: ReturnType<typeof runAdminPageHarness>,
): Promise<Listener> {
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
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

function onboardingConnectFixture(): OnboardingFixture {
  return {
    stage: 'connect_slack',
    revision: '{"version":1}',
    workspace: null,
    channel: null,
    tryStartedAt: null,
    completedAt: null,
  };
}

function submitOnboardingSlack(
  harness: ReturnType<typeof runAdminPageHarness>,
  botToken: string,
  signingSecret: string,
): void {
  harness.listeners.submit?.({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken, signingSecret },
    ),
    preventDefault() {},
  });
}

function connectedSlackFixture(): SlackConnectionFixture {
  return {
    connected: true,
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

function multiSlackIdentitiesFixture(): SlackIdentitiesFixture {
  return {
    identities: [
      {
        id: 'slack_identity_default',
        kind: 'workspace_default',
        lifecycle: 'connected',
        dmState: 'on',
        effectiveDmState: 'on',
        globalDmAllowed: true,
        dmAgentId: releaseAgent.id,
        dmProfile: { id: releaseAgent.id, name: releaseAgent.name, enabled: true },
        connectionRevision: 2,
        displayName: 'Chickpea',
        avatarUrl: 'https://avatars.slack-edge.com/chickpea.png',
        health: 'healthy',
        appId: 'A_CHICKPEA',
        consoleUrl: 'https://api.slack.com/apps/A_CHICKPEA/general',
        observedAt: 1_800_000_000_000,
        credentialProvenance: 'workspace_default',
        pendingDeliveryCount: 0,
        profiles: [
          { id: releaseAgent.id, name: releaseAgent.name, enabled: true },
          { id: opsAgent.id, name: opsAgent.name, enabled: true },
        ],
      },
      {
        id: 'slack_identity_finance',
        kind: 'dedicated',
        lifecycle: 'connected',
        dmState: 'on',
        effectiveDmState: 'on',
        globalDmAllowed: true,
        dmAgentId: opsAgent.id,
        dmProfile: { id: opsAgent.id, name: opsAgent.name, enabled: true },
        connectionRevision: 7,
        displayName: 'Finance',
        avatarUrl: 'https://avatars.slack-edge.com/finance.png',
        health: 'healthy',
        appId: 'A_FINANCE',
        consoleUrl: 'https://api.slack.com/apps/A_FINANCE/general',
        observedAt: 1_800_000_000_000,
        credentialProvenance: 'stored',
        pendingDeliveryCount: 0,
        profiles: [{ id: opsAgent.id, name: opsAgent.name, enabled: true }],
      },
    ],
    globalDmAllowed: true,
  };
}

function incompleteSlackIdentityFixture(
  overrides: Partial<SlackIdentityAdminFixture> = {},
): SlackIdentityAdminFixture {
  return {
    id: 'slack_identity_launch',
    kind: 'dedicated',
    lifecycle: 'setup_incomplete',
    dmState: 'on',
    effectiveDmState: 'on',
    globalDmAllowed: true,
    dmAgentId: releaseAgent.id,
    dmProfile: { id: releaseAgent.id, name: releaseAgent.name, enabled: true },
    connectionRevision: 0,
    displayName: 'Launch',
    avatarUrl: null,
    health: 'unknown',
    credentialProvenance: 'none',
    pendingDeliveryCount: 0,
    setupSourceProfileId: releaseAgent.id,
    profiles: [],
    ...overrides,
  };
}

test('Settings Slack identities is a durable default-first management screen', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities',
    slackIdentities: multiSlackIdentitiesFixture(),
  });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/settings/slack/identities');
  assert.equal(harness.app.className, 'frame primary-admin-shell');
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Slack identities<\/h1>/);
  assert.match(harness.app.innerHTML, /@Chickpea/);
  assert.match(harness.app.innerHTML, /Workspace default/);
  assert.match(harness.app.innerHTML, /@Finance/);
  assert.match(harness.app.innerHTML, /Direct messages/);
  assert.match(harness.app.innerHTML, /Handled by Ops Profile/);
  assert.match(harness.app.innerHTML, /Used by 2 Agents/);
  assert.match(harness.app.innerHTML, /Workspace credentials/);
  assert.match(harness.app.innerHTML, /Stored credentials/);
  assert.match(harness.app.innerHTML, /Add Slack identity/);
  assert.doesNotMatch(harness.app.innerHTML, /Paste.*signing secret/i);
});

test('an unconfigured workspace-default identity routes to the one Channels setup flow', async () => {
  const identities = multiSlackIdentitiesFixture();
  const workspaceDefault = identities.identities[0];
  assert.ok(workspaceDefault);
  workspaceDefault.lifecycle = 'setup_incomplete';
  workspaceDefault.health = 'disconnected';
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities',
    slackIdentities: identities,
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  assert.match(
    harness.app.innerHTML,
    /data-action="open-channels" data-identity="slack_identity_default">Connect @Chickpea<\/button>/,
  );
  assert.match(harness.app.innerHTML, /Not connected/);
  assert.match(harness.app.innerHTML, /Connect from Channels/);
  assert.match(harness.app.innerHTML, /Agent usage/);
  const workspaceDefaultActionAt = harness.app.innerHTML.indexOf(
    'data-identity="slack_identity_default"',
  );
  assert.notEqual(workspaceDefaultActionAt, -1);
  const workspaceDefaultRow = harness.app.innerHTML.slice(
    harness.app.innerHTML.lastIndexOf('<div class="identity-row">', workspaceDefaultActionAt),
    harness.app.innerHTML.indexOf('</button></div>', workspaceDefaultActionAt) + '</button></div>'.length,
  );
  assert.doesNotMatch(workspaceDefaultRow, /DM handler|Direct messages/);
  assert.doesNotMatch(
    harness.app.innerHTML,
    /data-action="slack-identity-open-setup" data-identity="slack_identity_default"/,
  );

  const click = harness.listeners.click;
  assert.ok(click);
  click({
    target: actionTarget({
      'data-action': 'open-channels',
      'data-identity': 'slack_identity_default',
    }),
  });
  await flushAsync();
  assert.equal(harness.locationPath(), '/admin/channels');
  assert.match(harness.app.innerHTML, /Connect @Chickpea/);
  assert.doesNotMatch(harness.app.innerHTML, /The workspace-default identity cannot be retired/);
});

test('an incomplete dedicated identity hides DM routing and resumes its own setup', async () => {
  const identities = multiSlackIdentitiesFixture();
  const finance = identities.identities.find((identity) =>
    identity.id === 'slack_identity_finance'
  );
  assert.ok(finance);
  finance.lifecycle = 'setup_incomplete';
  finance.health = 'disconnected';
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities',
    slackIdentities: identities,
  });
  await flushAsync();

  const financeActionAt = harness.app.innerHTML.indexOf(
    'data-identity="slack_identity_finance"',
  );
  assert.notEqual(financeActionAt, -1);
  const financeRow = harness.app.innerHTML.slice(
    harness.app.innerHTML.lastIndexOf('<div class="identity-row">', financeActionAt),
    harness.app.innerHTML.indexOf('</button></div>', financeActionAt) + '</button></div>'.length,
  );
  assert.match(financeRow, /Agent usage/);
  assert.match(financeRow, /Used by 1 Agent/);
  assert.match(financeRow, /data-action="slack-identity-open-setup"/);
  assert.match(financeRow, /Resume @Finance setup/);
  assert.doesNotMatch(financeRow, /DM handler|Direct messages/);
});

test('Settings can create a dedicated identity and land in its stable setup route', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities',
    slackIdentities: multiSlackIdentitiesFixture(),
  });
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  const change = harness.listeners.change;
  const submit = harness.listeners.submit;
  assert.ok(click && input && change && submit);

  click({ target: actionTarget({ 'data-action': 'slack-identity-create-open' }) });
  assert.match(harness.app.innerHTML, /Each distinct mention, avatar, and DM conversation requires another Slack app installation/);
  input({ target: valueTarget({ 'data-action': 'slack-identity-create-app-name' }, 'Finance Copilot') });
  input({ target: valueTarget({ 'data-action': 'slack-identity-create-display-name' }, 'Finance') });
  change({ target: valueTarget({ 'data-action': 'slack-identity-create-dm' }, opsAgent.id) });
  submit({
    preventDefault() {},
    target: submitTarget(
      { 'data-action': 'slack-identity-create-form' },
      { appName: 'Finance Copilot', displayName: 'Finance', initialDmAgentId: opsAgent.id },
    ),
  });
  await flushAsync();

  assert.deepEqual(harness.slackIdentityCreates.at(-1), {
    source: 'settings',
    initialDmAgentId: opsAgent.id,
    appName: 'Finance Copilot',
    displayName: 'Finance',
  });
  assert.equal(
    harness.locationPath(),
    '/admin/settings/slack/identities/slack_identity_new_presence/setup',
  );
  assert.match(harness.app.innerHTML, /Create app in Slack/);
  assert.match(harness.app.innerHTML, /does not change any Agent&rsquo;s Replies as selection/);
});

test('dedicated setup resumes without returned secrets and completes the signed callback stage', async () => {
  const identities = multiSlackIdentitiesFixture();
  identities.identities.push(incompleteSlackIdentityFixture());
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities/slack_identity_launch/setup',
    slackIdentities: identities,
  });
  await flushAsync();
  const click = harness.listeners.click;
  const submit = harness.listeners.submit;
  assert.ok(click && submit);

  assert.equal(harness.app.className, 'frame');
  assert.match(harness.app.innerHTML, /Set up @Launch/);
  assert.match(harness.app.innerHTML, /Create and install the Slack app/);
  assert.match(harness.app.innerHTML, /exact Slack page to change its avatar/);
  assert.doesNotMatch(harness.app.innerHTML, /Change avatar image in Slack/);
  assert.doesNotMatch(harness.app.innerHTML, /xoxb-live-secret|signing-live-secret/);
  click({ target: actionTarget({ 'data-action': 'slack-identity-credentials-open' }) });
  assert.match(harness.app.innerHTML, /Reinstall to Workspace/);
  submit({
    preventDefault() {},
    target: submitTarget(
      { 'data-action': 'slack-identity-credentials-form' },
      { botToken: 'xoxb-live-secret', signingSecret: 'signing-live-secret' },
    ),
  });
  await flushAsync();

  assert.deepEqual(harness.slackIdentityConnectPosts.at(-1), {
    identityId: 'slack_identity_launch',
    body: {
      expectedRevision: 0,
      botToken: 'xoxb-live-secret',
      signingSecret: 'signing-live-secret',
    },
  });
  assert.doesNotMatch(harness.app.innerHTML, /xoxb-live-secret|signing-live-secret/);
  assert.match(harness.app.innerHTML, /Set avatar and verify Slack/);
  assert.match(harness.app.innerHTML, /Current Slack avatar/);
  assert.match(harness.app.innerHTML, /src="https:\/\/avatars\.slack-edge\.com\/A_LAUNCH\.png"/);
  assert.match(
    harness.app.innerHTML,
    /href="https:\/\/api\.slack\.com\/apps\/A_LAUNCH\/general"[^>]*>Change avatar image in Slack &nearr;<\/a>/,
  );
  assert.match(harness.app.innerHTML, /Verify signed callback/);
  assert.doesNotMatch(harness.app.innerHTML, />Save names<\/button>/);

  click({ target: actionTarget({ 'data-action': 'slack-identity-verify' }) });
  await flushAsync();
  assert.equal(harness.slackIdentityVerifyPosts.length, 1);
  assert.match(harness.app.innerHTML, /Identity connected and attached to its creating Agent/);
  assert.match(harness.app.innerHTML, /Change avatar image in Slack/);
  assert.equal(harness.locationPath(), '/admin/settings/slack/identities/slack_identity_launch');
});

test('late dedicated credential validation cannot reopen setup after navigation', async () => {
  const identities = multiSlackIdentitiesFixture();
  identities.identities.push(incompleteSlackIdentityFixture());
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities/slack_identity_launch/setup',
    slackIdentities: identities,
    deferSlackIdentityConnect: true,
  });
  await flushAsync();
  const click = harness.listeners.click;
  const submit = harness.listeners.submit;
  assert.ok(click && submit);

  click({ target: actionTarget({ 'data-action': 'slack-identity-credentials-open' }) });
  submit({
    preventDefault() {},
    target: submitTarget(
      { 'data-action': 'slack-identity-credentials-form' },
      { botToken: 'xoxb-late-secret', signingSecret: 'late-signing-secret' },
    ),
  });
  await flushAsync();

  harness.popstate('/admin/settings/slack/identities');
  await flushAsync();
  harness.resolveSlackIdentityConnect();
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/settings/slack/identities');
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Slack identities<\/h1>/);
  assert.doesNotMatch(harness.app.innerHTML, /Verify signed callback/);
  assert.doesNotMatch(harness.app.innerHTML, /xoxb-late-secret|late-signing-secret/);
});

test('canceling setup confirms credential erasure before returning to the identity list', async () => {
  const identities = multiSlackIdentitiesFixture();
  identities.identities.push(incompleteSlackIdentityFixture());
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities/slack_identity_launch/setup',
    slackIdentities: identities,
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'slack-identity-cancel-open' }) });
  assert.match(harness.app.innerHTML, /Cancel this identity setup\?/);
  assert.equal(harness.bodyRegion.inert, true);
  click({ target: actionTarget({ 'data-action': 'slack-identity-confirm-apply' }) });
  await flushAsync();

  assert.deepEqual(harness.slackIdentityCancelPosts, [{
    identityId: 'slack_identity_launch',
    body: { expectedRevision: 0, deleteDraft: true },
  }]);
  assert.equal(harness.locationPath(), '/admin/settings/slack/identities');
  assert.match(
    harness.app.innerHTML,
    /Setup canceled after its stored credentials and callback were erased/,
  );
  assert.doesNotMatch(harness.app.innerHTML, /@Launch/);
});

test('identity detail separates Slack appearance, DM confirmation, reconnect, and retirement blockers', async () => {
  const identities = multiSlackIdentitiesFixture();
  const financeIdentity = identities.identities.find((identity) => identity.id === 'slack_identity_finance');
  assert.ok(financeIdentity);
  financeIdentity.setupSourceProfileId = opsAgent.id;
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities/slack_identity_finance',
    slackIdentities: identities,
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  const submit = harness.listeners.submit;
  assert.ok(click && change && submit);

  assert.equal(harness.app.className, 'frame');
  assert.match(harness.app.innerHTML, /Slack is the source of truth/);
  assert.match(harness.app.innerHTML, /href="https:\/\/api\.slack\.com\/apps\/A_FINANCE\/general"/);
  assert.match(harness.app.innerHTML, /Agent usage/);
  assert.match(harness.app.innerHTML, /Ops Profile/);
  assert.match(harness.app.innerHTML, /DMs handled by/);
  assert.match(harness.app.innerHTML, /Reconnect or rotate/);
  assert.match(harness.app.innerHTML, /Before retiring: move 1 Agent, turn DMs off/);

  change({ target: valueTarget({ 'data-action': 'slack-identity-dm-state' }, 'off') });
  change({ target: valueTarget({ 'data-action': 'slack-identity-dm-agent' }, opsAgent.id) });
  click({ target: actionTarget({ 'data-action': 'slack-identity-dm-save' }) });
  assert.match(harness.app.innerHTML, /Change DM behavior\?/);
  assert.equal(harness.bodyRegion.inert, true);
  click({ target: actionTarget({ 'data-action': 'slack-identity-confirm-apply' }) });
  await flushAsync();
  assert.equal(harness.slackIdentityDmPatches.at(-1)?.body.dmState, 'off');
  assert.match(harness.app.innerHTML, /DM behavior updated for future turns/);

  click({ target: actionTarget({ 'data-action': 'slack-identity-reconnect-open' }) });
  submit({
    preventDefault() {},
    target: submitTarget(
      { 'data-action': 'slack-identity-reconnect-form' },
      { botToken: 'xoxb-rotated', signingSecret: 'rotated-secret' },
    ),
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Reconnect @Finance/);
  assert.match(harness.app.innerHTML, /Verification does not change any Agent/);
  assert.match(harness.app.innerHTML, /this established identity cannot be deleted as a setup draft/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="slack-identity-cancel-open"/);
  assert.doesNotMatch(harness.app.innerHTML, />Save names<\/button>/);

  click({ target: actionTarget({ 'data-action': 'slack-identity-verify' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /No Agent&#39;s Replies as selection was changed/);
  assert.equal(financeIdentity.setupSourceProfileId, null);
  assert.equal(financeIdentity.setupReconnecting, false);
});

test('Slack identity loading never blocks core admin rendering', async () => {
  const channelsHarness = runAdminPageHarness({ deferSlackIdentity: true });
  await flushAsync();

  assert.equal(channelsHarness.slackIdentityCalls(), 1);
  assert.match(channelsHarness.app.innerHTML, /<h1 class="page-title">Channels<\/h1>/);
  assert.match(channelsHarness.app.innerHTML, /Channel assignments/);
  assert.doesNotMatch(channelsHarness.app.innerHTML, /Refreshing&hellip;/);

  const profilesHarness = runAdminPageHarness({
    initialPath: '/admin/agents',
    deferSlackIdentity: true,
  });
  await flushAsync();

  assert.match(profilesHarness.app.innerHTML, /<h1 class="page-title">Agents<\/h1>/);
  assert.equal(profilesHarness.slackIdentityCalls(), 0);

  channelsHarness.resolveSlackIdentity(0);
  await flushAsync();
  assert.match(channelsHarness.app.innerHTML, /<h1 class="page-title">Channels<\/h1>/);
});

test('Slack identity settings link is scoped to Slack settings and uses a safe new tab', async () => {
  const firstPaint = renderAdminPage().split('<script>')[0] ?? '';
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities/slack_identity_default',
    slackIdentities: multiSlackIdentitiesFixture(),
  });
  await flushAsync();

  assert.doesNotMatch(firstPaint, /Change avatar image in Slack/);
  const header = harness.app.innerHTML.match(/<header class="topbar">[\s\S]*?<\/header>/)?.[0] ?? '';
  assert.doesNotMatch(header, /Change avatar image in Slack/);
  const anchor = harness.app.innerHTML.match(/<a\b[^>]*href="https:\/\/api\.slack\.com\/apps\/A_CHICKPEA\/general"[^>]*>Change avatar image in Slack &nearr;<\/a>/)?.[0];
  assert.ok(anchor, 'expected the exact Slack identity settings anchor inside Slack settings');
  assert.match(anchor, /\btarget="_blank"/);
  const rel = anchor.match(/\brel="([^"]+)"/)?.[1]?.split(/\s+/) ?? [];
  assert.ok(rel.includes('noopener'));
  assert.ok(rel.includes('noreferrer'));
});

test('Slack overview keeps appearance management in Identities and uses the live name in behavior copy', async () => {
  const harness = runAdminPageHarness({
    slackIdentity: {
      displayName: 'Pea <Ops>',
      avatarUrl: 'https://avatars.slack-edge.com/pea.png?size=512&v=2',
      botUserId: 'U_PEA',
      appId: 'A_PEA',
      consoleUrl: 'https://api.slack.com/apps/A_PEA/general',
    },
  });
  await flushAsync();

  assert.equal(harness.slackIdentityCalls(), 1);
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Channels<\/h1>/);
  assert.doesNotMatch(harness.app.innerHTML, /avatars\.slack-edge\.com\/pea\.png/);
  assert.doesNotMatch(harness.app.innerHTML, /api\.slack\.com\/apps\/A_PEA\/general/);

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings', 'data-section': 'slack' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /When someone mentions @Pea &lt;Ops&gt; in an unassigned channel/);
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Slack identities<\/h1>/);
  assert.match(harness.app.innerHTML, /avatars\.slack-edge\.com\/pea\.png/);
  assert.doesNotMatch(harness.app.innerHTML, /api\.slack\.com\/apps\/A_PEA\/general/);
  click({ target: actionTarget({ 'data-action': 'open-channels' }) });
  click({
    target: actionTarget({
      'data-action': 'select-channel',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C0EXR3L9T',
    }),
  });
  await flushAsync();
  assert.match(harness.app.innerHTML, /replies as @Pea &lt;Ops&gt;/);

  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  assert.match(harness.app.innerHTML, /replies as @Pea &lt;Ops&gt;/);

  harness.popstate('/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/mem_release');
  await flushAsync();
  assert.doesNotMatch(harness.app.innerHTML, /!memory help|memory-copy-controls/);
});

test('a legacy live-identity outage does not block the identities management screen', async () => {
  const harness = runAdminPageHarness({
    slackIdentityError: {
      status: 502,
      error: 'slack_identity_unavailable',
      message: 'Slack identity could not be loaded.',
    },
  });
  await flushAsync();

  assert.equal(harness.slackIdentityCalls(), 1);
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Channels<\/h1>/);
  assert.doesNotMatch(harness.app.innerHTML, /Slack identity could not be loaded\./);

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings', 'data-section': 'slack' }) });
  await flushAsync();
  assert.equal(harness.locationPath(), '/admin/settings/slack/identities');
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Slack identities<\/h1>/);
});

test('Agent and Channel routes share the attached Agent roster and lower navigation', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.equal(harness.locationPath(), '/admin/channels');
  assert.deepEqual(harness.historyReplaces, []);
  assert.equal(harness.app.className, 'frame primary-admin-shell admin-surface admin-surface-channels-index');
  assert.match(html, /<aside class="rail primary-shell-sidebar agent-shell-sidebar">/);
  assert.match(html, /class="primary-shell-brand agent-shell-brand"[\s\S]*?data-action="go-home"[\s\S]*?Chickpea/);
  assert.doesNotMatch(html, /cloudflare · workers|local · node/);
  assert.match(html, /<nav class="agent-roster" aria-label="Agents">/);
  assert.match(html, /class="agent-roster-item" data-action="edit-profile" data-agent="agent_release"/);
  assert.match(html, /class="agent-roster-item" data-action="edit-profile" data-agent="agent_ops"/);
  assert.doesNotMatch(html, /class="agent-roster-item active"/);
  assert.match(html, /class="section-nav-item active" data-action="open-channels"[^>]*aria-current="page">Channels<\/button>/);
  assert.equal((html.match(/aria-label="Agents"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-label="Admin navigation"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<div class="rail-head"><span class="section-eyebrow">Channels<\/span><\/div>/);
  assert.match(html, /<h1 class="page-title">Channels<\/h1>/);
  assert.match(html, /Add Channel/);

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
  assert.match(harness.app.innerHTML, /class="agent-roster-item active" data-action="edit-profile" data-agent="agent_release"[^>]*aria-current="page"/);
  assert.match(harness.app.innerHTML, /class="section-nav-item active" data-action="open-channels"[^>]*aria-current="page">Channels<\/button>/);
  assert.match(harness.app.innerHTML, /data-action="channel-back" data-agent="agent_release"[^>]*>&larr; Release Profile<\/button>/);
  const channelHeader = harness.app.innerHTML.match(/<div class="main-head">[\s\S]*?<\/div><\/div>/)?.[0] ?? '';
  assert.doesNotMatch(channelHeader, /data-action="open-channel-memory"/);
  assert.match(harness.app.innerHTML, /Assigned Agent/);
  assert.match(harness.app.innerHTML, /Release Profile/);
  assert.doesNotMatch(harness.app.innerHTML, /Access summary/);
  assert.match(harness.app.innerHTML, /Resolved configuration/);
  assert.match(harness.app.innerHTML, /When it speaks/);
  assert.match(harness.app.innerHTML, /Try it in Slack/);
  assert.match(harness.app.innerHTML, /Additional instructions/);
  assert.match(harness.app.innerHTML, /Channel memory/);

  click({ target: actionTarget({ 'data-action': 'channel-back', 'data-agent': 'agent_release' }) });
  assert.equal(harness.locationPath(), '/admin/agents/agent_release');
  assert.match(harness.app.innerHTML, /class="agent-roster-item active" data-action="edit-profile" data-agent="agent_release"/);

  click({ target: actionTarget({ 'data-action': 'open-channels' }) });
  assert.equal(harness.locationPath(), '/admin/channels');
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Channels<\/h1>/);
  assert.doesNotMatch(harness.app.innerHTML, /class="agent-roster-item active"/);
});

test('Channels deep links and popstate keep the route and selected screen in sync', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T',
  });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/channels/T_DESIGN/C0EXR3L9T');
  assert.match(harness.app.innerHTML, /<h1 class="page-title mono-title">#eng-releases<\/h1>/);
  assert.match(harness.app.innerHTML, /class="agent-roster-item active" data-action="edit-profile" data-agent="agent_release"/);

  harness.popstate('/admin/channels');
  assert.equal(harness.locationPath(), '/admin/channels');
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Channels<\/h1>/);
  assert.doesNotMatch(harness.app.innerHTML, /class="agent-roster-item active"/);

  harness.popstate('/admin/agents/agent_ops');
  assert.equal(harness.locationPath(), '/admin/agents/agent_ops');
  assert.match(harness.app.innerHTML, /class="agent-roster-item active" data-action="edit-profile" data-agent="agent_ops"/);
});

test('Slack overview controls save behavior, test the connection, update credentials, and confirm disconnect', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/settings/slack/identities' });
  await flushAsync();

  const change = harness.listeners.change;
  const click = harness.listeners.click;
  const submit = harness.listeners.submit;
  assert.ok(change && click && submit);

  change({
    target: {
      checked: false,
      closest: () => null,
      getAttribute(name: string) {
        if (name === 'data-action') return 'slack-behavior';
        if (name === 'data-setting') return 'allowDms';
        return null;
      },
    } as unknown as FakeTarget,
  });
  await flushAsync();
  assert.deepEqual(harness.slackBehaviorPuts, [{ allowDms: false }]);
  assert.match(harness.app.innerHTML, /Allow direct messages[\s\S]*?<span class="behavior-state">Off<\/span>/);

  click({ target: actionTarget({ 'data-action': 'slack-test' }) });
  await flushAsync();
  assert.equal(harness.slackTestCalls(), 1);
  assert.match(harness.app.innerHTML, /Connection healthy · Acme Inc/);

  click({ target: actionTarget({ 'data-action': 'slack-update-open' }) });
  assert.match(harness.app.innerHTML, /Update Slack credentials/);
  assert.match(harness.app.innerHTML, /<label class="field-label" for="slack-update-bot-token">Bot User OAuth Token<\/label>/);
  assert.match(harness.app.innerHTML, /<input id="slack-update-bot-token"/);
  assert.match(harness.app.innerHTML, /<label class="field-label" for="slack-update-signing-secret">Signing Secret<\/label>/);
  assert.match(harness.app.innerHTML, /<input id="slack-update-signing-secret"/);
  submit({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: 'xoxb-rotated', signingSecret: 'rotated-secret' },
    ),
    preventDefault() {},
  });
  assert.match(harness.app.innerHTML, /Validating&hellip;/);
  assert.match(harness.app.innerHTML, /data-action="slack-update-close" disabled/);
  assert.match(harness.app.innerHTML, /data-action="slack-disconnect-open" disabled/);
  assert.match(harness.app.innerHTML, /data-action="slack-test" disabled/);
  click({ target: actionTarget({ 'data-action': 'slack-disconnect-open' }) });
  click({ target: actionTarget({ 'data-action': 'slack-update-close' }) });
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  assert.match(harness.app.innerHTML, /Update Slack credentials/);
  assert.doesNotMatch(harness.app.innerHTML, /Disconnect Acme Inc\?/);
  assert.doesNotMatch(harness.app.innerHTML, /<h1 class="page-title">Profiles<\/h1>/);
  assert.equal(harness.slackDisconnectCalls(), 0);
  await flushAsync();
  assert.deepEqual(harness.slackPosts, [{ botToken: 'xoxb-rotated', signingSecret: 'rotated-secret' }]);
  assert.doesNotMatch(harness.app.innerHTML, /Update Slack credentials/);

  click({ target: actionTarget({ 'data-action': 'slack-disconnect-open' }) });
  assert.match(harness.app.innerHTML, /Disconnect Acme Inc\?/);
  assert.match(harness.app.innerHTML, /does not uninstall the Slack app/i);
  click({ target: actionTarget({ 'data-action': 'slack-disconnect-confirm' }) });
  await flushAsync();
  assert.equal(harness.slackDisconnectCalls(), 1);
  assert.match(harness.app.innerHTML, /Connect @Chickpea/);
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

  assert.match(harness.app.innerHTML, /Slack has not applied all required permissions/);
  assert.match(harness.app.innerHTML, /Reinstall the app/);
});

test('Settings keeps the existing missing-permission recovery semantics', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
    slackPostError: {
      status: 422,
      error: 'slack_missing_scopes',
      consoleUrl: 'https://api.slack.com/apps/A0SETTINGS/oauth',
    },
  });
  await flushAsync();
  harness.listeners.submit?.({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: 'xoxb-settings', signingSecret: 'settings-secret' },
    ),
    preventDefault() {},
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Apply Chickpea(?:&rsquo;|')s Slack permissions before continuing/);
  assert.match(harness.app.innerHTML, /Reinstall @Chickpea in Slack/);
  assert.match(harness.app.innerHTML, /name="signingSecret"[^>]*value="settings-secret"/);
  assert.match(harness.app.innerHTML, /name="botToken"[^>]*value=""/);
  assert.equal(harness.focusedAction(), 'slack-connection-error');
});

test('Slack credential replacement ignores stale identity successes and failures', async () => {
  const oldIdentity: SlackIdentityFixture = {
    displayName: 'Old Bot',
    avatarUrl: 'https://avatars.slack-edge.com/old.png',
    botUserId: 'U_OLD',
    appId: 'A_OLD',
    consoleUrl: 'https://api.slack.com/apps/A_OLD/general',
  };
  const newIdentity: SlackIdentityFixture = {
    displayName: 'New <Bot>',
    avatarUrl: 'https://avatars.slack-edge.com/new.png',
    botUserId: 'U_NEW',
    appId: 'A_NEW',
    consoleUrl: 'https://api.slack.com/apps/A_NEW/general',
  };

  const staleSuccessHarness = runAdminPageHarness({ deferSlackIdentity: true });
  await flushAsync();
  const successClick = staleSuccessHarness.listeners.click;
  const successSubmit = staleSuccessHarness.listeners.submit;
  assert.ok(successClick && successSubmit);
  successClick({ target: actionTarget({ 'data-action': 'open-settings', 'data-section': 'slack' }) });
  successClick({ target: actionTarget({ 'data-action': 'slack-update-open' }) });
  successSubmit({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: 'xoxb-new', signingSecret: 'new-secret' },
    ),
    preventDefault() {},
  });
  await flushAsync();

  assert.equal(staleSuccessHarness.slackIdentityCalls(), 1);
  staleSuccessHarness.resolveSlackIdentity(0, oldIdentity);
  await flushAsync();
  assert.doesNotMatch(staleSuccessHarness.app.innerHTML, /@Old Bot/);
  successClick({ target: actionTarget({ 'data-action': 'open-channels' }) });
  await flushAsync();
  assert.equal(staleSuccessHarness.slackIdentityCalls(), 2);
  staleSuccessHarness.resolveSlackIdentity(1, newIdentity);
  await flushAsync();
  successClick({ target: actionTarget({ 'data-action': 'open-settings', 'data-section': 'slack' }) });
  assert.match(staleSuccessHarness.app.innerHTML, /When someone mentions @New &lt;Bot&gt;/);

  const staleFailureHarness = runAdminPageHarness({ deferSlackIdentity: true });
  await flushAsync();
  const failureClick = staleFailureHarness.listeners.click;
  const failureSubmit = staleFailureHarness.listeners.submit;
  assert.ok(failureClick && failureSubmit);
  failureClick({ target: actionTarget({ 'data-action': 'open-settings', 'data-section': 'slack' }) });
  failureClick({ target: actionTarget({ 'data-action': 'slack-update-open' }) });
  failureSubmit({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: 'xoxb-new', signingSecret: 'new-secret' },
    ),
    preventDefault() {},
  });
  await flushAsync();

  assert.equal(staleFailureHarness.slackIdentityCalls(), 1);
  staleFailureHarness.resolveSlackIdentity(0, {
    status: 502,
    error: 'slack_identity_unavailable',
    message: 'Old identity request failed.',
  });
  await flushAsync();
  failureClick({ target: actionTarget({ 'data-action': 'open-channels' }) });
  await flushAsync();
  assert.equal(staleFailureHarness.slackIdentityCalls(), 2);
  staleFailureHarness.resolveSlackIdentity(1, newIdentity);
  await flushAsync();
  failureClick({ target: actionTarget({ 'data-action': 'open-settings', 'data-section': 'slack' }) });
  assert.match(staleFailureHarness.app.innerHTML, /When someone mentions @New &lt;Bot&gt;/);
  assert.doesNotMatch(staleFailureHarness.app.innerHTML, /Old identity request failed/);
});

test('Slack behavior load and save failures stay honest and recoverable', async () => {
  const loadHarness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities',
    slackBehaviorGetFailures: 1,
  });
  await flushAsync();
  assert.match(loadHarness.app.innerHTML, /Slack behavior could not load/);
  assert.match(loadHarness.app.innerHTML, /Behavior service unavailable\./);
  assert.match(loadHarness.app.innerHTML, /data-action="slack-behavior-retry"/);
  assert.doesNotMatch(loadHarness.app.innerHTML, /class="behavior-state">On/);

  const loadClick = loadHarness.listeners.click;
  assert.ok(loadClick);
  loadClick({ target: actionTarget({ 'data-action': 'slack-behavior-retry' }) });
  await flushAsync();
  assert.equal(loadHarness.slackBehaviorGets(), 2);
  assert.match(loadHarness.app.innerHTML, /Allow direct messages/);
  assert.match(loadHarness.app.innerHTML, /class="behavior-state">On/);

  const saveHarness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities',
    slackBehaviorPutError: {
      status: 503,
      error: 'slack_behavior_unavailable',
      message: 'Could not save that Slack setting.',
    },
  });
  await flushAsync();
  const saveChange = saveHarness.listeners.change;
  assert.ok(saveChange);
  saveChange({
    target: {
      checked: false,
      closest: () => null,
      getAttribute(name: string) {
        if (name === 'data-action') return 'slack-behavior';
        if (name === 'data-setting') return 'allowDms';
        return null;
      },
    } as unknown as FakeTarget,
  });
  await flushAsync();
  assert.match(saveHarness.app.innerHTML, /Allow direct messages/);
  assert.match(saveHarness.app.innerHTML, /class="behavior-state">On/);
  assert.match(saveHarness.app.innerHTML, /Could not save that Slack setting\./);
  assert.match(saveHarness.app.innerHTML, /data-action="slack-behavior-retry"/);
});

test('Slack behavior writes serialize and environment-managed settings stay read-only', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities',
    slackBehavior: {
      allowDms: { value: false, source: 'env' },
      unassignedHint: { value: true, source: 'default' },
      welcomeOnJoin: { value: true, source: 'default' },
      ambientParticipation: { value: true, source: 'default' },
      progressiveStreaming: { value: false, source: 'default' },
      nativeTasks: { value: false, source: 'default' },
    },
  });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Allow direct messages[\s\S]*?Managed by the environment\./);
  assert.match(harness.app.innerHTML, /data-setting="allowDms"[^>]*disabled/);

  const change = harness.listeners.change;
  assert.ok(change);
  const behaviorTarget = (setting: string, checked: boolean) => ({
    checked,
    closest: () => null,
    getAttribute(name: string) {
      if (name === 'data-action') return 'slack-behavior';
      if (name === 'data-setting') return setting;
      return null;
    },
  }) as unknown as FakeTarget;
  change({ target: behaviorTarget('unassignedHint', false) });
  change({ target: behaviorTarget('welcomeOnJoin', false) });
  await flushAsync();
  assert.deepEqual(harness.slackBehaviorPuts, [{ unassignedHint: false }]);
});

test('Slack credential update failures announce the error, restore focus, and release the operation lock', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities',
    slackPostError: { status: 422, error: 'slack_auth_failed', detail: 'invalid_auth' },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const submit = harness.listeners.submit;
  assert.ok(click && submit);

  click({ target: actionTarget({ 'data-action': 'slack-update-open' }) });
  submit({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: 'xoxb-invalid', signingSecret: 'secret' },
    ),
    preventDefault() {},
  });
  assert.match(harness.app.innerHTML, /Validating&hellip;/);
  await flushAsync();

  assert.match(harness.app.innerHTML, /role="alert" aria-live="assertive"[^>]*data-role="slack-connection-error"/);
  assert.match(harness.app.innerHTML, /Slack rejected the bot token/);
  assert.equal(harness.focusedAction(), 'slack-connection-error');
  assert.doesNotMatch(harness.app.innerHTML, /data-action="slack-update-close" disabled/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="slack-disconnect-open" disabled/);
});

test('Slack credential update conflicts show the server guidance instead of a machine code', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/settings/slack/identities',
    slackPostError: {
      status: 409,
      error: 'slack_connection_changed',
      message: 'Slack connection changed while credentials were being validated. Try again.',
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const submit = harness.listeners.submit;
  assert.ok(click && submit);

  click({ target: actionTarget({ 'data-action': 'slack-update-open' }) });
  submit({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: 'xoxb-new', signingSecret: 'secret-new' },
    ),
    preventDefault() {},
  });
  await flushAsync();

  assert.match(
    harness.app.innerHTML,
    /Slack connection changed while credentials were being validated\. Try again\./,
  );
  assert.doesNotMatch(harness.app.innerHTML, />slack_connection_changed</);
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
  assert.match(
    harness.app.innerHTML,
    /Slack rejected the bot token \(auth\.test failed: invalid_auth\)/,
  );

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
  assert.equal(harness.locationPath(), '/admin/channels');
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

test('Slack disconnect dialog retains focus across unrelated async re-renders', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  // Leave an effective-config request pending, then return to the Slack
  // overview and open the modal before that background request resolves.
  click({
    target: actionTarget({
      'data-action': 'select-channel',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C_OPS',
    }),
  });
  click({ target: actionTarget({ 'data-action': 'open-channels' }) });
  click({ target: actionTarget({ 'data-action': 'slack-disconnect-open' }) });
  assert.equal(harness.focusedAction(), 'slack-disconnect-cancel');

  harness.resolveOpsEffective();
  await flushAsync();

  assert.match(harness.app.innerHTML, /Disconnect Acme Inc\?/);
  assert.equal(harness.topbarRegion.inert, true);
  assert.equal(harness.bodyRegion.inert, true);
  assert.equal(harness.focusedAction(), 'slack-disconnect-cancel');
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

  assert.match(harness.app.innerHTML, /class="agent-roster-item active" data-action="edit-profile" data-agent="agent_release"/);
  assert.match(harness.app.innerHTML, /class="agent-roster-meta" title="1 channel \+ Direct messages">1 channel \+ Direct messages<\/span>/);
  assert.match(harness.app.innerHTML, /<h1 class="page-title mono-title">#eng-releases<\/h1>/);
  // Agents is now a main-panel destination (the modal was retired): opening it
  // swaps the main panel to the overview, and each card carries its usage meta.
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Agents<\/h1>/);
  assert.match(harness.app.innerHTML, /<span class="pcard-name">Release Profile<\/span>/);
  assert.match(harness.app.innerHTML, /used in 1 channel/);

  // Drilling into an Agent opens the full-page editor whose placement section
  // links directly to the Channel detail.
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });
  assert.match(harness.app.innerHTML, /class="[^"]*agent-placement-card[^"]*"[\s\S]*?<h2>Where it works<\/h2>/);
  assert.match(harness.app.innerHTML, /data-action="open-channel-from-profile"[^>]*># eng-releases/);
});

test('the profile editor blocks delete while assigned and confirms disable everywhere', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_release' }) });

  // Lifecycle actions live in one accessible header overflow. Delete is
  // disabled while the Agent is attached (the server 409s too), and the menu
  // keeps the blocker visible rather than relying on a disabled control title.
  click({ target: actionTarget({ 'data-action': 'agent-overflow-toggle' }) });
  assert.match(harness.app.innerHTML, /role="menu" aria-label="Agent lifecycle actions"/);
  assert.match(harness.app.innerHTML, /data-action="delete-profile" disabled[^>]*>Delete Agent<\/button>/);
  assert.match(harness.app.innerHTML, /Detach it from every Channel before deleting this Agent/);
  assert.equal(harness.focusedAction(), 'agent-lifecycle-disable');

  // Choosing Disable on an assigned Agent asks for confirmation
  // (stops-everywhere) before it commits, rather than silently disabling it.
  click({ target: actionTarget({ 'data-action': 'agent-lifecycle-disable' }) });
  assert.match(harness.app.innerHTML, /Disable Release Profile\?/);
  assert.match(harness.app.innerHTML, /data-action="disable-confirm"/);
  assert.match(harness.app.innerHTML, /data-action="disable-keep"/);
  assert.equal(harness.focusedAction(), 'agent-overflow-toggle');
});

test('Profile disable and delete explain how to move an active Slack DM binding', async () => {
  const dmAgent = {
    ...releaseAgent,
    id: 'agent_dm_copy',
    name: 'DM Copy Profile',
  };
  const harness = runAdminPageHarness({
    assignments: [],
    agents: [dmAgent],
    slackIdentities: multiSlackIdentitiesFixture(),
    agentWriteError: {
      status: 409,
      error: 'agent_slack_dm_handler',
      profileId: dmAgent.id,
      identityIds: ['slack_identity_finance'],
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
  assert.match(
    harness.app.innerHTML,
    /This Agent still handles DMs for Finance\. In Settings → Slack → Identities, choose another DM Agent or turn off DMs first\./,
  );

  click({ target: actionTarget({ 'data-action': 'delete-profile' }) });
  await flushAsync();
  assert.match(
    harness.app.innerHTML,
    /This Agent still handles DMs for Finance\. In Settings → Slack → Identities, choose another DM Agent or turn off DMs first\./,
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

  // The create screen is a full page (not a modal): back link, all three
  // capability tabs, a ghost-example instructions placeholder, and Create/Cancel.
  assert.match(harness.app.innerHTML, /<h1 class="page-title">New Agent<\/h1>/);
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

test('Replies as reuses a connected identity without exposing DM routing controls', async () => {
  const harness = runAdminPageHarness({ slackIdentities: multiSlackIdentitiesFixture() });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': releaseAgent.id }) });
  assert.match(harness.app.innerHTML, /<h2 class="section-title">Replies as<\/h2>/);
  assert.match(harness.app.innerHTML, /@Chickpea/);
  assert.match(harness.app.innerHTML, /Workspace default/);
  assert.match(harness.app.innerHTML, /@Finance/);

  change({
    target: valueTarget(
      { 'data-action': 'profile-slack-identity' },
      'slack_identity_finance',
    ),
  });
  assert.match(harness.app.innerHTML, /Manage @Finance/);
  assert.doesNotMatch(harness.app.innerHTML, /DM handler|Handles DMs|profile-identity-make-dm/);
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.slackIdentityAttachPosts.length, 2);
  assert.equal(harness.slackIdentityAttachPosts[0]?.body.preflightOnly, true);
  assert.equal(harness.slackIdentityAttachPosts[1]?.body.preflightOnly, undefined);
  assert.equal(harness.slackIdentityAttachPosts[1]?.identityId, 'slack_identity_finance');
  assert.equal(harness.slackIdentityDmPatches.length, 0);
  assert.equal(
    harness.agentPatchBodies[0]?.body.slackIdentityId,
    undefined,
    'the generic Profile PATCH must not bypass the identity transaction',
  );
});

test('New Slack identity validates first, saves the Profile, then emits the stable setup handoff', async () => {
  const harness = runAdminPageHarness({ slackIdentities: multiSlackIdentitiesFixture() });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  const input = harness.listeners.input;
  assert.ok(click && change && input);

  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  change({
    target: valueTarget({ 'data-action': 'profile-slack-identity' }, '__new__'),
  });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  assert.equal(harness.agentPostBodies.length, 0);
  assert.equal(harness.slackIdentityCreates.length, 0);
  assert.match(harness.app.innerHTML, /Name is required\./);

  input({ target: inputTarget({ 'data-action': 'profile-name' }, 'Launch Guide') });
  input({
    target: inputTarget(
      { 'data-action': 'profile-instructions' },
      'Help the launch team with release questions.',
    ),
  });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();

  assert.equal(harness.agentPostBodies.length, 1);
  assert.deepEqual(harness.slackIdentityCreates, [{
    source: 'profile',
    initialDmAgentId: 'agent_launch_guide',
    displayName: 'Launch Guide',
  }]);
  assert.equal(
    harness.assignedUrls.at(-1),
    '/admin/settings/slack/identities/slack_identity_new_presence/setup',
  );
});

test('Profile identity management links to Identity settings while DM routing stays there', async () => {
  const harness = runAdminPageHarness({ slackIdentities: multiSlackIdentitiesFixture() });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': releaseAgent.id }) });
  assert.match(
    harness.app.innerHTML,
    /data-action="slack-identity-open-detail" data-identity="slack_identity_default">Manage @Chickpea<\/button>/,
  );
  assert.doesNotMatch(harness.app.innerHTML, /DM handler|Handles DMs|profile-identity-make-dm/);
  click({
    target: actionTarget({
      'data-action': 'slack-identity-open-detail',
      'data-identity': 'slack_identity_default',
    }),
  });
  await flushAsync();
  assert.equal(harness.locationPath(), '/admin/settings/slack/identities/slack_identity_default');
  assert.match(harness.app.innerHTML, /DMs handled by/);
});

test('identity membership blockers name channels and require wildcard acknowledgement before any Profile write', async () => {
  const harness = runAdminPageHarness({
    slackIdentities: multiSlackIdentitiesFixture(),
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
    slackIdentityAttachError: {
      status: 409,
      error: 'slack_identity_not_in_channels',
      message: 'Invite this Slack app to every listed channel before switching identities.',
      channels: [
        { workspaceId: 'T_DESIGN', channelId: 'C_PRIVATE', label: 'private-deals' },
        { workspaceId: 'T_DESIGN', channelId: 'C_FINANCE', label: 'finance' },
      ],
    },
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);

  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': releaseAgent.id }) });
  change({
    target: valueTarget(
      { 'data-action': 'profile-slack-identity' },
      'slack_identity_finance',
    ),
  });
  assert.match(harness.app.innerHTML, /cannot enumerate every destination/i);
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  assert.equal(harness.slackIdentityAttachPosts.length, 0);
  assert.equal(harness.agentPatchBodies.length, 0);
  assert.match(harness.app.innerHTML, /Acknowledge the wildcard channel warning/);

  change({
    target: valueTarget(
      { 'data-action': 'profile-identity-wildcard-ack' },
      'on',
      true,
    ),
  });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(harness.slackIdentityAttachPosts.length, 1);
  assert.equal(harness.slackIdentityAttachPosts[0]?.body.preflightOnly, true);
  assert.equal(harness.slackIdentityAttachPosts[0]?.body.acknowledgeUnenumeratedChannels, true);
  assert.equal(harness.agentPatchBodies.length, 0);
  assert.match(harness.app.innerHTML, /#private-deals/);
  assert.match(harness.app.innerHTML, /#finance/);
});

test('Channel Advanced shows the resolved Slack identity for new threads', async () => {
  const harness = runAdminPageHarness({
    slackIdentities: multiSlackIdentitiesFixture(),
    effectiveSlackIdentityId: 'slack_identity_finance',
  });
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
  assert.match(harness.app.innerHTML, /<h2 class="section-title">Resolved configuration<\/h2>/);
  assert.match(harness.app.innerHTML, /<dt>Replies as<\/dt><dd>@Finance[^<]*new threads only/);
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
  assert.match(picker, /#bot-test &mdash; currently Ops Profile/);
  assert.match(picker, /#new-channel/);
  assert.doesNotMatch(picker, /#eng-releases/);

  click({ target: actionTarget({ 'data-action': 'attach-channel-confirm' }) });
  await flushAsync();
  assert.deepEqual(harness.putAssignments, [
    {
      workspaceId: 'T_DESIGN',
      channelId: 'C_NEW',
      agentId: 'agent_release',
      enabled: true,
      expectedAgentId: null,
      channelLabel: 'new-channel',
    },
  ]);
  assert.doesNotMatch(harness.app.innerHTML, /data-role="attach-channel"/);
  assert.match(harness.app.innerHTML, /2 channels/);
});

test('Add to channels preserves an existing channel assignment while changing its profile', async () => {
  const harness = runAdminPageHarness({
    assignments: [
      defaultAssignments()[0] as AssignmentFixture,
      {
        workspaceId: 'T_DESIGN',
        channelId: 'C_OPS',
        channelLabel: 'ops-room',
        agentId: 'agent_ops',
        enabled: false,
        channelPromptAddendum: 'Keep the incident summary current.',
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

  assert.deepEqual(harness.putAssignments, [
    {
      workspaceId: 'T_DESIGN',
      channelId: 'C_OPS',
      agentId: 'agent_release',
      enabled: false,
      expectedAgentId: 'agent_ops',
      channelLabel: 'ops-room',
      channelPromptAddendum: 'Keep the incident summary current.',
    },
  ]);
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
  assert.equal((harness.putAssignments[0] as AssignmentFixture).channelId, 'C_NEW');
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

test('Add to channels warns when the connected Slack app still needs an invitation', async () => {
  const harness = runAdminPageHarness({
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture([{ id: 'C_NEW', name: 'new-channel' }]),
    attachSelectionValue: 'C_NEW',
    putIsMember: false,
  });
  const click = await openReleaseAttachPicker(harness);
  click({ target: actionTarget({ 'data-action': 'attach-channel-confirm' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /#new-channel was added, but the connected Slack app isn&#39;t a member of it yet/);
  assert.match(harness.app.innerHTML, /Invite it to #new-channel in Slack/);
});

test('Add to channels preserves the catalog invite warning when assignment membership is unavailable', async () => {
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

  assert.match(harness.app.innerHTML, /#new-channel was added, but the connected Slack app isn&#39;t a member of it yet/);
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
  assert.equal((harness.putAssignments[0] as AssignmentFixture).channelId, 'C_NEW');
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

  assert.match(harness.app.innerHTML, /assign Release Profile/);
  submit({
    target: submitTarget({ 'data-action': 'add-channel-form' }, { channelSelect: 'C_NEW' }),
    preventDefault() {},
  });
  await flushAsync();
  assert.equal((harness.putAssignments[0] as AssignmentFixture).agentId, 'agent_release');
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
  assert.match(harness.app.innerHTML, /<h2[^>]*>Instructions<\/h2>/);
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

test('Agent introduction is a presentation-only first paragraph with a neutral fallback', async () => {
  const richHarness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_intro',
    agents: [{
      ...releaseAgent,
      id: 'agent_intro',
      name: 'Introduction Agent',
      instructions: '**Answer** [release questions](https://example.com/release) with `care` and _clarity_.\n\nKeep this second paragraph out.',
    }],
    assignments: [],
  });
  await flushAsync();

  assert.match(
    richHarness.app.innerHTML,
    /class="agent-profile-intro"[^>]*aria-label="Answer release questions with care and clarity\."[^>]*>Answer release questions with care and clarity\.<\/p>/,
  );
  assert.match(richHarness.app.innerHTML, /Keep this second paragraph out/);
  richHarness.listeners.input?.({
    target: inputTarget({ 'data-action': 'profile-instructions' }, 'Edited instructions.'),
  });
  richHarness.listeners.click?.({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(Object.hasOwn(richHarness.agentPatchBodies[0]?.body ?? {}, 'introduction'), false);

  const emptyHarness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_empty_intro',
    agents: [{ ...releaseAgent, id: 'agent_empty_intro', instructions: '   \n\n  ' }],
    assignments: [],
  });
  await flushAsync();
  assert.match(
    emptyHarness.app.innerHTML,
    /Configure how this Agent thinks, what it can use, and where it works\./,
  );
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
  assert.match(harness.app.innerHTML, /role="menuitem" data-action="agent-lifecycle-disable">Disable Agent<\/button>/);
  assert.equal(harness.focusedAction(), 'agent-lifecycle-disable');

  harness.listeners.keydown?.({
    target: actionClassTarget({ 'data-action': 'agent-lifecycle-disable' }, 'agent-overflow-menuitem'),
    key: 'Escape',
    preventDefault() {},
  });
  assert.doesNotMatch(harness.app.innerHTML, /role="menu" aria-label="Agent lifecycle actions"/);
  assert.equal(harness.focusedAction(), 'agent-overflow-toggle');
});

test('agent-first Admin lands on the Default Agent with Channels in lower navigation', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin' });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/agents/agent_release');
  assert.equal(harness.app.className, 'frame primary-admin-shell admin-surface admin-surface-agent-detail');
  assert.match(harness.app.innerHTML, /<aside class="rail primary-shell-sidebar agent-shell-sidebar">/);
  assert.match(harness.app.innerHTML, /<nav class="agent-roster" aria-label="Agents">/);
  assert.match(harness.app.innerHTML, /<span class="section-eyebrow">Agents<\/span>/);
  assert.match(harness.app.innerHTML, /class="agent-roster-item active" data-action="edit-profile" data-agent="agent_release"[^>]*aria-current="page"/);
  assert.match(harness.app.innerHTML, /data-action="open-channels"[^>]*>Channels<\/button>/);
  assert.doesNotMatch(harness.app.innerHTML, />Profiles<\/button>|aria-label="Profiles"|>New profile</);
});

test('Agent detail follows the approved compact hierarchy and capability vocabulary', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin' });
  await flushAsync();

  assert.match(harness.app.innerHTML, /class="agent-profile-page"/);
  assert.match(harness.app.innerHTML, /<header class="agent-profile-header">[\s\S]*?<span class="agent-kicker">Agent<\/span>[\s\S]*?<h1 class="page-title">Release Profile<\/h1>/);
  assert.match(harness.app.innerHTML, /aria-label="Agent setup"/);
  for (const tab of ['Instructions', 'Skills', 'Connectors', 'Repositories', 'Memory']) {
    assert.match(harness.app.innerHTML, new RegExp(`role="tab"[^>]*>${tab}`));
  }
  assert.match(harness.app.innerHTML, /aria-label="Agent instructions"/);
  assert.match(harness.app.innerHTML, /class="agent-tabs-card"/);
  assert.match(harness.app.innerHTML, /class="[^"]*agent-placement-card[^"]*"[\s\S]*?<h2>Where it works<\/h2>/);
  assert.match(harness.app.innerHTML, /<h3[^>]*>Channels<\/h3>[\s\S]*?# eng-releases/);
  assert.match(harness.app.innerHTML, /<h3[^>]*>Direct messages<\/h3>/);
  assert.match(harness.app.innerHTML, /data-action="attach-open">Add to channels/);
  assert.match(harness.app.innerHTML, /class="[^"]*agent-model-card[^"]*"[\s\S]*?<h2>Model<\/h2>/);
  assert.match(harness.app.innerHTML, /class="advanced agent-advanced-card"[\s\S]*?Slack identity[\s\S]*?Coding sandbox/);
  assert.ok(
    harness.app.innerHTML.indexOf('class="agent-model-card"') < harness.app.innerHTML.indexOf('class="advanced agent-advanced-card"'),
    'Model must remain outside and before Agent Advanced',
  );

  const page = renderAdminPage();
  assert.match(page, /\.admin-surface \.agent-profile-page\s*\{[^}]*font-family:\s*"Avenir Next"/s);
  assert.match(page, /\.agent-profile-intro\s*\{[^}]*white-space:\s*nowrap;[^}]*text-overflow:\s*ellipsis;/s);
  assert.match(page, /\.agent-tabs-card\s*\{[^}]*border-radius:\s*16px;[^}]*overflow:\s*hidden;/s);
  assert.match(page, /\.agent-placement-card > \.bundle-row, \.agent-placement-card > \.callout\s*\{[^}]*grid-column:\s*1 \/ -1;/s);
  assert.match(page, /@container \(max-width: 750px\)[\s\S]*?\.agent-profile-header[^{]*\{[^}]*align-items:\s*flex-start;[^}]*flex-direction:\s*column;/s);
  assert.match(page, /@media \(max-width: 740px\)[\s\S]*?\.agent-profile-page \.ptabs\s*\{[^}]*overflow-x:\s*auto;/s);
});

test('Where it works keeps Channel placements and renders Direct messages as non-interactive identity status', async () => {
  const identities = multiSlackIdentitiesFixture();
  const workspaceIdentity = identities.identities.find((identity) =>
    identity.id === 'slack_identity_default'
  );
  assert.ok(workspaceIdentity);
  workspaceIdentity.displayName = 'Pea & Ops';

  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    slackIdentities: identities,
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /data-action="open-channel-from-profile"[^>]*># eng-releases/);
  assert.match(harness.app.innerHTML, /data-action="attach-open">Add to channels/);

  const dmHeadingAt = harness.app.innerHTML.indexOf('<h3>Direct messages</h3>');
  const addActionAt = harness.app.innerHTML.indexOf('data-action="attach-open"', dmHeadingAt);
  assert.notEqual(dmHeadingAt, -1);
  assert.notEqual(addActionAt, -1);
  const addButtonAt = harness.app.innerHTML.lastIndexOf('<button', addActionAt);
  const dmSection = harness.app.innerHTML.slice(dmHeadingAt, addButtonAt);
  assert.match(dmSection, /class="agent-dm-status">On via @Pea &amp; Ops<\/p>/);
  assert.doesNotMatch(dmSection, /identity-bound|<button|data-action=/);

  const fallbackHarness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    assignments: [{
      workspaceId: '*',
      channelId: '*',
      agentId: releaseAgent.id,
      enabled: true,
    }],
    slackIdentities: { identities: [], globalDmAllowed: true },
  });
  await flushAsync();
  assert.match(fallbackHarness.app.innerHTML, /class="agent-dm-status">On via @Chickpea<\/p>/);

  const noDmHarness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    assignments: [],
    slackIdentities: { identities: [], globalDmAllowed: true },
  });
  await flushAsync();

  assert.match(noDmHarness.app.innerHTML, /<h3[^>]*>Channels<\/h3>[\s\S]*?No Channels yet/);
  assert.match(
    noDmHarness.app.innerHTML,
    /<h3[^>]*>Direct messages<\/h3>[\s\S]*?No Slack identity routes Direct messages to this Agent\./,
  );
  assert.match(noDmHarness.app.innerHTML, /data-action="attach-open">Add to channels/);
});

test('Agent placements prefer the projected Slack Channel name over a raw Channel ID', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
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
      behavior: { participationMode: 'ambient', hasAdditionalInstructions: false },
      readiness: { ready: true, code: 'ready', reasons: [] },
    }],
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /data-action="open-channel-from-profile"[^>]*># eng-releases/);
  assert.doesNotMatch(harness.app.innerHTML, /># C0EXR3L9T/);
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
      behavior: { participationMode: 'ambient', hasAdditionalInstructions: false },
      readiness: { ready: true, code: 'ready', reasons: [] },
    }],
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<h1 class="page-title mono-title">#eng-releases<\/h1>/);
  assert.match(harness.app.innerHTML, />Open #eng-releases<\/a>/);
  assert.doesNotMatch(harness.app.innerHTML, /#C0EXR3L9T/);
});

test('Channel detail follows the Agent-first hierarchy and contains resolved configuration', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /class="channel-detail-page"/);
  assert.match(html, /<header class="channel-detail-header">[\s\S]*?<h1 class="page-title mono-title">#eng-releases<\/h1>[\s\S]*?class="channel-detail-status ready"[^>]*>Ready/);
  assert.match(html, /class="channel-enabled-control"[\s\S]*?Enabled[\s\S]*?aria-label="Channel enabled"/);
  assert.match(html, /class="channel-agent-hero"[\s\S]*?agent-roster-icon[\s\S]*?<h2>Release Profile<\/h2>[\s\S]*?Answer with release context\.[\s\S]*?>View Agent<\/button>[\s\S]*?>Change Agent<\/button>/);
  assert.match(html, /<h2 class="section-title">Inherited capabilities<\/h2>/);
  assert.match(html, /class="channel-participation-card"[\s\S]*?<h2 class="section-title">When it speaks<\/h2>/);
  assert.match(html, /class="channel-try-card"[\s\S]*?Try it in Slack[\s\S]*?data-action="copy-channel-prompt"[\s\S]*?Open #eng-releases/);
  assert.match(html, /<details class="advanced channel-advanced-card"[\s\S]*?<h2 class="section-title">Resolved configuration<\/h2>/);
  assert.doesNotMatch(html, /Access summary/);

  const order = [
    'channel-detail-header',
    'channel-agent-hero',
    'channel-capabilities-section',
    'channel-participation-card',
    'channel-try-card',
    'channel-advanced-card',
    'save-bar',
  ].map((marker) => html.indexOf(marker));
  assert.ok(order.every((position) => position >= 0), `missing hierarchy marker: ${order.join(', ')}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order);

  const page = renderAdminPage();
  assert.match(page, /@container \(max-width: 750px\)[\s\S]*?\.channel-detail-header\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(page, /@container \(max-width: 750px\)[\s\S]*?\.channel-agent-hero[\s\S]*?\.channel-participation-card,[\s\S]*?\.channel-try-card\s*\{[^}]*grid-template-columns:\s*1fr;/s);
});

test('Channel header keeps readiness, assignment, disabled, loading, and effective errors truthful', async () => {
  const attention = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C_ATTENTION',
    assignments: [{
      workspaceId: 'T_DESIGN', channelId: 'C_ATTENTION', channelLabel: 'attention',
      agentId: 'agent_release', enabled: true,
    }],
    channelIndex: [{
      workspaceId: 'T_DESIGN', channelId: 'C_ATTENTION', channelName: 'attention',
      assignment: { agentId: 'agent_release', agentName: 'Release Profile', agentEnabled: true },
      behavior: { participationMode: 'ambient' },
      readiness: { ready: false, code: 'identity_degraded', reasons: ['Slack identity needs attention'] },
    }],
  });
  await flushAsync();
  assert.match(attention.app.innerHTML, /class="channel-detail-status needs-attention" title="Slack identity needs attention"[^>]*>Needs attention/);

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
      behavior: { participationMode: 'ambient' },
      readiness: { ready: false, code: 'agent_disabled', reasons: ['Enable the assigned Agent'] },
    }],
  });
  await flushAsync();
  assert.match(disabled.app.innerHTML, /class="channel-detail-status needs-attention" title="Enable the assigned Agent\."[^>]*>Needs attention/);

  const unassigned = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C_UNASSIGNED',
    assignments: [],
    channelIndex: [{
      workspaceId: 'T_DESIGN', channelId: 'C_UNASSIGNED', channelName: 'planning',
      assignment: null, behavior: { participationMode: 'mention_only' },
      readiness: { ready: false, code: 'unassigned', reasons: ['Choose an Agent'] },
    }],
  });
  await flushAsync();
  assert.match(unassigned.app.innerHTML, /class="channel-detail-status unassigned"[^>]*>Needs Agent/);
  assert.match(unassigned.app.innerHTML, /No Agent assigned[\s\S]*?data-action="toggle-swap">Choose Agent/);

  const loading = runAdminPageHarness();
  await flushAsync();
  loading.listeners.click?.({ target: actionTarget({
    'data-action': 'select-channel', 'data-workspace': 'T_DESIGN', 'data-channel': 'C_OPS',
  }) });
  assert.match(loading.app.innerHTML, /class="channel-detail-status resolving"[^>]*>Resolving/);
  loading.resolveOpsEffective();
  await flushAsync();
  assert.doesNotMatch(loading.app.innerHTML, /channel-detail-status resolving/);

  const failed = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T',
    effectiveError: { status: 422, error: 'model_not_resolvable', message: 'Choose a model on Release Profile.' },
  });
  await flushAsync();
  assert.match(failed.app.innerHTML, /class="channel-detail-status needs-attention"[^>]*>Needs attention/);
  assert.match(failed.app.innerHTML, /class="channel-header-error" role="alert">Choose a model on Release Profile\.<\/p>/);
  assert.match(failed.app.innerHTML, /<h2 class="section-title">Resolved configuration<\/h2>[\s\S]*?Configuration issue/);
});

test('Channel capability groups use real previews, empty states, and owning-Agent navigation', async () => {
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
  assert.match(html, /class="channel-capability-group" data-capability="skill"[\s\S]*?Skills[\s\S]*?one[\s\S]*?\+1 more/);
  assert.match(html, /class="channel-capability-group" data-capability="connector"[\s\S]*?Connectors[\s\S]*?conn-logo[\s\S]*?Linear/);
  assert.match(html, /class="channel-capability-group" data-capability="repository"[\s\S]*?Repositories[\s\S]*?None added/);
  assert.match(html, /data-action="open-profiles" data-agent="agent_release"[^>]*>Open Agent capabilities/);
});

test('Channel participation remains a Channel-only draft and survives a failed save', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();
  harness.listeners.change?.({ target: inputTarget({ 'data-action': 'channel-participation' }, 'mention_only') });
  assert.match(harness.app.innerHTML, /<option value="mention_only" selected>Mention only<\/option>/);
  assert.match(harness.app.innerHTML, /data-action="save-channel" >/);
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'save-channel' }) });
  await flushAsync();
  assert.equal((harness.putAssignments.at(-1) as { participationMode?: string })?.participationMode, 'mention_only');
  assert.equal(harness.agentPatchBodies.length, 0);

  const failed = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T',
    putAssignmentError: { status: 409, error: 'assignment_conflict', message: 'Reload the Channel and try again.' },
  });
  await flushAsync();
  failed.listeners.change?.({ target: inputTarget({ 'data-action': 'channel-participation' }, 'mention_only') });
  failed.listeners.click?.({ target: actionTarget({ 'data-action': 'save-channel' }) });
  await flushAsync();
  assert.match(failed.app.innerHTML, /<option value="mention_only" selected>Mention only<\/option>/);
  assert.match(failed.app.innerHTML, /assignment_conflict/);
  assert.match(failed.app.innerHTML, /data-action="save-channel" >/);
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

test('Channels stay secondary and derive their detail from the assigned Agent', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin' });
  await flushAsync();

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'open-channels' }) });
  await flushAsync();
  assert.equal(harness.locationPath(), '/admin/channels');
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Channels<\/h1>/);
  assert.match(harness.app.innerHTML, /Assigned Agent: Release Profile/);
  assert.match(harness.app.innerHTML, /placeholder="Find a Channel or Agent"/);

  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'open-channel-index',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C0EXR3L9T',
    }),
  });
  await flushAsync();
  assert.equal(harness.locationPath(), '/admin/channels/T_DESIGN/C0EXR3L9T');
  assert.match(harness.app.innerHTML, /Assigned Agent/);
  assert.match(harness.app.innerHTML, /View Agent/);
  assert.match(harness.app.innerHTML, /Inherited capabilities/);
  assert.match(harness.app.innerHTML, /When it speaks/);
  assert.match(harness.app.innerHTML, /Give me three useful ways you can help this channel/);
  assert.match(harness.app.innerHTML, /Additional instructions/);
  assert.match(harness.app.innerHTML, /Channel memory/);
  assert.match(harness.app.innerHTML, /Exact-Channel files stay here even if the assigned Agent changes/);
});

test('Channels index matches the operational summary and assignment-table hierarchy', async () => {
  const disabledOps = { ...opsAgent, enabled: false };
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels',
    agents: [releaseAgent, disabledOps],
    assignments: [],
    channelIndex: [
      {
        workspaceId: 'T_DESIGN', channelId: 'C_READY', channelName: 'eng-releases',
        assignment: { agentId: 'agent_release', agentName: 'Release Profile', agentEnabled: true },
        behavior: { participationMode: 'ambient', hasAdditionalInstructions: true },
        readiness: { ready: true, code: 'ready', reasons: [] },
      },
      {
        workspaceId: 'T_DESIGN', channelId: 'C_DISABLED', channelName: 'incident-response',
        assignment: { agentId: 'agent_ops', agentName: 'Ops Profile', agentEnabled: false },
        behavior: { participationMode: 'mention_only', hasAdditionalInstructions: false },
        readiness: { ready: false, code: 'agent_disabled', reasons: ['Enable the assigned Agent'] },
      },
      {
        workspaceId: 'T_DESIGN', channelId: 'C_UNASSIGNED', channelName: 'planning',
        assignment: null,
        behavior: { participationMode: 'mention_only', hasAdditionalInstructions: false },
        readiness: { ready: false, code: 'unassigned', reasons: ['Choose an Agent'] },
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
  assert.match(html, /<span class="agent-kicker">Slack<\/span><h1 class="page-title">Channels<\/h1>/);
  assert.match(html, /data-action="toggle-add-channel"[^>]*>[^<]*<svg[\s\S]*?Add Channel<\/button>/);
  assert.match(html, /<dt>Configured Channels<\/dt><dd>3<\/dd>/);
  assert.match(html, /<dt>Enabled Agents<\/dt><dd>1<\/dd>/);
  assert.match(html, /class="channels-slack-state connected"[^>]*>[\s\S]*?Slack connected/);
  assert.match(html, /role="table" aria-label="Channel assignments"/);
  for (const heading of ['Channel', 'Agent', 'Behavior', 'Status']) {
    assert.match(html, new RegExp(`role="columnheader"[^>]*>${heading}<`));
  }
  assert.match(html, /data-channel-state="ready"[\s\S]*?#eng-releases[\s\S]*?Release Profile[\s\S]*?Mentions \+ useful moments[\s\S]*?Channel instructions added[\s\S]*?Ready/);
  assert.match(html, /data-channel-state="agent-disabled"[\s\S]*?#incident-response[\s\S]*?Ops Profile[\s\S]*?Mentions only[\s\S]*?Agent disabled/);
  assert.match(html, /data-channel-state="unassigned"[\s\S]*?#planning[\s\S]*?No Agent assigned[\s\S]*?Needs Agent/);
  assert.match(html, /data-channel-state="discovered"[\s\S]*?#customer-voice[\s\S]*?Choose an Agent[\s\S]*?Not configured/);
  assert.doesNotMatch(html, /class="channels-index-open"|>Open Agent<|&rsaquo;/);
});

test('Channels summary reports healthy, degraded, and disconnected Slack truth', async () => {
  const healthy = runAdminPageHarness({ initialPath: '/admin/channels' });
  await flushAsync();
  assert.match(healthy.app.innerHTML, /channels-slack-state connected[\s\S]*?Slack connected/);

  const degradedIdentities = multiSlackIdentitiesFixture();
  const workspaceDefault = degradedIdentities.identities.find((identity) => identity.kind === 'workspace_default');
  assert.ok(workspaceDefault);
  workspaceDefault.health = 'degraded';
  const degraded = runAdminPageHarness({
    initialPath: '/admin/channels',
    slackIdentities: degradedIdentities,
  });
  await flushAsync();
  assert.match(degraded.app.innerHTML, /channels-slack-state degraded[\s\S]*?Slack needs attention/);

  const disconnected = runAdminPageHarness({
    initialPath: '/admin/channels',
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();
  assert.match(disconnected.app.innerHTML, /channels-slack-state disconnected[\s\S]*?Slack disconnected/);
  assert.match(disconnected.app.innerHTML, /Connect @Chickpea/);
});

test('Channels search preserves its query and filters Channel and Agent names', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels',
    channelIndex: [
      {
        workspaceId: 'T_DESIGN', channelId: 'C_RELEASE', channelName: 'eng-releases',
        assignment: { agentId: 'agent_release', agentName: 'Release Profile', agentEnabled: true },
        behavior: { participationMode: 'ambient' }, readiness: { ready: true },
      },
      {
        workspaceId: 'T_DESIGN', channelId: 'C_OPS', channelName: 'incident-room',
        assignment: { agentId: 'agent_ops', agentName: 'Ops Profile', agentEnabled: true },
        behavior: { participationMode: 'mention_only' }, readiness: { ready: true },
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

test('Channels table keeps Channel, Agent, and discovered destinations separate', async () => {
  const fixtures = {
    initialPath: '/admin/channels',
    channelIndex: [{
      workspaceId: 'T_DESIGN', channelId: 'C_READY', channelName: 'eng-releases',
      assignment: { agentId: 'agent_release', agentName: 'Release Profile', agentEnabled: true },
      behavior: { participationMode: 'ambient' }, readiness: { ready: true },
    }, {
      workspaceId: 'T_DESIGN', channelId: 'C_DISCOVERED', channelName: 'customer-voice',
      assignment: null, behavior: { participationMode: 'mention_only' }, readiness: null,
      source: 'discovered',
    }],
    slackChannels: channelsFixture([
      { id: 'C_READY', name: 'eng-releases' },
      { id: 'C_DISCOVERED', name: 'customer-voice' },
    ]),
  };

  const channelHarness = runAdminPageHarness(fixtures);
  await flushAsync();
  channelHarness.listeners.click?.({ target: actionTarget({
    'data-action': 'open-channel-index', 'data-workspace': 'T_DESIGN', 'data-channel': 'C_READY',
  }) });
  await flushAsync();
  assert.equal(channelHarness.locationPath(), '/admin/channels/T_DESIGN/C_READY');

  const agentHarness = runAdminPageHarness(fixtures);
  await flushAsync();
  agentHarness.listeners.click?.({ target: actionTarget({
    'data-action': 'open-profiles', 'data-agent': 'agent_release',
  }) });
  assert.equal(agentHarness.locationPath(), '/admin/agents/agent_release');

  const discoveredHarness = runAdminPageHarness(fixtures);
  await flushAsync();
  assert.match(
    discoveredHarness.app.innerHTML,
    /data-action="channel-index-add" data-workspace="T_DESIGN" data-channel="C_DISCOVERED"/,
  );
  discoveredHarness.listeners.click?.({ target: actionTarget({
    'data-action': 'channel-index-add', 'data-workspace': 'T_DESIGN', 'data-channel': 'C_DISCOVERED',
  }) });
  assert.match(discoveredHarness.app.innerHTML, /<h2 class="section-title">Add a channel<\/h2>/);
  assert.match(discoveredHarness.app.innerHTML, /<option value="C_DISCOVERED" selected>/);
});

test('Channels projection fallback keeps saved assignments, counts, and recovery copy', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels',
    channelIndexError: { status: 503, error: 'projection_unavailable', message: 'Try again later' },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /The Channel index could not refresh\. Showing saved assignments/);
  assert.match(harness.app.innerHTML, /<dt>Configured Channels<\/dt><dd>2<\/dd>/);
  assert.match(harness.app.innerHTML, /data-channel-state="saved"[\s\S]*?#eng-releases[\s\S]*?Saved/);
  assert.match(harness.app.innerHTML, /data-action="open-channel-index" data-workspace="T_DESIGN" data-channel="C0EXR3L9T"/);
});

test('Channels columns truncate long visible values while retaining complete accessible text', () => {
  const page = renderAdminPage();
  assert.match(page, /\.channels-index-name, \.channels-index-agent-name, \.channels-index-behavior strong\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  assert.match(page, /\.channels-index-row\s*\{[^}]*grid-template-columns:\s*minmax\(180px, 1\.15fr\) minmax\(220px, 1\.35fr\) minmax\(180px, 1fr\) 110px;/s);
  assert.match(page, /@container \(max-width: 750px\)[\s\S]*?\.channels-index-table-head\s*\{[^}]*display:\s*none;[\s\S]*?\.channels-index-row\s*\{[^}]*grid-template-columns:\s*1fr;/s);
  assert.match(page, /\.channels-index-cell::before\s*\{[^}]*content:\s*attr\(data-label\);/s);
});

test('moving a Channel sends placement CAS and preserves Channel-local instructions', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T',
    swapSelectionValue: 'agent_ops',
  });
  await flushAsync();

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'toggle-swap' }) });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'attach-selected-profile' }) });
  await flushAsync();

  assert.deepEqual(harness.putAssignments.at(-1), {
    workspaceId: 'T_DESIGN',
    channelId: 'C0EXR3L9T',
    agentId: 'agent_ops',
    enabled: true,
    expectedAgentId: 'agent_release',
    channelLabel: 'eng-releases',
    channelPromptAddendum: 'Release channel addendum.',
    participationMode: 'ambient',
  });
  assert.match(harness.app.innerHTML, /class="owner-memory-assignee">Assigned Agent: Ops Profile<\/span>/);
});

test('configured unassigned Channels keep their detail and offer an Agent chooser', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C_UNASSIGNED',
    assignments: [],
    channelIndex: [{
      workspaceId: 'T_DESIGN',
      channelId: 'C_UNASSIGNED',
      channelName: 'planning',
      source: 'configured',
      assignment: null,
      behavior: { participationMode: 'mention_only', hasAdditionalInstructions: false, lifecycle: 'active' },
      readiness: { ready: false, code: 'unassigned', reasons: ['Choose an Agent'] },
      links: { channel: '/admin/channels/T_DESIGN/C_UNASSIGNED', agent: null },
    }],
  });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/channels/T_DESIGN/C_UNASSIGNED');
  assert.match(harness.app.innerHTML, /#planning/);
  assert.match(harness.app.innerHTML, /No Agent assigned/);
  assert.match(harness.app.innerHTML, /Choose Agent/);
  assert.doesNotMatch(harness.app.innerHTML, /No channels yet/);
  assert.doesNotMatch(harness.app.innerHTML, /class="agent-roster-item active"/);
  assert.match(harness.app.innerHTML, /data-action="channel-back"[^>]*>&larr; Channels<\/button>/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'channel-back' }) });
  assert.equal(harness.locationPath(), '/admin/channels');
});

test('disconnected Channel detail keeps the same Agent shell and truthful Slack context', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T',
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /<aside class="rail primary-shell-sidebar agent-shell-sidebar">/);
  assert.match(harness.app.innerHTML, /<nav class="agent-roster" aria-label="Agents">/);
  assert.match(harness.app.innerHTML, /class="agent-roster-item active" data-action="edit-profile" data-agent="agent_release"/);
  assert.match(harness.app.innerHTML, /class="agent-slack-status disconnected"[^>]*>Not connected<\/span>/);
  assert.match(harness.app.innerHTML, /Connect @Chickpea/);
});

test('Agent roster keeps long names and placement counts accessible while truncating visually', async () => {
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

  assert.match(harness.app.innerHTML, new RegExp(`aria-label="Open Agent ${escapedName}, 1 channel"`));
  assert.match(harness.app.innerHTML, new RegExp(`class="agent-roster-name" title="${escapedName}"`));
  assert.match(harness.app.innerHTML, /class="agent-roster-meta" title="1 channel">1 channel<\/span>/);
  assert.match(renderAdminPage(), /\.agent-roster-name\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
});

test('Agent owner memory exposes generated index, editable files, history, review, save, and forget', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin' });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'memory' }) });
  assert.match(harness.app.innerHTML, /class="owner-memory-files-head"[\s\S]*?<span>Files<\/span>[\s\S]*?aria-label="2 memory files">2<\/small>/);
  assert.match(harness.app.innerHTML, /data-tab="memory"[^>]*>Memory<span class="ptab-count">2<\/span>/);
  assert.match(harness.app.innerHTML, /# Channel Memory Index/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'owner-memory-file', 'data-file': 'mem_release' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Markdown body/);
  assert.match(harness.app.innerHTML, /<label class="field-label" for="owner-memory-name">Filename<\/label><input class="input mono" id="owner-memory-name" value="release-guidance\.md" readonly aria-readonly="true">/);
  assert.match(harness.app.innerHTML, /Version history \(1\)/);
  assert.match(harness.app.innerHTML, /Review requested/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'owner-memory-resolve-review' }) });
  await flushAsync();
  assert.deepEqual(harness.memoryReviewPosts, [{ expectedVersion: 1, resolution: 'confirmed' }]);

  harness.listeners.input?.({ target: valueTarget({ 'data-action': 'owner-memory-description' }, 'Updated Agent memory') });
  harness.listeners.input?.({ target: valueTarget({ 'data-action': 'owner-memory-body' }, 'Use the updated checklist.') });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'owner-memory-save' }) });
  await flushAsync();
  assert.deepEqual(harness.memoryPuts.at(-1), {
    expectedVersion: 1,
    description: 'Updated Agent memory',
    type: 'project',
    body: 'Use the updated checklist.',
  });

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'owner-memory-delete-open' }) });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'owner-memory-delete-confirm' }) });
  await flushAsync();
  assert.deepEqual(harness.memoryDeletes.at(-1), { expectedVersion: 2, acknowledgeIrreversible: true });
});

test('shared owner memory uses the prototype file rail, accessible ellipsis, and dark generated source', async () => {
  const longName = 'a-very-long-memory-filename-that-must-stay-on-one-line.md';
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_release',
    ownerMemoryFiles: [
      { name: 'MEMORY.md', path: 'agent/agent_release/MEMORY.md', generated: true, entryId: null, content: '# Agent index\n\n<script>unsafe()</script>\n' },
      { name: longName, path: `agent/agent_release/${longName}`, generated: false, entryId: 'mem_release', version: 1, status: 'active', description: 'Long filename proof.' },
    ],
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'memory' }) });

  assert.match(harness.app.innerHTML, new RegExp(`class="owner-memory-file"[^>]*aria-label="Open memory file ${longName}, active · v1"`));
  assert.match(harness.app.innerHTML, new RegExp(`class="owner-memory-file-name" title="${longName}">${longName}<\\/strong>`));
  assert.doesNotMatch(harness.app.innerHTML, /<script>unsafe\(\)<\/script>/);
  assert.match(harness.app.innerHTML, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);

  const page = renderAdminPage();
  assert.match(page, /\.owner-memory-layout\s*\{[^}]*grid-template-columns:\s*210px minmax\(0, 1fr\);/s);
  assert.match(page, /\.owner-memory-file-name\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  assert.match(page, /\.owner-memory-source\s*\{[^}]*background:\s*#2f2b24;[^}]*color:\s*#eee6d6;[^}]*overflow:\s*auto;/s);
  assert.match(page, /@container \(max-width: 750px\)[\s\S]*?\.owner-memory-layout\s*\{[^}]*grid-template-columns:\s*1fr;/s);
  assert.match(page, /@container \(max-width: 750px\)[\s\S]*?\.owner-memory-file-list\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s);
});

test('Agent owner memory creates a constrained Markdown file with an idempotency key', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin' });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'memory' }) });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'owner-memory-create-open' }) });
  harness.listeners.input?.({ target: valueTarget({ 'data-action': 'owner-memory-create-slug' }, 'launch-context.md') });
  harness.listeners.input?.({ target: valueTarget({ 'data-action': 'owner-memory-create-description' }, 'Durable launch context') });
  harness.listeners.change?.({ target: valueTarget({ 'data-action': 'owner-memory-create-type' }, 'project') });
  harness.listeners.input?.({ target: valueTarget({ 'data-action': 'owner-memory-create-body' }, '# Launch context\nShip safely.') });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'owner-memory-create-confirm' }) });
  await flushAsync();

  assert.deepEqual(harness.memoryCreates[0]?.body, {
    slug: 'launch-context',
    description: 'Durable launch context',
    type: 'project',
    body: '# Launch context\nShip safely.',
  });
  assert.match(harness.memoryCreates[0]?.idempotencyKey ?? '', /^admin-ui:owner-memory-create:/);
  assert.match(harness.app.innerHTML, /launch-context\.md/);
  assert.match(harness.app.innerHTML, /class="owner-memory-files-head"[\s\S]*?aria-label="3 memory files">3<\/small>/);
  assert.match(harness.app.innerHTML, /data-tab="memory"[^>]*>Memory<span class="ptab-count">3<\/span>/);
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

test('Agent deletion is disabled while projected live Slack thread roots exist', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/agents/agent_threaded',
    assignments: [],
    agents: [{
      ...releaseAgent,
      id: 'agent_threaded',
      name: 'Threaded Agent',
      deletion: { blocked: true, references: [], liveSnapshotRoots: [{ workspaceId: 'T_DESIGN', channelId: 'C1', threadTs: '1.0' }] },
    }],
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'agent-overflow-toggle' }) });
  assert.match(harness.app.innerHTML, /data-action="delete-profile" disabled title="This Agent still has live Slack threads\. Wait for them to expire first\."/);
  assert.match(harness.app.innerHTML, /Wait for its live Slack threads to expire before deleting this Agent/);
});

test('Channel Advanced edits the exact-Channel owner memory rather than an Agent scalar', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();
  assert.match(harness.app.innerHTML, /This memory stays only in #eng-releases, even if its Agent changes/);
  assert.match(harness.app.innerHTML, /class="owner-memory-assignee">Assigned Agent: Release Profile<\/span>/);
  assert.match(harness.app.innerHTML, /# Channel Memory Index/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'owner-memory-file', 'data-file': 'mem_release' }) });
  await flushAsync();
  harness.listeners.input?.({ target: valueTarget({ 'data-action': 'owner-memory-body' }, 'Channel-only release context.') });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'owner-memory-save' }) });
  await flushAsync();
  assert.equal(harness.memoryPuts.at(-1)?.body, 'Channel-only release context.');
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

  // The Skills capability tab renders, its panel empty at first.
  assert.match(harness.app.innerHTML, /data-action="profile-tab" data-tab="skills"/);
  assert.match(harness.app.innerHTML, /No custom skills yet/);

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
  assert.match(harness.app.innerHTML, /No custom skills yet/);
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
  // ...other presets remain, and the Available count drops from 26 to 24.
  assert.match(panel, /data-action="conn-preset" data-preset="airtable"/);
  assert.match(panel, /<span class="gallery-head-count">24<\/span>/);
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
  assert.match(harness.app.innerHTML, /<span>Sign into Notion<\/span>/);
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
  assert.match(editor, /<option value="oauth" selected disabled>OAuth \(configured separately\)<\/option>/);
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
    26,
  );
  assert.match(gallery, /<span>Available<\/span><span class="gallery-head-count">26<\/span>/);
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

  const notionRow = gallery.match(
    /<div class="gallery-row gallery-row-described"><span class="conn-logo conn-logo-img conn-logo-full"><svg[^>]*aria-hidden="true"(?:(?!<\/div>)[\s\S])*?data-preset="notion">Connect<\/button><\/div>/,
  )?.[0];
  assert.ok(notionRow);
  assert.doesNotMatch(notionRow, /conn-logo-mono|conn-logo-raster|data:image|>NO<\/span>/);

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

test('the Sentry preset keeps its header auth and applies the same idempotent prefix to test and save', async () => {
  const harness = runAdminPageHarness({ agents: [connectionsAgent()] });
  await flushAsync();

  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_conn' }) });
  click({ target: actionTarget({ 'data-action': 'profile-tab', 'data-tab': 'connections' }) });
  click({ target: actionTarget({ 'data-action': 'conn-preset', 'data-preset': 'sentry' }) });
  const recommended = harness.app.innerHTML;
  assert.match(recommended, /Sentry → Settings → Account → User Auth Tokens/);
  assert.match(
    recommended,
    /<a class="hint-link" href="https:\/\/sentry\.io\/settings\/account\/api\/auth-tokens\/"[^>]*>Where do I find this\?<\/a>/,
  );
  click({ target: actionTarget({ 'data-action': 'conn-view', 'data-view': 'advanced' }) });

  assert.match(harness.app.innerHTML, /<option value="none" selected>None<\/option>/);
  assert.match(harness.app.innerHTML, /value="Authorization"[^>]*data-action="conn-header-name"/);

  input({ target: inputTarget({ 'data-action': 'conn-header-value', 'data-index': '0' }, 'sentry-user-token') });
  click({ target: actionTarget({ 'data-action': 'conn-test' }) });
  await flushAsync();
  assert.equal(
    (harness.mcpTestPosts[0]?.headers as Record<string, string>).Authorization,
    'Sentry-Bearer sentry-user-token',
  );

  input({
    target: inputTarget(
      { 'data-action': 'conn-header-value', 'data-index': '0' },
      'Sentry-Bearer sentry-user-token',
    ),
  });
  click({ target: actionTarget({ 'data-action': 'conn-test' }) });
  await flushAsync();
  assert.equal(
    (harness.mcpTestPosts[1]?.headers as Record<string, string>).Authorization,
    'Sentry-Bearer sentry-user-token',
  );

  click({ target: actionTarget({ 'data-action': 'conn-save-row' }) });
  click({ target: actionTarget({ 'data-action': 'save-profile' }) });
  await flushAsync();
  assert.equal(
    (harness.mcpSecretPuts[0]?.body.headers as Record<string, string>).Authorization,
    'Sentry-Bearer sentry-user-token',
  );
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
    /<button[^>]*class="btn btn-primary btn-sm oauth-signin"[^>]*data-action="conn-oauth-start"[^>]*><span class="conn-logo conn-logo-img conn-logo-full"><svg[^>]*aria-hidden="true"[\s\S]*?<\/svg><\/span><span>Sign into Notion<\/span><\/button>/,
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
      displayName: 'Notion',
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
  assert.match(harness.app.innerHTML, /Sign into Notion/);
  assert.match(
    harness.app.innerHTML,
    /Notion OAuth could not be prepared\. Check that this install has a reachable callback URL, then try again\./,
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
  assert.match(harness.app.innerHTML, /data-action="conn-oauth-start"[^>]*>[\s\S]*?<span>Sign into Notion<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /Opening Notion/);
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
    /data-action="profile-tab" data-tab="connections"[^>]*>Connectors<span class="ptab-count">1<\/span>/,
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

test('an existing OAuth connection renders honestly and stages token cleanup when disabled', async () => {
  const harness = runAdminPageHarness({
    agents: [
      connectionsAgent({
        mcpServers: [
          mcpConnectionFixture({
            authMode: 'oauth',
            presetId: 'linear',
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
  click({ target: actionTarget({ 'data-action': 'conn-view', 'data-view': 'advanced' }) });

  assert.match(
    harness.app.innerHTML,
    /<option value="oauth" selected disabled>OAuth \(configured separately\)<\/option>/,
  );
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
    target: actionTarget({ 'data-action': 'owner-memory-file', 'data-file': 'mem_release' }),
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

test('dirty Channel settings guard every persistent shell and row exit', async () => {
  const exits = [
    { action: 'edit-profile', agent: 'agent_ops' },
    { action: 'new-profile' },
    { action: 'open-channels' },
    { action: 'go-home' },
    { action: 'channel-back', agent: 'agent_release' },
    { action: 'select-channel', workspace: 'T_DESIGN', channel: 'C_OPS' },
    { action: 'open-channel-index', workspace: 'T_DESIGN', channel: 'C_OPS' },
  ];

  for (const exit of exits) {
    const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
    await flushAsync();
    harness.listeners.input?.({
      target: inputTarget({ 'data-action': 'channel-addendum' }, `Unsaved via ${exit.action}`),
    });
    harness.listeners.click?.({
      target: actionTarget({
        'data-action': exit.action,
        ...(exit.agent ? { 'data-agent': exit.agent } : {}),
        ...(exit.workspace ? { 'data-workspace': exit.workspace } : {}),
        ...(exit.channel ? { 'data-channel': exit.channel } : {}),
      }),
    });

    assert.equal(harness.locationPath(), '/admin/channels/T_DESIGN/C0EXR3L9T', exit.action);
    assert.match(harness.app.innerHTML, /This Channel has changes you haven&rsquo;t saved/, exit.action);
    assert.match(harness.app.innerHTML, new RegExp(`Unsaved via ${exit.action}`), exit.action);
  }
});

test('dirty Channel history and beforeunload guard the draft, then honor discard and save destinations', async () => {
  const historyHarness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();
  historyHarness.listeners.input?.({
    target: inputTarget({ 'data-action': 'channel-addendum' }, 'Unsaved history draft'),
  });
  assert.deepEqual(historyHarness.beforeunload(), { prevented: true, returnValue: '' });
  historyHarness.popstate('/admin/agents/agent_ops');
  assert.equal(historyHarness.locationPath(), '/admin/channels/T_DESIGN/C0EXR3L9T');
  assert.match(historyHarness.app.innerHTML, /This Channel has changes you haven&rsquo;t saved/);
  historyHarness.listeners.click?.({ target: actionTarget({ 'data-action': 'leave-discard' }) });
  assert.equal(historyHarness.locationPath(), '/admin/agents/agent_ops');

  const saveHarness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();
  saveHarness.listeners.input?.({
    target: inputTarget({ 'data-action': 'channel-addendum' }, 'Save before opening Ops'),
  });
  saveHarness.listeners.click?.({
    target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_ops' }),
  });
  saveHarness.listeners.click?.({ target: actionTarget({ 'data-action': 'leave-save' }) });
  await flushAsync();
  assert.equal(saveHarness.locationPath(), '/admin/agents/agent_ops');
  assert.equal((saveHarness.putAssignments.at(-1) as { channelPromptAddendum?: string })?.channelPromptAddendum, 'Save before opening Ops');
});

test('owner memory blocks a dirty Channel exit first, while Channel save never consumes the memory draft', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();
  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'owner-memory-file', 'data-file': 'mem_release' }),
  });
  await flushAsync();
  harness.listeners.input?.({
    target: inputTarget({ 'data-action': 'owner-memory-body' }, 'Unsaved Channel memory body.'),
  });
  harness.listeners.input?.({
    target: inputTarget({ 'data-action': 'channel-addendum' }, 'Unsaved Channel page settings.'),
  });

  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'edit-profile', 'data-agent': 'agent_ops' }),
  });
  assert.match(harness.app.innerHTML, /Save or discard this memory draft before navigating away/);
  assert.doesNotMatch(harness.app.innerHTML, /role="dialog" aria-modal="true" aria-label="Unsaved changes"/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'save-channel' }) });
  await flushAsync();
  assert.equal((harness.putAssignments.at(-1) as { channelPromptAddendum?: string })?.channelPromptAddendum, 'Unsaved Channel page settings.');
  assert.match(harness.app.innerHTML, /Unsaved Channel memory body\./);
  assert.equal(harness.memoryPuts.length, 0);
});

test('the existing mobile menu is the sole narrow Agent roster transition with focus return', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();

  const page = renderAdminPage();
  assert.match(page, /@media \(max-width: 740px\)[\s\S]*?\.primary-admin-shell > \.topbar\s*\{[^}]*display:\s*flex;/s);
  assert.match(page, /@media \(max-width: 740px\)[\s\S]*?\.primary-admin-shell \.primary-shell-sidebar\s*\{[^}]*display:\s*none;/s);
  assert.equal((harness.app.innerHTML.match(/aria-label="Agents"/g) ?? []).length, 1);
  assert.match(harness.app.innerHTML, /data-action="mobile-agents-open"/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'mobile-agents-open' }) });
  assert.match(harness.app.innerHTML, /class="mobile-agent-roster" role="group" aria-label="Choose an Agent"/);
  assert.match(harness.app.innerHTML, /data-action="edit-profile" data-agent="agent_release"[^>]*aria-current="page"/);
  assert.match(harness.app.innerHTML, /data-action="edit-profile" data-agent="agent_ops"/);
  assert.match(harness.app.innerHTML, /data-action="new-profile"[^>]*>[^<]*<svg[\s\S]*?New Agent<\/button>/);
  assert.match(harness.app.innerHTML, /data-action="mobile-agents-close"/);
  assert.equal(harness.focusedAction(), 'mobile-agents-close');

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'mobile-agents-close' }) });
  assert.doesNotMatch(harness.app.innerHTML, /class="mobile-agent-roster"/);
  assert.equal(harness.focusedAction(), 'mobile-menu-trigger');
});

test('profile save and access summary render server model-resolution messages', async () => {
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

  const accessHarness = runAdminPageHarness({
    effectiveError: { status: 422, error: 'model_not_resolvable', message: serverMessage },
  });
  await flushAsync();

  const accessClick = accessHarness.listeners.click;
  assert.ok(accessClick);
  accessClick({
    target: actionTarget({
      'data-action': 'select-channel',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C0EXR3L9T',
    }),
  });
  await flushAsync();

  assert.match(accessHarness.app.innerHTML, /<p class="field-label">Configuration issue<\/p>/);
  assert.match(accessHarness.app.innerHTML, /No model pinned for agent agent_no_model/);
  assert.doesNotMatch(accessHarness.app.innerHTML, /<p class="field-label">No enabled profile<\/p>/);
});

test('selecting a channel re-renders after effective config finishes resolving', async () => {
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

  assert.match(harness.app.innerHTML, /Resolving\.\.\./);
  harness.resolveOpsEffective();
  await flushAsync();

  assert.match(harness.app.innerHTML, /#C_OPS/);
  assert.match(harness.app.innerHTML, /local-stub\/ops/);
  assert.doesNotMatch(harness.app.innerHTML, /Resolving\.\.\./);
});

test('the attached Agent roster summarizes placements instead of grouping Channel rows', async () => {
  const harness = runAdminPageHarness({
    slackConnection: null,
    assignments: [
      ...defaultAssignments(),
      {
        workspaceId: 'T_DEMO',
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
  assert.match(roster, /data-agent="agent_release"[\s\S]*?title="2 channels \+ Direct messages"/);
  assert.match(roster, /data-agent="agent_ops"[\s\S]*?title="1 channel"/);
  assert.doesNotMatch(roster, /data-action="select-channel"|#eng-releases|#demo-channel/);
});

test('add-channel opens a main-panel picker with the locked workspace and a channel dropdown', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture(),
  });
  await flushAsync();

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'toggle-add-channel' }) });
  await flushAsync();

  // Workspace is locked text (name + id), not an editable input.
  assert.match(harness.app.innerHTML, /Add a channel/);
  assert.match(harness.app.innerHTML, /Acme Inc/);
  assert.doesNotMatch(harness.app.innerHTML, /name="workspaceId"/);
  // The dropdown is populated from the proxy, private channels get a lock, and a
  // channel the bot is not in is flagged.
  assert.match(harness.app.innerHTML, /id="add-channel-select"/);
  assert.match(harness.app.innerHTML, /# new-channel/);
  assert.match(harness.app.innerHTML, /secret-room/);
  assert.match(harness.app.innerHTML, /not a member/);
  // Helper copy + the manual fallback affordance.
  assert.match(harness.app.innerHTML, /Invite the connected Slack app to the channel, then click Refresh/);
  assert.match(harness.app.innerHTML, /Enter ID manually/);
  // The picker fetched the proxy exactly once on open.
  assert.equal(harness.channelListCalls.length, 1);
});

test('add-channel missing_scope links reinstall and opens credential replacement', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
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
  assert.match(harness.app.innerHTML, /data-action="slack-update-open">Update credentials/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="refresh-channels"[^>]*>[^<]*<svg[\s\S]*?Refresh<\/button>/);

  click({ target: actionTarget({ 'data-action': 'slack-update-open' }) });
  assert.match(harness.app.innerHTML, /Update Slack credentials/);
  assert.doesNotMatch(harness.app.innerHTML, /<h2 class="section-title">Add a channel<\/h2>/);
});

test('add-channel missing_scope explains deployment-managed token repair', async () => {
  const connection = connectedSlackFixture();
  connection.credentials = { botToken: 'env', signingSecret: 'env', botUserId: 'env' };
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: connection,
    slackChannelFailures: 2,
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'toggle-add-channel' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /replace <span class="mono">SLACK_BOT_TOKEN<\/span> in your deployment and redeploy Chickpea/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="slack-update-open">Update credentials/);
});

test('add-channel submit PUTs the connected workspace id and surfaces the invite reminder', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture(),
    putIsMember: false,
  });
  await flushAsync();

  const click = harness.listeners.click;
  const submit = harness.listeners.submit;
  assert.ok(click && submit);
  click({ target: actionTarget({ 'data-action': 'toggle-add-channel' }) });
  await flushAsync();

  submit({
    target: submitTarget({ 'data-action': 'add-channel-form' }, { channelSelect: 'C_PRIVATE' }),
    preventDefault() {},
  });
  await flushAsync();

  // The PUT carries the CONNECTED workspace id (never a hand-typed one) and the
  // picked channel.
  assert.deepEqual(harness.putAssignments, [
    {
      workspaceId: 'T_DESIGN',
      channelId: 'C_PRIVATE',
      agentId: releaseAgent.id,
      enabled: true,
      expectedAgentId: null,
      channelLabel: 'secret-room',
    },
  ]);
  // isMember:false from the server drives the invite reminder (channel-specific).
  assert.match(harness.app.innerHTML, /Invite the connected Slack app to finish/);
  assert.match(harness.app.innerHTML, /Invite it to #secret-room in Slack/);
});

test('the attached Agent shell stays available while channel setup waits for Slack', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  // Disconnected: setup stays focused while the shared roster and stable
  // section switcher remain available.
  assert.match(harness.app.innerHTML, /Connect @Chickpea/);
  assert.match(harness.app.innerHTML, /<aside class="rail primary-shell-sidebar agent-shell-sidebar">/);
  assert.match(harness.app.innerHTML, /<nav class="agent-roster" aria-label="Agents">/);
  assert.match(harness.app.innerHTML, /class="agent-slack-status disconnected"[^>]*>Not connected<\/span>/);
  assert.match(harness.app.innerHTML, /class="section-nav-item" data-action="open-profiles"[^>]*>Agents<\/button>/);
  assert.match(harness.app.innerHTML, /class="section-nav-item" data-action="open-settings"[^>]*>Settings<\/button>/);
  assert.equal(harness.channelListCalls.length, 0);
});

test('add-channel manual fallback reveals a server-validated channel-ID input', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: connectedSlackFixture(),
    slackChannels: channelsFixture(),
  });
  await flushAsync();

  const click = harness.listeners.click;
  const submit = harness.listeners.submit;
  assert.ok(click && submit);
  click({ target: actionTarget({ 'data-action': 'toggle-add-channel' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'toggle-manual-channel' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /id="add-channel-manual" name="manualChannelId"/);

  submit({
    target: submitTarget({ 'data-action': 'add-channel-form' }, { manualChannelId: 'C_MANUAL' }),
    preventDefault() {},
  });
  await flushAsync();

  assert.deepEqual(harness.putAssignments, [
    { workspaceId: 'T_DESIGN', channelId: 'C_MANUAL', agentId: releaseAgent.id, enabled: true, expectedAgentId: null },
  ]);
});

test('onboarding walks through the approved create, Event URL, and values sequence', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
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
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/onboarding');
  assert.match(harness.app.innerHTML, /class="onboarding-shell"/);
  assert.match(harness.app.innerHTML, /aria-label="Onboarding progress"/);
  assert.match(harness.app.innerHTML, /<p class="onboarding-eyebrow">Connect Slack<\/p>/);
  assert.match(harness.app.innerHTML, /Create Chickpea/);
  assert.match(harness.app.innerHTML, /Choose your workspace, then click Next/);
  assert.match(harness.app.innerHTML, /Review Chickpea, then click Create and Install/);
  assert.match(harness.app.innerHTML, /\/admin\/assets\/onboarding\/create-workspace\.webp/);
  assert.match(harness.app.innerHTML, /\/admin\/assets\/onboarding\/create-review\.webp/);
  assert.match(harness.app.innerHTML, /slack-logo-image/);
  assert.equal((harness.app.innerHTML.match(/data-action="advance-slack-step"/g) ?? []).length, 1);
  assert.doesNotMatch(harness.app.innerHTML, /<nav class="rail"/);
  assert.doesNotMatch(harness.app.innerHTML, /aria-label="Admin navigation"/);
  assert.doesNotMatch(harness.app.innerHTML, /Events URL/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'advance-slack-step' }) });
  assert.match(harness.app.innerHTML, /Finish creating Chickpea/);
  assert.match(harness.app.innerHTML, /Review the permissions, then click Allow/);
  assert.match(harness.app.innerHTML, /When Slack says Chickpea is ready, click Go to App Settings/);
  assert.match(harness.app.innerHTML, /\/admin\/assets\/onboarding\/allow\.webp/);
  assert.match(harness.app.innerHTML, /\/admin\/assets\/onboarding\/ready\.webp/);
  assert.match(harness.app.innerHTML, /Open Slack setup again/);
  assert.match(harness.app.innerHTML, /data-action="onboarding-slack-events"/);
  assert.match(harness.app.innerHTML, /Next: Verify Event URL/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'onboarding-slack-events' }) });
  assert.match(harness.app.innerHTML, /Verify the Event URL/);
  assert.match(harness.app.innerHTML, /open Event Subscriptions/);
  assert.match(harness.app.innerHTML, /Beside Request URL, click Retry/);
  assert.match(harness.app.innerHTML, /When Request URL says Verified, click Save Changes/);
  assert.match(harness.app.innerHTML, /wait a few seconds and click Retry again/);
  assert.match(harness.app.innerHTML, /\/admin\/assets\/onboarding\/events-retry\.webp/);
  assert.match(harness.app.innerHTML, /\/admin\/assets\/onboarding\/events\.webp/);
  assert.match(harness.app.innerHTML, /data-action="onboarding-slack-keys"/);
  assert.match(harness.app.innerHTML, />I saved changes<\/button>/);
  assert.doesNotMatch(harness.app.innerHTML, /reinstall your app|\/reinstall\.webp/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'onboarding-slack-keys' }) });
  assert.match(harness.app.innerHTML, /Add 2 values/);
  assert.match(harness.app.innerHTML, /Paste them once\. Chickpea checks everything before saving/);
  assert.match(harness.app.innerHTML, /In OAuth &amp; Permissions, copy Bot User OAuth Token/);
  assert.match(harness.app.innerHTML, /In Basic Information, reveal and copy Signing Secret/);
  assert.match(harness.app.innerHTML, /\/admin\/assets\/onboarding\/bot-token\.webp/);
  assert.match(harness.app.innerHTML, /\/admin\/assets\/onboarding\/signing-secret\.webp/);
  assert.match(harness.app.innerHTML, /name="botToken"/);
  assert.match(harness.app.innerHTML, /name="signingSecret"/);
  assert.match(harness.app.innerHTML, /data-action="onboarding-slack-back" data-step="events"/);
  assert.match(harness.app.innerHTML, /Lost the Slack tab\? Open your apps/);
  assert.match(harness.app.innerHTML, /href="https:\/\/api\.slack\.com\/apps"/);
  assert.doesNotMatch(harness.app.innerHTML, /manifest_json/);
  assert.match(harness.app.innerHTML, />Check and connect<\/button>/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'onboarding-slack-back', 'data-step': 'events' }) });
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);
  assert.match(harness.app.innerHTML, /Verify the Event URL/);
});

test('onboarding treats incomplete Slack permissions as a normal continuation', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
    slackPostError: {
      status: 422,
      error: 'slack_missing_scopes',
      missingScopes: ['assistant:write', 'channels:read'],
      consoleUrl: 'https://api.slack.com/apps/A0REPAIR/oauth',
    },
    onboarding: {
      stage: 'connect_slack',
      revision: '{"version":1}',
      workspace: null,
      channel: null,
      tryStartedAt: null,
      completedAt: null,
    },
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'advance-slack-step' }) });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-app-created' }) });
  harness.listeners.submit?.({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: 'xoxb-under-scoped', signingSecret: 'safe-placeholder' },
    ),
    preventDefault() {},
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /One more Slack approval/);
  assert.match(harness.app.innerHTML, /Continue in Slack/);
  assert.match(harness.app.innerHTML, /href="https:\/\/api\.slack\.com\/apps\/A0REPAIR\/oauth"/);
  assert.match(harness.app.innerHTML, /target="_blank" rel="noopener noreferrer" data-action="slack-permissions-open"/);
  assert.doesNotMatch(harness.app.innerHTML, /role="alert"/);
  assert.match(harness.app.innerHTML, /click the yellow reinstall your app link/);
  assert.match(harness.app.innerHTML, /\/admin\/assets\/onboarding\/reinstall\.webp/);
  assert.doesNotMatch(harness.app.innerHTML, /assistant:write|channels:read|starter token/i);
  assert.doesNotMatch(harness.app.innerHTML, /safe-placeholder|xoxb-under-scoped/);
  assert.deepEqual(harness.onboardingCredentialValues(), { botToken: '', signingSecret: '' });
  assert.equal(harness.focusedAction(), 'slack-permission-heading');

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-open' }) });
  assert.match(harness.app.innerHTML, /Your values are still here/);
  assert.match(harness.app.innerHTML, /data-action="slack-permissions-check"[^>]*>Check again/);
  assert.doesNotMatch(harness.app.innerHTML, /Continue in Slack/);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-check' }) });
  assert.match(harness.app.innerHTML, /data-action="slack-permissions-check" disabled/);
  assert.match(harness.app.innerHTML, /Checking&hellip;/);
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-check' }) });
  assert.equal(harness.slackPosts.length, 2, 'one visible check action produces one request');
  await flushAsync();

  assert.deepEqual(harness.slackPosts, [
    { botToken: 'xoxb-under-scoped', signingSecret: 'safe-placeholder' },
    { botToken: 'xoxb-under-scoped', signingSecret: 'safe-placeholder' },
  ]);
  assert.match(harness.app.innerHTML, /One more Slack approval/);
  assert.match(harness.app.innerHTML, /Slack needs one more confirmation/);
  assert.doesNotMatch(harness.app.innerHTML, /role="alert"|assistant:write|channels:read|starter token/i);
  assert.deepEqual(harness.onboardingCredentialValues(), { botToken: '', signingSecret: '' });
  assert.equal(harness.focusedAction(), 'slack-permissions-open');
});

test('onboarding treats a missing Slack Events check as one calm resumable step', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
    slackPostResults: [{
      eventsVerificationRequired: true,
      consoleUrl: 'https://api.slack.com/apps/A0EVENTS/event-subscriptions',
    }],
    onboarding: onboardingConnectFixture(),
  });
  await flushAsync();
  submitOnboardingSlack(harness, 'xoxb-events', 'events-secret');
  await flushAsync();

  assert.match(harness.app.innerHTML, /One more Slack check/);
  assert.match(harness.app.innerHTML, /click Retry beside Request URL, then click Save Changes/);
  assert.match(
    harness.app.innerHTML,
    /href="https:\/\/api\.slack\.com\/apps\/A0EVENTS\/event-subscriptions"/,
  );
  assert.match(harness.app.innerHTML, />Finish in Slack/);
  assert.doesNotMatch(harness.app.innerHTML, /role="alert"|something is wrong|failed/i);
  assert.doesNotMatch(harness.app.innerHTML, /xoxb-events|events-secret/);
  assert.deepEqual(harness.onboardingCredentialValues(), { botToken: '', signingSecret: '' });

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-open' }) });
  assert.match(harness.app.innerHTML, /Return here when it says Verified/);
  assert.match(harness.app.innerHTML, /do not need to paste the values again/);
  assert.match(harness.app.innerHTML, /data-action="slack-permissions-check"[^>]*>Check now/);
});

test('onboarding celebrates a connected Slack workspace before channel selection', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
    slackChannels: channelsFixture([{ id: 'C_NEW', name: 'new-channel', isMember: true }]),
    slackPostResults: [
      { status: 422, error: 'slack_missing_scopes', consoleUrl: 'https://api.slack.com/apps/A0REPAIR/oauth' },
      {},
    ],
    onboarding: {
      stage: 'connect_slack',
      revision: '{"version":1}',
      workspace: null,
      channel: null,
      tryStartedAt: null,
      completedAt: null,
    },
  });
  await flushAsync();
  harness.listeners.submit?.({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: 'xoxb-page-only', signingSecret: 'page-only-secret' },
    ),
    preventDefault() {},
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-open' }) });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-check' }) });
  await flushAsync();

  assert.deepEqual(harness.slackPosts, [
    { botToken: 'xoxb-page-only', signingSecret: 'page-only-secret' },
    { botToken: 'xoxb-page-only', signingSecret: 'page-only-secret' },
  ]);
  assert.match(harness.app.innerHTML, /Slack connected/);
  assert.match(harness.app.innerHTML, /Everything worked/);
  assert.match(harness.app.innerHTML, /ready for a channel/);
  assert.match(harness.app.innerHTML, /Workspace, permissions, and event delivery are ready/);
  assert.match(harness.app.innerHTML, /data-action="onboarding-continue-to-channel"[^>]*>Choose a channel/);
  assert.doesNotMatch(harness.app.innerHTML, /Choose where Chickpea should start/);
  assert.doesNotMatch(harness.app.innerHTML, /Finish applying Slack permissions|page-only-secret|xoxb-page-only/);
  assert.deepEqual(harness.onboardingCredentialValues(), { botToken: '', signingSecret: '' });
  assert.equal(harness.focusedAction(), 'onboarding-connected-heading');

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'onboarding-continue-to-channel' }) });
  assert.match(harness.app.innerHTML, /Choose where Chickpea should start/);
  assert.doesNotMatch(harness.app.innerHTML, /Everything worked/);
  assert.equal(harness.focusedAction(), 'onboarding-channel-heading');
});

test('onboarding replaces the credential form with a clear checking state', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
    deferSlackPost: true,
    onboarding: onboardingConnectFixture(),
  });
  await flushAsync();
  submitOnboardingSlack(harness, 'xoxb-checking', 'checking-secret');

  assert.match(harness.app.innerHTML, /Checking your Slack setup&hellip;/);
  assert.match(harness.app.innerHTML, /<strong>Event URL<\/strong><span>Verified<\/span>/);
  assert.match(harness.app.innerHTML, /<strong>Workspace and permissions<\/strong><span>Checking<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"|name="signingSecret"|xoxb-checking|checking-secret/);

  harness.resolveSlackPost(0, {});
  await flushAsync();
  assert.match(harness.app.innerHTML, /Everything worked/);
});

test('onboarding keeps the draft through a transient Slack check and lets the owner check again', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
    slackPostResults: [
      { status: 422, error: 'slack_missing_scopes', consoleUrl: 'https://api.slack.com/apps/A0REPAIR/oauth' },
      { status: 502, error: 'slack_unreachable' },
      { status: 422, error: 'slack_missing_scopes', consoleUrl: 'https://api.slack.com/apps/A0REPAIR/oauth' },
    ],
    onboarding: onboardingConnectFixture(),
  });
  await flushAsync();
  submitOnboardingSlack(harness, 'xoxb-transient', 'transient-secret');
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-open' }) });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-check' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Slack could not be checked just now/);
  assert.match(harness.app.innerHTML, /data-action="slack-permissions-check"[^>]*>Check again/);
  assert.doesNotMatch(harness.app.innerHTML, /role="alert"/);
  assert.deepEqual(harness.onboardingCredentialValues(), { botToken: '', signingSecret: '' });
  assert.equal(harness.focusedAction(), 'slack-permissions-check');

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-check' }) });
  await flushAsync();
  assert.equal(harness.slackPosts.length, 3);
  assert.match(harness.app.innerHTML, /One more Slack approval/);
});

test('onboarding returns to Check again when Slack profile or channel preflight is temporarily unavailable', async () => {
  for (const error of ['identity_profile_unavailable', 'slack_channel_list_failed']) {
    const harness = runAdminPageHarness({
      initialPath: '/admin/onboarding',
      assignments: [],
      slackConnection: disconnectedSlackFixture(),
      slackPostResults: [
        { status: 422, error: 'slack_missing_scopes', consoleUrl: 'https://api.slack.com/apps/A0REPAIR/oauth' },
        { status: 502, error },
      ],
      onboarding: onboardingConnectFixture(),
    });
    await flushAsync();
    submitOnboardingSlack(harness, `xoxb-${error}`, `${error}-secret`);
    await flushAsync();
    harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-open' }) });
    harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-check' }) });
    await flushAsync();

    assert.match(harness.app.innerHTML, /Slack could not be checked just now/, error);
    assert.match(harness.app.innerHTML, /data-action="slack-permissions-check"[^>]*>Check again/, error);
    assert.doesNotMatch(harness.app.innerHTML, /Checking&hellip;|role="alert"/, error);
    assert.deepEqual(harness.onboardingCredentialValues(), { botToken: '', signingSecret: '' }, error);
    assert.equal(harness.focusedAction(), 'slack-permissions-check', error);
  }
});

test('onboarding asks for only the current bot token for recognized and unrecognized Slack auth failures', async () => {
  for (const detail of ['invalid_auth', 'token_revoked', 'unexpected_auth_rejection']) {
    const harness = runAdminPageHarness({
      initialPath: '/admin/onboarding',
      assignments: [],
      slackConnection: disconnectedSlackFixture(),
      slackPostResults: [
        { status: 422, error: 'slack_missing_scopes', consoleUrl: 'https://api.slack.com/apps/A0REPAIR/oauth' },
        { status: 401, error: 'slack_auth_failed', detail },
      ],
      onboarding: onboardingConnectFixture(),
    });
    await flushAsync();
    submitOnboardingSlack(harness, `xoxb-${detail}`, `${detail}-secret`);
    await flushAsync();
    harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-open' }) });
    harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-check' }) });
    await flushAsync();

    assert.match(harness.app.innerHTML, /Paste the current Bot User OAuth Token/);
    assert.match(harness.app.innerHTML, /role="alert"/);
    assert.deepEqual(harness.onboardingCredentialValues(), {
      botToken: '',
      signingSecret: `${detail}-secret`,
    });
    assert.equal(harness.focusedAction(), 'onboarding-bot-token');
    assert.doesNotMatch(harness.app.innerHTML, new RegExp(`xoxb-${detail}|${detail}-secret`));
  }
});

test('onboarding clears both draft values for app, workspace, and signed-challenge mismatches', async () => {
  for (const error of ['app_mismatch', 'workspace_mismatch', 'challenge_invalid_signature', 'signing_secret_change_requires_reconnect']) {
    const harness = runAdminPageHarness({
      initialPath: '/admin/onboarding',
      assignments: [],
      slackConnection: disconnectedSlackFixture(),
      slackPostResults: [
        { status: 422, error: 'slack_missing_scopes', consoleUrl: 'https://api.slack.com/apps/A0REPAIR/oauth' },
        { status: 409, error },
      ],
      onboarding: onboardingConnectFixture(),
    });
    await flushAsync();
    submitOnboardingSlack(harness, `xoxb-${error}`, `${error}-secret`);
    await flushAsync();
    harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-open' }) });
    harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-check' }) });
    await flushAsync();

    assert.deepEqual(harness.onboardingCredentialValues(), { botToken: '', signingSecret: '' }, error);
    assert.match(harness.app.innerHTML, /role="alert"[^>]*aria-live="assertive"/, error);
    assert.equal(harness.focusedAction(), 'slack-connection-error', error);
  }
});

test('onboarding permission continuation uses a compact safe app-list fallback', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
    slackPostError: {
      status: 422,
      error: 'slack_missing_scopes',
      consoleUrl: 'https://attacker.example/steal?token=xoxb-leak',
    },
    onboarding: onboardingConnectFixture(),
  });
  await flushAsync();
  submitOnboardingSlack(harness, 'xoxb-fallback', 'fallback-secret');
  await flushAsync();

  assert.match(harness.app.innerHTML, /href="https:\/\/api\.slack\.com\/apps"/);
  assert.match(harness.app.innerHTML, /Open the Chickpea app, then choose OAuth &amp; Permissions/);
  assert.doesNotMatch(harness.app.innerHTML, /attacker\.example|xoxb-leak|xoxb-fallback|fallback-secret/);
});

test('onboarding Start over and a fresh page discard the page-only Slack draft', async () => {
  const options = {
    initialPath: '/admin/onboarding',
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
    slackPostError: {
      status: 422,
      error: 'slack_missing_scopes',
      consoleUrl: 'https://api.slack.com/apps/A0REPAIR/oauth',
    },
    onboarding: onboardingConnectFixture(),
  };
  const harness = runAdminPageHarness(options);
  await flushAsync();
  submitOnboardingSlack(harness, 'xoxb-start-over', 'start-over-secret');
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-start-over' }) });

  assert.match(harness.app.innerHTML, /Add 2 values/);
  assert.deepEqual(harness.onboardingCredentialValues(), { botToken: '', signingSecret: '' });
  assert.equal(harness.focusedAction(), 'onboarding-signing-secret');

  const freshHarness = runAdminPageHarness(options);
  await flushAsync();
  freshHarness.listeners.click?.({ target: actionTarget({ 'data-action': 'advance-slack-step' }) });
  freshHarness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-app-created' }) });
  assert.deepEqual(freshHarness.onboardingCredentialValues(), { botToken: '', signingSecret: '' });
  assert.doesNotMatch(freshHarness.app.innerHTML, /xoxb-start-over|start-over-secret/);
});

test('onboarding cannot discard or overlap an in-flight permission check', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
    slackChannels: channelsFixture([{ id: 'C_NEW', name: 'new-channel', isMember: true }]),
    deferSlackPost: true,
    onboarding: onboardingConnectFixture(),
  });
  await flushAsync();
  submitOnboardingSlack(harness, 'xoxb-stale', 'stale-secret');
  harness.resolveSlackPost(0, {
    status: 422,
    error: 'slack_missing_scopes',
    consoleUrl: 'https://api.slack.com/apps/A0REPAIR/oauth',
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-open' }) });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-check' }) });
  assert.equal(harness.slackPosts.length, 2);
  assert.match(harness.app.innerHTML, /data-action="slack-permissions-start-over" disabled/);
  assert.match(harness.app.innerHTML, /Checking&hellip;/);
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-start-over' }) });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-check' }) });

  assert.equal(harness.slackPosts.length, 2, 'checking cannot overlap a second request');
  assert.match(harness.app.innerHTML, /Checking&hellip;/);
  assert.deepEqual(harness.onboardingCredentialValues(), { botToken: '', signingSecret: '' });

  harness.resolveSlackPost(1, {});
  await flushAsync();

  assert.match(harness.app.innerHTML, /Everything worked/);
  assert.doesNotMatch(harness.app.innerHTML, /Checking&hellip;|Finish applying Slack permissions/);
  assert.deepEqual(harness.onboardingCredentialValues(), { botToken: '', signingSecret: '' });
});

test('onboarding navigation discards the page-only Slack continuation draft', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
    slackPostError: {
      status: 422,
      error: 'slack_missing_scopes',
      consoleUrl: 'https://api.slack.com/apps/A0REPAIR/oauth',
    },
    onboarding: onboardingConnectFixture(),
  });
  await flushAsync();
  submitOnboardingSlack(harness, 'xoxb-navigation', 'navigation-secret');
  await flushAsync();
  assert.match(harness.app.innerHTML, /One more Slack approval/);

  harness.popstate('/admin/channels');
  assert.equal(harness.locationPath(), '/admin/channels');
  assert.doesNotMatch(harness.app.innerHTML, /One more Slack approval|xoxb-navigation|navigation-secret/);

  harness.popstate('/admin/onboarding');
  assert.match(harness.app.innerHTML, /Add 2 values/);
  assert.deepEqual(harness.onboardingCredentialValues(), { botToken: '', signingSecret: '' });
});

test('onboarding unexpected permission-check failures exit checking and show the ordinary error form', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
    slackPostResults: [
      { status: 422, error: 'slack_missing_scopes', consoleUrl: 'https://api.slack.com/apps/A0REPAIR/oauth' },
      { status: 500, error: 'internal_error' },
    ],
    onboarding: onboardingConnectFixture(),
  });
  await flushAsync();
  submitOnboardingSlack(harness, 'xoxb-unexpected', 'unexpected-secret');
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-open' }) });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-permissions-check' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Add 2 values/);
  assert.match(harness.app.innerHTML, /role="alert"[^>]*aria-live="assertive"/);
  assert.match(harness.app.innerHTML, /could not store the credentials/);
  assert.doesNotMatch(harness.app.innerHTML, /Checking&hellip;|Return here after Slack is done/);
  assert.deepEqual(harness.onboardingCredentialValues(), {
    botToken: 'xoxb-unexpected',
    signingSecret: 'unexpected-secret',
  });
  assert.equal(harness.focusedAction(), 'slack-connection-error');
});

test('onboarding mirrors typed Slack credentials without serializing them into rendered markup or history', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
    onboarding: onboardingConnectFixture(),
  });
  await flushAsync();
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'advance-slack-step' }) });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-app-created' }) });
  harness.listeners.input?.({ target: valueTarget({ 'data-action': 'slack-signing-secret' }, 'typed-secret') });
  harness.listeners.input?.({ target: valueTarget({ 'data-action': 'slack-bot-token' }, 'xoxb-typed') });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'slack-app-created' }) });

  assert.deepEqual(harness.onboardingCredentialValues(), {
    botToken: 'xoxb-typed',
    signingSecret: 'typed-secret',
  });
  assert.ok(harness.renderHistory.every((html) => !html.includes('xoxb-typed') && !html.includes('typed-secret')));
  assert.ok(harness.historyPushes.every((path) => !path.includes('xoxb-typed') && !path.includes('typed-secret')));
  assert.ok(harness.historyReplaces.every((path) => !path.includes('xoxb-typed') && !path.includes('typed-secret')));
  assert.match(harness.app.innerHTML, /type="password" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false"/);
});

test('onboarding never paints normal Admin navigation before its first routed render', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
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

test('onboarding gives compact recovery for each Slack verification failure code', async () => {
  const cases = [
    ['challenge_invalid_signature', /Retry the Event Subscriptions request URL check/],
    ['challenge_expired', /verification check expired/],
    ['challenge_missing', /waiting for Slack to verify the Events URL/],
    ['signing_secret_change_requires_reconnect', /disconnect this Slack app and connect it again/],
    ['workspace_mismatch', /different Slack workspace/],
    ['app_mismatch', /different Slack apps/],
    ['slack_scope_unverified', /required permissions/],
    ['slack_channel_list_failed', /confirm channel access/],
  ] as const;
  for (const [error, expected] of cases) {
    const harness = runAdminPageHarness({
      initialPath: '/admin/onboarding',
      assignments: [],
      slackConnection: disconnectedSlackFixture(),
      slackPostError: { status: 409, error, message: 'internal credential diagnostic must not render' },
      onboarding: {
        stage: 'connect_slack',
        revision: '{"version":1}',
        workspace: null,
        channel: null,
        tryStartedAt: null,
        completedAt: null,
      },
    });
    await flushAsync();
    harness.listeners.submit?.({
      target: submitTarget(
        { 'data-action': 'slack-connect-form' },
        { botToken: 'xoxb-safe-placeholder', signingSecret: 'safe-placeholder' },
      ),
      preventDefault() {},
    });
    await flushAsync();
    assert.match(harness.app.innerHTML, expected, error);
    assert.doesNotMatch(harness.app.innerHTML, /internal credential diagnostic/, error);
  }
});

test('onboarding assigns one returned Slack channel and lands directly in Try Chickpea', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
    agents: [seededAgents[0]],
    slackChannels: channelsFixture([
      { id: 'C_NEW', name: 'new-channel', isPrivate: false, isMember: false },
      { id: 'C_PRIVATE', name: 'invited-secret', isPrivate: true, isMember: true },
    ]),
    putIsMember: true,
    onboarding: {
      stage: 'choose_channel',
      revision: '{"version":1,"state":"active"}',
      workspace: { id: 'T_DESIGN', name: 'Acme Inc' },
      channel: null,
      tryStartedAt: null,
      completedAt: null,
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Choose where Chickpea should start/);
  assert.match(harness.app.innerHTML, /# new-channel/);
  assert.match(harness.app.innerHTML, /# invited-secret \(private\)/);
  assert.doesNotMatch(harness.app.innerHTML, /unreturned-secret/);

  harness.listeners.submit?.({
    target: submitTarget({ 'data-action': 'onboarding-channel-form' }, { channelSelect: 'C_NEW' }),
    preventDefault() {},
  });
  await flushAsync();

  assert.deepEqual(harness.putAssignments.at(-1), {
    workspaceId: 'T_DESIGN',
    channelId: 'C_NEW',
    agentId: 'agent_default',
    enabled: true,
    expectedAgentId: null,
    channelLabel: 'new-channel',
  });
  assert.deepEqual(harness.onboardingTryPosts, [{
    expectedRevision: '{"version":1,"state":"active"}',
    workspaceId: 'T_DESIGN',
    channelId: 'C_NEW',
    channelName: 'new-channel',
  }]);
  assert.match(harness.app.innerHTML, /Try Chickpea/);
  assert.match(harness.app.innerHTML, /https:\/\/app\.slack\.com\/client\/T_DESIGN\/C_NEW/);
  assert.match(harness.app.innerHTML, /Waiting for Chickpea to reply…/);
  assert.doesNotMatch(harness.app.innerHTML, /Waiting for Chickpea to reply&amp;hellip;/);
  assert.match(
    harness.app.innerHTML,
    /@Chickpea Give me three useful ways you can help this channel, each with an example prompt I could try next\./,
  );
});

test('onboarding stays on channel selection until Slack membership is positively verified', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
    agents: [seededAgents[0]],
    slackChannels: channelsFixture([{ id: 'C_NEW', name: 'new-channel' }]),
    onboarding: {
      stage: 'choose_channel',
      revision: '{"version":1,"state":"active"}',
      workspace: { id: 'T_DESIGN', name: 'Acme Inc' },
      channel: null,
      tryStartedAt: null,
      completedAt: null,
    },
  });
  await flushAsync();

  harness.listeners.submit?.({
    target: submitTarget({ 'data-action': 'onboarding-channel-form' }, { channelSelect: 'C_NEW' }),
    preventDefault() {},
  });
  await flushAsync();

  assert.equal(harness.onboardingTryPosts.length, 0);
  assert.match(harness.app.innerHTML, /could not verify that it joined #new-channel/);
  assert.match(harness.app.innerHTML, /Choose where Chickpea should start/);
});

test('onboarding carries the saved Slack channel name into the immediate Agent handoff', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    assignments: [],
    agents: [seededAgents[0]],
    putIsMember: true,
    slackChannels: channelsFixture([{ id: 'C_NEW', name: 'new-channel' }]),
    onboarding: {
      stage: 'choose_channel',
      revision: '{"version":1,"state":"active"}',
      workspace: { id: 'T_DESIGN', name: 'Acme Inc' },
      channel: null,
      tryStartedAt: null,
      completedAt: null,
    },
  });
  await flushAsync();

  harness.listeners.submit?.({
    target: submitTarget({ 'data-action': 'onboarding-channel-form' }, { channelSelect: 'C_NEW' }),
    preventDefault() {},
  });
  await flushAsync();
  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'open-profiles', 'data-agent': 'agent_default' }),
  });

  assert.match(harness.app.innerHTML, /># new-channel <span aria-hidden="true">&nearr;<\/span><\/button>/);
  assert.doesNotMatch(harness.app.innerHTML, /># C_NEW <span aria-hidden="true">&nearr;<\/span><\/button>/);
});

test('completed onboarding confirms the reply and hands off to the canonical Agent', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/onboarding',
    onboarding: {
      stage: 'complete',
      revision: '{"version":1,"state":"complete"}',
      workspace: { id: 'T_DESIGN', name: 'Acme Inc' },
      channel: { id: 'C_NEW', name: 'new-channel' },
      tryStartedAt: 1_800_000_000_000,
      completedAt: 1_800_000_005_000,
      agentId: 'agent_release',
      redirectTo: '/admin/agents/agent_release',
    },
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Reply confirmed in #new-channel/);
  assert.match(harness.app.innerHTML, /<h1 class="onboarding-title">Chickpea is ready<\/h1>/);
  assert.match(harness.app.innerHTML, /Continue in the Default Agent/);
  assert.doesNotMatch(harness.app.innerHTML, /aria-label="Admin navigation"/);
  assert.match(harness.app.innerHTML, /class="btn btn-primary" data-action="open-profiles" data-agent="agent_release">Open Release Profile/);
  assert.match(harness.app.innerHTML, /class="btn btn-soft" href="https:\/\/app\.slack\.com\/client\/T_DESIGN\/C_NEW"/);
  assert.doesNotMatch(harness.app.innerHTML, /readonly value="@Chickpea summarize|Copy message/);
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'open-profiles', 'data-agent': 'agent_release' }) });
  assert.match(harness.app.innerHTML, /aria-label="Admin navigation"/);
  assert.equal(harness.locationPath(), '/admin/agents/agent_release');
});

test('admin page renders the first-run Connect stepper when credentials are missing', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  // Step 1 is the whole screen: header, not-connected chip, the manifest Create
  // link (events URL prefilled), and the workspace-pick warning.
  assert.match(harness.app.innerHTML, /Connect @Chickpea/);
  assert.match(harness.app.innerHTML, /This is the workspace-default identity/);
  assert.match(harness.app.innerHTML, /Not connected/);
  // The manifest deep-link is the server-provided URL, attribute-escaped.
  assert.match(
    harness.app.innerHTML,
    /href="https:\/\/api\.slack\.com\/apps\?new_app=1&amp;manifest_json=%7B%22a%22%3A1%7D"/,
  );
  assert.match(harness.app.innerHTML, /tag\.example\.dev\/channels\/slack\/events/);
  assert.match(harness.app.innerHTML, /pick a workspace/);
  // Credential provenance lives in a collapsed disclosure (env signing secret is
  // read-only), and the paste fields belong to step 2 — hidden until advanced.
  assert.match(harness.app.innerHTML, /configured via environment/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);

  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'advance-slack-step' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Open Chickpea setup in Slack/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);
  click({ target: actionTarget({ 'data-action': 'slack-app-created' }) });
  await flushAsync();

  // Step 2: the two paired paste fields + the live-validation hint.
  assert.match(harness.app.innerHTML, /name="botToken"/);
  assert.match(harness.app.innerHTML, /name="signingSecret"/);
  assert.match(harness.app.innerHTML, /Reinstall to Workspace/);
  assert.match(harness.app.innerHTML, /first real Slack event/);
});

test('connected + zero channels shows the Slack overview with explicit workspace management', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: {
      connected: true,
      credentials: { botToken: 'env', signingSecret: 'env', botUserId: 'stored' },
      requestUrl: 'https://tag.example.dev/channels/slack/events',
      manifestUrl: 'https://api.slack.com/apps?new_app=1&manifest_json=%7B%22a%22%3A1%7D',
    },
  });
  await flushAsync();

  // Channels stays a placement index; workspace controls remain reachable in Settings.
  assert.match(harness.app.innerHTML, /<h1 class="page-title">Channels<\/h1>/);
  assert.match(harness.app.innerHTML, /No Channels yet/);
  assert.match(harness.app.innerHTML, /Add Channel/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);
  assert.doesNotMatch(harness.app.innerHTML, /Connect Slack/);
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'open-settings', 'data-section': 'slack' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Connected workspace/);
  assert.match(harness.app.innerHTML, /0 assigned channels/);
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

test('wizard paste-back submit posts both credentials and renders the connected state', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  const submit = harness.listeners.submit;
  assert.ok(submit);
  submit({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: '  xoxb-pasted ', signingSecret: 'pasted-secret' },
    ),
    preventDefault() {},
  });
  await flushAsync();

  // Trimmed on the client before the POST.
  assert.deepEqual(harness.slackPosts, [{ botToken: 'xoxb-pasted', signingSecret: 'pasted-secret' }]);
  // The connected funnel's dismissable success toast names the team + bot.
  assert.match(harness.app.innerHTML, /Connected to <b[^>]*>Acme Inc<\/b> as <span[^>]*>@tag<\/span>/);
  assert.doesNotMatch(harness.app.innerHTML, /name="botToken"/);
});

test('wizard submit validates empty fields inline without posting', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
    slackConnection: disconnectedSlackFixture(),
  });
  await flushAsync();

  const submit = harness.listeners.submit;
  assert.ok(submit);
  submit({
    target: submitTarget(
      { 'data-action': 'slack-connect-form' },
      { botToken: '', signingSecret: 'secret-only' },
    ),
    preventDefault() {},
  });
  await flushAsync();

  assert.equal(harness.slackPosts.length, 0);
  assert.match(harness.app.innerHTML, /Bot token is required\./);
});

// ---- Settings: model providers (cards 13-14) --------------------------------

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

test('the left rail keeps one coherent section switcher and section-specific navigation', async () => {
  const harness = runAdminPageHarness({ usageAdminUi: true });
  await flushAsync();

  const initialSwitcher = harness.app.innerHTML.match(/<nav class="section-switcher" aria-label="Admin navigation">[\s\S]*?<\/nav>/)?.[0] ?? '';
  assert.doesNotMatch(initialSwitcher, />Sections</);
  assert.doesNotMatch(initialSwitcher, /Sessions|open-sessions/);
  assert.ok(initialSwitcher.indexOf('>Agents</button>') < initialSwitcher.indexOf('>Channels</button>'));
  assert.ok(initialSwitcher.indexOf('>Channels</button>') < initialSwitcher.indexOf('>Usage</button>'));
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

test('the unified primary shell keeps a darker canvas around its white paper panel and collapses on mobile', () => {
  const page = renderAdminPage();
  assert.match(page, /\.primary-admin-shell\s*\{[^}]*background:\s*var\(--admin-visual-canvas\);[^}]*max-width:\s*none;/s);
  assert.match(page, /\.primary-admin-shell > \.topbar\s*\{[^}]*display:\s*none;/s);
  assert.match(page, /\.primary-admin-shell \.primary-shell-sidebar\s*\{[^}]*border-radius:\s*0;[^}]*box-shadow:\s*none;[^}]*width:\s*292px;/s);
  assert.match(page, /\.primary-admin-shell \.main\s*\{[^}]*background:\s*var\(--admin-visual-paper\);[^}]*height:\s*calc\(100% - 44px\);[^}]*margin:\s*22px 24px;[^}]*max-width:\s*none;[^}]*width:\s*auto;/s);
  assert.match(page, /\.team-main\s*\{[^}]*max-width:\s*760px;/s);
  assert.match(page, /\.usage-main\s*\{[^}]*max-width:\s*1100px;/s);
  assert.match(page, /@media \(max-width: 1000px\)[\s\S]*?\.primary-admin-shell \.primary-shell-sidebar\s*\{[^}]*width:\s*228px;[^}]*\}[\s\S]*?\.primary-admin-shell \.main\s*\{[^}]*margin-left:\s*15px;[^}]*margin-right:\s*15px;/s);
  assert.match(page, /@media \(max-width: 740px\)[\s\S]*?\.primary-admin-shell > \.topbar\s*\{[^}]*display:\s*flex;[^}]*\}[\s\S]*?\.primary-admin-shell \.primary-shell-sidebar\s*\{[^}]*display:\s*none;/s);
});

test('legacy Sessions page URLs return to the default Agent without loading Run data', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/sessions/run_session_fixture' });
  await flushAsync();

  assert.equal(harness.locationPath(), '/admin/agents/agent_release');
  assert.match(harness.app.innerHTML, /<aside class="rail primary-shell-sidebar agent-shell-sidebar">/);
  assert.doesNotMatch(harness.app.innerHTML, /Sessions|open-sessions|Run inspector/);
});

test('Settings shows an unobtrusive model-list status and refreshes it on demand', async () => {
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
  assert.match(html, /<span class="field-label">Model list<\/span>/);
  assert.match(html, /Models up to date &middot; revision 12/);
  assert.match(html, /data-action="model-catalog-refresh"[^>]*>[\s\S]*Refresh models<\/button>/);
  assert.doesNotMatch(html, /experimental|I understand|risk warning/i);

  click({ target: actionTarget({ 'data-action': 'model-catalog-refresh' }) });
  await flushAsync();
  await flushAsync();
  assert.equal(harness.modelCatalogRefreshCalls(), 1);
  assert.match(harness.app.innerHTML, /Models up to date &middot; revision 12/);
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
  assert.match(harness.app.innerHTML, /Models up to date &middot; revision 12/);

  harness.resolveModelCatalogStatus({
    ...currentStatus,
    revision: 3,
    generatedAt: '2026-07-01T20:00:00Z',
  });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Models up to date &middot; revision 12/);
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

test('Audit logs deep link renders the real Memory scope, generated index, editor, and reserved Network domain', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/mem_release',
  });
  await flushAsync();

  assert.equal(
    harness.locationPath(),
    '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/mem_release',
  );
  assert.match(harness.app.innerHTML, /Audit logs/);
  assert.match(harness.app.innerHTML, /Scheduled work/);
  assert.match(harness.app.innerHTML, /Network events/);
  assert.match(harness.app.innerHTML, /data-action="audit-tab-scheduled">Scheduled work/);
  assert.match(harness.app.innerHTML, /role="tab" disabled aria-disabled="true" title="Coming later">Network events/);
  assert.match(harness.app.innerHTML, /#eng-releases/);
  assert.match(harness.app.innerHTML, /release-guidance\.md/);
  assert.match(harness.app.innerHTML, /Review requested/);
  assert.match(harness.app.innerHTML, /Revision history \(1\)/);
  assert.match(harness.app.innerHTML, /Memories saved in #eng-releases can help Chickpea respond across this workspace/);
  assert.match(harness.app.innerHTML, /they can only be changed from #eng-releases/);
  assert.doesNotMatch(harness.app.innerHTML, /Review durable actions and retained data/);
  assert.doesNotMatch(harness.app.innerHTML, />Export store</);
  assert.doesNotMatch(harness.app.innerHTML, />Import</);
});

test('Memory scope rail uses Slack-style leading markers for public and private channels', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/MEMORY.md',
    memoryScopes: [
      {
        workspaceId: 'T_DESIGN', channelId: 'C0EXR3L9T', displayName: 'eng-releases',
        privacy: 'public', lifecycle: 'active', storeId: 'store_public_T_DESIGN',
        generation: null, entryCount: 1,
      },
      {
        workspaceId: 'T_DESIGN', channelId: 'C_PRIVATE', displayName: 'memory-private-acceptance',
        privacy: 'private', lifecycle: 'active', storeId: 'store_private_T_DESIGN',
        generation: null, entryCount: 0,
      },
    ],
  });
  await flushAsync();

  assert.match(
    harness.app.innerHTML,
    /<span class="audit-channel-marker" aria-hidden="true">#<\/span><span>eng-releases<\/span>/,
  );
  assert.match(
    harness.app.innerHTML,
    /<span class="audit-channel-marker" aria-hidden="true"><svg[^>]*>.*<\/svg><\/span><span>memory-private-acceptance<\/span>/,
  );
  assert.doesNotMatch(harness.app.innerHTML, /#memory-private-acceptance/);
  assert.doesNotMatch(harness.app.innerHTML, /audit-lock/);
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

test('Channel Advanced keeps additional instructions and exact-Channel memory together', async () => {
  const harness = runAdminPageHarness({ memoryScopes: [] });
  await flushAsync();

  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'select-channel',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C0EXR3L9T',
    }),
  });
  await flushAsync();
  assert.match(harness.app.innerHTML, /<summary data-action="channel-advanced-toggle">Advanced<\/summary>/);
  assert.match(harness.app.innerHTML, /<h2 class="section-title">Additional instructions<\/h2>/);
  assert.match(harness.app.innerHTML, /<h2 class="section-title">Channel memory<\/h2>/);
  assert.match(harness.app.innerHTML, /Exact-Channel files stay here even if the assigned Agent changes/);
  assert.match(harness.app.innerHTML, /# Channel Memory Index/);

  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'owner-memory-file', 'data-file': 'mem_release' }),
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /Markdown body/);
  assert.match(harness.app.innerHTML, /Version history \(1\)/);
  assert.match(harness.app.innerHTML, /This memory stays only in #eng-releases, even if its Agent changes/);
});

test('Channel Advanced stays open across memory editor re-renders', async () => {
  const harness = runAdminPageHarness({ initialPath: '/admin/channels/T_DESIGN/C0EXR3L9T' });
  await flushAsync();

  const advancedTarget: FakeTarget = {
    closest(selector: string) {
      if (selector === '[data-action]') return this;
      if (selector === 'details') return { open: false } as unknown as FakeTarget;
      return null;
    },
    getAttribute(name: string) {
      return name === 'data-action' ? 'channel-advanced-toggle' : null;
    },
  };
  harness.listeners.click?.({ target: advancedTarget });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'owner-memory-create-open' }) });

  assert.match(harness.app.innerHTML, /<details class="advanced channel-advanced-card" open><summary data-action="channel-advanced-toggle">Advanced<\/summary>/);
  assert.match(harness.app.innerHTML, /data-action="owner-memory-create-confirm"/);
});

test('Review scheduled work opens Audit with the selected channel filters', async () => {
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
  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'open-channel-scheduled',
      'data-workspace': 'T_DESIGN',
      'data-channel': 'C0EXR3L9T',
    }),
  });
  await flushAsync();

  assert.match(harness.app.innerHTML, /data-action="audit-tab-scheduled">Scheduled work/);
  assert.match(harness.app.innerHTML, /data-action="scheduled-filter-scope"/);
  assert.match(harness.app.innerHTML, /<option value="channel\|T_DESIGN\|C0EXR3L9T" selected>Channel: #eng-releases · Acme Inc<\/option>/);
  assert.match(harness.app.innerHTML, /Release readiness check/);
});

test('Memory editor escapes stored Markdown and explains irreversible deletion without a Slack controls catalog', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/mem_release',
  });
  await flushAsync();

  assert.doesNotMatch(harness.app.innerHTML, /<script>alert\(1\)<\/script>/);
  assert.match(harness.app.innerHTML, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(harness.app.innerHTML, /Relevant saved memories are used automatically in replies/);
  assert.doesNotMatch(harness.app.innerHTML, /data-action="memory-copy-controls"/);

  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'memory-delete-open' }),
  });
  assert.match(harness.app.innerHTML, /Delete release-guidance\?/);
  assert.match(
    harness.app.innerHTML,
    /This permanently removes the canonical memory body and the content from every stored revision in Chickpea\. Body-free audit tombstones and revision metadata remain\. Prior exports, Slack or provider logs, backups, and Flue transcripts may still retain copies; Chickpea cannot retract them\./,
  );

  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'memory-delete-cancel' }),
  });
  assert.doesNotMatch(harness.app.innerHTML, /Delete release-guidance\?/);

  harness.listeners.input?.({
    target: inputTarget({ 'data-action': 'memory-description' }, 'Unsaved operator draft'),
  });
  harness.listeners.click?.({
    target: actionTarget({ 'data-action': 'open-settings' }),
  });
  assert.equal(
    harness.locationPath(),
    '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/mem_release',
  );
  assert.match(harness.app.innerHTML, /Save or discard the current memory draft before navigating away/);
});

test('Memory editor saves a changed draft through the browser harness', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/mem_release',
  });
  await flushAsync();

  harness.listeners.input?.({
    target: inputTarget({ 'data-action': 'memory-description' }, 'Updated release guidance.'),
  });
  harness.listeners.input?.({
    target: inputTarget({ 'data-action': 'memory-body' }, 'Run the focused and full suites.'),
  });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'memory-save' }) });
  await flushAsync();

  assert.deepEqual(harness.memoryPuts, [{
    expectedVersion: 1,
    description: 'Updated release guidance.',
    type: 'project',
    body: 'Run the focused and full suites.',
  }]);
  assert.match(harness.app.innerHTML, /Memory saved\./);
  assert.match(harness.app.innerHTML, /value="Updated release guidance\."/);
  assert.match(harness.app.innerHTML, /Version 2/);
});

test('Memory editor preserves a conflicted draft until the operator loads the latest version', async () => {
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/mem_release',
    memorySaveError: { status: 409, error: 'memory_version_conflict', currentVersion: 2 },
  });
  await flushAsync();

  harness.listeners.input?.({
    target: inputTarget({ 'data-action': 'memory-description' }, 'Unsaved operator draft'),
  });
  harness.listeners.input?.({
    target: inputTarget({ 'data-action': 'memory-body' }, 'Unsaved body'),
  });
  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'memory-save' }) });
  await flushAsync();

  assert.match(harness.app.innerHTML, /now version 2/);
  assert.match(harness.app.innerHTML, /Your draft is preserved/);
  assert.match(harness.app.innerHTML, /value="Unsaved operator draft"/);
  assert.match(harness.app.innerHTML, /Unsaved body<\/textarea>/);
  assert.match(harness.app.innerHTML, /Latest saved guidance\./);

  harness.listeners.click?.({ target: actionTarget({ 'data-action': 'memory-use-latest' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /Loaded the latest saved version\./);
  assert.match(harness.app.innerHTML, /value="Latest saved guidance\."/);
  assert.doesNotMatch(harness.app.innerHTML, /Unsaved operator draft/);
});

test('Memory review resolution exposes both success and error states', async () => {
  const success = runAdminPageHarness({
    initialPath: '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/mem_release',
  });
  await flushAsync();
  success.listeners.click?.({ target: actionTarget({ 'data-action': 'memory-resolve-review' }) });
  await flushAsync();
  assert.deepEqual(success.memoryReviewPosts, [{ expectedVersion: 1, resolution: 'confirmed' }]);
  assert.match(success.app.innerHTML, /Review resolved\./);
  assert.doesNotMatch(success.app.innerHTML, /Review requested/);

  const failure = runAdminPageHarness({
    initialPath: '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/mem_release',
    memoryReviewError: { status: 409, error: 'memory_review_not_current' },
  });
  await flushAsync();
  failure.listeners.click?.({ target: actionTarget({ 'data-action': 'memory-resolve-review' }) });
  await flushAsync();
  assert.match(failure.app.innerHTML, /memory_review_not_current/);
  assert.match(failure.app.innerHTML, /Review requested/);
});

test('Memory permanent delete exposes honest success and error states', async () => {
  const success = runAdminPageHarness({
    initialPath: '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/mem_release',
  });
  await flushAsync();
  success.listeners.click?.({ target: actionTarget({ 'data-action': 'memory-delete-open' }) });
  success.listeners.click?.({ target: actionTarget({ 'data-action': 'memory-delete-confirm' }) });
  await flushAsync();
  assert.deepEqual(success.memoryDeletes, [{ expectedVersion: 1, acknowledgeIrreversible: true }]);
  assert.match(
    success.app.innerHTML,
    /Memory deleted from Chickpea\. Its canonical body and revision content were removed; body-free audit records remain, and prior exports, Slack or provider logs, backups, and Flue transcripts may still retain copies\./,
  );
  assert.doesNotMatch(success.app.innerHTML, /release-guidance\.md/);

  const failure = runAdminPageHarness({
    initialPath: '/admin/audit-logs/memory/store_public_T_DESIGN/C0EXR3L9T/mem_release',
    memoryDeleteError: { status: 503, error: 'memory_delete_unavailable' },
  });
  await flushAsync();
  failure.listeners.click?.({ target: actionTarget({ 'data-action': 'memory-delete-open' }) });
  failure.listeners.click?.({ target: actionTarget({ 'data-action': 'memory-delete-confirm' }) });
  await flushAsync();
  assert.match(failure.app.innerHTML, /memory_delete_unavailable/);
  assert.match(failure.app.innerHTML, /release-guidance\.md/);
});

test('Memory scope navigation ignores out-of-order file responses', async () => {
  const scopes: MemoryScopeFixture[] = [
    {
      workspaceId: 'T_DESIGN', channelId: 'C_FIRST', displayName: 'first',
      privacy: 'public', lifecycle: 'active', storeId: 'store_public_T_DESIGN',
      generation: null, entryCount: 1,
    },
    {
      workspaceId: 'T_DESIGN', channelId: 'C_SECOND', displayName: 'second',
      privacy: 'public', lifecycle: 'active', storeId: 'store_public_T_DESIGN',
      generation: null, entryCount: 1,
    },
  ];
  const harness = runAdminPageHarness({
    initialPath: '/admin/audit-logs/memory/store_public_T_DESIGN/C_FIRST',
    memoryScopes: scopes,
    memoryFiles: {
      C_FIRST: [{ name: 'MEMORY.md', generated: true, content: '# FIRST INDEX\n' }],
      C_SECOND: [{ name: 'MEMORY.md', generated: true, content: '# SECOND INDEX\n' }],
    },
    deferMemoryFiles: true,
  });
  await flushAsync();

  harness.listeners.click?.({
    target: actionTarget({
      'data-action': 'select-memory-scope',
      'data-store': 'store_public_T_DESIGN',
      'data-channel': 'C_SECOND',
    }),
  });
  harness.resolveMemoryFiles('C_SECOND');
  await flushAsync();
  assert.match(harness.app.innerHTML, /# SECOND INDEX/);

  harness.resolveMemoryFiles('C_FIRST');
  await flushAsync();
  assert.equal(
    harness.locationPath(),
    '/admin/audit-logs/memory/store_public_T_DESIGN/C_SECOND',
  );
  assert.match(harness.app.innerHTML, /# SECOND INDEX/);
  assert.doesNotMatch(harness.app.innerHTML, /# FIRST INDEX/);
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
  assert.doesNotMatch(html, /#direct_message/);
  assert.doesNotMatch(html, />#null<\/button>/);
  assert.match(html, /Recent <span class="usage-term-help"[^>]*>activity<\/span>/);
  assert.match(html, /data-tooltip="Activity includes each Slack message Chickpea responds to and each scheduled routine run\."/);
  assert.match(html, />Input tokens<\/th><th class="number">Output tokens<\/th><th class="number">Total tokens<\/th>/);
  assert.match(html, /<td class="number">1,200<\/td><td class="number">300<\/td><td class="number">1,500<\/td>/);
  assert.match(html, /class="usage-token-total" tabindex="0" data-tooltip="1,000 input · 250 output"[^>]*>1,250<\/span>/);
  assert.match(html, /Direct message/);
  assert.doesNotMatch(html, /data-action="usage-select-operation"|Activity details|data-operation="op_usage_fixture"/);
  assert.doesNotMatch(html, /Provider setup|Provider limits|Known estimate|Work instance|Retention and lifecycle/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /Release &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /authorization: Bearer|apiKey|clientSecret/i);
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

test('Settings renders the three key-provider rows and hides Workers AI on the Node target', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  // Anthropic (stored) shows the Stored chip + model count; OpenAI exposes both connections.
  assert.match(html, /<span class="prov-name">Anthropic<\/span>/);
  assert.match(html, /Stored<\/span><span class="hint">Saved here · 10 models available<\/span>/);
  assert.match(html, /<span class="prov-name">OpenAI<\/span>/);
  assert.match(html, /0 of 2 connected/);
  assert.doesNotMatch(html, /Selected:/);
  assert.doesNotMatch(html, /Use for OpenAI calls/);
  assert.match(html, /<span class="openai-auth-title">API key<\/span>/);
  assert.match(html, /<span class="openai-auth-title">ChatGPT subscription<\/span>/);
  assert.match(html, /Not connected<\/span>/);
  assert.match(html, /data-action="openai-subscription-start"/);
  assert.doesNotMatch(html, /Acknowledge experimental|personal ChatGPT account/);
  assert.match(html, /data-action="prov-add-key" data-provider="openai"/);
  // OpenRouter (env) is read-only — no change/remove — with the favorites manager.
  assert.match(html, /Via environment<\/span><span class="hint">Read-only/);
  assert.match(html, /in your picker<\/span>/);
  assert.match(html, /Models in your picker/);
  assert.doesNotMatch(html, /data-action="prov-remove" data-provider="openrouter"/);
  // Workers AI is binding-only: absent on Node.
  assert.doesNotMatch(html, /<span class="prov-name">Workers AI<\/span>/);
});

test('Settings selects one OpenAI method installation-wide while both connections remain configured', async () => {
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
  const change = harness.listeners.change;
  assert.ok(click && change);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  assert.doesNotMatch(harness.app.innerHTML, /Selected:/);
  assert.match(harness.app.innerHTML, /Use for OpenAI calls/);
  assert.match(harness.app.innerHTML, /class="select-wrap"><select class="input" id="openai-auth-method"/);
  assert.match(harness.app.innerHTML, /class="ic select-caret"/);
  assert.match(harness.app.innerHTML, /Applies to every OpenAI model and Agent/);
  assert.equal((harness.app.innerHTML.match(/>Selected</g) || []).length, 1);
  change({
    target: {
      value: 'subscription',
      closest: () => null,
      getAttribute(name: string) {
        return name === 'data-action' ? 'openai-auth-method' : null;
      },
    } as unknown as FakeTarget,
  });
  assert.match(harness.app.innerHTML, /Save to use ChatGPT subscription for every OpenAI call/);
  click({ target: actionTarget({ 'data-action': 'openai-auth-method-save' }) });
  await flushAsync();
  assert.deepEqual(harness.openAiAuthMethodPuts, ['subscription']);
  assert.doesNotMatch(harness.app.innerHTML, /Selected:/);
  assert.match(harness.app.innerHTML, /Applies to every OpenAI model and Agent/);
});

test('switching the OpenAI authentication method invalidates the profile picker model catalog', async () => {
  const harness = runAdminPageHarness({
    providers: [
      { id: 'anthropic', status: 'missing', modelCount: null },
      {
        id: 'openai',
        status: 'stored',
        modelCount: 1,
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
    modelProviders: [{
      id: 'openai',
      configured: true,
      source: 'via your key',
      suggestions: ['openai/gpt-4.1'],
    }],
    openaiModels: [{ id: 'gpt-4.1' }],
    openAiModelsAfterMethodSwitch: [{ id: 'gpt-5.6-sol' }],
  });
  await flushAsync();
  const click = harness.listeners.click;
  const change = harness.listeners.change;
  assert.ok(click && change);

  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /data-model="openai\/gpt-4\.1"/);

  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  change({
    target: {
      value: 'subscription',
      closest: () => null,
      getAttribute(name: string) {
        return name === 'data-action' ? 'openai-auth-method' : null;
      },
    } as unknown as FakeTarget,
  });
  click({ target: actionTarget({ 'data-action': 'openai-auth-method-save' }) });
  await flushAsync();

  click({ target: actionTarget({ 'data-action': 'open-profiles' }) });
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /data-model="openai\/gpt-5\.6-sol"/);
  assert.doesNotMatch(harness.app.innerHTML, /data-model="openai\/gpt-4\.1"/);
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
  // The API-key connection collapses independently from the subscription connection.
  assert.match(harness.app.innerHTML, /<span class="prov-name">OpenAI<\/span>/);
  assert.match(harness.app.innerHTML, /1 of 2 connected/);
  assert.match(harness.app.innerHTML, /Saved in Chickpea/);
  assert.doesNotMatch(harness.app.innerHTML, /Use for OpenAI calls/);
});

test('Settings omits the OpenAI method selector when Subscription is the only connection', async () => {
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

  assert.match(harness.app.innerHTML, /1 of 2 connected/);
  assert.doesNotMatch(harness.app.innerHTML, /Use for OpenAI calls|>Selected</);
});

test('Settings starts and completes Subscription authorization without rendering its browser capability', async () => {
  const harness = runAdminPageHarness({
    providers: [
      { id: 'anthropic', status: 'stored', modelCount: 10 },
      { id: 'openai', status: 'stored', modelCount: 2, activeAuthMethod: 'api_key', subscription: { state: 'disconnected', updatedAt: 0 } },
      { id: 'openrouter', status: 'env', modelCount: null },
      { id: 'workers-ai', status: 'missing', modelCount: null },
    ],
  });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);

  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();
  assert.match(harness.app.innerHTML, /one method selected for all OpenAI calls/);
  assert.doesNotMatch(harness.app.innerHTML, /Use for OpenAI calls/);
  assert.doesNotMatch(harness.app.innerHTML, /openai-subscription-risk/);
  click({ target: actionTarget({ 'data-action': 'openai-subscription-start' }) });
  await flushAsync();

  assert.deepEqual(harness.openAiSubscriptionPosts, [
    { action: 'start', body: {} },
  ]);
  assert.match(harness.app.innerHTML, /https:\/\/auth\.openai\.com\/codex\/device/);
  assert.match(harness.app.innerHTML, /CHICK-PEA/);
  assert.doesNotMatch(harness.app.innerHTML, /browser-attempt-capability-1234567890/);

  click({ target: actionTarget({ 'data-action': 'openai-subscription-copy-code' }) });
  await flushAsync();
  assert.deepEqual(harness.clipboardWrites, ['CHICK-PEA']);
  assert.match(harness.app.innerHTML, /Copied/);

  click({ target: actionTarget({ 'data-action': 'openai-subscription-poll' }) });
  await flushAsync();
  assert.deepEqual(harness.openAiSubscriptionPosts[1], {
    action: 'poll',
    body: { attemptCapability: 'browser-attempt-capability-1234567890' },
  });
  assert.match(harness.app.innerHTML, /Account <span class="mono">oas_safe_fixture<\/span>/);
  assert.match(harness.app.innerHTML, /Use for OpenAI calls/);
  assert.match(harness.app.innerHTML, /<option value="subscription" selected>ChatGPT subscription<\/option>/);
  assert.equal((harness.app.innerHTML.match(/>Selected</g) || []).length, 1);
  assert.doesNotMatch(harness.app.innerHTML, /Selected:/);
  assert.doesNotMatch(harness.app.innerHTML, /CHICK-PEA/);
  assert.doesNotMatch(harness.app.innerHTML, /browser-attempt-capability-1234567890/);
});

test('Settings keeps an authorizing attempt non-resumable after reload and disconnects without changing the API key', async () => {
  const authorizing = runAdminPageHarness({
    providers: [
      { id: 'anthropic', status: 'stored', modelCount: 10 },
      { id: 'openai', status: 'stored', modelCount: 2, subscription: { state: 'authorizing', updatedAt: 1_800_000_000_000 } },
      { id: 'openrouter', status: 'env', modelCount: null },
      { id: 'workers-ai', status: 'missing', modelCount: null },
    ],
  });
  await flushAsync();
  authorizing.listeners.click?.({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();
  assert.match(authorizing.app.innerHTML, /started in another page or before this reload/);
  assert.doesNotMatch(authorizing.app.innerHTML, /CHICK-PEA/);
  assert.doesNotMatch(authorizing.app.innerHTML, /openai-subscription-poll/);

  const connected = runAdminPageHarness({
    providers: [
      { id: 'anthropic', status: 'stored', modelCount: 10 },
      {
        id: 'openai',
        status: 'stored',
        modelCount: 2,
        subscription: {
          state: 'connected',
          updatedAt: 1_800_000_005_000,
          accountFingerprint: 'oas_safe_fixture',
          connectedAt: 1_800_000_005_000,
        },
      },
      { id: 'openrouter', status: 'env', modelCount: null },
      { id: 'workers-ai', status: 'missing', modelCount: null },
    ],
  });
  await flushAsync();
  const click = connected.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();
  click({ target: actionTarget({ 'data-action': 'openai-subscription-disconnect-open' }) });
  assert.match(connected.app.innerHTML, /A connected API key becomes the OpenAI method automatically/);
  click({ target: actionTarget({ 'data-action': 'openai-subscription-disconnect-confirm' }) });
  await flushAsync();

  assert.equal(connected.openAiSubscriptionDisconnects(), 1);
  assert.match(connected.app.innerHTML, /Saved in Chickpea/);
  assert.match(connected.app.innerHTML, /1 of 2 connected/);
  assert.match(connected.app.innerHTML, /Not connected/);
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
  // Provider still Missing (nothing stored) and the paste field is still open.
  assert.match(html, /Missing<\/span>/);
});

test('Settings remove-key confirmation names the pinned profiles and the honest consequence', async () => {
  const harness = runAdminPageHarness({
    assignments: [],
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
  assert.match(html, /the model provider call failed before completion/);
  assert.match(html, /ANTHROPIC_API_KEY<\/span> in the environment, if set, still applies/);
  assert.doesNotMatch(html, /Ops/); // the OpenAI-pinned profile is not implicated

  // Confirming removes the stored key.
  click({ target: actionTarget({ 'data-action': 'prov-remove-confirm', 'data-provider': 'anthropic' }) });
  await flushAsync();
  assert.deepEqual(harness.providerKeyDeletes, ['anthropic']);
});

test('Settings OpenRouter favorites manager searches, stars, and persists to the picker', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  const input = harness.listeners.input;
  assert.ok(click && input);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  // Two OpenRouter favorites render with ctx + input/output pricing metas.
  const html = harness.app.innerHTML;
  assert.match(html, /In your picker &middot; 2 starred/);
  assert.match(html, /<span class="fav-model">anthropic\/claude-sonnet-4<\/span><span class="fav-meta">200K ctx · <span class="price">\$3\.00 \/ \$15\.00<\/span> \/M<\/span>/);
  assert.match(html, /1M ctx/);

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
  assert.match(harness.app.innerHTML, /In your picker &middot; 3 starred/);
});

test('Settings shows the Workers AI row on the Cloudflare target with no per-row metas', async () => {
  const harness = runAdminPageHarness({ cloudflare: true });
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  click({ target: actionTarget({ 'data-action': 'open-settings' }) });
  await flushAsync();

  const html = harness.app.innerHTML;
  assert.match(html, /<span class="prov-name">Workers AI<\/span>/);
  assert.match(html, /Always available<\/span><span class="hint">Keyless · billed in Neurons/);
  assert.match(html, /via the Workers AI binding/);
  // Seed default renders as a starred favorite, provider-native, with NO meta.
  assert.match(html, /<span class="fav-model">@cf\/zai-org\/glm-5\.2<\/span><\/div>/);
  assert.match(html, /keep it starred to keep that default in the picker/);
});

test('the profile Model picker shows the node-unpinned pick-a-model prompt with the SLACK_TAG_MODEL note', async () => {
  const harness = runAdminPageHarness();
  await flushAsync();
  const click = harness.listeners.click;
  assert.ok(click);
  // A blank profile has no pinned model. The Model field is now a click-to-open
  // combobox (F6): opening it renders the grouped popover. With no providers
  // configured the popover shows the pick-a-model prompt.
  click({ target: actionTarget({ 'data-action': 'new-profile' }) });
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  const html = harness.app.innerHTML;

  assert.match(html, /placeholder="Pick a model &mdash; none pinned"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<div class="combo-group">no providers configured<\/div>/);
  // The empty-ish combo carries the offline/dev fallback note and a Settings link.
  assert.match(html, /set <span class="mono"[^>]*>SLACK_TAG_MODEL<\/span>/);
  assert.match(html, /as an offline\/dev fallback so an unpinned Agent still replies/);
  assert.match(html, /data-action="open-settings">Manage providers &amp; models in Settings &nearr;<\/button>/);
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

test('node-target Default seed is unpinned and its profile editor renders the pick-a-model prompt', async () => {
  const defaultProfile = seededAgents.find((agent) => agent.id === 'agent_default');
  assert.ok(defaultProfile);
  assert.equal(defaultProfile.model, undefined);

  const harness = runAdminPageHarness({
    agents: seededAgents,
    assignments: seededAssignments,
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
  // The seed's editor opens with an empty Model field; opening the combobox
  // proves the unpinned pick-a-model guidance renders in the popover.
  click({ target: actionTarget({ 'data-action': 'profile-model' }) });
  await flushAsync();
  const html = harness.app.innerHTML;

  assert.match(html, /<h1 class="page-title">Default<\/h1>/);
  assert.match(html, /value="" autocomplete="off" role="combobox" aria-expanded="true" aria-haspopup="listbox" placeholder="Pick a model &mdash; none pinned"/);
  assert.match(html, /<div class="combo-group">no providers configured<\/div>/);
  assert.match(html, /SLACK_TAG_MODEL/);
  assert.match(html, /as an offline\/dev fallback so an unpinned Agent still replies/);
});
