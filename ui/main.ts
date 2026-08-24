/**
 * The dashboard.
 *
 * Deliberately thin: it owns no game state, mutates nothing directly, and
 * talks to the engine only by reading the world and pushing commands. That is
 * the boundary that lets the simulation be tested headlessly, run at a
 * thousand days a second for balancing, and eventually be driven by a
 * different front end entirely.
 */
import { format, formatShort, pounds, type Money } from '../src/core/money.js';
import { formatDay } from '../src/core/time.js';
import { AC } from '../src/ledger/accounts.js';
import { naturalBalance } from '../src/ledger/ledger.js';
import { balanceSheet, incomeStatement } from '../src/ledger/statements.js';
import { regulatoryMetrics } from '../src/metrics/regulatory.js';
import { seriesOf } from '../src/metrics/recorder.js';
import { centralBank, heldBy, playerBank } from '../src/world/state.js';
import { CREDIT_GRADES, type CreditGrade } from '../src/world/types.js';
import type { GameCommand } from '../src/commands/index.js';
import { newGame } from '../src/index.js';

const engine = newGame('uk2025');
const world = engine.world;

/** Days of simulation per real second at each speed. */
const SPEEDS = { Pause: 0, Slow: 3, Normal: 12, Fast: 40 } as const;
type SpeedName = keyof typeof SPEEDS;
let speed: SpeedName = 'Pause';

const app = document.getElementById('app')!;
let carry = 0;
let last = performance.now();
let lastPaint = 0;

/** How often the page is repainted, regardless of how fast the clock runs. */
const PAINT_INTERVAL_MS = 200;

function frame(now: number): void {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;

  const wanted = SPEEDS[speed] * dt;
  if (wanted > 0) {
    carry += wanted;
    // Cap the work per frame so a slow tick never freezes the page.
    const budgetEndsAt = now + 12;
    while (carry >= 1 && performance.now() < budgetEndsAt) {
      engine.tick();
      carry -= 1;
    }
    if (carry > 4) carry = 4;
  }

  if (now - lastPaint >= PAINT_INTERVAL_MS) {
    lastPaint = now;
    paint();
  }
  requestAnimationFrame(frame);
}

// --- rendering -------------------------------------------------------------
//
// The shell is built once and each panel is patched only when its markup
// actually changes. Rebuilding the whole page every frame is not just wasteful:
// it detaches every button and slider mid-interaction, so nothing can reliably
// be clicked or dragged while the clock is running.

interface Panel {
  id: string;
  title: string;
  wide?: boolean;
  html(): string;
}

const panels: Panel[] = [
  { id: 'position', title: 'Position', wide: true, html: renderPosition },
  { id: 'sheet', title: 'Balance sheet', html: renderBalanceSheet },
  { id: 'committee', title: 'Credit committee', html: renderCommittee },
  { id: 'policy', title: 'Pricing &amp; policy', html: renderPolicy },
  { id: 'book', title: 'Loan book', html: renderBook },
  { id: 'economy', title: 'The economy', html: renderEconomy },
  { id: 'feed', title: 'Activity', wide: true, html: renderFeed },
];

const painted = new Map<string, string>();

function buildShell(): void {
  app.innerHTML = `
    <header>
      <h1>${playerBank(world).name}</h1>
      <span class="date num" id="date"></span>
      <span class="pill" id="queued"></span>
      <div class="speeds" id="speeds"></div>
    </header>
    <main>
      ${panels
        .map(
          (panel) => `<section class="${panel.wide ? 'wide' : ''}">
            <h2>${panel.title}</h2>
            <div class="body${panel.id === 'feed' ? ' feed' : ''}" id="panel-${panel.id}"></div>
          </section>`,
        )
        .join('')}
    </main>`;
}

function paint(): void {
  setText('date', formatDay(world.tick));
  setText('queued', `${engine.pending} queued`);
  patch('speeds', renderSpeeds());
  for (const panel of panels) patch(`panel-${panel.id}`, panel.html());
}

function setText(id: string, text: string): void {
  const node = document.getElementById(id);
  if (node && node.textContent !== text) node.textContent = text;
}

function patch(id: string, html: string): void {
  if (painted.get(id) === html) return;
  painted.set(id, html);
  const node = document.getElementById(id);
  if (node) node.innerHTML = html;
}

function renderSpeeds(): string {
  return (Object.keys(SPEEDS) as SpeedName[])
    .map((name) => `<button data-speed="${name}" aria-pressed="${speed === name}">${name}</button>`)
    .join('');
}

