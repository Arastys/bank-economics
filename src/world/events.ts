import type { Money } from '../core/money.js';
import type { CreditGrade, EntityId } from './types.js';
import type { EventBus } from '../core/events.js';

/**
 * The game's event vocabulary.
 *
 * Extend by adding entries here, or from a feature module via declaration
 * merging:
 *
 *   declare module '../world/events.js' {
 *     interface GameEvents { 'insurance.claimFiled': { policyId: string } }
 *   }
 */
export interface GameEvents {
  'sim.tickStarted': { tick: number };
  'sim.tickEnded': { tick: number };
  'sim.monthEnded': { tick: number; month: number; year: number };
  'sim.quarterEnded': { tick: number; quarter: number; year: number };
  'sim.yearEnded': { tick: number; year: number };

  'policy.rateChanged': { from: number; to: number; reason: string };

  'credit.applicationSubmitted': {
    applicationId: string;
    applicantId: EntityId;
    amount: Money;
    termMonths: number;
    grade: CreditGrade;
  };
  'credit.applicationApproved': { applicationId: string; loanId: string; rate: number };
  'credit.applicationDeclined': { applicationId: string; reason: string };
  'credit.applicationExpired': { applicationId: string };

  'loan.originated': { loanId: string; lenderId: EntityId; borrowerId: EntityId; amount: Money; rate: number };
  'loan.repaid': { loanId: string; amount: Money; principal: Money; interest: Money };
  'loan.missedPayment': { loanId: string; borrowerId: EntityId; amount: Money };
  'loan.defaulted': { loanId: string; borrowerId: EntityId; exposure: Money; loss: Money };
  'loan.matured': { loanId: string };

  'deposit.opened': { depositId: string; bankId: EntityId; customerId: EntityId; amount: Money };
  'deposit.placed': { depositId: string; amount: Money };
  'deposit.withdrawn': { depositId: string; amount: Money };
  'deposit.closed': { depositId: string; reason: string };

  'bond.issued': { bondId: string; issuerId: EntityId; amount: Money; couponRate: number; maturesOn: number };
  'bond.traded': { bondId: string; buyerId: EntityId; sellerId: EntityId; nominal: Money; price: number; consideration: Money };
  'bond.couponPaid': { bondId: string; amount: Money };
  'bond.redeemed': { bondId: string; amount: Money };

  'company.founded': { companyId: EntityId; sector: string };
  'company.failed': { companyId: EntityId; sector: string };
  'company.gradeChanged': { companyId: EntityId; from: CreditGrade; to: CreditGrade };
  'company.hired': { companyId: EntityId; count: number };
  'company.laidOff': { companyId: EntityId; count: number };

  'lod.promoted': { entityId: EntityId; cohortId: EntityId; reason: string };
  'lod.demoted': { entityId: EntityId; cohortId: EntityId };

  'bank.capitalRatioChanged': { bankId: EntityId; ratio: number };
  'bank.breachedLimit': { bankId: EntityId; limit: string; value: number; threshold: number };
  'bank.periodClosed': { bankId: EntityId; profit: Money };

  'notice': { severity: 'info' | 'warning' | 'critical'; message: string };
}

export type GameEventBus = EventBus<GameEvents>;

export type Emitter = <K extends keyof GameEvents & string>(type: K, payload: GameEvents[K]) => void;
