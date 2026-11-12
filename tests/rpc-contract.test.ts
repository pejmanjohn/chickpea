import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
// @ts-expect-error Release tooling JavaScript helper.
import { readSurface } from '../scripts/lib/rpc-surface.mjs';
// @ts-expect-error Release tooling JavaScript helper.
import { commitReasons, compareSurfaces, judge, subjectDigest, subjectValue } from '../scripts/lib/rpc-contract.mjs';
// @ts-expect-error Release tooling JavaScript helper.
import { keptReasons, run } from '../scripts/verify-rpc-contract.mjs';

type Change = { subject: string; kind: string; path: string; says: string; allowed: boolean; reason?: string };
type Surface = {
  classes: Record<string, { base?: string; methods: Record<string, { params: { type: unknown; optional?: boolean }[]; returns: unknown; fallback?: boolean }> }>;
  payloads: Record<string, { carries: string; type: unknown }>;
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

type Edits = Record<string, [string, string][]>;

function writeFixture(root: string, edits: Edits = {}, extra: Record<string, string> = {}) {
  for (const [file, original] of Object.entries({ ...FIXTURE, ...extra })) {
    let text = original;
    for (const [from, to] of edits[file] ?? []) {
      assert.ok(text.includes(from), `fixture edit target in ${file}: ${from}`);
      text = text.replace(from, to);
    }
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
}

function surfaceOf(edits: Edits = {}, extra: Record<string, string> = {}, payload = 'Job') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rpc-contract-fixture-'));
  try {
    writeFixture(root, edits, extra);
    return readSurface(root, { payloads: [{ name: payload, source: 'src/types.ts', note: 'admit(job)' }] }) as { surface: Surface; callersOf(name: string): string[] };
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
  assert.match(surface.classes.FlueDemoThreadV1Agent!.base!, /^@flue\/runtime \S+, agents \S+$/,
    'the Agents SDK under Flue\'s generated class is pinned apart from Flue');
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

test('follows a mixin applied to another mixin, and fails on one it cannot read', () => {
  const nested: [string, string][] = [
    ['function installationObject(', `function hostObject(Base: ObjectClass): ObjectClass {
  class HostObject extends (Base as new (...args: never[]) => object) {
    async chickpeaHostStop(): Promise<void> {}
  }
  return HostObject;
}
function installationObject(`],
    ['(installationObject(Base) as new', '(installationObject(hostObject(Base)) as new'],
  ];
  const { surface } = surfaceOf({ 'src/agent.ts': nested });
  assert.deepEqual(Object.keys(surface.classes.FlueDemoThreadV1Agent!.methods), ['chickpeaHostErase', 'chickpeaHostStop', 'chickpeaWake'],
    'the inner mixin\'s method is on the surface');

  const opaque: [string, string][] = [
    ['function installationObject(', 'const wrap = (Base: ObjectClass): ObjectClass => installationObject(Base);\nfunction installationObject('],
    ['(installationObject(Base) as new', '(wrap(Base) as new'],
  ];
  assert.throws(() => surfaceOf({ 'src/agent.ts': opaque }), /cannot read the class that wrap\(\) returns \(src\/agent\.ts\)/);
});

test('reads a renamed class, an override over its mixin, and a dependency type by package and version', () => {
  const { surface } = surfaceOf({
    'wrangler.jsonc': [['{ "tag": "v2", "deleted_classes": ["Retired"] },',
      '{ "tag": "v2", "deleted_classes": ["Retired"] }, { "tag": "v3", "renamed_classes": [{ "from": "OldStore", "to": "TagStateStore" }] },']],
    'src/agent.ts': [['async chickpeaWake(sentAt?: number): Promise<void> { void sentAt; }',
      'async chickpeaHostErase(request: { installationId: string; confirm: true }): Promise<void> { void request; }']],
    'src/store.ts': [
      ["import { DurableObject } from 'cloudflare:workers';", "import { DurableObject } from 'cloudflare:workers';\nimport type { Lease } from 'dep';"],
      ['  static make(): void {}', '  async lease(): Promise<Lease> { return { until: 0 }; }\n  static make(): void {}'],
    ],
  }, {
    'wrangler.jsonc': FIXTURE['wrangler.jsonc']!.replace('"TagStateStore", ', '"OldStore", '),
    'package-lock.json': '{ "packages": { "node_modules/dep": { "version": "1.2.3" } } }',
    'node_modules/dep/package.json': '{ "name": "dep", "version": "1.2.3", "types": "index.d.ts" }',
    'node_modules/dep/index.d.ts': 'export interface Lease { until: number }',
  });
  assert.deepEqual(Object.keys(surface.classes), ['FlueDemoThreadV1Agent', 'TagStateStore'], 'a class is read under its new name');
  assert.deepEqual(surface.classes.FlueDemoThreadV1Agent!.methods.chickpeaHostErase!.params.map(({ type }) => type),
    [{ object: { confirm: 'true', installationId: 'string' } }], 'the nearest class\'s method is the one that serves');
  assert.equal(surface.classes.TagStateStore!.methods.lease!.returns, 'ext:dep:Lease');
  assert.deepEqual(surface.external, { dep: '1.2.3' });
});

test('fails on a payload type it cannot find and on an overloaded method', () => {
  assert.throws(() => surfaceOf({}, {}, 'Missing'), /Payload type Missing is not exported from src\/types\.ts/);
  assert.throws(() => surfaceOf({
    'src/store.ts': [['  async status(threadKey: string)', '  async status(threadKey: number): Promise<Status>;\n  async status(threadKey: string): Promise<Status>;\n  async status(threadKey: string | number)']],
  }), /TagStateStore\.status has 2 call signatures/);
});

const single = (methods: Surface['classes'][string]['methods'], types: Surface['types'] = {}): Surface =>
  ({ classes: { S: { methods } }, payloads: {}, external: {}, types });
const method = (type: unknown, returns: unknown = 'void') => ({ params: [{ name: 'input', type }], returns });
const named = (...names: string[]) => ({ params: names.map((name) => ({ name, type: 'string' })), returns: 'void' });

test('refuses parameters that changed places under the same types, and notes a new name', () => {
  const before = single({ set: named('key', 'value'), get: named('key') });
  const swapped = single({ set: named('value', 'key'), get: named('settingKey') });
  const verdict = judge(compareSurfaces(before, swapped), swapped);
  assert.deepEqual(brief(verdict.refused), ['S.set: param-moved', 'S.set: param-moved']);
  assert.deepEqual(brief(verdict.noted), ['S.get: param-renamed']);

  const inserted = single({ set: named('key', 'scope', 'value'), get: named('key') });
  assert.deepEqual(brief(judge(compareSurfaces(before, inserted), inserted).refused),
    ['S.set: param-added', 'S.set: param-moved'], 'a parameter put before another moves it');
});

test('refuses a break in a parameter list, inside a container type, and in a class, payload or package', () => {
  const optional = { params: [{ name: 'input', type: 'string', optional: true }], returns: 'void' };
  const before: Surface = {
    classes: {
      S: {
        base: 'pkg 1.0.0',
        methods: {
          dropped: named('a', 'b'), loosened: method('string'), tightened: optional,
          list: method({ array: { object: { id: 'string' } } }), wrapped: method({ ref: '#Result', args: ['string'] }),
          keyed: method({ object: {}, index: 'string' }), pair: method({ tuple: ['string', 'number'] }), view: method('void', '#View'),
        },
      },
      Gone: { methods: {} },
    },
    payloads: { Job: { carries: 'admit(job)', type: { object: { id: 'string' } } }, Old: { carries: 'old(job)', type: 'string' } },
    external: { dep: '1.0.0' },
    types: { Result: { object: { value: 'T' } }, View: { object: { id: 'string' } } },
  };
  const after: Surface = {
    classes: {
      S: {
        base: 'pkg 2.0.0',
        methods: {
          dropped: named('a'), loosened: optional, tightened: method('string'),
          list: method({ array: { object: { id: 'number' } } }), wrapped: method({ ref: '#Result', args: ['number'] }),
          keyed: method({ object: {}, index: 'number' }), pair: method({ tuple: ['string', 'string'] }), view: method('void', '#View'),
        },
      },
    },
    payloads: { Job: { carries: 'admit(job)', type: { object: { id: 'number' } } } },
    external: { dep: '2.0.0' },
    types: { Result: { object: { value: 'T' } }, View: { object: { 'id?': 'string' } } },
  };
  const verdict = judge(compareSurfaces(before, after), after);
  assert.deepEqual(verdict.noted, []);
  assert.deepEqual(brief(verdict.refused), [
    'Gone: class-removed',
    'S.dropped: param-removed',
    'S.keyed (input) [key]: type-changed',
    'S.list (input) [] .id: type-changed',
    'S.loosened: param-optional',
    'S.pair (input) [1]: type-changed',
    'S.tightened: param-required',
    'S.wrapped (input) Result<1>: type-changed',
    'S: base-changed',
    'package dep: package-changed',
    'payload Job .id: type-changed',
    'payload Old: payload-removed',
    'type View: field-optional',
  ]);
});

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
  const fromCommit = commitReasons(['Drop gone\n\ncontract: S.gone removed: no caller since release 3, which production serves\n']);
  assert.deepEqual(fromCommit, [{ 'S.gone': { to: 'removed', reason: 'no caller since release 3, which production serves' } }]);
  assert.deepEqual(commitReasons(['contract: S.gone: no digest, so it names no value\n']), []);
  const accepted = judge(changes, after, { snapshotReasons: [pinned], commitReasons: fromCommit });
  assert.deepEqual(accepted.refused, []);
  assert.deepEqual(accepted.accepted.map(({ reason }: { reason: string }) => reason),
    ['no caller since release 3, which production serves', 'no caller sends a string since #1']);

  const later = single({ kept: method('boolean') });
  assert.deepEqual(brief(judge(compareSurfaces(before, later), later, { snapshotReasons: [pinned] }).refused),
    ['S.gone: method-removed', 'S.kept (input): type-changed'], 'a reason pinned to another value does not apply');
  const earlier = commitReasons([`Retype kept\n\ncontract: S.kept ${pinned['S.kept'].to}: no caller sends a string since #1\n`]);
  assert.deepEqual(brief(judge(changes, after, { commitReasons: [...earlier, ...fromCommit] }).refused), []);
  assert.deepEqual(brief(judge(compareSurfaces(before, later), later, { commitReasons: [...earlier, ...fromCommit] }).refused),
    ['S.kept (input): type-changed'], 'a commit reason does not cover a later change to its subject');
  assert.deepEqual(keptReasons(pinned, later), {}, '--update drops it');
  assert.deepEqual(keptReasons(pinned, after), pinned);
});

const PAYLOAD_SOURCES: Record<string, string> = {
  'src/agents/turn-input.ts': 'export interface SlackTurnInputV1 { turnJobId: string }',
  'src/sandbox/coding-worker-binding.ts': 'export interface CodingWorkerBinding { workspaceId: string }',
  'src/slack/thread-runner-rpc.ts': 'export interface ThreadRunnerJobPayload { text: string }',
};

test('the command fails a stale snapshot and a refused change, and passes on a reason pinned to it', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'rpc-contract-repo-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  const commit = (message: string) => { git('add', '-A'); git('commit', '-q', '--no-verify', '-m', message); };
  const check = (...argv: string[]) => run(argv, root) as { ok: boolean; stale: boolean; report: string; verdict: Record<'noted' | 'accepted' | 'refused', (Change & { digest?: string })[]> };
  const edit = (file: string, from: string, to: string) => {
    const text = readFileSync(path.join(root, file), 'utf8');
    assert.ok(text.includes(from), `edit target in ${file}: ${from}`);
    writeFileSync(path.join(root, file), text.replace(from, to));
  };
  try {
    git('init', '-q');
    writeFixture(root, {}, PAYLOAD_SOURCES);
    commit('base, before the check existed');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');

    const first = check();
    assert.equal(first.stale, true, 'no snapshot yet');
    assert.equal(first.ok, false);
    assert.match(first.report, /does not match the source\. Run npm run verify:rpc-contract -- --update and commit it\./);
    assert.equal(check('--update').ok, true, 'the base is read from its source, and nothing changed');
    commit('record the surface');
    assert.equal(check().ok, true);
    assert.throws(() => check('--update', '--head', 'HEAD'), /cannot combine with --head/);

    edit('src/types.ts', 'threadKey: string;', 'threadKey: number;');
    const changed = check();
    assert.deepEqual([changed.ok, changed.stale], [false, true], 'the source moved past the snapshot');
    assert.deepEqual(brief(changed.verdict.refused), ['type Job .threadKey: type-changed']);
    const refused = check('--update');
    assert.deepEqual([refused.ok, refused.stale], [false, false], 'an updated snapshot still needs its reason');
    const digest = (subject: string) => refused.verdict.refused.find((change) => change.subject === subject)!.digest;
    assert.match(refused.report, new RegExp(`^  contract: type Job ${digest('type Job')}: \\.\\.\\.$`, 'm'), 'the report prints the line to copy');

    commit(`Key threads by number\n\ncontract: type Job ${digest('type Job')}: no base caller reads threadKey`);
    const reasoned = check();
    assert.equal(reasoned.ok, true);
    assert.deepEqual(reasoned.verdict.accepted.map(({ reason }) => reason), ['no base caller reads threadKey']);
    assert.equal(check('--base', 'origin/main', '--head', 'HEAD').ok, true, 'two commits compare the same way');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    assert.deepEqual(brief(check().verdict.accepted), [], 'once merged, the change is the base');

    edit('src/types.ts', 'id: string;', '');
    const pinned = check('--update');
    const snapshot = JSON.parse(readFileSync(path.join(root, 'contracts/rpc-surface.json'), 'utf8')) as { contract: Record<string, unknown> };
    snapshot.contract = Object.fromEntries(pinned.verdict.refused.map(({ subject, digest: to }) => [subject, { to, reason: 'ids left with release 3' }]));
    writeFileSync(path.join(root, 'contracts/rpc-surface.json'), `${JSON.stringify(snapshot, null, 2)}\n`);
    assert.equal(check().ok, true, 'a reason in the snapshot');
    commit('Drop the job id');
    rmSync(path.join(root, 'contracts/rpc-surface.json'));
    assert.equal(check('--update').ok, true, 'a snapshot written afresh loses the reason, and the one committed on the branch still counts');
    edit('src/types.ts', 'installation?: string', 'installation?: string; attempt?: number');
    check('--update');
    commit('Add an attempt');
    const later = check();
    assert.equal(later.ok, false, 'the subject changed again, so the earlier reason no longer covers it');
    assert.deepEqual(brief(later.verdict.refused), ['type Job: field-removed']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
