import type { Money } from '../core/money.js';
import type { CalendarDate } from '../core/time.js';
import type { SimConfig } from '../world/state.js';
import type { BankPolicy, CreditGrade, Region, Sector, SizeBand } from '../world/types.js';

export interface CompanyCohortSpec {
  sector: string;
  region: string;
  sizeBand: SizeBand;
  creditGrade: CreditGrade;
  count: number;
  meanEmployees: number;
  /** Units of output per employee per business day. */
  meanProductivity: number;
  meanWagePerEmployee: Money;
  meanPrice: Money;
  /** Spread of firm sizes within the cohort. */
  sizeSigma: number;
  /** Opening balances per member. */
  cashPerFirm: Money;
  fixedAssetsPerFirm: Money;
  inventoryValuePerFirm: Money;
  debtPerFirm: Money;
}

export interface HouseholdCohortSpec {
  id?: string;
  region: string;
  creditGrade: CreditGrade;
  count: number;
  meanWage: Money;
  wageSigma: number;
  meanPropensityToConsume: number;
  employmentRate: number;
  savingsPerHousehold: Money;
  debtPerHousehold: Money;
  /** Set to bank this cohort with the player rather than the rest of the market. */
  banksWithPlayer?: boolean;
}

export interface ScenarioSpec {
  id: string;
  name: string;
  description: string;
  seed: number;
  startDate: CalendarDate;
  config?: Partial<SimConfig>;

  sectors: Sector[];
  regions: Region[];

  centralBank: {
    name: string;
    bankRate: number;
    inflationTarget: number;
    corridor: number;
  };

  playerBank: {
    name: string;
    policy: BankPolicy;
    operatingCostPerMonth: Money;
    /** Gilts held, as a multiple of the deposit base. */
    giltsToDeposits: number;
    /**
     * Opening shareholders' funds. Reserves are the balancing figure, so this
     * sets how much room the bank has to lend before capital binds.
     */
    equity: Money;
  };

  otherBanks: {
    name: string;
    giltsToDeposits: number;
    equityToDeposits: number;
  };

  companyCohorts: CompanyCohortSpec[];
  householdCohorts: HouseholdCohortSpec[];

  /** Corporate borrowers the player already banks, materialised at the start. */
  existingCorporateCustomers: number;

  gilts: {
    /** Tenors issued, in years. The programme is split evenly across them. */
    tenors: number[];
    couponSpread: number;
  };
}
