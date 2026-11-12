import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
// @ts-expect-error Release tooling JavaScript helper.
import { readSurface } from '../scripts/lib/rpc-surface.mjs';
// @ts-expect-error Release tooling JavaScript helper.
import { commitReasons, compareSurfaces, judge, subjectDigest, subjectValue } from '../scripts/lib/rpc-contract.mjs';
// @ts-expect-error Release tooling JavaScript helper.
import { keptReasons } from '../scripts/verify-rpc-contract.mjs';

type Change = { subject: string; kind: string; path: string; says: string; allowed: boolean };
type Surface = {
  classes: Record<string, { base?: string; methods: Record<string, { params: { type: unknown }[]; returns: unknown; fallback?: boolean }> }>;
  payloads: Record<string, unknown>;
  external: Record<string, string>;
  types: Record<string, unknown>;
};

const FIXTURE: Record<string, string> = {
  'package.json': '{ "type": "module" }',
  'package-lock.json': '{ "packages": {} }',
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2024', lib: ['ES2024', 'DOM'], module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      exactOptionalPropertyTypes: true, allowImportingTsExtensions: true, noEmit: true, types: [],
    },
    include: ['src/**/*.ts', 'types/**/*.d.ts'],
  }),
  'wrangler.jsonc': `{
    // A retired class is not part of the contract.
    "migrations": [
      { "tag": "v1", "new_sqlite_classes": ["TagStateStore", "FlueDemoThreadV1Agent", "Retired"] },
      { "tag": "v2", "deleted_classes": ["Retired"] },
    ],
  }`,
  'types/cloudflare-workers.d.ts': `declare module 'cloudflare:workers' {
    export class DurableObject { constructor(ctx: unknown, env: unknown); }
  }`,
  'src/types.ts': `export interface Job { id: string; threadKey: string; installation?: string }
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type Status = 'idle' | 'running';`,
  'src/store.ts': `import { DurableObject } from 'cloudflare:workers';
import type { Job, Result, Status } from './types.ts';
export class TagStateStore extends DurableObject {
  private count = 0;
  async admit(job: Job): Promise<Result<{ admitted: boolean }>> { this.count += job.id.length; return { ok: true, value: { admitted: true } }; }
  async status(threadKey: string): Promise<Status> { return threadKey ? 'idle' : 'running'; }
  async listAgents(): Promise<Result<string[]>> { return { ok: true, value: [] }; }
  private async hidden(): Promise<void> { await this.status(''); }
  static make(): void {}
}`,
  'src/agent.ts': `type ObjectClass = new (...args: never[]) => object;
function installationObject(Base: ObjectClass): ObjectClass {
  return class InstallationObject extends (Base as new (...args: never[]) => object) {
    async chickpeaHostErase(request: { installationId: string }): Promise<void> { void request; }
  };
}
export class DemoThread { static agentName: string; }
DemoThread.agentName = 'demo-thread-v1';
export const cloudflare = {
  base: (Base: ObjectClass): ObjectClass => class DemoThreadObject extends (installationObject(Base) as new (...args: never[]) => object) {
    async chickpeaWake(sentAt?: number): Promise<void> { void sentAt; }
  },
};`,
  'src/config/store-fallback.ts': `export async function withStoreFallback<T>(method: string, call: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  void method;
  try { return await call(); } catch { return fallback(); }
}`,
  'src/caller.ts': `import { withStoreFallback } from './config/store-fallback.ts';
interface StoreStub { listAgents(): Promise<unknown>; status(threadKey: string): Promise<unknown> }
export const list = (stub: StoreStub) => withStoreFallback('listAgents', () => stub.listAgents(), async () => []);
export const status = (stub: StoreStub) => stub.status('k');`,
};

