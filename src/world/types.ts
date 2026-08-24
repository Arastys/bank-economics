import type { Money } from '../core/money.js';
import type { Day } from '../core/time.js';

export type EntityId = string;

export type EntityKind = 'bank' | 'company' | 'person' | 'centralBank' | 'government' | 'cohort';

/**
 * Level of detail. `resolved` entities are simulated individually every tick;
 * `cohort` entities stand in for many latent members simulated statistically.
 */
export type Detail = 'resolved' | 'cohort';

export interface EntityBase {
  id: EntityId;
  kind: EntityKind;
  name: string;
  detail: Detail;
  /** Set when this entity was materialised out of a cohort. */
  originCohortId?: EntityId;
  createdOn: Day;
}

export type SectorId = string;
export type RegionId = string;
export type SizeBand = 'micro' | 'small' | 'medium' | 'large';

/** Internal credit grades, best to worst. */
export const CREDIT_GRADES = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'CCC'] as const;
export type CreditGrade = (typeof CREDIT_GRADES)[number];

export interface Sector {
  id: SectorId;
  name: string;
  /** Sensitivity of demand for this sector's output to the economic cycle. */
  cyclicality: number;
  /** Baseline annual probability of default for a mid-grade firm in this sector. */
  basePd: number;
  /** Typical capital intensity, used for investment and borrowing appetite. */
  capitalIntensity: number;
}

export interface Region {
  id: RegionId;
  name: string;
  populationWeight: number;
}

export interface CompanyFinancials {
  /** Trailing 12-month figures, refreshed at each month end. */
  revenue: Money;
  costs: Money;
  ebitda: Money;
  interestPaid: Money;
  /** EBITDA / interest. Infinity when there is no debt. */
  interestCover: number;
  /** Debt / EBITDA. */
  leverage: number;
}

export interface Company extends EntityBase {
  kind: 'company';
  detail: 'resolved';
  sector: SectorId;
  region: RegionId;
  sizeBand: SizeBand;
  creditGrade: CreditGrade;
  status: 'active' | 'distressed' | 'defaulted';

  employees: number;
  /**
   * How well the firm is run, as a multiple of the average for its sector.
   *
   * Drawn once at birth and fixed thereafter. It is baked into productivity,
   * so a better-run firm gets more out of the same people, has a lower unit
   * cost, and earns a better margin at the same market price -- which then
   * shows up in its earnings, its credit grade and whether it survives a bad
   * year. Nothing else needs to know about it for it to matter.
   */
  quality: number;
  /** Units of output per employee per business day, quality already included. */
  productivity: number;
  /** Daily wage bill per employee. */
  wagePerEmployee: Money;
  /**
   * The month of the year this firm settles pay, 1-12, drawn at birth.
   *
   * Real pay rounds are staggered across the calendar. Everyone here used to
   * settle on the same monthly tick with the same number, which is a
   * synchronisation machine: one shock moved every wage in the economy at
   * once, and the boom-bust cycle that produced is most of the model's
   * inflation volatility.
   */
  payReviewMonth: number;
  /** `economy.wageIndex` as it stood when this firm last settled pay. */
  wageIndexAtReview: number;
  /** Unit price the firm currently charges. */
  price: Money;
  /** Finished goods on hand, in units. */
  inventoryUnits: number;
  /** Units sold on the most recent tick -- feeds pricing and hiring. */
  lastSoldUnits: number;
  /** Smoothed daily takings, which is what investment spending is sized from. */
  recentRevenue: Money;
  /** Smoothed daily unit sales. Firms put roughly this much on the shelf. */
  expectedSales: number;

  /** Annualised probability of default, refreshed by the credit risk system. */
  pdAnnual: number;
  financials: CompanyFinancials;

  /** Banking relationship. A company borrowing from the player is always resolved. */
  bankId?: EntityId;
  /** Cash the firm wants to raise but has not yet secured. */
  fundingNeed: Money;
  /** Set while an application is with a lender, to avoid duplicate requests. */
  applicationId?: string;
}

