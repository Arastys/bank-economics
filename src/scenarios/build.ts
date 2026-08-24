import { ZERO, add, format, pounds, round, scale, sub, type Money } from '../core/money.js';
import { nextId, type IdCounters } from '../core/ids.js';
import { identityRng, logNormal, makeRng, randInt } from '../core/rng.js';
import { addYears, fromDate, addMonths } from '../core/time.js';
import { AC, depositCode } from '../ledger/accounts.js';
import { createLedger, openWithCapital, post, credit, debit } from '../ledger/ledger.js';
import { drawPayReviewMonth, drawQuality } from '../agents/lod.js';
import { goingRateFinancials } from '../agents/credit.js';
import { createMetrics } from '../metrics/recorder.js';
import { BOND_FIXED } from '../instruments/bond.js';
import { DEPOSIT_INSTANT } from '../instruments/deposit.js';
import { LOAN_AMORTISING, levelPayment } from '../instruments/loan.js';
import { registerBuiltinInstruments } from '../instruments/index.js';
import { CURVE_TENORS } from '../systems/markets.js';
import { addEntity, addInstrument, DEFAULT_CONFIG, type WorldState } from '../world/state.js';
import { CREDIT_GRADES, type Cohort, type Company, type CreditGrade } from '../world/types.js';
import type { CompanyCohortSpec, ScenarioSpec } from './types.js';

/** Five working days in seven: what a daily average of a weekday flow is. */
const BUSINESS_DAY_SHARE = 5 / 7;

const PLAYER_BANK_ID = 'bank:player';
const OTHER_BANKS_ID = 'bank:market';
const CENTRAL_BANK_ID = 'cb:boe';
const GOVERNMENT_ID = 'gov:hmt';

/**
 * Turn a scenario into a running world.
 *
 * The opening balance sheets are built so that the monetary system is
 * consistent from the first tick: every reserve a bank holds is a liability of
 * the central bank, every gilt is a liability of the state, every deposit is a
 * liability of the bank holding it, and every loan on a bank's books is a debt
 * somebody actually owes. Those are the identities the invariant tests check.
 */
