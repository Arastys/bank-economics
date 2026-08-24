import { ZERO, type Money } from '../core/money.js';
import type { WorldState } from '../world/state.js';
import { cohorts, resolvedCompanies, resolvedPeople } from '../world/state.js';
import type {
  Cohort,
  Company,
  CompanyArchetype,
  EntityId,
  Person,
  PersonArchetype,
  RegionId,
  SectorId,
} from '../world/types.js';

/**
 * A uniform handle on "some firms", whether that is one company simulated in
 * full or a cohort standing in for two thousand of them.
 *
 * Every economic system works through these views, so there is exactly one
 * implementation of production, pricing and hiring rather than one per level
 * of detail.
 */
export class FirmView {
  constructor(private readonly target: Company | Cohort) {}

  get id(): EntityId {
    return this.target.id;
  }

  get isCohort(): boolean {
    return this.target.kind === 'cohort';
  }

  /** How many firms this view stands for. */
  get count(): number {
    return this.target.kind === 'cohort' ? this.target.count : 1;
  }

  private get archetype(): CompanyArchetype {
    return (this.target as Cohort).archetype as CompanyArchetype;
  }

  get sector(): SectorId {
    return this.target.kind === 'cohort' ? this.archetype.sector : this.target.sector;
  }

  get region(): RegionId {
    return this.target.kind === 'cohort' ? this.archetype.region : this.target.region;
  }

  /** Total headcount across all firms in the view. */
  get employees(): number {
    return this.target.kind === 'cohort' ? (this.target.pool.employees ?? 0) : this.target.employees;
  }

  set employees(value: number) {
    const v = Math.max(0, value);
    if (this.target.kind === 'cohort') this.target.pool.employees = v;
    else this.target.employees = Math.round(v);
  }

  /**
   * Output per head as things stand, capital included.
   *
   * Written by `economy.capital` as the capital behind each worker changes,
   * which is why a cohort keeps an override in its pool rather than reading
   * the archetype straight through: the archetype is the template every member
   * was cut from and must not drift.
   */
  get productivity(): number {
    return this.target.kind === 'cohort'
      ? (this.target.pool.productivity ?? this.archetype.meanProductivity)
      : this.target.productivity;
  }

  set productivity(value: number) {
    const v = Math.max(0, value);
    if (this.target.kind === 'cohort') this.target.pool.productivity = v;
    else this.target.productivity = v;
  }

  /** Output per head at the reference capital per worker, before any deepening. */
  get baseProductivity(): number {
    return this.target.kind === 'cohort'
      ? this.archetype.meanProductivity
      : this.target.baseProductivity;
  }

  get wagePerEmployee(): Money {
    return this.target.kind === 'cohort'
      ? ((this.target.pool.wage ?? this.archetype.meanWagePerEmployee) as Money)
      : this.target.wagePerEmployee;
  }

  set wagePerEmployee(value: Money) {
    const v = Math.max(1, Math.round(value)) as Money;
    if (this.target.kind === 'cohort') this.target.pool.wage = v;
    else this.target.wagePerEmployee = v;
  }

  /** How well this firm is run, as a multiple of its sector average. */
  get quality(): number {
    return this.target.kind === 'cohort' ? (this.target.pool.quality ?? 1) : this.target.quality;
  }

  /**
   * How firmly the firm defends its margin, as a multiple of the standard
   * target markup. A better-run business holds out for a fuller price; a
   * poorly run one discounts its way through the stockroom.
   */
  get pricingDiscipline(): number {
    return 0.7 + 0.3 * this.quality;
  }

  get price(): Money {
    return this.target.kind === 'cohort'
      ? ((this.target.pool.price ?? this.archetype.meanPrice) as Money)
      : this.target.price;
  }

  set price(value: Money) {
    if (this.target.kind === 'cohort') this.target.pool.price = value;
    else this.target.price = value;
  }

  get inventoryUnits(): number {
    return this.target.kind === 'cohort' ? (this.target.pool.inventoryUnits ?? 0) : this.target.inventoryUnits;
  }

  set inventoryUnits(value: number) {
    const v = Math.max(0, value);
    if (this.target.kind === 'cohort') this.target.pool.inventoryUnits = v;
    else this.target.inventoryUnits = v;
  }

