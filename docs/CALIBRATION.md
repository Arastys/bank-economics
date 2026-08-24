# Calibrating the economy

Hand-tuning a simulation is guesswork until "balanced" is a number you can
measure. This is the machinery that turns it into a search problem.

```bash
npm run build
node scripts/calibrate.js score      # how good is it right now?
node scripts/calibrate.js sweep      # which knobs actually matter?
node scripts/calibrate.js search     # move the ones that do
```

Flags: `--seeds N` `--years N` `--workers N` `--params a,b,c` `--iterations N`.

## 1. Score

Every run is reduced to a handful of headline numbers (`RunSummary`) and scored
against targets (`src/calibration/targets.ts`). Each target has a value, a
tolerance — "one unit of badness" — and a weight. The penalty is
`weight × ((observed − target) / tolerance)²`, so being twice as far off is four
times as bad. A bank that goes insolvent takes a flat 50-point penalty on top,
because a run where the player's bank dies is a failed run whatever else it did.

Lower is better; zero would be every target hit exactly.

The targets are broadly UK figures over a normal cycle — CPI 2%, unemployment
4.5%, corporate insolvency 0.7%, NIM 2.5%, RoE 10%. They are a starting
position for a designer to argue with, not gospel. Change them in one file.

The scorecard is the point: it tells you *what* is wrong, ranked, rather than
that something is.

```
  metric                           actual     target   penalty
  Inflation                        -0.88%      2.00%     17.06
  Inflation volatility              8.79%      1.00%     40.43
  Unemployment                      5.33%      4.50%      0.75
  Cost of risk                     17.83%      1.00%    425.06
  ...
  TOTAL 497.94   bank survived 2/2
```

Read that as: unemployment is basically right, inflation is somewhat wrong and
very volatile, and credit losses are catastrophically wrong. Work top-down.

## Every number here has an error bar

Run the same configuration on eight different seeds and the total lands
anywhere between 68 and 148 — standard deviation 26. So a score on its own
supports far less than it looks like it does, and the scorecard prints its
uncertainty:

```
  TOTAL 87.8 ± 5.8   (73–117 across 6 seeds)
  Anything smaller than about 12 points is inside the noise here.
```

Comparisons are much better resolved than levels, because every configuration
is run on the *same* seeds. That pairs them: the seed's own contribution
cancels, leaving only what the change did. A change worth 73 points has a
paired standard deviation of 13; one with no real effect has a paired standard
deviation of 0.2. The sweep and the search both compare this way, and both
require a difference to clear two standard errors before believing it.

That is why the sweep prints a dash rather than a small number:

```
  parameter                               -30%          +30%  improves
  Price responsiveness               +13.2±2.9   +258.8±12.8  lower
  MPC inertia                                —     -17.6±2.4  higher
  Recovery variance                          —             —
```

Recovery variance does nothing measurable at this sample size. Reporting it as
"0.26" would have invited someone to tune it.

**Practical rule:** more seeds narrows a level, and you rarely need it narrow.
More seeds also narrows a comparison, and that is usually what you are after.
Six is the default because it is affordable; raise it when a decision turns on
a difference of a few points.

## 2. Sweep before you search

Roughly twenty parameters can be tuned. Most of them barely matter. `sweep`
runs each one at ±30% and reports how far the score moves, and which single
metric moves most — the second column is what tells you *why*.

Do this before any optimisation. It usually shows three or four parameters
carrying almost all the influence, which turns an intractable twenty-dimensional
search into a tractable four-dimensional one.

It also distinguishes the two kinds of problem:

- **A parametric problem** moves when you move a parameter. Search will fix it.
- **A structural problem** doesn't move at all, whatever you set. No amount of
  parameter search will fix it, and continuing to search is wasted time.

A known structural one: the MPC reacts to *year-on-year* inflation, which lags
the cycle by months. That produces a policy-driven cycle on top of the real one,
and no setting of `taylorInflationWeight` removes it — the fix is to give the
committee a forecast or a shorter-horizon measure.

## 3. Search

`search` does coordinate descent over whichever parameters you name, stepping
each one up and down and keeping any move that improves the mean score across
seeds. Nothing clever, and clever is not needed at this dimensionality.

```bash
node scripts/calibrate.js search --params priceAdjustment,investmentRate,wageIndexation --iterations 3
```

