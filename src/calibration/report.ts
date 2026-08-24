/**
 * Turns a campaign results file into something readable.
 *
 * Kept separate from the runner so a file can be analysed anywhere, by anyone,
 * long after the machine that produced it has moved on.
 */
import { spreadOf } from './targets.js';
import type { CampaignFile, CampaignRun } from './campaign.js';
import type { RunSummary } from './summary.js';

const pct = (value: number): string => `${(value * 100).toFixed(2)}%`;
const pad = (value: string, width: number): string => value.padStart(width);
const padEnd = (value: string, width: number): string => value.padEnd(width);

export interface Comparison {
  label: string;
  mean: number;
  standardError: number;
  pairs: number;
  /** Whether the difference clears two standard errors. */
  real: boolean;
}

/** Group a study's runs by the label the job carried. */
export function byLabel(runs: CampaignRun[]): Map<string, CampaignRun[]> {
  const groups = new Map<string, CampaignRun[]>();
  for (const run of runs) {
    if (run.error || run.score === undefined) continue;
    const list = groups.get(run.label) ?? [];
    list.push(run);
    groups.set(run.label, list);
  }
  return groups;
}

/**
 * Compare two groups seed by seed.
 *
 * Pairing cancels the seed's own contribution, which is worth tens of points,
 * and leaves only what the change did.
 */
export function comparePaired(
  before: CampaignRun[],
  after: CampaignRun[],
  read: (run: CampaignRun) => number = (run) => run.score ?? Number.NaN,
): Comparison {
  const baseline = new Map(before.map((run) => [run.seed, read(run)]));
  const deltas: number[] = [];
  for (const run of after) {
    const was = baseline.get(run.seed);
    const now = read(run);
    if (was !== undefined && Number.isFinite(was) && Number.isFinite(now)) deltas.push(now - was);
  }
  if (deltas.length === 0) {
    return { label: '', mean: 0, standardError: 0, pairs: 0, real: false };
  }
  const spread = spreadOf(deltas);
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  return {
    label: '',
    mean,
    standardError: spread.standardError,
    pairs: deltas.length,
    real: Math.abs(mean) > 2 * spread.standardError && Math.abs(mean) > 0.05,
  };
}

function metric(runs: CampaignRun[], read: (summary: RunSummary) => number): string {
  const values = runs.map((run) => (run.summary ? read(run.summary) : Number.NaN)).filter(Number.isFinite);
  if (values.length === 0) return '—';
  const spread = spreadOf(values);
  const average = values.reduce((a, b) => a + b, 0) / values.length;
  return `${pct(average)} ±${(spread.standardError * 100).toFixed(2)}`;
}

const METRICS: [string, (s: RunSummary) => number][] = [
  ['inflation', (s) => s.inflation.mean],
  ['infl. volatility', (s) => s.inflation.std],
  ['unemployment', (s) => s.unemployment.mean],
  ['output growth', (s) => s.outputGrowth],
  ['insolvency', (s) => s.insolvencyRate],
  ['gross margin', (s) => s.grossMargin.mean],
  ['cost of risk', (s) => s.costOfRisk],
  ['net interest margin', (s) => s.nim],
  ['return on equity', (s) => s.roe],
];

export function reportCampaign(file: CampaignFile): string {
  const out: string[] = [];
  const say = (...lines: string[]): void => void out.push(...(lines.length ? lines : ['']));

  const allRuns = file.studies.flatMap((study) => study.runs);
  const failed = allRuns.filter((run) => run.error);

  say(`Campaign: ${file.preset}`);
  say(`  commit    ${file.commit ?? 'unknown'}${file.branch ? ` (${file.branch})` : ''}`);
  say(`  machine   ${file.machine.cores} cores, node ${file.machine.node}, ${file.machine.platform}/${file.machine.arch}`);
  say(`  ran       ${allRuns.length} runs in ${(file.elapsedSeconds / 60).toFixed(1)} min`);
  say(`  seeds     ${file.seeds.length}`);
  if (failed.length > 0) say(`  FAILED    ${failed.length} runs — ${failed[0]!.error?.slice(0, 90)}`);

  for (const study of file.studies) {
    say();
    say(`${'═'.repeat(74)}`);
    say(`${study.label.toUpperCase()}`);
    say(`  ${study.question}`);
    say();
    const groups = byLabel(study.runs);
    if (groups.size === 0) {
      say('  no usable runs');
      continue;
    }
    if (study.id === 'sensitivity') say(...renderSensitivity(groups));
    else say(...renderGroups(groups, study.id));
  }

  return out.join('\n');
}

