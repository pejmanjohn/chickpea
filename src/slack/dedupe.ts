export class EventDedupeLedger {
  private readonly seen = new Set<string>();

  claim(eventId: string): boolean {
    if (this.seen.has(eventId)) {
      return false;
    }
    this.seen.add(eventId);
    return true;
  }
}
