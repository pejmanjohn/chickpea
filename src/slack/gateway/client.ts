import type { ConfigStore } from '../../config/store.ts';
import type { SettingsStore } from '../../config/settings-store.ts';
import { WORKSPACE_DEFAULT_SLACK_IDENTITY_ID } from '../../config/types.ts';
import type { IdentityStore } from '../../identity/types.ts';
import type { CredentialKeyring } from '../secret-envelope.ts';
import { SlackTransportError } from '../transport/types.ts';
import {
  loadOrCreateGatewayDeploymentIdentity,
  signGatewayRequest,
  type GatewayDeploymentIdentity,
} from './identity.ts';
import {
  CHICKPEA_GATEWAY_PROTOCOL_VERSION,
  MAX_GATEWAY_FRAME_BYTES,
  gatewayOperationAllowed,
  parseGatewayClaimCreateResponse,
  parseGatewayClaimStatusResponse,
  parseGatewayAvatarPublishResponse,
  parseGatewayFrameText,
  parseGatewayOperationResponse,
  type GatewayClaimCreateRequest,
  type GatewayClaimCreateResponse,
  type GatewayClaimStatusResponse,
  type GatewayClientFrame,
  type GatewayEventAck,
  type GatewayInboundDelivery,
  type GatewayOperationRequest,
  type GatewayServerFrame,
  type GatewaySessionHello,
  type GatewaySlackOperation,
  type GatewayWorkspaceBinding,
} from './protocol.ts';
import {
  gatewaySessionFailure,
  gatewaySessionRotationAt,
  type GatewaySessionCheckpoint,
} from './session.ts';

export const GATEWAY_CLAIM_SETTING = 'slack.gateway.claim.v1';
export const GATEWAY_BINDING_SETTING = 'slack.gateway.binding.v1';
export const GATEWAY_SESSION_SETTING = 'slack.gateway.session.v1';
const GATEWAY_REQUEST_TIMEOUT_MS = 15_000;

export interface GatewayClaimState {
  claimId: string;
  expiresAt: number;
  authorizationUrl: string;
  setupId?: string;
  setupRevision?: number;
}