  set lastSoldUnits(value: number) {
    if (this.target.kind === 'cohort') this.target.pool.lastSoldUnits = value;
    else this.target.lastSoldUnits = value;
  }

  get lastSoldUnits(): number {
    return this.target.kind === 'cohort' ? (this.target.pool.lastSoldUnits ?? 0) : this.target.lastSoldUnits;
  }

  get expectedSales(): number {
    return this.target.kind === 'cohort'
      ? (this.target.pool.expectedSales ?? 0)
      : this.target.expectedSales;
  }

  set expectedSales(value: number) {
    const v = Math.max(0, value);
    if (this.target.kind === 'cohort') this.target.pool.expectedSales = v;
    else this.target.expectedSales = v;
  }

  get recentRevenue(): Money {
    return this.target.kind === 'cohort'
      ? ((this.target.pool.recentRevenue ?? 0) as Money)
      : this.target.recentRevenue;
  }

  set recentRevenue(value: Money) {
    if (this.target.kind === 'cohort') this.target.pool.recentRevenue = value;
    else this.target.recentRevenue = value;
  }

  get entity(): Company | Cohort {
    return this.target;
  }

  /** Only resolved firms can hold products with the player's bank. */
  get company(): Company | undefined {
    return this.target.kind === 'company' ? this.target : undefined;
  }
}

export class PersonView {
  constructor(private readonly target: Person | Cohort) {}

  get id(): EntityId {
    return this.target.id;
  }

  get isCohort(): boolean {
    return this.target.kind === 'cohort';
  }

  get count(): number {
    return this.target.kind === 'cohort' ? this.target.count : 1;
  }

  /**
   * The three stages of a life, as headcounts.
   *
   * A pool that has never been through demography has no bands, so it reads as
   * all of working age -- which is what every person in this model was before
   * there were ages at all.
   */
  get children(): number {
    return this.target.kind === 'cohort' ? (this.target.pool.children ?? 0) : 0;
  }

  set children(value: number) {
    if (this.target.kind === 'cohort') this.target.pool.children = Math.max(0, value);
  }

  get workingAge(): number {
    if (this.target.kind !== 'cohort') return 1;
    return this.target.pool.workingAge ?? this.target.count;
  }

  set workingAge(value: number) {
    if (this.target.kind === 'cohort') this.target.pool.workingAge = Math.max(0, value);
  }

  get retired(): number {
    return this.target.kind === 'cohort' ? (this.target.pool.retired ?? 0) : 0;
  }

  set retired(value: number) {
    if (this.target.kind === 'cohort') this.target.pool.retired = Math.max(0, value);
  }

  /**
   * How good these people are at the work, as a multiple of the average.
   *
   * Normalised at build so the employment-weighted mean across the economy is
   * exactly one. Without that, drawing five pools out of a log-normal shifts
   * total output by whatever the sample happened to do, and the spread would
   * read as a productivity change rather than as a dispersion.
   */
  get ability(): number {
    return this.target.kind === 'cohort'
      ? (this.target.pool.ability ?? 1)
      : (this.target.ability ?? 1);
  }

  /** The real income per worker this pool has got used to. */
  get prosperityReference(): number {
    return this.target.kind === 'cohort' ? (this.target.pool.prosperityReference ?? 0) : 0;
  }

  set prosperityReference(value: number) {
    if (this.target.kind === 'cohort') this.target.pool.prosperityReference = Math.max(0, value);
  }

  /** Keep the headline count equal to the three bands it is made of. */
  reconcileCount(): void {
    if (this.target.kind !== 'cohort') return;
    this.target.count = this.children + this.workingAge + this.retired;
  }

  private get archetype(): PersonArchetype {
    return (this.target as Cohort).archetype as PersonArchetype;
  }

  get region(): RegionId {
    return this.target.kind === 'cohort' ? this.archetype.region : this.target.region;
  }

  /** Number of members in work. */
  get employed(): number {
    return this.target.kind === 'cohort'
      ? (this.target.pool.employed ?? this.target.count * this.archetype.employmentRate)
      : this.target.employed
        ? 1
        : 0;
  }

