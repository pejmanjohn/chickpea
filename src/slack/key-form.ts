import type { WebClient } from '@slack/web-api';

import type { SlackEventExecution } from '../channels/slack.ts';
import { isCloudflareTarget } from '../config/runtime-target.ts';
import { resolveStores, type AppStores, type PlatformEnv } from '../config/state-backend.ts';
import type {
  AgentConnectionBinding,
  ConnectionAccount,
  CustomAgentConfig,
  ResolvedAssignment,
} from '../config/types.ts';
import { connectionUrlPrefixes, type ConnectionCheckOptions } from '../connections/connection-check.ts';
import { connectionSetupBinding, setupConnectionTarget } from '../management/agent-connections.ts';
import type { SetupWakeRequest } from '../management/receipts.ts';
import type { ManagementStore } from '../management/store.ts';
import type { SlackFormKeyOutcome } from '../management/slack-key-save.ts';
import { setupWakeAgent, type SavedKeyCheck } from '../management/setup-wake.ts';
import type { ManagementSetupRecord } from '../management/types.ts';
import type { SlackStateStore } from './claim-store.ts';
import { conversationThreadTs, slackConversationKind } from './thread-key.ts';
import type { NormalizedSlackTurn } from './types.ts';
import type { GatewayDeploymentClient } from './gateway/client.ts';
import type { GatewayInboundDelivery, GatewayInteractionReceipt } from './gateway/protocol.ts';
import { wakeNodeTurnRelay } from './node-turn-relay.ts';
import { slackInteractionAckOf } from './interaction-ack.ts';
import { checkSlackBlocks } from './ui/block-kit-limits.ts';
import { surfaceMessenger, uiSurfaceRecord, type UiSurfaceMessenger } from './ui/host-surfaces.ts';
import type { SlackUiAction, SlackUiViewSubmission } from './ui/interaction-payload.ts';
import {
  isKeyCard,
  keyCardFinal,
  keyCardTransition,
  keyHost,
  keyInvalidNotice,
  keyModalView,
  keyNotSavedNotice,
  keyRefusalNotice,
  keyUnsavedNotice,
  keyRowAvailability,
  MAX_KEY_ROWS,
  parseKeyFormMetadata,
  readKeySubmission,
  renderKeyCard,
  type KeyCardSpec,
  type KeyRow,
  type KeyRowEvent,
  type KeyRowRefusal,
  type KeySetupFacts,
  type KeySubmissionReading,
  type KeyTarget,
  type KeyUnsaved,
  type KeyWarning,
} from './ui/key-card.ts';
import { parseUiControl, uiSurfaceId, UI_SURFACE_TTL_MS, type UiSurfaceRecord } from './ui/surface.ts';

type SurfaceState = Required<Pick<SlackStateStore, 'executeUiSurface'>>;
type KeyCard = UiSurfaceRecord & { spec: KeyCardSpec };

function surfaceState(stores: Pick<AppStores, 'slackState'>): SurfaceState | undefined {
  return stores.slackState.executeUiSurface ? stores.slackState as SurfaceState : undefined;
}

export interface KeyFormSlack {
  update(channelId: string, messageTs: string, rendered: { text: string; blocks: Array<Record<string, unknown>> }): Promise<void>;
  notice(input: { channelId: string; userId: string; text: string; threadTs: string }): Promise<void>;
}

export interface KeyFormContext {
  stores: AppStores;
  platformEnv: PlatformEnv | undefined;
  slack: KeyFormSlack;
  wake?: (request: SetupWakeRequest) => Promise<unknown>;
  deliverSetupReceipt?: () => void;
  checkOptions?: ConnectionCheckOptions;
}

interface KeyFormDelivery {
  stores: AppStores;
  platformEnv: PlatformEnv | undefined;
  client: Pick<WebClient, 'chat'>;
  gateway?: GatewayDeploymentClient;
  execution?: Pick<SlackEventExecution, 'enqueueTurn'>;
}

