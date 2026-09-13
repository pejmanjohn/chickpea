import { SlackListError } from './types.ts';

const LIST_ID = /^F[A-Z0-9]+$/;
const ITEM_ID = /^Rec[A-Za-z0-9]+$/;

/** Parse known native references only; URLs are never fetched. */
export function parseSlackListUrl(value: string, workspaceId: string): { listId: string; itemId?: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidUrl(); }
  if (value.length > 2_048 || url.protocol !== 'https:' || url.port || url.username || url.password ||
      !/^[a-z0-9-]+\.(?:enterprise\.)?slack\.com$/.test(url.hostname)) throw invalidUrl();
  const match = /^\/lists\/(T[A-Z0-9]+)\/(F[A-Z0-9]+)\/?$/.exec(url.pathname) ??
    (url.hostname === 'app.slack.com'
      ? /^\/client\/(T[A-Z0-9]+)\/(?:lists|unified-files\/list)\/(F[A-Z0-9]+)\/?$/.exec(url.pathname)
      : null);
  if (!match) throw invalidUrl();
  if (match[1] !== workspaceId) throw new SlackListError('workspace_mismatch', 'Use a List from this Slack workspace.');
  const ids = url.searchParams.getAll('record_id');
  if (ids.length > 1 || (ids[0] !== undefined && !ITEM_ID.test(ids[0]))) throw invalidUrl();
  return { listId: match[2]!, ...(ids[0] ? { itemId: ids[0] } : {}) };
}

export function requireListItemId(value: string | undefined, fromUrl?: string): string {
  if (value !== undefined && fromUrl !== undefined && value !== fromUrl) {
    throw new SlackListError('item_mismatch', 'The item ID and item link identify different tasks.');
  }
  const id = value ?? fromUrl;
  if (!id || !ITEM_ID.test(id)) throw new SlackListError('item_required', 'Use the exact item link or an item ID returned from this List.');
  return id;
}

export function verifiedListPermalink(value: unknown, workspaceId: string, listId: string): string {
  if (!LIST_ID.test(listId) || typeof value !== 'string' || parseSlackListUrl(value, workspaceId).listId !== listId) {
    throw new SlackListError('invalid_response', 'Slack did not return a matching List link.');
  }
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function slackListItemUrl(listUrl: string, itemId: string): string {
  requireListItemId(itemId);
  const url = new URL(listUrl);
  url.searchParams.set('record_id', itemId);
  return url.toString();
}

function invalidUrl(): SlackListError {
  return new SlackListError('list_link_required', 'Provide a native Slack List link, or use a link explicitly supplied in the conversation or saved instructions.');
}
