import type { WebClient } from '@slack/web-api';
import { isRecord } from '../../security/content-validation.ts';
import { slackPlatformErrorCode } from '../errors.ts';
import { SlackListError } from '../lists/types.ts';
import type { ListWriteLedger, ListWriteReceipt, SlackWriteOperation } from '../lists/writes.ts';
import {
  assertCurrentConversationNotShared,
  authorizeSlackRead,
  type AuthorizedSlackConversation,
  type SlackReadAuthorityPorts,
} from '../reading/authority.ts';
import { SlackReadError } from '../reading/errors.ts';
import { resolveSlackReadTarget } from '../reading/links.ts';
import { byteLength, MAX_SLACK_READ_RESULT_BYTES, SLACK_READ_NOTICE } from '../reading/service.ts';
import { SlackTransportError } from '../transport/types.ts';
import { SLACK_CHANNEL_ID } from '../ui/text.ts';
import { CANVAS_ID, SlackCanvasError, type JsonObject, type SlackCanvasesCall, type SlackCanvasOperation } from './types.ts';
import { parseSlackCanvasUrl, verifiedCanvasPermalink } from './urls.ts';

export function createSlackCanvasesCall(client: Pick<WebClient, 'apiCall'>): SlackCanvasesCall {
  return async (method, input) => {
    const result: unknown = await client.apiCall(method, input);
    if (!isRecord(result)) throw new SlackCanvasError('invalid_response', 'Slack returned an unexpected canvas response.');
    return result;
  };
}

const CANVAS_PAGE_BYTES = MAX_SLACK_READ_RESULT_BYTES - 8 * 1024;
const MAX_CANVAS_CONVERSATIONS = 8;

export const CANVAS_MISSING_OR_UNREADABLE = 'That canvas is not available to read here. It may not exist, or it is not in a channel that both the requester and this Agent can read.';
const NOT_FOUND = new Set(['file_not_found', 'file_deleted', 'canvas_not_found', 'canvas_deleted', 'access_denied']);

// Documented answers that cannot have changed a canvas. Others stay uncertain:
// Slack allows partial effects for internal_error and fatal_error, and a
// canvas or tab may exist after canvas_tab_creation_failed.
const DEFINITE_FAILURES = new Set([
  'access_denied', 'accesslimited', 'account_inactive', 'canvas_creation_failed', 'canvas_deleted',
  'canvas_disabled_user_team', 'canvas_editing_failed', 'canvas_editing_locked', 'canvas_not_found',
  'canvas_too_large', 'channel_canvas_already_exists', 'channel_not_found', 'deprecated_endpoint',
  'ekm_access_denied', 'enterprise_is_restricted', 'free_team_canvas_tab_already_exists',
  'free_teams_cannot_create_standalone_canvases', 'free_teams_cannot_edit_standalone_canvases',
  'invalid_arg_name', 'invalid_arguments', 'invalid_array_arg', 'invalid_auth', 'invalid_charset',
  'invalid_form_data', 'invalid_post_type', 'method_deprecated', 'missing_post_type', 'missing_scope',
  'no_permission', 'not_allowed_token_type', 'not_authed', 'not_in_channel', 'posting_to_channel_denied',
  'restricted_action', 'team_access_not_granted', 'team_tier_cannot_create_channel_canvases',
  'token_expired', 'token_revoked', 'two_factor_setup_required', 'use_skills_api',
  'operation_not_allowed', 'unknown_operation', 'unsupported_operation', 'gateway_http_404',
  'gateway_request_too_large', 'ratelimited', 'cancelled_before_call',
]);

interface CanvasFile {
  title?: string;
  link?: string;
  ownerId?: string;
  conversationIds: string[];
  /** Slack Connect workspaces that can read the canvas, counted apart from those the bot shares a conversation with. */
  externalWorkspaces: { visible: number; hidden: number };
}

