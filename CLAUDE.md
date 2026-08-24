# Working notes

## Commits

One concern per commit. A bug fix, a refactor and a new feature never share one.

- **Refactors land separately from behaviour changes.** Moving constants into
  `SimConfig` is a no-op commit that should be provably no-op; a change to what
  those constants do is a separate commit with numbers attached.
- **A fix ships with the test that catches it**, in the same commit, so the
  commit proves itself.
- **Write the message for someone bisecting.** They arrived here because
  something broke and they want to know what this commit changed and why.

The reason is `git bisect`. A commit that fixes wage indexation *and* adds a
calibration subsystem *and* moves twenty constants cannot be reverted, read or
blamed. This has already happened once here (`8d4edef`, 22 files, six concerns).

All work goes on the designated branch. No feature branches unless asked.

## Simulation invariants

Non-negotiable, and covered by tests:

- Money moves only through `post()`. Never assign a balance directly.
- No `Math.random()` in `src/`. Use `ctx.rng(stream)` or `identityRng`.
- The world is plain data — no functions, `Map`s or class instances — so a save
  stays `JSON.stringify(world)`.
- The engine stays DOM-free.
- Every tuning knob lives in `SimConfig`, and must be *read* as `config.<key>`.
  A parameter nothing reads is worse than no parameter: the calibration sweep
  reports it as having no influence and you conclude the mechanism does not
  matter. This has happened twice; `tests/calibration.test.ts` now guards it.
- Bump `WORLD_VERSION` and add a migration whenever the world shape changes.
- **A balance is not a behaviour.** Most of this economy's balance sheet has no
  contracts behind it and accrues nothing, while looking entirely normal in the
  accounts. Before building on any figure, confirm something actually posts to
  it. `docs/FLOWS.md` records what is live and what is scenery; add to it when
  you find out either way.

## Verifying edits

Patches applied by script have silently failed to match twice, leaving dead
code that looked wired up. After any scripted edit, assert the match and then
grep for the result — do not assume it landed.