/** A row per configuration, with the headline metrics and their error bars. */
function renderGroups(groups: Map<string, CampaignRun[]>, studyId: string): string[] {
  const lines: string[] = [];
  const labels = [...groups.keys()].sort(naturalOrder);
  const width = Math.max(14, ...labels.map((l) => l.length + 2));

  lines.push(
    `  ${padEnd('configuration', width)} ${pad('score', 14)} ${METRICS.slice(0, 6)
      .map(([name]) => pad(name, 16))
      .join(' ')}`,
  );
  for (const label of labels) {
    const runs = groups.get(label)!;
    const scores = spreadOf(runs.map((r) => r.score!));
    const mean = runs.reduce((t, r) => t + r.score!, 0) / runs.length;
    lines.push(
      `  ${padEnd(label, width)} ${pad(`${mean.toFixed(1)}±${scores.standardError.toFixed(1)}`, 14)} ` +
        METRICS.slice(0, 6)
          .map(([, read]) => pad(metric(runs, read), 16))
          .join(' '),
    );
  }

  // For the studies that vary one thing, say whether it changed anything at all.
  const first = groups.get(labels[0]!);
  if (first && labels.length > 1 && studyId !== 'baseline') {
    lines.push('');
    lines.push(`  Against ${labels[0]}, paired seed by seed:`);
    for (const label of labels.slice(1)) {
      const comparison = comparePaired(first, groups.get(label)!);
      lines.push(
        `    ${padEnd(label, width)} ${
          comparison.real
            ? `${comparison.mean >= 0 ? '+' : ''}${comparison.mean.toFixed(1)} ±${comparison.standardError.toFixed(1)}`
            : 'no measurable difference'
        }`,
      );
    }
  }
  return lines;
}

/** Parameters ranked by how far they actually move the score. */
function renderSensitivity(groups: Map<string, CampaignRun[]>): string[] {
  const baseline = groups.get('baseline');
  if (!baseline) return ['  no baseline runs to compare against'];

  // Labels look like `investmentRate=x1.3`. Group them by parameter and keep
  // them in multiplier order so a row reads as a response curve.
  const perParameter = new Map<string, { factor: number; comparison: Comparison }[]>();
  for (const [label, runs] of groups) {
    const match = label.match(/^(.+)=x(-?[\d.]+)$/);
    if (!match) continue;
    const list = perParameter.get(match[1]!) ?? [];
    list.push({ factor: Number(match[2]), comparison: comparePaired(baseline, runs) });
    perParameter.set(match[1]!, list);
  }

  const rows = [...perParameter].map(([key, points]) => {
    points.sort((a, b) => a.factor - b.factor);
    const real = points.filter((p) => p.comparison.real);
    return {
      key,
      points,
      influence: real.length > 0 ? Math.max(...real.map((p) => Math.abs(p.comparison.mean))) : 0,
    };
  });
  rows.sort((a, b) => b.influence - a.influence);

  const show = (c: Comparison): string =>
    c.real ? `${c.mean >= 0 ? '+' : ''}${c.mean.toFixed(0)}±${c.standardError.toFixed(0)}` : '—';

  const factors = [...new Set(rows.flatMap((r) => r.points.map((p) => p.factor)))].sort((a, b) => a - b);
  const lines = [
    `  ${padEnd('parameter', 28)} ${factors.map((f) => pad(`x${f}`, 12)).join(' ')}  improves`,
  ];
  for (const row of rows) {
    const cells = factors.map((factor) => {
      const point = row.points.find((p) => p.factor === factor);
      return pad(point ? show(point.comparison) : '', 12);
    });
    const lowest = row.points[0]?.comparison.mean ?? 0;
    const highest = row.points[row.points.length - 1]?.comparison.mean ?? 0;
    lines.push(
      `  ${padEnd(row.key, 28)} ${cells.join(' ')}  ${
        row.influence > 0 ? (lowest < highest ? 'lower' : 'higher') : ''
      }`,
    );
  }
  const real = rows.filter((r) => r.influence > 0);
  lines.push('');
  lines.push(`  ${real.length} of ${rows.length} parameters move the score measurably.`);
  if (real.length > 0) {
    lines.push(`  Worth tuning: ${real.slice(0, 5).map((r) => r.key).join(', ')}`);
  }
  return lines;
}

/** Sort labels so numbers in them order numerically. */
function naturalOrder(a: string, b: string): number {
  const numberIn = (value: string): number => {
    const match = value.match(/-?\d+(\.\d+)?/);
    return match ? Number(match[0]) : Number.NaN;
  };
  const x = numberIn(a);
  const y = numberIn(b);
  if (Number.isFinite(x) && Number.isFinite(y) && x !== y) return x - y;
  return a.localeCompare(b);
}
