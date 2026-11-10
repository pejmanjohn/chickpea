import { formatChangeSetProposal, type ChangeSetPresentationDialect } from '../change-set-presentation.ts';
import type { ManagementChangeSetPreview, ManagementChangeStatement } from '../types.ts';

/**
 * What a confirmation asks, in the words a person decides on: the question,
 * what happens, and the two buttons. The Agent card draws it; a client
 * without cards can ask the same way.
 */
export interface ConfirmationAsk {
  question: string;
  consequence: string;
  confirm: string;
  /** The way out, always "Keep …": nothing changes. */
  keep: string;
}

interface AskTarget {
  /** The Agent the change is about, as people mention it. */
  agent?: { name: string; handle?: string | undefined };
  /** Channels an Agent answers in, by name, for turning it off. */
  channels: readonly string[];
}

type Asked = Omit<ConfirmationAsk, 'consequence'>;

/** Plain text: the card shows it as text, so nothing is escaped or marked up. */
const PLAIN_DIALECT: ChangeSetPresentationDialect = {
  header: '',
  approvalInstruction: '',
  truncatedApprovalInstruction: '',
  truncationNotice: '…',
  textLimit: 2_000,
  bold: (text) => text,
  bullet: '•',
  escape: (text) => text,
  code: (text) => text,
};

const UNSURE: Asked = { question: 'Make this change?', confirm: 'Make the change', keep: 'Keep it as it is' };

export function confirmationAsk(preview: ManagementChangeSetPreview, target: AskTarget): ConfirmationAsk {
  const [change] = preview.changes;
  const plain = formatChangeSetProposal(preview, PLAIN_DIALECT).trim();
  if (preview.changes.length !== 1 || !change) return { ...UNSURE, consequence: plain };
  if (turnsAgentOff(preview)) return turnOffAsk(target);
  const asked = change.statement ? statementAsk(change.statement, target) : undefined;
  return { ...asked ?? UNSURE, consequence: plain };
}

/** Turning an Agent off is the one ask that names its Channels: they go quiet. */
export function turnsAgentOff(preview: ManagementChangeSetPreview): boolean {
  const [change, ...more] = preview.changes;
  const enabled = (record: unknown) => (record as { enabled?: unknown } | undefined)?.enabled;
  return change !== undefined && more.length === 0 && change.operationKind === 'update_agent' &&
    enabled(change.after) === false && enabled(change.before) !== false;
}

function turnOffAsk({ agent, channels }: AskTarget): ConfirmationAsk {
  const reach = channels.length
    ? `It answers in ${joinNames(channels)}. People who mention it there get no reply until you turn it back on.`
    : 'People who message it get no reply until you turn it back on.';
  return {
    question: `Turn off ${mention(agent) ?? 'this Agent'}?`,
    consequence: `${reach} Its instructions, memory and connections stay as they are.`,
    confirm: 'Turn off',
    keep: 'Keep it on',
  };
}

function statementAsk(statement: ManagementChangeStatement, target: AskTarget): Asked | undefined {
  const agent = 'agent' in statement && statement.agent ? mention(statement.agent) : mention(target.agent);
  switch (statement.kind) {
    case 'delete_agent':
      return { question: `Delete ${agent ?? 'this Agent'}?`, confirm: 'Delete', keep: 'Keep it' };
    case 'disconnect_connection':
      return { question: `Disconnect ${statement.connection}?`, confirm: 'Disconnect', keep: 'Keep it connected' };
    case 'remove_website_login':
      return {
        question: statement.site ? `Remove the ${statement.site} login?` : 'Remove this website login?',
        confirm: 'Remove login',
        keep: 'Keep the login',
      };
    case 'delete_routine':
      return { question: `Delete ${statement.routine ?? 'this schedule'}?`, confirm: 'Delete', keep: 'Keep it' };
    case 'remove_provider_credential':
      return { question: `Remove the ${statement.provider} key?`, confirm: 'Remove key', keep: 'Keep the key' };
    case 'update_member':
      return memberAsk(statement);
    default:
      return undefined;
  }
}

function memberAsk(statement: Extract<ManagementChangeStatement, { kind: 'update_member' }>): Asked {
  const member = statement.member ?? 'this member';
  if (statement.status === 'removed') return { question: `Remove ${member} from Chickpea?`, confirm: 'Remove', keep: 'Keep them' };
  if (statement.status === 'suspended') return { question: `Suspend ${member}?`, confirm: 'Suspend', keep: 'Keep their access' };
  if (statement.role === 'owner') return { question: `Make ${member} an Owner?`, confirm: 'Make Owner', keep: 'Keep their role' };
  return { question: `Change ${member}'s role?`, confirm: 'Change role', keep: 'Keep their role' };
}

function mention(agent: { name: string; handle?: string | undefined } | undefined): string | undefined {
  if (!agent) return undefined;
  return agent.handle ? `@${agent.handle}` : agent.name;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
