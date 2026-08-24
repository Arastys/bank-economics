import type { IdCounters } from '../core/ids.js';
import type { Money } from '../core/money.js';
import type { Day } from '../core/time.js';
import type { LedgerState } from '../ledger/ledger.js';
import type { Instrument } from '../instruments/types.js';
import type {
  Cohort,
  Company,
  CreditGrade,
  Entity,
  EntityId,
  Household,
  Region,
  Sector,
} from './types.js';

/** Tunables. Everything a designer might want to rebalance lives here. */
export interface SimConfig {
  /** Days a credit application stays on the desk before it lapses. */
  applicationValidityDays: number;
  /** Ticks a resolved entity must be idle before it can fold back into a cohort. */
  demotionIdleDays: number;
  /** Hard ceiling on resolved entities, to bound per-tick cost. */
  maxResolvedEntities: number;
  /** Loss given default, as a share of exposure. */
  lossGivenDefault: number;
  /** Central bank reaction function. */
  taylorInflationWeight: number;
  taylorOutputWeight: number;
  neutralRealRate: number;
  /** How fast prices respond to excess demand. */
  priceAdjustment: number;
  /** How fast firms adjust headcount. */
  hiringAdjustment: number;
  /**
   * How much firms differ in how well they are run, as a log-normal spread
   * around the sector average. Zero makes every firm identical.
   */
  firmQualitySpread: number;
  /** Sell-through firms aim for. Above it they raise prices, below they cut. */
  targetSellThrough: number;
  /** Days of stock a firm is comfortable holding. */
  targetStockDays: number;
  /** How much of the price signal is today's counter versus the stockroom. */
  demandPriceWeight: number;
  /**
   * The markup over unit production cost firms aim for.
   *
   * Without a cost anchor a firm prices purely off how fast stock is moving,
   * which says nothing about whether the price covers the wages that made it.
   * Pay can then rise straight through the price and leave the whole firm
   * sector selling at a loss indefinitely.
   */
  targetMarkup: number;
  /** How much of the price move is the pull towards cost, versus trading conditions. */
  costAnchorWeight: number;
  /**
   * How far below cost a firm will let its price fall while it works through
   * stock. Not zero: businesses do sell at a loss for a while.
   */
  minMarkup: number;
  /** How sharply buyers prefer cheaper sellers. */
  priceElasticity: number;
  /** Share of takings a comfortable firm puts back into capacity. */
  investmentRate: number;
  /**
   * How much dear money postpones a capacity decision.
   *
   * The share of takings a firm reinvests is multiplied by
   * `1 - this * realRateGap`, so at 4 a 250bp real tightening cuts investment
   * spending by a tenth. Zero disconnects the investment channel.
   */
  investmentRateSensitivity: number;
  /**
   * The buffer of savings households aim to hold, in days of income.
   *
   * Without a target, a fixed saving rate is a permanent leak: households put
   * a share of every wage packet into a pot and only ever trickle it back out,
   * so the firm sector loses that much cash a day for ever. With one, saving
   * is the gap to the buffer, which is zero once the buffer is full.
   */
  savingsBufferDays: number;
  /** Daily share of the gap to the buffer households close. */
  savingsAdjustment: number;
  /**
   * How much a better return on savings makes households hold back.
   *
   * Subtracted from the propensity to consume as `base - this * realRateGap`,
   * so at 2 a 250bp real tightening moves a household spending 95p in the
   * pound to 90p. It shifts the saving rate, which is a flow, and not the
   * target buffer, which is a stock -- see `propensityOutOfIncome`.
   *
   * Defaults to zero, which is the honest reading of the evidence rather than
   * a missing feature. Restraining consumption in this economy raises
   * unemployment without lowering inflation, because the price level here is
   * set by costs: the cost anchor and downward wage rigidity floor prices, so
   * less spending buys less output at the same price. At a sensitivity of 1,
   * inflation goes *up* 0.5 points and unemployment up 1.7. The channel is
   * built, tested and swept, and it is worth turning on the day wages respond
   * to slack.
   */
  savingsRateSensitivity: number;
  /** How quickly households' smoothed income follows actual receipts. */
  incomeSmoothing: number;
  /** Share of the population in the labour market. */
  labourParticipation: number;
  /** Employment rate at which the labour market bids wages up. */
  neutralTightness: number;
  /** How much of last month's inflation firms pass into pay. */
  wageIndexation: number;
  /** How strongly a tight or slack labour market moves pay. */
  wageTightnessResponse: number;
  /**
   * Most pay can fall in a month. Nominal wages are sticky downward in
   * reality, and without that floor a slack labour market drives a
   * self-reinforcing wage-price spiral straight into the ground.
   */
  maxMonthlyWageCut: number;
  /** Most pay can rise in a month. */
  maxMonthlyWageRise: number;
  /** Monthly depreciation of fixed assets. */
  depreciationPerMonth: number;
  /** How much of the previous Bank Rate carries into the next decision. */
  policySmoothing: number;
  /** Ceiling on Bank Rate. */
  maxBankRate: number;
  /** Chance per latent firm per business day of wanting to borrow. */
  cohortApplicationRate: number;
  /** Chance a firm banking elsewhere approaches the player instead. */
  shopAroundChance: number;
  /** Ceiling on new applications reaching the desk each day. */
  maxNewApplicationsPerDay: number;
  /** Missed payments tolerated before a loan is written off. */
  arrearsLimit: number;
  /** What a forced sale of a failed firm's assets loses against book value. */
  liquidationHaircut: number;
  /**
   * How much the state of the economy moves that. Recovery is procyclical:
   * in a slump the buyers are short of money and several firms are selling
   * the same assets at once, so they fetch less.
   */
  liquidationCyclicality: number;
  /** Spread of outcomes between one liquidation and the next. */
  liquidationVariance: number;
  /** How much better an orderly sale does than a forced one. */
  workoutHaircutFactor: number;
  /** How much asset-heavy sectors recover above asset-light ones. */
  liquidationCapitalIntensityBenefit: number;
  /** Corporation tax rate applied at year end. */
  corporationTaxRate: number;
  /** Regulatory minimums, reported but not yet enforced. */
  minimumCapitalRatio: number;
  minimumLiquidityRatio: number;
  /** FSCS protection limit per depositor per bank. */
  depositProtectionLimit: Money;
}

