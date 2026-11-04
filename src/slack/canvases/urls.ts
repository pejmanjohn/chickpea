import { CANVAS_ID, SlackCanvasError } from './types.ts';

export function parseSlackCanvasUrl(value: string, workspaceId: string): string {
  const trimmed = value.trim().replace(/^<([^|>]+)(\|[^>]*)?>$/, '$1');
  let url: URL;
  try { url = new URL(trimmed); } catch { throw invalidUrl(); }
  if (trimmed.length > 2_048 || url.protocol !== 'https:' || url.port || url.username || url.password ||
      !/^[a-z0-9-]+\.(?:enterprise\.)?slack\.com$/.test(url.hostname)) throw invalidUrl();
  const match = /^\/docs\/(T[A-Z0-9]+)\/(F[A-Z0-9]+)\/?$/.exec(url.pathname);
  if (!match || !CANVAS_ID.test(match[2]!)) throw invalidUrl();
  if (match[1] !== workspaceId) throw new SlackCanvasError('workspace_mismatch', 'Use a canvas from this Slack workspace.');
  return match[2]!;
}

export function verifiedCanvasPermalink(value: unknown, workspaceId: string, canvasId: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    if (parseSlackCanvasUrl(value, workspaceId) !== canvasId) return undefined;
  } catch {
    return undefined;
  }
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.toString();
}

function invalidUrl(): SlackCanvasError {
  return new SlackCanvasError('canvas_link_required', 'Provide a Slack canvas link from this workspace, such as one Slack copies with Copy link.');
}