export function keyFormContextOf(delivery: KeyFormDelivery): KeyFormContext {
  const { client, platformEnv, stores } = delivery;
  return {
    stores,
    platformEnv,
    slack: {
      update: (channel, ts, rendered) => surfaceMessenger(client, channel).update(ts, rendered),
      notice: async ({ channelId, userId, text, threadTs }) => {
        await client.chat.postEphemeral({ channel: channelId, user: userId, text, thread_ts: threadTs });
      },
    },
    wake: async (request) => (await import('../channels/slack.ts')).admitSetupWake(request, platformEnv, {
      stores,
      ...(delivery.gateway ? { gatewayClient: delivery.gateway } : {}),
      ...(delivery.execution?.enqueueTurn ? { enqueueTurn: delivery.execution.enqueueTurn } : {}),
    }),
    ...(isCloudflareTarget() ? {} : { deliverSetupReceipt: () => void wakeNodeTurnRelay(platformEnv) }),
  };
}

type KeyFormReason = KeyRowRefusal | 'invalid' | Exclude<SlackFormKeyOutcome['kind'], 'saved'> | `saved_${SavedKeyCheck}`;

function emitKeyForm(outcome: 'posted' | 'refused' | 'checked', reason?: KeyFormReason): void {
  console.info('[chickpea] slack_key_form', { outcome, ...(reason ? { reason } : {}) });
}

export function keyTargetOf(
  setup: ManagementSetupRecord,
  agent: Pick<CustomAgentConfig, 'revision'> | undefined,
  accounts: readonly ConnectionAccount[],
  bindings: readonly AgentConnectionBinding[],
): KeyTarget | undefined {
  const entry = agent && setupConnectionTarget(setup, agent, accounts, bindings);
  if (!entry) return undefined;
  const { policy, ownerKind } = entry.account;
  const binding = connectionSetupBinding(entry);
  if (policy.kind === 'api') {
    return { binding, valuePrefix: policy.headerValuePrefix ?? '', ownerKind, destinations: connectionUrlPrefixes(policy) };
  }
  if (policy.kind !== 'mcp') return undefined;
  const server = serverUrlWithoutQuery(policy.url);
  return server ? { binding, valuePrefix: policy.credentialValuePrefix ?? '', ownerKind, destinations: [server] } : undefined;
}

/** A server URL's query can carry a token, so only its origin and path are ever shown or stored. */
function serverUrlWithoutQuery(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}

function factsOf(setup: ManagementSetupRecord | undefined, target: KeyTarget | undefined): KeySetupFacts {
  return {
    ...(setup ? {
      setup: {
        status: setup.status,
        expiresAt: setup.expiresAt,
        ...(setup.target.credentialBinding ? { credentialBinding: setup.target.credentialBinding } : {}),
      },
    } : {}),
    ...(target ? { target } : {}),
  };
}

async function readKeyFacts(
  stores: Pick<AppStores, 'management' | 'config'>,
  setupOperationId: string,
  now: number,
): Promise<{ setup?: ManagementSetupRecord; facts: KeySetupFacts }> {
  const setup = await stores.management.getSetup(setupOperationId, now).catch(() => undefined);
  const agentId = setup?.target.agentId;
  if (!setup || setup.origin.kind !== 'slack' || !agentId) return { facts: factsOf(setup, undefined) };
  const [agent, accounts, bindings] = await Promise.all([
    stores.config.getAgent(agentId).catch(() => undefined),
    stores.config.listConnectionAccounts(setup.origin.workspaceId),
    stores.config.listAgentConnectionBindings(agentId),
  ]);
  return { setup, facts: factsOf(setup, keyTargetOf(setup, agent, accounts, bindings)) };
}

