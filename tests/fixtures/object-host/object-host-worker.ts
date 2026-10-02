// Real workerd Durable Object storage under the host functions every
// installation object delegates to: seed an object with SQL tables (one
// without a rowid), BLOBs, key-value entries and an alarm, export it a page
// at a time, refuse another installation, erase it and read back what is left.
import { DurableObject, type DurableObjectState } from 'cloudflare:workers';

import { objectInstallationEnv } from '../../../src/config/installation-scope.ts';
import { objectHostFunctions, type InstallationObjectHostRpc } from '../../../src/state/object-host.ts';

interface Env {
  CHICKPEA_TENANCY: string;
  PROBE: { getByName(name: string): ProbeObject };
}

export class ProbeObject extends DurableObject {
  private readonly scopedEnv: Record<string, unknown>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.scopedEnv = objectInstallationEnv(ctx, env as unknown as Record<string, unknown>);
  }

  private host(): InstallationObjectHostRpc {
    return objectHostFunctions({ env: this.scopedEnv, storage: this.ctx.storage as never });
  }

  async seed(): Promise<void> {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS transcript (id INTEGER PRIMARY KEY, body TEXT, image BLOB)');
    sql.exec('CREATE TABLE IF NOT EXISTS keyed (a TEXT NOT NULL, b INTEGER NOT NULL, v TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID');
    for (let index = 0; index < 40; index += 1) {
      sql.exec('INSERT INTO transcript (body, image) VALUES (?, ?)', `${'x'.repeat(200)} ${index}`, new Uint8Array([index, 255]));
      sql.exec('INSERT INTO keyed (a, b, v) VALUES (?, ?, ?)', `k${index % 3}`, index, `v${index}`);
    }
    // The application's minimal ambient storage type omits `put`.
    const storage = this.ctx.storage as typeof this.ctx.storage & { put(key: string, value: unknown): Promise<void> };
    await storage.put('flue:wake', { at: new Date(1_800_000_000_000), seen: new Map([['a', 1]]) });
    await storage.put('plain', 'value');
    await this.setAlarmAgain();
  }

  async setAlarmAgain(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 3_600_000);
  }

  async exportAll(installationId: string, maxBytes: number): Promise<{ text: string; pages: number }> {
    let cursor: string | null = null;
    let text = '';
    let pages = 0;
    do {
      const page = await this.host().chickpeaHostExportPage({ installationId, mode: 'full', maxBytes, ...(cursor ? { cursor } : {}) });
      text += page.lines;
      pages += 1;
      cursor = page.nextCursor;
    } while (cursor);
    return { text, pages };
  }

  async erase(installationId: string): Promise<{ erased: true }> {
    return this.host().chickpeaHostErase({ installationId });
  }

  async cancel(installationId: string): Promise<unknown> {
    return this.host().chickpeaHostCancelPendingWork({ installationId });
  }

  async state(): Promise<{ tables: string[]; entries: number; alarm: number | null }> {
    const tables = this.ctx.storage.sql.exec(
      // Local workerd keeps each object's name in `__miniflare_do_name`; deployed storage has no such table.
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE '\\_\\_miniflare%' ESCAPE '\\' ORDER BY name`,
    ).toArray().map((row) => String(row.name));
    const entries = (await this.ctx.storage.list()).size;
    return { tables, entries, alarm: await this.ctx.storage.getAlarm() };
  }

  async alarm(): Promise<void> {}
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/probe') return Response.json({ ok: true });
    try {
      const name = 'i1~inst_probe~T_PROBE:C_PROBE:1800000000.000100:owner-i1';
      const object = env.PROBE.getByName(name);
      await object.seed();
      const seeded = await object.state();
      const paged = await object.exportAll('inst_probe', 4_096);
      const whole = await object.exportAll('inst_probe', 4 * 1024 * 1024);
      let refused = '';
      try {
        await object.erase('inst_other');
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error);
      }
      const afterRefusal = await object.state();
      const cancelled = await object.cancel('inst_probe');
      const afterCancel = await object.state();
      await object.setAlarmAgain();
      const erased = await object.erase('inst_probe');
      const afterErase = await object.state();
      const reexported = await object.exportAll('inst_probe', 4_096);
      return Response.json({
        seeded, paged, whole, refused, afterRefusal, cancelled, afterCancel, erased, afterErase, reexported,
      });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.stack ?? error.message : String(error) }, { status: 500 });
    }
  },
};
