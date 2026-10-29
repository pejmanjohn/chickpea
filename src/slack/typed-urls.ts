/**
 * The http(s) URLs in the requester's text. Slack sends a typed URL as
 * `<url>` or `<url|label>`; only the target counts, since a label can show
 * another URL.
 */
export function requesterTypedUrls(requestText: string): URL[] {
  const text = requestText
    .replace(/<(https?:\/\/[^>|\s]+)(?:\|[^>]*)?>/gi, ' $1 ')
    .replace(/&amp;/gi, '&');
  return [...text.matchAll(/https?:\/\/[^\s<>"'`|]+/gi)].flatMap(([match]) => {
    try {
      const url = new URL(match.replace(/[.,;:!?)\]}]+$/, ''));
      // `https://api.example.com@evil.example/` names evil.example; never count it as typed.
      if (url.username || url.password) return [];
      // Slack links a bare `api.example.com/v1` as http://; a connection only ever sends over https.
      if (url.protocol === 'http:' && url.port === '') url.protocol = 'https:';
      return [url];
    } catch {
      return [];
    }
  });
}