export function buildWorld(spec: ScenarioSpec): WorldState {
  registerBuiltinInstruments();

  const ids: IdCounters = {};
  const ledger = createLedger();
  const startTick = 0;

  const world: WorldState = {
    version: 1,
    seed: spec.seed,
    tick: startTick,
    entities: {},
    instruments: {},
    instrumentsByHolder: {},
    instrumentsByObligor: {},
    lastInteraction: {},
    ledger,
    ids,
    playerBankId: PLAYER_BANK_ID,
    otherBanksId: OTHER_BANKS_ID,
    centralBankId: CENTRAL_BANK_ID,
    governmentId: GOVERNMENT_ID,
    sectors: Object.fromEntries(spec.sectors.map((s) => [s.id, s])),
    regions: Object.fromEntries(spec.regions.map((r) => [r.id, r])),
    markets: {
      interbankRate: spec.centralBank.bankRate,
      yieldCurve: {},
      creditSpreads: Object.fromEntries(CREDIT_GRADES.map((g) => [g, 0.02])) as Record<CreditGrade, number>,
      bondPrices: {},
    },
    economy: {
      priceIndex: 100,
      inflationAnnual: spec.centralBank.inflationTarget,
      outputGap: 0,
      unemployment: 0,
      outputUnits: 0,
      demandUnits: 0,
      potentialOutput: 0,
      labourForce: 0,
      employed: 0,
      confidence: 1,
      priceIndexHistory: [],
      wageIndex: 1,
      wageIndexHistory: [],
    },
    applications: {},
    metrics: createMetrics(),
    config: { ...DEFAULT_CONFIG, ...spec.config },
  };

  for (const tenor of CURVE_TENORS) world.markets.yieldCurve[tenor] = spec.centralBank.bankRate;

  // --- institutions --------------------------------------------------------

  addEntity(world, {
    id: CENTRAL_BANK_ID,
    kind: 'centralBank',
    detail: 'resolved',
    name: spec.centralBank.name,
    createdOn: startTick,
    bankRate: spec.centralBank.bankRate,
    inflationTarget: spec.centralBank.inflationTarget,
    corridor: spec.centralBank.corridor,
  });

  addEntity(world, {
    id: GOVERNMENT_ID,
    kind: 'government',
    detail: 'resolved',
    name: 'HM Treasury',
    createdOn: startTick,
  });

  addEntity(world, {
    id: PLAYER_BANK_ID,
    kind: 'bank',
    detail: 'resolved',
    name: spec.playerBank.name,
    createdOn: startTick,
    isPlayer: true,
    policy: structuredClone(spec.playerBank.policy),
    operatingCostPerMonth: spec.playerBank.operatingCostPerMonth,
  });

  addEntity(world, {
    id: OTHER_BANKS_ID,
    kind: 'bank',
    detail: 'resolved',
    name: spec.otherBanks.name,
    createdOn: startTick,
    isPlayer: false,
    policy: structuredClone(spec.playerBank.policy),
    operatingCostPerMonth: ZERO,
  });

  // --- the latent economy --------------------------------------------------

  const subdivided = subdivide(spec);
  const specByCohortId = new Map(subdivided.map(({ spec: cohortSpec, id }) => [id, cohortSpec]));

  const companyCohorts: Cohort[] = subdivided.map(({ spec: cohortSpec, id }) => {
    return addEntity(world, {
      id,
      kind: 'cohort',
      detail: 'cohort',
      name: `${cohortSpec.sizeBand} ${cohortSpec.sector} (${cohortSpec.region})`,
      createdOn: startTick,
      memberKind: 'company',
      count: cohortSpec.count,
      nextMemberIndex: 0,
      bankId: OTHER_BANKS_ID,
      archetype: {
        sector: cohortSpec.sector,
        region: cohortSpec.region,
        sizeBand: cohortSpec.sizeBand,
        creditGrade: cohortSpec.creditGrade,
        sizeSigma: cohortSpec.sizeSigma,
        meanEmployees: cohortSpec.meanEmployees,
        meanProductivity: cohortSpec.meanProductivity,
        meanWagePerEmployee: cohortSpec.meanWagePerEmployee,
        meanPrice: cohortSpec.meanPrice,
      },
      pool: {
        employees: cohortSpec.count * cohortSpec.meanEmployees,
        inventoryUnits:
          cohortSpec.meanPrice > 0
            ? (cohortSpec.count * cohortSpec.inventoryValuePerFirm) / cohortSpec.meanPrice
            : 0,
        price: cohortSpec.meanPrice,
        wage: cohortSpec.meanWagePerEmployee,
        lastSoldUnits: 0,
        // Warm start: the economy has been running for years before the game
        // opens, so the smoothed figures that drive spending and investment
        // start at their going rate. Starting them at zero would collapse
        // demand for a fortnight and send the whole model into a slump that
        // has nothing to do with anything the player did.
        recentRevenue: dailyRevenue(cohortSpec.count * cohortSpec.meanEmployees, cohortSpec),
        expectedSales: dailySales(cohortSpec.count * cohortSpec.meanEmployees, cohortSpec),
      },
    });
  });

  const householdCohorts: Cohort[] = spec.householdCohorts.map((cohortSpec, index) => {
    const id = cohortSpec.id ?? `coh:hh:${index}`;
    return addEntity(world, {
      id,
      kind: 'cohort',
      detail: 'cohort',
      name: `Households (${cohortSpec.region}${cohortSpec.banksWithPlayer ? ', your customers' : ''})`,
      createdOn: startTick,
      memberKind: 'household',
      count: cohortSpec.count,
      nextMemberIndex: 0,
      bankId: cohortSpec.banksWithPlayer ? PLAYER_BANK_ID : OTHER_BANKS_ID,
      archetype: {
        region: cohortSpec.region,
        creditGrade: cohortSpec.creditGrade,
        meanWage: cohortSpec.meanWage,
        wageSigma: cohortSpec.wageSigma,
        meanPropensityToConsume: cohortSpec.meanPropensityToConsume,
        employmentRate: cohortSpec.employmentRate,
      },
      pool: {
        employed: Math.round(cohortSpec.count * cohortSpec.employmentRate),
        lastIncome: 0,
        incomeRate: round(
          cohortSpec.count * cohortSpec.employmentRate * cohortSpec.meanWage * BUSINESS_DAY_SHARE,
        ),
      },
    });
  });

  // --- the player's existing corporate customers ---------------------------

  const rng = makeRng(spec.seed);
  const customers: { company: Company; loan: Money; rate: number; termMonths: number }[] = [];
  for (let i = 0; i < spec.existingCorporateCustomers; i++) {
    const cohortIndex = randInt(rng, 0, companyCohorts.length - 1);
    const cohort = companyCohorts[cohortIndex]!;
    const cohortSpec = specByCohortId.get(cohort.id)!;
    if (cohort.count <= 1) continue;

    const identity = `${cohort.id}#${cohort.nextMemberIndex++}`;
    const idRng = identityRng(spec.seed, identity);
    const sizeFactor = Math.min(6, logNormal(idRng, -(cohortSpec.sizeSigma ** 2) / 2, cohortSpec.sizeSigma));
    const employees = Math.max(1, Math.round(cohortSpec.meanEmployees * sizeFactor));
    const quality = drawQuality(world, identity);
    const payReviewMonth = drawPayReviewMonth(world, identity);

    const company: Company = {
      id: nextId(ids, 'cmp'),
      kind: 'company',
      detail: 'resolved',
      name: `${customerName(spec.seed, identity)} ${titleCase(cohortSpec.sector)} Ltd`,
      createdOn: startTick,
      originCohortId: cohort.id,
      sector: cohortSpec.sector,
      region: cohortSpec.region,
      sizeBand: cohortSpec.sizeBand,
      creditGrade: cohortSpec.creditGrade,
      status: 'active',
      employees,
      quality,
      productivity: cohortSpec.meanProductivity * quality,
      payReviewMonth,
      wageIndexAtReview: 1,
      wagePerEmployee: cohortSpec.meanWagePerEmployee,
      price: cohortSpec.meanPrice,
      inventoryUnits:
        cohortSpec.meanPrice > 0
          ? (cohortSpec.inventoryValuePerFirm * sizeFactor) / cohortSpec.meanPrice
          : 0,
      lastSoldUnits: 0,
      recentRevenue: dailyRevenue(employees, cohortSpec),
      expectedSales: dailySales(employees, cohortSpec),
      pdAnnual: 0.02,
      financials: goingRateFinancials({
        employees,
        productivity: cohortSpec.meanProductivity * quality,
        price: cohortSpec.meanPrice,
        wagePerEmployee: cohortSpec.meanWagePerEmployee,
      }),
      bankId: PLAYER_BANK_ID,
      fundingNeed: ZERO,
    };

    // Take this firm out of the pool it came from.
    cohort.count -= 1;
    cohort.pool.employees = Math.max(0, (cohort.pool.employees ?? 0) - employees);
    cohort.pool.inventoryUnits = Math.max(0, (cohort.pool.inventoryUnits ?? 0) - company.inventoryUnits);

    addEntity(world, company);
    customers.push({
      company,
      loan: round(cohortSpec.debtPerFirm * sizeFactor),
      rate: spec.centralBank.bankRate + 0.02 + idRng() * 0.02,
      termMonths: randInt(rng, 24, 84),
    });
  }

  // --- opening balance sheets ---------------------------------------------

  let playerDeposits: Money = ZERO;
  let otherDeposits: Money = ZERO;
  let otherLoans: Money = ZERO;

  companyCohorts.forEach((cohort) => {
    const cohortSpec = specByCohortId.get(cohort.id)!;
    if (cohort.count <= 0) return;
    const cash = scale(cohortSpec.cashPerFirm, cohort.count);
    const debt = scale(cohortSpec.debtPerFirm, cohort.count);
    openWithCapital(
      ledger,
      cohort.id,
      startTick,
      {
        [depositCode(OTHER_BANKS_ID)]: cash,
        [AC.FIXED_ASSETS]: scale(cohortSpec.fixedAssetsPerFirm, cohort.count),
        [AC.INVENTORY]: scale(cohortSpec.inventoryValuePerFirm, cohort.count),
      },
      { [AC.BORROWINGS]: debt },
    );
    otherDeposits = add(otherDeposits, cash);
    otherLoans = add(otherLoans, debt);
  });

  spec.householdCohorts.forEach((cohortSpec, index) => {
    const cohort = householdCohorts[index]!;
    const bankId = cohort.bankId!;
    const savings = scale(cohortSpec.savingsPerHousehold, cohort.count);
    const debt = scale(cohortSpec.debtPerHousehold, cohort.count);
    openWithCapital(
      ledger,
      cohort.id,
      startTick,
      { [depositCode(bankId)]: savings },
      { [AC.BORROWINGS]: debt },
    );
    if (bankId === PLAYER_BANK_ID) playerDeposits = add(playerDeposits, savings);
    else otherDeposits = add(otherDeposits, savings);
    // Household borrowing predates the game and sits with the rest of the
    // market, so the player's book starts purely corporate. Retail lending is
    // a deliberate extension point rather than a starting position.
    otherLoans = add(otherLoans, debt);
  });

  let playerCorporateLoans: Money = ZERO;
  for (const customer of customers) {
    const cohortSpec = specByCohortId.get(customer.company.originCohortId!)!;
    const sizeRatio = customer.company.employees / Math.max(1, cohortSpec.meanEmployees);
    const cash = round(cohortSpec.cashPerFirm * sizeRatio);
    openWithCapital(
      ledger,
      customer.company.id,
      startTick,
      {
        [depositCode(PLAYER_BANK_ID)]: cash,
        [AC.FIXED_ASSETS]: round(cohortSpec.fixedAssetsPerFirm * sizeRatio),
        [AC.INVENTORY]: round(cohortSpec.inventoryValuePerFirm * sizeRatio),
      },
      { [AC.BORROWINGS]: customer.loan },
    );
    playerDeposits = add(playerDeposits, cash);
    playerCorporateLoans = add(playerCorporateLoans, customer.loan);
  }

  const playerLoans = playerCorporateLoans;
  const playerGilts = scale(playerDeposits, spec.playerBank.giltsToDeposits);
  const otherGilts = scale(otherDeposits, spec.otherBanks.giltsToDeposits);

  // Reserves are the balancing figure: whatever equity and deposits fund that
  // has not been lent out or invested in gilts is held as central bank money.
  const playerReserves = plugReserves(
    spec.playerBank.name,
    playerDeposits,
    spec.playerBank.equity,
    playerGilts,
    playerLoans,
  );
  const otherEquity = scale(otherDeposits, spec.otherBanks.equityToDeposits);
  const otherReserves = plugReserves(spec.otherBanks.name, otherDeposits, otherEquity, otherGilts, otherLoans);

  openWithCapital(
    ledger,
    PLAYER_BANK_ID,
    startTick,
    { [AC.RESERVES]: playerReserves, [AC.BONDS]: playerGilts, [AC.LOANS]: playerLoans },
    { [AC.CUSTOMER_DEPOSITS]: playerDeposits },
  );

  openWithCapital(
    ledger,
    OTHER_BANKS_ID,
    startTick,
    { [AC.RESERVES]: otherReserves, [AC.BONDS]: otherGilts, [AC.LOANS]: otherLoans },
    { [AC.CUSTOMER_DEPOSITS]: otherDeposits },
  );

  // --- the monetary base ---------------------------------------------------
  //
  // Every reserve in the system is a liability of the central bank, matched by
  // its claim on the state; every gilt in issue is a liability of the state.
  // The state has spent the proceeds, so it carries the lot as negative
  // reserves -- which is exactly what a national debt is.
  const reservesIssued = add(playerReserves, otherReserves);
  const giltsInIssue = add(playerGilts, otherGilts);

  post(ledger, {
    tick: startTick,
    kind: 'genesis.monetaryBase',
    description: 'Central bank money and government debt in issue at the start of play',
    postings: [
      debit(CENTRAL_BANK_ID, AC.LOANS, reservesIssued),
      credit(CENTRAL_BANK_ID, AC.RESERVES_ISSUED, reservesIssued),
      credit(GOVERNMENT_ID, AC.DEBT_ISSUED, add(reservesIssued, giltsInIssue)),
      debit(GOVERNMENT_ID, AC.RETAINED_EARNINGS, add(reservesIssued, giltsInIssue)),
    ],
  });

  // --- contracts behind the opening balances -------------------------------

  seedGilts(world, spec, PLAYER_BANK_ID, playerGilts);
  seedGilts(world, spec, OTHER_BANKS_ID, otherGilts);

  for (const customer of customers) {
    const monthlyRate = customer.rate / 12;
    addInstrument(world, {
      id: nextId(ids, 'loan'),
      type: LOAN_AMORTISING,
      holderId: PLAYER_BANK_ID,
      obligorId: customer.company.id,
      principal: customer.loan,
      outstanding: customer.loan,
      rate: customer.rate,
      accrued: ZERO,
      openedOn: startTick,
      maturesOn: addMonths(startTick, customer.termMonths),
      nextPaymentOn: addMonths(startTick, 1),
      paymentIntervalMonths: 1,
      status: 'active',
      grade: customer.company.creditGrade,
      data: {
        monthlyPayment: levelPayment(customer.loan, monthlyRate, customer.termMonths),
        arrears: 0,
        termMonths: customer.termMonths,
      },
    });
    world.lastInteraction[customer.company.id] = startTick;

    addInstrument(world, {
      id: nextId(ids, 'dep'),
      type: DEPOSIT_INSTANT,
      holderId: customer.company.id,
      obligorId: PLAYER_BANK_ID,
      principal: ZERO,
      outstanding: ZERO,
      rate: spec.playerBank.policy.depositRate,
      accrued: ZERO,
      openedOn: startTick,
      nextPaymentOn: addMonths(startTick, 1),
      paymentIntervalMonths: 1,
      status: 'active',
      data: {},
    });
  }

  for (const cohort of householdCohorts) {
    addInstrument(world, {
      id: nextId(ids, 'dep'),
      type: DEPOSIT_INSTANT,
      holderId: cohort.id,
      obligorId: cohort.bankId!,
      principal: ZERO,
      outstanding: ZERO,
      rate:
        cohort.bankId === PLAYER_BANK_ID
          ? spec.playerBank.policy.depositRate
          : spec.centralBank.bankRate * 0.6,
      accrued: ZERO,
      openedOn: startTick,
      nextPaymentOn: addMonths(startTick, 1),
      paymentIntervalMonths: 1,
      status: 'active',
      data: {},
    });
  }

  // --- starting economic aggregates ----------------------------------------

  let potential = 0;
  let labourForce = 0;
  for (const cohort of companyCohorts) potential += (cohort.pool.employees ?? 0) * ((cohort.archetype as { meanProductivity: number }).meanProductivity ?? 0);
  for (const customer of customers) potential += customer.company.employees * customer.company.productivity;
  for (const cohort of householdCohorts) labourForce += cohort.count;

  world.economy.potentialOutput = potential;
  world.economy.outputUnits = potential;
  world.economy.labourForce = labourForce;
  world.economy.employed = labourForce * 0.95;
  world.economy.priceIndex = averagePrice(spec);
  world.economy.priceIndexHistory = [world.economy.priceIndex];

  world.tick = fromDate(spec.startDate);
  return world;
}

