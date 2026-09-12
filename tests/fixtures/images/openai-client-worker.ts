import {
  createOpenAiImagesClient,
  type ImageCallResult,
} from '../../../src/images/openai-images-client.ts';
import { findImageModel } from '../../../src/model-catalog/image-profiles.ts';

/**
 * Exercises the images client and the workerd fetch primitives it depends on
 * against a loopback stub. Only the scheme and host are rewritten on the way
 * out: the method, headers, body (JSON or multipart FormData), `redirect`
 * mode, and `signal` reach workerd's own `fetch` exactly as the client built
 * them, so this probes the runtime and not a mock.
 */
const BASE = 'https://images.probe.test/v1';

export default {
  async fetch(request: Request): Promise<Response> {
    const stub = new URL(request.url).searchParams.get('stub_url');
    if (!stub) return new Response('stub_url required', { status: 400 });
    const probes: Record<string, unknown> = {};
    for (const [name, run] of Object.entries(PROBES)) {
      try {
        probes[name] = await run(stub);
      } catch (err) {
        probes[name] = {
          threw: err instanceof Error ? err.name : 'unknown',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return Response.json(probes);
  },
};

const PROBES: Record<string, (stub: string) => Promise<unknown>> = {
  // The client sends `redirect: 'error'`; the direct Slack upload path sends
  // `redirect: 'manual'`. If workerd refused the former, every image call
  // would fail before reaching the provider.
  async redirectErrorAccepted(stub) {
    const response = await fetch(`${stub}/ok`, { redirect: 'error' });
    await response.body?.cancel().catch(() => {});
    return { status: response.status, url: response.url };
  },
  async redirectErrorRejectsRedirect(stub) {
    try {
      const response = await fetch(`${stub}/redirect`, { redirect: 'error' });
      await response.body?.cancel().catch(() => {});
      return { threw: false, status: response.status, redirected: response.redirected };
    } catch (err) {
      return {
        threw: true,
        name: err instanceof Error ? err.name : 'unknown',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
  // The portable alternative, and what the direct Slack upload already uses.
  async redirectManualAccepted(stub) {
    const response = await fetch(`${stub}/ok`, { redirect: 'manual' });
    await response.body?.cancel().catch(() => {});
    return { status: response.status, url: response.url };
  },
  async redirectManualExposesRedirect(stub) {
    const response = await fetch(`${stub}/redirect`, { redirect: 'manual' });
    await response.body?.cancel().catch(() => {});
    return { status: response.status, redirected: response.redirected, url: response.url };
  },
  // `rejectOffHostResponse` compares `response.url` to the configured host.
  async responseUrlPopulated(stub) {
    const response = await fetch(`${stub}/ok`);
    await response.body?.cancel().catch(() => {});
    return { url: response.url, hasUrl: response.url.length > 0 };
  },
  async generateSucceeds(stub) {
    return summarize(await client(stub).generate({
      prompt: 'A red kite over a harbour.',
      format: { format: 'jpeg', compression: 60 },
      deadlineMs: 20_000,
    }));
  },
  // A Blob-backed multipart body is the edit path's whole contract.
  async editSendsMultipart(stub) {
    return summarize(await client(stub, '/multipart-echo').edit({
      prompt: 'Put the logo on the poster.',
      format: { format: 'jpeg', compression: 60 },
      deadlineMs: 20_000,
      inputs: [{ bytes: pngBytes(), mimeType: 'image/png' }],
    }));
  },
  async deadlineAborts(stub) {
    return summarize(await client(stub, '/slow').generate({
      prompt: 'A slow one.',
      format: { format: 'png' },
      deadlineMs: 250,
    }));
  },
  async callerAbortStops(stub) {
    const controller = new AbortController();
    setTimeout(() => { controller.abort(); }, 200);
    return summarize(await client(stub, '/slow').generate({
      prompt: 'An abandoned one.',
      format: { format: 'png' },
      deadlineMs: 20_000,
      signal: controller.signal,
    }));
  },
  async base64DecodeWorks() {
    const binary = atob('AAECAw==');
    return { length: binary.length, first: binary.charCodeAt(0), last: binary.charCodeAt(3) };
  },
};

function client(stub: string, route = '') {
  const profile = findImageModel('openai/gpt-image-2.5-flare');
  if (!profile) throw new Error('image profile missing');
  return createOpenAiImagesClient({
    profile,
    apiKey: 'probe-key',
    baseUrl: BASE,
    fetchImpl: async (input, init) => {
      const target = new URL(String(input));
      const outgoing = new URL(stub);
      outgoing.pathname = `${outgoing.pathname.replace(/\/+$/, '')}${route || target.pathname}`;
      // Re-wrapped so `response.url` is empty and the off-host guard, which
      // this rewrite would otherwise trip, stays out of the probe's way.
      const response = await fetch(outgoing.toString(), init);
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, headers: response.headers });
    },
  });
}

function summarize(result: ImageCallResult): unknown {
  return result.ok
    ? {
        ok: true,
        byteLength: result.images[0]!.byteLength,
        appliedFormat: result.appliedFormat,
        appliedSize: result.appliedSize,
      }
    : { ok: false, reason: result.reason, detail: result.detail };
}

/** A 1x1 PNG, standing in for the small member upload that failed live. */
function pngBytes(): Uint8Array {
  const binary = atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  );
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
