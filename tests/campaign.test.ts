import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_FORMAT,
  MINIMUM_USEFUL_YEARS,
  PRESETS,
  buildStudies,
  jobCount,
  parseInvocation,
  runYears,
  seedsFor,
} from '../src/calibration/campaign.js';
import type { CampaignFile, CampaignRun } from '../src/calibration/campaign.js';
import { byLabel, comparePaired, reportCampaign } from '../src/calibration/report.js';

function run(partial: Partial<CampaignRun> & { seed: number; label: string }): CampaignRun {
  return { study: 's', years: 3, ms: 1, score: 100, ...partial };
}

describe('campaign shape', () => {
  it('derives seeds so two campaigns are comparable', () => {
    expect(seedsFor(4)).toEqual(seedsFor(4));
    expect(new Set(seedsFor(50)).size).toBe(50);
    expect(seedsFor(8).slice(0, 4)).toEqual(seedsFor(4));
  });

  it('asks a question in every study', () => {
    for (const preset of Object.values(PRESETS)) {
      const studies = buildStudies(preset);
      expect(studies.length).toBeGreaterThan(3);
      for (const study of studies) {
        expect(study.question.length).toBeGreaterThan(30);
        expect(study.jobs.length).toBeGreaterThan(0);
      }
    }
  });

  /**
   * A run shorter than this reports artefacts rather than findings, so no
   * study that compares one configuration against another may use one.
   *
   * The horizon study is the exception, and legitimately: measuring what the
   * horizon does to the answer is the whole point of it, and it is how the
   * five-year problem was found in the first place.
   */
  it('never compares configurations over a run too short to mean anything', () => {
    for (const preset of Object.values(PRESETS)) {
      for (const study of buildStudies(preset)) {
        if (study.id === 'horizon') continue;
        for (const job of study.jobs) {
          expect(job.years, `${preset.id}/${study.id}`).toBeGreaterThanOrEqual(MINIMUM_USEFUL_YEARS);
        }
      }
    }
  });

  /**
   * The failure this exists to prevent, which wasted a 6,016-run campaign: the
   * opening world settles through a large excursion in years three to six, and
   * every preset measured its comparisons at year five -- inside it. The
   * sensitivity sweep taken there recommended a parameter change that reverses
   * at ten years and at twenty.
   */
  it('keeps every preset out of the settling excursion', () => {
    for (const preset of Object.values(PRESETS)) {
      expect(preset.years, `${preset.id} sits in the excursion`).not.toBeLessThan(
        MINIMUM_USEFUL_YEARS,
      );
    }
  });

  it('grows with the preset', () => {
    const small = buildStudies(PRESETS.smoke!);
    const large = buildStudies(PRESETS.deep!);
    expect(jobCount(large)).toBeGreaterThan(jobCount(small) * 10);
    expect(runYears(large)).toBeGreaterThan(runYears(small));
  });

  it('varies the starting world in the studies that need to', () => {
    const studies = buildStudies(PRESETS.standard!);
    const subdivision = studies.find((s) => s.id === 'subdivision')!;
    expect(subdivision.jobs.every((job) => job.scenario?.cohortSubdivision !== undefined)).toBe(true);
    // Held at zero, so the study isolates slicing from cohorts differing.
    expect(subdivision.jobs.every((job) => job.scenario?.cohortDispersion === 0)).toBe(true);
  });
});

