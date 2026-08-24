import { ZERO, add, type Money } from '../core/money.js';
import { bernoulli, hashString } from '../core/rng.js';
import { AC } from '../ledger/accounts.js';
import { naturalBalance } from '../ledger/ledger.js';
import { estimatePd, gradeFromPd, refreshFinancials } from '../agents/credit.js';
import type { InstrumentContext } from '../instruments/types.js';
import { windUpBorrower } from '../instruments/loan.js';
import { resolvedCompanies } from '../world/state.js';
import { PHASE, defineSystem } from './system.js';

/** Borrowers are re-scored once a week, spread evenly across it. */
const REVIEW_CYCLE = 7;

function reviewDay(id: string): number {
  return hashString(id) % REVIEW_CYCLE;
}

/**
 * Credit risk.
 *
 * Resolved borrowers get an individual probability of default that responds to
 * their own accounts and to the cycle, and a daily draw against it. Nobody's
 * balance sheet is examined until they matter to the player.
 *
 * Latent firms are not scored here at all. Whether a firm inside a pool lives
 * or dies is demography rather than credit risk -- it happens to firms with no
 * borrowing and no relationship with the bank -- and belongs to
 * `firms.demography`.
 */
export const creditRiskSystem = defineSystem({
  id: 'risk.credit',
  phase: PHASE.CREDIT_RISK,
  description: 'Scores borrowers, then decides who fails',
  run(ctx) {
    const { world, ledger } = ctx;
    const rng = ctx.rng('risk.credit');

    for (const company of resolvedCompanies(world)) {
      if (company.status === 'defaulted') continue;

      // Credit reviews are staggered through the week rather than run on every
      // borrower every day: it is both cheaper and closer to how a bank works.
      if (reviewDay(company.id) === ctx.tick % REVIEW_CYCLE) {
        refreshFinancials(ledger, company, ctx.tick);
        // Smooth the estimate, so a grade reflects a trend rather than one
        // noisy month and the customer list is not a wall of downgrades.
        company.pdAnnual = company.pdAnnual * 0.75 + estimatePd(world, company) * 0.25;
        const grade = gradeFromPd(company.pdAnnual);
        if (grade !== company.creditGrade) {
          ctx.emit('company.gradeChanged', { companyId: company.id, from: company.creditGrade, to: grade });
          company.creditGrade = grade;
        }
      }

      const debt = naturalBalance(ledger, company.id, AC.BORROWINGS);
      if (debt <= 0) continue;

      // A firm with no debt cannot default on anyone, so only the indebted draw.
      if (!bernoulli(rng, company.pdAnnual / 365)) continue;

      // This is a business failure, not a cash-flow wobble, so the firm is
      // wound up outright rather than offered the work-out that an illiquid
      // but solvent borrower would get.
      const ictx: InstrumentContext = {
        tick: ctx.tick,
        world,
        ledger,
        emit: ctx.emit,
        rng: ctx.rng,
      };
      const exposure = windUpBorrower(ictx, company.id);

      ctx.emit('notice', {
        severity: exposure > 0 ? 'warning' : 'info',
        message: `${company.name} has failed`,
      });
    }

  },
});
