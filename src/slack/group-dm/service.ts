import type { WebClient } from '@slack/web-api';

import type { ConfigStore } from '../../config/store.ts';
import { isRecord } from '../../security/content-validation.ts';
import { slackPlatformErrorCode } from '../errors.ts';
import { renderSlackMessage } from '../message-format.ts';
import { recordDeliveredSlackAgentMessage } from '../public-context.ts';
import { isSlackRateLimitError } from '../read-budget.ts';
import { assertCurrentConversationNotShared, type SlackReadAuthorityPorts } from '../reading/authority.ts';
import { SlackReadError } from '../reading/errors.ts';
import { slackUserKind } from '../reading/service.ts';
import { SlackTransportError } from '../transport/types.ts';
import { admitGroupDmPeople, MAX_GROUP_DM_PEOPLE, type GroupDmAdmissionRefusal } from './admission.ts';
import type { GroupDmReceipt, GroupDmReceipts } from './receipts.ts';

type JsonObject = Record<string, unknown>;

export type GroupDmRefusalCode =
  | GroupDmAdmissionRefusal
  | 'person_not_eligible'
  | 'shared_conversation'
  | 'agent_app'
  | 'not_in_group_dms'
  | 'requester_unavailable'
  | 'agent_unavailable'
  | 'missing_scope'
  | 'rate_limited'
  | 'unavailable';

export type GroupDmPersonRefusal = 'not_named' | 'bot' | 'deactivated' | 'outside_workspace' | 'not_found';

const NOTHING_OPENED = 'Nothing was opened or posted.';

const REFUSALS: Record<Exclude<GroupDmRefusalCode, 'missing_scope'>, string> = {
  requester_required: `Starting a group DM needs a person's own request in Slack that @-mentions who to add. ${NOTHING_OPENED}`,
  not_named: `Add only people the requester @-mentioned in this request. Ask the requester to @-mention anyone else they want added. ${NOTHING_OPENED}`,
  too_few: `A group DM needs at least one person besides the requester. ${NOTHING_OPENED}`,
  too_many: `A group DM holds at most ${MAX_GROUP_DM_PEOPLE} people, the requester included. ${NOTHING_OPENED}`,
  person_not_eligible: `Only active people in this workspace can be added. Apps, bots, deactivated accounts and people from other organizations cannot. ${NOTHING_OPENED}`,
  shared_conversation: `In a conversation shared with another organization, I do not start group DMs, so nothing from here is carried elsewhere. ${NOTHING_OPENED}`,
  agent_app: `This Agent answers as its own Slack app, which cannot start group DMs. ${NOTHING_OPENED}`,
  not_in_group_dms: `Only Agents everyone in this workspace can use work in group DMs, so this Agent cannot start one. ${NOTHING_OPENED}`,
  requester_unavailable: `The person asking no longer has active Chickpea access. ${NOTHING_OPENED}`,
  agent_unavailable: `This Agent is no longer available. ${NOTHING_OPENED}`,
  rate_limited: 'Slack rate-limited this request. Nothing was posted, and no automatic retry was made.',
  unavailable: 'Slack could not start the group DM right now. Nothing was posted.',
};

const MISSING_SCOPE_HOSTED =
  'Chickpea does not have permission to start group DMs in this workspace yet. A workspace Owner needs to update Chickpea\'s Slack permissions in Chickpea Admin. Ordinary chat can continue.';
const MISSING_SCOPE_STANDALONE =
  'This Slack installation needs the permission to start group DMs (mpim:write). Its owner must update the app\'s scopes and reinstall through the existing Slack setup flow. Ordinary chat can continue.';

const MAY_HAVE_POSTED =
  'The opening message may have been posted, but Slack did not confirm it. Do not try again; tell the requester to check their group DMs.';

const UNCERTAIN_POST_ERRORS = new Set(['internal_error', 'fatal_error', 'request_timeout', 'service_unavailable']);

