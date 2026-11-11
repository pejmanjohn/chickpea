
import type { z } from 'zod';

import { browserCapabilityForTurn } from '../../browser/capability.ts';
import { getGithubConnection } from '../../config/github-app.ts';
import { isProviderKeyId, PROVIDER_DISPLAY_NAMES } from '../../config/provider-key-ids.ts';
import type { ConnectionCheckOutcome } from '../../connections/connection-check.ts';
import { ADMIN_PATH, adminOrigin, adminSettingsLinks, adminTeamLinks } from '../admin-links.ts';
import { ManagementError } from '../types.ts';
import {
  readAgentRun,
  readingView,
  resolveAgentModel,
  seesChannel,
  type AgentAdmissionReading,
  type AgentRunReading,
} from './agent-run.ts';
import type { McpErrorFix } from './conventions.ts';
import { agentAvatar, connectionRows, presenceProblem, type FiveZeroDeps } from './reads.ts';
import type * as schemas from './schemas.ts';

type Output = z.infer<typeof schemas.checkAgentOutput>;
type Check = Output['checks'][number];

/**
 * Every part of one Agent, checked the way Admin would, with a fix the
 * caller can act on for each failing part. No model call. The only requests
 * that leave Chickpea are today's test_connection checks of the Agent's own
 * custom API and MCP connections. Each row's `plain` is what a card shows:
 * its detail without a status code, the service's own words or an ID.
 */
export async function checkAgent(
  deps: FiveZeroDeps,
  input: z.infer<typeof schemas.checkAgentInput>,
): Promise<Output> {
  const reading = await readAgentRun(deps, input);
  const groups = await Promise.all([
    connectionChecks(deps, reading),
    modelChecks(deps, reading),
    slackChecks(deps, reading),
    channelChecks(deps, reading),
    scheduleChecks(deps, reading),
    repositoryChecks(deps, reading),
    websiteLoginChecks(deps, reading),
    admissionChecks(deps, reading),
  ]);
  // A row whose detail is already Chickpea's own words shows it as it is.
  const checks = groups.flat().map((check) => check.plain === undefined ? { ...check, plain: check.detail } : check);
  const view = readingView(reading);
  return {
    ...view,
    agent: { ...view.agent, ...agentAvatar(deps, reading.agent) },
    healthy: !checks.some(({ status }) => status === 'failing'),
    checks,
  };
}

export function agentAdminFix(deps: FiveZeroDeps, reading: Pick<AgentAdmissionReading, 'agent'>, label: string): McpErrorFix | undefined {
  const origin = adminOrigin(deps.baseUrl);
  return origin ? { label, url: `${origin}${ADMIN_PATH}/agents/${encodeURIComponent(reading.agent.id)}` } : undefined;
}

/**
 * A turned-off Agent's fix: turning it back on, through update_agent, which
 * the model proposes in the chat. Everyone a reading is for may do it: both
 * readings refuse an Agent the caller cannot edit, as get_agent does.
 */
export function turnOnFix(reading: Pick<AgentAdmissionReading, 'agent'>): McpErrorFix {
  return { label: 'Turn it back on', tool: 'update_agent', arguments: { agentId: reading.agent.id, on: true } };
}

function settingsFix(deps: FiveZeroDeps, reading: AgentAdmissionReading, section: 'providers' | 'github' | 'browser', label: string) {
  if (reading.actor.role === 'member') return undefined;
  const url = adminSettingsLinks(deps.baseUrl, section, reading.stores.env)?.admin;
  return url ? { label, url } : undefined;
}

function withFix(check: Omit<Check, 'fix'>, fix: McpErrorFix | undefined): Check {
  return fix ? { ...check, fix } : check;
}

/** A connection's reconnect link, through the 5.0 tool that hands it out. */
function reconnectFix(reading: AgentRunReading, label: string, connectionId: string): McpErrorFix {
  return { label, tool: 'reconnect_service', arguments: { agentId: reading.agent.id, connectionId } };
}

const CHECK_DETAIL: Readonly<Record<Exclude<ConnectionCheckOutcome['kind'], 'ok'>, [Check['status'], string]>> = {
  key_rejected: ['failing', 'The service rejected its saved key.'],
  not_permitted: ['failing', 'The saved key works but lacks permission.'],
  path_not_found: ['warning', 'The service answered, but the path Chickpea checks was not found.'],
  unreachable: ['failing', 'Chickpea could not reach the service.'],
  inconclusive: ['unknown', 'The check could not tell whether it works.'],
};

