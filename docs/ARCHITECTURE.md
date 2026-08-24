# Architecture

## The tick

One tick is one day. `Engine.tick()` does the same five things every time:

1. **Advance the clock** and open a new event journal.
2. **Apply queued commands.** Each is revalidated at the moment it is applied,
   because the world has moved on since it was queued.
3. **Run every system in phase order.**
4. **Collect the events** emitted during the tick.
5. **Check the ledger still balances.** A non-zero trial balance throws
   `LedgerImbalanceError` naming the tick, so an accounting mistake is located
   immediately rather than discovered as slow drift an hour later.

### Phases

Systems declare a phase rather than an index, and phases are spaced so new work
slots in without renumbering.

| Phase | System | What it does |
| ---: | --- | --- |
| 0 | *(commands)* | Player actions, applied by the engine itself |
| 100 | `policy.monetary` | MPC sets Bank Rate from inflation and the output gap |
| 200 | `markets.rates` | Yield curve, credit spreads, bond prices |
| 250 | `economy.capital` | Sets output per head from the capital behind each worker |
| 300 | `economy.production` | Firms produce; jobs are filled; wages paid to people |
| 350 | `economy.goodsMarket` | Demand meets output; prices move |
| 400 | `firms.decisions` | Monthly pay, hiring against labour supply, funding needs |
| 450 | `credit.demand` | Applications arrive; latent firms are materialised |
| 500 | `credit.underwriting` | The credit committee decides |
| 600 | `instruments.lifecycle` | Accrue, pay, mature — every contract |
| 700 | `risk.credit` | Re-score borrowers; decide who fails |
| 800 | `bank.treasury` | Reserve management against the central bank |
| 850 | `lod.sweep` | Fold idle entities away; prune dead records |
| 900 | `accounting.periods` | Operating costs and depreciation |
| 920 | `people.demography` | Births, ageing between life stages, retirement, death |
| 930 | `firms.demography` | Firms founded and firms failing inside the pools |
| 950 | `metrics.record` | Monthly time series and prudential ratios |
| 980 | `accounting.yearEnd` | Tax, public spending, the annual close |

Order matters in places and the phases encode it: firms must be paid before they
can spend, contracts must accrue before they can be repaid, and the books must
be measured before they are closed — closing zeroes every P&L account, so a
December snapshot taken afterwards would report a year of trading as nil.

Ordering also has teeth. Wages are paid at 300 and debt service falls due at
600, so a firm that spends everything on payroll starves its own loan payments
and falls into arrears on a bill it could have met. `production` therefore holds
back whatever is due to lenders in the next few days before paying wages.

## Threads

The engine is single-threaded and deliberately so. Every system posts to one
shared ledger, which is the definition of a contended critical section, and
JavaScript workers have no shared heap — parallelising a tick would mean either
rewriting all state as typed arrays in a `SharedArrayBuffer`, losing the
plain-data world, or structured-cloning the world every tick, which costs more
than the tick does. Determinism, which underpins saves, replays, every test and
the calibration harness, is the thing that would be spent for it.

Threads are used where the work is genuinely independent:

- **Calibration** runs one seed per worker with no shared state.
- **The dashboard** runs the engine on a worker that owns the world
  exclusively, and posts compact snapshots to the page. There is still exactly
  one thread advancing the simulation, so determinism is untouched, but the
  page no longer shares a thread with it: the clock runs at over a hundred
  simulated days a second while clicks are still answered in about 25ms.

The page never sees the world. Everything it draws crosses the boundary as a
`DashboardSnapshot` — a few kilobytes of already-resolved values rather than
the multi-megabyte world — and everything it does crosses back as a `Command`.

## Money

`Money` is a branded integer number of pence. The brand means a raw number
cannot be passed where money is expected, and that money cannot be combined
with `+` — every operation goes through a helper where rounding is explicit.

`allocate(total, weights)` distributes an amount by largest-remainder, so a
split never loses or invents a penny. It is used everywhere a flow fans out
across many recipients.

## The ledger

Every entity has accounts. A transaction is a set of postings that must sum to
zero; `post()` refuses anything else. Balances are stored debit-positive, and
`naturalBalance()` flips the sign for liabilities, equity and income so they
read positive.

Two invariants hold at all times and are tested:

- The **whole ledger** sums to zero.
- **Each entity's own books** sum to zero.

