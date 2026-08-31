import {
  CONNECTION_CATALOG_PRESETS,
  connectorCatalogLookupNames,
  matchingConnectorCatalogPresets,
  type ConnectorCatalogPreset,
} from '../config/presets.ts';

export type AgentCreationConnectorNoticeKind =
  | 'ambiguous'
  | 'unsupported'
  | 'unavailable'
  | 'already_attached'
  | 'overflow';

export interface AgentCreationConnectorCandidate {
  presetId: string;
  label: string;
  source: 'explicit' | 'inferred';
}

export interface AgentCreationConnectorNotice {
  kind: AgentCreationConnectorNoticeKind;
  label: string;
  text: string;
}

export interface AgentCreationConnectorPlan {
  candidates: AgentCreationConnectorCandidate[];
  notices: AgentCreationConnectorNotice[];
}

export async function selectAgentCreationConnectors(input: {
  requestText: string;
  explicitMentions: readonly string[];
  agentCorpus: string;
  attachedPresetIds?: ReadonlySet<string> | undefined;
  catalog?: readonly ConnectorCatalogPreset[] | undefined;
  isEligible?: ((preset: ConnectorCatalogPreset) => boolean | Promise<boolean>) | undefined;
  maxActions?: number | undefined;
}): Promise<AgentCreationConnectorPlan> {
  const catalog = input.catalog ?? CONNECTION_CATALOG_PRESETS;
  const attached = input.attachedPresetIds ?? new Set<string>();
  const isEligible = input.isEligible ?? (() => true);
  const maxActions = input.maxActions ?? 3;
  const candidates: AgentCreationConnectorCandidate[] = [];
  const notices: AgentCreationConnectorNotice[] = [];
  const selected = new Set<string>();
  const mentions = input.explicitMentions.flatMap((raw) => {
    const matches = matchingConnectorCatalogPresets(raw, catalog);
    const anchors = matches.length === 1
      ? [raw, ...connectorCatalogLookupNames(matches[0]!)]
      : [raw];
    const index = anchors.reduce<number | undefined>((earliest, anchor) => {
      const candidate = affirmativeMentionIndex(input.requestText, anchor);
      if (candidate === undefined) return earliest;
      return earliest === undefined ? candidate : Math.min(earliest, candidate);
    }, undefined);
    return index === undefined ? [] : [{ raw, index }];
  }).sort((left, right) => left.index - right.index);

  for (const { raw } of mentions) {
    const matches = matchingConnectorCatalogPresets(raw, catalog);
    if (matches.length === 0) {
      const label = safeConnectorLabel(raw);
      notices.push({
        kind: 'unsupported',
        label,
        text: `${label} isn’t available to connect yet.`,
      });
      continue;
    }
    if (matches.length > 1) {
      const label = safeConnectorLabel(raw);
      notices.push({
        kind: 'ambiguous',
        label,
        text: `${label} matches more than one connector; choose it later from View Agent.`,
      });
      continue;
    }
    const preset = matches[0]!;
    if (selected.has(preset.id)) continue;
    selected.add(preset.id);
    if (attached.has(preset.id)) {
      notices.push({
        kind: 'already_attached',
        label: preset.name,
        text: `${preset.name} is already attached.`,
      });
      continue;
    }
    if (!(await isEligible(preset))) {
      notices.push({
        kind: 'unavailable',
        label: preset.name,
        text: `${preset.name} isn’t available to connect right now.`,
      });
      continue;
    }
    if (candidates.length >= maxActions) {
      notices.push({
        kind: 'overflow',
        label: preset.name,
        text: `${preset.name} can be connected later from View Agent.`,
      });
      continue;
    }
    candidates.push({ presetId: preset.id, label: preset.name, source: 'explicit' });
  }

  if (candidates.length < maxActions) {
    const inferred = await uniqueInferredConnector({
      catalog,
      corpus: input.agentCorpus,
      selected,
      attached,
      isEligible,
    });
    if (inferred) {
      candidates.push({ presetId: inferred.id, label: inferred.name, source: 'inferred' });
    }
  }

  return { candidates, notices };
}

async function uniqueInferredConnector(input: {
  catalog: readonly ConnectorCatalogPreset[];
  corpus: string;
  selected: ReadonlySet<string>;
  attached: ReadonlySet<string>;
  isEligible: (preset: ConnectorCatalogPreset) => boolean | Promise<boolean>;
}): Promise<ConnectorCatalogPreset | undefined> {
  if (!normalizeLookup(input.corpus)) return undefined;
  const matches = input.catalog.filter((preset) =>
    !input.selected.has(preset.id) &&
    !input.attached.has(preset.id) &&
    connectorCatalogLookupNames(preset).some((name) =>
      affirmativeMentionIndex(input.corpus, name) !== undefined
    )
  );
  if (matches.length !== 1) return undefined;
  return await input.isEligible(matches[0]!) ? matches[0] : undefined;
}

function affirmativeMentionIndex(requestText: string, mention: string): number | undefined {
  const words = normalizeLookup(mention).split(' ').filter(Boolean);
  if (words.length === 0) return undefined;
  const pattern = words.map(escapeRegex).join('[^a-z0-9]+');
  const matcher = new RegExp(`(^|[^a-z0-9])(${pattern})(?=$|[^a-z0-9])`, 'ig');
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(requestText)) !== null) {
    const index = match.index + match[1]!.length;
    if (!quotedAt(requestText, index) && !negatedOrBackgroundAt(requestText, index)) return index;
  }
  return undefined;
}

function quotedAt(text: string, index: number): boolean {
  const prefix = text.slice(0, index);
  return (prefix.match(/"/g)?.length ?? 0) % 2 === 1 ||
    (prefix.match(/“/g)?.length ?? 0) > (prefix.match(/”/g)?.length ?? 0);
}

function negatedOrBackgroundAt(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 80), index).toLowerCase();
  return /(?:\b(?:do not|don't|dont|never|not|no|without|avoid|exclude|instead of)\b(?:\s+[a-z0-9'-]+){0,5}\s*|\b(?:previously|formerly|historically)\s+(?:used\s+)?|\b(?:for example|e\.g\.|example:)\s*)$/.test(
    prefix,
  );
}

function safeConnectorLabel(value: string): string {
  return value
    .replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[*_~`]/g, '')
    .slice(0, 80)
    .trim() || 'That connector';
}

function normalizeLookup(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
