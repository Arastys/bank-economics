# Where the money goes

**A balance is not a behaviour.** This file exists because that sentence cost a
lot of time to learn. The ledger is full of large, correct-looking balances that
nothing accrues on, pays into, or draws from. They are real in the accounts and
inert in the economy, and nothing about reading the code says which is which.

So: every money flow in the model, what triggers it, and whether it is **live**
or **scenery**. Check here before building on something.

Figures are measured on `uk2025`, seed 1, at the open and at year ten.

## The rule

An entity's ledger balance moves only when something posts to it. For the
latent economy that means an **instrument** — a loan, a deposit, a bond. A
cohort can hold £7bn of borrowings and pay nothing on it for a century, because
there is no contract to accrue against, and it will look completely normal on
the balance sheet the whole time.

`grep` proves a thing exists. It does not prove it does anything.

## The map

| flow | from | to | trigger | live? |
| --- | --- | --- | --- | --- |
| Wages | firms | people | `economy.production`, daily | **live** |
| Consumption | people | firms | `economy.goodsMarket`, daily | **live** |
| Investment | firms | firms | `economy.goodsMarket`, buys `FIXED_ASSETS` | **live** |
| Deposit interest | banks | **person** cohorts, resolved customers | `deposit.*` instrument, daily | **live** |
| Deposit interest | banks | **company** cohorts | `deposit.instant`, daily | **live** |
| Loan interest + principal | resolved borrowers | banks | `loan.*` instrument | **live** |
| Loan interest | latent economy | banks | `loan.pool`, floating, monthly | **live** |
| Interest on reserves | central bank | banks | `bank.treasury`, daily at Bank Rate | **live** |
| Gilt coupons | government | holders | `bond.*` instrument | **live** |
| Bank operating costs | banks | people | `accounting.periods`, monthly | **live** |
| Corporation tax | firms + banks | government | `accounting.yearEnd` | **live** |
| Public spending | government | people | `accounting.yearEnd`, spends the year's receipts | **live** |
| Firm profit | firms | own reserves | `accounting.yearEnd` closes the P&L | **live** |
| Bank profit | banks | own reserves | `accounting.yearEnd` closes the P&L | **live** |
| Dividends | firms + banks | people | `accounting.yearEnd`, out of reserves | **live** |

## How much of the balance sheet is scenery

**None of it, now.** This section used to be the point of the file:

| | at the open | year 10 |
| --- | ---: | ---: |
| Bank loan book | £7,603m, 0.6% contracted | £7,523m, **0.1% contracted** |
| Bank customer deposits | £7,706m | £8,360m, **86.3% contracted** |
| Cohort borrowings | £7,550m, **no instruments** | — |

and it now reads:

| | at the open | year 10 |
| --- | ---: | ---: |
| Bank loan book | £7,603m, **100% contracted** | £7,520m, **100% contracted** |
| Bank customer deposits | £7,706m, **100% contracted** | £7,099m, **99.9% contracted** |
| Reserves and gilts | £1,591m, live | — |

The asymmetry was the whole problem, and it was never a calibration one. A
sector that paid interest on 86% of its funding and earned it on 0.1% of its
lending was loss-making by construction: −0.87% net interest margin, and the
rival banks spending their way from +£1.47bn of equity to −£875m.

It is also why activating the loan book on its own, early on, was so violent —
that moved the asset side from 0% to 100% while the liability side was already
at 86%, so the economy swung from being subsidised to paying £378m a year with
no return path, and deflated. Doing both sides on the same tick, after the
return paths existed, took inflation from 4.56% to 1.45% and the scorecard's
metric penalty from 51.4 to 8.9.

The habit that produced this file is still the point. Nothing here says a
*future* balance will have a contract behind it.

## The circular flow, and where it leaks

Household income has five sources here: wages, deposit interest, bank operating
costs, recycled tax, and — since `firmDividendPayout` and `bankDividendPayout`
— dividends. Profit used to close to `RETAINED_EARNINGS` and stay there, which
meant **the model was only stable while nobody made money**: a profitable firm
sector accumulated cash households were never paid and therefore could not
spend.

