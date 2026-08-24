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

| configuration | inflation | inflation volatility | unemployment |
| --- | ---: | ---: | ---: |
| 10 cohorts (default) | 2.39% | 6.79% | 4.0% |
| 12x, identical slices | 7.23% | 5.38% | 3.2% |
| 12x, small dispersion | 9.29% | 5.67% | 2.8% |

The volatility improvement is real and worth having. The problem is the middle
row: splitting a pool into twelve *identical* pools should be a no-op, and it
moves inflation by five points. Something in the per-cohort logic does not
scale with cohort size.

One cause was found and fixed — headcount was being rounded to whole people per
cohort, so twelve pools shed fewer staff than one pool of the same size. That
was a genuine defect and improved the default calibration, but it did not close
the gap. Something else remains.

Do not turn subdivision up until that is understood. A knob that silently
changes the economy is worse than no knob, and any calibration done with it on
would be fitted to an artefact.

Larger `cohortDispersion` has a separate and better-understood problem:
permanent cost differences mean permanent competitive losers, and with no firm
entry or exit they simply shrink and shed staff. At 0.09 unemployment reaches
9.9% and output falls 3.7% a year. That one waits on firm demography.

## Watch the denominator

A metric can flatter the model without anyone lying. Corporate insolvency was
measured against every firm in the economy, but only the ~1,500 simulated
individually can fail at all — the other 20,000 are latent inside cohorts with
no failure process. The rate read 0.12% against a 0.7% target, looking mildly
too low. Measured against the firms actually at risk it is 3.76%: five times
too high, and the second-largest item on the scorecard.

Nothing about the model changed; the score went from 52 to 90 because the
measurement stopped hiding it. Before trusting a metric, check that its
denominator is the population the numerator can come from.

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
- **Three years minimum.** Year-on-year inflation has no history before then,
  and the summary discards the first thirteen months for exactly that reason.
- **Runs are parallel** across worker threads, one job per worker, no shared
  state — which is only possible because the engine is deterministic and
  self-contained.
- **Throughput is the binding constraint.** A full sweep is ~80 runs. At three
  years and four cores that is tens of minutes. Shorten the horizon or narrow
  `--params` while iterating.
- Balance checking is turned down to every 30 ticks inside the harness. The
  whole-economy scan is the single most expensive thing in a batch run, and the
  point here is throughput rather than forensics.

## Where the knobs live

Every tuning parameter is in `SimConfig` (`src/world/state.ts`). If you find
yourself writing a magic number inside a system, move it there instead — the
sweep can only explore what it can reach, and a constant buried in a module is
invisible to it. `src/calibration/parameters.ts` declares which of them are
worth sweeping and the range each may move in.
