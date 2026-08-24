/**
 * Ids are sequential per prefix and stored on the world, so a replay of the
 * same commands from the same seed produces byte-identical ids.
 */
export interface IdCounters {
  [prefix: string]: number;
}

export function nextId(counters: IdCounters, prefix: string): string {
  const n = (counters[prefix] ?? 0) + 1;
  counters[prefix] = n;
  return `${prefix}:${String(n).padStart(6, '0')}`;
}

export function peekId(counters: IdCounters, prefix: string): string {
  return `${prefix}:${String((counters[prefix] ?? 0) + 1).padStart(6, '0')}`;
}
