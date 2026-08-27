#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const options = parseArguments(process.argv.slice(2));
const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
validateManifest(manifest);

assert.ok(
  options.normalEvents.length >= 10,
  'At least ten isolated normal-timing captures are required',
);
const normalCaptures = options.normalEvents.map((path) =>
  parseEvents(readFileSync(path, 'utf8'))
);
let specificAcknowledgedTurns = 0;
for (const [index, events] of normalCaptures.entries()) {
  assertNativeOnly(events, `normal capture ${index + 1}`);
  assert.ok(events.some((event) =>
    event.event === 'activity.work' &&
    event.family === 'managed_connector' &&
    event.durationMs >= 1_000
  ), `Normal capture ${index + 1} is not an eligible managed turn`);
  if (hasAcknowledgedPhase(events, 'managed_connector', 'working')) {
    specificAcknowledgedTurns += 1;
  }
  assertAcknowledgedClear(events, `normal capture ${index + 1}`);
}

const diagnosticEvents = parseEvents(readFileSync(options.diagnosticEvents, 'utf8'));
assertNativeOnly(diagnosticEvents, 'diagnostic capture');
const diagnosticCursor = assertOrderedAcknowledgedPhases(diagnosticEvents, [
  ['unknown', 'thinking'],
  ['managed_connector', 'working'],
  ['managed_connector', 'reviewing'],
  ['response', 'drafting'],
]);
assert.notEqual(diagnosticEvents.findIndex((event, index) =>
  index >= diagnosticCursor &&
  event.event === 'activity.clear' &&
  event.surface === 'assistant_status' &&
  event.outcome === 'acknowledged'
), -1, 'The diagnostic status was not cleared after its final acknowledged phase');

const eligibleManagedTurns = normalCaptures.length;
const ratio = specificAcknowledgedTurns / eligibleManagedTurns;
assert.ok(ratio >= 0.9, 'Eligible managed turns did not meet the 90% specific-status gate');

console.log(JSON.stringify({
  ok: true,
  normalEventCount: normalCaptures.reduce((total, events) => total + events.length, 0),
  diagnosticEventCount: diagnosticEvents.length,
  eligibleManagedTurns,
  specificAcknowledgedTurns,
  specificAcknowledgedRatio: ratio,
  progressMessageCalls: manifest.progressMessageCalls,
  priorVersionRestored: manifest.priorVersionRestored,
  rawCaptureDeleted: manifest.rawCaptureDeleted,
}, null, 2));

function parseArguments(args) {
  const parsed = { normalEvents: [] };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value) usage();
    if (flag === '--normal-events') parsed.normalEvents.push(value);
    else if (flag === '--diagnostic-events') parsed.diagnosticEvents = value;
    else if (flag === '--manifest') parsed.manifest = value;
    else usage();
  }
  if (parsed.normalEvents.length === 0 || !parsed.diagnosticEvents || !parsed.manifest) usage();
  return parsed;
}

function usage() {
  throw new Error(
    'Usage: verify-semantic-activity-status-live.mjs '
      + '--normal-events <isolated-sanitized-jsonl> (repeat 10+) '
      + '--diagnostic-events <isolated-sanitized-jsonl> '
      + '--manifest <content-free-json>',
  );
}

function assertNativeOnly(events, label) {
  assert.ok(events.length > 0, `No semantic activity events in ${label}`);
  assert.equal(
    events.some((event) => event.surface === 'legacy_message'),
    false,
    `${label} contains legacy message activity; new work must be native-only`,
  );
}

function hasAcknowledgedPhase(events, family, phase) {
  return events.some((event) =>
    event.event === 'activity.transport' &&
    event.surface === 'assistant_status' &&
    event.outcome === 'acknowledged' &&
    event.family === family &&
    event.phase === phase
  );
}

function assertAcknowledgedClear(events, label) {
  assert.ok(events.some((event) =>
    event.event === 'activity.clear' &&
    event.surface === 'assistant_status' &&
    event.outcome === 'acknowledged'
  ), `${label} did not acknowledge the native semantic status clear`);
}

function parseEvents(input) {
  const prefix = '[chickpea:activity] ';
  return input.split(/\r?\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const json = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed;
    const event = JSON.parse(json);
    validateEvent(event);
    return [event];
  });
}