export interface SlackCanvasServiceOptions {
  workspaceId: string;
  botUserId: string;
  call: SlackCanvasesCall;
  authority: SlackReadAuthorityPorts;
  ledger: ListWriteLedger;
  signal?: AbortSignal | undefined;
  hosted?: boolean | undefined;
}

export class SlackCanvasService {
  constructor(private readonly options: SlackCanvasServiceOptions) {}

  get hosted(): boolean {
    return this.options.hosted === true;
  }

  async read(input: { canvasUrl?: string | undefined; channel?: string | undefined; offset?: number | undefined }): Promise<JsonObject> {
    const offset = input.offset ?? 0;
    const { canvasId, conversation, file } = await this.readable(input);
    const content = await this.content(canvasId);
    if (offset > 0 && offset >= content.length) {
      throw new SlackCanvasError('invalid_offset', 'That offset is past the end of the canvas. Read again from the start.');
    }
    const end = pageEnd(content, offset);
    return {
      status: 'read',
      canvas: { id: canvasId, ...(file?.title ? { title: file.title } : {}), ...(file?.link ? { link: file.link } : {}) },
      conversation,
      content: content.slice(offset, end),
      offset,
      ...(end < content.length ? { nextOffset: end } : {}),
      totalCharacters: content.length,
      notice: SLACK_READ_NOTICE,
    };
  }

  async create(toolCallId: string, title: string, markdown: string): Promise<JsonObject> {
    const ports = this.options.authority;
    await authorizeSlackRead(ports, ports.current.channelId);
    const facts = await ports.conversation(ports.current.channelId);
    if (!facts) throw new SlackCanvasError('channel_unavailable', CHANNEL_UNAVAILABLE);
    if (facts.im || facts.mpim) {
      throw new SlackCanvasError('channel_only', 'A canvas can be created only in a channel, not in a direct message or group DM. Nothing was created.');
    }
    const input = { channel_id: facts.id, title, document_content: { type: 'markdown', markdown } };
    let placement: 'channel_canvas' | 'channel_tab' = facts.canvasId ? 'channel_tab' : 'channel_canvas';
    return this.mutate(toolCallId, 'canvases.create', input, async () => {
      if (placement === 'channel_tab') return this.call('canvases.create', input);
      try {
        return await this.call('conversations.canvases.create', input);
      } catch (error) {
        if (errorCode(error) !== 'channel_canvas_already_exists') throw error;
        // canvases.create with channel_id gives the channel write access in
        // the same call; canvases.access.set needs the link shared first.
        placement = 'channel_tab';
        return this.call('canvases.create', input);
      }
    }, async (response) => {
      const canvasId = response.canvas_id;
      if (typeof canvasId !== 'string' || !CANVAS_ID.test(canvasId)) {
        throw new SlackCanvasError('invalid_response', 'Slack did not return the new canvas ID.');
      }
      const link = (await this.file(canvasId).catch(() => undefined))?.link;
      return {
        status: 'created',
        canvas: { id: canvasId, title, ...(link ? { link } : {}) },
        placement,
        message: !link
          ? 'Slack created the canvas but did not return its link. Do not create it again; people in this channel can open it from the channel header.'
          : placement === 'channel_canvas'
            ? 'Created this channel\'s canvas. People in the channel can view and edit it.'
            : 'Created a canvas and added it to this channel, where its members can view and edit it.',
      };
    });
  }

