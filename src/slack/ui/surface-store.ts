import { schemaInstallRequired, type StateDb } from '../../state/state-db.ts';
import {
  UI_SURFACE_ID_PATTERN,
  UI_SURFACE_MAX_SPEC_BYTES,
  type UiNamespace,
  type UiSurfaceRecord,
  type UiSurfaceResolution,
  type UiSurfaceSpec,
  type UiSurfaceStatus,
} from './surface.ts';

/** Settled surfaces stay readable this long so a late click can explain itself. */
const RETAIN_SETTLED_MS = 30 * 24 * 60 * 60_000;
const STATUSES = new Set<UiSurfaceStatus>([
  'pending_delivery', 'open', 'resolved', 'superseded', 'expired', 'failed',
]);

interface UiSurfaceRow {
  id: string;
  namespace: string;
  workspace_id: string;
  channel_id: string;
  thread_ts: string;
  conversation_thread_ts: string;
  conversation_kind: string;
  agent_id: string;
  turn_job_id: string;
  requester_user_id: string;
  spec_json: string;
  status: string;
  message_ts: string | null;
  resolution_json: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface UiSurfaceScope {
  workspaceId: string;
  channelId: string;
  agentId: string;
  /** One Slack thread; absent, the whole channel or DM. */
  threadTs?: string;
}

/** A claim made inside Slack admission, atomically with the click's TurnJob. */
export interface UiSurfaceClaim {
  surfaceId: string;
  resolution: UiSurfaceResolution;
}

export type UiSurfaceRpcRequest =
  | { kind: 'put_surface'; record: UiSurfaceRecord }
  | { kind: 'get_surface'; id: string }
  | { kind: 'bind_surface_message'; id: string; messageTs: string }
  | { kind: 'close_surface'; id: string; status: 'superseded' | 'expired' | 'failed' }
  | { kind: 'resolve_surface'; id: string; resolution: UiSurfaceResolution }
  | {
      kind: 'supersede_surfaces';
      scope: UiSurfaceScope;
      exceptTurnJobId: string;
      kinds: UiSurfaceSpec['kind'][];
    }
  | { kind: 'list_open_surfaces'; scope: UiSurfaceScope; limit?: number }
  | { kind: 'list_turn_surfaces'; turnJobId: string };

export type UiSurfaceRpcResponse =
  | { kind: 'surface'; surface: UiSurfaceRecord | null }
  | { kind: 'surfaces'; surfaces: UiSurfaceRecord[] };

export type UiSurfaceClaimOutcome =
  | { claimed: true; surface: UiSurfaceRecord }
  | { claimed: false; surface?: UiSurfaceRecord };

/**
 * Durable interactive surfaces, stored beside turn_jobs in the Slack state
 * database so a click's first-wins claim and its TurnJob commit together.
 * Target-neutral StateDb logic: Node runs it over node:sqlite, Cloudflare over
 * the state Durable Object. Methods never open their own transaction, so they
 * compose inside Slack admission (NodeStateDb transactions do not nest).
 */
export class UiSurfaceStoreLogic {
  constructor(
    private readonly db: StateDb,
    private readonly now: () => number = Date.now,
  ) {
    if (!schemaInstallRequired(db)) return;
    db.exec(
      `CREATE TABLE IF NOT EXISTS ui_surfaces (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_ts TEXT NOT NULL,
        conversation_thread_ts TEXT NOT NULL,
        conversation_kind TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        turn_job_id TEXT NOT NULL,
        requester_user_id TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        status TEXT NOT NULL,
        message_ts TEXT,
        resolution_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS ui_surfaces_thread_idx
       ON ui_surfaces (workspace_id, channel_id, thread_ts, agent_id, status)`,
    );
  }

