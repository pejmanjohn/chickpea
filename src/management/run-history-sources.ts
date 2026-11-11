import type { SlackPublicContextEntry } from '../config/types.ts';
import type { UsageOperationDetail, UsageStore } from '../usage/types.ts';

/** What one run was billed, net of anything credited back. */
export interface RunCharge {
  /** Millionths of a US dollar. */
  micros: number;
}

/**
 * What run history reads (management/mcp-v5/run-history.ts). It decides who
 * sees what itself; these only read. None of them reads a run's raw tool
 * results, the ledger's copy of a message, or a Help-improve copy.
 */
export interface RunHistorySources {
  usage: Pick<UsageStore, 'listOperations' | 'getOperation' | 'summarize'>;
  /**
   * Whether each ledger run's conversation was public when it ran, as Admin's
   * Usage page reads it (`WorkStore.getRunVisibilities`): at most 100 a call.
   * A run with no ledger row is missing from the map.
   */
  runVisibilities(runIds: readonly string[]): Promise<ReadonlyMap<string, boolean>>;
  /** One thread's rows in the thread record, which applies Slack's edits and deletions. */
  threadRecord(workspaceId: string, channelId: string, rootTs: string): Promise<SlackPublicContextEntry[]>;
  /** Where a schedule run posted, or undefined. */
  schedulePost(routineRunId: string): Promise<{ channelId: string; messageTs: string } | undefined>;
  /**
   * What the bill says each run cost, where this deployment has one to read;
   * undefined where it has none, so a list price estimate stands in. A run
   * the bill was read for and names no row of was billed nothing, and is 0
   * here; a run missing from the map shows no amount.
   */
  charges(items: readonly UsageOperationDetail[]): Promise<ReadonlyMap<string, RunCharge> | undefined>;
  /**
   * The secret run handles are sealed with, and the installation it is
   * derived for. Undefined where this deployment signs nobody in.
   */
  handleSecret(): Promise<{ secret: string; installationId: string } | undefined>;
}