export interface MarketState {
  /** Overnight rate at which banks lend to each other. Tracks Bank Rate closely. */
  interbankRate: number;
  /** Zero-coupon yields by tenor in years. */
  yieldCurve: Record<number, number>;
  /** Credit spread over the risk-free curve, by grade. */
  creditSpreads: Record<CreditGrade, number>;
  /** Clean price per £1 nominal, by bond id. */
  bondPrices: Record<string, number>;
}

export interface EconomyState {
  /** Average price of a unit of output, in pence. The index the CPI is built from. */
  priceIndex: number;
  /** Year-on-year CPI inflation. */
  inflationAnnual: number;
  /** Output relative to potential, as a share. Positive is a boom. */
  outputGap: number;
  unemployment: number;
  /** Units of goods produced on the last tick. */
  outputUnits: number;
  demandUnits: number;
  /** Slow-moving estimate of what the economy could produce at full employment. */
  potentialOutput: number;
  labourForce: number;
  employed: number;
  /** Slow-moving sentiment that shifts consumption and investment. */
  confidence: number;
  /** Rolling record used to compute year-on-year figures. */
  priceIndexHistory: number[];
}

/** Sampled time series for charts and for balancing the game. */
export interface MetricsState {
  /** Tick at which each sample was taken. */
  samples: Day[];
  series: Record<string, number[]>;
  capacity: number;
}

export interface CreditApplication {
  id: string;
  applicantId: EntityId;
  lenderId: EntityId;
  amount: Money;
  termMonths: number;
  purpose: 'workingCapital' | 'investment' | 'refinance' | 'mortgage' | 'consumer';
  grade: CreditGrade;
  pdAnnual: number;
  submittedOn: Day;
  expiresOn: Day;
  status: 'pending' | 'approved' | 'declined' | 'expired';
  /** Rate the bank offered, once underwritten. */
  offeredRate?: number;
  decisionReason?: string;
}

export interface WorldState {
  /** Bumped when the shape changes, so saves can be migrated. */
  version: number;
  seed: number;
  tick: Day;

