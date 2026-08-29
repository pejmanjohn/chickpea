export interface ManagedConnectorReadCopy {
  setupAction: string;
  accessSummary: string;
  receiptAction: string;
}

/**
 * Bounded read-lane copy shared by the browser handoff and its Slack receipt.
 * HubSpot keeps the approved product language; every other managed connector
 * gets connector-specific generic copy instead of inheriting CRM claims.
 */
export function managedConnectorReadCopy(
  toolkit: string,
  connectorLabel: string,
): ManagedConnectorReadCopy {
  if (toolkit.trim().toLowerCase() === 'hubspot') {
    return {
      setupAction: `use ${connectorLabel} when you ask it to research CRM records`,
      accessSummary: 'Can search and read CRM records. Cannot change HubSpot data.',
      receiptAction: 'search and read your CRM records',
    };
  }
  const label = connectorLabel.trim() || 'the connected account';
  return {
    setupAction: `use ${possessive(label)} read-only capabilities when you ask`,
    accessSummary: `Can use read-only ${label} capabilities. Cannot change ${label} data.`,
    receiptAction: `use ${possessive(label)} read-only capabilities`,
  };
}

export function managedConnectorWriteSummary(
  toolkit: string,
  connectorLabel: string,
): string {
  if (toolkit.trim().toLowerCase() === 'hubspot') {
    return 'Can search and read CRM records, and make explicitly confirmed updates.';
  }
  const label = connectorLabel.trim() || 'the connected account';
  return `Can use read and write ${label} capabilities. Changes still require your confirmation.`;
}

function possessive(value: string): string {
  return value.endsWith('s') ? `${value}'` : `${value}'s`;
}
