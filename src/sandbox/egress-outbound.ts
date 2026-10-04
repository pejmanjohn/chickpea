import {
  getCachedInstallationToken,
  getGithubConnection,
  mintableInstallation,
} from '../config/github-app.ts';
import { requireInstallationAdmitted } from '../config/installation-admission.ts';
import { deploymentTenancy, scopeInstallationEnv } from '../config/installation-scope.ts';
import { parseSandboxAllowedHosts, SANDBOX_SETTING_KEYS } from '../config/sandbox-settings.ts';
import { getSettingsStore, type PlatformEnv } from '../config/state-backend.ts';
import type { TurnPullRequestProgress } from '../config/state-rpc.ts';
import { sandboxEgressGrantsForMode, type SandboxEgressContext } from './cloudflare-policy.ts';
import {
  decideSandboxEgress,
  REPOSITORY_PERMISSIONS,
  resolveRepositoryInstallationScope,
} from './egress-handler.ts';
import { githubAuthorizationHeader } from './github-auth.ts';
import {
  admitGithubRequest,
  githubAnswerText,
  githubSecondaryLimitSeconds,
  githubWriteRateLimited,
  latchGithubRequests,
} from './github-write-rate.ts';
import {
  isGithubPullRequestCreateResponse,
  pullRequestProgressFromGithubResponse,
} from './progress.ts';

/**
 * Cloudflare's Sandbox SDK routes the container's intercepted HTTPS through
 * these Worker-side handlers. They receive the platform env, never scoped to
 * an installation, and the container's Durable Object ID, which the platform
 * sets and the container cannot forge. Each handler first asks that Sandbox,
 * in one call, which installation it serves and what its turn may reach,
 * and reads every tenant-owned store through that installation's env. A
 * Sandbox that cannot name its installation on a deployment serving many,
 * or whose installation the host no longer admits, gets nothing. Serving
 * many, each installation's GitHub writes are rate-limited, and all its
 * GitHub requests are held while GitHub's secondary limit lasts
 * (github-write-rate.ts). Profile grants are persisted as policy only; the
 * GitHub credential is minted after each request passes the pure policy
 * decision and is attached only to the Worker-side forwarded Request.
 */

export type SandboxOutboundContext = {
  containerId: string;
};

export type SandboxOutboundHandler = (
  request: Request,
  env: unknown,
  ctx: SandboxOutboundContext,
) => Promise<Response> | Response;

/** The Sandbox Durable Object methods the handlers call. */
export interface SandboxEgressStub {
  egressContext(): Promise<SandboxEgressContext>;
  getTurnId(): Promise<string | undefined>;
  recordPullRequestProgress(pullRequest: TurnPullRequestProgress, capturedTurnId: string): Promise<boolean>;
}

interface SandboxEgressNamespace {
  idFromString(id: string): unknown;
  get(id: unknown): SandboxEgressStub;
}

export const SANDBOX_BLOCKED_STATUS = 520;

export async function githubSandboxOutbound(
  request: Request,
  rawEnv: unknown,
  ctx: SandboxOutboundContext,
): Promise<Response> {
  try {
    const { env, stub, context } = await egressScope(rawEnv, ctx);
    const capturedTurnId = context.turnId;
    if (!capturedTurnId) return denySandboxOutbound();
    const policy = context.policy;
    if (!policy.mode) return denySandboxOutbound();

    // Credential-free preflight: validate the stored App-bound policy before
    // loading the private key.
    const preflightGrants = sandboxEgressGrantsForMode(policy, policy.mode);
    if (!preflightGrants) return denySandboxOutbound();
    const preflightDecision = decideSandboxEgress({
      url: request.url,
      method: request.method,
      grants: preflightGrants,
      allowedHosts: [],
    });
    if (!preflightDecision.allowed || preflightDecision.kind !== 'github') {
      return denySandboxOutbound();
    }

    // Resolve the credential only after the preflight decision, then bind the
    // stored policy to the current mode. Disconnecting the App invalidates the
    // running container until a fresh turn reconfigures it.
    const settings = getSettingsStore(env);
    // Serving many installations, the platform App scoped to this Sandbox's installation and its bindings.
    const connection = await getGithubConnection(settings, env);
    if (connection.mode !== 'app') return denySandboxOutbound();
    const grants = sandboxEgressGrantsForMode(policy, connection.mode);
    if (!grants) return denySandboxOutbound();
    const decision = decideSandboxEgress({
      url: request.url,
      method: request.method,
      headers: request.headers,
      grants,
      allowedHosts: [],
    });
    if (!decision.allowed || decision.kind !== 'github') {
      return denySandboxOutbound();
    }

    const installation = resolveRepositoryInstallationScope(
      grants,
      decision.repositories,
      (grant) => mintableInstallation(connection, grant),
    );
    if (!installation) return denySandboxOutbound();

    // An installation of many shares the platform's GitHub App: its writes
    // are rate-limited, and none of its requests leave while GitHub's
    // secondary limit holds it. Both are refused before a token is minted.
    if (context.installationId) {
      const admission = await admitGithubRequest({
        store: settings, installationId: context.installationId, effect: decision.effect, now: Date.now(),
      });
      if (!admission.admitted) return githubWriteRateLimited(admission.retryAfterSeconds);
    }
    const { token: credential } = await getCachedInstallationToken(
      connection,
      installation.id,
      {
        ...(installation.repositories
          ? { repositories: installation.repositories }
          : {}),
        permissions: REPOSITORY_PERMISSIONS,
      },
    );

    // Bind this request's decision to the turn captured before policy loading.
    // A reconfiguration during credential resolution must be decided again by
    // the next request, never forwarded under this turn's stale policy.
    if ((await stub.getTurnId()) !== capturedTurnId) return denySandboxOutbound();
    const headers = new Headers(request.headers);
    headers.set('Authorization', githubAuthorizationHeader(request.url, credential));
    const response = await fetch(new Request(request, { headers, redirect: 'manual' }));
    if (context.installationId) {
      const seconds = await githubSecondaryLimitSeconds({
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        body: () => githubAnswerText(response),
        now: Date.now(),
      });
      if (seconds !== undefined) {
        await latchGithubRequests({ store: settings, installationId: context.installationId, seconds, now: Date.now() });
      }
    }
    await recordPullRequestProgress(request, response, stub, capturedTurnId);
    return response;
  } catch {
    // Authentication/configuration errors are deliberately indistinguishable
    // from policy denials at the container boundary and never log token-bearing
    // request material.
    return denySandboxOutbound();
  }
}

