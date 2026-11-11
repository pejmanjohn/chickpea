// Real workerd Durable Objects for the store fallback: a Worker calls a
// method that a store on older code lacks (OldStore), and one that a store on
// newer code has (NewStore), and reports what the runtime did.
import { DurableObject } from 'cloudflare:workers';

import { withStoreFallback } from '../../../src/config/store-fallback.ts';

type Answer = { ok: true; value: string };

/** A store on the code from before `added` existed. Every method it runs is counted in its storage. */
export class OldStore extends DurableObject {
  async ran(): Promise<number> {
    return Number(await this.ctx.storage.get('ran') ?? 0);
  }

  async existing(): Promise<Answer> {
    await this.ctx.storage.put('ran', (await this.ran()) + 1);
    return { ok: true, value: 'old' };
  }
}

/** The same store on newer code. */
export class NewStore extends OldStore {
  async added(): Promise<Answer> {
    await this.ctx.storage.put('ran', (await this.ran()) + 1);
    return { ok: true, value: 'new' };
  }
}

interface Env {
  OLD_STORE: { getByName(name: string): OldStore };
  NEW_STORE: { getByName(name: string): NewStore };
}

/** `added` through the fallback helper; the fallback reads `existing`. */
function addedOrExisting(stub: OldStore) {
  return withStoreFallback<{ value: string; fellBack?: string }>(
    'added',
    async () => ({ value: (await (stub as unknown as NewStore).added()).value }),
    async (reason) => ({ value: (await stub.existing()).value, fellBack: reason }),
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/missing-method') {
      const old = env.OLD_STORE.getByName(crypto.randomUUID());
      const before = await old.ran();
      let threw: string | undefined;
      let pending: Promise<unknown> | undefined;
      try {
        pending = (old as unknown as NewStore).added();
      } catch (error) {
        threw = String(error);
      }
      let rejected: { name: string; message: string } | undefined;
      try {
        await pending;
      } catch (error) {
        rejected = { name: (error as Error).name, message: (error as Error).message };
      }
      const after = await old.ran();
      const fallback = await addedOrExisting(old);
      const afterFallback = await old.ran();
      const current = env.NEW_STORE.getByName(crypto.randomUUID());
      const answered = await addedOrExisting(current as unknown as OldStore);
      return Response.json({ threw, rejected, before, after, fallback, afterFallback, answered, ranOnNew: await current.ran() });
    }
    return new Response('ok');
  },
};
