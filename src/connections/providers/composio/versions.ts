export const COMPOSIO_TOOLKIT_VERSIONS = {
  gmail: '20260817_00',
  googlecalendar: '20260812_00',
  googledrive: '20260815_00',
  googlesheets: '20260813_00',
  googledocs: '20260818_00',
  googleslides: '20260819_00',
  notion: '20260819_00',
  google_search_console: '20260806_00',
  google_analytics: '20260721_00',
  hubspot: '20260817_00',
  gong: '20260721_00',
  googleads: '20260721_00',
  youtube: '20260721_00',
} as const;

export type PinnedComposioToolkit = keyof typeof COMPOSIO_TOOLKIT_VERSIONS;

export function composioToolkitVersion(toolkit: string): string | undefined {
  return COMPOSIO_TOOLKIT_VERSIONS[toolkit.toLowerCase() as PinnedComposioToolkit];
}
