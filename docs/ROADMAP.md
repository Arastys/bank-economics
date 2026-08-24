# Roadmap

What was deliberately left out of the starting framework, and where each piece
slots in. Nothing here should require reworking what already exists — that was
the point of the structure.

## What is actually in the way

The baseline scores 25.6 over 24 seeds at ten years. Two things are most of it:

- **Inflation level, 8.4.** 4.04% against 2%. Monetary policy cannot help:
  restraining demand here moves output rather than prices. See below.
- **Unemployment, 7.7 — and it is too low, not too high.** 1.57% against a 4.5%
  target. Damping the business cycle removed the busts and the labour block has
  never been retuned against an economy without them; every figure in it was
  fitted to a cycling one. This one *is* tuning, and `neutralTightness` is the
  dominant knob. Removing the job leak that `risk.credit` was running made this
  slightly worse and slightly more honest.

Then `nim` at 3.9 (4.84% against 2.5%) and `roe` at 2.3 (22.0% against 12%) —
the bank is too profitable, which is a pricing question rather than an
economic one.

Two things have left this list.

**Corporate insolvency, which was 40.5 of 67.8 — 60% of everything.** It was
not an economy failing five times too fast. The rate counted failures among
firms the player had lent to and divided by the number of firms the player had
lent to, then compared the result against a whole-economy target; a population
selected for having borrowed fails far more often than one that has not. Firm
demography gave the latent 22,000 a failure process, which made the
whole-economy denominator legitimate, and the term went to 0.0 at 0.77%
against a 0.7% target. Worth remembering as the model's clearest case of a
number being wrong about its own subject rather than wrong in value.

**The business cycle.** Its amplitude was mostly one defect — every firm
settling pay on the same tick — and volatility has gone from 15.8 to 1.9.

Everything that drives the economy is in `DEFAULT_CONFIG`
(`src/world/state.ts`) and `src/scenarios/uk2025.ts`. `npm run sim -- 1095`,
`node scripts/campaign.js standard` and the probe pattern in the tests are the
tools.

## Near term

**Enforce regulation.** The ratios are already computed every month and a
breach already raises `bank.breachedLimit`. Give it consequences: a supervisory
letter, a dividend block, forced deleveraging, and ultimately resolution with
the FSCS paying out covered depositors. One new system, no model changes.

**Firms entering as newcomers rather than as averages.** `firms.demography`
now founds and fails firms inside the pools, but a birth and a death both move
headcount and stock in proportion to the firm count, so the average firm is the
same size on either side. Real entrants are small and grow, and real failures
throw their staff onto the labour market. That was left out deliberately —
it is a net drain on employment, and unemployment is already 3 points below
target — so it is worth doing together with the labour retune above rather than
before it. `firmEntrantSize` is the knob that does not exist yet.

Firm demography also makes `cohortDispersion` usable at last: permanent
competitive losers can finally be replaced, where before the sector just
hollowed out. The campaign still shows dispersion costing 13.5 points at 0.04,
which is now worth re-running rather than assuming.

**Retail lending.** Mortgages and consumer credit as instrument types, plus
personal credit demand in `credit.demand`. People already have credit grades,
PDs and deposit relationships; only the products are missing.

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
proportional constraint, and a *regional* one — firms currently hire against
one economy-wide slack figure, so a region's firms can take on more staff than
that region has people; regional differentiation with real effects; supply
chains between sectors.

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

## The economy did not survive a decade

Everything was calibrated on three-year runs, and the model fell apart after
about four: unemployment reached 19% by year six and 38% by year ten, the
bank's loan book drained to nothing by year seven and its capital went
negative shortly after. It took two independent defects, one hiding the other.

**Firms had no margin objective.** They set prices from how fast stock was
turning over and nothing else, so nothing tied a price to what the thing cost
to make. Pay is indexed to inflation and to how tight the labour market is, and
could therefore rise straight through the price:

| date | avg price | unit wage cost | gross margin |
| --- | ---: | ---: | ---: |
| 2025-07 | £76.46 | £74.92 | 2.0% |
| 2026-07 | £83.67 | £76.19 | 8.9% |
| 2027-07 | £79.32 | £79.97 | −0.8% |
| 2028-01 | £82.55 | £86.16 | −4.4% |

Once the firm sector was selling below cost its earnings were negative by
construction, every credit application failed the affordability test — 15,776
declines for "no earnings to service the debt" over eight years — and the
credit market closed. Without credit, firms could not fund payroll, they shed
staff, demand fell and prices fell further.

This was the *second* spiral in the same place. Wage indexation was added to
stop a deflationary wage-price spiral, and downward wage rigidity was added to
stop that fix spiralling the other way. Both were right; together they left
nothing defending the margin. Firms now price against unit cost
(`targetMarkup`, `costAnchorWeight`), with the trading signal deciding how fast
they move rather than deciding the price outright.

