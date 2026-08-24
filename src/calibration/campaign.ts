/**
 * Long-running calibration campaigns.
 *
 * A campaign is a set of studies, each one a question with the runs needed to
 * answer it, executed in bulk on a machine with cores to spare and written to
 * a single results file. The file is self-describing -- it records the commit
 * that produced it, the machine, the seeds and every run -- so it can be
 * handed to someone else and analysed without any of the context that produced
 * it.
 */
import type { SimConfig } from '../world/state.js';
import type { ScenarioSpec } from '../scenarios/types.js';
import { PARAMETERS, clampToRange } from './parameters.js';
import { DEFAULT_CONFIG } from '../world/state.js';
import type { CalibrationJob } from './harness.js';
import type { RunSummary } from './summary.js';

export interface Study {
  id: string;
  label: string;
  /** What this study exists to find out. Printed with its results. */
  question: string;
  jobs: CalibrationJob[];
}

export interface CampaignRun {
  study: string;
  label: string;
  seed: number;
  years: number;
  overrides?: Partial<SimConfig>;
  scenario?: Partial<ScenarioSpec>;
  summary?: RunSummary;
  score?: number;
  /** Penalty contributed by each target, keyed by target id. */
  penalties?: Record<string, number>;
  /** What each target actually measured. */
  observed?: Record<string, number>;
  /** Set instead of the rest when the run threw. */
  error?: string;
  ms: number;
}

export interface CampaignFile {
  format: number;
  createdAt: string;
  /** Commit the results were produced from. Without it they cannot be trusted. */
  commit?: string;
  branch?: string;
  preset: string;
  seeds: number[];
  machine: { cores: number; node: string; platform: string; arch: string };
  elapsedSeconds: number;
  studies: { id: string; label: string; question: string; runs: CampaignRun[] }[];
}

export const CAMPAIGN_FORMAT = 1;

/**
 * Below this, a run says nothing.
 *
 * Two reasons, found a long way apart.
 *
 * Year-on-year inflation has no history to compare against for the first
 * twelve months, and the summary discards the first thirteen for that reason.
 * A one-year run therefore reports inflation from a handful of samples taken
 * while the figure is still meaningless -- around -16%, which is not a finding
 * about the economy but an artefact of asking too early.
 *
 * The second is worse, because it looks like a result. The opening world is
 * not in equilibrium, and finding one takes a large excursion through years
 * three to six -- annual inflation of 10.5%, 10.7% and 12.7% -- that is over
 * by year ten. Any mean that *ends* inside that excursion reports it rather
 * than the model. Measured across 64 seeds, the same configuration scores
 * 60.7±1.6 at three years, 162.1±1.4 at five, 67.5±1.0 at ten and 93.6±3.3 at
 * twenty. Five years is not a slightly worse three: it is a different number
 * about a different thing.
 *
 * This is not academic. Every preset once ran its comparisons at five years,
 * and a 4,992-run sensitivity sweep taken there recommended raising
 * `savingsBufferDays` by 30% -- a recommendation that reverses at ten years
 * and twenty. A campaign measured inside the excursion tunes the excursion.
 */
export const MINIMUM_USEFUL_YEARS = 10;

/**
 * Seeds are derived rather than random, so two campaigns run weeks apart are
 * directly comparable and a result can always be reproduced.
 */
export function seedsFor(count: number): number[] {
  return Array.from({ length: count }, (_, i) => 1000 + i * 7919);
}

export interface PresetShape {
  id: string;
  label: string;
  /** Seeds for the headline studies. */
  seeds: number;
  /** Seeds for the studies that sweep many configurations. */
  sweepSeeds: number;
  years: number;
  /** Horizons compared in the long-run study. */
  horizons: number[];
  /** How many parameters the sensitivity study covers. All of them by default. */
  sweepParameters?: number;
  /**
   * Multiples of each parameter's baseline to test. A single pair says whether
   * a parameter matters; a wider set says whether its effect is linear, which
   * is what tells you if a search can trust its own gradient.
   */
  sweepFactors: number[];
  subdivisionLevels: number[];
  dispersionLevels: number[];
}