  entities: Record<EntityId, Entity>;
  instruments: Record<string, Instrument>;
  /** Instrument ids by holder and by obligor, kept in step by the helpers below. */
  instrumentsByHolder: Record<EntityId, string[]>;
  instrumentsByObligor: Record<EntityId, string[]>;
  /** Last tick each resolved entity did something worth staying resolved for. */
  lastInteraction: Record<EntityId, Day>;

  ledger: LedgerState;
  ids: IdCounters;

  playerBankId: EntityId;
  /** Aggregate stand-in for every other bank in the system. */
  otherBanksId: EntityId;
  centralBankId: EntityId;
  governmentId: EntityId;

  sectors: Record<string, Sector>;
  regions: Record<string, Region>;

  markets: MarketState;
  economy: EconomyState;
  applications: Record<string, CreditApplication>;
  metrics: MetricsState;

  config: SimConfig;
}

export const WORLD_VERSION = 3;

export const DEFAULT_CONFIG: SimConfig = {
  applicationValidityDays: 14,
  demotionIdleDays: 120,
  maxResolvedEntities: 1500,
  lossGivenDefault: 0.45,
  taylorInflationWeight: 1.2,
  taylorOutputWeight: 0.5,
  neutralRealRate: 0.005,
  priceAdjustment: 0.006,
  hiringAdjustment: 0.02,
  firmQualitySpread: 0.18,
  targetSellThrough: 0.95,
  targetStockDays: 8,
  demandPriceWeight: 0.7,
  targetMarkup: 0.22,
  costAnchorWeight: 0.4,
  minMarkup: -0.05,
  priceElasticity: 2.5,
  investmentRate: 0.15,
  investmentRateSensitivity: 2,
  savingsBufferDays: 180,
  savingsAdjustment: 0.01,
  savingsRateSensitivity: 0,
  incomeSmoothing: 0.15,
  labourParticipation: 0.96,
  neutralTightness: 0.97,
  wageIndexation: 0.6,
  wageTightnessResponse: 0.3,
  maxMonthlyWageCut: 0.002,
  maxMonthlyWageRise: 0.02,
  depreciationPerMonth: 1 / 120,
  policySmoothing: 0.85,
  maxBankRate: 0.12,
  cohortApplicationRate: 0.0006,
  shopAroundChance: 0.35,
  maxNewApplicationsPerDay: 8,
  arrearsLimit: 3,
  liquidationHaircut: 0.4,
  liquidationCyclicality: 2.5,
  liquidationVariance: 0.1,
  workoutHaircutFactor: 0.5,
  liquidationCapitalIntensityBenefit: 0.08,
  corporationTaxRate: 0.25,
  minimumCapitalRatio: 0.08,
  minimumLiquidityRatio: 1.0,
  depositProtectionLimit: 8_500_000 as Money, // £85,000
};

// --- accessors -------------------------------------------------------------

export function getEntity(world: WorldState, id: EntityId): Entity {
  const e = world.entities[id];
  if (!e) throw new Error(`No entity "${id}"`);
  return e;
}

export function tryGetEntity(world: WorldState, id: EntityId): Entity | undefined {
  return world.entities[id];
}

export function addEntity<T extends Entity>(world: WorldState, entity: T): T {
  world.entities[entity.id] = entity;
  world.instrumentsByHolder[entity.id] ??= [];
  world.instrumentsByObligor[entity.id] ??= [];
  return entity;
}

export function removeEntity(world: WorldState, id: EntityId): void {
  delete world.entities[id];
  delete world.instrumentsByHolder[id];
  delete world.instrumentsByObligor[id];
  delete world.lastInteraction[id];
}

export function entitiesOfKind<K extends Entity['kind']>(
  world: WorldState,
  kind: K,
): Extract<Entity, { kind: K }>[] {
  const out: Extract<Entity, { kind: K }>[] = [];
  for (const id in world.entities) {
    const e = world.entities[id]!;
    if (e.kind === kind) out.push(e as Extract<Entity, { kind: K }>);
  }
  return out;
}

export function resolvedCompanies(world: WorldState): Company[] {
  return entitiesOfKind(world, 'company');
}

export function resolvedHouseholds(world: WorldState): Household[] {
  return entitiesOfKind(world, 'household');
}

export function cohorts(world: WorldState): Cohort[] {
  return entitiesOfKind(world, 'cohort');
}

export function playerBank(world: WorldState) {
  const bank = getEntity(world, world.playerBankId);
  if (bank.kind !== 'bank') throw new Error('playerBankId does not point at a bank');
  return bank;
}