  async update(toolCallId: string, input: {
    canvasUrl?: string | undefined;
    operation: 'append' | 'replace_section';
    markdown: string;
    sectionText?: string | undefined;
  }): Promise<JsonObject> {
    if (input.operation === 'append' && input.sectionText !== undefined) {
      throw new SlackCanvasError('invalid_section', 'sectionText applies only to replace_section. To add to the end of the canvas, leave it out.');
    }
    if (input.operation === 'replace_section' && !input.sectionText) {
      throw new SlackCanvasError('invalid_section', 'Pass sectionText: words that appear only in the section to replace.');
    }
    const target = await this.editable(input.canvasUrl);
    const document_content = { type: 'markdown', markdown: input.markdown };
    let change: JsonObject = { operation: 'insert_at_end', document_content };
    if (input.operation === 'replace_section') {
      const response = await this.call('canvases.sections.lookup', { canvas_id: target.canvasId, criteria: { contains_text: input.sectionText } });
      const ids = Array.isArray(response.sections)
        ? response.sections.flatMap((section) => isRecord(section) && typeof section.id === 'string' && section.id.length <= 256 ? [section.id] : [])
        : [];
      if (ids.length === 0) {
        throw new SlackCanvasError('section_not_found', 'No section of the canvas contains that text. Nothing was changed. Read the canvas and use words from the section to replace.');
      }
      if (ids.length > 1) {
        throw new SlackCanvasError('section_ambiguous', `${ids.length} sections contain that text. Nothing was changed. Use words that appear only in the section to replace.`);
      }
      change = { operation: 'replace', section_id: ids[0], document_content };
    }
    const edit = { canvas_id: target.canvasId, changes: [change] };
    return this.mutate(toolCallId, 'canvases.edit', edit, () => this.call('canvases.edit', edit), async () => ({
      status: 'updated',
      verification: 'slack_acknowledged',
      canvas: { id: target.canvasId, ...(target.link ? { link: target.link } : {}) },
      operation: input.operation,
      message: 'Slack accepted this change. Read the canvas to see the result.',
    }));
  }

  private async readable(input: { canvasUrl?: string | undefined; channel?: string | undefined }): Promise<{
    canvasId: string;
    conversation: AuthorizedSlackConversation;
    file?: CanvasFile;
  }> {
    const ports = this.options.authority;
    if (input.canvasUrl !== undefined && input.channel !== undefined) {
      throw new SlackCanvasError('invalid_target', 'Pass a canvas link or a channel, not both.');
    }
    if (input.canvasUrl === undefined) {
      const channelId = input.channel === undefined ? ports.current.channelId : channelTarget(input.channel);
      const conversation = await authorizeSlackRead(ports, channelId);
      const canvasId = (await ports.conversation(channelId))?.canvasId;
      if (!canvasId) {
        throw new SlackCanvasError('no_canvas', conversation.current ? 'This conversation has no canvas.' : 'That channel has no canvas.');
      }
      return { canvasId, conversation };
    }
    const canvasId = parseSlackCanvasUrl(input.canvasUrl, this.options.workspaceId);
    const current = await this.currentCanvas();
    if (current.canvasId === canvasId) return { canvasId, conversation: current.conversation };
    return { canvasId, ...await this.reachable(canvasId) };
  }

  private async editable(canvasUrl: string | undefined): Promise<{ canvasId: string; link?: string }> {
    const current = await this.currentCanvas();
    const canvasId = canvasUrl === undefined ? current.canvasId : parseSlackCanvasUrl(canvasUrl, this.options.workspaceId);
    if (!canvasId) {
      throw new SlackCanvasError('no_canvas', 'This conversation has no canvas. Pass the link of a canvas Chickpea created, or create one.');
    }
    const own = canvasId === current.canvasId;
    const { file } = own ? { file: await this.file(canvasId) } : await this.reachable(canvasId, SHARED_OUTSIDE);
    if (!own && file.ownerId !== this.options.botUserId) {
      throw new SlackCanvasError('not_editable', 'Only this conversation\'s canvas and canvases Chickpea created can be edited. Nothing was changed.');
    }
    await this.assertNotSharedOutside(file);
    return { canvasId, ...(file.link ? { link: file.link } : {}) };
  }

  /**
   * A canvas whose conversations the requester may read with this Agent.
   * Rules 3 and 4 refuse before any Slack lookup, so their refusal never
   * shows whether a canvas exists.
   */
  private async reachable(canvasId: string, sharedMessage?: string): Promise<{ file: CanvasFile; conversation: AuthorizedSlackConversation }> {
    const ports = this.options.authority;
    if (ports.managementAgent) throw new SlackReadError('current_conversation_only');
    await assertCurrentConversationNotShared(ports, sharedMessage);
    const file = await this.file(canvasId);
    return { file, conversation: await authorizeCanvasHome(ports, file.conversationIds) };
  }

