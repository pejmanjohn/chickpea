#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  diagnoseLiveTarget,
  parseDoctorSnapshot,
  type DoctorResult,
  type DoctorSnapshot,
} from './doctor.ts';
import type { RunnerRecord } from './state.ts';

export interface CliErrorRecord {
  kind: 'error';
  code: string;
}

export type CliRecord = DoctorResult | RunnerRecord | CliErrorRecord;

export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
  readJson(path: string): unknown;
}

const DEFAULT_IO: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  readJson: (path) => JSON.parse(readFileSync(path, 'utf8')) as unknown,
};

export function executeLiveCli(argv: readonly string[], io: CliIo = DEFAULT_IO): CliRecord {
  const [command, ...rest] = argv;
  const args = parseArguments(rest);
  if (args.has('cleanup-result') || args.has('cleanup-variant')) {
    throw new CliUsageError('CLEANUP_RECEIPT_REQUIRED');
  }
  if (command === 'doctor') {
    const { overlay, snapshot } = readInputs(args, io);
    return diagnoseLiveTarget({ overlay, source: { read: () => snapshot } });
  }
  if (command !== 'case' && command !== 'smoke' && command !== 'deep') {
    throw new CliUsageError('UNKNOWN_COMMAND');
  }
  // V0 intentionally exposes no shell path for supplying scored outcomes.
  // V1 will call the runner through its attended Computer Use coordinator,
  // after challenge-bound receipts and visible assertions are durable.
  throw new CliUsageError('COORDINATOR_REQUIRED');
}

export function serializeCliRecord(record: CliRecord): string {
  return JSON.stringify(record);
}

export function renderHumanRecord(record: CliRecord): string {
  switch (record.kind) {
    case 'doctor':
      return record.ready
        ? 'Doctor: ready'
        : `Doctor: blocked (${record.diagnostics.map(({ code }) => code).join(', ')})`;
    case 'action_required':
      return [
        `Action required: ${record.variantId} / ${record.actionRef}`,
        `Action: ${record.semanticAction}`,
        `Fixtures: ${record.fixtureAliases.join(', ')}`,
      ].join('\n');
    case 'assertion':
      return `Assertions required: ${record.variantId} (${record.tokens.map(({ token }) => token).join(', ')})`;
    case 'waiting':
      return `Waiting: ${record.variantId} / ${record.waitingFor}`;
    case 'terminal':
      return [
        `Run ${record.runId}: ${record.report.aggregate}`,
        `Executed (${record.report.inventory.executed.count}): ${record.report.inventory.executed.variantIds.join(', ')}`,
        `Blocked (${record.report.inventory.blocked.count}): ${record.report.inventory.blocked.variantIds.join(', ')}`,
      ].join('\n');
    case 'error':
      return `Live verifier error: ${record.code}`;
  }
}

export function runLiveCli(argv: readonly string[], io: CliIo = DEFAULT_IO): number {
  let record: CliRecord;
  try {
    record = executeLiveCli(argv, io);
  } catch (error) {
    record = safeErrorRecord(error);
  }
  io.stdout(`${serializeCliRecord(record)}\n`);
  io.stderr(`${renderHumanRecord(record)}\n`);
  return exitCode(record);
}

class CliUsageError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'CliUsageError';
    this.code = code;
  }
}

function readInputs(args: Map<string, string[]>, io: CliIo): { overlay: unknown; snapshot: DoctorSnapshot } {
  const overlay = io.readJson(one(args, 'target'));
  const snapshot = parseDoctorSnapshot(io.readJson(one(args, 'snapshot')));
  return { overlay, snapshot };
}

function parseArguments(argv: readonly string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !/^--[a-z][a-z0-9-]*$/.test(flag) || value === undefined || value.startsWith('--')) {
      throw new CliUsageError('INVALID_ARGUMENTS');
    }
    const key = flag.slice(2);
    result.set(key, [...(result.get(key) ?? []), value]);
  }
  return result;
}

function one(args: Map<string, string[]>, key: string): string {
  const values = args.get(key);
  if (values?.length !== 1) throw new CliUsageError(`REQUIRED_${key.toUpperCase().replaceAll('-', '_')}`);
  return values[0] as string;
}

function safeErrorRecord(error: unknown): CliErrorRecord {
  if (error instanceof CliUsageError) return { kind: 'error', code: error.code };
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return { kind: 'error', code: error.code };
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)) {
    return { kind: 'error', code: error.message };
  }
  return { kind: 'error', code: 'LIVE_VERIFIER_FAILED' };
}

function exitCode(record: CliRecord): number {
  if (record.kind === 'error') return 64;
  if (record.kind === 'doctor') return record.ready ? 0 : 2;
  if (record.kind !== 'terminal') return 0;
  if (record.report.aggregate === 'pass') return 0;
  if (record.report.aggregate === 'fail') return 1;
  return 2;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = runLiveCli(process.argv.slice(2));
}
