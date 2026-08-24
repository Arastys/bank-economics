/**
 * The dashboard.
 *
 * It owns no game state and never touches the world. The simulation runs on a
 * worker thread and posts compact snapshots; this file draws them and posts
 * commands back. That boundary is why the clock can run flat out without the
 * page seizing up, and why the same engine can be driven headlessly by tests
 * and by the calibration harness.
 */
import { formatShort, type Money } from '../src/core/money.js';
import { AC } from '../src/ledger/accounts.js';
import { CREDIT_GRADES, type CreditGrade } from '../src/world/types.js';
import type { GameCommand } from '../src/commands/index.js';
import type { DashboardSnapshot, LineItem } from './snapshot.js';
import type { FromWorker, ToWorker } from './protocol.js';

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

/** Simulated days per real second at each setting. */
const SPEEDS = { Pause: 0, Slow: 3, Normal: 12, Fast: 40, Max: 400 } as const;
type SpeedName = keyof typeof SPEEDS;
let speed: SpeedName = 'Pause';

const app = document.getElementById('app')!;
let latest: DashboardSnapshot | undefined;

/**
 * Applications the player has decided but the simulation has not yet acted on.
 *
 * Commands are applied at the start of a tick, so while the clock is paused a
 * decision sits in the queue and the row would otherwise look untouched --
 * leaving the player to click Approve repeatedly and wonder why nothing
 * happens. They are marked here until they leave the desk.
 */
const decided = new Set<string>();

worker.onmessage = (event: MessageEvent<FromWorker>): void => {
  const message = event.data;
  if (message.type === 'snapshot') {
    const first = latest === undefined;
    latest = message.snapshot;
    // Forget anything that has actually left the desk.
    const waiting = new Set(latest.applications.map((a) => a.id));
    for (const id of decided) if (!waiting.has(id)) decided.delete(id);
    if (first) buildShell();
    paint();
    return;
  }
  console.warn('Command rejected:', message.reason);
};

function send(message: ToWorker): void {
  worker.postMessage(message);
}

function command(gameCommand: GameCommand): void {
  send({ type: 'command', command: gameCommand });
}

// --- rendering -------------------------------------------------------------
//
// The shell is built once and each panel patched only when its markup actually
// changes. Rebuilding the whole page on every snapshot would detach every
// button and slider mid-interaction.

