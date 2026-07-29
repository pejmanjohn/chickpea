import { Hono, type Context } from 'hono';

import { UsageStateError } from '../usage/store.ts';
import type {
  UsageFilters,
  UsageGroupBy,
  UsageOperationKind,
  UsageOperationStatus,
  UsageQuery,
  UsageStore,
} from '../usage/types.ts';

interface UsageAdminApiOptions {
  store: (c: Context) => UsageStore;
}

export function createUsageAdminApi(options: UsageAdminApiOptions): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.get('/usage/summary', async (c) => {
    try {
      return c.json(await options.store(c).summarize(parseUsageQuery(c, true)));
    } catch (error) {
      return usageError(c, error);
    }
  });

  app.get('/usage/operations', async (c) => {
    try {
      const page = await options.store(c).listOperations(parseUsageQuery(c, false));
      return c.json({
        items: page.items,
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      });
    } catch (error) {
      return usageError(c, error);
    }
  });

  app.get('/usage/operations/:operationId', async (c) => {
    try {
      const detail = await options.store(c).getOperation(c.req.param('operationId'));
      return detail ? c.json(detail) : c.json({ error: 'usage_operation_not_found' }, 404);
    } catch (error) {
      return usageError(c, error);
    }
  });

  return app;
}

function parseUsageQuery(c: Context, includeGroup: boolean): UsageQuery {
  const from = numberQuery(c, 'from');
  const to = numberQuery(c, 'to');
  const limit = optionalNumberQuery(c, 'limit');
  const groupBy = includeGroup ? c.req.query('groupBy') : undefined;
  const currency = c.req.query('currency');
  const cursor = c.req.query('cursor');
  const filters: UsageFilters = {};
  assignCsv(filters, 'workspace', c.req.query('workspace'));
  assignCsv(filters, 'profile', c.req.query('profile'));
  assignCsv(filters, 'channel', c.req.query('channel'));
  assignCsv(filters, 'routine', c.req.query('routine'));
  assignCsv(filters, 'provider', c.req.query('provider'));
  assignCsv(filters, 'credential', c.req.query('credential'));
  assignCsv(filters, 'model', c.req.query('model'));
  assignCsv(filters, 'workKind', c.req.query('workKind'));
  assignCsv(filters, 'status', c.req.query('status'));
  return {
    from,
    to,
    ...(limit === undefined ? {} : { limit }),
    ...(groupBy === undefined ? {} : { groupBy: groupBy as UsageGroupBy }),
    ...(currency === undefined ? {} : { currency }),
    ...(cursor === undefined ? {} : { cursor: decodeCursor(cursor) }),
    ...(Object.keys(filters).length === 0 ? {} : { filters }),
  };
}

function numberQuery(c: Context, name: string): number {
  const value = c.req.query(name);
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new UsageStateError('usage_query_invalid', `Missing or invalid ${name}.`);
  }
  return Number(value);
}

function optionalNumberQuery(c: Context, name: string): number | undefined {
  const value = c.req.query(name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new UsageStateError('usage_query_invalid', `Invalid ${name}.`);
  }
  return Number(value);
}

function assignCsv<K extends keyof UsageFilters>(
  filters: UsageFilters,
  key: K,
  raw: string | undefined,
): void {
  if (raw === undefined) return;
  const values = raw.split(',').filter(Boolean);
  Object.assign(filters, { [key]: values as string[] | UsageOperationKind[] | UsageOperationStatus[] });
}

function encodeCursor(cursor: { startedAt: number; operationId: string }): string {
  return `${cursor.startedAt}:${cursor.operationId}`;
}

function decodeCursor(raw: string): { startedAt: number; operationId: string } {
  const separator = raw.indexOf(':');
  if (separator <= 0) {
    throw new UsageStateError('usage_query_invalid', 'Invalid usage cursor.');
  }
  const startedAt = Number(raw.slice(0, separator));
  const operationId = raw.slice(separator + 1);
  return { startedAt, operationId };
}

function usageError(c: Context, error: unknown): Response {
  if (error instanceof UsageStateError) {
    if (error.code === 'usage_operation_not_found') {
      return c.json({ error: error.code }, 404);
    }
    if (error.code === 'usage_query_invalid' || error.code === 'usage_invalid_input') {
      return c.json({ error: error.code }, 400);
    }
    return c.json({ error: error.code }, 409);
  }
  console.error('[chickpea] usage admin API failure');
  return c.json({ error: 'usage_unavailable' }, 503);
}