  set employed(value: number) {
    if (this.target.kind === 'cohort') this.target.pool.employed = Math.max(0, value);
    else this.target.employed = value > 0;
  }

  get propensityToConsume(): number {
    return this.target.kind === 'cohort'
      ? this.archetype.meanPropensityToConsume
      : this.target.propensityToConsume;
  }

  get lastIncome(): Money {
    return this.target.kind === 'cohort'
      ? ((this.target.pool.lastIncome ?? 0) as Money)
      : this.target.lastIncome;
  }

  set lastIncome(value: Money) {
    if (this.target.kind === 'cohort') this.target.pool.lastIncome = value;
    else this.target.lastIncome = value;
  }

  get incomeRate(): Money {
    return this.target.kind === 'cohort'
      ? ((this.target.pool.incomeRate ?? 0) as Money)
      : this.target.incomeRate;
  }

  set incomeRate(value: Money) {
    if (this.target.kind === 'cohort') this.target.pool.incomeRate = value;
    else this.target.incomeRate = value;
  }

  get entity(): Person | Cohort {
    return this.target;
  }

  get person(): Person | undefined {
    return this.target.kind === 'person' ? this.target : undefined;
  }
}

export function firmViews(world: WorldState): FirmView[] {
  const views: FirmView[] = [];
  for (const company of resolvedCompanies(world)) {
    if (company.status !== 'defaulted') views.push(new FirmView(company));
  }
  for (const cohort of cohorts(world)) {
    if (cohort.memberKind === 'company' && cohort.count > 0) views.push(new FirmView(cohort));
  }
  return views;
}

export function personViews(world: WorldState): PersonView[] {
  const views: PersonView[] = [];
  for (const person of resolvedPeople(world)) views.push(new PersonView(person));
  for (const cohort of cohorts(world)) {
    if (cohort.memberKind === 'person' && cohort.count > 0) views.push(new PersonView(cohort));
  }
  return views;
}

export function totalWageBill(view: FirmView, ability = 1): Money {
  return Math.round(effectiveLabour(view, ability) * view.wagePerEmployee) as Money;
}

/**
 * Headcount in efficiency units: what the firm's staff amount to once you
 * account for how good they are.
 *
 * Output and the wage bill both read this, and they have to. Ability that
 * raised output alone would leave a region of below-average workers producing
 * a third less for the same payroll -- unit costs collapse, and the firms there
 * fail for a reason that has nothing to do with how they are run. Scaling both
 * leaves the cost of a unit untouched and puts the whole of the difference
 * where it belongs: in what the people take home.
 */
export function effectiveLabour(view: FirmView, ability: number): number {
  return view.employees * Math.max(0, ability);
}

/**
 * How good the people working in each region are, as a multiple of the
 * average.
 *
 * Weighted by who is actually in work rather than by who lives there, since it
 * is the people at the benches who make the output. Regions with nobody
 * working are absent, and callers read them as one -- the neutral answer for a
 * firm with no staff.
 *
 * Built for the whole economy in one pass and deliberately not per firm.
 * `personViews` walks every entity in the world to build its list, so asking
 * it once per firm per business day is thousands of full scans a day: doing
 * that made the test suite eight times slower before anything else noticed.
 */
export function abilityByRegion(world: WorldState): Map<RegionId, number> {
  const weighted = new Map<RegionId, number>();
  const heads = new Map<RegionId, number>();
  for (const pool of personViews(world)) {
    const inWork = Math.max(0, pool.employed);
    if (inWork <= 0) continue;
    weighted.set(pool.region, (weighted.get(pool.region) ?? 0) + inWork * pool.ability);
    heads.set(pool.region, (heads.get(pool.region) ?? 0) + inWork);
  }
  const out = new Map<RegionId, number>();
  for (const [region, count] of heads) out.set(region, weighted.get(region)! / count);
  return out;
}

/** How good this region's workers are, or one where nobody is working. */
export function abilityOf(byRegion: Map<RegionId, number>, region: RegionId): number {
  return byRegion.get(region) ?? 1;
}

export const NO_MONEY = ZERO;
