import { createHash } from 'node:crypto';
import type { z } from 'zod';

import { formatChangeSetProposal } from '../change-set-presentation.ts';
import { managementOriginKey } from '../contracts.ts';
import { MARKDOWN_PRESENTATION_DIALECT } from '../markdown-presentation.ts';
import {
  ManagementError,
  type ApplyWorkspaceChangesResult,
  type ManagementActorContext,
  type ManagementApplyResult,
  type ManagementChangeSetPreview,
  type ManagementChangeStatement,
  type ManagementItemOutcome,
  type ManagementObjectRef,
  type ManagementOperation,
} from '../types.ts';
import { channelNames } from '../channel-names.ts';
import { confirmationAsk, turnsAgentOff } from './confirmation-ask.ts';
import { fail, fiveZeroCode, serviceCodeRetryable, versionToken, type McpErrorCode } from './conventions.ts';
import { agentAvatar, agentLinks, agentStatus, type FiveZeroDeps } from './reads.ts';
import type * as schemas from './schemas.ts';

export type ChangeResult = z.infer<typeof schemas.changeResultOutput>;

/** How long a confirmToken may be confirmed (U2 note, §11 item 3). */
export const CONFIRMATION_LIFETIME_MS = 30 * 60_000;

/**
 * The request ID one 5.0 call is stored under: the caller, the tool, and the
 * exact arguments with their key. A retry finds its stored result before
 * anything is read from current state, so a version the call itself moved
 * never refuses its own retry. The same key with other arguments finds
 * nothing here, and the service refuses it as a reused key.
 */
