import { AC } from '../ledger/accounts.js';
import { cashWallet, depositWallet, reserveWallet, type Wallet } from '../ledger/payments.js';
import { getEntity, type WorldState } from './state.js';
import type { EntityId } from './types.js';

/**
 * Where an entity keeps its spendable money.
 *
 * Firms and people bank with someone; banks, the central bank and the
 * state settle in reserves. Unbanked parties fall back to notes.
 */
export function walletOf(world: WorldState, id: EntityId): Wallet {
  const entity = getEntity(world, id);
  switch (entity.kind) {
    case 'bank':
    case 'centralBank':
    case 'government':
      return reserveWallet(id);
    case 'company':
    case 'person':
      return entity.bankId ? depositWallet(id, entity.bankId) : cashWallet(id);
    case 'cohort':
      // A pool banks somewhere -- usually the aggregate rival bank. Money
      // moving between your customers and the pool therefore moves reserves
      // between you and your competitors, which is where deposit flight comes
      // from when your rates are uncompetitive.
      return entity.bankId ? depositWallet(id, entity.bankId) : cashWallet(id);
    default:
      return cashWallet(id);
  }
}

export function bankOf(world: WorldState, id: EntityId): EntityId | undefined {
  const entity = world.entities[id];
  if (!entity) return undefined;
  return entity.kind === 'company' || entity.kind === 'person' || entity.kind === 'cohort'
    ? entity.bankId
    : undefined;
}

export { AC };