/**
 * Reserves = deposits + equity - gilts - loans.
 *
 * A negative result means the scenario has asked a bank to hold more assets
 * than it has funding for, which is a scenario bug rather than a runtime one,
 * so say so plainly.
 */
function plugReserves(name: string, deposits: Money, equity: Money, gilts: Money, loans: Money): Money {
  const reserves = sub(sub(add(deposits, equity), gilts), loans);
  if (reserves < 0) {
    throw new Error(
      `Scenario error: ${name} is funded short by ${format(-reserves as Money)}. ` +
        'Raise its equity, or cut its gilts or loan book.',
    );
  }
  return reserves;
}

/** Split a bank's gilt holding across the programme's tenors. */
function seedGilts(world: WorldState, spec: ScenarioSpec, holderId: string, total: Money): void {
  if (total <= 0) return;
  const tenors = spec.gilts.tenors;
  const perTenor = round(total / tenors.length);
  let placed: Money = ZERO;

  tenors.forEach((tenor, index) => {
    const nominal = index === tenors.length - 1 ? sub(total, placed) : perTenor;
    if (nominal <= 0) return;
    placed = add(placed, nominal);
    const id = nextId(world.ids, 'bond');
    const coupon = spec.centralBank.bankRate + spec.gilts.couponSpread * (tenor / 10);
    addInstrument(world, {
      id,
      type: BOND_FIXED,
      holderId,
      obligorId: GOVERNMENT_ID,
      principal: nominal,
      outstanding: nominal,
      rate: coupon,
      accrued: ZERO,
      openedOn: world.tick,
      maturesOn: addYears(world.tick, tenor),
      nextPaymentOn: addMonths(world.tick, 6),
      paymentIntervalMonths: 6,
      status: 'active',
      grade: 'AA',
      data: { sovereign: true, termYears: tenor },
    });
    world.markets.bondPrices[id] = 1;
  });
}