Tax already worked this way and the code says why: *"Tax that is taken out of
the circular flow and never returned is a slow drain on demand"*. The same
argument applies to profit and had never been carried across.

What the distribution actually looks like is worth knowing, because it says
something about the economy rather than about dividends. Over twenty years it
runs £180–450m a year, and the number of entities paying it falls from 33 in
year one to five or six by year twelve. **Almost nothing in this economy is
profitable** — gross margins collapse towards zero over a decade — so the
return path exists but very little travels down it. That is a finding about
the pricing and margin blocks, and it is on the roadmap rather than here.

Two limits are worth knowing about because they are load-bearing rather than
decorative: a dividend cannot exceed accumulated reserves, and cannot exceed
cash. The first is what stops a bank spending its way through its equity from
also paying out on a good year, which the rival banks would otherwise do.

One thing is still missing. Three things had to exist before the balance sheet
could safely be made live:

1. ~~rival banks with operating costs~~ — **done**. They pay at the player's
   own cost-to-deposits ratio, 2.2% of deposits a year, so the sector's
   running costs reach households as pay.
2. ~~dividends~~ — **done**, as above.
3. ~~contracts on **both** sides of the cohort balance sheet~~ — **done**,
   activated on the same tick so the flows partly offset: a `loan.pool` and a
   `deposit.instant` for every pool. See `docs/ROADMAP.md`.

Steps 1 and 2 added household income with no extra output behind it and the
economy ran hot at 4.56% inflation. Step 3 was the offsetting drain and took
it to 1.45%. What is left is a tuning pass, and two things worth knowing:
Bank Rate now swings between 0% and 10%, because floating-rate debt gave the
MPC a channel it never had, and the player bank is priced for the economy
that existed before all this.

## Level of detail: what is aggregated, and what that costs

Nothing about the flows above changes with resolution, and the thing usually
proposed to fix them was never the fix. Cohorts hold contracts: **75 deposits
and 60 loans** cover the entire latent balance sheet, at about the cost of
135 entities, i.e. nothing. That is the whole repair, and it is 250 times
cheaper than resolving the firms it covers. **Resolution was never the fix
for scenery**; contracts were.

Measured cost of resolution, for when that question comes up anyway:
**~3.5µs per entity per tick** and **~2,070 bytes per entity in a save**, both
linear.

| | entities | ticks/sec | 10-year run | save |
| --- | ---: | ---: | ---: | ---: |
| today | ~600 | ~890 | 4.2s | 0.2 MB |
| 2,000 firms | 2,000 | ~190 | 19s | 4.3 MB |
| all firms | 22,560 | ~13 | 4.8 min | 47 MB |
| + all people | 523,000 | ~0.55 | 1.8 hrs | >1 GB |

All firms makes campaigns overnight-only and breaks interactive play, which
wants the ~100+ ticks/sec the dashboard is built around, and it is 300 times
the cost of the 75 contracts that would fix the thing it is usually proposed
for. All people is three orders of magnitude too expensive on both time and
save size. No person is ever resolved today, and only company cohorts are ever
promoted.

The boundary is already "anyone who touches a bank": `maxResolvedEntities` is
1,500 and the model sits at ~600 resolved at year ten, so the cap is not
binding. It reaches ~994 by year twenty, and competition routes applications to
four more banks, so **it may start binding in long runs** — worth watching,
because hitting it changes behaviour silently.

## Checking whether something is live

Reading the code is not enough; both halves look identical. Measure it.

- **Count the contracts, not the balance.** `heldBy(world, id)` filtered by
  type, against `naturalBalance(...)`. A large balance with no instruments is
  scenery.
- **Watch the P&L account.** If `AC.INTEREST_INCOME` is not moving, nothing is
  accruing, whatever the loan book says.
- **Change the knob and look.** `targetCapitalRatio` from 0.12 to 0.16 produces
  byte-identical results, which is how we know that constraint never binds.
- **Trace one entity for a year** rather than reading an aggregate. Most of
  what this file records was found that way.
