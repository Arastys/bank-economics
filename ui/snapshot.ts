/**
 * The data contract between the simulation and the dashboard.
 *
 * The engine runs on a worker thread and the page never sees the world, so
 * everything the dashboard draws has to survive being structured-cloned across
 * that boundary. Keeping it to a compact, plain, already-resolved shape -- a
 * few kilobytes rather than the multi-megabyte world -- is what makes posting
 * one of these several times a second cheap.
 */
import { formatDay } from '../src/core/time.js';
import { AC } from '../src/ledger/accounts.js';
import { naturalBalance } from '../src/ledger/ledger.js';
import { balanceSheet, incomeStatement } from '../src/ledger/statements.js';
import { regulatoryMetrics } from '../src/metrics/regulatory.js';
import { seriesOf } from '../src/metrics/recorder.js';
import { centralBank, heldBy, playerBank } from '../src/world/state.js';
import { CREDIT_GRADES, type BankPolicy, type CreditGrade } from '../src/world/types.js';
import type { Engine } from '../src/engine/engine.js';

export interface LineItem {
  code: string;
  name: string;
  amount: number;
}

export interface PendingApplication {
  id: string;
  applicant: string;
  amount: number;
  termMonths: number;
  grade: CreditGrade;
}

export interface BookRow {
  grade: CreditGrade;
  count: number;
  exposure: number;
}

export interface FeedItem {
  tick: number;
  date: string;
  severity: 'info' | 'warning' | 'critical' | 'dim';
  text: string;
}

export interface DashboardSnapshot {
  tick: number;
  date: string;
  bankName: string;
  queued: number;
  /** Simulated days per real second, as actually achieved. */
  ticksPerSecond: number;

  position: {
    totalAssets: number;
    equity: number;
    profitYtd: number;
    capitalRatio: number;
    lcr: number;
    loans: number;
    deposits: number;
    bonds: number;
    reserves: number;
    bankRate: number;
    inflation: number;
    inflationTarget: number;
    unemployment: number;
    minimumCapitalRatio: number;
    minimumLiquidityRatio: number;
  };

  sheet: {
    assets: LineItem[];
    liabilities: LineItem[];
    equity: LineItem[];
    totalAssets: number;
    totalLiabilitiesAndEquity: number;
  };

  policy: BankPolicy;
  applications: PendingApplication[];
  applicationsWaiting: number;
  book: { rows: BookRow[]; loans: number; exposure: number; arrears: number };
  charts: Record<string, number[]>;
  feed: FeedItem[];
}

const CHARTED = ['bankRate', 'inflation', 'unemployment', 'capitalRatio', 'loans'];

/** Events worth showing. Everything else is noise at this cadence. */
const INTERESTING = new Set([
  'notice',
  'policy.rateChanged',
  'loan.defaulted',
  'credit.applicationApproved',
  'credit.applicationDeclined',
  'bank.breachedLimit',
  'bond.issued',
  'bond.traded',
]);

