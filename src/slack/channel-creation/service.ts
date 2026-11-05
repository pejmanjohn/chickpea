import type { WebClient } from '@slack/web-api';

import { isRecord } from '../../security/content-validation.ts';
import { slackPlatformErrorCode } from '../errors.ts';
import { renderSlackMessage } from '../message-format.ts';
import { isSlackRateLimitError } from '../read-budget.ts';
import { assertCurrentConversationNotShared, type SlackReadAuthorityPorts } from '../reading/authority.ts';
import { SlackReadError } from '../reading/errors.ts';
import {
  admitNamedPeople,
  refusedPeople,
  type NamedPeopleRefusal,
  type NamedPersonRefusal,
} from '../requested-conversations/people.ts';
import { slackWriteSurelyFailed, type RequestReceipt } from '../requested-conversations/receipts.ts';
import type { RequesterTextSource } from '../requester-text-source.ts';
import { SlackTransportError } from '../transport/types.ts';

type JsonObject = Record<string, unknown>;

export type ChannelVisibility = 'private' | 'public';

export interface ChannelRequest {
  name: string;
  visibility: ChannelVisibility;
  people: readonly string[];
  purpose?: string | undefined;
  message: string;
}

export const MAX_NAMED_INVITEES = 30;
export const MAX_CHANNEL_CREATE_ATTEMPTS = 3;
const SLACK_CHANNEL_NAME_LIMIT = 80;

export const SLACK_CHANNEL_CREATE_RECEIPT_PREFIX = 'slack_channel_create.v1:';

export type ChannelCreateReceipt =
  | { status: 'created'; channelId: string; visibility: ChannelVisibility }
  | { status: 'not_created'; attempts: number };

export const CHANNEL_CREATE_RECEIPT_CODEC = {
  parse(value: Record<string, unknown>): ChannelCreateReceipt | undefined {
    if (value.status === 'created' && typeof value.channelId === 'string' &&
        (value.visibility === 'private' || value.visibility === 'public')) {
      return { status: 'created', channelId: value.channelId, visibility: value.visibility };
    }
    if (value.status === 'not_created' && typeof value.attempts === 'number') {
      return { status: 'not_created', attempts: value.attempts };
    }
    return undefined;
  },
  retryable: (receipt: ChannelCreateReceipt) =>
    receipt.status === 'not_created' && receipt.attempts < MAX_CHANNEL_CREATE_ATTEMPTS,
};

export type ChannelCreateRefusalCode =
  | NamedPeopleRefusal
  | 'person_not_eligible'
  | 'shared_conversation'
  | 'agent_app'
  | 'not_workspace_wide'
  | 'public_after_web_content'
  | 'requester_unavailable'
  | 'agent_unavailable'
  | 'invalid_name'
  | 'name_taken'
  | 'restricted_action'
  | 'missing_scope'
  | 'too_many_attempts'
  | 'rate_limited'
  | 'unavailable';

export type ChannelAgentAccess =
  | { status: 'not_needed' }
  | { status: 'add_offered' }
  | { status: 'ask_owner' }
  | { status: 'add_in_admin'; adminUrl?: string | undefined };

const NOTHING_CREATED = 'Nothing was created.';

