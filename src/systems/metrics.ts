import { isMonthEnd } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { naturalBalance } from '../ledger/ledger.js';
import { incomeStatement } from '../ledger/statements.js';
import { record } from '../metrics/recorder.js';
import { regulatoryMetrics } from '../metrics/regulatory.js';
import { firmViews } from '../agents/views.js';
import { centralBank, cohorts, heldBy, playerBank, resolvedCompanies } from '../world/state.js';
import { PHASE, defineSystem } from './system.js';

/**
 * Samples the state of the bank and the economy once a month. The dashboard
 * charts read from here, and so does anyone balancing the game from a headless
 * batch run.
 */
/**
 * What firms make on a unit before overheads: price less the wages that went
 * into producing it, across the whole economy and weighted by headcount.
 *
 * Worth watching because nothing in the model defends it. Firms price off how
 * fast stock is turning over, not off what it cost them, so pay can rise
 * straight through the price and leave the entire firm sector selling below
 * cost -- at which point nobody can service a loan and the credit market
 * closes. That is invisible in a three-year run and fatal in a ten-year one.
 */
function grossMargin(world: Parameters<typeof resolvedCompanies>[0]): number {
  let employees = 0;
  let weightedPrice = 0;
  let weightedCost = 0;
  for (const firm of firmViews(world)) {
    if (firm.employees <= 0 || firm.price <= 0 || firm.productivity <= 0) continue;
    employees += firm.employees;
    weightedPrice += firm.price * firm.employees;
    weightedCost += (firm.wagePerEmployee / firm.productivity) * firm.employees;
  }
  if (employees === 0 || weightedPrice === 0) return 0;
  return (weightedPrice - weightedCost) / weightedPrice;
}

/**
 * Every company in the economy, latent or resolved.
 *
 * The denominator for anything meant to describe the corporate sector rather
 * than the player's borrowers. Resolved firms are a selected few hundred --
 * selected precisely for having borrowed -- and reading a whole-economy rate
 * off them overstates it by more than an order of magnitude.
 */
function totalFirms(world: Parameters<typeof resolvedCompanies>[0]): number {
  let total = resolvedCompanies(world).length;
  for (const cohort of cohorts(world)) {
    if (cohort.memberKind === 'company') total += cohort.count;
  }
  return total;
}

export const metricsSystem = defineSystem({
  id: 'metrics.record',
  phase: PHASE.METRICS,
  description: 'Records monthly time series for the bank and the economy',
  run(ctx) {
    if (!isMonthEnd(ctx.tick)) return;
    const { world, ledger } = ctx;
    const bank = playerBank(world);
    const cb = centralBank(world);
    const reg = regulatoryMetrics(world, ledger, bank.id);
    const pl = incomeStatement(ledger, bank.id);

    let nonPerforming = 0;
    let loanBook = 0;
    for (const inst of heldBy(world, bank.id)) {
      if (!inst.type.startsWith('loan.')) continue;
      if (inst.status === 'active') {
        loanBook += inst.outstanding;
        if (Number(inst.data.arrears ?? 0) > 0) nonPerforming += inst.outstanding;
      }
    }

    record(world.metrics, ctx.tick, {
      totalAssets: reg.totalAssets,
      equity: reg.cet1,
      capitalRatio: reg.capitalRatio,
      leverageRatio: reg.leverageRatio,
      lcr: reg.lcr,
      rwa: reg.rwa,
      deposits: naturalBalance(ledger, bank.id, AC.CUSTOMER_DEPOSITS),
      loans: naturalBalance(ledger, bank.id, AC.LOANS),
      bonds: naturalBalance(ledger, bank.id, AC.BONDS),
      reserves: naturalBalance(ledger, bank.id, AC.RESERVES),
      centralBankFunding: reg.centralBankFunding,
      profitYtd: pl.profit,
      interestIncome: naturalBalance(ledger, bank.id, AC.INTEREST_INCOME),
      interestExpense: naturalBalance(ledger, bank.id, AC.INTEREST_EXPENSE),
      operatingExpense: naturalBalance(ledger, bank.id, AC.OPERATING_EXPENSE),
      earningAssets: naturalBalance(ledger, bank.id, AC.LOANS) +
        naturalBalance(ledger, bank.id, AC.BONDS) +
        naturalBalance(ledger, bank.id, AC.RESERVES),
      impairments: naturalBalance(ledger, bank.id, AC.IMPAIRMENT),
      nplRatio: loanBook > 0 ? nonPerforming / loanBook : 0,
      protectedDeposits: reg.protectedDeposits,
      bankRate: cb.bankRate,
      inflation: world.economy.inflationAnnual,
      unemployment: world.economy.unemployment,
      outputGap: world.economy.outputGap,
      priceLevel: world.economy.priceIndex,
      output: world.economy.outputUnits,
      resolvedFirms: resolvedCompanies(world).length,
      totalFirms: totalFirms(world),
      grossMargin: grossMargin(world),
    });

    if (reg.capitalRatio < world.config.minimumCapitalRatio) {
      ctx.emit('bank.breachedLimit', {
        bankId: bank.id,
        limit: 'capitalRatio',
        value: reg.capitalRatio,
        threshold: world.config.minimumCapitalRatio,
      });
      ctx.emit('notice', {
        severity: 'critical',
        message: `Capital ratio ${(reg.capitalRatio * 100).toFixed(1)}% is below the ${(world.config.minimumCapitalRatio * 100).toFixed(0)}% minimum`,
      });
    }
    if (reg.lcr < world.config.minimumLiquidityRatio) {
      ctx.emit('bank.breachedLimit', {
        bankId: bank.id,
        limit: 'lcr',
        value: reg.lcr,
        threshold: world.config.minimumLiquidityRatio,
      });
    }
  },
});
