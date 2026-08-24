/**
 * Calibration harness.
 *
 *   node scripts/calibrate.js score              baseline scorecard
 *   node scripts/calibrate.js sweep              which parameters actually matter
 *   node scripts/calibrate.js search             coordinate descent on the best few
 *
 * Common flags: --seeds N --years N --workers N --params a,b,c
 *
 * Hand-tuning a simulation is guesswork until "balanced" is a number you can
 * measure. This turns it into a search problem: score a run against targets,
 * find out which knobs move the score, then move those knobs.
 */
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TARGETS, scoreAll } from '../dist/src/calibration/targets.js';
import { PARAMETERS, clampToRange } from '../dist/src/calibration/parameters.js';
import { DEFAULT_CONFIG } from '../dist/src/world/state.js';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'score';
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

// Two seeds leaves a standard error of about +/-18 on the total, which is
// larger than most of the differences worth arguing about. Six is affordable
// and roughly halves it.
const seedCount = Number(flag('seeds', 6));
const years = Number(flag('years', 4));
const workerCount = Math.max(1, Math.min(Number(flag('workers', os.cpus().length)), os.cpus().length));
const only = flag('params', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const iterations = Number(flag('iterations', 2));

const SEEDS = Array.from({ length: seedCount }, (_, i) => 1000 + i * 7919);
const parameters = only.length ? PARAMETERS.filter((p) => only.includes(p.key)) : PARAMETERS;

// --- worker pool -----------------------------------------------------------

const workerPath = fileURLToPath(new URL('./calibrate-worker.js', import.meta.url));

function createPool(size) {
  const workers = Array.from({ length: size }, () => new Worker(workerPath));
  const idle = [...workers];
  const queue = [];

  const pump = () => {
    while (idle.length > 0 && queue.length > 0) {
      const worker = idle.pop();
      const { job, resolve, reject } = queue.shift();
      worker.once('message', (message) => {
        idle.push(worker);
        if (message.ok) resolve(message.result);
        else reject(new Error(message.error));
        pump();
      });
      worker.postMessage(job);
    }
  };

  return {
    run: (job) => new Promise((resolve, reject) => { queue.push({ job, resolve, reject }); pump(); }),
    close: () => Promise.all(workers.map((w) => w.terminate())),
  };
}

const pool = createPool(workerCount);
let completed = 0;
let expected = 0;

async function evaluate(overrides) {
  const results = await Promise.all(
    SEEDS.map((seed) =>
      pool.run({ seed, years, overrides }).then((result) => {
        completed += 1;
        if (expected > 0) process.stderr.write(`\r  ${completed}/${expected} runs`);
        return result;
      }),
    ),
  );
  const summaries = results.map((r) => r.summary);
  return { score: scoreAll(summaries, DEFAULT_TARGETS), summaries };
}

// --- output ----------------------------------------------------------------

const pct = (v) => `${(v * 100).toFixed(2)}%`;
const pad = (v, n) => String(v).padStart(n);

function printScorecard(label, { score, summaries }) {
  console.log(`\n${label}`);
  console.log(`  ${'metric'.padEnd(28)} ${pad('actual', 10)} ${pad('target', 10)} ${pad('penalty', 9)}`);
  for (const c of score.components) {
    const target = DEFAULT_TARGETS.find((t) => t.key === c.key);
    console.log(
      `  ${c.label.padEnd(28)} ${pad(pct(c.observed), 10)} ${pad(pct(target.target), 10)} ${pad(c.penalty.toFixed(2), 9)}`,
    );
  }
  const survived = summaries.filter((s) => s.survived).length;
  const speed = Math.round(summaries.reduce((t, s) => t + s.ticksPerSecond, 0) / summaries.length);
  const { standardError, min, max, runs } = score.spread;
  console.log(`  ${'—'.repeat(60)}`);
  console.log(
    `  TOTAL ${score.total.toFixed(1)} ± ${standardError.toFixed(1)}   ` +
      `(${min.toFixed(0)}–${max.toFixed(0)} across ${runs} seeds)   ` +
      `survived ${survived}/${summaries.length}   ${speed} ticks/sec`,
  );
  if (standardError > 5) {
    console.log(
      `  Anything smaller than about ${(2 * standardError).toFixed(0)} points is inside the noise here.` +
        ` Raise --seeds to narrow it.`,
    );
  }
}

// --- commands --------------------------------------------------------------

async function commandScore() {
  expected = SEEDS.length;
  const baseline = await evaluate({});
  printScorecard(`Baseline — ${SEEDS.length} seeds x ${years} years`, baseline);
}

async function commandSweep() {
  expected = SEEDS.length * (1 + parameters.length * 2);
  const baseline = await evaluate({});
  printScorecard(`Baseline — ${SEEDS.length} seeds x ${years} years`, baseline);

  const rows = [];
  for (const parameter of parameters) {
    const base = DEFAULT_CONFIG[parameter.key];
    const low = clampToRange(parameter, base === 0 ? -parameter.step : base * 0.7);
    const high = clampToRange(parameter, base === 0 ? parameter.step : base * 1.3);
    const [lowResult, highResult] = await Promise.all([
      evaluate({ [parameter.key]: low }),
      evaluate({ [parameter.key]: high }),
    ]);

    // How much the score moves either side of baseline, and which single
    // metric it moves most — the second is what tells you why.
    const deltaLow = lowResult.score.total - baseline.score.total;
    const deltaHigh = highResult.score.total - baseline.score.total;
    // Movement is measured in tolerances, not raw units. Comparing raw
    // magnitudes just picks out whichever metric happens to be the largest
    // number, which is never the question being asked.
    const worst = baseline.score.components
      .map((c, i) => {
        const tolerance = DEFAULT_TARGETS.find((t) => t.key === c.key)?.tolerance ?? 1;
        const move =
          Math.abs(
            (highResult.score.components[i]?.observed ?? 0) - (lowResult.score.components[i]?.observed ?? 0),
          ) / tolerance;
        return { label: c.label, move };
      })
      .sort((a, b) => b.move - a.move)[0];

    rows.push({
      label: parameter.label,
      key: parameter.key,
      influence: Math.max(Math.abs(deltaLow), Math.abs(deltaHigh)),
      deltaLow,
      deltaHigh,
      best: deltaLow < deltaHigh ? 'lower' : 'higher',
      drives: worst?.label ?? '',
    });
  }

  rows.sort((a, b) => b.influence - a.influence);
  console.log(`\n\nSensitivity — how far the score moves at -30% / +30%\n`);
  console.log(`  ${'parameter'.padEnd(30)} ${pad('-30%', 9)} ${pad('+30%', 9)}  ${'improves'.padEnd(9)} drives`);
  for (const row of rows) {
    console.log(
      `  ${row.label.padEnd(30)} ${pad(row.deltaLow.toFixed(2), 9)} ${pad(row.deltaHigh.toFixed(2), 9)}  ${row.best.padEnd(9)} ${row.drives}`,
    );
  }
  console.log(`\n  Parameters near the bottom barely move the score. Ignore them and`);
  console.log(`  tune the handful at the top: node scripts/calibrate.js search --params ${rows.slice(0, 4).map((r) => r.key).join(',')}`);
}

async function commandSearch() {
  let best = await evaluate({});
  let config = {};
  printScorecard('Starting point', best);
  console.log(`\nCoordinate descent over ${parameters.length} parameters, ${iterations} passes\n`);

  for (let pass = 1; pass <= iterations; pass++) {
    for (const parameter of parameters) {
      const current = config[parameter.key] ?? DEFAULT_CONFIG[parameter.key];
      const candidates = [
        clampToRange(parameter, current - parameter.step),
        clampToRange(parameter, current + parameter.step),
      ].filter((value) => value !== current);

      for (const value of candidates) {
        const trial = await evaluate({ ...config, [parameter.key]: value });
        if (trial.score.total < best.score.total - 0.01) {
          best = trial;
          config = { ...config, [parameter.key]: value };
          console.log(
            `\r  pass ${pass}: ${parameter.label} -> ${value} (score ${best.score.total.toFixed(2)})`,
          );
        }
      }
    }
  }

  printScorecard('Best found', best);
  console.log('\nOverrides:\n');
  console.log(JSON.stringify(config, null, 2));
}

const commands = { score: commandScore, sweep: commandSweep, search: commandSearch };
const run = commands[command];
if (!run) {
  console.error(`Unknown command "${command}". Try: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.close());
