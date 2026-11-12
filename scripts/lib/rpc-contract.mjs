/**
 * Compares two RPC surfaces (rpc-surface.mjs) as two builds that serve side
 * by side: after a deploy, a held object on the base build answers callers on
 * the head build, and calls them. Each difference is one of:
 *
 * - noted: the head build only adds a method, an optional parameter or
 *   field, or a union member. Only head code that uses the addition can
 *   meet the base build with it.
 * - refused: a call the two builds already make can break, because one
 *   sends, reads or returns what the other no longer has. It passes only
 *   with a `contract:` reason: in the snapshot's `contract` section, pinned
 *   to the subject's head value, or as a commit line.
 *
 * Changed meaning under an unchanged type is not visible here.
 */
import { createHash } from 'node:crypto';

const isRef = (node) => typeof node === 'string' && node.startsWith('#');
const canonical = (node) => (typeof node === 'string' ? node : JSON.stringify(node));
const sameNode = (a, b) => canonical(a) === canonical(b);
const LITERAL = /^(?:".*"|true|false|-?\d[\d.e+-]*n?)$/;

/** A short digest of a subject's head value, which a snapshot reason pins. */
export function subjectDigest(value) {
  if (value === undefined) return 'removed';
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

const withoutFallback = ({ fallback: _fallback, ...method }) => method;

/** Every subject's head value: what a reason for that subject is pinned to. */
export function subjectValue(surface, subject) {
  const [kind, ...rest] = subject.split(' ');
  const name = rest.join(' ');
  if (kind === 'type') return surface.types[name];
  if (kind === 'payload') return surface.payloads[name];
  if (kind === 'package') return surface.external[name];
  const [className, method] = subject.split('.');
  const entry = surface.classes[className];
  if (method === undefined) return entry && { base: entry.base ?? null };
  const value = entry?.methods[method];
  return value && withoutFallback(value);
}

/** The positions, parameter or return, from which each named type is reachable. */
function positionsOf(surface) {
  const positions = new Map();
  const visit = (node, position) => {
    if (node && typeof node === 'object') {
      for (const value of Object.values(node)) visit(value, position);
      return;
    }
    if (!isRef(node)) return;
    const name = node.slice(1);
    const seen = positions.get(name) ?? new Set();
    if (seen.has(position)) return;
    seen.add(position);
    positions.set(name, seen);
    if (surface.types[name] !== undefined) visit(surface.types[name], position);
  };
  for (const entry of Object.values(surface.classes)) {
    for (const method of Object.values(entry.methods)) {
      for (const parameter of method.params) visit(parameter.type, 'param');
      visit(method.returns, 'return');
    }
  }
  for (const payload of Object.values(surface.payloads)) visit(payload.type, 'param');
  return positions;
}

const positionLabel = (set) => (set?.has('return') ? (set.has('param') ? 'both' : 'return') : 'param');

/**
 * Each kind of difference and whether it passes, by the position of the
 * value it is in. "base" and "head" are the two builds serving at once.
 */
const KINDS = {
  'class-added': { allowed: () => true, says: () => 'class added' },
  'class-removed': { allowed: () => false, says: () => 'class removed: base objects of this class still serve, and base callers still call them' },
  'base-changed': { allowed: () => false, says: ({ from, to }) => `outside base changed from ${from ?? 'none'} to ${to ?? 'none'}: its methods and routes may differ between the builds` },
  'package-changed': { allowed: () => false, says: ({ from, to }) => `version changed from ${from ?? 'none'} to ${to ?? 'none'}; its types cross an object boundary` },
  'payload-added': { allowed: () => true, says: () => 'payload added' },
  'payload-removed': { allowed: () => false, says: () => 'payload removed: the base build still sends or reads it' },
  'method-added': { allowed: () => true, says: () => 'method added' },
  'method-removed': { allowed: () => false, says: () => 'method removed (or renamed): a caller on the base build still calls it on a head object' },
  'param-added': { allowed: ({ optional }) => optional, says: ({ name, optional }) => optional ? `optional parameter \`${name}\` added` : `required parameter \`${name}\` added: a caller on the base build does not send it` },
  'param-removed': { allowed: () => false, says: ({ name }) => `parameter \`${name}\` removed: an object on the base build still reads it` },
  'param-optional': { allowed: () => false, says: ({ name }) => `parameter \`${name}\` became optional: an object on the base build expects it` },
  'param-required': { allowed: () => false, says: ({ name }) => `parameter \`${name}\` became required: a caller on the base build may leave it out` },
  'field-added': {
    allowed: ({ optional }) => optional,
    says: ({ name, optional, position }) => optional ? `optional field \`${name}\` added`
      : position === 'param' ? `required field \`${name}\` added: a caller on the base build does not send it`
        : `required field \`${name}\` added: an object on the base build does not return it`,
  },
  'field-removed': { allowed: () => false, says: ({ name }) => `field \`${name}\` removed (or renamed): the base build still sends or reads it` },
  'field-optional': {
    allowed: () => false,
    says: ({ name, position }) => `field \`${name}\` became optional: ${position === 'param' ? 'an object' : 'a caller'} on the base build expects it`,
  },
  'field-required': { allowed: () => false, says: ({ name }) => `field \`${name}\` became required: the base build may leave it out` },
  'member-added': {
    allowed: () => true,
    says: ({ member, position }) => position === 'param' ? `now accepts ${member}`
      : `can now return ${member}, which a caller on the base build may not know`,
  },
  'member-removed': {
    allowed: () => false,
    says: ({ member, position }) => position === 'param' ? `no longer accepts ${member}: a caller on the base build still sends it`
      : `no longer returns ${member}: an object on the base build still returns it`,
  },
  'type-changed': { allowed: () => false, says: ({ from, to }) => `type changed from ${brief(from)} to ${brief(to)}` },
};

function brief(node) {
  const text = canonical(node);
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** The literal-valued property every object member of both unions has, unique in each: their discriminant. */
function discriminant(left, right) {
  const objects = [...left, ...right].filter((member) => member && typeof member === 'object' && member.object);
  if (objects.length === 0) return undefined;
  const candidates = Object.keys(objects[0].object).filter((key) => !key.endsWith('?'));
  return candidates.sort().find((key) => objects.every((member) => typeof member.object[key] === 'string' && LITERAL.test(member.object[key]))
    && [left, right].every((side) => {
      const values = side.filter((member) => member?.object).map((member) => member.object[key]);
      return new Set(values).size === values.length;
    }));
}

/**
 * Pairs the union members that differ between two builds: by their
 * discriminant where every object member has one, then each remaining
 * object with the one sharing the most identical fields. What stays
 * unpaired was removed or added.
 */
function pairMembers(before, after) {
  const pairs = [];
  const key = discriminant(before, after);
  let removed = [...before];
  let added = [...after];
  if (key) {
    const byValue = new Map(added.filter((member) => member?.object).map((member) => [member.object[key], member]));
    for (const member of before) {
      const match = member?.object && byValue.get(member.object[key]);
      if (!match) continue;
      pairs.push([member, match, `${key}=${member.object[key]}`]);
      removed = removed.filter((item) => item !== member);
      added = added.filter((item) => item !== match);
    }
  }
  const shared = (from, to) => Object.keys(from.object).filter((name) => name in to.object && sameNode(from.object[name], to.object[name]));
  const candidates = [];
  removed.forEach((from, i) => added.forEach((to, j) => {
    if (!from?.object || !to?.object) return;
    const names = shared(from, to);
    if (names.length) candidates.push({ from, to, names, order: i * added.length + j });
  }));
  candidates.sort((a, b) => b.names.length - a.names.length || a.order - b.order);
  const used = new Set();
  for (const { from, to, names } of candidates) {
    if (used.has(from) || used.has(to)) continue;
    used.add(from);
    used.add(to);
    const literal = names.find((name) => LITERAL.test(from.object[name]));
    pairs.push([from, to, literal ? `${literal}=${from.object[literal]}` : `{${names.slice(0, 2).join(', ')}}`]);
  }
  return { pairs, removed: removed.filter((member) => !used.has(member)), added: added.filter((member) => !used.has(member)) };
}

const fields = (object) => new Map(Object.entries(object).map(([key, type]) => key.endsWith('?')
  ? [key.slice(0, -1), { optional: true, type }]
  : [key, { optional: false, type }]));

/** Compares two type nodes in one position; each difference goes to `report(kind, facts, path)`. */
function compareNode(a, b, context, path) {
  if (sameNode(a, b)) return;
  const { report, position } = context;
  const unionA = a?.union ?? (b?.union ? [a] : undefined);
  const unionB = b?.union ?? (a?.union ? [b] : undefined);
  if (unionA && unionB) {
    const right = new Set(unionB.map(canonical));
    const left = new Set(unionA.map(canonical));
    const before = unionA.filter((member) => !right.has(canonical(member)));
    const after = unionB.filter((member) => !left.has(canonical(member)));
    const { pairs, removed, added } = pairMembers(before, after);
    for (const [from, to, label] of pairs) compareNode(from, to, context, [...path, `|${label}`]);
    for (const member of removed) report('member-removed', { member: brief(member), position }, path);
    for (const member of added) report('member-added', { member: brief(member), position }, path);
    return;
  }
  if (isRef(a) || isRef(b)) {
    const pair = `${canonical(a)}=>${canonical(b)}`;
    if (context.expanding.has(pair)) return;
    const left = isRef(a) ? context.base.types[a.slice(1)] : a;
    const right = isRef(b) ? context.head.types[b.slice(1)] : b;
    if (left === undefined || right === undefined) { report('type-changed', { from: a, to: b }, path); return; }
    context.expanding.add(pair);
    compareNode(left, right, context, path);
    context.expanding.delete(pair);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (a.object && b.object) {
      const left = fields(a.object);
      const right = fields(b.object);
      for (const [name, field] of left) {
        const next = right.get(name);
        if (!next) { report('field-removed', { name, position }, path); continue; }
        if (field.optional !== next.optional) report(next.optional ? 'field-optional' : 'field-required', { name, position }, path);
        compareNode(field.type, next.type, context, [...path, `.${name}`]);
      }
      for (const [name, field] of right) {
        if (!left.has(name)) report('field-added', { name, optional: field.optional, position }, path);
      }
      if (a.index !== undefined || b.index !== undefined) {
        if (a.index === undefined || b.index === undefined) report('type-changed', { from: a.index ?? 'no index', to: b.index ?? 'no index' }, [...path, '[key]']);
        else compareNode(a.index, b.index, context, [...path, '[key]']);
      }
      return;
    }
    if (a.array !== undefined && b.array !== undefined) { compareNode(a.array, b.array, context, [...path, '[]']); return; }
    if (a.ref && b.ref && a.ref === b.ref && a.args.length === b.args.length) {
      a.args.forEach((arg, index) => compareNode(arg, b.args[index], context, [...path, `${a.ref.replace(/^#/, '')}<${index + 1}>`]));
      return;
    }
    for (const kind of ['tuple', 'conditional', 'indexed']) {
      if (a[kind] && b[kind] && a[kind].length === b[kind].length) {
        a[kind].forEach((item, index) => compareNode(item, b[kind][index], context, [...path, `[${index}]`]));
        return;
      }
    }
    if (a.keyof !== undefined && b.keyof !== undefined) { compareNode(a.keyof, b.keyof, context, [...path, 'keyof']); return; }
  }
  report('type-changed', { from: a, to: b }, path);
}

function compareMethod(base, head, context) {
  const { report } = context;
  const params = Math.max(base.params.length, head.params.length);
  for (let index = 0; index < params; index += 1) {
    const before = base.params[index];
    const after = head.params[index];
    if (!before) { report('param-added', { name: after.name, optional: Boolean(after.optional || after.rest) }, []); continue; }
    if (!after) { report('param-removed', { name: before.name }, []); continue; }
    const label = `(${after.name})`;
    if (Boolean(before.optional) !== Boolean(after.optional)) report(after.optional ? 'param-optional' : 'param-required', { name: after.name }, []);
    if (Boolean(before.rest) !== Boolean(after.rest)) report('type-changed', { from: before.rest ? 'rest' : 'single', to: after.rest ? 'rest' : 'single' }, [label]);
    compareNode(before.type, after.type, { ...context, position: 'param' }, [label]);
  }
  compareNode(base.returns, head.returns, { ...context, position: 'return' }, ['→']);
}

/**
 * Every difference from `base` to `head`, as `{ subject, kind, path, says, allowed }`.
 * A change inside a named type is reported once, under `type <Name>`.
 */
export function compareSurfaces(base, head) {
  const changes = [];
  const basePositions = positionsOf(base);
  const headPositions = positionsOf(head);
  const sink = (subject) => (kind, facts, path) => {
    const rule = KINDS[kind];
    changes.push({ subject, kind, path: path.join(' '), says: rule.says(facts), allowed: rule.allowed(facts) });
  };
  const context = (subject, position) => ({ base, head, report: sink(subject), position, expanding: new Set() });

  for (const name of union(Object.keys(base.classes), Object.keys(head.classes))) {
    const before = base.classes[name];
    const after = head.classes[name];
    if (!before) { sink(name)('class-added', {}, []); continue; }
    if (!after) { sink(name)('class-removed', {}, []); continue; }
    if ((before.base ?? null) !== (after.base ?? null)) sink(name)('base-changed', { from: before.base, to: after.base }, []);
    for (const method of union(Object.keys(before.methods), Object.keys(after.methods))) {
      const subject = `${name}.${method}`;
      if (!before.methods[method]) { sink(subject)('method-added', {}, []); continue; }
      if (!after.methods[method]) { sink(subject)('method-removed', {}, []); continue; }
      compareMethod(before.methods[method], after.methods[method], context(subject));
    }
  }
  for (const name of union(Object.keys(base.payloads), Object.keys(head.payloads))) {
    const before = base.payloads[name];
    const after = head.payloads[name];
    if (!before || !after) { sink(`payload ${name}`)(before ? 'payload-removed' : 'payload-added', {}, []); continue; }
    compareNode(before.type, after.type, context(`payload ${name}`, 'param'), []);
  }
  for (const name of union(Object.keys(base.types), Object.keys(head.types))) {
    if (base.types[name] === undefined || head.types[name] === undefined) continue;
    const reached = new Set([...(basePositions.get(name) ?? []), ...(headPositions.get(name) ?? [])]);
    compareNode(base.types[name], head.types[name], context(`type ${name}`, positionLabel(reached)), []);
  }
  for (const name of union(Object.keys(base.external), Object.keys(head.external))) {
    if (base.external[name] !== head.external[name] && base.external[name] !== undefined && head.external[name] !== undefined) {
      sink(`package ${name}`)('package-changed', { from: base.external[name], to: head.external[name] }, []);
    }
  }
  return changes;
}

function union(left, right) {
  return [...new Set([...left, ...right])].sort();
}

const COMMIT_REASON = /^contract:\s*(.+?):\s+(\S.*)$/gim;

/** `contract: <subject>: <reason>` lines in commit messages, by subject. */
export function commitReasons(messages) {
  const reasons = new Map();
  for (const message of messages) {
    for (const [, subject, reason] of message.matchAll(COMMIT_REASON)) reasons.set(subject.trim(), reason.trim());
  }
  return reasons;
}

/**
 * Splits changes into noted, accepted and refused. A refused change is
 * accepted by a snapshot reason pinned to the head value of its subject, or
 * by a commit reason naming its subject.
 */
export function judge(changes, head, { snapshotReasons = [], commitReasons: fromCommits = new Map() } = {}) {
  const noted = [];
  const accepted = [];
  const refused = [];
  for (const change of changes) {
    if (change.allowed) { noted.push(change); continue; }
    const digest = subjectDigest(subjectValue(head, change.subject));
    const pinned = snapshotReasons.find((reasons) => reasons[change.subject]?.to === digest)?.[change.subject];
    const reason = pinned?.reason ?? fromCommits.get(change.subject);
    if (reason) accepted.push({ ...change, reason });
    else refused.push({ ...change, digest });
  }
  return { noted, accepted, refused };
}
