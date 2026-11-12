import { AsyncLocalStorage } from 'node:async_hooks';

import type { FlueExecutionInterceptor } from '@flue/runtime';

/**
 * The OpenAI SDK throws on an SSE `error` event with its code on the error
 * object, and pi-ai keeps only the message. This reads the stream through
 * pi-ai's `fetch` option, before the SDK reads each chunk, and keeps the code
 * for the Flue model turn that opened it. Nothing the SDK sees changes.
 */
const CODE = /^[a-z][a-z0-9_]{0,39}$/;
const modelTurns = new AsyncLocalStorage<string>();
const codes = new Map<string, string>();

/** Runs each Flue model operation with its turn in scope, where the provider opens its stream. */
export const providerStreamErrorTurnInterceptor: FlueExecutionInterceptor = (operation, _context, next) =>
  operation.type === 'model' ? modelTurns.run(operation.turnId, next) : next();

/** `base`, noting an in-stream error's code for the model turn in scope, if any. */
export function observingProviderStreamErrors(base: typeof fetch | undefined): typeof fetch | undefined {
  const turnId = modelTurns.getStore();
  if (turnId === undefined) return base;
  codes.delete(turnId);
  return async (input, init) => {
    const response = await (base ?? globalThis.fetch)(input, init);
    if (!response.ok || !response.body ||
        !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) return response;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const scan = errorEventScanner((code) => {
      codes.delete(turnId);
      codes.set(turnId, code);
      if (codes.size > 64) codes.delete(codes.keys().next().value!);
    });
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) return controller.close();
        scan(decoder.decode(chunk.value, { stream: true }));
        controller.enqueue(chunk.value);
      },
      cancel: (reason) => reader.cancel(reason),
    }), response);
  };
}

/** The in-stream error code of a model turn, once. */
export function takeProviderStreamErrorCode(turnId: string | undefined): string | undefined {
  const code = turnId === undefined ? undefined : codes.get(turnId);
  if (code !== undefined) codes.delete(turnId!);
  return code;
}

/**
 * The SDK throws on an event named `error` (its data, or the data's `error`)
 * and on any event whose data has an `error` object; only those are parsed.
 */
function errorEventScanner(found: (code: string) => void): (text: string) => void {
  let pending = '';
  let name = '';
  let data: string[] = [];
  return (text) => {
    pending += text;
    // A long event arrives in many chunks; do not rescan it for each one.
    if (!text.includes('\n')) return;
    const lines = pending.split('\n');
    pending = lines.pop()!;
    for (const raw of lines) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(line.startsWith('data: ') ? 6 : 5));
      else if (line === '') {
        const payload = data.join('\n');
        const event = name;
        name = '';
        data = [];
        if (event !== 'error' && !/"error"\s*:\s*\{/.test(payload)) continue;
        try {
          const parsed = JSON.parse(payload) as { error?: { code?: unknown }; code?: unknown };
          const code = typeof parsed.error === 'object' && parsed.error ? parsed.error.code
            : event === 'error' ? parsed.code : undefined;
          if (typeof code === 'string' && CODE.test(code)) found(code);
        } catch {
          // Not JSON: the SDK fails on it itself.
        }
      }
    }
  };
}
