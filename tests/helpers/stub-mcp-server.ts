/**
 * A streamable-HTTP MCP server at one URL, answered in process. The Node MCP
 * transport sends every request through `https.request` pinned to the
 * address the guard checked (config/mcp-url.ts), so this replaces that one
 * function for the stub's origin and passes everything else through.
 */
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';

type JsonRpc = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> };

export interface StubMcpServer {
  /** Every tool the server was asked to run, in order. */
  calls: string[];
  restore(): void;
}

export function installStubMcpServer(url: string, tools: readonly string[]): StubMcpServer {
  const origin = new URL(url).origin;
  const original = https.request;
  const calls: string[] = [];
  const answer = (message: JsonRpc): unknown => {
    switch (message.method) {
      case 'initialize':
        return {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'stub-orders', version: '1.0.0' },
        };
      case 'tools/list':
        return {
          tools: tools.map((name) => ({
            name, description: `The stub ${name}.`, inputSchema: { type: 'object', properties: {} },
          })),
        };
      case 'tools/call':
        calls.push(String(message.params?.name));
        return { content: [{ type: 'text', text: 'stub answer' }] };
      default:
        return {};
    }
  };
  const respond = (method: string, payload: Buffer | undefined) => {
    if (method !== 'POST' || !payload) return { status: 405, body: undefined };
    const parsed = JSON.parse(payload.toString('utf8')) as JsonRpc | JsonRpc[];
    const replies = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((message) => message.id !== undefined)
      .map((message) => ({ jsonrpc: '2.0', id: message.id, result: answer(message) }));
    if (replies.length === 0) return { status: 202, body: undefined };
    return { status: 200, body: JSON.stringify(Array.isArray(parsed) ? replies : replies[0]) };
  };
  const stub = ((target: string | URL, options: { method?: string }, callback: (incoming: Readable) => void) => {
    if (new URL(String(target)).origin !== origin) {
      return (original as (...args: unknown[]) => unknown)(target, options, callback);
    }
    const outgoing = Object.assign(new EventEmitter(), {
      end(payload?: Buffer) {
        queueMicrotask(() => {
          const { status, body } = respond(options.method ?? 'GET', payload);
          const incoming = Object.assign(new Readable({ read() {} }), {
            statusCode: status,
            statusMessage: status === 200 ? 'OK' : 'Stub',
            rawHeaders: body === undefined ? [] : ['content-type', 'application/json'],
          });
          callback(incoming);
          if (body !== undefined) incoming.push(Buffer.from(body));
          incoming.push(null);
        });
      },
    });
    return outgoing;
  }) as unknown as typeof https.request;
  https.request = stub;
  syncBuiltinESMExports();
  return {
    calls,
    restore() {
      https.request = original;
      syncBuiltinESMExports();
    },
  };
}