It prints the overrides it found. Paste them into `DEFAULT_CONFIG` or into a
scenario's `config` block.

## 4. Lock it in

`tests/calibration.test.ts` runs two seeds for three years and asserts the
economy stays inside wide bands: no runaway inflation in either direction, no
employment collapse, the bank still solvent and still lending, corporate
failures in a plausible range.

Those bands are guard rails, not a tuning lock — their job is to catch a change
that sends the model into a spiral, not to freeze the current numbers. Tighten
them as the calibration settles.

## Open question: cohort granularity is not behaviour-neutral

`cohortSubdivision` splits each company specification into several cohorts.
Members stay latent either way, so the per-tick cost is one extra view per
cohort rather than one per firm — ten price-setters become ninety-two for
almost nothing, and the latent economy stops behaving like a handful of
identical giants.

It is **off by default**, because it changes aggregate outcomes in a way it
should not:

Sixteen seeds, ten years, identical slices throughout:

| slices | inflation | inflation volatility | score |
| ---: | ---: | ---: | ---: |
| 1 (default) | 4.10% | 2.74% | 68.3 |
| 4 | 4.22% | 2.41% | 70.2 |
| 12 | 4.23% | 2.31% | 73.5 |

The volatility improvement is real and worth having. The problem is that
splitting a pool into *identical* pools should be a no-op and is not: the level
moves too, and the score gets worse. Something in the per-cohort logic does not
scale with cohort size.

The effect is much smaller than it was — it used to move inflation by five
points, against 0.13 here — but that is mostly because the rest of the model
stopped swinging so hard rather than because the non-linearity was found. It
still points the same way at every level, and it still saturates rather than
scaling with the number of slices, which says it is a step taken on the first
split rather than something proportional.

One cause was found and fixed — headcount was being rounded to whole people per
cohort, so twelve pools shed fewer staff than one pool of the same size. That
was a genuine defect and improved the default calibration, but it did not close
the gap. Something else remains.

Do not turn subdivision up until that is understood. A knob that silently
changes the economy is worse than no knob, and any calibration done with it on
would be fitted to an artefact.

Larger `cohortDispersion` has a separate problem: permanent cost differences
mean permanent competitive losers. Before `firms.demography` there was no way
for them to be replaced, so a sector simply hollowed out — at 0.09 unemployment
reached 9.9% and output fell 3.7% a year. Entry and exit now exist, so this is
worth re-measuring rather than assumed; the most recent campaign still shows
0.04 costing 13.5 points, but that was run against pools whose average firm
size is held constant through a birth.

## Three years is not long enough

Every guard rail and every calibration in this repository ran for three years,
and the model was fine for three years. It was not fine for ten:

| horizon | gross margin | unemployment | insolvency |
| --- | ---: | ---: | ---: |
| 3 years | 2.9% | 4.0% | 4.0% |
| 6 years | 0.2% | 19.5% | 4.5% |
| 10 years | 1.4% | 37.6% | 5.3% |

Those are the figures as they stood then, kept as the record of what a short
horizon hid; the insolvency column is on the old loan-book denominator and is
not comparable with anything above.

Two defects were hiding behind that horizon — firms with no margin objective,
and people saving into a pot nothing spent — and both are written up in
`docs/ROADMAP.md`. Neither was visible at three years, and the second was not
visible until the first was fixed.

A short horizon is not a cheap approximation of a long one. It is a different
question, and it was answering the easy one. The campaign presets run to twenty
and forty years for this reason, and `grossMargin` is recorded monthly because
it is the variable that turns over first.

## Five years is the worst horizon there is

Three years was too short. Five is actively misleading, which is worse, because
a longer run feels like a safer one.

The opening world is not in equilibrium. Finding one takes a large excursion
through years three to six — annual inflation of 10.5%, 10.7% and 12.7%, with
unemployment humping to 10.8% and back — that is over by year ten. A mean that
*ends* inside that excursion is a measurement of it. Across 64 seeds, the same
default configuration scores:

| horizon | score | inflation | contributed by inflation |
| --- | ---: | ---: | ---: |
| 3 years | 60.7 ±1.6 | 4.25% | 10 |
| 5 years | 162.1 ±1.4 | 7.94% | 71 |
| 10 years | 67.5 ±1.0 | 3.71% | 6 |
| 20 years | 93.6 ±3.3 | 2.78% | 1 |

