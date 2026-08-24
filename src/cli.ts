/**
 * Headless runner: `npm run sim -- 730` advances the default scenario two
 * years and prints where the bank ended up. Useful for balancing without
 * opening a browser.
 */
import { format, formatShort } from './core/money.js';
import { formatDay } from './core/time.js';
import { AC } from './ledger/accounts.js';
import { naturalBalance } from './ledger/ledger.js';
import { balanceSheet, incomeStatement } from './ledger/statements.js';
import { regulatoryMetrics } from './metrics/regulatory.js';
import { playerBank, resolvedCompanies } from './world/state.js';
import { newGame } from './index.js';

const days = Number(process.argv[2] ?? 365);
const seed = process.argv[3] ? Number(process.argv[3]) : undefined;

const engine = newGame('uk2025', seed === undefined ? {} : { seed });
const world = engine.world;
const bank = playerBank(world);

console.log(`${bank.name} -- opening ${formatDay(world.tick)}`);
printPosition();

const started = Date.now();
engine.run(days);
const elapsed = Date.now() - started;

console.log(`\nRan ${days} days in ${elapsed}ms (${(days / (elapsed / 1000)).toFixed(0)} ticks/sec)`);
console.log(`\n${bank.name} -- ${formatDay(world.tick)}`);
printPosition();

const pl = incomeStatement(world.ledger, bank.id);
console.log('\nIncome statement (year to date)');
for (const line of pl.income) console.log(`  ${line.name.padEnd(24)} ${format(line.amount).padStart(16)}`);
for (const line of pl.expenses) console.log(`  ${line.name.padEnd(24)} ${format(-line.amount as never).padStart(16)}`);
console.log(`  ${'Profit'.padEnd(24)} ${format(pl.profit).padStart(16)}`);

const activity = engine.recentActivity(12);
console.log('\nRecent activity');
for (const event of activity) console.log(`  [${event.meta.tick}] ${event.type} ${summarise(event.payload)}`);

function printPosition(): void {
  const sheet = balanceSheet(world.ledger, bank.id);
  const reg = regulatoryMetrics(world, world.ledger, bank.id);
  console.log(`  Total assets      ${formatShort(sheet.totalAssets).padStart(12)}`);
  console.log(`  Loans             ${formatShort(naturalBalance(world.ledger, bank.id, AC.LOANS)).padStart(12)}`);
  console.log(`  Gilts             ${formatShort(naturalBalance(world.ledger, bank.id, AC.BONDS)).padStart(12)}`);
  console.log(`  Reserves          ${formatShort(naturalBalance(world.ledger, bank.id, AC.RESERVES)).padStart(12)}`);
  console.log(`  Deposits          ${formatShort(naturalBalance(world.ledger, bank.id, AC.CUSTOMER_DEPOSITS)).padStart(12)}`);
  console.log(`  Equity            ${formatShort(sheet.totalEquity).padStart(12)}`);
  console.log(`  Capital ratio     ${(reg.capitalRatio * 100).toFixed(1).padStart(11)}%`);
  console.log(`  LCR               ${(reg.lcr * 100).toFixed(0).padStart(11)}%`);
  console.log(`  Bank Rate         ${(bankRate() * 100).toFixed(2).padStart(11)}%`);
  console.log(`  Inflation         ${(world.economy.inflationAnnual * 100).toFixed(2).padStart(11)}%`);
  console.log(`  Unemployment      ${(world.economy.unemployment * 100).toFixed(1).padStart(11)}%`);
  console.log(`  Resolved firms    ${String(resolvedCompanies(world).length).padStart(12)}`);
}

function bankRate(): number {
  const cb = world.entities[world.centralBankId];
  return cb?.kind === 'centralBank' ? cb.bankRate : 0;
}

function summarise(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return String(payload ?? '');
  const entries = Object.entries(payload as Record<string, unknown>).slice(0, 3);
  return entries.map(([k, v]) => `${k}=${typeof v === 'number' ? Math.round(v) : String(v)}`).join(' ');
}
