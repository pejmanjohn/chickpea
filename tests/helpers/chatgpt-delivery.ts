/**
 * How ChatGPT answers a card's tool call, as probes 12 and 13 measured it
 * on 2026-11-10 and 11. A result with `isError` comes back as a JSON-RPC
 * error whose message holds only the result's text blocks, as Python reprs
 * inside ChatGPT's own wrapper: no `data`, no `structuredContent`, no
 * `_meta`. A tool ChatGPT has not listed since the app connected never
 * reaches the server. A call that runs 300 s is cut off with Cloudflare's
 * 504 page as the message, while the server finishes it. The node tests and
 * the browser harness both use this.
 */

export interface ChatGptError {
  code: number;
  message: string;
}

export const RESOURCE_NOT_FOUND: ChatGptError = { code: -32000, message: JSON.stringify({ detail: 'MCP Resource not found' }) };

export function chatGptError(result: { content?: Array<{ type: string; text?: string }> }): ChatGptError {
  const blocks = (result.content ?? []).filter(({ type }) => type === 'text')
    .map(({ text = '' }) => `TextContent(type='text', text=${pythonRepr(text)}, annotations=None, meta=None)`);
  return {
    code: -32000,
    message: JSON.stringify({
      detail: `Error code: INVALID_ARGUMENT; Error: RuntimeException: Error calling MCP tool: [${blocks.join(', ')}]`,
    }),
  };
}

/** Python's `repr` of a str. */
function pythonRepr(text: string): string {
  const quote = text.includes('\'') && !text.includes('"') ? '"' : '\'';
  const escaped = [...text].map((char) => {
    if (char === '\\' || char === quote) return `\\${char}`;
    if (char === '\n') return '\\n';
    if (char === '\r') return '\\r';
    if (char === '\t') return '\\t';
    const code = char.codePointAt(0)!;
    return code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : char;
  });
  return `${quote}${escaped.join('')}${quote}`;
}

/**
 * Cloudflare's 504 page, as ChatGPT sends it for a call cut off at 300 s,
 * with the person's IP address in it. Made up here: the address is a
 * documentation one, and the Ray ID is not real.
 */
export const GATEWAY_TIMEOUT_IP = '203.0.113.42';
export const GATEWAY_TIMEOUT: ChatGptError = {
  code: -32000,
  message: [
    '<!DOCTYPE html>',
    '<html class="no-js" lang="en-US"><head><title>chatgpt.com | 504: Gateway time-out</title>',
    '<meta charset="UTF-8" /><meta name="robots" content="noindex, nofollow" /></head>',
    '<body><div id="cf-wrapper"><div id="cf-error-details">',
    '<h1><span class="inline-block">Gateway time-out</span> <span class="code-label">Error code 504</span></h1>',
    '<p>The web server reported a gateway time-out error.</p>',
    '<div class="cf-error-footer"><span>Cloudflare Ray ID: <strong>9a0b1c2d3e4f5a6b</strong></span>',
    `<span id="cf-footer-item-ip">Your IP: <span class="hidden">${GATEWAY_TIMEOUT_IP}</span></span>`,
    '<span>Performance &amp; security by Cloudflare</span></div></div></div></body></html>',
  ].join('\n'),
};
