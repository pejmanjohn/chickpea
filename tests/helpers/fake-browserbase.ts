import { fakeFetch, type FakeFetchCall } from './fake-cdp-socket.ts';

export interface FakeContext {
  projectId: string;
  name: string;
}

export interface FakeSession {
  projectId: string;
  status: string;
  contextId?: string;
  userMetadata: Record<string, unknown>;
}

/**
 * A stateful Browserbase for one project: sessions and contexts it created,
 * plus any a test seeds, answered the way the API documents. `fail` answers a
 * call first when it returns a response.
 */
export function fakeBrowserbase(options: { projectId?: string; fail?: (call: FakeFetchCall) => Response | undefined } = {}) {
  const projectId = options.projectId ?? 'proj-platform';
  const contexts = new Map<string, FakeContext>();
  const sessions = new Map<string, FakeSession>();
  const downloads = new Map<string, Array<{ pageId: string; status: string; downloadUrl?: string }>>();
  let counter = 0;
  const notFound = () => Response.json({ statusCode: 404, error: 'Not Found' }, { status: 404 });
  const { calls, fetchImpl } = fakeFetch((call) => {
    const failed = options.fail?.(call);
    if (failed) return failed;
    const url = new URL(call.url);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    const body = (call.body ?? {}) as Record<string, any>;
    if (parts[1] === 'contexts') {
      const id = parts[2];
      if (call.method === 'POST' && !id) {
        counter += 1;
        const created = `ctx_${counter}`;
        contexts.set(created, { projectId: body.projectId ?? projectId, name: body.name ?? '' });
        return Response.json({ id: created }, { status: 201 });
      }
      const context = id ? contexts.get(id) : undefined;
      if (!context) return notFound();
      if (call.method === 'GET') return Response.json({ id, ...context });
      if (call.method === 'DELETE') {
        contexts.delete(id!);
        return new Response(null, { status: 204 });
      }
    }
    if (parts[1] === 'sessions') {
      const id = parts[2];
      if (!id && call.method === 'POST') {
        counter += 1;
        const created = `sess_${counter}`;
        const contextId = body.browserSettings?.context?.id as string | undefined;
        sessions.set(created, {
          projectId: body.projectId ?? projectId,
          status: 'RUNNING',
          ...(contextId ? { contextId } : {}),
          userMetadata: body.userMetadata ?? {},
        });
        return Response.json({ id: created, connectUrl: `wss://connect.example/${created}`, ...(contextId ? { contextId } : {}) }, { status: 201 });
      }
      if (!id && call.method === 'GET') {
        const status = url.searchParams.get('status');
        const match = /^user_metadata\['([^']+)'\]:'([^']*)'$/.exec(url.searchParams.get('q') ?? '');
        return Response.json([...sessions].filter(([, session]) =>
          (!status || session.status === status) && (!match || session.userMetadata[match[1]!] === match[2]))
          .map(([sessionId, session]) => ({ id: sessionId, ...session })));
      }
      const session = id ? sessions.get(id) : undefined;
      if (!session) return notFound();
      if (parts[3] === 'debug') return Response.json({ debuggerFullscreenUrl: `https://live.example/${id}`, debuggerUrl: '', pages: [] });
      if (parts[3] === 'recording') {
        if (call.method === 'POST') {
          downloads.set(id!, [{ pageId: 'p1', status: 'COMPLETED', downloadUrl: `https://recordings.example/${id}.mp4` }]);
          return new Response(null, { status: 202 });
        }
        return Response.json({ downloads: downloads.get(id!) ?? [] });
      }
      if (call.method === 'GET') return Response.json({ id, ...session });
      if (call.method === 'POST') {
        session.status = 'COMPLETED';
        return Response.json({ id, ...session });
      }
    }
    return new Response('unexpected', { status: 500 });
  });
  const requests = () => calls.map(({ method, url }) => {
    const parsed = new URL(url);
    return `${method} ${parsed.pathname}${parsed.search ? decodeURIComponent(parsed.search) : ''}`;
  });
  return { projectId, contexts, sessions, downloads, calls, requests, fetchImpl };
}
