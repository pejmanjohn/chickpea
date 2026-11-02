import { DatabaseSync } from 'node:sqlite';

import type { TurnInputSql } from '../../src/agents/turn-input.ts';

export function sqlStorage(): TurnInputSql & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    exec(query: string, ...bindings: unknown[]) {
      const statement = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const rows = statement.all(...(bindings as never[])) as Record<string, unknown>[];
        return { toArray: () => rows };
      }
      statement.run(...(bindings as never[]));
      return { toArray: () => [] };
    },
  };
}