export interface GatewayClientDependencies {
  settings: SettingsStore;
  config: ConfigStore;
  identity?: IdentityStore;
  keyring: CredentialKeyring;
  gatewayBaseUrl: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export interface GatewayOperationClient {
  readonly workspaceId: string;
  call(
    operation: GatewaySlackOperation,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

/** HTTPS control plane plus credential-free Slack operation proxy. */
export class GatewayDeploymentClient implements GatewayOperationClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private identityPromise: Promise<GatewayDeploymentIdentity> | undefined;
  private binding: GatewayWorkspaceBinding | undefined;

  constructor(private readonly dependencies: GatewayClientDependencies) {
    this.fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = dependencies.now ?? Date.now;
    this.requireBaseUrl();
  }

  get workspaceId(): string {
    if (!this.binding) throw new Error('Gateway workspace binding is unavailable.');
    return this.binding.workspaceId;
  }

  async loadBinding(): Promise<GatewayWorkspaceBinding | undefined> {
    if (this.binding) return this.binding;
    const raw = await this.dependencies.settings.getSetting(GATEWAY_BINDING_SETTING);
    if (!raw) return undefined;
    this.binding = parseStoredBinding(raw);
    return this.binding;
  }

  async recordSessionCheckpoint(checkpoint: GatewaySessionCheckpoint): Promise<void> {
    await this.dependencies.settings.setSetting(
      GATEWAY_SESSION_SETTING,
      JSON.stringify(checkpoint),
    );
  }

  async loadSessionCheckpoint(): Promise<GatewaySessionCheckpoint | undefined> {
    const raw = await this.dependencies.settings.getSetting(GATEWAY_SESSION_SETTING);
    return raw ? parseSessionCheckpoint(raw) : undefined;
  }

  async beginClaim(
    returnUrl?: string,
    setup?: { setupId: string; setupRevision: number },
  ): Promise<GatewayClaimCreateResponse> {
    const identity = await this.identity();
    const unsigned = {
      protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
      kind: 'claim.create' as const,
      deploymentId: identity.deploymentId,
      requestId: requestId(),
      issuedAt: this.now(),
      nonce: requestId('nonce'),
      publicKey: identity.publicKey,
      ...(returnUrl ? { returnUrl: requireReturnUrl(returnUrl) } : {}),
    } satisfies Omit<GatewayClaimCreateRequest, 'signature'>;
    const request = await signGatewayRequest(identity, unsigned);
    const response = parseGatewayClaimCreateResponse(await this.requestJson(
      '/v1/claims',
      { method: 'POST', body: JSON.stringify(request) },
    ));
    await this.dependencies.settings.setSetting(GATEWAY_CLAIM_SETTING, JSON.stringify({
      claimId: response.claimId,
      expiresAt: response.expiresAt,
      authorizationUrl: response.authorizationUrl,
      ...(setup ? setup : {}),
    } satisfies GatewayClaimState));
    return response;
  }

  async refreshClaim(): Promise<GatewayClaimStatusResponse> {
    const claim = await this.claim();
    if (!claim) throw new Error('No gateway installation claim is pending.');
    if (claim.expiresAt <= this.now()) throw new Error('Gateway installation claim expired.');
    const response = parseGatewayClaimStatusResponse(await this.signedJson(
      `/v1/claims/${encodeURIComponent(claim.claimId)}`,
      'claim.status',
      { claimId: claim.claimId },
    ));
    if (response.claimId !== claim.claimId) throw new Error('Gateway claim response mismatch.');
    if (response.state === 'bound' && response.binding) {
      await this.retainBinding(response.binding, claim);
    } else if (response.state === 'expired' || response.state === 'cancelled') {
      await this.dependencies.settings.deleteSetting(GATEWAY_CLAIM_SETTING);
    }
    return response;
  }

  async call(
    operation: GatewaySlackOperation,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!gatewayOperationAllowed(operation)) {
      throw new SlackTransportError(String(operation), 'operation_not_allowed');
    }
    const binding = await this.loadBinding();
    if (!binding) throw new SlackTransportError(operation, 'gateway_not_connected', { retryable: true });
    const identity = await this.identity();
    const unsigned = {
      protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
      kind: 'slack.operation' as const,
      deploymentId: identity.deploymentId,
      requestId: requestId(),
      issuedAt: this.now(),
      nonce: requestId('nonce'),
      bindingId: binding.bindingId,
      workspaceId: binding.workspaceId,
      operation,
      input: encodeGatewayInput(input),
    } satisfies Omit<GatewayOperationRequest, 'signature'>;
    const request = await signGatewayRequest(identity, unsigned);
    const response = parseGatewayOperationResponse(await this.requestJson(
      `/v1/workspaces/${encodeURIComponent(binding.workspaceId)}/operations`,
      { method: 'POST', body: JSON.stringify(request) },
    ));
    if (response.requestId !== request.requestId) {
      throw new SlackTransportError(operation, 'response_mismatch');
    }
    if (!response.ok) {
      throw new SlackTransportError(
        operation,
        response.error?.code ?? 'gateway_error',
        response.error ? { retryable: response.error.retryable } : {},
      );
    }
    return response.result ?? {};
  }

  /** Publish one immutable Agent avatar through gateway-owned public storage. */
  async publishAvatar(input: {
    workspaceId: string;
    agentId: string;
    revision: number;
    contentType: 'image/png' | 'image/jpeg' | 'image/webp';
    bytes: Uint8Array;
  }): Promise<string> {
    const binding = await this.requiredBinding();
    if (input.workspaceId !== binding.workspaceId) {
      throw new SlackTransportError('avatar.publish', 'workspace_mismatch');
    }
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new SlackTransportError('avatar.publish', 'invalid_revision');
    }
    const response = parseGatewayAvatarPublishResponse(await this.signedJson(
      '/v1/avatars',
      'avatar.publish',
      {
        bindingId: binding.bindingId,
        workspaceId: binding.workspaceId,
        agentId: input.agentId,
        revision: `rev_${input.revision}`,
        contentType: input.contentType,
        data: bytesToBase64(input.bytes),
      },
    ));
    return response.url;
  }

