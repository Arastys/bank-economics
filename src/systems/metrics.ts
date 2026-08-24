import { isMonthEnd } from '../core/time.js';
import { AC } from '../ledger/accounts.js';
import { naturalBalance } from '../ledger/ledger.js';
import { incomeStatement } from '../ledger/statements.js';
import { record } from '../metrics/recorder.js';
import { regulatoryMetrics } from '../metrics/regulatory.js';
import { centralBank, heldBy, playerBank } from '../world/state.js';
import { PHASE, defineSystem } from './system.js';

/**
 * Samples the state of the bank and the economy once a month. The dashboard
 * charts read from here, and so does anyone balancing the game from a headless
 * batch run.
 */
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