export class SlackGroupDmRefusal extends Error {
  constructor(
    readonly code: GroupDmRefusalCode,
    readonly people?: readonly { id: string; reason: GroupDmPersonRefusal }[],
  ) {
    super(code);
    this.name = 'SlackGroupDmRefusal';
  }
}

export interface SlackGroupDmServiceOptions {
  workspaceId: string;
  requesterSlackUserId: string;
  requestText: string | undefined;
  currentConversation: Pick<SlackReadAuthorityPorts, 'current' | 'conversation'>;
  chickpeaBot: Pick<WebClient, 'users' | 'conversations' | 'chat'>;
  persona: { username: string; icon_url?: string };
  assertStanding(): Promise<void>;
  receipts: Pick<GroupDmReceipts, 'claim' | 'settle'>;
  routeRepliesToAgent(channelId: string, messageTs: string, text: string): Promise<void>;
  hosted?: boolean;
}

export class SlackGroupDmService {
  constructor(private readonly options: SlackGroupDmServiceOptions) {}

  async start(people: readonly string[], message: string): Promise<JsonObject> {
    try {
      return await this.startGroupDm(people, message);
    } catch (error) {
      return groupDmFailure(error, this.options.hosted === true);
    }
  }

  private async startGroupDm(requested: readonly string[], message: string): Promise<JsonObject> {
    const admission = admitGroupDmPeople({
      requesterSlackUserId: this.options.requesterSlackUserId,
      requestText: this.options.requestText,
      people: requested,
    });
    if (!admission.ok) {
      throw new SlackGroupDmRefusal(admission.code, admission.people?.map((id) => ({ id, reason: 'not_named' as const })));
    }
    await this.options.assertStanding();
    await assertCurrentConversationNotShared(this.options.currentConversation);
    const { people } = admission;
    await this.assertPeopleEligible(people.slice(1));

    const previous = await this.options.receipts.claim();
    if (previous) return alreadyStarted(previous);
    let channelId: string;
    try {
      channelId = await this.open(people);
    } catch (error) {
      await this.options.receipts.settle({ status: 'not_posted' });
      throw error;
    }
    let messageTs: string;
    try {
      messageTs = await this.post(channelId, message);
    } catch (error) {
      if (!postSurelyFailed(error)) {
        return { status: 'unverified', code: 'post_unconfirmed', message: MAY_HAVE_POSTED };
      }
      await this.options.receipts.settle({ status: 'not_posted' });
      throw error;
    }
    await this.options.receipts.settle({ status: 'posted', channelId, messageTs, people });
    const routed = await this.options.routeRepliesToAgent(channelId, messageTs, message).then(() => true, () => {
      console.warn(JSON.stringify({ event: 'chickpea.group_dm.replies_not_routed', workspaceId: this.options.workspaceId, channelId }));
      return false;
    });
    return {
      status: 'posted',
      groupDm: startedGroupDm(channelId, messageTs, people),
      ...(routed ? { replies: 'Replies in the thread under this message reach you.' } : {}),
    };
  }

  private async assertPeopleEligible(people: readonly string[]): Promise<void> {
    const refused = (await Promise.all(people.map(async (id) => {
      const reason = await this.personRefusal(id);
      return reason ? [{ id, reason }] : [];
    }))).flat();
    if (refused.length) throw new SlackGroupDmRefusal('person_not_eligible', refused);
  }

  private async personRefusal(id: string): Promise<GroupDmPersonRefusal | undefined> {
    let user: unknown;
    try {
      user = (await this.options.chickpeaBot.users.info({ user: id })).user;
    } catch (error) {
      if (slackPlatformErrorCode(error) === 'user_not_found') return 'not_found';
      throw error;
    }
    if (!isRecord(user) || user.id !== id) return 'not_found';
    const kind = slackUserKind(user, this.options.workspaceId);
    // enterprise_user marks any Enterprise Grid user, another organization's too.
    if (kind === 'external' || user.team_id !== this.options.workspaceId) return 'outside_workspace';
    if (kind === 'app') return 'bot';
    if (kind === 'deactivated') return 'deactivated';
    return undefined;
  }

