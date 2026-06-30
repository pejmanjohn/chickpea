import type { SlackReplyPost } from './replies.ts';

interface EventDedupeEntry {
  status: 'in_flight' | 'completed';
  finalReply?: SlackReplyPost;
}

export class EventDedupeLedger {
  private readonly events = new Map<string, EventDedupeEntry>();

  claim(eventId: string): boolean {
    if (this.events.has(eventId)) {
      return false;
    }
    this.events.set(eventId, { status: 'in_flight' });
    return true;
  }

  complete(eventId: string, finalReply: SlackReplyPost): void {
    this.events.set(eventId, {
      status: 'completed',
      finalReply,
    });
  }

  release(eventId: string): void {
    const entry = this.events.get(eventId);
    if (entry?.status === 'in_flight') {
      this.events.delete(eventId);
    }
  }

  finalReply(eventId: string): SlackReplyPost | undefined {
    return this.events.get(eventId)?.finalReply;
  }
}
