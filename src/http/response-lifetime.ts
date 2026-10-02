/**
 * `response`, with the end of its body handed to `waitUntil`. A host that
 * releases a request's resources (a per-request database pool) once every
 * `waitUntil` promise has settled then keeps them while a streamed body (an
 * MCP event stream whose tool calls run as it is written) is still being
 * produced, not only until the handler returned. The promise settles when
 * the body has been written out, fails, or the client goes away. A response
 * without a body is returned as it is.
 */
export function holdUntilResponseEnds(
  response: Response,
  waitUntil: (promise: Promise<unknown>) => void,
): Response {
  if (response.body === null || response.status === 101) return response;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  waitUntil(response.body.pipeTo(writable).catch(() => undefined));
  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
