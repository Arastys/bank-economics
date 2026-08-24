import { ZERO, scale, type Money } from '../core/money.js';
import { nextId } from '../core/ids.js';
import { identityRng, logNormal } from '../core/rng.js';
import { addMonths } from '../core/time.js';
import { goingRateFinancials } from './credit.js';
import { AC, depositCode } from '../ledger/accounts.js';
import { accountsOf, balance, credit, debit, forgetOwner, naturalBalance, post } from '../ledger/ledger.js';
import { LOAN_BULLET } from '../instruments/loan.js';
import type { SimContext } from '../engine/context.js';
import { addEntity, addInstrument, getEntity, owedBy, removeEntity, touch, type WorldState } from '../world/state.js';
import type {
  Cohort,
  Company,
  CompanyArchetype,
  Entity,
  EntityId,
  Household,
  HouseholdArchetype,
} from '../world/types.js';

/**
 * Level of detail.
 *
 * Most of the economy is latent: it lives inside cohorts as counts and
 * aggregate balances. The moment a firm or household actually deals with the
 * player it is materialised into a full entity, carrying a carved-out share of
 * its pool's balance sheet with it. When the relationship ends it folds back.
 *
 * The carve is a ledger transaction like any other, which is what makes the
 * detail boundary safe: no money is created or destroyed by zooming in.
 */

export interface PromotionResult {
  entity: Company | Household;
  sizeFactor: number;
}

export function promoteMember(
  ctx: SimContext,
  cohortId: EntityId,
  reason: string,
): PromotionResult | undefined {
  const { world } = ctx;
  const cohort = getEntity(world, cohortId);
  if (cohort.kind !== 'cohort' || cohort.count <= 0) return undefined;
  if (countResolved(world) >= world.config.maxResolvedEntities) return undefined;

  const index = cohort.nextMemberIndex++;
  const identity = `${cohortId}#${index}`;
  const rng = identityRng(world.seed, identity);

  // Mean of the log-normal factor is 1, so an average member carves 1/count.
  const sigma = cohort.memberKind === 'company' ? (cohort.archetype as CompanyArchetype).sizeSigma : (cohort.archetype as HouseholdArchetype).wageSigma;
  const sizeFactor = Math.min(logNormal(rng, -(sigma * sigma) / 2, sigma), cohort.count * 0.9);
  const share = Math.min(0.9, sizeFactor / cohort.count);

  const entity =
    cohort.memberKind === 'company'
      ? buildCompany(world, cohort, identity, sizeFactor)
      : buildHousehold(world, cohort, identity, sizeFactor);

  addEntity(world, entity);
  carveBalanceSheet(ctx, cohort.id, entity.id, share);

  cohort.count -= 1;
  if (cohort.memberKind === 'company') {
    const company = entity as Company;
    cohort.pool.employees = Math.max(0, (cohort.pool.employees ?? 0) - company.employees);
    const stock = (cohort.pool.inventoryUnits ?? 0) * share;
    cohort.pool.inventoryUnits = Math.max(0, (cohort.pool.inventoryUnits ?? 0) - stock);
    company.inventoryUnits = stock;
  } else {
    const household = entity as Household;
    const employed = (cohort.pool.employed ?? 0) > 0 ? 1 : 0;
    cohort.pool.employed = Math.max(0, (cohort.pool.employed ?? 0) - employed);
    household.employed = employed > 0;
  }

  attachLegacyDebt(ctx, cohort, entity.id);

  touch(world, entity.id);
  ctx.emit('lod.promoted', { entityId: entity.id, cohortId: cohort.id, reason });
  return { entity, sizeFactor };
}

/**
 * Debt carved out of a pool is real money owed to somebody. Give it a contract
 * so it accrues interest and shows up in the borrower's credit assessment,
 * rather than sitting inert on the balance sheet.
 *
 * No postings are needed: the aggregate already sits on the lender's books,
 * and the carve moved the borrower's side of it.
 */
