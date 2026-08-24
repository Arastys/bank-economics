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

export interface PersonCohortSpec {
  id?: string;
  region: string;
  creditGrade: CreditGrade;
  count: number;
  meanWage: Money;
  wageSigma: number;
  meanPropensityToConsume: number;
  employmentRate: number;
  savingsPerPerson: Money;
  debtPerPerson: Money;
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
    /**
     * How many rival banks the rest of the market is divided into. One is the
     * old behaviour: a single aggregate holding everyone else's deposits.
     */
    count: number;
    giltsToDeposits: number;
    equityToDeposits: number;
  };

  companyCohorts: CompanyCohortSpec[];
  personCohorts: PersonCohortSpec[];

  /** Corporate borrowers the player already banks, materialised at the start. */
  existingCorporateCustomers: number;

  /**
   * How many cohorts each company specification is split into.
   *
   * A cohort is one price-setter however many firms it stands for, so ten
   * cohorts means the entire latent economy trades at ten prices. Splitting
   * them costs almost nothing -- the members stay latent either way -- and buys
   * real dispersion in prices, productivity and pay across the economy.
   */
  cohortSubdivision?: number;

  /**
   * How different those slices are from one another, as a log-normal spread.
   *
   * Dispersion is not free the way subdivision is. Permanent cost differences
   * mean permanent competitive losers, and this economy has no firm entry or
   * exit for them to be replaced through -- they simply shrink and shed staff.
   * Keep it modest until firm demography exists.
   */
  cohortDispersion?: number;

  gilts: {
    /** Tenors issued, in years. The programme is split evenly across them. */
    tenors: number[];
    couponSpread: number;
  };
}