Those error bars are small. The five-year figure is not noise, and it is not a
worse three-year figure — it is a different number about a different thing.

This cost a campaign. Every preset ran its baseline, sensitivity, subdivision
and dispersion studies at five years, so 5,568 of a 6,016-run campaign were
measured inside the excursion. The sensitivity sweep taken there ranked
`savingsBufferDays` as the second most powerful parameter in the model and
recommended raising it 30%:

| buffer | 5y score | 10y score | 20y score |
| --- | ---: | ---: | ---: |
| 180 (default) | 162 | 67 | 100 |
| 200 | — | 65 | 114 |
| 220 | — | 84 | 70 |
| 234 | 91 | — | — |
| 240 | — | 145 | 152 |

The recommendation reverses. At ten years and twenty the default is fine and
the recommended value is clearly worse. Note also that the 10y and 20y columns
are two seeds each, where the score carries roughly ±18 of seed noise — enough
to say 240 is wrong, not enough to choose between 180 and 220.

`MINIMUM_USEFUL_YEARS` is now ten and every preset uses it. The horizon study
is exempt, because measuring what the horizon does to the answer is the point
of it — and is how this was found.

The excursion itself is a separate open question. It is most likely a scenario
defect rather than a rules defect: the opening balance sheets, employment and
prices are hand-set and need not be mutually consistent, so the first few years
are the model arguing with its own initial conditions. Worth understanding
before anyone trusts a three-year number either.

## What the score is actually made of

At the shipped defaults, twenty-four seeds, ten years. The first column is
where the model stood when it was first measured at a horizon outside the
settling excursion; the last is where it stands now.

| component | observed | then | now |
| --- | ---: | ---: | ---: |
| inflation level | 4.04% | 6.3 | 8.4 |
| unemployment | 1.57% | 0.8 | 7.7 |
| net interest margin | 4.84% | 0.6 | 3.9 |
| return on equity | 21.96% | 1.7 | 2.3 |
| inflation volatility | 2.53% | 15.8 | 1.9 |
| output growth | −0.26% | 0.7 | 0.8 |
| cost of risk | 0.69% | 0.4 | 0.4 |
| unemployment volatility | 1.62% | 1.5 | 0.2 |
| corporate insolvency | 0.77% | 41.7 | **0.0** |
| **total** | | **69.5** | **25.6** |

What moved and why, in order:

- **Volatility fell eight-fold**, from 15.8 to 1.9. Firms used to settle pay on
  the same monthly tick from one economy-wide number, which is a
  synchronisation machine; they now settle on their own month of the year
  against a running index, so twelve vintages coexist. Heterogeneity of every
  kind helps here — the ability spread damps it further, monotonically.
- **Insolvency went from 41.7 to nothing**, and it was a measurement, not an
  economy. See "Watch the denominator" below: it is the model's clearest case
  of a number being wrong about its own subject rather than wrong in value.
- **Unemployment went from free to 7.7.** An economy without busts runs hot:
  1.57% against a 4.5% target. That is the volatility gain being handed back,
  and it is a calibration debt rather than a defect. The labour block has never
  been tuned against a damped economy; every figure in it was fitted to a
  cycling one.
- **The bank got better off and further from target.** NIM and ROE both drift
  up in a stable economy with almost no credit losses.
Two things follow, and both redirect effort.

**A knob that describes a term is not evidence the term is parametric.** Every
parameter governing recovery and loss — `lossGivenDefault`,
`liquidationHaircut`, `liquidationVariance`, `liquidationCyclicality`,
`workoutHaircutFactor` — moved the insolvency penalty by no measurable amount
at 24 seeds while it was the largest item on the card. That was read for a long
time as "insolvency is structural, so build firm demography". Half right: the
demography was worth building, but what actually made the number wrong was that
it described the loan book and was being scored against the economy. When a
term will not move for any parameter that names it, check what population it is
about before deciding what to build.

**It was the swing, then the miss, and now it is the level.** Volatility used
to cost two and a half times what the level did, then insolvency dwarfed both.
What is left is an inflation rate two points too high and an unemployment rate
three points too *low* — no longer a defect anywhere, just a calibration that
was never done against the economy the model has now become.

