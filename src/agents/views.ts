import { ZERO, type Money } from '../core/money.js';
import type { WorldState } from '../world/state.js';
import { cohorts, resolvedCompanies, resolvedHouseholds } from '../world/state.js';
import type {
  Cohort,
  Company,
  CompanyArchetype,
  EntityId,
  Household,
  HouseholdArchetype,
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

  get productivity(): number {
    return this.target.kind === 'cohort' ? this.archetype.meanProductivity : this.target.productivity;
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

export class HouseholdView {
  constructor(private readonly target: Household | Cohort) {}

  get id(): EntityId {
    return this.target.id;
  }

  get isCohort(): boolean {
    return this.target.kind === 'cohort';
  }

  get count(): number {
    return this.target.kind === 'cohort' ? this.target.count : 1;
  }

  private get archetype(): HouseholdArchetype {
    return (this.target as Cohort).archetype as HouseholdArchetype;
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

  get entity(): Household | Cohort {
    return this.target;
  }

  get household(): Household | undefined {
    return this.target.kind === 'household' ? this.target : undefined;
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

export function householdViews(world: WorldState): HouseholdView[] {
  const views: HouseholdView[] = [];
  for (const household of resolvedHouseholds(world)) views.push(new HouseholdView(household));
  for (const cohort of cohorts(world)) {
    if (cohort.memberKind === 'household' && cohort.count > 0) views.push(new HouseholdView(cohort));
  }
  return views;
}

export function totalWageBill(view: FirmView): Money {
  return Math.round(view.employees * view.wagePerEmployee) as Money;
}

export const NO_MONEY = ZERO;