async function connectionChecks(deps: FiveZeroDeps, reading: AgentRunReading): Promise<Check[]> {
  const accounts = reading.snapshotAgent.connections ?? [];
  const accountFor = (id: string) => accounts.find((account) => account.id === id || account.providerId === id);
  return Promise.all(connectionRows(reading.snapshotAgent).map(async (row): Promise<Check> => {
    const base = { part: 'connection' as const, name: row.name, connectionId: row.connectionId };
    const account = accountFor(row.connectionId);
    // A member's snapshot shows only their own personal accounts; team ones are an Owner's or Admin's to rekey.
    const mayReplaceKey = account !== undefined && (reading.actor.role !== 'member' || account.ownerKind === 'member');
    if (row.status === 'off') return { ...base, status: 'ok', detail: 'Turned off for this Agent.' };
    if (row.status === 'needs_attention') {
      return withFix({ ...base, status: 'failing', detail: 'It needs to be reconnected.' },
        account?.reconnect ? reconnectFix(reading, `Reconnect ${account.label}`, row.connectionId) : agentAdminFix(deps, reading, 'Reconnect it in Admin'));
    }
    if (row.status === 'waiting_for_setup') {
      // A key or sign-in left unfinished gets reconnect_service's link, as a connection just added does.
      const fix = account?.reconnect ? reconnectFix(reading, `Reconnect ${account.label}`, row.connectionId)
        : mayReplaceKey ? reconnectFix(reading, `Finish setting up ${row.name}`, row.connectionId)
          : agentAdminFix(deps, reading, 'Finish its setup in Admin');
      return withFix({ ...base, status: 'warning', detail: 'Its setup has not finished.' }, fix);
    }
    // A catalog service gets its stored state only; no new call goes to it.
    if (row.kind === 'service') return { ...base, status: 'ok', detail: 'Connected.' };
    let outcome: ConnectionCheckOutcome;
    try {
      outcome = await deps.service.testConnection(reading.context, { agentId: reading.agent.id, connectionId: row.connectionId });
    } catch (error) {
      // Testing unavailable here, an ambiguous connectionId, or a connection that is gone: nothing was checked.
      if (error instanceof ManagementError) return { ...base, status: 'unknown', detail: error.message, plain: CHECK_DETAIL.inconclusive[1] };
      throw error;
    }
    if (outcome.kind === 'ok') {
      return 'tools' in outcome
        ? { ...base, status: 'ok', detail: `Answered and listed ${outcome.tools.length} tools.` }
        : { ...base, status: 'ok', detail: `Answered with HTTP ${outcome.status}.`, plain: 'It answered.' };
    }
    const [status, summary] = CHECK_DETAIL[outcome.kind];
    const detail = [summary, 'status' in outcome && outcome.status ? `HTTP ${outcome.status}.` : '', outcome.detail]
      .filter(Boolean).join(' ');
    const fix = (outcome.kind === 'key_rejected' || outcome.kind === 'not_permitted') && mayReplaceKey
      ? reconnectFix(reading, 'Send a link to save a new key', row.connectionId)
      : undefined;
    return withFix({ ...base, status, detail, plain: summary }, fix);
  }));
}

/** `resolved` is the model resolveAgentModel already read for this reading, if any. */
export async function modelChecks(
  deps: FiveZeroDeps,
  reading: AgentAdmissionReading,
  resolved?: Awaited<ReturnType<typeof resolveAgentModel>>,
): Promise<Check[]> {
  const { model } = resolved ?? await resolveAgentModel(reading);
  const name = model.model ?? 'The workspace chat model';
  if (model.canRun) return [{ part: 'model', name, status: 'ok', detail: `It runs on ${name}.` }];
  const provider = model.model?.split('/')[0];
  const providerFix = provider && isProviderKeyId(provider) && reading.actor.role !== 'member' &&
    model.unavailable === 'credential_missing'
    ? { label: `Set up ${PROVIDER_DISPLAY_NAMES[provider]}`, tool: 'connect_model_provider', arguments: { provider } }
    : undefined;
  const fix = providerFix ?? settingsFix(deps, reading, 'providers', 'Open Model providers in Admin') ??
    agentAdminFix(deps, reading, 'Choose another model in Admin');
  const owner = reading.actor.role === 'member' && !fix ? ' An Owner or Admin can fix it.' : '';
  const detail = `${model.why ?? 'It cannot run now.'}${owner}`;
  // A model Chickpea could not resolve explains itself in engineering terms
  // (an Agent ID, an environment variable), which only the model should see.
  const plain = model.unavailable === 'unresolved' ? `No model is ready for it. Choose one in Admin.${owner}` : detail;
  return [withFix({ part: 'model', name, status: 'failing', detail, plain }, fix)];
}

