# Bank Economics

A simulation game in which you run a UK bank inside a working economy of
companies and households.

You set deposit rates and lending spreads, decide who gets credit, manage
liquidity against the Bank of England, and trade and issue bonds. The economy
around you produces, hires, spends, borrows and occasionally goes bust — and it
responds to what you do, because your lending creates the deposits it spends.

This repository is the **starting framework**, not a finished game. It is built
so that features can be added without redesigning what is already here.

## Quick start

```bash
npm install
npm test                       # unit tests, invariants and macro guard rails
npm run sim -- 730             # two years headless, printed
npm run ui                     # dashboard at localhost:5173/ui/index.html
node scripts/calibrate.js score  # how balanced is the economy right now?
```

## What is already modelled

| Area | What works today |
| --- | --- |
| **Accounting** | Full double-entry ledger. Every entity — your bank, each firm, each household pool, the state, the Bank of England — has real books that balance. |
| **Your bank** | Loans (amortising and bullet), instant-access and term deposits, gilts and corporate bonds, central bank funding, a credit policy you set. |
| **Companies** | Production, hiring and firing, pricing, stock, investment, borrowing, distress and insolvency with asset recoveries. |
| **Households** | Wages, consumption out of smoothed income and savings, deposits, mortgages held elsewhere. |
| **Markets** | A goods market that clears on price, a gilt curve, credit spreads, an interbank rate. |
| **Labour** | A supply constraint on hiring, and pay that follows prices and labour-market tightness with downward nominal rigidity. |
| **Policy** | A Monetary Policy Committee setting Bank Rate off inflation and the output gap; a state that taxes and spends. |
| **Regulation** | CET1, risk-weighted assets, capital and leverage ratios, LCR, FSCS-covered deposits — computed and reported, not yet enforced. |

## The six decisions that make it extensible

Domain features rarely force a rewrite. Plumbing does. These are the choices
that everything else hangs off.

**1. Double-entry is the only way money moves.**
No balance is ever just assigned. Every movement is a transaction whose postings
sum to zero, and the engine checks the whole ledger balances after every single
tick (`Engine.checkInvariants`). Balance sheets, P&L, capital ratios and
regulatory metrics are all *derived* — nothing is tracked twice. During
development this caught four separate bugs that would otherwise have shown up
months later as "the numbers look a bit off".

**2. Money is integers.** Pence, in a branded `Money` type, so a raw number
cannot be used as money and money cannot be added with `+`. `allocate()` splits
an amount across weights without losing or inventing a penny.

**3. The simulation is deterministic.** One tick is one day. Nothing calls
`Math.random()`; generators are derived from `(seed, stream name, tick)`, so
adding a system that consumes randomness cannot shift the numbers any existing
system sees. Same seed plus same commands always gives the same world — which is
what makes saves, replays and balancing possible.

**4. The engine is headless.** `src/` has no DOM reference. The dashboard runs
it on a worker thread that owns the world, and draws the snapshots it posts
back. You can run a thousand days in a test, or swap the front end entirely,
without touching the simulation.

**5. Player actions are data.** Everything you can do is a validated `Command`
object applied at a defined point in the tick. That one boundary is what later
gives replays, undo, tutorials, AI-run rival banks and multiplayer without
reworking anything.

**6. Systems never call each other.** They read the world, write the world, and
emit events. A new feature subscribes instead of editing the system that
produced the thing it cares about.

## Level of detail: the economy is only as detailed as it needs to be

Most of the economy is *latent*. Thousands of firms and hundreds of thousands of
households live inside **cohorts**: a count, a set of distribution parameters,
and one aggregate balance sheet.

The moment something deals with you — applies for a loan, opens an account — it
is **materialised** into a full entity with its own books, its own credit grade
and its own individual behaviour. When the relationship ends and it has been
idle long enough, it folds back into the pool.

The thing that makes this safe is that **cohorts hold real balance sheets in the
ledger**. Promotion is a ledger transaction that carves a share of the pool's
balances out and hands them to the new entity, down to the penny. Nothing is
conjured at the detail boundary and nothing is destroyed at it — which is
exactly where this pattern usually goes wrong.

