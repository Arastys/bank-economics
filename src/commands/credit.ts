import { err, ok } from '../core/result.js';
import { approveApplication, assessApplication, declineApplication } from '../systems/underwriting.js';
import { defineCommand, type Command } from './types.js';

export interface ApproveCredit extends Command {
  type: 'credit.approve';
  applicationId: string;
  /** Override the rate the policy would have offered. */
  rate?: number;
}

export const approveCredit = defineCommand<ApproveCredit>({
  type: 'credit.approve',
  label: 'Approve application',
  validate(ctx, command) {
    const app = ctx.world.applications[command.applicationId];
    if (!app) return err('No such application');
    if (app.status !== 'pending') return err(`Application is already ${app.status}`);
    if (app.lenderId !== ctx.world.playerBankId) return err('Application is with another lender');
    if (command.rate !== undefined && (command.rate < 0 || command.rate > 1)) {
      return err('Rate must be between 0% and 100%');
    }
    return ok();
  },
  apply(ctx, command) {
    const app = ctx.world.applications[command.applicationId]!;
    const rate = command.rate ?? assessApplication(ctx, app).rate;
    approveApplication(ctx, app, rate);
  },
});

export interface DeclineCredit extends Command {
  type: 'credit.decline';
  applicationId: string;
  reason?: string;
}

export const declineCredit = defineCommand<DeclineCredit>({
  type: 'credit.decline',
  label: 'Decline application',
  validate(ctx, command) {
    const app = ctx.world.applications[command.applicationId];
    if (!app) return err('No such application');
    if (app.status !== 'pending') return err(`Application is already ${app.status}`);
    if (app.lenderId !== ctx.world.playerBankId) return err('Application is with another lender');
    return ok();
  },
  apply(ctx, command) {
    const app = ctx.world.applications[command.applicationId]!;
    declineApplication(ctx, app, command.reason ?? 'Declined by the credit committee');
  },
});