async function slackChecks(deps: FiveZeroDeps, reading: AgentRunReading): Promise<Check[]> {
  const presence = reading.snapshotAgent.slackPresence;
  const name = presence?.normalizedHandle ? `@${presence.normalizedHandle}` : 'Slack';
  if (!presence || presence.health === 'unpublished') {
    return [{ part: 'slack', name, status: 'warning', detail: 'It is not in Slack yet, so no one can mention it.' }];
  }
  if (presence.health === 'healthy') return [{ part: 'slack', name, status: 'ok', detail: 'Ready in Slack.' }];
  if (presence.health === 'pending') return [{ part: 'slack', name, status: 'warning', detail: 'Still joining Slack.' }];
  return [withFix({ part: 'slack', name, status: 'failing', detail: presenceProblem(presence.errorCode) },
    agentAdminFix(deps, reading, 'Retry in Admin'))];
}

async function channelChecks(deps: FiveZeroDeps, reading: AgentRunReading): Promise<Check[]> {
  const grants = reading.grants.filter(({ agentId, channelId }) => agentId === reading.agent.id && seesChannel(reading, channelId));
  if (grants.length === 0) {
    return [{ part: 'channel', name: 'Channels', status: 'ok', detail: 'Not added to any Channel; it answers only in DMs.' }];
  }
  return grants.map((grant): Check => {
    const channel = reading.snapshot.channels.find(({ channelId }) => channelId === grant.channelId);
    const base = { part: 'channel' as const, name: channel?.label ? `#${channel.label}` : grant.channelId, channelId: grant.channelId };
    if (channel?.lifecycle === 'archived') {
      return withFix({ ...base, status: 'failing', detail: 'This Channel is turned off in Chickpea.' },
        agentAdminFix(deps, reading, 'Open the Agent in Admin'));
    }
    if (grant.status === 'active') return { ...base, status: 'ok', detail: 'Answers here.' };
    if (grant.status === 'pending') return { ...base, status: 'warning', detail: 'Still joining this Channel.' };
    return withFix({ ...base, status: 'failing', detail: 'Chickpea cannot answer here; invite Chickpea to the Channel again.' },
      agentAdminFix(deps, reading, 'Open the Agent in Admin'));
  });
}

const RECENT_RUNS = 5;

async function scheduleChecks(deps: FiveZeroDeps, reading: AgentRunReading): Promise<Check[]> {
  const { stores } = reading;
  if (!stores.routines) return [];
  const { routines } = await deps.service.inspectRoutines(reading.context, { workspaceId: reading.workspaceId })
    .catch(() => ({ routines: [] }));
  const own = routines.filter(({ owningAgentId, state }) => owningAgentId === reading.agent.id && state !== 'deleted');
  return Promise.all(own.map(async (routine): Promise<Check> => {
    const base = { part: 'schedule' as const, name: routine.name ?? routine.scheduleInput, scheduleId: routine.id };
    const next = routine.nextRunTime ? `Next run ${routine.nextRunTime.display}.` : 'No run is scheduled.';
    const fix = agentAdminFix(deps, reading, 'Open the Agent\'s schedules in Admin');
    if (routine.state === 'pending_authority') {
      return withFix({ ...base, status: 'failing', detail: 'Waiting for access: the person it runs as can no longer use something it needs.' }, fix);
    }
    if (routine.state === 'paused' || routine.state === 'disabled') {
      const why = routine.pausedReason ?? routine.disabledReason;
      const state = routine.state === 'paused' ? 'Paused.' : 'Turned off.';
      return withFix({ ...base, status: 'warning', detail: `${state}${why ? ` ${why}` : ''}`, plain: state }, fix);
    }
    if (routine.state === 'completed') return { ...base, status: 'ok', detail: 'Finished its one run.' };
    const runs = await stores.routines!.listRuns({ routineId: routine.id, limit: RECENT_RUNS });
    const failed = runs.filter(({ status }) => status === 'failed');
    const lastError = failed[0]?.publicError;
    if (runs[0]?.status === 'failed') {
      return withFix({
        ...base,
        status: 'failing',
        detail: `Its last run failed${lastError ? `: ${lastError}` : '.'} ${next}`,
        plain: `Its last run failed. ${next}`,
      }, fix);
    }
    if (failed.length > 0) {
      return withFix({
        ...base,
        status: 'warning',
        detail: `${failed.length} of its last ${runs.length} runs failed${lastError ? `: ${lastError}` : '.'} ${next}`,
        plain: `${failed.length} of its last ${runs.length} runs failed. ${next}`,
      }, fix);
    }
    return { ...base, status: 'ok', detail: next };
  }));
}

