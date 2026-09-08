import { createHash } from 'node:crypto';

import type { AssertionToken } from '../schema.ts';

export interface FoundationEvaluation<Failure extends string> {
  pass: boolean;
  observedTokens: AssertionToken[];
  failures: Failure[];
}

export function upstreamRecord(input: unknown): Record<string, unknown> {
  if (!isRecord(input) || 'observedTokens' in input) throw new Error('INVALID_UPSTREAM_SHAPE');
  return input;
}

export function objectAt(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = input[key];
  if (!isRecord(value)) throw new Error('INVALID_UPSTREAM_SHAPE');
  return value;
}

export function maybeObject(input: unknown): Record<string, unknown> | undefined {
  return isRecord(input) ? input : undefined;
}

export function recordsAt(input: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = input[key];
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error('INVALID_UPSTREAM_SHAPE');
  return value;
}

export function stringsAt(input: Record<string, unknown>, key: string): string[] {
  const value = input[key];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
    throw new Error('INVALID_UPSTREAM_SHAPE');
  }
  return value;
}

export function stringAt(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || value.length === 0) throw new Error('INVALID_UPSTREAM_SHAPE');
  return value;
}

export function integerAt(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  if (!Number.isSafeInteger(value)) throw new Error('INVALID_UPSTREAM_SHAPE');
  return value as number;
}

export function markerAt(input: Record<string, unknown>): string {
  const marker = stringAt(objectAt(input, 'request'), 'runMarker');
  if (!/^qa-[a-z0-9]{6,40}$/u.test(marker)) throw new Error('INVALID_UPSTREAM_SHAPE');
  return marker;
}

export function sha256Utf8(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

export function sha256Base64(value: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(value, 'base64')).digest('hex')}`;
}

export function result<Failure extends string>(
  observedTokens: FoundationEvaluation<Failure>['observedTokens'],
  failures: Failure[],
): FoundationEvaluation<Failure> {
  return {
    pass: failures.length === 0,
    observedTokens: [...new Set(observedTokens)],
    failures: [...new Set(failures)],
  };
}

export function hasSettledActivity(admin: Record<string, unknown>): boolean {
  const presentation = objectAt(admin, 'presentation');
  const projection = objectAt(presentation, 'activityProjection');
  return projection.state === 'cleared' || projection.state === 'not_required';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}