const REFUSALS: Record<Exclude<ChannelCreateRefusalCode, 'missing_scope' | 'restricted_action'>, string> = {
  requester_required: `Creating a channel needs a person's own request in Slack. ${NOTHING_CREATED}`,
  not_named: `Invite only people the requester @-mentioned in this request. Ask the requester to @-mention anyone else they want invited. ${NOTHING_CREATED}`,
  too_many: `A new channel can start with at most ${MAX_NAMED_INVITEES} people besides the requester. The requester can invite the rest once it exists. ${NOTHING_CREATED}`,
  person_not_eligible: `Only active members of this workspace can be invited. Guests, apps, bots, deactivated accounts and people from other organizations cannot; the requester can add a guest by hand once the channel exists. ${NOTHING_CREATED}`,
  shared_conversation: `Channels are not created from a conversation shared with another organization, so nothing from here is carried elsewhere. ${NOTHING_CREATED}`,
  agent_app: `This Agent answers as its own Slack app, which cannot create channels. ${NOTHING_CREATED}`,
  not_workspace_wide: `Only Agents everyone in this workspace can use create public channels. Ask the requester whether a private channel would do. ${NOTHING_CREATED}`,
  public_after_web_content: `Once a web page or search result has been read in this conversation, only private channels can be created. Ask the requester whether a private channel would do. ${NOTHING_CREATED}`,
  requester_unavailable: `The person asking no longer has active Chickpea access. ${NOTHING_CREATED}`,
  agent_unavailable: `This Agent is no longer available. ${NOTHING_CREATED}`,
  invalid_name: `Slack does not accept that channel name. Use lowercase letters, numbers, hyphens and underscores, at most ${SLACK_CHANNEL_NAME_LIMIT} characters. ${NOTHING_CREATED}`,
  name_taken: `A channel with that name already exists, or did and was archived. Choose another name. ${NOTHING_CREATED}`,
  too_many_attempts: `This request already tried to create a channel ${MAX_CHANNEL_CREATE_ATTEMPTS} times without success, so no more attempts are made. ${NOTHING_CREATED}`,
  rate_limited: 'Slack rate-limited this request. Nothing was created, and no automatic retry was made.',
  unavailable: `Slack could not create the channel right now. ${NOTHING_CREATED}`,
};

const MISSING_SCOPE_HOSTED =
  'Chickpea does not have permission to create channels in this workspace yet. A workspace Owner needs to update Chickpea\'s Slack permissions in Chickpea Admin. Ordinary chat can continue.';

const CREATE_UNCONFIRMED =
  'Slack did not confirm whether the channel was created, and nobody was invited. Do not try again in this request. If the requester asks again, use a different name.';

const OPENING_NOT_POSTED: Record<'not_posted' | 'unconfirmed', string> = {
  not_posted: 'Slack did not post the opening message.',
  unconfirmed: 'The opening message may have been posted, but Slack did not confirm it. Do not post it again.',
};

const REPLIES_REACH_YOU = 'Replies in the thread under your opening message reach you.';

const AGENT_ACCESS: Record<Exclude<ChannelAgentAccess['status'], 'not_needed'>, string> = {
  add_offered: 'You are not in this channel yet. The requester has a button there to add you; once they do, people there can work with you and replies in your message\'s thread reach you. Mentioning you there brings the button back.',
  ask_owner: 'You are not in this channel yet, and the requester cannot add you. A workspace Owner or Admin can add you there.',
  add_in_admin: 'You are not in this channel yet. The requester can add you to it in Chickpea Admin.',
};

const INVALID_NAME_ERRORS = new Set([
  'invalid_name', 'invalid_name_maxlength', 'invalid_name_punctuation', 'invalid_name_required', 'invalid_name_specials', 'no_channel',
]);

export type InviteRefusal = 'guest' | 'not_found' | 'not_allowed' | 'unconfirmed';

const INVITE_REFUSALS: Record<string, InviteRefusal> = {
  user_is_restricted: 'guest',
  ura_max_channels: 'guest',
  user_not_found: 'not_found',
};

const ALREADY_IN_CHANNEL = 'already_in_channel';

const SINGLE_INVITEE_ERRORS = new Set([
  ALREADY_IN_CHANNEL, ...Object.keys(INVITE_REFUSALS), 'cant_invite', 'cant_invite_self',
  'org_user_not_in_team', 'invitee_cant_see_channel', 'no_external_invite_permission',
]);

export class SlackChannelCreateRefusal extends Error {
  constructor(
    readonly code: ChannelCreateRefusalCode,
    readonly people?: readonly { id: string; reason: NamedPersonRefusal }[],
  ) {
    super(code);
    this.name = 'SlackChannelCreateRefusal';
  }
}

