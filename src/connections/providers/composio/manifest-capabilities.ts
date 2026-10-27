import * as v from 'valibot';

import { isRecord } from '../../../security/content-validation.ts';
import { MANAGED_CONNECTOR_CATALOG, composioManifest } from '../../catalog/index.ts';
import type { ManifestLookup } from '../../catalog/composio-manifests.ts';

type ReadTool = (tool: string, arguments_: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface ManifestComposioCapability {
  toolkit: string;
  tool: string;
  write: boolean;
  arguments(input: Record<string, unknown>): Record<string, unknown>;
  sanitize(data: Record<string, unknown>): Record<string, unknown>;
  /** Throws a safe message when a manifest precondition does not hold. */
  beforeDispatch?(input: Record<string, unknown>, read: ReadTool): Promise<void>;
}

const RESULT_BUDGETS = [
  { items: 50, characters: 4_000, depth: 8 },
  { items: 20, characters: 1_000, depth: 6 },
  { items: 10, characters: 300, depth: 4 },
  { items: 5, characters: 100, depth: 3 },
] as const;

export function manifestComposioCapabilities(): Record<string, ManifestComposioCapability> {
  const entries: Record<string, ManifestComposioCapability> = {};
  for (const connector of MANAGED_CONNECTOR_CATALOG.list()) {
    const manifest = composioManifest(connector.toolkit);
    if (!manifest) continue;
    const tools = new Map(manifest.capabilities.map(({ id, tool }) => [id, tool]));
    for (const capability of connector.capabilities) {
      entries[capability.id] = {
        toolkit: manifest.toolkit,
        tool: tools.get(capability.id)!,
        write: capability.accessLane === 'write',
        arguments(input) {
          const parsed = v.safeParse(capability.input, input);
          if (parsed.success) return parsed.output as Record<string, unknown>;
          const path = parsed.issues[0]?.path?.map(({ key }) => String(key)).join('.');
          throw new Error(path ? `Argument ${path} is invalid` : 'Arguments are invalid');
        },
        sanitize: (data) => boundComposioResult(data, capability.maxResultBytes),
      };
    }
    for (const { id, preconditions } of manifest.capabilities) {
      if (!preconditions) continue;
      entries[id]!.beforeDispatch = async (input, read) => {
        for (const { argument, current, target } of preconditions) {
          if (input[argument] === undefined) continue;
          const [left, right] = await Promise.all([current, target].map((lookup) =>
            lookupValue(entries, lookup, input, read)));
          if (!left || left !== right) {
            throw new Error(`${argument} must stay in the record's current container`);
          }
        }
      };
    }
  }
  return entries;
}

async function lookupValue(
  entries: Readonly<Record<string, ManifestComposioCapability>>,
  lookup: ManifestLookup,
  input: Record<string, unknown>,
  read: ReadTool,
): Promise<string | undefined> {
  const capability = entries[lookup.capability]!;
  try {
    const data = await read(capability.tool, capability.arguments(Object.fromEntries(
      Object.entries(lookup.arguments).map(([name, value]) =>
        [name, value.startsWith('$') ? input[value.slice(1)] : value]),
    )));
    let value: unknown = isRecord(data.data) ? data.data : data;
    for (const key of lookup.path.split('.')) value = isRecord(value) ? value[key] : undefined;
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

export function boundComposioResult(
  data: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  if (byteLength(data) <= maxBytes) return data;
  for (const budget of RESULT_BUDGETS) {
    const trimmed = trimValue(data, budget, 0) as Record<string, unknown>;
    const bounded = { ...trimmed, truncated: true };
    if (byteLength(bounded) <= maxBytes) return bounded;
  }
  return { truncated: true };
}

function trimValue(
  value: unknown,
  budget: (typeof RESULT_BUDGETS)[number],
  depth: number,
): unknown {
  if (typeof value === 'string') {
    return value.length > budget.characters ? `${value.slice(0, budget.characters)}…` : value;
  }
  if (Array.isArray(value)) {
    return depth >= budget.depth ? [] : value.slice(0, budget.items)
      .map((item) => trimValue(item, budget, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth >= budget.depth) return {};
    return Object.fromEntries(Object.entries(value).slice(0, budget.items * 4)
      .map(([key, item]) => [key, trimValue(item, budget, depth + 1)]));
  }
  return value;
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
