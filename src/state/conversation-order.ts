/**
 * One conversation's deliveries in the order they arrived, and different
 * conversations side by side. An entry waits for every earlier entry of its
 * key to release.
 */
export class ConversationOrder {
  private readonly tails = new Map<string, Promise<void>>();

  /** Resolves once the earlier entries of `key` released; then release this one. */
  async enter(key: string): Promise<() => void> {
    const previous = this.tails.get(key);
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous ? previous.then(() => released) : released;
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    await previous;
    return release;
  }

  /** Conversations with an entry waiting or admitting. */
  get size(): number {
    return this.tails.size;
  }
}
