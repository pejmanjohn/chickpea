import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';

import type { TailSegment } from './types.ts';

/**
 * `wrangler tail --format json` prints pretty-printed objects back to back
 * (docs/runbooks/runtime-observability.md). Split on top-level braces,
 * string-aware, and drop fragments that do not parse (a restart can cut one).
 */
export function splitJsonObjects(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    // Wrangler starts every top-level object at column 0 and JSON strings hold
    // no raw newlines, so a newline or a line-leading brace ends a torn object.
    if (c === '\n' && inString) { inString = false; escaped = false; depth = 0; continue; }
    if (c === '{' && (i === 0 || text[i - 1] === '\n') && depth > 0) depth = 0;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { if (depth > 0) inString = true; continue; }
    if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}' && depth > 0 && --depth === 0) {
      try {
        const value = JSON.parse(text.slice(start, i + 1));
        if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value);
      } catch { /* a torn object from a restarted segment */ }
    }
  }
  return out;
}

export interface TurnLatencyRow {
  at: number;
  entrypoint: string;
  version: string;
  turnRef?: string;
  runRef?: string;
  executor?: string;
  attempt?: number;
  outcome?: string;
  firstWrite?: string;
  final?: string;
  admissionToStartMs?: number;
  admissionToFirstWriteMs?: number;
  admissionToFinalMs?: number;
  receiptToAdmissionMs?: number;
  receiptToFirstWriteMs?: number;
  attemptMs?: number;
}

export interface GatewayDeliveryRow { at: number; outcome?: string; transport?: string; deliveryKind?: string; lagMs?: number; slackLagMs?: number }
export interface FiberRow { at: number; version: string; type: string; fiberName?: string; fiberId?: string; reason?: string; elapsedMs?: number }
export interface SignalRow { at: number; kind: SignalKind; entrypoint: string; version: string; text: string }

export const SIGNALS = {
  noAssignment: /no assignment for turn/i,
  rateLimited: /gateway_rate_limited|rate[_ -]?limited|ratelimited/i,
  gatewayRejected: /gateway_rejected/,
  admissionDeferred: /turn admission deferred/i,
  reattachFailed: /durable reattachment failed/i,
  recoveryFailed: /durable recovery final failed|exhausted durable reattachment/i,
  agentRunFailed: /agent run failed/i,
  stateStoreUnavailable: /state store unavailable/i,
  streamRecovery: /stream recovery unknown/i,
  codeUpdated: /reset because its code was updated/i,
} as const;
export type SignalKind = keyof typeof SIGNALS;