export function callOperationId(context: ManagementActorContext, tool: string, args: unknown): string {
  const digest = createHash('sha256').update(stableJson([
    context.organizationId,
    context.userId,
    context.membershipId,
    managementOriginKey(context.origin),
    tool,
    args,
  ])).digest('hex');
  return `mcp5_${digest.slice(0, 40)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The stored result of a call that already ran to completion. */
export async function priorResult(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  operationId: string,
): Promise<ManagementApplyResult | undefined> {
  try {
    const result = await deps.service.getOperation(context, operationId);
    return result && 'outcomes' in result ? result : undefined;
  } catch (error) {
    if (error instanceof ManagementError && error.code === 'operation_not_found') return undefined;
    throw error;
  }
}

/**
 * Runs one 5.0 write through the service's apply pipeline, which keeps the
 * policy, the confirmation, idempotency, undo and receipts. `operations` runs
 * only when this exact call has no stored result.
 */
export async function applyChange(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  call: {
    tool: string;
    args: { idempotencyKey: string };
    operations(): Promise<ManagementOperation[]>;
  },
): Promise<ApplyWorkspaceChangesResult> {
  const operationId = callOperationId(context, call.tool, call.args);
  const prior = await priorResult(deps, context, operationId);
  if (prior) return prior;
  return deps.service.applyWorkspaceChanges({
    context,
    idempotencyKey: call.args.idempotencyKey,
    operations: await call.operations(),
    operationId,
    confirmationLifetimeMs: CONFIRMATION_LIFETIME_MS,
  });
}

/** What a later call checks a sent version against, and how to say it changed. */
export function requireVersion(current: string, sent: string, what: string, readWith: string): void {
  if (current === sent) return;
  fail('changed_since_read', `${what} changed since you read it, so nothing changed.`, {
    nextStep: `Call ${readWith} again and send the change with the version it returns now, under a new idempotencyKey.`,
  });
}

type ObjectKind = ManagementObjectRef['kind'];

const VERSION_KINDS: Partial<Record<ObjectKind, string>> = {
  agent: 'agent',
  memory: 'memory',
  routine: 'schedule',
  workspace_model: 'workspace_model',
};

/** Which changed object's version a result carries, by the operation that changed it. */
const VERSIONED_OBJECT: Partial<Record<ManagementOperation['kind'], ObjectKind>> = {
  create_agent: 'agent',
  update_agent: 'agent',
  set_agent_image_model: 'agent',
  archive_agent: 'agent',
  restore_agent: 'agent',
  update_agent_memory: 'memory',
  save_routine: 'routine',
  control_routine: 'routine',
  take_over_routine: 'routine',
  set_workspace_model: 'workspace_model',
};

/**
 * One applied write as the 5.0 result. A refused or failed change becomes
 * the 5.0 error; a confirmation becomes its token and preview. `agentId`
 * names the Agent the change is about, read again for its current name.
 */
export async function changeResult(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  result: ApplyWorkspaceChangesResult,
  options: { agentId?: string; summary?: string | ((agentName: string) => string) } = {},
): Promise<ChangeResult> {
  if (result.status === 'clarification_required') {
    const { matches } = result.clarification;
    return {
      status: 'similar_agent_exists',
      summary: matches.length === 1
        ? `An Agent like this already exists: ${matches[0]!.name} (@${matches[0]!.handle}). Nothing was created.`
        : `${matches.length} Agents like this already exist. Nothing was created.`,
      nextStep: 'Ask the person whether to use one of these Agents or create a new one; only for a new one, call create_agent again with createEvenIfSimilar true and a new idempotencyKey.',
      matches: matches.map(({ id, name, handle }) => ({ agentId: id, name, handle })),
    };
  }
  if (result.status === 'confirmation_required') return confirmationResult(deps, context, result, options.agentId);
  const failed = result.outcomes.find(({ disposition }) => disposition === 'failed' || disposition === 'skipped');
  const applied = result.outcomes.filter(({ disposition }) => disposition === 'applied');
  if (failed && applied.length === 0) failedOutcome(failed);
  const { agent } = await agentSummary(deps, context, options.agentId ?? changedAgentId(applied));
  const versioned = applied.at(-1) && VERSIONED_OBJECT[applied.at(-1)!.operationKind];
  const version = versioned ? changedVersion(context, applied, versioned) : undefined;
  return {
    status: 'done',
    summary: typeof options.summary === 'function' ? options.summary(agent?.name ?? 'the Agent')
      : options.summary ?? doneSummary(applied.at(-1)?.operationKind, agent?.name),
    // Whatever changed, an Agent that is off answers no one, so trying it waits until it is on.
    ...(agent?.status === 'off' ? { nextStep: offNextStep(agent.name) } : {}),
    ...(agent ? { agent } : {}),
    ...(version ? { version } : {}),
    ...(applied.length === 1 && applied[0]!.undoAvailable ? { undoToken: result.operationId } : {}),
    ...withWarnings(result.outcomes),
  };
}

async function confirmationResult(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  result: ManagementApplyResult,
  agentId: string | undefined,
): Promise<ChangeResult> {
  const pending = result.outcomes.find(({ disposition }) => disposition === 'confirmation_required');
  // The service shows no preview for a confirmation that expired, which a
  // retried call can return.
  if (!pending?.proposalId || !result.confirmation) {
    fail('confirmation_expired', 'This confirmation expired, so nothing changed.', { nextStep: EXPIRED_NEXT_STEP });
  }
  const { preview } = result.confirmation;
  // An undo names no Agent of its own; its frozen change does.
  const about = agentId ?? preview.changes.map(({ target }) => /^agent:(.+)$/.exec(target)?.[1]).find(Boolean);
  const { agent } = await agentSummary(deps, context, about);
  return {
    status: 'needs_confirmation',
    summary: 'This change waits for the person\'s confirmation. Nothing has changed yet.',
    nextStep: 'Show the preview, ask the person, and call confirm_change with the confirmToken only after they agree.',
    ...(agent ? { agent } : {}),
    confirmation: {
      confirmToken: pending.proposalId,
      preview: formatChangeSetProposal(preview, CONFIRMATION_DIALECT),
      expiresAt: new Date(result.confirmation.expiresAt).toISOString(),
      // Admin has a button for every change that waits here but deleting an Agent.
      inAdmin: !preview.changes.some(({ operationKind }) => operationKind === 'delete_agent'),
      ask: confirmationAsk(preview, {
        ...agent ? { agent } : {},
        channels: turnsAgentOff(preview) ? await agentChannels(deps, context, about) : [],
      }),
    },
  };
}

/** The Channels an Agent answers in now, by name, for a confirmation that would silence it there. */
async function agentChannels(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  agentId: string | undefined,
): Promise<string[]> {
  if (!agentId) return [];
  const { channels } = await deps.service.inspectWorkspace(context);
  return channelNames(channels
    .filter(({ lifecycle, grants }) => lifecycle === 'active' &&
      grants.some((grant) => grant.agentId === agentId && grant.status === 'active'))
    .map(({ label }) => ({ name: label })));
}

/** The 4.x preview, closing with a line for the person instead of a tool name. */
const CONFIRMATION_DIALECT = {
  ...MARKDOWN_PRESENTATION_DIALECT,
  approvalInstruction: 'Nothing changes until you confirm.',
  truncatedApprovalInstruction: 'Nothing changes until you confirm.',
};

export const EXPIRED_NEXT_STEP = 'Call the tool that proposed the change again, with a new idempotencyKey, for a fresh preview and confirmToken.';

/**
 * A retired confirmation: the person kept it as it was, a newer change
 * replaced it, or what it changes moved on. Nothing stored says which, so
 * one sentence true of every cause.
 */
export const STALE_CONFIRMATION = 'That confirmation no longer applies. Ask again to make the change.';
export const STALE_NEXT_STEP = 'Nothing changed. Propose it again, with a new idempotencyKey, only if the person asks for it again.';

/** Adding an Agent to a Channel never turns it on, so the person decides that first. */
const AGENT_OFF_NEXT_STEP = 'Ask the person whether to turn it on. If they agree, call update_agent with on: true, then call add_agent_to_channel again with a new idempotencyKey.';

const NEXT_STEPS: Partial<Record<McpErrorCode, string>> = {
  changed_since_read: 'Read it again and send the change with the version it returns now, under a new idempotencyKey.',
  key_reused: 'Use a new idempotencyKey: this one already belongs to a different call.',
  confirmation_expired: EXPIRED_NEXT_STEP,
};

/** Slack refused the change for a reason that stays: the message says what has to change first. */
const SLACK_REFUSED_NEXT_STEP = 'Retrying will not help, and neither will opening the DM in Slack. Tell the person what the message says to do.';

/** The change did not apply: its outcome as the 5.0 error. */
function failedOutcome(outcome: ManagementItemOutcome): never {
  const serviceCode = outcome.code ?? 'operation_failed';
  const code = fiveZeroCode(serviceCode);
  // A call sent again after its confirmation was retired.
  const retired = outcome.code === 'proposal_stale';
  const message = retired ? STALE_CONFIRMATION
    : code === 'changed_since_read' ? 'It changed since you read it, so nothing changed.'
      : outcome.instruction ?? 'That change did not apply.';
  // A removal Composio could not finish is cut off already; resending replays it, so a retry needs a new key.
  const nextStep = outcome.code === 'removal_incomplete'
    ? 'Call remove_connection again with a new idempotencyKey, then confirm_change. Resending this call replays this result.'
    : outcome.code === 'agent_off' ? AGENT_OFF_NEXT_STEP
      : outcome.code === 'slack_refused' ? SLACK_REFUSED_NEXT_STEP
        : retired ? STALE_NEXT_STEP : NEXT_STEPS[code];
  fail(code, message, {
    retryable: serviceCodeRetryable(serviceCode),
    ...(nextStep ? { nextStep } : {}),
    ...(outcome.links?.admin ? { fix: { label: 'Open Chickpea Admin', url: outcome.links.admin } } : {}),
  });
}

function changedAgentId(applied: readonly ManagementItemOutcome[]): string | undefined {
  for (const outcome of applied) {
    if (outcome.operationKind === 'delete_agent') continue;
    const agent = outcome.changed?.find(({ kind }) => kind === 'agent');
    if (agent) return agent.id;
  }
  return undefined;
}

function changedVersion(
  context: ManagementActorContext,
  applied: readonly ManagementItemOutcome[],
  kind: ObjectKind,
): string | undefined {
  const ref = applied.flatMap(({ changed }) => changed ?? []).findLast((entry) => entry.kind === kind);
  const versionKind = VERSION_KINDS[kind];
  return ref?.revision !== undefined && versionKind
    ? versionToken(versionKind, ref.id, ref.revision, context.organizationId)
    : undefined;
}

/**
 * The Agent as it is now, with its links and the version a next change
 * sends; nothing when the caller can no longer edit it.
 */
export async function agentSummary(
  deps: FiveZeroDeps,
  context: ManagementActorContext,
  agentId: string | undefined,
): Promise<{ agent?: ChangeResult['agent']; version?: string }> {
  if (!agentId) return {};
  try {
    const { agent, stores } = await deps.service.agentReader(context, agentId);
    const handle = agent.slackPresence?.normalizedHandle || undefined;
    const [slack, grants] = await Promise.all([deps.service.slackAppLink(context), stores.config.listAgentChannelGrants()]);
    const links = agentLinks(deps.baseUrl, agent.id, slack);
    const channels = grants.filter((grant) => grant.agentId === agent.id && grant.status === 'active')
      .map(({ channelId, channelLabel }) => ({ channelId, ...(channelLabel ? { name: channelLabel } : {}) }));
    return {
      agent: {
        agentId: agent.id,
        name: agent.name,
        ...(handle ? { handle } : {}),
        status: agentStatus(agent),
        ...(channels.length ? { channels } : {}),
        ...agentAvatar(deps, agent),
        ...(links ? { links } : {}),
      },
      version: versionToken('agent', agent.id, agent.revision, context.organizationId),
    };
  } catch (error) {
    if (error instanceof ManagementError && error.code === 'forbidden') return {};
    throw error;
  }
}

function withWarnings(outcomes: readonly ManagementItemOutcome[]): { warnings?: string[] } {
  const warnings = outcomes.flatMap((outcome) => [
    ...(outcome.handleChange
      ? [`@${outcome.handleChange.requested} was taken in Slack, so the handle is @${outcome.handleChange.used}.`]
      : []),
    ...(outcome.warning ? [outcome.warning] : []),
  ]);
  return warnings.length ? { warnings } : {};
}

/** The Agent writes that send no summary of their own; every other write names its result. */
const DONE_SUMMARIES: Partial<Record<ManagementOperation['kind'], (name: string) => string>> = {
  create_agent: (name) => `Created ${name}.`,
  update_agent: (name) => `Saved ${name}.`,
  set_agent_image_model: (name) => `Saved ${name}'s image model.`,
  update_agent_memory: (name) => `Saved ${name}'s memory.`,
  archive_agent: (name) => `Archived ${name}; it no longer answers anywhere.`,
  restore_agent: (name) => `Restored ${name}.`,
  grant_agent_channel: (name) => `${name} now answers in the Channel.`,
};