function surfaceOf(edits: Record<string, [string, string][]> = {}, extra: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rpc-contract-fixture-'));
  try {
    for (const [file, original] of Object.entries({ ...FIXTURE, ...extra })) {
      let text = original;
      for (const [from, to] of edits[file] ?? []) {
        assert.ok(text.includes(from), `fixture edit target in ${file}: ${from}`);
        text = text.replace(from, to);
      }
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
    return readSurface(root, { payloads: [{ name: 'Job', source: 'src/types.ts', note: 'admit(job)' }] }) as { surface: Surface; callersOf(name: string): string[] };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const base = surfaceOf();
const verdictOf = (head: Surface) => judge(compareSurfaces(base.surface, head), head) as Record<'noted' | 'accepted' | 'refused', Change[]>;
const brief = (changes: Change[]) => changes.map(({ subject, kind, path: where }) => `${subject}${where ? ` ${where}` : ''}: ${kind}`).sort();

test('reads each deployed class, through its mixins, with every named type defined once', () => {
  const { surface, callersOf } = base;
  assert.deepEqual(Object.keys(surface.classes), ['FlueDemoThreadV1Agent', 'TagStateStore'], 'the retired class is left out');
  assert.deepEqual(Object.keys(surface.classes.TagStateStore!.methods), ['admit', 'listAgents', 'status'],
    'private, static and field members are not RPC methods');
  assert.deepEqual(Object.keys(surface.classes.FlueDemoThreadV1Agent!.methods), ['chickpeaHostErase', 'chickpeaWake']);
  assert.match(surface.classes.FlueDemoThreadV1Agent!.base!, /^@flue\/runtime /);
  const admit = surface.classes.TagStateStore!.methods.admit!;
  assert.deepEqual(admit.params.map(({ type }) => type), ['#Job']);
  assert.deepEqual(admit.returns, { ref: '#Result', args: [{ object: { admitted: 'boolean' } }] }, 'the awaited return');
  assert.deepEqual(surface.types.Job, { object: { id: 'string', 'installation?': 'string', threadKey: 'string' } });
  assert.equal(surface.classes.TagStateStore!.methods.listAgents!.fallback, true);
  assert.equal(surface.classes.TagStateStore!.methods.status!.fallback, undefined);
  assert.deepEqual(callersOf('status'), ['src/caller.ts:4'], 'the class\'s own call is not a caller');
});

test('refuses a removed method, a renamed one and a changed parameter', () => {
  const { surface } = surfaceOf({
    'src/store.ts': [
      ['  async listAgents(): Promise<Result<string[]>> { return { ok: true, value: [] }; }\n', ''],
      ['async status(threadKey: string)', 'async statusOf(threadKey: string)'],
      ["await this.status('')", "await this.statusOf('')"],
    ],
    'src/types.ts': [['threadKey: string;', 'threadKey: number;']],
  });
  const verdict = verdictOf(surface);
  assert.deepEqual(brief(verdict.refused), [
    'TagStateStore.listAgents: method-removed',
    'TagStateStore.status: method-removed',
    'type Job .threadKey: type-changed',
  ]);
  assert.deepEqual(brief(verdict.noted), ['TagStateStore.statusOf: method-added'], 'the new name is an addition');
});

test('refuses a narrowed return and a field the other build lacks', () => {
  const { surface } = surfaceOf({
    'src/types.ts': [
      ["'idle' | 'running'", "'idle'"],
      ['id: string;', 'id: string; attempt: number;'],
      ['installation?: string', 'installation: string'],
    ],
    'src/agent.ts': [['request: { installationId: string }', 'request: { installation: string }']],
  });
  assert.deepEqual(brief(verdictOf(surface).refused), [
    'FlueDemoThreadV1Agent.chickpeaHostErase (request): field-added',
    'FlueDemoThreadV1Agent.chickpeaHostErase (request): field-removed',
    'TagStateStore.status →: member-removed',
    'type Job: field-added',
    'type Job: field-required',
  ]);
});

test('notes what only head code can use: a method, an optional parameter or field, a union member', () => {
  const { surface } = surfaceOf({
    'src/types.ts': [
      ["'idle' | 'running'", "'idle' | 'running' | 'stopped'"],
      ['installation?: string', 'installation?: string; attempt?: number'],
    ],
    'src/store.ts': [['async listAgents()', 'async ping(): Promise<boolean> { return true; }\n  async listAgents()']],
    'src/agent.ts': [['chickpeaWake(sentAt?: number)', 'chickpeaWake(sentAt?: number, turnJobId?: string)']],
  });
  const verdict = verdictOf(surface);
  assert.deepEqual(verdict.refused, []);
  assert.deepEqual(brief(verdict.noted), [
    'FlueDemoThreadV1Agent.chickpeaWake: param-added',
    'TagStateStore.ping: method-added',
    'type Job: field-added',
    'type Status: member-added',
  ]);
});

test('fails loudly on a deployed class it cannot read', () => {
  const wrangler = FIXTURE['wrangler.jsonc']!.replace('"Retired"] }', '"Retired", "Mystery"] }');
  assert.throws(() => surfaceOf({}, { 'wrangler.jsonc': wrangler }), /Mystery: wrangler.jsonc deploys it/);
});

const single = (methods: Surface['classes'][string]['methods'], types: Surface['types'] = {}): Surface =>
  ({ classes: { S: { methods } }, payloads: {}, external: {}, types });
const method = (type: unknown, returns: unknown = 'void') => ({ params: [{ name: 'input', type }], returns });

test('pairs union members by their fields, so a deep addition is not a removed member', () => {
  const settled = (result: Record<string, unknown>) => ({
    union: [
      { object: { outcome: { union: ['"aborted"', '"failed"'] }, kind: '"limit"', at: 'number' } },
      { object: { outcome: { union: ['"aborted"', '"failed"'] }, at: 'number' } },
      { object: { outcome: '"completed"', at: 'number', result: { object: result } } },
    ],
  });
  const before = single({ settle: method('#Settled') }, { Settled: settled({ text: 'string', 'chain?': 'number' }) });
  const after = single({ settle: method('#Settled') }, { Settled: settled({ text: 'string', 'chain?': 'number', 'usage?': 'number' }) });
  assert.deepEqual(brief(compareSurfaces(before, after)), ['type Settled |outcome="completed" .result: field-added']);
  const dropped = single({ settle: method('#Settled') }, { Settled: settled({ text: 'string' }) });
  assert.deepEqual(brief(judge(compareSurfaces(before, dropped), dropped).refused),
    ['type Settled |outcome="completed" .result: field-removed'], 'an optional field removed may be a rename');
});

test('a reason accepts a refused change only while it names the change', () => {
  const before = single({ gone: method('string'), kept: method('string') });
  const after = single({ kept: method('number') });
  const changes = compareSurfaces(before, after);
  assert.deepEqual(brief(judge(changes, after).refused), ['S.gone: method-removed', 'S.kept (input): type-changed']);

  const pinned = { 'S.kept': { to: subjectDigest(subjectValue(after, 'S.kept')), reason: 'no caller sends a string since #1' } };
  const accepted = judge(changes, after, {
    snapshotReasons: [pinned],
    commitReasons: commitReasons(['Drop gone\n\ncontract: S.gone: no caller since release 3, which production serves\n']),
  });
  assert.deepEqual(accepted.refused, []);
  assert.deepEqual(accepted.accepted.map(({ reason }: { reason: string }) => reason),
    ['no caller since release 3, which production serves', 'no caller sends a string since #1']);

  const later = single({ kept: method('boolean') });
  assert.deepEqual(brief(judge(compareSurfaces(before, later), later, { snapshotReasons: [pinned] }).refused),
    ['S.gone: method-removed', 'S.kept (input): type-changed'], 'a reason pinned to another value does not apply');
  assert.deepEqual(keptReasons(pinned, later), {}, '--update drops it');
  assert.deepEqual(keptReasons(pinned, after), pinned);
});