export interface SlackChannelCreateServiceOptions {
  workspaceId: string;
  requesterSlackUserId: string;
  requesterText: string | undefined;
  requesterTextSource: RequesterTextSource | undefined;
  webContentRead?: boolean;
  currentConversation: Pick<SlackReadAuthorityPorts, 'current' | 'conversation'>;
  chickpeaBot: {
    users: Pick<WebClient['users'], 'info'>;
    conversations: Pick<WebClient['conversations'], 'info' | 'create' | 'invite' | 'members' | 'setPurpose'>;
    chat: Pick<WebClient['chat'], 'postMessage'>;
  };
  persona: { username: string; icon_url?: string };
  assertStanding(visibility: ChannelVisibility): Promise<void>;
  receipt: Pick<RequestReceipt<ChannelCreateReceipt>, 'claim' | 'settle'>;
  routeRepliesToAgent(channelId: string, messageTs: string, text: string): Promise<void>;
  agentAccess(channel: { id: string; requesterInvited: boolean }): Promise<ChannelAgentAccess>;
  hosted?: boolean;
}

export class SlackChannelCreateService {
  constructor(private readonly options: SlackChannelCreateServiceOptions) {}

  async create(request: ChannelRequest): Promise<JsonObject> {
    try {
      return await this.createChannel(request);
    } catch (error) {
      return channelCreateFailure(error, request.visibility, this.options.hosted === true);
    }
  }

  private async createChannel(request: ChannelRequest): Promise<JsonObject> {
    const name = slackChannelName(request.name);
    if (name === undefined) throw new SlackChannelCreateRefusal('invalid_name');
    const admission = admitNamedPeople({
      requesterSlackUserId: this.options.requesterSlackUserId,
      requesterText: this.options.requesterText,
      requesterTextSource: this.options.requesterTextSource,
      people: request.people,
      maxOthers: MAX_NAMED_INVITEES,
    });
    if (!admission.ok) {
      throw new SlackChannelCreateRefusal(admission.code, admission.people?.map((id) => ({ id, reason: 'not_named' as const })));
    }
    if (request.visibility === 'public' && this.options.webContentRead) throw new SlackChannelCreateRefusal('public_after_web_content');
    await this.options.assertStanding(request.visibility);
    await assertCurrentConversationNotShared(this.options.currentConversation);
    const refused = await refusedPeople(this.options.chickpeaBot, this.options.workspaceId, admission.others, { guests: 'refused' });
    if (refused.length) throw new SlackChannelCreateRefusal('person_not_eligible', refused);

    const people = [admission.requester, ...admission.others];
    const claim = await this.options.receipt.claim();
    if (!claim.claimed) {
      if (claim.previous === 'pending') return { status: 'unverified', code: 'already_attempted', message: CREATE_UNCONFIRMED };
      if (claim.previous.status === 'not_created') throw new SlackChannelCreateRefusal('too_many_attempts');
      return this.reinviteIntoCreatedChannel(claim.previous, people);
    }
    const failedAttempts = claim.previous?.status === 'not_created' ? claim.previous.attempts : 0;
    let channelId: string;
    try {
      channelId = await this.createInSlack(name, request.visibility);
    } catch (error) {
      if (!slackWriteSurelyFailed(error)) {
        console.warn(JSON.stringify({ event: 'chickpea.channel_create.unconfirmed', workspaceId: this.options.workspaceId }));
        return { status: 'unverified', code: 'create_unconfirmed', message: CREATE_UNCONFIRMED };
      }
      await this.options.receipt.settle({ status: 'not_created', attempts: failedAttempts + 1 });
      throw error;
    }
    await this.options.receipt.settle({ status: 'created', channelId, visibility: request.visibility });

    const invites = await this.inviteRetryingWithoutRefused(channelId, people);
    const purposeSet = request.purpose ? await this.setPurpose(channelId, request.purpose) : true;
    const opening = await this.post(channelId, request.message);
    if (opening.status === 'posted') {
      await this.options.routeRepliesToAgent(channelId, opening.messageTs, request.message).catch(() => {
        console.warn(JSON.stringify({ event: 'chickpea.channel_create.replies_not_routed', workspaceId: this.options.workspaceId, channelId }));
      });
    }
    const access = await this.options.agentAccess({
      id: channelId,
      requesterInvited: invites.invited.includes(this.options.requesterSlackUserId),
    });
    return {
      status: 'created',
      channel: { id: channelId, name, visibility: request.visibility, link: channelLink(channelId) },
      invited: invites.invited,
      ...(invites.notInvited.length ? { notInvited: invites.notInvited } : {}),
      ...(purposeSet ? {} : { purpose: 'not_set' }),
      opening: opening.status === 'posted'
        ? { messageTs: opening.messageTs, link: messageLink(channelId, opening.messageTs) }
        : { status: opening.status, message: OPENING_NOT_POSTED[opening.status] },
      ...agentAccessFields(access, opening.status === 'posted'),
    };
  }

