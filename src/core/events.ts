/**
 * A typed publish/subscribe bus.
 *
 * Systems never call each other. They emit events and subscribe to events,
 * which is what lets a new feature observe existing behaviour without anyone
 * editing the system that produced it.
 */
export interface EventMeta {
  tick: number;
  seq: number;
}

export type Handler<P> = (payload: P, meta: EventMeta) => void;
export type AnyHandler = (type: string, payload: unknown, meta: EventMeta) => void;
export type Unsubscribe = () => void;

export interface EmittedEvent {
  type: string;
  payload: unknown;
  meta: EventMeta;
}

export class EventBus<M extends { [K in keyof M]: unknown }> {
  private handlers = new Map<string, Set<Handler<never>>>();
  private anyHandlers = new Set<AnyHandler>();
  private seq = 0;
  private tick = 0;
  /** Events emitted during the current tick, in order. Cleared by `beginTick`. */
  private journal: EmittedEvent[] = [];

  beginTick(tick: number): void {
    this.tick = tick;
    this.seq = 0;
    this.journal = [];
  }

  on<K extends keyof M & string>(type: K, handler: Handler<M[K]>): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<never>);
    return () => set!.delete(handler as Handler<never>);
  }

  onAny(handler: AnyHandler): Unsubscribe {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  emit<K extends keyof M & string>(type: K, payload: M[K]): void {
    const meta: EventMeta = { tick: this.tick, seq: this.seq++ };
    this.journal.push({ type, payload, meta });
    const set = this.handlers.get(type);
    if (set) {
      // Copy so a handler may subscribe/unsubscribe without disturbing this pass.
      for (const handler of [...set]) (handler as Handler<M[K]>)(payload, meta);
    }
    for (const handler of [...this.anyHandlers]) handler(type, payload, meta);
  }

  /** Everything emitted this tick -- the UI activity feed reads from here. */
  drainJournal(): EmittedEvent[] {
    const out = this.journal;
    this.journal = [];
    return out;
  }

  peekJournal(): readonly EmittedEvent[] {
    return this.journal;
  }
}