  /** Ask the gateway to render the fixed Chickpea avatar theme from a seed. */
  async generateAvatar(input: {
    workspaceId: string;
    agentId: string;
    revision: number;
    seed: string;
  }): Promise<string> {
    const binding = await this.requiredBinding();
    if (input.workspaceId !== binding.workspaceId) {
      throw new SlackTransportError('avatar.generate', 'workspace_mismatch');
    }
    if (!Number.isSafeInteger(input.revision) || input.revision < 1) {
      throw new SlackTransportError('avatar.generate', 'invalid_revision');
    }
    const response = parseGatewayAvatarPublishResponse(await this.signedJson(
      '/v1/avatars',
      'avatar.generate',
      {
        bindingId: binding.bindingId,
        workspaceId: binding.workspaceId,
        agentId: input.agentId,
        revision: `rev_${input.revision}`,
        seed: input.seed,
      },
    ));
    return response.url;
  }

  async beginOidc(input: {
    clientId: string;
    redirectUri: string;
    state: string;
    nonce: string;
    teamId: string;
  }): Promise<{ authorizationUrl: string; expiresAt: number }> {
    const binding = await this.requiredBinding();
    if (input.teamId !== binding.workspaceId || input.clientId !== binding.clientId) {
      throw new Error('Gateway OIDC binding mismatch.');
    }
    const value = await this.signedJson('/v1/oidc/authorize', 'oidc.authorize', {
      bindingId: binding.bindingId,
      workspaceId: binding.workspaceId,
      clientId: binding.clientId,
      callbackUrl: input.redirectUri,
      state: input.state,
      oidcNonce: input.nonce,
    });
    const record = valueRecord(value, 'Gateway OIDC response is invalid.');
    const authorizationUrl = new URL(String(record.authorizationUrl));
    if (authorizationUrl.protocol !== 'https:' || authorizationUrl.username ||
        authorizationUrl.password || authorizationUrl.hash) {
      throw new Error('Gateway OIDC response is invalid.');
    }
    if (typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt)) {
      throw new Error('Gateway OIDC response is invalid.');
    }
    return { authorizationUrl: authorizationUrl.toString(), expiresAt: record.expiresAt };
  }

  async exchangeOidc(input: {
    attemptId: string;
    code: string;
    nonce: string;
    expectedTeamId: string;
    expectedSlackUserId?: string | null;
  }): Promise<{
    slackTeamId: string;
    slackUserId: string;
    displayName: string;
    contactEmail?: string;
  }> {
    const binding = await this.requiredBinding();
    if (input.expectedTeamId !== binding.workspaceId) throw new Error('Gateway OIDC binding mismatch.');
    const value = await this.signedJson('/v1/oidc/exchange', 'oidc.exchange', {
      bindingId: binding.bindingId,
      workspaceId: binding.workspaceId,
      attemptId: input.attemptId,
      code: input.code,
      oidcNonce: input.nonce,
      expectedTeamId: input.expectedTeamId,
      ...(input.expectedSlackUserId
        ? { expectedSlackUserId: input.expectedSlackUserId }
        : {}),
    });
    const record = valueRecord(value, 'Gateway OIDC proof is invalid.');
    const slackTeamId = requiredGatewayString(record.slackTeamId);
    const slackUserId = requiredGatewayString(record.slackUserId);
    const displayName = requiredGatewayString(record.displayName);
    const contactEmail = typeof record.contactEmail === 'string' && record.contactEmail
      ? record.contactEmail
      : undefined;
    if (slackTeamId !== binding.workspaceId ||
        (input.expectedSlackUserId && slackUserId !== input.expectedSlackUserId)) {
      throw new Error('Gateway OIDC proof is invalid.');
    }
    return { slackTeamId, slackUserId, displayName, ...(contactEmail ? { contactEmail } : {}) };
  }

  async createSession(
    send: (frame: GatewayClientFrame) => void,
    onEvent: (delivery: GatewayInboundDelivery) => Promise<'accepted' | 'duplicate' | 'rejected'>,
    checkpoint?: GatewaySessionCheckpoint,
  ): Promise<GatewayLogicalSession> {
    const [identity, binding] = await Promise.all([this.identity(), this.loadBinding()]);
    if (!binding) throw new Error('Gateway workspace binding is unavailable.');
    return new GatewayLogicalSession({
      identity,
      binding,
      send,
      onEvent,
      now: this.now,
      checkpoint: checkpoint ?? { health: 'connecting', attempt: 0 },
    });
  }

  private async retainBinding(
    binding: GatewayWorkspaceBinding,
    claim: GatewayClaimState,
  ): Promise<void> {
    const identity = await this.identity();
    if (binding.deploymentId !== identity.deploymentId) {
      throw new Error('Gateway binding belongs to another deployment.');
    }
    if (this.dependencies.identity && claim.setupId && claim.setupRevision) {
      await this.dependencies.identity.recordSharedSlackInstallation({
        setupId: claim.setupId,
        expectedRevision: claim.setupRevision,
        appId: binding.appId,
        clientId: binding.clientId,
        bindingId: binding.bindingId,
        slackTeamId: binding.workspaceId,
        installerSlackUserId: binding.installerSlackUserId,
        botUserId: binding.botUserId,
      });
    }
    const current = await this.dependencies.config.getWorkspaceInstallation(binding.workspaceId);
    if (!current) {
      await this.dependencies.config.ensureWorkspaceInstallation({
        workspaceId: binding.workspaceId,
        transportMode: 'gateway',
        teamId: binding.workspaceId,
        appId: binding.appId,
        botUserId: binding.botUserId,
        gatewayBindingId: binding.bindingId,
      });
    } else {
      await this.dependencies.config.updateWorkspaceInstallation(binding.workspaceId, {
        transportMode: 'gateway',
        appId: binding.appId,
        botUserId: binding.botUserId,
        gatewayBindingId: binding.bindingId,
        health: 'healthy',
        healthDetail: null,
      }, current.revision);
    }
    const defaultIdentity = await this.dependencies.config.getSlackIdentity(
      WORKSPACE_DEFAULT_SLACK_IDENTITY_ID,
    );
    await this.dependencies.config.updateSlackIdentity(
      defaultIdentity.id,
      defaultIdentity.connectionRevision,
      {
        lifecycle: 'connected',
        teamId: binding.workspaceId,
        appId: binding.appId,
        botUserId: binding.botUserId,
        credentialProvenance: 'workspace_default',
        observedAt: this.now(),
        health: 'healthy',
        healthDetail: null,
      },
    );
    await this.dependencies.settings.applySettingsPatch({
      set: [{ key: GATEWAY_BINDING_SETTING, value: JSON.stringify(binding) }],
      delete: [GATEWAY_CLAIM_SETTING],
    });
    this.binding = binding;
  }

  private async signedJson(
    path: string,
    kind: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const identity = await this.identity();
    const request = await signGatewayRequest(identity, {
      ...body,
      protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
      deploymentId: identity.deploymentId,
      requestId: requestId(),
      issuedAt: this.now(),
      nonce: requestId('nonce'),
      kind,
    });
    return this.requestJson(path, { method: 'POST', body: JSON.stringify(request) });
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetch(new URL(path, this.requireBaseUrl()), {
        ...init,
        // Cloudflare Workers reject `redirect: "error"` before sending the
        // request. Keep redirects manual and fail closed below instead.
        redirect: 'manual',
        signal: init.signal ?? AbortSignal.timeout(GATEWAY_REQUEST_TIMEOUT_MS),
        headers: { 'content-type': 'application/json', ...init.headers },
      });
    } catch (error) {
      const detail = error instanceof Error
        ? error.message.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 240)
        : 'unknown';
      console.warn('[chickpea] shared Slack gateway request failed before response:', detail);
      throw new SlackTransportError('gateway.request', 'gateway_unreachable', { retryable: true });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new SlackTransportError('gateway.request', 'gateway_redirect_rejected');
    }
    const text = await boundedResponseText(response, MAX_GATEWAY_FRAME_BYTES);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new SlackTransportError('gateway.request', 'invalid_gateway_response');
    }
    if (!response.ok) {
      const record = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      throw new SlackTransportError(
        'gateway.request',
        typeof record.error === 'string' ? record.error : 'gateway_rejected',
        { retryable: response.status >= 500 || response.status === 429 },
      );
    }
    return payload;
  }

  private async identity(): Promise<GatewayDeploymentIdentity> {
    this.identityPromise ??= loadOrCreateGatewayDeploymentIdentity({
      settings: this.dependencies.settings,
      keyring: this.dependencies.keyring,
      now: this.now,
    }).catch((error) => {
      this.identityPromise = undefined;
      throw error;
    });
    return this.identityPromise;
  }

  private async requiredBinding(): Promise<GatewayWorkspaceBinding> {
    const binding = await this.loadBinding();
    if (!binding) throw new Error('Gateway workspace binding is unavailable.');
    return binding;
  }

  private async claim(): Promise<GatewayClaimState | undefined> {
    const raw = await this.dependencies.settings.getSetting(GATEWAY_CLAIM_SETTING);
    return raw ? parseClaimState(raw) : undefined;
  }

  private requireBaseUrl(): URL {
    const url = new URL(this.dependencies.gatewayBaseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
      throw new Error('Chickpea gateway URL must be HTTPS.');
    }
    return url;
  }
}