  private async createInSlack(name: string, visibility: ChannelVisibility): Promise<string> {
    const response = await this.options.chickpeaBot.conversations.create({ name, is_private: visibility === 'private' });
    const id = isRecord(response.channel) ? response.channel.id : undefined;
    if (typeof id !== 'string' || !/^[CG][A-Z0-9]+$/.test(id)) {
      throw new SlackTransportError('conversations.create', 'create_unconfirmed');
    }
    return id;
  }

  private async reinviteIntoCreatedChannel(
    previous: Extract<ChannelCreateReceipt, { status: 'created' }>,
    people: readonly string[],
  ): Promise<JsonObject> {
    const invites = await this.inviteRetryingWithoutRefused(previous.channelId, people);
    const requester = this.options.requesterSlackUserId;
    const requesterJustJoined = invites.invited.includes(requester) && !invites.alreadyIn.has(requester);
    const access = requesterJustJoined
      ? await this.options.agentAccess({ id: previous.channelId, requesterInvited: true })
      : undefined;
    return {
      status: 'already_created',
      channel: { id: previous.channelId, visibility: previous.visibility, link: channelLink(previous.channelId) },
      invited: invites.invited,
      ...(invites.notInvited.length ? { notInvited: invites.notInvited } : {}),
      ...(access ? agentAccessFields(access, false) : {}),
      message: 'This request already created this channel. Do not create another; point the requester to it.',
    };
  }

  private async inviteRetryingWithoutRefused(channelId: string, people: readonly string[]): Promise<{
    invited: string[];
    notInvited: { id: string; reason: InviteRefusal }[];
    alreadyIn: ReadonlySet<string>;
  }> {
    const alreadyIn = new Set<string>();
    const refusedByUser = new Map<string, InviteRefusal>();
    const outcome = (inChannel: (id: string) => boolean, unknownReason: InviteRefusal) => ({
      alreadyIn,
      invited: people.filter(inChannel),
      notInvited: people.filter((id) => !inChannel(id))
        .map((id) => ({ id, reason: refusedByUser.get(id) ?? unknownReason })),
    });
    let remaining = [...people];
    for (let attempt = 0; attempt < 2 && remaining.length; attempt++) {
      try {
        await this.options.chickpeaBot.conversations.invite({ channel: channelId, users: remaining.join(',') });
        const invited = new Set(remaining);
        return outcome((id) => alreadyIn.has(id) || invited.has(id), 'not_allowed');
      } catch (error) {
        const perUser = inviteErrorsByUser(error, remaining);
        if (!perUser.size) break;
        for (const [id, code] of perUser) {
          if (code === ALREADY_IN_CHANNEL) alreadyIn.add(id);
          else refusedByUser.set(id, INVITE_REFUSALS[code] ?? 'not_allowed');
        }
        remaining = remaining.filter((id) => !perUser.has(id));
      }
    }
    if (!remaining.length) return outcome((id) => alreadyIn.has(id), 'not_allowed');
    const members = await this.members(channelId);
    return members
      ? outcome((id) => members.has(id), 'not_allowed')
      : outcome((id) => alreadyIn.has(id), 'unconfirmed');
  }

  private async members(channelId: string): Promise<ReadonlySet<string> | undefined> {
    try {
      const response = await this.options.chickpeaBot.conversations.members({ channel: channelId, limit: 200 });
      return Array.isArray(response.members) ? new Set(response.members.filter((id): id is string => typeof id === 'string')) : undefined;
    } catch {
      return undefined;
    }
  }

  private async setPurpose(channelId: string, purpose: string): Promise<boolean> {
    return this.options.chickpeaBot.conversations.setPurpose({ channel: channelId, purpose }).then(() => true, () => false);
  }