async function repositoryChecks(deps: FiveZeroDeps, reading: AgentRunReading): Promise<Check[]> {
  const grants = reading.agent.repositories.filter(({ enabled }) => enabled);
  if (grants.length === 0 || !reading.stores.settings) return [];
  const connection = await getGithubConnection(reading.stores.settings, reading.stores.env).catch(() => undefined);
  if (!connection || connection.mode === 'none') {
    return [withFix({
      part: 'repository',
      name: 'GitHub',
      status: 'failing',
      detail: `GitHub is not connected to Chickpea, so it cannot reach its repositories.${reading.actor.role === 'member' ? ' An Owner or Admin can connect it.' : ''}`,
    }, settingsFix(deps, reading, 'github', 'Connect GitHub in Admin'))];
  }
  const active = connection.platform
    ? new Set(connection.platform.bindings.map(({ githubInstallationId }) => githubInstallationId))
    : undefined;
  return grants.map((grant): Check => {
    const name = grant.allRepos ? `${grant.accountLogin}/*` : grant.fullName;
    if (grant.installationId === null) {
      return withFix({ part: 'repository', name, status: 'failing', detail: `Chickpea's GitHub App is not installed for ${grant.accountLogin}.` },
        // No 5.0 tool hands out a GitHub access link on its own, and the
        // 4.x one is hidden from clients that draw cards; the Agent's page
        // in Admin gives that access to Owners and Members alike.
        agentAdminFix(deps, reading, 'Give GitHub access in Admin'));
    }
    if (active && !active.has(grant.installationId)) {
      return withFix({ part: 'repository', name, status: 'failing', detail: `GitHub access for ${grant.accountLogin} is suspended or was removed.` },
        settingsFix(deps, reading, 'github', 'Open GitHub in Admin'));
    }
    return { part: 'repository', name, status: 'ok', detail: 'GitHub access is installed.' };
  });
}

async function websiteLoginChecks(deps: FiveZeroDeps, reading: AgentRunReading): Promise<Check[]> {
  const logins = reading.snapshotAgent.websiteLogins ?? [];
  if (logins.length === 0 || !reading.stores.settings) return [];
  const browser = await browserCapabilityForTurn(reading.stores.settings, reading.stores.env).catch(() => undefined);
  return logins.map((login): Check => {
    const base = { part: 'website_login' as const, name: login.host, loginId: login.loginId };
    const used = login.lastUsedAt === undefined
      ? 'Not used yet.'
      : `Last used ${new Date(login.lastUsedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.`;
    if (!login.enabled) return { ...base, status: 'ok', detail: `Turned off for this Agent. ${used}` };
    if (!browser) {
      return withFix({ ...base, status: 'failing', detail: `No hosted browser is connected, so it cannot sign in. ${used}` },
        settingsFix(deps, reading, 'browser', 'Connect a browser in Admin'));
    }
    return { ...base, status: 'ok', detail: used };
  });
}

/**
 * Would a message from this person in this place reach this Agent, from
 * stored configuration only: the Agent's state, the person's membership,
 * the Channel grant, and who may use it in a DM. Whether the person is in a
 * private Channel is Slack's to say when the message arrives.
 */
export function admissionChecks(deps: FiveZeroDeps, reading: AgentAdmissionReading): Check[] {
  const { agent, person, place } = reading;
  const who = person.you ? 'you' : person.name ?? 'this person';
  const name = place.kind === 'dm' ? `${who}, in a DM` : `${who}, in ${place.name ? `#${place.name}` : place.channelId}`;
  const fix = agentAdminFix(deps, reading, 'Open the Agent in Admin');
  const no = (detail: string, to = fix): Check[] => [withFix({ part: 'admission', name, status: 'failing', detail }, to)];
  if (agent.lifecycle === 'archived') return no(`${agent.name} is archived, so it answers no one.`);
  if (!agent.enabled) return no(`${agent.name} is turned off, so it answers no one.`, turnOnFix(reading));
  if (person.status !== 'active') {
    const team = reading.actor.role === 'member' ? undefined : adminTeamLinks(deps.baseUrl)?.admin;
    return no(`${person.you ? 'Your' : 'Their'} Chickpea membership is ${person.status}, so Chickpea ignores ${person.you ? 'your' : 'their'} messages.`,
      team ? { label: 'Open Team in Admin', url: team } : undefined);
  }
  const checks = place.kind === 'dm' ? dmAdmission(reading, name) : [channelAdmission(reading, name, place.channelId)];
  return checks.map((check) => check.status === 'failing' && fix ? { ...check, fix } : check);
}