  /**
   * An edit lands wherever the canvas is, so it must not carry content to an
   * organization that cannot read the current conversation: rule 4 of
   * authorizeSlackRead for writes. In a shared conversation, the canvas must
   * be its own and in no other conversation, so any external reader is that
   * conversation's.
   */
  private async assertNotSharedOutside(file: CanvasFile): Promise<void> {
    const ports = this.options.authority;
    const current = await ports.conversation(ports.current.channelId);
    const others = file.conversationIds.filter((id) => id !== ports.current.channelId);
    if (others.length > MAX_CANVAS_CONVERSATIONS) {
      throw new SlackCanvasError('too_widely_shared', 'This canvas is in too many conversations to check who can see it, so it cannot be edited. Nothing was changed.');
    }
    let outside = !current || file.externalWorkspaces.hidden > 0 ||
      (current.shared ? others.length > 0 : file.externalWorkspaces.visible > 0);
    for (const id of outside ? [] : others) {
      const facts = await ports.conversation(id);
      outside ||= !facts || facts.shared || (facts.teamId !== undefined && facts.teamId !== ports.workspaceId);
    }
    if (outside) throw new SlackCanvasError('shared_outside', SHARED_OUTSIDE);
  }

  private async currentCanvas(): Promise<{ conversation: AuthorizedSlackConversation; canvasId?: string }> {
    const ports = this.options.authority;
    const conversation = await authorizeSlackRead(ports, ports.current.channelId);
    const canvasId = (await ports.conversation(ports.current.channelId))?.canvasId;
    return { conversation, ...(canvasId ? { canvasId } : {}) };
  }

  private async file(canvasId: string): Promise<CanvasFile> {
    let response: JsonObject;
    try {
      response = await this.call('files.info', { file: canvasId });
    } catch (error) {
      throw notAvailable(error);
    }
    const file = canvasFile(response.file, this.options.workspaceId, canvasId);
    if (!file) throw new SlackReadError('not_available', CANVAS_MISSING_OR_UNREADABLE);
    return file;
  }

  private async content(canvasId: string): Promise<string> {
    let response: JsonObject;
    try {
      response = await this.call('canvases.getContent', { canvas_id: canvasId, content_type: 'markdown' });
    } catch (error) {
      throw notAvailable(error);
    }
    if (typeof response.content !== 'string') throw new SlackCanvasError('invalid_response', 'Slack returned an unexpected canvas response.');
    return response.content;
  }

  private async mutate(
    toolCallId: string,
    operation: SlackWriteOperation,
    input: JsonObject,
    write: () => Promise<JsonObject>,
    present: (response: JsonObject) => Promise<JsonObject>,
  ): Promise<JsonObject> {
    const reservation = await this.options.ledger.reserve(toolCallId, operation, input);
    if (!reservation.reserved) return previousWrite(reservation.receipt);
    let acknowledged = false;
    try {
      const response = await write();
      acknowledged = true;
      const result = await present(response);
      await this.options.ledger.finish(reservation.receipt, 'confirmed');
      return result;
    } catch (error) {
      const code = errorCode(error);
      const failed = !acknowledged &&
        (DEFINITE_FAILURES.has(code) || (error instanceof SlackTransportError && error.effectOutcome === 'failed'));
      await this.options.ledger.settle(reservation.receipt, failed ? 'failed' : 'unknown');
      return failed
        ? canvasToolFailure(error, 'not_written', this.hosted)
        : { status: 'unverified', code, message: 'This canvas change may have taken effect, but could not be verified. Do not repeat it. Read the canvas to check.' };
    }
  }