export interface KeyFormStoresNow {
  uiSurfaces: { get(id: string): UiSurfaceRecord | undefined };
  management: { getSetup(id: string, at?: number): ManagementSetupRecord | undefined };
  config: {
    getAgent(agentId: string): CustomAgentConfig;
    listConnectionAccounts(workspaceId: string): ConnectionAccount[];
    listAgentConnectionBindings(agentId: string): AgentConnectionBinding[];
  };
}

function readKeyFactsNow(stores: KeyFormStoresNow, setupOperationId: string, now: number): KeySetupFacts {
  const setup = stores.management.getSetup(setupOperationId, now);
  const agentId = setup?.target.agentId;
  if (!setup || setup.origin.kind !== 'slack' || !agentId) return factsOf(setup, undefined);
  let agent: CustomAgentConfig | undefined;
  try {
    agent = stores.config.getAgent(agentId);
  } catch {
    agent = undefined;
  }
  return factsOf(setup, keyTargetOf(
    setup,
    agent,
    stores.config.listConnectionAccounts(setup.origin.workspaceId),
    stores.config.listAgentConnectionBindings(agentId),
  ));
}

function clickedRow(action: SlackUiAction, card: UiSurfaceRecord | undefined): { card: KeyCard; row: KeyRow } | undefined {
  const control = parseUiControl(action);
  if (!control || control.kind !== 'key_add' || control.valueIndex === undefined || !isKeyCard(card) ||
      card.id !== control.surfaceId || card.workspaceId !== action.workspaceId) return undefined;
  if (action.containerType !== 'message' || action.isEphemeral || action.channelId !== card.channelId ||
      !action.messageTs || (card.messageTs && card.messageTs !== action.messageTs)) return undefined;
  const row = card.spec.rows[control.valueIndex];
  return row ? { card, row } : undefined;
}

function formForClick(
  action: SlackUiAction,
  clicked: { card: KeyCard; row: KeyRow } | undefined,
  facts: KeySetupFacts,
  now: number,
): Record<string, unknown> | undefined {
  if (!clicked) return undefined;
  const available = keyRowAvailability({
    card: clicked.card,
    workspaceId: action.workspaceId,
    userId: action.userId,
    setupOperationId: clicked.row.setupOperationId,
    facts,
    now,
  });
  return available.ok ? keyModalView({ card: clicked.card, row: available.row, target: available.target }) : undefined;
}

function cardId(action: SlackUiAction): string | undefined {
  return parseUiControl(action)?.surfaceId;
}

export async function keyFormForClick(
  action: SlackUiAction,
  stores: Pick<AppStores, 'slackState' | 'management' | 'config'>,
  now = Date.now(),
): Promise<Record<string, unknown> | undefined> {
  const id = cardId(action);
  const state = surfaceState(stores);
  if (!id || !state) return undefined;
  const clicked = clickedRow(action, await uiSurfaceRecord(state, { kind: 'get_surface', id }));
  if (!clicked) return undefined;
  const { facts } = await readKeyFacts(stores, clicked.row.setupOperationId, now);
  return formForClick(action, clicked, facts, now);
}

export async function answerKeyFormSubmission<C extends { stores: AppStores }>(
  submission: SlackUiViewSubmission,
  platformEnv: PlatformEnv | undefined,
  pendingContext: C | undefined | Promise<C | undefined>,
  admit: (context: C) => void,
): Promise<Response | undefined> {
  const [context, reading] = await Promise.all([
    pendingContext,
    readKeyFormSubmission(submission, resolveStores(platformEnv)),
  ]);
  const refusal = !context
    ? readKeySubmission({ submission, card: undefined, facts: {}, now: Date.now() })
    : reading;
  const ack = slackInteractionAckOf(platformEnv);
  if (!refusal.ok && (!ack || ack.claim())) return Response.json(refusal.responseAction);
  if (context) admit(context);
  return undefined;
}

