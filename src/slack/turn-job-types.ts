import type { ResolvedAssignment } from '../config/types.ts';
import type { RunExecutionAuthority } from '../work/types.ts';
import type { NormalizedSlackTurn } from './types.ts';

/** JSON-clonable durable relay payload shared by Node and Cloudflare state. */
export interface TurnJob {
  id: string;
  evtKey: string;
  msgKey: string;
  turn: NormalizedSlackTurn;
  assignment: ResolvedAssignment;
  /** Canonical Run correlation for either compatibility or ledger ownership. */
  runId?: string;
  /** Missing only on pre-cutover rows and old test fixtures; those are legacy. */
  executionAuthority?: RunExecutionAuthority;
}

/**
 * Adapter-owned lookup that lets an opaque RunExecution-scoped Flue identity
 * recover the Slack coordinates needed by the Slack agent initializer. The
 * common Work ledger remains free of raw channel coordinates and message body.
 */
export interface SlackAgentExecutionContext {
  continuityKey: string;
  runId: string;
  workspaceId: string;
  channelId: string;
  threadTs: string;
  createdAt: number;
}