function attachLegacyDebt(ctx: SimContext, cohort: Cohort, entityId: EntityId): void {
  const lenderId = cohort.bankId;
  if (!lenderId) return;
  const owed = naturalBalance(ctx.ledger, entityId, AC.BORROWINGS);
  if (owed <= 0) return;

  const rng = identityRng(ctx.world.seed, `legacy:${entityId}`);
  const cb = ctx.world.entities[ctx.world.centralBankId];
  const base = cb?.kind === 'centralBank' ? cb.bankRate : 0.05;
  const grade = cohort.memberKind === 'company'
    ? (cohort.archetype as CompanyArchetype).creditGrade
    : (cohort.archetype as HouseholdArchetype).creditGrade;

  addInstrument(ctx.world, {
    id: nextId(ctx.world.ids, 'loan'),
    type: LOAN_BULLET,
    holderId: lenderId,
    obligorId: entityId,
    principal: owed,
    outstanding: owed,
    rate: base + 0.015 + rng() * 0.02,
    accrued: ZERO,
    openedOn: ctx.tick,
    maturesOn: addMonths(ctx.tick, 36 + Math.floor(rng() * 60)),
    nextPaymentOn: addMonths(ctx.tick, 1),
    paymentIntervalMonths: 1,
    status: 'active',
    grade,
    data: { legacy: true, arrears: 0 },
  });
}

function buildCompany(world: WorldState, cohort: Cohort, identity: string, sizeFactor: number): Company {
  const archetype = cohort.archetype as CompanyArchetype;
  const id = nextId(world.ids, 'cmp');
  // Drawn from the firm's own identity, so the same latent member is always
  // the same quality of business however often it is materialised.
  const quality = drawQuality(world, identity);
  return {
    id,
    kind: 'company',
    detail: 'resolved',
    name: companyName(world, identity, archetype),
    createdOn: world.tick,
    originCohortId: cohort.id,
    sector: archetype.sector,
    region: archetype.region,
    sizeBand: archetype.sizeBand,
    creditGrade: archetype.creditGrade,
    status: 'active',
    employees: Math.max(1, Math.round(archetype.meanEmployees * sizeFactor)),
    quality,
    productivity: archetype.meanProductivity * quality,
    wagePerEmployee: archetype.meanWagePerEmployee,
    price: archetype.meanPrice,
    inventoryUnits: 0,
    lastSoldUnits: 0,
    recentRevenue: ZERO,
    expectedSales: 0,
    pdAnnual: 0.02,
    financials: goingRateFinancials({
      employees: Math.max(1, Math.round(archetype.meanEmployees * sizeFactor)),
      productivity: archetype.meanProductivity * quality,
      price: archetype.meanPrice,
      wagePerEmployee: archetype.meanWagePerEmployee,
    }),
    ...(cohort.bankId ? { bankId: cohort.bankId } : {}),
    fundingNeed: ZERO,
  };
}

function buildHousehold(world: WorldState, cohort: Cohort, identity: string, sizeFactor: number): Household {
  const archetype = cohort.archetype as HouseholdArchetype;
  const id = nextId(world.ids, 'hh');
  return {
    id,
    kind: 'household',
    detail: 'resolved',
    name: householdName(world, identity),
    createdOn: world.tick,
    originCohortId: cohort.id,
    region: archetype.region,
    employed: true,
    wage: Math.round(archetype.meanWage * sizeFactor) as Money,
    propensityToConsume: archetype.meanPropensityToConsume,
    creditGrade: archetype.creditGrade,
    pdAnnual: 0.015,
    lastIncome: ZERO,
    incomeRate: ZERO,
    ...(cohort.bankId ? { bankId: cohort.bankId } : {}),
  };
}

/**
 * Move `share` of every one of the cohort's balances onto the new entity.
 * Balances are moved as raw debit-positive amounts, so assets, liabilities and
 * reserves all carve correctly with one rule.
 */
