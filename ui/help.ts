/**
 * Explanatory copy for the dashboard.
 *
 * Kept together rather than scattered through the render functions so the
 * wording can be read and revised as a whole. Each one says what the thing is
 * and, where it matters, what the trade-off is -- a player who does not
 * already know what a capital ratio is gains nothing from being told that it
 * is the ratio of capital to risk-weighted assets.
 */
export const HELP: Record<string, string> = {
  // --- panels --------------------------------------------------------------
  position:
    'Your bank at a glance, with the state of the wider economy alongside it. Anything shown in amber or red wants attention.',
  sheet:
    'What the bank owns and what it owes. The two totals always match exactly — every movement is double-entry, so they cannot drift apart.',
  committee:
    'Businesses asking to borrow. Each one has been graded and priced; you decide whether to take it on.',
  policy: 'The levers you actually pull. Everything else on this page is a consequence of these.',
  book: 'Your lending, grouped by the credit grade it was written at. Riskier grades pay more and fail more often.',
  economy:
    'One reading a month since the game began. The shape matters more than the latest number — these are cycles, not trends.',
  activity: 'Notable events as they happen: rate decisions, approvals, failures and any limit you have breached.',
  speed:
    'How fast the clock runs. The simulation has its own thread, so the page stays responsive even at Max.',

  // --- position tiles ------------------------------------------------------
  totalAssets: 'Everything the bank owns: loans outstanding, gilts held, and money at the Bank of England.',
  equity:
    "Shareholders' money — assets minus liabilities. It absorbs losses, and it is what stands between a bad year and failure.",
  profitYtd: 'Profit since 1 January. It resets at each year end, after tax is paid.',
  capitalRatio:
    'Equity measured against your assets, weighted for how risky each one is. Regulators want at least 8%. Writing more loans pushes it down, so it sets a ceiling on how fast you can grow.',
  lcr: 'Liquid assets against the deposits that could plausibly leave in a month of stress. Below 100% means a run could catch you short even though you are perfectly solvent.',
  loans: 'Money lent to businesses and not yet repaid. Your best-earning asset, and the only one that can default.',
  deposits:
    'Money customers have placed with you. It is a liability — you owe it back on demand — and it is the cheapest funding you will find.',
  gilts:
    'UK government bonds. They count fully towards your liquidity and carry no capital charge, but they yield less than lending does.',
  reserves:
    'Money held at the Bank of England. It earns Bank Rate, settles payments to other banks, and is the safest thing you can hold. Too much of it means you are not lending.',
  bankRate:
    "The Bank of England's policy rate, set monthly against inflation and the state of the economy. It decides what your reserves earn and anchors what you can charge borrowers.",
  inflation:
    'How fast prices are rising year on year. The Bank targets 2%; a long way either side and it will move rates.',
  unemployment:
    'The share of the workforce without a job. It drives what people can spend, and so what your borrowers can sell.',

  // --- controls ------------------------------------------------------------
  autoUnderwrite:
    'Let your stated credit policy decide applications on its own. Switch it off to review each case yourself — while the clock is paused, your decisions queue up and take effect when it starts again.',
  depositRate:
    'What you pay on everyday accounts. Raising it wins deposits and stops existing ones leaving for a rival, but it costs you on the entire deposit book, not just the new money.',
  termDepositRate:
    'What you pay on money locked away for a fixed term. Dearer than instant access, but it cannot walk out during a stress, so it does not count against your liquidity.',
  lendingSpread:
    'Your margin over Bank Rate when lending to BB-grade borrowers, the bulk of the book. Widen it to earn more per loan and win fewer of them.',
  debtService:
    "The most of a borrower's monthly earnings you will let loan repayments take up. The single most important brake on lending: loosen it and you will write more loans and lose more of them.",
  minimumGrade:
    'Applications graded below this are declined outright. Lower grades pay a wider spread and default more often — the question is whether the spread covers the losses.',
};

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character]!);
}

/** A small question mark that explains itself on hover or keyboard focus. */
export function help(key: string): string {
  const text = HELP[key];
  if (!text) return '';
  const escaped = escapeAttribute(text);
  return `<button type="button" class="help" data-align="centre" data-help="${escaped}" aria-label="${escaped}">?</button>`;
}

/** Roughly how wide a bubble gets, for deciding which way to anchor it. */
const BUBBLE_WIDTH = 270;
const MARGIN = 10;

/**
 * Point each bubble away from whichever window edge it is near.
 *
 * The panels sit in a responsive grid, so an icon that is comfortably
 * mid-screen at one width is against the edge at another. Measuring after
 * paint is the only way to know, and a bubble that runs off the side would
 * either be unreadable or push the whole page sideways.
 */
export function anchorHelpBubbles(root: HTMLElement): void {
  const limit = window.innerWidth;
  for (const icon of root.querySelectorAll<HTMLElement>('.help')) {
    const centre = icon.getBoundingClientRect().left + icon.offsetWidth / 2;
    const align =
      centre + BUBBLE_WIDTH / 2 > limit - MARGIN
        ? 'end'
        : centre - BUBBLE_WIDTH / 2 < MARGIN
          ? 'start'
          : 'centre';
    if (icon.dataset.align !== align) icon.dataset.align = align;
  }
}
