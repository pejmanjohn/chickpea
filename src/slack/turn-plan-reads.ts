import { TURN_ENVELOPE_SETTING_KEYS } from '../agents/turn-envelope.ts';
import { WEBSITE_LOGINS_SETTING, websiteLoginStateKey } from '../browser/logins.ts';
import { BROWSER_SETTING_KEYS } from '../browser/settings.ts';
import { GITHUB_SETTING_KEYS } from '../config/github-app.ts';
import { deploymentServesManyInstallations } from '../config/installation-scope.ts';
import { providerPrefix } from '../config/model-access.ts';
import { isProviderKeyId, PROVIDER_KEY_IDS } from '../config/provider-key-ids.ts';
import { PROVIDER_KEY_SETTING_KEYS } from '../config/provider-keys.ts';
import type { PlatformEnv } from '../config/state-backend.ts';
import { tagStateStub } from '../config/state-rpc.ts';
import { TurnReads } from '../config/turn-read-batch.ts';
import type { StateRead } from '../config/turn-reads.ts';
import { timedStateRpc } from '../observability/runtime-latency.ts';
import { opaqueId } from '../work/admission.ts';
import { turnRequestTs } from './thread-context.ts';
import { slackAgentContinuityKey, slackConversationKind } from './thread-key.ts';
import type { PendingTurnJob } from './turn-jobs.ts';

/**
 * The reads a runner's turn makes first while it prepares, as the RPCs its
 * Cf store proxies send: its settings and credentials, the Agent with its
 * memory and Channel grant (memory), the connections, model roles and
 * previous plan (the plan), the thread's recorded context, and its Work run
 * and binding. A read missing here is still read, by its own RPC.
 */
export function turnPlanReads(
  job: PendingTurnJob,
  env: PlatformEnv | undefined,
  bindingId?: string,
): StateRead[] {
  const { turn, assignment } = job;
  const { agentId } = assignment;
  const hosted = deploymentServesManyInstallations(env);
  // Every turn reads the model catalog and what its dispatch freezes (turn-envelope.ts).
  const settingKeys = [...TURN_ENVELOPE_SETTING_KEYS];
  if (!hosted) {
    // A hosted browser comes from the host's access (browser/capability.ts):
    // an installation's stored browser key is never read there.
    settingKeys.push(BROWSER_SETTING_KEYS.apiKey, BROWSER_SETTING_KEYS.projectId);
    // A hosted GitHub App comes from the deployment, not settings.
    settingKeys.push(GITHUB_SETTING_KEYS.appId, GITHUB_SETTING_KEYS.appSlug, GITHUB_SETTING_KEYS.privateKey);
    // A model of a key-backed provider is ready only with a key: its readiness reads them all.
    if (assignment.model && isProviderKeyId(providerPrefix(assignment.model))) {
      settingKeys.push(...PROVIDER_KEY_IDS.map((id) => PROVIDER_KEY_SETTING_KEYS[id]));
    }
  }
  // An Agent granted a website login reads the login catalog, then each login's state.
  const logins = assignment.agent.websiteLogins?.filter((grant) => grant.enabled) ?? [];
  if (logins.length) {
    settingKeys.push(WEBSITE_LOGINS_SETTING, ...logins.map((grant) => websiteLoginStateKey(grant.loginId)));
  }
  const reads: StateRead[] = [
    { method: 'settingGetMany', args: [settingKeys] },
    { method: 'configGetAgent', args: [agentId] },
    { method: 'configGetWorkspaceInstallation', args: [turn.workspaceId] },
    { method: 'memoryExecute', args: [{ kind: 'get_agent_memory', agentId }] },
    { method: 'configGetAgentModelRole', args: [agentId, 'image'] },
    { method: 'configGetWorkspaceModelRole', args: [turn.workspaceId, 'image'] },
    { method: 'configListSlackPublicContext', args: [turn.workspaceId, turn.channelId, turn.threadTs] },
  ];
  if (slackConversationKind(turn) === 'channel') {
    reads.push({ method: 'configListAgentChannelGrants', args: [turn.workspaceId, turn.channelId] });
  }
  if (turn.actorMembershipId) {
    reads.push(
      { method: 'configListConnectionAccounts', args: [turn.workspaceId] },
      { method: 'configListAgentConnectionBindings', args: [agentId] },
      {
        method: 'threadRunnerTurn',
        args: [{
          kind: 'getBoundRuntimePlan',
          continuityKey: opaqueId('agent', slackAgentContinuityKey(turn, assignment)),
          beforeMessageTs: turnRequestTs(turn),
          actorMembershipId: turn.actorMembershipId,
          agentId,
        }],
      },
    );
  }
  if (job.runId) {
    reads.push({ method: 'workExecute', args: [{ kind: 'get_run', runId: job.runId }] });
    if (bindingId) reads.push({ method: 'workExecute', args: [{ kind: 'get_binding', bindingId }] });
  }
  if (hosted) {
    for (const id of PROVIDER_KEY_IDS) reads.push({ method: 'modelCredentialRead', args: [id] });
  }
  return reads;
}

/**
 * The turn's reads, its batch sent now; a state store without the batch, or
 * that fails it, answers nothing. Only dispatch preparation ends them before
 * the run, so an attempt that prepares no dispatch gets none:
 *
 * - one that already holds its dispatch envelope (a reattached run, a retry
 *   after preparation), whose settings and credential records would
 *   otherwise stay as read at its start for the whole run;
 * - a management approval, which skips memory and the plan, and which the
 *   state store applies with its own stores: a write this turn's proxies
 *   never see, before the Add key card reads the Agent and its connections.
 */
export function prefetchTurnReads(env: PlatformEnv, job: PendingTurnJob, bindingId?: string): TurnReads | undefined {
  if (job.dispatchEnvelope || job.turn.managementApprovalProposalId) return undefined;
  const answered = Promise.resolve().then(async () => {
    const reads = turnPlanReads(job, env, bindingId);
    const answers = await timedStateRpc('stateReadBatch', tagStateStub(env).stateReadBatch(reads));
    return Array.isArray(answers)
      ? reads.map((read, index) => [read, answers[index] ?? null] as const)
      : undefined;
  }).catch(() => undefined);
  return new TurnReads(answered);
}