export async function readKeyFormSubmission(
  submission: SlackUiViewSubmission,
  stores: Pick<AppStores, 'slackState' | 'management' | 'config'>,
  now = Date.now(),
): Promise<KeySubmissionReading> {
  const state = surfaceState(stores);
  const metadata = parseKeyFormMetadata(submission.privateMetadata);
  const [card, live] = state && metadata
    ? await Promise.all([
        uiSurfaceRecord(state, { kind: 'get_surface', id: metadata.cardId }),
        readKeyFacts(stores, metadata.setupOperationId, now),
      ])
    : [undefined, { facts: {} }];
  return readKeySubmission({ submission, card, facts: live.facts, now });
}

export function keyFormReceiptNow(
  delivery: GatewayInboundDelivery,
  stores: KeyFormStoresNow,
  now = Date.now(),
): GatewayInteractionReceipt | undefined {
  if (delivery.kind === 'interaction.ui_action') {
    const id = cardId(delivery);
    const clicked = id ? clickedRow(delivery, stores.uiSurfaces.get(id)) : undefined;
    const view = clicked
      ? formForClick(delivery, clicked, readKeyFactsNow(stores, clicked.row.setupOperationId, now), now)
      : undefined;
    return view ? { outcome: 'accepted', interaction: { openView: view } } : undefined;
  }
  if (delivery.kind !== 'interaction.view_submission') return undefined;
  const metadata = parseKeyFormMetadata(delivery.privateMetadata);
  const reading = readKeySubmission({
    submission: delivery,
    card: metadata ? stores.uiSurfaces.get(metadata.cardId) : undefined,
    facts: metadata ? readKeyFactsNow(stores, metadata.setupOperationId, now) : {},
    now,
  });
  return reading.ok ? undefined : { outcome: 'accepted', interaction: { responseAction: reading.responseAction } };
}

export async function keyFormReceipt(
  delivery: GatewayInboundDelivery,
  stores: Pick<AppStores, 'slackState' | 'management' | 'config'>,
  now = Date.now(),
): Promise<GatewayInteractionReceipt | undefined> {
  if (delivery.kind === 'interaction.ui_action') {
    const view = await keyFormForClick(delivery, stores, now);
    return view ? { outcome: 'accepted', interaction: { openView: view } } : undefined;
  }
  if (delivery.kind !== 'interaction.view_submission') return undefined;
  const reading = await readKeyFormSubmission(delivery, stores, now);
  return reading.ok ? undefined : { outcome: 'accepted', interaction: { responseAction: reading.responseAction } };
}

async function transitionRow(
  state: SurfaceState,
  id: string,
  setupOperationId: string,
  event: KeyRowEvent,
): Promise<{ card: KeyCard | undefined; applied: boolean }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const card = await uiSurfaceRecord(state, { kind: 'get_surface', id });
    if (!isKeyCard(card)) return { card: undefined, applied: false };
    const next = keyCardTransition(card.spec, setupOperationId, event);
    if (!next) return { card, applied: false };
    const replaced = await uiSurfaceRecord(state, {
      kind: 'replace_surface_spec',
      id,
      expected: card.spec,
      spec: next,
      ...(keyCardFinal(next) ? { settled: true as const } : {}),
    });
    if (isKeyCard(replaced)) return { card: replaced, applied: true };
  }
  return { card: undefined, applied: false };
}

async function redraw(slack: KeyFormSlack, card: KeyCard | undefined): Promise<void> {
  if (!card?.messageTs) return;
  await slack.update(card.channelId, card.messageTs, renderKeyCard(card, card.spec)).catch(() => {
    console.warn('[chickpea] Slack key card redraw failed');
  });
}

function notify(slack: KeyFormSlack, card: KeyCard, userId: string, text: string): Promise<void> {
  return slack.notice({ channelId: card.channelId, userId, text, threadTs: card.threadTs }).catch(() => {
    console.warn('[chickpea] Slack key form notice was not delivered');
  });
}