export function buildSnapshot(engine: Engine, ticksPerSecond: number): DashboardSnapshot {
  const world = engine.world;
  const bank = playerBank(world);
  const cb = centralBank(world);
  const reg = regulatoryMetrics(world, world.ledger, bank.id);
  const sheet = balanceSheet(world.ledger, bank.id);
  const pl = incomeStatement(world.ledger, bank.id);
  const balance = (code: string): number => naturalBalance(world.ledger, bank.id, code);

  const waiting = Object.values(world.applications).filter(
    (a) => a.status === 'pending' && a.lenderId === world.playerBankId,
  );

  const byGrade = new Map<CreditGrade, BookRow>();
  let exposure = 0;
  let arrears = 0;
  let loanCount = 0;
  for (const inst of heldBy(world, bank.id)) {
    if (inst.status !== 'active' || !inst.type.startsWith('loan.')) continue;
    const grade = inst.grade ?? 'BB';
    const row = byGrade.get(grade) ?? { grade, count: 0, exposure: 0 };
    row.count += 1;
    row.exposure += inst.outstanding;
    byGrade.set(grade, row);
    exposure += inst.outstanding;
    loanCount += 1;
    if (Number(inst.data.arrears ?? 0) > 0) arrears += inst.outstanding;
  }

  const charts: Record<string, number[]> = {};
  for (const key of CHARTED) charts[key] = seriesOf(world.metrics, key).filter(Number.isFinite);

  return {
    tick: world.tick,
    date: formatDay(world.tick),
    bankName: bank.name,
    queued: engine.pending,
    ticksPerSecond,

    position: {
      totalAssets: sheet.totalAssets,
      equity: sheet.totalEquity,
      profitYtd: pl.profit,
      capitalRatio: reg.capitalRatio,
      lcr: reg.lcr,
      loans: balance(AC.LOANS),
      deposits: balance(AC.CUSTOMER_DEPOSITS),
      bonds: balance(AC.BONDS),
      reserves: balance(AC.RESERVES),
      bankRate: cb.bankRate,
      inflation: world.economy.inflationAnnual,
      inflationTarget: cb.inflationTarget,
      unemployment: world.economy.unemployment,
      minimumCapitalRatio: world.config.minimumCapitalRatio,
      minimumLiquidityRatio: world.config.minimumLiquidityRatio,
    },

    sheet: {
      assets: sheet.assets.map(toLine),
      liabilities: sheet.liabilities.map(toLine),
      equity: sheet.equity.map(toLine),
      totalAssets: sheet.totalAssets,
      totalLiabilitiesAndEquity: sheet.totalLiabilities + sheet.totalEquity,
    },

    policy: structuredClone(bank.policy),
    applicationsWaiting: waiting.length,
    applications: waiting
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 8)
      .map((a) => ({
        id: a.id,
        applicant: world.entities[a.applicantId]?.name ?? a.applicantId,
        amount: a.amount,
        termMonths: a.termMonths,
        grade: a.grade,
      })),

    book: {
      rows: CREDIT_GRADES.filter((g) => byGrade.has(g)).map((g) => byGrade.get(g)!),
      loans: loanCount,
      exposure,
      arrears,
    },

    charts,
    feed: buildFeed(engine),
  };
}

function toLine(line: { code: string; name: string; amount: number }): LineItem {
  return { code: line.code, name: line.name, amount: line.amount };
}

/**
 * Event text is resolved here, on the worker, because turning an entity id
 * into a name needs the world and the page does not have one.
 */
function buildFeed(engine: Engine): FeedItem[] {
  const world = engine.world;
  const name = (id: unknown): string => world.entities[String(id)]?.name ?? String(id);
  const pct = (value: unknown): string => `${(Number(value) * 100).toFixed(2)}%`;

  return engine
    .recentActivity(150)
    .filter((event) => INTERESTING.has(event.type))
    .slice(-25)
    .reverse()
    .map((event) => {
      const payload = event.payload as Record<string, unknown>;
      const severity =
        event.type === 'notice' ? (String(payload.severity) as FeedItem['severity']) : 'dim';
      return {
        tick: event.meta.tick,
        date: formatDay(event.meta.tick),
        severity,
        text: describe(event.type, payload, name, pct),
      };
    });
}

function describe(
  type: string,
  payload: Record<string, unknown>,
  name: (id: unknown) => string,
  pct: (value: unknown) => string,
): string {
  switch (type) {
    case 'notice':
      return String(payload.message);
    case 'policy.rateChanged':
      return `Bank Rate moved to ${pct(payload.to)} — ${payload.reason}`;
    case 'loan.defaulted':
      return `${name(payload.borrowerId)} defaulted, ${money(payload.loss)} written off`;
    case 'credit.applicationApproved':
      return `Approved ${payload.applicationId} at ${pct(payload.rate)}`;
    case 'credit.applicationDeclined':
      return `Declined ${payload.applicationId}: ${payload.reason}`;
    case 'bank.breachedLimit':
      return `Limit breached: ${payload.limit} at ${pct(payload.value)}`;
    case 'bond.issued':
      return `Issued ${money(payload.amount)} at ${pct(payload.couponRate)}`;
    case 'bond.traded':
      return `Traded ${money(payload.nominal)} at ${(Number(payload.price) * 100).toFixed(2)}`;
    default:
      return type;
  }
}

function money(value: unknown): string {
  const pounds = Number(value) / 100;
  if (Math.abs(pounds) >= 1e6) return `£${(pounds / 1e6).toFixed(2)}m`;
  if (Math.abs(pounds) >= 1e3) return `£${(pounds / 1e3).toFixed(1)}k`;
  return `£${pounds.toFixed(2)}`;
}
