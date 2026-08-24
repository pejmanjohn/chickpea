export interface ManagedConnectorCanaryManifest {
  capability: string;
  arguments: Readonly<Record<string, unknown>>;
  requiredArguments: readonly string[];
  requiredResourceConstraints: readonly string[];
}

/** Safe, read-only starting points for the generic managed-provider verifier. */
export const MANAGED_CONNECTOR_CANARY_MANIFESTS: Readonly<
  Record<string, ManagedConnectorCanaryManifest>
> = Object.freeze({
  gmail: manifest('gmail.profile.read'),
  googlecalendar: manifest('calendar.calendars.list', { maxResults: 10 }),
  googledrive: manifest('drive.files.search', {
    query: 'Chickpea canary', pageSize: 5,
  }),
  googlesheets: manifest('sheets.spreadsheets.search', {
    query: 'Chickpea canary', maxResults: 5,
  }),
  googledocs: manifest('docs.documents.search', {
    query: 'Chickpea canary', maxResults: 5,
  }),
  googleslides: manifest('slides.presentations.get', {}, ['presentationId']),
  notion: manifest('notion.content.search', {
    query: 'Chickpea canary', pageSize: 10,
  }),
  google_search_console: manifest(
    'search_console.sites.get', {}, ['siteHandle'], ['siteUrls'],
  ),
  google_analytics: manifest(
    'analytics.properties.get', {}, ['propertyHandle'], ['propertyIds'],
  ),
  hubspot: manifest('hubspot.account.get'),
  gong: manifest('gong.workspaces.list', {}, ['workspaceHandle'], ['workspaceIds']),
  googleads: manifest(
    'ads.customers.get', {}, ['customerHandle'], ['customerIds'],
  ),
  youtube: manifest(
    'youtube.channels.get', {}, ['channelHandle'], ['channelIds'],
  ),
});

function manifest(
  capability: string,
  arguments_: Readonly<Record<string, unknown>> = {},
  requiredArguments: readonly string[] = [],
  requiredResourceConstraints: readonly string[] = [],
): ManagedConnectorCanaryManifest {
  return Object.freeze({
    capability,
    arguments: Object.freeze(arguments_),
    requiredArguments: Object.freeze(requiredArguments),
    requiredResourceConstraints: Object.freeze(requiredResourceConstraints),
  });
}