function carveBalanceSheet(ctx: SimContext, cohortId: EntityId, entityId: EntityId, share: number): void {
  const carved: { code: string; amount: Money }[] = [];
  let residual = 0;
  for (const account of accountsOf(ctx.ledger, cohortId)) {
    if (account.balance === 0) continue;
    const amount = scale(account.balance, share);
    if (amount === 0) continue;
    carved.push({ code: account.code, amount });
    residual += amount;
  }
  if (carved.length === 0) return;

  // Each account is rounded on its own, so the carved slice can be a few pence
  // out even though the pool's own books balance exactly. Push the difference
  // onto the largest line: without this the new entity carries a residual, and
  // deleting it later would quietly destroy those pence.
  if (residual !== 0) {
    let largest = carved[0]!;
    for (const line of carved) if (Math.abs(line.amount) > Math.abs(largest.amount)) largest = line;
    largest.amount = (largest.amount - residual) as Money;
  }

  const postings = [];
  for (const line of carved) {
    if (line.amount === 0) continue;
    postings.push({ ownerId: cohortId, code: line.code, amount: -line.amount as Money });
    postings.push({ ownerId: entityId, code: line.code, amount: line.amount });
  }
  if (postings.length === 0) return;
  post(ctx.ledger, {
    tick: ctx.tick,
    kind: 'lod.carve',
    description: `Carve ${(share * 100).toFixed(2)}% of ${cohortId} out to ${entityId}`,
    refs: { cohortId, entityId },
    postings,
  });
}

/**
 * Fold a resolved entity back into its cohort. Only safe once it holds no
 * contracts, since a cohort cannot carry an individual loan.
 */
export function demoteEntity(ctx: SimContext, entityId: EntityId): boolean {
  const { world } = ctx;
  const entity = world.entities[entityId];
  if (!entity || (entity.kind !== 'company' && entity.kind !== 'household')) return false;
  if (!entity.originCohortId) return false;

  const cohort = world.entities[entity.originCohortId];
  if (!cohort || cohort.kind !== 'cohort') return false;
  if (hasLiveContracts(world, entityId)) return false;

  const postings = [];
  for (const account of accountsOf(ctx.ledger, entityId)) {
    if (account.balance === 0) continue;
    postings.push({ ownerId: entityId, code: account.code, amount: -account.balance as Money });
    postings.push({ ownerId: cohort.id, code: account.code, amount: account.balance });
  }
  if (postings.length > 0) {
    post(ctx.ledger, {
      tick: ctx.tick,
      kind: 'lod.fold',
      description: `Fold ${entityId} back into ${cohort.id}`,
      refs: { cohortId: cohort.id, entityId },
      postings,
    });
  }

  cohort.count += 1;
  if (entity.kind === 'company') {
    cohort.pool.employees = (cohort.pool.employees ?? 0) + entity.employees;
    cohort.pool.inventoryUnits = (cohort.pool.inventoryUnits ?? 0) + entity.inventoryUnits;
  } else if (entity.employed) {
    cohort.pool.employed = (cohort.pool.employed ?? 0) + 1;
  }

  removeEntity(world, entityId);
  forgetOwner(ctx.ledger, entityId);
  ctx.emit('lod.demoted', { entityId, cohortId: cohort.id });
  return true;
}

/**
 * Wind an entity up and pass whatever is left to the pool it came from.
 *
 * Unlike demotion this does not put a member back: the firm is gone. But its
 * residual balance sheet is not. Deleting the accounts outright would destroy
 * a deposit the bank still owes, so the claims have to go somewhere -- and the
 * natural somewhere is the rest of its sector.
 */
export function dissolveEntity(ctx: SimContext, entityId: EntityId): boolean {
  const { world } = ctx;
  const entity = world.entities[entityId];
  if (!entity || (entity.kind !== 'company' && entity.kind !== 'household')) return false;

  const cohort = entity.originCohortId ? world.entities[entity.originCohortId] : undefined;
  if (!cohort || cohort.kind !== 'cohort') return false;
  if (hasLiveContracts(world, entityId)) return false;

  const postings = [];
  for (const account of accountsOf(ctx.ledger, entityId)) {
    if (account.balance === 0) continue;
    postings.push({ ownerId: entityId, code: account.code, amount: -account.balance as Money });
    postings.push({ ownerId: cohort.id, code: account.code, amount: account.balance });
  }
  if (postings.length > 0) {
    post(ctx.ledger, {
      tick: ctx.tick,
      kind: 'lod.dissolve',
      description: `Wind up ${entityId} into ${cohort.id}`,
      refs: { cohortId: cohort.id, entityId },
      postings,
    });
  }

  if (entity.kind === 'company' && entity.inventoryUnits > 0) {
    cohort.pool.inventoryUnits = (cohort.pool.inventoryUnits ?? 0) + entity.inventoryUnits;
  }

  removeEntity(world, entityId);
  forgetOwner(ctx.ledger, entityId);
  return true;
}