/**
 * Who may DM the Agent, and how a DM reaches it. The card shows one
 * sentence with what to do (`plain`); how Chickpea routes the DM stays in
 * `detail` for the model.
 */
function dmAdmission(reading: AgentAdmissionReading, name: string): Check[] {
  const { agent, person, installation, snapshotAgent } = reading;
  const active = reading.grants.filter(({ agentId, status }) => agentId === agent.id && status === 'active');
  const check = (status: Check['status'], detail: string, plain: string): Check => ({ part: 'admission', name, status, detail, plain });
  const who = person.you ? 'You' : person.name ?? 'This person';
  const how = snapshotAgent.ownSlackApp ? `message @${snapshotAgent.ownSlackApp.handle}`
    : installation?.defaultAgentId === agent.id ? 'message Chickpea'
      : 'choose it in Chickpea\'s Home tab in Slack';
  let audience: Check;
  if (active.length === 0) {
    audience = agent.creatorMembershipId === person.membershipId
      ? check('ok', `It is in no Channel, so only the person who created it may DM it, and ${person.you ? 'you did' : 'they did'}.`, `${who} can DM it: ${how}.`)
      : check('failing', 'It is in no Channel, so only the person who created it may DM it. Adding it to a public Channel lets the whole workspace use it.',
        'Only the person who created it can DM it until it is in a public Channel.');
  } else if (active.some(({ channelIsPrivate }) => channelIsPrivate === false)) {
    audience = check('ok', 'It is in a public Channel, so everyone in the workspace may DM it.', `${who} can DM it: ${how}.`);
  } else {
    audience = check('unknown', 'It is only in private Channels, so only their members may DM it. Slack says whether this person is one when the message arrives.',
      `${who} may not be able to DM it: it is only in private Channels.`);
  }
  if (audience.status === 'failing') return [audience];
  const route = snapshotAgent.ownSlackApp
    ? `A DM to its own Slack app, @${snapshotAgent.ownSlackApp.handle}, reaches it directly.`
    : installation?.defaultAgentId === agent.id
      ? 'It is the workspace\'s default Agent, so a DM to Chickpea reaches it.'
      : 'A DM to Chickpea goes first to the default Agent, whose front desk may hand it to this one or keep it; choosing this Agent in Chickpea\'s Home tab starts a DM with it.';
  return [{ ...audience, detail: `${audience.detail} ${route}` }];
}

function channelAdmission(reading: AgentAdmissionReading, name: string, channelId: string): Check {
  const { agent, snapshotAgent } = reading;
  const check = (status: Check['status'], detail: string): Check => ({ part: 'admission', name, status, detail, channelId });
  const channel = reading.snapshot.channels.find((candidate) => candidate.channelId === channelId);
  if (channel?.lifecycle === 'archived') return check('failing', 'This Channel is turned off in Chickpea.');
  const inChannel = seesChannel(reading, channelId) ? reading.grants.filter((grant) => grant.channelId === channelId) : [];
  const grant = inChannel.find(({ agentId }) => agentId === agent.id);
  if (!grant) return check('failing', `${agent.name} is not added to this Channel.`);
  if (grant.status === 'pending') return check('warning', `${agent.name} is still joining this Channel.`);
  if (grant.status !== 'active') return check('failing', 'Chickpea cannot answer in this Channel until it is invited again.');
  const handle = snapshotAgent.slackPresence?.normalizedHandle;
  const others = inChannel.filter(({ agentId, status }) => agentId !== agent.id && status === 'active').length;
  const mention = others > 0
    ? `${others + 1} Agents answer here, so a message reaches it when it mentions ${handle ? `@${handle}` : 'it'}.`
    : `It is the only Agent here, so a message that mentions ${handle ? `@${handle}` : 'Chickpea'} reaches it.`;
  const membership = grant.channelIsPrivate === false ? ''
    : ' The Channel is private or Chickpea has not recorded which, so Slack decides when the message arrives whether this person is in it.';
  return check(grant.channelIsPrivate === false ? 'ok' : 'unknown', `${mention}${membership}`);
}