```
  cohort: 8,994 micro retailers          resolved: Norbury Retail & Co
  ┌───────────────────────────┐          ┌──────────────────────────┐
  │ deposits      £404.7m     │ promote  │ deposits       £19.3k    │
  │ fixed assets  £1,079.3m   │ ───────► │ fixed assets   £51.6k    │
  │ borrowings    £314.8m     │ ◄─────── │ borrowings     £15.0k    │
  └───────────────────────────┘   fold   └──────────────────────────┘
         every penny accounted for in both directions
```

Every economic system works through `FirmView` / `HouseholdView`, so production,
pricing and hiring have exactly one implementation, not one per detail level.

## Layout

```
src/
  core/         money, deterministic RNG, the calendar, events, registries
  ledger/       accounts, double-entry postings, statements, payment routing
  world/        world state, entity types, the event vocabulary, transfers
  instruments/  loans, deposits, bonds — one handler per product
  agents/       level-of-detail views, promotion and folding, credit scoring, insolvency
  systems/      the tick pipeline: policy, markets, production, credit, risk, treasury
  commands/     everything the player can do
  engine/       the tick loop, save and load
  metrics/      time series and the prudential ratios
  scenarios/    the starting world, as data
ui/             a thin dashboard, no framework
tests/          unit tests and the invariants that must never break
```

## Adding things

**A new product** (mortgage, overdraft, swap): write a handler implementing
`InstrumentType` and register it. The lifecycle system drives it; the capital
and liquidity calculations pick it up from `riskWeight` / `hqlaFactor` /
`outflowFactor`. No existing file changes.

```ts
instrumentTypes.register('loan.mortgage', {
  key: 'loan.mortgage', category: 'loan', label: 'Residential mortgage',
  accrue, onPayment, onDefault,
  riskWeight: () => 0.35,
});
```

**A new behaviour**: `defineSystem({ id, phase, run })`. Phases are spaced by
50–100 so you can slot something between two existing ones without renumbering.

**A new player action**: `defineCommand({ type, label, validate, apply })` and
add it to the `GameCommand` union.

**A new event**: add it to `GameEvents`, or declare it from your own module —
the interface is open to declaration merging.

**A new scenario**: a `ScenarioSpec` object. Sectors, regions, cohorts, opening
balance sheets and the bank's starting policy are all data.

## Where it stands

Two simulated years run in roughly 15–20 seconds — about 36 ticks a second with
1,500 resolved entities — and the ledger balances on every one of the 730
ticks. The economy produces a recognisable business cycle:
demand softens, prices and employment fall, the MPC cuts, activity recovers,
inflation returns and rates rise. The bank makes losses through the downturn
and profits through the recovery.

### Balancing it

Economic balance is measurable rather than a matter of opinion:
`scripts/calibrate.js` scores a run against targets, sweeps parameters to find
which ones actually move the score, and searches over the handful that do. See
`docs/CALIBRATION.md`. Every tuning knob lives in `SimConfig`; if you need a
magic number inside a system, put it there instead, or the sweep cannot see it.

Known rough edges:

- **Too many firms fail** — 3.76% a year among the firms simulated individually,
  against a 0.7% target. Now the largest item on the scorecard.
- **Inflation is volatile** (~7.6% standard deviation). Part of this is
  structural: the MPC reacts to year-on-year inflation, which lags the cycle
  badly, so no parameter setting removes it.
- **The bank is too profitable** — 43% return on equity against a 10% target,
  which is what happens when credit losses are near zero.
- **No firm or household demography.** Firms fail but none are ever created, so
  the population falls about 0.7% a year with nothing offsetting it. Household
  numbers never change at all. Latent firms inside cohorts cannot fail, which
  is why the insolvency rate is measured against the at-risk population rather
  than the whole economy.
- **All firms behave identically.** They differ in size, sector and outcome, but
  every one of them runs the same decision rules with the same parameters.
- **Throughput** is ~104 ticks/second with 650 resolved firms, so a simulated
  year takes about 3.5 seconds. Fine for play; a full calibration sweep is
  still tens of minutes.
- **Regulation is reported, not enforced.** Breaching capital raises an event
  and nothing else happens yet.
- **The rest of the market is scenery.** Rival banks hold aggregate books and
  do not compete on price.

See `docs/ROADMAP.md` for what was deliberately left out and where it slots in.