function hasLiveContracts(world: WorldState, entityId: EntityId): boolean {
  if (owedBy(world, entityId).some((i) => i.status === 'active')) return true;
  return (world.instrumentsByHolder[entityId] ?? []).some((id) => world.instruments[id]?.status === 'active');
}

/**
 * Move a customer's money to a different bank. Deposits follow the customer,
 * and reserves move between the two banks to settle -- so winning a customer
 * genuinely funds you, and losing one genuinely drains you.
 */
export function switchBank(ctx: SimContext, entityId: EntityId, newBankId: EntityId): void {
  const entity = getEntity(ctx.world, entityId);
  if (entity.kind !== 'company' && entity.kind !== 'household' && entity.kind !== 'cohort') return;
  const oldBankId = entity.bankId;
  if (oldBankId === newBankId) return;

  if (oldBankId) {
    const amount = balance(ctx.ledger, entityId, depositCode(oldBankId));
    if (amount !== 0) {
      post(ctx.ledger, {
        tick: ctx.tick,
        kind: 'bank.switch',
        description: `${entityId} moves banking to ${newBankId}`,
        refs: { entityId, from: oldBankId, to: newBankId },
        postings: [
          credit(entityId, depositCode(oldBankId), amount as Money),
          debit(entityId, depositCode(newBankId), amount as Money),
          debit(oldBankId, AC.CUSTOMER_DEPOSITS, amount as Money),
          credit(oldBankId, AC.RESERVES, amount as Money),
          credit(newBankId, AC.CUSTOMER_DEPOSITS, amount as Money),
          debit(newBankId, AC.RESERVES, amount as Money),
        ],
      });
    }
  }
  entity.bankId = newBankId;
  touch(ctx.world, entityId);
}

function countResolved(world: WorldState): number {
  let n = 0;
  for (const id in world.entities) {
    const e: Entity = world.entities[id]!;
    if (e.kind === 'company' || e.kind === 'household') n++;
  }
  return n;
}

/**
 * A firm's quality, as a multiple of its sector average.
 *
 * Log-normal with a mean of exactly one, so materialising members out of a
 * cohort does not quietly make the economy more or less productive than the
 * pool it drew them from.
 */
export function drawQuality(world: WorldState, identity: string): number {
  const spread = world.config.firmQualitySpread;
  if (spread <= 0) return 1;
  const rng = identityRng(world.seed, `quality:${identity}`);
  return Math.max(0.3, Math.min(2.5, logNormal(rng, -(spread * spread) / 2, spread)));
}

const COMPANY_SUFFIX = ['Ltd', 'Group', 'Holdings', 'plc', '& Co', 'Services'];
const COMPANY_STEM = [
  'Ashfield', 'Brackley', 'Camden', 'Dunmore', 'Eastgate', 'Fenwick', 'Garrick', 'Harlow',
  'Ilkley', 'Jarrow', 'Kelvin', 'Lambourn', 'Marlow', 'Norbury', 'Oakhurst', 'Penrith',
  'Quarry', 'Redcliffe', 'Stanmore', 'Thornbury', 'Upton', 'Verity', 'Westbrook', 'Yardley',
];
const SURNAMES = [
  'Ahmed', 'Bennett', 'Clarke', 'Dhillon', 'Evans', 'Fletcher', 'Grant', 'Hughes',
  'Iqbal', 'Jones', 'Kaur', 'Lewis', 'Murray', 'Nowak', 'Okafor', 'Patel',
  'Quinn', 'Reid', 'Shah', 'Thompson', 'Ueno', 'Vaughan', 'Wright', 'Young',
];

function companyName(world: WorldState, identity: string, archetype: CompanyArchetype): string {
  const rng = identityRng(world.seed, `name:${identity}`);
  const stem = COMPANY_STEM[Math.floor(rng() * COMPANY_STEM.length)]!;
  const suffix = COMPANY_SUFFIX[Math.floor(rng() * COMPANY_SUFFIX.length)]!;
  const sector = archetype.sector.charAt(0).toUpperCase() + archetype.sector.slice(1);
  return `${stem} ${sector} ${suffix}`;
}

function householdName(world: WorldState, identity: string): string {
  const rng = identityRng(world.seed, `name:${identity}`);
  const surname = SURNAMES[Math.floor(rng() * SURNAMES.length)]!;
  return `${surname} household`;
}