export const PRESETS: Record<string, PresetShape> = {
  /** Proves the plumbing works before anyone commits an evening to it. */
  smoke: {
    id: 'smoke',
    label: 'Smoke test',
    seeds: 2,
    sweepSeeds: 2,
    years: MINIMUM_USEFUL_YEARS,
    horizons: [3, 4],
    sweepParameters: 3,
    sweepFactors: [0.7, 1.3],
    subdivisionLevels: [1, 4],
    dispersionLevels: [0, 0.04],
  },
  quick: {
    id: 'quick',
    label: 'Quick check',
    seeds: 8,
    sweepSeeds: 6,
    years: MINIMUM_USEFUL_YEARS,
    horizons: [3, 5],
    sweepFactors: [0.7, 1.3],
    subdivisionLevels: [1, 2, 4, 8],
    dispersionLevels: [0, 0.02, 0.06],
  },
  standard: {
    id: 'standard',
    label: 'Standard campaign',
    seeds: 24,
    sweepSeeds: 16,
    years: MINIMUM_USEFUL_YEARS,
    horizons: [3, 5, 10],
    sweepFactors: [0.7, 1.3],
    subdivisionLevels: [1, 2, 3, 4, 6, 8, 12],
    dispersionLevels: [0, 0.01, 0.02, 0.04, 0.06, 0.09],
  },
  deep: {
    id: 'deep',
    label: 'Deep campaign',
    seeds: 64,
    sweepSeeds: 48,
    years: MINIMUM_USEFUL_YEARS,
    horizons: [3, 5, 10, 20],
    sweepFactors: [0.55, 0.7, 1.3, 1.6],
    subdivisionLevels: [1, 2, 3, 4, 6, 8, 12, 20],
    dispersionLevels: [0, 0.005, 0.01, 0.02, 0.03, 0.04, 0.06, 0.09],
  },
  /**
   * For a machine you are prepared to leave alone. Enough seeds to pin the
   * error bars near a point, horizons long enough that slow drift has nowhere
   * to hide, and a wide enough sweep to show whether each parameter's effect
   * is linear.
   */
  overnight: {
    id: 'overnight',
    label: 'Overnight campaign',
    seeds: 160,
    sweepSeeds: 128,
    years: MINIMUM_USEFUL_YEARS,
    horizons: [3, 5, 10, 20, 40],
    sweepFactors: [0.4, 0.55, 0.7, 1.3, 1.6, 2],
    subdivisionLevels: [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20],
    dispersionLevels: [0, 0.005, 0.01, 0.015, 0.02, 0.03, 0.04, 0.06, 0.09],
  },
};

