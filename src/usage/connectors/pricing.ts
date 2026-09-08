interface ConnectorPriceComponent {
  id:
    | 'own_app_tool_call'
    | 'managed_app_tool_call'
    | 'managed_trigger_event'
    | 'managed_connected_account'
    | 'direct_execution_addon'
    | 'zdr_tool_call_addon'
    | 'advanced_white_label_connection';
  unit: 'tool_call' | 'trigger_event' | 'connected_account' | 'connection';
  microsPerUnit: number;
}

interface ConnectorPriceVersion {
  id: string;
  providerId: 'composio';
  sourceUrl: string;
  effectiveFrom: number;
  reviewedAt: number;
  currency: 'USD';
  components: readonly ConnectorPriceComponent[];
}

export const COMPOSIO_CONNECTOR_PRICE_VERSION: ConnectorPriceVersion = {
  id: 'composio-2026-08-15',
  providerId: 'composio',
  sourceUrl: 'https://composio.dev/pricing',
  effectiveFrom: Date.UTC(2026, 7, 15),
  reviewedAt: Date.UTC(2026, 7, 23),
  currency: 'USD',
  components: [
    { id: 'own_app_tool_call', unit: 'tool_call', microsPerUnit: 300 },
    { id: 'managed_app_tool_call', unit: 'tool_call', microsPerUnit: 500 },
    { id: 'managed_trigger_event', unit: 'trigger_event', microsPerUnit: 5_000 },
    { id: 'managed_connected_account', unit: 'connected_account', microsPerUnit: 100_000 },
    { id: 'direct_execution_addon', unit: 'tool_call', microsPerUnit: 100 },
    { id: 'zdr_tool_call_addon', unit: 'tool_call', microsPerUnit: 100 },
    {
      id: 'advanced_white_label_connection',
      unit: 'connection',
      microsPerUnit: 300_000,
    },
  ],
};

/**
 * List-price estimate before free allowances, plan credits, shared-connection
 * add-ons, negotiated discounts, or optional compliance add-ons.
 */
export function estimateComposioManagedDirectToolCost(toolCallCount: number): {
  priceVersionId: string;
  estimatedCostMicros: number;
  estimateCurrency: 'USD';
} {
  const managed = componentPrice('managed_app_tool_call');
  const direct = componentPrice('direct_execution_addon');
  return {
    priceVersionId: COMPOSIO_CONNECTOR_PRICE_VERSION.id,
    estimatedCostMicros: Math.max(0, Math.trunc(toolCallCount)) * (managed + direct),
    estimateCurrency: 'USD',
  };
}

function componentPrice(id: ConnectorPriceComponent['id']): number {
  return COMPOSIO_CONNECTOR_PRICE_VERSION.components.find(
    (component) => component.id === id,
  )!.microsPerUnit;
}