**People saved for ever.** They spent a fixed share of income and ran
savings down at a flat daily rate. Those two flows do not balance: with a 95%
propensity and a 0.01% daily drawdown, the savings stock has to reach five
hundred days of income before saving stops. Until then the firm sector handed
over more cash than it took back, every day. Firm cash fell from £2.9bn to
£90m over eight years while their deposits rose from £4.8bn to £8.2bn —
the economy did not lose money, it just piled it where nothing spent it.

Nothing in a three-year run showed this. The stock takes a decade to bite, and
the margin defect was masking it: a firm sector selling below cost was handing
its losses back to people as purchasing power, which is a leak in the
opposite direction. Fixing the margin made the saving leak visible, and
unemployment briefly got *worse* — 19% rather than 28% — which is how the
second defect was found.

People now save towards a buffer of `savingsBufferDays` days of income and
close the gap to it at `savingsAdjustment` a day, so the saving flow is zero
once the buffer is full and negative above it.

Eight-year runs, two seeds, each fix added in turn:

| | gross margin | unemployment | inflation | score |
| --- | ---: | ---: | ---: | ---: |
| neither | 0.4% | 28.2% | 2.2% | 979 |
| cost anchor only | 7.0% | 19.0% | −3.0% | 354 |
| both | 6.7% | 3.5% | 4.7% | 82 |

Lower is better on score. `tests/consumption.test.ts` runs the economy for ten
years and fails if the firm sector drains or unemployment runs away, so this
particular hole cannot reopen unnoticed.

## The committee cannot control inflation, and the rate is not why

Bank Rate used to reach loan pricing, reserve remuneration and the yield curve
and nothing else. No spending decision read it: firms borrowed to cover payroll
regardless of cost, reinvested a fixed share of takings, and people saved
towards a fixed buffer. Pinning the rate across a 900 basis point span moved
inflation by 0.2 points, in the wrong direction — dearer credit raised firms'
costs and the cost anchor passed them into prices, with nothing anywhere
reducing demand. Four parameters describing the committee were tuning nothing,
which is why a 4,992-run sweep found `taylorInflationWeight` among the most
inert knobs in the model.

`realRateGap()` is now that missing signal, and two channels read it:
investment (`investmentRateSensitivity`) and consumption
(`savingsRateSensitivity`).

**It was necessary and it is not sufficient.** With both channels wired and
correctly signed, the committee's grip is about 0.1–0.2 points of inflation
between a rate pinned at zero and the Taylor rule — noise. Restraining demand
in this economy does not lower prices, it lowers output:

| saving sensitivity | inflation | unemployment | gross margin |
| ---: | ---: | ---: | ---: |
| 0 | 3.74% | 3.23% | 5.78% |
| 0.5 | 3.72% | 3.57% | 6.52% |
| 1 | 4.26% | 4.96% | 7.19% |
| 2 | 6.19% | 7.59% | 10.19% |

Inflation goes *up* as demand is restrained. The first reading of that was
that prices here are cost-determined and demand never reaches them. **That was
wrong, and tracing a run shows it plainly.** Prices reach demand violently —
this economy runs a boom-bust cycle, and restraining demand makes the swings
bigger rather than the level lower. At the shipped defaults, twelve years:

| year | unemployment | wage/employee | unit cost | price | markup | inflation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2027 | 0.7% | £141.01 | £82.04 | £89.34 | 8.9% | 1.0% |
| 2029 | 7.2% | £190.95 | £111.49 | £109.65 | −1.6% | 12.2% |
| 2030 | 11.1% | £197.32 | £115.86 | £122.72 | 5.9% | 12.0% |
| 2033 | 1.9% | £186.20 | £109.81 | £121.73 | 10.9% | −2.1% |
| 2036 | 4.4% | £206.34 | £122.27 | £125.00 | 2.2% | 5.8% |

Unemployment runs 0.5% to 11%, inflation −2% to +12%, and the markup swings
from −1.6% to 12.7%. With the consumption channel forced on the same cycle
reaches 0.2%–27.5% unemployment and ±23% inflation. The mean is
insensitive to demand because the *cycle* sets it, not the level of spending.

Two supporting facts. Relaxing downward wage rigidity tenfold, from 0.2% a
month to a symmetric 2%, moves inflation from 3.81% to 3.66% — so the ratchet
is not the inflation engine either. And at 24 seeds over ten years the baseline
score of 69.5 is 41.7 insolvency, **15.8 inflation volatility** and only 6.3
inflation level: the swing is two and a half times the miss.

The cause was that wage setting was perfectly synchronised. `firms.ts`
computed one `wageGrowth` from one economy-wide tightness number and applied it
to every firm on the same monthly tick, so one shock moved every wage in the
economy at once. Firms now settle pay on their own month of the year against a
running wage index, so twelve vintages coexist and a shock reaches the wage
bill over a year. Paired across 24 seeds at ten years, inflation volatility
fell from 15.8 to 4.4, and the heterogeneity added since has taken it to 2.6.