  private async call(method: SlackCanvasOperation, input: JsonObject): Promise<JsonObject> {
    if (this.options.signal?.aborted) throw new SlackCanvasError('cancelled_before_call', 'The tool was cancelled before its next Slack call.');
    const result = await this.options.call(method, input);
    if (result.ok === true) return result;
    if (result.ok === false && typeof result.error === 'string' && /^[a-z0-9_]{1,100}$/.test(result.error)) {
      throw new SlackCanvasError(result.error, explainError(result.error, this.hosted), slackDetail(result));
    }
    throw new SlackCanvasError('invalid_response', 'Slack returned an unexpected canvas response.');
  }
}

async function authorizeCanvasHome(ports: SlackReadAuthorityPorts, conversationIds: readonly string[]): Promise<AuthorizedSlackConversation> {
  if (conversationIds.includes(ports.current.channelId)) return authorizeSlackRead(ports, ports.current.channelId);
  let refusal = new SlackReadError('not_available', CANVAS_MISSING_OR_UNREADABLE);
  for (const id of conversationIds.slice(0, MAX_CANVAS_CONVERSATIONS)) {
    try {
      return await authorizeSlackRead(ports, id);
    } catch (error) {
      if (!(error instanceof SlackReadError)) throw error;
      if (error.code === 'needs_agent_access' || error.code === 'needs_bot_invite') refusal = error;
      else if (error.code !== 'not_available') throw error;
    }
  }
  throw refusal;
}

function canvasFile(raw: unknown, workspaceId: string, canvasId: string): CanvasFile | undefined {
  if (!isRecord(raw) || raw.id !== canvasId) return undefined;
  const ids = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && SLACK_CHANNEL_ID.test(id))
    : [];
  const linked = typeof raw.linked_channel_id === 'string' && SLACK_CHANNEL_ID.test(raw.linked_channel_id) ? [raw.linked_channel_id] : [];
  const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 255) : '';
  const visible = Array.isArray(raw.external_workspaces_with_read_access) ? raw.external_workspaces_with_read_access.length : 0;
  const hidden = typeof raw.private_external_workspaces_with_read_access_count === 'number' ? raw.private_external_workspaces_with_read_access_count : 0;
  const link = verifiedCanvasPermalink(raw.permalink, workspaceId, canvasId);
  return {
    ...(title ? { title } : {}),
    ...(link ? { link } : {}),
    ...(typeof raw.user === 'string' ? { ownerId: raw.user } : {}),
    conversationIds: [...new Set([...linked, ...ids(raw.channels), ...ids(raw.groups), ...ids(raw.ims)])],
    externalWorkspaces: { visible, hidden },
  };
}

