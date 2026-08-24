# Running a calibration campaign

A campaign is a set of studies — each one a question, with the runs needed to
answer it — executed in bulk and written to a single results file. The file is
self-describing: it records the commit that produced it, the machine, the seeds
and every run, so it can be handed to someone else and analysed without any of
the context that produced it.

```bash
npm run build
node scripts/campaign.js run --preset standard --workers 20
node scripts/campaign.js report campaign.json.gz
```

Start with `--preset smoke`. It takes under a minute and proves the whole path
works on your machine before you commit an evening to it.

## Presets

Times assume roughly three seconds per simulated year per core, which is what
this engine does on a mid-range machine. The runner times one run at startup
and prints its own estimate before starting anything, so you can decide against
it.

| preset | runs | simulated years | on 20 cores | file (gzipped) |
| --- | ---: | ---: | ---: | ---: |
| `smoke` | 28 | 86 | ~15s | 5 KB |
| `quick` | 344 | 1,044 | ~3 min | 60 KB |
| `standard` | 1,032 | 5,208 | ~13 min | 200 KB |
| `deep` | 5,248 | 27,104 | ~1.1 h | 1 MB |
| `overnight` | 19,616 | 104,864 | ~4.4 h | 3.5 MB |

`--workers` defaults to your core count. Each worker holds one economy, so
expect a few hundred megabytes of memory per worker on the long horizons.

## What it asks

**Baseline** — where the default configuration actually sits, with enough seeds
that the error bars are worth reading. The same configuration scores anywhere
from 68 to 148 depending on the seed, so this is the study that turns a number
into a number with a confidence interval.

**Long run** — everything has been judged on three years. This runs the same
seeds out to ten, twenty, forty, and asks whether anything drifts. Nobody has
ever looked.

**Sensitivity** — every parameter at several multiples of its default, compared
seed by seed against baseline. Multiple points rather than one pair, because a
single pair says whether a parameter matters and a curve says whether its
effect is linear — which is what tells you whether a search can trust its own
gradient.

**Cohort subdivision** — the open modelling problem. Splitting a cohort into
several *identical* cohorts should change nothing and does. This walks the
number of slices from 1 to 20 with dispersion held at zero, to find where the
non-linearity starts and whether it scales with the count.

**Cohort dispersion** — how different cohorts can be before competitive
selection, with no firm entry to offset it, starts destroying the economy.

## The results file

Gzipped JSON, because it is meant to be handed over and this shape compresses
about sevenfold. Both forms are read transparently — gzip is detected from the
bytes, not the name.

```
{ format, createdAt, commit, branch, preset, seeds, machine, elapsedSeconds,
  studies: [ { id, label, question, runs: [ { seed, years, overrides, scenario,
                                              summary, score, penalties } ] } ] }
```

The commit matters more than anything else in there. Results from a different
commit are results about a different model, and there is no way to tell after
the fact without it.

## If it goes wrong

- **Every study is written as soon as it finishes.** Ctrl-C is safe; whatever
  had completed is already on disk.
- **A run that fails is recorded and the campaign carries on.** The report says
  how many failed and what the first one said.
- **A worker that dies is replaced.** This matters more than it sounds: a
  worker killed by the OS for memory emits `exit` and nothing else, and a pool
  that only listens for `error` waits for it for ever. The pool handles both.

## Reading it back

`report` prints the analysis, and it is the same code either of us runs, so we
are looking at the same thing.

Every comparison is paired seed by seed. Levels are noisy — tens of points
between seeds — but the same seed run twice differs only by what the change
did, so differences resolve far better than levels. Anything that fails to
clear two standard errors prints as a dash rather than as a small number,
because a small number invites someone to tune it.
