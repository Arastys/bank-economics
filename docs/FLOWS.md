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
| Deposit interest | banks | **company** cohorts | — | **scenery** — company cohorts have no deposit instrument |
| Loan interest + principal | resolved borrowers | banks | `loan.*` instrument | **live** |
| Loan interest | latent economy | banks | — | **scenery** — no instruments exist against £7.55bn of cohort borrowings |
| Interest on reserves | central bank | banks | `bank.treasury`, daily at Bank Rate | **live** |
| Gilt coupons | government | holders | `bond.*` instrument | **live** |
| Bank operating costs | banks | people | `accounting.periods`, monthly | **live** |
| Corporation tax | firms + banks | government | `accounting.yearEnd` | **live** |
| Public spending | government | people | `accounting.yearEnd`, spends the year's receipts | **live** |
| Firm profit | firms | own reserves | `accounting.yearEnd` closes the P&L | **live** |
| Bank profit | banks | own reserves | `accounting.yearEnd` closes the P&L | **live** |
| Dividends | firms + banks | people | `accounting.yearEnd`, out of reserves | **live** |

## How much of the balance sheet is scenery

| | at the open | year 10 |
| --- | ---: | ---: |
| Bank loan book | £7,603m, **0.6% contracted** | £7,523m, **0.1% contracted** |
| Bank customer deposits | £7,706m | £8,360m, **86.3% contracted** |
| Cohort borrowings | £7,550m, **no instruments** | — |
| Reserves and gilts | £1,591m, live | — |

The asymmetry is the important part, and it is not a calibration problem. By
year ten the banking sector **pays interest on 86% of its funding and earns
interest on 0.1% of its lending**. It is loss-making by construction, which is
what the sector's −0.87% net interest margin is, and what −£5.52bn of
accumulated bank losses by year twenty is — a figure that is part inert loan
book and part the running costs the rivals now pay out of equity because that
book earns them nothing.

While that holds, the banks are quietly handing households an unfunded income
stream. It is why activating the loan book on its own was so violent: that
switches the asset side from 0% to 100% while the liability side is already at
86%, so the economy swings from being subsidised to paying £378m a year with no
return path, and deflates.

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
3. contracts on **both** sides of the cohort balance sheet, activated together
   so the flows partly offset rather than draining one way. **Still to do**,
   and it is now the only thing between here and a live balance sheet. See
   `docs/ROADMAP.md`.

Steps 1 and 2 both add household income with no extra output behind them, so
the economy is running hot — inflation 4.56%, unemployment 0.98% — and it is
meant to be. Step 3 is the offsetting drain, and step 4 retunes what is left.

## Level of detail: what is aggregated, and what that costs

Nothing about the flows above changes with resolution. Cohorts can hold
contracts, and it is not many of them: 15 cohorts need **15 deposit
instruments and 60 loan instruments — 75 in all** to make the entire latent
balance sheet live, which costs about as much as 75 entities, i.e. nothing.
**Resolving the economy is not the fix for scenery**; contracts are.

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
