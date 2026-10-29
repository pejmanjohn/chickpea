export interface StubbedRequest {
  url: string;
  method: string;
  headers: Headers;
}

/**
 * Run with the platform fetch a connection check sends through when
 * `cloudflare: true` stubbed: DoH answers a public address, and every other
 * request is captured and answered by `respond`.
 */
export async function withConnectionNetwork<T>(
  respond: (request: StubbedRequest, signal: AbortSignal | undefined) => Response | Promise<Response>,
  run: (requests: StubbedRequest[]) => Promise<T>,
): Promise<T> {
  const previous = globalThis.fetch;
  const requests: StubbedRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://cloudflare-dns.com/dns-query')) {
      const type = new URL(url).searchParams.get('type');
      return Response.json({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] });
    }
    const request = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers) };
    requests.push(request);
    return respond(request, init?.signal ?? undefined);
  }) as typeof fetch;
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = previous;
  }
}
