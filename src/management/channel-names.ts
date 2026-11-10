/**
 * Channels as people know them, by name. Slack shows a private Channel's name
 * only to its members, so a Channel without one is counted, never shown by ID.
 */
export function channelNames(channels: ReadonlyArray<{ name?: string | undefined }>): string[] {
  const named = channels.flatMap(({ name }) => name ? [`#${name.replace(/^#/, '')}`] : []);
  const unnamed = channels.length - named.length;
  if (unnamed === 0) return named;
  return [...named, unnamed === 1 ? 'a private Channel' : `${unnamed} private Channels`];
}
