import { AsyncLocalStorage } from 'node:async_hooks';

import type { StateRpcResult } from './state-rpc.ts';

/** One read RPC: the stub method and its arguments, exactly as a proxy sends them. */
export interface StateRead {
  method: string;
  args: readonly unknown[];
}

/** A runner turn's reads, answered from one batch where they can be (turn-read-batch.ts). */
export interface TurnReadScope {
  read<T>(method: string, args: readonly unknown[], send: () => Promise<StateRpcResult<T>>): Promise<StateRpcResult<T>>;
  sent(method: string, op: string | undefined): void;
  close(): void;
}

const scopes = new AsyncLocalStorage<TurnReadScope>();

export function turnReads(): TurnReadScope | undefined {
  return scopes.getStore();
}

/** Run one turn attempt inside `reads`, when it has them; they end with it. */
export async function withTurnReads<T>(reads: TurnReadScope | undefined, run: () => Promise<T>): Promise<T> {
  if (!reads) return run();
  try {
    return await scopes.run(reads, run);
  } finally {
    reads.close();
  }
}

/** A lease check reads the state store: it exists to see what changed since the turn read it. */
export function outsideTurnReads<T>(run: () => T): T {
  return scopes.exit(run);
}

/** The turn is about to prepare its dispatch: from here on it reads the state store. */
export function endTurnReads(): void {
  scopes.getStore()?.close();
}
