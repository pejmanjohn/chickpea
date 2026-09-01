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
import type {
  ManagedAccessLane,
  ManagedAccountResourceConstraints,
  ManagedBindingResourceConstraints,
  ManagedCapabilityDefinition,
  ManagedConnectorDefinition,
  ManagedResourceSelection,
} from './types.ts';

const ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,191}$/;
const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9_]{0,191}$/;
const RESOURCE_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,127}$/;
const RESOURCE_HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,127}$/;

export class ManagedConnectorCatalog {
  private readonly connectorsByToolkit = new Map<string, ManagedConnectorDefinition>();
  private readonly capabilitiesById = new Map<string, ManagedCapabilityDefinition>();
  private readonly capabilitiesByToolName = new Map<string, ManagedCapabilityDefinition>();
  private readonly connectors: ManagedConnectorDefinition[];

  constructor(definitions: readonly ManagedConnectorDefinition[]) {
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

  list(): readonly ManagedConnectorDefinition[] {
    return this.connectors;
  }

  connector(toolkit: string): ManagedConnectorDefinition | undefined {
    return this.connectorsByToolkit.get(toolkit.trim().toLowerCase());
  }

  capability(id: string): ManagedCapabilityDefinition | undefined {
    return this.capabilitiesById.get(id.trim());
  }

  capabilityForToolName(toolName: string): ManagedCapabilityDefinition | undefined {
    return this.capabilitiesByToolName.get(toolName.trim());
  }

  capabilities(toolkit: string, accessLane: ManagedAccessLane): ManagedCapabilityDefinition[] {
    const connector = this.connector(toolkit);
    if (!connector) return [];
    return connector.capabilities.filter(
      ({ accessLane: lane }) => accessLane === 'write' || lane === 'read',
    );
  }
}

export function createManagedConnectorCatalog(
  definitions: readonly ManagedConnectorDefinition[],
): ManagedConnectorCatalog {
  return new ManagedConnectorCatalog(definitions);
}

export const MANAGED_CONNECTOR_CATALOG = createManagedConnectorCatalog(
  [
    ...MANAGED_GOOGLE_WORKSPACE_CONNECTORS,
    ...MANAGED_GOOGLE_PRODUCTIVITY_CONNECTORS,
    ...MANAGED_GOOGLE_ANALYTICS_CONNECTORS,
    ...MANAGED_NOTION_CONNECTORS,
    ...MANAGED_HUBSPOT_CONNECTORS,
    ...MANAGED_GONG_CONNECTORS,
    ...MANAGED_GOOGLE_ADS_CONNECTORS,
    ...MANAGED_YOUTUBE_CONNECTORS,
  ],
);

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

export function intersectManagedResourceConstraints(
  connector: ManagedConnectorDefinition,
  accountConstraints: ManagedAccountResourceConstraints | undefined,
  bindingConstraints: ManagedBindingResourceConstraints | undefined,
): ManagedAccountResourceConstraints | undefined {
  const definitions = connector.resources ?? [];
  const account = isRecord(accountConstraints) ? accountConstraints : {};
  const binding = isRecord(bindingConstraints) ? bindingConstraints : {};
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

export function projectManagedResourceHandles(
  constraints: ManagedAccountResourceConstraints | undefined,
): ManagedBindingResourceConstraints {
  if (!constraints) return {};
  return Object.fromEntries(Object.entries(constraints).map(([key, selections]) => [
    key,
    selections.map(({ handle }) => handle),
  ]));
}

function validateConnector(definition: ManagedConnectorDefinition): ManagedConnectorDefinition {
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
        capability.maxResultBytes > 256 * 1024) {
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
  ManagedAccessLane,
  ManagedAccountResourceConstraints,
  ManagedBindingResourceConstraints,
  ManagedCapabilityDefinition,
  ManagedConnectorDefinition,
  ManagedEffectClass,
  ManagedProviderAvailability,
  ManagedProviderAvailabilityStatus,
  ManagedProviderConfigurationCode,
  ManagedResourceDefinition,
  ManagedResourceSelection,
} from './types.ts';