export async function packageRegistrySandboxOutbound(
  request: Request,
  rawEnv: unknown,
  ctx: SandboxOutboundContext,
): Promise<Response> {
  try {
    const { env, context } = await egressScope(rawEnv, ctx);
    // The registries the turn resolved. Outside a configured turn (or on a
    // policy an earlier release stored) standalone reads its setting as it
    // always did; an installation of many reaches no registry.
    const snapshot = context.policy.packageRegistryHosts;
    const allowedHosts = snapshot ?? (deploymentTenancy(env) === 'installation'
      ? []
      : parseSandboxAllowedHosts(await getSettingsStore(env).getSetting(SANDBOX_SETTING_KEYS.allowedHosts)));
    const decision = decideSandboxEgress({
      url: request.url,
      method: request.method,
      grants: [],
      allowedHosts,
    });
    if (!decision.allowed || decision.kind !== 'package-registry') {
      return denySandboxOutbound();
    }
    // Manual redirects force every new origin back through interception,
    // where it is evaluated independently against the host allowlist.
    return fetch(new Request(request, { redirect: 'manual' }));
  } catch {
    return denySandboxOutbound();
  }
}

export function denySandboxOutbound(): Response {
  return new Response('Origin is disallowed', { status: SANDBOX_BLOCKED_STATUS });
}

/**
 * The container's own Sandbox, what it answers, and the env of the
 * installation it serves. Throws (and so denies) when a deployment serving
 * many installations meets a Sandbox that names none, or a standalone
 * deployment meets one that names any.
 */
async function egressScope(
  rawEnv: unknown,
  ctx: SandboxOutboundContext,
): Promise<{ env: PlatformEnv; stub: SandboxEgressStub; context: SandboxEgressContext }> {
  const platformEnv = sandboxPlatformEnv(rawEnv);
  const stub = platformEnv.SANDBOX.get(platformEnv.SANDBOX.idFromString(ctx.containerId));
  const context = await stub.egressContext();
  if (deploymentTenancy(platformEnv) === 'standalone') {
    if (context.installationId !== undefined) throw new Error('A standalone Sandbox names no installation.');
    return { env: platformEnv, stub, context };
  }
  if (!context.installationId) throw new Error('The Sandbox names no installation.');
  // A suspended or ended installation reaches nothing, within the admission
  // check's 30 seconds.
  await requireInstallationAdmitted(context.installationId);
  return {
    env: scopeInstallationEnv(platformEnv, { installationId: context.installationId }),
    stub,
    context,
  };
}

function sandboxPlatformEnv(value: unknown): PlatformEnv & { SANDBOX: SandboxEgressNamespace } {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Sandbox Worker environment is unavailable');
  }
  const workerEnv = value as Partial<PlatformEnv & { SANDBOX: SandboxEgressNamespace }>;
  if (
    !workerEnv.SANDBOX ||
    typeof workerEnv.SANDBOX.idFromString !== 'function' ||
    typeof workerEnv.SANDBOX.get !== 'function'
  ) {
    throw new Error('SANDBOX Durable Object binding is unavailable');
  }
  return workerEnv as PlatformEnv & { SANDBOX: SandboxEgressNamespace };
}

async function recordPullRequestProgress(
  request: Request,
  response: Response,
  stub: Pick<SandboxEgressStub, 'recordPullRequestProgress'>,
  capturedTurnId: string,
): Promise<void> {
  if (!isGithubPullRequestCreateResponse(request.url, request.method, response.status)) {
    return;
  }

  try {
    const pullRequest = pullRequestProgressFromGithubResponse({
      requestUrl: request.url,
      requestMethod: request.method,
      responseStatus: response.status,
      responseBody: await response.clone().json(),
    });
    if (!pullRequest) return;
    await stub.recordPullRequestProgress(pullRequest, capturedTurnId);
  } catch {
    // Progress recording is best-effort and must never turn a successful,
    // policy-approved GitHub operation into a failed sandbox request.
  }
}