function pageEnd(content: string, offset: number): number {
  let end = Math.min(content.length, offset + CANVAS_PAGE_BYTES);
  while (end > offset + 1 && byteLength(content.slice(offset, end)) > CANVAS_PAGE_BYTES) {
    end = offset + Math.floor((end - offset) * 0.9);
  }
  if (end >= content.length) return content.length;
  const newline = content.lastIndexOf('\n', end - 1);
  if (newline >= offset + (end - offset) / 2) return newline + 1;
  return isHighSurrogate(content.charCodeAt(end - 1)) ? end - 1 : end;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function channelTarget(value: string): string {
  const target = /^<?https:/.test(value.trim()) ? resolveSlackReadTarget({ link: value }) : resolveSlackReadTarget({ channel: value });
  if (target.ts) throw new SlackCanvasError('invalid_target', 'Pass a channel, not a message.');
  return target.channelId;
}

function notAvailable(error: unknown): unknown {
  return NOT_FOUND.has(errorCode(error)) ? new SlackReadError('not_available', CANVAS_MISSING_OR_UNREADABLE) : error;
}

const SHARED_OUTSIDE = 'This canvas may be visible to another organization, so it can be edited only as the canvas of the current conversation, from a conversation that is not shared with another organization. Nothing was changed.';
const CHANNEL_UNAVAILABLE = 'The Chickpea app cannot see this conversation, so it cannot add a canvas here. Someone in the channel can invite the app. Nothing was created.';

export function canvasToolFailure(error: unknown, status: 'not_read' | 'not_written', hosted = false): JsonObject {
  if (error instanceof SlackReadError) return { status, code: error.code, message: error.message };
  const code = errorCode(error);
  const detail = error instanceof SlackCanvasError ? error.detail : slackDetail(error);
  return {
    status,
    code,
    message: error instanceof SlackCanvasError || error instanceof SlackListError ? error.message : explainError(code, hosted),
    ...(detail ? { detail } : {}),
  };
}

function previousWrite(receipt: ListWriteReceipt): JsonObject {
  return {
    status: 'already_attempted',
    previousStatus: receipt.status,
    message: receipt.status === 'confirmed'
      ? 'This change was already made in this request. Do not repeat it; read the canvas if needed.'
      : 'An earlier write in this request is unresolved. Do not send another write. Read the canvas to check it.',
  };
}

function errorCode(error: unknown): string {
  if (error instanceof SlackCanvasError || error instanceof SlackListError) return error.code;
  const platform = slackPlatformErrorCode(error);
  if (platform && /^[a-z0-9_]{1,100}$/.test(platform)) return platform;
  if (isRecord(error) && error.code === 'slack_webapi_rate_limited_error') return 'ratelimited';
  if (error instanceof SlackTransportError && error.effectOutcome === 'failed') return 'transport_rejected';
  return 'unknown_response';
}

function slackDetail(source: unknown): string | undefined {
  const data = isRecord(source) && isRecord(source.data) ? source.data : source;
  return isRecord(data) && typeof data.detail === 'string' && data.detail ? data.detail.slice(0, 500) : undefined;
}

function explainError(code: string, hosted: boolean): string {
  if (code === 'missing_scope' && hosted) return 'This workspace has not given Chickpea the Slack canvas permissions yet. A Chickpea Owner can update them in Chickpea Admin. Ordinary chat can continue.';
  if (code === 'missing_scope') return 'This Slack installation needs the canvas read/write permissions. Its owner must update the app scopes and reinstall through the existing Slack setup flow. Ordinary chat can continue.';
  if (['operation_not_allowed', 'unknown_operation', 'unsupported_operation', 'gateway_http_404'].includes(code)) return 'This shared gateway does not support Slack canvases yet. Its operator must upgrade the gateway before canvas tools can work.';
  if (code === 'canvas_disabled_user_team') return 'Canvases are turned off in this Slack workspace. Nothing was changed.';
  if (code === 'free_team_canvas_tab_already_exists' || code === 'free_teams_cannot_create_standalone_canvases') return 'On this Slack workspace\'s free plan, a channel can have only one canvas, and this channel already has one. Nothing was created. Offer to add to the channel\'s canvas instead.';
  if (code === 'free_teams_cannot_edit_standalone_canvases') return 'On this Slack workspace\'s free plan, only a channel\'s own canvas can be edited. Nothing was changed.';
  if (code === 'team_tier_cannot_create_channel_canvases') return 'This Slack workspace\'s plan cannot add canvases to channels. Nothing was created.';
  if (code === 'channel_not_found' || code === 'not_in_channel') return CHANNEL_UNAVAILABLE;
  if (NOT_FOUND.has(code) || code === 'no_permission' || code === 'restricted_action') return 'Chickpea cannot open or edit this canvas. Nothing was changed; no access was changed either.';
  if (code === 'canvas_editing_locked') return 'Someone else is changing this canvas right now. Nothing was changed.';
  if (code === 'canvas_too_large') return 'The canvas or this change is too large for Slack. Nothing was changed.';
  if (code === 'canvas_creation_failed' || code === 'canvas_editing_failed') return 'Slack could not use this Markdown. Nothing was changed. Canvases support headings up to ###, lists, checklists, tables, quotes, code and links; see detail.';
  if (code === 'ratelimited') return 'Slack rate-limited this canvas operation. No automatic retry was made.';
  return `Slack could not complete this canvas operation (${code}).`;
}