/** One socket incarnation of a renewable logical session. */
export class GatewayLogicalSession {
  private checkpoint: GatewaySessionCheckpoint;
  private ready = false;

  constructor(private readonly input: {
    identity: GatewayDeploymentIdentity;
    binding: GatewayWorkspaceBinding;
    send: (frame: GatewayClientFrame) => void;
    onEvent: (delivery: GatewayInboundDelivery) => Promise<'accepted' | 'duplicate' | 'rejected'>;
    now: () => number;
    checkpoint: GatewaySessionCheckpoint;
  }) {
    this.checkpoint = { ...input.checkpoint };
  }

  async hello(): Promise<void> {
    const unsigned = {
      protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
      kind: 'session.hello' as const,
      deploymentId: this.input.identity.deploymentId,
      requestId: requestId(),
      issuedAt: this.input.now(),
      nonce: requestId('nonce'),
      bindingId: this.input.binding.bindingId,
    } satisfies Omit<GatewaySessionHello, 'signature'>;
    this.input.send(await signGatewayRequest(this.input.identity, unsigned));
  }

  async handle(raw: string): Promise<void> {
    const frame = parseGatewayFrameText(raw);
    this.requireFrameBinding(frame);
    if (frame.kind === 'session.ready') {
      this.ready = true;
      const now = this.input.now();
      this.checkpoint = {
        health: 'healthy',
        attempt: 0,
        connectedAt: now,
        lastHeartbeatAt: now,
        rotateAt: Math.min(frame.rotateAt, gatewaySessionRotationAt(now)),
      };
      return;
    }
    if (frame.kind === 'session.ping' || frame.kind === 'session.pong') {
      this.checkpoint = { ...this.checkpoint, lastHeartbeatAt: this.input.now() };
      if (frame.kind === 'session.ping') {
        this.input.send({
          protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
          kind: 'session.pong',
          at: frame.at,
        });
      }
      return;
    }
    if (!this.ready) throw new Error('Gateway delivered an event before session authentication.');
    if (frame.kind !== 'event.deliver' && frame.kind !== 'interaction.agent_selected') {
      throw new Error('Unsupported gateway session frame.');
    }
    let outcome: GatewayEventAck['outcome'];
    try {
      outcome = await this.input.onEvent(frame);
    } catch {
      // The gateway lane is deliberately online-only: processing failures are
      // rejected rather than queued. They are application failures, however,
      // not malformed frames, so one bad event must not tear down the socket.
      outcome = 'rejected';
    }
    this.input.send({
      protocolVersion: CHICKPEA_GATEWAY_PROTOCOL_VERSION,
      kind: 'event.ack',
      deliveryId: frame.deliveryId,
      outcome,
    });
  }