export interface RuntimeExtract {
  objects: number;
  versions: string[];
  turnLatency: TurnLatencyRow[];
  gatewayDelivery: GatewayDeliveryRow[];
  fibers: FiberRow[];
  signals: SignalRow[];
  outcomes: Record<string, number>;
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

function copyDefined<T extends object>(target: T, source: Record<string, unknown>, keys: string[], pick: (v: unknown) => unknown): void {
  for (const key of keys) {
    const value = pick(source[key]);
    if (value !== undefined) (target as Record<string, unknown>)[key] = value;
  }
}

/** Pull runtime latency events, fiber diagnostics and failure signals out of a capture. */
export function extractRuntime(objects: Array<Record<string, unknown>>): RuntimeExtract {
  const result: RuntimeExtract = { objects: objects.length, versions: [], turnLatency: [], gatewayDelivery: [], fibers: [], signals: [], outcomes: {} };
  const versions = new Set<string>();
  for (const o of objects) {
    const version = str((o.scriptVersion as Record<string, unknown> | undefined)?.id)?.slice(0, 8) ?? '';
    if (version) versions.add(version);
    const entrypoint = str(o.entrypoint) ?? '-';
    const outcome = str(o.outcome);
    if (outcome) result.outcomes[outcome] = (result.outcomes[outcome] ?? 0) + 1;
    const signal = (at: number, text: string) => {
      for (const [kind, pattern] of Object.entries(SIGNALS) as Array<[SignalKind, RegExp]>) {
        if (pattern.test(text)) result.signals.push({ at, kind, entrypoint, version, text: text.slice(0, 200) });
      }
    };
    for (const log of (Array.isArray(o.logs) ? o.logs : []) as Array<Record<string, unknown>>) {
      const at = num(log.timestamp) ?? num(o.eventTimestamp) ?? 0;
      const parts: string[] = [];
      for (const m of (Array.isArray(log.message) ? log.message : []) as unknown[]) {
        if (m && typeof m === 'object' && !Array.isArray(m)) {
          const record = m as Record<string, unknown>;
          if (record.event === 'turn_latency') {
            const row: TurnLatencyRow = { at, entrypoint, version };
            copyDefined(row, record, ['turnRef', 'runRef', 'executor', 'outcome', 'firstWrite', 'final'], str);
            copyDefined(row, record, ['attempt', 'admissionToStartMs', 'admissionToFirstWriteMs', 'admissionToFinalMs', 'receiptToAdmissionMs', 'receiptToFirstWriteMs', 'attemptMs'], num);
            result.turnLatency.push(row);
          } else if (record.event === 'gateway_delivery') {
            const row: GatewayDeliveryRow = { at };
            copyDefined(row, record, ['outcome', 'transport', 'deliveryKind'], str);
            copyDefined(row, record, ['lagMs', 'slackLagMs'], num);
            result.gatewayDelivery.push(row);
          }
          parts.push(JSON.stringify(record));
        } else if (typeof m === 'string') parts.push(m);
      }
      signal(at, parts.join(' '));
    }
    for (const ex of (Array.isArray(o.exceptions) ? o.exceptions : []) as Array<Record<string, unknown>>) {
      signal(num(ex.timestamp) ?? num(o.eventTimestamp) ?? 0, `${str(ex.name) ?? ''}: ${str(ex.message) ?? ''}`);
    }
    for (const d of (Array.isArray(o.diagnosticsChannelEvents) ? o.diagnosticsChannelEvents : []) as Array<Record<string, unknown>>) {
      const m = (d.message ?? {}) as Record<string, unknown>;
      const type = str(m.type);
      if (!type?.startsWith('fiber:')) continue;
      const p = (m.payload ?? {}) as Record<string, unknown>;
      const row: FiberRow = { at: num(m.timestamp) ?? num(d.timestamp) ?? 0, version, type };
      const fiberName = str(p.fiberName), fiberId = str(p.fiberId), reason = str(p.recoveryReason), elapsedMs = num(p.elapsedMs);
      if (fiberName) row.fiberName = fiberName;
      if (fiberId) row.fiberId = fiberId;
      if (reason) row.reason = reason;
      if (elapsedMs !== undefined) row.elapsedMs = elapsedMs;
      result.fibers.push(row);
    }
  }
  result.versions = [...versions];
  for (const list of [result.turnLatency, result.gatewayDelivery, result.fibers, result.signals]) list.sort((a, b) => a.at - b.at);
  return result;
}

/**
 * A bounded `wrangler tail` capture that restarts when the stream exits or
 * stalls, like the verifiers' earlier loop. The account comes from the
 * operator's environment (`CLOUDFLARE_ACCOUNT_ID`); it is never logged.
 */
export class TailCapture {
  readonly segments: TailSegment[] = [];
  private child: ChildProcess | null = null;
  private out: WriteStream;
  private err: WriteStream;
  private stopped = false;
  private lastByteAt = Date.now();
  private watchdog: NodeJS.Timeout | null = null;
  private readyWaiters: Array<() => void> = [];

  constructor(private readonly options: { worker: string; file: string; errFile: string; cwd: string; stallMs?: number; command?: string[]; env?: NodeJS.ProcessEnv }) {
    this.out = createWriteStream(options.file, { flags: 'a', mode: 0o600 });
    this.err = createWriteStream(options.errFile, { flags: 'a', mode: 0o600 });
  }

  start(): void {
    this.spawnSegment();
    this.watchdog = setInterval(() => {
      if (this.child && Date.now() - this.lastByteAt > (this.options.stallMs ?? 180_000)) {
        const current = this.segments.at(-1);
        if (current) current.reason = 'stall';
        this.child.kill('SIGINT');
      }
    }, 1000);
  }

  /** Resolves once the current segment reports it is connected, or after the timeout. */
  waitReady(timeoutMs: number): Promise<boolean> {
    if (this.segments.at(-1)?.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.readyWaiters.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  private spawnSegment(): void {
    const command = this.options.command ?? ['npx', 'wrangler', 'tail', this.options.worker, '--format', 'json'];
    const segment: TailSegment = { start: Date.now(), end: null, ready: null, exit: null };
    this.segments.push(segment);
    this.lastByteAt = Date.now();
    const child = spawn(command[0]!, command.slice(1), { cwd: this.options.cwd, env: this.options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const markReady = (chunk: Buffer) => {
      if (!segment.ready && /connected to|waiting for logs|successfully created tail/i.test(chunk.toString('utf8'))) {
        segment.ready = Date.now();
        for (const waiter of this.readyWaiters.splice(0)) waiter();
      }
    };
    child.stdout!.on('data', (chunk: Buffer) => { this.lastByteAt = Date.now(); markReady(chunk); this.out.write(chunk); });
    child.stderr!.on('data', (chunk: Buffer) => { markReady(chunk); this.err.write(chunk); });
    child.on('exit', (code) => {
      segment.end = Date.now();
      segment.exit = code;
      this.child = null;
      if (!this.stopped) setTimeout(() => { if (!this.stopped) this.spawnSegment(); }, 2000);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    const child = this.child;
    if (child) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill('SIGINT');
      });
    }
    await Promise.all([this.out, this.err].map((stream) => new Promise<void>((resolve) => stream.end(resolve))));
  }
}