/**
 * Split each company specification into several cohorts with slightly
 * different economics.
 *
 * Every member stays latent, so the per-tick cost is one extra view per cohort
 * rather than one per firm -- but the latent economy stops behaving like a
 * handful of identical giants and starts having a spread of prices, output per
 * head and pay for the goods market to sort between.
 */
function subdivide(spec: ScenarioSpec): { spec: CompanyCohortSpec; id: string }[] {
  const requested = Math.max(1, Math.round(spec.cohortSubdivision ?? 1));
  const out: { spec: CompanyCohortSpec; id: string }[] = [];

  spec.companyCohorts.forEach((cohortSpec, index) => {
    // Never split a specification so far that its slices stop being pools. A
    // cohort of three firms costs the same as a cohort of three thousand and
    // represents its members far worse, so the small specifications -- the
    // medium-sized manufacturers, the care homes -- are split less.
    const splits = Math.max(1, Math.min(requested, Math.floor(cohortSpec.count / MIN_COHORT_MEMBERS)));
    const counts = allocateCount(cohortSpec.count, splits);
    counts.forEach((count, k) => {
      if (count <= 0) return;
      const id = splits === 1 ? `coh:cmp:${index}` : `coh:cmp:${index}:${k}`;
      if (splits === 1) {
        out.push({ spec: cohortSpec, id });
        return;
      }
      // Deterministic in (seed, cohort, slice), so a scenario always builds
      // the same economy however many times it is loaded.
      const rng = identityRng(spec.seed, `subdivide:${index}:${k}`);
      const jitter = (sigma: number): number => logNormal(rng, -(sigma * sigma) / 2, sigma);

      // Productivity and pay vary independently: those are real differences
      // between firms. Price is then *derived* from them, so a cohort that
      // pays more or produces less charges more accordingly and its margin
      // stays intact. Jittering price independently instead leaves some
      // cohorts structurally unable to cover their wage bill at any volume,
      // which is not variety, it is a broken economy.
      const spread = spec.cohortDispersion ?? 0.05;
      const productivityFactor = jitter(spread);
      const wageFactor = jitter(spread * 0.9);
      const marginFactor = jitter(spread * 0.45);

      out.push({
        id,
        spec: {
          ...cohortSpec,
          count,
          meanProductivity: Math.max(0.1, cohortSpec.meanProductivity * productivityFactor),
          meanWagePerEmployee: Math.max(
            1,
            Math.round(cohortSpec.meanWagePerEmployee * wageFactor),
          ) as Money,
          meanPrice: Math.max(
            1,
            Math.round((cohortSpec.meanPrice * wageFactor * marginFactor) / productivityFactor),
          ) as Money,
          meanEmployees: Math.max(1, Math.round(cohortSpec.meanEmployees * jitter(spread * 1.6))),
        },
      });
    });
  });

  return out;
}