  close(reason: string, random?: () => number): GatewaySessionCheckpoint {
    this.ready = false;
    this.checkpoint = gatewaySessionFailure(this.checkpoint, reason, this.input.now(), random);
    return this.checkpoint;
  }

  state(): GatewaySessionCheckpoint {
    return { ...this.checkpoint };
  }

  private requireFrameBinding(frame: GatewayServerFrame): void {
    if ('bindingId' in frame && frame.bindingId !== this.input.binding.bindingId) {
      throw new Error('Gateway frame binding mismatch.');
    }
    if ('workspaceId' in frame && frame.workspaceId !== this.input.binding.workspaceId) {
      throw new Error('Gateway frame workspace mismatch.');
    }
  }
}

function parseStoredBinding(raw: string): GatewayWorkspaceBinding {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Gateway workspace binding is invalid.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gateway workspace binding is invalid.');
  }
  const record = value as Record<string, unknown>;
  const required = [
    'bindingId', 'deploymentId', 'workspaceId', 'appId', 'clientId', 'botUserId',
    'installerSlackUserId', 'sessionUrl',
  ];
  if (required.some((key) => typeof record[key] !== 'string') ||
      typeof record.installedAt !== 'number' || !Number.isSafeInteger(record.installedAt)) {
    throw new Error('Gateway workspace binding is invalid.');
  }
  const sessionUrl = new URL(String(record.sessionUrl));
  if (sessionUrl.protocol !== 'wss:' || sessionUrl.username || sessionUrl.password || sessionUrl.hash) {
    throw new Error('Gateway workspace binding is invalid.');
  }
  return {
    bindingId: String(record.bindingId),
    deploymentId: String(record.deploymentId),
    workspaceId: String(record.workspaceId),
    appId: String(record.appId),
    clientId: String(record.clientId),
    botUserId: String(record.botUserId),
    installerSlackUserId: String(record.installerSlackUserId),
    sessionUrl: sessionUrl.toString(),
    installedAt: Number(record.installedAt),
  };
}