  private async open(people: readonly string[]): Promise<string> {
    const response = await this.options.chickpeaBot.conversations.open({ users: people.join(',') });
    const id = isRecord(response.channel) ? response.channel.id : undefined;
    if (typeof id !== 'string' || !/^[CG][A-Z0-9]+$/.test(id)) throw new SlackGroupDmRefusal('unavailable');
    return id;
  }

  private async post(channelId: string, message: string): Promise<string> {
    const response = await this.options.chickpeaBot.chat.postMessage({
      channel: channelId,
      ...renderSlackMessage(message, 'markdown'),
      ...this.options.persona,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (typeof response.ts !== 'string' || response.channel !== channelId) {
      throw new SlackTransportError('chat.postMessage', 'post_unconfirmed');
    }
    return response.ts;
  }
}

export async function routeGroupDmRepliesToAgent(
  config: Pick<ConfigStore, 'putAgentThreadRoute' | 'putSlackPublicContext' | 'getWorkspaceInstallation'>,
  input: {
    workspaceId: string;
    channelId: string;
    messageTs: string;
    text: string;
    agent: { id: string; revision: number; configurationGeneration?: number | undefined };
  },
): Promise<void> {
  const { workspaceId, channelId, messageTs, agent } = input;
  await config.putAgentThreadRoute({
    workspaceId,
    channelId,
    threadTs: messageTs,
    agentId: agent.id,
    agentGeneration: agent.configurationGeneration ?? agent.revision,
    ownerIncarnation: 1,
  }, 0);
  const installation = await config.getWorkspaceInstallation(workspaceId);
  if (!installation) return;
  await recordDeliveredSlackAgentMessage(
    config,
    { workspaceId, channelId, threadTs: messageTs },
    { runtimeContract: installation.runtimeContract, agentId: agent.id },
    { messageTs, text: input.text },
  );
}

export function groupDmFailure(error: unknown, hosted: boolean): JsonObject {
  const refusal = asRefusal(error);
  return {
    status: 'refused',
    code: refusal.code,
    message: refusal.code === 'missing_scope'
      ? hosted ? MISSING_SCOPE_HOSTED : MISSING_SCOPE_STANDALONE
      : REFUSALS[refusal.code],
    ...(refusal.people?.length ? { people: refusal.people } : {}),
  };
}

function asRefusal(error: unknown): SlackGroupDmRefusal {
  if (error instanceof SlackGroupDmRefusal) return error;
  if (error instanceof SlackReadError) {
    return new SlackGroupDmRefusal(error.code === 'shared_conversation_only' ? 'shared_conversation' : 'unavailable');
  }
  if (isSlackRateLimitError(error)) return new SlackGroupDmRefusal('rate_limited');
  return new SlackGroupDmRefusal(slackPlatformErrorCode(error) === 'missing_scope' ? 'missing_scope' : 'unavailable');
}

function postSurelyFailed(error: unknown): boolean {
  if (error instanceof SlackTransportError) return error.effectOutcome === 'failed';
  if (isSlackRateLimitError(error)) return true;
  const code = slackPlatformErrorCode(error);
  return code !== undefined && !UNCERTAIN_POST_ERRORS.has(code);
}

function alreadyStarted(previous: Exclude<GroupDmReceipt, { status: 'not_posted' }>): JsonObject {
  if (previous.status === 'pending') return { status: 'unverified', code: 'already_attempted', message: MAY_HAVE_POSTED };
  return {
    status: 'already_started',
    groupDm: startedGroupDm(previous.channelId, previous.messageTs, previous.people),
    message: 'This request already started this group DM. Do not start another; point the requester to this one.',
  };
}

function startedGroupDm(channelId: string, messageTs: string, people: readonly string[]): JsonObject {
  return {
    channelId,
    people,
    messageTs,
    link: `https://slack.com/archives/${channelId}/p${messageTs.replace('.', '')}`,
  };
}
