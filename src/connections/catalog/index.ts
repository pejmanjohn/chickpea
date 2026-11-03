import { isRecord } from '../../security/content-validation.ts';
import { MANAGED_GOOGLE_WORKSPACE_CONNECTORS } from './google-workspace.ts';
import { MANAGED_GOOGLE_PRODUCTIVITY_CONNECTORS } from './google-productivity.ts';
import { MANAGED_GOOGLE_ANALYTICS_CONNECTORS } from './google-analytics.ts';
import { MANAGED_HUBSPOT_CONNECTORS } from './hubspot.ts';
import { MANAGED_GONG_CONNECTORS } from './gong.ts';
import { MANAGED_GOOGLE_ADS_CONNECTORS } from './google-ads.ts';
import { MANAGED_YOUTUBE_CONNECTORS } from './youtube.ts';
import {
  isManagedCapabilitySemanticOverride,
  managedConnectorSemanticDescriptor,
  type SemanticActivityDescriptor,
} from '../../activity/semantic.ts';
import { MANAGED_NOTION_CONNECTORS } from './notion.ts';
import {
  compileComposioManifest,
  composioConnectorHeader,
  parseComposioManifest,
  type ComposioManifestHeader,
} from './composio-manifests.ts';
import { COMPOSIO_MANIFEST_HEADERS } from './composio-headers.ts';
import { COMPOSIO_MANIFEST_LOADERS } from './composio-details.ts';
import { onDemand, type Loaded, type OnDemand } from '../../runtime/on-demand.ts';
import type {
  ConnectorDetail,
  ManagedAccessLane,
  ManagedAccountResourceConstraints,
  ManagedBindingResourceConstraints,
  ManagedCapabilityDefinition,
  ManagedCapabilityHeader,
  ManagedConnectorDefinition,
  ManagedConnectorHeader,
  ManagedResourceSelection,
} from './types.ts';

const ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,191}$/;
const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9_]{0,191}$/;
const RESOURCE_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,127}$/;
const RESOURCE_HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/**
 * The managed connectors and their capabilities, by header: ids, tool names,
 * lanes, effects, copy and resource contracts, everything but each tool's
 * description and input schema. Those load per toolkit (`detail`).
 */
export class ManagedConnectorCatalog {
  private readonly connectorsByToolkit = new Map<string, ManagedConnectorHeader>();
  private readonly capabilitiesById = new Map<string, ManagedCapabilityHeader>();
  private readonly capabilitiesByToolName = new Map<string, ManagedCapabilityHeader>();
  private readonly connectors: ManagedConnectorHeader[];
  private readonly details = new Map<string, OnDemand<ConnectorDetail>>();

  constructor(
    definitions: readonly ManagedConnectorHeader[],
    private readonly loadDetail: (toolkit: string) => Promise<ConnectorDetail>,
  ) {
    this.connectors = definitions.map((definition) => validateConnector(definition));
    const toolNames = new Set<string>();
    for (const connector of this.connectors) {
      if (this.connectorsByToolkit.has(connector.toolkit)) {
        throw new Error(`Duplicate managed connector toolkit ${connector.toolkit}`);
      }
      this.connectorsByToolkit.set(connector.toolkit, connector);
      for (const capability of connector.capabilities) {
        if (capability.connectorToolkit !== connector.toolkit) {
          throw new Error(
            `Managed capability ${capability.id} does not belong to connector ${connector.toolkit}`,
          );
        }
        if (this.capabilitiesById.has(capability.id)) {
          throw new Error(`Duplicate managed capability ${capability.id}`);
        }
        if (toolNames.has(capability.toolName)) {
          throw new Error(`Duplicate managed tool name ${capability.toolName}`);
        }
        this.capabilitiesById.set(capability.id, capability);
        this.capabilitiesByToolName.set(capability.toolName, capability);
        toolNames.add(capability.toolName);
      }
    }
  }

  list(): readonly ManagedConnectorHeader[] {
    return this.connectors;
  }

  connector(toolkit: string): ManagedConnectorHeader | undefined {
    return this.connectorsByToolkit.get(toolkit.trim().toLowerCase());
  }

  capability(id: string): ManagedCapabilityHeader | undefined {
    return this.capabilitiesById.get(id.trim());
  }

  capabilityForToolName(toolName: string): ManagedCapabilityHeader | undefined {
    return this.capabilitiesByToolName.get(toolName.trim());
  }

  capabilities(toolkit: string, accessLane: ManagedAccessLane): ManagedCapabilityHeader[] {
    const connector = this.connector(toolkit);
    if (!connector) return [];
    return connector.capabilities.filter(
      ({ accessLane: lane }) => accessLane === 'write' || lane === 'read',
    );
  }

