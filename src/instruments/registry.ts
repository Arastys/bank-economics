import { Registry } from '../core/registry.js';
import type { InstrumentType } from './types.js';

/**
 * All product behaviour is registered here. Adding a mortgage, an overdraft or
 * a derivative means registering another handler -- no existing file changes.
 */
export const instrumentTypes = new Registry<InstrumentType>('InstrumentType');

export function typeOf(key: string): InstrumentType {
  return instrumentTypes.get(key);
}