export async function explainKeyCardClick(context: KeyFormContext, action: SlackUiAction): Promise<void> {
  const state = surfaceState(context.stores);
  const id = cardId(action);
  if (!state || !id) return;
  const clicked = clickedRow(action, await uiSurfaceRecord(state, { kind: 'get_surface', id }));
  if (!clicked) return;
  const now = Date.now();
  const { facts } = await readKeyFacts(context.stores, clicked.row.setupOperationId, now);
  const available = keyRowAvailability({
    card: clicked.card,
    workspaceId: action.workspaceId,
    userId: action.userId,
    setupOperationId: clicked.row.setupOperationId,
    facts,
    now,
  });
  const refusal = available.ok ? 'unavailable' : available.refusal;
  emitKeyForm('refused', refusal);
  let card = clicked.card;
  if (refusal === 'expired' || refusal === 'superseded') {
    card = (await transitionRow(state, card.id, clicked.row.setupOperationId, { kind: refusal, at: now })).card ?? card;
  }
  if (refusal !== 'wrong_user') await redraw(context.slack, card);
  await notify(context.slack, card, action.userId, keyRefusalNotice(card, refusal));
}

const SAVE_EVENT: Record<Exclude<SlackFormKeyOutcome['kind'], 'saved'>, KeyUnsaved> = {
  rejected: 'rejected',
  unconfirmed: 'unconfirmed',
  target_changed: 'changed',
  expired: 'expired',
  access_lost: 'error',
  not_saved: 'error',
};

export async function saveKeyFromForm(context: KeyFormContext, submission: SlackUiViewSubmission): Promise<void> {
  const state = surfaceState(context.stores);
  const metadata = parseKeyFormMetadata(submission.privateMetadata);
  if (!state || !metadata) return;
  const now = Date.now();
  const [found, live] = await Promise.all([
    uiSurfaceRecord(state, { kind: 'get_surface', id: metadata.cardId }),
    readKeyFacts(context.stores, metadata.setupOperationId, now),
  ]);
  if (!isKeyCard(found)) return;
  const reading = readKeySubmission({ submission, card: found, facts: live.facts, now });
  if (!reading.ok) {
    emitKeyForm('refused', reading.refusal);
    let card: KeyCard = found;
    if (reading.refusal === 'expired' || reading.refusal === 'superseded') {
      card = (await transitionRow(state, found.id, metadata.setupOperationId, { kind: reading.refusal, at: now })).card ?? found;
      await redraw(context.slack, card);
    }
    await notify(context.slack, card, submission.userId, reading.refusal === 'invalid'
      ? keyInvalidNotice(reading.problem)
      : keyRefusalNotice(card, reading.refusal));
    return;
  }
  const checking = await transitionRow(state, found.id, metadata.setupOperationId, { kind: 'check', at: now });
  if (!checking.applied || !checking.card) return;
  await redraw(context.slack, checking.card);
  let outcome: SlackFormKeyOutcome;
  try {
    const { saveSlackFormKey } = await import('../management/slack-key-save.ts');
    outcome = await saveSlackFormKey({
      setupOperationId: metadata.setupOperationId,
      slackUserId: submission.userId,
      key: reading.key,
      stores: context.stores,
      ...(context.platformEnv ? { platformEnv: context.platformEnv } : {}),
      ...(context.checkOptions ? { options: { connectionCheck: context.checkOptions } } : {}),
    });
  } catch {
    outcome = { kind: 'not_saved' };
  }
  emitKeyForm('checked', outcome.kind === 'saved' ? `saved_${outcome.check}` : outcome.kind);
  const settled = await transitionRow(state, found.id, metadata.setupOperationId, outcome.kind === 'saved'
    ? { kind: 'saved', check: outcome.check }
    : { kind: 'unsaved', because: SAVE_EVENT[outcome.kind] });
  const card = settled.card ?? checking.card;
  await redraw(context.slack, card);
  if (outcome.kind === 'saved') {
    context.deliverSetupReceipt?.();
  } else if (outcome.kind === 'rejected' || outcome.kind === 'unconfirmed') {
    await wakeOnUnsavedKey(context, live.setup, reading.row, submission.userId, outcome);
  } else if (outcome.kind === 'access_lost' || outcome.kind === 'not_saved') {
    await notify(context.slack, card, submission.userId, keyNotSavedNotice(card));
  }
}