What that left behind is a **labour market that now runs far too hot**.
Damping the cycle removed the busts, and average unemployment fell to 1.63%
against a 4.5% target, and 1.52% once the rest of today's work landed — worth
7.9 of penalty where it used to be worth 0.8, so most of the volatility gain is
currently spent on it. That is a calibration
question rather than a defect in the mechanism, and `neutralTightness` is the
obvious lever, but the labour block has never been tuned against a damped
economy and every figure in it was fitted to a cycling one.

The consumption channel therefore ships switched off — built, tested and swept,
worth turning on once the cycle is damped, because until then extra demand
restraint buys amplitude rather than control. The investment
channel ships at 2, which costs 2.5±1.1 points of score at ten years and
−0.6±12.0 at twenty: the ten-year cost is the channel amplifying the settling
excursion, not a standing one.

A first attempt built the consumption channel against the target buffer rather
than the saving rate. That is a stock, not a flow: asking for a tenth more
buffer asks people to withhold eighteen days of income at once and hand it
back as abruptly when rates fall. It gave the committee enormous apparent grip
— inflation 10.2% at a pinned rate against 1.0% under the Taylor rule — by
wrecking the economy to get it, at 21% unemployment. Worth remembering the next
time a stabiliser looks powerful.

## People have ages; firms still do not

The population used to be a constant: one number per pool, everybody of
working age for ever. Labour supply is the hard limit on output and the thing
wages are bid against, so nothing the economy did could move it. People are now
born, spend `yearsAsChild` growing up, `yearsWorking` in the labour market and
`yearsRetired` before dying, and births run at one per worker per working
lifetime scaled by `prosperity ^ fertilityProsperity` -- so at zero the
population is exactly stationary and above it a richer economy grows. Over
thirty years: 0.0% at an elasticity of zero, -2.7% at 1.5, +5.2% at 4.

Money needs no special handling for inheritance. A pool holds one account
between its members, so a death leaves the balance where it is and fewer people
to share it. The survivors inherit and the ledger never sees a penny move.

Two things this cost, both worth recording because both looked like demographic
effects and neither was:

**A monetary shock dressed as a demographic one.** Opening savings were sized
per head from a figure calibrated when every person in the model was a worker.
Adding children and pensioners scaled it by the new headcount and minted 67%
more money against exactly the same output -- opening deposits went from
£4.8bn to £8.0bn, demand ran at 721,000 units against output of 473,000, and
inflation volatility went from 4.2 to 39.0. The per-head figures are a
calibrated aggregate, not a per-head truth, and they now scale with the
working-age count.

**Children budgeting as adults.** `poolBudget` split a pool by total headcount,
so each child defended a savings cushion of its own. Since a shortfall is
floored at zero rather than netted off, a hundred thousand of those floors is
demand out of nowhere. Children are mouths, not decisions: they eat from the
same budget as the adults they live with, and the split is over adults.

People also differ in how good they are at the work. `personAbilitySpread`
gives each pool an ability drawn off identity and then normalised so the
working-age-weighted mean is exactly one -- without that, five draws out of a
log-normal shift total output by whatever the sample happened to do, and the
knob reads as a productivity change rather than a dispersion.

Ability reaches output and pay together, through headcount in efficiency
units, and it has to. Raising output alone left a region of below-average
workers producing a third less for the same payroll: unit costs collapsed and
its firms failed for reasons unrelated to how they were run. Four seeds in
twenty-four scored over 500, two over 1400, against a baseline of 66. Scaling
both leaves the cost of a unit untouched and puts the whole difference into
what people take home -- in a region with two pools, the abler one takes 15%
more per head and the other 3% less.

Firms still have no demography, and that remains the largest single term in
the score -- 40.5 of 67.8, untouched by every parameter that describes it.

## Known open problem

Splitting a cohort into several identical cohorts changes aggregate outcomes.
It should not. `cohortSubdivision` is off by default because of it, and the
granularity it would buy is cheap and worth having once the cause is found.
Headcount rounding was one contributor and is fixed; something else remains.
Start by diffing aggregate employment, stock and price between a subdivided and
an unsubdivided run over the first ninety days — the divergence is gradual and
compounding rather than a step, which points at another per-cohort quantity
being treated as though the cohort were a single firm.

## Things to be careful about

- **Never assign a balance directly.** Everything goes through `post()`.
- **Never use `Math.random()`** in `src/`. Use `ctx.rng(stream)`.
- **Keep the world plain data.** No functions, `Map`s or class instances, or
  saving stops being one line.
- **Keep the engine DOM-free.**
- **Add a migration** whenever the world shape changes, and bump
  `WORLD_VERSION`.