export function centralBank(world: WorldState) {
  const cb = getEntity(world, world.centralBankId);
  if (cb.kind !== 'centralBank') throw new Error('centralBankId does not point at a central bank');
  return cb;
}

/**
 * How far the real cost of money sits above the rate the economy is used to.
 *
 * Positive is tight money, negative is loose, zero is neutral.
 *
 * This is the signal the policy rate reaches the real economy through, and
 * until something read it there was none. Bank Rate priced loans, remunerated
 * reserves and set the yield curve, but no spending decision anywhere looked
 * at it: firms borrowed to cover payroll, invested a fixed share of takings
 * and households saved towards a fixed buffer, none of which cared what money
 * cost. Pinning Bank Rate across a 900 basis point span moved inflation by
 * 0.2 points, and in the wrong direction -- dearer credit raised firms' costs
 * and the cost anchor passed them into prices, with nothing anywhere reducing
 * demand. A committee whose decisions do not reach the economy is a
 * decoration, and four parameters that describe it were tuning nothing.
 */
export function realRateGap(world: WorldState): number {
  const cb = centralBank(world);
  return cb.bankRate - world.economy.inflationAnnual - world.config.neutralRealRate;
}

// --- instrument index ------------------------------------------------------

export function addInstrument(world: WorldState, inst: Instrument): Instrument {
  world.instruments[inst.id] = inst;
  (world.instrumentsByHolder[inst.holderId] ??= []).push(inst.id);
  (world.instrumentsByObligor[inst.obligorId] ??= []).push(inst.id);
  return inst;
}

export function getInstrument(world: WorldState, id: string): Instrument {
  const inst = world.instruments[id];
  if (!inst) throw new Error(`No instrument "${id}"`);
  return inst;
}

export function heldBy(world: WorldState, holderId: EntityId): Instrument[] {
  return (world.instrumentsByHolder[holderId] ?? []).map((id) => world.instruments[id]!).filter(Boolean);
}

export function owedBy(world: WorldState, obligorId: EntityId): Instrument[] {
  return (world.instrumentsByObligor[obligorId] ?? []).map((id) => world.instruments[id]!).filter(Boolean);
}

/** Reassign a claim to a new holder, keeping the index consistent. */
export function transferHolder(world: WorldState, instId: string, newHolderId: EntityId): void {
  const inst = getInstrument(world, instId);
  const from = world.instrumentsByHolder[inst.holderId];
  if (from) {
    const idx = from.indexOf(instId);
    if (idx >= 0) from.splice(idx, 1);
  }
  inst.holderId = newHolderId;
  (world.instrumentsByHolder[newHolderId] ??= []).push(instId);
}

export function touch(world: WorldState, id: EntityId): void {
  world.lastInteraction[id] = world.tick;
}

/**
 * Drop finished contracts.
 *
 * Closed loans and redeemed bonds are kept around briefly so the UI can show
 * what happened, then discarded -- otherwise a long game accumulates dead
 * records and every scan over a bank's book gets slower for ever.
 */
export function pruneInstruments(world: WorldState, keepForDays: number): number {
  const cutoff = world.tick - keepForDays;
  let removed = 0;
  for (const id of Object.keys(world.instruments)) {
    const inst = world.instruments[id]!;
    if (inst.status === 'active') continue;
    const finishedOn = inst.maturesOn ?? inst.openedOn;
    if (finishedOn > cutoff) continue;
    detach(world.instrumentsByHolder[inst.holderId], id);
    detach(world.instrumentsByObligor[inst.obligorId], id);
    delete world.instruments[id];
    delete world.markets.bondPrices[id];
    removed++;
  }
  return removed;
}

function detach(list: string[] | undefined, id: string): void {
  if (!list) return;
  const index = list.indexOf(id);
  if (index >= 0) list.splice(index, 1);
}

/** Clear out applications that were decided long ago. */
export function pruneApplications(world: WorldState, keepForDays: number): number {
  const cutoff = world.tick - keepForDays;
  let removed = 0;
  for (const id of Object.keys(world.applications)) {
    const app = world.applications[id]!;
    if (app.status === 'pending' || app.expiresOn > cutoff) continue;
    delete world.applications[id];
    removed++;
  }
  return removed;
}
