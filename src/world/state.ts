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
  Person,
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
  /**
   * The share of latent firms that fail in a year, before the cycle.
   *
   * This is the economy-wide insolvency rate the model is trying to produce:
   * resolved borrowers fail on their own probability of default, and everybody
   * else -- the overwhelming majority, who have never borrowed from the player
   * -- fails at this rate. Set from the UK company insolvency rate.
   */
  firmExitRate: number;
  /**
   * How much a downturn raises failures.
   *
   * Multiplies the exit rate by `1 - this * outputGap`, so at 2 a two-point
   * negative output gap raises failures by a twentieth of themselves... a
   * bust kills firms, a boom keeps them alive. Zero makes exit acyclical.
   */
  firmExitCyclicality: number;
  /**
   * How strongly entry answers the amount of business going.
   *
   * Entry is the exit rate times `1 + this * (trade per firm / what the cohort
   * is used to - 1)`, so at zero entry exactly replaces exit whatever the
   * economy does and the firm population is stationary. Above zero a growing
   * economy gains firms and a shrinking one loses them, and the response
   * corrects itself: the firms that enter divide the same trade more ways.
   */
  firmEntryElasticity: number;
  /** How fast a cohort's remembered level of trade follows the actual one. */
  firmTradeMemory: number;
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
   * How much the capital behind a worker changes what they produce.
   *
   * Output per head is `baseProductivity * (capital per worker / the reference
   * below) ^ this`, so at 0.3 -- roughly the capital share of income -- a
   * doubling of capital per worker buys about a quarter more output per head.
   * Zero disconnects capital from production entirely and leaves fixed assets
   * as the inert balance-sheet entry they were.
   *
   * This is the only route to growth in output per head that the model has.
   * Nothing else writes productivity: it was a constant from the firm's birth
   * to its death, so an economy could only grow by hiring, and the population
   * is close to stationary.
   */
  capitalElasticity: number;
  /**
   * The capital per worker, in pence, at which a firm produces exactly its
   * base. Set to what the starting economy actually has, so a new world opens
   * on a factor of one and the elasticity above is measured from there.
   */
  capitalPerWorkerReference: number;
  /**
   * How much dear money postpones a capacity decision.
   *
   * The share of takings a firm reinvests is multiplied by
   * `1 - this * realRateGap`, so at 4 a 250bp real tightening cuts investment
   * spending by a tenth. Zero disconnects the investment channel.
   */
  investmentRateSensitivity: number;
  /**
   * The buffer of savings people aim to hold, in days of income.
   *
   * Without a target, a fixed saving rate is a permanent leak: people put
   * a share of every wage packet into a pot and only ever trickle it back out,
   * so the firm sector loses that much cash a day for ever. With one, saving
   * is the gap to the buffer, which is zero once the buffer is full.
   */
  savingsBufferDays: number;
  /** Daily share of the gap to the buffer people close. */
  savingsAdjustment: number;
  /**
   * How much a better return on savings makes people hold back.
   *
   * Subtracted from the propensity to consume as `base - this * realRateGap`,
   * so at 2 a 250bp real tightening moves a person spending 95p in the
   * pound to 90p. It shifts the saving rate, which is a flow, and not the
   * target buffer, which is a stock -- see `propensityOutOfIncome`.
   *
   * Defaults to zero, which is the honest reading of the evidence rather than
   * a missing feature. This economy runs a boom-bust cycle, and restraining
   * consumption makes the swings bigger rather than the mean lower: at a
   * sensitivity of 1 inflation goes *up* 0.5 points and unemployment up 1.7,
   * and at 2 the cycle reaches 27% unemployment. The channel is built, tested
   * and swept, and worth turning on once the cycle is damped. See
   * docs/ROADMAP.md.
   */
  savingsRateSensitivity: number;
  /** How quickly people' smoothed income follows actual receipts. */
  incomeSmoothing: number;
  /** Share of the working-age population in the labour market. */
  labourParticipation: number;
  /**
   * How much people differ in how good they are at the work, as a log-normal
   * spread around the average.
   *
   * It reaches output and pay together, because those are the same fact seen
   * from either side: a better workforce produces more from the same firm, and
   * takes a larger share of the wage bill for doing it. Zero makes everybody
   * identical, which is what they were.
   */
  personAbilitySpread: number;
  /** Years from birth to joining the workforce. */
  yearsAsChild: number;
  /** Years spent of working age. */
  yearsWorking: number;
  /** Years from leaving the workforce to dying. */
  yearsRetired: number;
  /**
   * How strongly prosperity feeds through to the birth rate.
   *
   * Births run at one per worker per working lifetime multiplied by
   * `prosperity ^ this`, so at zero the population is exactly stationary and
   * above zero a richer economy grows. This is the opposite of the real
   * demographic transition, where richer countries have fewer children. It is
   * the version where prosperity compounds instead of quietly shrinking the
   * workforce through the best decades, which is the better game and the
   * worse history.
   */
  fertilityProsperity: number;
  /** How fast the standard of living prosperity is judged against moves. */
  prosperityMemory: number;
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
  /**
   * What a wage set today would be, relative to one set at the start.
   *
   * Pay is not re-set for everyone every month. The economy-wide signal
   * accumulates here, and each firm applies the growth since its own last
   * review when its review month comes round -- so at any moment the wage bill
   * is a mix of twelve vintages rather than one number everybody just moved to.
   */
  wageIndex: number;
  /** The last twelve monthly values of `wageIndex`, oldest first. */
  wageIndexHistory: number[];
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