function parseClaimState(raw: string): GatewayClaimState {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('Gateway claim state is invalid.');
  }
  if (
    !record || typeof record.claimId !== 'string' || typeof record.authorizationUrl !== 'string' ||
    typeof record.expiresAt !== 'number' || !Number.isSafeInteger(record.expiresAt) ||
    ((record.setupId === undefined) !== (record.setupRevision === undefined)) ||
    (record.setupId !== undefined && typeof record.setupId !== 'string') ||
    (record.setupRevision !== undefined &&
      (typeof record.setupRevision !== 'number' || !Number.isSafeInteger(record.setupRevision)))
  ) {
    throw new Error('Gateway claim state is invalid.');
  }
  return {
    claimId: record.claimId,
    authorizationUrl: record.authorizationUrl,
    expiresAt: record.expiresAt,
    ...(record.setupId !== undefined
      ? { setupId: String(record.setupId), setupRevision: Number(record.setupRevision) }
      : {}),
  };
}

function parseSessionCheckpoint(raw: string): GatewaySessionCheckpoint {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Gateway session checkpoint is invalid.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Gateway session checkpoint is invalid.');
  }
  const record = value as Record<string, unknown>;
  if (!['disconnected', 'connecting', 'healthy', 'needs_attention'].includes(String(record.health)) ||
      typeof record.attempt !== 'number' || !Number.isSafeInteger(record.attempt) || record.attempt < 0) {
    throw new Error('Gateway session checkpoint is invalid.');
  }
  const checkpoint: GatewaySessionCheckpoint = {
    health: record.health as GatewaySessionCheckpoint['health'],
    attempt: record.attempt,
  };
  for (const key of ['connectedAt', 'lastHeartbeatAt', 'rotateAt', 'retryAt'] as const) {
    const item = record[key];
    if (item === undefined) continue;
    if (typeof item !== 'number' || !Number.isSafeInteger(item)) {
      throw new Error('Gateway session checkpoint is invalid.');
    }
    checkpoint[key] = item;
  }
  if (record.reason !== undefined) {
    if (typeof record.reason !== 'string' || record.reason.length > 256) {
      throw new Error('Gateway session checkpoint is invalid.');
    }
    checkpoint.reason = record.reason;
  }
  return checkpoint;
}

function encodeGatewayInput(input: Record<string, unknown>): Record<string, unknown> {
  return encodeValue(input) as Record<string, unknown>;
}

function encodeValue(value: unknown): unknown {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    return { __chickpeaBinary: 'base64', data: value.toString('base64') };
  }
  if (value instanceof Uint8Array) {
    let binary = '';
    for (const byte of value) binary += String.fromCharCode(byte);
    return { __chickpeaBinary: 'base64', data: btoa(binary) };
  }
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, encodeValue(child)]));
  }
  return value;
}

async function boundedResponseText(response: Response, maximumBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new SlackTransportError('gateway.request', 'gateway_response_too_large');
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(joined);
}

function requestId(prefix = 'request'): string {
  return `${prefix}_${globalThis.crypto.randomUUID().replaceAll('-', '')}`;
}

function requireReturnUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('Gateway return URL must be HTTPS.');
  }
  return url.toString();
}

function valueRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function requiredGatewayString(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512) {
    throw new Error('Gateway OIDC proof is invalid.');
  }
  return value;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}
