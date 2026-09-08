/** Short-lived discovery cache. Authorization must still be checked on every use. */
export class ChannelDirectoryCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; result: Promise<T> }>();

  constructor(private readonly now = Date.now, private readonly ttlMs = 60_000) {}

  get(key: string, load: () => Promise<T>, refresh = false): Promise<T> {
    const current = this.entries.get(key);
    if (!refresh && current && current.expiresAt > this.now()) return current.result;
    const entry = { expiresAt: Infinity, result: Promise.resolve().then(load) };
    // Bound memory even when installations are replaced repeatedly.
    if (this.entries.size >= 32) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, entry);
    entry.result = entry.result.then((value) => {
      entry.expiresAt = this.now() + this.ttlMs;
      return value;
    }, (error: unknown) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    });
    return entry.result;
  }
}