interface Panel {
  id: string;
  title: string;
  wide?: boolean;
  html(snapshot: DashboardSnapshot): string;
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
      <h1>${latest!.bankName}</h1>
      <span class="date num" id="date"></span>
      <span class="pill" id="rate"></span>
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
  const snapshot = latest;
  if (!snapshot) return;
  setText('date', snapshot.date);
  setText('rate', speed === 'Pause' ? 'paused' : `${snapshot.ticksPerSecond} days/sec`);
  setText('queued', `${snapshot.queued} queued`);
  patch('speeds', renderSpeeds());
  for (const panel of panels) patch(`panel-${panel.id}`, panel.html(snapshot));
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

function renderPosition({ position: p }: DashboardSnapshot): string {
  return `<div class="tiles">
      ${tile('Total assets', formatShort(p.totalAssets as Money))}
      ${tile('Equity', formatShort(p.equity as Money), p.equity <= 0 ? 'bad' : '')}
      ${tile('Profit YTD', formatShort(p.profitYtd as Money), p.profitYtd >= 0 ? 'good' : 'bad')}
      ${tile('Capital ratio', pct(p.capitalRatio), tone(p.capitalRatio, p.minimumCapitalRatio))}
      ${tile('Liquidity (LCR)', pct(p.lcr), tone(p.lcr, p.minimumLiquidityRatio))}
      ${tile('Loans', formatShort(p.loans as Money))}
      ${tile('Deposits', formatShort(p.deposits as Money))}
      ${tile('Gilts', formatShort(p.bonds as Money))}
      ${tile('Reserves', formatShort(p.reserves as Money))}
      ${tile('Bank Rate', pct(p.bankRate))}
      ${tile('Inflation', pct(p.inflation), Math.abs(p.inflation - p.inflationTarget) > 0.02 ? 'warn' : 'good')}
      ${tile('Unemployment', pct(p.unemployment))}
    </div>`;
}

function renderBalanceSheet({ sheet }: DashboardSnapshot): string {
  const line = (l: LineItem) =>
    `<tr><td>${label(l.code)}</td><td class="r num">${formatShort(l.amount as Money)}</td></tr>`;
  return `<table>
      <thead><tr><th>Assets</th><th class="r">Amount</th></tr></thead>
      <tbody>${sheet.assets.map(line).join('') || empty()}</tbody>
      <tfoot><tr><td>Total</td><td class="r num">${formatShort(sheet.totalAssets as Money)}</td></tr></tfoot>
    </table>
    <table style="margin-top:14px">
      <thead><tr><th>Liabilities &amp; equity</th><th class="r">Amount</th></tr></thead>
      <tbody>${sheet.liabilities.map(line).join('')}${sheet.equity.map(line).join('')}</tbody>
      <tfoot><tr><td>Total</td><td class="r num">${formatShort(sheet.totalLiabilitiesAndEquity as Money)}</td></tr></tfoot>
    </table>`;
}

function renderCommittee(snapshot: DashboardSnapshot): string {
  return `<div class="row">
      <label><input type="checkbox" data-policy="autoUnderwrite" ${snapshot.policy.autoUnderwrite ? 'checked' : ''}> Underwrite automatically</label>
      <span class="pill">${snapshot.applicationsWaiting} on the desk</span>
    </div>
    ${
      snapshot.applications.length === 0
        ? `<div class="empty">No applications waiting.</div>`
        : `<div class="scroller"><table><thead><tr>
             <th>Applicant</th><th class="r">Amount</th><th class="r">Grade</th><th></th>
           </tr></thead><tbody>${snapshot.applications
             .map(
               (a) => `<tr>
                 <td>${a.applicant}<span class="sub">${a.termMonths} months</span></td>
                 <td class="r num">${formatShort(a.amount as Money)}</td>
                 <td class="r num">${a.grade}</td>
                 <td class="r actions">${
                   decided.has(a.id)
                     ? `<span class="pill">decided — resumes with the clock</span>`
                     : `<button class="approve" data-approve="${a.id}">Approve</button>
                        <button class="decline" data-decline="${a.id}">Decline</button>`
                 }</td>
               </tr>`,
             )
             .join('')}</tbody></table></div>`
    }`;
}

function renderPolicy({ policy }: DashboardSnapshot): string {
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

function renderBook({ book }: DashboardSnapshot): string {
  if (book.loans === 0) return `<div class="empty">No loans on the book.</div>`;
  const rows = book.rows
    .map(
      (row) => `<tr><td>${row.grade}</td><td class="r num">${row.count}</td>
        <td class="r num">${formatShort(row.exposure as Money)}</td>
        <td class="r num">${((row.exposure / book.exposure) * 100).toFixed(0)}%</td></tr>`,
    )
    .join('');
  return `<table>
      <thead><tr><th>Grade</th><th class="r">Loans</th><th class="r">Exposure</th><th class="r">Share</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td>Total</td><td class="r num">${book.loans}</td>
        <td class="r num">${formatShort(book.exposure as Money)}</td>
        <td class="r num">${book.arrears > 0 ? `${((book.arrears / book.exposure) * 100).toFixed(1)}% in arrears` : 'clean'}</td></tr></tfoot>
    </table>`;
}

function renderEconomy({ charts }: DashboardSnapshot): string {
  const drawn = [
    chart('Bank Rate', charts.bankRate, pct),
    chart('Inflation', charts.inflation, pct),
    chart('Unemployment', charts.unemployment, pct),
    chart('Capital ratio', charts.capitalRatio, pct),
    chart('Loan book', charts.loans, (v) => formatShort(v as Money)),
  ].join('');
  return drawn || '<div class="empty">Charts appear at the first month end.</div>';
}

function renderFeed({ feed }: DashboardSnapshot): string {
  if (feed.length === 0) {
    return `<div class="empty">Nothing has happened yet. Press Normal to start the clock.</div>`;
  }
  return feed
    .map((item) => `<div class="${item.severity}"><span class="num">${item.date}</span> — ${item.text}</div>`)
    .join('');
}

// --- small helpers ---------------------------------------------------------

function tile(key: string, value: string, toneClass = ''): string {
  return `<div class="tile"><div class="k">${key}</div><div class="v num ${toneClass}">${value}</div></div>`;
}

function tone(value: number, minimum: number): string {
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

function chart(title: string, series: number[] | undefined, format: (value: number) => string): string {
  if (!series || series.length < 2) return '';
  const latestValue = series[series.length - 1]!;
  const lo = Math.min(...series);
  const hi = Math.max(...series);
  const span = hi - lo || 1;
  const points = series
    .map((v, i) => `${(i / (series.length - 1)) * 100},${46 - ((v - lo) / span) * 42 - 2}`)
    .join(' ');

  return `<div class="chartRow">
      <div class="lbl"><span>${title}</span><span class="num">${format(latestValue)}</span></div>
      <svg class="chart" viewBox="0 0 100 46" preserveAspectRatio="none">
        <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.2" vector-effect="non-scaling-stroke" />
      </svg>
    </div>`;
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
// Delegated from the root, so controls keep working no matter which panels
// were repainted since the user reached for them.

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
    send({ type: 'setSpeed', daysPerSecond: SPEEDS[speed] });
    paint();
    return;
  }
  if (target.dataset.approve) {
    decided.add(target.dataset.approve);
    command({ type: 'credit.approve', applicationId: target.dataset.approve });
  } else if (target.dataset.decline) {
    decided.add(target.dataset.decline);
    command({
      type: 'credit.decline',
      applicationId: target.dataset.decline,
      reason: 'Declined by the credit committee',
    });
  }
  paint();
});

app.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement | HTMLSelectElement;

  const range = RANGE_COMMANDS[target.id];
  if (range) {
    command(range(Number(target.value)));
    return;
  }
  if (target.dataset.policy === 'autoUnderwrite') {
    command({ type: 'bank.setCreditPolicy', autoUnderwrite: (target as HTMLInputElement).checked });
    return;
  }
  if (target.dataset.policy === 'minimumGrade') {
    command({ type: 'bank.setCreditPolicy', minimumGrade: target.value as CreditGrade });
  }
});

// Live feedback on the slider readout while dragging, without committing.
app.addEventListener('input', (event) => {
  const target = event.target as HTMLInputElement;
  if (!RANGE_COMMANDS[target.id]) return;
  const readout = target.parentElement?.querySelector('output');
  if (readout) readout.textContent = pct(Number(target.value));
});
