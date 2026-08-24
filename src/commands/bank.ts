import { type Money } from '../core/money.js';
import { err, ok } from '../core/result.js';
import { playerBank } from '../world/state.js';
import { CREDIT_GRADES, type CreditGrade } from '../world/types.js';
import { defineCommand, type Command } from './types.js';

export interface SetDepositRate extends Command {
  type: 'bank.setDepositRate';
  /** Annual rate, e.g. 0.025 for 2.5%. */
  rate: number;
  /** Which product the rate applies to. */
  product?: 'instant' | 'term';
}

export const setDepositRate = defineCommand<SetDepositRate>({
  type: 'bank.setDepositRate',
  label: 'Set deposit rate',
  validate(_ctx, command) {
    if (!Number.isFinite(command.rate)) return err('Rate must be a number');
    if (command.rate < 0 || command.rate > 0.2) return err('Rate must be between 0% and 20%');
    return ok();
  },
  apply(ctx, command) {
    const policy = playerBank(ctx.world).policy;
    if (command.product === 'term') policy.termDepositRate = command.rate;
    else policy.depositRate = command.rate;
    ctx.emit('notice', {
      severity: 'info',
      message: `${command.product === 'term' ? 'Term' : 'Instant access'} rate set to ${(command.rate * 100).toFixed(2)}%`,
    });
  },
});

export interface SetLendingSpread extends Command {
  type: 'bank.setLendingSpread';
  grade: CreditGrade;
  /** Margin over Bank Rate. */
  spread: number;
}

export const setLendingSpread = defineCommand<SetLendingSpread>({
  type: 'bank.setLendingSpread',
  label: 'Set lending spread',
  validate(_ctx, command) {
    if (!CREDIT_GRADES.includes(command.grade)) return err(`Unknown grade ${command.grade}`);
    if (!Number.isFinite(command.spread) || command.spread < 0 || command.spread > 0.5) {
      return err('Spread must be between 0 and 50 percentage points');
    }
    return ok();
  },
  apply(ctx, command) {
    playerBank(ctx.world).policy.lendingSpread[command.grade] = command.spread;
  },
});

export interface SetCreditPolicy extends Command {
  type: 'bank.setCreditPolicy';
  minimumGrade?: CreditGrade;
  maxSingleExposure?: Money;
  targetCapitalRatio?: number;
  targetLiquidityRatio?: number;
  autoUnderwrite?: boolean;
}

export const setCreditPolicy = defineCommand<SetCreditPolicy>({
  type: 'bank.setCreditPolicy',
  label: 'Set credit policy',
  validate(_ctx, command) {
    if (command.minimumGrade && !CREDIT_GRADES.includes(command.minimumGrade)) {
      return err(`Unknown grade ${command.minimumGrade}`);
    }
    if (command.maxSingleExposure !== undefined && command.maxSingleExposure < 0) {
      return err('Exposure limit cannot be negative');
    }
    if (
      command.targetCapitalRatio !== undefined &&
      (command.targetCapitalRatio < 0 || command.targetCapitalRatio > 1)
    ) {
      return err('Target capital ratio must be between 0 and 1');
    }
    if (
      command.targetLiquidityRatio !== undefined &&
      (command.targetLiquidityRatio < 0 || command.targetLiquidityRatio > 1)
    ) {
      return err('Target liquidity ratio must be between 0 and 1');
    }
    return ok();
  },
  apply(ctx, command) {
    const policy = playerBank(ctx.world).policy;
    if (command.minimumGrade !== undefined) policy.minimumGrade = command.minimumGrade;
    if (command.maxSingleExposure !== undefined) policy.maxSingleExposure = command.maxSingleExposure;
    if (command.targetCapitalRatio !== undefined) policy.targetCapitalRatio = command.targetCapitalRatio;
    if (command.targetLiquidityRatio !== undefined) policy.targetLiquidityRatio = command.targetLiquidityRatio;
    if (command.autoUnderwrite !== undefined) policy.autoUnderwrite = command.autoUnderwrite;
  },
});