The policy parameters — `taylorInflationWeight`, `taylorOutputWeight`,
`neutralRealRate` — still register no measurable effect even now that Bank Rate
reaches investment spending. Wiring the rate to demand was necessary and did
not make monetary policy matter, which is written up in `docs/ROADMAP.md`.

`savingsBufferDays` is worse in *both* directions at this horizon (+68 at
×0.7, +89 at ×1.3), which settles a question an earlier five-year campaign got
backwards: it is sitting at a local optimum and should not move.

## Watch the denominator

A metric can flatter the model without anyone lying, and this one moved twice.

Corporate insolvency was first measured against every firm in the economy,
while only the few hundred simulated individually could fail at all — the other
22,000 were latent inside cohorts with no failure process. The rate read 0.12%
against a 0.7% target, looking mildly too low. Narrowing the denominator to the
firms that could actually fail gave 3.8%: five times too high, and the score
went from 52 to 90. Nothing about the model had changed.

That was the right move and still the wrong number. A firm is only resolved
because it borrowed from the player, so the narrow denominator describes a
population *selected for having debt to default on* — that rate is the default
rate on the loan book, which is a real and useful quantity, but it was being
scored against a whole-economy target. It sat at 40.5 of a 67.8 score and no
parameter describing recovery or loss would shift it, because nothing about
recovery or loss was what was wrong.

The fix was neither denominator. It was to give the latent 22,000 a failure
process (`firms.demography`) so that the whole economy could be both numerator
and denominator. The rate is now 0.77% against the 0.7% target and the term is
0.0. Swapping the denominator alone would have read 0.10% — an order of
magnitude *below* target — because 95% of the implied failures did not exist.

The rule is not "prefer the wide denominator" or "prefer the narrow one". It is
that the numerator and the denominator must describe the same population, and
that when they do not, the repair usually belongs in the model rather than in
the measurement. Ask what population the target is about before choosing.

## The score is a diagnostic, not a target

Two changes in this codebase made the score worse and were still right. Winding
failed firms up properly means they genuinely stop producing, which shows up as
output volatility. Fixing the insolvency denominator revealed a problem rather
than creating one.

If a change makes the model more correct and the score worse, the score is
wrong, or a target is. Fix those. Do not fix the model back.

## A parameter nothing reads is worse than no parameter

The sweep reports an unwired parameter as having no influence, and you conclude
the mechanism does not matter — when in fact it was never connected. This has
already happened here, to eight parameters at once, after an edit silently
failed to apply.

`tests/calibration.test.ts` guards both halves of it:

- every parameter in `PARAMETERS` must be read as `config.<key>` somewhere in
  `src/`;
- no system may declare a bare tuning constant of its own, unless it is on the
  allowlist of genuinely structural values.

If you add a knob, put it in `SimConfig` and the tests will keep it honest.

## Practicalities

- **Always use several seeds.** A single run tells you about that run.
- **Ten years minimum**, which is `MINIMUM_USEFUL_YEARS` and what every preset
  uses. Three years is enough for year-on-year inflation to exist — the summary
  discards the first thirteen months for that reason — but not enough for the
  answer to mean anything: the economy is still inside its settling excursion,
  and a campaign measured there tunes the excursion. A 4,992-run sweep taken at
  five years recommended raising `savingsBufferDays` 30%, which reverses at ten
  years and at twenty.
- **Runs are parallel** across worker threads, one job per worker, no shared
  state — which is only possible because the engine is deterministic and
  self-contained. The runner defaults to one worker per core.
- **Throughput is the binding constraint.** Shorten the horizon below ten years
  only to prove the plumbing works, never to draw a conclusion; narrow
  `--params` instead while iterating.
- Balance checking costs more than it looks. `trialBalance` walks every account
  in the economy, so the harness turns it down to every 30 ticks while the CLI
  and the UI check every tick. The same run is roughly a third faster in the
  harness, and that gap is now the largest single cost on the interactive path.
- Balance checking is turned down to every 30 ticks inside the harness. The
  whole-economy scan is the single most expensive thing in a batch run, and the
  point here is throughput rather than forensics.

## Where the knobs live

Every tuning parameter is in `SimConfig` (`src/world/state.ts`). If you find
yourself writing a magic number inside a system, move it there instead — the
sweep can only explore what it can reach, and a constant buried in a module is
invisible to it. `src/calibration/parameters.ts` declares which of them are
worth sweeping and the range each may move in.