export const WORLD_VERSION = 10;

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
  firmExitRate: 0.007,
  firmExitCyclicality: 2,
  firmEntryElasticity: 1.5,
  firmTradeMemory: 0.02,
  targetSellThrough: 0.95,
  targetStockDays: 8,
  demandPriceWeight: 0.7,
  targetMarkup: 0.22,
  costAnchorWeight: 0.4,
  minMarkup: -0.05,
  priceElasticity: 2.5,
  investmentRate: 0.15,
  capitalElasticity: 0.3,
  capitalPerWorkerReference: 4_144_600,
  investmentRateSensitivity: 2,
  savingsBufferDays: 180,
  savingsAdjustment: 0.01,
  savingsRateSensitivity: 0,
  incomeSmoothing: 0.15,
  labourParticipation: 0.96,
  personAbilitySpread: 0.10,
  yearsAsChild: 18,
  yearsWorking: 49,
  yearsRetired: 15,
  fertilityProsperity: 1.5,
  prosperityMemory: 0.0008,
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
  forgetKindIndex(world);
  return entity;
}

export function removeEntity(world: WorldState, id: EntityId): void {
  delete world.entities[id];
  delete world.instrumentsByHolder[id];
  delete world.instrumentsByObligor[id];
  delete world.lastInteraction[id];
  forgetKindIndex(world);
}

/**
 * Resolved entities grouped by kind, built on demand and thrown away whenever
 * the population changes.
 *
 * `entitiesOfKind` used to walk every entity in the world on every call, and
 * the systems ask it seventeen times a tick: a ten-year run scanned 30.3M
 * entity slots to answer questions about a population of about 490. Caching
 * the answer is worth 16% of a run.
 *
 * It lives beside the world rather than in it because the world must stay
 * plain data -- a `Map` in there would not survive `JSON.stringify`. Keying a
 * `WeakMap` on the world also means a discarded world takes its index with it,
 * which matters to a calibration worker that builds thousands of them.
 */
const kindIndex = new WeakMap<WorldState, Map<Entity['kind'], Entity[]>>();

/**
 * Drop the index, rather than editing it in place.
 *
 * The arrays handed out are snapshots, and callers rely on that: the LOD sweep
 * iterates `resolvedCompanies(world)` while dissolving and demoting the very
 * firms in it. Splicing an entity out of a live array mid-loop would skip its
 * neighbour. Discarding costs one rebuild and cannot do that.
 */
function forgetKindIndex(world: WorldState): void {
  kindIndex.delete(world);
}

export function entitiesOfKind<K extends Entity['kind']>(
  world: WorldState,
  kind: K,
): Extract<Entity, { kind: K }>[] {
  let byKind = kindIndex.get(world);
  if (!byKind) {
    byKind = new Map();
    kindIndex.set(world, byKind);
  }
  const cached = byKind.get(kind);
  if (cached) return cached as Extract<Entity, { kind: K }>[];

  const out: Extract<Entity, { kind: K }>[] = [];
  for (const id in world.entities) {
    const e = world.entities[id]!;
    if (e.kind === kind) out.push(e as Extract<Entity, { kind: K }>);
  }
  byKind.set(kind, out);
  return out;
}

export function resolvedCompanies(world: WorldState): Company[] {
  return entitiesOfKind(world, 'company');
}

export function resolvedPeople(world: WorldState): Person[] {
  return entitiesOfKind(world, 'person');
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
 * and people saved towards a fixed buffer, none of which cared what money
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