type KeyFinding = { kind: 'rejected' } | { kind: 'unconfirmed'; check: KeyWarning };

/** One wake per setup and finding: a later rejection updates the card, and the thread admits its wake once. */
async function wakeOnUnsavedKey(
  context: KeyFormContext,
  setup: ManagementSetupRecord | undefined,
  row: KeyRow,
  slackUserId: string,
  finding: KeyFinding,
): Promise<void> {
  const agent = setup ? setupWakeAgent(setup) : undefined;
  if (!context.wake || !setup || !agent || setup.origin.kind !== 'slack') return;
  const person = await context.stores.identity.getUser(setup.actorUserId).catch(() => undefined);
  const host = keyHost(row);
  await context.wake({
    setupOperationId: `${setup.setupOperationId}.${finding.kind}`,
    workspaceId: setup.origin.workspaceId,
    channelId: setup.origin.channelId,
    threadTs: setup.origin.threadTs,
    wake: {
      agentId: agent.agentId,
      slackUserId,
      ...(setup.origin.conversationKind ? { conversationKind: setup.origin.conversationKind } : {}),
      note: setupKeyUnsavedNote({ person: person?.displayName ?? 'The person', connector: row.label, host, finding }),
    },
    notice: keyUnsavedNotice(row, finding.kind),
  }).catch(() => {
    console.warn('[chickpea] Slack key form could not wake the Agent');
  });
}

interface KeyCardDelivery {
  turn: Pick<NormalizedSlackTurn, 'workspaceId' | 'channelId' | 'threadTs' | 'messageTs' | 'userId' |
    'actorMembershipId' | 'source' | 'channelType' | 'sessionThreadTs'>;
  assignment: { agent: { id: string; name: string }; runtimeContract?: ResolvedAssignment['runtimeContract'] };
  turnJobId: string;
  state: SlackStateStore;
  management: Pick<ManagementStore, 'execute'>;
  config: Pick<AppStores['config'], 'getAgent' | 'listConnectionAccounts' | 'listAgentConnectionBindings'>;
  messenger: Pick<UiSurfaceMessenger, 'post'>;
  now?: number;
}

/** The Add key card for the form setups the turn's tools issued, under its reply. */
export async function deliverHostKeyCard(input: KeyCardDelivery): Promise<void> {
  const { turn, assignment } = input;
  const state = surfaceState({ slackState: input.state });
  if (!state || !turn.actorMembershipId || slackConversationKind(turn) === 'mpim') return;
  const listed = await input.management.execute({
    kind: 'list_slack_form_setups',
    workspaceId: turn.workspaceId,
    channelId: turn.channelId,
    threadTs: conversationThreadTs(turn, assignment.runtimeContract),
    messageTs: turn.messageTs,
    agentId: assignment.agent.id,
    actorMembershipId: turn.actorMembershipId,
    at: input.now ?? Date.now(),
  });
  if (listed.kind !== 'setups' || listed.setups.length === 0) return;
  await postKeyCard({ ...input, setups: listed.setups, state });
}