export interface Person extends EntityBase {
  kind: 'person';
  detail: 'resolved';
  region: RegionId;
  employerId?: EntityId;
  employed: boolean;
  /** Daily wage when employed. */
  wage: Money;
  /** Share of income spent rather than saved. */
  propensityToConsume: number;
  bankId?: EntityId;
  creditGrade: CreditGrade;
  pdAnnual: number;
  /** Money received on the most recent tick. */
  lastIncome: Money;
  /** Smoothed daily income. People budget from this, not from payday. */
  incomeRate: Money;
}

export interface Bank extends EntityBase {
  kind: 'bank';
  detail: 'resolved';
  /** True for the bank the human is running. */
  isPlayer: boolean;
  policy: BankPolicy;
  /** Staff, premises and systems, paid at each month end. */
  operatingCostPerMonth: Money;
}

/** Everything the player can set that the automated systems then act on. */
export interface BankPolicy {
  /** Annual rate paid on instant-access deposits. */
  depositRate: number;
  /** Annual rate paid on term deposits. */
  termDepositRate: number;
  /** Margin over Bank Rate charged on new corporate lending, by grade. */
  lendingSpread: Record<CreditGrade, number>;
  /** Worst grade the bank will lend to at all. */
  minimumGrade: CreditGrade;
  /** Largest single loan the bank will write automatically. */
  maxSingleExposure: Money;
  /**
   * Most of a borrower's monthly earnings the bank will let debt service take
   * up. The single most important brake on lending: without it the bank will
   * happily lend a healthy economy into insolvency.
   */
  maxDebtServiceRatio: number;
  /** Reject applications that would push the capital ratio below this. */
  targetCapitalRatio: number;
  /** Cash buffer the treasury system tries to maintain, as a share of deposits. */
  targetLiquidityRatio: number;
  /** Automatically approve applications that pass the credit policy. */
  autoUnderwrite: boolean;
}

export interface CentralBank extends EntityBase {
  kind: 'centralBank';
  detail: 'resolved';
  /** Bank Rate, annualised. */
  bankRate: number;
  inflationTarget: number;
  /** Corridor around Bank Rate for the deposit and lending facilities. */
  corridor: number;
}

export interface Government extends EntityBase {
  kind: 'government';
  detail: 'resolved';
}

/** Distribution parameters describing the latent members of a cohort. */
export interface CompanyArchetype {
  sector: SectorId;
  region: RegionId;
  sizeBand: SizeBand;
  creditGrade: CreditGrade;
  /** Log-normal parameters for relative member size (mean of the factor is 1). */
  sizeSigma: number;
  meanEmployees: number;
  meanProductivity: number;
  meanWagePerEmployee: Money;
  meanPrice: Money;
}

export interface PersonArchetype {
  region: RegionId;
  creditGrade: CreditGrade;
  meanWage: Money;
  wageSigma: number;
  meanPropensityToConsume: number;
  employmentRate: number;
}

export interface Cohort extends EntityBase {
  kind: 'cohort';
  detail: 'cohort';
  memberKind: 'company' | 'person';
  /** Latent members still inside the pool. */
  count: number;
  archetype: CompanyArchetype | PersonArchetype;
  /**
   * Aggregate non-monetary state for the latent members: headcount, stock on
   * hand, and so on. Money always lives in the ledger, never here.
   */
  pool: Record<string, number>;
  /** Monotonic, so each materialised member gets a stable identity. */
  nextMemberIndex: number;
  /** Where the pool banks. Usually the aggregate rival bank. */
  bankId?: EntityId;
}

export type Entity = Bank | Company | Person | CentralBank | Government | Cohort;

export function isCompany(e: Entity): e is Company {
  return e.kind === 'company';
}
export function isPerson(e: Entity): e is Person {
  return e.kind === 'person';
}
export function isBank(e: Entity): e is Bank {
  return e.kind === 'bank';
}
export function isCohort(e: Entity): e is Cohort {
  return e.kind === 'cohort';
}
