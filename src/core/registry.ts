/**
 * A name-keyed registry. Instrument types, systems, commands and agent
 * behaviours all plug in through one of these, so adding a feature means
 * registering something new rather than editing a switch statement.
 */
export class Registry<T> {
  private items = new Map<string, T>();

  constructor(private readonly label: string) {}

  register(key: string, item: T): this {
    if (this.items.has(key)) {
      throw new Error(`${this.label}: "${key}" is already registered`);
    }
    this.items.set(key, item);
    return this;
  }

  /** Replace an existing entry. Intended for mods and tests, not core code. */
  override(key: string, item: T): this {
    this.items.set(key, item);
    return this;
  }

  get(key: string): T {
    const item = this.items.get(key);
    if (item === undefined) {
      throw new Error(`${this.label}: no entry for "${key}" (have: ${[...this.items.keys()].join(', ')})`);
    }
    return item;
  }

  tryGet(key: string): T | undefined {
    return this.items.get(key);
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  keys(): string[] {
    return [...this.items.keys()];
  }

  values(): T[] {
    return [...this.items.values()];
  }

  entries(): [string, T][] {
    return [...this.items.entries()];
  }
}
