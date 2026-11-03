import type { ToolDefinition } from '@flue/runtime';

import {
  MANAGED_CONNECTOR_CATALOG,
  loadConnectorDetails,
  managedCapabilityDefinition,
  type ManagedCapabilityDefinition,
} from '../../src/connections/catalog/index.ts';
import { createManagedConnectionTools } from '../../src/connections/managed-tools.ts';

/** The connections' tools once their connector details loaded, as turn staging loads them before a render. */
export async function createLoadedManagedConnectionTools(
  input: Omit<Parameters<typeof createManagedConnectionTools>[0], 'details'>,
): Promise<ToolDefinition[]> {
  return createManagedConnectionTools({
    ...input,
    details: await loadConnectorDetails(input.connections.map(({ toolkit }) => toolkit)),
  });
}

/** A shipped capability's whole definition, description and input schema included. */
export async function loadManagedCapability(capabilityId: string): Promise<ManagedCapabilityDefinition | undefined> {
  const header = MANAGED_CONNECTOR_CATALOG.capability(capabilityId);
  const detail = header ? await MANAGED_CONNECTOR_CATALOG.detail(header.connectorToolkit)?.load() : undefined;
  return detail ? managedCapabilityDefinition(detail, header!.id) : undefined;
}