  /**
   * A connector's whole definition, loaded on its first use. Undefined for a
   * toolkit the catalog lacks.
   */
  detail(toolkit: string): OnDemand<ConnectorDetail> | undefined {
    const key = this.connector(toolkit)?.toolkit;
    if (key === undefined) return undefined;
    let detail = this.details.get(key);
    if (!detail) {
      detail = onDemand(`connector detail ${key}`, () => this.loadDetail(key));
      this.details.set(key, detail);
    }
    return detail;
  }
}

/** A catalog of whole definitions, such as a test's; their details load without an import. */
export function createManagedConnectorCatalog(
  definitions: readonly ManagedConnectorDefinition[],
): ManagedConnectorCatalog {
  const byToolkit = new Map(definitions.map((connector) => [connector.toolkit.trim().toLowerCase(), connector]));
  return new ManagedConnectorCatalog(definitions, async (toolkit) => ({ connector: byToolkit.get(toolkit)! }));
}

const HAND_WRITTEN_CONNECTORS: readonly ManagedConnectorDefinition[] = [
  ...MANAGED_GOOGLE_WORKSPACE_CONNECTORS,
  ...MANAGED_GOOGLE_PRODUCTIVITY_CONNECTORS,
  ...MANAGED_GOOGLE_ANALYTICS_CONNECTORS,
  ...MANAGED_NOTION_CONNECTORS,
  ...MANAGED_HUBSPOT_CONNECTORS,
  ...MANAGED_GONG_CONNECTORS,
  ...MANAGED_GOOGLE_ADS_CONNECTORS,
  ...MANAGED_YOUTUBE_CONNECTORS,
];

const HAND_WRITTEN_BY_TOOLKIT = new Map(HAND_WRITTEN_CONNECTORS.map((connector) => [connector.toolkit, connector]));

/** A hand-written connector for the same toolkit takes precedence over its manifest. */
const COMPOSIO_HEADERS = new Map(COMPOSIO_MANIFEST_HEADERS
  .filter(({ toolkit }) => !HAND_WRITTEN_BY_TOOLKIT.has(toolkit))
  .map((header) => [header.toolkit, header]));

/**
 * The shipped catalog. A Composio toolkit's detail imports its manifest's
 * chunk; a hand-written connector is already in memory but loads through the
 * same seam, so a path that skips the load fails for every connector alike.
 */
export const MANAGED_CONNECTOR_CATALOG = new ManagedConnectorCatalog([
  ...HAND_WRITTEN_CONNECTORS,
  ...[...COMPOSIO_HEADERS.values()].map(composioConnectorHeader),
], async (toolkit) => {
  const handWritten = HAND_WRITTEN_BY_TOOLKIT.get(toolkit);
  if (handWritten) return { connector: handWritten };
  const manifest = parseComposioManifest((await COMPOSIO_MANIFEST_LOADERS[toolkit]!()).default);
  return { connector: compileComposioManifest(manifest), manifest };
});

/** A bundled Composio manifest's header: its copy, sign-in mode, preset, version and validation call. */
export function composioHeader(toolkit: string): ComposioManifestHeader | undefined {
  return COMPOSIO_HEADERS.get(toolkit.trim().toLowerCase());
}

/** A shipped connector's whole definition, loaded on first use (ManagedConnectorCatalog.detail). */
export function connectorDetail(toolkit: string): OnDemand<ConnectorDetail> | undefined {
  return MANAGED_CONNECTOR_CATALOG.detail(toolkit);
}

/** Load these toolkits' details together; a toolkit the catalog lacks is skipped. */
export async function loadConnectorDetails(
  toolkits: Iterable<string>,
  catalog: ManagedConnectorCatalog = MANAGED_CONNECTOR_CATALOG,
): Promise<ReadonlyMap<string, Loaded<ConnectorDetail>>> {
  const unique = [...new Set([...toolkits].map((toolkit) => toolkit.trim().toLowerCase()))];
  const loaded = await Promise.all(unique.map(async (toolkit) => {
    const detail = catalog.detail(toolkit);
    return detail ? [toolkit, await detail.load()] as const : undefined;
  }));
  return new Map(loaded.filter((entry) => entry !== undefined));
}

/**
 * Load the details a Flue render of these managed connections reads
 * (useManagedConnectionTools), so the render finds them in memory.
 */
export async function preloadManagedConnectionDetails(
  connections: readonly { toolkit: string }[] | undefined,
): Promise<void> {
  await loadConnectorDetails((connections ?? []).map(({ toolkit }) => toolkit));
}

/** Load every shipped connector's detail, for a render whose connections are not known ahead. */
export async function preloadAllConnectorDetails(): Promise<void> {
  await loadConnectorDetails(MANAGED_CONNECTOR_CATALOG.list().map(({ toolkit }) => toolkit));
}