/** Below this many members a cohort is not worth having as a pool. */
const MIN_COHORT_MEMBERS = 40;

/** Split a headcount into `parts` whole numbers that still sum to the original. */
function allocateCount(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const counts = Array.from({ length: parts }, () => base);
  for (let i = 0; i < total - base * parts; i++) counts[i] = (counts[i] ?? 0) + 1;
  return counts;
}

/** The going daily rate of takings for a given headcount. */
function dailyRevenue(employees: number, cohortSpec: CompanyCohortSpec): Money {
  return round(employees * cohortSpec.meanProductivity * cohortSpec.meanPrice * BUSINESS_DAY_SHARE);
}

/** The going daily unit sales for a given headcount. */
function dailySales(employees: number, cohortSpec: CompanyCohortSpec): number {
  return employees * cohortSpec.meanProductivity * BUSINESS_DAY_SHARE;
}

function averagePrice(spec: ScenarioSpec): number {
  let weighted = 0;
  let total = 0;
  for (const cohort of spec.companyCohorts) {
    weighted += cohort.meanPrice * cohort.count;
    total += cohort.count;
  }
  return total > 0 ? weighted / total : pounds(1);
}

const STEMS = [
  'Aldgate', 'Bramley', 'Calder', 'Doverton', 'Elmswell', 'Frayling', 'Gorsley', 'Havering',
  'Ingleby', 'Jesmond', 'Kingsmead', 'Larkhall', 'Mossley', 'Netherby', 'Oldmoor', 'Padstow',
];

function customerName(seed: number, identity: string): string {
  const rng = identityRng(seed, `customer:${identity}`);
  return STEMS[Math.floor(rng() * STEMS.length)]!;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