function renderPosition(): string {
  const bank = playerBank(world);
  const cb = centralBank(world);
  const reg = regulatoryMetrics(world, world.ledger, bank.id);
  const sheet = balanceSheet(world.ledger, bank.id);
  const pl = incomeStatement(world.ledger, bank.id);

  return `<div class="tiles">
      ${tile('Total assets', formatShort(sheet.totalAssets))}
      ${tile('Equity', formatShort(sheet.totalEquity), sheet.totalEquity <= 0 ? 'bad' : '')}
      ${tile('Profit YTD', formatShort(pl.profit), pl.profit >= 0 ? 'good' : 'bad')}
      ${tile('Capital ratio', pct(reg.capitalRatio), ratioTone(reg.capitalRatio, world.config.minimumCapitalRatio))}
      ${tile('Liquidity (LCR)', pct(reg.lcr), ratioTone(reg.lcr, world.config.minimumLiquidityRatio))}
      ${tile('Loans', formatShort(naturalBalance(world.ledger, bank.id, AC.LOANS)))}
      ${tile('Deposits', formatShort(naturalBalance(world.ledger, bank.id, AC.CUSTOMER_DEPOSITS)))}
      ${tile('Gilts', formatShort(naturalBalance(world.ledger, bank.id, AC.BONDS)))}
      ${tile('Reserves', formatShort(naturalBalance(world.ledger, bank.id, AC.RESERVES)))}
      ${tile('Bank Rate', pct(cb.bankRate))}
      ${tile('Inflation', pct(world.economy.inflationAnnual), Math.abs(world.economy.inflationAnnual - cb.inflationTarget) > 0.02 ? 'warn' : 'good')}
      ${tile('Unemployment', pct(world.economy.unemployment))}
    </div>`;
}

function renderBalanceSheet(): string {
  const sheet = balanceSheet(world.ledger, playerBank(world).id);
  const line = (l: { code: string; amount: Money }) =>
    `<tr><td>${label(l.code)}</td><td class="r num">${formatShort(l.amount)}</td></tr>`;

  return `<table>
      <thead><tr><th>Assets</th><th class="r">Amount</th></tr></thead>
      <tbody>${sheet.assets.map(line).join('') || empty()}</tbody>
      <tfoot><tr><td>Total</td><td class="r num">${formatShort(sheet.totalAssets)}</td></tr></tfoot>
    </table>
    <table style="margin-top:14px">
      <thead><tr><th>Liabilities &amp; equity</th><th class="r">Amount</th></tr></thead>
      <tbody>${sheet.liabilities.map(line).join('')}${sheet.equity.map(line).join('')}</tbody>
      <tfoot><tr><td>Total</td><td class="r num">${formatShort((sheet.totalLiabilities + sheet.totalEquity) as Money)}</td></tr></tfoot>
    </table>`;
}

function renderCommittee(): string {
  const bank = playerBank(world);
  return `<div class="row">
      <label><input type="checkbox" data-policy="autoUnderwrite" ${bank.policy.autoUnderwrite ? 'checked' : ''}> Underwrite automatically</label>
      <span class="pill">${pendingApplications().length} on the desk</span>
    </div>
    ${renderApplications()}`;
}

function renderPolicy(): string {
  const policy = playerBank(world).policy;
  return `${slider('depositRate', 'Instant access rate', policy.depositRate, 0, 0.08)}
    ${slider('termDepositRate', 'Term deposit rate', policy.termDepositRate, 0, 0.1)}
    ${slider('spreadBB', 'Lending spread (BB)', policy.lendingSpread.BB, 0, 0.12)}
    ${slider('dsr', 'Max debt service ratio', policy.maxDebtServiceRatio, 0.1, 1)}
    <div class="control">
      <label for="minGrade">Lowest grade we will lend to</label>
      <select id="minGrade" data-policy="minimumGrade">
        ${CREDIT_GRADES.map((g) => `<option value="${g}" ${g === policy.minimumGrade ? 'selected' : ''}>${g}</option>`).join('')}
      </select>
    </div>`;
}

function renderEconomy(): string {
  return [
    chart('Bank Rate', 'bankRate', pct),
    chart('Inflation', 'inflation', pct),
    chart('Unemployment', 'unemployment', pct),
    chart('Capital ratio', 'capitalRatio', pct),
    chart('Loan book', 'loans', (v) => formatShort(v as Money)),
  ].join('') || '<div class="empty">Charts appear at the first month end.</div>';
}

function tile(key: string, value: string, tone = ''): string {
  return `<div class="tile"><div class="k">${key}</div><div class="v num ${tone}">${value}</div></div>`;
}