async function postKeyCard(input: Omit<KeyCardDelivery, 'state' | 'management'> & {
  setups: readonly ManagementSetupRecord[];
  state: SurfaceState;
}): Promise<void> {
  const { turn, assignment } = input;
  const agentId = assignment.agent.id;
  const [agent, accounts, bindings] = await Promise.all([
    input.config.getAgent(agentId).catch(() => undefined),
    input.config.listConnectionAccounts(turn.workspaceId),
    input.config.listAgentConnectionBindings(agentId),
  ]);
  const rows = input.setups.slice(0, MAX_KEY_ROWS).flatMap((setup): KeyRow[] => {
    const { action } = setup;
    if (action !== 'api_credential' && action !== 'mcp_credentials') return [];
    const target = setup.target.agentId === agentId ? keyTargetOf(setup, agent, accounts, bindings) : undefined;
    if (!target || !setup.target.connectionId) return [];
    return [{
      setupOperationId: setup.setupOperationId,
      connectionId: setup.target.connectionId,
      kind: action,
      label: setup.target.targetLabel,
      destinations: target.destinations,
      state: { is: 'waiting' },
    }];
  });
  if (rows.length === 0) return;
  const now = input.now ?? Date.now();
  const stored = await uiSurfaceRecord(input.state, {
    kind: 'put_surface',
    record: {
      id: uiSurfaceId(input.turnJobId, 'host-key-card'),
      namespace: 'host',
      workspaceId: turn.workspaceId,
      channelId: turn.channelId,
      threadTs: turn.threadTs,
      conversationThreadTs: conversationThreadTs(turn, assignment.runtimeContract),
      conversationKind: slackConversationKind(turn) === 'im' ? 'im' : 'channel',
      agentId,
      turnJobId: input.turnJobId,
      requesterUserId: turn.userId,
      spec: { kind: 'key_card', agentName: assignment.agent.name, rows },
      status: 'pending_delivery',
      createdAt: now,
      updatedAt: now,
      expiresAt: Math.max(now + UI_SURFACE_TTL_MS, ...input.setups.map(({ expiresAt }) => expiresAt)),
    },
  });
  if (!isKeyCard(stored) || stored.messageTs || stored.status !== 'pending_delivery') return;
  const rendered = renderKeyCard(stored, stored.spec);
  const check = checkSlackBlocks(rendered.blocks, { text: rendered.text });
  if (!check.ok) {
    console.error('[chickpea] Add key card failed the Block Kit check', { issues: check.issues.slice(0, 5) });
    await uiSurfaceRecord(input.state, { kind: 'close_surface', id: stored.id, status: 'failed' });
    return;
  }
  const messageTs = await input.messenger.post(rendered).catch(() => undefined);
  if (!messageTs) return;
  await uiSurfaceRecord(input.state, { kind: 'bind_surface_message', id: stored.id, messageTs });
  emitKeyForm('posted');
}

const UNCONFIRMED_ANSWER: Record<KeyWarning, string> = {
  not_permitted: 'answered 403',
  path_not_found: 'answered 404, as many APIs do at a base path whatever the key',
  unreachable: 'could not be reached or answered with a server error',
  inconclusive: 'answered in a way that neither accepts nor rejects a key',
};

function setupKeyUnsavedNote(input: { person: string; connector: string; host: string; finding: KeyFinding }): string {
  const { person, connector, host, finding } = input;
  const gave = `Chickpea note, not typed by ${person}: ${person} gave a key for ${connector} with Chickpea's Add key form in Slack`;
  if (finding.kind === 'rejected') {
    return [
      `${gave}, and ${host} rejected it (HTTP 401), so nothing was saved. The form offers Try again.`,
      `Reply here in one or two sentences: what usually causes this for ${connector}, and where they get a working key. Do not request another setup, and never ask them to paste a key here.`,
    ].join('\n\n');
  }
  return [
    `${gave}. Chickpea checked it with one request to the connection's base path at ${host}, which ${UNCONFIRMED_ANSWER[finding.check]}, so it could not confirm the key, nothing was saved, and the form is closed.`,
    `Call request_setup for ${connector} again with path set to a read endpoint inside the connection that a working key can read, such as a list endpoint, never the bare prefix. Chickpea then posts a new Add key button: tell the person in one sentence to use it, and never ask them to paste a key here.`,
  ].join('\n\n');
}
