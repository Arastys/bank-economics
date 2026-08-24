/**
 * Run a calibration campaign and write a results file.
 *
 *   node scripts/campaign.js smoke
 *   node scripts/campaign.js deep --workers 20
 *   node scripts/campaign.js report campaign.json.gz
 *
 * A campaign is a set of studies, each one a question with the runs needed to
 * answer it. The output is a single self-describing JSON file -- it records
 * the commit, the machine, the seeds and every run -- so it can be handed to
 * someone else and analysed without any of the context that produced it.
 *
 * Long runs on someone else's machine, so: every study is written to disk as
 * soon as it finishes, a run that throws is recorded and the campaign carries
 * on, and progress is reported with an estimate you can decide against before
 * committing an evening to it.
 */
import os from 'node:os';
import { writeFileSync, readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { CAMPAIGN_FORMAT, PRESETS, buildStudies, jobCount, parseInvocation, runYears, seedsFor } from '../dist/src/calibration/campaign.js';
import { reportCampaign } from '../dist/src/calibration/report.js';
import { DEFAULT_TARGETS, score } from '../dist/src/calibration/targets.js';
import { runJob } from '../dist/src/calibration/harness.js';

let invocation;
try {
  invocation = parseInvocation(process.argv.slice(2), { out: 'campaign.json.gz' });
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(1);
}

if (invocation.command === 'report') {
  console.log(reportCampaign(readCampaign(invocation.path)));
  process.exit(0);
}

/** Reads either form; gzip is detected from the bytes, not the name. */
function readCampaign(path) {
  const raw = readFileSync(path);
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return JSON.parse(text);
}

const preset = PRESETS[invocation.preset];
const workerCount = Math.max(1, invocation.workers || os.cpus().length);
// Gzipped by default: these files are for handing to someone else, and JSON
// this repetitive compresses about tenfold.
const outPath = invocation.out;

const studies = buildStudies(preset);
const totalJobs = jobCount(studies);
const totalYears = runYears(studies);

// --- estimate before committing anyone's evening to it ----------------------

console.log(`${preset.label} — ${studies.length} studies, ${totalJobs} runs, ${totalYears} simulated years`);
process.stdout.write('Timing one run to estimate... ');
const probeStarted = Date.now();
runJob({ seed: 1, years: 2 });
const secondsPerYear = (Date.now() - probeStarted) / 1000 / 2;
const estimate = (totalYears * secondsPerYear) / workerCount;
console.log(
  `${secondsPerYear.toFixed(2)}s per simulated year, ` +
    `so roughly ${formatDuration(estimate)} on ${workerCount} workers.`,
);
console.log(`Writing to ${outPath} after every study. Ctrl-C is safe: finished studies are already saved.\n`);

// --- worker pool ------------------------------------------------------------

const workerPath = fileURLToPath(new URL('./calibrate-worker.js', import.meta.url));

function createPool(size) {
  const live = new Set();
  const idle = [];
  const queue = [];

  const spawn = () => {
    const worker = new Worker(workerPath);
    // Nothing is in flight yet, and an exit with no pending job is just a
    // worker being shut down at the end of the campaign.
    worker.pending = undefined;
    worker.on('message', (message) => settle(worker, message));
    worker.on('error', (error) => settle(worker, { ok: false, error: String(error?.stack ?? error) }, true));
    worker.on('exit', (code) =>
      settle(worker, { ok: false, error: `worker exited with code ${code}` }, true),
    );
    live.add(worker);
    idle.push(worker);
    return worker;
  };

  /**
   * Finish whatever this worker was doing, however it finished.
   *
   * A worker can stop answering three ways: it replies, it throws, or it dies
   * outright. Only the first two raise 'error'; a worker that calls
   * process.exit -- or is killed by the OS for using too much memory, which is
   * the realistic one on a long campaign -- emits 'exit' and nothing else. Miss
   * that and the job it was holding never settles, so the campaign waits for
   * it for ever.
   */
  const settle = (worker, message, fatal = false) => {
    const pending = worker.pending;
    worker.pending = undefined;

    if (fatal) {
      live.delete(worker);
      worker.terminate().catch(() => {});
      if (pending) spawn();
    } else if (pending) {
      idle.push(worker);
    }

    if (pending) {
      pending.resolve({ message, ms: Date.now() - pending.started });
      pump();
    }
  };

  const pump = () => {
    while (idle.length > 0 && queue.length > 0) {
      const worker = idle.pop();
      if (!live.has(worker)) continue;
      const { job, resolve } = queue.shift();
      worker.pending = { resolve, started: Date.now() };
      worker.postMessage(job);
    }
  };

  for (let i = 0; i < size; i++) spawn();

  return {
    // A failing run must not take the campaign with it, so this never rejects.
    run: (job) => new Promise((resolve) => { queue.push({ job, resolve }); pump(); }),
    close: () => Promise.all([...live].map((w) => w.terminate())),
  };
}

const pool = createPool(workerCount);

// --- run --------------------------------------------------------------------

const file = {
  format: CAMPAIGN_FORMAT,
  createdAt: new Date().toISOString(),
  commit: gitDescribe('rev-parse --short HEAD'),
  branch: gitDescribe('rev-parse --abbrev-ref HEAD'),
  preset: preset.id,
  seeds: seedsFor(preset.seeds),
  machine: { cores: os.cpus().length, node: process.version, platform: process.platform, arch: process.arch },
  elapsedSeconds: 0,
  studies: [],
};

const startedAt = Date.now();
let done = 0;

for (const study of studies) {
  process.stdout.write(`${study.label}: 0/${study.jobs.length}`);
  const runs = await Promise.all(
    study.jobs.map((job) =>
      pool.run(job).then(({ message, ms }) => {
        done += 1;
        const elapsed = (Date.now() - startedAt) / 1000;
        const remaining = done > 0 ? (elapsed / done) * (totalJobs - done) : 0;
        process.stdout.write(
          `\r${study.label}: ${runs_done(study)}/${study.jobs.length}` +
            `   overall ${done}/${totalJobs}, about ${formatDuration(remaining)} left        `,
        );
        return toRecord(study.id, job, message, ms);
      }),
    ),
  );
  process.stdout.write(`\r${study.label}: ${study.jobs.length}/${study.jobs.length} done` + ' '.repeat(50) + '\n');

  file.studies.push({ id: study.id, label: study.label, question: study.question, runs });
  file.elapsedSeconds = (Date.now() - startedAt) / 1000;
  writeCampaign(outPath, file);
}

await pool.close();

const failures = file.studies.flatMap((s) => s.runs).filter((r) => r.error);
console.log(`\nFinished in ${formatDuration(file.elapsedSeconds)}.`);
if (failures.length > 0) console.log(`${failures.length} runs failed; they are recorded in the file.`);
console.log(`Wrote ${outPath} (${(readFileSync(outPath).length / 1e6).toFixed(1)} MB). Send me this file.\n`);
console.log(reportCampaign(file));

// --- helpers ----------------------------------------------------------------

function runs_done(study) {
  // Approximate per-study progress from the global counter; exact enough for a
  // progress line and free of extra bookkeeping.
  return Math.min(study.jobs.length, done - (totalJobsBefore(study) ?? 0));
}

function totalJobsBefore(study) {
  let total = 0;
  for (const other of studies) {
    if (other.id === study.id) return total;
    total += other.jobs.length;
  }
  return total;
}

function toRecord(studyId, job, message, ms) {
  const base = {
    study: studyId,
    label: job.label ?? 'default',
    seed: job.seed,
    years: job.years,
    ms: Math.round(ms),
  };
  if (job.overrides) base.overrides = job.overrides;
  if (job.scenario) base.scenario = job.scenario;
  if (!message.ok) return { ...base, error: message.error };

  const scored = score(message.result.summary, DEFAULT_TARGETS);
  return {
    ...base,
    // What each target observed is already in the summary, so only the
    // penalties are worth keeping alongside it.
    summary: round(message.result.summary),
    score: Number(scored.total.toFixed(4)),
    penalties: Object.fromEntries(scored.components.map((c) => [c.key, Number(c.penalty.toFixed(3))])),
  };
}

/** Six significant figures is far more than any of these numbers deserve. */
function round(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toPrecision(6)) : null;
  if (Array.isArray(value)) return value.map(round);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round(v)]));
  }
  return value;
}

function writeCampaign(path, contents) {
  const json = JSON.stringify(contents);
  writeFileSync(path, path.endsWith('.gz') ? gzipSync(json, { level: 9 }) : json);
}

function gitDescribe(args) {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
}

function formatDuration(seconds) {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${(seconds / 60).toFixed(0)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}