describe('reading results back', () => {
  it('ignores runs that failed', () => {
    const groups = byLabel([
      run({ seed: 1, label: 'a' }),
      run({ seed: 2, label: 'a', score: undefined, error: 'boom' }),
    ]);
    expect(groups.get('a')).toHaveLength(1);
  });

  it('pairs by seed and ignores runs with no partner', () => {
    const before = [run({ seed: 1, label: 'x', score: 100 }), run({ seed: 2, label: 'x', score: 200 })];
    const after = [run({ seed: 1, label: 'y', score: 110 }), run({ seed: 9, label: 'y', score: 999 })];
    const comparison = comparePaired(before, after);
    expect(comparison.pairs).toBe(1);
    expect(comparison.mean).toBe(10);
  });

  /**
   * The whole point of pairing: a consistent shift is a finding even when the
   * underlying scores are wildly different from one another.
   */
  it('finds a consistent shift under noisy levels', () => {
    const seeds = [1, 2, 3, 4, 5, 6];
    const noisy = [60, 200, 95, 310, 140, 70];
    const before = seeds.map((seed, i) => run({ seed, label: 'x', score: noisy[i] }));
    const after = seeds.map((seed, i) => run({ seed, label: 'y', score: noisy[i]! - 12 }));
    const comparison = comparePaired(before, after);
    expect(comparison.mean).toBeCloseTo(-12, 6);
    expect(comparison.real).toBe(true);
  });

  it('calls an inconsistent difference what it is', () => {
    const seeds = [1, 2, 3, 4, 5, 6];
    const jitter = [8, -9, 7, -6, 9, -8];
    const before = seeds.map((seed) => run({ seed, label: 'x', score: 100 }));
    const after = seeds.map((seed, i) => run({ seed, label: 'y', score: 100 + jitter[i]! }));
    expect(comparePaired(before, after).real).toBe(false);
  });

  it('renders every study, with its question', () => {
    const file: CampaignFile = {
      format: CAMPAIGN_FORMAT,
      createdAt: new Date().toISOString(),
      commit: 'abc1234',
      preset: 'smoke',
      seeds: [1, 2],
      machine: { cores: 20, node: 'v22', platform: 'linux', arch: 'x64' },
      elapsedSeconds: 60,
      studies: [
        {
          id: 'subdivision',
          label: 'Cohort subdivision',
          question: 'Does slicing a cohort change anything it should not?',
          runs: [
            run({ seed: 1, label: 'slices=1', score: 100 }),
            run({ seed: 2, label: 'slices=1', score: 120 }),
            run({ seed: 1, label: 'slices=4', score: 160 }),
            run({ seed: 2, label: 'slices=4', score: 180 }),
          ],
        },
      ],
    };
    const text = reportCampaign(file);
    expect(text).toContain('abc1234');
    expect(text).toContain('20 cores');
    expect(text).toContain('Does slicing a cohort change anything');
    expect(text).toContain('slices=4');
    expect(text).toContain('+60.0');
  });

  /**
   * A results file is meant to be handed over, and may well predate whatever
   * is being asked of it. A report that throws on an older file is useless
   * exactly when someone is trying to compare two of them.
   */
  it('reads a file recorded before a metric existed', () => {
    const older: CampaignFile = {
      format: CAMPAIGN_FORMAT,
      createdAt: new Date().toISOString(),
      preset: 'smoke',
      seeds: [1],
      machine: { cores: 4, node: 'v22', platform: 'linux', arch: 'x64' },
      elapsedSeconds: 1,
      studies: [
        {
          id: 'baseline',
          label: 'Baseline',
          question: 'Does an older file still render?',
          runs: [
            // No grossMargin, and no unemployment either: an old shape.
            run({
              seed: 1,
              label: 'baseline',
              score: 90,
              summary: { inflation: { mean: 0.02, std: 0.01, min: 0, max: 0 } } as never,
            }),
          ],
        },
      ],
    };
    const text = reportCampaign(older);
    expect(text).toContain('Does an older file still render?');
    expect(text).toContain('2.00%');
    // Missing figures show as a dash rather than taking the report down.
    expect(text).toContain('—');
  });

  it('says so rather than crashing when a study produced nothing usable', () => {
    const file: CampaignFile = {
      format: CAMPAIGN_FORMAT,
      createdAt: new Date().toISOString(),
      preset: 'smoke',
      seeds: [1],
      machine: { cores: 4, node: 'v22', platform: 'linux', arch: 'x64' },
      elapsedSeconds: 1,
      studies: [
        {
          id: 'baseline',
          label: 'Baseline',
          question: 'Anything at all?',
          runs: [run({ seed: 1, label: 'baseline', score: undefined, error: 'out of memory' })],
        },
      ],
    };
    const text = reportCampaign(file);
    expect(text).toContain('FAILED');
    expect(text).toContain('no usable runs');
  });
});

/**
 * The failure this exists to prevent, which cost an hour: an argument nobody
 * recognised fell through to the default preset, so `campaign smoke` -- the
 * obvious thing to type -- silently ran the standard campaign. Twenty-eight
 * runs became eleven hundred and nothing on screen said why.
 */
describe('what the campaign script was asked to do', () => {
  const defaults = { out: 'campaign.json.gz' };
  const parse = (...argv: string[]) => parseInvocation(argv, defaults);

  it('takes a bare preset name, which is how everyone types it', () => {
    expect(parse('smoke')).toMatchObject({ command: 'run', preset: 'smoke' });
    expect(parse('deep', '--workers', '20')).toMatchObject({ preset: 'deep', workers: 20 });
  });

  it('still takes the documented flag form', () => {
    expect(parse('run', '--preset', 'smoke')).toMatchObject({ command: 'run', preset: 'smoke' });
    expect(parse('--preset', 'quick')).toMatchObject({ preset: 'quick' });
  });

  it('refuses an argument it does not recognise rather than guessing', () => {
    expect(() => parse('smoek')).toThrow(/Unknown argument "smoek"/);
    expect(() => parse('--preset', 'enormous')).toThrow(/Unknown preset "enormous"/);
  });

  it('defaults to the standard campaign only when asked for nothing', () => {
    expect(parse()).toMatchObject({ command: 'run', preset: 'standard', out: 'campaign.json.gz' });
  });

  it('does not mistake a flag value for a preset', () => {
    expect(parse('--out', 'smoke')).toMatchObject({ preset: 'standard', out: 'smoke' });
  });

  it('reads a report path either way round', () => {
    expect(parse('report', 'runs.json.gz')).toEqual({ command: 'report', path: 'runs.json.gz' });
    expect(parse('report')).toEqual({ command: 'report', path: 'campaign.json.gz' });
  });
});