function ratioTone(value: number, minimum: number): string {
  if (value < minimum) return 'bad';
  if (value < minimum * 1.25) return 'warn';
  return 'good';
}

function pct(value: number): string {
  return `${(value * 100).toFixed(value > 5 ? 0 : 2)}%`;
}

function empty(): string {
  return `<tr><td colspan="2" class="empty">Nothing here yet</td></tr>`;
}

const LABELS: Record<string, string> = {
  [AC.RESERVES]: 'Reserves at the Bank',
  [AC.LOANS]: 'Loans and advances',
  [AC.BONDS]: 'Debt securities',
  [AC.INTEREST_RECEIVABLE]: 'Interest receivable',
  [AC.CUSTOMER_DEPOSITS]: 'Customer deposits',
  [AC.CENTRAL_BANK_FUNDING]: 'Central bank funding',
  [AC.DEBT_ISSUED]: 'Debt issued',
  [AC.INTEREST_PAYABLE]: 'Interest payable',
  [AC.SHARE_CAPITAL]: 'Share capital',
  [AC.RETAINED_EARNINGS]: 'Retained earnings',
  profitForPeriod: 'Profit for period',
};

function label(code: string): string {
  return LABELS[code] ?? code;
}

function pendingApplications() {
  return Object.values(world.applications)
    .filter((a) => a.status === 'pending' && a.lenderId === world.playerBankId)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8);
}

function renderApplications(): string {
  const applications = pendingApplications();
  if (applications.length === 0) return `<div class="empty">No applications waiting.</div>`;
  return `<table><thead><tr>
      <th>Applicant</th><th class="r">Amount</th><th class="r">Term</th><th class="r">Grade</th><th></th>
    </tr></thead><tbody>${applications
      .map((a) => {
        const applicant = world.entities[a.applicantId];
        return `<tr>
          <td>${applicant?.name ?? a.applicantId}</td>
          <td class="r num">${formatShort(a.amount)}</td>
          <td class="r num">${a.termMonths}m</td>
          <td class="r num">${a.grade}</td>
          <td class="r">
            <button class="approve" data-approve="${a.id}">Approve</button>
            <button class="decline" data-decline="${a.id}">Decline</button>
          </td>
        </tr>`;
      })
      .join('')}</tbody></table>`;
}

function renderBook(): string {
  const loans = heldBy(world, world.playerBankId).filter(
    (inst) => inst.status === 'active' && inst.type.startsWith('loan.'),
  );
  if (loans.length === 0) return `<div class="empty">No loans on the book.</div>`;

  const byGrade = new Map<CreditGrade, { count: number; exposure: number }>();
  let arrears = 0;
  let total = 0;
  for (const loan of loans) {
    const grade = loan.grade ?? 'BB';
    const row = byGrade.get(grade) ?? { count: 0, exposure: 0 };
    row.count += 1;
    row.exposure += loan.outstanding;
    byGrade.set(grade, row);
    total += loan.outstanding;
    if (Number(loan.data.arrears ?? 0) > 0) arrears += loan.outstanding;
  }

  const rows = CREDIT_GRADES.filter((g) => byGrade.has(g))
    .map((g) => {
      const row = byGrade.get(g)!;
      return `<tr><td>${g}</td><td class="r num">${row.count}</td>
        <td class="r num">${formatShort(row.exposure as Money)}</td>
        <td class="r num">${((row.exposure / total) * 100).toFixed(0)}%</td></tr>`;
    })
    .join('');

  return `<table>
      <thead><tr><th>Grade</th><th class="r">Loans</th><th class="r">Exposure</th><th class="r">Share</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>Total</td><td class="r num">${loans.length}</td>
        <td class="r num">${formatShort(total as Money)}</td>
        <td class="r num">${arrears > 0 ? `${((arrears / total) * 100).toFixed(1)}% in arrears` : 'clean'}</td></tr></tfoot>
    </table>`;
}

function chart(title: string, key: string, fmt: (value: number) => string): string {
  const series = seriesOf(world.metrics, key).filter(Number.isFinite);
  if (series.length < 2) return '';
  const latest = series[series.length - 1]!;
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const span = hi - lo || 1;
  const points = series
    .map((v, i) => `${(i / (series.length - 1)) * 100},${46 - ((v - lo) / span) * 42 - 2}`)
    .join(' ');

  return `<div class="chartRow">
      <div class="lbl"><span>${title}</span><span class="num">${fmt(latest)}</span></div>
      <svg class="chart" viewBox="0 0 100 46" preserveAspectRatio="none">
        <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.2" vector-effect="non-scaling-stroke" />
      </svg>
    </div>`;
}