function doneSummary(kind: ManagementOperation['kind'] | undefined, agentName = 'the Agent'): string {
  const summary = kind ? DONE_SUMMARIES[kind] : undefined;
  return summary ? summary(agentName) : 'Done.';
}

/**
 * What the model hears after a change to an Agent that is off, including the
 * one that turned it off: nothing that suggests trying it, and nothing that
 * suggests turning it on.
 */
export function offNextStep(agentName: string): string {
  return `${agentName} is off, so it answers no one in Slack. Don't suggest trying it.`;
}

/**
 * A confirmed change, named as its confirmation asked it ("Turn off @x?"
 * becomes "Turned off X."). A deleted Agent cannot be read again, so a
 * name comes from what the person confirmed. A change of another kind, or
 * several at once, reads as the change they confirmed.
 */
export function confirmedSummary(preview: ManagementChangeSetPreview | undefined): string | ((agentName: string) => string) {
  const [change, ...more] = preview?.changes ?? [];
  if (!change || more.length > 0) return CONFIRMED;
  if (turnsAgentOff(preview!)) return (name) => `Turned off ${name}.`;
  return (change.statement && confirmedWords(change.statement)) ?? CONFIRMED;
}

const CONFIRMED = 'Made the change you confirmed.';

function confirmedWords(statement: ManagementChangeStatement): string | undefined {
  switch (statement.kind) {
    case 'delete_agent':
      return `Deleted ${statement.agent.name}.`;
    case 'disconnect_connection':
      return `Disconnected ${statement.connection} from ${statement.agent.name}.`;
    case 'remove_website_login':
      return `Removed the ${statement.site ?? 'website'} login from ${statement.agent.name}.`;
    case 'delete_routine':
      return statement.routine ? `Deleted the schedule ${statement.routine}.` : 'Deleted the schedule.';
    case 'remove_provider_credential':
      return `Removed the ${statement.provider} key.`;
    case 'revoke_agent_channel':
      return `${statement.agent?.name ?? 'The Agent'} no longer answers in ${statement.channel ? `#${statement.channel.replace(/^#/, '')}` : 'that Channel'}.`;
    case 'update_member': {
      const member = statement.member ?? 'The member';
      if (statement.status === 'removed') return `Removed ${member} from Chickpea.`;
      if (statement.status === 'suspended') return `Suspended ${member}.`;
      if (statement.role === 'owner') return `Made ${member} an Owner.`;
      return statement.role ? `Changed ${member}'s role.` : undefined;
    }
    default:
      return undefined;
  }
}