function validateEvent(event) {
  assert.ok(event && typeof event === 'object' && !Array.isArray(event), 'Invalid event');
  assert.equal(event.schemaVersion, 1, 'Unsupported telemetry schema');
  switch (event.event) {
    case 'activity.produced':
      exactKeys(event, ['schemaVersion', 'event', 'family', 'phase', 'observed']);
      oneOf(event.family, [
        'managed_connector', 'custom_connection', 'skill', 'repository', 'memory',
        'scheduled_work', 'workspace', 'connection_setup', 'agent_authoring',
        'artifact', 'response', 'unknown', 'internal',
      ]);
      oneOf(event.phase, ['thinking', 'working', 'reviewing', 'drafting', 'reassessing']);
      assert.equal(typeof event.observed, 'boolean');
      break;
    case 'activity.queue':
      exactKeys(event, [
        'schemaVersion', 'event', 'layer', 'disposition', 'observed', 'durationMs',
      ], ['durationMs']);
      oneOf(event.layer, ['relay', 'presentation']);
      oneOf(event.disposition, [
        'enqueued', 'coalesced', 'duplicate', 'superseded', 'stale_dropped',
        'terminal_dropped', 'throttled', 'relay_failed',
      ]);
      assert.equal(typeof event.observed, 'boolean');
      optionalDuration(event.durationMs);
      break;
    case 'activity.transport':
      exactKeys(event, [
        'schemaVersion', 'event', 'surface', 'outcome', 'family', 'phase', 'durationMs',
      ], ['durationMs']);
      oneOf(event.surface, ['assistant_status', 'legacy_message']);
      oneOf(event.outcome, ['acknowledged', 'rejected', 'ambiguous', 'latched_off']);
      oneOf(event.family, [
        'managed_connector', 'custom_connection', 'skill', 'repository', 'memory',
        'scheduled_work', 'workspace', 'connection_setup', 'agent_authoring',
        'artifact', 'response', 'unknown', 'internal',
      ]);
      oneOf(event.phase, ['thinking', 'working', 'reviewing', 'drafting', 'reassessing']);
      optionalDuration(event.durationMs);
      break;
    case 'activity.clear':
      exactKeys(event, [
        'schemaVersion', 'event', 'surface', 'outcome', 'late', 'durationMs',
      ], ['late', 'durationMs']);
      oneOf(event.surface, ['assistant_status', 'legacy_message']);
      oneOf(event.outcome, ['acknowledged', 'rejected', 'ambiguous', 'skipped']);
      if (event.late !== undefined) assert.equal(typeof event.late, 'boolean');
      optionalDuration(event.durationMs);
      break;
    case 'activity.refresh':
      exactKeys(event, [
        'schemaVersion', 'event', 'outcome', 'durationMs',
      ], ['durationMs']);
      oneOf(event.outcome, ['scheduled', 'attempted', 'canceled', 'stale_dropped']);
      optionalDuration(event.durationMs);
      break;
    case 'activity.rate':
      exactKeys(event, [
        'schemaVersion', 'event', 'outcome', 'durationMs',
      ], ['durationMs']);
      oneOf(event.outcome, ['reserved', 'cooldown', 'exhausted', 'unavailable']);
      optionalDuration(event.durationMs);
      break;
    case 'activity.work':
      exactKeys(event, [
        'schemaVersion', 'event', 'family', 'outcome', 'durationMs',
      ]);
      oneOf(event.family, [
        'managed_connector', 'custom_connection', 'skill', 'repository', 'memory',
        'scheduled_work', 'workspace', 'connection_setup', 'agent_authoring',
        'artifact', 'response', 'unknown', 'internal',
      ]);
      oneOf(event.outcome, ['succeeded', 'failed', 'ambiguous']);
      optionalDuration(event.durationMs);
      break;
    default:
      assert.fail('Unknown semantic activity event');
  }
}

function exactKeys(value, allowed, optional = []) {
  const keys = Object.keys(value);
  assert.equal(keys.every((key) => allowed.includes(key)), true, 'Unsafe event field');
  for (const required of allowed.filter((key) => !optional.includes(key))) {
    assert.equal(keys.includes(required), true, 'Missing event field');
  }
}

function oneOf(value, allowed) {
  assert.equal(typeof value === 'string' && allowed.includes(value), true, 'Invalid event enum');
}

function optionalDuration(value) {
  if (value === undefined) return;
  assert.ok(Number.isInteger(value) && value >= 0 && value <= 300_000, 'Invalid event duration');
}

function validateManifest(manifest) {
  assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest));
  const allowed = new Set([
    'syntheticMailbox', 'readOnlyQuery', 'unmodifiedTiming', 'diagnosticTrace',
    'progressMessageCalls', 'priorVersionRestored', 'rawCaptureDeleted',
  ]);
  assert.equal(Object.keys(manifest).every((key) => allowed.has(key)), true);
  for (const field of [
    'syntheticMailbox', 'readOnlyQuery', 'unmodifiedTiming',
    'priorVersionRestored', 'rawCaptureDeleted',
  ]) assert.equal(manifest[field], true, `${field} must be true`);
  assert.equal(manifest.progressMessageCalls, 0, 'Activity progress-message calls must be zero');
  assert.equal(manifest.diagnosticTrace, true, 'diagnosticTrace must be true');
}

function assertOrderedAcknowledgedPhases(events, expected) {
  let cursor = 0;
  for (const [family, phase] of expected) {
    const producedIndex = events.findIndex((event, index) =>
      index >= cursor &&
      event.event === 'activity.produced' &&
      event.family === family &&
      event.phase === phase
    );
    assert.notEqual(producedIndex, -1, `Missing ordered ${family}/${phase} phase`);
    const acknowledgedIndex = events.findIndex((event, index) =>
      index > producedIndex &&
      event.event === 'activity.transport' &&
      event.surface === 'assistant_status' &&
      event.outcome === 'acknowledged' &&
      event.family === family &&
      event.phase === phase
    );
    assert.notEqual(
      acknowledgedIndex,
      -1,
      `The ordered ${family}/${phase} phase was not acknowledged by native status`,
    );
    cursor = acknowledgedIndex + 1;
  }
  return cursor;
}