// `company.failed` is deliberately absent: a failure already arrives as a
// notice, and showing both puts every insolvency in the feed twice.
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

function renderFeed(): string {
  const events = engine
    .recentActivity(120)
    .filter((event) => INTERESTING.has(event.type))
    .slice(-25)
    .reverse();
  if (events.length === 0) return `<div class="empty">Nothing has happened yet. Press Normal to start the clock.</div>`;

  return events
    .map((event) => {
      const payload = event.payload as Record<string, unknown>;
      const severity = event.type === 'notice' ? String(payload.severity) : 'dim';
      const text = event.type === 'notice' ? String(payload.message) : describe(event.type, payload);
      return `<div class="${severity}"><span class="num">${formatDay(event.meta.tick)}</span> — ${text}</div>`;
    })
    .join('');
}

function describe(type: string, payload: Record<string, unknown>): string {
  const name = (id: unknown): string => world.entities[String(id)]?.name ?? String(id);
  switch (type) {
    case 'policy.rateChanged':
      return `Bank Rate moved to ${pct(Number(payload.to))} — ${payload.reason}`;
    case 'loan.defaulted':
      return `${name(payload.borrowerId)} defaulted, ${formatShort(payload.loss as Money)} written off`;
    case 'credit.applicationApproved':
      return `Approved ${payload.applicationId} at ${pct(Number(payload.rate))}`;
    case 'credit.applicationDeclined':
      return `Declined ${payload.applicationId}: ${payload.reason}`;
    case 'bank.breachedLimit':
      return `Limit breached: ${payload.limit} at ${pct(Number(payload.value))}`;
    case 'bond.issued':
      return `Issued ${formatShort(payload.amount as Money)} at ${pct(Number(payload.couponRate))}`;
    case 'bond.traded':
      return `Traded ${formatShort(payload.nominal as Money)} at ${(Number(payload.price) * 100).toFixed(2)}`;
    default:
      return type;
  }
}

function slider(id: string, title: string, value: number, min: number, max: number): string {
  return `<div class="control">
      <label for="${id}">${title}</label>
      <output class="num" for="${id}">${pct(value)}</output>
      <input type="range" id="${id}" min="${min}" max="${max}" step="0.0005" value="${value}" />
    </div>`;
}

// --- input -----------------------------------------------------------------
//
// One set of delegated listeners on the root, so controls keep working no
// matter which panels were repainted since the user reached for them.

const RANGE_COMMANDS: Record<string, (value: number) => GameCommand> = {
  depositRate: (rate) => ({ type: 'bank.setDepositRate', rate }),
  termDepositRate: (rate) => ({ type: 'bank.setDepositRate', rate, product: 'term' }),
  spreadBB: (spread) => ({ type: 'bank.setLendingSpread', grade: 'BB', spread }),
  dsr: (maxDebtServiceRatio) => ({ type: 'bank.setCreditPolicy', maxDebtServiceRatio }),
};

app.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-speed],[data-approve],[data-decline]');
  if (!target) return;

  if (target.dataset.speed) {
    speed = target.dataset.speed as SpeedName;
    carry = 0;
    paint();
    return;
  }
  if (target.dataset.approve) {
    report(engine.enqueue({ type: 'credit.approve', applicationId: target.dataset.approve }));
  } else if (target.dataset.decline) {
    report(
      engine.enqueue({
        type: 'credit.decline',
        applicationId: target.dataset.decline,
        reason: 'Declined by the credit committee',
      }),
    );
  }
  paint();
});

app.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement | HTMLSelectElement;

  const range = RANGE_COMMANDS[target.id];
  if (range) {
    report(engine.enqueue(range(Number(target.value))));
    return;
  }
  if (target.dataset.policy === 'autoUnderwrite') {
    report(engine.enqueue({ type: 'bank.setCreditPolicy', autoUnderwrite: (target as HTMLInputElement).checked }));
    return;
  }
  if (target.dataset.policy === 'minimumGrade') {
    report(engine.enqueue({ type: 'bank.setCreditPolicy', minimumGrade: target.value as CreditGrade }));
  }
});

// Live feedback on the slider readout while dragging, without committing.
app.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement;
  if (!RANGE_COMMANDS[target.id]) return;
  const readout = target.parentElement?.querySelector('output');
  if (readout) readout.textContent = pct(Number(target.value));
});

function report(result: { ok: boolean; error?: unknown }): void {
  if (!result.ok) console.warn('Command rejected:', result.error);
}

buildShell();
paint();
requestAnimationFrame(frame);

// Handy when poking at a game from the browser console.
Object.assign(window as unknown as Record<string, unknown>, { engine, world, pounds });
