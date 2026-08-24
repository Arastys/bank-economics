import { pounds, type Money } from '../core/money.js';
import type { BankPolicy, CreditGrade } from '../world/types.js';
import type { ScenarioSpec } from './types.js';

const spread = (values: Partial<Record<CreditGrade, number>>): Record<CreditGrade, number> => ({
  AAA: 0.008,
  AA: 0.010,
  A: 0.015,
  BBB: 0.022,
  BB: 0.040,
  B: 0.065,
  CCC: 0.110,
  ...values,
});

const defaultPolicy: BankPolicy = {
  depositRate: 0.021,
  termDepositRate: 0.032,
  lendingSpread: spread({}),
  minimumGrade: 'B',
  maxDebtServiceRatio: 0.6,
  maxSingleExposure: pounds(4_000_000),
  targetCapitalRatio: 0.12,
  targetLiquidityRatio: 0.07,
  autoUnderwrite: true,
};

/**
 * A mid-sized UK challenger bank, three years old, sitting on more deposits
 * than it has managed to lend out.
 *
 * The opening position is deliberately liquid and under-lent: the interesting
 * decisions are about how fast to deploy that money, at what price, and to
 * whom -- and what happens to your funding when you get the price wrong.
 */
export const uk2025: ScenarioSpec = {
  id: 'uk2025',
  name: 'Sterling & Vale',
  description: 'A liquid, under-lent UK challenger bank looking for a loan book.',
  seed: 20250101,
  startDate: { year: 2025, month: 1, day: 6 },

  sectors: [
    { id: 'retail', name: 'Retail', cyclicality: 1.1, basePd: 0.015, capitalIntensity: 0.4 },
    { id: 'hospitality', name: 'Hospitality', cyclicality: 1.5, basePd: 0.011, capitalIntensity: 0.5 },
    { id: 'manufacturing', name: 'Manufacturing', cyclicality: 1.3, basePd: 0.022, capitalIntensity: 1.2 },
    { id: 'construction', name: 'Construction', cyclicality: 1.6, basePd: 0.019, capitalIntensity: 0.9 },
    { id: 'professional', name: 'Professional services', cyclicality: 0.8, basePd: 0.015, capitalIntensity: 0.2 },
    { id: 'technology', name: 'Technology', cyclicality: 1.0, basePd: 0.010, capitalIntensity: 0.5 },
    { id: 'transport', name: 'Transport & logistics', cyclicality: 1.2, basePd: 0.014, capitalIntensity: 1.1 },
    { id: 'health', name: 'Health & care', cyclicality: 0.4, basePd: 0.006, capitalIntensity: 0.8 },
  ],

  regions: [
    { id: 'london', name: 'London', populationWeight: 0.20 },
    { id: 'south', name: 'South of England', populationWeight: 0.27 },
    { id: 'midlands', name: 'Midlands', populationWeight: 0.27 },
    { id: 'north', name: 'North & Scotland', populationWeight: 0.26 },
  ],

  centralBank: {
    name: 'Bank of England',
    bankRate: 0.0425,
    inflationTarget: 0.02,
    corridor: 0.0025,
  },

  playerBank: {
    name: 'Sterling & Vale',
    policy: defaultPolicy,
    operatingCostPerMonth: pounds(650_000),
    giltsToDeposits: 0.30,
    equity: pounds(18_000_000),
  },

  otherBanks: {
    name: 'The rest of the market',
    giltsToDeposits: 0.12,
    equityToDeposits: 0.20,
  },

  companyCohorts: [
    micro('retail', 'midlands', 9000, 4),
    small('retail', 'south', 1200, 25),
    micro('hospitality', 'london', 6000, 6),
    small('manufacturing', 'north', 900, 40),
    medium('manufacturing', 'midlands', 120, 250),
    small('construction', 'south', 1800, 15),
    small('professional', 'london', 2400, 12),
    medium('technology', 'london', 150, 120),
    small('transport', 'north', 900, 20),
    medium('health', 'midlands', 90, 200),
  ],

  householdCohorts: [
    households('london', 60000, pounds(180), 0.94),
    households('south', 80000, pounds(140), 0.95),
    households('midlands', 80000, pounds(120), 0.93),
    households('north', 60000, pounds(115), 0.92),
    { ...households('south', 20000, pounds(130), 0.95), id: 'coh:hh:retail', banksWithPlayer: true },
  ],

  existingCorporateCustomers: 60,

  // Subdivision is available but deliberately off: it damps inflation
  // volatility (7.2% -> 5.4%) but pushes the inflation *level* from 2.4% to
  // 7.2%, and that happens even with identical slices, which it should not.
  // See docs/CALIBRATION.md before turning it up.
  cohortSubdivision: 1,
  cohortDispersion: 0.02,

  gilts: {
    tenors: [2, 5, 10, 30],
    couponSpread: 0.010,
  },
};

function micro(sector: string, region: string, count: number, employees: number) {
  return {
    sector,
    region,
    sizeBand: 'micro' as const,
    creditGrade: 'BB' as CreditGrade,
    count,
    meanEmployees: employees,
    meanProductivity: 1.6,
    meanWagePerEmployee: pounds(115),
    meanPrice: pounds(84),
    sizeSigma: 0.55,
    cashPerFirm: pounds(45_000),
    fixedAssetsPerFirm: pounds(120_000),
    inventoryValuePerFirm: pounds(6_000),
    debtPerFirm: pounds(35_000),
  };
}

function small(sector: string, region: string, count: number, employees: number) {
  return {
    sector,
    region,
    sizeBand: 'small' as const,
    creditGrade: 'BB' as CreditGrade,
    count,
    meanEmployees: employees,
    meanProductivity: 1.7,
    meanWagePerEmployee: pounds(130),
    meanPrice: pounds(89),
    sizeSigma: 0.5,
    cashPerFirm: pounds(220_000),
    fixedAssetsPerFirm: pounds(900_000),
    inventoryValuePerFirm: pounds(40_000),
    debtPerFirm: pounds(260_000),
  };
}

function medium(sector: string, region: string, count: number, employees: number) {
  return {
    sector,
    region,
    sizeBand: 'medium' as const,
    creditGrade: 'BBB' as CreditGrade,
    count,
    meanEmployees: employees,
    meanProductivity: 1.9,
    meanWagePerEmployee: pounds(150),
    meanPrice: pounds(92),
    sizeSigma: 0.45,
    cashPerFirm: pounds(1_800_000),
    fixedAssetsPerFirm: pounds(9_000_000),
    inventoryValuePerFirm: pounds(450_000),
    debtPerFirm: pounds(2_800_000),
  };
}

function households(region: string, count: number, wage: Money, employmentRate: number) {
  return {
    region,
    creditGrade: 'BBB' as CreditGrade,
    count,
    meanWage: wage,
    wageSigma: 0.45,
    meanPropensityToConsume: 0.95,
    employmentRate,
    savingsPerHousehold: pounds(16_000),
    debtPerHousehold: pounds(14_000),
  };
}
