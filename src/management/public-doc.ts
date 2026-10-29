import { isAllowedConnectorHost } from '../config/agent-write-rules.ts';

export const PUBLIC_DOC_READS_PER_TURN = 6;
export const PUBLIC_DOC_MAX_TEXT_CHARS = 24_000;
export const PUBLIC_DOC_MAX_LINKS = 50;
export const PUBLIC_DOC_MAX_BYTES = 2 * 1024 * 1024;
export const PUBLIC_DOC_MAX_REDIRECTS = 3;
export const PUBLIC_DOC_TIMEOUT_MS = 10_000;
/** A followed link's path is capped so a page cannot steer a read into carrying conversation text. */
export const PUBLIC_DOC_MAX_LINK_PATH_CHARS = 200;

/**
 * read_public_doc's input. The model gives only `url`; the Slack tool adds
 * the links this turn's earlier reads returned, which the model never sets.
 */
export interface ReadPublicDocInput {
  url: string;
  turnLinks: readonly string[];
}

export type ReadPublicDocResult = PublicDocPage | PublicDocUnreadable;

/** One page, as untrusted content: data to read, never instructions. */
export interface PublicDocPage {
  outcome: 'read';
  /** Where the page was read from, after redirects. */
  url: string;
  status: number;
  title?: string;
  untrusted: true;
  instruction: string;
  /** More text existed than `text` holds. */
  truncated: boolean;
  /** Same-host links without query strings, most related to this page first; each may be read next in this turn. */
  links: string[];
  text: string;
}

export type PublicDocUnreadableReason = 'timeout' | 'unreachable' | 'blocked' | 'too_many_redirects' | 'not_text';

/** A read that went out but brought back no page. It still counts toward the turn's reads. */
export interface PublicDocUnreadable {
  outcome: 'unreadable';
  url: string;
  reason: PublicDocUnreadableReason;
  message: string;
}

export type PublicDocRefusal = 'invalid' | 'not_public' | 'not_given';

export type PublicDocAdmission =
  | { admitted: true; url: URL }
  | { admitted: false; reason: PublicDocRefusal };

export const PUBLIC_DOC_REFUSALS: Record<PublicDocRefusal, string> = {
  invalid: 'Nothing was read: pass one full https URL.',
  not_public: 'Nothing was read: read_public_doc reads only public https pages on the standard port, never a local, private or internal address.',
  not_given: 'Nothing was read: read_public_doc reads only a URL the requester typed in their own current message to this Agent, or a link in links from a page read earlier in this turn. Ask the requester to send the docs link in their own message.',
};

/**
 * Whether `raw` may be read now: a URL the requester typed in their own
 * current message, or a link an earlier read in this turn returned. Either
 * way it must be a public https URL on the standard port.
 */
export function admitPublicDocUrl(
  raw: string,
  typed: readonly URL[],
  turnLinks: readonly string[],
): PublicDocAdmission {
  const url = publicDocUrl(raw);
  if (!url) return { admitted: false, reason: 'invalid' };
  if (!isPublicDocUrl(url)) return { admitted: false, reason: 'not_public' };
  if (typed.some((entry) => sameTypedUrl(entry, url))) return { admitted: true, url };
  const link = followedLink(url);
  return link && turnLinks.includes(link.href)
    ? { admitted: true, url: link }
    : { admitted: false, reason: 'not_given' };
}

/** `raw` as a URL without its fragment, resolved against `base` when given. A bare http URL becomes https, as Slack links a bare domain as http. */
export function publicDocUrl(raw: string, base?: URL): URL | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim(), base);
  } catch {
    return undefined;
  }
  url.hash = '';
  if (url.protocol === 'http:' && url.port === '') url.protocol = 'https:';
  return url;
}

export function isPublicDocUrl(url: URL): boolean {
  return url.protocol === 'https:' && !url.username && !url.password && isAllowedConnectorHost(url.host);
}

/** The form a followed link takes: no query string, and a bounded path. */
export function followedLink(url: URL): URL | undefined {
  if (url.pathname.length > PUBLIC_DOC_MAX_LINK_PATH_CHARS) return undefined;
  const link = new URL(url.href);
  link.search = '';
  return link;
}

/** A typed URL names the page when origin, path (give or take one trailing slash) and query all match. */
function sameTypedUrl(typed: URL, url: URL): boolean {
  const [left, right] = [typed.pathname, url.pathname];
  return typed.origin === url.origin && typed.search === url.search &&
    (left === right || left === `${right}/` || `${left}/` === right);
}
