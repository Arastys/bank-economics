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
| 300 | `economy.production` | Firms produce; wages paid to households |
| 350 | `economy.goodsMarket` | Demand meets output; prices move |
| 400 | `firms.decisions` | Monthly hiring, pay, funding needs |
| 450 | `credit.demand` | Applications arrive; latent firms are materialised |
| 500 | `credit.underwriting` | The credit committee decides |
| 600 | `instruments.lifecycle` | Accrue, pay, mature — every contract |
| 700 | `risk.credit` | Re-score borrowers; decide who fails |
| 800 | `bank.treasury` | Reserve management against the central bank |
| 850 | `lod.sweep` | Fold idle entities away; prune dead records |
| 900 | `accounting.periods` | Operating costs, depreciation, tax, period close |
| 950 | `metrics.record` | Monthly time series and prudential ratios |

Order matters in places and the phases encode it: firms must be paid before
they can spend, contracts must accrue before they can be repaid, and the books
must be closed before they are measured.

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

## Extension points that already exist

- `instrumentTypes` — products
- `systems` — behaviour, ordered by phase
- `commands` — player actions
- `GameEvents` — the event vocabulary, open to declaration merging
- `scenarios` — starting worlds as data
- `SimConfig` — every balancing knob in one object
- `migrations` — save compatibility as the world shape changes