The second is the stricter and more useful one. It is why `forgetOwner()`
refuses to delete an entity whose accounts do not net out: doing so would
silently destroy value, which is precisely the bug that produced a three-penny
drift during development.

### Payment routing

Who pays whom determines the postings, and `paymentPostings()` handles all
three cases:

- **Customer pays its own bank** — the bank's deposit liability shrinks.
- **Bank pays its own customer** — the deposit liability grows.
- **Anyone else** — value moves between the two parties, and if they bank in
  different places, reserves move between those banks to settle.

That last leg is what makes deposits worth competing for: losing a customer
costs you reserves, and replacing reserves costs Bank Rate plus the corridor.

### Market clearing

Wages and the goods market involve thousands of participants paying thousands
of others. Writing each pair as its own flow is quadratic and unreadable, so
`clearMarket()` nets the whole market into one transaction: one leg per
participant, plus a single net movement in deposits and reserves for each bank
in the middle. Each bank has to satisfy

```
Δ reserves = Δ deposits − what the bank itself paid + what the bank itself received
```

which keeps every set of books balanced whether the bank is merely clearing its
customers' payments or is a party to the trade.

### Batching

Interest on thousands of contracts lands on a handful of accounts, so the
lifecycle system accrues the whole economy first and writes one netted
transaction. Doing it per contract was 68% of the entire tick and left the
journal holding barely a day of history.

`netPostings` is the shared primitive: collapse many movements into one line
per account, dropping anything that cancels out. `FlowBatch` and `clearMarket`
use it too. The rule of thumb is that anything touching every agent should
accumulate postings and write once.

Batching is only safe because each contract still rounds and records its own
interest — only the ledger write is shared — so totals are unchanged.

## Bank lending creates money

Loan origination is the clearest illustration of why the ledger is worth
having. The bank does not lend out deposits it already holds; it writes an
asset and a matching deposit into existence:

```
debit   bank      loans              £250,000
credit  bank      customerDeposits   £250,000
debit   borrower  deposit@bank       £250,000
credit  borrower  borrowings         £250,000
```

Both sets of books balance, the money supply grows, and repayment destroys it
again. None of that had to be modelled specially — it falls out of writing the
transaction correctly.

## Level of detail

Cohorts hold a count, distribution parameters, aggregate non-monetary state
(`pool`), and — crucially — **real ledger accounts**.

**Promotion** draws a size factor from the archetype's distribution using a
generator seeded on the member's stable identity, so the same latent member
always materialises the same way. It then carves that share of every one of the
cohort's balances into the new entity, in one transaction. Because each account
is rounded independently, the slice is adjusted on its largest line so the new
entity's books balance exactly.

**Folding** reverses it and returns the member to the pool. It is refused while
the entity still holds live contracts, since a cohort cannot carry an
individual loan.

**Dissolution** is folding without returning a member: a failed firm is gone,
but its residual balance sheet is not, so its claims pass to its sector.

Debt carved out of a pool gets a real contract attached (`attachLegacyDebt`), so
it accrues interest and shows up in credit assessment rather than sitting inert.

## Determinism

- No `Math.random()` anywhere in `src/`.
- Systems call `ctx.rng('some.stream')`, derived from
  `(world seed, stream name, tick)` — stateless, so adding a new consumer of
  randomness cannot perturb any existing one.
- Latent agents use `identityRng(seed, identity)`, tied to who they are rather
  than to when they were created.
- Ids are sequential counters stored on the world.
- Nothing in the world holds a function, a `Map` or a class instance, so a save
  file is `JSON.stringify(world)` and load is the reverse, with a migration
  chain keyed on the version it upgrades *from*.
- Lookups that want a `Map` live *beside* the world, in a `WeakMap` keyed on the
  thing they index — entities by kind in `src/world/state.ts`, accounts by owner
  and code in `src/ledger/ledger.ts`. They are derived, never authoritative, and
  a restored save rebuilds them on first use, so nothing about the save format
  changes and no migration is needed. Keying on the world also means a
  calibration worker's discarded worlds take their indexes with them.
  Invalidate by discarding, not by editing in place: the arrays these hand out
  are snapshots, and callers iterate them while mutating the world.

## Extension points that already exist

- `instrumentTypes` — products
- `systems` — behaviour, ordered by phase
- `commands` — player actions
- `GameEvents` — the event vocabulary, open to declaration merging
- `scenarios` — starting worlds as data
- `SimConfig` — every balancing knob in one object
- `migrations` — save compatibility as the world shape changes