  /**
   * Insert by id and return the stored record. A replayed delivery gets the
   * existing row back, with any message binding or resolution; a surface that
   * was never posted takes the newer spec (a retried turn may ask differently).
   */
  put(record: UiSurfaceRecord): UiSurfaceRecord {
    validateRecord(record);
    this.purge();
    this.db.run(
      `UPDATE ui_surfaces SET spec_json = ?, updated_at = ?
       WHERE id = ? AND turn_job_id = ? AND namespace = ?
         AND status = 'pending_delivery' AND message_ts IS NULL`,
      JSON.stringify(record.spec),
      record.updatedAt,
      record.id,
      record.turnJobId,
      record.namespace,
    );
    this.db.run(
      `INSERT OR IGNORE INTO ui_surfaces (
        id, namespace, workspace_id, channel_id, thread_ts, conversation_thread_ts,
        conversation_kind, agent_id, turn_job_id, requester_user_id, spec_json, status,
        message_ts, resolution_json, created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      record.id,
      record.namespace,
      record.workspaceId,
      record.channelId,
      record.threadTs,
      record.conversationThreadTs,
      record.conversationKind,
      record.agentId,
      record.turnJobId,
      record.requesterUserId,
      JSON.stringify(record.spec),
      record.status,
      record.messageTs ?? null,
      record.createdAt,
      record.updatedAt,
      record.expiresAt,
    );
    return this.get(record.id)!;
  }

  get(id: string): UiSurfaceRecord | undefined {
    if (!UI_SURFACE_ID_PATTERN.test(id)) return undefined;
    const row = this.db.get('SELECT * FROM ui_surfaces WHERE id = ?', id) as UiSurfaceRow | undefined;
    return row ? decode(row) : undefined;
  }

  /** Record where the surface was posted; the first binding wins. */
  bindMessage(id: string, messageTs: string): UiSurfaceRecord | undefined {
    if (!/^\d{1,16}\.\d{1,16}$/.test(messageTs)) throw new Error('Slack message timestamp is invalid.');
    this.db.run(
      `UPDATE ui_surfaces
       SET message_ts = COALESCE(message_ts, ?),
           status = CASE WHEN status = 'pending_delivery' THEN 'open' ELSE status END,
           updated_at = ?
       WHERE id = ?`,
      messageTs,
      this.now(),
      id,
    );
    return this.get(id);
  }

  /**
   * First-wins resolution. Only an open, unexpired surface can resolve, and
   * the caller's namespace must match: a `ui` click never resolves a `host`
   * record. Composes inside the caller's transaction.
   */
  claim(input: UiSurfaceClaim, namespace: UiNamespace): UiSurfaceClaimOutcome {
    const now = this.now();
    const changed = this.db.run(
      `UPDATE ui_surfaces
       SET status = 'resolved', resolution_json = ?, updated_at = ?
       WHERE id = ? AND namespace = ? AND status IN ('open', 'pending_delivery') AND expires_at > ?`,
      JSON.stringify(input.resolution),
      now,
      input.surfaceId,
      namespace,
      now,
    ).changes === 1;
    const surface = this.get(input.surfaceId);
    return changed && surface ? { claimed: true, surface } : { claimed: false, ...(surface ? { surface } : {}) };
  }

  /** Close an open surface without an answer (expired, superseded, or failed). */
  close(id: string, status: Extract<UiSurfaceStatus, 'superseded' | 'expired' | 'failed'>): UiSurfaceRecord | undefined {
    this.db.run(
      `UPDATE ui_surfaces SET status = ?, updated_at = ?
       WHERE id = ? AND status IN ('open', 'pending_delivery')`,
      status,
      this.now(),
      id,
    );
    return this.get(id);
  }

  /**
   * Close the open surfaces of one kind in a thread, except those the current
   * turn owns, and return them so their cards can be redrawn.
   */
  supersede(
    scope: UiSurfaceScope,
    options: { exceptTurnJobId: string; kinds: readonly UiSurfaceSpec['kind'][] },
  ): UiSurfaceRecord[] {
    if (options.kinds.length === 0) return [];
    const closed: UiSurfaceRecord[] = [];
    for (const record of this.listOpen(scope, 20)) {
      if (record.turnJobId === options.exceptTurnJobId || !options.kinds.includes(record.spec.kind)) continue;
      const next = this.close(record.id, 'superseded');
      if (next?.status === 'superseded') closed.push(next);
    }
    return closed;
  }

  /**
   * Open surfaces in scope, newest first. A typed answer retires by approval
   * id across the channel, because a DM's approval can be typed in any of its
   * threads; supersede stays bound to one thread.
   */
  listOpen(scope: UiSurfaceScope, limit = 10): UiSurfaceRecord[] {
    const rows = this.db.all(
      `SELECT * FROM ui_surfaces
       WHERE workspace_id = ? AND channel_id = ? AND agent_id = ?
         AND (? IS NULL OR thread_ts = ?)
         AND status IN ('open', 'pending_delivery')
       ORDER BY created_at DESC LIMIT ?`,
      scope.workspaceId,
      scope.channelId,
      scope.agentId,
      scope.threadTs ?? null,
      scope.threadTs ?? null,
      Math.max(1, Math.min(50, limit)),
    ) as unknown as UiSurfaceRow[];
    return rows.flatMap((row) => {
      const record = decode(row);
      return record ? [record] : [];
    });
  }

  /** Every surface one turn created, oldest first. */
  listForTurn(turnJobId: string): UiSurfaceRecord[] {
    const rows = this.db.all(
      'SELECT * FROM ui_surfaces WHERE turn_job_id = ? ORDER BY created_at, id LIMIT 10',
      turnJobId,
    ) as unknown as UiSurfaceRow[];
    return rows.flatMap((row) => {
      const record = decode(row);
      return record ? [record] : [];
    });
  }

  /** Resolve an open surface outside admission (a typed answer retired it). */
  resolve(id: string, resolution: UiSurfaceResolution): UiSurfaceRecord | undefined {
    const now = this.now();
    this.db.run(
      `UPDATE ui_surfaces SET status = 'resolved', resolution_json = ?, updated_at = ?
       WHERE id = ? AND status IN ('open', 'pending_delivery')`,
      JSON.stringify(resolution),
      now,
      id,
    );
    return this.get(id);
  }

  /** One RPC entry point, so a remote state owner exposes a single method. */
  execute(request: UiSurfaceRpcRequest): UiSurfaceRpcResponse {
    switch (request.kind) {
      case 'put_surface':
        return { kind: 'surface', surface: this.put(request.record) };
      case 'get_surface':
        return { kind: 'surface', surface: this.get(request.id) ?? null };
      case 'bind_surface_message':
        return { kind: 'surface', surface: this.bindMessage(request.id, request.messageTs) ?? null };
      case 'close_surface':
        return { kind: 'surface', surface: this.close(request.id, request.status) ?? null };
      case 'resolve_surface':
        return { kind: 'surface', surface: this.resolve(request.id, request.resolution) ?? null };
      case 'supersede_surfaces':
        return {
          kind: 'surfaces',
          surfaces: this.supersede(request.scope, {
            exceptTurnJobId: request.exceptTurnJobId,
            kinds: request.kinds,
          }),
        };
      case 'list_open_surfaces':
        return { kind: 'surfaces', surfaces: this.listOpen(request.scope, request.limit) };
      case 'list_turn_surfaces':
        return { kind: 'surfaces', surfaces: this.listForTurn(request.turnJobId) };
    }
  }

  private purge(): void {
    this.db.run(
      `DELETE FROM ui_surfaces WHERE expires_at < ? AND updated_at < ?`,
      this.now() - RETAIN_SETTLED_MS,
      this.now() - RETAIN_SETTLED_MS,
    );
  }
}

function validateRecord(record: UiSurfaceRecord): void {
  if (!UI_SURFACE_ID_PATTERN.test(record.id)) throw new Error('UI surface id is invalid.');
  if (record.namespace !== 'ui' && record.namespace !== 'host') {
    throw new Error('UI surface namespace is invalid.');
  }
  if (!STATUSES.has(record.status)) throw new Error('UI surface status is invalid.');
  if (new TextEncoder().encode(JSON.stringify(record.spec)).byteLength > UI_SURFACE_MAX_SPEC_BYTES) {
    throw new Error('UI surface spec exceeds 16 KiB.');
  }
}

function decode(row: UiSurfaceRow): UiSurfaceRecord | undefined {
  try {
    if (!STATUSES.has(row.status as UiSurfaceStatus)) return undefined;
    if (row.namespace !== 'ui' && row.namespace !== 'host') return undefined;
    const record: UiSurfaceRecord = {
      id: row.id,
      namespace: row.namespace,
      workspaceId: row.workspace_id,
      channelId: row.channel_id,
      threadTs: row.thread_ts,
      conversationThreadTs: row.conversation_thread_ts,
      conversationKind: row.conversation_kind === 'im' ? 'im' : 'channel',
      agentId: row.agent_id,
      turnJobId: row.turn_job_id,
      requesterUserId: row.requester_user_id,
      spec: JSON.parse(row.spec_json) as UiSurfaceSpec,
      status: row.status as UiSurfaceStatus,
      ...(row.message_ts ? { messageTs: row.message_ts } : {}),
      ...(row.resolution_json
        ? { resolution: JSON.parse(row.resolution_json) as UiSurfaceResolution }
        : {}),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      expiresAt: Number(row.expires_at),
    };
    return record;
  } catch {
    return undefined;
  }
}