/**
 * These toolkits' details for synchronous code, such as a Flue render, after
 * an async seam loaded them: CapabilityNotLoadedError for one it did not.
 */
export function requireConnectorDetails(
  toolkits: Iterable<string>,
  catalog: ManagedConnectorCatalog = MANAGED_CONNECTOR_CATALOG,
): ReadonlyMap<string, Loaded<ConnectorDetail>> {
  const details = new Map<string, Loaded<ConnectorDetail>>();
  for (const toolkit of toolkits) {
    const key = toolkit.trim().toLowerCase();
    const detail = catalog.detail(key);
    if (detail && !details.has(key)) details.set(key, detail.require());
  }
  return details;
}

/** A capability's whole definition, description and input schema included, from its loaded connector. */
export function managedCapabilityDefinition(
  detail: Loaded<ConnectorDetail>,
  capabilityId: string,
): ManagedCapabilityDefinition | undefined {
  return detail.connector.capabilities.find(({ id }) => id === capabilityId.trim());
}

export function semanticDescriptorForManagedCapability(
  capabilityId: string,
): SemanticActivityDescriptor | undefined {
  const capability = MANAGED_CONNECTOR_CATALOG.capability(capabilityId);
  if (!capability) return undefined;
  const connector = MANAGED_CONNECTOR_CATALOG.connector(capability.connectorToolkit);
  return connector ? managedConnectorSemanticDescriptor(connector, capability) : undefined;
}

export function semanticDescriptorForManagedTool(
  toolName: string,
): SemanticActivityDescriptor | undefined {
  const capability = MANAGED_CONNECTOR_CATALOG.capabilityForToolName(toolName);
  return capability ? semanticDescriptorForManagedCapability(capability.id) : undefined;
}

/** The auth-config lane a credential needs for these capabilities: write when any of them writes. */
export function managedAccessLane(
  connector: ManagedConnectorHeader,
  capabilities: readonly string[],
): ManagedAccessLane {
  return connector.capabilities.some(({ id, accessLane }) =>
    accessLane === 'write' && capabilities.includes(id)) ? 'write' : 'read';
}

export function intersectManagedResourceConstraints(
  connector: ManagedConnectorHeader,
  accountConstraints: ManagedAccountResourceConstraints | undefined,
  bindingConstraints: ManagedBindingResourceConstraints | undefined,
): ManagedAccountResourceConstraints | undefined {
  const definitions = connector.resources ?? [];
  const account = isRecord(accountConstraints) ? accountConstraints : {};
  const binding = withoutPageScope(connector, isRecord(bindingConstraints) ? bindingConstraints : {});
  const allowedKeys = new Set(definitions.map(({ key }) => key));
  if (
    Object.keys(account).some((key) => !allowedKeys.has(key)) ||
    Object.keys(binding).some((key) => !allowedKeys.has(key))
  ) return undefined;
  if (definitions.length === 0) return {};

  const effective: ManagedAccountResourceConstraints = {};
  for (const definition of definitions) {
    const selections = parseAccountSelections(account[definition.key]);
    const handles = parseBindingHandles(binding[definition.key]);
    if (!selections || !handles) return undefined;
    if (definition.required && (selections.length === 0 || handles.length === 0)) return undefined;
    if (!definition.multiple && handles.length > 1) return undefined;
    if (handles.length === 0) continue;
    const byHandle = new Map(selections.map((selection) => [selection.handle, selection]));
    const selected = handles.map((handle) => byHandle.get(handle));
    if (selected.some((selection) => !selection)) return undefined;
    effective[definition.key] = selected as ManagedResourceSelection[];
  }
  return effective;
}

function withoutPageScope(
  connector: ManagedConnectorHeader,
  constraints: Record<string, unknown>,
): Record<string, unknown> {
  if (!connector.pageScope || !(connector.pageScope.key in constraints)) return constraints;
  const { [connector.pageScope.key]: _scope, ...rest } = constraints;
  return rest;
}

export function projectManagedResourceHandles(
  constraints: ManagedAccountResourceConstraints | undefined,
): ManagedBindingResourceConstraints {
  if (!constraints) return {};
  return Object.fromEntries(Object.entries(constraints).map(([key, selections]) => [
    key,
    selections.map(({ handle }) => handle),
  ]));
}