  private async post(channelId: string, message: string): Promise<
    { status: 'posted'; messageTs: string } | { status: 'not_posted' | 'unconfirmed' }
  > {
    try {
      const response = await this.options.chickpeaBot.chat.postMessage({
        channel: channelId,
        ...renderSlackMessage(message, 'markdown'),
        ...this.options.persona,
        unfurl_links: false,
        unfurl_media: false,
      });
      if (typeof response.ts === 'string' && response.channel === channelId) return { status: 'posted', messageTs: response.ts };
      return { status: 'unconfirmed' };
    } catch (error) {
      return { status: slackWriteSurelyFailed(error) ? 'not_posted' : 'unconfirmed' };
    }
  }
}

export function slackChannelName(proposed: string): string | undefined {
  const tidy = (value: string) => value.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  const normalized = tidy(proposed.toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-'));
  return tidy([...normalized].slice(0, SLACK_CHANNEL_NAME_LIMIT).join('')) || undefined;
}

export function channelCreateFailure(error: unknown, visibility: ChannelVisibility, hosted: boolean): JsonObject {
  const refusal = asRefusal(error);
  return {
    status: 'refused',
    code: refusal.code,
    message: refusalMessage(refusal.code, visibility, hosted),
    ...(refusal.people?.length ? { people: refusal.people } : {}),
  };
}

function refusalMessage(code: ChannelCreateRefusalCode, visibility: ChannelVisibility, hosted: boolean): string {
  if (code === 'missing_scope') {
    if (hosted) return MISSING_SCOPE_HOSTED;
    const permission = visibility === 'private' ? 'private channels (groups:write)' : 'public channels (channels:manage)';
    return `This Slack installation needs the permission to create ${permission}. Its owner must update the app's scopes and reinstall through the existing Slack setup flow. Ordinary chat can continue.`;
  }
  if (code === 'restricted_action') {
    return `This workspace's Slack settings do not let Chickpea create ${visibility} channels. A Slack workspace admin can change who may create them. ${NOTHING_CREATED}`;
  }
  return REFUSALS[code];
}

function asRefusal(error: unknown): SlackChannelCreateRefusal {
  if (error instanceof SlackChannelCreateRefusal) return error;
  if (error instanceof SlackReadError) {
    return new SlackChannelCreateRefusal(error.code === 'shared_conversation_only' ? 'shared_conversation' : 'unavailable');
  }
  if (isSlackRateLimitError(error)) return new SlackChannelCreateRefusal('rate_limited');
  const code = slackPlatformErrorCode(error);
  if (code === 'missing_scope' || code === 'name_taken' || code === 'restricted_action') return new SlackChannelCreateRefusal(code);
  if (code && INVALID_NAME_ERRORS.has(code)) return new SlackChannelCreateRefusal('invalid_name');
  return new SlackChannelCreateRefusal('unavailable');
}

function agentAccessFields(access: ChannelAgentAccess, openingPosted: boolean): JsonObject {
  if (access.status === 'not_needed') return openingPosted ? { replies: REPLIES_REACH_YOU } : {};
  const adminUrl = access.status === 'add_in_admin' ? access.adminUrl : undefined;
  return { agentAccess: { status: access.status, message: AGENT_ACCESS[access.status], ...(adminUrl ? { adminUrl } : {}) } };
}

function inviteErrorsByUser(error: unknown, invited: readonly string[]): ReadonlyMap<string, string> {
  const data = isRecord(error) && isRecord(error.data) ? error.data : undefined;
  const errors = Array.isArray(data?.errors) ? data.errors : [];
  if (errors.length) {
    return new Map(errors.flatMap((entry) =>
      isRecord(entry) && typeof entry.user === 'string' && typeof entry.error === 'string' ? [[entry.user, entry.error] as const] : []));
  }
  const code = slackPlatformErrorCode(error);
  return invited.length === 1 && code && SINGLE_INVITEE_ERRORS.has(code) ? new Map([[invited[0]!, code]]) : new Map();
}

function channelLink(channelId: string): string {
  return `https://slack.com/archives/${channelId}`;
}

function messageLink(channelId: string, messageTs: string): string {
  return `${channelLink(channelId)}/p${messageTs.replace('.', '')}`;
}