export function buildStudies(preset: PresetShape): Study[] {
  const seeds = seedsFor(preset.seeds);
  const sweepSeeds = seedsFor(preset.sweepSeeds);
  const years = preset.years;

  return [
    {
      id: 'baseline',
      label: 'Baseline',
      question:
        'Where does the default configuration actually sit, with enough seeds for the error bars to be worth reading?',
      jobs: seeds.map((seed) => ({ seed, years, label: 'baseline' })),
    },

    {
      id: 'horizon',
      label: 'Long run',
      question:
        'Does the economy hold up over decades, or does something drift? Everything so far has been judged on three years.',
      jobs: preset.horizons.flatMap((horizon) =>
        sweepSeeds.map((seed) => ({ seed, years: horizon, label: `${horizon}y` })),
      ),
    },

    {
      id: 'sensitivity',
      label: 'Sensitivity',
      question: 'Which parameters actually move the score, and by how much, with error bars on every one?',
      jobs: [
        ...sweepSeeds.map((seed) => ({ seed, years, label: 'baseline' })),
        ...PARAMETERS.slice(0, preset.sweepParameters ?? PARAMETERS.length).flatMap((parameter) => {
          const base = DEFAULT_CONFIG[parameter.key] as number;
          // Distinct values only: clamping to the parameter's range can push
          // two factors onto the same number, and running it twice tells you
          // nothing you did not already know.
          const values = new Map<number, string>();
          for (const factor of preset.sweepFactors) {
            const value = clampToRange(
              parameter,
              base === 0 ? parameter.step * (factor - 1) : base * factor,
            );
            if (value !== base) values.set(value, `${parameter.key}=x${factor}`);
          }
          return [...values].flatMap(([value, label]) =>
            sweepSeeds.map((seed) => ({
              seed,
              years,
              overrides: { [parameter.key]: value } as Partial<SimConfig>,
              label,
            })),
          );
        }),
      ],
    },

    {
      id: 'subdivision',
      label: 'Cohort subdivision',
      question:
        'Splitting a cohort into identical cohorts should change nothing and does. Where does the non-linearity start, and does it scale with the number of slices?',
      jobs: preset.subdivisionLevels.flatMap((slices) =>
        sweepSeeds.map((seed) => ({
          seed,
          years,
          scenario: { cohortSubdivision: slices, cohortDispersion: 0 },
          label: `slices=${slices}`,
        })),
      ),
    },

    {
      id: 'dispersion',
      label: 'Cohort dispersion',
      question:
        'How much can cohorts differ from one another before competitive selection, with no firm entry to offset it, starts destroying the economy?',
      jobs: preset.dispersionLevels.flatMap((dispersion) =>
        sweepSeeds.map((seed) => ({
          seed,
          years,
          scenario: { cohortSubdivision: 12, cohortDispersion: dispersion },
          label: `dispersion=${dispersion}`,
        })),
      ),
    },
  ];
}

/** Total simulated years, which is what campaign runtime is proportional to. */
export function runYears(studies: Study[]): number {
  return studies.reduce(
    (total, study) => total + study.jobs.reduce((sum, job) => sum + job.years, 0),
    0,
  );
}

export function jobCount(studies: Study[]): number {
  return studies.reduce((total, study) => total + study.jobs.length, 0);
}

export type Invocation =
  | { command: 'report'; path: string }
  | { command: 'run'; preset: string; workers?: number; out: string };

/**
 * What the campaign script was asked to do.
 *
 * Split out here so it can be tested. The failure it exists to prevent is
 * silent: an argument nobody recognises used to fall straight through to the
 * default preset, so `campaign smoke` -- the obvious thing to type -- ran the
 * standard campaign instead. Twenty-eight runs and twenty seconds became
 * eleven hundred runs and an hour, with nothing on screen to say why. Someone
 * running these on their own machine deserves better than that.
 */
export function parseInvocation(argv: string[], defaults: { out: string }): Invocation {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const positional = argv.filter(
    (arg, i) => !arg.startsWith('--') && !(i > 0 && argv[i - 1]?.startsWith('--')),
  );

  if (positional[0] === 'report') {
    return { command: 'report', path: positional[1] ?? flag('in') ?? defaults.out };
  }

  // A bare preset name is how everyone types it, so accept it -- but only when
  // it is a preset. Anything else is a mistake worth stopping for.
  const named = positional[0] === 'run' ? positional[1] : positional[0];
  if (named !== undefined && !(named in PRESETS)) {
    throw new Error(
      `Unknown argument "${named}". Expected "report" or one of: ${Object.keys(PRESETS).join(', ')}`,
    );
  }

  const preset = flag('preset') ?? named ?? 'standard';
  if (!(preset in PRESETS)) {
    throw new Error(`Unknown preset "${preset}". Try: ${Object.keys(PRESETS).join(', ')}`);
  }

  const workers = flag('workers');
  return {
    command: 'run',
    preset,
    workers: workers === undefined ? undefined : Number(workers),
    out: flag('out') ?? defaults.out,
  };
}
