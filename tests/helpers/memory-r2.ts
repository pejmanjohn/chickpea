/**
 * An R2 bucket binding in memory, for the checkpoint bucket's tests: the
 * methods the Sandbox SDK calls (put, get, head, delete, list and multipart
 * uploads), with R2's list semantics (prefix, startAfter, a cursor that
 * continues after the last listed key, limit, delimiter). Its state and its
 * objects' bodies are private fields, so a method called with any `this`
 * but the binding's own throws, as R2's runtime objects do.
 */

export class MemoryR2Object {
  readonly #body: string;
  readonly size: number;

  constructor(readonly key: string, body: string, readonly uploaded: Date) {
    this.#body = body;
    this.size = Buffer.byteLength(body);
  }

  async text(): Promise<string> {
    return this.#body;
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.#body) as unknown;
  }
}

class MemoryUpload {
  readonly #bucket: MemoryR2Bucket;
  readonly #parts: Map<number, string>;

  constructor(bucket: MemoryR2Bucket, readonly key: string, readonly uploadId: string, parts: Map<number, string>) {
    this.#bucket = bucket;
    this.#parts = parts;
  }

  async uploadPart(partNumber: number, value: string): Promise<{ partNumber: number; etag: string }> {
    this.#parts.set(partNumber, value);
    return { partNumber, etag: `etag-${partNumber}` };
  }

  async complete(parts: Array<{ partNumber: number }>): Promise<MemoryR2Object> {
    const body = parts.map(({ partNumber }) => this.#parts.get(partNumber) ?? '').join('');
    return this.#bucket.put(this.key, body);
  }

  async abort(): Promise<void> {
    this.#parts.clear();
  }
}

export interface MemoryR2Call {
  readonly method: string;
  readonly keys: readonly string[];
  readonly options?: Record<string, unknown>;
}

export class MemoryR2Bucket {
  readonly #objects = new Map<string, MemoryR2Object>();
  readonly #uploads = new Map<string, Map<number, string>>();
  /** Every call, with the keys it named. */
  readonly calls: MemoryR2Call[] = [];
  /** The clock `put` stamps objects with. */
  now = () => new Date(Date.UTC(2026, 9, 3, 12));

  /** Every key, sorted. */
  keys(): string[] {
    return [...this.#objects.keys()].sort();
  }

  /** The bucket's contents, for byte-identical comparisons. */
  async snapshot(): Promise<Record<string, string>> {
    const entries = await Promise.all(this.keys().map(async (key) => [key, await this.#objects.get(key)!.text()] as const));
    return Object.fromEntries(entries);
  }

  /** Seed an object directly, with its own upload time. */
  seed(key: string, body: string, uploaded: Date = this.now()): void {
    this.#objects.set(key, new MemoryR2Object(key, body, uploaded));
  }

  async put(key: string, value: string): Promise<MemoryR2Object> {
    this.calls.push({ method: 'put', keys: [key] });
    const object = new MemoryR2Object(key, String(value), this.now());
    this.#objects.set(key, object);
    return object;
  }

  async get(key: string): Promise<MemoryR2Object | null> {
    this.calls.push({ method: 'get', keys: [key] });
    return this.#objects.get(key) ?? null;
  }

  async head(key: string): Promise<MemoryR2Object | null> {
    this.calls.push({ method: 'head', keys: [key] });
    return this.#objects.get(key) ?? null;
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    this.calls.push({ method: 'delete', keys: list });
    for (const key of list) this.#objects.delete(key);
  }

  async list(options: {
    prefix?: string; startAfter?: string; cursor?: string; limit?: number; delimiter?: string;
  } = {}) {
    this.calls.push({ method: 'list', keys: [], options });
    const prefix = options.prefix ?? '';
    const after = options.cursor ?? options.startAfter;
    const matching = this.keys().filter((key) => key.startsWith(prefix) && (after === undefined || key > after));
    const objects: MemoryR2Object[] = [];
    const delimited = new Set<string>();
    let last: string | undefined;
    for (const key of matching) {
      if (objects.length + delimited.size >= (options.limit ?? 1_000)) break;
      last = key;
      const rest = key.slice(prefix.length);
      const cut = options.delimiter ? rest.indexOf(options.delimiter) : -1;
      if (cut >= 0) delimited.add(`${prefix}${rest.slice(0, cut + options.delimiter!.length)}`);
      else objects.push(this.#objects.get(key)!);
    }
    const truncated = last !== undefined && matching.at(-1) !== last;
    return {
      objects,
      truncated,
      ...(truncated ? { cursor: last } : {}),
      delimitedPrefixes: [...delimited],
    };
  }

  async createMultipartUpload(key: string): Promise<MemoryUpload> {
    this.calls.push({ method: 'createMultipartUpload', keys: [key] });
    const uploadId = `upload-${this.#uploads.size + 1}`;
    const parts = new Map<number, string>();
    this.#uploads.set(uploadId, parts);
    return new MemoryUpload(this, key, uploadId, parts);
  }

  resumeMultipartUpload(key: string, uploadId: string): MemoryUpload {
    this.calls.push({ method: 'resumeMultipartUpload', keys: [key] });
    const parts = this.#uploads.get(uploadId);
    if (!parts) throw new Error('No such upload.');
    return new MemoryUpload(this, key, uploadId, parts);
  }
}
