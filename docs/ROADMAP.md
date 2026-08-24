# Roadmap

What was deliberately left out of the starting framework, and where each piece
slots in. Nothing here should require reworking what already exists — that was
the point of the structure.

## Balancing first

Before new features, the economy needs tuning. Everything that drives it is in
`DEFAULT_CONFIG` (`src/world/state.ts`) and `src/scenarios/uk2025.ts`.

- Damp the business cycle: the amplitude is larger than it should be, driven by
  the interaction of the price adjustment rule, the hiring rule and the lagged
  year-on-year inflation measure the MPC reacts to.
- Bring impairments down to low single digits of the book per year.
- Remove the first-year deflationary drift.

`npm run sim -- 1095` and the probe pattern in the tests are the tools for this.

## Near term

**Enforce regulation.** The ratios are already computed every month and a
breach already raises `bank.breachedLimit`. Give it consequences: a supervisory
letter, a dividend block, forced deleveraging, and ultimately resolution with
the FSCS paying out covered depositors. One new system, no model changes.

**Retail lending.** Mortgages and consumer credit as instrument types, plus
household credit demand in `credit.demand`. Households already have credit
grades, PDs and deposit relationships; only the products are missing.

**Rival banks that actually compete.** `bank:market` currently holds an
aggregate book and does nothing. Give it the same `BankPolicy` and drive it
with a simple strategy, and deposit rates start to matter — the reserve
settlement that makes customer switching expensive is already in place.

**A real bond market.** Prices come off the curve today and trades go through
the aggregate rival at that price. Add a book of quotes, a bid-offer spread and
size limits, and mark-to-market through the P&L.

**Fiscal policy.** The state currently taxes and spends the same amount each
year. Give it a spending programme, deficits, and gilt issuance to fund them —
which makes your gilt portfolio a position on government finances rather than a
parking space.

## Medium term

**Player-facing depth**: a customer relationship view, sector concentration
limits, an arrears and forbearance workflow, a treasury desk for managing the
maturity ladder, and a proper objectives-and-scoring layer.

**Simulation depth**: a labour market with search and matching rather than a
proportional constraint; firm entry as well as exit; regional differentiation
with real effects; supply chains between sectors.

**Shocks and scenarios**: a scripted event layer — a pandemic, an energy price
spike, a mini-budget — expressed as scenario data plus a system that applies
them on schedule.

## Longer term

These are the ones the boundaries were built for.

- **Rival banks run by AI.** They already act through the same `Command` layer
  the player uses, so an automated bank is a strategy function, not new plumbing.
- **Multiplayer.** Commands are serialisable data applied at a defined point in
  a deterministic tick. The pieces for lockstep or server-authoritative play
  are already there.
- **Replays and undo.** Seed plus command log reproduces any game exactly.
- **A different front end.** The engine has no DOM dependency; the dashboard is
  the only thing that would be replaced.

## Things to be careful about

- **Never assign a balance directly.** Everything goes through `post()`.
- **Never use `Math.random()`** in `src/`. Use `ctx.rng(stream)`.
- **Keep the world plain data.** No functions, `Map`s or class instances, or
  saving stops being one line.
- **Keep the engine DOM-free.**
- **Add a migration** whenever the world shape changes, and bump
  `WORLD_VERSION`.