function validateConnector(definition: ManagedConnectorHeader): ManagedConnectorHeader {
  const toolkit = definition.toolkit.trim().toLowerCase();
  if (!ID_PATTERN.test(definition.id) || !ID_PATTERN.test(toolkit) ||
      !ID_PATTERN.test(definition.providerId)) {
    throw new Error('Managed connector identity is invalid');
  }
  if (!definition.label.trim() || !definition.description.trim() ||
      !definition.securityDescription.trim() || definition.capabilities.length === 0) {
    throw new Error(`Managed connector ${toolkit} is incomplete`);
  }
  const resourceKeys = new Set<string>();
  for (const resource of definition.resources ?? []) {
    if (!RESOURCE_KEY_PATTERN.test(resource.key) || resourceKeys.has(resource.key) ||
        !RESOURCE_KEY_PATTERN.test(resource.localArgument) ||
        !RESOURCE_KEY_PATTERN.test(resource.providerArgument)) {
      throw new Error(`Managed connector ${toolkit} has an invalid resource contract`);
    }
    resourceKeys.add(resource.key);
  }
  for (const capability of definition.capabilities) {
    if (!ID_PATTERN.test(capability.id) || !TOOL_NAME_PATTERN.test(capability.toolName) ||
        !Number.isInteger(capability.maxResultBytes) || capability.maxResultBytes < 1 ||
        capability.maxResultBytes > 256 * 1024 ||
        capability.effect !== 'read' && (
          !capability.sideEffectLabel?.trim() || capability.sideEffectLabel.length > 240 ||
          capability.sideEffectLabel !== capability.sideEffectLabel.trim()
        )) {
      throw new Error(`Managed connector ${toolkit} has an invalid capability`);
    }
    if (capability.semantic !== undefined &&
        !isManagedCapabilitySemanticOverride(capability.semantic)) {
      throw new Error(`Managed connector ${toolkit} has an invalid semantic override`);
    }
    if (capability.quota && (
      capability.quota.length === 0 || capability.quota.length > 8 ||
      new Set(capability.quota.map(({ bucket }) => bucket)).size !== capability.quota.length ||
      capability.quota.some(({ bucket, units }) =>
        !/^[a-z][a-z0-9_]{0,63}$/.test(bucket) ||
        !Number.isInteger(units) || units < 1 || units > 1_000_000)
    )) throw new Error(`Managed connector ${toolkit} has an invalid quota contract`);
    if (capability.artifact && (
      !RESOURCE_KEY_PATTERN.test(capability.artifact.argument) ||
      !RESOURCE_KEY_PATTERN.test(capability.artifact.mimeTypeArgument) ||
      !Number.isInteger(capability.artifact.maxBytes) || capability.artifact.maxBytes < 1 ||
      capability.artifact.maxBytes > 64 * 1024 * 1024 ||
      capability.artifact.allowedMimeTypes.length === 0 ||
      capability.artifact.allowedMimeTypes.some((value) =>
        !/^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/.test(value))
    )) throw new Error(`Managed connector ${toolkit} has an invalid artifact contract`);
  }
  return { ...definition, toolkit };
}

function parseAccountSelections(value: unknown): ManagedResourceSelection[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const selections: ManagedResourceSelection[] = [];
  const handles = new Set<string>();
  const providerRefs = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.handle !== 'string' ||
        typeof entry.providerRef !== 'string' || typeof entry.label !== 'string' ||
        !RESOURCE_HANDLE_PATTERN.test(entry.handle) || !entry.providerRef.trim() ||
        entry.providerRef.length > 2_000 || !entry.label.trim() || entry.label.length > 240 ||
        entry.currencyCode !== undefined && (
          typeof entry.currencyCode !== 'string' || !/^[A-Z]{3}$/.test(entry.currencyCode)
        ) ||
        handles.has(entry.handle) || providerRefs.has(entry.providerRef)) return undefined;
    handles.add(entry.handle);
    providerRefs.add(entry.providerRef);
    selections.push({
      handle: entry.handle,
      providerRef: entry.providerRef,
      label: entry.label.trim(),
      ...(typeof entry.currencyCode === 'string' ? { currencyCode: entry.currencyCode } : {}),
    });
  }
  return selections;
}

function parseBindingHandles(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 256 ||
      value.some((entry) => typeof entry !== 'string' || !RESOURCE_HANDLE_PATTERN.test(entry))) {
    return undefined;
  }
  const handles = [...new Set(value)];
  return handles.length === value.length ? handles : undefined;
}

export type {
  ConnectorDetail,
  ManagedAccessLane,
  ManagedAccountResourceConstraints,
  ManagedBindingResourceConstraints,
  ManagedCapabilityDefinition,
  ManagedCapabilityHeader,
  ManagedConnectorDefinition,
  ManagedConnectorHeader,
  ManagedEffectClass,
  ManagedProviderAvailability,
  ManagedProviderAvailabilityStatus,
  ManagedProviderConfigurationCode,
  ManagedResourceDefinition,
  ManagedResourceSelection,
} from './types.ts';
