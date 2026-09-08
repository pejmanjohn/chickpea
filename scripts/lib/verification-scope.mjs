import { digest } from './verification-inputs.mjs';

// Exclude only the serving version: its proven transitions are handled separately.
export function contextScope(id, context) {
  const { servingVersion, ...inputs } = context;
  return { context: id, ...inputs };
}

export function suitableCapability(cap, spec, selected) {
  if (cap?.kind === 'tool' && cap.scope?.shared === true) return true;
  return cap?.scope && digest(cap.scope) === digest(contextScope(selected.context, spec.contexts[selected.context]));
}

export function validateGroups(spec) {
  const ids = new Set(spec.cases.map((c) => c.id));
  for (const group of spec.groups ?? []) {
    if (!group || Object.keys(group).some((key) => !['id', 'title', 'required', 'optional', 'scopeReason'].includes(key))
      || typeof group.id !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(group.id) || ids.has(group.id)
      || !group.title?.trim() || !group.scopeReason?.trim()
      || !Array.isArray(group.required) || !group.required.length || !Array.isArray(group.optional)) throw new Error('Invalid variant group; declare required/optional cases and scope reason.');
    ids.add(group.id);
    const children = [...group.required, ...group.optional];
    if (new Set(children).size !== children.length || children.some((id) => !spec.cases.some((c) => c.id === id))) throw new Error('Variant groups need unique existing case IDs.');
    if (new Set(children.map((id) => spec.cases.find((c) => c.id === id).context)).size !== 1) throw new Error('Variant groups cannot combine contexts, targets, models or acceptance grades.');
  }
}

export function groupStatus(spec, cases) {
  return (spec.groups ?? []).map((group) => {
    const children = group.required.map((id) => cases.find((c) => c.id === id));
    const result = children.every((c) => c.result === 'pass') ? 'pass'
      : ['fail', 'ambiguous', 'stale', 'blocked', 'observe_overdue', 'in_progress', 'not_run'].find((result) => children.some((c) => c.result === result));
    return { ...group, grade: children[0].grade, target: children[0].target, result,
      pending: children.filter((c) => c.result !== 'pass').map((c) => c.id) };
  });
}

export function optionalCases(spec) {
  const required = new Set((spec.groups ?? []).flatMap((g) => g.required));
  return new Set((spec.groups ?? []).flatMap((g) => g.optional).filter((id) => !required.has(id)));
}
